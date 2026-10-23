/** Local paired driver for the zoom refinement helpers. It imports a native
 * project through ImportClient into a blank probe page with its own Editor,
 * image and drawing owners, then runs scripts/zoom-gesture-benchmark.mjs or
 * scripts/zoom-refinement-sweep.mjs against frozen and current source trees.
 * Results hold timings, counters and pixel-difference statistics only; the
 * project, its geometry and captured pixels are never written.
 *
 *   node scripts/serve.mjs --port 47841            (in another terminal)
 *   git archive <commit> src vendor | tar -x -C tmp/zoom/ref
 *   STYK_URL=http://127.0.0.1:47841 node scripts/benchmark-zoom-refinement.mjs gesture \
 *     --project file.styk --variants ref=/tmp/zoom/ref/src,new=/src --out artifacts/zoom-refinement/gesture.json
 *
 * Modes: gesture (paired trials per tick, in --order or a mirrored sequence),
 * profile (gesture with worker request and job traces), sweep (every tick, the
 * first variant as baseline and the last as current). Options: --ticks a,b,
 * --base /url (tree for the editor and resource owners, default /src),
 * --helper /url, --gpu (with STYK_BROWSER_GPU=1 on Linux), --warm (untimed wait for a loaded
 * capture worker before each gesture), --cpuprofile [--top n]. Run serialized:
 * concurrent work on the machine changes every timing. */
