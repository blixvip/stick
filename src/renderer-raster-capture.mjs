import {messageError} from './localized-error.mjs';
import {drawGeometry,releaseGeometryResources} from './pivot/geometry.mjs';
import {depthSurface} from './surface-raster.mjs';
import {RasterSurfacePool} from './raster-surfaces.mjs';
import {restoreDrawingComposite} from './drawing-composite-transport.mjs';
import {activeVfx,vfxStack,vfxPadding,vfxSamplingPadding,vfxWorkingSlots} from './vfx.mjs';
import {drawingMetadata} from './drawing-model.mjs';
import {hasNativeDiamondPaint,canRefineDrawingItems} from './renderer-preview-drawings.mjs';
import {segmentVfx,hasDrawableVfx,vfxSourcePlan,vfxSoftwareSourcePlan,releaseVfxSoftwareResources,VFX_SOURCE_DIMENSION,VFX_SOURCE_PIXELS} from './vfx-canvas.mjs';
import {withVfxWorkerResources,vfxSurfaceDimension} from './vfx-gpu.mjs';
import {objectBounds,cameraMatrix} from './renderer-geometry.mjs';
import {sceneVfxPlan} from './vfx-scene.mjs';
import {drawExportScene} from './export-frame-core.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {fitsVfxSurface,vfxSurfaceError,vfxSurfaceTiles} from './vfx-surface.mjs';

const pool=new RasterSurfacePool({contextOptions:{willReadFrequently:true}});
const pathTypes=new Set(['line','circle','poly','text']);
const tileGuard=2;
// Editor refinement must bound repeated paint work as well as pixel storage.
// The representative large-effect capture needs sixteen cores; eight by eight
// leaves headroom while refusing a halo admitted with microscopic cores.
const maxPreviewTiles=64;
const budgetError=()=>Object.assign(messageError(new Error(''), 'errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit', {}),{code:'preview_raster_budget'});
const invalidError=()=>messageError(new Error(''), 'errors.drawingComposite.invalidDrawingCompositeBounds', {});
const translucent=opacity=>opacity>0&&opacity<1;
const floatBits=n=>new Float32Array(new Uint32Array([n]).buffer)[0];
const planeBytes=(width,height)=>width*height*4;
const releasePaintSource=context=>{try{releaseGeometryResources(context);}finally{context.canvas.width=context.canvas.height=1;}};

function sceneRecipe(scene){
  const report=scene?.report,frame=scene?.frame,stack=vfxStack(frame);
  if(!report||!frame||![report.canvas_width,report.canvas_height].every(n=>Number.isSafeInteger(n)&&n>0)||
    report._styk||report.figure_types||report.keyframes||frame.objects||!Array.isArray(report.backgrounds??[])||
    (report.backgrounds?.length??0)>2||!Array.isArray(stack)||stack.length>64||!activeVfx(stack).length||stack.some(e=>isGeneratorType(e.type)))throw invalidError();
  if(frame.camera&&(![frame.camera.x??0,frame.camera.y??0,frame.camera.scale??1,frame.camera.angle_rad??0].every(Number.isFinite)||(frame.camera.scale??1)<=0))throw invalidError();
  for(const bg of report.backgrounds??[]){
    if(!bg||bg.data_url||bg.file_name||bg.image_url||bg.styk_tiles||
      (bg.paint?(!['solid','linear','radial','angular'].includes(bg.paint?.type)||!Array.isArray(bg.paint.stops)||bg.paint.stops.length>32):![2,3,4].includes(bg.kind)&&bg.color===undefined))throw invalidError();
  }
  // The recipe carries only resolved camera/filter/background metadata. Its
  // small clone is charged alongside the acknowledged evaluated snapshot.
  const recipeBytes=JSON.stringify(scene).length*2;
  if(recipeBytes>256*1024)throw invalidError();
  return {report,frame,recipeBytes};
}

/** Trace the native scene painter's scratch contexts, including its exact
 * source clamps. Context children are reused across consecutive painter runs;
 * CPU region entries remain distinct for repeated A/B/A scopes. */
