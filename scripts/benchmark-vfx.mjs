import {chromium} from '../tests/support/playwright.mjs';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage();await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const report=await page.evaluate(async()=>{
  const {createRenderer}=await import('/src/renderer.mjs'),{emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{createVfx}=await import('/src/vfx.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs'),{vfxGPUStats,releaseVfxGPU}=await import('/src/vfx-gpu.mjs');
  const results=[];
  for(const scenario of ['none','scene-grade-noise','scene-editing','scene-distortion','scene-bloom-crt','10-glows','100-glows','10-animated-glows']){
   releaseVfxGPU();const report=emptyDocument();report.canvas_width=1280;report.canvas_height=720;
   const objects=Array.from({length:1000},(_,i)=>createObject(report.figure_types[0],i+1,25+(i%50)*25,50+Math.floor(i/50)*33,{scale:.15}));
   const count=scenario==='100-glows'?100:scenario.includes('glows')?10:0;
   for(let i=0;i<count;i++)objects[i]._stykVfx={figure:[createVfx('glow','effect')]};
   const frame=createFrame(objects,60);report.keyframes=[frame];
   if(scenario.startsWith('scene-'))frame._stykVfx={figure:[{...createVfx('grade','grade'),params:{exposure:.1,contrast:.9,saturation:.8,temperature:.1}},createVfx('noise','noise')]};
   if(scenario==='scene-distortion')frame._stykVfx={figure:['wave','rgbSplit','shockwave'].map(type=>createVfx(type,type))};
   if(scenario==='scene-bloom-crt')frame._stykVfx={figure:[createVfx('bloom','bloom'),{...createVfx('crt','crt'),params:{...createVfx('crt','crt').params,curvature:.1,chromatic:2}}]};
   const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas);renderer.resize(1280,720,1);let geometry=buildGeometry(report,frame);const view={x:0,y:0,scale:1};
   const cameraEnabled=scenario!=='scene-editing',coldStart=performance.now();renderer.render({report,frame,geometry,view,cameraEnabled});await renderer.device?.queue.onSubmittedWorkDone();const coldMs=performance.now()-coldStart,times=[];
   for(let i=0;i<24;i++){
    if(scenario==='10-animated-glows'){for(let j=0;j<count;j++){const old=objects[j]._stykVfx.figure[0];objects[j]={...objects[j],_stykVfx:{figure:[{...old,params:{...old.params,radius:12+i/2}}]}};}geometry=buildGeometry(report,frame);}
    const start=performance.now();renderer.render({report,frame,geometry,view,cameraEnabled,dragTranslations:new Map([[1,{x:i%3,y:0}]])});await renderer.device?.queue.onSubmittedWorkDone();times.push(performance.now()-start);
   }
   const sorted=times.slice().sort((a,b)=>a-b);results.push({scenario,backend:renderer.stats.backend,adapter:renderer.stats.adapter,coldMs,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.floor(sorted.length*.95)],vfx:vfxGPUStats(),raster:renderer.rasterCache?.stats});renderer.destroy();
  }releaseVfxGPU();return {resolution:[1280,720],figures:1000,samples:24,results};
 });
 await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
