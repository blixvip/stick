import test from 'node:test';
import assert from 'node:assert/strict';
import {filterVfxCanvas,releaseVfxGPU} from '../src/vfx-gpu.mjs';
import {VfxWebGPU} from '../src/vfx-webgpu.mjs';
import {createVfx} from '../src/vfx.mjs';

const blur=()=>{const effect=createVfx('blur','blur');effect.params.radius=3;return effect;};
function enums(t){
  const names=['GPUShaderStage','GPUTextureUsage','GPUBufferUsage'],previous=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:new Proxy({},{get:()=>1})});
  t.after(()=>names.forEach((name,index)=>{if(previous[index])Object.defineProperty(globalThis,name,previous[index]);else delete globalThis[name];}));
}

test('a quiet WebGPU effect executor releases its working textures and keeps its pipelines',t=>{
  enums(t);t.mock.timers.enable({apis:['setTimeout']});
  const previous=globalThis.OffscreenCanvas;globalThis.OffscreenCanvas=class {constructor(width,height){this.width=width;this.height=height;}};
  t.after(()=>{globalThis.OffscreenCanvas=previous;});
  const textures=[],pipelines=[];
  const empty=()=>({}),renderPass=()=>({setPipeline(){},setBindGroup(){},draw(){},end(){}});
  const device={limits:{maxTextureDimension2D:4096},createShaderModule:empty,createBindGroupLayout:empty,createPipelineLayout:empty,createSampler:empty,createBindGroup:empty,
    createTexture({label}){const texture={label,destroyed:false,createView:empty,destroy(){this.destroyed=true;}};textures.push(texture);return texture;},
    createRenderPipeline(){const pipeline={};pipelines.push(pipeline);return pipeline;},
    createBuffer:({size})=>({size,destroy(){}}),createCommandEncoder:()=>({beginRenderPass:renderPass,copyTextureToTexture(){},finish:empty}),
    queue:{submit(){},copyExternalImageToTexture(){},writeBuffer(){}}};
  const gpu=new VfxWebGPU(device),working=()=>textures.filter(texture=>texture.label?.startsWith('VFX slot')&&!texture.destroyed).length;
  gpu.run({width:64,height:48},[blur()],{texture:true});
  const compiled=pipelines.length;
  assert.ok(working()>0&&compiled>0);
  t.mock.timers.tick(29000);
  gpu.run({width:64,height:48},[blur()],{texture:true});
  t.mock.timers.tick(29000);
  assert.ok(working()>0,'Use within the quiet period keeps the working textures.');
  t.mock.timers.tick(1000);
  assert.equal(working(),0,'Every caller shares the release, not only Canvas filtering.');
  gpu.run({width:64,height:48},[blur()],{texture:true});
  assert.ok(working()>0);assert.equal(pipelines.length,compiled,'Compiled pipelines survive the quiet period.');
  gpu.destroy();t.mock.timers.tick(60000);
  assert.equal(working(),0);
});

test('a quiet WebGL effect executor keeps its context and compiled programs',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let now=1000;t.mock.method(performance,'now',()=>now);
  const events=[],previous=globalThis.OffscreenCanvas;
  const graphics=()=>new Proxy({getParameter(){return 4096;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){events.push('loseContext');}};}},
    {get(target,key){return target[key]??((...args)=>{events.push(key);return {};});}});
  let contexts=0;
  globalThis.OffscreenCanvas=class {constructor(width,height){this.width=width;this.height=height;}getContext(){contexts++;return graphics();}};
  t.after(()=>{releaseVfxGPU();globalThis.OffscreenCanvas=previous;});
  releaseVfxGPU();events.length=0;
  const source=new OffscreenCanvas(32,24),count=name=>events.filter(event=>event===name).length;
  filterVfxCanvas(source,[blur()],{scale:1});
  const programs=count('createProgram');assert.ok(programs>0);assert.equal(contexts,1);
  now+=30001;t.mock.timers.tick(30001);
  assert.ok(count('deleteTexture')>0,'Working textures are released.');
  assert.equal(count('deleteProgram'),0);assert.equal(count('loseContext'),0);
  filterVfxCanvas(source,[blur()],{scale:1});
  assert.equal(contexts,1,'The next effect reuses the context.');
  assert.equal(count('createProgram'),programs,'Nothing compiles again after a quiet period.');
  now+=30001;t.mock.timers.tick(30001);
  assert.equal(count('deleteProgram'),0,'The release is scheduled again after later use.');
});

test('a software presenter compiles the remaining effect programs one per task before they are needed',async t=>{
  const {VfxGPU}=await import('../src/vfx-gpu.mjs');
  const events=[],previous=globalThis.OffscreenCanvas;
  const gl=new Proxy({getParameter(){return 4096;},getShaderParameter(){return true;},getProgramParameter(){return true;},isContextLost(){return false;},getExtension(){return {loseContext(){}};}},
    {get(target,key){return target[key]??((...args)=>{events.push(key);return {};});}});
  globalThis.OffscreenCanvas=class {constructor(width,height){this.width=width;this.height=height;}getContext(){return gl;}};
  t.after(()=>{globalThis.OffscreenCanvas=previous;});
  const gpu=new VfxGPU(),tasks=[],schedule=task=>tasks.push(task);
  gpu.program(3);const onDemand=gpu.programs.get(3);
  gpu.prewarm(schedule);gpu.prewarm(schedule);
  assert.equal(tasks.length,1,'Repeated requests share one sequence.');
  let steps=0;
  while(tasks.length){const before=gpu.programs.size;tasks.shift()();steps++;assert.ok(gpu.programs.size-before<=1,'Each task compiles at most one program.');}
  assert.equal(gpu.programs.size,28);assert.equal(gpu.programs.get(3),onDemand);
  assert.equal(steps,28,'Twenty-seven compilations and the task that finds nothing left.');
  const stopped=new VfxGPU(),pending=[];stopped.prewarm(task=>pending.push(task));stopped.destroy();
  pending.shift()();assert.equal(pending.length,0,'A destroyed executor compiles nothing more.');
  gpu.destroy();
});
