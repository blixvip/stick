import {messageError} from './localized-error.mjs';
/** The large native tables stay in the worker while editable render metadata changes. */
const retained = new Set(['keyframes', 'figure_types', 'backgrounds', '_stykSource']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sourceId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(id);
export function playbackProperties(report) {
  const properties = {};
  for (const key of Object.keys(report)) if (!retained.has(key)) {
    if (key === '_styk' && report._styk) {
      const {frameSources, audio, ...metadata} = report._styk; properties._styk = metadata;
    } else properties[key] = report[key];
  }
  return properties;
}

/** Compare immutable retained poses by identity, including explicitly dirtied
 * in-place edits and IDs whose preceding worker commit is not yet confirmed. */
export function retainedSourceChanges(report, mirror, dirty = []) {
  const sources = report._styk?.frameSources || {}, ids = new Set(dirty);
  for (const [id, frame] of Object.entries(sources)) if (mirror.get(id) !== frame) ids.add(id);
  for (const id of mirror.keys()) if (!own(sources, id)) ids.add(id);
  return [...ids].map(id => ({id, frame: own(sources, id) ? sources[id] : null}));
}

/** Validate the entire incoming transaction before replacing any live mirror field. */
export function applyPlaybackPatch(report, patch) {
  if (!patch?.properties || typeof patch.properties !== 'object' || Array.isArray(patch.properties) ||
    Object.keys(patch.properties).some(key => retained.has(key)) || own(patch.properties._styk || {}, 'frameSources') ||
    !Array.isArray(patch.frames) || !Array.isArray(patch.sources) || typeof patch.hasFrameSources !== 'boolean' ||
    (own(patch, 'figureUpdates') && !Array.isArray(patch.figureUpdates)))
    throw messageError(new Error(''), "errors.playbackPatch.invalidPlaybackDocumentPatch", {});
  for (const table of ['figure_types', 'backgrounds']) if (own(patch, table) && !Array.isArray(patch[table]))
    throw messageError(new Error(''), "errors.playbackPatch.invalidRenderMediaTablePatch", {});
  const frameIndices = new Set(), sourceIds = new Set(), figureIndices = new Set();
  for (const entry of patch.frames) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= report.keyframes.length || frameIndices.has(entry.index) || !Array.isArray(entry.frame?.objects))
      throw messageError(new Error(''), "errors.playbackPatch.playbackFrameUpdateTargetsAreInvalid", {});
    frameIndices.add(entry.index);
  }
  // Sparse figure replacements must keep identity: objects reference figures by
  // figure_type_id, so a mismatched update would corrupt the mirror.
  for (const entry of patch.figureUpdates ?? []) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= report.figure_types.length || figureIndices.has(entry.index) ||
      entry.figure?.figure_type_id !== report.figure_types[entry.index].figure_type_id)
      throw messageError(new Error(''), "errors.playbackPatch.playbackFigureUpdateTargetsAreInvalid", {});
    figureIndices.add(entry.index);
  }
  for (const entry of patch.sources) {
    if (!sourceId(entry.id) || sourceIds.has(entry.id) ||
      (entry.frame !== null && (!patch.hasFrameSources || !Array.isArray(entry.frame?.objects) || entry.frame._styk?.frameId !== entry.id)))
      throw messageError(new Error(''), "errors.playbackPatch.playbackRetainedSourceUpdateTargetsAreInvalid", {});
    sourceIds.add(entry.id);
  }
  if (patch.hasFrameSources && (!patch.properties._styk || typeof patch.properties._styk !== 'object'))
    throw messageError(new Error(''), "errors.playbackPatch.playbackRetainedSourcesRequireDocumentMetadata", {});
  const sources = report._styk?.frameSources || {};
  for (const entry of patch.sources) { if (entry.frame === null) delete sources[entry.id]; else sources[entry.id] = entry.frame; }
  for (const key of Object.keys(report)) if (!retained.has(key) && !own(patch.properties, key)) delete report[key];
  for (const [key, value] of Object.entries(patch.properties)) Object.defineProperty(report, key, {value, enumerable: true, configurable: true, writable: true});
  if (patch.hasFrameSources) report._styk.frameSources = sources;
  for (const entry of patch.frames) report.keyframes[entry.index] = entry.frame;
  for (const entry of patch.figureUpdates ?? []) report.figure_types[entry.index] = entry.figure;
  for (const table of ['figure_types', 'backgrounds']) if (own(patch, table)) report[table] = patch[table];
  return report;
}
