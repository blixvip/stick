import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_CODECS, MAX_AUDIO_SECONDS, audioEncoderSupported, encodeAudio, opusHead} from '../src/audio-encode.mjs';
import {Mp4Muxer} from '../src/mp4-muxer.mjs';
import {encodeMP4, encodeWebM} from '../src/video-export.mjs';
import {getExportCapabilities} from '../src/export-capabilities.mjs';
import {buildExportRequest, exportFormatStates, validateExportRequest, videoExportArguments} from '../src/export-request.mjs';

const ASC = new Uint8Array([0x11, 0x90]);           // AAC-LC, 48 kHz, stereo
const OPUS_HEAD = opusHead({preSkip: 312});
const stereo = (frames, value = 0.25) => new Float32Array(frames * 2).fill(value);
async function* chunks(...sizes) { for (const frames of sizes) yield stereo(frames); }

/** Fake WebCodecs audio: every 1024 (AAC) or 960 (Opus) input frames become one 40-byte packet, after flush. */
const ORIGINALS = ['AudioEncoder', 'AudioData', 'VideoEncoder', 'VideoFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
function install(t, {supports = () => true, described = true, queueLimit = 0} = {}) {
  const state = {configs: [], data: [], encoders: []};
  class Audio extends EventTarget {
    static async isConfigSupported(config) { return {supported: supports(config), config}; }
    constructor(callbacks) { super(); Object.assign(this, {callbacks, frames: 0, state: 'unconfigured', queued: 0}); state.encoders.push(this); }
    get encodeQueueSize() { return this.queued; }
    configure(config) { this.config = config; this.state = 'configured'; state.configs.push(config); }
    encode(data) {
      this.frames += data.numberOfFrames;
      if (queueLimit) { this.queued += 20; setTimeout(() => { this.queued = 0; this.dispatchEvent(new Event('dequeue')); }, 1); }
    }
    async flush() {
      const size = this.config.codec === 'opus' ? 960 : 1024, count = Math.ceil(this.frames / size);
      for (let i = 0; i < count; i++) {
        const timestamp = Math.round(i * size * 1e6 / 48000);
        this.callbacks.output({timestamp, duration: Math.round(size * 1e6 / 48000), byteLength: 40, copyTo(target) { target.fill(i % 250 + 1); }},
          i === 0 && described ? {decoderConfig: {description: (this.config.codec === 'opus' ? OPUS_HEAD : ASC).buffer.slice(0)}} : undefined);
      }
    }
    close() { this.state = 'closed'; }
  }
  class Data { constructor(init) { Object.assign(this, init); state.data.push(this); } close() { this.closed = true; } }
  class Encoder extends EventTarget {
    static async isConfigSupported(config) { return {supported: true, config}; }
    constructor(callbacks) { super(); this.callbacks = callbacks; this.pending = []; this.state = 'unconfigured'; }
    configure() { this.state = 'configured'; }
    encode(frame, options) { this.pending.push({timestamp: frame.timestamp, type: options.keyFrame ? 'key' : 'delta'}); }
    async flush() {
      for (const chunk of this.pending.splice(0)) this.callbacks.output({...chunk, byteLength: 6, copyTo(target) { target.fill(7); }}, chunk.type === 'key' && !this.described ? (this.described = true, {decoderConfig: {description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]).buffer}}) : undefined);
    }
    close() { this.state = 'closed'; }
  }
  class Frame { constructor(source, options) { Object.assign(this, options); } close() {} }
  Object.assign(globalThis, {AudioEncoder: Audio, AudioData: Data, VideoEncoder: Encoder, VideoFrame: Frame});
  t.after(() => { for (const [key, descriptor] of ORIGINALS) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return state;
}

// --- Container readers -------------------------------------------------------------------

const ascii = (bytes, at, length = 4) => String.fromCharCode(...bytes.subarray(at, at + length));
const view = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset + at);
function boxes(bytes, start = 0, end = bytes.length) {
  const found = [];
  for (let at = start; at < end;) {
    let size = view(bytes, at).getUint32(0), header = 8;
    if (size === 1) { size = Number(view(bytes, at).getBigUint64(8)); header = 16; }
    assert.ok(size >= header && at + size <= end, `box ${ascii(bytes, at + 4)} overruns its parent`);
    found.push({type: ascii(bytes, at + 4), start: at, size, payload: [at + header, at + size]});
    at += size;
  }
  return found;
}
const child = (bytes, parent, type, nth = 0) => boxes(bytes, ...parent.payload).filter(box => box.type === type)[nth];
const trackOf = (bytes, handler) => boxes(bytes, ...boxes(bytes).find(box => box.type === 'moov').payload).filter(box => box.type === 'trak')
  .find(track => ascii(bytes, child(bytes, child(bytes, track, 'mdia'), 'hdlr').payload[0] + 8) === handler);

