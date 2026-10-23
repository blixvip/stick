import test from 'node:test';
import assert from 'node:assert/strict';
import {poseObjectSignature} from '../src/pose-snapshot.mjs';
import {normalizeFrame} from '../src/pivot/structure.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';

test('saved pose comparison follows attachment identities through reordered slots',()=>{
  const figure=emptyDocument().figure_types[0];
  const before=createFrame([createObject(figure,7,100,100,{join:{target_object_slot:1,target_handle_id:1}}),createObject(figure,2,200,100)]);
  const after=structuredClone(before);normalizeFrame(after);
  for(const object of before.objects)assert.equal(poseObjectSignature(object,before),poseObjectSignature(after.objects.find(o=>o.unique_id===object.unique_id),after));
  const child=after.objects.find(o=>o.unique_id===7);child.join.target_handle_id=2;
  assert.notEqual(poseObjectSignature(before.objects[0],before),poseObjectSignature(child,after));
});
test('saved pose comparison never reads runtime geometry or movieclip clocks',()=>{
  const figure=emptyDocument().figure_types[0],frame=createFrame([createObject(figure,1,0,0)]),object=frame.objects[0];
  const before=poseObjectSignature(object,frame);
  for(const field of ['runtime_segments','_movieclipSample'])Object.defineProperty(object,field,{enumerable:true,get(){throw new Error('Runtime cache was read');}});
  assert.equal(poseObjectSignature(object,frame),before);object.futurePoseProperty=12;
  assert.notEqual(poseObjectSignature(object,frame),before);
});
