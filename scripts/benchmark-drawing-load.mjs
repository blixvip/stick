import {chromium} from '../tests/support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Heavy drawing load: many dense high-resolution cels well beyond the resident
// tile budget, then scrubbing, playback, painting on top and saving. Reports
// frame pacing, stroke latency, memory bounds and correctness at each stage.
const url=process.env.STYK_URL||'http://127.0.0.1:47839',cels=Number(process.env.CELS||24),resolution=Number(process.env.RESOLUTION||4);
const output=path.resolve(process.env.STYK_LOAD_ARTIFACTS||'artifacts/drawing-load');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.stack));
page.on('console',m=>{if(m.text().startsWith('LOAD'))console.log(m.text());});
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s.length?+s[Math.floor((s.length-1)*p)].toFixed(1):null;};
const summary=a=>({n:a.length,p50:q(a,.5),p95:q(a,.95),max:q(a,1)});
try{
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{styk.state.settings.autosaveSeconds=0;window.__lt=[];new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(e.duration);}).observe({entryTypes:['longtask']});});
  await page.locator('[data-workspace-mode="draw"]').click();await page.locator('[data-draw-action="new"]').first().click();
  // Generate cels with the real stroke engine: dense soft scribbles over the stage.
  const generation=await page.evaluate(async({cels,resolution})=>{
    const {DrawingStroke}=await import('/src/drawing-pixels.mjs'),e=styk.editor,d=styk.drawing,id=e.activeLayerId,start=performance.now();
    d.settings.resolution=resolution;
    for(let c=0;c<cels;c++){
      if(c)e.nextDrawing([id],{blank:true,length:1});
      const r=e.report,target=e.prepareDrawingCel({pixelsPerUnit:resolution,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);
      const s=new DrawingStroke(surface.store,{size:90*resolution,hardness:.2,flow:.5,color:[40+c*8%200,90,160],pressureSize:false,seed:c});
      for(let i=0;i<160;i++){const t=i/160;s.sample({x:(r.canvas_width*(.05+.9*t))*resolution,y:(r.canvas_height*(.5+.42*Math.sin(t*Math.PI*6+c)))*resolution});}
      for(let i=0;i<120;i++){const t=i/120;s.sample({x:(r.canvas_width*(.5+.45*Math.cos(t*Math.PI*2+c)))*resolution,y:(r.canvas_height*(.5+.45*Math.sin(t*Math.PI*2)))*resolution});}
      e.commitDrawingPixels(target,s.finish(),'Load stroke');
      if(c%6===5)console.log(`LOAD generated ${c+1}/${cels} cels`);
    }
    await d.barrier();
    const stats=d.owner.stats;return {ms:Math.round(performance.now()-start),stats:{tiles:stats.tiles,residentMB:+(stats.bytes/2**20).toFixed(1),entries:stats.entries,unpublished:stats.unpublished}};
  },{cels,resolution});
  console.log('LOAD generation',JSON.stringify(generation));
  // Scrub every cel: time until its pixels are resident and presented.
  const scrub=await page.evaluate(async cels=>{
    const e=styk.editor,d=styk.drawing,times=[],misses=[],coldWait=[],warmPresent=[];window.__lt.length=0;
    for(let pass=0;pass<2;pass++)for(let tick=0;tick<cels;tick++){
      const start=performance.now();e.seek(tick);const t=e.drawingTarget(),cold=!d.owner.entry(t.figure).store;
      const entry=await d.owner.surface(t.figure);if(!entry.store?.size)misses.push(tick);const ready=performance.now();
      await new Promise(r=>requestAnimationFrame(()=>r()));times.push(performance.now()-start);(cold?coldWait:warmPresent).push(cold?ready-start:performance.now()-ready);
    }
    const stats=d.owner.stats;const med=a=>a.length?+[...a].sort((x,y)=>x-y)[a.length>>1].toFixed(1):null;return {ms:times,cold:coldWait.length,coldWaitP50:med(coldWait),warmPresentP50:med(warmPresent),misses,longTasks:window.__lt.length,longMax:Math.max(0,...window.__lt),residentMB:+(stats.bytes/2**20).toFixed(1),budgetMB:d.owner.tileBudget/2**20,hardMB:d.owner.hardBudget/2**20};
  },cels);
  console.log('LOAD scrub',JSON.stringify({...summary(scrub.ms),cold:scrub.cold,coldWaitP50:scrub.coldWaitP50,warmPresentP50:scrub.warmPresentP50,misses:scrub.misses.length,longTasks:scrub.longTasks,residentMB:scrub.residentMB}));
  // Playback frame pacing across all cels.
  const playback=await page.evaluate(async()=>{
    const frames=[];let last=performance.now(),run=true;const loop=t=>{frames.push(t-last);last=t;if(run)requestAnimationFrame(loop);};requestAnimationFrame(loop);
    styk.editor.seek(0);window.__lt.length=0;document.querySelector('[data-action="play"],#play,button[aria-label*="Play" i]')?.click();
    await new Promise(r=>setTimeout(r,4000));run=false;document.querySelector('[data-action="play"],#play,button[aria-label*="Pause" i]')?.click();
    return {frames:frames.slice(3),longTasks:window.__lt.length};
  });
  console.log('LOAD playback',JSON.stringify({...summary(playback.frames),longTasks:playback.longTasks}));
  await page.keyboard.press('Escape');await page.evaluate(()=>{if(styk.state.playing)styk.editor.seek?.(0);});
  // Paint a heavy stroke on a dense cel while measuring frames and latency.
  await page.evaluate(()=>{styk.editor.seek(3);Object.assign(styk.drawing.settings,{size:120,hardness:.3,flow:.6,opacity:1});});
  await page.locator('[data-tool="drawing-brush"]').click();
  await page.evaluate(()=>{const d=styk.drawing;window.__lat=[];window.__frames=[];window.__lt.length=0;
    const ss=d.sampleStroke.bind(d);d.sampleStroke=e=>{const s=d.gesture?.session;if(s&&e.timeStamp)(s._times??=[]).push(e.timeStamp);return ss(e);};
    const fl=d.flushStroke.bind(d);d.flushStroke=(s,force)=>{const seq=s.seq,r=fl(s,force);if(s.seq!==seq&&s._times?.length){(s._batches??=new Map()).set(s.seq,s._times);s._times=[];}return r;};
    const sm=d.strokeMessage.bind(d);d.strokeMessage=data=>{const s=d.sessions.get(data.stroke),times=s?._batches?.get(data.seq),r=sm(data);if(times&&data.kind==='tiles')requestAnimationFrame(()=>{const now=performance.now();for(const x of times)window.__lat.push(now-x);});return r;};
    let last=performance.now();window.__run=true;const loop=t=>{window.__frames.push(t-last);last=t;if(window.__run)requestAnimationFrame(loop);};requestAnimationFrame(loop);});
  const box=await page.locator('#viewport').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height/2;
  await page.mouse.move(cx-500,cy);await page.mouse.down();
  for(let i=0;i<360;i++){const t=i/360*Math.PI*8;await page.mouse.move(cx+Math.cos(t)*500*Math.sin(i/200),cy+Math.sin(t*1.3)*300);}
  const upAt=await page.evaluate(()=>performance.now());await page.mouse.up();
  await page.waitForFunction(()=>!styk.drawing.gesture,null,{timeout:60000});
  const paint=await page.evaluate(upAt=>{window.__run=false;return {frames:window.__frames.slice(2),lat:window.__lat,longTasks:window.__lt.length,longMax:Math.max(0,...window.__lt),commitMs:performance.now()-upAt,undo:styk.editor.undoLabel};},upAt);
  console.log('LOAD paint',JSON.stringify({frames:summary(paint.frames),latency:summary(paint.lat),longTasks:paint.longTasks,longMax:paint.longMax,undo:paint.undo}));
  // Publish everything and serialize the native document.
  const save=await page.evaluate(async()=>{
    const {DocumentExporter}=await import('/src/document-export.mjs'),start=performance.now();await styk.drawing.barrier();const barrierMs=performance.now()-start;
    const blob=await new DocumentExporter().export(styk.editor.report,{format:'styk'});const stats=styk.drawing.owner.stats;
    const mem=performance.memory?{heapMB:+(performance.memory.usedJSHeapSize/2**20).toFixed(0)}:{};
    return {barrierMs:Math.round(barrierMs),saveMs:Math.round(performance.now()-start),bytesMB:+(blob.size/2**20).toFixed(1),unpublished:stats.unpublished,residentMB:+(stats.bytes/2**20).toFixed(1),...mem};
  });
  console.log('LOAD save',JSON.stringify(save));
  const result={cels,resolution,generation,scrub:{...summary(scrub.ms),misses:scrub.misses.length,longTasks:scrub.longTasks,longMax:scrub.longMax,residentMB:scrub.residentMB,budgetMB:scrub.budgetMB,hardMB:scrub.hardMB},playback:{...summary(playback.frames),longTasks:playback.longTasks},paint:{frames:summary(paint.frames),latency:summary(paint.lat),longTasks:paint.longTasks,longMax:paint.longMax,undo:paint.undo},save,errors,
    environment:{cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,platform:process.platform,chrome:browser.version(),date:new Date().toISOString()}};
  await writeFile(path.join(output,'load.json'),JSON.stringify(result,null,2));
  if(errors.length)throw new Error('Browser errors during the load benchmark:\n'+errors.join('\n'));
}finally{await browser.close();}
