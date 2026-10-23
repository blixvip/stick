import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const output=path.resolve('artifacts/telemetry-fixes-2026-09-12/camera');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1100,height:600}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const baseline='28cd6f9',sources=new Map();
  await page.route('**/release/**',async route=>{
    const file=new URL(route.request().url()).pathname.replace('/release/','');
    if(!sources.has(file))sources.set(file,execFileSync('git',['show',`${baseline}:${file}`],{maxBuffer:16*1024*1024}));
    await route.fulfill({body:sources.get(file),contentType:'text/javascript'});
  });
  await page.goto(`${process.env.STYK_URL||'http://127.0.0.1:47843'}/api/health`);
  const result=await page.evaluate(async()=>{
    const [{drawCameraMonitor},{drawCameraMonitor:released},{createRenderer},{PlaybackCache},{defaultFigure,createObject,createFrame},{buildGeometry}]=await Promise.all([
      import('/src/camera-monitor.mjs'),import('/release/src/camera-monitor.mjs'),import('/src/renderer.mjs'),import('/src/playback.mjs'),import('/src/demo.mjs'),import('/src/pivot/geometry.mjs')]);
    document.body.replaceChildren();document.body.style.cssText='background:#e9edf2;font:16px sans-serif;display:flex;gap:24px;padding:24px';
    const canvas=label=>{const box=document.createElement('div');box.textContent=label;const c=document.createElement('canvas');c.style.cssText='display:block;width:480px;height:300px;margin-top:12px';box.append(c);document.body.append(box);return c;};
    const before=canvas('Released 0.5.6'),after=canvas('Candidate');
    const figure=defaultFigure(1),objects=Array.from({length:400},(_,i)=>createObject(figure,i+1,20+(i%25)*25,20+Math.floor(i/25)*24,{scale:.18}));
    const frame=createFrame(objects),report={version:5,canvas_width:640,canvas_height:400,figure_types:[figure],keyframes:[frame],backgrounds:[]};
    const renderer=await createRenderer(document.createElement('canvas'));renderer.resize(640,400,1);
    if(!renderer.device)throw new Error(`Camera GPU comparison requires WebGPU; got ${renderer.stats.backend}`);
    const playback=new PlaybackCache();
    try {
      playback.load(report,{cameraEnabled:true});await playback.prepareRange([0]);
      const packet=playback.get(0),key=renderer.prepareFrame(packet,{report,view:{scale:1}}),base={report,resources:renderer.resources,onError:error=>{throw error;}};
      const sample=async(draw,target,prepared)=>{
        const submit=[],complete=[];
        for(let i=0;i<35;i++){
          const start=performance.now();draw(target,{...base,frame:{...frame},prepared});const submitted=performance.now();
          await renderer.device.queue.onSubmittedWorkDone();target.getContext('2d').getImageData(0,0,1,1);
          if(i>=5){submit.push(submitted-start);complete.push(performance.now()-start);}
        }
        const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {mean:values.reduce((a,b)=>a+b,0)/values.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)};};
        return {submit:stats(submit),complete:stats(complete)};
      };
      const comparisons=[];
      for(let round=0;round<3;round++){
        const prepared={renderer,key};
        if(round%2){const candidate=await sample(drawCameraMonitor,after,prepared);comparisons.push({candidate,released:await sample(released,before)});}
        else comparisons.push({released:await sample(released,before),candidate:await sample(drawCameraMonitor,after,prepared)});
      }
      const a=before.getContext('2d').getImageData(0,0,before.width,before.height).data,b=after.getContext('2d').getImageData(0,0,after.width,after.height).data;
      let absolute=0,changed=0;for(let i=0;i<a.length;i+=4){let pixel=0;for(let c=0;c<4;c++){const d=Math.abs(a[i+c]-b[i+c]);absolute+=d;pixel=Math.max(pixel,d);}if(pixel>32)changed++;}
      const pixelDifference={meanAbsolute:absolute/a.length,over32Percent:changed/(a.length/4)*100};
      if(pixelDifference.meanAbsolute>8||pixelDifference.over32Percent>10)throw new Error(`Camera artwork mismatch: ${JSON.stringify(pixelDifference)}`);
      const failed=document.createElement('canvas');failed.style.cssText='width:160px;height:100px';document.body.append(failed);
      const original=failed.getContext.bind(failed),failures=[];let attempts=0,invalidations=0;
      failed.getContext=()=>{attempts++;return null;};
      const options={...base,frame,geometry:buildGeometry(report,frame),onError:e=>failures.push({code:e.telemetryCode,stage:e.telemetryStage}),onInvalidate:()=>invalidations++};
      const failedOnce=drawCameraMonitor(failed,options),skipped=drawCameraMonitor(failed,options);
      if(failedOnce!==false||skipped!==false||attempts!==1||failures.length!==1)throw new Error('Preview failure did not back off.');
      failed.getContext=original;failed.dispatchEvent(new Event('contextrestored'));
      if(!drawCameraMonitor(failed,options)||invalidations!==1)throw new Error('Preview did not recover after context restoration.');
      const ctx=original('2d'),transform=ctx.transform.bind(ctx),restore=ctx.restore.bind(ctx);let restores=0;
      ctx.transform=()=>{throw new TypeError('Injected preview drawing failure');};ctx.restore=()=>{restores++;restore();};
      if(drawCameraMonitor(failed,options)!==false||restores!==1)throw new Error('Preview drawing failure leaked canvas state.');
      ctx.transform=transform;failed.dispatchEvent(new Event('contextrestored'));
      if(!drawCameraMonitor(failed,options))throw new Error('Preview failed after drawing error recovery.');
      failed.remove();
      const softwareErrors=[],software=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true,onError:error=>softwareErrors.push(error.telemetryCode)});
      software.resize(640,400,1);
      const getContext=OffscreenCanvas.prototype.getContext;let allocations=0;
      try {
        OffscreenCanvas.prototype.getContext=function(type,...args){if(type==='2d'){allocations++;return null;}return getContext.call(this,type,...args);};
        const opts={report,frame,geometry:options.geometry,view:{scale:1},cameraEnabled:false};
        software.render(opts);software.render(opts);
        if(allocations!==1||softwareErrors.length!==1)throw new Error('Software raster allocation failure did not fall back once.');
        const pixels=software.context.getImageData(0,0,640,400).data;let ink=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&pixels[i]<150)ink++;
        if(ink<100)throw new Error('Software fallback lost the artwork.');
      }finally{OffscreenCanvas.prototype.getContext=getContext;software.destroy();}
      return {backend:renderer.stats.backend,adapter:renderer.stats.adapter,figures:objects.length,segments:figure.segments.length*objects.length,comparisons,pixelDifference,failures,invalidations,softwareErrors};
    }finally{playback.dispose();renderer.destroy();}
  });
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'comparison.png')});
  await writeFile(path.join(output,'results.json'),JSON.stringify({browser:browser.version(),baseline,...result,errors},null,2));
  console.log(JSON.stringify(result));
}finally{await browser.close();}
