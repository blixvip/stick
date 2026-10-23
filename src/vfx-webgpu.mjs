import {messageError} from './localized-error.mjs';
import {activeVfx} from './vfx.mjs';
import {fitsVfxSurface,vfxSurfaceError} from './vfx-surface.mjs';
import {vfxPaint} from './vfx-paint.mjs';
// WGSL port of vfx-shaders.mjs. The vertex keeps the GLSL uv convention
// (uv.y=0 at the framebuffer bottom); copyExternalImageToTexture stores image
// row 0 at texture row 0, so the vertical flip lives inside the samplers.
// Ops 11/12 relied on gl_FragCoord's bottom-left origin through
// p.w-fragCoord.y with p.w==pass height, which simplifies to position.y.
const code=`override operation:i32;
struct Params{dimensions:vec2f,origin:vec2f,outputSize:vec2f,paintType:i32,stopCount:i32,paintAngle:f32,pad0:f32,p:vec4f,q:vec4f,r:vec4f,stops:array<vec4f,32>,stopOffsets:array<vec4f,8>};
@group(0) @binding(0) var sourceImage:texture_2d<f32>;
@group(0) @binding(1) var originalImage:texture_2d<f32>;
@group(0) @binding(2) var maskImage:texture_2d<f32>;
@group(0) @binding(3) var smp:sampler;
@group(0) @binding(4) var<uniform> params:Params;
const PI:f32=3.141592653589793;
struct VOut{@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn vertex(@builtin(vertex_index) i:u32)->VOut{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));return VOut(vec4f(p*2.-1.,0.,1.),p);}
fn stopOffset(i:i32)->f32{return params.stopOffsets[(u32(i))>>2u][(u32(i))&3u];}
fn sampleAt(at:vec2f)->vec4f{if(at.x<0.||at.y<0.||at.x>1.||at.y>1.){return vec4f(0.);}return textureSampleLevel(sourceImage,smp,vec2f(at.x,1.-at.y),0.);}
fn sampleOrig(at:vec2f)->vec4f{return textureSampleLevel(originalImage,smp,vec2f(at.x,1.-at.y),0.);}
fn sampleMask(at:vec2f)->vec4f{return textureSampleLevel(maskImage,smp,vec2f(at.x,1.-at.y),0.);}
fn globalPixel(uv:vec2f)->vec2f{return vec2f(uv.x,1.-uv.y)*params.dimensions+params.origin;}
fn sampleGlobal(at:vec2f)->vec4f{let pos=(at-params.origin)/params.dimensions;return sampleAt(vec2f(pos.x,1.-pos.y));}
fn brush(uv:vec2f)->vec4f{if(params.paintType==0){return params.stops[0];}
 var pos=globalPixel(uv)/params.outputSize-vec2f(.5);let cs=cos(params.paintAngle);let sn=sin(params.paintAngle);pos=mat2x2f(cs,-sn,sn,cs)*pos;var t=pos.x+.5;
 if(params.paintType==2){t=length(pos)*2.;}
 if(params.paintType==3){t=fract(atan2(pos.y,pos.x)/(2.*PI)+1.);}
 if(params.paintType==4){t=(abs(pos.x)+abs(pos.y))*2.;}
 var a=params.stops[0];var offset=stopOffset(0);
 for(var i=1;i<32;i++){if(i>=params.stopCount){break;}let next=stopOffset(i);if(t<next){return mix(a,params.stops[u32(i)],clamp((t-offset)/max(.00001,next-offset),0.,1.));}a=params.stops[u32(i)];offset=next;}
 return a;}
fn hashValue(n0:u32)->u32{var n=n0;n^=n>>16u;n*=0x7feb352du;n^=n>>15u;n*=0x846ca68bu;n^=n>>16u;return n;}
fn hashPoint(xy:vec2f,seed:f32)->f32{let vi=vec2i(floor(xy));let v=vec2u(bitcast<u32>(vi.x),bitcast<u32>(vi.y));return f32(hashValue(v.x*1973u+v.y*9277u+u32(seed)*26699u)&65535u)/65535.;}
fn noiseAt(pos:vec2f,seed:f32,smoothness:f32)->f32{let i=floor(pos);var f=fract(pos);f=mix(vec2f(0.),f*f*(3.-2.*f),vec2f(smoothness));return mix(mix(hashPoint(i,seed),hashPoint(i+vec2f(1.,0.),seed),f.x),mix(hashPoint(i+vec2f(0.,1.),seed),hashPoint(i+vec2f(1.),seed),f.x),f.y);}
@fragment fn fragment(@location(0) uv:vec2f,@builtin(position) fragPos:vec4f)->@location(0) vec4f{
 let p=params.p;let q=params.q;
 var c=sampleAt(uv);var rgb=vec3f(0.);if(c.a>.000001){rgb=c.rgb/c.a;}
 if(operation==1){let b=brush(uv);return vec4f(mix(rgb,b.rgb,p.x*b.a)*c.a,c.a);}
 if(operation==2){rgb*=exp2(p.x);rgb=(rgb-vec3f(.5))*p.y+vec3f(.5);let l=dot(rgb,vec3f(.2126,.7152,.0722));rgb=mix(vec3f(l),rgb,p.z);rgb+=vec3f(p.w*.12,q.x*.12,-p.w*.12);rgb+=vec3f(q.y*pow(1.-clamp(l,0.,1.),2.)*.4+q.z*pow(clamp(l,0.,1.),2.)*.4);rgb=pow(max(rgb,vec3f(0.)),vec3f(1./q.w));return vec4f(clamp(rgb,vec3f(0.),vec3f(1.))*c.a,c.a);}
 if(operation==3||operation==4){let delta=select(vec2f(0.,1./params.dimensions.y),vec2f(1./params.dimensions.x,0.),operation==3);var sum=vec4f(0.);let radius=clamp(i32(p.x),0,128);for(var i=-radius;i<=radius;i++){sum+=sampleAt(uv+delta*f32(i));}return sum/f32(radius*2+1);}
 if(operation==5||operation==6){let delta=select(vec2f(0.,1./params.dimensions.y),vec2f(1./params.dimensions.x,0.),operation==5);var alpha=0.;let radius=clamp(i32(p.x),0,128);for(var i=-radius;i<=radius;i++){alpha=max(alpha,sampleAt(uv+delta*f32(i)).a);}return vec4f(alpha);}
 if(operation==7){let front=sampleOrig(uv);let b=brush(uv);let a=clamp(pow(sampleAt(uv-vec2f(q.x,-q.y)/params.dimensions).a,p.y)*p.x*b.a,0.,1.);
  if(p.z>0.){var frgb=mix(front.rgb,b.rgb*front.a,vec3f(a));if(p.w==1.){frgb=min(front.rgb+b.rgb*front.a*a,vec3f(front.a));}if(p.w==2.){frgb=front.rgb+b.rgb*a*(front.a-front.rgb);}return vec4f(frgb,front.a);}
  let under=vec4f(b.rgb*a,a);var pixel=front+under*(1.-front.a);
  if(p.w==1.){pixel=vec4f(min(front.rgb+under.rgb,vec3f(max(front.a,a))),max(front.a,a));}
  if(p.w==2.){pixel=vec4f(front.rgb+under.rgb-front.rgb*under.rgb,max(front.a,a));}
  return pixel;}
 if(operation==8){let xy=globalPixel(uv);let size=p.xy;let cell=clamp((floor((xy-q.xy)/size)+vec2f(.5))*size+q.xy,vec2f(.5),params.outputSize-vec2f(.5));return sampleGlobal(cell);}
 if(operation==9){let xy=globalPixel(uv)/p.y;let seed=p.z+p.w;let smoothness=max(q.z,q.w);let n=noiseAt(xy,seed,smoothness)-.5;var grain=vec3f(n);if(q.x>0.){grain=vec3f(n,noiseAt(xy,seed+131.,smoothness)-.5,noiseAt(xy,seed+719.,smoothness)-.5);}return vec4f(clamp(rgb+grain*p.x*q.y,vec3f(0.),vec3f(1.))*c.a,c.a);}
 if(operation==10){var xy=(globalPixel(uv)/params.outputSize-q.xy)*2.;xy.x/=q.z;let distance=mix(max(abs(xy.x),abs(xy.y)),length(xy)/1.41421356237,q.w)/p.z;let dark=smoothstep(1.-p.y,1.,distance)*p.x;let b=brush(uv);return vec4f(mix(c.rgb,b.rgb*c.a,vec3f(dark*b.a)),c.a);}
 if(operation==11){let xy=(vec2f(fragPos.x,fragPos.y)*p.x-p.yz)/params.dimensions;return sampleAt(vec2f(xy.x,1.-xy.y));}
 if(operation==12){let xy=(vec2f(fragPos.x,fragPos.y)+p.yz)/p.x/params.dimensions;return sampleAt(vec2f(xy.x,1.-xy.y));}
 if(operation==13){return vec4f(1.-c.a);}
 if(operation==14){var a=c.a;for(var i=0;i<16;i++){let angle=f32(i)*PI/8.;a=max(a,sampleAt(uv+vec2f(cos(angle),sin(angle))*p.x/params.dimensions).a);}return vec4f(a);}
 if(operation==15){let front=sampleOrig(uv);let b=brush(uv);var a=select(max(0.,c.a-front.a),c.a*front.a,p.y>0.);a*=p.x*b.a;
  if(p.z>0.){return vec4f(b.rgb*a,a);}
  if(p.y>0.){return vec4f(mix(front.rgb,b.rgb*front.a,vec3f(clamp(c.a*p.x*b.a,0.,1.))),front.a);}
  return front+vec4f(b.rgb*a,a)*(1.-front.a);}
 if(operation==16){let xy=globalPixel(uv);let delta=xy-q.xy*params.outputSize;var dir=select(normalize(delta+vec2f(.00001)),vec2f(cos(p.z),sin(p.z)),p.y==1.);if(p.y==3.){dir=vec2f(-dir.y,dir.x);}var sum=vec4f(0.);for(var i=0;i<33;i++){let t=f32(i)/32.-.5;sum+=sampleGlobal(xy+dir*p.x*t*2.);}return sum/33.;}
 if(operation==17){let n=noiseAt(globalPixel(uv)/p.y,p.w,1.);var keep:f32;if(p.x<=0.){keep=1.;}else if(p.x>=1.){keep=0.;}else{keep=smoothstep(p.x-p.z,p.x+p.z,n);}let edge=(1.-smoothstep(p.x,p.x+q.x+p.z,n))*keep;let b=brush(uv);return vec4f(mix(c.rgb,b.rgb*c.a,vec3f(edge*b.a))*keep,c.a*keep);}
 if(operation==18){let delta=vec2f(cos(p.y),sin(p.y))*p.x;let xy=globalPixel(uv);let red=sampleGlobal(xy+delta*q.x);let green=sampleGlobal(xy+delta*q.y);let blue=sampleGlobal(xy+delta*q.z);let alpha=max(red.a,max(green.a,blue.a));return vec4f(red.r,green.g,blue.b,alpha);}
 if(operation==19){let axis=vec2f(cos(p.z),sin(p.z));let xy=globalPixel(uv);let wave=sin(dot(xy,axis)*2.*PI/p.y+p.w);return sampleGlobal(xy+vec2f(-axis.y,axis.x)*wave*p.x);}
 if(operation==20){let xy=globalPixel(uv);let delta=xy-q.xy*params.outputSize;let distance=length(delta);let ring=(distance-p.x)/p.y;let strength=sin(ring*PI)*pow(max(0.,1.-abs(ring)),p.w)*p.z;return sampleGlobal(xy+delta/max(.0001,distance)*strength);}
 if(operation==21){let l=max(rgb.r,max(rgb.g,rgb.b));let mask=smoothstep(p.x-p.y,p.x+p.y,l);return c*mask;}
 if(operation==22){let front=sampleOrig(uv);let b=brush(uv);return vec4f(min(front.rgb+c.rgb*b.rgb*b.a*p.x,vec3f(max(front.a,c.a))),max(front.a,c.a));}
 if(operation==23){let xy=globalPixel(uv)/params.outputSize-vec2f(.5);let position=dot(xy,vec2f(cos(p.y),sin(p.y)))+.5;let distance=abs(position-p.x)*2./p.z;let light=1.-smoothstep(1.-p.w,1.,distance);let b=brush(uv);return vec4f(clamp(c.rgb+b.rgb*b.a*light*q.x*c.a,vec3f(0.),vec3f(c.a)),c.a);}
 if(operation==24){let xy=globalPixel(uv);let pos=xy/params.outputSize*2.-vec2f(1.);let warped=(pos*(1.+p.z*dot(pos,pos))*.5+vec2f(.5))*params.outputSize;var s=sampleGlobal(warped);if(any(warped<vec2f(0.))||any(warped>=params.outputSize)){s=vec4f(0.);}if(p.w>0.){s.r=sampleGlobal(warped+vec2f(p.w,0.)).r;s.b=sampleGlobal(warped-vec2f(p.w,0.)).b;s=vec4f(min(s.rgb,vec3f(s.a)),s.a);}let line=(.5+.5*cos((xy.y+q.x)*2.*PI/p.y))*p.x;let b=brush(uv);return vec4f(mix(s.rgb,b.rgb*s.a,vec3f(line*b.a)),s.a);}
 if(operation==25){let front=sampleOrig(uv);let inner=sampleMask(uv);let b=brush(uv);let outer=max(0.,c.a-front.a)*p.x*b.a;let ring=inner+vec4f(b.rgb*outer,outer)*(1.-inner.a);if(p.y>0.){return ring;}return ring+front*(1.-ring.a);}
 if(operation==26){return mix(sampleOrig(uv),c,p.x);}
 if(operation==27){var xy=globalPixel(uv)/p.y+vec2f(p.z*.73,p.z*1.17);var offset=vec2f(0.);var weight=1.;var total=0.;for(var i=0;i<4;i++){if(f32(i)>=q.x){break;}offset+=vec2f(noiseAt(xy,p.w+f32(i)*37.,1.),noiseAt(xy+vec2f(19.1,7.7),p.w+131.+f32(i)*37.,1.))*weight;total+=weight;weight*=.5;xy*=2.;}return sampleGlobal(globalPixel(uv)+(offset/total*2.-vec2f(1.))*p.x);}
 return c;}`;
