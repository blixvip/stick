import {messageError} from './localized-error.mjs';
/** A minimal MP4 (ISO base media) writer for one H.264 video track.
 * Sources: ISO/IEC 14496-12 (boxes), 14496-15 (avcC), https://www.w3.org/TR/webcodecs-avc-codec-registration/
 *
 * Layout: ftyp, then mdat (a 64-bit size that is patched once the total is
 * known, so a streamed export never holds the video in memory), then moov. All
 * samples form one chunk, so the sample tables stay a few entries long and no
 * offset can outgrow 32 bits. Frames are constant-rate: the media timescale is
 * fps x 1000 and every sample lasts 1000 ticks. An encoder that reorders frames
 * (B-frames) would need composition offsets, so it is rejected rather than
 * written with wrong timing.
 *
 * A soundtrack (`audio`: AAC packets from audio-encode.mjs) is a second track whose
 * samples follow the video samples in mdat as a second chunk. Players read that
 * fine from a file; it is not laid out for playing while downloading. The AAC
 * encoder's priming samples are not trimmed with an edit list, so sound starts
 * about 40 ms late in players that do not skip them.
 */
const text = new TextEncoder();
const u32 = value => new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const u16 = value => new Uint8Array([(value >>> 8) & 255, value & 255]);
const u64 = value => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value)); return bytes; };
const fourcc = name => text.encode(name);
const join = parts => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0), bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  return bytes;
};
const box = (type, ...payload) => { const body = join(payload); return join([u32(8 + body.byteLength), fourcc(type), body]); };
const fullBox = (type, version, flags, ...payload) => box(type, new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]), ...payload);
const zeros = count => new Uint8Array(count);

/** Fixed-point 16.16 for the track's display size. */
const fixed = value => u32(value * 65536);
const MATRIX = join([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

// nclx colour information; WebCodecs names map onto the ISO/IEC 23091-2 numbers.
const PRIMARIES = {bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9};
const TRANSFER = {bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, srgb: 13, pq: 16, hlg: 18};
const MATRICES = {rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9};
// An encoder that names no colour space gets BT.709, limited range: what H.264 players assume for HD anyway.
function colourBox(space) {
  return box('colr', fourcc('nclx'), u16(PRIMARIES[space?.primaries] ?? 1), u16(TRANSFER[space?.transfer] ?? 1),
    u16(MATRICES[space?.matrix] ?? 1), new Uint8Array([space?.fullRange ? 0x80 : 0]));
}

function sampleEntry({width, height, description, colorSpace}) {
  const name = zeros(32);
  return box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), zeros(4), u16(1), name,
    u16(0x0018), new Uint8Array([0xff, 0xff]), box('avcC', description), colourBox(colorSpace));
}

/** An MPEG-4 descriptor: its tag, an expandable length, then the payload. */
function descriptor(tag, ...payload) {
  const body = join(payload), length = [body.byteLength & 0x7f];
  for (let rest = body.byteLength >>> 7; rest; rest >>>= 7) length.unshift((rest & 0x7f) | 0x80);
  return join([new Uint8Array([tag]), new Uint8Array(length), body]);
}

/** The 'esds' box that describes an AAC stream: object type 0x40 (MPEG-4 audio), the AudioSpecificConfig, and default SL settings. */
const esds = (config, bitrate) => fullBox('esds', 0, 0, descriptor(0x03, u16(0), new Uint8Array([0]),
  descriptor(0x04, new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(bitrate), u32(bitrate), descriptor(0x05, config)),
  descriptor(0x06, new Uint8Array([2]))));

/** The soundtrack's 'trak': one chunk at `offset`, timed in samples at the sample rate. */
function audioTrack({sampleRate, channels, description, packets}, {trackId, offset, movieDuration}) {
  const ticks = packets.map(packet => Math.max(1, Math.round(packet.duration * sampleRate / 1e6))), total = ticks.reduce((sum, value) => sum + value, 0);
  // Consecutive packets of the same length share one time-to-sample entry.
  const runs = [];
  for (const value of ticks) { const last = runs.at(-1); if (last?.value === value) last.count++; else runs.push({value, count: 1}); }
  const sizes = new Uint8Array(packets.length * 4), sizeView = new DataView(sizes.buffer);
  packets.forEach((packet, i) => sizeView.setUint32(i * 4, packet.data.byteLength));
  const bytes = packets.reduce((sum, packet) => sum + packet.data.byteLength, 0), bitrate = Math.round(bytes * 8 * sampleRate / total);
  const entry = box('mp4a', zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536), esds(description, bitrate));
  const table = box('stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(runs.length), ...runs.flatMap(run => [u32(run.count), u32(run.value)])),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(packets.length), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(packets.length), sizes),
    fullBox('stco', 0, 0, u32(1), u32(offset)));
  return box('trak',
    fullBox('tkhd', 0, 3, u32(0), u32(0), u32(trackId), u32(0), u32(movieDuration), zeros(8), u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)),
    box('mdia', fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(total), u16(0x55c4), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), fourcc('soun'), zeros(12), text.encode('StykAnimate\0')),
      box('minf', fullBox('smhd', 0, 0, zeros(4)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), table)));
}

