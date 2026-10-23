import {messageError} from './localized-error.mjs';
import {editorSpatialShapeMethods} from './editor-spatial-shape.mjs';
import {unprojectSpatial,unprojectJoint,projectSpatial,projection} from './spatial-projection.mjs';
import {geometryPlans} from './pivot/geometry-pose.mjs';
import {animationRotation} from './animation-origin.mjs';
import {rigConstraintPlan} from './rig-constraints.mjs';
import {spatialBone,spatialSkin,spatialMotionValue,spatialAxisQuaternion,quatMultiply,quatRotate,spatialPoint,spatialQuaternion,quaternionPose,betweenVectors} from './rig-spatial.mjs';
import {inverseQuaternion,spatialWorldQuaternion,spatialWorldVector,spatialPoleHandle,captureSpatialIK,flatSpatialBend,spatialPoleFor,spatialKnee} from './ik-spatial.mjs';
import {ikChain,ikLayout,ikFollowerIndices,solveObjectIK} from './ik.mjs';
import {poseChoiceGroups,applyChannelPoseChoice} from './rig-pose-choices.mjs';

const plans=e=>geometryPlans(e.geometry.objects.get(e.selectedSlot));
const layout=e=>plans(e)?.definition??ikLayout(e.figure);
const rigPlan=e=>plans(e)?.plan??rigConstraintPlan(e.figure);
export const editorSpatialMethods={
 ...editorSpatialShapeMethods,
 setPoseChoice(name,id){
  const group=poseChoiceGroups(this.figure,this.object).find(g=>g.name===name);if(!group)return false;
  if((id===0&&group.hidden===false)||(id!==0&&!group.choices.some(c=>c.id===id)))throw messageError(new Error(''), "errors.editorSpatial.chooseAnAvailableRigPose", {});
  if(group.value===id)return false;
  return this._objectEdit('Change '+name,o=>{
   if(group.kind==='channels'){
    applyChannelPoseChoice(this.figure,o,group.choices.find(c=>c.id===id));return;
   }
   const lengths=o.len_flag?o.lengths.slice():this.figure.segments.map(s=>s.length);
   for(const c of group.choices)lengths[c.index]=c.id===id?c.shown:c.hidden;
   o.lengths=lengths;o.len_flag=1;delete o.runtime_segments;
  },{posed:true});
 },
 _releaseSpatialChain(object,index=this.selectedJoint){
  // Direct FK manipulation takes ownership of this limb. The object edit has
  // already baked its displayed IK pose; release only the chain being rotated.
  for(const[id,c]of Object.entries(object._stykIK??{}))if(c.enabled&&c.pinned&&c.spatialTarget&&ikChain(this.figure,Number(id),c.chainLength,layout(this)).includes(index))
   object._stykIK={...object._stykIK,[id]:{...c,pinned:false}};
 },
 getSpatialIKPole(){
  const f=this.figure,o=this.object,s=f?.segments[this.selectedJoint],c=o?._stykIK?.[s?.segment_id];
  if(!c?.enabled||!c.spatialTarget||c.bendDirection!==0)return null;
  const pole=spatialPoleHandle(f,o,this.geometry.objects.get(this.selectedSlot),ikChain(f,s.segment_id,c.chainLength,layout(this)),c.spatialTarget);
  return pole?{...pole,handle:s.segment_id}:null;
 },
 setSpatialIKPole(x,y,depth){
  const pole=this.getSpatialIKPole();if(!pole)return false;
  if(![x,y,depth??pole.point[2]].every(Number.isFinite))throw messageError(new Error(''), "errors.editorSpatial.chooseAFiniteIkPolePosition", {});
  const g=this.geometry.objects.get(this.selectedSlot),p=unprojectSpatial({x,y},depth??pole.point[2],this.object,g.root);
  const v=[p.x-pole.center[0],p.y-pole.center[1],(depth??pole.point[2])-pole.center[2]],n=Math.hypot(...v);if(n<1e-6)return false;
  return this.setSpatialIKTarget({pole:v.map(x=>x/n),swivel:0});
 },
 setSpatialIKTarget(patch){
  const f=this.figure,id=f?.segments[this.selectedJoint]?.segment_id,c=this.object?._stykIK?.[id];
  if(!c?.enabled||!c.spatialTarget||c.bendDirection!==0)return false;
  for(const[k,v]of Object.entries(patch)){
   if(k==='pole'){if(!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite)||Math.abs(Math.hypot(...v)-1)>1e-5)throw messageError(new Error(''), "errors.editorSpatial.chooseAUnitIkPoleDirection", {});}
   else if(!['depth','swivel'].includes(k)||!Number.isFinite(v)||Math.abs(v)>1e6)throw messageError(new Error(''), "errors.editorSpatial.chooseAFiniteSpatialIkAdjustment", {});
  }
  const g=this.geometry.objects.get(this.selectedSlot);
  return this._objectEdit(patch.pole?'Move IK pole':'Adjust spatial IK target',o=>{
   let capture;
   if(!c.pinned){
    const key=`${o.unique_id}:${id}`;this._drag.spatialIKCapture??=new Map();
    if(!this._drag.spatialIKCapture.has(key))this._drag.spatialIKCapture.set(key,captureSpatialIK(f,o,g,ikChain(f,id,c.chainLength,layout(this)),ikFollowerIndices(f,id,layout(this)),c.target.rotation,c.spatialTarget.swivel));
    capture=this._drag.spatialIKCapture.get(key);
   }
   const next={...c,...capture,target:{...c.target,...(!c.pinned?unprojectJoint(g.joints.get(id)):{})},spatialTarget:{...(capture?.spatialTarget??c.spatialTarget),...patch}};
   if(patch.depth!==undefined){
    const screen=c.pinned?projectSpatial([c.target.x,c.target.y,c.spatialTarget.depth],projection(o,g.root)):g.joints.get(id);
    Object.assign(next.target,unprojectSpatial(screen,patch.depth,o,g.root));
   }
   if(!c.pinned){
    const solved=solveObjectIK(f,o,g.root,layout(this),{[id]:{...next,pinned:true}},{includePoints:false,rigPlan:rigPlan(this),followTargetOrientation:false});o.angles=solved.angles;
    if(solved.lengths){o.lengths=solved.lengths;o.len_flag=1;}
   }
   o._stykIK={...o._stykIK,[id]:next};delete o.runtime_segments;
  },{posed:true});
 },
 setSpatialFeetPinned(pinned){
  const f=this.figure,o=this.object;if(!f||!o)return false;
  const targets=f.segments.flatMap((s,i)=>o._stykIK?.[s.segment_id]?.enabled&&f.segments.some(child=>spatialBone(child)&&child._stykRig.spatial.parent===s.segment_id&&/foot|ankle/i.test(child.name??''))?[i]:[]);
  if(!targets.length)return false;
  const selected=this.selectedJoint;if(!this.beginDrag(pinned?'Plant feet':'Release feet'))return false;
  try{for(const i of targets){this.selectedJoint=i;this.setNodeIK({pinned});}this.selectedJoint=selected;this.commitDrag();return true;}
  catch(error){this.selectedJoint=selected;this.cancelDrag();throw error;}
 },
 getSpatialPose(index=this.selectedJoint){
  const f=this.figure,o=this.object,s=f?.segments[index];if(!o||!spatialBone(s))return null;
  const r=s._stykRig.spatial,delta=animationRotation(f,o),find=id=>{const i=f.segments.findIndex(s=>s.segment_id===id);return i<0?undefined:i;},parent=find(r.parent),turn=find(r.turn),pitch=find(r.pitch);
  const angles=this.geometry.objects.get(this.selectedSlot)?.solvedAngles??o.angles;
  const sign=o.image_text_flags?-1:1,parentAngle=parent===undefined?0:(angles[parent]-delta)*sign-f.segments[parent].angle_rad;
  const bend=(angles[index]-delta)*sign-s.angle_rad-parentAngle;
  // Mechanical details expose their authored residual. Their master's applied
  // rotation remains an evaluation dependency, not another editable channel.
  return r.motion?{bend:r.motion.type==='hinge'?Math.atan2(Math.sin(bend),Math.cos(bend)):0,turn:0,pitch:0}:
   {bend,turn:(angles[turn]-delta)*sign-f.segments[turn].angle_rad,pitch:(angles[pitch]-delta)*sign-f.segments[pitch].angle_rad};
 },
 setSpatialPose(patch,{wholeFigure=false}={}){
  const before=this.getSpatialPose();if(!before)return false;
  for(const[k,v]of Object.entries(patch))if(!['bend','turn','pitch'].includes(k)||!Number.isFinite(v)||Math.abs(v)>1e6)throw messageError(new Error(''), "errors.editorSpatial.chooseAFiniteJointRotation", {});
  // A hinge accepts only its own rotation; a slide does not rotate.
  const motion=this.getSpatialMotion();if(motion)return motion.type==='hinge'&&patch.bend!==undefined?this.setSpatialMotion(patch.bend):false;
  if(Object.entries(patch).every(([k,v])=>Math.abs(v-before[k])<1e-12))return false;
  const f=this.figure,r=f.segments[this.selectedJoint]._stykRig.spatial,ids=rigPlan(this).ids;
  const frame=this.geometry.objects.get(this.selectedSlot).segments[this.selectedJoint].spatialFrame;
  const parent=quatMultiply(frame.q,inverseQuaternion(spatialQuaternion(before.bend,before.turn,before.pitch))),next={...before,...patch};
  const world=spatialWorldQuaternion(quatMultiply(parent,spatialQuaternion(next.bend,next.turn,next.pitch)),f,this.object),handle=f.segments[this.selectedJoint].segment_id;
  if(wholeFigure&&r.parent)throw messageError(new Error(''), "errors.editorSpatial.selectTheRootArticulationToRotateTheWhole", {});
  const controllers=wholeFigure?this.object._stykIK:null;
  const delta=wholeFigure?quatMultiply(world,inverseQuaternion(spatialWorldQuaternion(frame.q,f,this.object))):null;
  const root=this.geometry.objects.get(this.selectedSlot).root;
  const center=wholeFigure?spatialWorldVector(spatialPoint(frame,r.origin),f,this.object).map((v,i)=>v*this.object.scale+(i===0?root.x:i===1?root.y:0)):null;
  return this._objectEdit('Rotate articulated joint',o=>{
   this._releaseSpatialChain(o);
   if(patch.bend!==undefined)this._rotateJoint((patch.bend-before.bend)*(o.image_text_flags?-1:1));
   for(const key of ['turn','pitch'])if(patch[key]!==undefined)o.angles[ids.get(r[key])]+=(patch[key]-before[key])*(o.image_text_flags?-1:1);
   this._plantSpatialFollower(o,handle,world);
   // Figure orientation moves the existing targets and their bend planes as
   // one rigid transform. Local torso posing still leaves planted feet alone.
   if(controllers)o._stykIK=Object.fromEntries(Object.entries(controllers).map(([id,c])=>{
    if(!c.spatialTarget)return[id,c];
    const p=quatRotate(delta,[c.target.x-center[0],c.target.y-center[1],c.spatialTarget.depth-center[2]]);
    const rotate=q=>quatMultiply(spatialQuaternion(-c.target.rotation,0,0),quatMultiply(delta,quatMultiply(spatialQuaternion(c.target.rotation,0,0),q)));
    return[id,{...c,target:{...c.target,x:center[0]+p[0],y:center[1]+p[1]},
     spatialTarget:{...c.spatialTarget,depth:center[2]+p[2],pole:quatRotate(delta,c.spatialTarget.pole)},
     ...(c.spatialFollowers?{spatialFollowers:Object.fromEntries(Object.entries(c.spatialFollowers).map(([id,q])=>[id,rotate(q)]))}:{})}];
   }));
  },{posed:true});
 },
 resetSpatialPose(all=false){
  if(!all)return this.getSpatialMotion()?this.setSpatialMotion(0):this.setSpatialPose({bend:0,turn:0,pitch:0});
  const f=this.figure,o=this.object;if(!f||!o)return false;
  return this._objectEdit('Reset articulated rig',o=>{
   const delta=animationRotation(f,o),ids=rigPlan(this).ids;
   for(const s of f.segments)if(spatialBone(s))for(const id of [s.segment_id,s._stykRig.spatial.turn,s._stykRig.spatial.pitch]){const i=ids.get(id);o.angles[i]=f.segments[i].angle_rad*(o.image_text_flags?-1:1)+delta;}
   // Slides return to their rest position (or the nearest end of their range).
   const slides=f.segments.flatMap((s,i)=>s._stykRig?.spatial?.motion?.type==='slide'?[i]:[]);
   if(slides.length){o.lengths=o.len_flag?o.lengths.slice():f.segments.map(s=>s.length);o.len_flag=1;
    for(const i of slides){const r=f.segments[i]._stykRig.spatial,rest=Math.hypot(...r.tip.map((n,k)=>n-r.origin[k]));o.lengths[i]=rest+Math.min(r.motion.max,Math.max(r.motion.min,0));}}
   // Targets must release when the animator explicitly restores the rest pose.
   if(o._stykIK)o._stykIK=Object.fromEntries(Object.entries(o._stykIK).map(([id,c])=>[id,{...c,pinned:false}]));
  },{posed:true});
 },
 /** Gesture reference for direct spatial posing. Every sample is solved from
  * this fixed start, so closed drags return exactly and twist cannot drift. */
 _spatialGesture(kind){
  const f=this.figure,o=this.object,i=this.selectedJoint,key=`${kind}:${o.unique_id}:${i}`;
  if(this._drag)this._drag.spatialGesture??=new Map();
  let gesture=this._drag?.spatialGesture.get(key);
  if(gesture)return gesture;
  const g=this.geometry.objects.get(this.selectedSlot),shape=g.segments[i],frame=shape.spatialFrame,r=f.segments[i]._stykRig.spatial;
  const world=p=>{const v=spatialWorldVector(p,f,o).map(n=>n*o.scale);return[v[0]+g.root.x,v[1]+g.root.y,v[2]];};
  const start=unprojectJoint(shape.start),origin=[start.x,start.y,world(spatialPoint(frame,r.origin))[2]],tip=world(spatialPoint(frame,r.tip)),vector=tip.map((v,k)=>v-origin[k]),length=Math.hypot(...vector);
  const before=this.getSpatialPose(),local=spatialQuaternion(before.bend,before.turn,before.pitch);
  // Limbs lying in the view plane leave toward the character's front.
  let root=shape;while(root.seg._stykRig?.spatial?.parent){const parent=g.segments[rigPlan(this).ids.get(root.seg._stykRig.spatial.parent)];if(!parent?.spatialFrame)break;root=parent;}
  const front=quatRotate(spatialWorldQuaternion(root.spatialFrame.q,f,o),[0,0,1])[2];
  const depth=length>1e-9?vector[2]/length:0;
  gesture={origin,tip,length,direction:length>1e-9?vector.map(v=>v/length):[1,0,0],side:Math.abs(depth)>.04?Math.sign(depth):front<-.2?-1:1,
   world:spatialWorldQuaternion(frame.q,f,o),parent:quatMultiply(frame.q,inverseQuaternion(local)),start:null};
  this._drag?.spatialGesture.set(key,gesture);
  return gesture;
 },
 /** A planted hand or foot keeps the world orientation it is given; the
  * solver otherwise restores its stored one. */
 _plantSpatialFollower(object,handle,world){
  for(const [id,c]of Object.entries(object._stykIK??{}))if(c.enabled&&c.pinned&&c.spatialFollowers?.[handle])
   object._stykIK={...object._stykIK,[id]:{...c,spatialFollowers:{...c.spatialFollowers,[handle]:quatMultiply(spatialQuaternion(-c.target.rotation,0,0),world)}}};
 },
 /** Write a world orientation for the selected bone into its native channels. */
 _setSpatialWorldOrientation(world,gesture,label,edit){
  const f=this.figure,o=this.object,i=this.selectedJoint,r=f.segments[i]._stykRig.spatial,before=this.getSpatialPose(),ids=rigPlan(this).ids;
  const pose=quaternionPose(quatMultiply(inverseQuaternion(gesture.parent),spatialWorldQuaternion(world,f,o,true)),before);
  return this._objectEdit(label,target=>{
   this._releaseSpatialChain(target);
   const sign=target.image_text_flags?-1:1;this._rotateJoint((pose.bend-before.bend)*sign);
   for(const key of ['turn','pitch'])target.angles[ids.get(r[key])]+=(pose[key]-before[key])*sign;
   this._plantSpatialFollower(target,f.segments[i].segment_id,world);
   edit?.(target);
  },{posed:true});
 },
 /** Right-drag: twist the selected part around its own axis (turn a head,
  * twist a torso or forearm). Horizontal pointer travel sets the angle. With
  * IK on, a limb's end marker turns its hand or foot instead, and a planted
  * limb's knee or elbow swings its bend direction, so no pin is released. */
 twistSpatialJoint(x,y,{pixel=1}={}){
  const f=this.figure,o=this.object,i=this.selectedJoint,s=f?.segments[i];if(!o||!spatialBone(s)||!this._drag||s._stykRig.spatial.motion)return false;
  if(![x,y,pixel].every(Number.isFinite)||pixel<=0)return false;
  const gesture=this._spatialGesture('twist');gesture.start??={x,y};
  if(gesture.length<1e-6)return false;
  // 120 screen pixels turn a quarter.
  const angle=(x-gesture.start.x)/pixel/120*Math.PI/2*(o.image_text_flags?-1:1),d=gesture.direction,h=Math.sin(angle/2);
  const about=[d[0]*h,d[1]*h,d[2]*h,Math.cos(angle/2)],c=o._stykIK?.[s.segment_id];
  // The ankle or wrist marker is the foot or hand control: it turns that
  // part about the shin or forearm.
  const end=c?.enabled&&c.spatialTarget?f.segments.findIndex(n=>spatialBone(n)&&n._stykRig.spatial.parent===s.segment_id&&!n._stykPoseChoice&&!n._stykRig.spatial.motion):-1;
  if(end>=0){
   this.selectedJoint=end;
   try{const part=this._spatialGesture('twist');return this._setSpatialWorldOrientation(quatMultiply(about,part.world),part,'Turn '+(f.segments[end].name||'part'));}
   finally{this.selectedJoint=i;}
  }
  for(const[id,limb]of Object.entries(o._stykIK??{})){
   if(!limb.enabled||!limb.pinned||!limb.spatialTarget||limb.bendDirection!==0||!ikChain(f,Number(id),limb.chainLength,layout(this)).includes(i))continue;
   gesture.swivel??=limb.spatialTarget.swivel;
   this.selectedJoint=rigPlan(this).ids.get(Number(id));
   try{return this.setSpatialIKTarget({swivel:gesture.swivel+angle});}finally{this.selectedJoint=i;}
  }
  // The axis is the bone in world space.
  return this._setSpatialWorldOrientation(quatMultiply(about,gesture.world),gesture,'Twist articulated joint');
 },
 /** Pose drag on a spatial bone. It turns flat on screen like an ordinary
  * figure; `depth` (the held depth key) swings it toward or away from the
  * camera instead, `flip` choosing the side, and `stretch` also scales it. */
 poseSpatialJoint(x,y,{stretch=false,depth=false,flip=false,pixel=0,anchor=null}={}){
  const f=this.figure,o=this.object,i=this.selectedJoint,s=f?.segments[i];if(!o||!spatialBone(s))return false;
  if(![x,y].every(Number.isFinite))return false;
  if(s._stykRig.spatial.motion)return this._moveMechanicalJoint(x,y,anchor);
  // A planted knee/elbow steers its existing bend plane directly. Its end
  // target stays planted; no separate canvas pole is needed.
  if(!stretch)for(const[id,c]of Object.entries(o._stykIK??{})){
   if(!c.enabled||!c.pinned||!c.spatialTarget||c.bendDirection!==0)continue;
   const chain=ikChain(f,Number(id),c.chainLength,layout(this));if(chain.length!==2||chain[0]!==i)continue;
   try{this.selectedJoint=rigPlan(this).ids.get(Number(id));const pole=this.getSpatialIKPole();return pole?this.setSpatialIKPole(x,y,pole.knee[2]):false;}
   finally{this.selectedJoint=i;}
  }
  const kind=depth&&!stretch?'arc':'flat';
  if(this._drag){
   // Pressing or releasing the depth key mid-drag starts the other gesture
   // from the current pose and pointer, so the bone never jumps.
   const key=`${o.unique_id}:${i}`,kinds=this._drag.spatialKinds??=new Map(),last=kinds.get(key);
   if(last&&last!==kind){for(const k of ['arc','flat'])this._drag.spatialGesture?.delete(`${k}:${key}`);anchor={x,y};}
   kinds.set(key,kind);
  }
  return kind==='arc'?this._arcSpatialJoint(x,y,flip,pixel,anchor):this._flatSpatialJoint(x,y,stretch,anchor);
 },
 /** The bone turns about the view axis through its base, as on a flat figure,
  * keeping its lean toward or away from the camera and its twist. The angle
  * is measured from the grab point against the fixed gesture start, so the
  * grab never jumps and a closed drag returns exactly. */
 _flatSpatialJoint(x,y,stretch,anchor){
  const f=this.figure,o=this.object,i=this.selectedJoint,g=this.geometry.objects.get(this.selectedSlot),gesture=this._spatialGesture('flat');
  // The tip keeps its depth while turning, so the pointer is unprojected there.
  const depth=gesture.tip[2],p=unprojectSpatial({x,y},depth,o,g.root);
  gesture.grab??=anchor?unprojectSpatial(anchor,depth,o,g.root):{x:gesture.tip[0],y:gesture.tip[1]};
  gesture.nativeLength??=o.len_flag?o.lengths[i]:f.segments[i].length;
  const c=gesture.origin,gx=gesture.grab.x-c[0],gy=gesture.grab.y-c[1],px=p.x-c[0],py=p.y-c[1],from=Math.hypot(gx,gy),to=Math.hypot(px,py);
  if(from<1e-6||to<1e-6)return false;
  const world=quatMultiply(spatialQuaternion(Math.atan2(py,px)-Math.atan2(gy,gx),0,0),gesture.world);
  return this._setSpatialWorldOrientation(world,gesture,'Pose articulated joint',stretch?target=>{
   const lengths=target.len_flag?target.lengths.slice():f.segments.map(s=>s.length);lengths[i]=gesture.nativeLength*to/from;target.lengths=lengths;target.len_flag=1;
  }:undefined);
 },
 /** The bone keeps its length and swings in 3D so its end follows the pointer.
  * Inside its projected reach it leaves the view plane on the gesture's depth
  * side; `flip` mirrors that side. One swing from the fixed gesture start
  * keeps axial twist unchanged. */
 _arcSpatialJoint(x,y,flip,pixel=0,anchor=null){
  const o=this.object,g=this.geometry.objects.get(this.selectedSlot),gesture=this._spatialGesture('arc');
  if(gesture.length<1e-6)return false;
  const depth=gesture.origin[2]+gesture.direction[2]*gesture.length,p=unprojectSpatial({x,y},depth,o,g.root);
  // Motion is relative to the grab point, so grabbing beside a marker never
  // jumps. Short bones (chest, neck) use a longer virtual lever for control.
  // Without an anchor the bone end tracks the pointer directly.
  gesture.pointer??=anchor?unprojectSpatial(anchor,depth,o,g.root):{x:gesture.tip[0],y:gesture.tip[1]};
  const l=Math.max(gesture.length,pixel>0?70*pixel:0),d=gesture.direction;
  const dx=d[0]*l+p.x-gesture.pointer.x,dy=d[1]*l+p.y-gesture.pointer.y,reach=Math.hypot(dx,dy);
  let direction;
  if(reach>=l)direction=[dx/reach,dy/reach,0];
  else{const side=gesture.side*(flip?-1:1);direction=[dx/l,dy/l,side*Math.sqrt(l*l-reach*reach)/l];}
  if(reach<1e-9&&Math.abs(direction[2])<1e-9)return false;
  return this._setSpatialWorldOrientation(quatMultiply(betweenVectors(d,direction),gesture.world),gesture,'Pose articulated joint');
 },
 /** Travel of the selected slide (figure units from rest) or hinge (radians). */
 getSpatialMotion(index=this.selectedJoint){
  const f=this.figure,o=this.object,s=f?.segments[index],r=s?._stykRig?.spatial,m=r?.motion;if(!o||!m||!spatialBone(s))return null;
  const g=this.geometry.objects.get(this.selectedSlot),driver=m.driver?(g?.segments[rigPlan(this).ids.get(m.driver.joint)]?.spatialFrame?.motionValue??0)*m.driver.multiplier:0;
  const applied=spatialMotionValue(r,{length:o.len_flag?o.lengths[index]:s.length,bend:m.type==='hinge'?this.getSpatialPose(index).bend:0,driver});
  const min=m.min-driver,max=m.max-driver,value=applied-driver;
  return{type:m.type,min,max,value,applied,driver,fraction:max>min?(value-min)/(max-min):0};
 },
 /** Set a mechanical joint's travel, clamped to its range; `fraction` maps 0–1 onto it. */
 setSpatialMotion(value,{fraction=false}={}){
  const m=this.getSpatialMotion();if(!m)return false;
  if(!Number.isFinite(value))throw messageError(new Error(''), "errors.editorSpatial.chooseAFinitePosition", {});
  const target=Math.min(m.max,Math.max(m.min,fraction?m.min+value*(m.max-m.min):value)),i=this.selectedJoint,s=this.figure.segments[i],r=s._stykRig.spatial;
  const current=m.type==='slide'?(this.object.len_flag?this.object.lengths[i]:s.length):this.getSpatialPose().bend;
  const next=m.type==='slide'?Math.hypot(...r.tip.map((n,k)=>n-r.origin[k]))+target:target;
  if(Math.abs(next-current)<1e-12)return false;
  return this._objectEdit(m.type==='slide'?'Slide mechanical joint':'Turn hinge',o=>{
   if(m.type==='hinge')this._rotateJoint((next-current)*(o.image_text_flags?-1:1));
   else{o.lengths=o.len_flag?o.lengths.slice():this.figure.segments.map(s=>s.length);o.len_flag=1;o.lengths[i]=next;}
   delete o.runtime_segments;
  },{posed:true});
 },
 /** Pose drag on a slide or hinge: move to the point of its track nearest the
  * pointer, relative to where the handle was grabbed. The track is captured at
  * the gesture start, so a drag that returns to its start restores the pose. */
 _moveMechanicalJoint(x,y,anchor){
  const m=this.getSpatialMotion();if(!m||m.max<=m.min)return false;
  const f=this.figure,o=this.object,i=this.selectedJoint,key=`mechanism:${o.unique_id}:${i}`;
  let gesture=this._drag?.spatialGesture?.get(key);
  const g=this.geometry.objects.get(this.selectedSlot);
  if(!gesture){
   const frame=g.segments[i].spatialFrame,r=f.segments[i]._stykRig.spatial,tip=spatialPoint(frame,r.tip),pivot=spatialPoint(frame,r.origin);
   const axis=quatRotate(frame.q,m.type==='slide'?frame.axis:r.motion.axis??[0,0,1]);
   const world=p=>{const v=spatialWorldVector(p,f,o).map(n=>n*o.scale);return[v[0]+g.root.x,v[1]+g.root.y,v[2]];};
   const along=p=>{const d=p-m.value;if(m.type==='slide')return world(tip.map((n,k)=>n+axis[k]*d));
    const turned=quatRotate(spatialAxisQuaternion(axis,d),tip.map((n,k)=>n-pivot[k]));return world(turned.map((n,k)=>n+pivot[k]));};
   const start=along(m.value);
   gesture={along,start,grab:anchor?unprojectSpatial(anchor,start[2],o,g.root):{x:start[0],y:start[1]}};
   if(this._drag){this._drag.spatialGesture??=new Map();this._drag.spatialGesture.set(key,gesture);}
  }
  const pointer=unprojectSpatial({x,y},gesture.start[2],o,g.root),target=[gesture.start[0]+pointer.x-gesture.grab.x,gesture.start[1]+pointer.y-gesture.grab.y];
  const distance=p=>{const q=gesture.along(p);return(q[0]-target[0])**2+(q[1]-target[1])**2;};
  // Sample the track, then refine between the neighbours of the nearest sample.
  const steps=96,at=k=>m.min+(m.max-m.min)*k/steps;
  let best=0;for(let k=1;k<=steps;k++)if(distance(at(k))<distance(at(best)))best=k;
  let lo=at(Math.max(0,best-1)),hi=at(Math.min(steps,best+1));
  for(let n=0;n<40;n++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;if(distance(a)<=distance(b))hi=b;else lo=a;}
  // Past either end the pointer lands exactly on that stop.
  const value=[m.min,m.max].reduce((v,end)=>distance(end)<=distance(v)?end:v,(lo+hi)/2);
  return this.setSpatialMotion(value)||true;
 },
 _clearSpatialIKDepth(){
  const o=this.object,s=this.figure?.segments[this.selectedJoint];if(o&&s)this._drag?.spatialGesture?.delete(`depth:${o.unique_id}:${s.segment_id}`);
 },
 /** A depth push changes the limb, so the next plain target drag captures it
  * afresh, continuing from where the target is instead of jumping to the pointer. */
 _clearFlatSpatialIK(){
  const o=this.object,s=this.figure?.segments[this.selectedJoint];if(!o||!s||!this._drag)return;
  const key=`${o.unique_id}:${s.segment_id}`;
  this._drag.spatialGesture?.delete(`flat-ik:${key}`);this._drag.ikCapture?.delete(key);
  (this._drag.ikResume??=new Map()).set(key,null);
 },
 /** The pointer for a plain target drag, offset by where a depth push left the target. */
 _spatialIKPointer(x,y){
  const o=this.object,s=this.figure?.segments[this.selectedJoint],resume=this._drag?.ikResume,key=`${o?.unique_id}:${s?.segment_id}`;
  if(!resume?.has(key))return{x,y};
  let offset=resume.get(key);
  if(!offset){const p=this.geometry.objects.get(this.selectedSlot).joints.get(s.segment_id);offset={x:p.x-x,y:p.y-y};resume.set(key,offset);}
  return{x:x+offset.x,y:y+offset.y};
 },
 /** Plain drags of a spatial hand or foot solve the limb as on a flat figure:
  * each bone keeps its lean toward or away from the camera and the knee or
  * elbow stays on its side of the limb on screen, so it moves across the
  * screen instead of toward the camera. The result is only a pole for the
  * existing analytic solver; `spatialTarget` supplies the target's depth and
  * swivel. Null for other limbs and while the limb points into the screen. */
 _flatSpatialIKPole(handle,c,target,spatialTarget){
  if(!spatialTarget||c.bendDirection!==0)return null;
  const f=this.figure,o=this.object,g=this.geometry.objects.get(this.selectedSlot),chain=ikChain(f,handle,c.chainLength,layout(this));
  if(chain.length!==2||Math.abs(o.scale)<1e-9)return null;
  const key=`flat-ik:${o.unique_id}:${handle}`;let gesture=this._drag?.spatialGesture?.get(key);
  if(!gesture){
   const shapes=chain.map(i=>g.segments[i]);if(shapes.some(s=>!s.spatialFrame))return null;
   // The solver's unscaled world space, in which the base stays fixed during the drag.
   const point=(s,p)=>spatialWorldVector(spatialPoint(s.spatialFrame,p),f,o);
   const base=point(shapes[0],shapes[0].seg._stykRig.spatial.origin),knee=point(shapes[0],shapes[0].seg._stykRig.spatial.tip),end=point(shapes[1],shapes[1].seg._stykRig.spatial.tip);
   const a=Math.hypot(...knee.map((v,i)=>v-base[i])),reach=Math.hypot(end[0]-base[0],end[1]-base[1]);
   const b=Math.hypot(...end.map((v,i)=>v-knee[i])),offset=p=>(end[0]-base[0])*(p[1]-base[1])-(end[1]-base[1])*(p[0]-base[0]);
   // A straight limb bends to the side its stored bend direction shows on screen.
   const bent=offset(knee),natural=offset(spatialKnee(base,end,spatialTarget.pole,spatialTarget.swivel??0,a,b).knee);
   gesture={base,end,a,b,lean:knee[2]-base[2],side:Math.abs(bent)>1e-3*a*reach?Math.sign(bent):Math.abs(natural)>.05*a*reach?Math.sign(natural):0};
   if(this._drag){this._drag.spatialGesture??=new Map();this._drag.spatialGesture.set(key,gesture);}
  }
  const aim=[(target.x-g.root.x)/o.scale,(target.y-g.root.y)/o.scale,spatialTarget.depth/o.scale],b=gesture.base;
  // Failing that, toward the side the pointer first leaves it by.
  if(!gesture.side)gesture.side=Math.sign((gesture.end[0]-b[0])*(aim[1]-b[1])-(gesture.end[1]-b[1])*(aim[0]-b[0]))||1;
  const bend=flatSpatialBend(b,aim,gesture.lean,gesture.side,gesture.a,gesture.b);
  return bend&&spatialPoleFor(b,aim,bend,spatialTarget.swivel??0);
 },
 /** Shift-drag on a hand or foot target: vertical travel moves it toward the
  * camera (down) or away (up) while its screen position stays fixed. */
 poseSpatialIKDepth(x,y,{pixel=1}={}){
  const f=this.figure,o=this.object,s=f?.segments[this.selectedJoint],c=o?._stykIK?.[s?.segment_id];
  if(!c?.enabled||!c.spatialTarget||c.bendDirection!==0||!this._drag||![x,y,pixel].every(Number.isFinite)||pixel<=0)return false;
  const key=`depth:${o.unique_id}:${s.segment_id}`;this._drag.spatialGesture??=new Map();
  if(!this._drag.spatialGesture.has(key))this._drag.spatialGesture.set(key,{y,depth:c.spatialTarget.depth});
  const gesture=this._drag.spatialGesture.get(key);
  this.setSpatialIKTarget({depth:gesture.depth+(y-gesture.y)/pixel*Math.abs(o.scale)*.5});return true;
 },
};
export {spatialBone,spatialSkin};
