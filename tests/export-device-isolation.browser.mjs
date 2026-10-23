/** Repeated export alongside a live WebGPU editor, including real device loss. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/backend.cjs';

const output = path.resolve('artifacts/export-device-isolation');
await mkdir(output, {recursive: true});
const service = await backend.startBackend({appRoot: process.cwd()});
let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 960}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.origin);
  await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    const {ExportFrameRenderer} = await import('/src/export-frame-renderer.mjs');
    const {samplingFixture} = await import('/tests/export-sampling-fixture.mjs');
    const {exportFrameGeometry, drawExportSceneTiled} = await import('/src/export-frame-core.mjs');
    const {PlaybackResources} = await import('/src/playback-resources.mjs');
    const {encodeWebM} = await import('/src/video-export.mjs');
    const check = (ok, message) => {if (!ok) throw new Error(message);};
    const report = samplingFixture({kind: 'outline', opacity: .6});
    report.keyframes[0].objects[0].field28 = 60;
    report.figure_types[0].segment_decode.global_style.u30 = 80;
    report.canvas_width = 1920; report.canvas_height = 1080;
    for (const frame of report.keyframes) {
      frame.objects[0].scale = 12;
      frame.objects[0].root_x = 500; frame.objects[0].root_y = 300;
    }
    await styk.acceptImport({document: report, kind: 'piv'}, 'Export device regression.piv');
    const source = styk.editor.report, revision = styk.editor.revision;
    const live = styk.state.renderer;
    window.lostExportRenderer = live;
    check(live.stats.backend === 'WebGPU', 'A live hardware renderer is required.');
    let lost = false;
    live.device.lost.then(() => {lost = true;});

    // Capture actual context creation, including nested object/outline opacity.
    const surface = new OffscreenCanvas(1920, 1080), tile = new OffscreenCanvas(1, 1);
    const context = surface.getContext('2d', {willReadFrequently: true});
    const resources = new PlaybackResources({preview: false});
    const geometry = exportFrameGeometry(report, report.keyframes[0]);
    const originalGetContext = OffscreenCanvas.prototype.getContext, contexts = new Set();
    OffscreenCanvas.prototype.getContext = function (...args) {
      const result = originalGetContext.apply(this, args);
      if (args[0] === '2d') contexts.add(result);
      return result;
    };
    let count;
    try {
      for (let i = 0; i < 3; i++) {
        await drawExportSceneTiled(context, report, report.keyframes[0], geometry, resources, 1024, tile);
        count ??= contexts.size;
        check(contexts.size === count, 'Export allocated new opacity contexts on a later frame.');
        check(tile.width === 1 && tile.height === 1, 'Tile pixels were retained between frames.');
      }
      check(count >= 3, 'The fixture must exercise nested opacity surfaces.');
      check([...contexts].every(ctx => ctx.getContextAttributes().willReadFrequently),
        'An export scratch surface requested GPU-backed rendering.');
    } finally {OffscreenCanvas.prototype.getContext = originalGetContext; resources.dispose();}

    const renders = [];
    for (const smoothing of ['edges', 'sprites', 'none']) {
      const renderer = new ExportFrameRenderer({width: 1920, height: 1080, smoothing});
      try {
        await renderer.load(report);
        for (let i = 0; i < 12; i++) {
          const canvas = await renderer.renderTick(i % 3);
          const blob = await new Promise(resolve => canvas.toBlob(resolve));
          check(blob?.size > 1000 && canvas.width === 1920 && canvas.height === 1080,
            'Export did not produce a full-size nonempty image.');
          check(!lost && live.stats.backend === 'WebGPU', 'Export disconnected the editor device.');
        }
        renders.push({smoothing, frames: renderer.stats.renderedFrames,
          renderWidth: renderer.stats.renderWidth, renderHeight: renderer.stats.renderHeight});
        if (smoothing === 'edges') window.exportRegressionPNG = renderer.canvas.toDataURL();
      } finally {renderer.dispose();}
    }
    const videoRenderer = new ExportFrameRenderer({width: 640, height: 360});
    let videoExport;
    try {
      await videoRenderer.load(report);
      const nativeWorker = new Worker('/src/native-video-frame-worker.mjs', {type: 'module'});
      let requestId = 0;
      const request = (operation, data = {}, transfer = []) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native frame worker timed out.')), 15000);
        nativeWorker.onmessage = ({data}) => {clearTimeout(timer); data.ok ? resolve(data) : reject(new Error(data.error));};
        nativeWorker.onerror = () => {clearTimeout(timer); reject(new Error('Native frame worker failed.'));};
        nativeWorker.postMessage({id: ++requestId, operation, ...data}, transfer);
      });
      try {
        for (const preserveAlpha of [false, true]) {
          await request('start', {width: 640, height: 360, preserveAlpha});
          const bitmap = await createImageBitmap(await videoRenderer.renderTick(0));
          const {blob} = await request('frame', {bitmap}, [bitmap]);
          const decoded = await createImageBitmap(blob);
          const readback = new OffscreenCanvas(640, 360).getContext('2d', {willReadFrequently: true});
          try {readback.drawImage(decoded, 0, 0);} finally {decoded.close();}
          const pixels = readback.getImageData(0, 0, 640, 360).data;
          check(pixels[3] === (preserveAlpha ? 0 : 255), 'Native frame worker changed background transparency.');
          check(pixels.some((channel, index) => index % 4 !== 3 && channel > 30), 'Native video frame is blank.');
        }
      } finally {nativeWorker.terminate();}
      const blob = await encodeWebM({width: 640, height: 360, fps: 24, totalFrames: 24,
        renderFrame: index => videoRenderer.renderTick(index % 3)});
      const video = document.createElement('video'), url = URL.createObjectURL(blob);
      video.muted = true; document.body.append(video);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Exported video did not decode.')), 15000);
          video.onloadeddata = () => {clearTimeout(timer); resolve();};
          video.onerror = () => {clearTimeout(timer); reject(new Error('Exported video is invalid.'));};
          video.src = url; video.load();
        });
        check(video.videoWidth === 640 && video.videoHeight === 360 && Math.abs(video.duration - 1) < .002,
          'Worker export produced incorrect video dimensions or duration.');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Exported video did not seek.')), 15000);
          video.onseeked = () => {clearTimeout(timer); resolve();};
          video.currentTime = .5;
        });
        const pixels = new OffscreenCanvas(640, 360).getContext('2d', {willReadFrequently: true});
        pixels.drawImage(video, 0, 0);
        const rgba = pixels.getImageData(0, 0, 640, 360).data;
        let coloredPixels = 0;
        for (let i = 0; i < rgba.length; i += 4)
          if (Math.max(rgba[i], rgba[i+1], rgba[i+2]) - Math.min(rgba[i], rgba[i+1], rgba[i+2]) > 30) coloredPixels++;
        check(coloredPixels > 1000, `The decoded video frame has only ${coloredPixels} colored pixels.`);
        videoExport = {nativeFrameAlphaChecked: true, bytes: blob.size, frames: 24, width: video.videoWidth, height: video.videoHeight,
          duration: video.duration, coloredPixels};
      } finally {video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);}
      check(!lost, 'Video encoding disconnected the editor device.');
    } finally {videoRenderer.dispose();}
    check(styk.editor.report === source && styk.editor.revision === revision,
      'Export changed the active document.');

    // Once loss is delivered, scheduled redraw/resize/preparation must be inert.
    const survivingExport = new ExportFrameRenderer({width: 640, height: 360});
    await survivingExport.load(report);
    const inFlight = survivingExport.renderTick(0);
    live.device.destroy(); await live.device.lost;
    const width = live.canvas.width, height = live.canvas.height;
    live.resize(333, 222, 1);
    const unusable = new Proxy({}, {get() {throw new Error('Lost renderer accessed scene data.');}});
    check(live.render(unusable) === undefined, 'Lost renderer continued rendering.');
    check(live.prepareFrame(unusable, unusable) === null, 'Lost renderer prepared GPU data.');
    check(live.renderPrepared('missing', unusable) === false, 'Lost renderer submitted a prepared frame.');
    check(live.canvas.width === width && live.canvas.height === height, 'Lost renderer resized its canvas.');
    try {
      check((await inFlight).width === 640, 'Device loss interrupted an independent software export.');
      check((await survivingExport.renderTick(1)).height === 360, 'Export could not continue after editor device loss.');
    } finally {survivingExport.dispose();}
    return {contexts: count, renders, videoExport, adapter: live.stats.adapter, documentPreserved: true,
      lostDeviceStopped: true, revision};
  });
  await page.waitForFunction(() => document.querySelector('#renderer-error').hidden &&
    styk.state.renderer !== window.lostExportRenderer &&
    ['WebGPU','Canvas 2D fallback'].includes(styk.state.renderer.stats.backend));
  await page.screenshot({path: path.join(output, 'reconnected-editor.png')});
  const final = await page.evaluate(() => ({revision: styk.editor.revision,
    backend: styk.state.renderer.stats.backend,
    objects: styk.state.renderer.stats.objects, warnings: styk.state.renderer.stats.warnings,
    png: window.exportRegressionPNG}));
  assert.equal(final.revision, result.revision);
  assert.ok(final.objects > 0);
  assert.deepEqual(final.warnings || [], []);
  assert.deepEqual(errors, []);
  const xInput = page.locator('[data-field="root_x"]'), originalX = Number(await xInput.inputValue());
  await xInput.fill(String(originalX + 5)); await xInput.press('Tab');
  assert.equal(await page.evaluate(() => styk.editor.object.root_x), originalX + 5);
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => styk.editor.object.root_x), originalX);
  await writeFile(path.join(output, 'export.png'), Buffer.from(final.png.split(',')[1], 'base64'));
  const report = {...result, automaticRendererRecovery: true, recoveredBackend: final.backend, exportSurvivedDeviceLoss: true, editingAndUndo: true, errors};
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {await browser?.close(); await service.stop();}
