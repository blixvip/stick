import {messageError} from './localized-error.mjs';
/** Display colors and copy-on-write recoloring. No geometry or asset copies. */
import {resolveInstanceFigure, styleColor, polygonIdentity, meshPaletteColor} from './animation-style.mjs';
import {segmentPaint, normalizePaint, parseColor, hexColor, samplePaint} from './paint.mjs';
import {color, mixColor} from './pivot/geometry.mjs';

export const usesSegmentColors = (report, figure, object) => report.version >= 5 || figure?._styk?.colorMode === 'segments' || object?._styk?.colorMode === 'segments';
export function displayedColor(report, figure, object, rgb) {
  if (!usesSegmentColors(report, figure, object)) return (Number(object.color_override_raw) | 0) < 0 ? [0,0,0] : color(object.color_override_raw).rgb;
  return mixColor(rgb, object.color_override_raw);
}
export function displayedSegmentPaint(report, figure, object, segment) {
  const paint = segmentPaint(segment);
  // A full native override suppresses the secondary endpoint, including alpha.
  // Bake that visible solid so clearing the override cannot reveal a new fade.
  if(usesSegmentColors(report,figure,object) && Number(object.color_override_raw)>>>24===255){paint.type='solid';paint.stops=[paint.stops[0]];}
  return {...paint, stops:paint.stops.map(stop=>({...stop,color:displayedColor(report,figure,object,stop.color)}))};
}
export function figurePalette(report, figure, object) {
  const resolved=resolveInstanceFigure(figure,object), colors=new Map();
  const row=rgb=>{const key=hexColor(rgb);if(!colors.has(key))colors.set(key,{color:key,segments:[],polygons:[]});return colors.get(key);};
  for(const segment of resolved.segments){
    const stops=displayedSegmentPaint(report,resolved,object,segment).stops, matches=new Map();
    stops.forEach((stop,index)=>{const entry=row(stop.color);let match=matches.get(entry);if(!match){match={handleId:segment.segment_id,stops:[]};entry.segments.push(match);matches.set(entry,match);}match.stops.push(index);});
  }
  resolved.polyfills?.forEach((polygon,index)=>row(displayedColor(report,resolved,object,polygon.color_rgb??[0,0,0])).polygons.push(polygonIdentity(polygon,index)));
  resolved._styk?.spatialMesh?.colors.forEach((_,index)=>{
    const entry=row(displayedColor(report,resolved,object,meshPaletteColor(resolved,object,index)));
    (entry.meshColors??=[]).push(index);
  });
  return [...colors.values()].sort((a,b)=>b.segments.length-a.segments.length || a.color.localeCompare(b.color));
}
/** Palette membership is scoped by instance: attached rigs can reuse handle IDs. */
export function attachedFigurePalette(report, frame, uid) {
  const objects=frame.objects, start=objects.findIndex(object=>object.unique_id===uid);
  if(start<0)return [];
  const children=new Map(), figures=new Map(report.figure_types.map(figure=>[figure.figure_type_id,figure]));
  objects.forEach((object,slot)=>{
    const parent=object.join?.target_object_slot;
    if(parent===undefined)return;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(slot);
  });
  const queue=[start], seen=new Set(queue), colors=new Map();
  for(let cursor=0;cursor<queue.length;cursor++){
    const slot=queue[cursor], object=objects[slot], figure=figures.get(object.figure_type_id);
    if(figure)for(const entry of figurePalette(report,figure,object)){
      if(!colors.has(entry.color))colors.set(entry.color,{color:entry.color,segments:[],polygons:[],instances:{}});
      const row=colors.get(entry.color);
      for(const segment of entry.segments)row.segments.push(segment);
      for(const polygon of entry.polygons)row.polygons.push(polygon);
      if(entry.meshColors)row.meshColors=[...new Set([...(row.meshColors??[]),...entry.meshColors])];
      row.instances[object.unique_id]={...entry,figureTypeId:figure.figure_type_id};
    }
    for(const child of children.get(slot)??[])if(!seen.has(child)){seen.add(child);queue.push(child);}
  }
  if(queue.length===1)for(const row of colors.values())delete row.instances;
  return [...colors.values()].sort((a,b)=>b.segments.length-a.segments.length||a.color.localeCompare(b.color));
}
const rgb=value=>{
  if(typeof value==='string')return parseColor(value).color;
  if(!Array.isArray(value)||value.length!==3||value.some(n=>!Number.isInteger(n)||n<0||n>255))throw messageError(new Error(''), "errors.figureColors.chooseThreeRgbBytesOrAHexColor", {});
  return [...value];
};
const opacity=value=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw messageError(new Error(''), "errors.figureColors.opacityMustBeBetweenZeroAndOne", {});return value;};
export function validateRecolor(input) {
  const operation={...input};
  if(!['all','replace','style','reset'].includes(operation.mode))throw messageError(new Error(''), "errors.figureColors.chooseAColorOperation", {});
  if(operation.color!==undefined)operation.color=rgb(operation.color);
  if(operation.from!==undefined)operation.from=rgb(operation.from);
  if(operation.opacity!==undefined)opacity(operation.opacity);
  if(operation.mode==='replace'&&(!operation.color||!operation.from&&!operation.targets))throw messageError(new Error(''), "errors.figureColors.chooseTheColorToReplace", {});
  if(operation.targets){
    if(operation.targets.instances)for(const [uid,targets] of Object.entries(operation.targets.instances)){
      if(!Number.isInteger(Number(uid))||Number(uid)<0||Number(uid)>0xffffffff||targets.instances)throw messageError(new Error(''), "errors.figureColors.chooseValidPaletteInstances", {});
      validateRecolor({...operation,targets});
    }
    if(!Array.isArray(operation.targets.segments)||!Array.isArray(operation.targets.polygons??[]))throw messageError(new Error(''), "errors.figureColors.chooseValidPaletteTargets", {});
    for(const entry of operation.targets.segments)if(!Number.isInteger(entry.handleId)||entry.handleId<1||entry.handleId>65535||!Array.isArray(entry.stops)||entry.stops.some(index=>!Number.isInteger(index)||index<0||index>=32))throw messageError(new Error(''), "errors.figureColors.chooseValidSegmentColorStops", {});
    for(const id of operation.targets.polygons??[])if(!Number.isInteger(id)||id<1||id>65535)throw messageError(new Error(''), "errors.figureColors.chooseValidFillIdentities", {});
    if(operation.targets.meshColors!==undefined&&(!Array.isArray(operation.targets.meshColors)||operation.targets.meshColors.length>1024||new Set(operation.targets.meshColors).size!==operation.targets.meshColors.length||Array.from(operation.targets.meshColors).some(index=>!Number.isInteger(index)||index<0||index>=1024)))
      throw messageError(new Error(''), 'errors.figureColors.chooseValidPaletteTargets', {});
  }
  if(operation.mode==='style'){
    const patch=operation.patch={...operation.patch};
    for(const key of Object.keys(patch))if(!['color','paint','gradient','opacity','thickness'].includes(key))throw messageError(new Error(''), "errors.figureColors.unsupportedColorStyle", {key: key});
    if(patch.color!==undefined)patch.color=rgb(patch.color);
    if(patch.paint)patch.paint=normalizePaint(patch.paint);
    if(patch.opacity!==undefined)opacity(patch.opacity);
    if(patch.thickness!==undefined&&(!Number.isFinite(patch.thickness)||patch.thickness<0||patch.thickness>1e6))throw messageError(new Error(''), "errors.figureColors.invalidSegmentThickness", {});
    if(patch.gradient){patch.gradient={...patch.gradient,color:rgb(patch.gradient.color??'#ffffff')};if(patch.gradient.opacity!==undefined)opacity(patch.gradient.opacity);}
  }
  return operation;
}
/** Returns the original object for no-ops. Only the edited instance owns overlays. */
export function recolorObject(report, figure, object, operation) {
  if(operation.targets?.instances){
    const targets=operation.targets.instances[object.unique_id];
    if(!targets)return object;
    operation={...operation,targets,figureTypeId:targets.figureTypeId};
  }
  if(operation.figureTypeId!==undefined&&operation.figureTypeId!==figure.figure_type_id)return object;
  const fields={};
  if(operation.opacity!==undefined){const value=Math.round((1-operation.opacity)*255);if(value!==(object.field28??0))fields.field28=value;}
  if(operation.mode==='all'&&!operation.color)return Object.keys(fields).length?{...object,...fields}:object;
  if(operation.mode==='replace'&&!operation.targets&&hexColor(operation.from)===hexColor(operation.color))return object;
  const resolved=resolveInstanceFigure(figure,object);
  let targets=operation.targets;
  if(operation.mode==='replace'&&!targets)targets=figurePalette(report,figure,object).find(entry=>entry.color===hexColor(operation.from));
  if(operation.mode==='replace'&&!targets)return object;
  const matches=new Map((targets?.segments??[]).map(entry=>[entry.handleId,entry.stops]));
  const polygons=new Set(targets?.polygons??[]);
  const meshColors=new Set(targets?.meshColors??[]),mesh=resolved._styk?.spatialMesh;
  for(const index of meshColors)if(index>=(mesh?.colors.length??0))throw messageError(new Error(''), 'errors.figureColors.chooseValidPaletteTargets', {});
  const needsNormalize=!usesSegmentColors(report,figure,object)||Boolean(Number(object.color_override_raw)>>>24);
  const normalize=operation.mode==='reset'||needsNormalize;
  const style={...object._stykStyle,segments:{...object._stykStyle?.segments},polygons:{...object._stykStyle?.polygons},
    ...(object._stykStyle?.meshColors?{meshColors:{...object._stykStyle.meshColors}}:{})};
  let changed=false;
  const write=(table,id,patch)=>{const before=table[id]??{},next={...before,...patch};if(JSON.stringify(before)!==JSON.stringify(next)){table[id]=next;changed=true;}};
  const putPaint=(segment,paint)=>{
    const patch={color:styleColor(paint.stops[0].color)};
    if(paint.type!=='solid')patch.gradientColor=styleColor(paint.stops.at(-1).color);
    // Native two-endpoint gradients need no duplicated paint record.
    if(segment.paint||segment.secondary&&paint.type==='solid'||operation.mode==='style'&&(operation.patch.paint||'gradient' in operation.patch))patch.paint=paint;
    if(operation.mode==='style'&&(operation.patch.paint||'gradient' in operation.patch)){
      patch.opacity=paint.stops[0].opacity;
      if(paint.type!=='solid')patch.gradientOpacity=paint.stops.at(-1).opacity;
    }
    write(style.segments,segment.segment_id,patch);
  };
  for(let index=0;index<resolved.segments.length;index++){
    const segment=resolved.segments[index], selected=operation.mode==='all'||operation.mode==='reset'||matches.has(segment.segment_id);
    if(!normalize&&!selected)continue;
    let paint=displayedSegmentPaint(report,resolved,object,segment);
    if(operation.mode==='reset'){
      const original=segmentPaint(figure.segments[index]);
      paint.stops.forEach(stop=>stop.color=samplePaint(original,stop.offset).color.map(Math.round));
    }
    if(operation.mode==='all'&&operation.color)paint.stops.forEach(stop=>stop.color=operation.color);
    if(operation.mode==='replace'&&selected)for(const stop of matches.get(segment.segment_id)){
      if(!paint.stops[stop])throw messageError(new Error(''), "errors.figureColors.theGradientChangedReopenThePalette", {});paint.stops[stop].color=operation.color;
    }
    if(operation.mode==='style'&&selected){
      const patch=operation.patch;
      if(patch.paint)paint=normalizePaint(patch.paint);
      if(patch.color)paint.stops[0].color=patch.color;
      if(patch.opacity!==undefined)paint.stops[0].opacity=patch.opacity;
      if('gradient' in patch){
        if(!patch.gradient){paint.type='solid';paint.stops=[paint.stops[0]];}
        else {if(paint.type==='solid'){paint.type='linear';paint.stops.push({offset:1,color:patch.gradient.color,opacity:1});}paint.stops.at(-1).color=patch.gradient.color;if(patch.gradient.opacity!==undefined)paint.stops.at(-1).opacity=patch.gradient.opacity;}
      }
      const values={};if(patch.opacity!==undefined)values.opacity=patch.opacity;if(patch.thickness!==undefined)values.thickness=patch.thickness;
      write(style.segments,segment.segment_id,values);
    }
    putPaint(segment,paint);
  }
  resolved.polyfills?.forEach((polygon,index)=>{
    const id=polygonIdentity(polygon,index),selected=operation.mode==='all'||operation.mode==='reset'||polygons.has(id);
    if(!normalize&&!selected)return;
    let value=operation.mode==='reset'?figure.polyfills[index].color_rgb:displayedColor(report,resolved,object,polygon.color_rgb??[0,0,0]);
    if(selected&&operation.color)value=operation.color;
    if(selected&&operation.mode==='style'&&operation.patch.color)value=operation.patch.color;
    write(style.polygons,id,{color:styleColor(value),...(selected&&operation.mode==='style'&&operation.patch.opacity!==undefined?{opacity:operation.patch.opacity}:{})});
  });
  mesh?.colors.forEach((_,index)=>{
    const selected=operation.mode==='all'||operation.mode==='reset'||meshColors.has(index);
    if(!normalize&&!selected)return;
    let value=operation.mode==='reset'?figure._styk.spatialMesh.colors[index]:displayedColor(report,resolved,object,meshPaletteColor(resolved,object,index));
    if(selected&&operation.color)value=operation.color;
    if(selected&&operation.mode==='style'&&operation.patch.color)value=operation.patch.color;
    const next=styleColor(value),before=style.meshColors?.[index];
    if(next!==before){style.meshColors??={...object._stykStyle?.meshColors};style.meshColors[index]=next;changed=true;}
  });
  if(!changed&&!needsNormalize&&!Object.keys(fields).length)return object;
  return {...object,...fields,...(!usesSegmentColors(report,figure,object)?{_styk:{...object._styk,colorMode:'segments'}}:{}),_stykStyle:style,color_override_raw:0};
}
