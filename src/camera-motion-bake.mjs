import {messageError} from './localized-error.mjs';
import {evaluatedFrame,timeline} from './pivot/geometry.mjs';
import {cameraAtTime,cameraTravelAt} from './camera-motion.mjs';
import {followSamplingReport} from './camera-follow.mjs';
import {sheetKeyAt} from './layer-sheet.mjs';
import {autoKeyRange} from './keyframe-easing.mjs';
/** Camera projection for baking. Follow clips also need the figures they follow, and
 * only those; other figures, media and geometry never reach the bake. */
export function cameraSamplingReport(report){
  const follows=(report._styk?.cameraMotion?.clips??[]).filter(c=>c.type==='follow'&&c.enabled);
  if(follows.length){
    const projection=followSamplingReport(report,[...new Set(follows.flatMap(c=>c.targets.map(t=>t.uid)))]);
    const types=new Set([...projection.keyframes,...Object.values(projection._styk.frameSources??{})].flatMap(f=>f.objects.map(o=>o.figure_type_id)));
    return {...projection,figure_types:report.figure_types.filter(f=>types.has(f.figure_type_id)),backgrounds:[],_styk:{...projection._styk,cameraMotion:report._styk.cameraMotion}};
  }
  return cameraOnlyReport(report);
}
function cameraOnlyReport(report){
  const frame=f=>({objects:[],camera:f.camera,duration_raw:f.duration_raw,_styk:{frameId:f._styk?.frameId,easing:f._styk?.easing}});
  const animation=a=>a?{...a,channels:a.channels.filter(c=>c.target.kind==='camera')}:undefined;
  const sheet=report._styk?.layerSheet,layers=report._styk?.layers;
  const authored=animation(report._styk?.animation),legacy=animation(sheet?.legacyAnimation),references=new Set([
    ...(sheet?.tracks.camera.keys??[]),...(authored?.channels??[]).flatMap(c=>c.keys),...(legacy?.channels??[]).flatMap(c=>c.keys),
  ].map(k=>k.value?.frameId).filter(Boolean)),frameSources={};
  for(const id of references){const source=report._styk?.frameSources?.[id];if(source)frameSources[id]=frame(source);}
  const metadata={cameraMotion:report._styk?.cameraMotion,animation:authored,frameSources,layers:layers?{version:layers.version,defaultLayerId:layers.defaultLayerId,order:[],byId:{},assignments:{},fixed:layers.fixed}:undefined};
  if(sheet)metadata.layerSheet={version:sheet.version,duration:sheet.duration,nextId:sheet.nextId,tracks:{camera:sheet.tracks.camera,scene:{end:sheet.duration,keys:[]}},legacyAnimation:legacy};
  return {version:report.version,fps:report.fps,frame_delay_ms:report.frame_delay_ms,canvas_width:report.canvas_width,canvas_height:report.canvas_height,auto_easing:report.auto_easing,figure_types:[],backgrounds:[],keyframes:report.keyframes.map(frame),_styk:metadata};
}
/** Bake adjoining curve spans as guards, retaining every unedited output tick.
 * Auto runs share tangents, so the complete adjoining run must be retained. */
export function cameraBakeRange(report,start,end){
  const track=report._styk?.layerSheet?.tracks.camera,keys=track?.keys??[];
  if(!keys.length)return {sampleStart:start,sampleEnd:end};
  const left=Math.max(0,sheetKeyAt(track,start).index),right=Math.min(keys.length-1,Math.max(left,sheetKeyAt(track,end-1).index+1));
  const [first,last]=autoKeyRange(keys,left,right);
  const sampleStart=Math.min(start,keys[first].tick),sampleEnd=Math.max(end,keys[last].tick);
  if(sampleEnd-sampleStart>100000)throw messageError(new Error(''), "errors.cameraMotionBake.splitTheCameraEasingSpanBeforeBakingAt", {});
  return {sampleStart,sampleEnd};
}
export async function sampleMotionBake(report,{start,end,signal,onProgress}={}){
  const source=cameraSamplingReport(report),rows=timeline(source),frames=[],{sampleStart,sampleEnd}=cameraBakeRange(source,start,end);let index=0,deadline=performance.now()+6;
  const restore=sampleEnd<(source._styk?.layerSheet?.duration??rows.at(-1).start+rows.at(-1).count);
  for(let tick=sampleStart;tick<sampleEnd+Number(restore);tick++){
    if(signal?.aborted)throw messageError(new DOMException('', 'AbortError'), "errors.cameraMotionBakeClient.cameraBakeCancelled", {});
    while(index+1<rows.length&&rows[index+1].start<=tick)index++;
    const row=rows[index],frame=evaluatedFrame(source,index,row.count?(tick-row.start)/row.count:0,tick),base=frame.camera?.is_default?{x:0,y:0,scale:1,angle_rad:0}:frame.camera??{x:0,y:0,scale:1,angle_rad:0},inside=tick>=start&&tick<end;
    const moved=inside?cameraTravelAt(source,frame):null,travel=moved&&!moved.is_default?moved:base,camera=inside?(cameraAtTime(source,frame)??base):base;
    // Keep the baked screen impulse separate from depth-driving camera travel, which includes follow.
    const previous=base._parallaxMotionOffset??{x:0,y:0};
    frames.push({tick,restore:tick===sampleEnd,camera:{...camera,is_default:false,_parallaxMotionOffset:{x:camera.x-travel.x+previous.x,y:camera.y-travel.y+previous.y}}});
    if(performance.now()>=deadline){onProgress?.((tick-start+1)/(end-start));await new Promise(resolve=>setTimeout(resolve,0));deadline=performance.now()+6;}
  }
  return frames;
}
