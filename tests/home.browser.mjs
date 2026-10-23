// Home in the browser (docs/HOME.md): it opens first, takes the keyboard, starts new animations on the chosen
// canvas, leads into the tutorials and steps aside for the editor. The desktop's project list is
// scripts/smoke-home.mjs.
import {chromium} from './support/playwright.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const url = process.env.STYK_URL || 'http://127.0.0.1:47831';
const out = path.resolve('artifacts/home-browser');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const checks = [];
const open = async ({view = 'home', width = 1440, height = 900, context} = {}) => {
  const page = await (context ?? browser).newPage({viewport: {width, height}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Defined before the page runs: the test chooses where the app starts ('auto' leaves it to the setting).
  await page.addInitScript(value => { globalThis.stykStartupView = value; }, view);
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
  return {page, errors};
};
const shown = page => page.evaluate(() => window.styk.home.shown);

try {
  // ---- Home first ----------------------------------------------------------------------------------------------------
  let {page, errors} = await open();
  assert.equal(await shown(page), true);
  assert.equal(await page.locator('.home-title').textContent(), 'Welcome to StykAnimate');
  assert.equal(await page.locator('.home-projects .ui-empty-title').textContent(), 'Your projects stay in your files', 'the browser keeps no project list and says so');
  assert.equal(await page.locator('[data-action="home"][aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator('.workspace-switch [aria-pressed="true"]').count(), 0, 'no workspace is pressed on Home');
  assert.deepEqual(await page.evaluate(() => ['.band-history', '.band-save', '.band-export'].map(selector => getComputedStyle(document.querySelector(selector)).visibility)),
    ['hidden', 'hidden', 'hidden'], 'what acts on the animation steps out of the band');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#viewport')).visibility), 'hidden', 'the editor under Home is out of reach');
  assert.equal(await page.locator('.home-lesson-start').count(), 1);
  assert.match(await page.locator('.home-lesson-title').textContent(), /Look around/);
  await page.screenshot({path: path.join(out, 'home.png')});
  checks.push('Home opens first: its page, the Home button pressed, the editor and its band actions out of reach.');

  // ---- The keyboard is Home's ---------------------------------------------------------------------------------------
  await page.keyboard.press('h');
  assert.equal(await page.evaluate(() => window.styk.state.tool), 'select', 'the Hand tool\'s key does nothing on Home');
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.querySelector('#home').contains(document.activeElement)), 'Tab moves through Home');
  await page.keyboard.press('Escape');
  assert.equal(await shown(page), false, 'Escape goes back to the animation');
  await page.keyboard.press('h');
  assert.equal(await page.evaluate(() => window.styk.state.tool), 'hand', 'the editor has its keys back');
  await page.keyboard.press('v');
  await page.click('[data-action="home"]');
  assert.equal(await shown(page), true, 'the Home button shows Home');
  await page.click('.workspace-switch [data-workspace-mode="animate"]');
  assert.equal(await shown(page), false, 'a workspace button leads back to the editor');
  checks.push('Home owns the keyboard: editor keys are off, Escape and the workspace switch lead back.');

  // ---- Start: a canvas of the chosen shape ---------------------------------------------------------------------------
  for (const [canvas, size] of [['portrait', [540, 960]], ['square', [720, 720]], ['landscape', [960, 540]]]) {
    await page.evaluate(() => window.styk.actions.home());
    await page.click(`[data-home="new"][data-canvas="${canvas}"]`);
    await page.waitForFunction(size => !window.styk.home.shown && window.styk.editor.report.canvas_width === size[0] && window.styk.editor.report.canvas_height === size[1], size);
    assert.equal(await page.evaluate(() => window.styk.editor.dirty), false, `a new ${canvas} animation has nothing to save`);
    assert.equal(await page.evaluate(() => window.styk.editor.frame.objects.length), 1, 'Blue is on it');
  }
  checks.push('Start opens a new landscape, vertical or square animation with Blue on it.');

  // ---- Messages and commands while Home shows ------------------------------------------------------------------------
  await page.evaluate(() => window.styk.actions.home());
  await page.evaluate(() => window.styk.ui.toasts.show({message: 'Hello from Home'}));
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Hello from Home'));
  const toastBox = await page.evaluate(() => { const box = document.querySelector('#toast .ui-toast')?.getBoundingClientRect() ?? document.querySelector('#toast').getBoundingClientRect(); return {top: box.top, bottom: box.bottom}; });
  assert.ok(toastBox.top >= 0 && toastBox.bottom <= 900, 'a message shows inside the window while Home covers the stage header');
  await page.evaluate(() => window.styk.actions['toggle-grid']());
  assert.equal(await shown(page), false, 'a command that works on the animation sends Home away first');
  await page.evaluate(() => window.styk.actions['toggle-grid']());
  await page.evaluate(() => window.styk.actions.home());
  await page.evaluate(() => window.styk.actions.help());
  await page.waitForFunction(() => document.querySelector('dialog[open]'));
  assert.equal(await shown(page), true, 'Keyboard shortcuts open over Home');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  assert.equal(await shown(page), true, 'Escape closes the dialog first');
  checks.push('Messages stay visible on Home; editing commands send Home away, Help opens over it.');

  // ---- Learn leads into a tutorial -----------------------------------------------------------------------------------
  await page.click('.home-lesson-start');
  await page.waitForFunction(() => window.styk.tutorials.active?.id === 'tour' && !window.styk.home.shown);
  assert.equal(await page.locator('.stage-head .tutorial-strip').count(), 1);
  await page.evaluate(() => window.styk.actions.home());
  assert.equal(await page.evaluate(() => window.styk.tutorials.active), null, 'Home ends the tutorial');
  assert.equal(await page.locator('.tutorial-strip').count(), 0);
  checks.push('Learn starts a tutorial in the editor; Home ends it.');

  // ---- A language change rewrites Home's words (pseudolocalization stands in for a translated pack) ---------------------
  await page.evaluate(() => window.styk.localization.localization.setPseudo('long'));
  await page.waitForFunction(() => document.querySelector('.home-section-title')?.textContent.startsWith('［')
    && document.querySelector('.home-lesson-title')?.textContent.startsWith('［'));
  await page.evaluate(() => window.styk.localization.localization.setPseudo(null));
  await page.waitForFunction(() => document.querySelector('.home-section-title')?.textContent === 'Start');
  checks.push('Home follows the interface language.');
  assert.deepEqual(errors, []);
  await page.close();

  // ---- The setting decides, across reloads ---------------------------------------------------------------------------
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  ({page, errors} = await open({view: 'auto', context}));
  assert.equal(await shown(page), true, 'Home shows by default');
  await page.evaluate(async () => { window.styk.settingsUI.commit({showHomeOnStartup: false}); await window.styk.settingsUI.flush?.(); });
  await page.reload();
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
  assert.equal(await shown(page), false, 'turned off, the app opens in the editor');
  assert.deepEqual(errors, []);
  await context.close();
  checks.push('Settings › Show Home when the app starts is honoured after a reload.');

  // ---- Small windows -------------------------------------------------------------------------------------------------
  for (const [width, height] of [[820, 600], [390, 844]]) {
    ({page, errors} = await open({width, height}));
    const overflow = await page.evaluate(() => { const home = document.querySelector('.home-page'); return home.scrollWidth - home.clientWidth; });
    assert.ok(overflow <= 0, `Home fits ${width} px without scrolling sideways (${overflow})`);
    assert.ok(await page.locator('.home-lesson-start').isVisible());
    await page.screenshot({path: path.join(out, `home-${width}x${height}.png`), fullPage: false});
    assert.deepEqual(errors, []);
    await page.close();
  }
  checks.push('Home fits a small window and a phone without sideways scrolling.');
  console.log(checks.map(check => `✓ ${check}`).join('\n'));
} finally {
  await browser.close();
}
