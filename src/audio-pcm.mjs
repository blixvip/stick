import {messageError} from './localized-error.mjs';
import {AUDIO_RATE, clipGainAt, MAX_AUDIO_SECONDS} from './audio-model.mjs';
const text = (view, at, length) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, length));
/** Read RIFF headers without materializing an entire recording. */
export async function inspectWave(blob) {
  if (blob.size < 44) throw messageError(new Error(''), "errors.audioPcm.thisRecordingNeedsAnAudioDecoder", {});
  const header = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (text(header, 0, 4) !== 'RIFF' || text(header, 8, 4) !== 'WAVE') throw messageError(new Error(''), "errors.audioPcm.thisRecordingNeedsAnAudioDecoder", {});
  let format, data, at = 12, chunks = 0;
  while (at + 8 <= blob.size && ++chunks <= 4096) {
    const view = new DataView(await blob.slice(at, at + 48).arrayBuffer());
    const kind = text(view, 0, 4), size = view.getUint32(4, true);
    if (at + 8 + size > blob.size) throw messageError(new Error(''), "errors.audioPcm.theWavRecordingIsTruncated", {});
    if (kind === 'fmt ' && size >= 16) {
      let code = view.getUint16(8, true);
      if (code === 0xfffe && size >= 40) code = view.getUint16(32, true);
      format = {code, channels: view.getUint16(10, true), sampleRate: view.getUint32(12, true), stride: view.getUint16(20, true), bits: view.getUint16(22, true)};
    } else if (kind === 'data') data = {offset: at + 8, bytes: size};
    at += 8 + size + size % 2;
    if (format && data) break;
  }
  if (!format || !data || ![1, 2].includes(format.channels) || ![1, 3].includes(format.code) || ![8, 16, 24, 32].includes(format.bits) || format.code === 3 && format.bits !== 32 || format.stride !== format.channels * format.bits / 8 || format.sampleRate < 8000 || format.sampleRate > 192000 || data.bytes % format.stride) throw messageError(new Error(''), "errors.audioPcm.thisWavEncodingNeedsTheDesktopAudioDecoder", {});
  const frames = data.bytes / format.stride, duration = frames / format.sampleRate;
  if (duration <= 0 || duration > MAX_AUDIO_SECONDS) throw messageError(new Error(''), "errors.audioPcm.recordingsMustBeBetweenOneSampleAndOne", {});
  return {...format, ...data, frames, duration, blob};
}
function sample(view, at, format) {
  let value;
  if (format.code === 3) value = view.getFloat32(at, true);
  else if (format.bits === 8) value = (view.getUint8(at) - 128) / 128;
  else if (format.bits === 16) value = view.getInt16(at, true) / 32768;
  else if (format.bits === 24) { const raw = view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getInt8(at + 2) << 16; value = raw / 8388608; }
  else value = view.getInt32(at, true) / 2147483648;
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
export async function wavePeaks(source, cancelled = () => false) {
  const count = Math.min(4096, Math.max(1, Math.ceil(source.duration * 80))), peaks = new Array(count).fill(0);
  const step = Math.max(1, Math.floor(256 * 1024 / source.stride));
  for (let start = 0; start < source.frames; start += step) {
    if(cancelled())throw messageError(new DOMException('', 'AbortError'), "errors.audioPcm.audioImportCancelled", {});
    const frames = Math.min(step, source.frames - start), view = new DataView(await source.blob.slice(source.offset + start * source.stride, source.offset + (start + frames) * source.stride).arrayBuffer());
    for (let i = 0; i < frames; i++) {
      const bin = Math.min(count - 1, Math.floor((start + i) * count / source.frames));
      for (let c = 0; c < source.channels; c++) peaks[bin] = Math.max(peaks[bin], Math.abs(sample(view, i * source.stride + c * source.bits / 8, source)));
    }
  }
  return peaks.map(value => Math.round(value * 10000) / 10000);
}
/** Same deterministic stereo mixer for preview and export. One bounded chunk. */
export async function mixAudio(clips, sources, startSample, frames, sampleRate = AUDIO_RATE) {
  if (!Number.isSafeInteger(startSample) || startSample < 0 || !Number.isInteger(frames) || frames < 1 || frames > AUDIO_RATE) throw messageError(new Error(''), "errors.audioPcm.invalidAudioMixRange", {});
  const output = new Float32Array(frames * 2), start = startSample / sampleRate, end = (startSample + frames) / sampleRate;
  for (const clip of clips) {
    if (clip.start >= end || clip.start + clip.duration <= start) continue;
    const source = sources.get(clip.assetId); if (!source) throw messageError(new Error(''), "errors.audioPcm.prepareTheAudioRecordingBeforePlayingOrExporting", {});
    const from = Math.max(0, Math.ceil((clip.start - start) * sampleRate - 1e-7)), to = Math.min(frames, Math.ceil((clip.start + clip.duration - start) * sampleRate - 1e-7));
    const sourceStart = Math.max(0, Math.floor((start + from / sampleRate - clip.start + clip.offset) * source.sampleRate));
    const sourceEnd = Math.min(source.frames, Math.ceil((start + to / sampleRate - clip.start + clip.offset) * source.sampleRate) + 1);
    const view = new DataView(await source.blob.slice(source.offset + sourceStart * source.stride, source.offset + sourceEnd * source.stride).arrayBuffer());
    for (let i = from; i < to; i++) {
      const time = (startSample + i) / sampleRate, position = (time - clip.start + clip.offset) * source.sampleRate;
      const index = Math.max(0, Math.floor(position) - sourceStart), next = Math.min(sourceEnd - sourceStart - 1, index + 1), fraction = position - Math.floor(position);
      if (index >= sourceEnd - sourceStart) continue;
      const gain = clipGainAt(clip, time);
      for (let c = 0; c < 2; c++) {
        const channel = Math.min(c, source.channels - 1) * source.bits / 8;
        const a = sample(view, index * source.stride + channel, source), b = sample(view, next * source.stride + channel, source);
        output[i * 2 + c] += (a + (b - a) * fraction) * gain;
      }
    }
  }
  // A fixed saturator has identical behavior at chunk/seek boundaries and never
  // changes gain based on how many muted tracks happen to exist.
  for (let i = 0; i < output.length; i++) output[i] = Math.max(-1, Math.min(1, output[i]));
  return output;
}
export function pcmWave(channels, rate = AUDIO_RATE) {
  const frames = channels[0].length, count = Math.min(2, channels.length), bytes = new ArrayBuffer(44 + frames * count * 4), view = new DataView(bytes);
  const put = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  put(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); put(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, count, true); view.setUint32(24, rate, true); view.setUint32(28, rate * count * 4, true); view.setUint16(32, count * 4, true); view.setUint16(34, 32, true); put(36, 'data'); view.setUint32(40, frames * count * 4, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) view.setFloat32(44 + (i * count + c) * 4, channels[c][i], true);
  return new Blob([bytes], {type: 'audio/wav'});
}
