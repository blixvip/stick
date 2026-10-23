import {messageError} from './localized-error.mjs';
import {documentHasRigConstraints} from './rig-constraints.mjs';
import {documentHasSurfaces} from './pivot/surfaces.mjs';
import {cameraAtTime} from './camera-motion.mjs';
import {parallaxResolver} from './layer-parallax.mjs';
const cameraFeatures=report=>Boolean(report._styk?.cameraMotion?.clips.some(c=>c.enabled)||report._styk?.layers?.order.some(id=>report._styk.layers.byId[id]?.parallax?.enabled));
/** Native Pivot has one shared exposure sequence. Bake authored tracks only in
 * the export worker, keeping editable STYK sources and the UI document intact. */
import {evaluatedFrame, nativeTimeline, timeline, buildGeometry} from './pivot/geometry.mjs';
import {validateScene} from './pivot/model.mjs';
import {animationChannels, animationChannelId, validateAnimationDocument} from './animation-channels.mjs';
import {applyLayerOrder, layerVisible, validateLayerState,ensureLayerState} from './layers.mjs';
import {materializeSimpleFrameDraftForPivot} from './pivot-frame-draft.mjs';
import {createNativeStyleTable, hasNativeStyleOverrides} from './pivot-style-materialize.mjs';
import {modernizeLegacyObjectColor,portableFigure,portableBackground} from './clipboard-assets.mjs';
import {hasAnimationOrigins} from './animation-origin.mjs';

import {hasFrameEasing} from './keyframe-easing.mjs';
import {hasPinnedIK} from './ik.mjs';
import {movieclipTypes} from './movieclips.mjs';
import {createMovieclipMaterializer} from './movieclip-materialize.mjs';
const hasIK = report => report.keyframes.some(frame => frame.objects.some(hasPinnedIK));
const MAX_FRAMES = 100000, MAX_OBJECTS = 2000000, MAX_BACKGROUNDS = 65534;
const activeChannels = report => animationChannels(report).filter(channel => channel.property === 'pose' || channel.keys.length);

/** An imported sheet is a view of native time until a track is authored or
 * retimed. Prove that identity from its current contents on every export; a
 * cached "unedited" flag would become unsafe after Undo or native-save reopen.
 * Unknown sheet controls conservatively retain the existing baking path. */
function withoutNativeSheet(report) {
  const sheet = report._styk?.layerSheet;
  if (!sheet || report._styk.animation || report._styk.movieclipSource || movieclipTypes(report).size || sheet.version !== 1 || Object.keys(sheet).some(key => !['version', 'duration', 'nextId', 'tracks'].includes(key))) return report;
  const rows = nativeTimeline(report), last = rows.at(-1), duration = last ? last.start + last.count : 0;
  if (sheet.duration !== duration || !duration) return report;
  const times = [...new Set([0, ...rows.filter(row => row.count > 0).map(row => row.start)])].sort((a, b) => a - b);
  const ids = ['scene', 'camera', ...(report._styk?.layers?.order ?? [])];
  if (!sheet.tracks || Object.keys(sheet.tracks).length !== ids.length) return report;
  const interpolation = report.version < 5 ? 'constant' : report.auto_easing ? 'auto' : 'linear';
  for (const id of ids) {
    const track = sheet.tracks[id];
    if (!track || track.end !== duration || track.keys?.length !== times.length || Object.keys(track).some(key => !['end', 'keys'].includes(key))) return report;
    for (let index = 0; index < times.length; index++) {
      const key = track.keys[index];
      if (!key || key.tick !== times[index] || key.sourceTick !== key.tick || key.interpolation !== interpolation ||
          Object.keys(key).some(field => !['id', 'tick', 'sourceTick', 'interpolation', 'empty'].includes(field))) return report;
    }
  }
  const metadata = {...report._styk}; delete metadata.layerSheet;
  return {...report, _styk: metadata};
}

export function needsPivotMaterialization(report) {
  report = withoutNativeSheet(report);
  if (cameraFeatures(report)||report._styk?.layerSheet) return true;
  if (movieclipTypes(report).size || report._styk?.movieclipSource) return true;
  if (hasIK(report)) return true;
  if (hasFrameEasing(report)) return true;
  if (activeChannels(report).length) return true;
  if (hasAnimationOrigins(report)) return true;
  if (hasNativeStyleOverrides(report)) return true;
  if (report.keyframes.some(frame => frame.objects.some(object => object._stykZIndex !== undefined))) return true;
  const layers = report._styk?.layers;
  if (!layers) return false;
  if (layers.fixed?.camera?.visible === false || layers.fixed?.scene?.visible === false ||
      layers.order.some(id => layers.byId[id]?.visible === false)) return true;
  return layers.order.length > 1 && report.keyframes.some(frame => applyLayerOrder(report, frame) !== frame);
}

