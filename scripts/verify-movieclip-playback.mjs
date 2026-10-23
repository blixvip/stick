// Read-only source-file probe of real app playback after a library movieclip insertion.
import {chromium} from '../tests/support/playwright.mjs';
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

import {corpusPath} from '../tests/support/corpus.mjs';
const source = process.argv[2] || corpusPath('Downloads/16 Akane vs Akato Segundo round (2).piv');
const clip = process.argv[3] || corpusPath('Documents/StykAnimate/library/Flash aura.stykmov');
const output = path.resolve(process.env.STYK_PROBE_OUTPUT || 'artifacts/akane-flash-aura');
await mkdir(output, {recursive: true});
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const original = await Promise.all([source, clip].map(digest));
const browser = await chromium.launch({channel: 'chrome', headless: true});
const result = {source, clip, errors: [], runs: []};
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 950}});
  if (process.env.STYK_PROBE_BASELINE) for (const name of ['renderer', 'prepared-frames']) {
    const body = await readFile(path.join(process.env.STYK_PROBE_BASELINE, `${name}.before.mjs`), 'utf8');
    await page.route(`**/src/${name}.mjs`, route => route.fulfill({body, contentType: 'text/javascript'}));
  }
  page.on('pageerror', error => {result.errors.push(error.message); console.log('PAGE ERROR', error.message);});
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  if (process.env.STYK_PROBE_MODE) await page.evaluate(mode => styk.settingsUI.commit({timelineMode: mode}), process.env.STYK_PROBE_MODE);
  await page.evaluate(() => styk.editor.markSaved());
  await page.locator('#file-input').setInputFiles(source);
  await page.waitForFunction(name => !styk.state.importing && styk.editor.name === name, path.basename(source, '.piv'), {timeout: 180000});
  result.scene = await page.evaluate(() => ({frames: styk.editor.report.keyframes.length, ticks: styk.editor.totalTicks,
    fps: styk.editor.report.fps, width: styk.editor.report.canvas_width, height: styk.editor.report.canvas_height,
    layerSheet: Boolean(styk.editor.report._styk?.layerSheet), mode: styk.state.settings.timelineMode}));
  console.log('LOADED', JSON.stringify(result.scene));
  await page.evaluate(async encoded => {
    const {ImportClient} = await import('/src/import-client.mjs');
    const importer = new ImportClient();
    try {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const imported = await importer.importFile(new File([bytes], 'Flash aura.stykmov'));
      window.auraDocument = imported.document;
    } finally {importer.dispose();}
    const renderer = styk.state.renderer;
    if (!renderer.device) throw new Error('This probe requires WebGPU.');
    const surface = new OffscreenCanvas(128, 96), context = surface.getContext('2d', {willReadFrequently: true});
    const probe = window.movieclipProbe = {frames: [], gpuErrors: [], failures: [], captures: [], uid: null};
    renderer.device.addEventListener('uncapturederror', event => probe.gpuErrors.push(event.error.message));
    const render = renderer.renderPrepared.bind(renderer);
    renderer.renderPrepared = (key, options) => {
      let ok;
      try {ok = render(key, options);} catch (error) {probe.failures.push({tick: styk.editor.tick, message: error.message}); throw error;}
      if (styk.state.playing && probe.frames.at(-1)?.tick !== styk.editor.tick) {
        context.clearRect(0, 0, 128, 96); context.drawImage(renderer.canvas, 0, 0, 128, 96);
        const pixels = context.getImageData(0, 0, 128, 96).data;
        let visible = 0, colored = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 32) {
          visible++; if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 240) colored++;
        }
        const packet = styk.state.playbackPacket;
        const sample = {tick: styk.editor.tick, key, ok, visible, colored, objects: packet?.objectCount,
          primitives: renderer.stats.primitives, packetBytes: packet?.byteLength,
          gpuBytes: renderer.preparedFrames.bytes, reduced: packet?.previewQuality,
          clipPresent: probe.uid !== null && packet?.uids.includes(probe.uid)};
        probe.frames.push(sample);
        if (!ok || visible === 0 || colored === 0 || sample.clipPresent) probe.captures.push({tick: sample.tick, png: renderer.canvas.toDataURL()});
      }
      return ok;
    };
  }, (await readFile(clip)).toString('base64'));
  const middle = Number(process.env.STYK_PROBE_TICK || Math.floor(result.scene.ticks / 2));
  const start = Math.max(0, middle - 8), end = Math.min(result.scene.ticks, middle + 24);
  async function run(name, first = start, last = end) {
    await page.evaluate(({first, last}) => {
      styk.state.loop = false; styk.state.loopRange = {startTick: first, endTick: last};
      styk.editor.seek(first); movieclipProbe.frames = []; movieclipProbe.captures = [];
    }, {first, last});
    await page.waitForFunction(() => !styk.state.editablePreparing);
    await page.locator('#play-button').click();
    await page.waitForFunction(() => !styk.state.playing, null, {timeout: 120000});
    await page.waitForFunction(() => !styk.state.editablePreparing, null, {timeout: 30000});
    const state = await page.evaluate(() => ({...movieclipProbe, performance: styk.performance()}));
    for (const capture of state.captures) await writeFile(path.join(output, `${name}-${capture.tick}.png`), Buffer.from(capture.png.split(',')[1], 'base64'));
    delete state.captures;
    result.runs.push({name, first, last, ...state});
    await page.screenshot({path: path.join(output, `${name}.png`)});
    console.log('RUN', JSON.stringify({name, frames: state.frames.length, expected: last - first,
      blank: state.frames.filter(f => !f.ok || !f.visible || !f.colored).map(f => f.tick), gpuErrors: state.gpuErrors, failures: state.failures,
      insertedFrames: state.frames.filter(f => f.clipPresent).map(f => f.tick)}));
    await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  }
  await run('before-insertion');
  result.insertion = await page.evaluate(middle => {
    const e = styk.editor; e.seek(middle);
    const prior = e.evaluatedFrame.objects.length, revision = e.revision;
    e.importFigure(auraDocument, {position: {x: e.report.canvas_width / 2, y: e.report.canvas_height / 2}});
    movieclipProbe.uid = e.selectedUid;
    return {tick: middle, frameIndex: e.frameIndex, uid: e.selectedUid, beforeObjects: prior,
      afterObjects: e.evaluatedFrame.objects.length, beforeRevision: revision, afterRevision: e.revision};
  }, middle);
  console.log('INSERTED', JSON.stringify(result.insertion));
  await run('after-insertion');
  await run('replay-insertion', middle, end);
  await page.evaluate(() => styk.editor.undo()); await run('undo-insertion');
  await page.evaluate(() => styk.editor.redo()); await run('redo-insertion');
  if (process.env.STYK_PROBE_FULL === '1') {
    await run('full-animation', 0, result.scene.ticks);
    await run('full-replay', 0, result.scene.ticks);
  }
  assert.deepEqual(await Promise.all([source, clip].map(digest)), original, 'Source files changed.');
  result.sourcesUnchanged = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(result.errors, []);
  for (const run of result.runs) {
    assert.equal(run.frames.length, run.last - run.first, `${run.name}: incomplete playback`);
    assert.deepEqual(run.gpuErrors, []); assert.deepEqual(run.failures, []);
    run.frames.forEach((frame, i) => {
      assert.equal(frame.tick, run.first + i); assert.ok(frame.ok && frame.visible && frame.colored, `${run.name}: blank tick ${frame.tick}`);
    });
    const shouldContainClip = !['before-insertion', 'undo-insertion'].includes(run.name);
    assert.equal(Boolean(run.frames.find(frame => frame.tick === middle)?.clipPresent), shouldContainClip, `${run.name}: movieclip presence changed`);
  }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
