import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('artifacts/disconnect-segment'); await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1560, height: 1000}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => {assert.ok(value, name); checks.push(name); console.log('PASS', name);};
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** The screen position of a figure's joint (a segment's end) or origin. */
const point = (uid, name) => page.evaluate(({uid, name}) => {
  const {editor, state} = styk, g = [...editor.geometry.objects.values()].find(g => g.obj.unique_id === uid);
  const p = name ? g.segments.find(s => s.seg.name === name).end : g.root;
  const rect = document.getElementById('overlay').getBoundingClientRect();
  return {x: rect.x + state.view.x + p.x * state.view.scale, y: rect.y + state.view.y + p.y * state.view.scale};
}, {uid, name});
const rightClick = async (uid, name) => {
  await page.keyboard.press('Escape'); await settle();
  const p = await point(uid, name); await page.mouse.click(p.x, p.y, {button: 'right'}); await settle();
};
const item = () => page.locator('#menu [data-action="disconnect-segment"]');
const scene = () => page.evaluate(() => ({count: styk.editor.selectionFrame.objects.length, uids: styk.editor.selectionFrame.objects.map(o => o.unique_id),
  selected: styk.editor.selectedUid, name: styk.editor.figure?.name, types: styk.editor.report.figure_types.length}));
const canvas = name => page.locator('#viewport').screenshot({path: path.join(out, `${name}.png`)});
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
  for (const mode of ['advanced', 'simple']) {
    await page.evaluate(mode => {
      styk.settingsUI.commit({timelineMode: mode, showHandles: true}); styk.editor.newDocument();
      styk.state.tool = 'select'; styk.state.handles = true; styk.state.hidden.clear(); styk.state.locked.clear();
      styk.state.view = {x: 200, y: 40, scale: 1}; styk.editor.select(1);
    }, mode);
    await page.locator('#viewport').focus(); await settle(); await canvas(`${mode}-before`);

    await rightClick(1, null);
    check(`${mode}: the origin's menu has no Disconnect segment`, await item().count() === 0);
    await rightClick(1, 'Left upper arm');
    check(`${mode}: a joint's menu offers Disconnect segment`, await item().isVisible() && await item().isEnabled());
    await item().click(); await settle();
    const split = await scene();
    check(`${mode}: the arm is a new selected figure`, split.count === 2 && split.selected !== 1 && split.name === 'Left upper arm' && split.types === 2);
    await canvas(`${mode}-after`);

    await rightClick(split.selected, 'Left upper arm');
    check(`${mode}: a whole figure cannot be disconnected further`, await item().isVisible() && !(await item().isEnabled()));
    await page.keyboard.press('Escape'); await settle();

    await page.keyboard.press('Control+z'); await settle();
    const undone = await scene();
    check(`${mode}: one undo restores the single figure`, undone.count === 1 && undone.types === 1);
    await page.keyboard.press('Control+Shift+z'); await settle();
    check(`${mode}: redo splits it again`, (await scene()).count === 2);
  }
  check('no uncaught page errors', errors.length === 0);
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify({checks, errors}, null, 2));
  await browser.close();
}