const UNIFORM_SIZE=736,UNIFORM_STRIDE=1024,UNIFORM_SLOTS=64,IDLE_MS=30000;
/** WebGPU executor mirroring VfxGPU: one pipeline per operation, ping-pong
 * texture slots, identical uniform semantics. run() accepts a canvas source;
 * pass texture:true to receive the padded result texture instead of a canvas. */
export class VfxWebGPU{
 constructor(device){
  this.device=device;this.canvas=new OffscreenCanvas(1,1);this.context=null;
  this.module=device.createShaderModule({code,label:'VFX WGSL'});
  this.layout=device.createBindGroupLayout({entries:[
   {binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{}},
   {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{}},
   {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{}},
   {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
   {binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{}}]});
  this.pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[this.layout]});
  this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
  this.blank=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
  this.uniforms=device.createBuffer({size:UNIFORM_STRIDE*UNIFORM_SLOTS,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.staging=new ArrayBuffer(UNIFORM_SIZE);this.f32=new Float32Array(this.staging);this.i32=new Int32Array(this.staging);
  this.paintColors=new Float32Array(128);this.paintOffsets=new Float32Array(32);
  this.slots=[];this.retired=[];this.pipelines=new Map();this.stats={passes:0,bytes:0,calls:0};
 }
 descriptor(operation){return {layout:this.pipelineLayout,vertex:{module:this.module,entryPoint:'vertex'},fragment:{module:this.module,entryPoint:'fragment',constants:{operation},targets:[{format:'rgba8unorm'}]}};}
 pipeline(operation){
  if(!Number.isInteger(operation)||operation<0||operation>27)throw messageError(new RangeError(''), "errors.vfxGpu.unknownVfxGraphicsOperation", {});
  let entry=this.pipelines.get(operation);if(!entry){entry=this.device.createRenderPipeline(this.descriptor(operation));this.pipelines.set(operation,entry);}return entry;
 }
 /** Compile every operation ahead of the frame that first needs it. A pipeline
  * created on demand compiles on the thread that executes this device's
  * commands, stalling presentation the first time each effect appears;
  * asynchronous creation does not. A pipeline needed sooner is created on
  * demand as before, and whichever finishes first is kept. */
 prewarm(){
  if(this.prewarmed||!this.device.createRenderPipelineAsync)return;this.prewarmed=true;
  for(let operation=0;operation<=27;operation++)if(!this.pipelines.has(operation))
   this.device.createRenderPipelineAsync(this.descriptor(operation)).then(pipeline=>{if(!this.destroyed&&!this.pipelines.has(operation))this.pipelines.set(operation,pipeline);},()=>{});
 }
 slot(index,width,height){
  let slot=this.slots[index];
  if(!slot){slot={texture:null,view:null,width:0,height:0};this.slots[index]=slot;}
  // Resizing mid-run must not destroy the old texture: passes already recorded
  // into the current encoder still reference it, and an immediate destroy()
  // would invalidate the whole submission. Retired textures are released after
  // the run's submits instead.
  if(slot.width!==width||slot.height!==height){slot.width=width;slot.height=height;if(slot.texture)this.retired.push(slot.texture);slot.texture=this.device.createTexture({label:`VFX slot ${index}`,size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});slot.view=slot.texture.createView();}
  return slot;
 }
 run(source,stack,{scale=1,origin={x:0,y:0},outputSize,pad=0,texture=false}={}){
  stack=activeVfx(stack);if(!stack.length)return texture?null:source;
  const w=source.width,h=source.height,W=w+2*pad,H=h+2*pad;
  if(!fitsVfxSurface(W,H,this.device.limits.maxTextureDimension2D))throw vfxSurfaceError();
  if(source.texture&&pad)throw messageError(new Error(''), "errors.vfxWebgpu.gpuArtworkMustIncludeItsEffectPadding", {});
  const input=source.texture?{texture:source.texture,view:source.texture.createView(),width:w,height:h}:this.slot(0,W,H);
  if(pad){const clear=this.device.createCommandEncoder(),rp=clear.beginRenderPass({colorAttachments:[{view:input.view,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});rp.end();this.device.queue.submit([clear.finish()]);}
  if(!source.texture)this.device.queue.copyExternalImageToTexture({source},{texture:input.texture,origin:[pad,pad,0],premultipliedAlpha:true},[w,h]);
  if(!texture){if(this.canvas.width!==W)this.canvas.width=W;if(this.canvas.height!==H)this.canvas.height=H;if(!this.context){this.context=this.canvas.getContext('webgpu');if(!this.context)throw messageError(new Error(''), "errors.vfxWebgpu.vfxRequireAnAvailableWebgpuCanvasContext", {});}if(!this.configured){this.context.configure({device:this.device,format:'rgba8unorm',alphaMode:'premultiplied'});this.configured=true;}}
  this.stats.passes=0;let brushType=0,brushAngle=0,brushStops=1;
  let current=input,encoder=this.device.createCommandEncoder(),uOffset=0;
  const submit=()=>{this.device.queue.submit([encoder.finish()]);encoder=this.device.createCommandEncoder();uOffset=0;};
  const pass=(operation,p=[0,0,0,0],q=[0,0,0,0],original=current,width=W,height=H,screen=false,mask=null)=>{
   const f=this.f32,i=this.i32;f.fill(0);i.fill(0);
   f[0]=current.width;f[1]=current.height;f[2]=origin.x;f[3]=origin.y;f[4]=outputSize?.width??w;f[5]=outputSize?.height??h;
   i[6]=brushType;i[7]=brushStops;f[8]=brushAngle;
   f.set(p,12);f.set(q,16);f.set(this.paintColors,24);f.set(this.paintOffsets,152);
   this.device.queue.writeBuffer(this.uniforms,uOffset,this.staging);
   const next=screen?null:this.slot([1,2,3].find(x=>this.slots[x]!==current&&this.slots[x]!==original&&this.slots[x]!==mask)??6,width,height);
   const bindGroup=this.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:current.view},{binding:1,resource:original?.view??this.blank.createView()},{binding:2,resource:mask?.view??this.blank.createView()},{binding:3,resource:this.sampler},{binding:4,resource:{buffer:this.uniforms,offset:uOffset,size:UNIFORM_SIZE}}]});
   const rp=encoder.beginRenderPass({colorAttachments:[{view:screen?this.context.getCurrentTexture().createView():next.view,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
   rp.setPipeline(this.pipeline(operation));rp.setBindGroup(0,bindGroup);rp.draw(3);rp.end();
   this.stats.passes++;uOffset+=UNIFORM_STRIDE;if(uOffset+UNIFORM_STRIDE>this.uniforms.size)submit();if(next)current=next;
  };
  if(source.texture)pass(0); // Resolve the source format before RGBA-only scratch copies.
  const blur=radius=>{if(radius<=0)return;const factor=Math.max(1,Math.ceil(radius/20)),ox=factor>1?((origin.x%factor)+factor)%factor:0,oy=factor>1?((origin.y%factor)+factor)%factor:0,bw=Math.max(1,Math.ceil((W+ox)/factor)),bh=Math.max(1,Math.ceil((H+oy)/factor));if(factor>1)pass(11,[factor,ox,oy,bh],undefined,current,bw,bh);const r=Math.min(128,Math.max(1,Math.round(radius/factor*.57735)));for(let i=0;i<3;i++){pass(3,[r,0,0,0],undefined,current,bw,bh);pass(4,[r,0,0,0],undefined,current,bw,bh);}if(factor>1)pass(12,[factor,ox,oy,H]);};
  const paint=value=>{const brush=vfxPaint(value);brushType=['solid','linear','radial','angular','diamond'].indexOf(brush.type);brushAngle=brush.angle*Math.PI/180;brushStops=brush.stops.length;brush.stops.forEach((s,x)=>{this.paintColors.set([...s.color.map(n=>n/255),s.opacity],x*4);this.paintOffsets[x]=s.offset;});};
  const save=(index=4)=>{const saved=this.slot(index,W,H);encoder.copyTextureToTexture({texture:current.texture},{texture:saved.texture},[W,H]);return saved;};
  const morph=(radius,rounded=false)=>{radius=Math.ceil(radius);let step=1;while(radius>0){const amount=Math.min(rounded?step:128,radius);if(rounded)pass(14,[amount,0,0,0]);else{pass(5,[amount,0,0,0]);pass(6,[amount,0,0,0]);}radius-=amount;step*=2;}};
  try{for(const {type,params:p} of stack){
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
    if(p.mode===2){pass(13);morph(width,p.rounded);pass(15,[p.opacity,1,1,0],undefined,saved);const inner=save(5);current=saved;morph(width,p.rounded);pass(25,[p.opacity,p.only,0,0],undefined,saved,W,H,false,inner);}
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
  if(!texture)pass(0,undefined,undefined,current,W,H,true);
  submit();this.stats.calls++;this.stats.bytes=(W*H+this.slots.reduce((n,s)=>n+(s?s.width*s.height:0),0))*4;
  return texture?{texture:current.texture,width:W,height:H}:this.canvas;
  }finally{
   for(const retired of this.retired)retired.destroy();this.retired.length=0;
   // Every caller shares this lifetime: working pixels leave after a quiet
   // period, compiled pipelines stay until the device goes.
   clearTimeout(this.idleTimer);this.idleTimer=setTimeout(()=>{this.idleTimer=undefined;this.releasePixels();},IDLE_MS);this.idleTimer.unref?.();
  }
 }
 /** Release the working textures. A result returned by run() is copied by its
  * caller in the same task, so nothing still reads these. */
 releasePixels(){for(const slot of this.slots)slot?.texture?.destroy();this.slots=[];this.stats.bytes=0;}
 destroy(){this.destroyed=true;clearTimeout(this.idleTimer);this.idleTimer=undefined;for(const slot of this.slots)slot?.texture?.destroy();this.slots=[];for(const retired of this.retired)retired.destroy();this.retired=[];this.uniforms?.destroy();this.blank?.destroy();if(this.configured)this.context?.unconfigure();this.canvas.width=this.canvas.height=1;}
}
const executors=new WeakMap();
export function vfxWebGPUFor(device){let executor=executors.get(device);if(!executor){executor=new VfxWebGPU(device);executors.set(device,executor);}return executor;}
export function releaseVfxWebGPU(device){const executor=executors.get(device);if(executor){executors.delete(device);executor.destroy();}}
