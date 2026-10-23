import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';

const root = path.resolve('.'), output = path.join(root, 'artifacts/renderer-quality');
await mkdir(output, {recursive:true});
const env = {...process.env, STYK_USER_DATA_DIR:path.join(output, `profile-${Date.now()}`)};
await mkdir(env.STYK_USER_DATA_DIR, {recursive:true});
await writeFile(path.join(env.STYK_USER_DATA_DIR,'telemetry-state.json'), JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({args:[root], cwd:root, timeout:45000, env});
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout:30000});
  const result = await page.evaluate(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const {createRenderer} = await import('/src/renderer.mjs');
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const {buildGeometry} = await import('/src/pivot/geometry.mjs');
    const {compilePlaybackPacket} = await import('/src/playback-worker.mjs');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const report = emptyDocument(), figure = report.figure_types[0];
    report.canvas_width = 400; report.canvas_height = 300;
    const frame = createFrame([createObject(figure, 1, 180, 160, {scale:.6})]);
    report.keyframes = [frame];
    const geometry = buildGeometry(report, frame), view = {x:0, y:0, scale:1};
    const options = {report, frame, geometry, view, canvasHandles:[{point:{x:180,y:160},screenRadius:5,color:'#ff0000',uid:1}]};
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:350px;top:200px;width:400px;height:300px;z-index:99999';
    document.body.append(canvas);
    let invalidations = 0;
    const r = await createRenderer(canvas, {onInvalidate:() => invalidations++});
    check(r.stats.backend === 'WebGPU', 'Hardware WebGPU is required for this test');
    r.resize(400, 300, 1);
    const read = async prepared => {
      if (prepared) check(r.renderPrepared(prepared, {report, view}), 'Prepared frame remains usable');
      else r.render(options);
      const url = canvas.toDataURL();
      const image = new Image(); image.src = url; await image.decode();
      const copy = new OffscreenCanvas(canvas.width, canvas.height), ctx = copy.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
      let opaque = 0, ink = 0;
      for (let i=0; i<pixels.length; i+=4) {
        if (pixels[i+3] > 200) opaque++;
        if (pixels[i+3] > 200 && pixels[i]+pixels[i+1]+pixels[i+2] < 600) ink++;
      }
      check(opaque > 1000 && ink > 20, `Visible artwork required (${opaque} opaque, ${ink} ink)`);
      return {opaque, ink};
    };
    const initial = await read();
    const original = r.createVectorPipeline.bind(r);
    const hold = () => {
      let release;
      const gate = new Promise(resolve => release = resolve);
      r.createVectorPipeline = async count => { await gate; return original(count); };
      return () => { r.createVectorPipeline = original; release(); };
    };
    const release = hold(), oldPipeline = r.pipeline, oldHandles = r.handleRenderer.pipeline;
    const pending = r.setMsaa(2);
    check(r.msaaCount === 4 && r.pipeline === oldPipeline, 'Pending compilation retains active sample count/pipeline');
    r.resize(401, 300, 1);
    const during = await read();
    check(r.handleRenderer.pipeline === oldHandles, 'Handle pipeline stays active during compilation');
    release(); await pending;
    check(r.msaaCount === 1 && invalidations === 1, 'Unsupported 2x reduces to 1x and schedules repaint');
    const reduced = await read();
    const packet = await compilePlaybackPacket(report, 0, {revision:51});
    const key = r.prepareFrame(packet, {report, view});
    await read(key);

    // Pause/restoration can supersede compilation with the already active level.
    const cancel = hold(), superseded = r.setMsaa(4);
    await r.setMsaa(1); cancel();
    check(await superseded === false && r.msaaCount === 1, 'Returning to the active level cancels stale compilation');
    const compileHandles = r.handleRenderer.createPipeline.bind(r.handleRenderer);
    r.handleRenderer.createPipeline = async () => { throw new Error('Injected handle pipeline failure'); };
    let rejection;
    try { await r.setMsaa(4); } catch (error) { rejection = error.message; }
    r.handleRenderer.createPipeline = compileHandles;
    check(rejection === 'Injected handle pipeline failure' && r.msaaCount === 1, 'Failure preserves usable resources');
    await read();
    await r.setMsaa(4);
    const restored = await read(key);
    check(r.msaaCount === 4 && r.hasPreparedFrame(key), 'Restoration preserves prepared playback');

    const limit = r.device.limits.maxTextureDimension2D;
    r.resize(limit + 1, 300, 1);
    check(canvas.width <= limit && r.width === limit + 1 && r.dpr < 1, 'Large viewport fits actual device limit');
    await read();
    const backing = {width:canvas.width, height:canvas.height, dpr:r.dpr, limit};
    r.resize(400, 300, 1); await read();
    await r.device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 100));
    check(r.stats.warnings.length === 0, r.stats.warnings.join('\n'));
    const finalRelease = hold(), destroyed = r.setMsaa(1);
    // Complete a pipeline before destroying the device, but hold publication.
    finalRelease(); r.destroy();
    await destroyed;
    canvas.remove();
    const singleCanvas = document.createElement('canvas');
    singleCanvas.width = 400; singleCanvas.height = 300;
    singleCanvas.style.cssText = 'width:400px;height:300px';
    document.body.append(singleCanvas);
    const single = await createRenderer(singleCanvas, {msaa:1});
    single.render({...options,canvasHandles:undefined});
    await single.device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 100));
    check(single.contextConfigured && single.stats.warnings.length === 0, 'An already-sized 1x surface is configured on first use');
    single.destroy(); singleCanvas.remove();
    return {backend:'WebGPU', initial, during, reduced, restored, backing, invalidations, warnings:r.stats.warnings};
  });
  assert.deepEqual(errors, []);
  await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });
  await page.screenshot({path:path.join(output, 'editor.png')});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {await app.close();}
