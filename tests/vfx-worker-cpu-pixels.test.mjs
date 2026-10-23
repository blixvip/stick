import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx,activeVfx,VFX_REGISTRY} from '../src/vfx.mjs';
import {VfxGPU,withVfxWorkerResources,releaseVfxGPU} from '../src/vfx-gpu.mjs';
import {withVfx,releaseVfxSoftwareResources} from '../src/vfx-canvas.mjs';

function pixels(width,height){
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=(i*19+81)%256;data[i+1]=(i*37+203)%256;data[i+2]=(i*11+42)%256;data[i+3]=[0,1,31,127,192,254,255][i/4%7];}
  return data;
}
function softwareCanvas(run){
  const previousCanvas=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData;
  globalThis.ImageData=class {constructor(data,width,height){assert.equal(data.length,width*height*4);Object.assign(this,{data,width,height});}};
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(kind){
      if(kind==='webgl2')return null;
      return this.context??=new Proxy({canvas:this,save(){},restore(){},getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};},
        getImageData:(x,y,width,height)=>({data:pixels(width,height)}),putImageData(data){this.image=data;},
      },{get(target,key){return target[key]??(()=>{});}});
    }
  };
  try{return run();}finally{releaseVfxGPU();releaseVfxSoftwareResources();globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousImageData;}
}

test('owned CPU capture pixels preserve every native effect result without changing ordinary input ownership',()=>softwareCanvas(()=>{
  const types=['tint','grade','blur','glow','shadow','outline','pixelate','noise','vignette','dissolve','rgbSplit','turbulence','wave','shockwave','bloom','lightSweep','crt'];
  const ordinary=new VfxCPU(),owned=new VfxCPU();
  try{
    for(const type of types)for(const mode of [0,1,2]){
      const effect=createVfx(type,`${type}-${mode}`);
      if(type==='grade')effect.params.exposure=.7;
      if(Object.hasOwn(effect.params,'mode'))effect.params.mode=Math.min(mode,VFX_REGISTRY[type].params.mode.max);
      if(!activeVfx([effect]).length)continue;
      const width=13+mode,height=9+mode,source=new OffscreenCanvas(width,height),raw=pixels(width,height);
      let readback;
      source.getContext('2d').getImageData=()=>{assert.equal(owned.slots[0],undefined,'Previous private input ends before fresh readback.');readback=new Uint8ClampedArray(raw);return {data:readback};};
      const options={scale:.83,origin:{x:.37,y:-.61},outputSize:{width:19,height:17}};
      // Ordinary calls keep their independent input copy and output conversion.
      const reference=ordinary.run({width,height,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray(raw)})})},[effect],options).getContext('2d').image;
      const result=owned.run(source,[effect],{...options,ownedPixels:true}).getContext('2d').image;
      assert.deepEqual(result.data,reference.data,`${type}/${mode}: identical native straight-alpha output`);
      assert.equal(owned.slots[0].pixels,readback,'The one fresh readback is the private input plane.');
      assert.ok(owned.slots.some(slot=>slot?.pixels===result.data),'The private final pass is converted directly into ImageData.');
      assert.ok(!ordinary.slots.some(slot=>slot?.pixels===reference.data),'Ordinary output remains separately owned.');
      const premul=new Uint8ClampedArray(raw);owned.premultiply(premul);
      assert.deepEqual(readback,premul,'Native passes do not mutate their borrowed original input.');
    }
  }finally{ordinary.destroy();owned.destroy();}
}));

test('ordinary runPixels preserves caller pixels, while private repeated filters release borrowed inputs before allocating sources',()=>softwareCanvas(()=>{
  const effect=createVfx('blur','directional');Object.assign(effect.params,{mode:1,radius:1.7,angle:34});
  const plain=new VfxCPU(),raw=pixels(7,5),original=raw.slice();plain.premultiply(raw);const expected=raw.slice();
  plain.runPixels(raw,7,5,[effect]);assert.deepEqual(raw,expected);assert.notEqual(plain.slots[0].pixels,raw);plain.destroy();
  let local,readbacks=0;const runPixels=VfxCPU.prototype.runPixels;
  VfxCPU.prototype.runPixels=function(data,width,height,stack,options){local=this;assert.equal(options.ownedPixels,true);return runPixels.call(this,data,width,height,stack,options);};
  const getContext=OffscreenCanvas.prototype.getContext;
  OffscreenCanvas.prototype.getContext=function(kind){
    const context=getContext.call(this,kind);if(kind==='2d'&&!Object.hasOwn(context,'checked')){context.checked=true;const read=context.getImageData;context.getImageData=function(...args){assert.equal(local?.slots[0],undefined,'The previous local input ends before source readback.');readbacks++;return read.apply(this,args);};}
    return context;
  };
  try{
    withVfxWorkerResources(()=>{
      const target=new OffscreenCanvas(32,24).getContext('2d');
      for(const size of [8,13,6])withVfx(target,[effect],()=>{assert.equal(local?.slots[0],undefined,'The previous local input ends before source painting.');}, {bounds:{x:3.37,y:2.61,width:size,height:size},cacheHint:`source-${size}`});
    },{releaseSource:context=>{context.canvas.width=context.canvas.height=1;}});
    assert.equal(readbacks,3);assert.deepEqual(original,pixels(7,5));
  }finally{VfxCPU.prototype.runPixels=runPixels;OffscreenCanvas.prototype.getContext=getContext;}
}));

