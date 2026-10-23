import {messageError} from './localized-error.mjs';
import {interpolateSpatialPose} from './spatial-projection.mjs';
import {evaluatedFrame, evaluatedNativeFrame, shortest} from './pivot/geometry.mjs';
import {sheetKeyAt} from './layer-sheet.mjs';
import {layerLocked, layerVisible} from './layers.mjs';
import {snapshotPoseFrame} from './pose-snapshot.mjs';
import {interpolateIK} from './ik.mjs';

export const TWEENER_MODES = Object.freeze(['breakdown', 'neighbor', 'push', 'relax']);
const fields = ['root_x', 'root_y', 'scale', 'angles', 'len_flag', 'lengths', 'bend_flag', 'bends',
  '_stykAnimationOrigin', '_stykSpatial'];
const copy = value => structuredClone(value);

/** Strict neighbors exclude the key being edited and clip replacement boundaries. */
export function tweenNeighbors(keys, tick) {
  let {index} = sheetKeyAt({keys}, tick);
  let right = index + 1;
  if (keys[index]?.tick === tick) index--;
  while (index >= 0 && (keys[index].patchOnly || keys[index].hidden)) index--;
  while (right < keys.length && (keys[right].patchOnly || keys[right].hidden)) right++;
  return {previous: keys[index], next: keys[right]};
}

function sample(editor, tick) {
  const rows = editor.timeline;
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = (low + high + 1) >>> 1; if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const row = rows[low];
  return evaluatedFrame(editor.report, low, row.count ? (tick - row.start) / row.count : 0, tick, {skipMovieclips: true});
}

function poseInto(target, source) {
  for (const field of fields) {
    if (source[field] === undefined) delete target[field];
    else target[field] = copy(source[field]);
  }
}

/** A tiny native projection reuses parent-relative angle, origin and IK semantics.
 * Definitions are shared; no timeline or artwork is copied or resampled on input. */
function blendReport(report, a, b, uids) {
  const frames = [a, b].map(frame => {
    const pose = snapshotPoseFrame(frame, uids);
    pose._styk = {easing: {interpolation: 'linear'}};
    pose.duration_raw = 1;
    return pose;
  });
  const types = new Set(frames.flatMap(frame => frame.objects.map(o => o.figure_type_id)));
  return {version: 5, auto_easing: false, figure_types: report.figure_types.filter(f => types.has(f.figure_type_id)),
    keyframes: frames, _styk: {}};
}

