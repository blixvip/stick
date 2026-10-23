/** Actual source app playback/interaction probe. Never writes the input file. */
import {chromium,_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const source=process.argv[2];if(!source)throw new Error('Provide a PIV project.');
const label=process.env.STYK_PROBE_LABEL||'current',fps=Number(process.env.STYK_PROBE_FPS||120);
const output=path.resolve('artifacts/playback-interactions',label);await mkdir(output,{recursive:true});
const desktop=process.env.STYK_PROBE_DESKTOP==='1';
const host=desktop?await electron.launch({args:[process.cwd()],cwd:process.cwd(),env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}}):await chromium.launch({channel:'chrome',headless:true});
const page=desktop?await host.firstWindow():await host.newPage({viewport:{width:1600,height:1000}});
if(desktop)await host.evaluate(({BrowserWindow})=>{
  const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);
  w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive();
});
if(process.env.STYK_PROBE_MEMORY_GIB)await page.addInitScript(value=>Object.defineProperty(navigator,'deviceMemory',{get:()=>value}),Number(process.env.STYK_PROBE_MEMORY_GIB));
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  if(process.env.STYK_BASELINE_CLIENT){
    const ref=process.env.STYK_BASELINE_CLIENT,files=new Map();
    if(desktop)await page.waitForFunction(()=>window.styk?.ready);
    await page.context().route(url=>url.pathname==='/'||url.pathname==='/index.html'||url.pathname.startsWith('/src/'),async route=>{
      const pathname=new URL(route.request().url()).pathname,file=pathname==='/'?'index.html':pathname.slice(1);
      if(!files.has(file))files.set(file,execFileSync('git',['show',`${ref}:${file}`],{maxBuffer:16*1024*1024}));
      await route.fulfill({body:files.get(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/javascript'});
    });
    if(desktop)await page.reload();
  }
  if(process.env.STYK_BASELINE_WORKER)await page.route('**/src/playback-worker.mjs',async route=>route.fulfill({contentType:'text/javascript',body:await readFile(process.env.STYK_BASELINE_WORKER,'utf8')}));
  if(!desktop)await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  console.log('IMPORTED');
  const playbackProfiler=process.env.STYK_PROBE_PROFILE==='1'?await page.context().newCDPSession(page):null;
  if(playbackProfiler){await playbackProfiler.send('Profiler.enable');await playbackProfiler.send('Profiler.start');}
  if(process.env.STYK_PROBE_GPU_CACHE_MIB)await page.evaluate(bytes=>{const cache=styk.state.renderer.preparedFrames;if(!cache)throw new Error('GPU cache override requires WebGPU.');cache.maxBytes=bytes;cache.stats.maxBytes=bytes;},Number(process.env.STYK_PROBE_GPU_CACHE_MIB)*1024*1024);
  await page.evaluate(async fps=>{
    const {PlaybackCache}=await import('/src/playback.mjs'),s=styk.state,e=styk.editor;
    e.setFPS(fps);e.markSaved();s.loop=false;e.seek(0);styk.fit();
    window.probe={packets:[],presented:[],renders:[],uploads:[],longTasks:[]};
    const receive=PlaybackCache.prototype._receive;
    PlaybackCache.prototype._receive=function(m){if(m.type==='packet'&&m.revision===this.revision){const p=m.packet;probe.packets.push({tick:p.tick,ms:p.compileMs,bytes:p.byteLength,quality:p.previewQuality,rasters:p.compatibility.length,groups:p.groups.length,timings:p.timings,cache:p.workerCache,sharing:p.sharing});}return receive.call(this,m);};
    const r=s.renderer,render=r.renderPrepared.bind(r);r.renderPrepared=(...args)=>{const start=performance.now(),result=render(...args);if(result&&s.playing&&probe.presented.at(-1)?.tick!==e.tick)probe.presented.push({tick:e.tick,at:performance.now(),ms:performance.now()-start});return result;};
    const prepare=r.prepareFrame.bind(r);r.prepareFrame=(packet,...args)=>{const at=performance.now();try{return prepare(packet,...args);}finally{probe.uploads.push({tick:packet.tick,at,ms:performance.now()-at});}};
    const edit=r.render.bind(r);r.render=options=>{const start=performance.now(),result=edit(options);probe.renders.push({at:performance.now(),ms:performance.now()-start,kind:s.drag?.kind,preparation:r.stats.preparation,rasterized:r.stats.rasterizedObjects});return result;};
    new PerformanceObserver(list=>{for(const e of list.getEntries())probe.longTasks.push({at:e.startTime,ms:e.duration});}).observe({entryTypes:['longtask']});
    styk.actions.play();
  },fps);
  const deadline=Date.now()+Number(process.env.STYK_PROBE_SECONDS||180)*1000;
  let nextLog=0,complete=false;
  while(Date.now()<deadline){
    await page.waitForTimeout(500);
    const status=await page.evaluate(()=>({playing:styk.state.playing,tick:styk.editor.tick,total:styk.editor.totalTicks,packet:probe.packets.at(-1),presentation:styk.performance().presentation.fps}));
    if(Date.now()>nextLog){console.log(JSON.stringify(status));nextLog=Date.now()+10000;}
    if(!status.playing){complete=status.tick===status.total-1;break;}
  }
  if(!complete)await page.evaluate(()=>{if(styk.state.playing)styk.actions.play();});
  await page.waitForFunction(()=>!styk.state.editablePreparing,null,{timeout:60000});
  const playback=await page.evaluate(()=>({backend:styk.state.renderer.stats.backend,adapter:styk.state.renderer.stats.adapter,hardware:{deviceMemory:navigator.deviceMemory,cores:navigator.hardwareConcurrency,userAgent:navigator.userAgent},performance:styk.performance(),...probe}));
  if(playbackProfiler){const {profile}=await playbackProfiler.send('Profiler.stop');await writeFile(path.join(output,'playback.cpuprofile'),JSON.stringify(profile));}
  await writeFile(path.join(output,'playback.json'),JSON.stringify({source,fps,complete,...playback,errors},null,2));
  const totalTicks=await page.evaluate(()=>styk.editor.totalTicks);
  if(!complete||playback.presented.length!==totalTicks||playback.presented.some((p,i)=>p.tick!==i))throw new Error('Playback ended before every sequential tick was presented.');
  console.log(JSON.stringify({complete,frames:playback.presented.length,slowest:playback.packets.slice().sort((a,b)=>b.ms-a.ms).slice(0,8),reduced:playback.packets.filter(p=>p.quality?.reduced).length}));
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.seek(styk.editor.totalTicks-1);styk.fit();});
  await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender);
  const client=await page.context().newCDPSession(page);await client.send('Profiler.enable');await client.send('Profiler.start');
  const rect=await page.locator('#overlay').boundingBox();
  await page.mouse.move(rect.x+rect.width*.3,rect.y+rect.height*.3);await page.mouse.down({button:'middle'});
  const panKind=await page.evaluate(()=>styk.state.drag?.kind);
  for(let i=0;i<30;i++)await page.mouse.move(rect.x+rect.width*.3+i*3,rect.y+rect.height*.3+i);
  await page.mouse.up({button:'middle'});
  const target=await page.evaluate(async()=>{
    const e=styk.editor,s=styk.state,{worldToScreen}=await import('/src/renderer.mjs');
    const editable=[...e.geometry.objects.values()].find(g=>g.segments.some(segment=>!segment.static&&segment.length>3));
    if(!editable)throw new Error('The benchmark needs an editable segment in the final frame.');
    e.select(editable.obj.unique_id,0);const g=e.geometry.objects.get(e.selectedSlot),point=g.segments.find(segment=>!segment.static&&segment.length>3).end;
    const screen=worldToScreen(point,{report:e.report,frame:e.evaluatedFrame,view:s.view,cameraEnabled:false}),r=document.querySelector('#overlay').getBoundingClientRect();
    s.view.x+=r.width/2-screen.x;s.view.y+=r.height/2-screen.y;window.dispatchEvent(new Event('resize'));
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  });
  await page.waitForFunction(()=>!styk.state.dirtyRender);await page.mouse.move(target.x,target.y);await page.mouse.down();
  const poseKind=await page.evaluate(()=>styk.state.drag?.kind);
  for(let i=0;i<30;i++)await page.mouse.move(target.x+i*.7,target.y+i*.5);
  await page.mouse.up();
  const {profile}=await client.send('Profiler.stop');await writeFile(path.join(output,'interactions.cpuprofile'),JSON.stringify(profile));
  const timeline=await page.locator('.sheet-scroll').boundingBox();
  await page.mouse.move(timeline.x+24,timeline.y+14);await page.mouse.down();
  for(let i=0;i<20;i++)await page.mouse.move(timeline.x+24+i*14,timeline.y+14);
  const scrubActive=await page.evaluate(()=>styk.state.scrubbing);await page.mouse.up();
  await page.waitForFunction(()=>!styk.state.scrubbing&&!styk.state.editablePreparing);
  const scrubTick=await page.evaluate(()=>styk.editor.tick);
  await page.screenshot({path:path.join(output,'edited.png')});
  await writeFile(path.join(output,'interactions.json'),JSON.stringify({panKind,poseKind,scrubActive,scrubTick,...await page.evaluate(()=>({renders:probe.renders,longTasks:probe.longTasks,performance:styk.performance()})),errors},null,2));
  await page.evaluate(()=>{probe.packets=[];probe.presented=[];const endTick=styk.editor.totalTicks-1,startTick=Math.max(0,endTick-150);styk.state.loopRange={startTick,endTick};styk.editor.seek(startTick);styk.actions.play();});
  await page.waitForFunction(()=>!styk.state.playing,null,{timeout:60000});
  await writeFile(path.join(output,'replay.json'),JSON.stringify(await page.evaluate(()=>({packets:probe.packets,presented:probe.presented,performance:styk.performance()})),null,2));
  console.log(JSON.stringify({panKind,poseKind,scrubActive,scrubTick,replayFrames:await page.evaluate(()=>probe.presented.length),errors}));
}finally{
  await page.evaluate(()=>{styk.editor.markSaved();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();}).catch(()=>{});
  if(desktop)await host.evaluate(({app})=>app.exit(0)).catch(()=>{});
  else await host.close();
}
