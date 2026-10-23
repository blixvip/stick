import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {OnionController} from '../src/onion-controller.mjs';
import {OnionSkinCache} from '../src/onion-skin.mjs';

function fixture({legacy=false}={}){
  const report=emptyDocument();report.keyframes=Array.from({length:12},(_,i)=>createFrame([createObject(report.figure_types[0],1,100+i*10,250)],10));
  const editor=new Editor({demo:false}).load(report);editor.seek(50);
  let settings=normalizeEditorSettings({onionBefore:2,onionAfter:2,...(!legacy?{onionRangeBefore:20,onionRangeAfter:20}:{})});const commits=[],errors=[];
  const controller=new OnionController({editor,getSettings:()=>settings,getEnabled:()=>true,onCommit:patch=>{commits.push(patch);settings=normalizeEditorSettings({...settings,...patch});},onError:error=>errors.push(error)});
  return {editor,controller,commits,errors,getSettings:()=>settings};
}

test('legacy values adopt paired fixed distances without depending on key spacing',()=>{
  const {controller,commits,getSettings}=fixture({legacy:true}),owner={};
  assert.equal(controller.snapshot().before.span,2);controller.begin(owner);
  controller.preview(owner,{onionRangeBefore:3});
  assert.equal(controller.snapshot().before.span,3);assert.equal(getSettings().onionRangeBefore,null);assert.equal(commits.length,0);
  controller.commit(owner);assert.deepEqual(commits,[{onionRangeBefore:3,onionRangeAfter:2}]);
  controller.change(owner,{onionMode:'frames'});assert.equal(controller.snapshot().before.span,3);assert.equal(controller.snapshot().before.count,3);
  controller.destroy();
});

test('superseded views cannot commit or cancel a newer gesture',()=>{
  const {controller,commits}=fixture(),a={},b={};controller.begin(a);controller.preview(a,{onionRangeBefore:40});controller.begin(b);
  assert.equal(controller.snapshot().before.span,20);controller.preview(b,{onionRangeBefore:25});controller.commit(a);controller.cancel(a);
  assert.equal(controller.snapshot().before.span,25);assert.equal(commits.length,0);controller.commit(b);assert.equal(commits.length,1);controller.destroy();
});

test('seek, document edits, disposal and failed commits leave no preview behind',()=>{
  const {controller,editor,commits,errors}=fixture(),owner={};
  controller.begin(owner);controller.preview(owner,{onionRangeBefore:40});editor.seek(60);controller.commit(owner);assert.equal(commits.length,0);assert.equal(controller.session,null);
  controller.begin(owner);controller.preview(owner,{onionRangeBefore:40});editor.setFrameDuration(4);controller.commit(owner);assert.equal(commits.length,0);
  controller.onCommit=()=>{throw new Error('Failed setting');};controller.begin(owner);controller.preview(owner,{onionRangeBefore:30});controller.commit(owner);assert.equal(errors.length,1);assert.equal(controller.session,null);
  controller.begin(owner);controller.preview(owner,{onionRangeBefore:30});controller.destroy();assert.equal(controller.session,null);assert.equal(controller.listeners.size,0);
});

test('sampling never rounds the temporal boundary out to a distant key',()=>{
  const {controller,editor}=fixture(),owner={},cache=new OnionSkinCache();
  controller.change(owner,{onionRangeBefore:9,onionRangeAfter:9});assert.equal(cache.get(editor,controller.settings).length,0);
  controller.change(owner,{onionRangeBefore:10});assert.equal(cache.get(editor,controller.settings).length,1);
  controller.change(owner,{onionRangeBefore:11});assert.equal(cache.get(editor,controller.settings).length,1);assert.equal(controller.snapshot().before.endpoint,39);
  controller.change(owner,{onionMode:'frames',onionStep:3,onionRangeBefore:8,onionRangeAfter:0});assert.equal(cache.get(editor,controller.settings).length,2);controller.destroy();
});

test('output-frame ranges in Simple Add mode sample stored poses and exclude an empty placeholder',()=>{
  const {controller,editor}=fixture(),owner={},cache=new OnionSkinCache();
  editor.enableFrameDrafts();editor.beginFrameDraft({mode:'add',index:11});
  controller.change(owner,{onionRangeBefore:20,onionRangeAfter:20});
  const snapshot=controller.snapshot(),frames=cache.get(editor,controller.settings);
  assert.equal(snapshot.after.span,20);assert.equal(snapshot.after.count,0);assert.equal(frames.length,snapshot.before.count);assert.ok(frames.length>0);
  const stored=frames.map(entry=>entry.frame.objects[0].root_x);
  editor.select(1);editor.moveSelection(50,0);assert.deepEqual(cache.get(editor,controller.settings).map(entry=>entry.frame.objects[0].root_x),stored);
  editor.load(emptyDocument());editor.enableFrameDrafts({mode:'add',empty:true});assert.equal(cache.get(editor,controller.settings).length,0);
  controller.destroy();
});


test('fixed spans and endpoints follow every seek, while only available samples shrink',()=>{
  const {controller,editor,getSettings}=fixture(),owner={},cache=new OnionSkinCache();
  controller.change(owner,{onionRangeBefore:20,onionRangeAfter:30,onionMode:'frames'});
  const stored=getSettings();
  for(const tick of [50,51,59,0,119]){
    editor.seek(tick);const range=controller.snapshot(),actualTick=editor.tick;
    assert.equal(range.before.span,20);assert.equal(range.after.span,30);
    assert.equal(range.before.endpoint,actualTick-20);assert.equal(range.after.endpoint,actualTick+30);
    assert.equal(range.before.count,Math.min(20,actualTick));assert.equal(range.after.count,Math.min(30,editor.totalTicks-1-actualTick));
    assert.equal(cache.get(editor,controller.settings).length,range.before.count+range.after.count);
    assert.equal(getSettings(),stored,'seeking does not write preferences');
  }
  const pending=controller.snapshot(60);assert.equal(pending.before.endpoint,40);assert.equal(pending.after.endpoint,90);
  editor.seek(0);controller.change(owner,{onionRangeBefore:300});assert.equal(controller.snapshot().before.span,300);
  assert.equal(controller.snapshot().before.count,0);editor.seek(50);assert.equal(controller.snapshot().before.span,300);
  controller.destroy();
});

test('legacy adoption is stable through seeks and preserves the untouched side on edge edits',()=>{
  const {controller,editor,commits}=fixture({legacy:true});
  assert.equal(controller.snapshot().before.span,2);assert.equal(controller.snapshot().after.span,2);
  editor.seek(0);assert.equal(controller.snapshot().before.span,2);assert.equal(controller.snapshot().after.span,2);
  controller.change({}, {onionRangeAfter:30});assert.deepEqual(commits,[{onionRangeBefore:2,onionRangeAfter:30}]);
  editor.seek(119);assert.equal(controller.snapshot().after.span,30);assert.equal(controller.snapshot().after.count,0);
  controller.destroy();
});
