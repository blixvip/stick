import test from 'node:test';
import assert from 'node:assert/strict';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {applyTileChanges} from '../src/drawing-pixels.mjs';
import {captureSelection,selectionStores,lassoContains,lassoBounds} from '../src/drawing-lasso.mjs';
import {selectionTiles,transformSelectedPixels} from '../src/drawing-selection.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';

const select=(store,points)=>selectionStores(store,captureSelection(store,points).tiles).source;

test('integer selection translation preserves unselected RGBA and allocates no intervening tiles',()=>{
  const store=new TileStore(),tile=store.writable(0,0);tile.pixels.set([200,100,50,255],(10*64+10)*4);tile.pixels.set([127,5,249,1],(10*64+30)*4);
  const source=select(store,[{x:8,y:8},{x:14,y:8},{x:14,y:14},{x:8,y:14}]),before=tile.pixels.slice();
  const matrix=[1,0,0,1,640000,0];assert.equal(selectionTiles(store,source,matrix).length,1);
  const changes=transformSelectedPixels(store,{source,matrix});
  assert.deepEqual(store.pixel(30,10),[127,5,249,1]);assert.deepEqual(store.pixel(640010,10),[200,100,50,255]);assert.equal(store.pixel(10,10)[3],0);assert.equal(store.size,2);
  applyTileChanges(store,changes,'before');assert.equal(store.size,1);assert.deepEqual(store.get(0,0).pixels,before);
});

test('deleting selected pixels preserves nearby translucent and transparent RGB',()=>{
  const store=new TileStore(),t=store.writable(0,0);t.pixels.set([90,60,10,127],(10*64+10)*4);t.pixels.set([25,50,75,0],(10*64+30)*4);
  const source=select(store,[{x:8,y:8},{x:14,y:8},{x:14,y:14},{x:8,y:14}]);
  transformSelectedPixels(store,{source,matrix:[1,0,0,1,0,0],remove:true});
  assert.equal(store.pixel(10,10)[3],0);assert.deepEqual(store.pixel(30,10),[25,50,75,0]);
});

test('lasso across a trillion empty pixels only captures occupied tiles',()=>{
  const store=new TileStore();store.set(-1,-1,new Uint8ClampedArray([127,5,249,1]));store.set(100000,100000,new Uint8ClampedArray([33,66,99,255]));
  const points=[{x:-64,y:-64},{x:6400064,y:-64},{x:6400064,y:6400064},{x:-64,y:6400064}],before=[...store].map(t=>t.pixels.slice());
  const result=captureSelection(store,points,{maxBytes:48*1024});assert.equal(result.tiles.length,2);
  assert.equal(result.tiles.reduce((n,t)=>n+t.pixels.byteLength+(t.remaining?.byteLength??0),0),TILE_BYTES*2);
  assert.ok(result.tiles.every(t=>t.remaining===null));assert.deepEqual([...store].map(t=>t.pixels),before);
  const {source}=selectionStores(store,result.tiles),changes=transformSelectedPixels(store,{source,matrix:[1,0,0,1,64,0],maxBytes:1024*1024});
  assert.deepEqual(store.pixel(6400064,6400000),[33,66,99,255]);assert.deepEqual(store.pixel(0,-64),[127,5,249,1]);
  applyTileChanges(store,changes,'before');assert.deepEqual([...store].map(t=>t.pixels),before);
});

test('fully selected tiles are shared copy-on-write; partial tiles carry worker-computed bounds',()=>{
  const base=new TileStore();base.set(0,0,new Uint8ClampedArray([12,34,56,255]));base.set(1,0,new Uint8ClampedArray([99,88,77,255]));
  const result=captureSelection(base,[{x:0,y:0},{x:96,y:0},{x:96,y:64},{x:0,y:64}]),{source,remainder}=selectionStores(base,result.tiles);
  assert.equal(source.get(0,0),base.get(0,0));assert.notEqual(source.get(1,0).pixels,base.get(1,0).pixels);
  assert.deepEqual(source.get(1,0).alphaBounds,{x:0,y:0,width:32,height:64});assert.deepEqual(remainder.get(1,0).alphaBounds,{x:32,y:0,width:32,height:64});
  base.writable(0,0).pixels[0]=77;assert.equal(source.pixel(0,0)[0],12);
});

test('filtered selection seeds neighboring destination tiles before writing its edge',()=>{
  const original=new TileStore();original.set(0,0,new Uint8ClampedArray([200,100,50,255]));original.set(1,0,new Uint8ClampedArray([127,5,249,1]));
  const source=select(original,[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}]),matrix=[2,0,0,2,60,0],worker=new TileStore();
  for(const t of selectionTiles(original,source,matrix))worker.set(t.tx,t.ty,t.pixels);
  const changes=transformSelectedPixels(worker,{source,matrix});
  applyTileChanges(original,changes,'after');assert.deepEqual(original.pixel(90,30),[127,5,249,1]);assert.ok(original.pixel(64,1)[3]>1);
});

