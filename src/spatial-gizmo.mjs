import {animationRotation} from './animation-origin.mjs';
import {quatMultiply,quatRotate,spatialQuaternion,spatialAxisQuaternion,quaternionPose,betweenVectors} from './rig-spatial.mjs';
import {canvasFont} from './ui/font-loading.mjs';
import {t as interfaceText} from './localization.mjs';

const TAU=Math.PI*2,RADIUS=50,IDENTITY=[0,0,0,1];
const axes=[[1,0,0],[0,1,0],[0,0,1]];
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const inverse=q=>[-q[0],-q[1],-q[2],q[3]];
const normalize=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

const axisRotation=(i,a)=>[...axes[i].map(v=>v*Math.sin(a/2)),Math.cos(a/2)];

export function createSpatialGizmo(editor,project){
 const pose=editor.getSpatialPose();if(!pose)return null;
 const motion=editor.getSpatialMotion?.();if(motion&&(motion.type!=='hinge'||motion.max<=motion.min))return null;
 const shape=editor.geometry.objects.get(editor.selectedSlot)?.segments[editor.selectedJoint];if(!shape?.spatialFrame)return null;
 const axis=normalize(editor.figure.segments[editor.selectedJoint]?._stykRig?.spatial?.motion?.axis??axes[2]);
 const q=motion?spatialAxisQuaternion(axis,motion.applied):spatialQuaternion(pose.bend,pose.turn,pose.pitch),world=shape.spatialFrame.q,parent=quatMultiply(world,inverse(q));
 const angle=animationRotation(editor.figure,editor.object),cs=Math.cos(angle),sn=Math.sin(angle),mirror=editor.object.image_text_flags?-1:1,sign=editor.object.scale<0?-1:1;
 const screen=v=>[(v[0]*cs-v[1]*mirror*sn)*sign,(v[0]*sn+v[1]*mirror*cs)*sign,v[2]];
 const fromScreen=v=>quatRotate(inverse(parent),[(v[0]*cs+v[1]*sn)*sign,(-v[0]*sn+v[1]*cs)*sign*mirror,v[2]]);
 let rings;
 if(motion){
  const i=axis.reduce((best,n,k)=>Math.abs(n)>Math.abs(axis[best])?k:best,0),hint=axes[(i+1)%3],d=dot(axis,hint);
  const u=normalize(hint.map((n,k)=>n-axis[k]*d)),v=cross(axis,u);
  rings=[{axis:i,color:['#ee727c','#65d7a0','#74adff'][i],u:screen(quatRotate(world,u)),v:screen(quatRotate(world,v))}];
 }else rings=axes.map((_,i)=>({axis:i,color:['#ee727c','#65d7a0','#74adff'][i],u:screen(quatRotate(world,axes[(i+1)%3])),v:screen(quatRotate(world,axes[(i+2)%3]))}));
 return {center:project(shape.start),radius:RADIUS,pose:motion?{bend:motion.value,turn:0,pitch:0}:pose,q,fromScreen,rings,...(motion?{motion}:{}),label:shape.seg?.name||interfaceText('errors.validationLabels.jointRotation')};
}
export const ringPoint=(ring,t,radius=RADIUS)=>ring.u.map((v,i)=>(v*Math.cos(t)+ring.v[i]*Math.sin(t))*radius);
export function drawRotationGizmo(ctx,gizmo){
 if(!gizmo)return;const {center,rings,radius}=gizmo;
 ctx.save();ctx.translate(center.x,center.y);ctx.lineCap='round';
 if(!gizmo.motion){ctx.fillStyle='rgba(15,23,38,.06)';ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.fill();}
 // Back arcs remain visible, but the front arcs have stronger contrast.
 for(const front of [false,true])for(const ring of rings){
  ctx.strokeStyle=ring.color;ctx.globalAlpha=front?1:.3;ctx.lineWidth=front?2.6:1.3;
  ctx.beginPath();let open=false;for(let i=0;i<=96;i++){const p=ringPoint(ring,i*TAU/96,radius),visible=(p[2]>=0)===front;if(visible){open?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]);}open=visible;}ctx.stroke();
 }
 if(!gizmo.motion){ctx.globalAlpha=.85;ctx.strokeStyle='#dde5f1';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,radius+9,0,TAU);ctx.stroke();}
 ctx.globalAlpha=1;ctx.fillStyle='#192234';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,4,0,TAU);ctx.fill();ctx.stroke();
 ctx.font=canvasFont('10px');ctx.textAlign='center';ctx.fillStyle='#192234';const label=gizmo.label??interfaceText('errors.validationLabels.jointRotation'),width=Math.min(220,Math.max(96,ctx.measureText(label).width+16));ctx.fillRect(-width/2,-radius-31,width,17);ctx.fillStyle='#fff';ctx.fillText(label,0,-radius-19,width-12);ctx.restore();
}
function sphere(point,g){
 const x=(point.x-g.center.x)/g.radius,y=(point.y-g.center.y)/g.radius,r2=x*x+y*y;
 return g.fromScreen(normalize([x,y,r2<=.5?Math.sqrt(1-r2):.5/Math.sqrt(r2)]));
}
export function startRotationGizmo(g,point){
 if(!g)return null;const x=point.x-g.center.x,y=point.y-g.center.y,d=Math.hypot(x,y);
 if(d>g.radius+15)return null;
 const base={g,point,previous:g.pose};
 if(d>g.radius+4)return g.motion?null:{...base,mode:'view',last:Math.atan2(y,x),total:0};
 let best=null;
 for(const ring of g.rings)for(let i=0;i<144;i++){
  const t=i*TAU/144,p=ringPoint(ring,t,g.radius),distance=Math.hypot(p[0]-x,p[1]-y);
  // Resolve intersections toward the visible arc, with a stable axis tie-break.
  const score=distance+(p[2]<0?.8:0);
  if(distance<6&&(!best||score<best.score))best={ring,t,score};
 }
 if(best&&d>12){const r=best.ring;return {...base,mode:'axis',ring:r,last:best.t,total:0,edge:Math.abs(r.u[0]*r.v[1]-r.u[1]*r.v[0])<.12};}
 if(g.motion)return null;
 return {...base,mode:'free',vector:sphere(point,g)};
}
export function rotateGizmo(drag,point,precision=false){
 const g=drag.g,gain=precision?.15:1;let q;
 if(drag.mode==='free'){
  let delta=betweenVectors(drag.vector,sphere(point,g));
  if(precision){const angle=2*Math.acos(Math.max(-1,Math.min(1,delta[3]))),n=Math.hypot(...delta.slice(0,3));delta=n>1e-9?[...delta.slice(0,3).map(v=>v/n*Math.sin(angle*gain/2)),Math.cos(angle*gain/2)]:IDENTITY;}
  q=quatMultiply(delta,g.q);
 }else{
  if(drag.mode==='view'){
   const a=Math.atan2(point.y-g.center.y,point.x-g.center.x);drag.total+=wrap(a-drag.last);drag.last=a;
  }else if(drag.edge){
   // An edge-on circle cannot be inverted. Drag along its visible tangent.
   const r=drag.ring,t=drag.last,tx=-r.u[0]*Math.sin(t)+r.v[0]*Math.cos(t),ty=-r.u[1]*Math.sin(t)+r.v[1]*Math.cos(t),n=Math.hypot(tx,ty);
   const dx=point.x-drag.point.x,dy=point.y-drag.point.y;
   drag.total+=(n>.1?(dx*tx+dy*ty)/n:dx-dy)/g.radius;drag.point=point;
  }else{
   const r=drag.ring,x=point.x-g.center.x,y=point.y-g.center.y,det=r.u[0]*r.v[1]-r.u[1]*r.v[0];
   const a=Math.atan2((r.u[0]*y-r.u[1]*x)/det,(x*r.v[1]-y*r.v[0])/det);drag.total+=wrap(a-drag.last);drag.last=a;
  }
  if(g.motion){const pose={bend:Math.max(g.motion.min,Math.min(g.motion.max,g.pose.bend+drag.total*gain)),turn:0,pitch:0};drag.previous=pose;return pose;}
  if(drag.mode==='axis')q=quatMultiply(g.q,axisRotation(drag.ring.axis,drag.total*gain));
  else {const a=g.fromScreen([1,0,0]),b=g.fromScreen([Math.cos(drag.total*gain),Math.sin(drag.total*gain),0]);q=quatMultiply(betweenVectors(a,b),g.q);}
 }
 const pose=quaternionPose(q,drag.previous);drag.previous=pose;return pose;
}

export {quaternionPose,betweenVectors};
