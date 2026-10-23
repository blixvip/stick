const { messageError } = require('./localization.cjs');
/** Local, bounded audio decoding. Renderer receives tokens, never filesystem paths. */
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const MAX_CHUNK = 256 * 1024, MAX_INPUT = 32 * 1024 * 1024, MAX_OUTPUT = 48000 * 2 * 2 * 3600 + 4096;
class AudioService {
  constructor({encoderPath, tempRoot, timeoutMs = 120000}) {
    if (!path.isAbsolute(encoderPath) || !path.isAbsolute(tempRoot)) throw messageError(new Error(''), 'desktop.audioService.errors.nativeApprovedAudioPathsAreRequired', {});
    Object.assign(this, {encoderPath, tempRoot, timeoutMs}); this.jobs = new Map();
  }
  touch(job) { clearTimeout(job.timer); job.timer = setTimeout(() => void this.cancel(job.token), this.timeoutMs); job.timer.unref?.(); }
  async begin({size} = {}) {
    if (!Number.isInteger(size) || size < 1 || size > MAX_INPUT) throw messageError(new Error(''), 'desktop.audioService.errors.audioRecordingsMustBeAtMost32MiB', {});
    if (this.starting || this.jobs.size) throw messageError(new Error(''), 'desktop.audioService.errors.finishTheCurrentAudioImportFirst', {});
    this.starting = true; let job;
    try {
      await fs.mkdir(this.tempRoot, {recursive: true});
      const directory = await fs.mkdtemp(path.join(this.tempRoot, 'stykanimate-audio-'));
      job = {token: randomUUID(), directory, input: path.join(directory, 'input.media'), output: path.join(directory, 'decoded.wav'), size, written: 0, phase: 'writing'};
      job.handle = await fs.open(job.input, 'wx'); this.jobs.set(job.token, job); this.touch(job);
      return {token: job.token, maxChunkBytes: MAX_CHUNK};
    } catch (error) { if (job) await this.release(job); throw error; }
    finally { this.starting = false; }
  }
  async use(token, phase, action) {
    const job = this.jobs.get(token);
    if (!job || job.cancelled || job.phase !== phase) throw messageError(new Error(''), 'desktop.audioService.errors.thisAudioImportIsNoLongerActive', {});
    if (job.busy) throw messageError(new Error(''), 'desktop.audioService.errors.waitForThePreviousAudioChunk', {});
    job.busy = true; clearTimeout(job.timer); job.idle = new Promise(resolve => { job.resolveIdle = resolve; });
    let failure, result;
    try { result = await action(job); if (job.cancelled) throw messageError(new Error(''), 'desktop.audioService.errors.audioImportCancelled', {}); }
    catch (error) { failure = error; }
    finally { job.busy = false; job.resolveIdle(); if (this.jobs.has(token) && !job.cancelled) this.touch(job); }
    if (failure) { await this.cancel(token); throw failure; } return result;
  }
  write(token, value) {
    return this.use(token, 'writing', async job => {
      const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null;
      if (!bytes?.length || bytes.length > MAX_CHUNK || job.written + bytes.length > job.size) throw messageError(new Error(''), 'desktop.audioService.errors.invalidAudioInputChunk', {});
      let offset = 0; while (offset < bytes.length) { const {bytesWritten} = await job.handle.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw messageError(new Error(''), 'desktop.audioService.errors.audioFileWriteStopped', {}); offset += bytesWritten; }
      job.written += bytes.length; return {written: job.written};
    });
  }
  finish(token) {
    return this.use(token, 'writing', async job => {
      if (job.written !== job.size) throw messageError(new Error(''), 'desktop.audioService.errors.audioUploadIsIncomplete', {});
      await job.handle.close(); job.handle = null;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff', '-i', job.input,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '3600.001', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', job.output];
      let stderr = '', timer;
      const child = job.child = spawn(this.encoderPath, args, {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
      child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2048); });
      job.closed = new Promise(resolve => child.once('close', resolve));
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => { child.kill(); reject(messageError(new Error(''), 'desktop.audioService.errors.audioDecodingTimedOut', {})); }, this.timeoutMs);
          child.once('error', () => reject(messageError(new Error(''), 'desktop.audioService.errors.theLocalAudioDecoderIsUnavailableRebuildTheBundledVideoEncoder', {})));
          child.once('close', code => code === 0 ? resolve() : reject(messageError(new Error(''), 'desktop.audioService.errors.thisRecordingCouldNotBeDecodedStderr', {stderr: stderr})));
        });
      } finally { clearTimeout(timer); }
      if (job.cancelled) throw messageError(new Error(''), 'desktop.audioService.errors.audioImportCancelled', {});
      const stat = await fs.stat(job.output);
      if (stat.size < 44 || stat.size > MAX_OUTPUT) throw messageError(new Error(''), 'desktop.audioService.errors.decodedAudioExceedsTheOneHourLimit', {});
      job.handle = await fs.open(job.output, 'r'); job.outputSize = stat.size; job.position = 0; job.phase = 'reading';
      return {size: stat.size, maxChunkBytes: MAX_CHUNK};
    });
  }
  read(token) {
    return this.use(token, 'reading', async job => {
      const bytes = Buffer.alloc(Math.min(MAX_CHUNK, job.outputSize - job.position)); let offset = 0;
      while (offset < bytes.length) { const {bytesRead} = await job.handle.read(bytes, offset, bytes.length - offset, job.position + offset); if (!bytesRead) throw messageError(new Error(''), 'desktop.audioService.errors.decodedAudioIsIncomplete', {}); offset += bytesRead; }
      job.position += bytes.length; const done = job.position === job.outputSize;
      if (done) await this.release(job);
      return {bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), done};
    });
  }
  async release(job) {
    this.jobs.delete(job.token); clearTimeout(job.timer); await job.handle?.close().catch(() => {}); job.handle = null;
    // Every path is a fixed child of a directory created by this service.
    await fs.unlink(job.input).catch(() => {}); await fs.unlink(job.output).catch(() => {}); await fs.rmdir(job.directory).catch(() => {});
  }
  async cancel(token) {
    const job = this.jobs.get(token); if (!job) return {cancelled: false};
    if (job.cancellation) return job.cancellation;
    job.cancelled = true;
    job.cancellation = (async () => { job.child?.kill(); if (job.closed) await job.closed; if (job.busy) await job.idle; await this.release(job); return {cancelled: true}; })();
    return job.cancellation;
  }
  async dispose() { await Promise.all([...this.jobs.keys()].map(token => this.cancel(token))); }
}
module.exports = {AudioService};
