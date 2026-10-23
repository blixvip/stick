/** Full-project desktop playback diagnostic. Reads but never saves the input. */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {startWorkerProfiles,summarizeProfiles} from './worker-profile-support.mjs';

if(!process.argv[2])throw new Error('Provide a project path and optional artifact label.');
const source=path.resolve(process.argv[2]),label=process.argv[3]||String(Date.now());
const root=process.cwd(),output=path.resolve('artifacts/project-playback',label),sourceRoot=path.resolve(process.env.STYK_BASELINE_SOURCES||'src');
await mkdir(output,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const result={source:{path:source,sha256:digest(await readFile(source))},measuredAt:new Date().toISOString(),
  environment:{cpu:os.cpus()[0].model,memory:os.totalmem(),node:process.version,dpr:process.env.STYK_PROBE_DPR==='native'?'native':Number(process.env.STYK_PROBE_DPR||1),width:Number(process.env.STYK_PROBE_WIDTH||1600),height:Number(process.env.STYK_PROBE_HEIGHT||1000),memoryHintGiB:Number(process.env.STYK_PROBE_MEMORY_GIB)||null,previewQuality:process.env.STYK_PROBE_QUALITY||'adaptive'},hashes:{},errors:[]};
const captured=new Map();
for(const name of (await readdir(sourceRoot,{recursive:true})).filter(name=>name.endsWith('.mjs'))){
  const bytes=await readFile(path.join(sourceRoot,name));result.hashes[name]=digest(bytes);captured.set(name.replaceAll('\\','/'),bytes);
  const target=path.join(output,'sources',name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
}
console.log('OUTPUT',output);
// STYK_RENDERER=canvas|gpu seeds the disposable profile's Graphics mode setting.
if(process.env.STYK_RENDERER){result.environment.renderer=process.env.STYK_RENDERER;await mkdir(path.join(output,'profile'),{recursive:true});await writeFile(path.join(output,'profile','editor-settings.json'),JSON.stringify({rendererMode:process.env.STYK_RENDERER}));}
const app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[root,...(process.env.STYK_PROBE_WORKER_PROFILE==='1'?['--remote-debugging-port=9339']:[])],cwd:root,timeout:60000,env:{...process.env,STYK_DEBUG:'1',STYK_USER_DATA_DIR:path.join(output,'profile')}});
const child=app.process();result.processId=child.pid;
result.launchLog='';child.stderr.on('data',chunk=>{result.launchLog=(result.launchLog+chunk).slice(-12000);});
try{
  const page=await app.firstWindow({timeout:60000});page.setDefaultTimeout(180000);
  page.on('pageerror',error=>result.errors.push(error.message));
  await page.context().route('**/src/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice('/src/'.length);let body=captured.get(name);
    if(body&&name==='playback-budget.mjs'&&result.environment.memoryHintGiB)body=Buffer.from(body.toString().replace('export function deviceMemoryHint(environment = globalThis) {',`export function deviceMemoryHint(environment = globalThis) { return ${result.environment.memoryHintGiB};`));
    if(body&&name==='playback.mjs'&&process.env.STYK_PROBE_WORKERS){
      const count=Number(process.env.STYK_PROBE_WORKERS);
      if(!Number.isInteger(count)||count<1||count>4)throw new Error('Worker diagnostic count must be between one and four.');
      const code=body.toString(),signature=/\bworkerCount,(?=\s*maxWorkerBytes\b)/;
      if(!signature.test(code))throw new Error('Worker diagnostic override could not be applied.');
      body=Buffer.from(code.replace(signature,`workerCount = ${count},`));
      result.environment.workerCount=count;result.executedPlaybackHash=digest(body);
    }
    if(body&&name==='playback-resources.mjs'&&process.env.STYK_PROBE_CPU_PATHS==='1'){
      const signature='width*height<=512*512',code=body.toString();
      if(!code.includes(signature))throw new Error('CPU raster diagnostic override could not be applied.');
      body=Buffer.from(code.replace(signature,'true'));result.environment.cpuPaths=true;result.executedResourcesHash=digest(body);
    }
    if(body&&name==='app.mjs'&&result.environment.previewQuality==='full'){
      const code=body.toString(),signature='function adaptPreviewQuality(sample, now) {';
      if(!code.includes(signature))throw new Error('Full-quality diagnostic override could not be applied.');
      body=Buffer.from(code.replace(signature,`${signature} return; // Diagnostic: fixed full-quality preview.\n`));
      result.executedAppHash=digest(body);
    }
    if(body)await route.fulfill({status:200,contentType:'text/javascript',body});else await route.continue();
  });
  // STYK_PROBE_FOREGROUND=1 focuses the window on top, as when someone is using the app; Windows
  // schedules an unfocused, occluded window's threads less favourably. The display stays awake
  // for this app instance only, since a sleeping display stops presenting frames.
  result.environment.foreground=process.env.STYK_PROBE_FOREGROUND==='1';
  await app.evaluate(({BrowserWindow,powerSaveBlocker},{width,height,foreground})=>{const w=BrowserWindow.getAllWindows()[0];if(foreground)powerSaveBlocker.start('prevent-display-sleep');w.setContentSize(width,height);w.webContents.setBackgroundThrottling(false);w.setIgnoreMouseEvents(true);if(foreground){w.setAlwaysOnTop(true);w.show();w.focus();}else{w.setFocusable(false);w.showInactive();}},result.environment);
  await page.waitForFunction(()=>window.styk?.ready);
  const client=await page.context().newCDPSession(page);
  // STYK_PROBE_DPR=native keeps the display's own scale factor. Emulating another one
  // adds a scaling composite that the app never pays in real use.
  if(result.environment.dpr!=='native'){
    await client.send('Emulation.setDeviceMetricsOverride',{width:result.environment.width,height:result.environment.height,deviceScaleFactor:result.environment.dpr,mobile:false});
    await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  }
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
  const started=Date.now();await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,path.extname(source)));
  result.importMs=Date.now()-started;
  // First-run prompts can arrive after readiness; exclude backdrop compositing
  // from the animation measurement in this disposable profile.
  await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();});
  result.scene=await page.evaluate(()=>{const e=styk.editor,r=e.report;return {ticks:e.totalTicks,fps:r.fps,delay:r.frame_delay_ms,frames:r.keyframes.length,canvas:[r.canvas_width,r.canvas_height],
    definitions:r.figure_types.map(f=>({id:f.figure_type_id,segments:f.segments.length,types:f.segments.reduce((s,x)=>(s[x.segment_type]=(s[x.segment_type]||0)+1,s),{})})),
    objects:r.keyframes.map(f=>f.objects.length),backend:styk.state.renderer.stats.backend,adapter:styk.state.renderer.stats.adapter};});
  result.stallFrameContents=await page.evaluate(()=>{
    const report=styk.editor.report,figures=new Map(report.figure_types.map(f=>[f.figure_type_id,f]));
    return [31,48,129,162,175,180,202,480,482].filter(tick=>tick<report.keyframes.length).map(tick=>{
      const frame=report.keyframes[tick],types={},definitions=new Map();
      for(const object of frame.objects){
        const f=figures.get(object.figure_type_id);if(!f)continue;
        definitions.set(f.figure_type_id,{id:f.figure_type_id,name:f.name,segments:f.segments.length,instances:(definitions.get(f.figure_type_id)?.instances||0)+1});
        for(const s of f.segments)types[s.segment_type]=(types[s.segment_type]||0)+1;
      }
      return {tick,camera:frame.camera,objects:frame.objects.length,types,definitions:[...definitions.values()],
        instances:frame.objects.map(o=>({uid:o.unique_id,figure:o.figure_type_id}))};
    });
  });
  console.log('SCENE',JSON.stringify({...result.scene,definitions:result.scene.definitions.length,objects:Math.max(...result.scene.objects),importMs:result.importMs}));
  await page.screenshot({path:path.join(output,'import.png')});
  if(process.env.STYK_PROBE_FPS){
    result.targetFps=Number(process.env.STYK_PROBE_FPS);
    await page.evaluate(fps=>{styk.editor.setFPS(fps);styk.editor.markSaved();},result.targetFps);
  }
  // STYK_PROBE_HIDE=<css selector> skips the subtree's style, layout and paint (content-visibility) to measure UI cost during playback.
  if(process.env.STYK_PROBE_HIDE){await page.addStyleTag({content:`${process.env.STYK_PROBE_HIDE}{content-visibility:hidden!important}`});result.environment.hide=process.env.STYK_PROBE_HIDE;}
  if(process.env.STYK_PROBE_TRACE==='1')await client.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordContinuously',traceBufferSizeInKb:131072,
    includedCategories:['gpu','cc','viz','blink.user_timing','renderer.scheduler','devtools.timeline','v8','toplevel','disabled-by-default-gpu.service','disabled-by-default-gpu.device','disabled-by-default-skia','disabled-by-default-v8.gc',...(process.env.STYK_PROBE_TRACE_EXTRA?process.env.STYK_PROBE_TRACE_EXTRA.split(','):[])]}});
  // STYK_PROBE_MAIN_PROFILE=1 records the page's main-thread CPU profile during playback (main-profile.cpuprofile).
  if(process.env.STYK_PROBE_MAIN_PROFILE==='1'){await client.send('Profiler.enable');await client.send('Profiler.setSamplingInterval',{interval:250});await client.send('Profiler.start');}
  // STYK_PROBE_WORKER_PROFILE=1 records every playback worker's CPU profile during playback.
  let workerProfiles=null;if(process.env.STYK_PROBE_WORKER_PROFILE==='1'){workerProfiles=await startWorkerProfiles(9339);result.workerProfileCount=workerProfiles.count;}
  await page.evaluate(async({start,end,quality})=>{
    const {PlaybackCache}=await import('/src/playback.mjs');
    const s=styk.state,e=styk.editor,r=s.renderer;
    window.probe={packets:[],presented:[],uploads:[],longTasks:[],quality:[],raf:[],gpuErrors:[],active:false};
    r.device?.addEventListener('uncapturederror',event=>probe.gpuErrors.push(event.error.message));
    const receive=PlaybackCache.prototype._receive;
    PlaybackCache.prototype._receive=function(...args){const m=args[0];if(probe.active&&m.type==='packet'&&m.revision===this.revision){const p=m.packet;probe.packets.push({tick:p.tick,at:performance.now(),ms:p.compileMs,bytes:p.byteLength,quality:p.previewQuality,resolution:p.resolution,scale:p.scale,rasters:p.compatibility.length,groups:p.groups.length,timings:p.timings,cache:p.workerCache,sharing:p.sharing,clipping:p.clipping,reused:p.reusedGeometryObjects,largestRasters:p.compatibility.map(entry=>({uid:entry.uid,kind:entry.glyphMask?'glyph':entry.vectorRaster?'vector':'image/path',width:(entry.bitmap||entry.vectorRaster)?.width||0,height:(entry.bitmap||entry.vectorRaster)?.height||0})).sort((a,b)=>b.width*b.height-a.width*a.height).slice(0,5)});}return receive.apply(this,args);};
    const presented=(at,mode)=>{if(s.playing&&probe.active&&probe.presented.at(-1)?.tick!==e.tick){probe.presented.push({tick:e.tick,at:performance.now(),ms:performance.now()-at,quality:s.previewGovernor?.index||0,mode});performance.mark(`styk-tick-${e.tick}`);}};
    const render=r.renderPrepared.bind(r);r.renderPrepared=(...args)=>{const at=performance.now(),value=render(...args);if(value)presented(at,'prepared');return value;};
    const live=r.render.bind(r);r.render=(...args)=>{const at=performance.now(),value=live(...args);presented(at,'live');return value;};
    const prepare=r.prepareFrame.bind(r);r.prepareFrame=(p,...args)=>{const at=performance.now();try{return prepare(p,...args);}finally{if(probe.active)probe.uploads.push({tick:p.tick,at,ms:performance.now()-at});}};
    new PerformanceObserver(list=>{if(probe.active)for(const x of list.getEntries())probe.longTasks.push({at:x.startTime,ms:x.duration});}).observe({entryTypes:['longtask']});
    let prior=0;const raf=now=>{if(probe.active){probe.raf.push({at:now,ms:prior?now-prior:0,buffering:s.buffering});const index=s.previewGovernor?.index||0;if(index!==probe.quality.at(-1)?.index)probe.quality.push({at:now,tick:e.tick,index});}prior=now;requestAnimationFrame(raf);};requestAnimationFrame(raf);
    s.settings.playbackQuality=quality==='adaptive'?'auto':quality==='full'?'normal':quality;
    s.loop=false;s.loopRange=end>=0?{startTick:start,endTick:Math.min(end+1,e.totalTicks)}:null;e.seek(start);styk.fit();
    probe.active=true;probe.started=performance.now();styk.actions.play();
  },{start:Number(process.env.STYK_PROBE_START||0),end:Number(process.env.STYK_PROBE_END??-1),quality:result.environment.previewQuality});
  const timeout=Date.now()+Number(process.env.STYK_PROBE_SECONDS||600)*1000;
  while(Date.now()<timeout){
    await page.waitForTimeout(10000);
    const status=await page.evaluate(()=>({playing:styk.state.playing,tick:styk.editor.tick,total:styk.editor.totalTicks,fps:styk.performance().presentation.fps,quality:styk.state.previewGovernor?.index,packet:probe.packets.at(-1)}));
    console.log('STATUS',JSON.stringify({...status,packet:status.packet&&{tick:status.packet.tick,ms:status.packet.ms,bytes:status.packet.bytes,quality:status.packet.quality}}));
    if(!status.playing)break;
  }
  result.playback=await page.evaluate(()=>{probe.active=false;return {...probe,playing:styk.state.playing,performance:styk.performance(),
    preparedStats:styk.state.renderer?.preparedFrames?.stats?{...styk.state.renderer.preparedFrames.stats}:null,
    playbackStats:styk.state.playback?.stats?{...styk.state.playback.stats,lastSharing:null,workerCache:null}:null};});
  if(process.env.STYK_PROBE_MAIN_PROFILE==='1'){const {profile}=await client.send('Profiler.stop');await writeFile(path.join(output,'main-profile.cpuprofile'),JSON.stringify(profile));result.mainProfile=summarizeProfiles([profile]);console.log('MAIN_PROFILE',JSON.stringify(result.mainProfile.top.slice(0,25)));}
  if(workerProfiles){const written=await workerProfiles.stop(output);result.workerProfileFiles=written;const {readFile:read}=await import('node:fs/promises');result.workerProfile=summarizeProfiles(await Promise.all(written.map(async w=>JSON.parse(await read(w.file,'utf8')))));console.log('WORKER_PROFILE',JSON.stringify(result.workerProfile.top.slice(0,20)));}
  if(process.env.STYK_PROBE_TRACE==='1'){
    const completed=new Promise(resolve=>client.once('Tracing.tracingComplete',resolve));await client.send('Tracing.end');
    const {stream}=await completed,parts=[];
    try{for(;;){const part=await client.send('IO.read',{handle:stream});parts.push(Buffer.from(part.data,part.base64Encoded?'base64':'utf8'));if(part.eof)break;}}
    finally{await client.send('IO.close',{handle:stream});}
    await writeFile(path.join(output,'chrome-trace.json'),Buffer.concat(parts));
  }
  const first=Number(process.env.STYK_PROBE_START||0),last=Math.min(Number(process.env.STYK_PROBE_END??(result.scene.ticks-1)),result.scene.ticks-1);
  result.sequential=result.playback.presented.length===last-first+1&&result.playback.presented.every((p,i)=>p.tick===first+i);
  await page.evaluate(()=>{if(styk.state.playing)styk.actions.play();});
  await page.waitForFunction(()=>!styk.state.editablePreparing);
  await page.screenshot({path:path.join(output,'final.png')});
  const q=values=>{const a=values.sort((a,b)=>a-b);return {n:a.length,p50:a[Math.floor(a.length*.5)]||0,p95:a[Math.floor(a.length*.95)]||0,p99:a[Math.floor(a.length*.99)]||0,max:a.at(-1)||0};};
  const p=result.playback.presented,gaps=p.slice(1).map((x,i)=>x.at-p[i].at);
  result.summary={sequential:result.sequential,frames:p.length,liveFrames:p.filter(p=>p.mode==='live').length,wallMs:p.at(-1)?.at-p[0]?.at,gaps:q(gaps),compile:q(result.playback.packets.map(p=>p.ms)),upload:q(result.playback.uploads.map(p=>p.ms)),
    reducedPackets:result.playback.packets.filter(p=>p.quality.reduced).length,quality:result.playback.quality,longTasks:q(result.playback.longTasks.map(p=>p.ms)),gpuErrors:result.playback.gpuErrors,errors:result.errors};
  console.log('SUMMARY',JSON.stringify(result.summary));
  if(!result.sequential)throw new Error('Playback did not present every requested tick in order.');
  if(result.playback.gpuErrors.length)throw new Error('Playback emitted GPU validation errors.');
}catch(error){result.errors.push(error.stack);throw error;}
finally{
  result.sourceUnchanged=digest(await readFile(source))===result.source.sha256;
  result.changedDuringRun=[];for(const [name,hash]of Object.entries(result.hashes)){
    const current=await readFile(path.join(sourceRoot,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!current||digest(current)!==hash)result.changedDuringRun.push(name);
  }
  await writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));
  let killTimer;
  try{await Promise.race([app.evaluate(({app})=>app.exit(0)).catch(()=>{}),new Promise(resolve=>{
    killTimer=setTimeout(()=>{if(child.exitCode===null)child.kill();resolve();},10000);
  })]);}finally{clearTimeout(killTimer);}
}
