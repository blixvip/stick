/** Browser-side audit kernels. Run through the collaborative preview, not UI
 * automation attached to the source Electron timing runs. Owns its resources.
 */
import {createRenderer} from '../src/renderer.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {createVfx} from '../src/vfx.mjs';
import {vfxGPUStats, releaseVfxGPU} from '../src/vfx-gpu.mjs';

const summary = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return {medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
    maxMs: sorted.at(-1), samples: values};
};

export async function rendererCase(scenario = 'none', count = 1000, forceCanvas2D = false) {
  releaseVfxGPU();
  const report = emptyDocument(); report.canvas_width = 1280; report.canvas_height = 720;
  const objects = Array.from({length: count}, (_, i) => createObject(report.figure_types[0], i + 1,
    25 + (i % 50) * 25 + (scenario === 'offscreen' && i % 10 ? 10000 : 0),
    50 + Math.floor(i / 50) * 33, {scale: .15}));
  const frame = createFrame(objects, 60); report.keyframes = [frame];
  if (scenario === 'scene-bloom') frame._stykVfx = {figure: [createVfx('bloom', 'bloom')]};
  if (scenario === 'object-glow') for (let i = 0; i < 100; i++) objects[i]._stykVfx = {figure: [createVfx('glow', 'glow')]};
  const canvas = document.createElement('canvas'), renderer = await createRenderer(canvas, {forceCanvas2D});
  renderer.resize(1280, 720, 1);
  const start = performance.now(), geometry = buildGeometry(report, frame), geometryMs = performance.now() - start;
  const submit = [], completion = [], coldStart = performance.now();
  try {
    renderer.render({report, frame, geometry, view: {x: 0, y: 0, scale: 1}, cameraEnabled: true});
    await renderer.device?.queue.onSubmittedWorkDone(); const coldMs = performance.now() - coldStart;
    for (let i = 0; i < 32; i++) {
      const at = performance.now();
      renderer.render({report, frame, geometry, view: {x: 0, y: 0, scale: 1}, cameraEnabled: true,
        dragTranslations: new Map([[1, {x: i % 3, y: 0}]])});
      const cpuMs = performance.now() - at;
      await renderer.device?.queue.onSubmittedWorkDone();
      if (i >= 8) { submit.push(cpuMs); completion.push(performance.now() - at); }
    }
    return {scenario, count, forceCanvas2D, resolution: [1280, 720], geometryMs, coldMs,
      backend: renderer.stats.backend, adapter: renderer.stats.adapter,
      submit: summary(submit), completion: summary(completion), vfx: {...vfxGPUStats()},
      primitives: geometry.drawables.length, userAgent: navigator.userAgent,
      limitations: ['Synthetic ten-segment native figures; retained geometry, translation only.',
        '24 warm samples after 8 discarded frames; completion uses an explicit GPU queue fence.',
        'Collaborative preview Electron/Chromium differs from source app Electron. This is neither rAF FPS nor physical input latency.',
        'Offscreen scenario also spreads figures beyond vertical stage bounds; no candidate culling implementation is measured.']};
  } finally { renderer.destroy(); releaseVfxGPU(); canvas.width = canvas.height = 1; }
}

export async function libraryCardsCase(count = 1000) {
  const {UserLibrary} = await import('../src/user-library.mjs');
  const {appendLocalized, replaceLocalized, connectTranslations} = await import('../src/localization-bindings.mjs');
  const owner = Object.create(UserLibrary.prototype), host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;width:600px'; document.body.append(host);
  const items = Array.from({length: count}, (_, i) => ({path: `fixture-${i}.stk`, name: `Figure ${i}`, kind: 'figure'}));
  const rows = []; let completeMarkup;
  try {
    for (let pass = 0; pass < 4; pass++) for (const mode of pass % 2 ? ['batch-prototype', 'production', 'window-prototype'] : ['production', 'batch-prototype', 'window-prototype']) {
      replaceLocalized(host);
      const active = mode === 'window-prototype' ? items.slice(0, 40) : items;
      const at = performance.now();
      if (mode === 'production') for (const item of active) appendLocalized(host, owner.card(item));
      else {
        const fragment = document.createDocumentFragment();
        for (const item of active) fragment.append(owner.card(item));
        host.append(fragment); connectTranslations(host);
      }
      // Include style/layout materialization for the realized cards.
      host.getBoundingClientRect();
      const elapsedMs = performance.now() - at;
      if (host.querySelectorAll('.library-card').length !== active.length) throw new Error('Card count differs.');
      if (host.querySelector('.library-name')?.textContent !== items[0].name) throw new Error('Card label differs.');
      if (mode !== 'window-prototype') {
        completeMarkup ??= host.innerHTML;
        if (host.innerHTML !== completeMarkup) throw new Error('Batch insertion changed card markup.');
      }
      rows.push({pass, mode, elapsedMs, cards: active.length, domNodes: host.querySelectorAll('*').length});
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return {count, rows, identicalCompleteMarkup: true, summary: Object.fromEntries(['production', 'batch-prototype', 'window-prototype']
      .map(mode => [mode, summary(rows.filter(row => row.mode === mode && row.pass).map(row => row.elapsedMs))])),
      userAgent: navigator.userAgent,
      limitations: ['Real current card builder and translation registration, synthetic local metadata.',
        'Excludes thumbnail decode, file listing, selection and search filtering; hidden fixture host retains measurable DOM/layout.',
        'Window projection creates only first 40 cards; it is not a complete accessible virtualization implementation.']};
  } finally { replaceLocalized(host); host.remove(); }
}
