import {messageError} from './localized-error.mjs';
import {validateAnimationDocument} from './animation-channels.mjs';
import {validateObjectChanges} from './pivot/model.mjs';
import {ensureLayerState} from './layers.mjs';
import {planSheetAssignmentSteps,commitSheetAssignment,planSheetDeletionSteps,commitSheetDeletion} from './editor-layer-sheet.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const aborted = () => messageError(new DOMException('', 'AbortError'), "errors.editorLayerAsync.layerMigrationWasCancelled", {});
function start(editor, options) {
  if (editor._drag) editor.commitDrag(); if (editor._animationEdit) editor.commitAnimationEdit();
  const report = editor.report, revision = editor.revision, identity = editor._nextFrameIdentity;
  return {report, revision, identity, check() {
    if (options.signal?.aborted) throw aborted();
    if (editor.report !== report || editor.revision !== revision || editor._nextFrameIdentity !== identity)
      throw messageError(new Error(''), "errors.editorLayerAsync.theAnimationChangedWhileTheLayerMoveWas", {});
  }};
}
function checkLayer(editor, id) {
  const state = ensureLayerState(editor.report);
  if (!own(state.byId, id)) throw messageError(new Error(''), "errors.editorLayerAsync.chooseAnExistingDestinationUserLayer", {}); return state;
}
function header(animation) { const {channels, ...fields} = animation ?? {}; return fields; }

/** Build independent report copies incrementally. History retains the original
 * received assets; a later shared Rig edit cannot mutate its undo snapshots. */
async function stage(editor, wire, context, options) {
  if (wire === null) return null;
  if (!wire || wire.version !== 1 || !Array.isArray(wire.channelUpdates) || !Array.isArray(wire.channelOrder) ||
      !wire.frameSources || typeof wire.frameSources !== 'object' || Array.isArray(wire.frameSources) ||
      !Number.isSafeInteger(wire.nextFrameIdentity) || wire.nextFrameIdentity < context.identity)
    throw messageError(new Error(''), "errors.editorLayerAsync.theLayerWorkerReturnedAnInvalidMigrationPlan", {});
  const beforeAnimation = context.report._styk.animation ?? null, byId = new Map((beforeAnimation?.channels ?? []).map(channel => [channel.id, channel]));
  const changed = new Set();
  for (const update of wire.channelUpdates) {
    if (!update || typeof update.id !== 'string' || changed.has(update.id) || (update.channel && update.channel.id !== update.id)) throw messageError(new Error(''), "errors.editorLayerAsync.invalidMigratedAnimationChannel", {});
    changed.add(update.id); if (update.channel === null) byId.delete(update.id); else byId.set(update.id, update.channel);
  }
  if (wire.channelOrder.length !== byId.size || new Set(wire.channelOrder).size !== byId.size || wire.channelOrder.some(id => !byId.has(id)))
    throw messageError(new Error(''), "errors.editorLayerAsync.theLayerWorkerReturnedAnInvalidChannelOrder", {});
  const afterAnimation = {...header(beforeAnimation), version: 1, nextKeyId: wire.nextKeyId, channels: wire.channelOrder.map(id => byId.get(id))};
  const occupied = new Set([...context.report.keyframes.map(frame => frame._styk?.frameId), ...Object.keys(context.report._styk.frameSources ?? {})]);
  const sources = Object.entries(wire.frameSources), preparedFrameSources = {}, frameSourceChanges = [], counts = new Map();
  let lastYield = performance.now(), sourceBytes = 0, completed = 0;
  for (const [id, frame] of sources) {
    context.check();
    if (!/^frame-[1-9]\d*$/.test(id) || occupied.has(id) || frame?._styk?.frameId !== id || !Array.isArray(frame.objects) || Number(id.slice(6)) >= wire.nextFrameIdentity)
      throw messageError(new Error(''), "errors.editorLayerAsync.theLayerWorkerReturnedAnInvalidPoseSource", {});
    occupied.add(id);
    validateObjectChanges(context.report, frame, frame.objects.map(object => object.unique_id));
    const copy = clone({...frame, objects: []});
    for (const object of frame.objects) {
      copy.objects.push(clone(object)); counts.set(object.unique_id, (counts.get(object.unique_id) ?? 0) + 1);
      sourceBytes += 512 + 8 * ((object.angles?.length ?? 0) + (object.lengths?.length ?? 0) + (object.bends?.length ?? 0));
      if (performance.now() - lastYield >= 4) { await pause(); context.check(); lastYield = performance.now(); }
    }
    sourceBytes += 256;
    preparedFrameSources[id] = copy; frameSourceChanges.push({id, before: {exists: false}, after: {exists: true, value: frame}});
    completed++;
    if (performance.now() - lastYield >= 4 || completed === sources.length) {
      options.onProgress?.({phase: 'staging', completed, total: sources.length}); await pause(); context.check(); lastYield = performance.now();
    }
  }
  validateAnimationDocument({...context.report, _styk: {...context.report._styk, animation: afterAnimation,
    frameSources: {...context.report._styk.frameSources, ...wire.frameSources}}});
  return {beforeAnimation, afterAnimation, frameSources: wire.frameSources, frameSourceChanges, preparedFrameSources,
    nextFrameIdentity: wire.nextFrameIdentity, sampledTicks: wire.sampledTicks, affectedLayerIds: wire.affectedLayerIds,
    hadFrameSourceTable: context.report._styk.frameSources !== undefined, sourceBytes: sourceBytes * 2,
    frameSourceUidCounts: {before: [], after: [...counts]}};
}
async function prepare(editor, params, options, context) {
  const planner = options.planMigration ?? editor._layerMigrationPlanner;
  if (typeof planner !== 'function') throw messageError(new Error(''), "errors.editorLayerAsync.theBackgroundLayerPlannerIsNotConnected", {});
  context.check();
  const wire = await planner({...params, nextFrameIdentity: context.identity}, {signal: options.signal, onProgress: options.onProgress});
  context.check(); const migration = await stage(editor, wire, context, options); context.check(); return migration;
}
async function prepareSheet(editor,options,build,commit){
  const context=start(editor,options),state=editor.report._styk.layers,steps=build({...options,background:true});
  for(;;){
    context.check();if(state!==editor.report._styk.layers)throw messageError(new Error(''), "errors.editorLayerAsync.layerMetadataChangedWhileTheChangeWasPrepared", {});
    const step=steps.next();if(step.done)return commit(editor,step.value);
    options.onProgress?.(step.value);await pause();
  }
}