/** EBML elements: {id, payload: [from, to]} between two offsets. */
function elements(bytes, start = 0, end = bytes.length) {
  const found = [];
  for (let at = start; at < end;) {
    let idLength = 1; while (!(bytes[at] & (0x80 >> (idLength - 1)))) idLength++;
    const id = [...bytes.subarray(at, at + idLength)].reduce((sum, byte) => sum * 256 + byte, 0);
    let sizeLength = 1; while (!(bytes[at + idLength] & (0x80 >> (sizeLength - 1)))) sizeLength++;
    let size = bytes[at + idLength] & (0xff >> sizeLength);
    for (let i = 1; i < sizeLength; i++) size = size * 256 + bytes[at + idLength + i];
    const from = at + idLength + sizeLength;
    found.push({id, payload: [from, from + size]});
    at = from + size;
  }
  return found;
}
const number = (bytes, [from, to]) => [...bytes.subarray(from, to)].reduce((sum, byte) => sum * 256 + byte, 0);

// --- The audio encoder -------------------------------------------------------------------

test('a soundtrack is encoded to AAC or Opus packets with the stream description', async t => {
  const state = install(t);
  const aac = await encodeAudio({codec: 'aac', chunks: chunks(12000, 12000, 6000), seconds: 0.625});
  assert.deepEqual(state.configs[0], {codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000, aac: {format: 'aac'}});
  assert.deepEqual(state.data.map(data => [data.format, data.sampleRate, data.numberOfChannels, data.numberOfFrames]), [['f32', 48000, 2, 12000], ['f32', 48000, 2, 12000], ['f32', 48000, 2, 6000]]);
  assert.deepEqual(state.data.map(data => data.timestamp), [0, 250000, 500000], 'chunks are timed by the samples before them');
  assert.ok(state.data.every(data => data.closed) && state.encoders[0].state === 'closed');
  assert.equal(aac.packets.length, Math.ceil(30000 / 1024)); assert.deepEqual([...aac.description], [...ASC]);
  assert.equal(aac.packets[0].timestamp, 0); assert.equal(aac.packets[1].duration, 21333); assert.equal(aac.packets[0].data.length, 40);
  assert.equal(aac.sampleRate, 48000); assert.equal(aac.channels, 2);

  const opus = await encodeAudio({codec: 'opus', chunks: chunks(12000), seconds: 0.25});
  assert.deepEqual(state.configs[1], {codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, opus: {application: 'audio', frameDuration: 20000}});
  assert.equal(opus.packets.length, 13); assert.equal(opus.preSkip, 312); assert.deepEqual([...opus.description], [...OPUS_HEAD]);
  assert.equal(new TextDecoder().decode(OPUS_HEAD.subarray(0, 8)), 'OpusHead'); assert.equal(OPUS_HEAD.length, 19);
});

test('silence, undescribed streams and unusable input are reported, never encoded wrongly', async t => {
  install(t);
  assert.equal(await encodeAudio({codec: 'aac', chunks: chunks()}), null, 'no samples means no soundtrack');
  await assert.rejects(encodeAudio({codec: 'aac', chunks: [new Float32Array(5)]}), /invalid samples/);
  await assert.rejects(encodeAudio({codec: 'aac', chunks: [new Int16Array(4)]}), /invalid samples/);
  await assert.rejects(encodeAudio({codec: 'aac', chunks: chunks(100), seconds: MAX_AUDIO_SECONDS + 1}), /up to one hour/);
  await assert.rejects(encodeAudio({codec: 'flac', chunks: chunks(100)}), /Unknown audio codec/);
  await assert.rejects(encodeAudio({codec: 'aac', chunks: chunks(12000, 12000), maxBytes: 100}), /size limit/);
});

