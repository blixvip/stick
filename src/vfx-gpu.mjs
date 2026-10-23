import {messageError} from './localized-error.mjs';
import {activeVfx,vfxPadding,vfxSamplingPadding} from './vfx.mjs';
import {vfxPaint} from './vfx-paint.mjs';
import {vfxVertex as vertex,vfxFragment as fragment} from './vfx-shaders.mjs';
import {vfxWebGPUFor,releaseVfxWebGPU} from './vfx-webgpu.mjs';
import {fitsVfxSurface,vfxSurfaceError,VFX_MAX_DIMENSION} from './vfx-surface.mjs';
import {filterVfxCPU,releaseVfxCPU,releaseVfxCPUInput} from './vfx-cpu.mjs';
export class VfxGPU {
 constructor(){
  this.canvas=new OffscreenCanvas(1,1);const gl=this.gl=this.canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
  if(!gl)throw messageError(new Error(''), "errors.vfxGpu.vfxRequireAnAvailableWebgl2GraphicsContext", {});
  this.maxDimension=Math.min(VFX_MAX_DIMENSION,gl.getParameter(gl.MAX_TEXTURE_SIZE));
  this.compile=(type,code)=>{const shader=gl.createShader(type);gl.shaderSource(shader,code);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){const reason=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw messageError(new Error(''), "errors.vfxGpu.vfxShader", {reason: reason});}return shader;};
  this.vertexShader=this.compile(gl.VERTEX_SHADER,vertex);this.programs=new Map();
  this.paintColors=new Float32Array(128);this.paintOffsets=new Float32Array(32);
  this.slots=[];this.framebuffer=gl.createFramebuffer();this.stats={passes:0,bytes:0,calls:0};
 }
 program(operation){
  if(!Number.isInteger(operation)||operation<0||operation>27)throw messageError(new RangeError(''), "errors.vfxGpu.unknownVfxGraphicsOperation", {});
  let entry=this.programs.get(operation);if(entry)return entry;
  const gl=this.gl,shader=this.compile(gl.FRAGMENT_SHADER,fragment.replace('uniform int operation,paintType,stopCount;',`const int operation=${operation}; uniform int paintType,stopCount;`)),program=gl.createProgram();gl.attachShader(program,this.vertexShader);gl.attachShader(program,shader);gl.linkProgram(program);gl.deleteShader(shader);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)){const reason=gl.getProgramInfoLog(program);gl.deleteProgram(program);throw messageError(new Error(''), "errors.vfxGpu.vfxProgram", {reason: reason});}
  const uniforms=Object.fromEntries(['sourceImage','originalImage','maskImage','dimensions','origin','outputSize','p','q','paintType','paintAngle','stopCount','stops[0]','stopOffsets[0]'].map(name=>[name,gl.getUniformLocation(program,name)]));entry={program,uniforms};this.programs.set(operation,entry);return entry;
 }
 slot(index,width,height){
  const gl=this.gl;let slot=this.slots[index];if(!slot){const texture=gl.createTexture();slot={texture,width:0,height:0};this.slots[index]=slot;gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
  gl.bindTexture(gl.TEXTURE_2D,slot.texture);if(slot.width!==width||slot.height!==height){slot.width=width;slot.height=height;gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);}return slot;
 }
 /** Returns this executor's canvas, sized to the source. With `region`, the
  * drawing buffer only grows, in 256-pixel steps, and the result is the
  * rectangle `{canvas,x,y,width,height}` of that canvas until the next run.
  * Each drawing buffer resize waits for the graphics process, and figures of
  * different sizes resized it for every filtered figure. */
 run(source,stack,{scale=1,origin={x:0,y:0},outputSize,region=false}={}){
  stack=activeVfx(stack);if(!stack.length)return source;
  const gl=this.gl,w=source.width,h=source.height;if(gl.isContextLost())throw messageError(new Error(''), "errors.vfxGpu.theVfxGraphicsContextWasLostRetryAfter", {});
  if(!fitsVfxSurface(w,h,this.maxDimension))throw vfxSurfaceError();
  const canvasWidth=region?Math.max(this.canvas.width,Math.min(this.maxDimension,Math.ceil(w/256)*256)):w,canvasHeight=region?Math.max(this.canvas.height,Math.min(this.maxDimension,Math.ceil(h/256)*256)):h;
  if(this.canvas.width!==canvasWidth)this.canvas.width=canvasWidth;if(this.canvas.height!==canvasHeight)this.canvas.height=canvasHeight;
  gl.disable(gl.BLEND);gl.activeTexture(gl.TEXTURE0);const input=this.slot(0,w,h);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  this.stats.passes=0;let brushType=0,brushAngle=0,brushStops=1;
  let current=input;
  const pass=(operation,p=[0,0,0,0],q=[0,0,0,0],original=current,width=w,height=h,screen=false)=>{
    const {program,uniforms:u}=this.program(operation);gl.useProgram(program);
    gl.uniform1i(u.sourceImage,0);gl.uniform1i(u.originalImage,1);gl.uniform1i(u.maskImage,2);gl.uniform2f(u.origin,origin.x,origin.y);gl.uniform2f(u.outputSize,outputSize?.width??w,outputSize?.height??h);
    gl.uniform1i(u.paintType,brushType);gl.uniform1f(u.paintAngle,brushAngle);gl.uniform1i(u.stopCount,brushStops);gl.uniform4fv(u['stops[0]'],this.paintColors);gl.uniform1fv(u['stopOffsets[0]'],this.paintOffsets);
    const next=screen?null:this.slot([1,2,3].find(i=>this.slots[i]!==current&&this.slots[i]!==original),width,height);
    gl.bindFramebuffer(gl.FRAMEBUFFER,screen?null:this.framebuffer);if(next)gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,next.texture,0);
    gl.viewport(0,0,width,height);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,current.texture);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,original.texture);gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(u.dimensions,current.width,current.height);gl.uniform4fv(u.p,p);gl.uniform4fv(u.q,q);gl.drawArrays(gl.TRIANGLES,0,3);this.stats.passes++;if(next)current=next;
  };
  const blur=radius=>{if(radius<=0)return;const factor=Math.max(1,Math.ceil(radius/20)),ox=factor>1?((origin.x%factor)+factor)%factor:0,oy=factor>1?((origin.y%factor)+factor)%factor:0,bw=Math.max(1,Math.ceil((w+ox)/factor)),bh=Math.max(1,Math.ceil((h+oy)/factor));if(factor>1)pass(11,[factor,ox,oy,bh],undefined,current,bw,bh);const r=Math.min(128,Math.max(1,Math.round(radius/factor*.57735)));for(let i=0;i<3;i++){pass(3,[r,0,0,0],undefined,current,bw,bh);pass(4,[r,0,0,0],undefined,current,bw,bh);}if(factor>1)pass(12,[factor,ox,oy,h]);};
  const paint=value=>{const brush=vfxPaint(value);brushType=['solid','linear','radial','angular','diamond'].indexOf(brush.type);brushAngle=brush.angle*Math.PI/180;brushStops=brush.stops.length;brush.stops.forEach((s,i)=>{this.paintColors.set([...s.color.map(n=>n/255),s.opacity],i*4);this.paintOffsets[i]=s.offset;});};
  const save=(index=4)=>{const saved=this.slot(index,w,h);gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,current.texture,0);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,saved.texture);gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,w,h);return saved;};
  const morph=(radius,rounded=false)=>{radius=Math.ceil(radius);let step=1;while(radius>0){const amount=Math.min(rounded?step:128,radius);if(rounded)pass(14,[amount,0,0,0]);else{pass(5,[amount,0,0,0]);pass(6,[amount,0,0,0]);}radius-=amount;step*=2;}};
  for(const {type,params:p} of stack){
    const strengthSource=p.effectStrength<1?save(7):null;
    if(p.color!==undefined)paint(p.color);
    if(type==='tint')pass(1,[p.mix,0,0,0]);
    else if(type==='grade')pass(2,[p.exposure,p.contrast,p.saturation,p.temperature],[p.tint,p.shadows,p.highlights,p.gamma]);
    else if(type==='blur'){if(!p.mode)blur(p.radius*scale);else pass(16,[p.radius*scale,p.mode,p.angle*Math.PI/180,0],[p.centerX,p.centerY,0,0]);}
    else if(type==='glow'||type==='shadow'){
      if(type==='glow'&&p.coreMix){paint(p.coreColor);pass(1,[p.coreMix,0,0,0]);paint(p.color);}
      for(const inner of p.mode===2?[true,false]:[p.mode===1]){const saved=save();if(inner)pass(13);morph(p.spread*scale,true);blur(p.radius*scale);pass(7,[p.intensity??p.opacity,p.falloff??1,Number(inner),p.blend??0],[(p.offsetX??0)*scale,(p.offsetY??0)*scale,0,0],saved);}
    }else if(type==='outline'){
      const saved=save(),width=p.width*scale*(p.mode===2?.5:1);
      if(p.mode===2){pass(13);morph(width,p.rounded);pass(15,[p.opacity,1,1,0],undefined,saved);const inner=save(5);current=saved;morph(width,p.rounded);gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,inner.texture);gl.activeTexture(gl.TEXTURE0);pass(25,[p.opacity,p.only,0,0],undefined,saved);}
      else{if(p.mode===1)pass(13);morph(width,p.rounded);pass(15,[p.opacity,Number(p.mode===1),p.only,0],undefined,saved);}
    }else if(type==='pixelate')pass(8,[Math.max(1,p.size*scale),Math.max(1,(p.linked?p.size:p.sizeY)*scale),0,0],[p.offsetX*scale,p.offsetY*scale,0,0]);
    else if(type==='noise')pass(9,[p.amount,Math.max(1,p.size*scale),p.seed,Math.floor(p.phase*1024)],[p.colored,p.contrast,p.softness,p.pattern]);
    else if(type==='vignette')pass(10,[p.amount,p.softness,p.radius,0],[p.centerX,p.centerY,p.aspect,p.roundness]);
    else if(type==='dissolve')pass(17,[p.progress,p.size*scale,p.softness,p.seed],[p.edge,0,0,0]);
    else if(type==='rgbSplit')pass(18,[p.amount*scale,p.angle*Math.PI/180,0,0],[p.red,p.green,p.blue,0]);
    else if(type==='turbulence')pass(27,[p.amount*scale,p.size*scale,p.evolution,p.seed],[p.detail,0,0,0]);
    else if(type==='wave')pass(19,[p.strength*scale,p.wavelength*scale,p.angle*Math.PI/180,p.phase*Math.PI/180]);
    else if(type==='shockwave')pass(20,[p.radius*scale,p.thickness*scale,p.strength*scale,p.falloff],[p.centerX,p.centerY,0,0]);
    else if(type==='bloom'){const saved=save();pass(21,[p.threshold,p.softness,0,0]);blur(p.radius*scale);pass(22,[p.intensity,0,0,0],undefined,saved);}
    else if(type==='lightSweep')pass(23,[p.position,p.angle*Math.PI/180,p.width,p.softness],[p.intensity,0,0,0]);
    else if(type==='crt')pass(24,[p.amount,p.spacing*scale,p.curvature,p.chromatic*scale],[p.phase*scale,0,0,0]);
    if(strengthSource)pass(26,[p.effectStrength,0,0,0],undefined,strengthSource);
  }
  // The last pass draws the bottom-left w×h of the drawing buffer. Displayed
  // rows run top-down, so that is the image's lower-left at y=height-h.
  pass(0,undefined,undefined,current,w,h,true);gl.flush();this.stats.calls++;this.stats.bytes=(canvasWidth*canvasHeight+this.slots.reduce((n,s)=>n+(s?s.width*s.height:0),0))*4;
  return region?{canvas:this.canvas,x:0,y:canvasHeight-h,width:w,height:h}:this.canvas;
 }
 /** Compile the programs no effect has needed yet, one per task. A program
  * compiles on the thread that presents frames and its status is read
  * synchronously, so the first frames that use an effect otherwise stall
  * playback while every worker compiles the same programs. */
 prewarm(schedule=callback=>setTimeout(callback,16)){
  if(this.prewarming)return;this.prewarming=true;let operation=0;
  const step=()=>{
   if(!this.prewarming||this.gl.isContextLost())return;
   while(operation<=27&&this.programs.has(operation))operation++;
   if(operation>27)return;
   try{this.program(operation++);}catch{return;}
   schedule(step);
  };
  schedule(step);
 }
 /** A completed worker capture releases pixels while keeping its bounded shader
  * programs warm. Detach framebuffer and sampler references before deleting
  * textures so no retained binding can extend a large surface's lifetime. */
 releasePixels(){
  const gl=this.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,null,0);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  for(let unit=0;unit<3;unit++){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,null);}gl.activeTexture(gl.TEXTURE0);
  for(const slot of this.slots)if(slot)gl.deleteTexture(slot.texture);this.slots=[];
  this.canvas.width=this.canvas.height=1;this.stats.bytes=4;gl.flush();
 }
 destroy(){this.prewarming=false;for(const slot of this.slots)if(slot)this.gl.deleteTexture(slot.texture);this.slots=[];this.gl.deleteFramebuffer(this.framebuffer);for(const {program} of this.programs.values())this.gl.deleteProgram(program);this.programs.clear();this.gl.deleteShader(this.vertexShader);this.gl.getExtension('WEBGL_lose_context')?.loseContext();this.canvas.width=this.canvas.height=1;}
}
let executor,idleTimer,lastUse=0,sharedDevice=null,workerResources;
/** One synchronous capture owns its private pixel storage. Its bounded graphics
 * context/programs stay warm until worker disposal.
 * After a GPU failure,
 * release its textures before allocating software pixels and keep the original
 * surface limit so the native painter follows the same bounded surface route.
 * Main preview/export calls outside this scope keep their existing policy. */
