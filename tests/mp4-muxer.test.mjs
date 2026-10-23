import test from 'node:test';
import assert from 'node:assert/strict';
import {Mp4Muxer, avcCodecStrings} from '../src/mp4-muxer.mjs';
import {encodeMP4, avcCodedSize} from '../src/video-export.mjs';

const ascii = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
/** The boxes between two offsets: {type, start, size, payload: [from, to]}. */
function boxes(bytes, start = 0, end = bytes.length) {
  const found = [];
  for (let at = start; at < end;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    let size = view.getUint32(0), header = 8;
    if (size === 1) { size = Number(view.getBigUint64(8)); header = 16; }
    assert.ok(size >= header && at + size <= end, `box ${ascii(bytes, at + 4)} at ${at} overruns its parent`);
    found.push({type: ascii(bytes, at + 4), start: at, size, payload: [at + header, at + size]});
    at += size;
  }
  return found;
}
const child = (bytes, parent, type) => boxes(bytes, ...parent.payload).find(box => box.type === type);
const path = (bytes, root, ...types) => types.reduce((box, type) => { const next = child(bytes, box, type); assert.ok(next, `missing ${type}`); return next; }, root);
const view = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset + at);

const DESCRIPTION = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
const metadata = {decoderConfig: {description: DESCRIPTION.buffer.slice(0), colorSpace: {primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false}}};
const chunkOf = (timestamp, type, bytes) => ({timestamp, type, byteLength: bytes.length, copyTo(target) { target.set(bytes); }});
const SAMPLES = [[1, 2, 3, 4, 5], [6, 7], [8, 9, 10], [11], [12, 13, 14, 15]].map(list => new Uint8Array(list));

function mux(options = {}) {
  const muxer = new Mp4Muxer({width: 320, height: 240, fps: 24, totalFrames: SAMPLES.length, maxBytes: 1 << 20, ...options});
  SAMPLES.forEach((bytes, index) => muxer.add(chunkOf(Math.round(index * 1e6 / 24), index === 0 || index === 3 ? 'key' : 'delta', bytes), index === 0 ? metadata : undefined));
  return muxer;
}