function withoutFrameIdentity(frame) {
  if (!frame._styk) return frame;
  const metadata = {...frame._styk}; delete metadata.frameId; delete metadata.easing;
  if (Object.keys(metadata).length) frame._styk = metadata; else delete frame._styk;
  return frame;
}

/** Preserve zero-duration source poses as zero-duration native keys. Authored
 * hidden poses replace only their own track; untouched tracks retain their own
 * native hidden poses. Coincident references to one source share an exposure. */
function hiddenExposures(report, rows, channels) {
  const groups = new Map(), extraSources = {}, sourceIds = new Set(Object.keys(report._styk?.frameSources ?? {}));
  for (const frame of report.keyframes) if (frame._styk?.frameId) sourceIds.add(frame._styk.frameId);
  const authored = new Set(channels.filter(channel => channel.property === 'pose').map(channel => channel.id));
  const targets = [{kind: 'scene'}, {kind: 'camera'}, ...(report._styk?.layers?.order ?? ['layer-1']).map(id => ({kind: 'layer', id}))];
  const add = (tick, sourceId, target, nativeIndex = null) => {
    const id = `${tick}:${sourceId ?? 'blank'}`;
    let group = groups.get(id);
    if (!group) groups.set(id, group = {tick, sourceId, nativeIndex, targets: new Map()});
    if (nativeIndex !== null) group.nativeIndex = nativeIndex;
    group.targets.set(animationChannelId(target, 'pose'), target);
  };
  rows.forEach((row, index) => {
    if (row.count !== 0) return;
    const frame = report.keyframes[index]; let sourceId = frame._styk?.frameId;
    if (!sourceId) {
      let suffix = index + 1; do { sourceId = `export-hidden-${suffix++}`; } while (sourceIds.has(sourceId));
      sourceIds.add(sourceId); extraSources[sourceId] = frame;
    }
    for (const target of targets) if (!authored.has(animationChannelId(target, 'pose'))) add(row.start, sourceId, target, index);
  });
  for (const channel of channels) if (channel.property === 'pose') for (const key of channel.keys)
    if (key.hidden) add(key.tick, key.value?.frameId ?? null, channel.target);
  return {events: [...groups.values()].sort((a, b) => a.tick - b.tick), extraSources};
}

function sampleAt(report, rows, tick, hidden) {
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const row = rows[low], index = hidden?.nativeIndex ?? low;
  return evaluatedFrame(report, index, hidden?.nativeIndex !== null && hidden?.nativeIndex !== undefined ? 0 :
    row.count > 0 ? Math.max(0, Math.min(1, (tick - row.start) / row.count)) : 0, tick);
}

