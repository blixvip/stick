import {parallaxResolver} from './layer-parallax.mjs';
import {cameraMatrix,shapeRecord,SHAPE,SHAPE_BYTES,argbFloats} from './renderer-geometry.mjs';
import {opacityArtwork} from './renderer-opacity.mjs';
import {drawBackground,backgroundBounds,sceneBackgroundColor} from './pivot/background.mjs';
import {sceneVfxBounds} from './vfx-scene.mjs';
import {encodePreparedCommands} from './prepared-frames.mjs';
import {offsetGeneratorBatch,generatorSchedule,scheduleWalker} from './vfx-generator-frame.mjs';

/** One texture drawn over a whole target; the image's first row is the top. */
export const fullscreenTextureShader=`@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var sourceSampler:sampler;
struct VOut{ @builtin(position) position:vec4f, @location(0) uv:vec2f };
@vertex fn vertex(@builtin(vertex_index) i:u32)->VOut {let p=vec2f(f32((i<<1u)&2u),f32(i&2u));return VOut(vec4f(p*2.-1.,0.,1.),vec2f(p.x,1.-p.y));}
@fragment fn fragment(@location(0) uv:vec2f)->@location(0) vec4f {return textureSampleLevel(source,sourceSampler,uv,0.);}`;

/** Re-render retained GPU artwork into camera coordinates. Share the device,
 * primitive buffers and textures; own one camera texture, its MSAA target and
 * the scene background. The image never leaves the device: drawing it through
 * a Canvas and copying it back for filtering waited on the graphics process
 * twice for every presented frame. */
