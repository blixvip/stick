import {messageError} from './localized-error.mjs';
/** Layer exposure sheet. Each key owns a complete pose on one layer. Imported
 * spans reference their original evaluator until their endpoints are edited. */
import {layerIdForUid} from './layers.mjs';
import {poseSourceFrame, samplePoseTrack} from './animation-pose.mjs';
import {validateKeyEasing} from './keyframe-easing.mjs';
import {snapshotPoseFrame} from './pose-snapshot.mjs';
import {continuations,setContinuations} from './movieclip-presence.mjs';
import {frameOrder,setOrder,normalizeFrame} from './pivot/structure.mjs';

const cache=new WeakMap();
// One validation index per live report. It retains only the current sheet's
// identities; history owns its immutable track records independently.
const validationIndices=new WeakMap();
export const MAX_SHEET_TICKS=10000000;
export function sheetTrack(report,id){return report._styk?.layerSheet?.tracks[id];}
export function sheetKeyAt(track,tick){
  const keys=track?.keys??[];let low=0,high=keys.length;
  while(low<high){const mid=(low+high)>>>1;if(keys[mid].tick<=tick)low=mid+1;else high=mid;}
  return {key:keys[low-1],next:keys[low],index:low-1};
}
export function sheetKeyTimes(report){
  const state=report._styk?.layerSheet;if(!state)return [];
  return [...new Set([0,...Object.values(state.tracks).flatMap(track=>track.keys.map(key=>key.tick))])].filter(t=>t<state.duration).sort((a,b)=>a-b);
}
function sheetValidationState(report){
  const state=report._styk?.layerSheet;if(state===undefined)return report;
  if(!state||state.version!==1||!Number.isInteger(state.duration)||state.duration<1||state.duration>MAX_SHEET_TICKS||
    !Number.isSafeInteger(state.nextId)||state.nextId<1||!state.tracks||Array.isArray(state.tracks))throw messageError(new Error(''), "errors.layerSheet.invalidLayerTimeline", {});
  const allowed=new Set(['scene','camera',...(report._styk.layers?.order??[])]);
  if([...allowed].some(id=>!Object.hasOwn(state.tracks,id)))throw messageError(new Error(''), "errors.layerSheet.layerTimelineIsMissingAnExposureTrack", {});
  return {state,allowed};
}
function validateTrack(report,id,track,allowed,duration){
    if(!allowed.has(id)||!track||!Array.isArray(track.keys))throw messageError(new Error(''), "errors.layerSheet.layerTimelineReferencesAMissingLayer", {});
    if(!Number.isInteger(track.end)||track.end<0||track.end>duration)throw messageError(new Error(''), "errors.layerSheet.invalidLayerExposureLength", {});
    const ids=new Set(),sources=new Map();let previous=-1,largest=0;
    const sourceFor=frameId=>{if(sources.has(frameId))return sources.get(frameId);const frame=poseSourceFrame(report,frameId);if(frame)sources.set(frameId,frame);return frame;};
    for(const key of track.keys){
      if(ids.size>=1000000||!key||typeof key.id!=='string'||!key.id||ids.has(key.id)||!Number.isInteger(key.tick)||key.tick<0||key.tick<=previous||key.tick>=track.end)
        throw messageError(new Error(''), "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered", {});
      ids.add(key.id);previous=key.tick;validateKeyEasing(key);
      if(key.patchOnly!==undefined&&key.patchOnly!==true)throw messageError(new Error(''), "errors.layerSheet.invalidMovieclipFrameBoundary", {});
      if(key.movieclipPatches!==undefined){
        if(!Array.isArray(key.movieclipPatches)||key.movieclipPatches.length>65535)throw messageError(new Error(''), "errors.layerSheet.invalidMovieclipFrameReplacements", {});
        const replaced=new Set();
        for(const patch of key.movieclipPatches){if(!patch||!Number.isInteger(patch.uid)||patch.uid<0||replaced.has(patch.uid)||!sourceFor(patch.frameId)||
          patch.replacementUid!==undefined&&!sourceFor(patch.frameId).objects.some(object=>object.unique_id===patch.replacementUid)||
          patch.orderIndex!==undefined&&(!Number.isInteger(patch.orderIndex)||patch.orderIndex<0||patch.orderIndex>65535))throw messageError(new Error(''), "errors.layerSheet.invalidMovieclipFrameReplacement", {});replaced.add(patch.uid);}
      }
      if(/^cell-\d+$/.test(key.id))largest=Math.max(largest,Number(key.id.slice(5)));
      if(key.sourceTick!==undefined){if(!Number.isFinite(key.sourceTick)||key.sourceTick<0||key.sourceTick>MAX_SHEET_TICKS)throw messageError(new Error(''), "errors.layerSheet.invalidImportedLayerTiming", {});}
      else if(key.value?.frameId!==null&&!sourceFor(key.value?.frameId))throw messageError(new Error(''), "errors.layerSheet.layerKeyReferencesAMissingPose", {});
    }
  return {track,keys:track.keys,end:track.end,count:track.keys.length,largest,sources};
}
function validateSheet(report,owner,incremental){
  if(report._styk?.layerSheet===undefined){validationIndices.delete(owner);return report;}
  const {state,allowed}=sheetValidationState(report),known=incremental?validationIndices.get(owner):undefined,
    previous=known&&known.nativeFrames===report.keyframes?known:undefined,tracks=new Map(),changed=new Set();
  // Undo may remove a newly created source table without changing imported
  // tracks. Recheck distinct source references rather than every retained key.
  const sameSources=summary=>{for(const [id,frame] of summary.sources)if(poseSourceFrame(report,id)!==frame)return false;return true;};
  let count=0,largest=0;
  for(const [id,track] of Object.entries(state.tracks)){
    const old=previous?.tracks.get(id),retained=old&&old.track===track&&old.keys===track.keys&&old.count===track.keys.length&&old.end===track.end&&sameSources(old);
    if(!allowed.has(id))throw messageError(new Error(''), "errors.layerSheet.layerTimelineReferencesAMissingLayer", {});
    if(retained&&track.end>state.duration)throw messageError(new Error(''), "errors.layerSheet.invalidLayerExposureLength", {});
    const summary=retained?old:validateTrack(report,id,track,allowed,state.duration);
    tracks.set(id,summary);if(!retained)changed.add(id);count+=summary.count;largest=Math.max(largest,summary.largest);
  }
  if(count>1000000)throw messageError(new Error(''), "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered", {});
  if(state.nextId<=largest)throw messageError(new Error(''), "errors.layerSheet.layerKeyIdentityCounterIsInvalid", {});
  for(const id of previous?.tracks.keys()??[])if(!tracks.has(id))changed.add(id);
  const owners=previous?.owners??new Map(),additions=previous?new Map():owners;
  for(const id of changed)for(const key of tracks.get(id)?.keys??[]){const keyId=key.id;
    const oldOwner=owners.get(keyId);
    if(additions.has(keyId)||oldOwner!==undefined&&!changed.has(oldOwner))throw messageError(new Error(''), "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered", {});
    additions.set(keyId,id);
  }
  // Do not alter the last valid index until every candidate invariant passes.
  for(const id of changed)for(const key of previous?.tracks.get(id)?.keys??[])owners.delete(key.id);
  for(const [keyId,id] of additions)owners.set(keyId,id);
  validationIndices.set(owner,{tracks,owners,nativeFrames:report.keyframes});
  return report;
}
export function validateLayerSheet(report){return validateSheet(report,report,false);}
/** Internal commands copy edited keys/tracks before publication. Untrusted load
 * and explicit validation keep the complete traversal above. */
