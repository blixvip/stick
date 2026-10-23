/** Compatibility rendering during gestures: layered frames match full repaints,
 * layers are reused while posing, moving and panning, and a scene larger than
 * the raster budget no longer re-rasterizes every figure on each repaint. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 850}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', {value: undefined}));
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  const result = await page.evaluate(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const {defaultFigure, createFrame, createObject} = await import('/src/demo.mjs');
    const figure = defaultFigure(), objects = [];
    for (let i = 0; i < 48; i++) objects.push(createObject(figure, i + 1, 60 + (i % 12) * 45, 120 + Math.floor(i / 12) * 90));
    const report = {version: 5, canvas_width: 640, canvas_height: 480, fps: 12, backgrounds: [], figure_types: [figure], keyframes: [createFrame(objects)]};
    styk.editor.markSaved();
    await styk.acceptImport({document: report, kind: 'piv'}, 'Layers.piv');
    await new Promise(resolve => setTimeout(resolve, 300));
    const renderer = styk.state.renderer, editor = styk.editor, canvas = renderer.canvas;
    if (renderer.stats.backend !== 'Canvas 2D fallback') throw new Error('The compatibility renderer is not active.');
    const pixels = () => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    // Compare premultiplied values: the workspace outside the artboard is
    // transparent, where unpremultiplied colors of alpha 5 versus 6 swing by 40.
    const compare = (a, b) => {let max = 0, changed = 0, total = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 4; c++) {
      const d = Math.abs((c === 3 ? a[i + 3] : a[i + c] * a[i + 3] / 255) - (c === 3 ? b[i + 3] : b[i + c] * b[i + 3] / 255));
      if (d >= 1) changed++; if (d > max) max = d; total += d;} return {max: Math.round(max), changed, mean: +(total / a.length).toFixed(3)};};
    const base = {report: editor.report, view: {...styk.state.view}, cameraEnabled: false, clipToCanvas: false, onionFrames: [], showHandles: false};
    const frame = () => ({frame: editor.evaluatedFrame, geometry: editor.geometry});
    const checks = {};
    // A gesture before any figure changes composites every figure into one layer.
    renderer.render({...base, ...frame()});
    renderer.render({...base, ...frame(), liveEditing: true});
    const layered = pixels(); renderer.render({...base, ...frame()});
    checks.idle = compare(layered, pixels());
    // Posing one figure: it becomes the live range; others reuse layers.
    const uid = editor.report.keyframes[0].objects[20].unique_id;
    editor.select(uid, 1); editor.beginDrag('Pose joint');
    const reuses = () => renderer.stats.sceneLayerReuses || 0, builds = () => renderer.stats.sceneLayerBuilds || 0;
    renderer.render({...base, ...frame(), liveEditing: true});
    const g = editor.geometry.objects.get(editor.selectedSlot), end = g.segments.find(segment => !segment.static)?.end;
    const buildsBefore = builds(), reusesBefore = reuses();
    for (let step = 1; step <= 4; step++) {
      editor.poseJoint(end.x + step * 6, end.y - step * 4);
      renderer.render({...base, ...frame(), liveEditing: true});
    }
    checks.poseBuilds = builds() - buildsBefore; checks.poseReuses = reuses() - reusesBefore;
    const posed = pixels(); renderer.render({...base, ...frame()});
    checks.pose = compare(posed, pixels());
    editor.commitDrag();
    // Moving whole figures uses drag translations over the same layers.
    const translations = new Map([[uid, {x: 23, y: -11}]]);
    renderer.render({...base, ...frame(), liveEditing: true, dragTranslations: translations});
    translations.set(uid, {x: 31, y: -7});
    const moveReuses = reuses(); renderer.render({...base, ...frame(), liveEditing: true, dragTranslations: translations});
    checks.moveReused = reuses() > moveReuses;
    const moved = pixels(); renderer.render({...base, ...frame(), dragTranslations: translations});
    checks.move = compare(moved, pixels());
    // Panning by whole device pixels blits the layer at an offset.
    renderer.render({...base, ...frame(), liveEditing: true});
    const panReuses = reuses(), view = {...base.view, x: base.view.x + 17 / renderer.dpr, y: base.view.y - 9 / renderer.dpr};
    renderer.render({...base, view, ...frame(), liveEditing: true});
    checks.panReused = reuses() > panReuses;
    const panned = pixels(); renderer.render({...base, view, ...frame()});
    checks.pan = compare(panned, pixels());
    // Over budget, figures drawn this frame are never evicted for others.
    renderer.clearArtwork(); renderer.artworkBudget = 64 * 1024;
    renderer.render({...base, ...frame()}); const rasterized = renderer.stats.rasterizedObjects || 0;
    renderer.render({...base, ...frame()}); checks.repeatRasters = (renderer.stats.rasterizedObjects || 0) - rasterized;
    checks.budget = renderer.artworkBytes <= renderer.artworkBudget;
    const budgeted = pixels(); renderer.artworkBudget = undefined; renderer.clearArtwork(); renderer.render({...base, ...frame()});
    checks.budgetPixels = compare(budgeted, pixels());
    return checks;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  // Layers around edited figures are pixel-exact. A view-only layer carries a
  // pan margin, under which Canvas resamples cached figures slightly
  // differently on edges; the release frame repaints exactly.
  for (const name of ['pose', 'move']) assert.ok(result[name].max <= 2, `${name} layers must match a full repaint: ${JSON.stringify(result[name])}`);
  for (const name of ['idle', 'pan']) assert.ok(result[name].max <= 20, `${name} layers must match a full repaint within edge resampling: ${JSON.stringify(result[name])}`);
  assert.equal(result.poseBuilds, 1, 'only the first changed pose builds layers');
  assert.ok(result.poseReuses >= 3 && result.moveReused && result.panReused, JSON.stringify(result));
  assert.ok(result.budget, 'the raster cache stays within its budget');
  assert.ok(result.repeatRasters < 48, `an over-budget scene must not re-rasterize every figure: ${result.repeatRasters}`);
  // Figures that do not fit draw as vectors instead of resampled rasters;
  // only antialiased edges differ (vectors are slightly crisper).
  assert.ok(result.budgetPixels.mean < 2, `direct drawing matches cached artwork: ${JSON.stringify(result.budgetPixels)}`);
  console.log('Compatibility layers: layered gestures match full repaints and reuse their composites.');
} finally { await browser.close(); }
