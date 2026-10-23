import test from 'node:test';
import assert from 'node:assert/strict';
import {withVfx,releaseVfxSoftwareResources} from '../src/vfx-canvas.mjs';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx} from '../src/vfx.mjs';
import {capturePreviewRaster} from '../src/renderer-raster-capture.mjs';

test('explicit worker cleanup releases software region entries and scratch while ordinary calls retain reuse',()=>{
  const previousCanvas=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData,runPixels=VfxCPU.prototype.runPixels;
  const executors=[],canvases=[];let calls=0,capability=null,gpuReleases=0;
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;canvases.push(this);this.context={canvas:this,draws:[],lost:false,isContextLost(){return this.lost;},getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};},setTransform(){},fillRect(){},clearRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},drawImage(source){this.draws.push(source);},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(){}};}
    getContext(type){return type==='webgl2'?capability:this.context;}
    transferToImageBitmap(){return {width:this.width,height:this.height,close(){}};}
  };
  globalThis.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
  VfxCPU.prototype.runPixels=function(pixels,width,height){calls++;if(!executors.includes(this))executors.push(this);const slot=this.slot(0,width,height);slot.pixels.set(pixels);return {pixels:slot.pixels,width,height};};
  try{
    const target=new OffscreenCanvas(32,32),context=target.getContext('2d'),stack=[createVfx('blur','blur')],paint=ctx=>ctx.fillRect(3,3,8,8);
    const options={bounds:{x:0,y:0,width:16,height:16},cacheHint:'unchanged'};
    withVfx(context,stack,paint,options);withVfx(context,stack,paint,options);
    assert.equal(calls,1);assert.equal(context.draws[0],context.draws[1]);
    const first=context.draws[0];assert.ok(first.width>1);assert.ok(executors[0].slots[0].pixels.length>0);
    releaseVfxSoftwareResources();assert.equal(first.width,1);assert.equal(first.height,1);assert.equal(executors[0].slots.length,0);assert.equal(target.width,32);
    withVfx(context,stack,paint,options);assert.equal(calls,2);assert.notEqual(context.draws[2],first);assert.equal(executors.length,2);
    const second=context.draws[2];releaseVfxSoftwareResources();assert.equal(second.width,1);assert.equal(executors[1].slots.length,0);
    withVfx(context,stack,paint,{bounds:options.bounds});
    const result=context.draws.at(-1);assert.ok(result.width>1);
    releaseVfxSoftwareResources();releaseVfxSoftwareResources();assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(executors[2].slots.length,0);
    const captureSource=()=>({records:[{scale:1,_stykVfx:{figure:stack}}],items:[{type:'line',slot:0,obj:0,opacity:1,alpha:1,rgb:[0,0,0],thickness:0,points:[]}]});
    const plan={width:16,height:16,matrix:[1,0,0,1,0,0],maxBytes:1024*1024},rootIndex=canvases.length;
    const captured=capturePreviewRaster(captureSource(),{...plan,resources:null});captured.bitmap.close();
    assert.equal(executors.at(-1).slots.length,0,'Capture releases its software executor before returning its bitmap.');
    const captureCanvas=canvases.slice(rootIndex).find(canvas=>canvas.context.draws.length);assert.ok(captureCanvas);captureCanvas.context.lost=true;
    assert.throws(()=>capturePreviewRaster(captureSource(),plan),/canvas became unavailable/);
    assert.equal(executors.at(-1).slots.length,0,'Failed captures release software executor slots too.');
    const recovered=capturePreviewRaster(captureSource(),plan);recovered.bitmap.close();
    assert.equal(recovered.bitmap.width,16);assert.equal(executors.at(-1).slots.length,0);
    const outer={opacity:1,scale:1,effects:[]},sharedInner={owner:{opacity:1,scale:1,effects:stack},part:0};
    const nestedSource=(parts,{cloned=false}={})=>{
      const records=[{scale:1},outer,sharedInner];
      const items=parts.map((part,index)=>{
        const inner=cloned?records.push(structuredClone(sharedInner))-1:2;
        return {type:'line',slot:0,obj:0,opacity:1,alpha:1,rgb:[0,0,0],thickness:0,points:[],start:{x:index,y:0},_movieclipOwner:1,_movieclipPart:part,_movieclipInner:inner};
      });
      return {records,items};
    };
    const shared=capturePreviewRaster(nestedSource(Array(100).fill('A')),plan),cloned=capturePreviewRaster(nestedSource(Array(100).fill('A'),{cloned:true}),plan);
    assert.equal(cloned.workingBytes,shared.workingBytes,'Continuous painter groups reserve one selected inner stack despite cloned metadata.');shared.bitmap.close();cloned.bitmap.close();
    const twoRuns=capturePreviewRaster(nestedSource(['A','B']),plan),beforeRepeated=calls;
    const threeRuns=capturePreviewRaster(nestedSource(['A','B','A']),plan);
    assert.equal(calls-beforeRepeated,3,'A/B/A paints three distinct contiguous inner groups.');
    assert.ok(threeRuns.workingBytes>twoRuns.workingBytes,'Repeated A reserves a third software-region entry.');twoRuns.bitmap.close();threeRuns.bitmap.close();
    capability={MAX_TEXTURE_SIZE:1,VERTEX_SHADER:2,getParameter(){return 2048;},createShader(){return {};},shaderSource(){},compileShader(){},getShaderParameter(){return true;},createFramebuffer(){return {};},isContextLost(){return true;},deleteFramebuffer(){},deleteProgram(){},deleteShader(){},getExtension(){return {loseContext(){gpuReleases++;}};}};
    const limited=capturePreviewRaster(captureSource(),{...plan,width:2150,maxBytes:64*1024*1024});limited.bitmap.close();
    assert.equal(limited.tileCount,2,'Actual 2048-pixel capability forces bounded cores even when the 4096-pixel memory plan fits.');
    assert.ok(limited.tileWidth+28<=2048);assert.equal(gpuReleases,1,'Capture releases GPU storage before publication.');
    assert.ok(executors.every(executor=>!executor.slots.length&&!executor.canvas),'Independent local and fallback CPU owners are both released.');
  }finally{releaseVfxSoftwareResources();globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousImageData;VfxCPU.prototype.runPixels=runPixels;}
});
