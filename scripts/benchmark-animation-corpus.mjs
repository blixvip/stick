/** Full local PIV collection audit. Every source is read-only; edits live in a
 * dedicated Electron profile. Resume by label; byte-identical files share a run. */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const base=path.resolve('artifacts/animation-corpus-60');
const inventory=JSON.parse(await readFile(path.join(base,'inventory.json'),'utf8'));
const label=process.env.STYK_CORPUS_LABEL||'exact-baseline',output=path.join(base,label);
const sourceRoot=process.env.STYK_CORPUS_SOURCE?path.resolve(process.env.STYK_CORPUS_SOURCE):null;
const filter=process.env.STYK_CORPUS_FILTER;
await mkdir(output,{recursive:true});
const unique=[...new Map(inventory.files.map(f=>[f.sha256,f])).values()].filter(f=>!filter||f.relative.toLowerCase().includes(filter.toLowerCase()));
// Start with complete animations, then asset packs. Preserve every inventory row.
unique.sort((a,b)=>Number(!a.relative.startsWith('DBP9'))-Number(!b.relative.startsWith('DBP9'))||b.bytes-a.bytes);
const summaries=[];
for(const [index,file] of unique.entries()){
  const id=file.sha256.slice(0,16),dir=path.join(output,id),resultPath=path.join(dir,'report.json');
  const reference=label!=='exact-baseline'?await readFile(path.join(base,'exact-baseline',id,'report.json'),'utf8').then(JSON.parse,()=>null):null;
  let result;
  try{result=JSON.parse(await readFile(resultPath,'utf8'));if(result.error)result=null;}catch{}
  if(!result){
    await mkdir(dir,{recursive:true});let app;
    const started=Date.now();
    console.log(JSON.stringify({event:'start',index:index+1,total:unique.length,file:file.relative,mb:file.bytes/1e6}));
    try{
      app=await electron.launch({args:[process.cwd()],env:{...process.env,STYK_USER_DATA_DIR:path.join(dir,'profile')},timeout:60000});
      const page=await app.firstWindow(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setIgnoreMouseEvents(true);w.setFocusable(false);w.showInactive();});
      await page.waitForFunction(()=>window.styk?.ready,null,{timeout:60000});
      if(sourceRoot){
        const files=new Map();
        await page.context().route(url=>url.pathname==='/'||url.pathname==='/index.html'||url.pathname.startsWith('/src/'),async route=>{
          const name=new URL(route.request().url()).pathname.slice(1)||'index.html';
          if(!files.has(name))files.set(name,await readFile(path.join(sourceRoot,name)));
          await route.fulfill({body:files.get(name),contentType:name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript'});
        });
      }
      await page.evaluate(()=>stykDesktop.setTelemetryConsent({analytics:false,diagnostics:false}));
      await page.reload();await page.waitForFunction(()=>window.styk?.ready);
      await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
      const importing=Date.now();
      await page.locator('#file-input').setInputFiles(file.path);
      await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(file.path,'.piv'),{timeout:240000});
      await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender,null,{timeout:120000});
      const importMs=Date.now()-importing;
      const info=await page.evaluate(()=>{
        const setup=async()=>{
        const e=styk.editor,s=styk.state,{PlaybackCache}=await import('/src/playback.mjs');
        for(const d of document.querySelectorAll('dialog[open]'))d.close();
        // Legacy PIV stores integer milliseconds. Normalize this read-only
        // benchmark instance to exact 60 Hz without changing file semantics.
        e._fields('Benchmark frame rate',{fps:60,frame_delay_ms:1000/60},{timing:true});
        e.markSaved();s.loop=false;e.seek(0);styk.fit();
        const p=window.corpusProbe={packets:[],presented:[],uploads:[],longTasks:[],raf:[],phase:'playback'};
        const receive=PlaybackCache.prototype._receive;
        PlaybackCache.prototype._receive=function(m){if(m.type==='packet'&&m.revision===this.revision){const q=m.packet;p.packets.push({at:performance.now(),tick:q.tick,compileMs:q.compileMs,bytes:q.byteLength,quality:q.previewQuality,rasters:q.compatibility.length,groups:q.groups.length,shapes:q.shapes.length/24,timings:q.timings,sharing:q.sharing,cache:q.workerCache,clipping:q.clipping});}return receive.call(this,m);};
        const r=s.renderer,render=r.renderPrepared.bind(r),prepare=r.prepareFrame.bind(r);
        r.renderPrepared=(...args)=>{const at=performance.now(),ok=render(...args);if(ok&&s.playing&&p.presented.at(-1)?.tick!==e.tick)p.presented.push({tick:e.tick,at:performance.now(),submitMs:performance.now()-at,governor:s.previewGovernor?.index||0});return ok;};
        r.prepareFrame=(packet,...args)=>{const at=performance.now();try{return prepare(packet,...args);}finally{p.uploads.push({tick:packet.tick,at,ms:performance.now()-at});}};
        new PerformanceObserver(list=>{for(const entry of list.getEntries())p.longTasks.push({at:entry.startTime,ms:entry.duration,phase:p.phase});}).observe({entryTypes:['longtask']});
        const frame=now=>{if(p.phase==='playback'){p.raf.push(now);requestAnimationFrame(frame);}};requestAnimationFrame(frame);
        let playing=s.playing;
        Object.defineProperty(s,'playing',{get:()=>playing,set:value=>{if(playing&&!value)p.stop={at:performance.now(),stack:new Error().stack};playing=value;},configurable:true});
        return{ticks:e.totalTicks,keyframes:e.report.keyframes.length,canvas:[e.report.canvas_width,e.report.canvas_height],figureTypes:e.report.figure_types.length,backend:r.stats.backend,adapter:r.stats.adapter,scale:s.view.scale,dpr:r.dpr,targetFps:1000/e.report.frame_delay_ms};
        };
        // CDP may hold an awaited evaluation promise weakly. Keep setup alive
        // across dynamic imports until the driver receives its result.
        return window.corpusSetup=setup();
      });
      await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender,null,{timeout:120000});
      // A single authored pose can carry the PIV maximum 16-bit hold. Measure a
      // sustained ten seconds and inspect its far endpoint instead of reporting
      // thousands of identical held ticks as distinct animated test frames.
      const sampledTicks=info.keyframes===1&&info.ticks>3600?600:info.ticks;
      info.coverage=sampledTicks===info.ticks?'all-ticks':'sustained-single-keyframe-hold';info.sampledTicks=sampledTicks;
      let profiler;
      if(process.env.STYK_CORPUS_PROFILE){profiler=await page.context().newCDPSession(page);await profiler.send('Profiler.enable');await profiler.send('Profiler.start');}
      if(process.env.STYK_CORPUS_IMAGES)await (await import('./probe-preview-images.mjs')).probePreviewImages(page);
      await page.evaluate(()=>{corpusProbe.playAt=performance.now();styk.actions.play();});
      let complete=false,lastProgress=0;
      const deadline=Date.now()+Math.max(180000,info.ticks/60*1000*12);
      while(Date.now()<deadline){
        await page.waitForTimeout(500);
        const status=await page.evaluate(()=>({playing:styk.state.playing,tick:styk.editor.tick,total:styk.editor.totalTicks,frames:corpusProbe.presented.length}));
        if(Date.now()-lastProgress>15000){console.log(JSON.stringify({event:'playback',file:file.relative,...status}));lastProgress=Date.now();}
        if(sampledTicks<info.ticks&&status.tick>=sampledTicks-1){await page.evaluate(()=>{if(styk.state.playing)styk.actions.play();});complete=true;break;}
        if(!status.playing){complete=status.tick===info.ticks-1;break;}
      }
      if(!complete)await page.evaluate(()=>{if(styk.state.playing)styk.actions.play();});
      const playback=await page.evaluate(()=>{corpusProbe.phase='inspection';return{...corpusProbe,performance:styk.performance()};});
      if(profiler){const {profile}=await profiler.send('Profiler.stop');await writeFile(path.join(dir,'playback.cpuprofile'),JSON.stringify(profile));}
      await writeFile(path.join(dir,'playback.json'),JSON.stringify(playback));
      const presented=playback.presented.filter(p=>p.tick<sampledTicks),intervals=presented.slice(1).map((f,i)=>({tick:f.tick,ms:f.at-presented[i].at}));
      const sorted=intervals.toSorted((a,b)=>a.ms-b.ms),slow=intervals.filter(i=>i.ms>25);
      const worst=sorted.slice(-8).reverse(),ticks=[...new Set([...worst.slice(0,5).map(i=>i.tick),...playback.packets.toSorted((a,b)=>b.compileMs-a.compileMs).slice(0,3).map(p=>p.tick),info.ticks-1])];
      await page.waitForFunction(()=>!styk.state.editablePreparing&&!styk.state.dirtyRender,null,{timeout:120000});
      const contents=await page.evaluate(async ticks=>{
        const {buildGeometry,timeline,evaluatedFrame}=await import('/src/pivot/geometry.mjs'),{playbackLocation}=await import('/src/playback-worker.mjs');
        const report=styk.editor.report,entries=timeline(report),rows=[];
        for(const tick of ticks){const loc=playbackLocation(entries,tick),frame=evaluatedFrame(report,loc.index,loc.t,tick),g=buildGeometry(report,frame),d=g.drawables;
          rows.push({tick,keyframe:loc.index,objects:frame.objects.length,drawables:d.length,types:d.reduce((a,s)=>(a[s.type]=(a[s.type]||0)+1,a),{}),fadedObjects:g.orderedObjects.filter(g=>g.drawables[0]?.opacity<1).length,bent:d.filter(s=>Math.abs(s.bend)>1e-7).length,translucentSegments:d.filter(s=>s.alpha<1).length,largestFigures:g.orderedObjects.map(g=>({uid:g.obj.unique_id,segments:g.segments.length,opacity:g.drawables[0]?.opacity,root:g.root})).sort((a,b)=>b.segments-a.segments).slice(0,5)});
        }return rows;
      },ticks);
      const seeks=[];
      for(const tick of reference?.seeks?.map(s=>s.tick) ?? [...new Set([info.ticks-1,...worst.slice(0,2).map(i=>i.tick),0])]){
        const seek=await page.evaluate(async tick=>{const t=performance.now(),e=styk.editor;e.seek(tick);await new Promise(resolve=>{const next=()=>{if(!styk.state.editablePreparing&&!styk.state.dirtyRender&&e.tick===tick)resolve();else requestAnimationFrame(next);};requestAnimationFrame(next);});const submitted=performance.now();await styk.state.renderer.device?.queue.onSubmittedWorkDone();return{tick,submitMs:submitted-t,completeMs:performance.now()-t,preparation:styk.performance().editablePreparation};},tick);seeks.push(seek);
      }
      await page.screenshot({path:path.join(dir,'scene.png')});
      result={file,aliases:inventory.files.filter(f=>f.sha256===file.sha256).map(f=>f.relative),label,sourceRoot,info,importMs,elapsedMs:Date.now()-started,complete,sequential:presented.length===sampledTicks&&presented.every((p,i)=>p.tick===i),fps:presented.length>1?(presented.length-1)*1000/(presented.at(-1).at-presented[0].at):null,intervalP95:sorted[Math.floor(sorted.length*.95)]?.ms??0,maxInterval:sorted.at(-1)?.ms??0,slowIntervals:slow.length,worst,reducedPackets:playback.packets.filter(p=>p.quality?.reduced).length,reducedPresentations:presented.filter(p=>p.governor).length,maxPacketBytes:Math.max(0,...playback.packets.map(p=>p.bytes)),contents,seeks,errors};
      const {probeCorpusGestures}=await import(`./corpus-gestures.mjs?${file.sha256}`);
      result.startupMs=playback.performance.presentation?.startupMs;
      result.bufferingMs=playback.performance.presentation?.bufferingMs;
      try{result.gestures=await probeCorpusGestures(page,{tick:reference?.gestures?.tick??contents.find(c=>c.objects>0)?.tick??0,dir});}
      catch(error){result.gestures={error:error.message};}
    }catch(error){result={file,label,error:error.stack,elapsedMs:Date.now()-started};}
    finally{if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
    await writeFile(resultPath,JSON.stringify(result,null,2));
  }
  summaries.push(result);
  await writeFile(path.join(output,'summary.json'),JSON.stringify({label,sourceRoot,files:inventory.files.length,unique:unique.length,results:summaries},null,2));
  console.log(JSON.stringify({event:'done',index:index+1,total:unique.length,file:file.relative,fps:result.fps,p95:result.intervalP95,max:result.maxInterval,slow:result.slowIntervals,ticks:result.info?.ticks,sequential:result.sequential,error:result.error?.split('\n').slice(0,3).join(' ')}));
  if(await readFile(path.join(output,'stop-after-current'),'utf8').then(()=>true,()=>false))break;
}