function sceneWorkingSet(geometry,{width,height,snapshotBytes,resourceBytes,recipeBytes,maxBytes,report,frame,effectLimit,regionCaches,allowDrawings,resources}){
  const scene=sceneVfxPlan(frame,width,height,undefined,width/report.canvas_width);
  if(!Number.isSafeInteger(scene.pad)||!Number.isSafeInteger(scene.width)||!Number.isSafeInteger(scene.height)||
    !fitsVfxSurface(scene.width,scene.height,effectLimit))throw vfxSurfaceError();
  const camera=cameraMatrix({report,frame}),sx=width/report.canvas_width,sy=height/report.canvas_height;
  const matrix={a:sx*camera[0],b:sy*camera[1],c:sx*camera[2],d:sy*camera[3],e:sx*camera[4]-scene.viewport.x,f:sy*camera[5]-scene.viewport.y};
  const root={width:scene.width,height:scene.height,children:new Map()},gpuSlots=new Map(),cpuSlots=new Map();
  let effectBytes=0,effectEdge=0,regionBytes=0,runId=0,softwareFilters=0;
  const child=(state,kind,width,height,matrix=state.matrix)=>{
    let node=state.node.children.get(kind);
    if(!node){node={width,height,children:new Map()};state.node.children.set(kind,node);}
    node.width=Math.max(node.width,width);node.height=Math.max(node.height,height);
    return {node,width,height,matrix};
  };
  const reserveFilter=(stack,width,height)=>{
    const bytes=planeBytes(width,height),slots=vfxWorkingSlots(stack);
    effectBytes=Math.max(effectBytes,bytes);effectEdge=Math.max(effectEdge,width,height);
    for(const index of slots.gpu)gpuSlots.set(index,Math.max(gpuSlots.get(index)??0,bytes));
    for(const index of slots.cpu)cpuSlots.set(index,Math.max(cpuSlots.get(index)??0,bytes));
  };
  const isolationBounds=items=>{
    let widest=0;
    for(const item of items){if(hasDrawableVfx(item)||activeVfx(segmentVfx(item)).length)return null;widest=Math.max(widest,Math.abs(item.thickness??0)+2*Math.abs(item.outline??0));}
    const b=objectBounds(items,resources??{}),pad=widest/4;return {x:b.x-pad,y:b.y-pad,width:b.width+2*pad,height:b.height+2*pad};
  };
  const isolate=(state,opacity,items,kind='group')=>{
    if(opacity<=0)return null;if(opacity>=1)return state;
    let right=state.width,bottom=state.height;
    const bounds=isolationBounds(items);
    if(bounds){
      const m=state.matrix,corners=[[bounds.x,bounds.y],[bounds.x+bounds.width,bounds.y],[bounds.x,bounds.y+bounds.height],[bounds.x+bounds.width,bounds.y+bounds.height]].map(([x,y])=>({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f}));
      const left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y));right=Math.max(...corners.map(p=>p.x));bottom=Math.max(...corners.map(p=>p.y));
      if(Number.isFinite(left+top+right+bottom)){
        const x0=Math.max(0,Math.floor(left)-2),y0=Math.max(0,Math.floor(top)-2);
        right=Math.min(state.width,Math.ceil(right)+2);bottom=Math.min(state.height,Math.ceil(bottom)+2);
        if(right<=x0||bottom<=y0)return null;
      }else{right=state.width;bottom=state.height;}
    }
    return child(state,kind,Math.min(state.width,Math.ceil(right/64)*64),Math.min(state.height,Math.ceil(bottom/64)*64));
  };
  const filter=(state,stack,items,scale,outputRect,domainBounds)=>{
    stack=activeVfx(stack);if(!stack.length)return [state];
    const plan=vfxSourcePlan({width:state.width,height:state.height,matrix:state.matrix,stack,bounds:objectBounds(items,resources??{}),domainBounds:domainBounds??objectBounds(items,{...resources,vfxBounds:false}),scale,
      padding:vfxPadding(stack,Math.hypot(state.matrix.a,state.matrix.b)*Math.abs(scale??1))+2});
    if(!plan)return [];
    let regions=[plan.rect];
    if(regionCaches){const software=vfxSoftwareSourcePlan(plan,{width:state.width,height:state.height,outputRect});if(!software)return [];regions=[software.rin];regionBytes+=planeBytes(software.rin.width,software.rin.height);softwareFilters++;}
    else if(!fitsVfxSurface(plan.rect.width,plan.rect.height,effectLimit))regions=vfxSurfaceTiles(plan.rect,{width:state.width,height:state.height},plan.pad,effectLimit);
    const states=[];
    for(const region of regions){
      const fits=regionCaches?Number.isSafeInteger(region.width)&&Number.isSafeInteger(region.height)&&region.width>0&&region.height>0&&Math.max(region.width,region.height)<=VFX_SOURCE_DIMENSION&&region.width*region.height<=VFX_SOURCE_PIXELS:fitsVfxSurface(region.width,region.height,effectLimit);
      if(states.length>=maxPreviewTiles||!fits)throw vfxSurfaceError();
      reserveFilter(stack,region.width,region.height);
      const next=child(state,'effect',region.width,region.height,{...state.matrix,e:state.matrix.e-region.x,f:state.matrix.f-region.y});
      if(regionCaches)next.node.transient=true;
      states.push(next);
    }
    return states;
  };
  const generatorFree=stack=>!stack?.some?.(e=>isGeneratorType(e.type));
  const trace=(items,state,outputRect,depth=0)=>{
    if(depth>32)throw invalidError();
    const groups=[];
    for(const item of items){
      const drawing=drawingMetadata(item.fig);
      if(item.type==='image'){
        if(!allowDrawings||drawing?.version!==2||resources&&!canRefineDrawingItems([item],resources))throw invalidError();
      }else if(!pathTypes.has(item.type)||drawing)throw invalidError();
      if(depthSurface(item)||hasNativeDiamondPaint(item)||
        Object.values(item.obj?._stykVfx??{}).some(stack=>!generatorFree(stack)))throw invalidError();
      let group=groups.at(-1);if(!group||group.slot!==item.slot){group={slot:item.slot,items:[]};groups.push(group);}group.items.push(item);
    }
    for(const group of groups){
      const first=group.items[0],owner=first._movieclipOwner;runId++;
      if(owner){
        if(!generatorFree(owner.effects))throw invalidError();
        let next=isolate(state,owner.opacity,group.items);if(!next)continue;
        const innerItems=group.items.map(item=>{const inner=item._movieclipInner;return {...item,slot:item._movieclipPart,_movieclipOwner:inner?.owner,_movieclipPart:inner?.part,_movieclipInner:inner?.inner};});
        for(const filtered of filter(next,owner.effects,group.items,owner.scale,outputRect,owner.domainBounds))trace(innerItems,filtered,undefined,depth+1);continue;
      }
      const effects=vfxStack(first.obj);let next=isolate(state,first.opacity,group.items);if(!next)continue;
      for(const filtered of filter(next,effects,group.items,Math.abs(first.obj?.scale??1),outputRect)){
      const style=group.items.find(item=>item.fig)?.fig.segment_decode?.global_style,outline=style&&floatBits(style.u28);
      if(outline>0&&Number.isFinite(outline)){
        const outlineItems=group.items.filter(item=>item.type!=='image').map(item=>({...item,outline:outline*Math.abs(item.obj?.scale??1),thickness:item.thickness===undefined?undefined:item.thickness+2*outline*Math.abs(item.obj?.scale??1)}));
        isolate(filtered,1-Number(style.u30??0)/255,outlineItems,'outline');
      }
      for(const item of group.items)if(!item._vfxSkipNode&&!item.outline)filter(filtered,segmentVfx(item),[item],Math.abs(item.obj?.scale??1),outputRect);
      }
    }
  };
  trace(geometry.drawables,{node:root,width:scene.width,height:scene.height,matrix},{x:0,y:0,width:scene.width,height:scene.height});
  let scratchBytes=0;const nodes=[root];while(nodes.length){const node=nodes.pop();scratchBytes+=planeBytes(node.width,node.height);nodes.push(...node.children.values());}
  const slotBytes=slots=>[...slots.values()].reduce((sum,bytes)=>sum+bytes,0);
  // The disposable software executor borrows the fresh readback as slot zero
  // and converts its final buffer in place. Only its result canvas is extra.
  const executorBytes=()=>Math.max(slotBytes(gpuSlots)+effectBytes,slotBytes(cpuSlots)+effectBytes);
  const overhead=()=>64*effectEdge+1024,metadataBytes=snapshotBytes+resourceBytes+recipeBytes,outputBytes=planeBytes(width,height),sourceBytes=planeBytes(scene.width,scene.height);
  let objectPaintBytes=metadataBytes+outputBytes+scratchBytes+executorBytes()+regionBytes+overhead();
  if(regionCaches&&softwareFilters===1){
    // One native object filter has no preceding software executor. Its local
    // source and nested geometry end after readback, before passes/cache pixels
    // are allocated. All native filters carry a cacheHint, so their one output
    // canvas is already the region entry, rather than a second wrapper canvas.
    let retainedScratch=0;const retained=[root];while(retained.length){const node=retained.pop();if(node.transient)continue;retainedScratch+=planeBytes(node.width,node.height);retained.push(...node.children.values());}
    const paintReadback=metadataBytes+outputBytes+scratchBytes+effectBytes+overhead();
    const filterAndCache=metadataBytes+outputBytes+retainedScratch+slotBytes(cpuSlots)+regionBytes+overhead();
    objectPaintBytes=Math.max(paintReadback,filterAndCache);
  }
  // The native painter releases completed object scratch before part.done().
  // Executor slots stay warm and bounded; their maxima include this final
  // whole-scene filter while its padded source and output remain alive.
  reserveFilter(vfxStack(frame),scene.width,scene.height);
  // With no GPU, native object filters use the local CPU/cache route. Their
  // caches end before this phase; its borrowed input is dropped before the
  // fresh scene readback. Only non-input slots retain earlier dimensions.
  const sceneExecutorBytes=regionCaches?slotBytes(cpuSlots)-(cpuSlots.get(0)??0)+2*sourceBytes:executorBytes();
  // Published tiles, mips and drawing scratch end after their pixels have
  // entered the native padded scene. The borrowed scene/root pool stays alive.
  const filteredMetadataBytes=metadataBytes-resourceBytes;
  const sceneFilterBytes=filteredMetadataBytes+outputBytes+sourceBytes+sceneExecutorBytes+overhead();
  const transferBytes=filteredMetadataBytes+2*outputBytes+sourceBytes+sceneExecutorBytes+overhead();
  const workingBytes=Math.max(objectPaintBytes,sceneFilterBytes,transferBytes);
  if(!Number.isSafeInteger(workingBytes)||workingBytes>maxBytes)throw budgetError();
  return {workingBytes,effects:true,tileCount:1,nativePadding:true,sceneWidth:scene.width,sceneHeight:scene.height,scenePad:scene.pad,
    objectPaintBytes,sceneFilterBytes,transferBytes,regionCacheBytes:regionBytes,painterRuns:runId};
}

