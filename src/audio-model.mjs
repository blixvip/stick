import {validationLabel} from './validation-labels.mjs';
import {messageError} from './localized-error.mjs';
/** Serializable, immutable audio edit state. Times are seconds, never frame indices. */
export const AUDIO_RATE = 48000;
export const AUDIO_CHUNK_BYTES = 192 * 1024;
export const MAX_AUDIO_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_AUDIO_PROJECT_BYTES = 96 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 3600;
export const MAX_AUDIO_TRACKS = 64;
export const MAX_AUDIO_CLIPS = 4096;
export const MAX_AUDIO_VOICES = 32;
export const EMPTY_AUDIO = Object.freeze({version: 1, assets: Object.freeze({}), tracks: Object.freeze([])});
const checkedAssets = new WeakSet();
const number = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) throw messageError(new Error(''), "errors.audioModel.mustBeBetweenAnd", {name: validationLabel(name), min: min, max: max});
};
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const audioState = report => report?._styk?.audio ?? EMPTY_AUDIO;
export const audioFps = report => report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps;
export const audioEnd = state => Math.max(0, ...state.tracks.flatMap(track => track.clips.map(clip => clip.start + clip.duration)));
export const freshAudioId = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;
export function* validateAudioAssetSteps(asset) {
  if (!asset || typeof asset !== 'object') throw messageError(new Error(''), "errors.audioModel.invalidAudioAsset", {});
  if (checkedAssets.has(asset)) return asset;
  if (!id(asset.id) || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length > 240) throw messageError(new Error(''), "errors.audioModel.invalidAudioAssetNameOrIdentity", {});
  number(asset.size, 1, MAX_AUDIO_FILE_BYTES, 'Audio file size');
  number(asset.duration, 1 / AUDIO_RATE, MAX_AUDIO_SECONDS, 'Audio duration');
  if (!Number.isInteger(asset.size) || !Array.isArray(asset.chunks) || asset.chunks.length > Math.ceil(MAX_AUDIO_FILE_BYTES / AUDIO_CHUNK_BYTES)) throw messageError(new Error(''), "errors.audioModel.invalidEmbeddedAudio", {});
  let size = 0, count = 0;
  for (const chunk of asset.chunks) {
    const text = chunk?.data_base64;
    if (typeof text !== 'string' || !text.length || text.length > AUDIO_CHUNK_BYTES * 4 / 3 || text.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw messageError(new Error(''), "errors.audioModel.invalidEmbeddedAudioBytes", {});
    size += text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
    if (++count % 4 === 0) yield {phase:'validating audio',checked:size};
  }
  if (size !== asset.size) throw messageError(new Error(''), "errors.audioModel.embeddedAudioIsIncomplete", {});
  if (!Array.isArray(asset.peaks) || asset.peaks.length > 4096 || !asset.peaks.length || asset.peaks.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw messageError(new Error(''), "errors.audioModel.invalidAudioWaveform", {});
  checkedAssets.add(asset);
  return asset;
}
export function validateAudioAsset(asset) { const steps=validateAudioAssetSteps(asset); for(;;){const step=steps.next();if(step.done)return step.value;} }
export function validateAudioState(state) {
  if (!state || state.version !== 1 || !state.assets || typeof state.assets !== 'object' || Array.isArray(state.assets) || !Array.isArray(state.tracks) || state.tracks.length > MAX_AUDIO_TRACKS) throw messageError(new Error(''), "errors.audioModel.unsupportedAudioDocument", {});
  let bytes = 0, count = 0; const ids = new Set();
  const identity = value => { if (!id(value) || ids.has(value)) throw messageError(new Error(''), "errors.audioModel.duplicateOrInvalidAudioIdentity", {}); ids.add(value); };
  for (const [key, asset] of Object.entries(state.assets)) {
    if (key !== asset.id) throw messageError(new Error(''), "errors.audioModel.invalidAudioAssetReference", {});
    identity(key); validateAudioAsset(asset); bytes += asset.size;
  }
  if (bytes > MAX_AUDIO_PROJECT_BYTES) throw messageError(new Error(''), "errors.audioModel.embeddedAudioExceedsThe96MibProjectLimit", {});
  for (const track of state.tracks) {
    identity(track.id);
    if (typeof track.name !== 'string' || !track.name.trim() || track.name.length > 120 || !Array.isArray(track.clips) || typeof track.mute !== 'boolean' || typeof track.solo !== 'boolean') throw messageError(new Error(''), "errors.audioModel.invalidAudioTrack", {});
    number(track.gain, 0, 4, 'Track volume');
    for (const clip of track.clips) {
      if (++count > MAX_AUDIO_CLIPS) throw messageError(new Error(''), "errors.audioModel.aProjectSupportsUpTo4096Audio", {});
      identity(clip.id); const asset = Object.hasOwn(state.assets,clip.assetId) && state.assets[clip.assetId];
      if (!asset) throw messageError(new Error(''), "errors.audioModel.audioClipReferencesAMissingRecording", {});
      number(clip.start, 0, MAX_AUDIO_SECONDS, 'Clip start');
      number(clip.offset, 0, asset.duration, 'Source trim');
      number(clip.duration, 1 / AUDIO_RATE, asset.duration, 'Clip duration');
      if (clip.offset + clip.duration > asset.duration + 1e-7 || clip.start + clip.duration > MAX_AUDIO_SECONDS) throw messageError(new Error(''), "errors.audioModel.audioClipExtendsBeyondItsSourceOrThe", {});
      number(clip.gain, 0, 4, 'Clip volume');
      number(clip.fadeIn, 0, clip.duration, 'Fade in'); number(clip.fadeOut, 0, clip.duration, 'Fade out');
    }
  }
  const boundaries = audibleClips(state).flatMap(clip => [[clip.start,1],[clip.start+clip.duration,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let voices=0; for(const [,delta] of boundaries) if((voices+=delta)>MAX_AUDIO_VOICES) throw messageError(new Error(''), "errors.audioModel.upTo32AudioClipsCanSoundAt", {});
  return state;
}
export const audibleClips = state => {
  const solo = state.tracks.some(track => track.solo);
  return state.tracks.filter(track => !track.mute && (!solo || track.solo) && track.gain > 0)
    .flatMap(track => track.clips.filter(clip => clip.gain > 0).map(clip => ({...clip, gain: clip.gain * track.gain})));
};
export const clipGainAt = (clip, time) => {
  const local = time - clip.start;
  if (local < 0 || local >= clip.duration) return 0;
  return clip.gain * Math.min(1, clip.fadeIn ? local / clip.fadeIn : 1, clip.fadeOut ? (clip.duration - local) / clip.fadeOut : 1);
};
/** Explicit ripple operation: split at insertions and retain source offsets on removal. */
export function rippleAudio(state, start, removed, inserted) {
  const end = start + removed, delta = inserted - removed;
  const tracks = state.tracks.map(track => ({...track, clips: track.clips.flatMap(clip => {
    const finish = clip.start + clip.duration;
    if (finish <= start) return [clip];
    if (clip.start >= end) return [{...clip, start: clip.start + delta}];
    const parts = [];
    if (clip.start < start) parts.push({...clip, duration: start - clip.start, fadeIn: Math.min(clip.fadeIn, start - clip.start), fadeOut: 0});
    if (finish > end) {
      const cut = Math.max(0, end - clip.start), duration = clip.duration - cut;
      parts.push({...clip, id: parts.length ? freshAudioId('clip') : clip.id, start: Math.max(end, clip.start) + delta,
        offset: clip.offset + cut, duration, fadeIn: 0, fadeOut: Math.min(clip.fadeOut, duration)});
    }
    return parts;
  })}));
  return validateAudioState({...state, tracks});
}
