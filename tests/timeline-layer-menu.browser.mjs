import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const out = 'artifacts/timeline-layer-menu'; await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 800}}), errors = [];
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const row = name => page.getByRole('button', {name: `Select layer ${name}`, exact: true});
const item = name => page.getByRole('menuitem', {name, exact: true});
const menusFit = () => page.locator('[role="menu"]:visible').evaluateAll(nodes => nodes.every(node => {
  const bounds = node.getBoundingClientRect();
  return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
}));
try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument} = await import('/src/demo.mjs');
    styk.settingsUI.commit({timelineMode: 'advanced'}); styk.editor.load(emptyDocument());
    styk.editor.createLayer('Drawing'); styk.editor.createLayer('Foreground'); styk.editor.createLayerFolder('Shot');
  }); await settle();
  await row('Drawing').click(); await row('Foreground').click({modifiers: ['Control']}); await settle();
  const before = await page.evaluate(() => JSON.stringify(styk.editor.serialize()));
  await row('Foreground').click({button: 'right'});
  assert.deepEqual((await page.evaluate(() => styk.timeline.ids)).sort(), ['layer-2', 'layer-3']);
  assert.ok(await page.locator('[role="menu"]:visible .ui-menu-item').count() <= 7);
  await page.screenshot({path: `${out}/desktop.png`, animations: 'disabled'});
  await item('Focus').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Focus selected layers');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await settle();
  assert.deepEqual((await page.evaluate(() => [...styk.editor.getLayerFocus().ids])).sort(), ['layer-2', 'layer-3']);
  assert.equal(await page.evaluate(() => styk.editor.getLayerFocus().lock), true);
  assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), before);
  await page.getByRole('button', {name: 'Show all layers', exact: true}).click(); await settle();

  await row('Foreground').click({button: 'right'}); await item('Organize').focus(); await page.keyboard.press('ArrowRight');
  await item('Move to folder').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Shot');
  assert.ok(await menusFit(), 'root and both nested menus fit the desktop viewport');
  await page.screenshot({path: `${out}/organize.png`, animations: 'disabled'});
  await page.keyboard.press('Enter'); await settle();
  assert.equal(await page.evaluate(() => styk.editor.getLayer('layer-2').folderId), 'folder-1');
  assert.equal(await page.evaluate(() => styk.editor.getLayer('layer-3').folderId), 'folder-1');
  await page.evaluate(() => styk.editor.undo()); await settle();
  assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.serialize())), before);

  await row('Foreground').click({button: 'right'}); await item('Layer color').click();
  await page.getByRole('menuitemcheckbox', {name: 'Violet', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => styk.editor.getLayer('layer-3').color), 'violet');
  await page.evaluate(() => styk.editor.undo()); await settle();

  await page.setViewportSize({width: 520, height: 740}); await settle();
  await page.evaluate(() => styk.timeline._menu({clientX: innerWidth - 12, clientY: innerHeight - 8}, {layer: true}));
  await item('Organize').focus(); await page.keyboard.press('ArrowRight');
  await item('Move to folder').focus(); await page.keyboard.press('ArrowRight');
  assert.ok(await menusFit(), 'nested menus remain within a constrained window');
  await page.screenshot({path: `${out}/compact.png`, animations: 'disabled'});
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Move to folder');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Organize');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[role="menu"]:visible').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS compact layer menus, retained selection, keyboard submenus, undo and constrained placement');
} finally { await browser.close(); }
