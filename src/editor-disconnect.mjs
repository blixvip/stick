import {messageError} from './localized-error.mjs';
/** Animate's Disconnect segment: the selected segment and everything hanging
 * from it become a separate figure in every frame, posed where they were.
 *
 * One undo step holds three sparse commands: the new figure's poses are
 * inserted beside the source instance's (forking a shared definition first, so
 * linked instances keep their rig), then the existing topology command trims
 * each definition. Topology owns IK, style, effect and validation repair. */
import {segmentBranchIndices} from './editor-builder.mjs';
import {componentGeometry} from './editor-builder-topology.mjs';
import {hasRigConstraints} from './rig-constraints.mjs';
import {isMovieclip, snapshotFigureDefinition} from './movieclips.mjs';
import {drawingMetadata} from './drawing-model.mjs';
import {remapSurface, surfaceHandles} from './pivot/surfaces.mjs';
import {frameOrder, setOrder, normalizeFrame, resolveJoinSelection} from './pivot/structure.mjs';
import {layerLocked} from './layers.mjs';
import {remapVfxOwner} from './vfx.mjs';
import {remapIKFollowers} from './ik.mjs';
import {snapshotPoseObject} from './pose-snapshot.mjs';

const LABEL = 'Disconnect segment';

/** The selected segment and its descendants, when they are only part of one figure. */
function disconnectTarget(editor) {
  const object = editor.object, figure = editor.figure, segment = figure?.segments[editor.selectedJoint];
  if (!segment || (editor.selectedUids.size !== 1 && !editor.branchSelected) || isMovieclip(figure) || drawingMetadata(figure)) return null;
  const indices = segmentBranchIndices(figure.segments, segment.segment_id);
  return indices.length < figure.segments.length ? {object, figure, segment, indices} : null;
}

/** Which fills move with the part. A fill using joints on both sides has no exact owner. */
function movingFills(figure, part, base) {
  return (figure.polyfills ?? []).map(polygon => {
    const handles = surfaceHandles(polygon);
    if (!handles.some(id => part.has(id))) return false;
    if (handles.every(id => part.has(id) || id === base)) return true;
    throw messageError(new Error(''), "errors.editorDisconnect.aFillJoinsThisPartToTheRest", {});
  });
}

/** The part paints behind the rest when it mostly sat under it inside the figure. */
function paintsBehind(figure, part, moves) {
  const sums = [[0, 0], [0, 0]];
  const add = (z, inPart) => { sums[+inPart][0] += z; sums[+inPart][1]++; };
  figure.segments.forEach((segment, i) => add(Number.isFinite(segment.z_order) ? segment.z_order : i, part.has(segment.segment_id)));
  (figure.polyfills ?? []).forEach((polygon, i) => add(Number.isFinite(polygon.z_order) ? polygon.z_order : i, moves[i]));
  return sums[1][0] / sums[1][1] < sums[0][0] / sums[0][1];
}

function replaceObject(frame, object) {
  frame.objects[frame.objects.findIndex(value => value.unique_id === object.unique_id)] = snapshotPoseObject(object);
}

/** Replays a `disconnect` command's pose insertions; its definitions travel in
 * `figureDefinitionSplice` and its layer membership in `frameUidCounts`. */
export function applyDisconnectFrames(editor, command, direction) {
  for (const change of command.changes) {
    const frame = editor._sourceFrame(change);
    if (direction === 'after') {
      if (change.owner) replaceObject(frame, change.owner.after);
      frame.objects.push(snapshotPoseObject(change.part));
    } else {
      frame.objects.splice(frame.objects.findIndex(object => object.unique_id === change.part.unique_id), 1);
      if (change.owner) replaceObject(frame, change.owner.before);
    }
    setOrder(frame, [...change[`${direction}Order`]]); normalizeFrame(frame);
  }
}

function trimPose(object, keep) {
  object.angles = keep.map(i => object.angles[i]);
  if (object.len_flag) object.lengths = keep.map(i => object.lengths[i]);
  if (object.bend_flag) object.bends = keep.map(i => object.bends[i]);
  delete object.runtime_segments;
}