export function withVfxWorkerResources(paint,{samplingPadding=false,releaseSource}={}){
 if(sharedDevice||workerResources)throw messageError(new Error(''), 'errors.rasterSurfaces.aRasterScratchSurfaceCannotBeUsedConcurrently', {});
 const previous=workerResources,state=workerResources={limit:undefined,software:false,samplingPadding,releaseSource};let completed=false;
 try{const result=paint({setSamplingPadding(value){state.samplingPadding=value===true;}});completed=true;return result;}finally{try{try{if(completed)releasePrivateVfxPixels();else releasePrivateVfxGPU();}finally{releaseVfxCPU();}}finally{workerResources=previous;}}
}
/** Local software-region paint contexts have no parent scratch map. A one-shot
 * worker may explicitly end their geometry lifetime after pixels are read. */
export function releaseVfxWorkerSource(context){workerResources?.releaseSource?.(context);}
/** Only disposable captures may borrow and convert their private CPU pixels. */
export function vfxWorkerPixelsOwned(){return !!workerResources;}
export function prepareVfxWorkerSource(){if(workerResources)releaseVfxCPUInput();}
export function vfxSourcePadding(stack,scale=1,extent=0){return (workerResources?.samplingPadding?vfxSamplingPadding:vfxPadding)(stack,scale,extent);}
/** A quiet period releases working pixels. The graphics context and its
 * compiled programs stay: recreating them compiles on the thread that
 * presents frames, a visible stall at the next playback or edit. The WebGPU
 * executor applies the same rule to every caller itself. */
