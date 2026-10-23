/** Auto key: Advanced-only toggle, shortcut, persistent preference, red playhead, and painting a held drawing. */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const out = 'artifacts/auto-key'; await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => {assert.ok(value, name); console.log('PASS', name);};
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = () => page.locator('.tl-autokey');
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    styk.state.settings.autosaveSeconds = 0; styk.settingsUI.commit({timelineMode: 'advanced', autoKey: false}); styk.editor.load(createDemo());
  });
  await settle();
  check('Auto key starts off', await page.evaluate(() => styk.editor.autoKey === false) && await button().getAttribute('aria-pressed') === 'false');
  await button().click(); await settle();
  check('The timeline button turns auto key on', await page.evaluate(() => styk.editor.autoKey && styk.state.settings.autoKey) && await button().getAttribute('aria-pressed') === 'true');
  check('The playhead turns red while auto keying', await page.evaluate(() => document.querySelector('.timeline-panel').classList.contains('auto-keying')));
  await page.screenshot({path: `${out}/on.png`});
  await page.locator('#viewport').focus(); await page.keyboard.press('k'); await settle();
  check('K toggles auto key', await page.evaluate(() => !styk.editor.autoKey) && await button().getAttribute('aria-pressed') === 'false');
  await page.keyboard.press('k'); await settle();
  await page.getByRole('button', {name: 'Simple', exact: true}).click(); await settle();
  check('Simple hides the toggle and never auto keys', await button().isHidden() && await page.evaluate(() => styk.editor.autoKey === false && styk.state.settings.autoKey));
  await page.getByRole('button', {name: 'Advanced', exact: true}).click(); await settle();
  check('Advanced restores the preference', await page.evaluate(() => styk.editor.autoKey) && await button().isVisible());

  // Painting a held drawing copies it to the playhead first.
  await page.evaluate(async () => {
    const e = styk.editor, layer = e.createDrawingLayer(); e.sheetSetDuration(12, layer.id, 0); window.__drawingLayer = layer.id;
    e.seek(0);
  });
  await page.locator('[data-workspace-mode="draw"]').click(); await settle();
  const rect = await page.locator('#viewport').boundingBox();
  const stroke = async (x, y) => {await page.mouse.move(x, y); await page.mouse.down(); await page.waitForFunction(() => Boolean(styk.drawing.gesture)); await page.mouse.move(x + 80, y + 30, {steps: 6}); await page.mouse.up(); await page.waitForFunction(() => !styk.drawing.gesture); await page.evaluate(() => styk.drawing.barrier());};
  await stroke(rect.x + rect.width * .3, rect.y + rect.height * .3);
  await page.evaluate(() => styk.editor.seek(6)); await settle();
  await stroke(rect.x + rect.width * .3, rect.y + rect.height * .5);
  const drawingKeys = await page.evaluate(() => styk.editor.layerFrameKeys(__drawingLayer).map(key => key.tick));
  check(`Painting a held drawing keys the playhead (${drawingKeys})`, drawingKeys.includes(0) && drawingKeys.includes(6));
  check('No uncaught browser errors', errors.length === 0);
} finally { await browser.close(); }
