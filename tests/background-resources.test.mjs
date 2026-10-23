import test from 'node:test';
import assert from 'node:assert/strict';
import {drawBackground,releaseBackgroundResources,backgroundResourceStats} from '../src/pivot/background.mjs';

test('immutable edge backgrounds reuse pixels, invalidate exact placement, and release their owner',()=>{
  const oldCanvas=globalThis.OffscreenCanvas,oldBitmap=globalThis.ImageBitmap;
  const captures=[];
  class Bitmap {constructor(){this.width=this.naturalWidth=16;this.height=this.naturalHeight=12;this.complete=true;}}
  class Surface {constructor(width,height){this.width=width;this.height=height;this.ctx={drawImage:(...args)=>captures.push(args)};}getContext(){return this.ctx;}}
  globalThis.OffscreenCanvas=Surface;globalThis.ImageBitmap=Bitmap;
  const output=[],context={save(){},restore(){},drawImage:(...args)=>output.push(args),canvas:{}},image=new Bitmap();
  const report={backgrounds:[{background_id:1,kind:1}]},frame={background_id:1};
  const resources={image:()=>image,url:()=>'',bounds:{x:-40,y:-30,width:220,height:160},backgroundBytes:1024*1024};
  try {
    drawBackground(context,report,frame,160,120,resources);
    const count=captures.length,surface=output.at(-1)[0];assert.ok(count>1);
    drawBackground(context,report,frame,160,120,resources);
    assert.equal(captures.length,count);assert.equal(output.at(-1)[0],surface);
    drawBackground(context,report,frame,160,120,{...resources,bounds:{...resources.bounds,x:-60}});
    assert.ok(captures.length>count);assert.notEqual(output.at(-1)[0],surface);
    assert.ok(backgroundResourceStats().bytes<=resources.backgroundBytes);
    releaseBackgroundResources(context);assert.deepEqual(backgroundResourceStats(),{bytes:0,entries:0});
    assert.equal(surface.width,1);assert.equal(surface.height,1);
  } finally {releaseBackgroundResources(context);globalThis.OffscreenCanvas=oldCanvas;globalThis.ImageBitmap=oldBitmap;}
});

test('crossfade variants retain independent images and mutable background sources never retain pixels',()=>{
  const oldCanvas=globalThis.OffscreenCanvas,oldBitmap=globalThis.ImageBitmap;let paints=0;
  class Bitmap {constructor(){this.width=this.naturalWidth=16;this.height=this.naturalHeight=12;this.complete=true;}}
  class Surface {constructor(width,height){this.width=width;this.height=height;}getContext(){return {drawImage(){paints++;}};}}
  globalThis.OffscreenCanvas=Surface;globalThis.ImageBitmap=Bitmap;
  const images=[new Bitmap(),new Bitmap()],context={save(){},restore(){},drawImage(){},canvas:{}};
  const report={backgrounds:[{background_id:1,kind:1},{background_id:2,kind:1}]},frame={background_id:1,background_id_b:2,background_mix:128};
  const resources={image:id=>images[id-1],url:bg=>bg.background_id,bounds:{x:-40,y:-30,width:220,height:160},backgroundBytes:1024*1024};
  try {
    drawBackground(context,report,frame,160,120,resources);const first=paints;
    drawBackground(context,report,frame,160,120,resources);assert.equal(paints,first);
    assert.equal(backgroundResourceStats().entries,2);
    releaseBackgroundResources(context);
    const mutable={width:16,height:12,naturalWidth:16,naturalHeight:12,complete:true};
    const live={...resources,image:()=>mutable};
    drawBackground(context,report,{background_id:1},160,120,live);const previous=paints;
    drawBackground(context,report,{background_id:1},160,120,live);assert.ok(paints>previous);
    assert.equal(backgroundResourceStats().bytes,0);
  } finally {releaseBackgroundResources(context);globalThis.OffscreenCanvas=oldCanvas;globalThis.ImageBitmap=oldBitmap;}
});

