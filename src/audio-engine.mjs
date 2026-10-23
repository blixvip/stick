import {restoreMessageError, messageError} from './localized-error.mjs';

import {AUDIO_RATE, AUDIO_CHUNK_BYTES, MAX_AUDIO_FILE_BYTES, audibleClips, audioState, freshAudioId, validateAudioAssetSteps} from './audio-model.mjs';
const abort = () => messageError(new DOMException('', 'AbortError'), "errors.audioEngine.audioOperationCancelled", {});
const check = signal => { if (signal?.aborted) throw abort(); };
const CACHE_BYTES = 768 * 1024 * 1024;

/** One mixer worker, disk-backed Blob sources, < 1 s of scheduled PCM.
 * No recordings or decoded buffers are copied on timeline edits. */
export class AudioEngine {
  constructor({desktop = globalThis.stykDesktop, onError = () => {}} = {}) {
    Object.assign(this, {desktop, onError}); this.sequence = 0; this.pending = new Map(); this.sources = new Map(); this.nodes = new Set(); this.generation = 0; this.preparing = Promise.resolve();
  }
  request(operation, fields = {}, transfers = []) {
    if (this.disposed) return Promise.reject(abort());
    if (!this.worker) {
      this.worker = new Worker(new URL('./audio-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate audio'});
      this.worker.onmessage = ({data}) => { const request = this.pending.get(data.id); if (!request) return; this.pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(restoreMessageError(new Error(data.error), data)) : request.resolve(data.result); };
      this.worker.onerror = event => { event.preventDefault(); this.failWorker((event.message ? new Error(event.message) : messageError(new Error(''), "errors.audioEngine.theAudioWorkerStopped"))); };
      this.worker.onmessageerror = () => this.failWorker(messageError(new Error(''), "errors.audioEngine.audioCouldNotBeTransferred", {}));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => this.failWorker(messageError(new Error(''), "errors.audioEngine.audioPreparationTimedOut", {})), 120000);
      this.pending.set(id, {resolve, reject, timer});
      try { this.worker.postMessage({id, operation, ...fields}, transfers); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  failWorker(error) { this.stop(); for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); this.worker?.terminate(); this.worker = null; this.sources.clear(); }
  async unlock() {
    this.context ??= new AudioContext({sampleRate: AUDIO_RATE, latencyHint: 'interactive'});
    if (this.context.state !== 'running') await this.context.resume();
  }
  async decode(blob, signal) {
    check(signal);
    try { await this.request('inspect', {blob}); return blob; } catch (error) { check(signal); }
    if (this.desktop?.beginAudioImport) {
      let token; const parts = [];
      const cancel = () => { if (token) void this.desktop.cancelAudioImport(token).catch(() => {}); };
      signal?.addEventListener('abort', cancel, {once: true});
      try {
        const transfer = await this.desktop.beginAudioImport({size: blob.size}); token = transfer.token; check(signal);
        for (let offset = 0; offset < blob.size; offset += AUDIO_CHUNK_BYTES) { check(signal); await this.desktop.writeAudioImport(token, await blob.slice(offset, offset + AUDIO_CHUNK_BYTES).arrayBuffer()); }
        const output = await this.desktop.finishAudioImport(token); check(signal); let size = 0;
        for (;;) { const chunk = await this.desktop.readAudioImport(token); check(signal); size += chunk.bytes.byteLength; if (size > output.size || !chunk.bytes.byteLength && !chunk.done) throw messageError(new Error(''), "errors.audioEngine.invalidDecodedAudioStream", {}); parts.push(new Blob([chunk.bytes])); if (chunk.done) break; }
        if (size !== output.size) throw messageError(new Error(''), "errors.audioEngine.decodedAudioIsIncomplete", {}); token = null;
        return new Blob(parts, {type: 'audio/wav'});
      } finally { signal?.removeEventListener('abort', cancel); if (token) await this.desktop.cancelAudioImport(token).catch(() => {}); }
    }
    // Browser fallback is explicitly bounded before full decoding. Desktop
    // handles long compressed sources through FFmpeg and temporary files.
    if (blob.size > 8 * 1024 * 1024) throw messageError(new Error(''), "errors.audioEngine.useTheDesktopAppForCompressedRecordingsLarger", {});
    const url = URL.createObjectURL(blob), media = new Audio(); let duration;
    try {
      duration = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(messageError(new Error(''), "errors.audioEngine.audioMetadataCouldNotBeRead", {})), 10000);
        media.onloadedmetadata = () => { clearTimeout(timer); resolve(media.duration); };
        media.onerror = () => { clearTimeout(timer); reject(messageError(new Error(''), "errors.audioEngine.thisAudioFormatIsNotSupportedByThis", {})); }; media.src = url;
      });
    } finally { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); }
    if (!Number.isFinite(duration) || duration > 120) throw messageError(new Error(''), "errors.audioEngine.useTheDesktopAppForCompressedRecordingsLonger", {});
    check(signal); const context = new OfflineAudioContext(2, 1, AUDIO_RATE);
    const buffer = await context.decodeAudioData(await blob.arrayBuffer()); check(signal);
    if (buffer.length * buffer.numberOfChannels * 4 > 64 * 1024 * 1024) throw messageError(new Error(''), "errors.audioEngine.decodedAudioExceedsTheBrowserMemoryLimit", {});
    const channels = Array.from({length: Math.min(2, buffer.numberOfChannels)}, (_, index) => buffer.getChannelData(index));
    return this.request('wave', {channels, rate: buffer.sampleRate}, channels.map(channel => channel.buffer));
  }
  async import(file, {signal, onProgress = () => {}} = {}) {
    if (!(file instanceof Blob) || !file.size || file.size > MAX_AUDIO_FILE_BYTES) throw messageError(new Error(''), "errors.audioEngine.chooseAnAudioRecordingUpTo32Mib", {});
    const key = freshAudioId('sound'), cancel=()=>this.worker?.postMessage({operation:'cancel-import',key});
    signal?.addEventListener('abort',cancel,{once:true});
    try {
    onProgress('Decoding audio…'); const blob = await this.decode(file, signal); check(signal);
    onProgress('Drawing waveform…'); const metadata = await this.request('source', {key, blob, peaks: true}); check(signal);
    const asset = {id: key, name: (file.name || 'Audio.wav').slice(0, 240), size: file.size, duration: metadata.duration, peaks: metadata.peaks, chunks: []};
    for (let offset = 0; offset < file.size; offset += AUDIO_CHUNK_BYTES) { check(signal); asset.chunks.push(await this.request('encode', {blob: file, offset})); }
    for(const step of validateAudioAssetSteps(asset)){check(signal);await new Promise(resolve=>setTimeout(resolve,0));}
    this.sources.set(key, {asset, size: blob.size}); await this.evict(new Set([key]));
    return asset;
    } finally {signal?.removeEventListener('abort',cancel);if(signal?.aborted&&this.worker)await this.request('release',{ids:[...this.sources.keys()]}).catch(()=>{});}
  }
  async evict(keep) {
    let bytes = [...this.sources.values()].reduce((n, source) => n + source.size, 0);
    for (const [id, source] of this.sources) if (!keep.has(id) && bytes > CACHE_BYTES) { this.sources.delete(id); bytes -= source.size; }
    if (bytes > CACHE_BYTES) { this.sources.clear(); await this.request('release', {ids:[]}); throw messageError(new Error(''), "errors.audioEngine.theActiveAudioMixExceedsThe768Mib", {}); }
    await this.request('release', {ids: [...this.sources.keys()]});
  }
  prepare(report, {start = 0, end = Infinity, signal} = {}) {
    const state = audioState(report), clips = audibleClips(state).filter(clip => clip.start < end && clip.start + clip.duration > start);
    const run = async () => {
      check(signal); const needed = new Set(clips.map(clip => clip.assetId));
      for (const id of needed) {
        const asset = state.assets[id];
        if (this.sources.get(id)?.asset === asset) continue;
        await this.request('embedded-start', {key: id});
        for (const chunk of asset.chunks) { check(signal); await this.request('embedded-chunk', {key: id, chunk}); }
        const original = await this.request('embedded-end', {key: id}); check(signal);
        const blob = await this.decode(original, signal); check(signal);
        const metadata = await this.request('source', {key: id, blob});
        if (Math.abs(metadata.duration - asset.duration) > 1 / 100) throw messageError(new Error(''), "errors.audioEngine.theDecodedDurationOfHasChanged", {name: asset.name});
        this.sources.set(id, {asset, size: blob.size}); await this.evict(needed);
      }
      check(signal); await this.request('clips', {clips}); this.hasAudio = clips.length > 0; return this.hasAudio;
    };
    const pending = this.preparing.then(run).catch(async error => { if (this.worker) await this.request('embedded-clear').catch(() => {}); throw error; }); this.preparing = pending.catch(() => {}); return pending;
  }
  get running() { return Boolean(this.anchor); }
  get position() { return this.anchor ? Math.min(this.end, this.anchor.time + Math.max(0, this.context.currentTime - this.anchor.clock)) : this.stoppedAt ?? 0; }
  async start(time, end) {
    this.stop(); if (!this.hasAudio) return;
    const generation = this.generation; this.starting = true; this.end = end;
    try {
      await this.unlock(); if (generation !== this.generation) return;
      const start = Math.round(time * AUDIO_RATE), frames = Math.min(12000, Math.round(end * AUDIO_RATE) - start); if (frames < 1) return;
      const pcm = await this.request('mix', {start, frames}); if (generation !== this.generation) return;
      this.anchor = {time: start / AUDIO_RATE, clock: this.context.currentTime + .04}; this.nextSample = start;
      this.schedule(pcm); this.starting = false;
      this.timer = setInterval(() => void this.fill(generation), 40); void this.fill(generation);
    } catch (error) { if (generation === this.generation) { this.stop(); this.onError(error); } }
    finally { if (generation === this.generation) this.starting = false; }
  }
  schedule(pcm) {
    const frames = pcm.length / 2, buffer = this.context.createBuffer(2, frames, AUDIO_RATE);
    for (let c = 0; c < 2; c++) { const channel = buffer.getChannelData(c); for (let i = 0; i < frames; i++) channel[i] = pcm[i * 2 + c]; }
    const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.context.destination);
    node.onended = () => { node.disconnect(); this.nodes.delete(node); }; this.nodes.add(node);
    node.start(this.anchor.clock + this.nextSample / AUDIO_RATE - this.anchor.time); this.nextSample += frames;
  }
  async fill(generation) {
    if (this.filling || !this.anchor || generation !== this.generation) return;
    this.filling = true;
    try {
      while (generation === this.generation && this.anchor && this.nextSample < Math.round(this.end * AUDIO_RATE) && this.nextSample / AUDIO_RATE < this.position + .65) {
        const start = this.nextSample, frames = Math.min(12000, Math.round(this.end * AUDIO_RATE) - start);
        const pcm = await this.request('mix', {start, frames}); if (generation !== this.generation || !this.anchor) break;
        const clock = this.anchor.clock + start / AUDIO_RATE - this.anchor.time;
        if (clock < this.context.currentTime) { this.stop(); this.onError(messageError(new Error(''), "errors.audioEngine.audioPreparationFellBehindPlaybackPausedTryAgain", {})); break; }
        this.schedule(pcm);
      }
      if(this.anchor&&this.nextSample>=Math.round(this.end*AUDIO_RATE))clearInterval(this.timer);
    } catch (error) { if (generation === this.generation) { this.stop(); this.onError(error); } }
    finally { this.filling = false; }
  }
  stop() {
    this.stoppedAt = this.position; this.generation++; this.anchor = null; this.starting = false; clearInterval(this.timer);
    for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); } this.nodes.clear();
  }
  async *exportChunks(report, {start, duration, signal}) {
    this.stop(); await this.prepare(report, {start, end: start + duration, signal});
    const first = Math.round(start * AUDIO_RATE), length = Math.round(duration * AUDIO_RATE);
    for (let offset = 0; offset < length; offset += 12000) { check(signal); const pcm = await this.request('mix', {start: first + offset, frames: Math.min(12000, length - offset)}); check(signal); yield pcm; }
  }
  async clear() { this.stop(); this.hasAudio = false; this.sources.clear(); if (this.worker) await this.request('clear'); }
  dispose() { this.disposed = true; this.failWorker(abort()); void this.context?.close(); }
}
