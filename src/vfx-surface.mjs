import {messageError} from './localized-error.mjs';
// One shared allocation contract for Canvas, WebGL, WebGPU and export tiles.
// Rectangles and padding are in output pixels; effect parameters stay authored.
export const VFX_MAX_PIXELS = 16777216;
export const VFX_MAX_DIMENSION = 4096;
export function vfxSurfaceError() {
  return Object.assign(messageError(new Error(''), "errors.vfxSurface.theEffectSamplingRegionExceedsTheGraphicsBudget", {}), {code:'vfx_surface_budget',telemetryCode:'out_of_memory'});
}
export function fitsVfxSurface(width,height,limit=VFX_MAX_DIMENSION) {
  return Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&Math.max(width,height)<=limit&&width*height<=VFX_MAX_PIXELS;
}
/** Lazy tiles retain only a halo and one output core, never an output-sized list. */
export function* vfxSurfaceTiles(rect,canvas,pad,limit=VFX_MAX_DIMENSION) {
  const edge=Math.min(limit,Math.floor(Math.sqrt(VFX_MAX_PIXELS)));
  const core=Math.min(1024,edge-2*pad);
  if(!Number.isSafeInteger(pad)||pad<0||core<1)throw vfxSurfaceError();
  const left=Math.max(0,rect.x),top=Math.max(0,rect.y),right=Math.min(canvas.width,rect.x+rect.width),bottom=Math.min(canvas.height,rect.y+rect.height);
  for(let y=top;y<bottom;y+=core)for(let x=left;x<right;x+=core){
    const width=Math.min(core,right-x),height=Math.min(core,bottom-y);
    const sx=Math.max(rect.x,x-pad),sy=Math.max(rect.y,y-pad),ex=Math.min(rect.x+rect.width,x+width+pad),ey=Math.min(rect.y+rect.height,y+height+pad);
    yield {x:sx,y:sy,width:ex-sx,height:ey-sy,output:{x,y,width,height}};
  }
}
