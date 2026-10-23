import test from 'node:test';
import {execFileSync} from 'node:child_process';

test('a published incremental scene releases superseded geometry, including its lazy view', () => {
  execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {emptyDocument,createObject} from './src/demo.mjs';
    import {buildGeometry} from './src/pivot/geometry.mjs';
    const report=emptyDocument(),frame=report.keyframes[0];
    frame.objects.push(createObject(report.figure_types[0],1,100,100));
    frame.object_draw_order=[0];
    function prepare(){
      let current=buildGeometry(report,frame);
      const oldScene=new WeakRef(current),oldObject=new WeakRef(current.objects.get(0));
      for(let i=0;i<12;i++){
        frame.objects[0].angles[0]+=.01;
        current=buildGeometry(report,frame,{previous:current,dirtySlots:new Set([0])});
      }
      return {current,oldScene,oldObject};
    }
    const {current,oldScene,oldObject}=prepare();
    for(let i=0;i<5;i++){await new Promise(setImmediate);global.gc();}
    assert.ok(oldScene.deref()===undefined,'lazy getter retains previous scene');
    assert.ok(oldObject.deref()===undefined,'previous figure geometry is retained');
    assert.ok(current.drawables.length>0,'latest lazy drawables still work');
  `],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
});

test('live spatial skin reuse releases superseded geometry', () => {
 execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {construction} from './src/rig-examples-3d.mjs';
  import {emptyDocument,createObject,createFrame} from './src/demo.mjs';
  import {buildGeometry} from './src/pivot/geometry.mjs';
  const q=construction();q.add(0,0,0,'Figure');const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Pitch');
  q.add(0,40,Math.PI/2,'Bone',{control:true,rig:{spatial:{parent:0,origin:[0,0,0],tip:[0,40,0],turn,pitch}}});
  const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},object=createObject(figure,1,100,100),frame=createFrame([object]),doc={...emptyDocument(),figure_types:[figure],keyframes:[frame]};
  function prepare(){let current=buildGeometry(doc,frame);const oldScene=new WeakRef(current),oldObject=new WeakRef(current.objects.get(0));
   for(let i=0;i<12;i++){object.angles[turn-1]+=.01;current=buildGeometry(doc,frame,{previous:current,dirtySlots:new Set([0]),poseSlots:new Set([0])});}
   return {current,oldScene,oldObject};
  }
  const {current,oldScene,oldObject}=prepare();
  for(let i=0;i<5;i++){await new Promise(setImmediate);global.gc();}
  assert.equal(oldScene.deref(),undefined);assert.equal(oldObject.deref(),undefined);assert.equal(current.objects.get(0).segments.length,4);assert.ok(Array.isArray(current.drawables));
 `],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
});