function planPreviewScene(snapshot,{width,height,maxBytes,snapshotBytes=0,resourceBytes=0,allowDrawings=false,resources,scene,effectLimit=4096,regionCaches=false}={}){
  if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)||!Number.isSafeInteger(snapshotBytes)||snapshotBytes<0||
    !Number.isSafeInteger(resourceBytes)||resourceBytes<0||!Number.isFinite(maxBytes)||maxBytes<0||!Number.isSafeInteger(effectLimit)||effectLimit<1||effectLimit>4096||typeof regionCaches!=='boolean')throw invalidError();
  const {report,frame,recipeBytes}=sceneRecipe(scene),geometry=snapshot.drawables?snapshot:restoreDrawingComposite(snapshot);
  const plan=sceneWorkingSet(geometry,{width,height,snapshotBytes,resourceBytes,recipeBytes,maxBytes,report,frame,effectLimit,regionCaches,allowDrawings,resources});
  return {...plan,geometry,scene:{report,frame}};
}

/** Model the native painter's existing scratch owners before allocating any
 * pixels. Each Canvas context owns at most one group, outline and effect child;
 * dense segment lists reuse those children instead of reserving per primitive. */
function workingSet(drawables,{width,height,matrix,maxBytes,snapshotBytes,resourceBytes=0,outputBytes=0,effectLimit=4096,regionCaches=false,allowDrawings=false,resources,nativePadding=false}) {
  const root={width,height,children:new Map()},sourceBytes=width*height*4;
  let effectBytes=0,effectEdge=0,effects=false;
  const gpuSlots=new Map(),cpuSlots=new Map();
  const descend=(node,kind,padding)=>{
    const w=width+2*padding,h=height+2*padding;
    if(kind==='effect'&&!fitsVfxSurface(w,h,effectLimit))throw vfxSurfaceError();
    let child=node.children.get(kind);
    if(!child){child={width:w,height:h,children:new Map()};node.children.set(kind,child);}
    child.width=Math.max(child.width,w);child.height=Math.max(child.height,h);
    if(kind==='effect'){effects=true;effectBytes=Math.max(effectBytes,child.width*child.height*4);effectEdge=Math.max(effectEdge,child.width,child.height);}
    return child;
  };
  const runs=[];let nextRun=0;
  for(let primitive=0;primitive<drawables.length;primitive++){
    const item=drawables[primitive];
    const drawing=drawingMetadata(item.fig);
    if(item.type==='image'){
      const entry=resources?.drawing?.(item.fig);
      if(!allowDrawings||drawing?.version!==2||resources&&(!entry?.store||entry.id!==drawing.celId||entry.revision!==drawing.revision))throw invalidError();
    }else if(!pathTypes.has(item.type)||drawing)throw invalidError();
    if(depthSurface(item)||hasNativeDiamondPaint(item))throw invalidError();
    let node=root,padding=0,parentRun=0,depth=0,slot=item.slot,owner=item._movieclipOwner,part=item._movieclipPart,inner=item._movieclipInner;
    const filter=(stack,scale,key)=>{
      if(!activeVfx(stack).length)return;
      padding+=(nativePadding?vfxPadding:vfxSamplingPadding)(stack,matrix[0]*Math.abs(scale??1))+2;
      node=descend(node,'effect',padding);
      const bytes=node.width*node.height*4,slots=vfxWorkingSlots(stack);
      for(const index of slots.gpu)gpuSlots.set(index,Math.max(gpuSlots.get(index)??0,bytes));
      for(const index of slots.cpu)cpuSlots.set(index,Math.max(cpuSlots.get(index)??0,bytes));
      // drawGeometry chooses one owner's stack per painter group, even when
      // streamed inner metadata contains repeated copies of that same stack.
      if(regionCaches)(node.groups??=new Set()).add(key);
    };
    const isolate=opacity=>{if(translucent(opacity))node=descend(node,'group',padding);};
    const innerOwners=new Set();
    for(;;){
      let run=runs[depth];
      if(!run||run.parentRun!==parentRun||run.slot!==slot){
        run={id:++nextRun,parentRun,slot,owner,opacity:item.opacity,obj:item.obj,foundFigure:false};
        runs[depth]=run;runs.length=depth+1;
      }
      if(run.owner){
        if(run.owner.opacity<=0)break;
        isolate(run.owner.opacity);filter(run.owner.effects,run.owner.scale,`group:${run.id}`);
        if(inner&&innerOwners.has(inner))throw invalidError();
        if(inner)innerOwners.add(inner);
        parentRun=run.id;depth++;slot=part;owner=inner?.owner;part=inner?.part;inner=inner?.inner;
        continue;
      }
      if(run.opacity<=0)break;
      isolate(run.opacity);filter(vfxStack(run.obj),run.obj?.scale,`group:${run.id}`);
      if(!run.foundFigure&&item.fig){run.foundFigure=true;run.style=item.fig.segment_decode?.global_style;}
      const style=run.style,outline=style&&floatBits(style.u28);
      if(outline>0&&Number.isFinite(outline)&&translucent(1-Number(style.u30??0)/255))descend(node,'outline',padding);
      if(!item._vfxSkipNode&&!item.outline)filter(segmentVfx(item),item.obj?.scale,`primitive:${primitive}`);
      break;
    }
  }
  let scratchBytes=0,regionCacheBytes=0;
  const nodes=[root];
  while(nodes.length){const node=nodes.pop(),bytes=node.width*node.height*4;scratchBytes+=bytes;regionCacheBytes+=bytes*(node.groups?.size??0);nodes.push(...node.children.values());}
  // The worker scope destroys private GPU textures before software fallback
  // and holds that route for the rest of the capture. Reserve the larger
  // executor lifetime, with each retained slot bounded across all groups.
  // Private CPU input is borrowed and output converted in place, leaving one
  // result canvas like the GPU. Native region caches exist only without GPU
  // capability and their canvases are accounted separately above.
  const gpuBytes=[...gpuSlots.values()].reduce((sum,bytes)=>sum+bytes,0)+effectBytes;
  const cpuBytes=[...cpuSlots.values()].reduce((sum,bytes)=>sum+bytes,0)+effectBytes;
  const workingBytes=snapshotBytes+resourceBytes+2*outputBytes+sourceBytes+scratchBytes+Math.max(gpuBytes,cpuBytes)+regionCacheBytes+(effects?64*effectEdge+1024:0);
  if(!Number.isSafeInteger(workingBytes)||workingBytes>maxBytes)throw Object.assign(budgetError(),{effects});
  return {workingBytes,effects};
}

