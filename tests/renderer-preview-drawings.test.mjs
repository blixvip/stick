import test from 'node:test';
import assert from 'node:assert/strict';
import {canRefineDrawingItems} from '../src/renderer-preview-drawings.mjs';
import {drawingPreviewPlan,preparePreviewDrawings} from '../src/renderer-preview-drawing-resources.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {TILE_BLOB_PREFIX,encodeTileBlob,assembleTileBlobBytes} from '../src/drawing-tile-codec.mjs';
import {bytesToBase64} from '../src/base64.mjs';
import {DrawingTileProvider} from '../src/drawing-provider.mjs';

async function drawing({x=-2,y=1}={}){
  const figure=createDrawingFigure({celId:'cel-preview-drawing',figureTypeId:1}),store=new TileStore();
  store.set(x,y,new Uint8ClampedArray([73,128,219,192]));
  figure._styk.drawing.bounds=store.bounds;figure.image_assets[0].styk_tiles=await encodeTileBlob(store);
  return {figure,store,item:{type:'image',fig:figure}};
}

test('drawing refinement uses clean published revisions and leaves dirty/live resources immediate',async()=>{
  const {figure,store,item}=await drawing(),revision=figure._styk.drawing.revision;
  const entry={id:figure._styk.drawing.celId,revision,store,published:{revision,url:figure.image_assets[0].styk_tiles}};
  const resources={drawing:()=>entry};
  assert.equal(canRefineDrawingItems([item],resources),true);
  for(const patch of [{published:null},{published:{revision:revision-1,url:figure.image_assets[0].styk_tiles}},{published:{revision,url:'old'}},
    {revision:revision+1},{id:'selection'},{store:null},{pinned:true},{loading:Promise.resolve()},{deferred:[{}]},{transient:true}]){
    assert.equal(canRefineDrawingItems([item],{drawing:()=>({...entry,...patch})}),false);
  }
  assert.equal(canRefineDrawingItems([item],{}),false);
  const provider=new DrawingTileProvider();
  try{await provider.prepare([figure]);assert.equal(canRefineDrawingItems([item],{drawing:fig=>provider.presenter(fig)}),true);figure._styk.drawing.revision++;assert.equal(canRefineDrawingItems([item],{drawing:fig=>provider.presenter(fig)}),false);}
  finally{provider.dispose();}
});

test('native paths retain eligibility while ordinary media, legacy drawings and depth remain immediate',()=>{
  assert.equal(canRefineDrawingItems([{type:'line'},{type:'circle'},{type:'poly'},{type:'text'}]),true);
  for(const item of [{type:'image'},{type:'mesh'},{type:'line',fig:{_styk:{drawing:{version:2}}}},
    {type:'image',fig:{_styk:{drawing:{version:1}}}},
    {type:'poly',alpha:1,points:[{x:0,y:0},{x:1,y:0},{x:0,y:1}],depthValues:[0,0,0],poly:{_stykSurface:{depthTest:true}}}]){
    assert.equal(canRefineDrawingItems([item]),false);
  }
  assert.equal(drawingPreviewPlan([{type:'line'}]).bytes,0);
});

test('active native diamond brushes stay immediate while inactive brushes and shader colours remain eligible',()=>{
  for(const type of ['line','text']){
    const item={type,obj:{scale:1},seg:{paint:{type:'diamond'}}};
    assert.equal(canRefineDrawingItems([item]),false);
    assert.equal(canRefineDrawingItems([{...item,outline:1}]),true);
    assert.equal(canRefineDrawingItems([{...item,obj:{scale:1,color_override_raw:0xff123456}}]),true);
  }
  assert.equal(canRefineDrawingItems([{type:'line',obj:{_stykVfx:{figure:[{type:'glow',params:{color:{type:'diamond'}}}]}}}]),true);
});

test('worker drawing admission counts unique sparse tiles, mips and scratch before decoding',async()=>{
  const {item,figure}=await drawing(),plan=drawingPreviewPlan([item,item]);
  assert.equal(plan.figures.length,1);assert.equal(plan.decodedBytes,TILE_BYTES);
  assert.ok(plan.bytes>=9*TILE_BYTES+plan.scratchBytes+plan.stripBytes);
  assert.equal(plan.tintBytes,0);assert.equal(drawingPreviewPlan([{...item,onionTint:[255,0,0]}]).tintBytes>0,true);
  assert.ok(plan.bytes<1024*1024);
  const sparse={...figure,_styk:{drawing:{...figure._styk.drawing,bounds:{x:-6400000,y:-6400000,width:12800064,height:12800064}}}};
  const far=drawingPreviewPlan([{...item,fig:sparse}]);
  assert.equal(far.decodedBytes,TILE_BYTES);assert.ok(far.bytes<128*1024*1024);
  await assert.rejects(preparePreviewDrawings(plan,{maxBytes:plan.bytes-1}),/working memory/);
  const conflict={...figure,_styk:{drawing:{...figure._styk.drawing,revision:1}}};
  assert.throws(()=>drawingPreviewPlan([item,{...item,fig:conflict}]),/Invalid drawing composite/);
});

test('malformed drawing headers and unsupported resources fail before pixel allocation',async()=>{
  const {item,figure}=await drawing();
  const header=new Uint8Array(16),view=new DataView(header.buffer);view.setUint32(0,0x54595453);view.setUint32(4,1,true);view.setUint32(8,64,true);view.setUint32(12,32769,true);
  for(const url of ['broken',TILE_BLOB_PREFIX+'AA==',TILE_BLOB_PREFIX+bytesToBase64(header)]){
    assert.throws(()=>drawingPreviewPlan([{...item,fig:{...figure,image_assets:[{styk_tiles:url}]}}]),/Invalid drawing composite/);
  }
  assert.throws(()=>drawingPreviewPlan([{type:'image'}]),/Invalid drawing composite/);
  const empty={...figure,_styk:{drawing:{...figure._styk.drawing,bounds:null}},image_assets:[{styk_tiles:TILE_BLOB_PREFIX+bytesToBase64(assembleTileBlobBytes([]))}]};
  assert.equal(drawingPreviewPlan([{...item,fig:empty}]).decodedBytes,0);
});

test('one disposable existing provider decodes exact published pixels and releases scratch on cancellation',async()=>{
  const {item,figure,store}=await drawing(),plan=drawingPreviewPlan([item]);
  const resources=await preparePreviewDrawings(plan),entry=resources.drawing(figure);
  assert.ok(resources.drawingProvider instanceof DrawingTileProvider);
  assert.deepEqual(entry.store.pixel(-128,64),store.pixel(-128,64));
  assert.equal(resources.drawingProvider.hardBytes,store.bytes);
  let shrunk={width:64,height:64};entry._scratches=new Map([['test',{canvas:shrunk}]]);
  resources.dispose();assert.equal(shrunk.width,1);assert.equal(shrunk.height,1);assert.equal(resources.drawingProvider.entries.size,0);
  let checks=0;await assert.rejects(preparePreviewDrawings(plan,{check:()=>{if(++checks===3)throw new DOMException('Superseded','AbortError');}}),{name:'AbortError'});
  assert.equal(await preparePreviewDrawings(drawingPreviewPlan([{type:'line'}])),null);
});
