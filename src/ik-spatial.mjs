/** Persistent 3D target space for native spatial IK. No render caches or second
 * pose hierarchy: the solver still writes the figure's authored angle channels. */
import {animationRotation} from './animation-origin.mjs';
import {quatMultiply,quatRotate,spatialPoint,spatialQuaternion,betweenVectors} from './rig-spatial.mjs';
export const inverseQuaternion=q=>[-q[0],-q[1],-q[2],q[3]];
const normalize=v=>{const n=Math.hypot(...v);return n>1e-10?v.map(x=>x/n):[0,0,1];};
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function spatialWorldVector(v,figure,object,inverse=false){
 const a=animationRotation(figure,object),c=Math.cos(a),s=Math.sin(a),m=object.image_text_flags?-1:1;
 return inverse?[v[0]*c+v[1]*s,(-v[0]*s+v[1]*c)*m,v[2]]:[v[0]*c-v[1]*m*s,v[0]*s+v[1]*m*c,v[2]];
}
export function spatialWorldQuaternion(q,figure,object,inverse=false){
 const a=animationRotation(figure,object),reflect=v=>object.image_text_flags?[-v[0],v[1],-v[2],v[3]]:v;
 return inverse?reflect(quatMultiply(spatialQuaternion(-a,0,0),q)):quatMultiply(spatialQuaternion(a,0,0),reflect(q));
}
export function captureSpatialIK(figure,object,geometry,chain,followers,rotation=0,swivel=0){
 const spatialFollowers={};
 for(const i of followers){const q=geometry.segments[i]?.spatialFrame?.q;if(q)spatialFollowers[figure.segments[i].segment_id]=quatMultiply(spatialQuaternion(-rotation,0,0),spatialWorldQuaternion(q,figure,object));}
 const shapes=chain.map(i=>geometry.segments[i]);let spatialTarget;
 if(shapes.length===2&&shapes.every(s=>s.spatialFrame)){
  const points=[spatialPoint(shapes[0].spatialFrame,shapes[0].seg._stykRig.spatial.origin),...shapes.map(s=>spatialPoint(s.spatialFrame,s.seg._stykRig.spatial.tip))];
  const axis=normalize(points[2].map((v,i)=>v-points[0][i])),knee=points[1].map((v,i)=>v-points[0][i]);let pole=knee.map((v,i)=>v-axis[i]*dot(knee,axis));
  if(Math.hypot(...pole)<1e-5){const hint=quatRotate(shapes[0].spatialFrame.q,[0,0,1]);pole=hint.map((v,i)=>v-axis[i]*dot(hint,axis));if(Math.hypot(...pole)<1e-5)pole=cross(axis,[0,1,0]);}
  const normal=normalize(cross(axis,pole));
  const direction=normalize(pole),side=cross(axis,direction),reference=direction.map((v,i)=>v*Math.cos(swivel)-side[i]*Math.sin(swivel));
  spatialTarget={depth:points[2][2]*object.scale,pole:normalize(spatialWorldVector(reference,figure,object)),swivel,
   normals:shapes.map(s=>normalize(quatRotate(inverseQuaternion(s.spatialFrame.q),normal)))};
 }
 return {...(Object.keys(spatialFollowers).length?{spatialFollowers}:{}),...(spatialTarget?{spatialTarget}:{})};
}
export function spatialKnee(base,end,pole,swivel,a,b){
 const vector=end.map((v,i)=>v-base[i]),distance=Math.hypot(...vector),axis=normalize(vector),d=Math.max(Math.abs(a-b)+1e-8,Math.min(a+b,distance));
 let direction=pole.map((v,i)=>v-axis[i]*dot(pole,axis));
 if(Math.hypot(...direction)<1e-6)direction=cross(axis,Math.abs(axis[0])<.8?[1,0,0]:[0,1,0]);
 direction=normalize(direction);const side=cross(axis,direction),cs=Math.cos(swivel),sn=Math.sin(swivel);
 const along=(a*a-b*b+d*d)/(2*d),height=Math.sqrt(Math.max(0,a*a-along*along));
 const bend=direction.map((v,i)=>v*cs+side[i]*sn);
 return {knee:base.map((v,i)=>v+axis[i]*along+bend[i]*height),end:base.map((v,i)=>v+axis[i]*d),normal:normalize(cross(axis,bend))};
}
/** Flat, 2D-like bend of a two-bone limb: of the knee positions spatialKnee
 * can reach, the one where the upper bone keeps its depth `lean` (knee depth
 * minus base depth) and the knee lies on screen `side` of the base→end line
 * (the sign of their screen cross product). Returns the unit bend direction
 * across the axis, or null when the axis points into the screen, where every
 * knee position projects alike. */
