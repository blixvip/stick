import {chromium} from '../tests/support/playwright.mjs';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';

// Serve only the changed rendering modules from a git revision for comparison;
// never swap files in the user's checkout. Other modules remain the current code.
const revision=process.argv.find(arg=>arg.startsWith('--baseline='))?.slice(11);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();
 if(revision)for(const file of ['export-frame-core.mjs','vfx-camera.mjs','vfx-camera-gpu.mjs','vfx-canvas.mjs','vfx.mjs','pivot/background.mjs']){
  const body=execFileSync('git',['show',`${revision}:src/${file}`],{encoding:'utf8',windowsHide:true});
  await page.route(`**/src/${file}`,route=>route.fulfill({status:200,contentType:'text/javascript',body}));
 }
 await page.goto((process.env.STYK_TEST_URL||'http://127.0.0.1:47832')+'/api/health');
 const rows=await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{createVfx}=await import('/src/vfx.mjs');
  const {createRenderer}=await import('/src/renderer.mjs'),{drawExportSceneTiled,exportFrameGeometry}=await import('/src/export-frame-core.mjs');
  const {vfxGPUStats,releaseVfxGPU}=await import('/src/vfx-gpu.mjs'),{releaseGeometryResources}=await import('/src/pivot/geometry.mjs');
  const stats=times=>{const sorted=times.toSorted((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.floor(sorted.length*.95)]};};
  const rows=[];
  for(const scene of ['none','shockwave','mixed']){
   const report=emptyDocument();report.canvas_width=1280;report.canvas_height=720;
   const frame=createFrame(Array.from({length:1000},(_,i)=>createObject(report.figure_types[0],i+1,-20+(i%50)*27,20+Math.floor(i/50)*37,{scale:.15})),24);report.keyframes=[frame];
   if(scene!=='none')frame._stykVfx={figure:(scene==='mixed'?['blur','wave','shockwave']:['shockwave']).map(type=>createVfx(type,type))};
   const geometry=exportFrameGeometry(report,frame),renderer=await createRenderer(document.createElement('canvas'));renderer.resize(1280,720,1);
   const preview=[];let cold;
   for(let i=0;i<25;i++){
    const start=performance.now();renderer.render({report,frame,geometry,view:{scale:1},dragTranslations:new Map([[1,{x:i%3,y:0}]])});await renderer.device.queue.onSubmittedWorkDone();
    const ms=performance.now()-start;if(i)preview.push(ms);else cold=ms;
   }
   const previewBytes=vfxGPUStats().bytes,backend=renderer.stats.backend;
   renderer.destroy();releaseVfxGPU();
   const output=new OffscreenCanvas(1280,720),ctx=output.getContext('2d',{willReadFrequently:true}),tile=new OffscreenCanvas(1,1),exports=[];let exportCold;
   for(let i=0;i<9;i++){
    const start=performance.now();await drawExportSceneTiled(ctx,report,frame,geometry,{preload:async()=>{}},512,tile);
    // Force completion and include readback, as the encoders consume pixels.
    ctx.getImageData(0,0,1280,720);const ms=performance.now()-start;if(i)exports.push(ms);else exportCold=ms;
   }
   rows.push({scene,backend,figures:1000,output:[1280,720],preview:{samples:24,coldMs:cold,...stats(preview),filterBytes:previewBytes},export:{samples:8,coldMs:exportCold,...stats(exports),filterBytes:vfxGPUStats().bytes},releasedTile:[tile.width,tile.height]});
   releaseGeometryResources(ctx);output.width=output.height=1;releaseVfxGPU();
  }
  return rows;
 });
 await fs.mkdir('artifacts/vfx/camera-sampling',{recursive:true});
 await fs.writeFile(`artifacts/vfx/camera-sampling/performance-${revision?'baseline':'current'}.json`,JSON.stringify({revision:revision??'working tree',rows},null,2));console.log(JSON.stringify(rows,null,2));
}finally{await browser.close();}
