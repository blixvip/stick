import {messageError} from '../localized-error.mjs';
/** Optional single-sided native fills. A local reference triangle preserves
 * winding under reflection, rotation, joining and ID remapping. Ordinary
 * polygons remain double-sided. Optional depth guides offset native painter
 * order without storing any per-pose surface state. */
export function surfaceCulled(poly, points, joints, cachedParity) {
  const basis=poly._stykSurface?.basis;if(!basis)return false;
  let parity=cachedParity;
  if(parity===undefined){const o=joints.get(basis[0]),x=joints.get(basis[1]),y=joints.get(basis[2]);if(!o||!x||!y)return true;parity=(x.x-o.x)*(y.y-o.y)-(x.y-o.y)*(y.x-o.x);}
  if(points.length<3)return true;const p=points[0];
  let area=0,extent=0;
  for(let i=1;i<points.length;i++){
    const x=points[i].x-p.x,y=points[i].y-p.y;extent=Math.max(extent,x*x+y*y);
    if(i+1<points.length)area+=x*(points[i+1].y-p.y)-y*(points[i+1].x-p.x);
  }
  // Native pose channels use float32 angles. Treat subpixel slivers caused by
  // their rounding as edge-on; the tolerance scales with the actual surface.
  const facing=(poly._stykSurface.side==='back'?-1:1)*(poly._stykSurface.flipped?-1:1);
  return area*Math.sign(parity)*facing<=extent*2e-7;
}
export function surfaceOrder(poly,joints) {
  const surface=poly._stykSurface,base=Number(poly.z_order??0);
  if(!surface?.depth?.length)return base;
  const o=joints.get(surface.basis[0]),x=joints.get(surface.basis[1]);
  if(!o||!x)return base;
  const dx=x.x-o.x,dy=x.y-o.y,den=dx*dx+dy*dy;
  if(den<1e-16)return base;
  let depth=0;
  for(const id of surface.depth){const p=depthPoint(joints,id);if(!p)return base;depth+=((p.x-o.x)*dx+(p.y-o.y)*dy)/den;}
  return base+depth/surface.depth.length;
}
export function surfaceDepthValues(poly,joints){
  if(!poly._stykSurface?.depthTest)return undefined;
  const s=poly._stykSurface,o=joints.get(s.basis[0]),x=joints.get(s.basis[1]),dx=x.x-o.x,dy=x.y-o.y,den=dx*dx+dy*dy;
  return s.depth.map(id=>{const p=depthPoint(joints,id);return Number(poly.z_order??0)+(den>1e-16?((p.x-o.x)*dx+(p.y-o.y)*dy)/den:0);});
}
function depthPoint(joints,id){const p=joints.get(id);if(!p?.depthOffset)return p;const root=joints.get(0);return{x:root.x+p.depthOffset.x,y:root.y+p.depthOffset.y};}
/** One pose owns this small cache. Shared surface vertices are projected once,
 * independent of triangle count; no definition or previous pose is retained. */
