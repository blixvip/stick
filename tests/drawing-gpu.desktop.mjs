// Desktop (Electron) check of GPU drawing: the packaged runtime's Chromium
// must provide GPU residency and the GPU brush, commit strokes without the
// worker fallback, and present live ink within a frame or two of input.
import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.'),out=path.join(root,'artifacts/drawing-gpu'),profile=path.join(out,`desktop-profile-${Date.now()}`),checks=[];
await mkdir(profile,{recursive:true});
await writeFile(path.join(profile,'telemetry-state.json'),JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
const env={...process.env,STYK_USER_DATA_DIR:profile,STYK_LIBRARY_DIR:path.join(profile,'library')};delete env.ELECTRON_RUN_AS_NODE;
const check=(name,value,detail)=>{assert.ok(value,`${name}${detail?` ${JSON.stringify(detail)}`:''}`);checks.push(name);console.log('PASS',name);};
const app=await electron.launch({args:[root],cwd:root,env,timeout:45000});
let result;
try{
  const page=await app.firstWindow();await page.waitForFunction(()=>window.styk?.ready,undefined,{timeout:30000});
  await page.setViewportSize?.({width:1440,height:1000}).catch(()=>{});
  // A fresh profile may open a first-run dialog over the workspace tabs.
  await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();document.querySelector('[data-workspace-mode="draw"]').click();});
  await page.waitForFunction(()=>styk.drawing.active,undefined,{timeout:10000});
  await page.evaluate(()=>styk.state.renderer.gpuDrawingReady);
  const runtime=await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),e=styk.editor,d=styk.drawing,report=emptyDocument();report.canvas_width=1920;report.canvas_height=1080;
    e.load(report);d.bind();e.createDrawingLayer();styk.state.settings.autosaveSeconds=0;styk.fit();
    Object.assign(d.settings,{size:24,resolution:2,stabilization:0,opacity:1,flow:1,hardness:1,pressureSize:false,texture:0,color:'#ff00ff'});
    const r=styk.state.renderer;return{backend:r.stats.backend,adapter:r.stats.adapter,gpu:Boolean(r.drawingGpu),electron:navigator.userAgent.match(/Electron\/[\d.]+/)?.[0],chrome:navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]};
  });
  console.log(JSON.stringify(runtime));
  check('the desktop renderer is WebGPU with GPU drawing residency',/webgpu/i.test(runtime.backend)&&runtime.gpu,runtime);
  const box=await page.locator('#viewport').boundingBox();
  // Probe the stroke region after each render, as tests/drawing-latency.browser.mjs does.
  const region={left:box.x+150,top:box.y+100,width:Math.min(900,box.width-300),height:Math.min(500,box.height-200)};
  await page.evaluate(({region})=>{
    const scene=document.querySelector('#scene'),probe=new OffscreenCanvas(1,1),ctx=probe.getContext('2d',{willReadFrequently:true}),renderer=styk.state.renderer,render=renderer.render;
    const bench=window.desktopBench={samples:[],pending:[],running:true,frames:[]};
    addEventListener('pointermove',event=>{if(!bench.running||!(event.buttons&1))return;for(const s of event.getCoalescedEvents?.().length?event.getCoalescedEvents():[event]){const sample={x:s.clientX,y:s.clientY,time:s.timeStamp,latency:null};bench.samples.push(sample);bench.pending.push(sample);}},{capture:true});
    const tick=t=>{if(!bench.running)return;if(bench.last)bench.frames.push(t-bench.last);bench.last=t;requestAnimationFrame(tick);};requestAnimationFrame(tick);
    renderer.render=function(...args){const value=render.apply(this,args);if(!bench.running||!bench.pending.length)return value;
      const now=performance.now(),r=scene.getBoundingClientRect(),sx=scene.width/r.width,sy=scene.height/r.height,x0=Math.max(0,Math.floor((region.left-r.left)*sx)),y0=Math.max(0,Math.floor((region.top-r.top)*sy)),w=Math.min(scene.width-x0,Math.ceil(region.width*sx)),h=Math.min(scene.height-y0,Math.ceil(region.height*sy));
      if(probe.width!==w||probe.height!==h){probe.width=w;probe.height=h;}ctx.clearRect(0,0,w,h);ctx.drawImage(scene,x0,y0,w,h,0,0,w,h);const bytes=ctx.getImageData(0,0,w,h).data;
      const magenta=(x,y)=>{if(x<0||y<0||x>=w||y>=h)return false;const i=(y*w+x)*4;return bytes[i]>150&&bytes[i+2]>150&&bytes[i+1]<.6*Math.min(bytes[i],bytes[i+2]);};
      for(const s of bench.pending){const x=Math.round((s.x-r.left)*sx)-x0,y=Math.round((s.y-r.top)*sy)-y0;if(magenta(x,y)||magenta(x+1,y)||magenta(x,y+1))s.latency=now-s.time;}
      bench.pending=bench.pending.filter(s=>s.latency===null&&now-s.time<5000);return value;};
  },{region});
  // A short warm-up stroke, undone, so the measurement reflects steady state.
  await page.mouse.move(box.x+box.width-200,box.y+box.height-150);await page.mouse.down();for(let i=1;i<=15;i++)await page.mouse.move(box.x+box.width-200+i*4,box.y+box.height-150+i);await page.mouse.up();
  await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation,null,{timeout:30000});await page.evaluate(()=>styk.drawing.history('undo'));await page.waitForTimeout(400);
  await page.evaluate(()=>{const b=window.desktopBench;b.samples.length=0;b.pending.length=0;b.frames.length=0;});
  // The zigzag stays inside the probed region whatever the window size.
  const cdp=await page.context().newCDPSession(page),left=region.left+30,top=region.top+30,width=region.width-60,rowHeight=(region.height-60)/6,duration=2500;
  const point=t=>{const rows=6,cycle=t/duration*rows,row=Math.min(rows-1,Math.floor(cycle)),u=cycle-row;return{x:left+(row%2?1-u:u)*width,y:top+(row+u)*rowHeight*5/6};};
  const send=(type,p,buttons)=>cdp.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',buttons,clickCount:type==='mouseMoved'?0:1}).catch(()=>{});
  await send('mouseMoved',point(0),0);await send('mousePressed',point(0),1);const start=Date.now();
  for(let next=0;next<duration;next+=1000/240){const wait=start+next-Date.now();if(wait>1)await new Promise(r=>setTimeout(r,wait));send('mouseMoved',point(Math.min(duration,Date.now()-start)),1);}
  await new Promise(r=>setTimeout(r,200));await send('mouseReleased',point(duration),0);
  await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation,null,{timeout:30000});
  result=await page.evaluate(()=>{const b=window.desktopBench;b.running=false;const l=b.samples.map(s=>s.latency).filter(v=>v!==null).sort((a,c)=>a-c),f=b.frames.sort((a,c)=>a-c),q=(a,p)=>a[Math.min(a.length-1,Math.floor(p*a.length))];
    const t0=b.samples[0]?.time??0;return{timeline:b.samples.filter((s,i)=>i%15===0).map(s=>[Math.round(s.time-t0),s.latency===null?null:Math.round(s.latency)]),samples:b.samples.length,visible:l.length/Math.max(1,b.samples.length),p50:q(l,.5),p95:q(l,.95),p99:q(l,.99),frameP50:q(f,.5),frameP95:q(f,.95),undo:styk.editor.undoLabel,gpuDispatches:styk.state.renderer.stats.drawingGpu?.strokeDispatches,fallbacks:styk.drawing.strokeStats.gpuFallbacks??0};});
  console.log(JSON.stringify(result));
  check('a desktop GPU stroke commits as one brush command without the worker fallback',result.undo==='Brush stroke'&&result.gpuDispatches>0&&result.fallbacks===0,result);
  check('desktop live ink appears within two frames of input for most samples',result.visible>.98&&result.p95<=2.5*result.frameP50+4,result);
  await page.screenshot({path:path.join(out,'desktop-workspace.png')});
  await writeFile(path.join(out,'desktop-result.json'),JSON.stringify({checks,runtime,result,date:new Date().toISOString(),method:'Electron window from the repository root with an isolated profile; mouse input at 240 Hz through the DevTools Input domain for 2.5 s; stroke-region read-back after each render. Excludes scanout and physical pen latency.'},null,2));
}catch(error){console.error(error);process.exitCode=1;}finally{
  // The edited document would ask to be saved on close; end the process instead.
  await Promise.race([app.close(),new Promise(resolve=>setTimeout(resolve,5000))]).catch(()=>{});
  // Kill the whole Electron tree; the Playwright connection would otherwise
  // keep this script alive.
  const pid=app.process().pid;if(pid){try{(await import('node:child_process')).execFileSync('taskkill',['/pid',String(pid),'/t','/f'],{stdio:'ignore'});}catch{}}
  process.exit(process.exitCode??0);
}