test('an MP4 file has ftyp, mdat and a moov whose tables describe every sample', async () => {
  const bytes = new Uint8Array(await mux().finish(SAMPLES.length).arrayBuffer());
  const top = boxes(bytes);
  assert.deepEqual(top.map(box => box.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(ascii(bytes, top[0].payload[0]), 'isom');
  const [mdat, moov] = [top[1], top[2]];
  const total = SAMPLES.reduce((sum, sample) => sum + sample.length, 0);
  assert.equal(mdat.size, 16 + total, 'the 64-bit mdat size covers exactly the samples');

  const track = path(bytes, moov, 'trak');
  const media = path(bytes, track, 'mdia'), table = path(bytes, media, 'minf', 'stbl');
  assert.equal(view(bytes, path(bytes, media, 'mdhd').payload[0]).getUint32(12), 24000, 'media timescale is fps x 1000');
  assert.equal(view(bytes, path(bytes, media, 'mdhd').payload[0]).getUint32(16), 5000, 'five 1000-tick samples');
  assert.equal(ascii(bytes, path(bytes, media, 'hdlr').payload[0] + 8), 'vide');
  const tkhd = path(bytes, track, 'tkhd').payload[0];
  assert.equal(view(bytes, tkhd).getUint32(0) & 0xffffff, 3, 'the track is enabled and in the movie');
  assert.equal(view(bytes, tkhd + 76).getUint32(0) >>> 16, 320); assert.equal(view(bytes, tkhd + 80).getUint32(0) >>> 16, 240);

  const stts = path(bytes, table, 'stts').payload[0];
  assert.deepEqual([4, 8, 12].map(offset => view(bytes, stts + offset).getUint32(0)), [1, 5, 1000]);
  const stss = path(bytes, table, 'stss').payload[0];
  assert.deepEqual([4, 8, 12].map(offset => view(bytes, stss + offset).getUint32(0)), [2, 1, 4], 'keyframes are numbered from 1');
  const stsz = path(bytes, table, 'stsz').payload[0];
  assert.equal(view(bytes, stsz + 8).getUint32(0), SAMPLES.length);
  assert.deepEqual(SAMPLES.map((_, i) => view(bytes, stsz + 12 + i * 4).getUint32(0)), SAMPLES.map(sample => sample.length));
  const stsc = path(bytes, table, 'stsc').payload[0];
  assert.deepEqual([4, 8, 12, 16].map(offset => view(bytes, stsc + offset).getUint32(0)), [1, 1, 5, 1]);
  const offset = view(bytes, path(bytes, table, 'stco').payload[0] + 8).getUint32(0);
  assert.equal(offset, mdat.start + 16);
  assert.deepEqual([...bytes.subarray(offset, offset + total)], SAMPLES.flatMap(sample => [...sample]), 'the chunk offset is the first sample');

  const entry = path(bytes, table, 'stsd').payload[0] + 8;
  assert.equal(ascii(bytes, entry + 4), 'avc1');
  const avc1 = {payload: [entry + 8, entry + view(bytes, entry).getUint32(0)]};
  assert.equal(view(bytes, avc1.payload[0] + 24).getUint16(0), 320); assert.equal(view(bytes, avc1.payload[0] + 26).getUint16(0), 240);
  const inner = boxes(bytes, avc1.payload[0] + 78, avc1.payload[1]);
  const avcC = inner.find(box => box.type === 'avcC');
  assert.deepEqual([...bytes.subarray(...avcC.payload)], [...DESCRIPTION], 'the encoder\'s own decoder configuration is stored unchanged');
  const colr = inner.find(box => box.type === 'colr');
  assert.equal(ascii(bytes, colr.payload[0]), 'nclx');
  assert.deepEqual([4, 6, 8].map(at => view(bytes, colr.payload[0] + at).getUint16(0)), [1, 1, 1]);
});

test('streamed MP4 output patches the mdat size and matches the blob mux byte for byte', async () => {
  const plain = new Uint8Array(await mux().finish(SAMPLES.length).arrayBuffer());
  const streamed = mux({streamed: true});
  const tail = streamed.finish(SAMPLES.length);
  const parts = streamed.drain();
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  assert.equal(tail.patch.bytes.length, 8);
  assert.equal(tail.patch.offset, boxes(bytes.subarray(0, 32))[0].size + 8, 'the patch is the 64-bit size inside the mdat header');
  bytes.set(tail.patch.bytes, tail.patch.offset);
  assert.deepEqual(bytes, plain);
});

test('the muxer refuses streams it cannot describe honestly', () => {
  const fresh = () => new Mp4Muxer({width: 320, height: 240, fps: 24, totalFrames: 2, maxBytes: 1 << 20});
  assert.throws(() => fresh().add(chunkOf(0, 'delta', SAMPLES[0]), metadata), /initial keyframe/);
  assert.throws(() => fresh().add(chunkOf(0, 'key', SAMPLES[0]), {}), /describe its H\.264 stream/);
  const muxer = fresh();
  muxer.add(chunkOf(41667, 'key', SAMPLES[0]), metadata);
  assert.throws(() => muxer.add(chunkOf(0, 'delta', SAMPLES[1])), /out-of-order/, 'B-frame reordering is reported, not written with wrong timing');
  assert.throws(() => muxer.finish(2), /1 of 2 frames/);
  const small = new Mp4Muxer({width: 320, height: 240, fps: 24, totalFrames: 1, maxBytes: 4200});
  assert.throws(() => small.add(chunkOf(0, 'key', new Uint8Array(200)), metadata), /size limit/);
  assert.throws(() => new Mp4Muxer({width: 320, height: 240, fps: 5e6, totalFrames: 1, maxBytes: 1 << 20}), /frame rate/);
});

test('the H.264 codec string uses the lowest level that fits the picture and rate', () => {
  assert.deepEqual(avcCodecStrings(1280, 720, 30), ['avc1.64001f', 'avc1.4d001f', 'avc1.42001f']);
  assert.equal(avcCodecStrings(1920, 1080, 24)[0], 'avc1.640028');
  assert.equal(avcCodecStrings(3840, 2160, 24)[0], 'avc1.640033');
  assert.equal(avcCodecStrings(3840, 2160, 60)[0], 'avc1.640034');
  assert.equal(avcCodecStrings(160, 90, 24)[0], 'avc1.64000a');
  assert.deepEqual(avcCodedSize(321, 241), {width: 322, height: 242});
  assert.deepEqual(avcCodedSize(320, 240), {width: 320, height: 240});
});

function install(t, {supports = () => true} = {}) {
  const keys = ['VideoEncoder', 'VideoFrame', 'OffscreenCanvas'], saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const state = {configs: [], frames: [], canvases: []};
  class Encoder extends EventTarget {
    static async isConfigSupported(config) { state.configs.push(config); return {supported: supports(config), config}; }
    constructor(callbacks) { super(); this.callbacks = callbacks; this.pending = []; this.state = 'unconfigured'; state.encoder = this; }
    configure(config) { this.config = config; this.state = 'configured'; }
    encode(frame, options) { this.pending.push({timestamp: frame.timestamp, type: options.keyFrame ? 'key' : 'delta'}); }
    async flush() {
      for (const chunk of this.pending.splice(0)) this.callbacks.output({...chunk, byteLength: 4, copyTo(buffer) { buffer.set([1, 2, 3, 4]); }}, chunk.type === 'key' && !this.described ? (this.described = true, metadata) : undefined);
    }
    close() { this.state = 'closed'; }
  }
  class Frame { constructor(source, options) { Object.assign(this, options, {source}); state.frames.push(this); } close() { this.closed = true; } }
  class Canvas {
    constructor(width, height) { Object.assign(this, {width, height, draws: [], fills: []}); state.canvases.push(this); }
    getContext() { return {set fillStyle(value) { this.color = value; }, fillRect: (...args) => this.fills.push(args), drawImage: (...args) => this.draws.push(args)}; }
  }
  Object.assign(globalThis, {VideoEncoder: Encoder, VideoFrame: Frame, OffscreenCanvas: Canvas});
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return state;
}

test('encodeMP4 asks for length-prefixed H.264 and returns an MP4 blob', async t => {
  const state = install(t);
  const progress = [];
  const blob = await encodeMP4({width: 1920, height: 1080, fps: 24, totalFrames: 5, renderFrame: () => ({width: 1920, height: 1080}), onProgress: value => progress.push(value)});
  assert.equal(blob.type, 'video/mp4');
  const config = state.encoder.config;
  assert.equal(config.codec, 'avc1.640028'); assert.deepEqual(config.avc, {format: 'avc'});
  assert.equal(config.width, 1920); assert.equal(config.height, 1080); assert.equal(config.latencyMode, 'quality');
  assert.equal(state.canvases.length, 0, 'an even picture needs no copy');
  assert.equal(progress.at(-1).completed, 5);
  assert.ok(state.frames.every(frame => frame.closed)); assert.equal(state.encoder.state, 'closed');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(boxes(bytes).map(box => box.type), ['ftyp', 'mdat', 'moov']);
});

test('encodeMP4 pads an odd picture with black and falls back to a simpler H.264 profile', async t => {
  const state = install(t, {supports: config => config.codec.startsWith('avc1.42')});
  const source = {width: 321, height: 241};
  const blob = await encodeMP4({width: 321, height: 241, fps: 24, totalFrames: 3, renderFrame: () => source});
  assert.deepEqual(state.configs.map(config => config.codec.slice(0, 7)), ['avc1.64', 'avc1.4d', 'avc1.42'], 'High, then Main, then Baseline');
  assert.equal(state.encoder.config.width, 322); assert.equal(state.encoder.config.height, 242);
  assert.equal(state.canvases.length, 1, 'one scratch canvas is reused for every frame');
  const [pad] = state.canvases;
  assert.deepEqual([pad.width, pad.height], [322, 242]);
  assert.equal(pad.fills.length, 3); assert.equal(pad.draws.length, 3);
  assert.ok(pad.draws.every(([image]) => image === source));
  assert.ok(state.frames.every(frame => frame.source === pad));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const moov = boxes(bytes).find(box => box.type === 'moov');
  const tkhd = path(bytes, moov, 'trak', 'tkhd').payload[0];
  assert.equal(view(bytes, tkhd + 76).getUint32(0) >>> 16, 322, 'the track is the size that was encoded');
});

test('encodeMP4 reports a size no H.264 encoder supports', async t => {
  install(t, {supports: () => false});
  await assert.rejects(encodeMP4({width: 320, height: 240, fps: 24, totalFrames: 1, renderFrame: () => ({width: 320, height: 240})}), /No H\.264 video encoder/);
});

test('encodeMP4 streams through a sink like WebM', async t => {
  install(t);
  const written = [], patches = [];
  const sink = {streamed: true, position: 0,
    async write(part) { const bytes = new Uint8Array(part); written.push(bytes); this.position += bytes.byteLength; },
    async patch(offset, bytes) { patches.push({offset, bytes: [...bytes]}); },
    async finish() { return {saved: true, size: this.position}; },
    async abort() { this.aborted = true; }};
  const options = {width: 320, height: 240, fps: 24, totalFrames: 5, renderFrame: () => ({width: 320, height: 240})};
  const plain = new Uint8Array(await (await encodeMP4(options)).arrayBuffer());
  const result = await encodeMP4({...options, sink});
  assert.equal(result.saved, true);
  const bytes = new Uint8Array(written.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of written) { bytes.set(part, at); at += part.byteLength; }
  assert.equal(patches.length, 1);
  bytes.set(patches[0].bytes, patches[0].offset);
  assert.deepEqual(bytes, plain);
  assert.equal(sink.aborted, undefined);
});
