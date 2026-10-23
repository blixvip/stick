import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {buildGeometry,buildGeometryAsync} from '../src/pivot/geometry.mjs';
import {Editor} from '../src/editor.mjs';

function fixture(){
 const q=construction();q.add(0,0,0,'Figure');
 const basis=[0,q.add(0,30,0,'X'),q.add(0,30,Math.PI/2,'Y')];
 const bone=(x)=>{const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Pitch'),id=q.add(0,90,Math.PI/2,'Bone',{control:true,rig:{spatial:{parent:0,origin:[x,0,0],tip:[x,90,0],turn,pitch}}});return{id,turn,pitch};};
 const left=bone(-30),right=bone(30),triangles=[];
 for(const b of [left,right]){const x=b===left?-30:30,ids=[[x-12,10,0],[x+12,10,0],[x,80,6]].map(point=>q.add(0,0,0,'Surface',{rig:{spatial:{point,bindings:[{joint:b.id,weight:1}]}}}));
  triangles.push(ids);q.polyfills.push({segment_ids:ids,color_rgb:[10,40,90],color_alpha:1,z_order:0,_stykSurface:{basis,side:'front',depthTest:true,depth:ids}});
 }
 const figure={figure_type_id:1,segments:q.segments,polyfills:q.polyfills,image_assets:[],text_assets:[]},object=createObject(figure,1,200,200),frame=createFrame([object]),doc={...emptyDocument(),figure_types:[figure],keyframes:[frame]};
 return{doc,frame,figure,object,left,right,triangles,basis};
}
const incremental=previous=>({previous,dirtySlots:new Set([0]),poseSlots:new Set([0])});
const exact=(doc,frame,actual)=>assert.deepEqual(actual.objects.get(0),buildGeometry(doc,frame).objects.get(0));

test('live spatial edits reuse untouched branches and surfaces with exact fresh geometry',()=>{
 const{doc,frame,object,left,right,triangles}=fixture();let prior=buildGeometry(doc,frame);
 for(let i=1;i<=45;i++){
  object.angles[left.turn-1]=Math.sin(i/7);object.angles[left.pitch-1]=Math.cos(i/9)*.4;
  const next=buildGeometry(doc,frame,incremental(prior)),a=prior.objects.get(0),b=next.objects.get(0);
  assert.equal(b.segments[right.id-1],a.segments[right.id-1]);
  assert.equal(b.joints.get(triangles[1][0]),a.joints.get(triangles[1][0]));
  assert.equal(b.polys[1],a.polys[1]);assert.notEqual(b.polys[0],a.polys[0]);exact(doc,frame,next);prior=next;
 }
});

test('global transforms, appearance, length changes and surface bases invalidate the affected pose',()=>{
 const{doc,frame,object,left,basis}=fixture();let prior=buildGeometry(doc,frame);
 for(const change of [()=>{object.len_flag=1;object.lengths[left.id-1]=120;},()=>{object.angles[basis[1]-1]=.4;},()=>{object.root_x+=8;},()=>{object.scale=-1.2;},()=>{object.image_text_flags=1;},()=>{object.color_override_raw=0xffbb6622;},()=>{object.field28=70;},()=>{object.angles[0]+=.25;}]){
  change();const next=buildGeometry(doc,frame,incremental(prior));exact(doc,frame,next);prior=next;
 }
});

test('definition edits and replacement objects never inherit a live pose cache',()=>{
 const{doc,frame,figure,object,left}=fixture();let prior=buildGeometry(doc,frame);
 object.angles[left.turn-1]=.2;prior=buildGeometry(doc,frame,incremental(prior));
 figure.polyfills[1].color_rgb=[240,30,20];figure.segments.at(-1).thickness=4;
 let next=buildGeometry(doc,frame,{previous:prior,dirtySlots:new Set([0])});exact(doc,frame,next);assert.notEqual(next.objects.get(0).polys[1],prior.objects.get(0).polys[1]);
 prior=next;frame.objects[0]=structuredClone(object);next=buildGeometry(doc,frame,incremental(prior));exact(doc,frame,next);assert.notEqual(next.objects.get(0).polys[1],prior.objects.get(0).polys[1]);
});

test('depth-only surface dependencies invalidate otherwise unchanged polygons',()=>{
 const{doc,frame,figure,object,left,triangles}=fixture();
 figure.polyfills[1]._stykSurface.depth=triangles[0];
 const previous=buildGeometry(doc,frame);object.angles[left.pitch-1]=.5;
 const next=buildGeometry(doc,frame,incremental(previous));
 assert.notEqual(next.objects.get(0).polys[1],previous.objects.get(0).polys[1]);exact(doc,frame,next);
});

test('cooperative pose reuse leaves published geometry immutable and supports cancellation',async()=>{
 const{doc,frame,object,left}=fixture(),previous=buildGeometry(doc,frame),snapshot=structuredClone(previous.objects.get(0).segments.map(s=>s.end));object.angles[left.pitch-1]=.7;
 const next=await buildGeometryAsync(doc,frame,incremental(previous),{sliceMs:0,yieldControl:async()=>{}});exact(doc,frame,next);
 assert.deepEqual(previous.objects.get(0).segments.map(s=>s.end),snapshot);
 const controller=new AbortController();await assert.rejects(buildGeometryAsync(doc,frame,incremental(previous),{sliceMs:0,signal:controller.signal,yieldControl:async()=>controller.abort()}),{name:'AbortError'});
});

test('editor gestures keep native undo, cancellation and rest-length posing with reused skin',()=>{
 const{doc,left}=fixture(),e=new Editor({demo:false});e.load(doc);e.select(1,left.id-1);const original=e.serialize();
 e.beginDrag('Turn');for(const turn of [.2,.7,-.3]){e.setSpatialPose({turn});exact(e.report,e.evaluatedFrame,e.geometry);}e.cancelDrag();assert.deepEqual(e.serialize(),original);
 e.beginDrag('Turn');for(const turn of [.4,.6])e.setSpatialPose({turn});e.commitDrag();e.undo();assert.deepEqual(e.serialize(),original);
});
