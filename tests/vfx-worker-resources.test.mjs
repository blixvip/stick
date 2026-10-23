import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxGPU,filterVfxCanvas,vfxSurfaceDimension,withVfxWorkerResources,releaseVfxGPU,vfxSourcePadding} from '../src/vfx-gpu.mjs';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx,activeVfx,vfxWorkingSlots,vfxPadding,vfxSamplingPadding,VFX_REGISTRY} from '../src/vfx.mjs';
import {capturePreviewRaster,planPreviewRaster,planPreviewRasterResources} from '../src/renderer-raster-capture.mjs';

function graphics(){
  return new Proxy({getParameter(){return 4096;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){}};}},{get(target,key){return target[key]??(()=>({}));}});
}

test('worker footprint includes the actual retained slots of both native executors',()=>{
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {constructor(width,height){this.width=width;this.height=height;}getContext(){return graphics();}};
  try{
    const types=['tint','grade','blur','glow','shadow','outline','pixelate','noise','vignette','dissolve','rgbSplit','turbulence','wave','shockwave','bloom','lightSweep','crt'];
    const stacks=[];
    for(const type of types)for(const mode of [0,1,2])for(const effectStrength of [1,.6]){
      const effect=createVfx(type,type);
      if(Object.hasOwn(effect.params,'mode'))effect.params.mode=Math.min(mode,VFX_REGISTRY[type].params.mode.max);
      effect.params.effectStrength=effectStrength;
      if(type==='grade')effect.params.exposure=1;
      stacks.push([effect]);
    }
    stacks.push([createVfx('glow','glow'),createVfx('bloom','bloom'),createVfx('blur','blur')]);
    for(const stack of stacks){
      if(!activeVfx(stack).length)continue;
      const gpu=new VfxGPU(),cpu=new VfxCPU(),bound=vfxWorkingSlots(stack,2.1);
      try{
        gpu.run(new OffscreenCanvas(8,6),stack,{scale:2.1});
        cpu.runPixels(new Uint8ClampedArray(8*6*4),8,6,stack,{scale:2.1});
        for(let i=0;i<gpu.slots.length;i++)if(gpu.slots[i])assert.ok(bound.gpu.includes(i),`${stack[0].type}: GPU slot ${i}`);
        for(let i=0;i<cpu.slots.length;i++)if(cpu.slots[i])assert.ok(bound.cpu.includes(i),`${stack[0].type}: CPU slot ${i}`);
        assert.equal(cpu._screen,null,'The native software schedule never allocates a screen copy.');
      }finally{gpu.destroy();cpu.destroy();}
    }
    const directional=createVfx('blur','directional');directional.params.mode=1;
    assert.deepEqual(vfxWorkingSlots([directional],25),{gpu:[0,1],cpu:[0,1]});
  }finally{globalThis.OffscreenCanvas=previous;}
});

test('worker GPU failure releases textures before CPU pixels and keeps a bounded route without retry',()=>{
  const previous=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData;
  const run=VfxGPU.prototype.run,destroy=VfxGPU.prototype.destroy,cpuRun=VfxCPU.prototype.run;
  const events=[];let gpuRuns=0,softwareRuns=0;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(kind){return kind==='webgl2'?graphics():{getImageData:(x,y,width,height)=>({data:new Uint8ClampedArray(width*height*4)}),putImageData(){}};}
  };
  globalThis.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
  VfxGPU.prototype.run=function(){gpuRuns++;events.push('GPU failure');this.slot(0,8,6);throw Error('Context lost');};
  VfxGPU.prototype.destroy=function(){events.push('GPU release');return destroy.call(this);};
  VfxCPU.prototype.run=function(...args){softwareRuns++;events.push('CPU allocation');return cpuRun.apply(this,args);};
  try{
    const source=new OffscreenCanvas(8,6),effect=createVfx('blur','directional');effect.params.mode=1;
    withVfxWorkerResources(()=>{
      assert.equal(vfxSurfaceDimension(),4096);
      filterVfxCanvas(source,[effect],{scale:1});
      assert.equal(vfxSurfaceDimension(),4096,'Capability remains stable after GPU storage is released.');
      filterVfxCanvas(source,[effect],{scale:1});
      assert.throws(()=>withVfxWorkerResources(()=>{}),/concurrently/);
    });
    assert.deepEqual(events.slice(0,4),['GPU failure','GPU release','CPU allocation','CPU allocation']);
    assert.equal(gpuRuns,1);assert.equal(softwareRuns,2);
    filterVfxCanvas(source,[effect],{scale:1});
    assert.equal(gpuRuns,2,'Ordinary calls preserve their existing GPU retry policy.');
  }finally{releaseVfxGPU();globalThis.OffscreenCanvas=previous;globalThis.ImageData=previousImageData;VfxGPU.prototype.run=run;VfxGPU.prototype.destroy=destroy;VfxCPU.prototype.run=cpuRun;}
});

