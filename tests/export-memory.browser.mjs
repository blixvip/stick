import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
const output = path.resolve('artifacts/export-memory');
await mkdir(output, {recursive: true});
const service = await backend.startBackend({appRoot: process.cwd()}); let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.origin + '/api/health');
  const result = await page.evaluate(async () => {
    const {ExportFrameRenderer} = await import('/src/export-frame-renderer.mjs');
    const {samplingFixture} = await import('/tests/export-sampling-fixture.mjs');
    const {exportFrameGeometry, drawExportScene} = await import('/src/export-frame-core.mjs');
    const {PlaybackResources} = await import('/src/playback-resources.mjs');
    const {downsampleExportPixels} = await import('/src/export-sampling.mjs');
    const check = (ok, message) => {if (!ok) throw new Error(message);};
    const MiB = 1024 * 1024, report = samplingFixture({kind: 'outline', opacity: .7});
    report.keyframes[0].objects[0].field28 = 60;
    // Odd output dimensions and a rotated translucent outline cross many tiles.
    const width = 769, height = 577;
    const direct = new OffscreenCanvas(width * 2, height * 2), context = direct.getContext('2d', {willReadFrequently: true});
    const resources = new PlaybackResources(), geometry = exportFrameGeometry(report, report.keyframes[0]);
    await resources.preload(geometry.drawables);
    drawExportScene(context, report, report.keyframes[0], geometry, resources);
    const expected = downsampleExportPixels(context.getImageData(0,0,width*2,height*2).data, width, height);
    resources.dispose(); direct.width = direct.height = 1;
    const renderer = new ExportFrameRenderer({width, height, smoothing: 'sprites', maxWorkingBytes: 32 * MiB});
    let max = 0, mean = 0, alphaMax = 0, stats;
    try {
      await renderer.load(report);
      for (let frame = 0; frame < 20; frame++) {
        const canvas = await renderer.renderTick(0);
        check(canvas.width === width && canvas.height === height, 'Low-memory export changed output dimensions.');
        check(renderer.stats.maxRasterTileSide <= 520, 'A supersampled tile exceeded the constrained plan.');
      }
      const actual = renderer.context.getImageData(0,0,width,height).data;
      // Compare premultiplied channels: tiny-alpha unpremultiplication amplifies
      // rounding in invisible colors. Canvas strokes also round translated paths.
      for (let i = 0; i < actual.length; i += 4) {
        alphaMax = Math.max(alphaMax, Math.abs(actual[i+3] - expected[i+3]));
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(actual[i+c]*actual[i+3]/255 - expected[i+c]*expected[i+3]/255);
          max = Math.max(max,d); mean += d;
        }
      }
      mean /= width * height * 3;
      // Repositioning Canvas paths changes edge coverage slightly even before
      // downsampling (also observable with a single translated full-size draw).
      // Bound both the worst edge delta and the whole-image error; blank rows,
      // missing tile borders and incorrect group opacity exceed these bounds.
      check(max <= 24 && alphaMax <= 24 && mean < .02, `Tile pixel error exceeds tolerance: ${JSON.stringify({max,alphaMax,mean})}`);
      stats = {...renderer.stats}; window.memoryExportPNG = renderer.canvas.toDataURL();
    } finally {renderer.dispose();}
    check(renderer.canvas.width === 1, 'Completed export retained its output pixels.');

    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {super(String(url).includes('/src/export-frame-worker.mjs') ? '/tests/export-fault-worker.mjs' : url, options);}
    };
    const faulty = new ExportFrameRenderer({width: 128, height: 96, timeoutMs: 5000});
    let errorCode;
    try {
      await faulty.load(report);
      try {await faulty.renderTick(0);} catch (error) {errorCode = error.code;}
      check(errorCode === 'export_canvas_lost', 'A lost worker canvas produced a successful frame.');
      check(faulty.canvas.width === 1 && faulty.stats.renderedFrames === 0, 'Failed export kept pixels or published a frame.');
    } finally {faulty.dispose(); window.Worker = OriginalWorker;}
    const retry = new ExportFrameRenderer({width: 128, height: 96});
    try {await retry.load(report); check((await retry.renderTick(0)).width === 128, 'Fresh export failed after context loss.');}
    finally {retry.dispose();}
    return {frames: 20, budgetMiB: 32, width, height, stats, pixelError: {max,alphaMax,mean}, injectedLoss: errorCode, retrySucceeded: true};
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'export.png'), Buffer.from((await page.evaluate(() => window.memoryExportPNG)).split(',')[1], 'base64'));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({...result, errors}, null, 2));
  console.log(JSON.stringify({...result, errors}));
} finally {await browser?.close(); await service.stop();}