test('an encoder that does not describe its stream is rejected for AAC and given the standard header for Opus', async t => {
  install(t, {described: false});
  await assert.rejects(encodeAudio({codec: 'aac', chunks: chunks(2048)}), /did not describe its AAC stream/);
  const opus = await encodeAudio({codec: 'opus', chunks: chunks(2048)});
  assert.deepEqual([...opus.description], [...opusHead()]);
});

test('a browser without the encoder says so and the soundtrack is not silently dropped', async t => {
  install(t, {supports: config => config.codec === 'opus'});
  await assert.rejects(encodeAudio({codec: 'aac', chunks: chunks(100)}), /cannot encode AAC sound.*Turn off Include sound/);
  assert.equal(await audioEncoderSupported('aac'), false); assert.equal(await audioEncoderSupported('opus'), true);
  assert.equal(await audioEncoderSupported('opus', {}), false, 'no AudioEncoder at all');
  delete globalThis.AudioEncoder;
  await assert.rejects(encodeAudio({codec: 'opus', chunks: chunks(100)}), /cannot encode sound/);
});

test('a slow encoder is waited for', async t => {
  const state = install(t, {queueLimit: 1});
  const done = await encodeAudio({codec: 'opus', chunks: chunks(12000, 12000, 12000)});
  assert.ok(done.packets.length > 0 && state.data.length === 3, 'each chunk waited for the queue to drain');
});

test('cancelling stops the audio encoder', async t => {
  install(t);
  const controller = new AbortController();
  async function* cancelling() { yield stereo(12000); controller.abort(); yield stereo(12000); }
  await assert.rejects(encodeAudio({codec: 'aac', chunks: cancelling(), signal: controller.signal}), error => error.name === 'AbortError');
  await assert.rejects(encodeAudio({codec: 'aac', chunks: chunks(100), signal: controller.signal}), error => error.name === 'AbortError');
});

// --- MP4 ---------------------------------------------------------------------------------

const AVC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
const video = i => ({timestamp: Math.round(i * 1e6 / 24), type: i === 0 ? 'key' : 'delta', byteLength: 5, copyTo(target) { target.set([i, i, i, i, i]); }});
function packets(count, size = 1024) {
  return Array.from({length: count}, (_, i) => ({timestamp: Math.round(i * size * 1e6 / 48000), duration: Math.round(size * 1e6 / 48000), data: new Uint8Array(30 + (i % 3)).fill(100 + i)}));
}
function mux(options = {}, sound = {codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC, packets: packets(5)}) {
  const muxer = new Mp4Muxer({width: 320, height: 240, fps: 24, totalFrames: 4, maxBytes: 1 << 20, audio: sound, ...options});
  for (let i = 0; i < 4; i++) muxer.add(video(i), i === 0 ? {decoderConfig: {description: AVC.buffer.slice(0)}} : undefined);
  return muxer;
}

