import {messageError} from './localized-error.mjs';
/** Reusable rig editing: frame-local previews, one definition commit per gesture. */
import {buildGeometry, shortest} from './pivot/geometry.mjs';
import {segmentBranchIndices} from './editor-builder.mjs';
import {authoredRigTarget} from './rig-constraints.mjs';

const EPS = 1e-9;
function coordinates(x, y) {
  if (![x, y].every(value => typeof value === 'number' && Number.isFinite(value))) throw messageError(new Error(''), "errors.editorRig.jointCoordinatesMustBeFinite", {});
}
function chordPose(start, end, bend, scale, fallbackAngle) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const chordFactor = Math.abs(bend) < EPS ? 1 : 2 * Math.sin(bend / 2) / bend;
  if (Math.abs(chordFactor) < EPS && distance > EPS) throw messageError(new Error(''), "errors.editorRig.aClosedFullCircleBendCannotBeStretched", {});
  return {
    angle: distance < EPS ? fallbackAngle : Math.atan2(end.y - start.y, end.x - start.x) - bend / 2 - (chordFactor * scale < 0 ? Math.PI : 0),
    length: distance < EPS ? 0 : distance / Math.abs(scale * chordFactor),
  };
}

function restorePreview(editor, drag) {
  const rig = drag.rig, object = editor.frame.objects.find(o => o.unique_id === rig.uid);
  if (!object) return;
  for (const index of rig.changedIndices) object.angles[index] = rig.object.angles[index];
  if (rig.object.len_flag) {
    if (!object.len_flag) object.lengths = rig.object.lengths.slice();
    for (const index of rig.changedIndices) object.lengths[index] = rig.object.lengths[index];
  } else {
    if (rig.lengths) for (const index of rig.changedIndices) rig.lengths[index] = rig.figure.segments[index].length;
    object.len_flag = 0; object.lengths = [];
  }
  object.len_flag = rig.object.len_flag;
  rig.changedIndices.clear();
}