export function validateLayerSheetChanges(report,owner){return validateSheet(report,owner,true);}
export function legacySheetReport(report){
  const state=report._styk.layerSheet;
  const metadata={...report._styk,animation:state.legacyAnimation};delete metadata.layerSheet;
  return {...report,_styk:metadata};
}
export function invalidateLayerSheet(report){cache.delete(report);}
function ordered(frame){return (frame.object_draw_order??frame.objects.map((_,i)=>i)).map(i=>frame.objects[i]).filter(Boolean);}
/** A frame replacement changes membership without inserting a new control point
 * into any figure's outer motion curve. All ordinary posing still uses poses. */
function replaceMovieclipFrame(report,base,patch,resolveGeometry,replacement=poseSourceFrame(report,patch.frameId)){
  const removed=patch.uid;
  const frame={...base,objects:base.objects.filter(object=>object.unique_id!==removed).map(object=>({...object}))};
  let geometry;
  for(const object of frame.objects)if(object.join){
    const parent=base.objects[object.join.target_object_slot]?.unique_id;
    if(parent===removed&&patch.replacementUid!==undefined)object.join={...object.join,target_unique_id:patch.replacementUid};
    else if(parent===removed){geometry??=resolveGeometry(report,base);const root=geometry.objects.get(object.object_slot)?.root;if(root){object.root_x=root.x;object.root_y=root.y;}object.join=null;}
    else object.join={...object.join,target_unique_id:parent};
  }
  const added=new Set(replacement.objects.map(object=>object.unique_id));
  frame.objects=frame.objects.filter(object=>!added.has(object.unique_id));
  frame.objects.push(...replacement.objects.map(object=>({...object,...(object.join?{join:{...object.join,target_unique_id:replacement.objects[object.join.target_object_slot]?.unique_id}}:{})})));
  const previous=frameOrder(base),anchor=previous.indexOf(removed),order=previous.filter(uid=>uid!==removed&&!added.has(uid));
  let insertion=anchor<0?order.length:Math.min(anchor,order.length);
  if(anchor<0&&patch.orderIndex!==undefined){
    const layer=layerIdForUid(report,removed),siblings=order.filter(uid=>layerIdForUid(report,uid)===layer);
    insertion=patch.orderIndex<siblings.length?order.indexOf(siblings[patch.orderIndex]):siblings.length?order.indexOf(siblings.at(-1))+1:order.length;
  }
  order.splice(insertion,0,...frameOrder(replacement));
  const slots=new Map(frame.objects.map((object,slot)=>[object.unique_id,slot]));
  for(const object of frame.objects)if(object.join)object.join.target_object_slot=slots.get(object.join.target_unique_id);
  setOrder(frame,order);normalizeFrame(frame);
  return setContinuations(frame,[...continuations(base).filter(step=>step.uid!==removed&&!continuations(replacement).some(value=>value.uid===step.uid)),...continuations(replacement)]);
}
export function sampleLayerSheet(report,tick,{sampleLegacy,sampleNative,resolveGeometry,skipMovieclipPatches=false}){
  const state=report._styk.layerSheet;
  let cached=cache.get(report);
  if(!cached||cached.state!==state){cached={state,legacy:legacySheetReport(report),samples:new Map(),channels:new Map(),endpoints:new WeakMap(),imported:new WeakMap(),baseTracks:new WeakMap(),patchChannels:new WeakMap()};cache.set(report,cached);}
  // All imported layers at the same time share one complete scene evaluation.
  cached.samples.clear();
  const sourceAt=time=>{let value=cached.samples.get(time);if(!value){value=sampleLegacy(cached.legacy,time);cached.samples.set(time,value);}return value;};
  const baseSample=(id,track)=>{
    const {key,next,index}=sheetKeyAt(track,tick);
    if(track&&tick>=track.end&&!['scene','camera'].includes(id))return null;
    if(!key)return null;
    if(key.value?.frameId===null)return null;
    if(next?.value?.frameId===null)return key.sourceTick!==undefined?sourceAt(key.sourceTick):poseSourceFrame(report,key.value?.frameId);
    if(key.sourceTick!==undefined&&(!next||next.sourceTick!==undefined)){
      const fraction=next?Math.max(0,Math.min(1,(tick-key.tick)/(next.tick-key.tick))):0;
      return sourceAt(key.sourceTick+fraction*((next?.sourceTick??key.sourceTick)-key.sourceTick));
    }
    let imported=cached.imported.get(track);if(imported===undefined){imported=track.keys.some(k=>k.sourceTick!==undefined);cached.imported.set(track,imported);}
    if(imported){
      const first=Math.max(0,index-1),last=Math.min(track.keys.length,index+3);
      const frames=track.keys.slice(first,last).map((entry,i)=>{
        let frame;
        if(entry.sourceTick!==undefined){frame=cached.endpoints.get(entry);if(!frame){const source=sourceAt(entry.sourceTick);frame=snapshotPoseFrame(source,['scene','camera'].includes(id)?[]:source.objects.filter(o=>layerIdForUid(report,o.unique_id)===id).map(o=>o.unique_id));cached.endpoints.set(entry,frame);}}
        else frame=poseSourceFrame(report,entry.value?.frameId);
        return {...(frame??report.keyframes[0]),...(!frame?{objects:[],object_count:0,object_draw_order:[],object_draw_order_unique_ids:[]}:{}),
          _styk:{...frame?._styk,easing:{interpolation:entry.interpolation,...(entry.bezier?{bezier:entry.bezier}:{})}},duration_raw:(track.keys[first+i+1]?.tick??entry.tick+1)-entry.tick};
      });
      const metadata={...report._styk};delete metadata.animation;delete metadata.layerSheet;
      return sampleNative({...report,version:5,keyframes:frames,_styk:metadata},index-first,next?(tick-key.tick)/(next.tick-key.tick):0);
    }
    let channel=cached.channels.get(track);
    if(!channel){channel={target:['scene','camera'].includes(id)?{kind:id}:{kind:'layer',id},property:'pose',keys:track.keys};cached.channels.set(track,channel);}
    return samplePoseTrack(report,channel,tick,{sampleNative:(source,index,t)=>sampleNative({...source,version:5},index,t)});
  };
  const sample=id=>{
    const track=state.tracks[id];if(!track)return null;
    let base=cached.baseTracks.get(track);
    if(!base){base=track.keys.some(key=>key.patchOnly)?{...track,keys:track.keys.filter(key=>!key.patchOnly)}:track;cached.baseTracks.set(track,base);}
    let frame=baseSample(id,base);
    const {key,next}=sheetKeyAt(track,tick);
    if(!skipMovieclipPatches&&tick<track.end)for(const patch of key?.movieclipPatches??[]){
      let replacement;
      if(next?.movieclipPatches?.some(value=>value.uid===patch.uid)&&!['constant','hold'].includes(key.interpolation)){
        let channels=cached.patchChannels.get(track);if(!channels){channels=new Map();cached.patchChannels.set(track,channels);}
        let channel=channels.get(patch.uid);
        if(!channel){channel={target:{kind:'layer',id},property:'pose',keys:track.keys.map(entry=>({...entry,value:{frameId:entry.movieclipPatches?.find(value=>value.uid===patch.uid)?.frameId??null}}))};channels.set(patch.uid,channel);}
        replacement=samplePoseTrack(report,channel,tick,{sampleNative:(source,index,t)=>sampleNative({...source,version:5},index,t)});
      }
      frame=replaceMovieclipFrame(report,frame??{...report.keyframes[0],objects:[],object_draw_order:[],object_draw_order_unique_ids:[]},patch,resolveGeometry,replacement);
    }
    return frame;
  };
  const template=report.keyframes[0],scene=sample('scene')??{background_id:0,background_id_b:0,background_mix:0},camera=sample('camera'),records=[];
  const frames=new Map(report._styk.layers.order.map(id=>[id,sample(id)]));
  // Imported layers commonly share one native pose. Retain its objects and
  // geometry identities instead of cloning the entire scene on every seek.
  if(camera===scene&&scene.objects?.every(object=>frames.get(layerIdForUid(report,object.unique_id))===scene)&&
    continuations(scene).every(step=>frames.get(layerIdForUid(report,step.uid))===scene)&&
    [...frames.values()].every(frame=>!frame||frame===scene||!frame.objects.length&&!continuations(frame).length))return scene;
  const partitions=new Map(),steps=[];
  for(const id of report._styk.layers.order){
    const frame=frames.get(id);if(!frame)continue;
    let groups=partitions.get(frame);
    if(!groups){groups=new Map();partitions.set(frame,groups);
      const groupFor=uid=>{const owner=layerIdForUid(report,uid);let group=groups.get(owner);if(!group)groups.set(owner,group={records:[],steps:[]});return group;};
      for(const object of ordered(frame))groupFor(object.unique_id).records.push({object,parent:object.join?frame.objects[object.join.target_object_slot]?.unique_id:null});
      for(const step of continuations(frame))groupFor(step.uid).steps.push(step);
    }
    const group=groups.get(id);if(group){for(const record of group.records)records.push(record);for(const step of group.steps)steps.push(step);}
  }
  const slots=new Map(records.map(({object},slot)=>[object.unique_id,slot]));
  const objects=records.map(({object,parent},slot)=>{
    const parentSlot=slots.get(parent),joined=object.join&&parentSlot!==undefined;
    if(object.object_slot===slot&&(!object.join||joined&&object.join.target_object_slot===parentSlot))return object;
    return {...object,object_slot:slot,join:joined?{...object.join,target_object_slot:parentSlot,target_unique_id:parent}:null};
  });
  const result={...template,objects,object_count:objects.length,object_draw_order:objects.map((_,i)=>i),object_draw_order_unique_ids:objects.map(o=>o.unique_id),camera:camera?.camera??{is_default:true,x:0,y:0,scale:1,angle_rad:0}};
  setContinuations(result,steps);
  for(const field of ['background_id','background_id_b','background_mix','background_color','_stykBackgroundColor','_stykVfx']){
    if(field in scene)result[field]=scene[field];else delete result[field];
  }
  return result;
}
