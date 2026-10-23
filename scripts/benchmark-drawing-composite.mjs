import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const output=process.env.STYK_COMPOSITE_BENCHMARK||'artifacts/drawing-worker-composite';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),results=[];
try{
  for(let round=0;round<3;round++)for(const mode of round%2?['worker','main']:['main','worker']){
    const page=await browser.newPage();await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
    const result=await page.evaluate(async mode=>{
      const {drawGeometry,releaseGeometryResources}=await import('/src/pivot/geometry.mjs'),{DrawingResources}=await import('/src/drawing-resources.mjs'),{sendDrawingComposite}=await import('/src/drawing-composite-transport.mjs');
      const obj={unique_id:1,scale:1},fig={figure_type_id:1},seg={segment_kind:'line'},drawables=[],bounds={x:0,y:0,width:3840,height:2160};
      let seed=1234567;const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/4294967296;
      for(let i=0;i<16000;i++){
        const x=random()*3840,y=random()*2160,points=[{x,y},{x:x+random()*250-125,y:y+random()*250-125}];
        drawables.push({type:'line',obj,fig,seg,slot:0,points,start:points[0],end:points[1],angle:0,bend:0,length:150,thickness:2+random()*8,alpha:1,opacity:1,rgb:[Math.floor(random()*255),Math.floor(random()*255),Math.floor(random()*255)]});
      }
      const owner=new DrawingResources({figure_types:[]},{history:false}),worker=owner.compositeWorker;let canvas,ctx,source,packets=0,maxPacket=0;
      const request=worker.request.bind(worker);worker.request=(kind,data,...rest)=>{if(kind==='composite-chunk'){packets++;maxPacket=Math.max(maxPacket,data.chunk.estimatedBytes??64);}return request(kind,data,...rest);};
      const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())tasks.push(e.duration);}),tasks=[];observer.observe({type:'longtask'});
      let last=performance.now(),maxGap=0,ticks=0;const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},8);
      await new Promise(resolve=>setTimeout(resolve,32));last=performance.now();ticks=0;maxGap=0;const started=performance.now();
      try{
        if(mode==='main'){
          canvas=document.createElement('canvas');canvas.width=bounds.width;canvas.height=bounds.height;ctx=canvas.getContext('2d');
          drawGeometry(ctx,{drawables},{});source=ctx.getImageData(0,0,bounds.width,bounds.height).data;
        }else{
          await sendDrawingComposite(worker,drawables,{maxBytes:256*1024*1024});
          source=new Uint8ClampedArray((await worker.request('composite',{bounds,matrix:[1,0,0,1,0,0],maxBytes:768*1024*1024,baseURL:location.href})).source);
        }
        const elapsedMs=performance.now()-started;
        await new Promise(resolve=>setTimeout(resolve,24));clearInterval(timer);observer.disconnect();
        let hash=2166136261;for(const byte of source)hash=Math.imul(hash^byte,16777619);
        return {mode,elapsedMs,maxEventLoopGapMs:maxGap,ticks,longTasks:tasks,maxLongTaskMs:Math.max(0,...tasks),hash:hash>>>0,sourceBytes:source.byteLength,packets,maxPacket};
      }finally{clearInterval(timer);observer.disconnect();if(ctx)releaseGeometryResources(ctx);if(canvas)canvas.width=canvas.height=1;owner.dispose();}
    },mode);
    results.push({round,...result});console.log(JSON.stringify(results.at(-1)));await page.close();
  }
  assert.equal(new Set(results.map(r=>r.hash)).size,1,'Matched captures must preserve every pixel.');
  const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)],summary=Object.fromEntries(['main','worker'].map(mode=>[mode,Object.fromEntries(['elapsedMs','maxEventLoopGapMs','maxLongTaskMs'].map(key=>[key,median(results.filter(r=>r.mode===mode).map(r=>r[key]))]))]));
  await writeFile(output+'/benchmark.json',JSON.stringify({browser:browser.version(),workload:{width:3840,height:2160,lines:16000,seed:1234567},limits:'Synthetic capture only; excludes flood traversal, physical input and whole-process memory. Main uses the prior direct Canvas capture; worker uses the new frame transport and capture.',summary,results},null,2));console.log(JSON.stringify(summary));
}finally{await browser.close();}
