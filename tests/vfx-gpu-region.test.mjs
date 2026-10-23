import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxGPU,releaseVfxGPU} from '../src/vfx-gpu.mjs';
import {VfxWebGPU} from '../src/vfx-webgpu.mjs';
import {withVfx} from '../src/vfx-canvas.mjs';
import {createVfx} from '../src/vfx.mjs';

/** A recording WebGL2 stand-in: every call succeeds and is listed. */
function graphics(events){
  const base={getParameter(){return 4096;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){}};}};
  return new Proxy(base,{get(target,key){return target[key]??((...args)=>{events.push({method:key,args});return {};});}});
}
function install(t,events,sizes){
  const previous=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this._width=width;this._height=height;}
    get width(){return this._width;}set width(value){if(this.gl)sizes.push(['width',value]);this._width=value;}
    get height(){return this._height;}set height(value){if(this.gl)sizes.push(['height',value]);this._height=value;}
    getContext(kind){assert.equal(kind,'webgl2');return this.gl=graphics(events);}
  };
  t.after(()=>{releaseVfxGPU();globalThis.OffscreenCanvas=previous;});
}
const blur=()=>{const effect=createVfx('blur','blur');effect.params.radius=3;return effect;};

test('the region route grows the drawing buffer in steps and never shrinks it for a smaller figure',t=>{
  const events=[],sizes=[];install(t,events,sizes);
  const gpu=new VfxGPU();
  try{
    const expected=[[640,512,768,512],[608,544,768,768],[700,96,768,768],[300,200,768,768],[900,40,1024,768]];
    for(const [width,height,canvasWidth,canvasHeight] of expected){
      const result=gpu.run({width,height},[blur()],{scale:1,region:true});
      assert.equal(result.canvas,gpu.canvas);
      assert.deepEqual([gpu.canvas.width,gpu.canvas.height],[canvasWidth,canvasHeight]);
      // WebGL draws bottom-up: the result is the lower-left of the canvas image.
      assert.deepEqual([result.x,result.y,result.width,result.height],[0,canvasHeight-height,width,height]);
      const viewport=events.filter(event=>event.method==='viewport').at(-1).args;
      assert.deepEqual(viewport,[0,0,width,height]);
    }
    assert.deepEqual(sizes,[['width',768],['height',512],['height',768],['width',1024]],'Five figures resize the drawing buffer three times, not ten.');
    assert.equal(events.filter(event=>event.method==='readPixels').length,0);
    gpu.releasePixels();assert.deepEqual([gpu.canvas.width,gpu.canvas.height],[1,1],'A quiet period releases the grown buffer.');
  }finally{gpu.destroy();}
});

test('the canvas route keeps presenting on a drawing buffer of the surface size',t=>{
  const events=[],sizes=[];install(t,events,sizes);
  const gpu=new VfxGPU();
  try{
    const result=gpu.run({width:64,height:48},[blur()],{scale:1});
    assert.equal(result,gpu.canvas);assert.deepEqual(sizes,[['width',64],['height',48]]);
  }finally{gpu.destroy();}
});

test('Canvas effects copy only the filtered region and keep the established source surface',t=>{
  const events=[],sizes=[];install(t,events,sizes);
  const run=VfxGPU.prototype.run,requests=[];
  const executorCanvas={width:1024,height:768};
  VfxGPU.prototype.run=function(source,stack,options){requests.push(options.region);return {canvas:executorCanvas,x:0,y:768-source.height,width:source.width,height:source.height};};
  t.after(()=>{VfxGPU.prototype.run=run;});
  const sources=[];
  const Canvas=globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas=class extends Canvas{getContext(kind,options){if(kind==='webgl2')return super.getContext(kind);sources.push(options);return {setTransform(){},clearRect(){},canvas:this};}};
  t.after(()=>{globalThis.OffscreenCanvas=Canvas;});
  const draws=[];
  const destination=attributes=>({canvas:{width:64,height:48},getContextAttributes:()=>attributes,getTransform:()=>({a:1,b:0,c:0,d:1,e:0,f:0}),save(){},restore(){},setTransform(){},drawImage(...args){draws.push(args);}});
  const bounds={x:8,y:8,width:20,height:16};
  withVfx(destination({willReadFrequently:true}),[blur()],()=>{},{bounds});
  withVfx(destination(undefined),[blur()],()=>{},{bounds});
  assert.deepEqual(requests,[true,true]);
  assert.deepEqual(sources,[undefined,undefined],'Software and accelerated destinations share one source policy, as worker captures do.');
  assert.equal(draws.length,2);
  for(const [image,sx,sy,w,h,,,dw,dh] of draws){
    assert.equal(image,executorCanvas);
    assert.deepEqual([sx,sy,dw,dh],[0,768-h,w,h],'The copy reads the lower-left result at its own size.');
  }
});

test('effect pipelines compile ahead of first use without replacing one created on demand',async t=>{
  const names=['GPUShaderStage','GPUTextureUsage','GPUBufferUsage'],previous=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:new Proxy({},{get:()=>1})});
  t.after(()=>names.forEach((name,index)=>{if(previous[index])Object.defineProperty(globalThis,name,previous[index]);else delete globalThis[name];}));
  const created=[],pending=[];
  const empty=()=>({}),texture=()=>({createView:empty,destroy(){}});
  const device={limits:{maxTextureDimension2D:4096},createShaderModule:empty,createBindGroupLayout:empty,createPipelineLayout:empty,createSampler:empty,createBindGroup:empty,createTexture:texture,
    createBuffer:()=>({size:65536,destroy(){}}),
    createRenderPipeline(descriptor){const pipeline={sync:descriptor.fragment.constants.operation};created.push(pipeline);return pipeline;},
    createRenderPipelineAsync(descriptor){return new Promise((resolve,reject)=>pending.push({operation:descriptor.fragment.constants.operation,resolve,reject}));}};
  const gpu=new VfxWebGPU(device);
  const onDemand=gpu.pipeline(3);
  gpu.prewarm();gpu.prewarm();
  assert.equal(pending.length,27,'Every other operation is requested once.');
  assert.ok(pending.every(request=>request.operation!==3));
  assert.equal(gpu.pipeline(7).sync,7,'A pipeline needed before its warm copy arrives is created on demand.');
  for(const request of pending){if(request.operation===9)request.reject(new Error('lost'));else request.resolve({warm:request.operation});}
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(gpu.pipeline(3),onDemand);assert.equal(gpu.pipeline(7).sync,7);
  assert.equal(gpu.pipeline(16).warm,16,'A warm pipeline needs no compilation at first use.');
  assert.equal(gpu.pipeline(9).sync,9,'A failed warm request falls back to on-demand creation.');
  assert.equal(created.length,3);
  const late=new VfxWebGPU(device);pending.length=0;late.prewarm();late.destroy();
  for(const request of pending)request.resolve({warm:request.operation});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(late.pipelines.size,0,'A destroyed executor keeps nothing that arrives late.');
});
