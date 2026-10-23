import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const out = 'artifacts/timeline-layer-filter'; await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [], checks = [];
let maximumChecklistRows = 0;
const headingChecks = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const filter = () => page.getByRole('dialog', {name: 'Filter layers', exact: true});
const check = name => filter().getByRole('checkbox', {name: `Show ${name} in timeline`, exact: true});
const row = name => page.getByRole('button', {name: `Select layer ${name}`, exact: true});
const simpleRow = id => page.locator(`.tl-layers-row[data-layer-id="${id}"] .tl-layers-pick`);
const snapshot = () => page.evaluate(() => ({document: JSON.stringify(styk.editor.serialize()), history: styk.editor._undo.length}));
const unchanged = async (before, message) => { assert.deepEqual(await snapshot(), before, message); checks.push(message); };
const done = async () => { await filter().getByRole('button', {name: 'Done', exact: true}).click(); await settle(); assert.equal(await page.locator('.tl-layer-filter-popover .tl-layer-filter-item').count(), 0, 'closed checklists release their virtual rows'); };
const open = async () => { await page.getByRole('button', {name: 'Filter layers', exact: true}).click(); await filter().waitFor(); await settle(); };
const screenshot = name => page.screenshot({path: `${out}/${name}.png`, animations: 'disabled'});
const fit = () => filter().evaluate(node => { const r = node.getBoundingClientRect(); return {fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, width: r.width, height: r.height}; });
const bounded = async () => { const count = await filter().locator('.tl-layer-filter-item').count(); maximumChecklistRows = Math.max(maximumChecklistRows, count); assert.ok(count < 25, 'dense checklist DOM remains bounded'); };
const headingBounds = () => page.locator('.sheet-label-head').evaluate(head => {
  const h = head.getBoundingClientRect(), buttons = [...head.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
    const r = button.getBoundingClientRect();
    return {name: button.getAttribute('aria-label'), fits: r.left >= h.left - 1 && r.right <= h.right + 1 && r.top >= h.top - 1 && r.bottom <= h.bottom + 1};
  });
  return {width: h.width, buttons};
});

