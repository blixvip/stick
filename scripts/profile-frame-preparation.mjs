/** Isolated diagnostic of the same packet compiler used by the playback worker.
 * The compiler runs on the page for CPU profiling; use the playback benchmark
 * for actual presentation rates. Input projects are never saved or modified. */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('Provide a PIV project and optional display ticks.');
const ticks = process.argv.slice(3).map(Number);
const output = path.resolve('artifacts/frame-preparation', process.env.STYK_PROBE_LABEL || 'current');
await mkdir(output, {recursive:true});
const app = await electron.launch({args:[process.cwd()], env:{...process.env, STYK_USER_DATA_DIR:path.join(output,'profile')}});
try {
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => {for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); styk.editor.markSaved();});
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source,'.piv'), {timeout:180000});
  await page.waitForFunction(() => !styk.state.editablePreparing && !styk.state.dirtyRender);
  const client = await page.context().newCDPSession(page);
  await client.send('Profiler.enable'); await client.send('Profiler.start');
  const result = await page.evaluate(async ticks => {
    const {compilePlaybackPacket, playbackLocation, PlaybackResources} = await import('/src/playback-worker.mjs');
    const {PlaybackGeometryCache} = await import('/src/playback-geometry-cache.mjs');
    const {ArtworkRegistry} = await import('/src/render-artwork.mjs');
    const {timeline, evaluatedFrame, buildGeometry} = await import('/src/pivot/geometry.mjs');
    const {requiresCompatibilityTexture, objectBounds} = await import('/src/renderer-geometry.mjs');
    const report = styk.editor.report, entries = timeline(report), resources = new PlaybackResources({preview:true});
    const geometryCache = new PlaybackGeometryCache(), artworkRegistry = new ArtworkRegistry();
    const rows = [], groups = [], imagePreloads=[];
    const preload=resources.preload.bind(resources);
    resources.preload=async(items,options)=>{
      const at=performance.now(),before=[...resources.images].map(([url,b])=>({url:url.slice(0,80),width:b.width,height:b.height,crop:[b.srcX,b.srcY,b.srcW,b.srcH]}));
      await preload(items,options);
      imagePreloads.push({ms:performance.now()-at,before,after:[...resources.images].map(([url,b])=>({url:url.slice(0,80),width:b.width,height:b.height,crop:[b.srcX,b.srcY,b.srcW,b.srcH]})),sources:[...resources.sources.values()].map(s=>s.info)});
    };
    if (!ticks.length) ticks = [0, Math.floor(styk.editor.totalTicks/2), styk.editor.totalTicks-1];
    const scale = styk.state.view.scale * styk.state.renderer.dpr;
    try {
      for (const tick of ticks) {
        const loc = playbackLocation(entries,tick), frame = evaluatedFrame(report,loc.index,loc.t,tick), geometry = buildGeometry(report,frame);
        groups.push({tick,objects:frame.objects.length,drawables:geometry.drawables.length,items:geometry.orderedObjects.map(g => ({
          uid:g.obj.unique_id,definition:g.obj.figure_type_id,segments:g.segments.length,drawables:g.drawables.length,
          types:g.drawables.reduce((a,s)=>(a[s.type]=(a[s.type]||0)+1,a),{}),opacity:g.drawables[0]?.opacity,
          compatibility:requiresCompatibilityTexture(g.drawables),bounds:objectBounds(g.drawables),
          outline:g.fig.segment_decode?.global_style?.u28,bent:g.drawables.filter(s=>Math.abs(s.bend)>1e-7).length,
          translucent:g.drawables.filter(s=>s.alpha<.999999||s.seg?.secondary?.a>0).length
        }))});
      }
      for (let pass=0;pass<2;pass++) for (const tick of ticks) {
        const packet=await compilePlaybackPacket(report,tick,{entries,scale,resources,geometryCache,artworkRegistry,maxTextureDimension:4096,maxPacketBytes:256*1024*1024});
        rows.push({pass,tick,compileMs:packet.compileMs,timings:packet.timings,bytes:packet.byteLength,groups:packet.groups.length,
          compatibility:packet.compatibility.length,sharing:packet.sharing,clipping:packet.clipping,reusedGeometryObjects:packet.reusedGeometryObjects});
        for(const item of packet.compatibility)item.bitmap?.close();
      }
      return {totalTicks:styk.editor.totalTicks,canvas:[report.canvas_width,report.canvas_height],scale,rows,groups,imagePreloads};
    } finally {resources.dispose();}
  },ticks);
  const {profile} = await client.send('Profiler.stop');
  await writeFile(path.join(output,'compile.cpuprofile'),JSON.stringify(profile));
  await writeFile(path.join(output,'report.json'),JSON.stringify({source,...result,errors},null,2));
  console.log(JSON.stringify({output,rows:result.rows,errors}));
} finally {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
