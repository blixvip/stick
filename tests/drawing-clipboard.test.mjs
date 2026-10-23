import test from 'node:test';
import assert from 'node:assert/strict';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {encodeClipboardTiles,decodePixelClipboard,validatePixelClipboard} from '../src/drawing-clipboard.mjs';
import {indexedTileCoverage,transformTiles} from '../src/drawing-transform.mjs';
import {encodeDrawingPNG,drawingPNGBytes,decodeDrawingPNGBytes} from '../src/drawing-png.mjs';
import {clipboardWireChunks,createClipboardWireDecoder} from '../src/clipboard-wire.mjs';
import {restoreClipboard} from '../src/shared-clipboard.mjs';

const clip=(tiles,bounds={x:-6400000,y:0,width:12800064,height:64})=>({version:2,pixelsPerUnit:1,world:{x:10,y:20},matrix:[1,0,0,1,10,20],bounds,tiles});
const pixels=()=>Uint8ClampedArray.from({length:TILE_BYTES},(_,i)=>i%4===3?i%256:(i*7)%256);

test('sparse clipboard crosses the wire without flattening distant pixels or changing exact RGBA',async()=>{
  const original=pixels(),tiles=await encodeClipboardTiles([{tx:-100000,ty:0,pixels:original.buffer},{tx:100000,ty:0,pixels:original.buffer}]);
  const data=clip(tiles),decoder=createClipboardWireDecoder({maxBytes:1024*1024,maxResidentBytes:1024*1024});
  for await(const part of clipboardWireChunks(data))await decoder.push(part);
  const restored=decoder.finish();decoder.dispose();assert.deepEqual(restored,data);
  const {store}=await decodePixelClipboard(restored);assert.equal(store.size,2);assert.equal(store.bytes,TILE_BYTES*2);
  assert.deepEqual(store.get(-100000,0).pixels,original);assert.deepEqual(store.get(100000,0).pixels,original);
});

test('copy reuses exact tile PNGs and stores affine pose without resampling source bytes',async()=>{
  const original=pixels(),png=await encodeDrawingPNG(original,64,64),tiles=await encodeClipboardTiles([{tx:0,ty:0,png:drawingPNGBytes(png).buffer}]);
  assert.equal(tiles[0].png,png);
  const data={...clip(tiles,{x:0,y:0,width:64,height:64}),matrix:[.6,.8,-.8,.6,100,200]},decoded=await decodePixelClipboard(data);
  assert.deepEqual(decoded.store.get(0,0).pixels,original);
  const source=new TileStore();source.set(0,0,original);
  const a=transformTiles(decoded.store,data.matrix),b=transformTiles(source,data.matrix);
  assert.deepEqual([...a].map(t=>[t.tx,t.ty,[...t.pixels]]),[...b].map(t=>[t.tx,t.ty,[...t.pixels]]));
});

test('legacy PNG clipboard packets retain their dimensions, exact colors and origin',async()=>{
  const data={pixelsPerUnit:2,width:2,height:1,world:{x:23,y:45},dataUrl:await encodeDrawingPNG(new Uint8ClampedArray([127,5,249,1,10,20,30,255]),2,1)};
  const {store}=await decodePixelClipboard(data);assert.deepEqual(store.pixel(0,0),[127,5,249,1]);assert.deepEqual(store.pixel(1,0),[10,20,30,255]);
  await assert.rejects(decodePixelClipboard({...data,width:3}),/dimensions/);
});

test('clipboard metadata rejects invalid indices and poses without replacing a previous copy',async()=>{
  const tiles=await encodeClipboardTiles([{tx:0,ty:0,pixels:pixels().buffer}]),data=clip(tiles,{x:0,y:0,width:64,height:64}),editor={_drawingPixelClipboard:'before',_emit:()=>{}};
  const cases=[{version:3},{tiles:[...tiles,...tiles]},{tiles:[{...tiles[0],tx:.5}]},{tiles:[{...tiles[0],tx:0x80000000}]},{bounds:null},{bounds:{x:1000,y:0,width:2,height:2}},{matrix:[0,0,0,0,0,0]},{world:{x:NaN,y:0}},{tiles:[{...tiles[0],png:'data:text/plain,hi'}]}];
  for(const change of cases){await assert.rejects(restoreClipboard(editor,{format:'StykAnimate clipboard',version:1,kind:'drawing-pixels',data:{...data,...change}}));assert.equal(editor._drawingPixelClipboard,'before');}
  await restoreClipboard(editor,{format:'StykAnimate clipboard',version:1,kind:'drawing-pixels',data});assert.deepEqual(editor._drawingPixelClipboard,data);
});

