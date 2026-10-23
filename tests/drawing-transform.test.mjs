import test from 'node:test';
import assert from 'node:assert/strict';
import {TileStore,TILE_BYTES,MAX_TILE} from '../src/drawing-tiles.mjs';
import {transformTiles,inverseMatrix,multiplyMatrix} from '../src/drawing-transform.mjs';
import {tileChanges,applyTileChanges} from '../src/drawing-pixels.mjs';

const put=(s,x,y,p)=>{const tx=Math.floor(x/64),ty=Math.floor(y/64);s.writable(tx,ty).pixels.set(p,((y-ty*64)*64+x-tx*64)*4);};

test('sparse resampling allocates occupied islands, never their empty bounding box',()=>{
  const s=new TileStore();put(s,-64000001,0,[127,5,249,1]);put(s,64000001,0,[200,100,40,255]);
  const out=transformTiles(s,[2,0,0,2,0,0],{filter:'nearest',maxBytes:32*TILE_BYTES});
  assert.deepEqual(out.pixel(-128000002,0),[127,5,249,1]);assert.deepEqual(out.pixel(128000003,1),[200,100,40,255]);
  assert.ok(out.size<=4);assert.ok(out.bounds.width>250000000);
});

test('rotation and reflection preserve exact low-alpha RGBA at pixel centers',()=>{
  const s=new TileStore();put(s,2,-3,[127,5,249,1]);
  assert.deepEqual(transformTiles(s,[0,1,-1,0,0,0]).pixel(2,2),[127,5,249,1]);
  assert.deepEqual(transformTiles(s,[-1,0,0,1,0,0]).pixel(-3,-3),[127,5,249,1]);
});

test('filtered paste leaves every unpainted destination byte intact and undoes exactly',()=>{
  const source=new TileStore(),target=new TileStore();put(source,2,2,[255,0,0,200]);
  put(target,30,30,[127,5,249,1]);put(target,31,30,[17,51,233,0]);put(target,3,3,[0,0,255,100]);
  const snapshot=target.get(0,0).pixels.slice(),before=new Map();
  transformTiles(source,[1.5,0,0,1.5,0,0],{target,before});
  assert.deepEqual(target.pixel(30,30),[127,5,249,1]);assert.deepEqual(target.pixel(31,30),[17,51,233,0]);
  assert.ok(target.pixel(3,3)[0]>0&&target.pixel(3,3)[2]>0);
  applyTileChanges(target,tileChanges(target,before),'before');assert.deepEqual(target.get(0,0).pixels,snapshot);
});

test('bilinear sampling crosses negative and positive tile edges without seams',()=>{
  const source=new TileStore();for(let x=-65;x<=65;x++)put(source,x,2,[x+65,55,130-x,255]);
  const out=transformTiles(source,[1,0,0,1,.5,0]);
  for(const x of [-64,-1,0,63,64])assert.deepEqual(out.pixel(x,2),[Math.round(x+64.5),55,Math.round(130.5-x),255]);
});

test('downsampling uses area coverage with premultiplied color and no hidden RGB halo',()=>{
  const s=new TileStore();for(let y=-64;y<64;y++)for(let x=-64;x<64;x++)put(s,x,y,(x+y)&1?[250,0,250,0]:[20,80,160,255]);
  const out=transformTiles(s,[.25,0,0,.25,0,0]);
  for(const p of [[-15,-15],[-1,-1],[0,0],[15,15]])assert.deepEqual(out.pixel(...p),[20,80,160,128]);
});

test('nearest resampling remains crisp for pixel art',()=>{
  const s=new TileStore();put(s,0,0,[17,23,29,127]);const out=transformTiles(s,[4,0,0,4,0,0],{filter:'nearest'});
  for(let y=0;y<4;y++)for(let x=0;x<4;x++)assert.deepEqual(out.pixel(x,y),[17,23,29,127]);
  assert.deepEqual(out.bounds,{x:0,y:0,width:4,height:4});
});

test('transform budget and coordinate range reject before editing the destination',()=>{
  const s=new TileStore(),target=new TileStore();s.set(0,0,new Uint8ClampedArray([100,100,100,255]));put(target,1,1,[1,2,3,4]);
  const snapshot=target.get(0,0).pixels.slice();
  assert.throws(()=>transformTiles(s,[100000,0,0,100000,0,0],{target,maxBytes:1024*1024}),/memory limit/);
  assert.throws(()=>transformTiles(s,[1,0,0,1,(MAX_TILE+2)*64,0],{target}),/format range/);
  assert.deepEqual(target.get(0,0).pixels,snapshot);
});

test('source and destination pose composition preserves the same world-space position',()=>{
  const sourcePose=[0,.5,.5,0,200,-30],destinationPose=[-2,0,0,2,15,45],relative=multiplyMatrix(inverseMatrix(destinationPose),sourcePose);
  const roundtrip=multiplyMatrix(destinationPose,relative);assert.deepEqual(roundtrip,sourcePose);
  assert.throws(()=>inverseMatrix([0,0,0,0,1,1]),/singular/);
});
