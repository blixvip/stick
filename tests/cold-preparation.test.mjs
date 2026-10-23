import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createFrame,createObject,emptyDocument} from '../src/demo.mjs';
import {documentChunks,applyDocumentChunk} from '../src/document-transport.mjs';
import {ArtworkRegistry} from '../src/render-artwork.mjs';
import {buildGeometry,buildGeometryAsync,evaluatedFrame,timeline} from '../src/pivot/geometry.mjs';
import {movieclipAsset} from '../src/movieclips.mjs';
import {movieclipCacheStats} from '../src/movieclip-geometry.mjs';
import {ThumbnailRenderer} from '../src/thumbnail-renderer.mjs';

function clipFixture(){
  const editor=new Editor();editor.select(1);
  const figure=editor.createMovieclip({start:0,end:20,replace:false});
  return {editor,figure};
}
function transport(report,options){
  const chunks=[...documentChunks(report,options)];let received;
  for(const chunk of chunks)received=applyDocumentChunk(received,structuredClone(chunk));
  return {received,chunks};
}
test('shared figure transport retains exact native content and existing aliases across nested clips',()=>{
  const {figure}=clipFixture(),child=movieclipAsset(figure).document.figure_types[0];
  const other=structuredClone(figure);other.figure_type_id++;
  movieclipAsset(other).document.figure_types=[child];
  const report={figure_types:[child,figure,other,structuredClone(child)],keyframes:[]};
  const {received,chunks}=transport(report,{maxBytes:4096,maxRecords:4,sharedFigures:true});
  assert.deepEqual(received,report);
  assert.equal(JSON.stringify(received),JSON.stringify(report));
  assert.equal(received.figure_types[0],movieclipAsset(received.figure_types[1]).document.figure_types[0]);
  assert.equal(received.figure_types[0],movieclipAsset(received.figure_types[2]).document.figure_types[0]);
  assert.notEqual(received.figure_types[0],received.figure_types[3],'Equal but independent definitions must stay independent.');
  assert.ok(chunks.some(c=>c.operations?.some(op=>op.figureReference)));
  assert.ok(chunks.every(c=>!c.estimatedBytes||c.estimatedBytes<=4096));
});
test('figure transport rejects cyclic and out-of-order aliases without accepting general object references',()=>{
  const {figure}=clipFixture();movieclipAsset(figure).document.figure_types.push(figure);
  assert.throws(()=>transport({figure_types:[figure]},{sharedFigures:true}),/Cyclic/);
  const report={figure_types:[],keyframes:[],opaque:{segments:[],figure_type_id:1}};
  for(const figureReference of [['figure_types',3],['opaque'],['__proto__','figure_types',0]])
    assert.throws(()=>applyDocumentChunk(report,{operations:[{path:['figure_types',0],figureReference}]}),/reference/i);
  assert.deepEqual(report.figure_types,[]);
});
test('sampled clip artwork excludes unused timeline data but includes every child definition and instance style',async()=>{
  const {editor,figure}=clipFixture(),report={...editor.report,figure_types:[figure],keyframes:[createFrame([createObject(figure,900,0,0)])]};
  const geometry=buildGeometry(report,report.keyframes[0]).objects.get(0),registry=new ArtworkRegistry();registry.begin(1);
  const original=registry.get(geometry,geometry.drawables),key=await registry.contentKey(original);
  const otherFigure=structuredClone(figure);movieclipAsset(otherFigure).document.opaque='unused timeline payload'.repeat(10000);
  const other={...geometry,fig:otherFigure};
  assert.equal(registry.get(other,other.drawables),original);
  assert.ok(original.definition.text.length<10000,'The clip timeline must not enter its drawing definition.');
  const child=geometry.drawables[0].fig;child.futureOutlineStyle={width:7,color:123};registry.begin(2);
  const updated=registry.get(geometry,geometry.drawables);
  assert.notEqual(await registry.contentKey(updated),key,'A child style change must invalidate even retained geometry.');
  const moved={...geometry,obj:{...geometry.obj,field28:128}};
  assert.notEqual(registry.get(moved,moved.drawables),updated);
});
test('nested clip preparation yields inside a single outer object and cancels without publishing a partial cache',async()=>{
  const {figure}=clipFixture(),asset=movieclipAsset(figure),child=asset.document.figure_types[0];
  asset.document.keyframes=[createFrame(Array.from({length:80},(_,i)=>createObject(child,i+1,i*5,100)),20)];
  const report={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([createObject(figure,900,0,0)],20)]};
  const rows=timeline(report),frame=evaluatedFrame(report,0,0,rows[0].start),controller=new AbortController();let yields=0;
  await assert.rejects(buildGeometryAsync(report,frame,null,{sliceMs:0,signal:controller.signal,yieldControl:async()=>{yields++;controller.abort();}}),{name:'AbortError'});
  assert.ok(yields>0);assert.equal(movieclipCacheStats(figure).frames,0);
  yields=0;const actual=await buildGeometryAsync(report,frame,null,{sliceMs:0,yieldControl:async()=>{yields++;}});
  assert.ok(yields>10,'Nested drawing work needs checkpoints even with one outer clip.');
  assert.deepEqual(actual.drawables,buildGeometry(report,frame).drawables);
});
test('sheet pose edits and history preserve definition revisions and produce thumbnail patches',()=>{
  const report=emptyDocument();report.keyframes=[0,10].map(x=>createFrame([createObject(report.figure_types[0],1,x,100)],10));
  const editor=new Editor({demo:false,layerTimeline:true}).load(report),events=[];
  editor.addEventListener('change',e=>{if(['edit','history'].includes(e.detail.kind))events.push(e.detail);});
  const thumbnails=new ThumbnailRenderer(editor);thumbnails.loadedVersion=thumbnails.version;thumbnails.fullSnapshot=false;
  try{
    const revision=editor.definitionRevision,before=editor.serialize();editor.select(1);editor.moveSelection(12,-4);
    assert.equal(editor.definitionRevision,revision);assert.equal(thumbnails.fullSnapshot,false);
    assert.ok(events.at(-1).layerSheet);assert.ok(events.at(-1).sourceIds.length);assert.deepEqual(events.at(-1).frameIndices,[]);
    editor.undo();assert.deepEqual(editor.serialize(),before);assert.equal(editor.definitionRevision,revision);
    editor.redo();assert.equal(editor.definitionRevision,revision);assert.equal(thumbnails.fullSnapshot,false);
    const definition=structuredClone(editor.report.figure_types[0]);definition.segments[0].thickness+=5;
    editor.replaceFigureDefinition(definition.figure_type_id,definition);
    assert.ok(editor.definitionRevision>revision);assert.ok(thumbnails.definitionsChanged||thumbnails.fullSnapshot);
  }finally{thumbnails.destroy();}
});

