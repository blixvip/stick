/** Paired renderer measurements on identical inputs; no user project is opened. */
import {chromium} from '../tests/support/playwright.mjs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';

const out = 'artifacts/onion-performance-20260928';
const baseline = process.env.STYK_ONION_BASELINE;
const sourceFiles = ['src/renderer.mjs','src/renderer-onion-composite.mjs','src/onion-surface-cache.mjs','src/playback-budget.mjs','src/vfx-viewport.mjs'];
const fingerprints = async root => Object.fromEntries(await Promise.all(sourceFiles.map(async file => {
  try { return [file, createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')]; }
  catch (error) { if (error.code === 'ENOENT') return [file,null]; throw error; }
})));
const sources = {current:await fingerprints(process.cwd()),...(baseline?{baseline:await fingerprints(baseline)}:{})};
const server = await backend.startBackend({appRoot: process.cwd()});
const browser = await chromium.launch({channel: 'chrome', headless: true});
await mkdir(out, {recursive: true});
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (baseline) await page.route('**/__onion_baseline/**', async route => {
    const relative = new URL(route.request().url()).pathname.split('/__onion_baseline/')[1];
    await route.fulfill({body: await readFile(path.join(baseline, relative)), contentType: 'text/javascript'});
  });
  await page.goto(server.origin); await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async baseline => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const modules = [['current', await import('/src/renderer.mjs')]];
    if (baseline) modules.unshift(['baseline', await import('/__onion_baseline/src/renderer.mjs')]);
    const summary = values => {values.sort((a,b) => a-b); return {p50: values[Math.floor(values.length*.5)], p95: values[Math.floor(values.length*.95)], max: values.at(-1)};};
    const rows = [], gpuErrors = [];
    for (const workload of [
      {name:'steady', width:960, height:540, dpr:1, ghosts:3, count:400, iterations:40},
      {name:'pressure', width:1360, height:768, dpr:2, ghosts:6, count:160, iterations:20},
    ]) {
      const report = emptyDocument(), figure = report.figure_types[0];
      report.canvas_width = workload.width; report.canvas_height = workload.height;
      report.keyframes = Array.from({length:workload.ghosts+1}, (_,i) => createFrame(Array.from({length:workload.count}, (_,j) =>
        createObject(figure, j+1, 20+j%25*38+i*2, 20+Math.floor(j/25)*33, {scale:.18})),1));
      const scenes = report.keyframes.map(frame => buildGeometry(report,frame));
      const options = {report,frame:report.keyframes.at(-1),geometry:scenes.at(-1),view:{x:0,y:0,scale:1},cameraEnabled:false,
        onionFrames:report.keyframes.slice(0,-1).map((frame,i)=>({frame,geometry:scenes[i],opacity:.14/(workload.ghosts-i)}))};
      for (const forceCanvas2D of [false,true]) {
        const samples=[];
        try {
          for(const [version,module] of modules){
            const renderer=await module.createRenderer(document.createElement('canvas'),{forceCanvas2D});
            renderer.resize(workload.width,workload.height,workload.dpr);
            renderer.device?.addEventListener('uncapturederror',e=>gpuErrors.push(e.error.message));
            samples.push({version,renderer,cpu:[],complete:[],work:[],cold:null});
          }
          for(let iteration=0;iteration<workload.iterations+5;iteration++)for(const sample of iteration%2?[...samples].reverse():samples){
            const {renderer}=sample;
            options.dragTranslations=new Map([[1,{x:iteration%15,y:0}]]);
            const start=performance.now();renderer.render(options);const cpu=performance.now()-start;
            await renderer.device?.queue.onSubmittedWorkDone();const complete=performance.now()-start;
            if(!iteration)sample.cold={cpuMs:cpu,completionMs:complete};
            if(iteration>=5){sample.cpu.push(cpu);sample.complete.push(complete);sample.work.push({
              frames:renderer.stats.onionRenderedFrames??null,hits:renderer.stats.onionFrameHits??null,
              objects:renderer.stats.onionRasterizedObjects??0,
              // Baseline Canvas mixed completed frames and object rasters in one
              // LRU; current Canvas owns them separately. Avoid double counting.
              retainedBytes:renderer.stats.onionCacheBytes??renderer.onionArtworkBytes??0,
              compositeBytes:renderer.stats.onionCompositeBytes??0,
              totalOnionBytes:renderer.device?renderer.stats.onionCompositeBytes??0:
                renderer.onionLayers?(renderer.stats.onionCompositeBytes??0)+renderer.onionArtworkBytes:
                  renderer.onionArtworkBytes+(renderer.onionSurface?renderer.onionSurface.width*renderer.onionSurface.height*4:0)});}
          }
          for(const s of samples)rows.push({workload,version:s.version,backend:s.renderer.stats.backend,adapter:s.renderer.stats.adapter,
            cold:s.cold,cpuMs:summary(s.cpu),completionMs:summary(s.complete),work:s.work});
        } finally {for(const s of samples)s.renderer.destroy();}
      }
    }
    return {rows,gpuErrors};
  }, Boolean(baseline));
  await writeFile(`${out}/${process.argv[2]??'latest'}.json`,JSON.stringify({measuredAt:new Date().toISOString(),browser:browser.version(),sources,...result,errors},null,2));
  for(const {workload,version,backend,cpuMs,completionMs,work} of result.rows)
    console.log(JSON.stringify({workload:workload.name,version,backend,cpuMs,completionMs,last:work.at(-1)}));
  if(errors.length||result.gpuErrors.length)throw Error(JSON.stringify({errors,gpuErrors:result.gpuErrors}));
  for(const row of result.rows.filter(row=>row.version==='current'))for(const work of row.work){
    assert.equal(work.frames,0,'Unchanged ghost frames must be retained during live translation');
    assert.equal(work.hits,row.workload.ghosts,'Every unchanged ghost must hit the completed layer');
    assert.equal(work.objects,0,'Warm posing must not rerasterize ghost figures');
    assert.ok(work.retainedBytes<=64*1024*1024,'Retained onion pixels must stay within the hardware policy');
  }
} finally {await browser.close();server.stop();}