function capturePlan(drawables,options){
  const {width,height}=options;
  let rejection;
  // Native Canvas coverage depends on the canvas domain, even when an edge is
  // far inside a crop. Preserve that domain and the established filter halos
  // whenever the complete native lifetime fits this capture's reservation.
  try{return {...workingSet(drawables,{...options,nativePadding:true}),tileWidth:width,tileHeight:height,tileCount:1,tileGuard:0,nativePadding:true};}
  catch(error){if(!['preview_raster_budget','vfx_surface_budget'].includes(error.code))throw error;if(options.fullNativeDomain||error.code==='preview_raster_budget'&&!error.effects)throw error;rejection=error;}
  if(!options.nativePadding){
    try{return {...workingSet(drawables,options),tileWidth:width,tileHeight:height,tileCount:1,tileGuard:0,nativePadding:false};}
    catch(error){if(!['preview_raster_budget','vfx_surface_budget'].includes(error.code))throw error;rejection=error;}
  }
  let tileWidth=width,tileHeight=height;
  for(;;){
    if(tileWidth>=tileHeight&&tileWidth>1)tileWidth=Math.ceil(tileWidth/2);
    else if(tileHeight>1)tileHeight=Math.ceil(tileHeight/2);
    else throw rejection;
    const tileCount=Math.ceil(width/tileWidth)*Math.ceil(height/tileHeight);
    if(tileCount>maxPreviewTiles)throw rejection;
    try{
      const admitted=workingSet(drawables,{...options,width:Math.min(width,tileWidth+2*tileGuard),height:Math.min(height,tileHeight+2*tileGuard),outputBytes:width*height*4});
      return {...admitted,tileWidth,tileHeight,tileCount,tileGuard,nativePadding:options.nativePadding};
    }catch(error){if(!['preview_raster_budget','vfx_surface_budget'].includes(error.code))throw error;rejection=error;}
  }
}

