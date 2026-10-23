import {playbackProperties} from './playback-patch.mjs';
import {easingMode, usesLegacyNativeEasing} from './keyframe-easing.mjs';

const fixedTrack = id => id === 'scene' || id === 'camera';
const keyAt = (keys, tick) => {
  let low = 0, high = keys.length;
  while (low < high) { const mid = (low + high) >>> 1; if (keys[mid].tick <= tick) low = mid + 1; else high = mid; }
  return {key: keys[low - 1], next: keys[low], index: low - 1};
};

/** Small render-metadata snapshot. Native object/asset tables stay out of it.
 * Authored sources and Simple drafts currently require full invalidation: their
 * dependency graph is wider than native adjacent-frame interpolation. */
export function playbackRetentionSnapshot(report, entries, {scale, cameraEnabled, storedFrames} = {}) {
  if (storedFrames || report._styk?.simpleFrameDraft || report._styk?.animation?.channels?.length) return null;
  const sheet = report._styk?.layerSheet ?? null, properties = playbackProperties(report);
  // Layer cells are compared per tick at retention time, so a localized sheet
  // edit retains packets on untouched spans. legacyAnimation feeds every
  // sourceTick sample, so it stays global. Commands replace sheet state and
  // track objects wholesale, making identity and content diffs safe.
  if (sheet) properties._styk = (({layerSheet, ...rest}) => rest)(properties._styk ?? {});
  const frameIndexById = new Map();
  report.keyframes.forEach((frame, index) => { if (frame._styk?.frameId) frameIndexById.set(frame._styk.frameId, index); });
  return {signature: JSON.stringify([properties, scale, cameraEnabled, storedFrames, sheet?.legacyAnimation ?? null]),
    entries: entries.map(entry => ({...entry})), sheet, frameIndexById,
    legacy: report.keyframes.map((_, index) => usesLegacyNativeEasing(report, index)),
    auto: report.keyframes.map(frame => easingMode(frame._styk?.easing) === 'auto'),
    interpolates: report.keyframes.map(frame => report.version >= 5 || Boolean(frame._styk?.easing))};
}

/** The layer cells a track samples at one tick, mirroring the sheet evaluator's
 * source selection: the covering key's movieclip patches always apply, while
 * pose content comes from a sourceTick pair, a captured pose, an imported
 * endpoint window, or a pose channel over the surrounding keys. */
function sheetTrackInputs(track, id, tick) {
  const keys = track.keys, deps = [], refs = new Set(), sourceRanges = [];
  const cover = keyAt(keys, tick);
  if (cover.key && tick < track.end && cover.key.movieclipPatches?.length) {
    // Movieclip patches interpolate through a virtual channel built from every
    // key, so their reach mirrors the pose window around the covering key.
    for (let slot = Math.max(0, cover.index - 1); slot <= Math.min(keys.length - 1, cover.index + 3); slot++) {
      const dep = keys[slot]; deps.push(dep);
      for (const patch of dep.movieclipPatches ?? []) if (patch.frameId) refs.add(patch.frameId);
    }
  }
  const base = keys.some(key => key.patchOnly) ? keys.filter(key => !key.patchOnly) : keys;
  const {key, next, index} = keyAt(base, tick);
  if (key && (fixedTrack(id) || tick < track.end) && key.value?.frameId !== null) {
    if (next?.value?.frameId === null) {
      deps.push(key);
      if (key.sourceTick !== undefined) sourceRanges.push([key.sourceTick, key.sourceTick]); else refs.add(key.value.frameId);
    } else if (key.sourceTick !== undefined && (!next || next.sourceTick !== undefined)) {
      deps.push(key); if (next) deps.push(next);
      sourceRanges.push([key.sourceTick, next?.sourceTick ?? key.sourceTick]);
    } else {
      // Imported tracks interpolate through endpoint frames up to three keys
      // ahead; authored pose channels reach adjacent tangents either side.
      const imported = base.some(entry => entry.sourceTick !== undefined);
      const last = Math.min(base.length - 1, index + (imported ? 3 : 2));
      for (let slot = Math.max(0, index - 1); slot <= last; slot++) {
        const dep = base[slot]; deps.push(dep);
        if (dep.sourceTick !== undefined) sourceRanges.push([dep.sourceTick, dep.sourceTick]);
        else if (dep.value?.frameId) refs.add(dep.value.frameId);
      }
    }
  }
  return {sig: JSON.stringify(deps), refs, sourceRanges};
}

/** Whether the retained-source or native-keyframe targets a tick depends on
 * changed. Frame ids resolve against both the retained table and keyframes. */
function targetDirty(previous, next, refs, dirty, dirtySourceIds) {
  for (const ref of refs) if (dirtySourceIds.has(ref) || dirty.has(previous.frameIndexById.get(ref) ?? -1) || dirty.has(next.frameIndexById.get(ref) ?? -1)) return true;
  return false;
}