/** Small packets joined into blocks of about 256 KiB, so a sink is not written to once per packet. */
function blocks(parts, limit = 256 * 1024) {
  const joined = [];
  let group = [], size = 0;
  for (const part of parts) {
    group.push(part); size += part.byteLength;
    if (size >= limit) { joined.push(join(group)); group = []; size = 0; }
  }
  if (group.length) joined.push(join(group));
  return joined;
}

/** The soundtrack's length in milliseconds. */
const audioMilliseconds = ({sampleRate, packets}) => Math.round(packets.reduce((sum, packet) => sum + Math.max(1, Math.round(packet.duration * sampleRate / 1e6)), 0) * 1000 / sampleRate);

export class Mp4Muxer {
  constructor({width, height, fps, totalFrames, maxBytes, streamed = false, audio = null}) {
    this.audio = audio?.packets?.length ? audio : null;
    this.audioBytes = this.audio ? this.audio.packets.reduce((sum, packet) => sum + packet.data.byteLength, 0) : 0;
    this.width = width; this.height = height; this.fps = fps; this.totalFrames = totalFrames;
    this.timescale = Math.round(fps * 1000);
    if (!(this.timescale >= 1 && this.timescale <= 0xffffffff)) throw messageError(new Error(''), "errors.mp4Muxer.theFrameRateCannotBeStoredInAn", {});
    this.maxBytes = maxBytes;
    this.streamed = streamed;
    this.frames = 0;
    this.lastTimestamp = -1;
    this.sizes = [];
    this.keyframes = [];
    this.samples = [];
    this.dataBytes = 0;
    this.description = null;
    this.colorSpace = null;
    this.ftyp = box('ftyp', fourcc('isom'), u32(512), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
    // mdat starts with the 64-bit form of its header: size 1, the type, then the real size.
    this.mdatHeader = join([u32(1), fourcc('mdat'), zeros(8)]);
    this.mdatSizeOffset = this.ftyp.byteLength + 8;
    this.dataStart = this.ftyp.byteLength + this.mdatHeader.byteLength;
    this.pending = streamed ? [this.ftyp, this.mdatHeader] : null;
  }

  /** Parts produced since the last drain, in output order. */
  drain() {
    if (!this.pending?.length) return null;
    const parts = this.pending;
    this.pending = [];
    return parts;
  }

  add(chunk, metadata) {
    if (!Number.isSafeInteger(chunk.timestamp) || chunk.timestamp < 0 || chunk.timestamp < this.lastTimestamp) {
      throw messageError(new Error(''), "errors.mp4Muxer.theEncoderReturnedOutOfOrderVideoTimestamps", {});
    }
    if (this.frames === 0) {
      if (chunk.type !== 'key') throw messageError(new Error(''), "errors.mp4Muxer.theVideoEncoderDidNotProduceAnInitial", {});
      const description = metadata?.decoderConfig?.description;
      if (!description) throw messageError(new Error(''), "errors.mp4Muxer.theVideoEncoderDidNotDescribeItsH", {});
      // A copy: the encoder may reuse the buffer it described the stream with.
      this.description = (description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array(description.buffer, description.byteOffset, description.byteLength)).slice();
      this.colorSpace = metadata.decoderConfig.colorSpace ?? null;
    }
    if (this.dataStart + this.dataBytes + this.audioBytes + chunk.byteLength + 4096 > this.maxBytes) throw messageError(new Error(''), "errors.mp4Muxer.theEncodedVideoExceedsTheConfiguredExportSize", {});
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (chunk.type === 'key') this.keyframes.push(this.frames + 1);
    this.sizes.push(data.byteLength);
    this.dataBytes += data.byteLength;
    if (this.streamed) this.pending.push(data); else this.samples.push(data);
    this.lastTimestamp = chunk.timestamp;
    this.frames++;
  }

  movie() {
    const duration = this.frames * 1000, sizes = new Uint8Array(this.sizes.length * 4), keys = new Uint8Array(this.keyframes.length * 4);
    const sizeView = new DataView(sizes.buffer), keyView = new DataView(keys.buffer);
    this.sizes.forEach((size, i) => sizeView.setUint32(i * 4, size));
    this.keyframes.forEach((number, i) => keyView.setUint32(i * 4, number));
    const videoDuration = Math.round(duration * 1000 / this.timescale), movieDuration = Math.max(videoDuration, this.audio ? audioMilliseconds(this.audio) : 0);
    const table = box('stbl',
      fullBox('stsd', 0, 0, u32(1), sampleEntry({width: this.width, height: this.height, description: this.description, colorSpace: this.colorSpace})),
      fullBox('stts', 0, 0, u32(1), u32(this.frames), u32(1000)),
      fullBox('stss', 0, 0, u32(this.keyframes.length), keys),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(this.frames), u32(1)),
      fullBox('stsz', 0, 0, u32(0), u32(this.frames), sizes),
      fullBox('stco', 0, 0, u32(1), u32(this.dataStart)));
    const media = box('mdia',
      fullBox('mdhd', 0, 0, u32(0), u32(0), u32(this.timescale), u32(duration), u16(0x55c4), u16(0)),
      fullBox('hdlr', 0, 0, u32(0), fourcc('vide'), zeros(12), text.encode('StykAnimate\0')),
      box('minf', fullBox('vmhd', 0, 1, zeros(8)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), table));
    const track = box('trak',
      fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(videoDuration), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, fixed(this.width), fixed(this.height)),
      media);
    const sound = this.audio ? audioTrack(this.audio, {trackId: 2, offset: this.dataStart + this.dataBytes, movieDuration}) : null;
    return box('moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(sound ? 3 : 2)),
      track, ...(sound ? [sound] : []));
  }

  finish(expectedFrames) {
    if (this.frames !== expectedFrames) throw messageError(new Error(''), "errors.mp4Muxer.videoExportProducedOfFrames", {frames: this.frames, expectedFrames: expectedFrames});
    const moov = this.movie(), mdatSize = this.mdatHeader.byteLength + this.dataBytes + this.audioBytes;
    if (this.dataStart + this.dataBytes + this.audioBytes + moov.byteLength > this.maxBytes) throw messageError(new Error(''), "errors.mp4Muxer.theEncodedVideoExceedsTheExportSizeLimit", {});
    const sound = this.audio ? blocks(this.audio.packets.map(packet => packet.data)) : [];
    if (this.streamed) {
      for (const block of sound) this.pending.push(block);
      this.pending.push(moov);
      return {patch: {offset: this.mdatSizeOffset, bytes: u64(mdatSize)}};
    }
    const header = this.mdatHeader.slice();
    header.set(u64(mdatSize), 8);
    return new Blob([this.ftyp, header, ...this.samples, ...sound, moov], {type: 'video/mp4'});
  }
}

/** The AVC levels (ITU-T H.264 table A-1) as [level_idc, max macroblocks per second, max macroblocks per frame]. */
const LEVELS = [[10, 1485, 99], [11, 3000, 396], [12, 6000, 396], [13, 11880, 396], [20, 11880, 396], [21, 19800, 792], [22, 20250, 1620],
  [30, 40500, 1620], [31, 108000, 3600], [32, 216000, 5120], [40, 245760, 8192], [42, 522240, 8704], [50, 589824, 22080],
  [51, 983040, 36864], [52, 2073600, 36864], [60, 4177920, 139264]];

/** The WebCodecs codec strings to try for a picture size and rate: High, Main, then Baseline, each at the lowest level that fits. */
export function avcCodecStrings(width, height, fps) {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16), rate = frame * fps;
  const level = (LEVELS.find(([, perSecond, perFrame]) => rate <= perSecond && frame <= perFrame) ?? LEVELS.at(-1))[0];
  const hex = level.toString(16).padStart(2, '0');
  return [`avc1.6400${hex}`, `avc1.4d00${hex}`, `avc1.4200${hex}`];
}
