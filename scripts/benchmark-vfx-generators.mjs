// Generated-effect cost in the real app for a light fight, a dense crowd and
// the heaviest styles together: per-frame batch building (sequential
// playback and after an edit), WebGPU and Canvas rendering with and without
// effects, and playback packet compilation. Requires `npm run serve`;
// STYK_TEST_URL overrides http://127.0.0.1:47832. Writes
// artifacts/vfx-generators/benchmark.json. Timings are one machine's CPU
// submission plus GPU completion; they are not display latency.
import {chromium} from '../tests/support/playwright.mjs';
import fs from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
try{
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready,null,{timeout:60000});
 const results=await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{initializeLayerSheet}=await import('/src/editor-layer-sheet.mjs');
  const {createRenderer}=await import('/src/renderer.mjs'),{generatorBatchFor,generatorAnchorStats,INTERACTIVE_SAMPLING_MS}=await import('/src/vfx-generator-frame.mjs'),{compilePlaybackPacket}=await import('/src/playback-worker.mjs');
  const stats=list=>{const s=[...list].sort((a,b)=>a-b);return {median:+s[s.length>>1].toFixed(3),p95:+s[Math.floor(s.length*.95)].toFixed(3),max:+s.at(-1).toFixed(3)};};
  const e=styk.editor,out={};
  for(const [name,figures,effects] of [['light',2,'fight'],['dense',300,'crowd'],['styles',16,'styles']]){
   const doc=emptyDocument(),fig=doc.figure_types[0];doc.canvas_width=1280;doc.canvas_height=720;
   doc.keyframes=[0,1,2,3,4,5].map(k=>{const f=createFrame(Array.from({length:figures},(_,i)=>createObject(fig,i+1,80+(i%30)*40+k*6,260+Math.floor(i/30)*30)),20);f._stykBackgroundColor=0xff15131f;return f;});
   e.load(doc);initializeLayerSheet(e.report);e._invalidate({timing:true});
   if(effects==='fight'){e.addVfxClip({kind:'figure',uid:1},'aura',{start:0,duration:100});e.addVfxClip({kind:'figure',uid:1},'beam',{start:10,duration:60});e.addVfxClip({kind:'figure',uid:2},'explosion',{start:24,duration:40});}
   else if(effects==='styles'){
    // The heaviest looks together: every aura style, big textured explosions, thick smoke and fire breath.
    const style=(id,values)=>e.setVfxClipParameters(id,e.getVfxClips().find(c=>c.id===id).effects[0].id,values);
    for(let i=0;i<8;i++)style(e.addVfxClip({kind:'figure',uid:1+i},'aura',{start:0,duration:100}),{style:i});
    for(const [i,s] of [[3,4],[5,3],[2,2],[7,5]].entries())style(e.addVfxClip({kind:'figure',uid:9+i},'explosion',{start:10+i*6,duration:60}),{style:s[1]});
    style(e.addVfxClip({kind:'figure',uid:13},'smoke',{start:0,duration:100}),{style:1});style(e.addVfxClip({kind:'figure',uid:14},'beam',{start:6,duration:80}),{style:5,aimUid:15});
   }
   else{for(let i=0;i<10;i++)e.addVfxClip({kind:'figure',uid:1+i*29},'aura',{start:0,duration:100});for(let i=0;i<5;i++)e.addVfxClip({kind:'figure',uid:150+i*20},'explosion',{start:8+i*12,duration:30});e.addVfxGroup({kind:'scene'},'Rain');e.addVfxClip({kind:'figure',uid:40},'beam',{start:6,duration:80});}
   const batch=[],cold=[],particles=[];
   for(let tick=0;tick<90;tick++){e.seek(tick);const frame=e.evaluatedFrame,geometry=e.geometry;const t=performance.now(),b=generatorBatchFor(e.report,frame,geometry);batch.push(performance.now()-t);particles.push(b?.particles??0);}
   for(let i=0;i<8;i++){e._invalidate({timing:true});e.seek(40+i);const frame=e.evaluatedFrame,geometry=e.geometry,t=performance.now();generatorBatchFor(e.report,frame,geometry);cold.push(performance.now()-t);}
   // The editor samples trails within a frame budget and refines on later frames.
   const interactive=[],refineFrames=[];
   for(let i=0;i<8;i++){e._invalidate({timing:true});e.seek(40+i);const frame=e.evaluatedFrame,geometry=e.geometry;let frames=0,b;do{const t=performance.now();b=generatorBatchFor(e.report,frame,geometry,{budgetMs:INTERACTIVE_SAMPLING_MS});interactive.push(performance.now()-t);frames++;}while(b?.incomplete&&frames<200);refineFrames.push(frames);}
   const size={w:1280,h:720},gpu=await createRenderer(document.createElement('canvas')),soft=await createRenderer(document.createElement('canvas'),{forceCanvas2D:true});
   gpu.resize(size.w,size.h,1);soft.resize(size.w,size.h,1);
   const view={x:0,y:0,scale:1},timing={gpuWith:[],gpuWithout:[],canvasWith:[],canvasWithout:[],packet:[]};
   try{
    for(let tick=30;tick<60;tick++){
     e.seek(tick);const options={report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,view};
     for(const [key,enabled] of [['gpuWithout',false],['gpuWith',true]]){const t=performance.now();gpu.render({...options,vfxEnabled:enabled});await gpu.device.queue.onSubmittedWorkDone();timing[key].push(performance.now()-t);}
     if(tick%3===0)for(const [key,enabled] of [['canvasWithout',false],['canvasWith',true]]){const t=performance.now();soft.render({...options,vfxEnabled:enabled});timing[key].push(performance.now()-t);}
     if(tick%5===0){const t=performance.now(),packet=await compilePlaybackPacket(e.report,tick,{gpuIsolation:true});timing.packet.push(performance.now()-t);for(const item of packet.compatibility)item.bitmap?.close();}
    }
   }finally{gpu.destroy();soft.destroy();}
   out[name]={figures,particles:stats(particles),batchMs:stats(batch),afterEditMs:stats(cold),interactiveFrameMs:stats(interactive),refineFrames:stats(refineFrames),...Object.fromEntries(Object.entries(timing).map(([k,v])=>[k+'Ms',stats(v)])),anchors:generatorAnchorStats()};
  }
  return out;
 });
 await fs.mkdir('artifacts/vfx-generators',{recursive:true});
 await fs.writeFile('artifacts/vfx-generators/benchmark.json',JSON.stringify({date:new Date().toISOString(),userAgent:await page.evaluate(()=>navigator.userAgent),results},null,2));
 console.log(JSON.stringify(results,null,1));
}finally{await browser.close();}
