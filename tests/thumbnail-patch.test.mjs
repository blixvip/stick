import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createDemo} from '../src/demo.mjs';
import {ThumbnailRenderer} from '../src/thumbnail-renderer.mjs';
import {applyDocumentChunk} from '../src/document-transport.mjs';
import {applyPlaybackPatch,playbackProperties} from '../src/playback-patch.mjs';

function fixture(t) {
  const editor=new Editor({demo:false}).load(createDemo());
  const renderer=new ThumbnailRenderer(editor),wire={report:null,incoming:null,patches:[],afterCommit:null,afterChunk:null};
  renderer._request=async(operation,message)=>{
    if(operation==='snapshot-chunk'){
      wire.incoming=applyDocumentChunk(wire.incoming,structuredClone(message.chunk));
      wire.mode=message.mode;wire.afterChunk?.(message);
    } else if(operation==='snapshot-complete'){
      if(wire.mode==='document')wire.report=wire.incoming;
      else {wire.patches.push(structuredClone(wire.incoming));applyPlaybackPatch(wire.report,wire.incoming);}
      wire.incoming=null;
      await wire.afterCommit?.();
    }
  };
  const sync=signal=>renderer._snapshot(renderer.version,signal??new AbortController().signal);
  t.after(()=>renderer.destroy());
  return {editor,renderer,wire,sync};
}

test('thumbnail patches retain historical poses and transfer additions, forced edits, undo and deletion',async t=>{
  const {editor:e,renderer:r,wire:w,sync}=fixture(t);
  const old=e.captureFrameSource(e.report.keyframes[0]);await sync();
  const retained=w.report._styk.frameSources[old],fullBytes=r.stats.lastSnapshotBytes;
  const added=e.captureFrameSource(e.report.keyframes[1]);r.invalidate({kind:'edit',frameIndices:[],sourceIds:[added]});await sync();
  assert.deepEqual(w.patches.at(-1).sources.map(s=>s.id),[added]);
  assert.equal(w.report._styk.frameSources[old],retained);
  assert.equal(Object.hasOwn(w.patches.at(-1).properties._styk,'frameSources'),false);
  assert.ok(r.stats.lastSnapshotBytes<fullBytes);
  e.report._styk.frameSources[added].objects[0].root_x=1234;
  r.invalidate({kind:'edit',frameIndices:[],sourceIds:[added]});await sync();
  assert.equal(w.report._styk.frameSources[added].objects[0].root_x,1234);
  delete e.report._styk.frameSources[added];r.invalidate({kind:'history',layerSheet:true,frameIndices:[],sourceIds:[added]});await sync();
  assert.deepEqual(w.patches.at(-1).sources,[{id:added,frame:null}]);
  assert.equal(r.mirrorSources.has(added),false);assert.equal(w.report._styk.frameSources[old],retained);
  delete e.report._styk.frameSources;r.invalidate({kind:'edit',frameIndices:[]});await sync();
  assert.equal(w.report._styk.frameSources,undefined);assert.equal(r.mirrorSources.size,0);
});

test('thumbnail patches repair an already committed source addition undone before its ACK',async t=>{
  const {editor:e,renderer:r,wire:w,sync}=fixture(t);await sync();
  const added=e.captureFrameSource(e.report.keyframes[0]);r.invalidate({kind:'edit',frameIndices:[],sourceIds:[added]});
  w.afterCommit=()=>{delete e.report._styk.frameSources[added];r.invalidate({kind:'edit',frameIndices:[]});w.afterCommit=null;};
  await assert.rejects(sync(),{name:'AbortError'});
  assert.ok(w.report._styk.frameSources[added]);
  await sync();assert.equal(w.report._styk.frameSources[added],undefined);
  assert.deepEqual(w.patches.at(-1).sources,[{id:added,frame:null}]);assert.equal(r.changedSources.size,0);
});

