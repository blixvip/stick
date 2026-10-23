import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
const url=process.env.STYK_URL||'http://127.0.0.1:47839';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('console',message=>{if(message.text().startsWith('DRAWING BENCH'))console.log(message.text());});
try{
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {DrawingStroke}=await import('/src/drawing-pixels.mjs'),{DrawingResources}=await import('/src/drawing-resources.mjs'),{createDrawingFigure}=await import('/src/drawing-model.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs'),{emptyDocument}=await import('/src/demo.mjs');
    const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)];
    const summary=values=>({samples:values.length,p50:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values)});
    // Dab rasterization cost — this code runs inside the stroke worker.
    const brush=(span,size,hardness)=>{
      const times=[];let bytes=0;
      for(let pass=0;pass<5;pass++){const store=new TileStore();const b=new DrawingStroke(store,{size,hardness,flow:hardness?1:.2,pressureSize:false});
        for(let i=0;i<120;i++){const start=performance.now();b.sample({x:64+i*span/120,y:400+Math.sin(i/12)*160});times.push(performance.now()-start);}bytes=Math.max(bytes,b.bytes);b.cancel();}
      return {span,size,hardness,processingMs:summary(times),undoBytes:bytes};
    };
    const brushes=[brush(576,8,1),brush(3840,256,0),brush(1920,512,0)];
    // 500 published cels, each a tile of line art, for cold/warm decode timing.
    const report=emptyDocument(),owner=new DrawingResources(report),figures=[];
    const tile=new Uint8ClampedArray(64*64*4);
    for(let i=0;i<64;i++)for(let j=0;j<64;j++)if(Math.abs(i-j)<2)tile.set([25,35,45,255],(i*64+j)*4);
    console.log('DRAWING BENCH generating 500 published tile cels');
    const generationStart=performance.now();
    for(let i=0;i<500;i++){
      const figure=createDrawingFigure({pixelsPerUnit:1,figureTypeId:i+1});report.figure_types.push(figure);figures.push(figure);
      owner.install(figure,[{tx:(i*13)%30-15,ty:(i*7)%17-8,pixels:tile.slice().buffer}]);
      if(i%100===99)console.log('DRAWING BENCH generated '+(i+1));
    }
    report.canvas_width=1920;report.canvas_height=1080;
    const barrierStart0=performance.now();await owner.flush();const publishMs=performance.now()-barrierStart0;
    const generationMs=performance.now()-generationStart,cold=[],warm=[],memory=[];
    for(let cycle=0;cycle<3;cycle++){
      for(let i=0;i<24;i++){const figure=figures[cycle*100+i],entry=owner.entry(figure);entry.store=null;
        let start=performance.now();await owner.surface(figure);cold.push(performance.now()-start);
        start=performance.now();await owner.surface(figure);warm.push(performance.now()-start);}
      memory.push({...owner.stats});
    }
    console.log('DRAWING BENCH cache cycles complete');
    const f=figures[350],surface=await owner.surface(f),stroke=new DrawingStroke(surface.store,{size:32});stroke.sample({x:400,y:400});owner.apply(f,stroke.finish(),'after');
    const barrierStart=performance.now();await owner.flush();const barrierMs=performance.now()-barrierStart;
    const start=performance.now(),filled=await owner.worker.request('fill',{bounds:{x:0,y:0,width:704,height:544},tiles:[],options:{x:0,y:0,color:[20,40,60,255],tolerance:16,expansion:1,gap:0},maxBytes:64*1024*1024}),fillMs=performance.now()-start;
    const output={brushes,fixture:{cels:figures.length,generationMs,publishMs,tileBlobCharacters:figures.reduce((n,f)=>n+(f.image_assets[0].styk_tiles?.length??0),0)},coldFlipMs:summary(cold),warmFlipMs:summary(warm),memory,barrierMs,fillMs,fillTiles:filled.tiles.length,budgets:{tiles:owner.tileBudget}};
    owner.dispose();output.afterDispose=owner.stats;
    const adapter=await navigator.gpu?.requestAdapter();output.gpu=adapter?.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}:null;
    return output;
  });
  // Interactive pipeline: a real pointer stroke through the stroke worker.
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-draw-action="new"]').first().click();
  await page.evaluate(()=>{
    const d=styk.drawing;window.__rtt=[];const orig=d.strokeMessage.bind(d);
    d.strokeMessage=data=>{orig(data);if(data.kind==='tiles')window.__rtt.push(d.strokeStats.lastRoundTripMs);};
    window.__lt=[];window.__frames=0;new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(e.duration)}).observe({entryTypes:['longtask']});
    const tick=()=>{window.__frames++;window.__raf=requestAnimationFrame(tick)};requestAnimationFrame(tick);
  });
  const rect=await page.locator('#viewport').boundingBox(),x=rect.x+rect.width*.25,y=rect.y+rect.height*.3;
  await page.mouse.move(x,y);await page.mouse.down();await page.waitForFunction(()=>Boolean(styk.drawing.gesture));
  await page.evaluate(()=>{window.__lt.length=0;window.__rtt.length=0;window.__frames=0;});
  const wallStart=Date.now();
  await page.mouse.move(x+620,y+260,{steps:300});await page.mouse.up();
  await page.waitForFunction(()=>!styk.drawing.gesture);
  const wallMs=Date.now()-wallStart;
  const pipeline=await page.evaluate(()=>{cancelAnimationFrame(window.__raf);
    const p=(values,q)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*q)]??0;
    return {batches:styk.drawing.strokeStats.batches,maxQueueDepth:styk.drawing.strokeStats.maxQueueDepth,wallMs:0,workerRoundTripMs:{samples:__rtt.length,p50:p(__rtt,.5),p95:p(__rtt,.95),max:Math.max(...__rtt,0)},frames:__frames,longTasks:__lt.length,longTaskMs:__lt.reduce((a,b)=>a+b,0)};
  });
  pipeline.wallMs=wallMs;pipeline.longTaskMsPerAnimationFrame=pipeline.frames?pipeline.longTaskMs/pipeline.frames:0;
  result.pipeline=pipeline;
  result.environment={cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),platform:os.platform(),node:process.version,chrome:await browser.version(),headless:true,date:new Date().toISOString()};
  await mkdir('artifacts/drawing',{recursive:true});await writeFile('artifacts/drawing/performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
