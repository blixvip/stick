import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const out = 'artifacts/canvas-selection';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const pose = () => page.evaluate(() => styk.editor.serialize());
const screen = point => page.evaluate(point => {
  const b = document.querySelector('#viewport').getBoundingClientRect(), v = styk.state.view;
  return {x: b.x + v.x + point.x * v.scale, y: b.y + v.y + point.y * v.scale};
}, point);
async function drag(point, delta, {button = 'left', cancel = false} = {}) {
  const p = await screen(point);
  await page.mouse.move(p.x, p.y); await page.mouse.down({button});
  await page.mouse.move(p.x + delta.x, p.y + delta.y, {steps: 5});
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up({button}); await settle();
}

try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createObject, createFrame} = await import('/src/demo.mjs');
    const r = emptyDocument(), f = r.figure_types[0], part = structuredClone(f);
    const line = {...f.segments[0], segment_id: 1, parent_id: 0, segment_type: 'line', segment_kind: 'squareLine',
      length: 160, thickness: 8, angle_rad: 0, is_static: false};
    f.segments = [line, {...line, segment_id: 2, parent_id: 1, length: 65, angle_rad: .5}]; f.segment_count = 2;
    part.figure_type_id = 2; part.name = 'Artwork';
    part.segments = [{...line, aux_code: 1, is_static: true, length: 130, thickness: 60}]; part.segment_count = 1;
    r.figure_types.push(part);
    r.keyframes = [createFrame([createObject(f, 1, 180, 170), createObject(part, 2, 180, 330),
      createObject(part, 3, 310, 330, {join: {target_object_slot: 1, target_unique_id: 2, target_handle_id: 1}})], 20)];
    styk.settingsUI.commit({timelineMode: 'simple', motionPaths: false, showHandles: true});
    styk.editor.load(r); styk.editor.disableFrameDrafts(); styk.editor.select(null); styk.fit();
  });
  await page.keyboard.press('v'); await settle();
  const original = await pose(), undo = await page.evaluate(() => styk.editor._undo.length);
  for (const [uid, x] of [[2, 235], [3, 370]]) {
    await drag({x, y: 330}, {x: 35, y: 25});
    assert.deepEqual(await page.evaluate(() => [styk.editor.selectedUid, styk.editor.selectedJoint]), [uid, -1]);
    assert.deepEqual(await pose(), original);
    assert.equal(await page.evaluate(() => styk.editor._undo.length), undo);
  }
  console.log('PASS artwork drags select free and joined figures without movement or history');
  const artwork = await screen({x: 370, y: 330});
  await page.mouse.click(artwork.x, artwork.y, {button: 'right'});
  await page.getByText('Unjoin figure', {exact: true}).click();
  assert.equal(await page.evaluate(() => Boolean(styk.editor.object.join)), false);
  await page.evaluate(() => styk.editor.undo()); assert.deepEqual(await pose(), original);
  console.log('PASS artwork selection supports context-menu unjoin and undo');

  const from = {x: 260, y: 172}, p = await screen(from);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  assert.deepEqual(await page.evaluate(() => [styk.editor.selectedUid, styk.editor.selectedJoint, styk.state.drag?.kind]), [1, 0, 'pose']);
  await page.mouse.move(p.x + 20, p.y + 35, {steps: 5});
  const preview = await page.evaluate(() => {
    const g = styk.editor.geometry.objects.get(0);
    return {root: g.root, angle: g.segments[0].angle, scale: styk.state.view.scale};
  });
  assert.deepEqual(preview.root, {x: 180, y: 170});
  assert.ok(Math.abs(preview.angle - Math.atan2(35 / preview.scale, 160 + 20 / preview.scale)) < .001, 'mid-segment grab preserves endpoint offset');
  await page.mouse.up(); await settle();
  assert.equal(await page.evaluate(() => styk.editor._undo.length), undo + 1);
  const posed = await pose();
  await page.evaluate(() => styk.editor.undo()); assert.deepEqual(await pose(), original);
  await page.evaluate(() => styk.editor.redo()); assert.deepEqual(await pose(), posed);
  await page.screenshot({path: `${out}/segment-drag.png`});
  await page.evaluate(() => styk.editor.undo());
  console.log('PASS padded mid-segment dragging poses the joint without a grab jump, with undo and redo');

  await drag(from, {x: 15, y: 40}, {cancel: true}); assert.deepEqual(await pose(), original);
  await drag({x: 180, y: 170}, {x: 25, y: 10});
  assert.notDeepEqual(await pose(), original);
  await page.evaluate(() => styk.editor.undo()); assert.deepEqual(await pose(), original);
  await drag(from, {x: 0, y: 35}, {button: 'right'});
  assert.ok(await page.evaluate(() => styk.editor.object.bends?.some(value => Math.abs(value) > .01)));
  assert.equal(await page.locator('#menu').isVisible(), false);
  await page.evaluate(() => styk.editor.undo()); assert.deepEqual(await pose(), original);
  console.log('PASS Escape, origin translation and right-drag bending remain available');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