import {chromium} from '../tests/support/playwright.mjs';
import {writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),mode=args[0],opt=name=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:undefined;};
const origin=process.env.STYK_URL||'http://127.0.0.1:47841',project=opt('project'),gpu=args.includes('--gpu');
if(!['gesture','profile','sweep'].includes(mode)||!project)throw new Error('Usage: benchmark-zoom-refinement.mjs gesture|profile|sweep --project file [--variants name=/url,...]');
const variants=(opt('variants')||'new=/src').split(',').map(v=>v.split('='));
const ticks=(opt('ticks')||'68,39,43,58,90,93,98,151,168').split(',').map(Number),out=opt('out');
const order=(opt('order')||'').split(',').filter(Boolean);
// Editor, importer and resource owners load from one tree; name a frozen one when the working tree may change.
const base=opt('base')||'/src';
const sha=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
const projectHash=await sha(project);
const browser=await chromium.launch({channel:'chrome',headless:true,args:gpu?['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan']:[]});
const result={mode,measuredAt:new Date().toISOString(),browser:browser.version(),gpu,variants,base,errors:[]};
try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text().slice(0,300));});
  await page.route('**/__zoom_probe__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Zoom probe</title><input type="file" id="f">'}));
  await page.goto(origin+'/__zoom_probe__'+(args.includes('--warm')?'#warm':''));
  // Other work on the machine changes every timing. Keep the one-minute load
  // average beside each sweep row and trial so disturbed samples are visible.
  const load=()=>+os.loadavg()[0].toFixed(2);result.load=[];result.cpus=os.cpus().length;
  await page.exposeFunction('zoomProgress',d=>{result.load.push({tick:d.tick,load1:load()});if(process.env.VERBOSE)console.log(JSON.stringify(d));});
  await page.locator('#f').setInputFiles(project);
  await page.evaluate(async base=>{
    const [{ImportClient},{Editor},{PreviewImages},{assetURL},{drawingMetadata},{frameImageDrawables,backgroundImageAssets}]=await Promise.all(
      ['import-client','editor','preview-images','image-resources','drawing-model','scene-preparation'].map(n=>import(`${base}/${n}.mjs`)));
    const importer=new ImportClient(),imported=await importer.importFile(document.getElementById('f').files[0],{project:true});importer.adoptSource?.(imported);
    const editor=new Editor({demo:false,layerTimeline:true});editor.load(imported.document);
    const subscribers=new Set(),notify=()=>{for(const cb of [...subscribers])cb();};
    const images=new PreviewImages({onReady:notify}),owner=editor.drawingResources;owner.onChange=notify;
    const idle=()=>!owner.decoding&&!owner.decodeQueue.length&&!owner.previews?.active&&!owner.previews?.queue.size&&!images.busy&&!images.queued&&!images.pendingImages.size;
    const resources={url:assetURL,image:url=>images.image(url),drawing:f=>drawingMetadata(f)?owner.presenter(f):null,drawingLoad:f=>drawingMetadata(f)?owner.surface(f):null,
      async preload(drawables){
        await images.prepare([...frameImageDrawables(editor.geometry),...backgroundImageAssets(editor.report,editor.evaluatedFrame).map(asset=>({type:'image',asset}))],{scale:1,maxDimension:4096});
        const figures=new Map(drawables.filter(i=>i.fig?._styk?.drawing?.version===2).map(i=>[i.fig._styk.drawing.celId,i.fig]));
        for(const figure of figures.values())for(let i=0;i<8&&!owner.presenter(figure)?.store;i++)await owner.surface(figure).catch(()=>{});
      }};
    window.zoom={editor,resources,owner,images,importer,
      subscribeResources:cb=>{subscribers.add(cb);return()=>subscribers.delete(cb);},
      async waitResourcesReady(){for(let quiet=0;quiet<3;){await new Promise(r=>setTimeout(r,4));quiet=idle()?quiet+1:0;}}};
  },base);
  result.totalTicks=await page.evaluate(()=>zoom.editor.totalTicks);
  let cdpProfile;
  if(args.includes('--cpuprofile')){cdpProfile=await page.context().newCDPSession(page);await cdpProfile.send('Profiler.enable');await cdpProfile.send('Profiler.setSamplingInterval',{interval:500});
    await page.evaluate(()=>{window.__profileMarks=[];});}
  if(mode==='sweep'){
    const [base,current]=[variants[0],variants.at(-1)];
    if(cdpProfile)await cdpProfile.send('Profiler.start');
    result.sweep=await page.evaluate(async({base,current,gpu,ticks,helper})=>{
      const {zoomRefinementSweep}=await import(helper);
      const r=await zoomRefinementSweep({editor:zoom.editor,resources:zoom.resources,baselineRendererURL:base+'/renderer.mjs',currentRendererURL:current+'/renderer.mjs',forceCanvas2D:!gpu,
        ticks,subscribeResources:zoom.subscribeResources,waitResourcesReady:zoom.waitResourcesReady,onProgress:d=>window.zoomProgress({tick:d.tick,passed:d.passed,readyMs:d.readyMs,error:d.error})});
      return r;
    },{base:base[1],current:current[1],gpu,ticks:opt('ticks')?ticks:undefined,helper:opt('helper')||'/scripts/zoom-refinement-sweep.mjs'});
  }else{
    if(cdpProfile)await cdpProfile.send('Profiler.start');
    const sequence=order.length?order:variants.map(v=>v[0]).concat(variants.map(v=>v[0]).reverse());
    result.trials=[];
    for(const tick of ticks)for(const name of sequence){
      const url=variants.find(v=>v[0]===name)[1];
      const trial=await page.evaluate(async({tick,url,gpu,name,helper,profile})=>{
        const {zoomGestureBenchmark}=await import(helper);
        const {editor,resources}=zoom;editor.seek(tick);await resources.preload(editor.geometry.drawables);await zoom.waitResourcesReady();
        let trace;
        if(profile){
          const {DrawingWorker}=await import(url+'/drawing-worker-client.mjs');trace=[];
          if(!DrawingWorker.prototype.__traced){const original=DrawingWorker.prototype.request;DrawingWorker.prototype.__traced=true;
            DrawingWorker.prototype.request=function(type,payload,options){const row={type,at:performance.now()};(window.__trace??=[]).push(row);
              const p=original.call(this,type,payload,options);p.then(()=>{row.ms=performance.now()-row.at;},()=>{row.ms=performance.now()-row.at;row.failed=true;});return p;};}
          window.__trace=trace;
          const {CanvasRasterRefinement}=await import(url+'/canvas-raster-refinement.mjs');
          if(!CanvasRasterRefinement.prototype.__traced){const original=CanvasRasterRefinement.prototype.request;CanvasRasterRefinement.prototype.__traced=true;
            CanvasRasterRefinement.prototype.request=function(key,d){const ok=original.call(this,key,d);
              window.__trace.push({type:'job',at:performance.now(),ok,w:d.capture.width,h:d.capture.height,items:d.items.length,scene:d.capture.scene!==undefined,priority:Boolean(d.priority),
                viewport:Boolean(d.capture.nativePadding),images:d.items.filter(i=>i.type==='image').length,vfx:d.items.filter(i=>i.obj?._stykVfx||i._stykVfx).length,clip:Boolean(d.capture.clipBounds)});return ok;};}
        }
        const previews=zoom.owner.previews;
        if(previews&&!previews.__counted){previews.__counted=true;const original=previews.scratch.bind(previews);
          previews.scratch=(entry,rect,options)=>{const before=previews.queue.size+(previews.active?1:0),hit=original(entry,rect,options),c=window.__scratch??={};
            const kind=!hit?'none':'hit';c[kind]=(c[kind]??0)+1;if(previews.queue.size+(previews.active?1:0)>before)c.queued=(c.queued??0)+1;return hit;};}
        window.__scratch={};let scratchInitial;
        const r=await zoomGestureBenchmark({onProgress:d=>{if(d.step===1)scratchInitial={...window.__scratch,cache:previews?.cache.size};},rendererURL:url+'/renderer.mjs',forceCanvas2D:!gpu,report:editor.report,frame:editor.evaluatedFrame,geometry:editor.geometry,resources,
          defer:name!=='ctl'&&!name.startsWith('ctl'),awaitRefinement:true,warmWorker:location.hash==='#warm',subscribeResources:zoom.subscribeResources,waitResourcesReady:zoom.waitResourcesReady});
        const pixels=r.pixels;delete r.pixels;
        let hash=0;for(let i=0;i<pixels.length;i++)hash=(hash*31+pixels[i])|0;
        (window.zoomPixels??={})[tick+':'+name+':'+(window.zoomTrial=(window.zoomTrial??0)+1)]=pixels;
        r.scratchInitial=scratchInitial;
        return {tick,name,pixelKey:tick+':'+name+':'+window.zoomTrial,hash,trace,...r};
      },{tick,url,gpu,name,helper:opt('helper')||'/scripts/zoom-gesture-benchmark.mjs',profile:mode==='profile'});
      trial.load1=load();result.trials.push(trial);
      const rf=trial.refinement;
      console.log(JSON.stringify({tick,name,init:+trial.rows[0].cpuMs.toFixed(1),gestP95:+trial.gesture.cpuMs.p95.toFixed(1),settle:+trial.settle.cpuMs.max.toFixed(1),
        ready:+rf.settlementElapsedMs.toFixed(1),first:rf.firstPublicationMs&&+rf.firstPublicationMs.toFixed(0),half:rf.halfPublicationMs&&+rf.halfPublicationMs.toFixed(0),jobs:rf.completed,cb:rf.callbackCount,cbMax:rf.callbackCpuMs.max,steadyP95:+trial.steady.cpuMs.p95.toFixed(2),lt:trial.interactionLongTasks.length,load:trial.load1,scratch:trial.scratchInitial,err:trial.errors.length}));
    }
    // Pixel comparisons against the first variant's same-tick capture, in page.
    result.pixels=await page.evaluate(()=>{
      const out=[],keys=Object.keys(window.zoomPixels);
      for(const key of keys){const [tick]=key.split(':'),refKey=keys.find(k=>k.startsWith(tick+':'));const a=window.zoomPixels[key],b=window.zoomPixels[refKey];
        let sum=0,max=0,alphaMax=0,painted=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);sum+=d;if(d>max)max=d;if(i%4===3){if(d>alphaMax)alphaMax=d;if(a[i])painted++;}}
        out.push({key,against:refKey,mean:sum/a.length,max,alphaMax,paintedPixels:painted});}
      return out;});
  }
  if(cdpProfile){
    const {profile}=await cdpProfile.send('Profiler.stop');const byId=new Map(profile.nodes.map(n=>[n.id,n])),parent=new Map();
    for(const n of profile.nodes)for(const c of n.children??[])parent.set(c,n.id);
    const self=new Map(),inclusive=new Map(),name=n=>n.callFrame.functionName+' '+n.callFrame.url.split('/').slice(-2).join('/')+':'+n.callFrame.lineNumber;
    profile.samples.forEach((id,i)=>{const dt=profile.timeDeltas[i];let n=byId.get(id);self.set(name(n),(self.get(name(n))??0)+dt);const seen=new Set();
      for(let cur=id;cur!==undefined;cur=parent.get(cur)){const k=name(byId.get(cur));if(!seen.has(k)){seen.add(k);inclusive.set(k,(inclusive.get(k)??0)+dt);}}});
    const top=m=>[...m].sort((a,b)=>b[1]-a[1]).slice(0,+(opt('top')||22)).map(([k,v])=>(v/1000).toFixed(0).padStart(6)+'ms '+k).join('\n');
    console.log('SELF\n'+top(self)+'\nINCLUSIVE\n'+top(inclusive));
  }
  await page.evaluate(async()=>{zoom.importer.dispose();});
}catch(error){result.failure=String(error.stack).slice(0,2000);console.error(result.failure);}
finally{
  result.projectStable=await sha(project)===projectHash;
  if(out)await writeFile(out,JSON.stringify(result));
  await browser.close();
  console.log(JSON.stringify({errors:result.errors.slice(0,5),failure:Boolean(result.failure),projectStable:result.projectStable,sweepPassed:result.sweep?.passed,failedTicks:result.sweep?.failedTicks,timings:result.sweep?.timings}));
}