test('capture closes its completed bitmap if executor cleanup throws and recovers the next job',()=>{
  const previous=globalThis.OffscreenCanvas,run=VfxGPU.prototype.run,releasePixels=VfxGPU.prototype.releasePixels;let closed=0;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){
      this.width=width;this.height=height;let matrix=[1,0,0,1,0,0];
      this.context=new Proxy({canvas:this,isContextLost(){return false;},getContextAttributes(){return {willReadFrequently:true};},setTransform(...values){matrix=values.length===1?[values[0].a,values[0].b,values[0].c,values[0].d,values[0].e,values[0].f]:values;},getTransform(){return Object.fromEntries(['a','b','c','d','e','f'].map((key,index)=>[key,matrix[index]]));}},{get(target,key){return target[key]??(()=>{});}});
    }
    getContext(type){return type==='webgl2'?graphics():this.context;}
    transferToImageBitmap(){return {width:this.width,height:this.height,close(){closed++;}};}
  };
  VfxGPU.prototype.run=function(source){this.canvas.width=source.width;this.canvas.height=source.height;return this.canvas;};
  VfxGPU.prototype.releasePixels=function(){releasePixels.call(this);throw Error('Executor cleanup failed');};
  try{
    const effect=createVfx('blur','directional');effect.params.mode=1;
    const geometry={drawables:[{type:'line',slot:0,opacity:1,alpha:1,rgb:[0,0,0],thickness:0,bend:0,points:[{x:0,y:0},{x:4,y:4}],start:{x:0,y:0},end:{x:4,y:4},obj:{scale:1,_stykVfx:{figure:[effect]}},seg:{segment_kind:'line'}}]};
    const options={width:16,height:16,matrix:[1,0,0,1,0,0],maxBytes:1024*1024};
    assert.throws(()=>capturePreviewRaster(geometry,options),/Executor cleanup failed/);
    assert.equal(closed,1,'The unpublished completed bitmap is closed exactly once.');
    VfxGPU.prototype.releasePixels=releasePixels;
    const recovered=capturePreviewRaster(geometry,options);recovered.bitmap.close();
    assert.equal(closed,2);assert.equal(recovered.width,16);
  }finally{VfxGPU.prototype.run=run;VfxGPU.prototype.releasePixels=releasePixels;releaseVfxGPU();globalThis.OffscreenCanvas=previous;}
});

test('completed worker captures keep shader programs warm while releasing every large pixel owner',()=>{
  const previous=globalThis.OffscreenCanvas,contexts=[],events=[];
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(kind){
      assert.equal(kind,'webgl2');const canvas=this,gl=graphics();
      for(const method of ['createProgram','deleteProgram','deleteTexture','framebufferTexture2D','bindTexture']){
        const existing=gl[method];gl[method]=function(...args){events.push({method,args});return existing.apply(this,args);};
      }
      gl.getExtension=()=>({loseContext(){events.push({method:'loseContext'});}});contexts.push({canvas,gl});return gl;
    }
  };
  try{
    releaseVfxGPU();const effect=createVfx('blur','warm'),source=new OffscreenCanvas(32,24);
    const capture=()=>withVfxWorkerResources(()=>filterVfxCanvas(source,[effect],{scale:1}));
    capture();assert.equal(contexts.length,1);
    const programs=events.filter(event=>event.method==='createProgram').length;
    assert.ok(programs>0);assert.equal(events.filter(event=>event.method==='deleteProgram').length,0);
    assert.equal(contexts[0].canvas.width,1);assert.equal(contexts[0].canvas.height,1);
    assert.ok(events.some(event=>event.method==='framebufferTexture2D'&&event.args[3]===null));
    assert.ok(events.filter(event=>event.method==='bindTexture'&&event.args[1]===null).length>=3);
    const firstReleased=events.filter(event=>event.method==='deleteTexture').length;assert.ok(firstReleased>=3);
    source.width=16;source.height=8;capture();
    assert.equal(contexts.length,1,'The next capture reuses the graphics context.');
    assert.equal(events.filter(event=>event.method==='createProgram').length,programs,'Compiled programs are reused.');
    assert.equal(events.filter(event=>event.method==='deleteTexture').length,2*firstReleased,'Both captures release their complete slot storage.');
    assert.throws(()=>withVfxWorkerResources(()=>{vfxSurfaceDimension();throw Error('Painting failed');}),/Painting failed/);
    assert.equal(events.filter(event=>event.method==='loseContext').length,1,'An unsuccessful capture releases the complete executor.');
    capture();assert.equal(contexts.length,2,'A failed capture recovers with a fresh context.');
    releaseVfxGPU();assert.equal(events.filter(event=>event.method==='loseContext').length,2);
    assert.equal(events.filter(event=>event.method==='deleteProgram').length,programs*2);
  }finally{releaseVfxGPU();globalThis.OffscreenCanvas=previous;}
});

