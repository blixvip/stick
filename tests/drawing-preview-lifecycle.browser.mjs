import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=process.env.STYK_LIFECYCLE_ARTIFACTS||'artifacts/drawing-preview-lifecycle',baseline=process.env.STYK_LIFECYCLE_BASELINE,checks=[],errors=[],observations=[];
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
 await page.context().route('**/*',route=>route.continue());
 if(baseline){const body=execFileSync('git',['show',`${baseline}:src/renderer.mjs`],{encoding:'utf8'});await page.context().route('**/src/renderer.mjs',route=>route.fulfill({contentType:'text/javascript',body}));}
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);await page.locator('[data-workspace-mode="draw"]').click();
 await page.evaluate(()=>{
  styk.state.settings.autosaveSeconds=0;
  window.probeDrawing=()=>new Promise(resolve=>{
   const renderer=styk.state.renderer,render=renderer.render;
   renderer.render=function(...args){
    const result=render.apply(this,args);renderer.render=render;
    const scene=document.querySelector('#scene'),canvas=new OffscreenCanvas(scene.width,scene.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(scene,0,0);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let ink=0;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i]<70&&pixels[i+1]<110&&pixels[i+2]>160&&pixels[i+3]>100)ink++;
    const t=styk.editor.drawingTarget(),surface=t.figure&&styk.drawing.owner.entry(t.figure);
    resolve({ink,bounds:surface?.store?.bounds??null,tiles:surface?.store?.size??0,gesture:Boolean(styk.drawing.gesture)});return result;
   };styk.drawing.onRender();
  });
  window.seedDrawing=async(dense=false)=>{
   const {emptyDocument}=await import('/src/demo.mjs'),e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();
   const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);
   const tiles=[{tx:3,ty:2,before:null,after:new Uint8ClampedArray([32,62,216,255])}];
   if(dense)for(let tx=40;tx<104;tx++)tiles.push({tx,ty:2,before:null,after:new Uint8ClampedArray([32,62,216,255])});
   e.commitDrawingPixels(target,tiles);
   await d.barrier();d.owner.busy=true;window.lifecycleSurface=surface;
   d.tool='eraser';Object.assign(d.settings,{resolution:1,size:200,pressureSize:false,pressureOpacity:false,hardness:1,flow:1,opacity:1,stabilization:0,texture:0});d.onUI();
   const {transformPoint}=await import('/src/drawing-model.mjs'),{worldToScreen}=await import('/src/renderer-geometry.mjs');
   const p=worldToScreen(transformPoint(d.pixelMatrix(e.drawingTarget()),{x:224,y:160}),{report:e.report,frame:e.evaluatedFrame,view:styk.state.view,cameraEnabled:false}),r=d.viewport.getBoundingClientRect();
   return{x:r.left+p.x,y:r.top+p.y};
  };
 });
 for(const mode of ['gpu','canvas']){
  await page.evaluate(mode=>{const backend=styk.state.renderer.stats.backend;if(mode==='gpu'?!/webgpu/i.test(backend):!/canvas/i.test(backend))styk.settingsUI.commit({rendererMode:mode});},mode);
  await page.waitForFunction(mode=>mode==='gpu'?/webgpu/i.test(styk.state.renderer.stats.backend):/canvas/i.test(styk.state.renderer.stats.backend),mode);
  // WebGPU normally draws resident tiles; this suite covers its scratch/worker
  // presenter fallback, which the Canvas path always uses.
  if(mode==='gpu')await page.evaluate(()=>styk.state.renderer.setGpuDrawing(false));
  const point=await page.evaluate(()=>seedDrawing()),painted=await page.evaluate(()=>probeDrawing());observations.push({mode,phase:'painted',...painted});
  check(`${mode}: seeded artwork is visibly painted`,painted.ink>3000);
  await page.evaluate(()=>{
   const worker=styk.drawing.owner.previews.worker,request=worker.request.bind(worker);
   window.releaseStartup=null;window.startupRequested=false;
   worker.request=async(...args)=>{startupRequested=true;await new Promise(resolve=>releaseStartup=resolve);worker.request=request;return request(...args);};
   for(let tx=40;tx<104;tx++)lifecycleSurface.store.set(tx,2,new Uint8ClampedArray([32,62,216,255]));
   styk.drawing.owner.present(lifecycleSurface);
  });
  const starting=await page.evaluate(()=>probeDrawing());observations.push({mode,phase:'waiting for first worker preview',...starting});
  check(`${mode}: entering worker previews retains visible artwork while startup is blocked`,starting.ink===painted.ink&&await page.evaluate(()=>startupRequested));
  await page.screenshot({path:`${output}/${mode}-preview-startup.png`});
  await page.evaluate(()=>releaseStartup());await page.waitForFunction(()=>!styk.drawing.owner.previews.active);
  await page.evaluate(()=>{for(let tx=40;tx<104;tx++)lifecycleSurface.store.delete(tx,2);styk.drawing.owner.present(lifecycleSurface);});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.waitForFunction(()=>styk.drawing.gesture?.session&&lifecycleSurface.store.bounds===null);
  const erased=await page.evaluate(()=>probeDrawing());observations.push({mode,phase:'held eraser',...erased});
  await page.screenshot({path:`${output}/${mode}-held-eraser.png`});
  check(`${mode}: erasing the last pixel clears the canvas before pointer release`,erased.gesture&&erased.bounds===null&&erased.ink===0);
  await page.evaluate(()=>styk.drawing.cancel());await page.mouse.up();
  const cancelled=await page.evaluate(()=>probeDrawing());observations.push({mode,phase:'cancelled erase',...cancelled});
  check(`${mode}: cancelling the erase restores visible original pixels`,cancelled.ink===painted.ink);
  await page.mouse.down();await page.waitForFunction(()=>styk.drawing.gesture?.session&&lifecycleSurface.store.bounds===null);await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation);
  const committed=await page.evaluate(()=>probeDrawing());check(`${mode}: committed erasing remains blank`,committed.ink===0&&committed.bounds===null);
  await page.evaluate(()=>styk.drawing.history('undo'));const undone=await page.evaluate(()=>probeDrawing());check(`${mode}: Undo restores the erased artwork`,undone.ink===painted.ink);
  await page.evaluate(()=>styk.drawing.history('redo'));const redone=await page.evaluate(()=>probeDrawing());check(`${mode}: Redo clears the artwork again`,redone.ink===0);
  await page.evaluate(()=>seedDrawing());await page.evaluate(()=>probeDrawing());
  await page.evaluate(()=>{lifecycleSurface.store.set(1000,1000,new Uint8ClampedArray([32,62,216,255]));lifecycleSurface.store.delete(3,2);styk.drawing.owner.present(lifecycleSurface);});
  const offscreen=await page.evaluate(()=>probeDrawing());observations.push({mode,phase:'only offscreen pixels remain',...offscreen});
  check(`${mode}: removing the visible pixels does not retain their image when offscreen paint remains`,offscreen.bounds?.x===64000&&offscreen.ink===0);

  await page.evaluate(()=>seedDrawing(true));
  await page.waitForFunction(()=>[...styk.drawing.owner.previews.cache.values()].some(v=>v.entry===lifecycleSurface));
  const dense=await page.evaluate(()=>probeDrawing());check(`${mode}: a worker-preview cel paints its visible tile`,dense.tiles===65&&dense.ink>3000);
  await page.evaluate(()=>{
   const worker=styk.drawing.owner.previews.worker,request=worker.request.bind(worker);window.previewHeld=false;
   worker.request=async(...args)=>{const result=await request(...args);window.previewHeld=true;await new Promise(resolve=>window.releasePreview=resolve);return result;};
   lifecycleSurface.store.set(3,2,new Uint8ClampedArray([20,40,200,255]));styk.drawing.owner.present(lifecycleSurface);
  });
  await page.waitForFunction(()=>window.previewHeld);
  const waiting=await page.evaluate(()=>probeDrawing());check(`${mode}: a nonempty cel keeps its completed image while the next preview waits`,waiting.ink===dense.ink);
  await page.evaluate(()=>{lifecycleSurface.store.delete(3,2);styk.drawing.owner.present(lifecycleSurface);});
  const cleared=await page.evaluate(()=>probeDrawing());check(`${mode}: removing the visible cover clears it even with a preview in flight`,cleared.ink===0);
  await page.evaluate(()=>releasePreview());await page.waitForFunction(()=>!styk.drawing.owner.previews.active);
  const late=await page.evaluate(()=>probeDrawing());observations.push({mode,phase:'late preview after visible pixels removed',...late});
  check(`${mode}: a late completed preview cannot bring removed pixels back`,late.ink===0);

  if(mode==='gpu'){
   await page.evaluate(()=>seedDrawing(true));await page.waitForFunction(()=>[...styk.drawing.owner.previews.cache.values()].some(v=>v.entry===lifecycleSurface));
   const ready=await page.evaluate(()=>probeDrawing());
   await page.evaluate(()=>{
    const owner=styk.drawing.owner,worker=owner.decodeWorker,request=worker.request.bind(worker);window.decodeHeld=false;
    worker.request=async(...args)=>{const result=await request(...args);window.decodeHeld=true;await new Promise(resolve=>window.releaseDecode=resolve);return result;};
    owner.dropScratch(lifecycleSurface);lifecycleSurface.store=null;lifecycleSurface.stamp++;styk.drawing.onRender();
   });
   await page.waitForFunction(()=>window.decodeHeld);const cold=await page.evaluate(()=>probeDrawing());
   check('gpu: an evicted cel keeps its prior image while pixels are still decoding',cold.ink===ready.ink&&cold.bounds===null);
   await page.evaluate(()=>releaseDecode());await page.waitForFunction(()=>lifecycleSurface.store&&!lifecycleSurface.loading&&[...styk.drawing.owner.previews.cache.values()].some(v=>v.entry===lifecycleSurface));
   const decoded=await page.evaluate(()=>probeDrawing());check('gpu: the decoded cel returns to the same visible pixels',decoded.ink===ready.ink);
  }
 }
 check('no uncaught browser errors',errors.length===0);
 await writeFile(output+'/result.json',JSON.stringify({checks,errors,observations,browser:browser.version(),baseline:baseline??null},null,2));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({message:error.message,checks,errors,observations},null,2));await page.screenshot({path:output+'/failure.png'});throw error;}
finally{await browser.close();}
