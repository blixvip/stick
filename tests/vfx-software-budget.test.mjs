import test from 'node:test';
import assert from 'node:assert/strict';
import {withVfx,configureVfxSoftwareResources,vfxSoftwareResourceStats,releaseVfxSurface,releaseVfxSoftwareResources} from '../src/vfx-canvas.mjs';
import {releaseGeometryResources} from '../src/pivot/geometry.mjs';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx} from '../src/vfx.mjs';

function softwareFixture(run){
  const previousCanvas=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData,previousRun=VfxCPU.prototype.runPixels;
  let calls=0;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){
      this.width=width;this.height=height;let matrix={a:1,b:0,c:0,d:1,e:0,f:0};
      this.context={canvas:this,draws:[],getTransform(){return matrix;},setTransform(a,b,c,d,e,f){matrix={a,b,c,d,e,f};},clearRect(){},fillRect(){},save(){},restore(){},
        drawImage(source,...args){this.draws.push({source,width:source.width,height:source.height,args});},
        getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(){}};
    }
    getContext(kind){return kind==='webgl2'?null:this.context;}
  };
  globalThis.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
  VfxCPU.prototype.runPixels=function(pixels,width,height){calls++;return {pixels,width,height};};
  try{
    const stack=[createVfx('blur','blur')],context=()=>new OffscreenCanvas(32,32).getContext('2d');
    const draw=(ctx,cacheHint)=>withVfx(ctx,stack,target=>target.fillRect(3,3,8,8),{bounds:{x:0,y:0,width:16,height:16},cacheHint});
    run({context,draw,calls:()=>calls,stack});
  }finally{releaseVfxSoftwareResources();globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousImageData;VfxCPU.prototype.runPixels=previousRun;}
}

test('software region retention follows owner LRU and releases evicted pixels before replacement',()=>softwareFixture(({context,draw,calls})=>{
  const ctx=context();configureVfxSoftwareResources(ctx,{maxBytes:65536});draw(ctx,'A');
  const bytes=vfxSoftwareResourceStats(ctx).bytes,first=ctx.draws.at(-1).source;assert.ok(bytes>0);
  configureVfxSoftwareResources(ctx,{maxBytes:2*bytes});draw(ctx,'B');const second=ctx.draws.at(-1).source;
  draw(ctx,'A');assert.equal(calls(),2);draw(ctx,'C');
  assert.equal(second.width,1);assert.ok(first.width>1);assert.equal(vfxSoftwareResourceStats(ctx).bytes,2*bytes);
  draw(ctx,'A');assert.equal(calls(),3);draw(ctx,'B');assert.equal(calls(),4);
  configureVfxSoftwareResources(ctx,{maxBytes:0});assert.equal(vfxSoftwareResourceStats(ctx).bytes,0);assert.equal(first.width,1);
  draw(ctx,'B');draw(ctx,'B');assert.equal(calls(),6);
  assert.equal(ctx.draws.at(-1).source.width,1,'An unretained completed result releases storage after compositing.');
  assert.ok(ctx.draws.at(-1).width>1,'The destination receives the full result before its storage is released.');
}));

test('nested scratch shares its root allowance and aggregate retention does not multiply with contexts',()=>softwareFixture(({context,draw})=>{
  const root=context();configureVfxSoftwareResources(root,{maxBytes:65536});draw(root,'root');
  const bytes=vfxSoftwareResourceStats(root).bytes,rootPixels=root.draws.at(-1).source;
  configureVfxSoftwareResources(root,{maxBytes:bytes});const child=context();configureVfxSoftwareResources(child,{owner:root});draw(child,'child');
  assert.equal(rootPixels.width,1);assert.equal(vfxSoftwareResourceStats(root).bytes,bytes);assert.deepEqual(vfxSoftwareResourceStats(child),vfxSoftwareResourceStats(root));
  const childPixels=child.draws.at(-1).source;releaseVfxSurface(root);
  assert.equal(childPixels.width,1,'Closing a root releases retained entries of all its transient children.');
  assert.equal(vfxSoftwareResourceStats(root).bytes,0);
  draw(child,'child');const independent=context();configureVfxSoftwareResources(independent,{maxBytes:bytes});draw(independent,'independent');
  assert.equal(child.draws.at(-1).source.width,1);assert.equal(vfxSoftwareResourceStats().bytes,bytes);
  assert.equal(vfxSoftwareResourceStats(independent).maxBytes,bytes);
  releaseVfxSurface(independent);assert.equal(vfxSoftwareResourceStats().bytes,0);
}));

test('retained export contexts reuse equivalent source regions across tiles and explicit cleanup ends that lifetime',()=>softwareFixture(({context,draw,calls,stack})=>{
  const ctx=context(),paint=target=>target.fillRect(3,3,8,8);
  const options={bounds:{x:0,y:0,width:16,height:16},cacheHint:'same frame',outputRect:{x:0,y:0,width:64,height:32}};
  withVfx(ctx,stack,paint,options);const first=ctx.draws.at(-1).source;
  releaseGeometryResources(ctx,{retainCanvases:true});
  ctx.setTransform(1,0,0,1,-32,0);
  withVfx(ctx,stack,paint,{...options,outputRect:{x:-32,y:0,width:64,height:32}});
  assert.equal(calls(),1,'A shifted export tile samples the same filtered owner source.');
  assert.equal(ctx.draws.at(-1).source,first);assert.ok(first.width>1);
  releaseGeometryResources(ctx);assert.equal(first.width,1);assert.equal(vfxSoftwareResourceStats(ctx).bytes,0);
  ctx.setTransform(1,0,0,1,0,0);draw(ctx,'same frame');assert.equal(calls(),2);
}));

test('zero-retention software compositing releases pixels after destination failure and can recover',()=>softwareFixture(({context,draw})=>{
  const ctx=context();configureVfxSoftwareResources(ctx,{maxBytes:0});const original=ctx.drawImage;
  ctx.drawImage=function(...args){original.apply(this,args);throw Error('Destination unavailable');};
  assert.throws(()=>draw(ctx,'A'),/Destination unavailable/);assert.equal(ctx.draws.at(-1).source.width,1);
  assert.equal(vfxSoftwareResourceStats().bytes,0);ctx.drawImage=original;draw(ctx,'A');assert.ok(ctx.draws.at(-1).width>1);
}));

test('closing the largest configured lifetime immediately shrinks the shared aggregate allowance',()=>softwareFixture(({context,draw})=>{
  const high=context();configureVfxSoftwareResources(high,{maxBytes:65536});draw(high,'high');
  const bytes=vfxSoftwareResourceStats(high).bytes;configureVfxSoftwareResources(high,{maxBytes:3*bytes});
  const first=context(),second=context();configureVfxSoftwareResources(first,{maxBytes:bytes});configureVfxSoftwareResources(second,{maxBytes:bytes});
  draw(first,'first');draw(second,'second');assert.equal(vfxSoftwareResourceStats().bytes,3*bytes);
  releaseVfxSurface(high);
  assert.equal(vfxSoftwareResourceStats().maxBytes,bytes);assert.equal(vfxSoftwareResourceStats().bytes,bytes);
  assert.equal(first.draws.at(-1).source.width,1);assert.ok(second.draws.at(-1).source.width>1);
}));