export const editorRigMethods = {
  /** In reposition mode only the dragged joint moves; connected endpoints stay fixed. */
  beginRigDrag({reposition = true, bend = false, label = bend ? 'Bend rig joint' : 'Edit rig'} = {}) {
    const segment = this.figure?.segments[this.selectedJoint];
    if (bend && (!segment || segment._stykRig?.spatial ||
        ![0, 6].includes(segment.primitive_code ?? (segment.flags ?? 0) & 255))) return false;
    if(this.figure?.segments[this.selectedJoint]?._stykRig?.spatial)throw messageError(new Error(''), "errors.editorRig.usePoseOrRotateToArticulateThisJoint", {});
    if(this.figure?.segments[this.selectedJoint]?._stykRig?.anglePath||this.figure?.segments[this.selectedJoint]?._stykRig?.weighted)return false;
    if (!bend && this.figure?.segments[this.selectedJoint]?._stykRig?.connector) return this.beginDrag('Slide connector');
    if (!this.figure?.segments[this.selectedJoint]) return false;
    if (Math.abs(this.object.scale) < EPS) throw messageError(new Error(''), "errors.editorRig.increaseFigureScaleBeforeEditingItsRig", {});
    if (!this.beginDrag(label)) return false;
    const geometry = this.geometry.objects.get(this.selectedSlot), object = this._drag.before.find(o => o.unique_id === this.selectedUid);
    const index = this.selectedJoint, figure = this.figure, handle = figure.segments[index].segment_id;
    const children = [];
    for (let i = 0; i < figure.segments.length; i++) if (figure.segments[i].parent_id === handle) children.push(i);
    this._drag.rig = {uid: this.selectedUid, typeId: figure.figure_type_id, figure, object, index, geometry,
      reposition, bend, branch: segmentBranchIndices(figure.segments, handle), children, changedIndices: new Set(), changes: new Map(), lengths: null};
    return true;
  },
  /** Safe for pointermove: never clones a definition or walks another animation frame. */
  editRigJoint(x, y, {stretch = false, isolate = false, reposition} = {}) {
    if (this.figure?.segments[this.selectedJoint]?._stykRig?.connector) return this.slideConnector(x,y);
    coordinates(x, y);
    const active = Boolean(this._drag?.rig);
    if (!active && !this.beginRigDrag({reposition: reposition ?? true})) return false;
    const drag = this._drag, rig = drag.rig;
    if (this.frameIndex !== drag.index || this.selectedUid !== rig.uid || this.figure !== rig.figure) { this.cancelRigDrag(); throw messageError(new Error(''), "errors.editorRig.theEditedFigureChangedDuringTheRigGesture", {}); }
    try {
      const object = this.object, selected = rig.geometry.segments[rig.index], point = {x, y}, changes = new Map();
      if(selected.seg._stykRig?.anglePath||selected.seg._stykRig?.weighted)return false;
      const movePoint = reposition ?? rig.reposition;
      if(selected.seg._stykRig?.angleLock){
        const current=rig.object.len_flag?rig.object.lengths[rig.index]:rig.figure.segments[rig.index].length;
        const chord=Math.hypot(selected.end.x-selected.start.x,selected.end.y-selected.start.y),axis=selected.angle+selected.bend/2;
        if((stretch||movePoint)&&current>EPS&&chord>EPS){
          const along=Math.max(0,(point.x-selected.start.x)*Math.cos(axis)+(point.y-selected.start.y)*Math.sin(axis));
          changes.set(rig.index,{angle:rig.object.angles[rig.index],length:along*current/chord});
        }
      } else if (Math.hypot(point.x - selected.end.x, point.y - selected.end.y) < EPS) {
        // Exact pointer return restores the snapshot, without float32 chord drift.
      } else if (movePoint) {
        const target=authoredRigTarget(selected,point.x,point.y);
        changes.set(rig.index, chordPose(selected.start, target, selected.bend, object.scale, rig.object.angles[rig.index]));
        for (const i of rig.children) {
          const child = rig.geometry.segments[i];
          // Explicit relationships keep controlling their parts during a rig
          // edit. Re-fitting them would bake deformation into authored lengths.
          if(child.connector||child.seg._stykRig?.follow||child.rigSpace?.followScale!==undefined||child.rigSpace?.locked)continue;
          const target=authoredRigTarget({...child,start:point},child.end.x,child.end.y);
          changes.set(i, chordPose(point, target, child.bend, object.scale, rig.object.angles[i]));
        }
      } else {
        const target=authoredRigTarget(selected,point.x,point.y);
        const pose = chordPose(selected.start, target, selected.bend, object.scale, rig.object.angles[rig.index]);
        const delta = shortest(pose.angle - rig.object.angles[rig.index]);
        for (const i of isolate ? [rig.index] : rig.branch) changes.set(i, {angle: rig.object.angles[i] + delta});
        if (stretch) changes.get(rig.index).length = pose.length;
      }
      restorePreview(this, drag);
      for (const [i, change] of changes) {
        object.angles[i] = rig.object.angles[i] + shortest(change.angle - rig.object.angles[i]);
        if (change.length !== undefined) {
          if (!object.len_flag) {
            // Materialize the optional native length vector once per gesture.
            rig.lengths ??= rig.figure.segments.map(s => s.length);
            object.lengths = rig.lengths; object.len_flag = 1;
          }
          object.lengths[i] = change.length;
        }
        rig.changedIndices.add(i);
      }
      rig.changes = changes; delete object.runtime_segments; this.touch();
      if (!active) this.commitRigDrag();
      return true;
    } catch (error) { this.cancelRigDrag(); throw error; }
  },
  commitRigDrag() {
    const drag = this._drag, rig = drag?.rig; if (!rig) return false;
    const preview = this.frame.objects.find(o => o.unique_id === rig.uid), operations = [];
    if (rig.bend) {
      // Bending uses the same local solver as Animate. Collect its final branch
      // once on release, then publish a single reusable definition edit.
      for (const i of rig.branch) rig.changes.set(i, {
        length: preview.len_flag ? preview.lengths[i] : undefined,
        bend: i === rig.index && preview.bend_flag ? preview.bends[i] : undefined,
      });
    }
    for (const [i, change] of rig.changes) {
      const angleDelta = shortest(preview.angles[i] - rig.object.angles[i]);
      const oldLength = rig.object.len_flag ? rig.object.lengths[i] : rig.figure.segments[i].length;
      const length = change.length, lengthDelta = length === undefined ? 0 : length - oldLength;
      const oldBend = rig.object.bend_flag ? rig.object.bends[i] : rig.figure.segments[i].bend_rad ?? 0;
      const bendDelta = change.bend === undefined ? 0 : change.bend - oldBend;
      if (Math.abs(angleDelta) < EPS && Math.abs(lengthDelta) < EPS && Math.abs(bendDelta) < EPS) continue;
      const ratio = length === undefined || Math.abs(oldLength) < EPS ? null : length / oldLength;
      const oldDefault = rig.figure.segments[i].length;
      operations.push({index: i, angleDelta, length, lengthDelta, ratio, bendDelta,
        defaultLength: length === undefined ? oldDefault : Math.abs(oldDefault) > EPS && ratio !== null ? oldDefault * ratio : length});
    }
    const retainedGeometry = {previous:this._geometry ?? this._incremental?.previous, dirtySlots:this._geometry ? [] : this._incremental?.dirtySlots ?? []};
    // Remove the temporary pose before capturing the reusable document operation.
    this._drag = null;
    if (drag.authored) this._authoredPoseEdit = null;
    else this._replaceObjects(drag.index, drag.before);
    this._invalidate();
    if (!operations.length) { this._emit('edit', {label: 'Cancel rig edit', changedUids: drag.before.map(o => o.unique_id)}); return false; }
    return this._topologyEdit(drag.label, figure => {
      for (const operation of operations) {
        const segment = figure.segments[operation.index]; segment.angle_rad += operation.angleDelta;
        if (operation.bendDelta) segment.bend_rad = (segment.bend_rad ?? 0) + operation.bendDelta;
        if (operation.length !== undefined) {
          segment.length = operation.defaultLength;
        }
      }
      for (const frame of this._allSourceFrames()) {
        const affected = new Set();
        for (let slot = 0; slot < frame.objects.length; slot++) {
          const object = frame.objects[slot]; if (object.figure_type_id !== rig.typeId) continue;
          affected.add(slot);
          for (const operation of operations) {
            object.angles[operation.index] += operation.angleDelta;
            if (object.bend_flag) object.bends[operation.index] += operation.bendDelta;
            if (object.len_flag && operation.length !== undefined) object.lengths[operation.index] = operation.ratio === null
              ? object.lengths[operation.index] + operation.lengthDelta : object.lengths[operation.index] * operation.ratio;
          }
          delete object.runtime_segments;
        }
        if (!affected.size) continue;
        const children = new Map();
        frame.objects.forEach((object, slot) => {
          if (!object.join) return;
          const parent = object.join.target_object_slot, list = children.get(parent);
          if (list) list.push(slot); else children.set(parent, [slot]);
        });
        const queue = [...affected], relocated = new Set();
        for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
          relocated.add(child); if (!affected.has(child)) { affected.add(child); queue.push(child); }
        }
        if (!relocated.size) continue;
        // Joined coordinates need only this component and its ancestor chain.
        // Do not compile the hundreds of unrelated figures in a large frame.
        const required = new Set(affected);
        for (const slot of affected) {
          let current = slot;
          while (frame.objects[current].join) {
            current = frame.objects[current].join.target_object_slot;
            if (required.has(current)) break; required.add(current);
          }
        }
        const slots = [...required].sort((a, b) => a - b), local = new Map(slots.map((slot, index) => [slot, index]));
        const objects = slots.map((slot, index) => ({...frame.objects[slot], object_slot: index,
          join: frame.objects[slot].join ? {...frame.objects[slot].join, target_object_slot: local.get(frame.objects[slot].join.target_object_slot)} : null}));
        const geometry = buildGeometry(this.report, {...frame, objects, object_draw_order: objects.map((_, i) => i)});
        for (const slot of relocated) {
          const object = frame.objects[slot], root = geometry.objects.get(local.get(slot))?.root;
          if (root) { object.root_x = root.x; object.root_y = root.y; }
        }
      }
    }, {segmentIndices: operations.map(operation => operation.index), retainedGeometry});
  },
  cancelRigDrag() {
    const drag = this._drag; if (!drag?.rig) return false;
    this._drag = null;
    if (drag.authored) this._authoredPoseEdit = null;
    else this._replaceObjects(drag.index, drag.before);
    this._invalidate();
    this._emit('edit', {label: 'Cancel rig edit', changedUids: drag.before.map(o => o.unique_id)}); return true;
  },
};