test('capture forwards its actual device admission policy to native filter source allocation',()=>{
  const previous=globalThis.OffscreenCanvas,run=VfxGPU.prototype.run,observed=[];let limit=4096;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){
      this.width=width;this.height=height;let matrix=[1,0,0,1,0,0];
      this.context=new Proxy({canvas:this,isContextLost(){return false;},getContextAttributes(){return {willReadFrequently:true};},setTransform(...values){matrix=values.length===1?[values[0].a,values[0].b,values[0].c,values[0].d,values[0].e,values[0].f]:values;},getTransform(){return Object.fromEntries(['a','b','c','d','e','f'].map((key,index)=>[key,matrix[index]]));}},{get(target,key){return target[key]??(()=>{});}});
    }
    getContext(kind){if(kind!=='webgl2')return this.context;const gl=graphics();gl.getParameter=()=>limit;return gl;}
    transferToImageBitmap(){return {width:this.width,height:this.height,close(){}};}
  };
  VfxGPU.prototype.run=function(source,stack,options){observed.push({width:source.width,padding:vfxSourcePadding(stack,options.scale)});this.canvas.width=source.width;this.canvas.height=source.height;return this.canvas;};
  try{
    const effect=createVfx('blur','native-source');effect.params.radius=1;
    const geometry={drawables:[{type:'line',slot:0,opacity:1,alpha:1,rgb:[0,0,0],thickness:1,bend:0,points:[{x:0,y:0},{x:200,y:0}],start:{x:0,y:0},end:{x:200,y:0},obj:{scale:1,_stykVfx:{figure:[effect]}},seg:{segment_kind:'line'}}]};
    const options={width:2000,height:16,matrix:[10,0,0,10,.37,.61],maxBytes:1024*1024*1024},native=planPreviewRaster(geometry,options);
    assert.equal(native.nativePadding,true);
    releaseVfxGPU();capturePreviewRaster(geometry,options).bitmap.close();
    assert.deepEqual(observed.pop(),{width:2064,padding:vfxPadding([effect],10)});
    limit=2048;releaseVfxGPU();capturePreviewRaster(geometry,options).bitmap.close();
    assert.deepEqual(observed.pop(),{width:2040,padding:vfxSamplingPadding([effect],10)},'A smaller actual device selects its admitted sampling halo.');
    limit=4096;releaseVfxGPU();capturePreviewRaster(geometry,{...options,maxBytes:native.workingBytes-1}).bitmap.close();
    assert.deepEqual(observed.pop(),{width:2040,padding:vfxSamplingPadding([effect],10)},'Memory pressure selects the same admitted sampling halo.');
  }finally{VfxGPU.prototype.run=run;releaseVfxGPU();globalThis.OffscreenCanvas=previous;}
});

test('preflight reports actual private capability costs before drawing pixels are allocated',()=>{
  const previous=globalThis.OffscreenCanvas,allocations=[];let available=true;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){allocations.push([width,height]);this.width=width;this.height=height;}
    getContext(kind){assert.equal(kind,'webgl2');return available?graphics():null;}
  };
  try{
    const effect=createVfx('blur','planned-drawing');effect.params.mode=1;
    const geometry={drawables:[{type:'image',slot:0,opacity:1,obj:{scale:1,_stykVfx:{figure:[effect]}},fig:{_styk:{drawing:{version:2,celId:'cel',revision:3}}}}]};
    const options={width:64,height:64,matrix:[1,0,0,1,0,0],maxBytes:1024*1024,allowDrawings:true,nativePadding:true};
    releaseVfxGPU();
    const cheap=planPreviewRaster(geometry,options),gpu=planPreviewRasterResources(geometry,options);
    assert.equal(gpu.workingBytes,cheap.workingBytes);assert.deepEqual(allocations,[[1,1]]);
    releaseVfxGPU();available=false;
    const software=planPreviewRasterResources(geometry,options);
    assert.equal(software.workingBytes,planPreviewRaster(geometry,{...options,regionCaches:true}).workingBytes);
    assert.ok(software.workingBytes>gpu.workingBytes,'Missing GPU includes retained software-region pixels.');
    const count=allocations.length;
    assert.throws(()=>planPreviewRasterResources(geometry,{...options,maxBytes:cheap.workingBytes-1}),error=>error.code==='preview_raster_budget');
    assert.equal(allocations.length,count,'Rejected cheap admission does not discover graphics capability.');
    assert.ok(allocations.every(([w,h])=>w===1&&h===1));
  }finally{releaseVfxGPU();globalThis.OffscreenCanvas=previous;}
});
