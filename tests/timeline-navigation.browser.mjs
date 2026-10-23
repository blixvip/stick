/** Advanced timeline navigation: zoom anchors, following the playhead, room under the last layer and edge scrolling.
 * Run with `node tests/timeline-navigation.browser.mjs` against `npm run serve` (STYK_URL overrides the address). */
import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';

const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 800}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks.push(name); console.log(`PASS ${name}`); };
/** The view: the playhead's x in the grid, the grid's width, zoom and offsets. */
const view = () => page.evaluate(() => { const t = styk.timeline; return {x: (Math.floor(styk.editor.tick) + .5) * t.pxPerTick - t._offsetX(), width: t.width, height: t.height, zoom: t.pxPerTick, left: t._offsetX(), top: t.scroll.scrollTop}; });
const slider = async value => { await page.locator('#timeline-zoom').fill(String(value)); await page.locator('#timeline-zoom').dispatchEvent('input'); await settle(); };
const seek = async tick => { await page.evaluate(tick => styk.editor.seek(tick), tick); await settle(); };

try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument} = await import('/src/demo.mjs');
    styk.settingsUI.commit({timelineMode: 'advanced', theme: 'light'}); styk.editor.load(emptyDocument());
    for (let i = 2; i <= 14; i++) styk.editor.createLayer(`Layer ${i}`);
    const e = styk.editor; e.sheetInsertFrames(['scene', 'camera', ...e.report._styk.layers.order], 0, 400);
  }); await settle();

  // The slider zooms around the playhead: it stays where it was.
  await slider(14); await page.evaluate(() => styk.timeline._scrollToX(0)); await seek(30); await settle();
  let before = await view();
  await slider(30); let after = await view();
  check('The slider zooms in around the playhead', after.zoom === 30 && Math.abs(after.x - before.x) < 1.5, {before, after});
  await slider(6); after = await view();
  check('The slider zooms out around the playhead', after.zoom === 6 && (Math.abs(after.x - before.x) < 1.5 || after.left === 0), {before, after});
  // A playhead out of view comes to the middle.
  await slider(14); await page.evaluate(() => styk.timeline._scrollToX(200 * 14)); await settle();
  before = await view(); assert.ok(before.x < 0, 'the playhead starts out of view');
  await slider(20); after = await view();
  check('Zooming with the playhead out of view brings it to the middle', Math.abs(after.x - after.width / 2) < 1.5, after);

  // Ctrl + wheel zooms under the pointer, in proportion to the wheel's delta.
  const grid = await page.locator('.sheet-scroll').boundingBox();
  const tickUnder = x => page.evaluate(x => (styk.timeline._offsetX() + x) / styk.timeline.pxPerTick, x);
  await slider(14); await page.mouse.move(grid.x + 400, grid.y + 120);
  const under = await tickUnder(400);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control'); await settle();
  after = await view();
  check('Ctrl + wheel zooms under the pointer', after.zoom > 15.5 && after.zoom < 17 && Math.abs(await tickUnder(400) - under) < .2, after);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, 10); await page.keyboard.up('Control'); await settle();
  const gentle = (await view()).zoom / after.zoom;
  check('A small wheel delta zooms gently', gentle < 1 && gentle > .97, gentle);

  // Stepping past the view's edge brings the playhead back, forward and backward.
  await slider(14); await seek(0); await page.evaluate(() => styk.timeline._scrollToX(0)); await settle();
  const last = Math.floor((await view()).width / 14) - 1;
  await seek(last); await seek(last + 3); after = await view();
  check('A step past the right edge pages the grid forward', after.x > 0 && after.x < 80, after);
  await seek(last - 2); after = await view();
  check('A step back past the left edge keeps the playhead in view', after.x > 0 && after.x <= after.width, after);
  // Playback follows only while the playhead was in view.
  await page.evaluate(() => styk.timeline.setPaused(true)); await seek(last + 3); await settle();
  const page1 = (await view()).left;
  await seek(last + 3 + Math.ceil((await view()).width / 14)); after = await view();
  check('Playback pages forward when the playhead leaves the view', after.left > page1 && after.x > 0 && after.x < 80, after);
  await page.evaluate(() => styk.timeline._scrollToX(0)); await settle(); await settle();
  await seek(last + 200); after = await view();
  check('Playback leaves the grid alone after scrolling away from the playhead', after.left === 0, after);
  await page.evaluate(() => styk.timeline.setPaused(false)); await settle();

  // The last layer scrolls clear of the grid's foot.
  await page.evaluate(() => { const t = styk.timeline; t.scroll.scrollTop = t.scroll.scrollHeight; }); await settle();
  const foot = await page.evaluate(() => { const t = styk.timeline, i = t.tracks.length - 1; return {gap: t.height - (t.rowY(i) + t.rowSize(i)), row: t.layout.row, more: !t.moreRows || t.moreRows.hidden}; });
  check('The last layer scrolls clear of the grid\'s foot', foot.gap >= 2 * foot.row && foot.more, foot);

  // A drag resting at the foot of the grid keeps scrolling the rows.
  await page.evaluate(() => { styk.timeline.scroll.scrollTop = 0; styk.timeline._scrollToX(0); }); await settle();
  const box = await page.locator('.sheet-scroll').boundingBox(), body = await page.evaluate(() => ({top: styk.timeline.bodyTop, height: styk.timeline.height}));
  await page.mouse.move(box.x + 200, box.y + body.top + 16); await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + body.height - 6, {steps: 4});
  await page.waitForTimeout(400);
  const dragged = await view();
  await page.mouse.up(); await settle();
  check('A drag resting at the grid\'s foot scrolls the rows', dragged.top > 40, dragged);
  check('The dragged range reaches the rows scrolled into view', await page.evaluate(() => styk.timeline.selectedLayers.size > 3));

  assert.deepEqual(errors, []);
  console.log(`PASS timeline navigation (${checks.length} checks)`);
} finally { await browser.close(); }
