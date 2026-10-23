import {activeVfx,vfxStack} from './vfx.mjs';
import {compileVectorObject,objectBounds} from './renderer-geometry.mjs';
import {supportsVectorIsolation,rasterizeVectorGroup} from './renderer-vector-raster.mjs';
import {vfxWebGPUFor} from './vfx-webgpu.mjs';

/** One opaque isolation group can stay on the same GPU through rasterization
 * and filtering. Nested effects and Canvas-only artwork retain their renderer. */
export function vectorVfxSource(items,resolution){
 const owner=items[0]?._movieclipOwner,object=items[0]?.obj,stack=activeVfx(owner?.effects??vfxStack(object));
 if(!stack.length||owner?.sceneEffects?.length||owner&&owner.opacity!==1)return null;
 const clean=[];
 for(const item of items){
  if(item._movieclipOwner!==owner||item._movieclipInner||item.opacity<.999999||!owner&&item.obj!==object)return null;
  if(Object.entries(item.obj?._stykVfx??{}).some(([key,effects])=>(owner||key!=='figure')&&activeVfx(effects).length))return null;
  clean.push({...item,_movieclipOwner:undefined,_movieclipInner:undefined,obj:{...item.obj,_stykVfx:undefined}});
 }
 return supportsVectorIsolation(clean,resolution)?{items:clean,stack,scale:Math.abs(owner?.scale??object?.scale??1),domain:owner?.domainBounds}:null;
}
/** Artwork painted by Canvas whose only effects are its outermost stack: the
 * same artwork without that stack, and the stack to run where it is presented.
 * Filtering inside the Canvas painter moves the pixels into the effect
 * executor and back before the renderer uploads the result, three transfers
 * that each wait for the graphics process. Inner effects and translucent
 * owners keep the complete painter, which composites them in its own order. */
export function canvasVfxSource(items){
 const owner=items[0]?._movieclipOwner,object=items[0]?.obj,stack=activeVfx(owner?owner.effects:vfxStack(object));
 if(!stack.length||owner?.sceneEffects?.length||owner&&owner.opacity!==1)return null;
 const bare=owner&&{...owner,effects:[]},objects=new Map(),clean=[];
 for(const item of items){
  if(item._movieclipOwner!==owner)return null;
  if(owner){
   if(Object.values(item.obj?._stykVfx??{}).some(effects=>activeVfx(effects).length))return null;
   for(let inner=item._movieclipInner;inner;inner=inner.inner)if(activeVfx(inner.owner?.effects).length)return null;
   clean.push({...item,_movieclipOwner:bare});
  }else{
   if(item.obj!==object||item._movieclipInner||item.opacity<.999999)return null;
   if(Object.entries(item.obj._stykVfx??{}).some(([key,effects])=>key!=='figure'&&activeVfx(effects).length))return null;
   let bareObject=objects.get(item.obj);if(!bareObject){bareObject={...item.obj,_stykVfx:undefined};objects.set(item.obj,bareObject);}
   clean.push({...item,obj:bareObject});
  }
 }
 return {items:clean,stack,scale:Math.abs(owner?.scale??object?.scale??1),domain:owner?.domainBounds};
}
/** Filter unfiltered artwork pixels (a GPU raster, bitmap or canvas covering
 * `bounds`) on the renderer's device and retain the result as one texture. */
export function filterArtworkVfx(renderer,source,image,{width,height,pixelScale,bounds,label='Filtered artwork'}){
 const domain=source.domain??objectBounds(source.items,{...renderer.resources,vfxBounds:false});let texture;
 try{
  const output=vfxWebGPUFor(renderer.device).run(image,source.stack,{texture:true,scale:pixelScale*source.scale,origin:{x:(bounds.x-domain.x)*pixelScale,y:(bounds.y-domain.y)*pixelScale},outputSize:{width:domain.width*pixelScale,height:domain.height*pixelScale}});
  texture=renderer.device.createTexture({label,size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  const encoder=renderer.device.createCommandEncoder({label:`Retain ${label}`});encoder.copyTextureToTexture({texture:output.texture},{texture},[width,height]);renderer.device.queue.submit([encoder.finish()]);
  return {texture,bindGroup:renderer.textureBindGroup(texture),width,height,bytes:width*height*4};
 }catch(error){texture?.destroy();throw error;}
}
export function rasterizeVectorVfx(renderer,source,{width,height,pixelScale,bounds,root}){
 const data=source.data??compileVectorObject(source.items,root,0);
 const raster=rasterizeVectorGroup(renderer,{data,width,height,pixelScale,bounds,root});
 try{return filterArtworkVfx(renderer,source,raster,{width,height,pixelScale,bounds,label:'Filtered vector artwork'});}
 finally{raster.texture.destroy();}
}