try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument} = await import('/src/demo.mjs');
    styk.settingsUI.commit({timelineMode: 'advanced', theme: 'light'}); styk.editor.load(emptyDocument());
    styk.editor.renameLayer('layer-1', 'Background');
    styk.editor.createLayer('Body'); styk.editor.createLayer('Hands'); styk.editor.createDrawingLayer('Sparks');
    styk.editor.createLayer('Floor'); styk.editor.createLayer('Reference'); styk.editor.createLayerFolder('Character', ['layer-2', 'layer-3']);
  }); await settle();

  await page.getByRole('button', {name: 'More layer types', exact: true}).click();
  await page.getByRole('menuitem', {name: 'New folder', exact: true}).click(); await settle();
  const rename = page.getByRole('textbox', {name: /Rename New folder/});
  await rename.fill('Empty shot'); await rename.press('Enter'); await settle();
  assert.equal(await page.evaluate(() => styk.editor.getLayerFolders().at(-1).name), 'Empty shot');
  checks.push('Advanced folder creation from New layer ▾ immediately offers rename');
  let before = await snapshot();
  await open();
  await check('Body').uncheck(); await settle();
  assert.equal(await check('Character').getAttribute('aria-checked'), 'mixed');
  assert.equal(await page.evaluate(() => styk.timeline.tracks.some(row => row.id === 'layer-2')), false);
  await check('Character').click(); await settle();
  assert.equal(await check('Body').isChecked(), true); assert.equal(await check('Hands').isChecked(), true);
  await check('Character').click(); await settle();
  assert.equal(await check('Body').isChecked(), false); assert.equal(await check('Hands').isChecked(), false);
  await check('Body').check(); await settle();
  assert.equal(await check('Character').getAttribute('aria-checked'), 'mixed');
  assert.equal(await check('Hands').isChecked(), false);
  await check('Character').check(); await settle();
  assert.equal(await check('Body').isChecked(), true); assert.equal(await check('Hands').isChecked(), true);
  await unchanged(before, 'folder and child checklist changes preserve saved artwork and undo history');

  await filter().getByRole('searchbox', {name: 'Find layers or folders'}).fill('character'); await settle();
  assert.deepEqual(await filter().locator('input[data-filter-id]').evaluateAll(nodes => nodes.map(node => node.dataset.filterId)), ['folder-1', 'layer-3', 'layer-2']);
  await filter().getByRole('searchbox', {name: 'Find layers or folders'}).fill('empty shot'); await settle();
  assert.deepEqual(await filter().locator('input[data-filter-id]').evaluateAll(nodes => nodes.map(node => node.dataset.filterId)), ['folder-2']);
  await filter().getByRole('searchbox', {name: 'Find layers or folders'}).fill('nothing'); await settle();
  assert.ok(await filter().getByText('No layers or folders found.', {exact: true}).isVisible());
  await filter().getByRole('searchbox', {name: 'Find layers or folders'}).fill(''); await settle();
  await unchanged(before, 'folder name search and empty results preserve the document'); await done();

  await open();
  for (const name of ['Character', 'Empty shot', 'Reference', 'Floor', 'Sparks', 'Background']) await check(name).uncheck();
  await settle();
  assert.deepEqual(await page.evaluate(() => styk.timeline.tracks.map(row => row.id)), ['camera', 'scene']);
  assert.ok(await page.locator('.sheet-empty-layers').isHidden(), 'valid Camera and Scene rows do not show an empty-list notice');
  await done(); await row('Camera').click(); await settle();
  const fixedBefore = await snapshot(); await open();
  await filter().getByRole('button', {name: 'Only selected', exact: true}).click(); await settle();
  assert.deepEqual(await page.evaluate(() => styk.timeline.tracks.map(row => row.id)), ['camera']);
  assert.ok(await page.locator('.sheet-empty-layers').isHidden(), 'Only selected Camera remains a valid timeline row');
  await check('Camera').uncheck(); await settle();
  assert.deepEqual(await page.evaluate(() => styk.timeline.tracks.map(row => row.id)), []);
  assert.ok(await page.locator('.sheet-empty-layers').isVisible(), 'all rows unchecked shows the empty-list notice');
  await filter().getByRole('button', {name: 'Reset filter', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => styk.timeline.tracks.filter(row => row.kind === 'layer').length), 6);
  assert.ok(await page.locator('.sheet-empty-layers').isHidden(), 'reset restores valid rows and removes the empty-list notice');
  await unchanged(fixedBefore, 'fixed-only and completely empty row filters preserve document data and undo history'); await done();

  // The last row at the grid's foot (the sheet also scrolls past it, into the room under the last layer).
  await page.evaluate(() => { const t = styk.timeline; t.scroll.scrollTop = Math.max(0, t.layout.header + t.layout.height - t.height); }); await settle();
  await row('Body').click(); await row('Sparks').click({modifiers: ['Control']}); await settle();
  before = await snapshot();
  await open(); await filter().getByRole('button', {name: 'Only selected', exact: true}).click(); await settle();
  assert.deepEqual((await page.evaluate(() => styk.timeline.tracks.filter(row => row.kind === 'layer').map(row => row.id))).sort(), ['layer-2', 'layer-4']);
  assert.equal(await check('Camera').isChecked(), false); assert.equal(await check('Scene').isChecked(), false);
  await screenshot('advanced-light');
  await unchanged(before, 'Only selected changes rows without saved eye, lock, or frame changes');
  await filter().getByRole('button', {name: 'Reset filter', exact: true}).click(); await settle();
  assert.equal(await filter().getByRole('button', {name: 'Reset filter', exact: true}).isDisabled(), true);
  await check('Floor').uncheck(); await settle(); await done();
  await page.evaluate(() => styk.timeline.focusSelectedLayers({ids: ['layer-2', 'layer-3'], lock: true})); await settle();
  await open(); assert.ok(await filter().getByText('Layer focus is also active.', {exact: true}).isVisible());
  await filter().getByRole('button', {name: 'End focus', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => styk.editor.getLayerFocus()), null);
  assert.equal(await check('Floor').isChecked(), false, 'ending focus retains row checklist choices');
  assert.equal(await page.evaluate(() => styk.timeline.tracks.some(row => row.id === 'layer-5')), false);
  await unchanged(before, 'focus lock notice and End focus preserve the checklist and saved flags'); await done();

  await page.getByRole('button', {name: 'Simple', exact: true}).click(); await settle();
  await page.locator('#layers-button').click(); await settle();
  assert.equal(await page.locator('.tl-layers-row[data-layer-id="layer-5"]').count(), 0, 'filter survives Advanced to Simple switch');
  const simpleBeforeFolder = await snapshot();
  await page.getByRole('button', {name: 'New folder', exact: true}).click();
  const simpleRename = page.getByRole('textbox', {name: 'Rename New folder', exact: true});
  assert.ok(await simpleRename.evaluate(node => document.activeElement === node), 'Simple folder creation immediately focuses its name');
  await simpleRename.fill('Simple shot'); await simpleRename.press('Enter'); await settle();
  const beforeF2 = await snapshot();
  await simpleRow('folder-3').press('F2');
  const f2Rename = page.getByRole('textbox', {name: 'Rename Simple shot', exact: true});
  await f2Rename.fill('Renamed shot'); await f2Rename.press('Enter'); await settle();
  assert.equal(await page.evaluate(() => styk.editor.getLayerFolders().find(folder => folder.id === 'folder-3').name), 'Renamed shot');
  await page.evaluate(() => styk.editor.undo()); await settle();
  await unchanged(beforeF2, 'Simple F2 folder rename undoes to its original name');
  await page.evaluate(() => { styk.editor.undo(); styk.editor.undo(); }); await settle();
  await unchanged(simpleBeforeFolder, 'Simple immediate folder naming and creation undo completely');
  await open(); assert.equal(await check('Floor').isChecked(), false);
  await filter().getByRole('button', {name: 'Reset filter', exact: true}).click(); await settle(); await done();
  await simpleRow('layer-2').click(); await simpleRow('layer-3').click({modifiers: ['Control']});
  assert.deepEqual((await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId))).sort(), ['layer-2', 'layer-3']);
  await simpleRow('layer-3').click({modifiers: ['Control']});
  assert.deepEqual(await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId)), ['layer-2']);
  assert.equal(await page.evaluate(() => styk.editor.activeLayerId), 'layer-2');
  await simpleRow('layer-3').click({modifiers: ['Control']});
  await simpleRow('layer-4').click({modifiers: ['Meta']});
  assert.deepEqual((await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId))).sort(), ['layer-2', 'layer-3', 'layer-4']);
  await simpleRow('layer-4').click({modifiers: ['Meta']});
  assert.deepEqual((await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId))).sort(), ['layer-2', 'layer-3']);
  await simpleRow('layer-4').click({modifiers: ['Meta']});
  await open(); await filter().getByRole('button', {name: 'Only selected', exact: true}).click(); await settle();
  assert.deepEqual((await page.locator('.tl-layers-row').evaluateAll(nodes => nodes.map(node => node.dataset.layerId).filter(id => id.startsWith('layer-')))).sort(), ['layer-2', 'layer-3', 'layer-4']);
  await filter().getByRole('button', {name: 'Reset filter', exact: true}).click(); await settle(); await done();
  await simpleRow('layer-2').click(); await simpleRow('layer-6').click({modifiers: ['Shift']});
  assert.deepEqual((await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId))).sort(), ['layer-2', 'layer-3', 'layer-4', 'layer-5', 'layer-6']);
  await simpleRow('layer-4').click({modifiers: ['Shift']});
  assert.deepEqual((await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId))).sort(), ['layer-2', 'layer-3', 'layer-4']);
  await simpleRow('layer-6').click({modifiers: ['Shift']});
  assert.deepEqual((await page.locator('.tl-layers-pick[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.closest('[data-layer-id]').dataset.layerId))).sort(), ['layer-2', 'layer-3', 'layer-4', 'layer-5', 'layer-6']);
  await screenshot('simple-selection-light');
  const groupBefore = await snapshot(), groupHistory = groupBefore.history;
  await page.getByRole('button', {name: 'Group selected layers in folder', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => styk.editor._undo.length), groupHistory + 1);
  assert.deepEqual(await page.evaluate(() => ['layer-2', 'layer-3', 'layer-4', 'layer-5', 'layer-6'].map(id => styk.editor.getLayer(id).folderId)), Array(5).fill('folder-3'));
  await page.evaluate(() => styk.editor.undo()); await settle();
  await unchanged(groupBefore, 'Simple Ctrl, Command and Shift selection groups the selected layers in one undoable command');
  await open(); await check('Floor').uncheck(); await settle(); await done();
  await page.locator('#layers-button').click();
  await page.getByRole('button', {name: 'Advanced', exact: true}).click(); await settle();
  assert.equal(await page.evaluate(() => styk.timeline.tracks.some(row => row.id === 'layer-5')), false, 'filter survives Simple to Advanced switch');
  await page.evaluate(() => styk.editor.load(styk.editor.serialize())); await settle();
  await open(); assert.equal(await check('Floor').isChecked(), true, 'document replacement resets row filters'); await done();
  checks.push('shared row filter survives timeline mode switches and resets for replacement documents');

  for (const width of [220, 140]) for (const focused of [false, true]) {
    await page.evaluate(focused => focused ? styk.timeline.focusSelectedLayers({ids: ['layer-2'], lock: true}) : styk.editor.clearLayerFocus(), focused);
    const divider = page.getByRole('separator', {name: 'Resize layer names'}); await divider.press('Home');
    if (width === 140) { await divider.press('Shift+ArrowLeft'); await divider.press('Shift+ArrowLeft'); }
    await settle(); const measured = await headingBounds();
    assert.equal(measured.width, width, 'the divider reaches the tested column width');
    assert.ok(measured.buttons.every(button => button.fits), `${width}px heading, focus ${focused}: ${JSON.stringify(measured)}`);
    for (const name of ['New layer', 'Filter layers']) assert.ok(measured.buttons.some(button => button.name === name), `${name} remains visible`);
    if (focused) assert.ok(measured.buttons.some(button => button.name === 'Show all layers'));
    headingChecks.push({width, focused, touch: false, ...measured});
    await screenshot(`heading-${width}-${focused ? 'focus' : 'all'}`);
  }
  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => { styk.editor.clearLayerFocus(); styk.settingsUI.commit({touchInterface: 'on'}); }); await settle();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.touchLayout), 'phone-portrait');
  for (const focused of [false, true]) {
    await page.evaluate(focused => focused ? styk.timeline.focusSelectedLayers({ids: ['layer-2'], lock: true}) : styk.editor.clearLayerFocus(), focused); await settle();
    const measured = await headingBounds();
    assert.equal(measured.width, 148, 'phone touch uses the tested names column width');
    assert.ok(measured.buttons.every(button => button.fits), `148px phone-touch heading, focus ${focused}: ${JSON.stringify(measured)}`);
    assert.ok(measured.buttons.some(button => button.name === 'Filter layers'), 'phone touch keeps Filter layers');
    headingChecks.push({width: 148, focused, touch: true, ...measured});
    await screenshot(`heading-phone-${focused ? 'focus' : 'all'}`);
  }
  await page.evaluate(() => { styk.editor.clearLayerFocus(); styk.settingsUI.commit({touchInterface: 'off'}); });
  await page.setViewportSize({width: 1280, height: 900}); await settle();
  await page.getByRole('separator', {name: 'Resize layer names'}).press('Home');
  checks.push('layer header controls stay within 220 and 140 pixel columns with focus on or off, including phone touch at 148 pixels');

  await page.evaluate(() => {
    const report = styk.editor.serialize(), state = report._styk.layers;
    for (let i = 7; i <= 2000; i++) { const id = `layer-${i}`; state.order.push(id); state.byId[id] = {name: `Crowd ${i}`, visible: true, locked: false}; report._styk.layerSheet.tracks[id] = {keys: [], end: 0}; }
    state.nextId = 2001; styk.editor.load(report);
  }); await settle(); const denseBefore = await snapshot(); await open();
  await bounded();
  const search = filter().getByRole('searchbox', {name: 'Find layers or folders'});
  await search.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.dataset.filterId), 'camera');
  await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.dataset.filterId), 'layer-1');
  await page.keyboard.press('Space'); await settle();
  assert.equal(await page.evaluate(() => styk.timeline.tracks.some(row => row.id === 'layer-1')), false);
  await bounded();
  await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.dataset.filterId), 'camera');
  await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.dataset.filterId), 'scene');
  await screenshot('dense-light'); await unchanged(denseBefore, 'dense keyboard navigation and Space toggles retain saved data and bounded checklist rows');
  await done();
  for (const theme of ['dark', 'light']) for (const width of [520, 320]) {
    await page.setViewportSize({width, height: 740}); await page.evaluate(theme => styk.settingsUI.commit({theme}), theme); await settle();
    await open(); const bounds = await fit(); assert.ok(bounds.fits, `${width}px ${theme} filter fits the viewport: ${JSON.stringify(bounds)}`);
    await bounded();
    await screenshot(`${width}-${theme}`); await done();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({checks, headingChecks, denseLayers: 2000, maximumChecklistRows, compactWidths: [520, 320], themes: ['dark', 'light'], errors}, null, 2));
  console.log('PASS folder and child row filters, search, focus, persistence, quick folder, Simple multi-selection and dense keyboard/compact layouts');
} finally { await browser.close(); }
