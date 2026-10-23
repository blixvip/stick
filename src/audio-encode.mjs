import {messageError} from './localized-error.mjs';
/** Encodes an offline soundtrack with WebCodecs for the browser's video exports:
 * AAC for MP4 and Opus for WebM. The mix comes from the same worker mixer that
 * plays it (audio-engine.mjs exportChunks: stereo Float32 at 48 kHz, in 250 ms
 * chunks), so what is heard is what is exported. The whole soundtrack is encoded
 * before the first video frame and kept as packets (about 1 MiB a minute), which
 * lets the muxers place it without waiting on the video.
 */
import {AUDIO_RATE} from './audio-model.mjs';

const CHANNELS = 2;
export const AUDIO_CODECS = Object.freeze({
  aac: {label: 'AAC', bitrate: 128000, frameMicroseconds: Math.round(1024 * 1e6 / AUDIO_RATE),
    config: bitrate => ({codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: CHANNELS, bitrate, aac: {format: 'aac'}})},
  opus: {label: 'Opus', bitrate: 96000, frameMicroseconds: 20000,
    config: bitrate => ({codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: CHANNELS, bitrate, opus: {application: 'audio', frameDuration: 20000}})},
});
/** Video exports with sound are limited to an hour, as on the desktop. */
export const MAX_AUDIO_SECONDS = 3600;
// libopus's usual pre-skip at 48 kHz, for encoders that do not describe their stream.
const OPUS_PRE_SKIP = 312;

/** Whether this browser can encode the codec at the export's rate and channel count. */
export async function audioEncoderSupported(codec, environment = globalThis) {
  const definition = AUDIO_CODECS[codec];
  if (!definition || !environment.AudioEncoder || !environment.AudioData) return false;
  try { return Boolean((await environment.AudioEncoder.isConfigSupported(definition.config(definition.bitrate))).supported); }
  catch { return false; }
}

/** The 19-byte Ogg Opus identification header (RFC 7845 §5.1), for encoders that give none. */
export function opusHead({preSkip = OPUS_PRE_SKIP, channels = CHANNELS, sampleRate = AUDIO_RATE} = {}) {
  const head = new Uint8Array(19), view = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  view.setUint16(10, preSkip, true); view.setUint32(12, sampleRate, true);
  return head;
}

const cancelled = () => messageError(new DOMException('', 'AbortError'), "errors.audioEncode.videoExportCancelled", {});

/**
 * @param {{codec: 'aac'|'opus', chunks: AsyncIterable<Float32Array>|Iterable<Float32Array>, signal?: AbortSignal,
 *   maxBytes?: number, bitrate?: number, seconds?: number}} options `chunks` are interleaved stereo samples.
 * @returns {Promise<null|{codec: string, sampleRate: number, channels: number, description: Uint8Array,
 *   preSkip: number, packets: {timestamp: number, duration: number, data: Uint8Array}[]}>} null for silence.
 */
export async function encodeAudio({codec, chunks, signal, maxBytes = 256 * 1024 * 1024, bitrate, seconds}) {
  const definition = AUDIO_CODECS[codec];
  if (!definition) throw messageError(new TypeError(''), "errors.audioEncode.unknownAudioCodec", {codec: codec});
  if (seconds > MAX_AUDIO_SECONDS) throw messageError(new Error(''), "errors.audioEncode.videoExportsWithSoundSupportUpToOne", {});
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') throw messageError(new Error(''), "errors.audioEncode.thisBrowserCannotEncodeSoundTurnOffInclude", {});
  const config = definition.config(bitrate ?? definition.bitrate);
  let supported = false;
  try { supported = (await AudioEncoder.isConfigSupported(config)).supported; } catch { /* Reported below. */ }
  if (!supported) throw messageError(new Error(''), "errors.audioEncode.thisBrowserCannotEncodeSoundTurnOffInclude2", {label: definition.label});
  if (signal?.aborted) throw cancelled();

  const packets = [];
  let description, failure, bytes = 0, wake;
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      try {
        const given = metadata?.decoderConfig?.description;
        if (given && !description) description = (given instanceof ArrayBuffer ? new Uint8Array(given) : new Uint8Array(given.buffer, given.byteOffset, given.byteLength)).slice();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        bytes += data.byteLength;
        if (bytes > maxBytes) throw messageError(new Error(''), "errors.audioEncode.theEncodedSoundExceedsTheExportSizeLimit", {});
        packets.push({timestamp: chunk.timestamp, duration: chunk.duration || definition.frameMicroseconds, data});
      } catch (error) { failure ||= error; wake?.(); }
    },
    error(error) { failure ||= error; wake?.(); },
  });
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const abort = () => { failure ||= cancelled(); wake?.(); if (encoder.state !== 'closed') encoder.close(); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    encoder.configure(config);
    let frames = 0;
    for await (const pcm of chunks) {
      check();
      if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length % CHANNELS) throw messageError(new Error(''), "errors.audioEncode.theSoundtrackMixReturnedInvalidSamples", {});
      const data = new AudioData({format: 'f32', sampleRate: AUDIO_RATE, numberOfFrames: pcm.length / CHANNELS, numberOfChannels: CHANNELS,
        timestamp: Math.round(frames * 1e6 / AUDIO_RATE), data: pcm});
      try { encoder.encode(data); } finally { data.close(); }
      frames += pcm.length / CHANNELS;
      // Keep the encoder's queue short: the mixer produces faster than real time.
      while (encoder.encodeQueueSize > 8) {
        await new Promise(resolve => {
          wake = resolve;
          encoder.addEventListener('dequeue', resolve, {once: true});
        });
        wake = null;
        check();
      }
    }
    if (!frames) return null;
    await encoder.flush();
    check();
  } finally {
    signal?.removeEventListener('abort', abort);
    if (encoder.state !== 'closed') encoder.close();
  }
  if (!packets.length) throw messageError(new Error(''), "errors.audioEncode.theAudioEncoderProducedNoSound", {});
  if (!description) {
    if (codec === 'aac') throw messageError(new Error(''), "errors.audioEncode.theAudioEncoderDidNotDescribeItsAac", {});
    description = opusHead();
  }
  const preSkip = codec === 'opus' ? new DataView(description.buffer, description.byteOffset, description.byteLength).getUint16(10, true) : 0;
  return {codec: config.codec, sampleRate: AUDIO_RATE, channels: CHANNELS, description, preSkip, packets};
}
