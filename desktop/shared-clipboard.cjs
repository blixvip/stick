'use strict';
const { messageError } = require('./localization.cjs');


const {randomUUID} = require('node:crypto');
const FORMAT = 'application/x-stykanimate-clipboard-v1';
const MAX_BYTES = 256 * 1024 * 1024, CHUNK_BYTES = 256 * 1024;

// Only complete, bounded transfers are published to the OS clipboard. Readers
// retain their own snapshot so another application's Copy cannot mix packets.
class SharedClipboard {
  constructor(clipboard) { this.clipboard = clipboard; this.jobs = new Map(); }
  register(job) {
    if (this.jobs.size >= 4) throw messageError(new Error(''), 'desktop.sharedClipboard.errors.tooManyClipboardTransfers', {});
    const token = randomUUID();
    job.timer = setTimeout(() => this.cancel(token), 120000); job.timer.unref?.();
    this.jobs.set(token, job); return token;
  }
  beginWrite() { return {token: this.register({mode: 'write', parts: [], size: 0}), maxChunkBytes: CHUNK_BYTES}; }
  write(token, bytes) {
    const job = this.jobs.get(token);
    if (job?.mode !== 'write') throw messageError(new Error(''), 'desktop.sharedClipboard.errors.theClipboardTransferHasExpired', {});
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > CHUNK_BYTES) throw messageError(new Error(''), 'desktop.sharedClipboard.errors.invalidClipboardPacket', {});
    job.size += bytes.byteLength + 4;
    if (job.size > MAX_BYTES) { this.cancel(token); throw messageError(new Error(''), 'desktop.sharedClipboard.errors.theClipboardExceedsThe256MBLimit', {}); }
    const size = Buffer.alloc(4); size.writeUInt32LE(bytes.byteLength);
    job.parts.push(size, Buffer.from(bytes));
  }
  finish(token) {
    const job = this.jobs.get(token);
    if (job?.mode !== 'write' || !job.size) throw messageError(new Error(''), 'desktop.sharedClipboard.errors.theClipboardTransferIsEmptyOrExpired', {});
    const id = randomUUID();
    try { this.clipboard.writeBuffer(FORMAT, Buffer.concat([Buffer.from(id), ...job.parts])); return {id}; }
    finally { this.cancel(token); }
  }
  beginRead(knownId) {
    const bytes = this.clipboard.readBuffer(FORMAT);
    // Chromium's availableFormats() omits raw custom formats on Windows.
    if (!bytes?.length) return null;
    if (bytes.length < 41 || bytes.length > MAX_BYTES + 36) throw messageError(new Error(''), 'desktop.sharedClipboard.errors.invalidStykAnimateClipboardData', {});
    const id = bytes.toString('ascii', 0, 36);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw messageError(new Error(''), 'desktop.sharedClipboard.errors.invalidClipboardIdentity', {});
    if (id === knownId) return {id, unchanged: true};
    return {id, token: this.register({mode: 'read', bytes, offset: 36})};
  }
  read(token) {
    const job = this.jobs.get(token);
    if (job?.mode !== 'read') throw messageError(new Error(''), 'desktop.sharedClipboard.errors.theClipboardTransferHasExpired', {});
    const {bytes, offset} = job;
    if (offset + 4 > bytes.length) { this.cancel(token); throw messageError(new Error(''), 'desktop.sharedClipboard.errors.truncatedClipboardPacket', {}); }
    const size = bytes.readUInt32LE(offset), end = offset + 4 + size;
    if (!size || size > CHUNK_BYTES || end > bytes.length) { this.cancel(token); throw messageError(new Error(''), 'desktop.sharedClipboard.errors.invalidClipboardPacketSize', {}); }
    job.offset = end;
    const done = end === bytes.length;
    if (done) this.cancel(token);
    return {bytes: bytes.buffer.slice(bytes.byteOffset + offset + 4, bytes.byteOffset + end), done};
  }
  cancel(token) { const job = this.jobs.get(token); clearTimeout(job?.timer); this.jobs.delete(token); }
  dispose() { for (const token of this.jobs.keys()) this.cancel(token); }
}
module.exports = {SharedClipboard, FORMAT};