function releaseIdle(){const wait=30000-(performance.now()-lastUse);if(wait>0){idleTimer=setTimeout(releaseIdle,wait);return;}idleTimer=undefined;executor?.releasePixels();}
/** Register the renderer's WebGPU device so the shared WGSL executor can run
 * scene/drawable filters without leaving the device. Without one, callers fall
 * back to the WebGL 2 executor. */
export function initVfxDevice(device){
 sharedDevice=device;device.lost.then(()=>{if(sharedDevice===device)sharedDevice=null;releaseVfxWebGPU(device);});
 // After startup has presented: effects then never compile during playback.
 if(typeof setTimeout==='function'&&device.createRenderPipelineAsync)setTimeout(()=>{if(sharedDevice===device)vfxWebGPUFor(device).prewarm();},1500);
}
export function releaseVfxDevice(device){if(sharedDevice===device)sharedDevice=null;releaseVfxWebGPU(device);}
let cpuFallbacks=0;
/** Filter a canvas through the active GPU executor when possible. Any GPU
 * failure — missing WebGL2, lost context, oversized surface — falls back to
 * the deterministic software executor so a filter call can never fail. */
function filterSoftware(source,stack,options){
 return filterVfxCPU(source,stack,workerResources?{...options,ownedPixels:true}:options);
}
export function filterVfxCanvas(source,stack,options){if(!activeVfx(stack).length)return source;
 if(workerResources?.software)return filterSoftware(source,stack,options);
 try{
  if(sharedDevice&&!workerResources){const gpu=vfxWebGPUFor(sharedDevice);lastUse=performance.now();idleTimer??=setTimeout(releaseIdle,30000);return gpu.run(source,stack,options);}
  executor??=new VfxGPU();lastUse=performance.now();idleTimer??=setTimeout(releaseIdle,30000);return executor.run(source,stack,options);
 }catch(error){if(workerResources){workerResources.software=true;releasePrivateVfxGPU();}cpuFallbacks++;return filterSoftware(source,stack,options);}}
