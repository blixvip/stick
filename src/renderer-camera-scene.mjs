import {effectiveCamera,sceneBackgroundColor} from './pivot/background.mjs';
import {layerVisible} from './layers.mjs';
import {parallaxResolver} from './layer-parallax.mjs';
import {canRefineDrawingItems} from './renderer-preview-drawings.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {vfxStack} from './vfx.mjs';
import {assetURL} from './image-resources.mjs';

/** The native camera painter and its capture share the same filtered pose.
 * Geometry stays immutable; only active drag translations need new records. */
export function cameraSceneDrawables({report,geometry,hiddenUids,dragTranslations}){
  return geometry.drawables.filter(item=>!hiddenUids?.has(item.obj.unique_id)&&layerVisible(report,item.obj.unique_id)).map(item=>{
    const delta=dragTranslations?.get?.(item.obj.unique_id)||dragTranslations?.[item.obj.unique_id];if(!delta)return item;
    const point=p=>p&&({x:p.x+delta.x,y:p.y+delta.y});return {...item,start:point(item.start),end:point(item.end),points:item.points?.map(point),
      obj:{...item.obj,root_x:item.obj.root_x+delta.x,root_y:item.obj.root_y+delta.y}};
  });
}

/** An evaluated native scene, never an animation/figure library. Unsupported
 * resources and dynamic generator/parallax painters keep their immediate path. */
export function cameraRefinementScene(options,items,resources={}){
  const {report,frame,geometry,generatorBatch}=options;
  if(items.some(item=>item.type==='mesh'||item.poly?._stykSurface?.depthTest)||!canRefineDrawingItems(items,resources))return null;
  if(generatorBatch?.particles||generatorBatch?.draws?.length||generatorBatch?.incomplete)return null;
  if(!Object.hasOwn(options,'generatorBatch')&&((report._styk?.vfxClips?.clips??[]).some(clip=>clip.effects?.some(effect=>isGeneratorType(effect.type)))||
    [...(geometry.objects?.values()??[])].some(g=>g.nestedGenerators)))return null;
  const parallax=parallaxResolver(report,frame);
  for(const uid of new Set(items.map(item=>item.obj.unique_id))){const p=parallax(uid);if(p.x||p.y)return null;}
  const override=sceneBackgroundColor(report,frame),ids=new Set([Number(frame.background_id),...(frame.background_mix?[Number(frame.background_id_b)]:[])]),backgrounds=[];
  if(override===undefined)for(const bg of report.backgrounds??[])if(ids.has(Number(bg.background_id))){
    if(assetURL(bg)||bg.paint?.type==='diamond')return null;
    const native={};for(const key of ['background_id','kind','color','color_a','color_b','x1','y1','x2','y2','paint'])if(bg[key]!==undefined)native[key]=bg[key];
    backgrounds.push(native);
  }
  return {report:{canvas_width:report.canvas_width,canvas_height:report.canvas_height,backgrounds},
    frame:{camera:effectiveCamera(report,frame),background_id:frame.background_id,background_id_b:frame.background_id_b,
      background_mix:frame.background_mix,_stykBackgroundColor:override,_stykVfx:{figure:vfxStack(frame)}}};
}
