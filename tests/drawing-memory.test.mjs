import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {DrawingController} from '../src/drawing-controller.mjs';
import {DrawingStroke,applyTileChanges} from '../src/drawing-pixels.mjs';
import {floodTiles} from '../src/drawing-fill.mjs';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {strokeRegion} from '../src/drawing-stroke-region.mjs';
import {levelStore} from '../src/drawing-raster.mjs';

test('install rejects an oversized result without replacing existing pixels',()=>{
  const f=createDrawingFigure({celId:'memory'}),r=new DrawingResources({figure_types:[f]},{tileBytes:8*TILE_BYTES,hardBytes:2*TILE_BYTES});r.busy=true;r.flush=async()=>{};
  try{r.install(f,[{tx:0,ty:0,pixels:new Uint8ClampedArray([1,2,3,255])}]);const s=r.entry(f).store;
    assert.throws(()=>r.install(f,Array.from({length:8},(_,tx)=>({tx,ty:0,pixels:new Uint8ClampedArray([4,5,6,255])}))),/memory is full/);
    assert.equal(r.entry(f).store,s);assert.equal(r.stats.bytes,TILE_BYTES);
  }finally{r.dispose();}
});
test('copy-on-write replacements reserve new unique tile bytes',()=>{
  const f=createDrawingFigure({celId:'one'}),g=createDrawingFigure({celId:'two'}),r=new DrawingResources({figure_types:[f,g]},{tileBytes:TILE_BYTES,hardBytes:TILE_BYTES});r.flush=async()=>{};r.busy=true;
  try{r.install(f,[{tx:0,ty:0,pixels:new Uint8ClampedArray([1,2,3,255])}]);r.fork(f,g);
    assert.throws(()=>r.apply(g,[{tx:0,ty:0,after:new Uint8ClampedArray([4,5,6,255])}],'after'),/memory is full/);
    assert.deepEqual(r.entry(g).store.pixel(0,0),[1,2,3,255]);assert.equal(r.stats.bytes,TILE_BYTES);
  }finally{r.dispose();}
});
test('live stroke replies cannot bypass the hard tile budget',()=>{
  const f=createDrawingFigure({celId:'live'}),r=new DrawingResources({figure_types:[f]},{tileBytes:TILE_BYTES,hardBytes:2*TILE_BYTES});r.flush=async()=>{};r.busy=true;
  try{const s={id:1,surface:r.entry(f),before:new Map(),posted:new Map(),outstanding:1,owner:r};s.surface.store=new TileStore();
    const c=Object.create(DrawingController.prototype);let cancelled=false,error;
    Object.assign(c,{sessions:new Map([[1,s]]),owner:r,strokeStats:{},cancel(){cancelled=true;r.hold(s,0);},onError:e=>error=e});
    c.strokeMessage({kind:'tiles',stroke:1,seq:1,tiles:Array.from({length:8},(_,tx)=>({tx,ty:0,pixels:new Uint8ClampedArray(TILE_BYTES).buffer}))});
    assert.ok(cancelled);assert.match(error.message,/memory is full/);assert.equal(s.surface.store.size,0);assert.equal(r.workingBytes,0);
  }finally{r.dispose();}
});
test('brush working memory fails before allocating the next tile and supports exact cancellation',()=>{
  const s=new TileStore(),b=new DrawingStroke(s,{size:2,workingBytes:5*TILE_BYTES});b.sample({x:10,y:10});
  assert.throws(()=>b.sample({x:140,y:10}),/working memory/);b.cancel();assert.equal(s.size,0);
});
test('4K diagonal seeding follows the stroke rather than its bounding rectangle',()=>{
  const tiles=[...strokeRegion([{x:0,y:0},{x:3840,y:2160},{x:7680,y:4320}],10)];assert.ok(tiles.length<400,tiles.length);
  for(let i=0;i<=100;i++){const tx=Math.floor(7680*i/100/64),ty=Math.floor(4320*i/100/64);assert.ok(tiles.some(t=>t[0]===tx&&t[1]===ty));}
});
test('an oversized stroke seed cancels at the animation-frame boundary',()=>{
  const c=Object.create(DrawingController.prototype),s={id:1,pending:[{x:0,y:0},{x:1e12,y:1e12}],queue:[],qi:0,paths:[],brush:{size:4,pressureSize:false,texture:0,scatter:0},outstanding:0,sent:new Set(),surface:{store:new TileStore()}};let cancelled=false,error;
  Object.assign(c,{sessions:new Map([[1,s]]),cancel(){cancelled=true;},onError:e=>error=e});c.flushStroke(s);assert.ok(cancelled);assert.match(error.message,/working memory/);
});
test('fill masks can exceed the old 16MP limit and remain exactly undoable',()=>{
  const s=new TileStore();s.set(0,0,new Uint8ClampedArray([2,4,6,255]));const before=s.get(0,0).pixels.slice();
  const changes=floodTiles(s,{x:10,y:10,color:[12,14,16,255],bounds:{x:0,y:0,width:8192,height:4096}});
  assert.equal(changes.length,1);assert.deepEqual(s.pixel(10,10),[12,14,16,255]);applyTileChanges(s,changes,'before');assert.deepEqual(s.get(0,0).pixels,before);
});
test('high mip levels visit occupied branches rather than empty descendants',()=>{
  const store=new TileStore();store.set(-10000,10000,new Uint8ClampedArray([12,34,56,255]));const entry={store};let reads=0;const get=store.get.bind(store);store.get=(...args)=>{reads++;return get(...args);};
  levelStore(entry,8);assert.ok(reads<=4,reads);assert.ok(entry.levels[0].size===1);
});