/** Executor surface edge, or 0 when no GPU executor exists (callers then take
 * the software path, which is bounded only by memory). */
export function vfxSurfaceDimension(){
 if(workerResources?.limit!==undefined)return workerResources.limit;
 if(sharedDevice&&!workerResources)return Math.min(VFX_MAX_DIMENSION,sharedDevice.limits.maxTextureDimension2D);
 let limit;try{executor??=new VfxGPU();lastUse=performance.now();idleTimer??=setTimeout(releaseIdle,30000);limit=executor.maxDimension;}catch{limit=0;}
 if(workerResources){workerResources.limit=limit;if(!limit)workerResources.software=true;}return limit;
}
/** Prepare this thread's WebGL executor before its first effect. Owners that
 * present through WebGPU filter there instead and never call this. */
export function prewarmVfxGPU(){
 if(sharedDevice||workerResources?.software)return false;
 try{executor??=new VfxGPU();lastUse=performance.now();idleTimer??=setTimeout(releaseIdle,30000);executor.prewarm();return true;}catch{return false;}
}
export function vfxGPUStats(){const source=sharedDevice?vfxWebGPUFor(sharedDevice).stats:executor?.stats;return {...(source??{passes:0,bytes:0,calls:0}),cpuFallbacks,programs:executor?.programs.size??0};}
function releasePrivateVfxPixels(){try{executor?.releasePixels();}catch(error){try{releasePrivateVfxGPU();}finally{throw error;}}}
function releasePrivateVfxGPU(){clearTimeout(idleTimer);idleTimer=undefined;const retired=executor;executor=null;retired?.destroy();}
export function releaseVfxGPU(){releasePrivateVfxGPU();if(sharedDevice)releaseVfxWebGPU(sharedDevice);}