export const editorTweenerMethods = {
  beginTween() {
    if (this._drag) throw messageError(new Error(''), "errors.editorTweener.finishTheCurrentEditBeforeOpeningTweener", {});
    if (!this.selectedUids.size) throw messageError(new Error(''), "errors.editorTweener.selectFiguresToTween", {});
    if (!Number.isInteger(this.tick)) throw messageError(new Error(''), "errors.editorTweener.chooseAWholeFrameBeforeTweening", {});
    const sheet = this.report._styk?.layerSheet;
    if (!sheet && this.tick !== this.timeline[this.frameIndex].start)
      throw messageError(new Error(''), "errors.editorTweener.chooseAStoredKeyframeBeforeTweeningThisNative", {});
    const current = this.evaluatedFrame, selected = current.objects.filter(o => this.selectedUids.has(o.unique_id));
    if (!selected.length) throw messageError(new Error(''), "errors.editorTweener.selectFiguresPresentAtThisFrame", {});
    // Bound interactive pose work; the existing editor owns scene-level caches.
    if (selected.length > 256 || selected.reduce((n, o) => n + o.angles.length, 0) > 100000)
      throw messageError(new Error(''), "errors.editorTweener.tweenASmallerSelectionUpTo256Figures", {});
    const groups = new Map(), frames = new Map(), indices = new Map(), definitions = new Map(this.report.figure_types.map(f => [f.figure_type_id, f]));
    for (const object of selected) {
      if (object._styk?.locked || layerLocked(this.report, object.unique_id) || !layerVisible(this.report, object.unique_id))
        throw messageError(new Error(''), "errors.editorTweener.unlockAndShowAllSelectedFiguresBeforeTweening", {});
      const id = this.layerForUid(object.unique_id);
      // Legacy authored pose tracks retain their own timing; ordinary sheets
      // use layer keys and never accidentally use another layer's boundaries.
      const keys = sheet?.tracks[id]?.keys ?? this.animationChannel({kind:'figure',uid:object.unique_id},'pose')?.keys ??
        this.animationChannel({kind:'layer',id},'pose')?.keys ?? this.timeline.filter(r => r.count > 0).map(r => ({tick:r.start}));
      const {previous, next} = tweenNeighbors(keys, this.tick);
      if (!previous || !next) throw messageError(new Error(''), "errors.editorTweener.placeThePlayheadBetweenTwoKeysOnEvery", {});
      for (const key of [previous, next]) if (!frames.has(key.tick)) {
        const frame = sample(this, key.tick);frames.set(key.tick, frame);
        indices.set(key.tick, new Map(frame.objects.map(o => [o.unique_id,o])));
      }
      const a = frames.get(previous.tick), b = frames.get(next.tick);
      const from = indices.get(previous.tick).get(object.unique_id), to = indices.get(next.tick).get(object.unique_id);
      if (!from || !to || from.figure_type_id !== object.figure_type_id || to.figure_type_id !== object.figure_type_id ||
          from.angles.length !== object.angles.length || to.angles.length !== object.angles.length)
        throw messageError(new Error(''), "errors.editorTweener.eachSelectedFigureNeedsTheSameRigAt", {});
      const parent = (frame, o) => o.join ? frame.objects[o.join.target_object_slot]?.unique_id : null;
      if (parent(a, from) !== parent(current, object) || parent(b, to) !== parent(current, object))
        throw messageError(new Error(''), "errors.editorTweener.keepTheSameFigureAttachmentsAtBothNeighboring", {});
      const key = `${previous.tick}:${next.tick}`;
      if (!groups.has(key)) groups.set(key, {a, b, previous:previous.tick, next:next.tick, uids:[]});
      groups.get(key).uids.push(object.unique_id);
    }
    const plans = [...groups.values()].map(group => {
      const between = blendReport(this.report, group.a, group.b, group.uids);
      const breakdown = evaluatedNativeFrame(between, 0, (this.tick - group.previous) / (group.next - group.previous));
      return {uids:group.uids, between, previous:group.previous, next:group.next,
        left:blendReport(this.report, current, group.a, group.uids),
        right:blendReport(this.report, current, group.b, group.uids),
        relax:blendReport(this.report, current, breakdown, group.uids)};
    });
    if (!this.beginDrag('Tween pose')) throw messageError(new Error(''), "errors.editorTweener.selectFiguresToTween", {});
    const selectedIds = new Set(selected.map(o => o.unique_id));
    this._drag.tweener = {plans, definitions, objects:new Map(this.frame.objects.filter(o => selectedIds.has(o.unique_id)).map(o => [o.unique_id,o]))};
    if (this._authoredPoseEdit) {
      this._authoredPoseEdit.keyAtPlayhead = true;
      if (sheet) this._authoredPoseEdit.keyAtPlayheadLayers = [...new Set(selected.map(o => this.layerForUid(o.unique_id)))].filter(id => {
        const {key} = sheetKeyAt(sheet.tracks[id], this.tick);return key?.tick !== this.tick || key.patchOnly;
      });
    }
    return {groups:plans.map(({previous,next}) => ({previous,next})), figures:selected.length};
  },
  updateTween(amount, mode = 'breakdown') {
    if (!TWEENER_MODES.includes(mode) || !Number.isFinite(amount) || amount < (mode === 'neighbor' ? -1 : 0) || amount > 1)
      throw messageError(new Error(''), "errors.editorTweener.chooseAValidTweenerModeAndAmount", {});
    const session = this._drag?.tweener;
    if (!session) throw messageError(new Error(''), "errors.editorTweener.openTweenerBeforeAdjustingThePose", {});
    const {objects} = session;
    for (const plan of session.plans) {
      const report = mode === 'breakdown' ? plan.between : mode === 'neighbor' ? (amount < 0 ? plan.left : plan.right) : plan.relax;
      const result = evaluatedNativeFrame(report, 0, Math.abs(amount));
      const sampled = new Map(result.objects.map(o => [o.unique_id,o]));
      const baseline = new Map(plan.relax.keyframes[0].objects.map(o => [o.unique_id,o]));
      for (const uid of plan.uids) {
        const object = objects.get(uid), value = sampled.get(uid), start = baseline.get(uid);
        poseInto(object, value);
        if (start._stykIK) object._stykIK = copy(interpolateIK(start, value, mode === 'push' ? -1 : 1));
        if (mode === 'push') {
          if(start._stykSpatial||value._stykSpatial)object._stykSpatial=interpolateSpatialPose(start,value,-1);
          // Reflect the relaxed displacement around the immutable starting pose.
          for (const field of ['root_x','root_y','scale']) object[field] = 2 * start[field] - value[field];
          object.scale = Math.max(0, object.scale);
          object.angles = start.angles.map((angle,i) => angle - shortest(value.angles[i] - angle));
          const figure = session.definitions.get(object.figure_type_id);
          for (const [flag,field,base] of [['len_flag','lengths','length'],['bend_flag','bends','bend_rad']]) {
            if (value[flag] || start[flag]) {
              object[flag] = 1;
              object[field] = figure.segments.map((segment,i) => 2 * (start[flag] ? start[field][i] : segment[base] ?? 0) -
                (value[flag] ? value[field][i] : segment[base] ?? 0));
            }
          }
          if (object._stykAnimationOrigin && start._stykAnimationOrigin) {
            for (const field of ['x','y','offsetX','offsetY']) if (Number.isFinite(object._stykAnimationOrigin[field]))
              object._stykAnimationOrigin[field] = 2 * (start._stykAnimationOrigin[field] ?? 0) - object._stykAnimationOrigin[field];
            for (const [id,ghost] of Object.entries(object._stykAnimationOrigin.ghosts ?? {})) {
              const original = start._stykAnimationOrigin.ghosts?.[id];if (!original) continue;
              for (const field of ['angle_rad','bend_rad','length']) ghost[field] = field === 'angle_rad' ?
                original[field] - shortest(ghost[field] - original[field]) : 2 * original[field] - ghost[field];
            }
          }
        }
      }
    }
    this.touch();
    return true;
  },
};