test('sparse lasso matches independent even-odd pixel tests for fractional, negative and crossing edges',()=>{
  const polygons=[
    [{x:-66.5,y:-64.5},{x:14.25,y:-90},{x:32.5,y:24.5},{x:-31,y:17}],
    [{x:-80,y:-80},{x:60,y:60},{x:-80,y:60},{x:60,y:-80}],
    [{x:-1,y:-1},{x:20,y:-1},{x:20,y:12},{x:9,y:12},{x:9,y:25},{x:-1,y:25}],
  ];
  for(const points of polygons){
    const store=new TileStore();for(let ty=-2;ty<1;ty++)for(let tx=-2;tx<1;tx++)store.set(tx,ty,new Uint8ClampedArray([127,5,249,1]));
    const before=[...store].map(t=>t.pixels.slice()),{source,remainder}=selectionStores(store,captureSelection(store,points).tiles);
    for(let y=-128;y<64;y++)for(let x=-128;x<64;x++){
      let crossings=0;for(let i=0,j=points.length-1;i<points.length;j=i++){
        const a=points[i],b=points[j],scan=y+.5;
        if((a.y>scan)!==(b.y>scan)&&(b.x-a.x)*(scan-a.y)/(b.y-a.y)+a.x>x+.5)crossings++;
      }
      const selected=Boolean(crossings%2);assert.equal(source.pixel(x,y)[3]!==0,selected,`${x},${y}`);assert.equal(remainder.pixel(x,y)[3]===0,selected);assert.equal(lassoContains(points,x,y),selected);
    }
    assert.deepEqual([...store].map(t=>t.pixels),before);
  }
});

test('lasso validates geometry and preflights memory without changing source',()=>{
  assert.equal(lassoBounds([{x:1,y:1},{x:2,y:1}]),null);
  assert.throws(()=>lassoBounds([{x:NaN,y:0}]),/coordinates/);
  assert.throws(()=>lassoBounds(Array(8193).fill({x:1,y:1})),/coordinates/);
  const store=new TileStore();store.set(0,0,new Uint8ClampedArray([1,2,3,255]));const before=store.get(0,0).pixels.slice(),points=[{x:0,y:0},{x:32,y:0},{x:32,y:64},{x:0,y:64}];
  assert.throws(()=>captureSelection(store,points,{maxBytes:TILE_BYTES*2}),/memory/);assert.deepEqual(store.get(0,0).pixels,before);
});

test('selection seeding skips existing cel tiles in the empty gap between selected islands',()=>{
  const store=new TileStore();for(const tx of [-100000,0,100000])store.set(tx,0,new Uint8ClampedArray([12,34,56,255]));
  const source=new TileStore();source.set(-100000,0,new Uint8ClampedArray([12,34,56,255]));source.set(100000,0,new Uint8ClampedArray([12,34,56,255]));
  assert.deepEqual(selectionTiles(store,source,[1,0,0,1,64,0]).map(t=>t.tx),[-100000,100000]);
  assert.deepEqual(selectionTiles(store,source,[1e20,0,0,1e20,0,0],'smooth',{remove:true}).map(t=>t.tx),[-100000,100000]);
});

test('transient surfaces deduplicate shared pixels and release their derived caches',async()=>{
  const owner=new DrawingResources({figure_types:[]},{history:false}),base=new TileStore();base.set(0,0,new Uint8ClampedArray([12,34,56,255]));base.set(1,0,new Uint8ClampedArray([99,88,77,255]));
  const a=owner.transient(base),b=owner.transient(base.fork());assert.equal(owner.stats.bytes,TILE_BYTES*2);assert.equal(owner.stats.entries,0);assert.equal(owner.stats.unpublished,0);
  b.store.writable(0,0).pixels[0]=22;assert.equal(owner.stats.bytes,TILE_BYTES*3);assert.equal(base.pixel(0,0)[0],12);
  const c={width:128,height:128};b._scratches=new Map([['test',{canvas:c,used:0}]]);assert.equal(owner.stats.scratchBytes,128*128*4);
  owner.releaseTransient(b);assert.equal(c.width,1);assert.equal(owner.stats.bytes,TILE_BYTES*2);assert.equal(owner.stats.scratchBytes,0);
  await owner.dispose();assert.equal(owner.stats.bytes,0);assert.equal(owner.stats.transients,0);assert.equal(a.store,null);
});
