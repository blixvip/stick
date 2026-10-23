import {vfxStack} from './vfx.mjs';
import {connectedVfxGeometry} from './vfx-connected.mjs';
import {movieclipAsset, playbackSettings} from './movieclips.mjs';
import {layerVisible} from './layers.mjs';
import {rotatedDrawing,drawingRotationReference} from './movieclip-drawings.mjs';
import {animationRotation} from './animation-origin.mjs';
import {projection} from './spatial-projection.mjs';
import {buildMovieclipMeshSteps} from './movieclip-mesh.mjs';
import {isGeneratorType} from './vfx-registry.mjs';

/** Whether a movieclip document, or one nested in it, has generated effects.
 * Published movieclip documents are immutable, so the answer is cached. */
const generatorDocuments=new WeakMap();
function hasGeneratedEffects(document,depth=0){
  if(!document||depth>8)return false;
  let known=generatorDocuments.get(document);
  if(known===undefined){
    known=Boolean(document._styk?.vfxClips?.clips.some(c=>c.effects.some(e=>isGeneratorType(e.type))))||(document.figure_types??[]).some(f=>hasGeneratedEffects(f._styk?.movieclip?.document,depth+1));
    generatorDocuments.set(document,known);
  }
  return known;
}

const caches = new WeakMap();
const MAX_FRAMES = 48, MAX_POINTS = 250000;
// One budget for every asset in this renderer, including nested assets.
const retained=new Map();let retainedPoints=0;
function scaledOwner(owner,scale,point){
  const result={...owner,scale:(owner.scale??1)*Math.abs(scale)},bounds=owner.domainBounds;
  if(bounds){const corners=[[bounds.x,bounds.y],[bounds.x+bounds.width,bounds.y],[bounds.x,bounds.y+bounds.height],[bounds.x+bounds.width,bounds.y+bounds.height]].map(([x,y])=>point({x,y}));
    const x=Math.min(...corners.map(p=>p.x)),y=Math.min(...corners.map(p=>p.y));
    result.domainBounds={x,y,width:Math.max(...corners.map(p=>p.x))-x,height:Math.max(...corners.map(p=>p.y))-y};}
  return result;
}
const scaledInner=(inner,transformOwner)=>inner?{...inner,owner:transformOwner(inner.owner),inner:scaledInner(inner.inner,transformOwner)}:undefined;
function touch(cache){retained.delete(cache);retained.set(cache,true);}
function evict(cache){const first=cache.frames.entries().next().value;if(!first)return;cache.frames.delete(first[0]);cache.points-=first[1].points;retainedPoints-=first[1].points;if(!cache.frames.size)retained.delete(cache);}
export function movieclipCacheStats(figure) {
  const cache = caches.get(movieclipAsset(figure));
  return cache ? {hits:cache.hits, misses:cache.misses, frames:cache.frames.size, points:cache.points} : {hits:0,misses:0,frames:0,points:0};
}
function* sampleSteps(asset, local, api) {
  let cache = caches.get(asset);
  if (!cache) {cache = {frames:new Map(), rows:api.timeline(asset.document), points:0,hits:0,misses:0}; caches.set(asset, cache);}
  const prior = cache.frames.get(local);
  if (prior) {cache.hits++; cache.frames.delete(local); cache.frames.set(local,prior);touch(cache);return prior.geometry;}
  const tick = asset.sourceStart + local, rows = cache.rows;
  let low=0,high=rows.length-1;
  while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}
  const row=rows[low], frame=api.evaluatedFrame(asset.document,low,row.count?(tick-row.start)/row.count:0,tick);
  const geometry=connectedVfxGeometry(api.buildGeometrySteps ? yield* api.buildGeometrySteps(asset.document,frame) : api.buildGeometry(asset.document,frame),frame,asset.document);
  if(vfxStack(frame).length)geometry.sceneEffects=vfxStack(frame);
  geometry.sourceFrame=frame;
  const points=geometry.drawables.reduce((n,s)=>n+(s.points?.length??1),0);
  cache.misses++;
  if(points<=MAX_POINTS){
    while(cache.frames.size&&(cache.frames.size>=MAX_FRAMES||cache.points+points>MAX_POINTS)){
      evict(cache);
    }
    while(retained.size&&(retainedPoints+points>MAX_POINTS||retained.size>=64&&!retained.has(cache)))evict(retained.keys().next().value);
    cache.frames.set(local,{geometry,points});cache.points+=points;retainedPoints+=points;touch(cache);
  }
  return geometry;
}
/** One selectable container, with independently styled child render groups.
 * Cached local geometry is shared by all instances of an immutable asset. */
