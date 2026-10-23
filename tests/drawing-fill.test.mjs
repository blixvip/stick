import test from 'node:test';
import assert from 'node:assert/strict';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {applyTileChanges} from '../src/drawing-pixels.mjs';
import {floodTiles} from '../src/drawing-fill.mjs';

test('a small enclosed fill is independent of distant artwork bounds',()=>{
  const store=new TileStore(),ink=[20,30,40,255];
  for(let y=-8;y<=8;y++)for(let x=-8;x<=8;x++)if(Math.abs(x)===8||Math.abs(y)===8)store.writable(Math.floor(x/64),Math.floor(y/64)).pixels.set(ink,(((y%64+64)%64)*64+(x%64+64)%64)*4);
  store.set(20000,20000,new Uint8ClampedArray(ink));const before=store.readRect(-10,-10,21,21);
  const changes=floodTiles(store,{x:0,y:0,color:[255,60,20,255],tolerance:0,bounds:{x:-10,y:-10,width:1280074,height:1280074},maxBytes:1024*1024});
  assert.equal(changes.length,4);assert.deepEqual(store.pixel(0,0),[255,60,20,255]);assert.deepEqual(store.pixel(9,0),[0,0,0,0]);assert.deepEqual(store.pixel(1280000,1280000),ink);
  applyTileChanges(store,changes,'before');assert.deepEqual(store.readRect(-10,-10,21,21),before);
  applyTileChanges(store,changes,'after');assert.deepEqual(store.pixel(0,0),[255,60,20,255]);
});

// Independent dense reference: a pixel queue and repeated four-neighbour
// morphology, intentionally separate from the tile/scanline implementation.
function reference(pixels,width,height,{x,y,color,tolerance=0,gap=0,expansion=0,source=pixels}){
  const count=width*height,origin=(y*width+x)*4,rgba=source.slice(origin,origin+4),eligible=new Uint8Array(count);
  for(let p=0;p<count;p++){const i=p*4,a=source[i+3]/255,ta=rgba[3]/255;eligible[p]=+(Math.abs(source[i]*a-rgba[0]*ta)<=tolerance&&Math.abs(source[i+1]*a-rgba[1]*ta)<=tolerance&&Math.abs(source[i+2]*a-rgba[2]*ta)<=tolerance&&Math.abs(source[i+3]-rgba[3])<=tolerance);}
  const neighbors=p=>[p%width?p-1:-1,p%width+1<width?p+1:-1,p>=width?p-width:-1,p+width<count?p+width:-1].filter(n=>n>=0);
  function grow(mask,n){for(let step=0;step<n;step++){const next=mask.slice();for(let p=0;p<count;p++)if(mask[p])for(const q of neighbors(p))next[q]=1;mask=next;}return mask;}
  const blocked=grow(eligible.map(n=>1-n),gap),selected=new Uint8Array(count),queue=[];const start=y*width+x;
  if(eligible[start]&&!blocked[start]){selected[start]=1;queue.push(start);}
  for(let n=0;n<queue.length;n++)for(const p of neighbors(queue[n]))if(eligible[p]&&!blocked[p]&&!selected[p]){selected[p]=1;queue.push(p);}
  const mask=grow(selected,gap+expansion),out=pixels.slice();for(let p=0;p<count;p++)if(mask[p])out.set(color,p*4);return out;
}

test('tile boundaries, negative origins, tolerance and morphology match an independent pixel fill',()=>{
  let seed=913;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const width=79,height=73,bounds={x:-39,y:51,width,height};
  for(let run=0;run<30;run++){
    const pixels=new Uint8ClampedArray(width*height*4),source=new Uint8ClampedArray(pixels.length);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      // Joined rooms, a narrow leak, soft edges and invisible RGB cross tiles.
      const wall=(x===43&&y!==32)||(y===44&&x>12&&x<69),noise=random()<.025;
      const rgba=wall?[18,22,30,255]:noise?[20,60,120,run%2?90:0]:[40,80,120,0];
      pixels.set(rgba,(y*width+x)*4);source.set(wall?[0,0,0,255]:[20,50,90,0],(y*width+x)*4);
    }
    const store=new TileStore();store.writeRect(bounds.x,bounds.y,width,height,pixels);store.set(5,5,new Uint8ClampedArray([7,8,9,255]));
    const options={x:run%2?60:10,y:run%2?54:12,color:[120,20,60,190],tolerance:[0,16,100,255][run%4],gap:[0,1,2,8,0][run%5],expansion:[0,1,4,16,2][run%5],...(run%3===0?{source}: {})};
    const expected=reference(pixels,width,height,options),changes=floodTiles(store,{...options,x:options.x+bounds.x,y:options.y+bounds.y,bounds});
    assert.deepEqual(store.readRect(bounds.x,bounds.y,width,height),expected,`case ${run}`);assert.deepEqual(store.pixel(320,320),[7,8,9,255]);
    applyTileChanges(store,changes,'before');assert.deepEqual(store.readRect(bounds.x,bounds.y,width,height),pixels,`undo ${run}`);
    applyTileChanges(store,changes,'after');assert.deepEqual(store.readRect(bounds.x,bounds.y,width,height),expected,`redo ${run}`);
  }
});

test('sparse fill budget rejection is atomic, including shared source tiles',()=>{
  const store=new TileStore();store.set(0,0,new Uint8ClampedArray([1,2,3,0]));const sibling=store.fork(),before=store.get(0,0);
  assert.throws(()=>floodTiles(store,{x:0,y:0,color:[1,2,3,255],bounds:{x:0,y:0,width:200000,height:200000},maxBytes:8*TILE_BYTES}),/memory/);
  assert.equal(store.size,1);assert.equal(store.get(0,0),before);assert.equal(sibling.get(0,0),before);assert.deepEqual(store.pixel(1,1),[1,2,3,0]);
});

test('invalid fill coordinates and source lengths fail before changing pixels',()=>{
  const store=new TileStore(),bounds={x:0,y:0,width:16,height:16};
  for(const options of [{x:NaN,y:0},{x:0,y:Infinity},{x:0,y:0,source:new Uint8ClampedArray(4)},{x:0,y:0,bounds:{...bounds,width:Infinity}}])assert.throws(()=>floodTiles(store,{bounds,...options}),/Invalid fill/);
  assert.equal(store.size,0);
});

test('an open sparse flood stops exploring when its future output exceeds the budget',()=>{
  const store=new TileStore();store.set(20000,20000,new Uint8ClampedArray([20,40,60,255]));let reads=0;
  const get=store.get.bind(store);store.get=(...args)=>{reads++;return get(...args);};
  assert.throws(()=>floodTiles(store,{x:0,y:0,color:[255,0,0,255],bounds:{x:0,y:0,width:1280064,height:1280064},maxBytes:1024*1024}),/working memory/);
  assert.ok(reads<300,`Only affordable output tiles should be explored, saw ${reads}`);assert.equal(store.size,1);assert.deepEqual(store.pixel(1280000,1280000),[20,40,60,255]);
});
