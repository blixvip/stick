/** Regression: a failing compatibility raster must degrade its object instead of
 * aborting the scene build, and a failed build must draw the stale layout rather
 * than retry the same doomed work on every frame. Runs the real WebGPU path. */
import { _electron as electron, chromium } from './support/playwright.mjs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const browser=process.argv.includes('--browser');
const app = browser?await chromium.launch({channel:'chrome',headless:true}):await electron.launch({ args: [root], cwd: root, timeout: 45000, env: { ...process.env, STYK_USER_DATA_DIR: path.join(root, 'artifacts', `raster-failure-${Date.now()}`) } });
try {
  const page = browser?await app.newPage():await app.firstWindow();
  if(browser)await page.goto(process.env.STYK_URL||'http://127.0.0.1:47843');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.styk?.ready === true, { timeout: 20000 });
  const result = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.mjs');
    const errors = [];
    window.addEventListener('error', event => errors.push(event.error?.message || String(event.error)));
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128; document.body.append(canvas);
    const renderer = await createRenderer(canvas);
    renderer.resize(256, 128, 1);
    if (renderer.stats.backend !== 'WebGPU') return { skipped: renderer.stats.backend };
    const fig = { figure_type_id: 1, segments: [], polyfills: [{ color_rgb: [240, 40, 20], alpha_raw: 0 }] };
    const object = (uid, slot, x, y) => {
      const obj = { unique_id: uid, object_slot: slot, figure_type_id: 1, root_x: x, root_y: y, scale: 1, field28: 0 }, root = { x, y };
      // A bow-tie polygon needs the even-odd compatibility raster.
      return { obj, fig, slot, root, segments: [], polys: [], drawables: [{ type: 'poly', obj, fig, slot, index: 0, poly: fig.polyfills[0], points: [[0, 0], [24, 24], [0, 24], [24, 0]].map(([dx, dy]) => ({ x: x + dx, y: y + dy })), z: 0, rgb: [240, 40, 20], alpha: 1, opacity: 1 }] };
    };
    const report = { version: 5, canvas_width: 256, canvas_height: 128, figure_types: [fig], backgrounds: [] };
    const scene = (items, previous, changed) => ({ objects: new Map(items.map(g => [g.slot, g])), orderedObjects: items, token: {}, previousToken: previous?.token, changedSlots: new Set(changed ?? items.map(g => g.slot)), warnings: [] });
    const frame = items => ({ objects: items.map(g => g.obj), background_id: 0 });
    let geometry = scene([object(1, 0, 20, 20), object(2, 1, 80, 20)]);
    const draw = (g = geometry, extra = {}) => renderer.render({ report, frame: frame(g.orderedObjects), geometry: g, view: { scale: 1, x: 0, y: 0 }, cameraEnabled: false, editorBackgroundColor: 0xffffffff, ...extra });
    draw();
    if (!renderer.stats.textureObjects) throw new Error('Fixture produced no compatibility textures.');
    const kept = renderer.entries.get(1).texture;
    if (!kept) throw new Error('Expected the first object to hold a compatibility texture.');
    // A failing raster reuses the slot's last texture and finishes the build.
    const originalRaster = renderer.rasterObject;
    renderer.rasterObject = () => { throw new Error('probe raster failure'); };
    const changed = { ...geometry.orderedObjects[0], drawables: geometry.orderedObjects[0].drawables.map(item => ({ ...item, rgb: [20, 220, 40] })) };
    geometry = scene([changed, geometry.orderedObjects[1]], geometry, [0]);
    draw();
    if (renderer.stats.rasterFailures !== 1) throw new Error(`Expected one raster failure, got ${renderer.stats.rasterFailures}`);
    if (renderer.entries.get(1).texture !== kept) throw new Error('Failed raster did not retain the previous texture.');
    if (!['layout', 'incremental'].includes(renderer.stats.preparation)) throw new Error(`Build did not complete: ${renderer.stats.preparation}`);
    // With no previous texture, the object degrades to vector shapes.
    renderer.rasterCache.clear();
    geometry = scene([{ ...changed, drawables: changed.drawables.map(item => ({ ...item, rgb: [40, 40, 220] })) }, object(3, 2, 140, 20)], geometry, [0, 2]);
    draw();
    const degraded = renderer.entries.get(1);
    if (!degraded) throw new Error('Degraded object lost its layout entry.');
    if (degraded.texture) throw new Error('Degraded object kept a destroyed texture.');
    // A whole-build failure keeps drawing the stale layout without per-frame retry.
    const originalPrepare = renderer.prepare;
    let attempts = 0;
    renderer.prepare = () => { attempts++; throw new Error('probe prepare failure'); };
    renderer.generation++; // force a full rebuild (canUpdate === false)
    draw();
    if (renderer.stats.prepareFailures !== 1 || renderer.stats.preparation !== 'failed') throw new Error(`Prepare failure was not recorded: ${JSON.stringify({ failures: renderer.stats.prepareFailures, preparation: renderer.stats.preparation })}`);
    draw();
    if (attempts !== 1) throw new Error(`Failed prepare retried on identical inputs: ${attempts} attempts`);
    // A real input change retries the build once.
    geometry = scene([geometry.orderedObjects[0], object(4, 3, 200, 20)], geometry);
    draw();
    if (attempts !== 2) throw new Error(`Changed inputs did not retry the build: ${attempts} attempts`);
    renderer.prepare = originalPrepare;
    renderer.rasterObject = originalRaster;
    geometry = scene(geometry.orderedObjects, geometry);
    draw();
    if (renderer.stats.preparation === 'failed') throw new Error('Renderer stayed in the failed state after recovery.');
    await new Promise(resolve => setTimeout(resolve, 30)); // flush microtask rethrows
    if (!errors.some(message => /probe (raster|prepare) failure/.test(message))) throw new Error(`Telemetry lost the renderer error: ${JSON.stringify(errors)}`);
    return { rasterFailures: renderer.stats.rasterFailures, prepareFailures: renderer.stats.prepareFailures, errors: errors.length };
  });
  console.log(JSON.stringify(result));
} finally { await app.close(); }