/** Serial, transparent editor refinement. The transferable bitmap owns the
 * completed pixels; the software scratch pool retains only a reset context.
 * Effect executor pixels are released before publication, keeping bounded
 * programs warm without letting pixels outlive their memory reservation. */
export function planPreviewRaster(snapshot,{width,height,matrix,clipBounds,maxBytes,snapshotBytes=0,resourceBytes=0,allowDrawings=false,resources,nativePadding=false,effectLimit=4096,regionCaches=false,scene}={}){
  if(scene!==undefined)return planPreviewScene(snapshot,{width,height,maxBytes,snapshotBytes,resourceBytes,allowDrawings,resources,scene,effectLimit,regionCaches});
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>4096||height>4096||matrix?.length!==6||!matrix.every(Number.isFinite)||matrix[0]<=0||matrix[1]!==0||matrix[2]!==0||matrix[3]!==matrix[0]||!Number.isSafeInteger(snapshotBytes)||snapshotBytes<0||!Number.isSafeInteger(resourceBytes)||resourceBytes<0||!Number.isFinite(maxBytes)||maxBytes<0||!Number.isSafeInteger(effectLimit)||effectLimit<1||effectLimit>4096||typeof regionCaches!=='boolean')throw invalidError();
  if(clipBounds&&(![clipBounds.x,clipBounds.y,clipBounds.width,clipBounds.height].every(Number.isFinite)||clipBounds.width<=0||clipBounds.height<=0))throw invalidError();
  const geometry=snapshot.drawables?snapshot:restoreDrawingComposite(snapshot);
  const fullNativeDomain=nativePadding&&geometry.drawables.length===1&&geometry.drawables[0].type==='image';
  return {...capturePlan(geometry.drawables,{width,height,matrix,maxBytes,snapshotBytes,resourceBytes,allowDrawings,resources,nativePadding,fullNativeDomain,effectLimit,regionCaches}),geometry};
}

