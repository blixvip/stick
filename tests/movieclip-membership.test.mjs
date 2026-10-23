import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject,defaultFigure} from '../src/demo.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {presencePlayback,continuations,usesPresence} from '../src/movieclip-presence.mjs';
import {createSheetMembershipSampler} from '../src/movieclip-membership.mjs';
import {evaluatedFrame,timeline,nativeTimeline,movieclipPresenceIndex,invalidateEvaluationCaches} from '../src/pivot/geometry.mjs';

function fixture() {
  const child=defaultFigure(),document=emptyDocument();
  document.keyframes=Array.from({length:8},(_,i)=>createFrame([createObject(child,1,200+i*9,250)]));
  const clip=movieclipFigure(2,'Clip',document,{duration:8,pivot:{x:200,y:250}});
  const object=()=>createObject(clip,7,300,300,{_stykMovieclip:presencePlayback()});
  return new Editor({demo:false,layerTimeline:true}).load({...emptyDocument(),figure_types:[child,clip],keyframes:[createFrame([object()],11),createFrame([object()])]});
}
function compare(editor) {
  const report=editor.report,rows=timeline(report),sample=createSheetMembershipSampler(report,nativeTimeline(report));
  const members=frame=>[...new Map([...continuations(frame).map(step=>[step.uid,step.playback]),...frame.objects.filter(usesPresence).map(object=>[object.unique_id,object._stykMovieclip])])].sort((a,b)=>a[0]-b[0]);
  for(let tick=0;tick<editor.totalTicks;tick+=.5){
    const index=rows.findLastIndex(row=>row.start<=tick),row=rows[index];
    const full=evaluatedFrame(report,index,row.count?(tick-row.start)/row.count:0,tick,{skipMovieclips:true});
    assert.deepEqual(members(sample(tick)),members(full),`clock membership at ${tick}`);
  }
}
test('projected clocks match the pose evaluator through breaks and cross-layer copies',()=>{
  const e=fixture();compare(e);e.seek(4);e.select(7);e.breakApartMovieclip();compare(e);
  e.sheetCopyFrames(['layer-1'],3,7);const layer=e.createLayer('Copy');e.sheetPasteFrames([layer.id],0);compare(e);
});

test('projected clocks preserve blanks, speeds, eased patches, retiming and undo',()=>{
  const e=fixture();
  for(const action of [
    ()=>{e.seek(3);e.select(7);e.setMovieclipPlayback({speed:2});},
    ()=>{e.seek(5);e.select(7);e.copySelection();e.deleteSelection();},
    ()=>{e.seek(8);e.pasteSelection();},
    ()=>e.sheetInsertFrames(['layer-1'],2,3),
    ()=>e.sheetRemoveFrames(['layer-1'],4,6),
    ()=>e.undo(),()=>e.redo(),
  ]){action();compare(e);}
});

test('clock rebuilding never reads pose arrays or figure artwork',()=>{
  const e=fixture(),report=e.report;
  // Many unrelated dense poses, with traps instead of timing-dependent limits.
  for(const frame of report.keyframes)for(let i=0;i<200;i++){
    const object={unique_id:100+i,figure_type_id:1,object_slot:frame.objects.length};
    for(const field of ['angles','lengths','bends','runtime_segments'])Object.defineProperty(object,field,{enumerable:true,get(){throw new Error(`Read unrelated ${field}`);}});
    frame.objects.push(object);
  }
  Object.defineProperty(report.figure_types[0],'segments',{get(){throw new Error('Read unrelated artwork');}});
  invalidateEvaluationCaches(report);
  const index=movieclipPresenceIndex(report);
  assert.equal(index.get(7).elapsed,12);
  assert.equal(movieclipPresenceIndex(report),index,'Reuse the clock until document invalidation.');
});
