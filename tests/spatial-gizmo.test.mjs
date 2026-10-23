import test from 'node:test';
import assert from 'node:assert/strict';
import {quatMultiply,quatRotate,spatialQuaternion} from '../src/rig-spatial.mjs';
import {quaternionPose,betweenVectors,createSpatialGizmo,startRotationGizmo,rotateGizmo,ringPoint} from '../src/spatial-gizmo.mjs';
const quaternion=p=>spatialQuaternion(p.bend,p.turn,p.pitch);
const sameRotation=(a,b)=>assert.ok(Math.abs(a.reduce((s,v,i)=>s+v*b[i],0))>1-1e-8,`${a} != ${b}`);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const fixture=({pose={bend:0,turn:0,pitch:0},parent=[0,0,0,1],angle=0,mirror=false,scale=1}={})=>({
 selectedSlot:0,selectedJoint:0,figure:{segments:[{angle_rad:0}]},object:{angles:[angle],image_text_flags:mirror?1:0,scale},getSpatialPose:()=>pose,
 geometry:{objects:new Map([[0,{segments:[{start:{x:100,y:150},end:{x:120,y:250},spatialFrame:{q:quatMultiply(parent,quaternion(pose))}}]}]])},
});

test('quaternion channels round-trip compound rotations and both singularities without jumps',()=>{
 for(const turn of [-7,-Math.PI/2,-1.570795,0,1.570795,Math.PI/2,2,7])for(const pitch of [-4,.3,2])for(const bend of [-3,.7,5]){
  const p={pitch,turn,bend},q=quaternion(p),result=quaternionPose(q,p);sameRotation(quaternion(result),q);
  for(const key of Object.keys(p))near(result[key],p[key]);
 }
 let p={pitch:.4,turn:1.3,bend:.2};
 for(let i=0;i<80;i++){const target={pitch:.4,turn:1.3+i*.01,bend:.2},next=quaternionPose(quaternion(target),p);for(const key of Object.keys(p))assert.ok(Math.abs(next[key]-p[key])<.011);p=next;}
});
test('free rotation follows screen motion through parent turns, reflection and figure rotation',()=>{
 for(const parent of [quaternion({pitch:.3,turn:1.57,bend:.9}),quaternion({pitch:-2,turn:3,bend:.5})])for(const mirror of [false,true])for(const scale of [-1,1]){
  const e=fixture({parent,mirror,scale,angle:.6,pose:{bend:.4,pitch:.3,turn:1.57}}),g=createSpatialGizmo(e,p=>p);
  assert.deepEqual(g.center,{x:100,y:150});const drag=startRotationGizmo(g,g.center);assert.equal(drag.mode,'free');
  const result=rotateGizmo(drag,{x:115,y:140}),initialVector=g.fromScreen([0,0,1]);
  const delta=quatMultiply(quaternion(result),[-g.q[0],-g.q[1],-g.q[2],g.q[3]]),actual=quatRotate(delta,initialVector),wanted=g.fromScreen([.3,-.2,Math.sqrt(.87)]);
  actual.forEach((v,i)=>near(v,wanted[i]));
 }
});
test('local axis and view rings retain repeated revolutions and finite edge-on drags',()=>{
 const g=createSpatialGizmo(fixture(),p=>p),point={x:150,y:150};
 const drag={g,point,previous:g.pose,mode:'axis',ring:g.rings[2],last:0,total:0,edge:false};
 for(let i=1;i<=300;i++){const p=ringPoint(drag.ring,i*.05);rotateGizmo(drag,{x:g.center.x+p[0],y:g.center.y+p[1]});}
 near(drag.previous.bend,15);
 for(const ring of g.rings.slice(0,2)){
  const edge={g,point:{...point},previous:g.pose,mode:'axis',ring,last:0,total:0,edge:true};
  const p=rotateGizmo(edge,{x:point.x+20,y:point.y+10});assert.ok(Object.values(p).every(Number.isFinite));assert.ok(Math.hypot(...Object.values(p))>0);
 }
 const view=startRotationGizmo(g,{x:159,y:150});assert.equal(view.mode,'view');const p=rotateGizmo(view,{x:100,y:209});near(p.bend,Math.PI/2);
});
test('opposite trackball vectors produce a valid half-turn',()=>{
 const q=betweenVectors([1,0,0],[-1,0,0]);sameRotation(q,[0,0,1,0]);
});