export class CameraGpuSource {
 constructor(renderer){this.renderer=renderer;}
 /** The scene background in camera coordinates, including the effect sampling
  * margin. A color clears the pass and solid or gradient backgrounds draw as
  * the renderer's own shape records, so a moving camera costs nothing. Painted
  * and image backgrounds use the native Canvas painter and upload only when
  * the background, the camera or the size changes. */
 background(options,width,height,plan,matrix){
  const r=this.renderer,{report,frame}=options,color=sceneBackgroundColor(report,frame);
  if(color!==undefined){const [red,green,blue,alpha]=argbFloats(color);return {clearValue:{r:red*alpha,g:green*alpha,b:blue*alpha,a:alpha}};}
  const clearValue={r:0,g:0,b:0,a:0},viewport=sceneVfxBounds(report,plan);
  const layers=[Number(frame.background_id),...(frame.background_mix?[Number(frame.background_id_b)]:[])].map(id=>report.backgrounds?.find(b=>Number(b.background_id)===id));
  if(layers.every(bg=>!bg||!bg.paint&&(bg.kind===2||bg.kind===3||bg.kind===4||bg.color!==undefined))){
   const records=r.background({report,frame,cameraEnabled:true,backgroundViewport:viewport},()=>null);
   if(!this.shapes){
    this.shapes=r.device.createBuffer({label:'VFX camera background',size:2*SHAPE_BYTES,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.transforms=r.device.createBuffer({label:'VFX camera background transform',size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    r.device.queue.writeBuffer(this.transforms,0,new Float32Array([0,0,1,1]));
    this.shapeBindGroup=r.device.createBindGroup({layout:r.globalLayout,entries:[{binding:0,resource:{buffer:r.uniform}},{binding:1,resource:{buffer:this.shapes}},{binding:2,resource:{buffer:this.transforms}}]});
   }
   const count=Math.min(2,records.length);
   for(let index=0;index<count;index++)r.device.queue.writeBuffer(this.shapes,index*SHAPE_BYTES,records[index].data);
   return {clearValue,records:count};
  }
  const signature=JSON.stringify([r.generation,width,height,matrix,plan.pad,frame.background_mix,layers.map(bg=>bg?[bg.background_id,bg.kind,bg.color,bg.color_a,bg.color_b,bg.x1,bg.y1,bg.x2,bg.y2,bg.paint,r.resources.url?.(bg)]:null)]);
  if(this.backgroundReport!==report||this.backgroundSignature!==signature||!this.backgroundTexture){
   const canvas=this.backgroundCanvas??=new OffscreenCanvas(width,height);
   if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
   // A software surface uploads from memory as a detached bitmap.
   const context=this.backgroundContext??=canvas.getContext('2d',{willReadFrequently:true});
   context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,width,height);context.save();context.transform(...matrix);
   drawBackground(context,report,frame,report.canvas_width,report.canvas_height,{...r.resources,
    bounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,true,report,viewport),
    paintBounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,true,report)});
   context.restore();
   const image=canvas.transferToImageBitmap();
   try{
    if(this.backgroundTexture?.width!==width||this.backgroundTexture.height!==height){
     this.backgroundTexture?.destroy();this.backgroundBindGroup=null;
     this.backgroundTexture=r.device.createTexture({label:'VFX camera background',size:[width,height],format:'rgba8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    }
    r.device.queue.copyExternalImageToTexture({source:image},{texture:this.backgroundTexture,premultipliedAlpha:true},[width,height]);
   }finally{image.close();canvas.width=canvas.height=1;}
   this.backgroundReport=report;this.backgroundSignature=signature;this.stats.backgroundUploads++;
  }
  this.backgroundBindGroup??=r.device.createBindGroup({layout:this.blit.getBindGroupLayout(0),entries:[{binding:0,resource:this.backgroundTexture.createView()},{binding:1,resource:r.nearestSampler}]});
  return {clearValue,bindGroup:this.backgroundBindGroup};
 }
 /** Density already published by the viewport layout. Vector-only sources
  * retain their existing key, without inspecting primitives or textures. */
 paintRevision(){const r=this.renderer;return r.stats.textureObjects||r.stats.croppedTextureObjects||r.stats.outlinedVectorObjects?r.lastRasterResolution:undefined;}
 paint(target,options,width,height,plan){
  const r=this.renderer,{report,frame}=options,scale=plan.outputSize.width/report.canvas_width;
  const samples=r.msaaCount>1?r.msaaCount:0;this.stats??={paints:0,backgroundUploads:0};this.stats.paints++;
  if(this.msaaSamples!==samples||this.format!==r.format||!this.blit){
   const module=this.module??=r.device.createShaderModule({code:fullscreenTextureShader,label:'VFX camera background'});
   this.blit=r.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:r.format}]},multisample:{count:samples||1}});
   this.backgroundBindGroup=null;
  }
  if(this.width!==width||this.height!==height||this.msaaSamples!==samples||this.format!==r.format){
   this.width=width;this.height=height;this.format=r.format;
   this.target?.destroy();this.msaa?.destroy();this.msaaSamples=samples;
   this.target=r.device.createTexture({label:'VFX camera source',size:[width,height],format:r.format,
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
   this.msaa=samples?r.device.createTexture({label:'VFX camera MSAA',size:[width,height],sampleCount:samples,format:r.format,usage:GPUTextureUsage.RENDER_ATTACHMENT}):null;
  }
  const matrix=cameraMatrix({report,frame,view:{scale,x:-plan.viewport.x,y:-plan.viewport.y},cameraEnabled:true});
  const background=this.background(options,width,height,plan,matrix);
  const uniform=new Float32Array([matrix[0],matrix[2],matrix[4],Math.hypot(matrix[0],matrix[1]),matrix[1],matrix[3],matrix[5],0,width,height,1,1,0,0,width,height]);
  const restored=[],lease=r.rasterCache.lease();
  try{
  r.device.queue.writeBuffer(r.uniform,0,uniform);
  if(!options.preparedFrame&&options.cameraEnabled===false){
    if(this.depthTransforms?.length!==r.transformData.length)this.depthTransforms=new Float32Array(r.transformData.length);
    this.depthTransforms.set(r.transformData);const depth=parallaxResolver(report,frame);
    for(const entry of r.layout){if(!entry.g||entry.isOnion)continue;const d=depth(entry.uid),i=entry.transform*4;this.depthTransforms[i]+=d.x;this.depthTransforms[i+1]+=d.y;}
    r.device.queue.writeBuffer(r.transformBuffer,0,this.depthTransforms);
  }
  const encoder=r.device.createCommandEncoder({label:'VFX camera artwork'}),drawingGpu=r.drawingGpu,drawings=new Map(),cameraEntries=new Map();
  if(!options.preparedFrame)for(const entry of r.layout){
   if(entry.isOnion||options.hiddenUids?.has(entry.uid)||!entry.drawing||entry.gpuDrawing)continue;
   // The editor scratch covers its viewport, which can omit artwork sampled
   // by the camera after a drag, rotation or parallax shift. Reuse the bounded
   // artwork owner for an independently sampled camera source.
   const {source,items}=opacityArtwork(entry.g,entry.drawingItems);
   // A live stroke may widen tile coverage without replacing its geometry.
   r.boundsCache?.delete(source);
   const texture=r.rasterObject(source,items,Math.hypot(matrix[0],matrix[1]));
   if(!texture)continue;lease.add(texture);
   const b=texture.bounds,origin=texture.origin,data=new Float32Array(shapeRecord({
    a:[b.x-origin.x,b.y-origin.y,b.x+b.width-origin.x,b.y+b.height-origin.y],gradient:texture.region,
    color:[1,1,1,1],mode:SHAPE.TEXTURE,transform:entry.transform}));
   const cameraEntry={...entry,data,texture,count:1};cameraEntries.set(entry,cameraEntry);restored.push(entry);r.uploadEntry(cameraEntry);
  }
  if(!options.preparedFrame&&drawingGpu&&!drawingGpu.destroyed){
   const transforms=options.cameraEnabled===false?this.depthTransforms:r.transformData;
   for(const entry of r.layout)if(entry.gpuDrawing&&!entry.isOnion&&!options.hiddenUids?.has(entry.uid)){
    const at=entry.transform*4,translation={x:transforms[at]-entry.source.root.x,y:transforms[at+1]-entry.source.root.y};
    drawings.set(entry,drawingGpu.prepare(entry.drawing,r.gpuDrawingView(entry,matrix,{width,height,dpr:1,translation})));
   }
   drawingGpu.encode(encoder);
  }
  const pass=encoder.beginRenderPass({colorAttachments:[this.msaa
   ?{view:this.msaa.createView(),resolveTarget:this.target.createView(),clearValue:background.clearValue,loadOp:'clear',storeOp:'discard'}
   :{view:this.target.createView(),clearValue:background.clearValue,loadOp:'clear',storeOp:'store'}]});
  if(background.bindGroup){pass.setPipeline(this.blit);pass.setBindGroup(0,background.bindGroup);pass.draw(3);}
  const prepared=options.preparedFrame;
  pass.setPipeline(r.pipeline);
  if(background.records){pass.setBindGroup(0,this.shapeBindGroup);pass.setBindGroup(1,r.blankBindGroup);pass.draw(6,background.records,0,0);}
  pass.setBindGroup(0,prepared?.bindGroup??r.globalBindGroup);
  if(prepared){
   encodePreparedCommands(r,pass,prepared,{hiddenUids:options.hiddenUids,dragTranslations:options.dragTranslations,skipBackground:true});
  }else{
  let begin=-1,count=0;
  const flush=()=>{if(count){pass.setBindGroup(1,r.blankBindGroup);pass.draw(6,count,0,begin);count=0;begin=-1;}};
  // Generated effects: the editor pass's batch, plus camera parallax in world view.
  const depth=options.cameraEnabled===false?parallaxResolver(report,frame):null,batch=depth?offsetGeneratorBatch(r.lastGeneratorBatch,depth):r.lastGeneratorBatch;
  const plan=batch&&generatorSchedule(batch,options.hiddenUids),gpu=plan&&!plan.empty?r.generatorGpu():null;
  if(gpu)gpu.upload(batch);
  const walker=gpu?scheduleWalker(plan,draws=>{flush();gpu.draw(pass,draws,r.msaaCount,p=>{p.setPipeline(r.pipeline);p.setBindGroup(0,r.globalBindGroup);});}):null;
  walker?.begin();
  for(const original of r.layout){
   const entry=cameraEntries.get(original)??original;
   if(!entry.g||entry.isOnion){flush();continue;}
   walker?.object(entry.uid);
   const drawing=drawings.get(entry);
   if(drawing){flush();drawingGpu.draw(pass,drawing);pass.setPipeline(r.pipeline);pass.setBindGroup(0,r.globalBindGroup);}
   else if(entry.texture){flush();pass.setBindGroup(1,entry.texture.bindGroup);pass.draw(6,entry.count,0,entry.offset);}
   else {if(count&&begin+count!==entry.offset)flush();if(begin<0)begin=entry.offset;count+=entry.capacity;}
  }
  flush();walker?.end();}
  pass.end();r.device.queue.submit([encoder.finish()]);
  }finally{
  // Queue order makes the camera submission see its own uniforms, then restores
  // the editor state before subsequent work on the shared device.
  try{
   for(const entry of restored)r.uploadEntry(entry);
   if(!options.preparedFrame&&options.cameraEnabled===false)r.device.queue.writeBuffer(r.transformBuffer,0,r.transformData);
   if(options.viewportUniforms)r.device.queue.writeBuffer(r.uniform,0,options.viewportUniforms);
  }finally{lease.release();if(!r.destroyed)r.artworkStats();}
  }
  return this.target;
 }
 destroy(){this.msaa?.destroy();this.target?.destroy();this.backgroundTexture?.destroy();this.shapes?.destroy();this.transforms?.destroy();
  this.msaa=this.target=this.backgroundTexture=this.backgroundBindGroup=this.backgroundReport=this.shapes=this.transforms=this.shapeBindGroup=null;
  if(this.backgroundCanvas)this.backgroundCanvas.width=this.backgroundCanvas.height=1;}
}
