import {messageError} from './localized-error.mjs';
import {drawGeometry} from './pivot/geometry.mjs';
import {exportDrawGroups} from './export-frame-core.mjs';
import {opacityArtwork} from './renderer-opacity.mjs';

const abort=()=>{throw messageError(new DOMException('', 'AbortError'), 'errors.playbackWorker.playbackPreparationWasSuperseded', {});};

function descriptorFor(source,items,resources,revision) {
  let descriptor=resources?.geometryDescriptors?.get(source);
  if(!descriptor){descriptor={};resources?.geometryDescriptors?.set(source,descriptor);}
  if(descriptor.software?.items!==items||descriptor.software.revision!==revision){
    descriptor.software={items,revision};
  }
  return descriptor.software;
}

function classifySource(source,descriptor,resources) {
  // New and moving poses use the native painter without duplicating its bounds
  // and opacity work. Only a repeated destination phase pays this source scan.
  let cost=0,reusable=true,oneOwner=true,uniformOpacity=true;
  const items=descriptor.items,uid=source.obj.unique_id,opacity=items[0]?.opacity;
  for(const item of items){
    cost+=(item.type==='text'?32:1)+(item.points?.length??0)/4;
    if(item.type==='image'||item.type==='mesh'||item._movieclipOwner)reusable=false;
    if(item.obj.unique_id!==uid)oneOwner=false;
    if(item.opacity!==opacity)uniformOpacity=false;
  }
  // Connected groups can span native owners. Never cull the full run against
  // its first export slot, or capture a source that includes hidden members.
  const bounds=oneOwner?exportDrawGroups({drawables:items},resources)[0]?.bounds:null;
  Object.assign(descriptor,{classified:true,oneOwner,uniformOpacity,bounds,reusable:cost>=24&&reusable&&Boolean(bounds)});
}

/** -1 outside, 0 intersecting/unknown, 1 conservatively inside. A complete
 * on-screen object needs no repeated per-primitive viewport tests. */
export function softwareBoundsState(bounds,matrix,width,height) {
  if(!bounds)return 0;
  const [a,b,c,d,e,f]=matrix,x=a*bounds.x+c*bounds.y+e,y=b*bounds.x+d*bounds.y+f;
  const ax=a*bounds.width,cx=c*bounds.height,by=b*bounds.width,dy=d*bounds.height;
  const left=x+Math.min(0,ax)+Math.min(0,cx),right=x+Math.max(0,ax)+Math.max(0,cx);
  const top=y+Math.min(0,by)+Math.min(0,dy),bottom=y+Math.max(0,by)+Math.max(0,dy);
  if(!Number.isFinite(left)||!Number.isFinite(right)||!Number.isFinite(top)||!Number.isFinite(bottom))return 0;
  if(right < -2||bottom < -2||left > width+2||top > height+2)return -1;
  return left>=2&&top>=2&&right<=width-2&&bottom<=height-2?1:0;
}

export function softwareVisibleBounds(matrix,width,height) {
  const [a,b,c,d,e,f]=matrix,determinant=a*d-b*c;
  if(!Number.isFinite(determinant)||!determinant)return null;
  const xs=[],ys=[];
  for(const [x,y] of [[-2,-2],[width+2,-2],[-2,height+2],[width+2,height+2]]){
    xs.push((d*(x-e)-c*(y-f))/determinant);ys.push((-b*(x-e)+a*(y-f))/determinant);
  }
  return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),guard:0};
}

/** Conservative destination raster. Native Canvas antialiasing depends on the
 * destination origin, including rotated/minified curves, so retain its zero
 * origin rather than translating paths into a smaller object-local surface. */