test('thumbnail source changes interrupted between chunks resume or are replaced without partial publication',async t=>{
  const {editor:e,renderer:r,wire:w,sync}=fixture(t);await sync();
  const id=e.captureFrameSource(e.report.keyframes[0]);e.report._styk.frameSources[id].opaque='abc'.repeat(100000);
  r.invalidate({kind:'edit',frameIndices:[],sourceIds:[id]});
  const abort=new AbortController();let chunks=0;
  w.afterChunk=()=>{if(++chunks===2)abort.abort();};
  await assert.rejects(sync(abort.signal),{name:'AbortError'});assert.equal(w.report._styk.frameSources?.[id],undefined);
  w.afterChunk=null;await sync();assert.equal(w.report._styk.frameSources[id].opaque.length,300000);
  assert.ok(r.stats.maxChunkBytes<=65536);
});

test('document replacement during patch ACK discards the old mirror and its source references',async t=>{
  const {editor:e,renderer:r,wire:w,sync}=fixture(t);e.captureFrameSource(e.report.keyframes[0]);await sync();
  r.invalidate({kind:'edit',frameIndices:[0]});
  w.afterCommit=()=>{e.load(createDemo());w.afterCommit=null;};
  await assert.rejects(sync(),{name:'AbortError'});assert.equal(r.mirrorSources.size,0);
  await sync();assert.equal(w.mode,'document');assert.deepEqual(w.report,e.report);
});

test('thumbnail patches preserve changed definitions/backgrounds and remove obsolete metadata',async t=>{
  const {editor:e,renderer:r,wire:w,sync}=fixture(t);e.report.obsolete=true;await sync();
  delete e.report.obsolete;e.report.figure_types[0].segments[0].color_rgb=[255,0,0];e.report.backgrounds=[];
  r.invalidate({kind:'edit',definition:true,frameIndices:[]});await sync();
  assert.equal(r.stats.snapshots,1);assert.deepEqual(w.report,e.report);assert.equal(w.report.obsolete,undefined);
});

test('media and source patch validation precedes every worker mutation',()=>{
  const report=createDemo(),before=structuredClone(report);
  const patch={properties:{...playbackProperties(report),fps:99},frames:[],sources:[],hasFrameSources:false,figure_types:{}};
  assert.throws(()=>applyPlaybackPatch(report,patch),/media/);assert.deepEqual(report,before);
  patch.figure_types=[];patch.sources=[{id:'bad',frame:{objects:[]}}];
  assert.throws(()=>applyPlaybackPatch(report,patch),/sources|source/);assert.deepEqual(report,before);
});

test('a renderer opened during an Add draft invalidates the stored preview when switching to Update',()=>{
  const editor=new Editor({demo:false}).load(createDemo());
  editor.report._styk.simpleFrameDraft={mode:'add',index:0,baseline:structuredClone(editor.report.keyframes[0])};
  const renderer=new ThumbnailRenderer(editor),version=renderer.version;
  try {
    editor.report._styk.simpleFrameDraft={...editor.report._styk.simpleFrameDraft,mode:'update'};
    editor._emit('frame-draft',{frameIndices:[0]});
    assert.equal(renderer.version,version+1);
    assert.ok(renderer.changedFrames.has(0));
  } finally {renderer.destroy();}
});

test('one-pose thumbnail transfer stays bounded as the retained pose library grows',async t=>{
  const sizes=[];
  for(const count of [10,100]){
    const {editor:e,renderer:r,sync}=fixture(t);
    for(let i=0;i<count;i++)e.captureFrameSource(e.report.keyframes[i%e.report.keyframes.length]);
    await sync();
    const id=e.captureFrameSource(e.report.keyframes[0]);
    r.invalidate({kind:'edit',frameIndices:[],sourceIds:[id]});await sync();
    assert.equal(r.stats.sourceUpserts,1);assert.equal(r.stats.snapshots,1);
    assert.ok(r.stats.maxChunkBytes<=65536);sizes.push(r.stats.lastSnapshotBytes);
  }
  // IDs and metadata counters may gain a digit; the historical poses must not travel.
  assert.ok(sizes[1]<=sizes[0]+100,`Pose patch grew with history: ${sizes}`);
});
