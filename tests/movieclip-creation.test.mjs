import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {sampleSheet} from './helpers/sheet-samples.mjs';
import {movieclipAsset} from '../src/movieclips.mjs';

function fixture({frames=80,neighbors=1,duration=1}={}){
  const document=emptyDocument(),figure=document.figure_types[0];
  document.keyframes=Array.from({length:frames},(_,i)=>createFrame([
    createObject(figure,1,100+Math.sin(i)*20,200),
    ...Array.from({length:neighbors},(_,n)=>createObject(figure,n+2,300+n*40,200+i,{unrelatedPayload:'outside-capture'.repeat(200)})),
  ],duration));
  return new Editor({demo:false,layerTimeline:true}).load(document);
}
const shapes=(report,tick)=>buildGeometry(report,sampleSheet(report,tick)).drawables.map(d=>({type:d.type,rgb:d.rgb,alpha:d.alpha,points:d.points.map(p=>[p.x,p.y])}));
function close(actual,expected){
  assert.equal(actual.length,expected.length);
  actual.forEach((a,i)=>{
    const b=expected[i];assert.equal(a.type,b.type);assert.deepEqual(a.rgb,b.rgb);assert.equal(a.alpha,b.alpha);assert.equal(a.points.length,b.points.length);
    a.points.forEach((p,j)=>p.forEach((n,k)=>assert.ok(Math.abs(n-b.points[j][k])<1e-5,`${i}/${j}/${k}: ${n} != ${b.points[j][k]}`)));
  });
}

test('range creation retains imported pose keys and history excludes unrelated layer poses',()=>{
  const sizes=[];
  for(const neighbors of [1,40]){
    const e=fixture({neighbors}),frames=e.report.keyframes.slice(),before=e.report._styk.layerSheet;
    e.seek(31);e.select(1);const undo=e._undo.length;e.createMovieclip({start:31,end:47});
    const uid=e.selectedUid,command=e._undo.at(-1);sizes.push(command.bytes);
    assert.equal(e._undo.length,undo+1);assert.ok(command.bytes<400000,`History was ${command.bytes} bytes`);
    assert.equal(command.commands.length,2,'One definition and one sparse sheet command.');
    const sheet=command.commands.find(c=>c.kind==='layer-sheet');
    assert.equal(sheet.frameSourceChanges.length,1,'Reuse the same captured container pose across the range.');
    assert.deepEqual(sheet.frameSourceChanges[0].after.value.objects.map(o=>o.unique_id),[uid]);
    assert.ok(!JSON.stringify(command).includes('outside-capture'));
    for(let i=0;i<frames.length;i++)assert.equal(e.report.keyframes[i],frames[i]);
    for(const [id,track] of Object.entries(before.tracks)){
      const after=e.report._styk.layerSheet.tracks[id];
      if(id!=='layer-1'){assert.equal(after,track);continue;}
      for(const key of track.keys){const next=after.keys.find(value=>value.id===key.id);assert.equal(next.sourceTick,key.sourceTick);assert.equal(next.interpolation,key.interpolation);}
    }
    const after=e.report._styk.layerSheet;e.undo();assert.equal(e.report._styk.layerSheet,before);
    e.redo();assert.equal(e.report._styk.layerSheet,after);
  }
  assert.ok(Math.abs(sizes[1]-sizes[0])<1000,'Unrelated figures do not multiply capture/history memory.');
});

test('conversion boundaries preserve fractional eased poses, stacking, reopen and exact undo',()=>{
  const e=fixture({frames:4,neighbors:2,duration:10});
  e.sheetSetEasing(['layer-1'],0,39,{interpolation:'bezier',bezier:[.15,.8,.6,.2]});
  e.seek(10);e.select(2);e.moveSelection(-35,12);
  const before=e.serialize(),samples=Array.from({length:e.totalTicks*4},(_,i)=>shapes(e.report,i/4));
  e.seek(3);e._selectIds([1,2]);e.createMovieclip({start:3,end:24});
  for(let i=0;i<samples.length;i++)close(shapes(e.report,i/4),samples[i]);
  const reopened=new Editor({demo:false,layerTimeline:true}).load(e.serialize());
  for(let i=0;i<samples.length;i++)close(shapes(reopened.report,i/4),samples[i]);
  e.undo();assert.deepEqual(e.serialize(),before);
  e.redo();for(const tick of [0,2.5,3,12.5,23.75,24,30])close(shapes(e.report,tick),samples[tick*4]);
});

test('definition-only range capture changes no sheet poses or sources',()=>{
  const e=fixture(),sheet=e.report._styk.layerSheet,sources=e.report._styk.frameSources,undo=e._undo.length;
  e.select(1);const figure=e.createMovieclip({start:3,end:17,replace:false});
  assert.equal(movieclipAsset(figure).duration,14);assert.equal(e.report._styk.layerSheet,sheet);assert.equal(e.report._styk.frameSources,sources);
  assert.equal(e._undo.length,undo+1);assert.equal(e._undo.at(-1).commands.length,1);
});

test('shortened layers stay empty outside an extended container range',()=>{
  const e=fixture({frames:3,neighbors:1,duration:8});
  const total=e.totalTicks,second=e.createLayer('Other');e.sheetAssignFigures([2],second.id);e.sheetRemoveFrames(['layer-1'],8,total-1);
  const expected=Array.from({length:total},(_,t)=>shapes(e.report,t));e.seek(3);e.select(1);e.createMovieclip({start:3,end:12});
  assert.equal(e.totalTicks,total);
  for(let t=0;t<total;t++)close(shapes(e.report,t),expected[t]);
  e.undo();for(let t=0;t<total;t++)close(shapes(e.report,t),expected[t]);
});

test('connected figures across layers convert together and leave other tracks intact',()=>{
  const e=fixture({frames:8,neighbors:2});
  e.select(2);e.joinTo(1,1);
  const upper=e.createLayer('Upper');e.sheetAssignFigures([2],upper.id);
  const outside=e.createLayer('Outside');e.sheetAssignFigures([3],outside.id);
  const retained=e.report._styk.layerSheet.tracks[outside.id];
  const expected=Array.from({length:e.totalTicks},(_,t)=>shapes(e.report,t));
  e.seek(2);e.select(1);const before=e.serialize();e.createMovieclip({start:2,end:6});
  assert.equal(e.report._styk.layerSheet.tracks[outside.id],retained);
  for(let t=0;t<e.totalTicks;t++)close(shapes(e.report,t),expected[t]);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();
  const reopened=new Editor({demo:false,layerTimeline:true}).load(e.serialize());
  for(let t=0;t<e.totalTicks;t++)close(shapes(reopened.report,t),expected[t]);
});

test('a locked replacement layer rejects creation without publishing a partial definition',()=>{
  const e=fixture();e.select(1);e.setLayerLocked('layer-1',true);
  const before=e.serialize(),history=e._undo.length,bytes=e.historySize;
  assert.throws(()=>e.createMovieclip({start:3,end:17}),/Unlock/);
  assert.deepEqual(e.serialize(),before);assert.equal(e._undo.length,history);assert.equal(e.historySize,bytes);
});
