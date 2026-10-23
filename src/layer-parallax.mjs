import {messageError} from './localized-error.mjs';
import {cameraTravelAt} from './camera-motion.mjs';
/** Camera-relative translations; original geometry, topology and artwork stay immutable. */
const zero=Object.freeze({x:0,y:0});
export function validateCameraParallaxOffset(camera){const p=camera?._parallaxMotionOffset;if(p!==undefined&&(!p||![p.x,p.y].every(Number.isFinite)))throw messageError(new Error(''), "errors.layerParallax.invalidBakedCameraParallaxOffset", {});}
export function validateParallax(p){
  if(p===undefined)return;
  if(!p||typeof p.enabled!=='boolean'||typeof p.linked!=='boolean'||![p.x,p.y].every(v=>Number.isFinite(v)&&v>=0&&v<=4)||!p.reference||![p.reference.x,p.reference.y].every(Number.isFinite))throw messageError(new Error(''), "errors.layerParallax.parallaxNeedsA0400ResponseAndA", {});
}
export function parallaxResolver(report,frame,cameraEnabled=true){
  const layers=report?._styk?.layers;
  if(!cameraEnabled||layers?.fixed?.camera?.visible===false||!layers)return ()=>zero;
  // Follow moves the camera itself, so it drives depth like authored travel; shake-style impulses do not.
  const travel=cameraTravelAt(report,frame),camera=travel?.is_default?{}:travel??{},impulse=camera._parallaxMotionOffset??zero,offsets=new Map();
  for(const id of layers.order){const p=layers.byId[id].parallax;if(p?.enabled)offsets.set(id,{x:(1-p.x)*((camera.x??0)-impulse.x-p.reference.x),y:(1-p.y)*((camera.y??0)-impulse.y-p.reference.y)});}
  if(!offsets.size)return ()=>zero;
  const objects=frame?.objects,roots=new Map(),rootUids=new Map();
  // Only joined members need identity mapping; ordinary layers allocate no
  // per-object projection state. Path compression keeps long chains linear.
  if(objects)for(let i=0;i<objects.length;i++){
    if(!objects[i].join||roots.has(i))continue;
    let slot=i;const chain=[];
    while(objects[slot]?.join&&!roots.has(slot)&&chain.length<=objects.length){chain.push(slot);slot=Number(objects[slot].join.target_object_slot);}
    const uid=roots.get(slot)??objects[slot]?.unique_id??objects[i].unique_id;
    for(const part of chain){roots.set(part,uid);rootUids.set(objects[part].unique_id,uid);}
  }
  return uid=>offsets.get(layers.assignments[String(rootUids.get(uid)??uid)]??layers.defaultLayerId)??zero;
}
export function translatedPlan(plan,offset){const m=plan.matrix;return {...plan,matrix:[...m.slice(0,4),m[4]+m[0]*offset.x+m[2]*offset.y,m[5]+m[1]*offset.x+m[3]*offset.y]};}
