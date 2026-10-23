import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async baseline=>{
    const current=await import('/src/renderer.mjs'),before=baseline?await import(baseline):null;
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];report.canvas_width=960;report.canvas_height=540;
    const frames=Array.from({length:4},(_,i)=>createFrame(Array.from({length:400},(_,j)=>createObject(figure,j+1,20+j%25*38+i*2,20+Math.floor(j/25)*33,{scale:.18})),1));
    report.keyframes=frames;const scenes=frames.map(frame=>buildGeometry(report,frame));
    const options={report,frame:frames[3],geometry:scenes[3],view:{x:0,y:0,scale:1},cameraEnabled:false,onionFrames:frames.slice(0,3).map((frame,i)=>({frame,geometry:scenes[i],opacity:.14/(3-i)}))};
    const rows=[],errors=[],instances=[];
    const summary=values=>{values.sort((a,b)=>a-b);return{median:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],max:values.at(-1)};};
    try{
      for(const fallback of [false,true])for(const [name,module] of [...(before?[['before',before]]:[]),['after',current]]){
        const canvas=document.createElement('canvas');if(fallback)canvas.getContext('2d');const renderer=await module.createRenderer(canvas);renderer.resize(960,540,1);
        renderer.device?.addEventListener('uncapturederror',e=>errors.push(e.error.message));instances.push({name,renderer,cpu:[],complete:[]});
      }
      // Interleave runs so both revisions share the same scene and system load.
      for(let iteration=0;iteration<50;iteration++)for(const sample of iteration%2?[...instances].reverse():instances){
        const {renderer}=sample;options.dragTranslations=new Map([[1,{x:iteration%15,y:0}]]);
        const start=performance.now();renderer.render(options);const cpu=performance.now()-start;await renderer.device?.queue.onSubmittedWorkDone();
        if(iteration>=10){sample.cpu.push(cpu);sample.complete.push(performance.now()-start);}
      }
      for(const {name,renderer,cpu,complete} of instances)rows.push({name,backend:renderer.stats.backend,adapter:renderer.stats.adapter,cpuMs:summary(cpu),submissionAndCompletionMs:summary(complete),drawCalls:renderer.stats.drawCalls,onionCompositeBytes:renderer.stats.onionCompositeBytes??0,onionCacheBytes:renderer.onionArtworkBytes??0,retainedGpuBytes:renderer.stats.gpuBytes??0,onionRasterized:renderer.stats.onionRasterizedObjects??0});
    }finally{for(const {renderer} of instances)renderer.destroy();}
    return {workload:{figures:400,ghosts:3,width:960,height:540,samples:40},rows,errors};
  },process.env.STYK_ONION_BASELINE??null);
  await mkdir('artifacts/onion-scene-opacity',{recursive:true});await writeFile('artifacts/onion-scene-opacity/benchmark.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(result.errors.length)throw Error(result.errors.join('\n'));
}finally{await browser.close();}
