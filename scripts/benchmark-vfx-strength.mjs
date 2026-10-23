import {chromium} from '../tests/support/playwright.mjs';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const result=await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const {createVfx}=await import('/src/vfx.mjs');
  const {evaluatedFrame,buildGeometry}=await import('/src/pivot/geometry.mjs');
  const {createRenderer}=await import('/src/renderer.mjs');
  const {vfxGPUStats}=await import('/src/vfx-gpu.mjs');
  const {RetainedGeometryCache}=await import('/src/playback-geometry-cache.mjs');
  const {compilePlaybackPacket}=await import('/src/playback-worker.mjs');
  const {PlaybackResources}=await import('/src/playback-resources.mjs');
  const rows=[];
  const summarize=list=>{list.sort((a,b)=>a-b);return {median:list[Math.floor(list.length/2)],p95:list[Math.floor(list.length*.95)]};};
  for(const scenario of ['none','10-turbulence','10-partial-strength','scene-turbulence']){
   const doc=emptyDocument();doc.canvas_width=1280;doc.canvas_height=720;
   doc.keyframes=[0,1].map(k=>{
    const objects=Array.from({length:1000},(_,i)=>{
     const object=createObject(doc.figure_types[0],i+1,25+i%50*25+(i<10?k*100:0),55+Math.floor(i/50)*33,{scale:.15});
     if(i<10&&scenario.startsWith('10-')){
      const effect=createVfx('turbulence','t');if(scenario==='10-partial-strength')effect.params.effectStrength=.5;
      object._stykVfx={figure:[effect]};
     }return object;
    });
    const frame={...createFrame(objects,40),_styk:{easing:{interpolation:'linear'}}};
    if(scenario==='scene-turbulence')frame._stykVfx={figure:[createVfx('turbulence','t')]};
    return frame;
   });
   const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas);renderer.resize(1280,720,1);
   const cache=new RetainedGeometryCache(),preparation=[],rendering=[];let geometry;
   for(let i=0;i<25;i++){
    const tick=10+i,start=performance.now(),frame=evaluatedFrame(doc,0,tick/40,tick);geometry=cache.get(doc,frame,1);const prepared=performance.now();
    renderer.render({report:doc,frame,geometry,view:{x:0,y:0,scale:1},cameraEnabled:true});await renderer.device?.queue.onSubmittedWorkDone();
    if(i){preparation.push(prepared-start);rendering.push(performance.now()-prepared);}
   }
   const resources=new PlaybackResources(),packet=await compilePlaybackPacket(doc,34,{resources,scale:1,quality:1});
   const key=renderer.prepareFrame(packet,{report:doc,view:{x:0,y:0,scale:1}}),presentation=[];
   for(let i=0;i<24;i++){const start=performance.now();renderer.renderPrepared(key,{report:doc,view:{x:0,y:0,scale:1},cameraEnabled:true});await renderer.device?.queue.onSubmittedWorkDone();presentation.push(performance.now()-start);}
   rows.push({scenario,backend:renderer.stats.backend,adapter:renderer.stats.adapter,preparationMs:summarize(preparation),renderMs:summarize(rendering),preparedPresentationMs:summarize(presentation),vfx:vfxGPUStats()});
   for(const item of packet.compatibility)item.bitmap?.close();resources.dispose();renderer.destroy();
  }
  return {figures:1000,resolution:[1280,720],samples:24,rows};
 });
 await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/strength-performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
