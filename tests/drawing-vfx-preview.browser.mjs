import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`${process.env.STYK_URL||'http://127.0.0.1:47835'}/api/health`);
 const result=await page.evaluate(async()=>{
  const [{Editor},{emptyDocument,createFrame,createObject},{createRenderer},{drawingMetadata},{createGpuStroke},{normalizeBrush,BrushStroke}]=await Promise.all([
   import('/src/editor.mjs'),import('/src/demo.mjs'),import('/src/renderer.mjs'),import('/src/drawing-model.mjs'),import('/src/drawing-gpu.mjs'),import('/src/drawing-brush.mjs')]);
  const rows=[],gpuErrors=[],screens=[],comparisons=[];
  const check=(value,message)=>{if(!value)throw new Error(message);};
  const png=async(data,width,height)=>{const canvas=new OffscreenCanvas(width,height);canvas.getContext('2d').putImageData(new ImageData(data,width,height),0,0);const blob=await canvas.convertToBlob();return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});};
  for(const fallback of [false,true])for(const figureVfx of [false,true]){
   const report=emptyDocument(),floor=report.figure_types[0];report.canvas_width=320;report.canvas_height=200;
   floor.segments=[{...floor.segments[0],angle_rad:0,segment_kind:'squareLine',segment_type:'line',length:320,thickness:200,color_rgb:[40,70,100]}];floor.segment_count=1;
   report.keyframes=[createFrame([createObject(floor,1,0,100)])];
   const e=new Editor({demo:false,layerTimeline:true}).load(report),layer=e.createDrawingLayer('Drawing'),owner=e.drawingResources;
   // Keep this pixel fixture on its live store while preview jobs finish;
   // document publication is independently covered by drawing history tests.
   owner.busy=true;
   const drawingErrors=[];owner.onError=error=>drawingErrors.push(error.message);owner.previews.onError=owner.onError;
   const target=e.prepareDrawingCel({pixelsPerUnit:4});await owner.surface(target.figure);
   const changes=[];for(let ty=2;ty<10;ty++)for(let tx=2;tx<18;tx++)changes.push({tx,ty,before:null,after:new Uint8ClampedArray([255,0,0,128])});
   e.commitDrawingPixels(target,changes);const uid=target.object.unique_id,figure=e.drawingTarget().figure;
   const [sceneFx]=e.addVfx({kind:'scene'},'grade');e.setVfxParameter({kind:'scene'},sceneFx,'exposure',.01);
   if(figureVfx){const [id]=e.addVfx({kind:'figure',uid},'blur');e.setVfxParameter({kind:'figure',uid},id,'radius',1);}
   const diagnostics=[],r=await createRenderer(document.createElement('canvas'),{forceCanvas2D:fallback,onError:error=>diagnostics.push(error.message),resources:{drawing:f=>drawingMetadata(f)?owner.presenter(f):null}});
   r.resize(320,200,1);await r.gpuDrawingReady;r.device?.addEventListener('uncapturederror',event=>gpuErrors.push(event.error.message));
   const options=()=>({report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,view:{x:0,y:0,scale:1},cameraEnabled:false});
   const read=async(renderer=r)=>{await renderer.device?.queue.onSubmittedWorkDone();const out=new OffscreenCanvas(renderer.canvas.width,renderer.canvas.height),ctx=out.getContext('2d',{willReadFrequently:true});ctx.drawImage(renderer.canvas,0,0);return ctx.getImageData(0,0,out.width,out.height).data;};
   const compare=(a,b,message,include=()=>true)=>{let sum=0,count=0;for(let i=0;i<a.length;i++)if(include(i)){sum+=Math.abs(a[i]-b[i]);count++;}check(count>0,'Camera comparison has no pixels');comparisons.push({message,mean:sum/count});};
   const pixel=(data,x=100,y=80)=>[...data.slice((y*r.canvas.width+x)*4,(y*r.canvas.width+x)*4+4)];
   const settle=async paint=>{for(let round=0;round<40;round++){
    const before=[...owner.entries.values()].map(entry=>entry.stamp).join(),gpuBefore=r.drawingGpu?.presentationKey;
    paint();for(let wait=0;wait<500&&(owner.previews.active||owner.previews.queue.size);wait++)await new Promise(resolve=>setTimeout(resolve,10));
    await new Promise(resolve=>setTimeout(resolve,0));
    if(before===[...owner.entries.values()].map(entry=>entry.stamp).join()&&gpuBefore===r.drawingGpu?.presentationKey&&!owner.previews.active&&!owner.previews.queue.size&&!r.drawingGpu?.incomplete)return;
   }throw new Error('Drawing presentation did not settle');};
   try{
    r.render(options());const camera=r.device?r.vfxViewport?.camera:r.vfxCamera;check(camera,`Camera unavailable: ${JSON.stringify({backend:r.stats.backend,stats:r.stats,diagnostics})}`);const paint=camera.paint;let cameraPaints=0;
    if(paint)camera.paint=(...args)=>{cameraPaints++;return paint(...args);};
    await settle(()=>r.render(options()));const ready=await read(),center=pixel(ready);
    check(Math.abs(center[0]-148)<=2&&Math.abs(center[1]-35)<=2&&Math.abs(center[2]-50)<=2&&center[3]===255,`Scene effects lost drawing or alpha: ${JSON.stringify({fallback,figureVfx,center,diagnostics,drawingErrors})}`);
    const outside=pixel(ready,10,10);check(outside[0]<50&&outside[1]>60,`Camera tiles painted outside their source bounds: ${JSON.stringify({fallback,figureVfx,outside})}`);
    const warm=cameraPaints;r.render(options());await read();check(cameraPaints===warm,'A complete unchanged camera image was repainted');
    screens.push({name:`${r.stats.backend}-${figureVfx?'figure-effects':'tiles'}`,png:await png(ready,320,200)});
    if(!fallback&&!figureVfx){
     const presenter=owner.presenter(figure),stamp=presenter.stamp,brush=normalizeBrush({size:96,hardness:1,flow:1,opacity:1,color:[0,255,0],pressureSize:false,stabilization:0});
     const session=createGpuStroke(r.drawingGpu,presenter,brush),pipeline=new BrushStroke(brush,shape=>session.add(shape));pipeline.sample({x:400,y:320,pressure:1,time:0});pipeline.finish();
     await settle(()=>r.render(options()));const painted=pixel(await read());check(painted[1]>240&&painted[0]<10,'Scene effects omitted the provisional GPU stroke');check(presenter.stamp===stamp,'The provisional stroke unexpectedly published CPU pixels');
     session.release();const next=createGpuStroke(r.drawingGpu,presenter,brush);
     try{await settle(()=>r.render(options()));check(pixel(await read()).every((v,i)=>Math.abs(v-center[i])<=2),'Cancelling and immediately starting a stroke retained old camera ink');}finally{next.release();}
     const frame={...e.evaluatedFrame,camera:{x:18,y:-11,scale:.8,angle_rad:.25}},view={x:-200,y:-50,scale:1},dragTranslations=new Map([[uid,{x:240,y:10}]]);
     r.resize(160,100,2);const moved={...options(),frame,view,dragTranslations};await settle(()=>r.render(moved));const tiles=await read();
     screens.push({name:'moved-tiles',png:await png(tiles,320,200)});
     await r.setGpuDrawing(false);await settle(()=>r.render(moved));const scratch=await read();
     screens.push({name:'moved-scratch',png:await png(scratch,320,200)});
     compare(tiles,scratch,'Camera-space tiles differ from camera raster after pan, rotation, drag and DPR');
     const reference=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true,resources:{drawing:f=>drawingMetadata(f)?owner.presenter(f):null}});
     try{
      reference.resize(160,100,2);await settle(()=>reference.render(moved));
      const q=r.vfxViewport.quadFloats,det=q[0]*q[3]-q[1]*q[2],inside=i=>{
       const pixel=i>>2,x=pixel%320+.5-q[4],y=Math.floor(pixel/320)+.5-q[5],u=(q[3]*x-q[2]*y)/det,v=(q[0]*y-q[1]*x)/det;
       return u>.01&&u<.99&&v>.01&&v<.99;
      };
      // Workspace artwork outside the rotated camera is not part of its
      // filtered image; the portable full-camera painter is the oracle here.
      const portable=await read(reference);compare(tiles,portable,'Camera image differs from portable full-camera rendering',inside);
      screens.push({name:'moved-reference',png:await png(portable,320,200)});
      reference.resize(320,200,1);await settle(()=>reference.render(options()));compare(ready,await read(reference),'Static camera differs from portable full-camera rendering');
     }finally{reference.destroy();}
     r.resize(320,200,1);await settle(()=>r.render(options()));
     const store=presenter.store,replacement={...presenter,store:store.fork(),scratch:undefined,level:undefined};replacement.store.tiles.clear();replacement.store._changed();owner.entries.set(presenter.id,replacement);owner.dropScratch(presenter);
     await settle(()=>r.render(options()));check(pixel(await read())[0]<50,'Replacing a store with an empty store kept old camera ink');
     owner.entries.set(presenter.id,presenter);owner.dropScratch(replacement);owner.dropScratch(presenter);await settle(()=>r.render(options()));check(pixel(await read()).every((v,i)=>Math.abs(v-center[i])<=2),'Restoring the same-stamp presenter lost drawing pixels');
     const grown=store.fork();grown.set(19,4,new Uint8ClampedArray([0,255,0,255]));presenter.store=grown;presenter.stamp++;owner.dropScratch(presenter);
     await settle(()=>r.render(options()));check(pixel(await read(),310,72)[1]>240,'Camera raster omitted live ink outside retained drawing bounds');
     presenter.store=store;presenter.stamp++;owner.dropScratch(presenter);await settle(()=>r.render(options()));
     e.select(uid);e.moveSelection(240,10);const translated=e.geometry.orderedObjects.find(g=>g.obj.unique_id===uid);
     check(translated.renderSource,'Translation fixture did not retain its original artwork');
     const committed={...options(),frame:{...e.evaluatedFrame,camera:frame.camera},view};r.resize(160,100,2);
     await r.setGpuDrawing(true);await settle(()=>r.render(committed));const committedTiles=await read();
     await r.setGpuDrawing(false);await settle(()=>r.render(committed));compare(committedTiles,await read(),'Camera tiles differ for a committed translation retaining source artwork');
     e.moveSelection(-240,-10);
    }
    e.setLayerVisible('scene',false);e.setLayerVisible('layer-1',false);await settle(()=>r.render(options()));
    e.setLayerVisible('scene',true);e.setLayerVisible('layer-1',true);r.resize(320,200,1);await settle(()=>r.render(options()));
    check(pixel(await read()).every((v,i)=>Math.abs(v-center[i])<=2),'Restoring Scene and floor changed settled drawing pixels');
    r.render({...options(),vfxEnabled:false});check(pixel(await read()).every((v,i)=>Math.abs(v-center[i])<=2),'Bypassing effects lost drawing pixels');
    await settle(()=>r.render(options()));check(pixel(await read()).every((v,i)=>Math.abs(v-center[i])<=2),'Re-enabling effects lost drawing pixels');
    const drawingObject=e.geometry.orderedObjects.find(g=>g.obj.unique_id===uid),ghost={...e.geometry,drawables:drawingObject.drawables,orderedObjects:[drawingObject],objects:new Map([[drawingObject.slot,drawingObject]])};
    await settle(()=>r.render({...options(),onionFrames:[{frame:e.evaluatedFrame,geometry:ghost,opacity:.5}]}));
    const onion=pixel(await read());check(Math.abs(onion[0]-175)<=2&&Math.abs(onion[1]-26)<=2&&Math.abs(onion[2]-38)<=2,'Scene effects omitted the drawing onion overlay');
    await settle(()=>r.render(options()));check(pixel(await read()).every((v,i)=>Math.abs(v-center[i])<=2),'Disabling the onion overlay changed current artwork');
    rows.push({backend:r.stats.backend,figureVfx,center,onion,cameraPaints});
    check(!drawingErrors.length,`Drawing resource failure: ${drawingErrors.join('; ')}`);
   }finally{r.destroy();await owner.dispose();}
  }
  return {rows,gpuErrors,screens,comparisons};
 });
 await mkdir('artifacts/drawing-onion-fix',{recursive:true});
 for(const screen of result.screens){await writeFile(`artifacts/drawing-onion-fix/vfx-${screen.name}.png`,Buffer.from(screen.png.split(',')[1],'base64'));delete screen.png;}
 await writeFile('artifacts/drawing-onion-fix/vfx-report.json',JSON.stringify({...result,errors},null,2));
 assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[]);
 for(const row of result.comparisons)assert.ok(row.mean<2,JSON.stringify(row));
 console.log('PASS cold dense drawings, Scene/figure effects, live GPU strokes, cancellation, camera coverage, alpha, bypass and visibility on both backends');
}finally{await browser.close();}