export function materializePivotDocument(report) {
  if(documentHasSurfaces(report))throw messageError(new Error(''), "errors.pivotExportMaterialize.pivotCannotPreserveOneSidedFillsSaveAs", {});
  if(documentHasRigConstraints(report))throw messageError(new Error(''), "errors.pivotExportMaterialize.pivotCannotPreserveConnectorsOrSmartStretchSave", {});
  report = withoutNativeSheet(materializeSimpleFrameDraftForPivot(report));
  if (report.keyframes.length && movieclipTypes(report).size) {
    const materializer=createMovieclipMaterializer(report),rows=timeline(report),total=rows.at(-1).start+rows.at(-1).count;
    if(total>MAX_FRAMES)throw messageError(new Error(''), "errors.pivotExportMaterialize.movieclipExportExceedsThe100000FrameLimit", {});
    const frames=[];let index=0,objects=0;
    for(let tick=0;tick<total;tick++){
      while(index+1<rows.length&&rows[index+1].start<=tick)index++;
      const row=rows[index],sample=evaluatedFrame(report,index,row.count?(tick-row.start)/row.count:0,tick),offset=parallaxResolver(report,sample),frame=materializer.frame({...sample,camera:cameraAtTime(report,sample),objects:sample.objects.map(o=>{const d=offset(o.unique_id);return d.x||d.y?{...o,root_x:o.root_x+d.x,root_y:o.root_y+d.y}:o;})});
      delete frame._cameraMotionTick;
      frame.duration_raw=1;objects+=frame.objects.length;if(objects>MAX_OBJECTS)throw messageError(new Error(''), "errors.pivotExportMaterialize.movieclipExportExceedsTheObjectLimit", {});frames.push(frame);
    }
    const metadata={...report._styk};delete metadata.animation;delete metadata.frameSources;delete metadata.movieclipSource;delete metadata.layerSheet;
    const fixed=metadata.layers?.fixed;delete metadata.layers;delete metadata.cameraMotion;
    const output={...report,figure_types:materializer.figures,keyframes:frames,_styk:metadata,auto_easing:false,auto_easing_disabled_raw:1};
    if(fixed)ensureLayerState(output).fixed=fixed;
    return materializePivotDocument(output);
  }
  if (report.keyframes.length === 0) {
    // The working placeholder is absent from native stored-frame export. Its
    // authored overlays cannot create stored exposures after Delete All.
    validateScene({...report,keyframes:[{objects:[],duration_raw:0}]});
    const output={...report,total_output_frames:0,duration_seconds:0};
    if (report._styk) {
      output._styk={...report._styk};delete output._styk.animation; delete output._styk.cameraMotion;delete output._styk.layers;delete output._styk.frameSources;
    }
    return output;
  }
  if (!needsPivotMaterialization(report)) return report;
  validateAnimationDocument(report);
  if (report._styk?.layers) validateLayerState(report._styk.layers);
  const channels = activeChannels(report), layers = report._styk?.layers;
  const authored = report.version < 5 || cameraFeatures(report) || !!report._styk?.layerSheet || hasIK(report) || hasFrameEasing(report) || channels.length > 0 || hasAnimationOrigins(report) || hasNativeStyleOverrides(report) || layers?.order.some(id => layers.byId[id]?.visible === false), rows = nativeTimeline(report), outputRows = timeline(report);
  const totalTicks = outputRows.at(-1).start + outputRows.at(-1).count;
  const {events: hidden, extraSources} = authored && !report._styk?.layerSheet ? hiddenExposures(report, rows, channels) : {events: [], extraSources: {}};
  const outputCount = authored ? totalTicks + hidden.length : report.keyframes.length;
  if (outputCount < 1 || outputCount > MAX_FRAMES) throw messageError(new Error(''), "errors.pivotExportMaterialize.nativePivotExportNeedsKeysTheSupportedLimit", {value: outputCount.toLocaleString(), value1: MAX_FRAMES.toLocaleString()});
  const output = {...report, backgrounds: [...(report.backgrounds ?? [])], keyframes: []};
  // Materialized per-segment styles use Pivot 5. Convert the untouched legacy
  // colors too, before changing their interpretation in the output document.
  const legacy=report.version<5;
  const segmentColorTypes=new Set(report.figure_types.filter(figure=>figure._styk?.colorMode==='segments').map(figure=>figure.figure_type_id));
  if(report._styk?.layerSheet||legacy)output.version=5;
  if(legacy){
    output.figure_types=report.figure_types.map(figure=>portableFigure(figure,true));
    output.backgrounds=(report.backgrounds??[]).map(portableBackground);
  }
  const styleTypeId = createNativeStyleTable(output);
  if (output._styk) {
    output._styk = {...output._styk}; delete output._styk.animation; delete output._styk.cameraMotion; delete output._styk.layers; delete output._styk.frameSources; delete output._styk.layerSheet;
  }
  if (authored) { output.auto_easing = false; output.auto_easing_disabled_raw = 1; output.auto_easing_source = 'file'; }
  const colorIds = new Map(output.backgrounds.filter(bg => bg.kind === 2).map(bg => [bg.color, bg.background_id]));
  const usedBackgroundIds = new Set(output.backgrounds.map(bg => bg.background_id)); let nextBackgroundId = 1, objectCount = 0;
  const colorId = color => {
    if (colorIds.has(color)) return colorIds.get(color);
    if (output.backgrounds.length >= MAX_BACKGROUNDS) throw messageError(new Error(''), "errors.pivotExportMaterialize.animatedSceneColorsExceedTheNativePivotBackground", {});
    while (usedBackgroundIds.has(nextBackgroundId)) nextBackgroundId++;
    const id = nextBackgroundId++; usedBackgroundIds.add(id); colorIds.set(color, id);
    output.backgrounds.push({background_id: id, kind: 2, color, name: `Color #${(color & 0xffffff).toString(16).padStart(6, '0')}`}); return id;
  };
  const append = (frame, duration) => {
    const geometry = frame.objects.some(object => object.join || hasPinnedIK(object)) ? buildGeometry(report, frame) : null;
    const oldToNew = new Map(), objects = [],parallax=parallaxResolver(report,frame);
    frame.objects.forEach((object, slot) => {
      if (!layerVisible(report, object.unique_id)) return;
      oldToNew.set(slot, objects.length);
      const next = {...object, object_slot: objects.length}; delete next.runtime_segments;
      if(legacy&&!segmentColorTypes.has(object.figure_type_id))modernizeLegacyObjectColor(next);
      if (geometry?.objects.get(slot)?.solvedAngles) next.angles = geometry.objects.get(slot).solvedAngles.slice();
      if (geometry?.objects.get(slot)?.solvedLengths) {next.len_flag = 1; next.lengths = geometry.objects.get(slot).solvedLengths.slice();}
      delete next._stykIK;
      delete next._stykAnimationOrigin;
      delete next._stykZIndex;
      next.figure_type_id = styleTypeId(object); delete next._stykStyle;
      if (object.join) {
        const root = geometry.objects.get(slot)?.root;
        if (!root) throw messageError(new Error(''), "errors.pivotExportMaterialize.anExportedFigureHasUnresolvedJoinedGeometry", {});
        next.root_x = root.x; next.root_y = root.y;
      }
      const depth=parallax(object.unique_id);next.root_x+=depth.x;next.root_y+=depth.y;
      objects.push(next);
    });
    for (const object of objects) if (object.join) {
      const parent = oldToNew.get(object.join.target_object_slot);
      object.join = parent === undefined ? null : {...object.join, target_object_slot: parent, target_unique_id: objects[parent].unique_id};
    }
    objectCount += objects.length;
    if (objectCount > MAX_OBJECTS) throw messageError(new Error(''), "errors.pivotExportMaterialize.theComposedPivotExportExceedsTheTwoMillion", {});
    const order = (frame.object_draw_order ?? frame.objects.map((_, slot) => slot)).filter(slot => oldToNew.has(slot)).map(slot => oldToNew.get(slot));
    const next = withoutFrameIdentity({...frame, duration_raw: duration, objects, object_count: objects.length,
      keyframe_index: output.keyframes.length, object_draw_order: order, object_draw_order_unique_ids: order.map(slot => objects[slot].unique_id)});
    const sceneHidden = report._styk?.layers?.fixed?.scene?.visible === false;
    if (sceneHidden || next._stykBackgroundColor !== undefined) {
      next.background_id = colorId(sceneHidden ? 0 : next._stykBackgroundColor); next.background_id_b = 0; next.background_mix = 0;
    }
    next.camera=cameraAtTime(report,frame);delete next._cameraMotionTick;
    delete next._stykBackgroundColor;
    if (report._styk?.layers?.fixed?.camera?.visible === false) next.camera = {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0};
    // Existing aliases must agree with the authoritative native exposure.
    next.hidden = duration === 0; next.inbetweens = duration - 1; next.duration_frames = duration;
    output.keyframes.push(next);
  };
  if (!authored) {
    for (let index = 0; index < report.keyframes.length; index++) append(evaluatedFrame(report, index, 0, rows[index].start), report.keyframes[index].duration_raw);
  } else {
    let hiddenIndex = 0;
    const sourceMetadata = Object.keys(extraSources).length ? {...report._styk, frameSources: {...report._styk?.frameSources, ...extraSources}} : report._styk;
    for (let tick = 0; tick <= totalTicks; tick++) {
      while (hiddenIndex < hidden.length && hidden[hiddenIndex].tick === tick) {
        const exposure = hidden[hiddenIndex++], replacements = exposure.targets;
        const temporary = {...report, _styk: {...sourceMetadata, animation: {...report._styk?.animation,
          channels: [...channels.filter(channel => !replacements.has(channel.id)), ...[...replacements].map(([id, target]) =>
            ({id, target, property: 'pose', keys: [{id: 'export-hidden-pose', tick, value: {frameId: exposure.sourceId}, interpolation: 'hold'}]}))]}}};
        append(sampleAt(temporary, rows, tick, exposure), 0);
      }
      if (tick < totalTicks) append(sampleAt(report, rows, tick), 1);
    }
  }
  output.total_output_frames = totalTicks; output.duration_seconds = totalTicks / output.fps;
  output.figure_types = output.figure_types.map(figure => {
    if (!figure._styk?.animationOrigin) return figure;
    const metadata = {...figure._styk}; delete metadata.animationOrigin;
    return {...figure, _styk: metadata};
  });
  validateScene(output);
  return output;
}
