import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {VfxGPU} from '../src/vfx-gpu.mjs';
import {VfxWebGPU} from '../src/vfx-webgpu.mjs';
import {createVfx} from '../src/vfx.mjs';

const blur=()=>{const effect=createVfx('blur','blur');effect.params.radius=1.1;return effect;};

test('Gaussian blur keeps its pixel dimensions and translation at fractional origins without downsampling',()=>{
  const width=12,height=9,pixels=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<pixels.length;i+=4)pixels.set([i%128,i%96,i%64,128],i);
  const glow=createVfx('glow','glow');glow.params.radius=.7;
  for(const stack of [[blur()],[glow,blur()]]){
    const cpu=new VfxCPU();
    try{
      const expected=cpu.runPixels(pixels,width,height,stack,{scale:2.17}).pixels.slice();
      for(const origin of [{x:.37,y:-.61},{x:-13.37,y:14.61}]){
        const result=cpu.runPixels(pixels,width,height,stack,{scale:2.17,origin});
        assert.equal(result.width,width);assert.equal(result.height,height);
        assert.equal(result.pixels.length,width*height*4,'ImageData receives exactly the advertised RGBA extent.');
        assert.deepEqual(result.pixels,expected,'An ordinary blur does not shift or rescale when its global origin is fractional.');
      }
    }finally{cpu.destroy();}
  }
});

test('both graphics Gaussian schedulers retain the original extent at fractional origins',()=>{
  const previous={canvas:globalThis.OffscreenCanvas,stage:globalThis.GPUShaderStage,texture:globalThis.GPUTextureUsage,buffer:globalThis.GPUBufferUsage};
  const gl=new Proxy({getParameter(){return 4096;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){}};}},{get(target,key){return target[key]??(()=>({}));}});
  globalThis.OffscreenCanvas=class {constructor(width,height){this.width=width;this.height=height;}getContext(){return gl;}};
  globalThis.GPUShaderStage={FRAGMENT:1};globalThis.GPUTextureUsage={TEXTURE_BINDING:1,COPY_SRC:2,COPY_DST:4,RENDER_ATTACHMENT:8};globalThis.GPUBufferUsage={UNIFORM:1,COPY_DST:2};
  const empty=()=>({}),texture=()=>({createView:empty,destroy(){}});
  const renderPass=()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}});
  const device={limits:{maxTextureDimension2D:4096},createShaderModule:empty,createBindGroupLayout:empty,createPipelineLayout:empty,createSampler:empty,createRenderPipeline:empty,createBindGroup:empty,createTexture:texture,
    createBuffer({size}){return {size,destroy(){}};},createCommandEncoder(){return {beginRenderPass:renderPass,copyTextureToTexture(){},finish:empty};},queue:{submit(){},copyExternalImageToTexture(){},writeBuffer(){}}};
  const gpu=new VfxGPU(),webgpu=new VfxWebGPU(device);
  try{
    const source=new OffscreenCanvas(12,9),options={origin:{x:.37,y:-.61},scale:2.17};
    gpu.run(source,[blur()],options);webgpu.run(source,[blur()],{...options,texture:true});
    for(const executor of [gpu,webgpu])for(const slot of executor.slots)if(slot){assert.equal(slot.width,12);assert.equal(slot.height,9);}
  }finally{gpu.destroy();webgpu.destroy();globalThis.OffscreenCanvas=previous.canvas;globalThis.GPUShaderStage=previous.stage;globalThis.GPUTextureUsage=previous.texture;globalThis.GPUBufferUsage=previous.buffer;}
});
