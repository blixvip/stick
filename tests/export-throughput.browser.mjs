import {chromium} from './support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import backend from '../desktop/backend.cjs';
const label = process.argv.includes('--before') ? 'before' : 'after';
const output = path.resolve('artifacts/export-throughput');
await mkdir(output, {recursive: true});
const service = await backend.startBackend({appRoot: process.cwd()});
let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.origin + '/api/health');
  const result = await page.evaluate(async () => {
    const {ExportFrameRenderer} = await import('/src/export-frame-renderer.mjs');
    const {samplingFixture} = await import('/tests/export-sampling-fixture.mjs');
    const report = samplingFixture({kind: 'outline', opacity: .7});
    const object = report.keyframes[0].objects[0];
    for (const frame of report.keyframes) {
      frame.objects = Array.from({length: 100}, (_, i) => ({...object, unique_id: i + 1}));
      frame.object_draw_order = frame.objects.map((_, i) => i);
    }
    const {exportFrameGeometry} = await import('/src/export-frame-core.mjs');
    const drawables = exportFrameGeometry(report, report.keyframes[0]).drawables.length;
    if (drawables < 100) throw new Error('Dense fixture omitted figures.');
    const renderer = new ExportFrameRenderer({width: 3840, height: 2160, smoothing: 'sprites', maxWorkingBytes: 256 * 1024 * 1024});
    const samples = [];
    try {
      await renderer.load(report);
      for (let i = 0; i < 3; i++) {
        const start = performance.now(); await renderer.renderTick(0);
        samples.push({wallMs: performance.now() - start, ...renderer.stats});
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', renderer.context.getImageData(0, 0, 3840, 2160).data))].map(n => n.toString(16).padStart(2, '0')).join('');
      return {width: renderer.width, height: renderer.height, figures: 100, drawables, smoothing: 'sprites', samples, hash};
    } finally {renderer.dispose();}
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, label + '.json'), JSON.stringify({...result, errors}, null, 2));
  console.log(JSON.stringify(result));
} finally {await browser?.close(); await service.stop();}
