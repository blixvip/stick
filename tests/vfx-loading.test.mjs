import test from 'node:test';
import assert from 'node:assert/strict';
import {GeneratorGpu} from '../src/vfx-generator-gpu.mjs';

function globalValue(t,name,value){
  const previous=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else delete globalThis[name];});
}

function gpu(t, compile) {
  globalValue(t,'GPUShaderStage',{VERTEX:1,FRAGMENT:2});
  globalValue(t,'GPUTextureUsage',{TEXTURE_BINDING:1,COPY_DST:2});
  const texture={destroy:t.mock.fn()};
  const device={
    createShaderModule:()=>({}), createBindGroupLayout:()=>({}), createPipelineLayout:()=>({}),
    createTexture:()=>texture, createSampler:()=>({}), createRenderPipelineAsync:compile,
    createRenderPipeline:()=>{throw new Error('Synchronous compilation during drawing');},
  };
  return new GeneratorGpu(device,'bgra8unorm',{});
}

test('generated effects await both blends and quality levels before drawing',async t=>{
  const pending=[];
  const renderer=gpu(t,descriptor=>new Promise(resolve=>pending.push({descriptor,resolve})));
  let ready=false;
  const loading=renderer.initialize().then(()=>{ready=true;});
  assert.equal(pending.length,4);
  await Promise.resolve();assert.equal(ready,false);
  for(const entry of pending)entry.resolve(entry.descriptor);
  await loading;
  for(const samples of [1,4])for(const blend of [0,1]){
    const pipeline=renderer.pipeline(blend,samples);
    assert.equal(pipeline.multisample.count,samples);
    assert.match(pipeline.label,blend?/additive/:/normal/);
    assert.equal(renderer.pipeline(blend,samples),pipeline);
  }
  renderer.destroy();assert.equal(renderer.pipelines.size,0);
});

test('late compilation cannot restore disposed effect resources',async t=>{
  const pending=[];
  const renderer=gpu(t,()=>new Promise(resolve=>pending.push(resolve)));
  const loading=renderer.initialize(),atlas=renderer.atlas;
  renderer.destroy();
  for(const resolve of pending)resolve({});
  await loading;
  assert.equal(renderer.pipelines.size,0);assert.equal(renderer.atlas,null);
  assert.equal(atlas.destroy.mock.callCount(),1);
});

test('effect shader failure reaches renderer startup fallback',async t=>{
  const renderer=gpu(t,()=>Promise.reject(new Error('Shader compilation failed')));
  await assert.rejects(renderer.initialize(),/Shader compilation failed/);
  assert.equal(renderer.pipelines.size,0);renderer.destroy();
});

let realm=0;
async function atlas(t, Worker) {
  globalValue(t,'window',{});
  globalValue(t,'Worker',Worker);
  return import(`../src/vfx-generator-atlas.mjs?loading-test=${++realm}`);
}

test('material preparation shares one worker and waits for all transferred rows',async t=>{
  let worker,instances=0;
  const module=await atlas(t,class {
    constructor(){worker=this;instances++;}
    postMessage(data){this.request=data;}
    terminate(){this.terminated=true;}
  });
  const loading=module.prewarmAtlas();assert.equal(module.prewarmAtlas(),loading);
  assert.equal(instances,1);assert.equal(worker.request.rows.length,module.ATLAS_ROWS);
  let ready=false;void loading.then(()=>{ready=true;});
  await Promise.resolve();assert.equal(ready,false);
  for(const row of worker.request.rows){
    const levels=Array.from({length:module.ATLAS_LEVELS},(_,level)=>{
      const width=(module.CELL*module.COLUMNS)>>level,height=module.CELL>>level;
      return {width,height,data:new Uint8Array(width*height*2).fill(row+1)};
    });
    worker.onmessage({data:{row,levels}});
  }
  worker.onmessage({data:{done:true}});
  assert.equal(await loading,true);assert.equal(worker.terminated,true);
  for(let row=0;row<module.ATLAS_ROWS;row++)assert.equal(module.atlasRow(row).levels[0].data[0],row+1,'uses transferred bytes rather than synchronous generation');
});

for(const failure of ['constructor','error','messageerror','incomplete','timeout'])test(`material ${failure} settles loading and releases the worker`,async t=>{
  let worker;
  if(failure==='timeout')t.mock.timers.enable({apis:['setTimeout']});
  const module=await atlas(t,class {
    constructor(){if(failure==='constructor')throw new Error('Worker blocked');worker=this;}
    postMessage(){}
    terminate(){this.terminated=true;}
  });
  const loading=module.prewarmAtlas();
  if(failure==='error')worker.onerror({preventDefault(){}});
  if(failure==='messageerror')worker.onmessageerror();
  if(failure==='incomplete')worker.onmessage({data:{done:true}});
  if(failure==='timeout')t.mock.timers.tick(8000);
  assert.equal(await loading,false);
  if(worker)assert.equal(worker.terminated,true);
  assert.equal(module.prewarmAtlas(),loading,'failure does not start workers on every frame');
});

test('catalogue preview work waits for the material worker',async t=>{
  let worker,idleCalls=0;
  globalValue(t,'window',{});
  globalValue(t,'Worker',class {
    constructor(){worker=this;}
    postMessage(){}
    terminate(){}
  });
  globalValue(t,'requestIdleCallback',()=>{idleCalls++;});
  const {requestEffectPreview}=await import('../src/vfx-preset-preview.mjs');
  requestEffectPreview('add','aura',()=>{});
  requestEffectPreview('add','smoke',()=>{});
  await Promise.resolve();assert.equal(idleCalls,0,'idle callbacks must not race preparation');
  worker.onmessage({data:{done:true}});
  await Promise.resolve();assert.equal(idleCalls,1,'queued previews share one scheduled drain');
});