test('malformed tile dimensions fail before allocating or decompressing the declared image',async()=>{
  const png=await encodeDrawingPNG(new Uint8ClampedArray(128*64*4),128,64),data=clip([{tx:0,ty:0,png}],{x:0,y:0,width:64,height:64});
  // Any attempt to inflate would throw a different error: the tile dimension
  // contract must reject its header first, including valid oversized PNGs.
  const original=globalThis.DecompressionStream;globalThis.DecompressionStream=class{constructor(){throw Error('Unexpected decompression');}};
  try{await assert.rejects(decodePixelClipboard(data),/dimensions/);await assert.rejects(decodeDrawingPNGBytes(drawingPNGBytes(png),{width:64,height:64}),/dimensions/);}
  finally{globalThis.DecompressionStream=original;}
});

test('clipboard decoding and encoding preflight memory and leave the source intact',async()=>{
  const source=pixels(),before=source.slice(),tiles=await encodeClipboardTiles([{tx:0,ty:0,pixels:source.buffer}]),data=clip(tiles,{x:0,y:0,width:64,height:64});
  await assert.rejects(decodePixelClipboard(data,{maxBytes:TILE_BYTES}),/memory/);
  await assert.rejects(encodeClipboardTiles([{tx:0,ty:0,pixels:source.buffer}],{maxBytes:1}),/memory/);assert.deepEqual(source,before);
});

test('serialized tile index plans sparse paste support and keeps filtering neighbors',()=>{
  const keys=indexedTileCoverage([{tx:-100000,ty:0},{tx:100000,ty:0}],[1,0,0,1,64,0],'nearest');
  assert.equal(keys.size,2);assert.ok(keys.has('-99999,0'));assert.ok(keys.has('100001,0'));assert.ok(!keys.has('0,0'));
  const smooth=indexedTileCoverage([{tx:0,ty:0}],[1,0,0,1,0,0],'smooth');assert.ok(smooth.has('-1,0'));assert.ok(smooth.has('1,0'));
  assert.throws(()=>indexedTileCoverage([{tx:0,ty:0}],[1e9,0,0,1e9,0,0]),/memory/);
});

test('empty sparse selections remain empty without manufacturing a dense image',async()=>{
  const data=clip([],null);assert.equal(validatePixelClipboard(data).pixelBytes,0);assert.equal((await decodePixelClipboard(data)).store.size,0);
});

test('paste reserves one new pixel tile per output when the private destination is empty',()=>{
  const source=new TileStore();for(let tx=0;tx<8;tx++)source.set(tx,0,new Uint8ClampedArray([10,20,30,255]));
  const before=new Map(),maxBytes=source.bytes+8*TILE_BYTES+256*256*4+2048;
  const target=transformTiles(source,[1,0,0,1,640,0],{before,filter:'nearest',maxBytes});
  assert.equal(target.size,8);assert.equal(before.size,8);assert.ok([...before.values()].every(value=>value===null));assert.deepEqual(target.pixel(640,0),[10,20,30,255]);
});

test('tile-aligned translations preserve exact visible bytes and blend existing destination tiles',()=>{
  const source=new TileStore(),input=pixels();source.set(-2,-3,input);source.set(-1,-3,input);
  const target=new TileStore(),existing=new Uint8ClampedArray(TILE_BYTES);existing.set([200,30,10,128],4);target.set(2,-1,existing);
  const before=new Map();transformTiles(source,[1,0,0,1,192,128],{target,before});
  const expected=input.slice();for(let i=0;i<TILE_BYTES;i+=4)if(!expected[i+3])expected.fill(0,i,i+3);
  assert.deepEqual(target.get(1,-1).pixels,expected);assert.deepEqual(source.get(-2,-3).pixels,input);
  assert.equal(before.get('1,-1'),null);assert.deepEqual(before.get('2,-1'),existing);
  // Reference the existing affine sampler using a lattice reflection twice.
  const reflected=transformTiles(source,[-1,0,0,1,0,0]);
  const reference=new TileStore();reference.set(2,-1,existing);
  transformTiles(reflected,[-1,0,0,1,192,128],{target:reference});
  assert.deepEqual(target.get(2,-1).pixels,reference.get(2,-1).pixels);
  assert.throws(()=>transformTiles(source,[1,0,0,1,192,128],{target,maxBytes:1}),/memory/);
  assert.deepEqual(target.get(1,-1).pixels,expected);
});

test('bounded parallel PNG decoding preserves index order and rejects a later invalid tile',async()=>{
  const png=await encodeDrawingPNG(pixels(),64,64),tiles=Array.from({length:24},(_,tx)=>({tx,ty:0,png})),data=clip(tiles,{x:0,y:0,width:24*64,height:64});
  const {store}=await decodePixelClipboard(data);assert.deepEqual([...store].map(t=>t.tx),tiles.map(t=>t.tx));
  tiles[12]={...tiles[12],png:'data:image/png;base64,AAAA'};await assert.rejects(decodePixelClipboard(data),/PNG/);
});