export function softwareRasterRegion(bounds,matrix,width,height) {
  if(!bounds)return null;
  const [a,b,c,d,e,f]=matrix,{x,y}=bounds,x1=x+bounds.width,y1=y+bounds.height;
  const xs=[a*x+c*y+e,a*x1+c*y+e,a*x+c*y1+e,a*x1+c*y1+e];
  const ys=[b*x+d*y+f,b*x1+d*y+f,b*x+d*y1+f,b*x1+d*y1+f];
  if(!xs.every(Number.isFinite)||!ys.every(Number.isFinite))return null;
  const left=Math.max(0,Math.floor(Math.min(...xs))-2),top=Math.max(0,Math.floor(Math.min(...ys))-2);
  const right=Math.min(width,Math.ceil(Math.max(...xs))+2),bottom=Math.min(height,Math.ceil(Math.max(...ys))+2);
  return right>left&&bottom>top?{x:0,y:0,width:Math.min(width,Math.ceil(right/64)*64),height:Math.min(height,Math.ceil(bottom/64)*64)}:null;
}

/** Ordered software scene painter. Object pixels share the worker's existing
 * artwork registry and raster owner; transfers still contain only one frame. */
export async function drawSoftwarePlaybackGeometry(context,geometry,resources,{report,hiddenSet,offsetFor,
  artworkRegistry,revision,sharedArtwork=true,cancelled=()=>false,yieldWork=async()=>{},walker,statistics={}}={}) {
  const strokeState={width:1},base=context.getTransform(),width=context.canvas.width,height=context.canvas.height;
  artworkRegistry?.begin(revision);
  Object.assign(statistics,{culledObjects:0,rasterCacheHits:0,rasterCacheMisses:0,cachedObjects:0,directObjects:0});
  const initialHits=resources?.artworkBitmaps?.hits??0,initialMisses=resources?.artworkBitmaps?.misses??0;
  const baseMatrix=[base.a,base.b,base.c,base.d,base.e,base.f];
  let baseClip,priorX,priorY,matrix,offsetClip;
  walker?.begin();
  for(const group of geometry.orderedObjects){
    if(cancelled())abort();
    const source=group.renderSource||group.opacitySource||group,sourceItems=source.drawables;
    const descriptor=descriptorFor(source,sourceItems,resources,revision);
    // Connected-effect groups can contain several native owners. They are
    // already filtered by connectedVfxGeometry and keep their original runs.
    let items=group.drawables;
    if(hiddenSet){
      if(descriptor.oneOwner){if(hiddenSet.has(group.obj.unique_id))continue;}
      else {
        let filtered;
        for(let index=0;index<items.length;index++){
          if(hiddenSet.has(items[index].obj.unique_id)){filtered??=items.slice(0,index);}
          else if(filtered)filtered.push(items[index]);
        }
        if(filtered)items=filtered;
      }
    }
    if(!items.length)continue;
    walker?.object(items[0].obj.unique_id);
    const offset=offsetFor(items[0].obj.unique_id),opacity=items[0].opacity;
    const rootX=base.a*(group.root.x+offset.x)+base.c*(group.root.y+offset.y)+base.e,
      rootY=base.b*(group.root.x+offset.x)+base.d*(group.root.y+offset.y)+base.f;
    const repeated=descriptor.a===base.a&&descriptor.b===base.b&&descriptor.c===base.c&&descriptor.d===base.d&&
      descriptor.rootX===rootX&&descriptor.rootY===rootY&&descriptor.width===width&&descriptor.height===height;
    if(!repeated){
      // One exact phase marker follows the existing weak source lifetime.
      // Avoid strings, bounds, cost scans and opacity lifting on the cold path.
      descriptor.a=base.a;descriptor.b=base.b;descriptor.c=base.c;descriptor.d=base.d;
      descriptor.rootX=rootX;descriptor.rootY=rootY;descriptor.width=width;descriptor.height=height;
      descriptor.rasterKey=undefined;
    }
    let clipBounds=null,outside=false,sourceMatrix;
    if(repeated){
      if(!descriptor.classified)classifySource(source,descriptor,resources);
      if(offset.x!==priorX||offset.y!==priorY){
        priorX=offset.x;priorY=offset.y;
        matrix=offset.x||offset.y?[base.a,base.b,base.c,base.d,base.e+base.a*offset.x+base.c*offset.y,base.f+base.b*offset.x+base.d*offset.y]:baseMatrix;
        offsetClip=undefined;
      }
      const dx=group.root.x-source.root.x,dy=group.root.y-source.root.y;
      sourceMatrix=dx||dy?[matrix[0],matrix[1],matrix[2],matrix[3],matrix[4]+matrix[0]*dx+matrix[2]*dy,matrix[5]+matrix[1]*dx+matrix[3]*dy]:matrix;
      const boundsState=softwareBoundsState(descriptor.bounds,sourceMatrix,width,height);
      outside=(descriptor.uniformOpacity?opacity<=0:items.every(item=>item.opacity<=0))||boundsState===-1;
      if(!outside&&boundsState!==1){
        if(baseClip===undefined)baseClip=softwareVisibleBounds(baseMatrix,width,height);
        if(offsetClip===undefined)offsetClip=baseClip?{...baseClip,x:baseClip.x-offset.x,y:baseClip.y-offset.y}:null;
        clipBounds=offsetClip;
      }
    }
    context.save();
    try {
      context.translate(offset.x,offset.y);
      if(outside){
        statistics.culledObjects++;
        drawGeometry(context,{drawables:items,strokeState,skipPaint:true},resources);
      } else {
        // Opaque groups paint directly over their backdrop in the native path.
        // Painting them onto transparent pixels first changes edge rounding.
        // Native opacity isolation already has this exact intermediate layer.
        const region=repeated&&sharedArtwork&&artworkRegistry&&resources?.artworkBitmaps&&descriptor.reusable&&opacity>0&&opacity<1
          ?softwareRasterRegion(descriptor.bounds,sourceMatrix,width,height):null;
        let rasterized=false;
        if(region&&region.width*region.height*4<=resources.artworkBitmaps.maxBytes){
          const cache=resources.artworkBitmaps;
          if(cache.canRetain(descriptor.rasterKey??'software-pending',region.width*region.height*4)){
            // Native opacity lifting clones artwork. Defer it until this exact
            // immutable source/phase is reusable, never for a first-use pose.
            const view=opacityArtwork(group,items);
            if(view.isolated){
              if(!descriptor.rasterKey){
                if(!descriptor.artworkKey){
                  const steps=artworkRegistry.getSteps(view.source,view.items);let artwork;
                  for(;;){const step=steps.next();if(step.done){artwork=step.value;break;}await yieldWork();if(cancelled())abort();}
                  descriptor.artworkKey=artworkRegistry.contentKey(artwork);
                }
                // Exact fractional phase, linear camera transform and crop all
                // affect antialiasing. Never quantize them to manufacture hits.
                const phase=JSON.stringify([base.a,base.b,base.c,base.d,rootX,rootY,region.width,region.height]);
                descriptor.rasterKey=`software:${descriptor.artworkKey}:${phase}`;
              }
              cache.consumeBitmap(descriptor.rasterKey,()=>{
                const pool=resources.pathRasterSurfaces,{surface,context:raster}=pool.acquire(region.width,region.height);
                const brush={width:1};
                try {
                  raster.setTransform(sourceMatrix[0],sourceMatrix[1],sourceMatrix[2],sourceMatrix[3],sourceMatrix[4]-region.x,sourceMatrix[5]-region.y);
                  drawGeometry(raster,{drawables:view.items,strokeState:brush,clipBounds:softwareBoundsState(descriptor.bounds,sourceMatrix,region.width,region.height)===1?null:softwareVisibleBounds([
                    ...sourceMatrix.slice(0,4),sourceMatrix[4]-region.x,sourceMatrix[5]-region.y],region.width,region.height)},resources);
                  return surface.transferToImageBitmap();
                } finally {pool.release();}
              },bitmap=>{
                context.setTransform(1,0,0,1,0,0);context.globalAlpha*=view.opacity;
                context.imageSmoothingEnabled=false;
                context.drawImage(bitmap,region.x,region.y);
              });
              statistics.cachedObjects++;
              rasterized=true;
            }
          }
        }
        if(!rasterized){drawGeometry(context,{drawables:items,strokeState,clipBounds},resources);statistics.directObjects++;}
      }
    } finally {context.restore();}
    await yieldWork();
  }
  if(cancelled())abort();
  walker?.end();
  statistics.rasterCacheHits=(resources?.artworkBitmaps?.hits??0)-initialHits;
  statistics.rasterCacheMisses=(resources?.artworkBitmaps?.misses??0)-initialMisses;
}
