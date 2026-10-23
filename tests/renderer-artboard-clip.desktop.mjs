import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';

// The WebGPU artboard clip must follow the artboard at fractional pixel ratios
// (110% and 125% display scaling), at any pan and with a rotated camera.
const root = path.resolve('.'), output = path.join(root, 'artifacts', 'renderer-artboard-clip');
await mkdir(output, {recursive: true});
const app = await electron.launch({args: [root], cwd: root, timeout: 45000,
  env: {...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`)}});
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const s = styk.state, r = s.renderer, e = styk.editor, samples = [];
    if (!r.device) return {backend: r.stats.backend, samples};
    styk.fit();
    for (const dpr of [1.1, 1.25]) for (const [panX, panY, angle] of [[0, 0, 0], [63.4, 11.7, 0], [-120.2, -30.5, 0], [20, 10, .3]]) {
      const view = {...s.view, x: s.view.x + panX, y: s.view.y + panY};
      r.resize(r.canvas.clientWidth, r.canvas.clientHeight, dpr);
      const frame = {...e.evaluatedFrame, camera: {...(e.evaluatedFrame.camera || {}), angle_rad: angle}};
      // Capture in the same task as the render, before presentation.
      r.render({report: e.report, frame, geometry: e.geometry, view, hiddenUids: new Set(), dragTranslations: new Map(), onionFrames: [], clipToCanvas: false});
      const copy = document.createElement('canvas'); copy.width = r.canvas.width; copy.height = r.canvas.height;
      const ctx = copy.getContext('2d', {willReadFrequently: true}); ctx.drawImage(r.canvas, 0, 0);
      // Edges panned off the canvas are not sampled.
      const alpha = (x, y) => { const px = Math.round(x * dpr), py = Math.round(y * dpr); return px < 0 || py < 0 || px >= copy.width || py >= copy.height ? null : ctx.getImageData(px, py, 1, 1).data[3]; };
      const w = e.report.canvas_width * view.scale, h = e.report.canvas_height * view.scale;
      samples.push({dpr, panX, angle, left: alpha(view.x + 4, view.y + h / 2), right: alpha(view.x + w - 4, view.y + h / 2),
        top: alpha(view.x + w / 2, view.y + 4), bottom: alpha(view.x + w / 2, view.y + h - 4), outside: alpha(view.x - 6, view.y + h / 2)});
    }
    return {backend: r.stats.backend, samples};
  });
  assert.deepEqual(errors, []);
  if (!result.samples.length) console.log(`SKIP: ${result.backend} (no WebGPU device)`);
  assert.ok(result.samples.every(sample => sample.left !== null || sample.right !== null), 'Every view must sample an artboard edge.');
  for (const sample of result.samples) {
    // A rotated camera keeps the artboard in place; its background covers the edges.
    for (const edge of ['left', 'right', 'top', 'bottom']) if (sample[edge] !== null) assert.equal(sample[edge], 255, `Artboard ${edge} edge is not painted at ${JSON.stringify(sample)}`);
    if (sample.outside !== null) assert.equal(sample.outside, 0, `Background leaked outside the artboard at ${JSON.stringify(sample)}`);
  }
  console.log(JSON.stringify(result));
} finally { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); }