export const editorDisconnectMethods = {
  canDisconnectSegment() { return Boolean(disconnectTarget(this)); },

  /** Split the selected segment's branch into a new, unjoined figure across the whole animation. */
  disconnectSegment() {
    if (this._drag) this.commitDrag();
    const target = disconnectTarget(this);
    if (!target) throw messageError(new Error(''), "errors.editorDisconnect.selectASegmentThatIsOnlyPartOf", {});
    const {object, figure, segment, indices} = target, uid = object.unique_id, report = this.report, typeId = figure.figure_type_id;
    if (report._styk?.movieclipSource) throw messageError(new Error(''), "errors.editorDisconnect.disconnectIsNotAvailableInsideThisMovieclip", {});
    if (this._frameDraftEnabled || report._styk?.simpleFrameDraft) throw messageError(new Error(''), "errors.editorDisconnect.updateOrDiscardTheWorkingFrameFirst", {});
    if (layerLocked(report, uid)) throw messageError(new Error(''), "errors.editorDisconnect.unlockTheFigureBeforeDisconnectingASegment", {});
    if (hasRigConstraints(figure) || figure._styk?.spatialMesh) throw messageError(new Error(''), "errors.editorDisconnect.figuresWithRigRelationshipsCannotBeSplit", {});
    const part = new Set(indices.map(index => figure.segments[index].segment_id)), base = segment.parent_id, origin = figure._styk?.animationOrigin;
    if (origin && (origin.support || part.has(origin.handleId) || part.has(origin.rotationHandleId)))
      throw messageError(new Error(''), "errors.editorDisconnect.moveTheFigureOriginOffThisPartFirst", {});
    if ([...this.animationChannels, ...(report._styk?.layerSheet?.legacyAnimation?.channels ?? [])].some(channel => channel.target?.uid === uid))
      throw messageError(new Error(''), "errors.editorDisconnect.thisFigureKeepsOlderAnimationCurves", {});
    const moves = movingFills(figure, part, base), behind = paintsBehind(figure, part, moves);
    const holds = frame => frame.objects.some(value => value.unique_id === uid && value.figure_type_id === typeId);
    const locations = [];
    report.keyframes.forEach((frame, index) => { if (holds(frame)) locations.push({index}); });
    for (const [sourceId, frame] of Object.entries(report._styk?.frameSources ?? {})) if (holds(frame)) locations.push({index: -1, sourceId});
    // Linked instances keep the whole rig: only this instance's definition is split.
    const shared = this._allSourceFrames().some(frame => frame.objects.some(value => value.figure_type_id === typeId && value.unique_id !== uid));
    return this.movieclipBatch(LABEL, () => {
      const pieceUid = this._identity(), bases = [];
      let nextType = Math.max(0, ...report.figure_types.map(value => value.figure_type_id)) + 1;
      const owner = shared ? {...snapshotFigureDefinition(figure), figure_type_id: nextType++} : figure;
      const piece = {...snapshotFigureDefinition(figure), figure_type_id: nextType++, name: String(segment.name || `${figure.name || 'Figure'} part`).slice(0, 255)};
      if (piece._styk?.animationOrigin) { piece._styk = {...piece._styk}; delete piece._styk.animationOrigin; }
      const changes = locations.map(location => {
        const frame = this._sourceFrame(location), slot = frame.objects.findIndex(value => value.unique_id === uid), source = frame.objects[slot];
        // The displayed pose: joined parents and pinned IK (including IK
        // reaching through joined figures) decide where the part's joints are.
        const geometry = componentGeometry(report, frame, resolveJoinSelection(frame, [uid], true).affectedSlots)(slot);
        bases.push(base ? geometry.joints.get(base) : geometry.root);
        const displayed = snapshotPoseObject(source);
        if (geometry.solvedAngles) displayed.angles = geometry.solvedAngles.slice();
        if (geometry.solvedLengths) { displayed.len_flag = 1; displayed.lengths = geometry.solvedLengths.slice(); }
        const copy = snapshotPoseObject(displayed);
        Object.assign(copy, {unique_id: pieceUid, figure_type_id: piece.figure_type_id, join: null, root_x: geometry.root.x, root_y: geometry.root.y});
        delete copy._stykAnimationOrigin;
        remapVfxOwner(copy, piece.figure_type_id, undefined, typeId);
        const children = frame.objects.filter(value => value.join?.target_object_slot === slot && part.has(value.join.target_handle_id));
        remapIKFollowers(copy, new Map(children.map(child => [child.unique_id, child.unique_id])));
        const order = frameOrder(frame), at = order.indexOf(uid) + (behind ? 0 : 1);
        const change = {index: location.index, ...(location.sourceId ? {sourceId: location.sourceId} : {}), part: copy,
          beforeOrder: order, afterOrder: [...order.slice(0, at), pieceUid, ...order.slice(at)]};
        if (shared) { displayed.figure_type_id = owner.figure_type_id; remapVfxOwner(displayed, owner.figure_type_id, undefined, typeId); }
        if (shared || geometry.solvedAngles || geometry.solvedLengths) change.owner = {before: snapshotPoseObject(source), after: displayed};
        return change;
      });
      const figures = shared ? [owner, piece] : [piece];
      const command = {kind: 'disconnect', label: LABEL, changes, definition: true,
        figureDefinitionSplice: {index: report.figure_types.length, figures: figures.map(snapshotFigureDefinition)},
        frameUidCounts: {before: [], after: [[pieceUid, changes.length]]},
        retainedFrameSourceIds: changes.flatMap(change => change.sourceId ? [change.sourceId] : []),
        beforeSelection: this._selectionState(), structural: true, timing: false};
      report.figure_types.push(...figures);
      applyDisconnectFrames(this, command, 'after');
      this._newLayerHints ??= new Map(); this._newLayerHints.set(pieceUid, this.layerForUid(uid));
      command.afterSelection = this._selectionState();
      // The trims below validate the whole document; the batch rolls this back if they fail.
      this._record(command); this._invalidate();
      this._topologyEdit(LABEL, next => {
        const keep = indices;
        locations.forEach((location, i) => {
          const frame = this._sourceFrame(location), copy = frame.objects.find(value => value.unique_id === pieceUid);
          copy.root_x = bases[i].x; copy.root_y = bases[i].y; trimPose(copy, keep);
        });
        next.segments = keep.map(index => next.segments[index]);
        next.segments.find(value => value.segment_id === segment.segment_id).parent_id = 0;
        const remap = id => id === base ? 0 : id;
        next.polyfills = (next.polyfills ?? []).filter((_, i) => moves[i]);
        for (const polygon of next.polyfills) {
          polygon.segment_ids = polygon.segment_ids.map(remap);
          if (polygon.segment_ids_raw) polygon.segment_ids_raw = [...polygon.segment_ids];
          remapSurface(polygon, remap);
        }
      }, {definition: piece});
      this._topologyEdit(LABEL, next => {
        const keep = next.segments.flatMap((value, index) => part.has(value.segment_id) ? [] : [index]);
        for (const location of locations) {
          const frame = this._sourceFrame(location), slot = frame.objects.findIndex(value => value.unique_id === uid);
          const pieceSlot = frame.objects.findIndex(value => value.unique_id === pieceUid);
          // Figures joined to the part stay joined to the same joint, now on the new figure.
          for (const child of frame.objects) if (child.join?.target_object_slot === slot && part.has(child.join.target_handle_id))
            child.join = {...child.join, target_object_slot: pieceSlot, target_unique_id: pieceUid};
          trimPose(frame.objects[slot], keep);
        }
        next.segments = keep.map(index => next.segments[index]);
        next.polyfills = (next.polyfills ?? []).filter((_, i) => !moves[i]);
      }, {definition: owner});
      this._selectIds([pieceUid]);
      return this.object;
    });
  },
};
