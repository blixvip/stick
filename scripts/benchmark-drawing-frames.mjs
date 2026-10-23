import {chromium,_electron} from '../tests/support/playwright.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
const output=process.env.STYK_DOTS_ARTIFACTS||'artifacts/drawing-frame-latency/baseline',packaged=process.env.STYK_DOTS_PACKAGED==='1';await mkdir(output,{recursive:true});
const electron=process.env.STYK_DOTS_ELECTRON==='1';
let browser,page;
if(electron){
  const main=resolve(output,'electron-main.cjs');
  await writeFile(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(resolve(output,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});w.webContents.setFrameRate(60);w.loadURL(${JSON.stringify(process.env.STYK_URL||'http://127.0.0.1:47839')});});`);
  browser=await _electron.launch({args:[main]});page=await browser.firstWindow();
}else{browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});}
const errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  // Keep HTTP-cache policy identical when serving a comparison revision.
  await page.route('**/*',route=>route.continue());
  if(process.env.STYK_DOTS_BASELINE)for(const file of ['app.mjs','drawing-controller.mjs','renderer-geometry.mjs','renderer.mjs','renderer-raster-cache.mjs','drawing-resources.mjs','drawing-tiles.mjs']){
    const body=execFileSync('git',['show',`${process.env.STYK_DOTS_BASELINE}:src/${file}`],{encoding:'utf8',maxBuffer:4*1024*1024});
    await page.route(`**/src/${file}`,route=>route.fulfill({body,contentType:'text/javascript'}));
  }
  if(packaged){
    if(!process.env.STYK_DOTS_WEB_ROOT)throw new Error('Set STYK_DOTS_WEB_ROOT to the packaged resources/web directory.');
    const root=resolve(process.env.STYK_DOTS_WEB_ROOT);
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),path=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),file=resolve(root,path);
      if(!file.startsWith(root+sep)||url.origin!==(process.env.STYK_URL||'http://127.0.0.1:47839'))return route.continue();
      try{const body=await readFile(file);return route.fulfill({body,contentType:extname(file)==='.mjs'?'text/javascript':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':undefined});}catch{return route.continue();}
    });
  }
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');styk.editor.load(emptyDocument());styk.editor.createDrawingLayer();styk.state.settings.autosaveSeconds=0;Object.assign(styk.drawing.settings,{size:8,resolution:2,stabilization:0,color:'#203ed8'});});
  const box=await page.locator('#viewport').boundingBox(),start={x:box.x+140,y:box.y+170};
  const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');
  async function measure(count,stroke,idle=false){
    if(stroke){await page.mouse.move(start.x,start.y+160);await page.mouse.down();await page.waitForFunction(()=>styk.drawing.gesture?.session);}
    await cdp.send('Profiler.start');
    const measured=await page.evaluate(async({start,count,stroke,idle})=>{
      const d=styk.drawing,r=styk.state.renderer,render=r.render,overlay=d.overlayDraw,renderTimes=[],overlayTimes=[],intervals=[],latencies=[];
      let last=performance.now(),moves=0;const at=last;
      r.render=function(...args){const t=performance.now();try{return render.apply(this,args);}finally{renderTimes.push(performance.now()-t);}};
      d.overlayDraw=function(...args){const t=performance.now();try{return overlay.apply(this,args);}finally{overlayTimes.push(performance.now()-t);if(moves&&d.cursor)latencies.push(t-d.cursor.timeStamp);}};
      const timer=setInterval(()=>{const now=performance.now();intervals.push(now-last);last=now;const t=(now-at)/4000;if(idle)return;
        d.move({pointerId:d.gesture?.id??1234,pointerType:'mouse',pressure:.5,clientX:start.x+Math.min(700,t*700),clientY:start.y+(stroke?160:80)+Math.sin(t*30)*40,timeStamp:now});moves++;},8);
      try{await new Promise(resolve=>setTimeout(resolve,4000));}finally{clearInterval(timer);r.render=render;d.overlayDraw=overlay;}
      const summary=values=>{values.sort((a,b)=>a-b);return{count:values.length,p50:values[Math.floor(values.length*.5)]??0,p95:values[Math.floor(values.length*.95)]??0,max:values.at(-1)??0};};
      return{count,stroke,idle,moves,render:summary(renderTimes),overlay:summary(overlayTimes),eventLoop:summary(intervals),cursor:summary(latencies),backend:r.stats.backend,onion:styk.state.onion,owner:d.owner.stats,pending:d.gesture?.session?.pending.length,workerTrip:d.strokeStats.lastRoundTripMs,heap:performance.memory?.usedJSHeapSize};
    },{start,count,stroke,idle});
    const {profile}=await cdp.send('Profiler.stop');
    const nodes=new Map(profile.nodes.map(n=>[n.id,n])),samples=new Map();for(let i=0;i<(profile.samples?.length??0);i++){const id=profile.samples[i];samples.set(id,(samples.get(id)??0)+(profile.timeDeltas[i]??0));}
    measured.hotspots=[...samples].map(([id,microseconds])=>({ms:microseconds/1000,...nodes.get(id)?.callFrame})).sort((a,b)=>b.ms-a.ms).slice(0,20);
    results.push(measured);await writeFile(output+`/profile-${count}-${idle?'idle':stroke?'stroke':'hover'}.json`,JSON.stringify(profile));console.log(JSON.stringify(measured));
    if(stroke){await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.operation);}
  }
  for(let i=0;i<50;i++){
    if(i)await page.evaluate(()=>styk.editor.nextDrawing([styk.editor.activeLayerId],{blank:true}));
    await page.mouse.click(start.x+i*8,start.y+Math.sin(i/5)*40);await page.waitForFunction(()=>!styk.drawing.gesture&&!styk.drawing.loading&&!styk.drawing.operation);
    if(i===0)await measure(1,false);
  }
  if(process.env.STYK_DOTS_DENSE)await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,target=e.prepareDrawingCel({pixelsPerUnit:2,world:{x:0,y:0}}),changes=[];
    // A patterned 8.4 MP raster in the current cel, after the same fifty-dot
    // animation setup. Fixture construction is outside the timed interaction.
    for(let ty=-16;ty<18;ty++)for(let tx=-30;tx<30;tx++){
      const after=new Uint8ClampedArray(64*64*4);for(let p=0;p<4096;p++)after.set([150+(p+tx+30)%80,180+(p+ty+16)%50,130+(p+tx+ty+46)%90,255],p*4);
      changes.push({tx,ty,before:null,after});
    }
    e.commitDrawingPixels(target,changes);await d.barrier();
    await new Promise(resolve=>setTimeout(resolve,1000));
  });
  await measure(50,false);await measure(50,true);await page.mouse.move(2,2);await page.evaluate(()=>styk.drawing.barrier());await measure(50,false,true);await page.screenshot({path:output+'/fifty-frames.png'});
  await writeFile(output+'/result.json',JSON.stringify({packaged,electron,dense:Boolean(process.env.STYK_DOTS_DENSE),baseline:process.env.STYK_DOTS_BASELINE||null,browser:electron?await browser.evaluate(()=>process.versions.electron):browser.version(),errors,results},null,2));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({message:error.message,errors,results},null,2));await page.screenshot({path:output+'/failure.png'});throw error;}
finally{if(electron)await browser.evaluate(({app})=>app.exit(0)).catch(()=>{});else await browser.close();}