/** A worker can report its required reservation after snapshot transfer but
 * before drawing decode or pixel allocation. Cheap bounded admission precedes
 * graphics-capability discovery, and the existing private scope releases its
 * working owners before the caller can reclaim cold renderer artwork. */
export function planPreviewRasterResources(snapshot,options){
  const initial=planPreviewRaster(snapshot,options);
  if(!initial.effects)return initial;
  return withVfxWorkerResources(()=>{
    const limit=vfxSurfaceDimension();
    return planPreviewRaster(initial.geometry,{...options,effectLimit:limit>0?limit:4096,regionCaches:limit===0});
  });
}

function capturePreviewScene(snapshot,options){
  const started=performance.now(),initial=planPreviewScene(snapshot,options);
  let completed;
  try{
    const capture=()=>{
      let capturePool,result;
      try{
        const limit=vfxSurfaceDimension(),plan=planPreviewScene(initial.geometry,{...options,effectLimit:limit>0?limit:4096,regionCaches:limit===0});
        if(typeof options.resources?.rasterSurface!=='function')throw invalidError();
        if(options.resourceBytes>0&&typeof options.resources.drawingProvider?.dispose!=='function')throw invalidError();
        capturePool=options.resources.rasterSurface(options.width,options.height,{hasImages:true});
        const {surface,context}=capturePool.acquire(options.width,options.height);
        if(!context)throw messageError(new Error(''), 'errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable', {});
        // The stream already contains evaluated connected/visible artwork.
        // Native rendering receives no clip library, poses, parser or document
        // mirror, and retains its original accelerated canvas domain.
        drawExportScene(context,plan.scene.report,plan.scene.frame,{...plan.geometry,connectedVfxSource:true},options.resources,{releaseSceneScratch:true,
          beforeSceneFilter:()=>{
            options.resources.drawingProvider?.dispose();
            for(const entry of options.resources.tintCanvases?.values()??[])entry.canvas.width=entry.canvas.height=1;
            options.resources.tintCanvases?.clear();
          }});
        if(context.isContextLost?.())throw messageError(new Error(''), 'errors.drawingComposite.theDrawingCompositeCanvasBecameUnavailable', {});
        const bitmap=surface.transferToImageBitmap();
        result={bitmap,width:options.width,height:options.height,bytes:planeBytes(options.width,options.height),workingBytes:plan.workingBytes,
          effects:true,tileCount:1,nativePadding:true,sceneWidth:plan.sceneWidth,sceneHeight:plan.sceneHeight,scenePad:plan.scenePad,workMs:0};
        return result;
      }catch(error){capturePool?.dispose();throw error;}
      finally{try{capturePool?.release();releaseVfxSoftwareResources();}catch(error){result?.bitmap.close();throw error;}}
    };
    const result=withVfxWorkerResources(()=>completed=capture(),{releaseSource:releasePaintSource});result.workMs=performance.now()-started;return result;
  }catch(error){completed?.bitmap.close();throw error;}
}