const nativeIndexChanged = (previous, next, index, dirty) =>
  dirty.has(index) || next.entries[index]?.start !== previous.entries[index]?.start ||
  next.entries[index]?.count !== previous.entries[index]?.count;

/** Whether a sourceTick's sampled time range touches a changed or shifted
 * native frame, applying the same interpolation neighbour rules as packets. */
function nativeRangeDirty(previous, next, [lo, hi], dirty, nativeShift) {
  const entries = previous.entries;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], start = entry.start, end = start + entry.count;
    if (end <= lo) continue; if (start > hi) break;
    if (nativeIndexChanged(previous, next, index, dirty)) return true;
    if (hi > start && previous.interpolates[index] && index + 1 < entries.length) {
      if (nativeIndexChanged(previous, next, index + 1, dirty)) return true;
      if (previous.auto[index] && (nativeIndexChanged(previous, next, index - 1, dirty) || nativeIndexChanged(previous, next, index + 2, dirty))) return true;
      if (previous.legacy[index] && (dirty.size || nativeShift)) return true;
    }
  }
  return false;
}

/** A packet stays valid only if every layer track samples unchanged cells at
 * its tick and none of those cells' referenced sources or native frames moved. */
function sheetTickDirty(previous, next, tick, dirty, dirtySourceIds, nativeShift) {
  for (const id of new Set([...Object.keys(previous.sheet.tracks), ...Object.keys(next.sheet.tracks)])) {
    const before = previous.sheet.tracks[id], after = next.sheet.tracks[id];
    if (before === after) {
      // Identical cells still depend on the sources and native frames they
      // reference, so a dirty target invalidates the tick without a cell edit.
      if (dirty.size || dirtySourceIds.size || nativeShift) {
        const inputs = sheetTrackInputs(before, id, tick);
        if (targetDirty(previous, next, inputs.refs, dirty, dirtySourceIds) ||
          inputs.sourceRanges.some(range => nativeRangeDirty(previous, next, range, dirty, nativeShift))) return true;
      }
      continue;
    }
    if (!fixedTrack(id) && tick >= (before?.end ?? 0) && tick >= (after?.end ?? 0)) continue;
    if (!before || !after) return true;
    if (!fixedTrack(id) && (tick >= before.end) !== (tick >= after.end)) return true;
    const oldInputs = sheetTrackInputs(before, id, tick), newInputs = sheetTrackInputs(after, id, tick);
    if (oldInputs.sig !== newInputs.sig) return true;
    if (targetDirty(previous, next, oldInputs.refs, dirty, dirtySourceIds) || targetDirty(previous, next, newInputs.refs, dirty, dirtySourceIds)) return true;
    if (oldInputs.sourceRanges.some(range => nativeRangeDirty(previous, next, range, dirty, nativeShift)) ||
      newInputs.sourceRanges.some(range => nativeRangeDirty(previous, next, range, dirty, nativeShift))) return true;
  }
  return false;
}

/** Retain only packets whose sampled inputs and absolute tick location are
 * unchanged. Conservative legacy-easing dependencies include the whole native
 * sequence because angular unwrapping can propagate beyond adjacent keys.
 * Retained-source edits drop everything unless a layer sheet can attribute
 * each tick's inputs to specific cells. */
export function unchangedPlaybackTicks(previous, next, packets, changedIndices, dirtySourceIds = new Set()) {
  const keep = new Set(), dirty = new Set(changedIndices);
  if (!previous || !next || previous.signature !== next.signature) return keep;
  if (Boolean(previous.sheet) !== Boolean(next.sheet)) return keep;
  if (dirtySourceIds.size && !previous.sheet) return keep;
  // A duration edit can shift an entry's absolute span without patching the
  // frame itself; sourceTick cells sampling shifted spans must not survive.
  const nativeShift = previous.entries.length !== next.entries.length ||
    previous.entries.some((entry, index) => entry.start !== next.entries[index].start || entry.count !== next.entries[index].count);
  for (const packet of packets) {
    const index = packet.frameIndex, before = previous.entries[index], after = next.entries[index];
    if (!before || !after || before.start !== after.start || before.count !== after.count || dirty.has(index)) continue;
    if (packet.tick < after.start || packet.tick >= after.start + after.count) continue;
    if (previous.sheet) {
      if (sheetTickDirty(previous, next, packet.tick, dirty, dirtySourceIds, nativeShift)) continue;
    } else if (packet.tick > after.start && previous.interpolates[index] && index + 1 < previous.entries.length) {
      if (dirty.has(index + 1)) continue;
      // Auto tangents use adjacent values and each adjoining key's easing mode.
      // Include both neighbors even when a mode edit starts/ends an Auto run.
      if (previous.auto[index] && (dirty.has(index - 1) || dirty.has(index + 2))) continue;
      if (previous.legacy[index] && dirty.size) continue;
    }
    keep.add(packet.tick);
  }
  return keep;
}