export function* buildMovieclipGeometrySteps(fig,obj,root,slot,api) {
  if(movieclipAsset(fig).spatialMeshes)return yield* buildMovieclipMeshSteps(fig,obj,root,slot,api.joinedParent,api.objectColor,api.previous);
  const asset=movieclipAsset(fig),parent=api.joinedParent,
    joint=asset.drawingRotation&&parent?.segments.find(s=>s.seg.segment_id===obj.join?.target_handle_id),
    figureAngle=joint?.spatialFrame?animationRotation(parent.fig,parent.obj):0,
    drawing=rotatedDrawing(asset,obj,joint?.spatialFrame?.q,joint?.spatialFrame?drawingRotationReference(parent,joint,figureAngle):undefined),
    camera=drawing?projection(parent.obj,parent.root):null,
    depthScale=camera&&joint.start.rawPoint?1/Math.max(.05,1-camera.k*joint.start.rawPoint[2]):1,
    scale=Number(obj.scale??1)*(drawing?joint.spatialFrame.stretch*depthScale:1),inheritedFlip=drawing&&parent.obj.image_text_flags?-1:1,
    angle=Number(obj.angles?.[0]??0)+(drawing?drawing.roll*inheritedFlip+figureAngle:0),
    a=Math.cos(angle)*scale,b=Math.sin(angle)*scale,flip=(obj.image_text_flags?-1:1)*inheritedFlip;
  if(drawing)root={...joint.start};
  const point=p=>({x:root.x+a*(p.x-asset.pivot.x)-b*(p.y-asset.pivot.y)*flip,y:root.y+b*(p.x-asset.pivot.x)+a*(p.y-asset.pivot.y)*flip});
  const end={x:root.x+40*Math.cos(angle)*scale,y:root.y+40*Math.sin(angle)*scale};
  const joints=new Map([[0,root],[1,end]]),
    handle={seg:fig.segments[0],obj,fig,slot,index:0,start:root,end,points:[root,end],angle,length:40*scale,bend:0,thickness:0,opacity:1,alpha:1,rgb:[0,0,0]};
  const geometry={obj,fig,root,slot,joints,segments:[handle],polys:[],drawables:[]};
  const local=obj._movieclipSample===null?null:drawing?.frame??obj._movieclipSample??playbackSettings(obj).offset;
  if(drawing){geometry.drawingView=drawing;geometry.drawingTransform={angle,scale,flip};}
  if(local===null)return geometry;
  const source=yield* sampleSteps(asset,local,api), owner={opacity:1-Number(obj.field28??0)/255,effects:source.sceneEffects?.length?[...source.sceneEffects,...(obj._stykVfx?.figure??[])]:obj._stykVfx?.figure,scale:Math.abs(scale)};
  // Generated effects inside the clip draw beside it, in its local transform.
  if(source.sourceFrame&&hasGeneratedEffects(asset.document))geometry.nestedGenerators={report:asset.document,frame:source.sourceFrame,geometry:source,opacity:owner.opacity,
    matrix:[a,b,-b*flip,a*flip,root.x-a*asset.pivot.x+b*flip*asset.pivot.y,root.y-b*asset.pivot.x-a*flip*asset.pivot.y]};
  const objects=new Map(),owners=new Map();
  const transformOwner=owner=>{let result=owners.get(owner);if(!result){result=scaledOwner(owner,scale,point);owners.set(owner,result);}return result;};
  let completed=0;
  for(const item of source.drawables){
    if((++completed & 127)===0)yield {phase:'geometry',stage:'movieclip',completed,total:source.drawables.length};
    if(!layerVisible(asset.document,item.obj.unique_id))continue;
    let child=objects.get(item.obj);
    if(!child){child={...item.obj,unique_id:obj.unique_id,object_slot:slot,scale:(item.obj.scale??1)*scale,image_text_flags:Number(Boolean(item.obj.image_text_flags)!==Boolean(obj.image_text_flags))};objects.set(item.obj,child);}
    geometry.drawables.push({...item,obj:child,slot,
      _movieclipOwner:owner,_movieclipPart:item.slot,
      ...(item._movieclipOwner?{_movieclipInner:{owner:transformOwner(item._movieclipOwner),part:item._movieclipPart,inner:scaledInner(item._movieclipInner,transformOwner)}}:{}),
      points:item.points?.map(point),start:item.start&&point(item.start),end:item.end&&point(item.end),
      angle:item.angle===undefined?undefined:item.angle*flip+angle,bend:(item.bend??0)*flip,
      length:item.length===undefined?undefined:item.length*scale,
      thickness:item.thickness===undefined?undefined:item.thickness*Math.abs(scale)});
  }
  return geometry;
}