export const editorLayerAsyncMethods = {
  setLayerMigrationPlanner(planner) {
    if (planner !== null && typeof planner !== 'function') throw messageError(new Error(''), "errors.editorLayerAsync.provideALayerPlanningFunction", {});
    this._layerMigrationPlanner = planner; return this;
  },
  async assignFiguresToLayerAsync(uids, id, options = {}) {
    if(this.report._styk?.layerSheet){
      return prepareSheet(this,options,options=>planSheetAssignmentSteps(this,uids,id,options),commitSheetAssignment);
    }
    const context = start(this, options), state = checkLayer(this, id), ids = [...new Set(uids)];
    if (ids.some(uid => !this._layerUidCounts.has(uid))) throw messageError(new Error(''), "errors.editorLayerAsync.chooseFiguresPresentInThisAnimation", {});
    const updates = ids.filter(uid => this.layerForUid(uid) !== id).map(uid => [['assignments', String(uid)], id]);
    if (!updates.length) return false;
    const migration = await prepare(this, {uids: ids, targetLayerId: id}, options, context);
    if (state !== this.report._styk.layers) throw messageError(new Error(''), "errors.editorLayerAsync.layerMetadataChangedWhileTheMoveWasPrepared", {});
    return this._layerEdit('Assign figures to layer', updates, {structural: true, reindex: true, migration});
  },
  async deleteLayerAsync(id, options = {}) {
    if(this.report._styk?.layerSheet){
      if(options.targetLayerId)return this.deleteLayer(id,options);
      return prepareSheet(this,options,options=>planSheetDeletionSteps(this,id,options),commitSheetDeletion);
    }
    const context = start(this, options), state = checkLayer(this, id), position = state.order.indexOf(id);
    if (state.order.length === 1) throw messageError(new Error(''), "errors.editorLayerAsync.keepAtLeastOneUserLayer", {});
    const target = options.targetLayerId ?? state.order[position - 1] ?? state.order[position + 1];
    if (target === id) throw messageError(new Error(''), "errors.editorLayerAsync.chooseADifferentDestinationLayer", {}); checkLayer(this, target);
    const migration = await prepare(this, {uids: this.getLayerFigureUids(id), targetLayerId: target, deletedLayerId: id}, options, context);
    const updates = [[['order'], state.order.filter(value => value !== id)], [['byId', id], undefined, true]];
    if (state.defaultLayerId === id) updates.push([['defaultLayerId'], target]);
    for (const [uid, assignment] of Object.entries(state.assignments)) if (assignment === id) updates.push([['assignments', uid], target]);
    return this._layerEdit('Delete layer', updates, {structural: true, reindex: true, activeId: state.activeId === id ? target : undefined, migration});
  },
};
