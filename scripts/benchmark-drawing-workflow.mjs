import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const results={scenarios:[]},errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.state.settings.autosaveSeconds=0;});
  await page.locator('[data-workspace-mode="draw"]').click();
  for(const count of [1,500]){
    await page.evaluate(async count=>{
      const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
      const report=emptyDocument();report.canvas_width=640;report.canvas_height=480;
      report.keyframes=[createFrame(Array.from({length:count},(_,i)=>createObject(report.figure_types[0],i+1,20+(i%25)*25,50+Math.floor(i/25)*20,{scale:.12})),96)];
      styk.editor.load(report);styk.drawing.bind();
      for(let i=0;i<(count===1?1:3);i++){
        styk.editor.createDrawingLayer();const target=styk.editor.prepareDrawingCel(),surface=await styk.drawing.owner.surface(target.figure),{DrawingStroke}=await import('/src/drawing-pixels.mjs');
        const stroke=new DrawingStroke(surface.store,{size:8});stroke.sample({x:60+i*50,y:100});styk.editor.commitDrawingPixels(target,stroke.finish());styk.editor.extendDrawing(undefined,95);
      }
      await styk.drawing.barrier();styk.fit();styk.drawing.settings.size=8;
      const b=window.drawingBench={processing:[],latency:[],pending:[],renders:[],longTasks:[],active:false,playing:[]};
      b.observer=new PerformanceObserver(list=>{if(b.active)b.longTasks.push(...list.getEntries().map(e=>({at:e.startTime,ms:e.duration})));});b.observer.observe({entryTypes:['longtask']});
      b.samples=new WeakMap();b.batches=new Map();
      const d=styk.drawing;
      if(!d._benchSampleStroke){
        d._benchSampleStroke=d.sampleStroke;d.sampleStroke=function(event){const b=window.drawingBench,start=performance.now();try{return this._benchSampleStroke(event);}finally{if(b.active){b.processing.push(performance.now()-start);const sample=this.gesture?.session?.pending.at(-1);if(sample)b.samples.set(sample,start);}}};
        d._benchFlush=d.flushStroke;d.flushStroke=function(s){const samples=s.pending.slice(0,512),seq=s.seq,result=this._benchFlush(s),b=window.drawingBench;if(b.active&&s.seq!==seq)b.batches.set(s.id+':'+s.seq,samples.map(p=>b.samples.get(p)).filter(n=>n!=null));return result;};
        d._benchReply=d.strokeMessage;d.strokeMessage=function(data){const s=this.sessions.get(data.stroke),b=window.drawingBench,key=data.stroke+':'+data.seq,times=b.batches.get(key),result=this._benchReply(data);if(data.kind==='tiles'&&times&&s){b.batches.delete(key);for(const start of times)b.pending.push({start,surface:s.surface,stamp:s.surface.stamp});}return result;};
      }
      const renderer=styk.state.renderer;
      for(const name of ['render','renderPrepared'])if(renderer[name]&&!renderer['_bench'+name]){renderer['_bench'+name]=renderer[name];renderer[name]=function(...args){const b=window.drawingBench,start=performance.now(),value=this['_bench'+name](...args),end=performance.now();if(b.active&&value!==false){b.renders.push(end-start);b.pending=b.pending.filter(p=>{if(p.surface.stamp<p.stamp)return true;b.latency.push(end-p.start);return false;});if(styk.state.playing)b.playing.push({at:end,tick:styk.state.playbackPacket?.tick??styk.editor.tick});}return value;};}
    },count);
    const rect=await page.locator('#viewport').boundingBox();
    await page.evaluate(()=>{drawingBench.active=true;drawingBench.start=performance.now();});
    for(let pass=0;pass<3;pass++){
      await page.mouse.move(rect.x+rect.width*.3,rect.y+rect.height*.4+pass*20);await page.mouse.down();await page.waitForFunction(()=>Boolean(styk.drawing.gesture));
      await page.mouse.move(rect.x+rect.width*.7,rect.y+rect.height*.6+pass*20,{steps:80});await page.mouse.up();
    }
    const drawing=await page.evaluate(async()=>{await styk.drawing.barrier();await new Promise(requestAnimationFrame);drawingBench.active=false;
      const quantiles=a=>{a=[...a].sort((x,y)=>x-y);return {samples:a.length,p50:a[Math.floor((a.length-1)*.5)]??null,p95:a[Math.floor((a.length-1)*.95)]??null,max:a.at(-1)??null};};
      const b=drawingBench;return {processingMs:quantiles(b.processing),pointerSampleToRenderSubmitMs:quantiles(b.latency),renderMs:quantiles(b.renders),longTasks:b.longTasks.filter(e=>e.at>=b.start),memory:styk.drawing.owner.stats,historyBytes:styk.editor.historySize,gpuBytes:styk.state.renderer.stats.gpuBytes,backend:styk.state.renderer.stats.backend};});
    await page.evaluate(()=>{drawingBench.playing=[];drawingBench.active=true;});
    await page.locator('#play-button').click();await page.waitForFunction(()=>styk.state.playing);await page.waitForTimeout(2400);await page.locator('#play-button').click();
    const playback=await page.evaluate(()=>{drawingBench.active=false;const frames=drawingBench.playing.filter((f,i,a)=>!i||a[i-1].tick!==f.tick),intervals=frames.slice(1).map((f,i)=>f.at-frames[i].at).sort((a,b)=>a-b);return {uniquePresented:frames.length,intervalP50:intervals[Math.floor(intervals.length*.5)],intervalP95:intervals[Math.floor(intervals.length*.95)],maxInterval:intervals.at(-1),telemetry:styk.performance().presentation};});
    results.scenarios.push({figures:count,segments:count*10,drawingLayers:count===1?1:3,drawing,playback});console.log('Measured drawing with',count,'figures');
    await page.evaluate(()=>drawingBench.observer.disconnect());
  }
  results.sustained=await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,{DrawingStroke}=await import('/src/drawing-pixels.mjs'),{DocumentExporter}=await import('/src/document-export.mjs');
    const exporter=new DocumentExporter(),cycles=[],flips=[],barriers=[],forcedTileBudget=6*1024*1024;d.owner.tileBudget=forcedTileBudget;e.seek(0);
    for(let i=0;i<24;i++){
      e.nextDrawing(undefined,{blank:false,length:2});const target=e.drawingTarget(),start=performance.now(),surface=await d.owner.surface(target.figure);flips.push(performance.now()-start);
      const stroke=new DrawingStroke(surface.store,{size:20,erase:i%3===0});stroke.sample({x:80+i*10,y:160});stroke.sample({x:200+i*10,y:180});e.commitDrawingPixels(target,stroke.finish());e.undo();e.redo();
      if(i%4===3){const before=performance.now(),blob=await exporter.export(e.report,{format:'styk',getRevision:()=>e.revision});barriers.push(performance.now()-before);cycles.push({cycle:i+1,...d.owner.stats,historyBytes:e.historySize,savedBytes:blob.size});}
    }
    const owner=d.owner;await d.barrier();e.load((await import('/src/demo.mjs')).emptyDocument());return {cycles,flipMs:flips,saveMs:barriers,afterReplacement:owner.stats,disposed:owner.disposed,forcedTileBudget};
  });
  results.fullFrame=await page.evaluate(async()=>{
    const {DrawingResources}=await import('/src/drawing-resources.mjs'),{pixelChangeBytes}=await import('/src/drawing-pixels.mjs');const owner=new DrawingResources({figure_types:[]}),width=3968,height=2288,pixels=new Uint8ClampedArray(width*height*4);
    // Dense, opaque full-frame paint: all pixels carry varied RGB, unlike the line-art fixture.
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([x%256,y%256,(x+y)%256,255],(y*width+x)*4);
    const {TileStore,tileKey}=await import('/src/drawing-tiles.mjs'),{applyTileChanges}=await import('/src/drawing-pixels.mjs'),store=new TileStore();store.writeRect(0,0,width,height,pixels);
    const tiles=[...store].map(t=>({tx:t.tx,ty:t.ty,pixels:t.pixels.slice().buffer}));
    try{const begin=performance.now(),fill=await owner.worker.request('fill',{bounds:{x:0,y:0,width,height},tiles,options:{x:1,y:1,tolerance:255,color:[30,70,180,255],expansion:1,gap:1}},{transfer:tiles.map(t=>t.pixels)}),fillMs=performance.now()-begin;
      applyTileChanges(store,fill.tiles,'after');const encodingTiles=[...store].map(t=>({tx:t.tx,ty:t.ty,pixels:t.pixels.slice().buffer}));
      const encoded=performance.now(),result=await owner.worker.request('encode-tiles',{celId:'full-frame-benchmark',keep:encodingTiles.map(t=>tileKey(t.tx,t.ty)),tiles:encodingTiles},{transfer:encodingTiles.map(t=>t.pixels)});return {width,height,fillMs,historyBytes:pixelChangeBytes(fill.tiles),tiles:fill.tiles.length,encodeMs:performance.now()-encoded,tileBlobCharacters:result.blobUrl.length};
    }finally{owner.dispose();}
  });
  results.errors=errors;results.environment={cpu:os.cpus()[0]?.model,node:process.version,chrome:await browser.version(),headless:true,viewport:{width:1440,height:1000},date:new Date().toISOString()};
  const output=process.env.STYK_DRAWING_ARTIFACTS||'artifacts/drawing';await mkdir(output,{recursive:true});await writeFile(output+'/workflow-performance.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
