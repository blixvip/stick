import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {solveObjectIK} from '../src/ik.mjs';
import {rigIKContext} from '../src/ik-rig.mjs';
import {evaluateIKPose} from '../src/ik-evaluation.mjs';
const near=(a,b,t=.002)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function fixture(x=.5,y=.8){
 const q=construction();q.add(0,0,0,'Rotation');const driver=q.add(0,100*x,0,'Upper projection',{rig:{stretch:{restLength:100,min:0,max:1,width:'keep'}}}),second=q.add(0,100*y,0,'Lower projection',{rig:{stretch:{restLength:100,min:0,max:1,width:'keep'}}});
 const anchor=q.add(0,40,-Math.PI/2,'Body'),base=q.add(0,0,0,'Attachment',{rig:{weighted:{origin:0,anchors:[{joint:anchor,weight:.8}]}}});
 const follow=driver=>({orientation:'world',follow:{driver,mode:'stretch',influence:1},response:{mode:'stretch',multiplier:2}});
 const a=q.add(base,100,.6,'Upper bone',{control:true,rig:follow(driver)}),b=q.add(a,85,-.7,'Lower bone',{control:true,rig:follow(second)});
 const fig={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},doc={...emptyDocument(),figure_types:[fig],keyframes:[createFrame([createObject(fig,1,250,200)])]};
 return {doc,a,b,driver,second,base};
}
test('native IK reaches projected two-bone targets through different, negative and edge-on axes',()=>{
 for(const [x,y]of [[1,.8],[.7,.9],[.2,.3],[.5,.9],[.5,.5]]){
  const {doc,a,b}=fixture(x,y),fig=doc.figure_types[0],object=doc.keyframes[0].objects[0];
  for(const [aa,bb]of [[.9,-.4],[.3,-1],[1.1,-.8]]){
   const posed=structuredClone(doc);posed.keyframes[0].objects[0].angles[a-1]=aa;posed.keyframes[0].objects[0].angles[b-1]=bb;
   const target=buildGeometry(posed,posed.keyframes[0]).objects.get(0).joints.get(b);
   const controller={enabled:true,pinned:true,chainLength:2,bendDirection:0,target:{...target,rotation:0},followers:{}};
   const result=solveObjectIK(fig,object,{x:250,y:200},undefined,{[b]:controller});
   const rendered=structuredClone(doc);rendered.keyframes[0].objects[0].angles=result.angles;
   const p=buildGeometry(rendered,rendered.keyframes[0]).objects.get(0).joints.get(b);near(p.x,target.x);near(p.y,target.y);
   assert.ok(result.angles.every(Number.isFinite));assert.deepEqual(object.angles,doc.keyframes[0].objects[0].angles);
  }
 }
});
test('projected IK uses ordinary controls, stops at a derived anchor, and invalidates cached rig settings',()=>{
 const {doc,a,b,driver}=fixture(.7,.8),e=new Editor({demo:false});e.load(doc);e.select(1,b-1);
 assert.equal(e.getIKSettings().maxLength,2);e.setNodeIK({enabled:true});const before=e.serialize();
 const p=e.geometry.objects.get(0).joints.get(b);e.poseIKTarget(p.x-10,p.y+8);const target=e.geometry.objects.get(0).joints.get(b);near(target.x,p.x-10);near(target.y,p.y+8);
 e.undo();assert.deepEqual(e.serialize(),before);
 const knee=e.geometry.objects.get(0).joints.get(a);
 e.select(1,driver-1);e.setRigBehavior({stretch:{max:.1}});const after=e.geometry.objects.get(0).joints.get(b);assert.ok([after.x,after.y].every(Number.isFinite));
 near(after.x,p.x);near(after.y,p.y);assert.notDeepEqual(e.geometry.objects.get(0).joints.get(a),knee);
});
test('joined projected rigs preserve source scale, local constraints and pinned targets',()=>{
 for(const scale of [.4,1,2]){
  const {doc,b}=fixture(.7,.8),q=construction();q.add(0,40,0,'Body anchor',{control:true});
  const parent={figure_type_id:2,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};doc.figure_types.push(parent);
  const child=doc.keyframes[0].objects[0];child.scale=scale;child.join={target_object_slot:1,target_unique_id:2,target_handle_id:1};
  doc.keyframes[0].objects.push(createObject(parent,2,180,220));
  doc.keyframes[0]=createFrame(doc.keyframes[0].objects);
  const e=new Editor({demo:false});e.load(doc);e.select(1,b-1);const p=e.geometry.objects.get(0).joints.get(b);
  e.setNodeIK({enabled:true,chainLength:2});let at=e.geometry.objects.get(0).joints.get(b);near(at.x,p.x);near(at.y,p.y);
  e.poseIKTarget(p.x-5,p.y+8);at=e.geometry.objects.get(0).joints.get(b);near(at.x,p.x-5);near(at.y,p.y+8);
  e.select(2,-1);e.moveSelection(3,-2);at=e.geometry.objects.get(0).joints.get(b);near(at.x,p.x-5);near(at.y,p.y+8);
 }
});
test('projection iterations exclude dense surface attachments and cached solutions see rig mutations',()=>{
 const {doc,b,driver}=fixture(.7,.8),fig=doc.figure_types[0],object=doc.keyframes[0].objects[0],template=fig.segments[4];
 for(let n=0;n<3000;n++){const s={...template,segment_id:fig.segments.length+1,parent_id:b,_stykRig:{weighted:{origin:0,anchors:[{joint:b,weight:1}]}}};fig.segments.push(s);object.angles.push(0);}
 const context=rigIKContext(fig,object,{x:250,y:200},[b],object.angles.slice(),()=>undefined);assert.ok(context.dependencyCount<20);
 const target=buildGeometry(doc,doc.keyframes[0]).objects.get(0).joints.get(b);object._stykIK={[b]:{enabled:true,pinned:true,chainLength:2,bendDirection:0,target:{...target,rotation:0},followers:{}}};
 const first=evaluateIKPose(doc,'dense',fig,object,{x:250,y:200});assert.equal(evaluateIKPose(doc,'dense',fig,object,{x:250,y:200}),first);
 fig.segments[driver-1]._stykRig.stretch.max=.1;
 assert.notEqual(evaluateIKPose(doc,'dense',fig,object,{x:250,y:200}),first);
});
