// The five tutorials in the real editor (docs/TUTORIALS.md), driven by real pointer and key input: every step is
// done by doing it. Also: Skip, Show me, Leave, the next tutorial, pausing outside Animate, the caption of a narrow
// header, and that a tutorial leaves the person's timeline mode and unsaved state as they were.
import {chromium} from './support/playwright.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const url = process.env.STYK_URL || 'http://127.0.0.1:47831';
const out = path.resolve('artifacts/tutorials-browser');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const checks = [];

async function open({width = 1440, height = 900} = {}) {
  const page = await browser.newPage({viewport: {width, height}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
  return {page, errors};
}
const engineState = page => page.evaluate(() => {
  const engine = window.styk.tutorials.engine;
  return engine ? {id: engine.tutorial.id, step: engine.step?.id, satisfied: engine.satisfied, finished: engine.finished} : null;
});
/** The mark glides to each new target: its box once it holds still, with the point to press. */
async function mark(page) {
  let previous = '';
  for (let round = 0; round < 50; round++) {
    const box = await page.evaluate(() => {
      const element = document.querySelector('.tutorial-mark');
      if (!element || element.hidden) return null;
      const rect = element.getBoundingClientRect();
      return {kind: element.dataset.kind, left: rect.left, top: rect.top, width: rect.width, height: rect.height};
    });
    const key = JSON.stringify(box);
    if (box && key === previous) return box.kind === 'dot' ? {...box, x: box.left, y: box.top} : {...box, x: box.left + box.width / 2, y: box.top + box.height / 2};
    previous = key;
    await page.waitForTimeout(60);
  }
  throw new Error(`No settled mark at ${JSON.stringify(await engineState(page))}`);
}
const at = (page, id) => page.waitForFunction(id => { const engine = window.styk.tutorials.engine; return engine?.step?.id === id && !engine.satisfied; }, id, {timeout: 6000})
  .catch(async () => { throw new Error(`Expected step ${id}, at ${JSON.stringify(await engineState(page))}`); });
const done = (page, label) => page.waitForFunction(() => window.styk.tutorials.engine?.satisfied, null, {timeout: 5000})
  .catch(async () => { throw new Error(`${label} was not detected: ${JSON.stringify(await engineState(page))}`); });
const next = page => page.click('.tutorial-next');
async function drag(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(from.x + dx * step / 10, from.y + dy * step / 10);
  await page.mouse.up();
}
async function start(page, id) {
  assert.equal(await page.evaluate(id => window.styk.tutorials.start(id), id), true, `${id} starts`);
  await page.waitForFunction(id => window.styk.tutorials.active?.id === id && document.querySelector('.stage-head .tutorial-strip'), id);
}
async function finished(page, id) {
  await page.waitForFunction(() => window.styk.tutorials.engine?.finished, null, {timeout: 5000});
  assert.ok((await page.evaluate(() => window.styk.state.settings.tutorialsDone)).includes(id), `${id} is remembered as done`);
}

try {
  const {page, errors} = await open();
  await page.evaluate(() => window.styk.settingsUI.commit({timelineMode: 'simple'}));
  const tabs = () => page.evaluate(() => window.styk.projects.tabs.size);

  // ---- Look around ---------------------------------------------------------------------------------------------------
  await start(page, 'tour');
  assert.deepEqual(await page.evaluate(() => [window.styk.state.settings.timelineMode, window.styk.editor.name, window.styk.editor.dirty]), ['advanced', 'Practice', false]);
  assert.equal(await page.locator('.tutorial-say-text').textContent(), 'This is the stage. Your animation happens on the white canvas.');
  await at(page, 'stage'); await next(page);
  await at(page, 'tools'); await next(page);
  await at(page, 'deselect');
  { const box = await mark(page); await page.mouse.click(box.left + 24, box.top + 24); }
  await done(page, 'deselect');
  await at(page, 'select');
  { const box = await mark(page); await page.mouse.click(box.x, box.y - 40); }
  await done(page, 'select');
  await at(page, 'panels'); await next(page);
  await at(page, 'timeline'); await next(page);
  await at(page, 'workspaces'); await next(page);
  await finished(page, 'tour');
  assert.equal(await page.locator('.tutorial-strip[data-state="finished"] .tutorial-next-tutorial').isVisible(), true);
  assert.match(await page.locator('.tutorial-next-tutorial').textContent(), /Move around the canvas/);
  const practiceTabs = await tabs();
  checks.push('Look around: deselecting and selecting are detected; the end offers the next tutorial.');

  // ---- Move around the canvas, started from the end of the last one ------------------------------------------------
  await page.click('.tutorial-next-tutorial');
  await page.waitForFunction(() => window.styk.tutorials.active?.id === 'canvas');
  assert.equal(await tabs(), practiceTabs, 'the next tutorial uses the same practice animation');
  await at(page, 'zoom');
  { const box = await mark(page); await page.mouse.move(box.x, box.y); await page.keyboard.down('Control'); for (let tick = 0; tick < 4; tick++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(50); } await page.keyboard.up('Control'); }
  await done(page, 'zoom');
  await at(page, 'pan');
  { const box = await mark(page); await page.mouse.move(box.x, box.y); await page.keyboard.down('Space'); await drag(page, box, -120, 40); await page.keyboard.up('Space'); }
  await done(page, 'pan');
  await at(page, 'fit');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'fit');
  await at(page, 'exact');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); await page.locator('[data-action="zoom-100"]:visible').click(); }
  await done(page, '100%');
  await at(page, 'grid');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'grid');
  await finished(page, 'canvas');
  await page.evaluate(() => window.styk.actions['toggle-grid']());
  checks.push('Move around the canvas: zoom, pan, Fit, 100% and the grid are each detected.');

  // ---- Pose a figure -------------------------------------------------------------------------------------------------
  await start(page, 'posing');
  await at(page, 'select');
  { const box = await mark(page); await page.mouse.click(box.x, box.y - 40); }
  await done(page, 'select');
  await at(page, 'pose');
  { const dot = await mark(page); assert.equal(dot.kind, 'dot', 'a dot marks the joint to drag'); await drag(page, dot, 46, -70); }
  await done(page, 'pose');
  // What a lesson changes is not unsaved work: the next reading after the edit marks the practice animation clean.
  await page.waitForFunction(() => !window.styk.editor.dirty, null, {timeout: 3000});
  await at(page, 'move');
  { const dot = await mark(page); await drag(page, dot, 90, 0); }
  await done(page, 'move');
  await at(page, 'undo');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'undo');
  await at(page, 'flip');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'flip');
  await at(page, 'wrap'); await next(page);
  await finished(page, 'posing');
  checks.push('Pose a figure: selecting, bending a joint, moving the origin, Undo and Flip are each detected.');

  // ---- Make it move --------------------------------------------------------------------------------------------------
  await start(page, 'timeline');
  await at(page, 'look'); await next(page);
  await at(page, 'scrub');
  { const box = await mark(page); assert.ok(box.height <= 52, `the ruler alone is marked (${box.height})`); await drag(page, {x: box.left + 24, y: box.y}, 60, 0); }
  await done(page, 'scrub');
  await at(page, 'add');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'add');
  await at(page, 'pose');
  { const dot = await mark(page); await drag(page, dot, 46, -70); }
  await done(page, 'pose');
  assert.equal(await page.evaluate(() => window.styk.editor.report._styk.layerSheet.tracks['layer-1'].keys.length), 2, 'Blue has two poses');
  await at(page, 'play');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'play');
  await at(page, 'stop');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'stop');
  await at(page, 'onion');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'onion');
  await finished(page, 'timeline');
  checks.push('Make it move: scrubbing, Add frame, a second pose, Play, Stop and onion skin are each detected.');

  // ---- Panels and commands -------------------------------------------------------------------------------------------
  await start(page, 'panels');
  await at(page, 'library');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'library');
  await at(page, 'properties');
  { const box = await mark(page); await page.mouse.click(box.x, box.y); }
  await done(page, 'properties');
  await at(page, 'palette');
  assert.match(await page.locator('.tutorial-say-text').textContent(), /Ctrl\+P/, 'the step names the person\'s own shortcut');
  await page.keyboard.press('Control+p');
  await done(page, 'palette');
  await page.keyboard.press('Escape');
  await at(page, 'layout'); await next(page);
  await at(page, 'home'); await next(page);
  await finished(page, 'panels');
  assert.equal(await page.locator('.tutorial-next-tutorial').isVisible(), false, 'nothing is left to offer');
  checks.push('Panels and commands: the Library and Properties tabs and the command search are each detected.');

  // ---- Leaving gives everything back ---------------------------------------------------------------------------------
  await page.click('.tutorial-leave');
  assert.equal(await page.evaluate(() => window.styk.tutorials.active), null);
  assert.equal(await page.locator('.tutorial-strip, .tutorial-mark').count(), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.stage-head .ui-crumb')).display) !== 'none', true, 'the scene crumb is back');
  assert.equal(await page.evaluate(() => window.styk.state.settings.timelineMode), 'simple', 'the person\'s timeline mode is back');
  assert.equal(await page.evaluate(() => window.styk.editor.dirty), false);
  checks.push('Leaving gives the header, the timeline mode and the practice animation back as they were.');

  // ---- Skip, Show me, Back, and a pause outside Animate ---------------------------------------------------------------
  await start(page, 'posing');
  await at(page, 'select');
  assert.equal(await page.locator('.tutorial-next .ui-label').textContent(), 'Skip');
  await page.click('.tutorial-next');
  await at(page, 'pose');
  const before = await page.evaluate(() => ({view: {...window.styk.state.view}, selected: window.styk.editor.selectedUid, revision: window.styk.editor.revision}));
  await page.click('.tutorial-show');
  await page.waitForFunction(() => !document.querySelector('.tutorial-ghost')?.hidden);
  await page.waitForFunction(() => document.querySelector('.tutorial-ghost')?.hidden, null, {timeout: 6000});
  assert.deepEqual(await page.evaluate(() => ({view: {...window.styk.state.view}, selected: window.styk.editor.selectedUid, revision: window.styk.editor.revision})), before, 'Show me acts the step out without doing it');
  await page.click('.tutorial-back');
  await at(page, 'select');
  await page.click('.workspace-switch [data-workspace-mode="draw"]');
  await page.waitForFunction(() => window.styk.tutorials.presenter.paused);
  assert.equal(await page.locator('.tutorial-strip').isVisible(), false, 'Draw keeps its own bar in the header');
  await page.locator('#toast button', {hasText: 'Back to Animate'}).click();
  await page.waitForFunction(() => !window.styk.tutorials.presenter.paused && document.querySelector('.tutorial-strip')?.checkVisibility());
  checks.push('Skip moves on, Show me changes nothing, Back returns, and outside Animate the tutorial waits with a way back.');
  assert.deepEqual(errors, []);
  await page.close();

  // ---- A narrow header: the sentence goes on a line of its own ---------------------------------------------------------
  const small = await open({width: 820, height: 600});
  await start(small.page, 'tour');
  await small.page.waitForFunction(() => !document.querySelector('.tutorial-caption')?.hidden);
  const caption = await small.page.evaluate(() => {
    const element = document.querySelector('.tutorial-caption'), head = document.querySelector('.stage-head').getBoundingClientRect(), box = element.getBoundingClientRect();
    return {text: element.textContent, below: box.top >= head.bottom, inside: box.left >= head.left && box.right <= head.right + 1};
  });
  assert.equal(caption.text, 'This is the stage. Your animation happens on the white canvas.');
  assert.ok(caption.below && caption.inside, JSON.stringify(caption));
  const headHeight = await small.page.evaluate(() => document.querySelector('.stage-head').getBoundingClientRect().height);
  assert.ok(headHeight <= 48, 'the strip adds no row to the header');
  await small.page.screenshot({path: path.join(out, 'tour-820x600.png')});
  assert.deepEqual(small.errors, []);
  await small.page.close();
  checks.push('In a narrow header the sentence shows whole on a caption below it, and the header keeps its height.');
  console.log(checks.map(check => `✓ ${check}`).join('\n'));
} finally {
  await browser.close();
}
