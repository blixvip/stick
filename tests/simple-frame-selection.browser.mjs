/** Simple frame navigation keeps the canvas selection (it never selects a layer's figures). */
import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1500, height: 1000}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => {assert.ok(value, name); console.log('PASS', name);};
const selected = () => page.evaluate(() => [...styk.editor.selectedUids].sort((a, b) => a - b).join(','));
const card = index => page.locator('.sheet-filmstrip canvas').nth(index);
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {createDemo} = await import('/src/demo.mjs');
    styk.settingsUI.commit({timelineMode: 'simple'}); styk.editor.load(createDemo());
    const uids = styk.editor.selectionFrame.objects.map(o => o.unique_id);
    if (uids.length < 2 || new Set(uids.map(uid => styk.editor.layerForUid(uid))).size !== 1) throw new Error('Fixture needs several figures in one layer.');
    styk.editor.select(uids[1]);
  });
  await card(0).waitFor();
  const initial = await selected();
  await card(3).click();
  check('Clicking a frame keeps the selected figure', await selected() === initial);

  await page.locator('#layers-button').click();
  await page.locator('.tl-layers-pick').first().click();
  check('Choosing a layer for new figures keeps the selection', await selected() === initial);
  await page.keyboard.press('Escape');
  await card(5).click();
  check('Frames clicked after choosing a layer keep the selection', await selected() === initial);

  // A layer selected with its contents (as the Advanced timeline does) stops following on Simple navigation.
  await page.evaluate(() => { const e = styk.editor; e.selectSheetLayer(e.layerForUid(e.selectedUid)); e.select(e.selectionFrame.objects[0].unique_id); });
  const single = await selected();
  await page.evaluate(() => { const e = styk.editor; e.selectSheetLayer(e.activeLayerId); });
  const layerContents = await selected();
  await card(2).click();
  check('Frame clicks keep an explicit layer-contents selection without re-selecting', await selected() === layerContents);
  await page.evaluate(() => styk.editor.select(styk.editor.selectionFrame.objects[0].unique_id));
  await card(4).click();
  check('Frame clicks keep a later single-figure selection', await selected() === single);

  await page.evaluate(() => styk.editor.select(null));
  await card(1).click();
  check('Frame clicks keep an empty selection', await selected() === '');
  check('No uncaught browser errors', errors.length === 0);
} finally { await browser.close(); }
