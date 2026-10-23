import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotPoseObject} from '../src/pose-snapshot.mjs';
import {cloneTopologySnapshot,topologyHistoryBytes} from '../src/topology-history.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';

test('pose snapshots own numeric storage and metadata without retaining render caches', () => {
  const pose = {unique_id:1, angles:[0,-0,Math.PI], lengths:[1,2,3], bends:[],
    _stykStyle:{segments:{1:{color:[1,2,3]}}}, runtime_segments:[{uncloneable:()=>{}}], _movieclipSample:{uncloneable:()=>{}}};
  const snapshot = snapshotPoseObject(pose);
  assert.equal('runtime_segments' in snapshot,false);assert.equal('_movieclipSample' in snapshot,false);
  for (const field of ['angles','lengths','bends']) {assert.deepEqual(snapshot[field],pose[field]);assert.notEqual(snapshot[field],pose[field]);}
  pose.angles[0]=15;pose._stykStyle.segments[1].color[0]=255;
  assert.equal(snapshot.angles[0],0);assert.equal(snapshot._stykStyle.segments[1].color[0],1);
});

test('topology history conservatively bounds numeric JSON without reading vector elements', () => {
  const values = [Number.MAX_VALUE,-Number.MIN_VALUE,Math.PI,1e-20,0];
  const state = {figure:{segments:[]},frames:[{index:0,objects:[{unique_id:1,angles:values,lengths:[],bends:[]}]}]};
  const command = {kind:'topology',before:state,after:cloneTopologySnapshot(state),sourceBytes:123};
  const bytes = topologyHistoryBytes(command);
  assert.ok(bytes>=JSON.stringify(command).length*2+123);
  for(const side of ['before','after'])for(const key of ['angles','lengths','bends']) {
    const array = command[side].frames[0].objects[0][key];
    for(let i=0;i<array.length;i++)Object.defineProperty(array,i,{get(){throw new Error('History sizing walked a pose vector');}});
  }
  assert.equal(topologyHistoryBytes(command),bytes);
});

test('native history retains independent imported runtime lengths and bends', () => {
  const object={unique_id:1,angles:[0],runtime_segments:[{length:47,bend_rad:.4}],lengths:[],bends:[]};
  const state={figure:{segments:[]},frames:[{index:0,objects:[object]}]},copy=cloneTopologySnapshot(state);
  assert.deepEqual(copy,state);assert.deepEqual(Object.keys(copy.frames[0].objects[0]),Object.keys(object));
  object.runtime_segments[0].length=99;object.angles[0]=1;
  assert.equal(copy.frames[0].objects[0].runtime_segments[0].length,47);
  assert.equal(copy.frames[0].objects[0].angles[0],0);
});

test('dense shared definition history remains exact through independent edits and repeated replay', () => {
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=Array.from({length:300},(_,i)=>({...base,segment_id:i+1,parent_id:i,length:2,angle_rad:i/200,aux_code:1}));
  figure.segment_count=figure.segments.length;
  report.keyframes=Array.from({length:8},(_,frame)=>createFrame(Array.from({length:12},(_,i)=>createObject(figure,i+1,50+i*8,50+frame))));
  const editor=new Editor({demo:false}).load(report);editor.select(1,5);
  const before=editor.serialize(),end=editor.geometry.objects.get(0).segments[5].end;
  editor.editRigJoint(end.x+1,end.y+2);
  const after=editor.serialize(),command=editor._undo.at(-1),history=structuredClone(command);
  assert.equal(command.kind,'topology');
  editor.select(1);editor.beginTranslationDrag();editor.moveSelection(13,9);editor.commitDrag();editor.undo();
  assert.deepEqual(editor.serialize(),after);assert.deepEqual(command,history);
  for(let i=0;i<3;i++){editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);assert.deepEqual(command,history);}
});