export function createSurfaceEvaluation(joints){
  const frames=new Map(),root=joints.get(0);let lastBasis,lastFrame;
  return(poly,points,projected)=>{
    const s=poly._stykSurface,base=Number(poly.z_order??0),basis=s.basis;
    const same=lastBasis&&basis[0]===lastBasis[0]&&basis[1]===lastBasis[1]&&basis[2]===lastBasis[2];
    let f=same?lastFrame:frames.get(basis.join(':'));
    if(!f){const o=joints.get(s.basis[0]),x=joints.get(s.basis[1]),y=joints.get(s.basis[2]);
      if(!o||!x||!y)return{culled:true,z:base};
      const dx=x.x-o.x,dy=x.y-o.y;f={o,dx,dy,den:dx*dx+dy*dy,parity:dx*(y.y-o.y)-dy*(y.x-o.x),depth:new Map()};frames.set(basis.join(':'),f);}
    lastBasis=basis;lastFrame=f;
    if(projected){
      let sum=0;const values=projected.depthValues;
      for(let i=0;i<values.length;i++){sum+=values[i];values[i]+=base;}
      return{culled:surfaceCulled(poly,points,joints,f.parity),z:base+sum/(values.length||1),depthValues:values};
    }
    let sum=0;const values=s.depthTest?new Array(s.depth.length):undefined;
    for(let i=0;i<(s.depth?.length??0);i++){
      const id=s.depth[i];let value=f.depth.get(id);
      if(value===undefined){const p=joints.get(id);value=!p||f.den<1e-16?0:p.depthOffset?
        ((root.x+p.depthOffset.x-f.o.x)*f.dx+(root.y+p.depthOffset.y-f.o.y)*f.dy)/f.den:
        ((p.x-f.o.x)*f.dx+(p.y-f.o.y)*f.dy)/f.den;f.depth.set(id,value);}
      sum+=value;if(values)values[i]=base+value;
    }
    return{culled:surfaceCulled(poly,points,joints,f.parity),z:base+(s.depth?.length?sum/s.depth.length:0),depthValues:values};
  };
}
export function surfaceHandles(poly) {return [...(poly.segment_ids??[]),...(poly._stykSurface?.basis??[]),...(poly._stykSurface?.depth??[])];}
export function documentHasSurfaces(document,seen=new Set()) {
  if(seen.has(document))return false;seen.add(document);
  return document.figure_types.some(f=>f.polyfills?.some(p=>p._stykSurface)||f._styk?.spatialMesh||f._styk?.movieclip?.spatialMeshes||(f._styk?.movieclip&&documentHasSurfaces(f._styk.movieclip.document,seen)));
}
export function remapSurface(poly, remap) {
  if(poly._stykSurface)poly._stykSurface={...poly._stykSurface,basis:poly._stykSurface.basis.map(remap),...(poly._stykSurface.depth?{depth:poly._stykSurface.depth.map(remap)}:{})};
}
export function validateSurface(poly, ids) {
  const s=poly._stykSurface;if(s===undefined)return;
  if(!s||!Array.isArray(s.basis)||s.basis.length!==3||new Set(s.basis).size!==3||s.basis.some(id=>!Number.isInteger(id)||!ids.has(id)))throw messageError(new Error(''), "errors.surfaces.faceVisibilityNeedsThreeDistinctExistingReferenceJoints", {});
  if(s.side!==undefined&&!['front','back'].includes(s.side))throw messageError(new Error(''), "errors.surfaces.chooseFrontBackOrBothForFaceVisibility", {});
  if(s.flipped!==undefined&&typeof s.flipped!=='boolean')throw messageError(new Error(''), "errors.surfaces.faceFacingMustBeABoolean", {});
  if(s.depth!==undefined&&(!Array.isArray(s.depth)||!s.depth.length||s.depth.length>1024||s.depth.some(id=>!Number.isInteger(id)||!ids.has(id))))throw messageError(new Error(''), "errors.surfaces.faceDepthNeedsExistingReferenceJointsUpTo", {});
  if(s.depthTest!==undefined&&(typeof s.depthTest!=='boolean'||s.depthTest&&(s.depth?.length!==3||poly.segment_ids?.length!==3)))throw messageError(new Error(''), "errors.surfaces.depthTestingNeedsATriangleWithOneDepth", {});
}

/** Authoring validation is separate from pose evaluation: a valid reference may
 * temporarily flatten during animation, in which case its faces are hidden. */
export function editableSurface(surface, figure, joints, handleIds) {
  validateSurface({_stykSurface:surface,segment_ids:handleIds},new Set([0,...figure.segments.map(s=>s.segment_id)]));
  const [o,x,y]=surface.basis.map(id=>joints.get(id));
  const cross=o&&x&&y?(x.x-o.x)*(y.y-o.y)-(x.y-o.y)*(y.x-o.x):0;
  const scale=o&&x&&y?Math.hypot(x.x-o.x,x.y-o.y)*Math.hypot(y.x-o.x,y.y-o.y):0;
  if(!scale||Math.abs(cross)<=scale*1e-7)throw messageError(new Error(''), "errors.surfaces.referenceJointsMustFormATriangleChooseA", {});
  return {basis:[...surface.basis],side:surface.side??'front',flipped:surface.flipped??false,...(surface.depth?{depth:[...surface.depth]}:{}),...(surface.depthTest?{depthTest:true}:{})};
}

export function protectSurfaceReferences(figure, removed) {
  if((figure.polyfills??[]).some(p=>!p.segment_ids.some(id=>removed.has(id))&&[...(p._stykSurface?.basis??[]),...(p._stykSurface?.depth??[])].some(id=>removed.has(id))))
    throw messageError(new Error(''), "errors.editorBuilderTopology.thisJointControlsFaceVisibilityChangeTheFill", {});
  const mesh=figure._styk?.spatialMesh;
  if(mesh&&[...removed].some(id=>mesh.basis.includes(id)||mesh.bones.includes(id)))
    throw messageError(new Error(''), "errors.surfaces.thisJointMovesOrOrientsThe3dMesh", {});
}
