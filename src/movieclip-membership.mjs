import {messageError} from './localized-error.mjs';
/** Clock construction projects only membership and playback descriptors. The
 * existing sheet sampler still owns blanks, time remapping and replacements;
 * it never needs to interpolate a joint, build geometry or copy a dense pose. */
import {sampleLayerSheet} from './layer-sheet.mjs';
import {usesPresence, continuations} from './movieclip-presence.mjs';
import {easedProgress, easingMode} from './keyframe-easing.mjs';

export function createSheetMembershipSampler(report, nativeRows) {
  const sheet = report._styk?.layerSheet;
  // Legacy authored channels and inherited sources can change membership before
  // the sheet is composed. Keep their general evaluator until projected there.
  if (!sheet || sheet.legacyAnimation?.channels?.length || report._styk.movieclipSource) return null;
  const frames = new WeakMap();
  const project = frame => {
    let value = frames.get(frame);
    if (value) return value;
    const objects = [];
    for (const object of frame.objects) if (usesPresence(object)) objects.push({
      unique_id:object.unique_id, figure_type_id:object.figure_type_id,
      object_slot:objects.length, _stykMovieclip:object._stykMovieclip,
    });
    value = {objects, object_count:objects.length, duration_raw:frame.duration_raw,
      object_draw_order:objects.map((_, i)=>i), object_draw_order_unique_ids:objects.map(object=>object.unique_id),
      _styk:{frameId:frame._styk?.frameId,easing:frame._styk?.easing,movieclipContinuations:continuations(frame)}};
    frames.set(frame,value); return value;
  };
  const source = {...report, figure_types:[], keyframes:report.keyframes.map(project), _styk:{...report._styk,
    frameSources:Object.fromEntries(Object.entries(report._styk.frameSources ?? {}).map(([id,frame])=>[id,project(frame)]))}};
  const sampleNative = (document, index, fraction=0) => {
    const a=document.keyframes[index], b=document.keyframes[index+1];
    if (!b || fraction<=0 || document.version<5 && !a._styk?.easing) return a;
    const progress=easingMode(a._styk?.easing)==='auto' ? fraction : easedProgress(a._styk?.easing,fraction);
    return progress>=1 ? b : a;
  };
  return tick => sampleLayerSheet(source,tick,{
    sampleNative,
    sampleLegacy:(_, time)=>{
      let low=0,high=nativeRows.length-1;
      while(low<high){const mid=(low+high+1)>>>1;if(nativeRows[mid].start<=time)low=mid;else high=mid-1;}
      const row=nativeRows[low];
      return sampleNative(source,low,row?.count ? (time-row.start)/row.count : 0);
    },
    resolveGeometry:()=>{throw messageError(new Error(''), "errors.movieclipMembership.movieclipMembershipMustNotRequireGeometry", {});},
  });
}