test('an MP4 with sound has an AAC track whose samples follow the video in mdat', async () => {
  const bytes = new Uint8Array(await mux().finish(4).arrayBuffer());
  const top = boxes(bytes), mdat = top[1];
  assert.deepEqual(top.map(box => box.type), ['ftyp', 'mdat', 'moov']);
  const sound = packets(5), audioBytes = sound.reduce((sum, packet) => sum + packet.data.length, 0);
  assert.equal(mdat.size, 16 + 4 * 5 + audioBytes, 'the mdat covers the video samples and the sound');

  const moov = top[2], tracks = boxes(bytes, ...moov.payload).filter(box => box.type === 'trak');
  assert.equal(tracks.length, 2);
  const mvhd = child(bytes, moov, 'mvhd').payload[0];
  assert.equal(view(bytes, mvhd + 96).getUint32(0), 3, 'the next track id follows both tracks');
  const audio = trackOf(bytes, 'soun'), media = child(bytes, audio, 'mdia'), table = child(bytes, child(bytes, media, 'minf'), 'stbl');
  assert.equal(view(bytes, child(bytes, audio, 'tkhd').payload[0] + 12).getUint32(0), 2, 'track id 2');
  assert.equal(view(bytes, child(bytes, media, 'mdhd').payload[0] + 12).getUint32(0), 48000, 'timed in samples');
  assert.equal(view(bytes, child(bytes, media, 'mdhd').payload[0] + 16).getUint32(0), 5 * 1024);
  const stts = child(bytes, table, 'stts').payload[0];
  assert.deepEqual([4, 8, 12].map(offset => view(bytes, stts + offset).getUint32(0)), [1, 5, 1024], 'equal packets share one entry');
  const stsz = child(bytes, table, 'stsz').payload[0];
  assert.equal(view(bytes, stsz + 8).getUint32(0), 5);
  assert.deepEqual(sound.map((_, i) => view(bytes, stsz + 12 + i * 4).getUint32(0)), sound.map(packet => packet.data.length));
  const offset = view(bytes, child(bytes, table, 'stco').payload[0] + 8).getUint32(0);
  assert.equal(offset, mdat.start + 16 + 4 * 5, 'the sound chunk starts where the video samples end');
  assert.deepEqual([...bytes.subarray(offset, offset + sound[0].data.length)], [...sound[0].data]);

  const entry = child(bytes, table, 'stsd').payload[0] + 8;
  assert.equal(ascii(bytes, entry + 4), 'mp4a');
  assert.equal(view(bytes, entry + 8 + 16).getUint16(0), 2, 'two channels'); assert.equal(view(bytes, entry + 8 + 24).getUint32(0), 48000 * 65536);
  const esds = boxes(bytes, entry + 8 + 28, entry + view(bytes, entry).getUint32(0)).find(box => box.type === 'esds');
  const body = bytes.subarray(esds.payload[0] + 4, esds.payload[1]);
  assert.equal(body[0], 0x03, 'an ES descriptor'); assert.equal(body[5], 0x04, 'holding a decoder configuration'); assert.equal(body[7], 0x40, 'of object type MPEG-4 audio');
  assert.deepEqual([...body.subarray(body.length - 7)], [0x05, 2, 0x11, 0x90, 0x06, 1, 2], 'the AudioSpecificConfig, then the SL settings');
  assert.equal(view(bytes, child(bytes, trackOf(bytes, 'vide'), 'tkhd').payload[0] + 20).getUint32(0), 167, 'the video track keeps its own length (4 frames at 24 fps)');
  assert.equal(view(bytes, mvhd + 16).getUint32(0), 167, 'the movie lasts as long as its longer track (5 AAC frames are 107 ms)');
});

test('the movie lasts as long as its longer track, and streamed output matches the blob', async () => {
  const long = {codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC, packets: packets(400)};
  const bytes = new Uint8Array(await mux({}, long).finish(4).arrayBuffer());
  const moov = boxes(bytes)[2];
  assert.equal(view(bytes, child(bytes, moov, 'mvhd').payload[0] + 16).getUint32(0), Math.round(400 * 1024 * 1000 / 48000), 'the sound is longer than the video');

  const plain = new Uint8Array(await mux().finish(4).arrayBuffer());
  const streamed = mux({streamed: true}), tail = streamed.finish(4), parts = streamed.drain();
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.byteLength; }
  joined.set(tail.patch.bytes, tail.patch.offset);
  assert.deepEqual(joined, plain);
  assert.ok(parts.length < 12, 'sound is written in blocks, not once per packet');

  const silent = new Uint8Array(await mux({}, null).finish(4).arrayBuffer());
  assert.equal(boxes(silent, ...boxes(silent)[2].payload).filter(box => box.type === 'trak').length, 1, 'no soundtrack, no sound track');
  assert.throws(() => mux({maxBytes: 4500}, {codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC, packets: packets(200)}).finish(4), /size limit/);
});