for(const interrupt of ['pause','edit','failure'])test(`thumbnail snapshots survive ${interrupt} at an ACK boundary without stale content`,async()=>{
  const editor=new Editor({demo:false});editor.report.opaque='keep every byte'.repeat(20000);
  const thumbnails=new ThumbnailRenderer(editor),controller=new AbortController();let received,headers=0,chunks=0,interrupted=false;
  thumbnails._request=async(operation,{chunk})=>{
    if(operation!=='snapshot-chunk')return;
    if(chunk.header)headers++;
    received=applyDocumentChunk(received,structuredClone(chunk));chunks++;
    if(chunks===2&&!interrupted){
      interrupted=true;
      if(interrupt==='failure')throw new Error('Worker failed');
      controller.abort();
    }
  };
  try{
    await assert.rejects(thumbnails._snapshot(thumbnails.version,controller.signal),interrupt==='failure'?/Worker failed/:{name:'AbortError'});
    if(interrupt==='edit'){
      editor.report.opaque='the edited value';thumbnails.invalidate({kind:'edit',frameIndices:[0]});
    }
    await thumbnails._snapshot(thumbnails.version,new AbortController().signal);
    const {_stykSource,...expected}=editor.report;
    assert.deepEqual(received,expected);
    assert.equal(headers,interrupt==='pause'?1:2);
    assert.equal(thumbnails.loadedVersion,thumbnails.version);assert.equal(thumbnails.snapshot,null);
  }finally{thumbnails.destroy();}
});
