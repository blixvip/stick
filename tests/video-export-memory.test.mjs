import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWebM, videoFrameWindow} from '../src/video-export.mjs';

test('browser video retains at most one 4K frame even after the encoder dequeues without output', async t => {
  const descriptors = ['VideoEncoder', 'VideoFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const frames = []; let instance;
  class Encoder extends EventTarget {
    static async isConfigSupported(config) {return {supported: true, config};}
    constructor(callbacks) {super(); instance = this; this.callbacks = callbacks; this.pending = []; this.peak = 0; this.state = 'unconfigured';}
    configure(config) {this.config = config; this.state = 'configured';}
    encode(frame, options) {
      this.pending.push({timestamp: frame.timestamp, type: options.keyFrame ? 'key' : 'delta'});
      this.peak = Math.max(this.peak, this.pending.length);
      this.encodeQueueSize = 0; this.dispatchEvent(new Event('dequeue'));
    }
    async flush() {for (const chunk of this.pending.splice(0)) this.callbacks.output({...chunk, byteLength: 4, copyTo(buffer) {buffer.set([1, 2, 3, 4]);}});}
    close() {this.state = 'closed';}
  }
  class Frame {
    constructor(canvas, options) {Object.assign(this, options); frames.push(this);}
    close() {this.closed = true;}
  }
  Object.assign(globalThis, {VideoEncoder: Encoder, VideoFrame: Frame});
  t.after(() => {for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}});
  const progress = [];
  const blob = await encodeWebM({width: 3840, height: 2160, fps: 24, totalFrames: 12,
    renderFrame: () => ({width: 3840, height: 2160}), onProgress: value => progress.push(value)});
  assert.equal(blob.type, 'video/webm'); assert.equal(instance.peak, 1);
  assert.equal(instance.config.hardwareAcceleration, 'prefer-software'); assert.equal(instance.config.latencyMode, 'quality');
  assert.equal(progress.length, 12); assert.equal(progress.at(-1).completed, 12);
  assert.ok(frames.every(frame => frame.closed)); assert.equal(instance.state, 'closed');
  assert.equal(videoFrameWindow(1920, 1080), 4); assert.equal(videoFrameWindow(3840, 2160), 1);
});

test('streamed WebM output reserves and patches the segment size, matching the blob mux', async t => {
  const descriptors = ['VideoEncoder', 'VideoFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  class Encoder extends EventTarget {
    static async isConfigSupported(config) {return {supported: true, config};}
    constructor(callbacks) {super(); this.callbacks = callbacks; this.state = 'unconfigured';}
    configure(config) {this.state = 'configured';}
    encode(frame, options) {this.pending = this.pending || []; this.pending.push({timestamp: frame.timestamp, type: options.keyFrame ? 'key' : 'delta'});}
    async flush() {for (const chunk of this.pending.splice(0)) this.callbacks.output({...chunk, byteLength: 4, copyTo(buffer) {buffer.set([1, 2, 3, 4]);}});}
    close() {this.state = 'closed';}
  }
  class Frame { constructor(canvas, options) {Object.assign(this, options);} close() {} }
  Object.assign(globalThis, {VideoEncoder: Encoder, VideoFrame: Frame});
  t.after(() => {for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}});
  const options = {width: 320, height: 240, fps: 24, totalFrames: 5, renderFrame: () => ({width: 320, height: 240})};
  const plain = new Uint8Array(await (await encodeWebM(options)).arrayBuffer());

  const written = [], patches = [];
  const sink = {
    streamed: true, position: 0,
    async write(part) { const bytes = new Uint8Array(part instanceof Blob ? await part.arrayBuffer() : part); written.push(bytes); this.position += bytes.byteLength; },
    async patch(offset, bytes) { patches.push({offset, bytes: [...bytes]}); },
    async finish() { return {saved: true, size: this.position}; },
    async abort() { this.aborted = true; },
  };
  const result = await encodeWebM({...options, sink});
  assert.equal(result.saved, true);
  const streamed = new Uint8Array(written.reduce((total, part) => total + part.byteLength, 0));
  let cursor = 0;
  for (const part of written) { streamed.set(part, cursor); cursor += part.byteLength; }
  for (const {offset, bytes} of patches) streamed.set(bytes, offset);
  // One patch: the 8-byte segment size field right after the Segment ID.
  assert.equal(patches.length, 1);
  const segment = plain.length - streamed.length; // streamed segment size field is wider
  assert.ok(segment <= 0, 'streamed output must be at least as large');
  // Find the Segment element (0x1A53 0x8067) in the streamed bytes.
  let at = -1;
  for (let i = 0; i < streamed.length - 12; i++) if (streamed[i] === 0x18 && streamed[i + 1] === 0x53 && streamed[i + 2] === 0x80 && streamed[i + 3] === 0x67) { at = i; break; }
  assert.ok(at > 0);
  assert.equal(patches[0].offset, at + 4);
  assert.equal(patches[0].bytes[0], 0x01); // fixed 8-byte VINT marker
  let declared = 0;
  for (let i = 1; i < 8; i++) declared = declared * 256 + patches[0].bytes[i];
  assert.equal(declared, streamed.length - at - 12, 'patched size must equal the segment body length');
  // Everything except the segment size field must be byte-identical.
  assert.deepEqual([...streamed.subarray(0, at + 4)], [...plain.subarray(0, at + 4)]);
  // Segment bodies: streamed starts at at+12; plain segment has a compact VINT.
  const plainBody = plain.length - at - 4 - (plain[at + 4] & 0x80 ? 1 : plain[at + 4] & 0x40 ? 2 : 8);
  const plainHeader = at + 4 + (plain[at + 4] & 0x80 ? 1 : plain[at + 4] & 0x40 ? 2 : 8);
  assert.deepEqual([...streamed.subarray(at + 12)], [...plain.subarray(plainHeader)]);
});