// --- WebM --------------------------------------------------------------------------------

test('a WebM with sound has an Opus track and clusters in time order', async t => {
  install(t);
  const blob = await encodeWebM({width: 320, height: 240, fps: 24, totalFrames: 24, renderFrame: () => ({width: 320, height: 240}), audioChunks: chunks(12000, 12000, 12000, 12000)});
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const [header, segment] = elements(bytes);
  assert.equal(header.id, 0x1a45dfa3); assert.equal(segment.id, 0x18538067);
  const parts = elements(bytes, ...segment.payload);
  const tracks = parts.find(part => part.id === 0x1654ae6b), entries = elements(bytes, ...tracks.payload);
  assert.equal(entries.length, 2);
  const opus = elements(bytes, ...entries[1].payload), field = id => opus.find(item => item.id === id);
  assert.equal(number(bytes, field(0xd7).payload), 2); assert.equal(number(bytes, field(0x83).payload), 2, 'an audio track');
  assert.equal(new TextDecoder().decode(bytes.subarray(...field(0x86).payload)), 'A_OPUS');
  assert.equal(number(bytes, field(0x56aa).payload), Math.round(312 * 1e9 / 48000), 'CodecDelay is the pre-skip');
  assert.equal(number(bytes, field(0x56bb).payload), 80000000, 'an 80 ms seek pre-roll');
  assert.deepEqual([...bytes.subarray(...field(0x63a2).payload)], [...OPUS_HEAD], 'CodecPrivate is the Opus header');
  const sound = elements(bytes, ...field(0xe1).payload);
  assert.equal(number(bytes, sound.find(item => item.id === 0x9f).payload), 2, 'stereo');

  // Every cluster is in time order, video and sound merged: the sound in one track, the frames in the other.
  const clusters = parts.filter(part => part.id === 0x1f43b675).map(cluster => {
    const items = elements(bytes, ...cluster.payload), block = items.find(item => item.id === 0xa3);
    return {time: number(bytes, items.find(item => item.id === 0xe7).payload), track: bytes[block.payload[0]] & 0x7f};
  });
  assert.equal(clusters.filter(cluster => cluster.track === 1).length, 24); assert.equal(clusters.filter(cluster => cluster.track === 2).length, 50, 'a second of Opus in 20 ms packets');
  for (let i = 1; i < clusters.length; i++) assert.ok(clusters[i].time >= clusters[i - 1].time, `cluster ${i} is not before the one it follows`);
  assert.ok(clusters.slice(0, 6).some(cluster => cluster.track === 2) && clusters.slice(0, 6).some(cluster => cluster.track === 1), 'sound and picture alternate from the start');
  const cues = parts.find(part => part.id === 0x1c53bb6b);
  assert.equal(elements(bytes, ...cues.payload).length, 1, 'only the video keyframe is a cue point');
});

// --- The whole export --------------------------------------------------------------------

test('encodeMP4 and encodeWebM take the soundtrack after the video encoder is chosen, and report the mix as progress', async t => {
  install(t);
  const phases = [];
  const options = {width: 320, height: 240, fps: 24, totalFrames: 6, renderFrame: () => ({width: 320, height: 240}), onProgress: p => phases.push(p.phase ?? 'frame')};
  const mp4 = new Uint8Array(await (await encodeMP4({...options, audioChunks: chunks(12000)})).arrayBuffer());
  assert.equal(phases[0], 'mixing audio');
  assert.ok(trackOf(mp4, 'soun') && trackOf(mp4, 'vide'));
  assert.equal(view(mp4, child(mp4, child(mp4, trackOf(mp4, 'soun'), 'mdia'), 'mdhd').payload[0] + 16).getUint32(0), 12 * 1024, '12000 samples make 12 AAC frames');
});