test('background allowance shrink trims both retained variants before hits and transient draws',()=>{
  const oldCanvas=globalThis.OffscreenCanvas,oldBitmap=globalThis.ImageBitmap,oldDesktop=globalThis.stykDesktop;
  const output=[],paintSizes=[];
  class Bitmap {constructor(){this.width=this.naturalWidth=1024;this.height=this.naturalHeight=1024;this.complete=true;}}
  class Surface {constructor(width,height){this.width=width;this.height=height;}getContext(){return {drawImage:()=>paintSizes.push([this.width,this.height])};}}
  globalThis.OffscreenCanvas=Surface;globalThis.ImageBitmap=Bitmap;globalThis.stykDesktop={memoryBytes:8*1024**3};
  const context={save(){},restore(){},drawImage:(...args)=>output.push(args),canvas:{}},images=[new Bitmap(),new Bitmap()];
  const report={backgrounds:[{background_id:1,kind:1},{background_id:2,kind:1}]},crossfade={background_id:1,background_id_b:2,background_mix:128};
  const resources={image:id=>images[id-1],url:bg=>bg.background_id,bounds:{x:-256,y:-256,width:1024,height:1024},backgroundBytes:8*1024**2};
  const draw=(frame=crossfade,options=resources)=>drawBackground(context,report,frame,1024,1024,options);
  try {
    draw();const first=output.at(-2)[0],second=output.at(-1)[0];
    assert.deepEqual(backgroundResourceStats(),{bytes:8*1024**2,entries:2});
    const paints=paintSizes.length;
    draw({background_id:2},{...resources,backgroundBytes:4*1024**2});
    assert.equal(output.at(-1)[0],second);assert.equal(paintSizes.length,paints,'The remaining variant is still a hit.');
    assert.equal(first.width,1);assert.deepEqual(backgroundResourceStats(),{bytes:4*1024**2,entries:1});
    const mutable={width:1024,height:1024,naturalWidth:1024,naturalHeight:1024,complete:true};
    draw({background_id:1},{...resources,image:()=>mutable,backgroundBytes:0});
    assert.equal(second.width,1);assert.deepEqual(backgroundResourceStats(),{bytes:0,entries:0});
    assert.equal(output.at(-1)[0].width,1,'Mutable working pixels are released after their transient draw.');
    draw();const beforeMiss=output.slice(-2).map(args=>args[0]);
    draw({background_id:1},{...resources,backgroundBytes:0,bounds:{x:-512,y:-512,width:2048,height:2048}});
    assert.deepEqual(backgroundResourceStats(),{bytes:0,entries:0});assert.ok(beforeMiss.every(surface=>surface.width===1));
    assert.ok(paintSizes.some(([width,height])=>width===2048&&height===2048),'Zero retention does not cap the temporary raster.');
    draw();const beforeDirect=output.slice(-2).map(args=>args[0]);
    draw({background_id:1},{...resources,backgroundBytes:0,bounds:{x:0,y:0,width:1024,height:1024}});
    assert.equal(output.at(-1)[0],images[0]);assert.deepEqual(backgroundResourceStats(),{bytes:0,entries:0});assert.ok(beforeDirect.every(surface=>surface.width===1));
  } finally {releaseBackgroundResources(context);globalThis.OffscreenCanvas=oldCanvas;globalThis.ImageBitmap=oldBitmap;if(oldDesktop===undefined)delete globalThis.stykDesktop;else globalThis.stykDesktop=oldDesktop;}
});

test('realm allowance shrink evicts older context pixels before a surviving background hit',()=>{
  const oldCanvas=globalThis.OffscreenCanvas,oldBitmap=globalThis.ImageBitmap,oldDesktop=globalThis.stykDesktop;
  class Bitmap {constructor(){this.width=this.naturalWidth=1024;this.height=this.naturalHeight=1024;this.complete=true;}}
  class Surface {constructor(width,height){this.width=width;this.height=height;}getContext(){return {drawImage(){}};}}
  globalThis.OffscreenCanvas=Surface;globalThis.ImageBitmap=Bitmap;globalThis.stykDesktop={memoryBytes:8*1024**3};
  const outputs=[[],[]],contexts=outputs.map(output=>({save(){},restore(){},drawImage:(...args)=>output.push(args),canvas:{}}));
  const images=[new Bitmap(),new Bitmap()],report={backgrounds:[{background_id:1,kind:1},{background_id:2,kind:1}]};
  const frame={background_id:1,background_id_b:2,background_mix:128},resources={image:id=>images[id-1],url:bg=>bg.background_id,bounds:{x:-256,y:-256,width:1024,height:1024},backgroundBytes:16*1024**2};
  try {
    for(const context of contexts)drawBackground(context,report,frame,1024,1024,resources);
    assert.deepEqual(backgroundResourceStats(),{bytes:16*1024**2,entries:4});
    const discarded=outputs[0].map(args=>args[0]),survivor=outputs[1].at(-1)[0];
    globalThis.stykDesktop={memoryBytes:2*1024**3};
    drawBackground(contexts[1],report,{background_id:2},1024,1024,resources);
    assert.equal(outputs[1].at(-1)[0],survivor);assert.deepEqual(backgroundResourceStats(),{bytes:8*1024**2,entries:2});
    assert.ok(discarded.every(surface=>surface.width===1),'The aggregate follows the smaller hardware plan even on a hit.');
  } finally {for(const context of contexts)releaseBackgroundResources(context);globalThis.OffscreenCanvas=oldCanvas;globalThis.ImageBitmap=oldBitmap;if(oldDesktop===undefined)delete globalThis.stykDesktop;else globalThis.stykDesktop=oldDesktop;}
});
