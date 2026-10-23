import {messageError} from './localized-error.mjs';
/** Cyclic, angle-driven native joint positions. Curves are document data;
 * evaluation is stateless, so dragging, seeking and export use the same pose. */
const TAU=Math.PI*2;
export function sameAnglePath(a,b){
  if(!a||!b)return a===b;
  return ['driver','pitch','origin','restAngle','pitchRestAngle','figureRestAngle','source'].every(k=>a[k]===b[k])&&
    (!a.keys&&!b.keys||a.keys?.length===b.keys?.length&&a.keys.every((p,i)=>p.length===b.keys[i].length&&p.every((v,j)=>v===b.keys[i][j])));
}
export function validateAnglePath(path,reference,dependencies){
  if(!path||typeof path!=='object'||Array.isArray(path))throw messageError(new Error(''), "errors.rigAnglePath.invalidAnglePath", {});
  if(path.source!==undefined){
    if(Object.keys(path).some(k=>k!=='source'))throw messageError(new Error(''), "errors.rigAnglePath.aDepthGuideOnlyReferencesItsAnglePath", {});
    reference(path.source,'Angle-path depth source');dependencies.add(path.source);return;
  }
  if(Object.keys(path).some(k=>!['driver','pitch','origin','restAngle','pitchRestAngle','figureRestAngle','keys'].includes(k)))throw messageError(new Error(''), "errors.rigAnglePath.invalidAnglePathField", {});
  reference(path.driver,'Angle-path driver');reference(path.origin,'Angle-path origin',true);dependencies.add(path.driver);dependencies.add(path.origin);
  if(path.pitch!==undefined){reference(path.pitch,'Angle-path pitch');dependencies.add(path.pitch);}
  for(const k of ['restAngle','pitchRestAngle','figureRestAngle'])if(!Number.isFinite(path[k])||Math.abs(path[k])>1e6)throw messageError(new Error(''), "errors.rigAnglePath.setFiniteAnglePathReferenceAngles", {});
  if(!Array.isArray(path.keys)||path.keys.length<2||path.keys.length>64)throw messageError(new Error(''), "errors.rigAnglePath.anAnglePathNeeds264OrderedSamples", {});
  let prior=-Infinity;
  for(const key of path.keys){
    if(!Array.isArray(key)||key.length!==4||key.some(n=>!Number.isFinite(n)||Math.abs(n)>1e6)||key[0]<0||key[0]>=TAU||key[0]<=prior)throw messageError(new Error(''), "errors.rigAnglePath.anglePathSamplesRequireIncreasingAnglesFrom0", {});
    prior=key[0];
  }
}
/** Periodic cubic Hermite interpolation with monotone component tangents.
 * Limiting the tangents prevents narrow reference shapes from overshooting. */
export function sampleAnglePath(keys,angle){
  let t=((angle%TAU)+TAU)%TAU,i=keys.findLastIndex(k=>k[0]<=t);if(i<0){i=keys.length-1;t+=TAU;}
  const n=keys.length,a=keys[i],b=keys[(i+1)%n],before=keys[(i+n-1)%n],after=keys[(i+2)%n];
  const timeB=b[0]+(i===n-1?TAU:0),span=timeB-a[0],u=(t-a[0])/span;
  const prevSpan=(a[0]-before[0]+TAU)%TAU,nextSpan=(after[0]-b[0]+TAU)%TAU;
  const tangent=(left,right,h0,h1)=>left*right<=0?0:(3*(h0+h1))/((2*h1+h0)/left+(h1+2*h0)/right);
  return [1,2,3].map(k=>{const slope=(b[k]-a[k])/span,m0=tangent((a[k]-before[k])/prevSpan,slope,prevSpan,span),m1=tangent(slope,(after[k]-b[k])/nextSpan,span,nextSpan);
    return (2*u**3-3*u*u+1)*a[k]+(u**3-2*u*u+u)*span*m0+(-2*u**3+3*u*u)*b[k]+(u**3-u*u)*span*m1;});
}
