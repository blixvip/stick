import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=process.env.STYK_LIVE_ARTIFACTS||'artifacts/drawing-live',checks=[],errors=[];await mkdir(output,{recursive:true});
const previewDelayMs=Number(process.env.STYK_PREVIEW_DELAY_MS||0),baseline=process.env.STYK_LIVE_BASELINE,software=process.env.STYK_LIVE_SOFTWARE==='1';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
 // Apply the same disabled HTTP cache policy to comparison revisions.
 await page.context().route('**/*',route=>route.continue());
 if(baseline)for(const name of process.env.STYK_LIVE_MODULES?.split(',')??['drawing-preview-cache','drawing-worker-operations','renderer']){const body=execFileSync('git',['show',`${baseline}:src/${name}.mjs`],{encoding:'utf8'});await page.context().route(`**/src/${name}.mjs`,route=>route.fulfill({contentType:'text/javascript',body}));}
 if(software)await page.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));
 await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
 // This suite covers the stroke worker and worker-preview presenter, the
 // Canvas path and WebGPU fallback; GPU tiles have their own suite.
 await page.evaluate(()=>styk.state.renderer.setGpuDrawing?.(false));await page.locator('[data-workspace-mode="draw"]').click();
 await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');styk.editor.load(emptyDocument());styk.editor.createDrawingLayer();styk.state.settings.autosaveSeconds=0;Object.assign(styk.drawing.settings,{size:8,resolution:2,stabilization:0,color:'#203ed8'});});
 if(previewDelayMs)await page.evaluate(ms=>{const worker=styk.drawing.owner.previews.worker,request=worker.request.bind(worker);worker.request=async(...args)=>{const result=await request(...args);await new Promise(resolve=>setTimeout(resolve,ms));return result;};},previewDelayMs);
 const box=await page.locator('#viewport').boundingBox(),start={x:box.x+100,y:box.y+100};
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.waitForFunction(()=>styk.drawing.gesture?.session);
 const measured=await page.evaluate(async({x,y})=>{
  const d=styk.drawing,scene=document.querySelector('#scene'),canvas=new OffscreenCanvas(24,24),ctx=canvas.getContext('2d',{willReadFrequently:true}),points=[],trips=[];
  const previewWorker=d.owner.previews.worker,previewRequest=previewWorker.request;let firstPreviewMs=null;
  previewWorker.request=async function(...args){const start=performance.now(),result=await previewRequest.apply(this,args);firstPreviewMs??=performance.now()-start;return result;};
  const started=performance.now(),duration=5500,misses=[];let probes=0,hits=0,missSince=null,maxMissMs=0,maxPending=0,firstVisibleMs=null;
  const input=setInterval(()=>{const elapsed=Math.min(duration,performance.now()-started),t=elapsed/duration,row=Math.min(7,Math.floor(t*8)),u=t*8-row,p={x:x+(row%2?1-u:u)*720,y:y+row*46,time:performance.now()};points.push(p);d.move({pointerId:d.gesture.id,pointerType:'mouse',pressure:.5,clientX:p.x,clientY:p.y,timeStamp:p.time});maxPending=Math.max(maxPending,d.gesture.session.pending.length);},8);
  const observe=()=>{
   const now=performance.now(),point=points.findLast(p=>p.time<=now-100);
   if(point){
    const rect=scene.getBoundingClientRect(),sx=(point.x-rect.left)*scene.width/rect.width,sy=(point.y-rect.top)*scene.height/rect.height;
    ctx.clearRect(0,0,24,24);ctx.drawImage(scene,sx-12,sy-12,24,24,0,0,24,24);
    const bytes=ctx.getImageData(0,0,24,24).data;let visible=false;for(let i=0;i<bytes.length;i+=4)if(bytes[i]<70&&bytes[i+1]<110&&bytes[i+2]>160&&bytes[i+3]>100){visible=true;break;}
    probes++;if(visible){hits++;firstVisibleMs??=now-started;missSince=null;}else{missSince??=now;maxMissMs=Math.max(maxMissMs,now-missSince);if(misses.length<50){const p=d.pixel({clientX:point.x,clientY:point.y},d.gesture.target);misses.push({ms:now-started,x:point.x,y:point.y,sx,sy,pixels:d.gesture.surface.store.pixel(Math.floor(p.x),Math.floor(p.y)),tiles:d.gesture.surface.store.size,pixelStamp:d.gesture.surface.pixelStamp,previewVersions:[...d.owner.previews.cache.values()].map(v=>v.version)});}}
    trips.push(d.strokeStats.lastRoundTripMs);
   }
  };
  // WebGPU swaps its presentation texture after the paint task. Read the
  // canvas immediately after the app renders, as its color sampler does.
  const renderer=styk.state.renderer,render=renderer.render,queue=renderer.device?.queue,copy=queue?.copyExternalImageToTexture,seen=new WeakSet();let previewUploads=0,duplicatePreviewUploads=0,peakWorkingBytes=0;
  if(copy)queue.copyExternalImageToTexture=function(source,...args){if(source.source instanceof ImageBitmap&&[...renderer.drawingTextures?.values()??[]].some(t=>t.canvas===source.source)){previewUploads++;if(seen.has(source.source))duplicatePreviewUploads++;seen.add(source.source);}return copy.call(this,source,...args);};
  renderer.render=function(...args){const result=render.apply(this,args);observe();peakWorkingBytes=Math.max(peakWorkingBytes,d.owner.workingBytes);return result;};
  try{await new Promise(resolve=>setTimeout(resolve,duration));}
  finally{clearInterval(input);renderer.render=render;previewWorker.request=previewRequest;if(copy)queue.copyExternalImageToTexture=copy;}
  trips.sort((a,b)=>a-b);
  return{samples:points.length,probes,hits,visibleFraction:hits/probes,maxMissMs,firstVisibleMs,firstPreviewMs,maxPending,tiles:d.gesture.surface.store.size,workerMedianMs:trips[Math.floor(trips.length*.5)],workerP95Ms:trips[Math.floor(trips.length*.95)],workerMaxMs:Math.max(...trips),backend:renderer.stats.backend,previewUploads,duplicatePreviewUploads,peakWorkingBytes,misses};
 },start);
 console.log(JSON.stringify(measured));await writeFile(output+'/measured.json',JSON.stringify(measured,null,2));
 check('a small 2x brush paints while continuous input crosses the worker-preview threshold',measured.samples>250&&measured.probes>100&&measured.tiles>64);
 check('recent pointer positions remain visibly painted during the stroke',measured.visibleFraction>.9&&measured.maxMissMs<500);
 if(!software)check('unchanged completed previews are not uploaded again for newer input',measured.previewUploads>0&&measured.duplicatePreviewUploads===0);
 await page.screenshot({path:output+'/during-stroke.png'});await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation);
 check('the live stroke finishes as one undoable brush command',await page.evaluate(()=>styk.editor.undoLabel==='Brush stroke'));
 check('no uncaught browser errors',errors.length===0);
 await writeFile(output+'/live.json',JSON.stringify({checks,errors,measured,browser:browser.version(),previewDelayMs,baseline:baseline??null,method:'Scripted 125 Hz pointer samples with real worker/rendering and optional delayed preview replies. Each rendered frame probes canvas pixels near the pointer position from 100 ms earlier while input continues. Both comparison revisions disable HTTP caching. Canvas readback affects timing; this is a visible-progress regression check, not physical tablet or input-to-photon measurement.'},null,2));
}catch(error){await page.screenshot({path:output+'/failure.png'});throw error;}finally{await browser.close();}