export function capturePreviewRaster(snapshot,{width,height,matrix,clipBounds,maxBytes,snapshotBytes=0,resourceBytes=0,resources,nativePadding=false,scene}={}){
  if(scene!==undefined)return capturePreviewScene(snapshot,{width,height,maxBytes,snapshotBytes,resourceBytes,allowDrawings:Boolean(resources),resources,scene});
  const started=performance.now(),initialPlan=planPreviewRaster(snapshot,{width,height,matrix,clipBounds,maxBytes,snapshotBytes,resourceBytes,allowDrawings:Boolean(resources),resources,nativePadding}),geometry=initialPlan.geometry;
  const singleDrawing=geometry.drawables.length===1&&geometry.drawables[0].type==='image',fullNativeDomain=nativePadding&&singleDrawing;
  const options={width,height,matrix,maxBytes,snapshotBytes,resourceBytes,allowDrawings:Boolean(resources),resources,nativePadding,fullNativeDomain},effects=initialPlan.effects;
  const capture=({setSamplingPadding}={})=>{
  let output,result,capturePool;
  const paint=(context,transform)=>{
    if(!context)throw messageError(new Error(''), 'errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable', {});
    context.setTransform(...transform);drawGeometry(context,{...geometry,clipBounds},resources??{});
    if(context.isContextLost?.())throw messageError(new Error(''), 'errors.drawingComposite.theDrawingCompositeCanvasBecameUnavailable', {});
  };
  try{
    // Invalid or impossible jobs fail above without allocating even a tiny GPU
    // context. Capability discovery follows cheap admission and precedes all
    // large pixel allocations, so limited devices cannot mix unreserved owners.
    const limit=effects?vfxSurfaceDimension():4096;
    const plan=effects?capturePlan(geometry.drawables,{...options,effectLimit:limit>0?limit:4096,regionCaches:limit===0}):initialPlan;
    setSamplingPadding?.(!plan.nativePadding);
    const {workingBytes,tileWidth,tileHeight,tileCount,tileGuard}=plan;
    // Prepared drawings already own an accelerated serial scratch pool. Keep
    // their native image blending route: a software root surface changes
    // translucent filtered pixels when composited over other figures.
    // Native paths continue using the existing software-only capture owner.
    capturePool=effects&&singleDrawing&&typeof resources?.rasterSurface==='function'?
      resources.rasterSurface(width,height,{hasImages:true}):pool;
    let bitmap;
    if(tileCount===1){
      const {surface,context}=capturePool.acquire(width,height);paint(context,matrix);bitmap=surface.transferToImageBitmap();
    }else{
      output=new OffscreenCanvas(width,height);
      const context=output.getContext('2d',{willReadFrequently:true});
      if(!context)throw messageError(new Error(''), 'errors.drawingComposite.theDrawingCompositeCanvasIsUnavailable', {});
      context.imageSmoothingEnabled=false;
      // Cores partition the original pixel grid. Native withVfx supplies each
      // core's sampling halos and derives spatial-filter origins from unchanged
      // owner domain bounds, so cropping cannot re-anchor or scale the effects.
      for(let y=0;y<height;y+=tileHeight)for(let x=0;x<width;x+=tileWidth){
        const w=Math.min(tileWidth,width-x),h=Math.min(tileHeight,height-y),left=Math.max(0,x-tileGuard),top=Math.max(0,y-tileGuard),right=Math.min(width,x+w+tileGuard),bottom=Math.min(height,y+h+tileGuard),lease=capturePool.acquire(right-left,bottom-top);
        try{
          paint(lease.context,[...matrix.slice(0,4),matrix[4]-left,matrix[5]-top]);
          // Keep Canvas's whole-image blend pipeline, as native opacity
          // isolation does: source-rectangle copies round coverage differently.
          context.save();try{context.beginPath();context.rect(x,y,w,h);context.clip();context.drawImage(lease.surface,left,top);}finally{context.restore();}
        }
        finally{capturePool.release();releaseVfxSoftwareResources();}
      }
      if(context.isContextLost?.())throw messageError(new Error(''), 'errors.drawingComposite.theDrawingCompositeCanvasBecameUnavailable', {});
      bitmap=output.transferToImageBitmap();
    }
    result={bitmap,width,height,bytes:width*height*4,workingBytes,effects,tileCount,tileWidth,tileHeight,tileGuard,workMs:0};return result;
  }catch(error){capturePool?.dispose();throw error;}
  finally{try{capturePool?.release();releaseVfxSoftwareResources();if(output)output.width=output.height=1;}catch(error){result?.bitmap.close();throw error;}}
  };
  let completed;
  try{
    const paint=scope=>completed=capture(scope);
    const result=effects?withVfxWorkerResources(paint,{samplingPadding:!nativePadding,releaseSource:releasePaintSource}):paint();result.workMs=performance.now()-started;return result;
  }catch(error){completed?.bitmap.close();throw error;}
}
