import {messageError} from './localized-error.mjs';
/** Perspective is a final projection of the existing spatial pose. IK targets
 * remain in scene coordinates, before projection, in every saved document. */
export const cameraDefaults = Object.freeze({strength: 0, distance: 600});
export const shapeDefaults = Object.freeze({width: 1, taper: 0});
export const spatialCamera = object => ({...cameraDefaults, centerX:object?.root_x??0, centerY:object?.root_y??0, ...object?._stykSpatial?.camera});
export const spatialShape = (object, id) => ({...shapeDefaults, ...object?._stykSpatial?.shape?.[id]});
function projectedDrawing(objects,object,figures){
  const parent=objects[object.join?.target_object_slot],figure=id=>figures?.find(f=>f.figure_type_id===id);
  const asset=figure(object.figure_type_id)?._styk?.movieclip;
  return Boolean((asset?.drawingRotation||asset?.spatialMeshes)&&figure(parent?.figure_type_id)?.segments.some(s=>s.segment_id===object.join.target_handle_id&&s._stykRig?.spatial?.origin));
}
export const spatialPerspectiveAvailable = (objects, object, figures) => !object?.join && !objects.some(o=>o.join?.target_object_slot===object?.object_slot&&!projectedDrawing(objects,o,figures));
export function validateSpatialJoins(frame,figures){
  for(const o of frame.objects)if(o.join&&(o._stykSpatial?.camera?.strength||frame.objects[o.join.target_object_slot]?._stykSpatial?.camera?.strength&&!projectedDrawing(frame.objects,o,figures)))throw messageError(new Error(''), "errors.spatialProjection.perspectiveRequiresASingleSpatialFigureOrA", {});
}
export function projection(object, root) {
  const c = object?._stykSpatial?.camera;
  if (!c?.strength || !object.scale) return null;
  return {root:{x:c.centerX??root.x,y:c.centerY??root.y}, k: c.strength / (c.distance * Math.abs(object.scale)), scale: Math.abs(object.scale)};
}
const NEAR = .05;
export function projectSpatial(p, camera) {
  if (!camera) return {x:p[0], y:p[1]};
  const d = Math.max(NEAR, 1 - camera.k * p[2]);
  return {x:camera.root.x + (p[0]-camera.root.x)/d,
    y:camera.root.y + (p[1]-camera.root.y)/d, rawPoint:p};
}
export function unprojectSpatial(p, depth, object, root) {
  const camera = projection(object, root);
  if (!camera) return {x:p.x, y:p.y};
  const d = Math.max(NEAR, 1 - camera.k * depth);
  return {x:camera.root.x+(p.x-camera.root.x)*d, y:camera.root.y+(p.y-camera.root.y)*d};
}
export const unprojectJoint = p => p.rawPoint ? {x:p.rawPoint[0], y:p.rawPoint[1]} : {x:p.x,y:p.y};

/** Clip a convex spatial face before projection. A clipped triangle may have
 * four vertices; the shared depth compositor triangulates its convex fan. */
export function projectSpatialFace(points, camera) {
  if (!camera || !points.length || points.some(p=>!p.rawPoint)) return null;
  const near = (1-NEAR)/camera.k;
  if (!points.some(p=>p.rawPoint[2]>near)) return {points,depthValues:points.map(p=>p.rawPoint[2]/(1-camera.k*p.rawPoint[2])/camera.scale)};
  const raw = points.map(p=>p.rawPoint),clipped=[];
  for(let i=0;i<raw.length;i++){
    const a=raw[i], b=raw[(i+1)%raw.length], inside=a[2]<=near, next=b[2]<=near;
    if(inside)clipped.push(a);
    if(inside!==next){const t=(near-a[2])/(b[2]-a[2]);clipped.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,near]);}
  }
  return {points:clipped.map(p=>projectSpatial(p,camera)),
    depthValues:clipped.map(p=>p[2]/Math.max(NEAR,1-camera.k*p[2])/camera.scale)};
}
export function validateSpatialPose(object, figure) {
  const state=object._stykSpatial;if(state===undefined)return;
  const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
  const number=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
  if(!record(state)||Object.keys(state).some(k=>!['camera','shape'].includes(k)))throw messageError(new Error(''), "errors.spatialProjection.invalidSpatialPoseSettings", {});
  if(state.camera!==undefined){const c=state.camera;if(!record(c)||Object.keys(c).some(k=>!['strength','distance','centerX','centerY'].includes(k))||!number(c.strength,0,1)||!number(c.distance,10,100000)||['centerX','centerY'].some(k=>c[k]!==undefined&&!number(c[k],-1e7,1e7)))throw messageError(new Error(''), "errors.spatialProjection.perspectiveNeedsStrength01AndDistance10", {});}
  if(state.shape!==undefined){
    if(!record(state.shape)||Object.keys(state.shape).length>figure.segments.length)throw messageError(new Error(''), "errors.spatialProjection.invalidSpatialProportions", {});
    const bones=new Set(figure.segments.filter(s=>s._stykRig?.spatial?.origin).map(s=>s.segment_id));
    for(const[id,s]of Object.entries(state.shape))if(String(Number(id))!==id||!bones.has(Number(id))||!record(s)||Object.keys(s).some(k=>!['width','taper'].includes(k))||!number(s.width,.1,5)||!number(s.taper,-.9,3))throw messageError(new Error(''), "errors.spatialProjection.spatialProportionsNeedAnExistingBoneWidth0", {});
  }
}
export function interpolateSpatialPose(a,b,t) {
  const lerp=(a,b,min=-1e7,max=1e7)=>Math.max(min,Math.min(max,a+(b-a)*t)), ca=spatialCamera(a),cb=spatialCamera(b),shape={};
  for(const id of new Set([...Object.keys(a._stykSpatial?.shape??{}),...Object.keys(b._stykSpatial?.shape??{})])){
    const x=spatialShape(a,id),y=spatialShape(b,id);shape[id]={width:lerp(x.width,y.width,.1,5),taper:lerp(x.taper,y.taper,-.9,3)};
  }
  return {camera:{strength:lerp(ca.strength,cb.strength,0,1),distance:lerp(ca.distance,cb.distance,10,100000),centerX:lerp(ca.centerX,cb.centerX),centerY:lerp(ca.centerY,cb.centerY)},...(Object.keys(shape).length?{shape}:{})};
}
