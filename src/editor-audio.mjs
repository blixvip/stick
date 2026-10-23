import {messageError} from './localized-error.mjs';
import {audioState, validateAudioState, validateAudioAsset, freshAudioId, rippleAudio, audioFps} from './audio-model.mjs';

function publish(editor, next, label) {
  const before = audioState(editor.report), beforePresent = Object.hasOwn(editor.report._styk,'audio'); if (next === before) return false;
  validateAudioState(next);
  if (editor._drag) editor.commitDrag();
  if (editor._animationEdit) editor.commitAnimationEdit();
  editor.report._styk.audio = next;
  // Assets and unchanged tracks are immutable shared references. History sizing
  // counts newly retained media once, without serializing recording bytes.
  const assetBytes = Object.entries(next.assets).reduce((n, [id, asset]) => n + (before.assets[id] === asset ? 0 : asset.size * 8 / 3), 0)
    + Object.entries(before.assets).reduce((n,[id,asset])=>n+(next.assets[id]===asset?0:asset.size*8/3),0);
  const precomputedBytes = assetBytes + JSON.stringify([before.tracks, next.tracks]).length * 2 + 512;
  editor._record({kind: 'audio', label, before, after: next, beforePresent, precomputedBytes});
  editor._emit('edit', {label, audio: true});
  return true;
}
function modifyTrack(editor, id, operation, label) {
  const state = audioState(editor.report), index = state.tracks.findIndex(track => track.id === id);
  if (index < 0) throw messageError(new Error(''), "errors.editorAudio.selectAnAudioTrack", {});
  const tracks = [...state.tracks]; tracks[index] = operation(tracks[index]);
  if (tracks[index] === state.tracks[index]) return false;
  return publish(editor, {...state, tracks}, label);
}
function clipOwner(editor, id) {
  const track = audioState(editor.report).tracks.find(track => track.clips.some(clip => clip.id === id));
  if (!track) throw messageError(new Error(''), "errors.editorAudio.selectAnAudioClip", {});
  return {track, clip: track.clips.find(clip => clip.id === id)};
}
export function applyAudioCommand(editor, command, direction) {
  if (command.kind !== 'audio') return false;
  if(direction==='before'&&!command.beforePresent)delete editor.report._styk.audio;
  else editor.report._styk.audio = command[direction];
  editor._revision = command[`${direction}Revision`];
  editor._emit('history', {label: command.label, audio: true});
  return true;
}
export const editorAudioMethods = {
  addAudioTrack(name = 'Audio') {
    const state = audioState(this.report), track = {id: freshAudioId('audio'), name, gain: 1, mute: false, solo: false, clips: []};
    publish(this, {...state, tracks: [...state.tracks, track]}, 'Add audio track'); return track.id;
  },
  importAudio(asset, {trackId, start = this.tick / audioFps(this.report)} = {}) {
    validateAudioAsset(asset);
    const state = audioState(this.report), tracks = [...state.tracks];
    let index = tracks.findIndex(track => track.id === trackId);
    if (index < 0) { index = tracks.length; tracks.push({id: freshAudioId('audio'), name: asset.name.replace(/\.[^.]+$/, '').slice(0, 120), gain: 1, mute: false, solo: false, clips: []}); }
    const clip = {id: freshAudioId('clip'), assetId: asset.id, start, offset: 0, duration: asset.duration, gain: 1, fadeIn: 0, fadeOut: 0};
    tracks[index] = {...tracks[index], clips: [...tracks[index].clips, clip]};
    publish(this, {...state, assets: {...state.assets, [asset.id]: asset}, tracks}, 'Import audio'); return clip.id;
  },
  setAudioTrack(id, patch) {
    if (Object.keys(patch).some(key => !['name', 'gain', 'mute', 'solo'].includes(key))) throw messageError(new Error(''), "errors.editorAudio.unsupportedAudioTrackProperty", {});
    return modifyTrack(this, id, track => Object.entries(patch).every(([key, value]) => track[key] === value) ? track : ({...track, ...patch}), 'Edit audio track');
  },
  deleteAudioTrack(id) {
    const state = audioState(this.report); if (!state.tracks.some(track => track.id === id)) return false;
    const tracks = state.tracks.filter(track => track.id !== id), used = new Set(tracks.flatMap(track => track.clips.map(clip => clip.assetId)));
    return publish(this, {...state, tracks, assets: Object.fromEntries(Object.entries(state.assets).filter(([key]) => used.has(key)))}, 'Delete audio track');
  },
  setAudioClip(id, patch, targetTrackId) {
    if (Object.keys(patch).some(key => !['start', 'offset', 'duration', 'gain', 'fadeIn', 'fadeOut'].includes(key))) throw messageError(new Error(''), "errors.editorAudio.unsupportedAudioClipProperty", {});
    if (Object.values(patch).some(value => !Number.isFinite(value))) throw messageError(new Error(''), "errors.editorAudio.audioClipPropertiesMustBeFiniteNumbers", {});
    const {track, clip} = clipOwner(this, id), state = audioState(this.report);
    targetTrackId ??= track.id;
    if (!state.tracks.some(track => track.id === targetTrackId)) throw messageError(new Error(''), "errors.editorAudio.selectADestinationAudioTrack", {});
    const next = {...clip, ...patch}; next.fadeIn = Math.min(next.fadeIn, next.duration); next.fadeOut = Math.min(next.fadeOut, next.duration);
    if (targetTrackId === track.id && Object.keys(next).every(key => next[key] === clip[key])) return false;
    const tracks = state.tracks.map(row => row.id === targetTrackId
      ? {...row, clips: [...row.clips.filter(clip => clip.id !== id), next]}
      : row.id === track.id ? {...row, clips: row.clips.filter(clip => clip.id !== id)} : row);
    return publish(this, {...state, tracks}, 'Edit audio clip');
  },
  splitAudioClip(id, time = this.tick / audioFps(this.report)) {
    const {track, clip} = clipOwner(this, id), cut = time - clip.start;
    if (cut < 1 / 48000 || clip.duration - cut < 1 / 48000) throw messageError(new Error(''), "errors.editorAudio.placeThePlayheadInsideTheAudioClipTo", {});
    const right = {...clip, id: freshAudioId('clip'), start: time, offset: clip.offset + cut, duration: clip.duration - cut, fadeIn: 0, fadeOut: Math.min(clip.fadeOut, clip.duration - cut)};
    modifyTrack(this, track.id, row => ({...row, clips: row.clips.flatMap(item => item.id === id ? [{...clip, duration: cut, fadeIn: Math.min(clip.fadeIn, cut), fadeOut: 0}, right] : [item])}), 'Split audio clip');
    return right.id;
  },
  duplicateAudioClip(id) {
    const {track, clip} = clipOwner(this, id), next = {...clip, id: freshAudioId('clip'), start: clip.start + clip.duration};
    modifyTrack(this, track.id, row => ({...row, clips: [...row.clips, next]}), 'Duplicate audio clip'); return next.id;
  },
  copyAudioClip(id) {
    const {clip} = clipOwner(this,id);
    this._audioClipboard = {clip:{...clip},asset:audioState(this.report).assets[clip.assetId]}; return true;
  },
  cutAudioClip(id) { this.copyAudioClip(id); return this.deleteAudioClip(id); },
  pasteAudioClip(trackId, start = this.tick / audioFps(this.report)) {
    if (!this._audioClipboard) return false;
    const state=audioState(this.report), tracks=[...state.tracks], saved=this._audioClipboard;
    let asset=saved.asset,index=tracks.findIndex(track=>track.id===trackId);
    if (state.assets[asset.id] && state.assets[asset.id] !== asset) asset={...asset,id:freshAudioId('sound')};
    if(index<0){index=tracks.length;tracks.push({id:freshAudioId('audio'),name:'Audio',gain:1,mute:false,solo:false,clips:[]});}
    const clip={...saved.clip,id:freshAudioId('clip'),assetId:asset.id,start};
    tracks[index]={...tracks[index],clips:[...tracks[index].clips,clip]};
    publish(this,{...state,assets:state.assets[asset.id]===asset?state.assets:{...state.assets,[asset.id]:asset},tracks},'Paste audio clip');return clip.id;
  },
  deleteAudioClip(id) {
    const {track} = clipOwner(this, id), state = audioState(this.report);
    const tracks = state.tracks.map(row => row.id === track.id ? {...row, clips: row.clips.filter(clip => clip.id !== id)} : row);
    const used = new Set(tracks.flatMap(row => row.clips.map(clip => clip.assetId)));
    return publish(this, {...state, tracks, assets: Object.fromEntries(Object.entries(state.assets).filter(([key]) => used.has(key)))}, 'Delete audio clip');
  },
  rippleAudio(startTick, removedTicks, insertedTicks) {
    const fps = audioFps(this.report), state = audioState(this.report);
    if (!state.tracks.length) return false;
    return publish(this, rippleAudio(state, startTick / fps, removedTicks / fps, insertedTicks / fps), 'Ripple audio');
  },
};