test('repeated worker GPU fallback ends old borrowed pixels before repaint and uses ordinary conversion outside its scope',()=>softwareCanvas(()=>{
  const context=OffscreenCanvas.prototype.getContext,gpuRun=VfxGPU.prototype.run,cpuRun=VfxCPU.prototype.run;
  const effect=createVfx('blur','fallback');Object.assign(effect.params,{mode:1,radius:1.3});
  let globalCPU,readbacks=0,runs=0;const policies=[];
  OffscreenCanvas.prototype.getContext=function(kind){
    if(kind==='webgl2')return new Proxy({getParameter:()=>4096,getShaderParameter:()=>true,getProgramParameter:()=>true,getExtension:()=>({loseContext(){}})}, {get:(target,key)=>target[key]??(()=>({}))});
    const ctx=context.call(this,kind);if(!Object.hasOwn(ctx,'checked')){ctx.checked=true;const read=ctx.getImageData;ctx.getImageData=function(...args){if(policies.at(-1))assert.equal(globalCPU?.slots[0],undefined);readbacks++;return read.apply(this,args);};}return ctx;
  };
  VfxGPU.prototype.run=function(){runs++;throw Error('Deliberate context loss');};
  VfxCPU.prototype.run=function(source,stack,options){globalCPU=this;policies.push(options?.ownedPixels===true);return cpuRun.call(this,source,stack,options);};
  try{
    const target=new OffscreenCanvas(32,24).getContext('2d');
    withVfxWorkerResources(()=>{
      for(const size of [8,13,6])withVfx(target,[effect],()=>{assert.equal(globalCPU?.slots[0],undefined,'Private global input ends before the next source paint.');},{bounds:{x:3.37,y:2.61,width:size,height:size},cacheHint:`source-${size}`});
    });
    assert.equal(runs,1);assert.equal(readbacks,3);assert.deepEqual(policies,[true,true,true]);
    withVfx(target,[effect],()=>{}, {bounds:{x:2,y:2,width:4,height:4}});
    assert.equal(runs,2);assert.equal(policies.at(-1),false,'Ordinary preview/export CPU conversion retains its existing ownership.');
  }finally{OffscreenCanvas.prototype.getContext=context;VfxGPU.prototype.run=gpuRun;VfxCPU.prototype.run=cpuRun;}
}));

test('a failed private CPU filter cannot retry an unadmitted larger native region, while ordinary fallback stays unchanged',()=>softwareCanvas(()=>{
  const getContext=OffscreenCanvas.prototype.getContext,gpuRun=VfxGPU.prototype.run,cpuRun=VfxCPU.prototype.run,runPixels=VfxCPU.prototype.runPixels;
  const failed=Error('Private CPU filtering failed'),effect=createVfx('blur','failure');Object.assign(effect.params,{mode:1,radius:1.3});let softwarePasses=0;
  OffscreenCanvas.prototype.getContext=function(kind){return kind==='webgl2'?new Proxy({getParameter:()=>64,getShaderParameter:()=>true,getProgramParameter:()=>true,getExtension:()=>({loseContext(){}})},{get:(target,key)=>target[key]??(()=>({}))}):getContext.call(this,kind);};
  VfxGPU.prototype.run=()=>{throw Error('Deliberate GPU failure');};
  VfxCPU.prototype.run=function(...args){cpuRun.apply(this,args);throw failed;};
  VfxCPU.prototype.runPixels=function(...args){softwarePasses++;return runPixels.apply(this,args);};
  const paint=()=>withVfx(new OffscreenCanvas(160,80).getContext('2d'),[effect],()=>{}, {bounds:{x:0,y:1,width:150,height:20},cacheHint:'native-owner'});
  try{
    assert.throws(()=>withVfxWorkerResources(paint),error=>error===failed);
    assert.equal(softwarePasses,1,'The private capture ends after its admitted CPU fallback fails; no local oversized retry is allocated.');
    paint();assert.equal(softwarePasses,3,'Ordinary painting retains the original global CPU attempt followed by local software recovery.');
  }finally{OffscreenCanvas.prototype.getContext=getContext;VfxGPU.prototype.run=gpuRun;VfxCPU.prototype.run=cpuRun;VfxCPU.prototype.runPixels=runPixels;}
}));
