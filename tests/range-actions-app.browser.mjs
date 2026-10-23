/** Real timeline range selection, canvas/inspector commands, atomic undo and worker output. */
import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {objectBounds} from '../src/renderer-geometry.mjs';
const {startBackend} = createRequire(import.meta.url)('../desktop/backend.cjs');
const appRoot = fileURLToPath(new URL('..', import.meta.url)), out = path.join(appRoot, 'artifacts');
await mkdir(out, {recursive: true});
const report = emptyDocument(); report.canvas_width = 720; report.canvas_height = 430;
report.keyframes = [0, 1, 2, 3].map(index => createFrame([
  createObject(report.figure_types[0], 1, 140 + index * 25, 270, {angles: report.figure_types[0].segments.map(segment => segment.angle_rad + (index + 1) * .13), scale: .65 + index * .04}),
  createObject(report.figure_types[0], 2, 440 - index * 15, 250, {angles: report.figure_types[0].segments.map(segment => segment.angle_rad - index * .1), scale: .7}),
  createObject(report.figure_types[0], 3, 610, 290, {scale: .5}),
], 10));
const sourcePath = path.join(out, 'range-actions-source.styk'), joinedPath = path.join(out, 'range-actions-joined.styk');
await writeFile(sourcePath, JSON.stringify(new Editor({demo: false}).load(report).serialize()));
const joined = structuredClone(report);
for (const frame of joined.keyframes) frame.objects[0].join = {target_object_slot: 1, target_unique_id: 2, target_handle_id: 1};
await writeFile(joinedPath, JSON.stringify(new Editor({demo: false}).load(joined).serialize()));
const backend = await startBackend({appRoot}), checks = [], errors = []; let browser, page;
const firstCase = Number(process.env.RANGE_FROM || 0); let caseIndex = 0;
const object = (frame, uid) => frame.objects.find(object => object.unique_id === uid);
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  page = await browser.newPage({viewport: {width: 1500, height: 1020}}); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(backend.origin); await page.waitForFunction(() => styk?.ready);
  await page.evaluate(async () => {
    const {PlaybackCache} = await import('/src/playback.mjs'), original = PlaybackCache.prototype.prepareRange;
    PlaybackCache.prototype.prepareRange = function(...args) {globalThis.rangePlayback = this; return original.apply(this, args);};
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Sheet edits write pose sources, never report.keyframes — compare evaluated
  // output at each native frame's start tick instead. The top-level _styk only
  // identifies which source pose was sampled; content comparisons ignore it.
  const frames = () => page.evaluate(async () => {
    const {evaluatedFrame} = await import('/src/pivot/geometry.mjs');
    return styk.editor.timeline.map(row => {
      const {_styk, ...frame} = evaluatedFrame(styk.editor.report, row.index, 0, row.start);
      return JSON.parse(JSON.stringify(frame));
    });
  });
  async function point(uid, handle = 0) {
    return page.evaluate(({uid, handle}) => {
      const geometry = [...styk.editor.geometry.objects.values()].find(g => g.obj.unique_id === uid), p = geometry.joints.get(handle), rect = document.querySelector('#viewport').getBoundingClientRect(), view = styk.state.view;
      return {x: rect.left + view.x + p.x * view.scale, y: rect.top + view.y + p.y * view.scale, scale: view.scale};
    }, {uid, handle});
  }
  async function selectFigure(uid, modifiers) {
    await page.evaluate(({uid, add}) => styk.editor.select(uid, -1, {add}), {uid, add: Boolean(modifiers?.includes('Control'))});
    await settle();
  }
  const cellPoint = (uid, tick) => page.evaluate(({uid, tick}) => {
    const t = styk.timeline, row = t.tracks.findIndex(track => track.id === styk.editor.layerForUid(uid)), r = t.scroll.getBoundingClientRect();
    return {x: r.left + (tick + .5) * t.pxPerTick - t._offsetX(), y: r.top + t.rowY(row) + t.rowSize(row) / 2};
  }, {uid, tick});
  async function resetRange(file = sourcePath) {
    // Each run opens a fresh copy of the source in place of the last one: projects open in tabs of their own,
    // so the previous run's project closes first (its changes are discarded) and the file takes its place.
    await page.evaluate(async () => {globalThis.previousRangeReport = styk.editor.report; styk.editor.markSaved(); await styk.projects.close();});
    const choosing = page.waitForEvent('filechooser');
    await page.locator('#viewport').focus();
    await page.keyboard.press('Control+o');
    await (await choosing).setFiles(file);
    await page.waitForFunction(() => styk.editor.report !== globalThis.previousRangeReport || document.querySelector('#discard-changes'));
    if (await page.locator('#discard-changes').count()) await page.locator('#discard-changes').click();
    await page.waitForFunction(() => styk.editor.report !== globalThis.previousRangeReport); await settle();
    await selectFigure(1);
    // Sheet ranges are contiguous columns: click frame 1, Shift-click frame 3.
    await page.mouse.click(...Object.values(await cellPoint(1, 0)));
    await page.keyboard.down('Shift');
    await page.mouse.click(...Object.values(await cellPoint(1, 20)));
    await page.keyboard.up('Shift');
    await settle(); await selectFigure(1);
    assert.deepEqual(await page.evaluate(() => styk.state.rangeIndices), [0, 1, 2]);
    await page.locator('#apply-range-movement').check(); await settle();
    assert.equal(await page.evaluate(() => styk.state.applyRange), true);
  }
  async function menuAction(action) {
    const uid = await page.evaluate(() => styk.editor.selectedUid), p = await point(uid);
    await page.mouse.click(p.x, p.y, {button: 'right'});
    await page.locator(`#menu [data-action="${action}"]`).click(); await settle();
  }
  async function numeric(key, value) {const input = page.locator(`[data-property="${key}"]`); await input.fill(String(value)); await input.press('Enter'); await settle();}
  async function workerMatches() {
    await page.waitForFunction(() => styk.state.playbackRevision === styk.editor.revision && globalThis.rangePlayback?.report === styk.editor.report);
    const result = await page.evaluate(async () => {
      const {compilePlaybackPacket} = await import('/src/playback-worker.mjs'), rows = [];
      for (const tick of [0, 10, 20, 30]) {
        await rangePlayback.prepareRange([tick]); const actual = rangePlayback.get(tick), expected = await compilePlaybackPacket(styk.editor.report, tick, {scale: rangePlayback.scale});
        rows.push({tick, equal: JSON.stringify([...actual.shapes]) === JSON.stringify([...expected.shapes]) && JSON.stringify([...actual.transforms]) === JSON.stringify([...expected.transforms])});
      }
      return rows;
    });
    assert.ok(result.every(row => row.equal), `Worker range mismatch: ${JSON.stringify(result)}`);
  }
  async function exercise(name, operation, verify, {file = sourcePath, setup} = {}) {
    if (caseIndex++ < firstCase) return;
    console.log('CHECK', name);
    await resetRange(file); if (setup) await setup();
    const before = await frames(), history = await page.evaluate(() => styk.editor._undo.length);
    await operation(); await settle(); const after = await frames();
    assert.equal(await page.evaluate(() => styk.editor._undo.length), history + 1, `${name} must be one undo command`);
    for (const index of [3]) assert.deepEqual(after[index], before[index], `${name} changed unselected frame ${index}`);
    for (const index of [0, 1, 2]) {assert.notDeepEqual(after[index], before[index], `${name} did not change selected frame ${index}`); verify?.(after[index], before[index], index);}
    await workerMatches();
    await page.locator('#viewport').click({position: {x: 5, y: 5}}); await page.keyboard.press('Control+z'); await settle();
    assert.deepEqual(await frames(), before, `${name} undo did not restore exact native frames`); await workerMatches();
    checks.push(name); console.log('PASS', name);
  }
  await exercise('Insert dialog adds one common identity only in selected native frames', async () => {
      await page.locator('#open-insert').click();
      await page.getByRole('menuitem', {name: 'Stick figure', exact: true}).click();
    },
    (after, before) => {assert.equal(after.objects.length, before.objects.length + 1); assert.ok(after.objects.some(o => o.unique_id > 3));});
  await exercise('Asset library insertion honors the selected frame range', async () => {await page.locator('#open-insert').click(); await page.getByRole('menuitem', {name: /^All .*in this project/}).click(); await page.locator('#asset-list .styk-asset-row').first().click();},
    (after, before) => assert.equal(after.objects.length, before.objects.length + 1));
  await exercise('Duplicate preserves each selected frame’s distinct source pose', () => page.evaluate(() => styk.actions.duplicate()),
    (after, before) => {const copy = after.objects.find(o => o.unique_id > 3); assert.ok(copy); assert.deepEqual(copy.angles, object(before, 1).angles); assert.equal(copy.scale, object(before, 1).scale);});
  await exercise('Delete removes the selected identity across the selected range', () => menuAction('delete'), after => assert.equal(object(after, 1), undefined));
  await exercise('Figure color applies only to the chosen identity in selected frames', async () => {await page.locator('#figure-color').fill('#123456'); await page.locator('#figure-color').dispatchEvent('change');},
    (after, before) => {const g=buildGeometry(report,after).objects.get(object(after,1).object_slot); for(const segment of g.segments)assert.deepEqual(segment.rgb,[18,52,86]); assert.deepEqual(object(after, 2), object(before, 2));});
  await exercise('Opacity numeric input applies to the native range atomically', () => numeric('figure_opacity', 50), after => assert.equal(object(after, 1).field28, 128));
  await exercise('Position numeric input applies the absolute value to each selected frame', () => numeric('root_x', 240), after => assert.equal(object(after, 1).root_x, 240));
  await exercise('Scale numeric input preserves each frame’s pose while changing scale', () => numeric('scale', 80),
    (after, before) => {assert.equal(object(after, 1).scale, .8); assert.deepEqual(object(after, 1).angles, object(before, 1).angles);});
  await exercise('Horizontal mirror updates each selected frame’s own pose', () => page.evaluate(() => styk.actions.mirror()),
    (after, before) => assert.notDeepEqual(object(after, 1).angles, object(before, 1).angles));
  await exercise('Rotate button adds 15 degrees to each selected frame’s own pose', () => page.evaluate(() => styk.actions.rotate()),
    (after, before) => {object(after, 1).angles.forEach((angle, index) => assert.ok(Math.abs(angle - object(before, 1).angles[index] - Math.PI / 12) < 1e-9)); assert.equal(object(after, 1).root_x, object(before, 1).root_x);});
  await exercise('Center button centers the root independently in each selected frame', () => page.evaluate(() => styk.actions.center()),
    (after, before) => {assert.equal(object(after, 1).root_x, 360); assert.equal(object(after, 1).root_y, 215); assert.deepEqual(object(after, 1).angles, object(before, 1).angles);});
  await exercise('Reset pose restores native definition angles in every selected frame', () => page.evaluate(() => styk.actions['reset-pose']()),
    (after, before) => {assert.deepEqual(object(after, 1).angles, report.figure_types[0].segments.map(segment => segment.angle_rad)); assert.equal(object(after, 1).len_flag, 0); assert.equal(object(after, 1).bend_flag, 0); assert.equal(object(after, 1).root_x, object(before, 1).root_x); assert.equal(object(after, 1).scale, object(before, 1).scale);});
  await exercise('Align left uses each selected frame’s actual shape bounds', () => page.evaluate(() => styk.actions['align-left']()),
    (after, before) => {
      const bounds = frame => [...buildGeometry(report, frame).objects.values()].filter(g => [1, 2].includes(g.obj.unique_id))
        .map(g => objectBounds([...g.segments.map(s => ({...s, type: s.seg.segment_type || 'line'})), ...g.polys]));
      const expected = Math.min(...bounds(before).map(b => b.x));
      for (const b of bounds(after)) assert.ok(Math.abs(b.x - expected) < .001);
      assert.deepEqual(object(after, 3), object(before, 3));
    }, {setup: () => selectFigure(2, ['Control'])});
  await exercise('Bring to front changes painter order in selected frames only', () => page.locator('#properties-panel [data-action="layer-front"]').click(), after => assert.equal(after.object_draw_order_unique_ids.at(-1), 1));
  await exercise('Copy and Paste inserts the clipboard pose into the selected range', async () => {await menuAction('copy'); await menuAction('paste');},
    (after, before) => {assert.equal(after.objects.length, before.objects.length + 1); assert.ok(after.objects.some(o => o.unique_id > 3));});
  await exercise('Cut copies once and removes figures from the selected range', async () => {
    const p = await point(1); await page.mouse.click(p.x, p.y); await page.keyboard.press('Control+x');
  }, after => assert.equal(object(after, 1), undefined));
  await exercise('Canvas attachment joins to the same native handle across selected frames', async () => {
    await page.evaluate(() => styk.actions['attach-figure']()); const p = await point(2, 1); await page.mouse.click(p.x, p.y);
  }, after => {assert.equal(object(after, 1).join.target_unique_id, 2); assert.equal(object(after, 1).join.target_handle_id, 1);});
  await exercise('Detach preserves world placement and unselected frame attachments', async () => {await page.locator('#viewport').focus();await page.keyboard.press('j');},
    (after, before) => {const root = buildGeometry(report, before).objects.get(object(before, 1).object_slot).root;
      assert.equal(object(after, 1).join, null); assert.ok(Math.abs(object(after, 1).root_x - root.x) < .001); assert.ok(Math.abs(object(after, 1).root_y - root.y) < .001);}, {file: joinedPath});
  await exercise('Canvas dragging applies a relative translation to every selected pose', async () => {
    const p = await point(1); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 30 * p.scale, p.y + 12 * p.scale, {steps: 12}); await page.mouse.up();
  }, (after, before) => {assert.ok(Math.abs(object(after, 1).root_x - object(before, 1).root_x - 30) < .2); assert.ok(Math.abs(object(after, 1).root_y - object(before, 1).root_y - 12) < .2);});
  assert.deepEqual(errors, []);
  await resetRange(); await page.screenshot({path: path.join(out, 'range-actions-app.png')});
  await writeFile(path.join(out, 'range-actions-app.json'), JSON.stringify({checks, errors}, null, 2));
} catch (error) {
  await page?.screenshot({path: path.join(out, 'range-actions-app-failure.png')}).catch(() => {});
  await writeFile(path.join(out, 'range-actions-app.json'), JSON.stringify({checks, errors, failure: error.stack}, null, 2));
  throw error;
} finally {await browser?.close(); backend.stop();}
