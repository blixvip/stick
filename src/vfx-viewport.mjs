import {activeVfx,vfxStack} from './vfx.mjs';
import {vfxGPUStats} from './vfx-gpu.mjs';
import {CameraVfx} from './vfx-camera.mjs';
import {CameraGpuSource,fullscreenTextureShader as shader} from './vfx-camera-gpu.mjs';
import {vfxWebGPUFor} from './vfx-webgpu.mjs';
import {onionLayerEnd} from './onion-surface-cache.mjs';
// Project the filtered camera surface over the artboard rect: v covers
// [0,1]^2 across the report canvas, affine maps it into viewport pixels, and
// uv.xy/zw select the filtered texture's unpadded centre.
const quadShader=`struct Quad{affine:vec4f,extra:vec4f,uv:vec4f};
@group(0) @binding(0) var<uniform> quad:Quad;
@group(0) @binding(1) var tex:texture_2d<f32>;
@group(0) @binding(2) var smp:sampler;
struct QOut{@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn vertex(@builtin(vertex_index) i:u32)->QOut{
 var v=array<vec2f,6>(vec2f(0.,0.),vec2f(1.,0.),vec2f(0.,1.),vec2f(0.,1.),vec2f(1.,0.),vec2f(1.,1.));
 let t=v[i];let px=vec2f(quad.affine.x*t.x+quad.affine.z*t.y+quad.extra.x,quad.affine.y*t.x+quad.affine.w*t.y+quad.extra.y);
 return QOut(vec4f(px.x/quad.extra.z*2.-1.,1.-px.y/quad.extra.w*2.,0.,1.),quad.uv.xy+t*quad.uv.zw);
}
@fragment fn fragment(@location(0) uv:vec2f)->@location(0) vec4f{return textureSampleLevel(tex,smp,uv,0.);}`;
export const hasSceneVfx=frame=>Boolean(activeVfx(vfxStack(frame)).length);
/** Filter the completed GPU artwork on-device and project the camera image
 * back into the viewport, then draw editing handles after processing. No pixel
 * readback. */
export class ViewportVfx{
 constructor(renderer){this.renderer=renderer;const d=renderer.device,module=d.createShaderModule({code:shader,label:'VFX final composition'}),quadModule=d.createShaderModule({code:quadShader,label:'VFX camera projection'});this.pipeline=d.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:renderer.format}]},multisample:{count:renderer.msaaCount}});this.quadPipeline=d.createRenderPipeline({layout:'auto',vertex:{module:quadModule,entryPoint:'vertex'},fragment:{module:quadModule,entryPoint:'fragment',targets:[{format:renderer.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},multisample:{count:renderer.msaaCount}});this.quadUniform=d.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.quadFloats=new Float32Array(12);}
 render(options){const r=this.renderer,d=r.device,w=r.canvas.width,h=r.canvas.height;
  if(!this.camera){this.cameraSource=new CameraGpuSource(r);this.camera=new CameraVfx({paint:(...args)=>this.cameraSource.paint(...args),texturePaint:true,getPaintRevision:()=>this.cameraSource.paintRevision()});}
  const camera=this.camera.renderTexture({...options,resourceRevision:[r.generation,r.drawingGpu?.presentationKey]},r.dpr,r.resources,vfxWebGPUFor(d));
  if(this.width!==w||this.height!==h||this.format!==r.format){this.texture?.destroy();this.width=w;this.height=h;this.format=r.format;this.texture=d.createTexture({label:'VFX processed viewport',size:[w,h],format:r.format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});this.bindGroup=d.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:this.texture.createView()},{binding:1,resource:r.sampler}]});}
  const encoder=d.createCommandEncoder();
  // Snapshot the rendered frame so the composite can keep the workspace around
  // the artboard, then rebuild the canvas from the two textures.
  encoder.copyTextureToTexture({texture:r.context.getCurrentTexture()},{texture:this.texture},[w,h]);
  const destination=r.context.getCurrentTexture().createView();
  let pass=encoder.beginRenderPass({colorAttachments:[{...r.colorAttachment(destination),storeOp:'store'}]});
  pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bindGroup);pass.draw(3);
  if(camera){const cw=camera.report.canvas_width,ch=camera.report.canvas_height,[a,b,c,d2,e,f]=camera.affine,tw=camera.texture.width??camera.surface.width,th=camera.texture.height??camera.surface.height;
   this.quadFloats.set([a*cw,b*cw,c*ch,d2*ch,e,f,w,h,camera.pad/tw,camera.pad/th,camera.surface.width/tw,camera.surface.height/th]);
   d.queue.writeBuffer(this.quadUniform,0,this.quadFloats);
   pass.setPipeline(this.quadPipeline);pass.setBindGroup(0,d.createBindGroup({layout:this.quadPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.quadUniform}},{binding:1,resource:camera.texture.createView()},{binding:2,resource:r.sampler}]}));pass.draw(6);}
  if(!options.preparedFrame)for(let i=0;i<r.layout.length;i++){
   const entry=r.layout[i];if(!entry.isOnion)continue;
   const end=onionLayerEnd(r.layout,i);
   pass=r.onionComposite.draw(encoder,destination,pass,r.layout,i,end).pass;i=end-1;
  }
  if(options.canvasHandles)r.handleRenderer.draw(pass);pass.end();d.queue.submit([encoder.finish()]);
  r.stats.vfx={...vfxGPUStats(),viewportBytes:w*h*8,cameraBytes:(this.cameraSource?.width??0)*(this.cameraSource?.height??0)*24};
 }
 destroy(){this.texture?.destroy();this.quadUniform?.destroy();this.camera?.destroy();this.cameraSource?.destroy();}
}
