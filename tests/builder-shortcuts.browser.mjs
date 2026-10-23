import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const focus = () => page.locator('#viewport').focus();
const count = () => page.evaluate(() => styk.editor.figure.segments.length);
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47849');
  await page.waitForFunction(() => window.styk?.ready);
  await page.locator('[data-workspace-mode="rig"]').click();
  await page.evaluate(() => styk.editor.select(styk.editor.selectedUid, 0));
  await focus();
  const before = await count();
  await page.keyboard.press('s');
  assert.equal(await count(), before + 1);
  await page.keyboard.press('Control+z');
  assert.equal(await count(), before);
  await page.keyboard.press('Control+d');
  assert.deepEqual(await page.evaluate(() => ({branch: styk.state.duplicatePlacement?.branch, flip: styk.state.duplicatePlacement?.flip})), {branch: false, flip: false});
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => Boolean(styk.state.duplicatePlacement)), false);
  assert.equal(await count(), before);
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => styk.state.builderBranch), true);
  await page.keyboard.press('Control+d');
  assert.equal(await page.evaluate(() => styk.state.duplicatePlacement.branch), true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  await page.evaluate(() => {
    const e = styk.editor, original = e.mirrorSegment;
    window.flips = [];
    e.mirrorSegment = function(axis, options) { flips.push({axis, ...options}); return original.call(this, axis, options); };
  });
  const geometry = await page.evaluate(() => JSON.stringify(styk.editor.figure));
  await page.keyboard.press('Shift+h');
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.figure)), geometry);
  await page.keyboard.press('Shift+v');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('b');
  await page.keyboard.press('Shift+h');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await page.evaluate(() => flips), [
    {axis: 'horizontal', branch: false}, {axis: 'vertical', branch: false}, {axis: 'horizontal', branch: true},
  ]);
  await page.keyboard.press('b');
  await page.keyboard.press('Shift+s');
  assert.ok(await count() > before + 1, 'Shift+S splits descendants');
  await page.keyboard.press('Control+z');
  assert.equal(await count(), before);
  await page.evaluate(() => styk.hotkeys.setBindings({'split-segment': ['Mod+Shift+KeyQ']}));
  await page.keyboard.press('Control+Shift+q');
  assert.equal(await count(), before + 1, 'Shift in custom binding does not split descendants');
  await page.keyboard.press('Control+z');
  assert.equal(await count(), before);
  await page.evaluate(() => styk.hotkeys.setBindings({}));
  assert.deepEqual(errors, []);
  console.log('PASS: Build split/undo, branch toggle, duplicate scope/cancel, flip scope/undo, Shift+S descendants.');
} finally { await browser.close(); }
