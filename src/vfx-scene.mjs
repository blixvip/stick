import {vfxPadding,vfxStack} from './vfx.mjs';
import {fitsVfxSurface,vfxSurfaceError} from './vfx-surface.mjs';

/** Camera coordinates stay fixed while the source includes neighboring artwork.
 * A tile uses the same domain and scale as the full output. No GPU allocation. */
export function sceneVfxPlan(frame,width,height,viewport={width,height,x:0,y:0},scale=1){
 const padding=vfxPadding(vfxStack(frame),scale,Math.max(viewport.width,viewport.height));
 const pad=padding?padding+2:0; // bilinear samples and raster coverage
 return {pad,width:width+2*pad,height:height+2*pad,scale,
  viewport:{...viewport,x:(viewport.x??0)-pad,y:(viewport.y??0)-pad},
  outputSize:{width:viewport.width,height:viewport.height}};
}

export function checkSceneVfxPlan(plan,limit){
 if(!fitsVfxSurface(plan.width,plan.height,limit))throw vfxSurfaceError();
 return plan;
}

export function sceneVfxBounds(report,plan){
 const {viewport:v,width,height}=plan;
 return {x:v.x*report.canvas_width/v.width,y:v.y*report.canvas_height/v.height,
  width:width*report.canvas_width/v.width,height:height*report.canvas_height/v.height};
}