test('a video export that cannot encode its sound fails before a frame is rendered', async t => {
  // The video encoder works; the audio one does not support AAC.
  const state = install(t, {supports: () => false});
  state.rendered = 0;
  await assert.rejects(encodeMP4({width: 320, height: 240, fps: 24, totalFrames: 6, audioChunks: chunks(100), renderFrame: () => { state.rendered++; return {width: 320, height: 240}; }}), /cannot encode AAC sound/);
  assert.equal(state.rendered, 0);
});

// --- Planning and capabilities -----------------------------------------------------------

const environment = (audio = {opus: true, aac: true}) => ({Worker: class {}, OffscreenCanvas: class {}, createImageBitmap() {}, VideoFrame: class {}, AudioData: class {},
  VideoEncoder: {isConfigSupported: async () => ({supported: true})},
  AudioEncoder: {isConfigSupported: async config => ({supported: audio[config.codec === 'opus' ? 'opus' : 'aac']})}});

test('capabilities say which browser video formats can take sound', async () => {
  const both = await getExportCapabilities({environment: environment()});
  assert.equal(both.formats.find(format => format.id === 'webm').audio, true); assert.equal(both.formats.find(format => format.id === 'mp4').audio, true);
  const onlyOpus = await getExportCapabilities({environment: environment({opus: true, aac: false})});
  assert.equal(onlyOpus.formats.find(format => format.id === 'webm').audio, true); assert.equal(onlyOpus.formats.find(format => format.id === 'mp4').audio, false);
  const none = await getExportCapabilities({environment: {...environment(), AudioEncoder: undefined}});
  assert.ok(none.formats.filter(format => ['webm', 'mp4'].includes(format.id)).every(format => format.audio === false));
  const desktop = await getExportCapabilities({environment: environment(), desktop: {getVideoCapabilities: async () => ({formats: [{id: 'mp4', supported: true, codec: 'h264'}]})}});
  assert.equal('audio' in desktop.formats.find(format => format.id === 'mp4'), false, 'the desktop encoder keeps its own sound rule');
});

test('the dialog allows sound for a browser encoder that reported it, and the plan agrees', async () => {
  const clips = [{start: 0, duration: 1}], context = {totalFrames: 24, fps: 24, canvasWidth: 640, canvasHeight: 360, audioClips: clips, name: 'Test', loop: true, defaultDither: false};
  const request = format => buildExportRequest({format, audio: true}, context);
  const statesFor = async audio => exportFormatStates({capabilities: await getExportCapabilities({environment: environment(audio)}), totalFrames: 24});
  for (const format of ['mp4', 'webm']) {
    const yes = await statesFor({opus: true, aac: true}), no = await statesFor({opus: false, aac: false});
    assert.equal(yes.get(format).audio, true); assert.equal('audio' in no.get(format), false);
    assert.equal(validateExportRequest(request(format), {...context, states: yes, audioSupported: false}).error, '', `${format} takes sound`);
    assert.match(validateExportRequest(request(format), {...context, states: no, audioSupported: false}).error, /desktop FFmpeg/, `${format} without an encoder`);
    assert.equal(validateExportRequest(request(format), {...context, states: no, audioSupported: false}).canExport, false);
    const plan = browserAudio => videoExportArguments(request(format), {...context, provider: 'WebCodecs', browserAudio});
    assert.equal(plan(true).includeAudio, true); assert.equal(plan(true).encoder, 'webcodecs');
    assert.throws(() => plan(false), /desktop FFmpeg/); assert.throws(() => plan(undefined), /desktop FFmpeg/);
  }
  // A silent project and Include sound switched off never need an encoder.
  assert.equal(videoExportArguments(buildExportRequest({format: 'mp4', audio: false}, context), {...context, provider: 'WebCodecs'}).includeAudio, false);
  assert.equal(videoExportArguments(request('mp4'), {...context, provider: 'WebCodecs', audioClips: []}).includeAudio, false);
});

test('the codec table names the browser codecs', () => {
  assert.deepEqual(Object.keys(AUDIO_CODECS), ['aac', 'opus']);
  assert.equal(AUDIO_CODECS.aac.frameMicroseconds, 21333); assert.equal(AUDIO_CODECS.opus.frameMicroseconds, 20000);
});
