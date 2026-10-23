import {messageError} from './localized-error.mjs';
/** Native Alt+handle transforms about the selected figure's own origin.
 * https://www.pivotanimator.net/help5-2/size_and_rotation.htm
 */
import {shortest} from './pivot/geometry.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
const EPS = 1e-9;
const coordinates = (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw messageError(new Error(''), "errors.editorFigureTransform.transformCoordinatesMustBeFinite", {});
};

export function createFigureHandleTransform(origin, start) {
  coordinates(origin.x, origin.y); coordinates(start.x, start.y);
  const dx = start.x - origin.x, dy = start.y - origin.y, distance = Math.hypot(dx, dy);
  if (!(distance > EPS)) throw messageError(new Error(''), "errors.editorFigureTransform.dragAHandleAwayFromTheFigureOrigin", {});
  return {origin: {...origin}, distance, lastAngle: Math.atan2(dy, dx), rotation: 0};
}

/** Accumulates crossings of ±π without altering the original scale reference.
 * Ctrl locks scale; Shift locks rotation. Toolbar toggles work independently.
 */
export function figureHandleTransform(state, point, {rotate = true, scale = true, ctrlKey = false, shiftKey = false} = {}) {
  coordinates(point.x, point.y);
  const dx = point.x - state.origin.x, dy = point.y - state.origin.y, distance = Math.hypot(dx, dy);
  if (distance > EPS) {
    const angle = Math.atan2(dy, dx);
    state.rotation += shortest(angle - state.lastAngle); state.lastAngle = angle;
  }
  return {radians: rotate && !shiftKey ? state.rotation : 0, factor: scale && !ctrlKey ? distance / state.distance : 1};
}

export const editorFigureTransformMethods = {
  beginFigureHandleDrag(x, y, {rotate = true, scale = true, joint = this.selectedJoint, label = 'Transform figure'} = {}) {
    if (!this.object || joint < 0 || !this.figure?.segments[joint]) return false;
    const original = this.geometry.objects.get(this.selectedSlot), handle = original?.segments[joint]?.end;
    x ??= handle?.x; y ??= handle?.y; coordinates(x, y);
    if (!original || !(Math.abs(this.object.scale) > EPS)) throw messageError(new Error(''), "errors.editorFigureTransform.increaseFigureScaleBeforeTransformingAHandle", {});
    // Validate before beginning a command so invalid starts leave history alone.
    createFigureHandleTransform(original.root, {x, y});
    if (!this.beginDrag(label)) return false;
    try {
      const slot = this.selectedSlot, geometry = this.geometry, children = new Map();
      this.frame.objects.forEach((object, index) => {
        if (!object.join) return;
        const values = children.get(object.join.target_object_slot) || [];
        values.push(index); children.set(object.join.target_object_slot, values);
      });
      const queue = this.frame.objects.flatMap((object, index) => this.selectedUids.has(object.unique_id) ? [index] : []);
      const affected = new Set(queue);
      for (let cursor = 0; cursor < queue.length; cursor++) for (const index of children.get(queue[cursor]) || [])
        if (!affected.has(index)) { affected.add(index); queue.push(index); }
      const snapshots = new Map(this._drag.before.map(object => [object.unique_id, object]));
      this._drag.figureHandle = {uid: this.selectedUid, rotate, scale,
        transform: createFigureHandleTransform(geometry.objects.get(slot).root, {x, y}),
        targets: queue.map(index => ({slot: index, before: snapshots.get(this.frame.objects[index].unique_id)}))};
      return true;
    } catch (error) { this.cancelDrag(); throw error; }
  },

  transformFigureHandle(x, y, options = {}) {
    coordinates(x, y);
    const active = Boolean(this._drag?.figureHandle);
    if (!active && !this.beginFigureHandleDrag(undefined, undefined, options)) return false;
    const drag = this._drag, edit = drag.figureHandle;
    if (drag.index !== this.frameIndex || edit.uid !== this.selectedUid) {
      this.cancelDrag(); throw messageError(new Error(''), "errors.editorFigureTransform.theSelectedFigureChangedDuringItsGesture", {});
    }
    try {
      const {radians, factor} = figureHandleTransform(edit.transform, {x, y}, {...edit, ...options});
      const cos = Math.cos(radians), sin = Math.sin(radians), origin = edit.transform.origin;
      for (const {slot, before} of edit.targets) {
        const object = this.frame.objects[slot];
        if (before._stykAnimationOrigin) object._stykAnimationOrigin = {...before._stykAnimationOrigin};
        // Multi-figure drags transform the group about the dragged figure's
        // origin like Pivot: every selected root orbits and scales toward it.
        // The dragged root sits at the origin and therefore stays fixed.
        const dx = (before.root_x ?? 0) - origin.x, dy = (before.root_y ?? 0) - origin.y;
        object.root_x = origin.x + (dx * cos - dy * sin) * factor;
        object.root_y = origin.y + (dx * sin + dy * cos) * factor;
        object.scale = before.scale * factor;
        for (let index = 0; index < before.angles.length; index++) object.angles[index] = before.angles[index] + radians;
        rotateOriginSupport(this.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id), object, radians);
        // Joined descendants derive their positions from the transformed parent
        // vertices and commit canonically; their stored roots follow the group.
        if (Math.abs(radians) < EPS && Math.abs(factor - 1) < EPS) {
          if ('root_x' in before) { object.root_x = before.root_x; object.root_y = before.root_y; }
          else { delete object.root_x; delete object.root_y; }
          object.scale = before.scale;
          for (let index = 0; index < before.angles.length; index++) object.angles[index] = before.angles[index];
          if (before._stykAnimationOrigin) object._stykAnimationOrigin = {...before._stykAnimationOrigin};
          if ('runtime_segments' in before) object.runtime_segments = before.runtime_segments;
          else delete object.runtime_segments;
        } else delete object.runtime_segments;
      }
      this.touch(); if (!active) this.commitDrag(); return true;
    } catch (error) { this.cancelDrag(); throw error; }
  },
  commitFigureHandleDrag() { return this._drag?.figureHandle ? this.commitDrag() : false; },
  cancelFigureHandleDrag() { return this._drag?.figureHandle ? this.cancelDrag() : false; },
};