export function flatSpatialBend(base,end,lean,side,a,b){
 const vector=end.map((v,i)=>v-base[i]),distance=Math.hypot(...vector),q=Math.hypot(vector[0],vector[1]);
 if(distance<1e-9||q<1e-6*distance)return null;
 const axis=vector.map(v=>v/distance),d=Math.max(Math.abs(a-b)+1e-8,Math.min(a+b,distance));
 const along=(a*a-b*b+d*d)/(2*d),height=Math.sqrt(Math.max(0,a*a-along*along));
 // u lies in the screen plane, so only v changes the knee's depth; the
 // knee's screen side is the opposite sign of its u component.
 const u=[vector[1]/q,-vector[0]/q,0],v=cross(axis,u);
 const sin=height*Math.abs(v[2])>1e-9?Math.max(-1,Math.min(1,(lean-axis[2]*along)/(height*v[2]))):0,cos=-side*Math.sqrt(1-sin*sin);
 return u.map((n,i)=>n*cos+v[i]*sin);
}
/** The pole for which spatialKnee bends toward `bend` at this swivel. */
export function spatialPoleFor(base,end,bend,swivel){
 const axis=normalize(end.map((v,i)=>v-base[i])),side=cross(axis,bend);
 return normalize(bend.map((v,i)=>v*Math.cos(swivel)-side[i]*Math.sin(swivel)));
}
/** Align both the bone axis and its captured bend-plane normal. A shortest
 * swing from the previous pose alone accumulates axial twist on closed drags. */
export function spatialIKOrientation(axis,normal,direction,plane){
 const aim=normalize(direction),swing=betweenVectors(normalize(axis),aim),turned=quatRotate(swing,normal);
 const angle=Math.atan2(dot(aim,cross(turned,plane)),dot(turned,plane))/2;
 const twist=[...aim.map(v=>v*Math.sin(angle)),Math.cos(angle)];
 return quatMultiply(twist,swing);
}
/** A pole is a direction in scene space; its displayed handle has a stable
 * radius derived from the limb, so dragging never adds another pose hierarchy. */
export function spatialPoleHandle(figure,object,geometry,chain,settings){
 if(chain.length!==2||!settings||Math.abs(object.scale)<1e-9)return null;
 const shapes=chain.map(i=>geometry.segments[i]);if(shapes.some(s=>!s.spatialFrame))return null;
 const world=p=>{const v=spatialWorldVector(p,figure,object).map(n=>n*object.scale);return[v[0]+geometry.root.x,v[1]+geometry.root.y,v[2]];};
 const base=world(spatialPoint(shapes[0].spatialFrame,shapes[0].seg._stykRig.spatial.origin)),knee=world(spatialPoint(shapes[0].spatialFrame,shapes[0].seg._stykRig.spatial.tip)),end=world(spatialPoint(shapes[1].spatialFrame,shapes[1].seg._stykRig.spatial.tip));
 const axis=normalize(end.map((v,i)=>v-base[i])),length=Math.hypot(...knee.map((v,i)=>v-base[i]))+Math.hypot(...end.map((v,i)=>v-knee[i]));
 const raw=settings.pole.map((v,i)=>v-axis[i]*dot(settings.pole,axis));let direction=normalize(Math.hypot(...raw)<1e-6?cross(axis,Math.abs(axis[0])<.8?[1,0,0]:[0,1,0]):raw);
 const side=cross(axis,direction),cs=Math.cos(settings.swivel??0),sn=Math.sin(settings.swivel??0);direction=direction.map((v,i)=>v*cs+side[i]*sn);
 const center=base.map((v,i)=>(v+end[i])/2),radius=Math.max(20,length*.5),point=center.map((v,i)=>v+direction[i]*radius);
 return{point,center,knee,axis,radius};
}
export function interpolateQuaternion(a,b,t){
 let d=dot(a,b),sign=d<0?-1:1;d=Math.min(1,Math.abs(d));
 const angle=Math.acos(d),sin=Math.sin(angle),x=sin>1e-6?Math.sin((1-t)*angle)/sin:1-t,y=(sin>1e-6?Math.sin(t*angle)/sin:t)*sign;
 return normalize(a.map((v,i)=>v*x+b[i]*y));
}
export function interpolatePole(a,b,t){return quatRotate(interpolateQuaternion([0,0,0,1],betweenVectors(a,b),t),a);}
