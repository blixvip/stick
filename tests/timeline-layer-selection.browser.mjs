import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const out = 'artifacts/timeline-layer-selection';
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
page.setDefaultNavigationTimeout(60000); page.setDefaultTimeout(15000);
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const row = id => page.locator(`.sheet-layer[data-layer-id="${id}"]:visible .sheet-layer-name`);
const selected = () => page.evaluate(() => styk.timeline.ids.toSorted());
const checks = [];
try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831/'); await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = report.figure_types[0];
    report.keyframes = [createFrame([1, 2, 3].map(uid => createObject(figure, uid, uid * 100, 100)), 10)];
    styk.settingsUI.commit({timelineMode: 'advanced'});
    const editor = styk.editor; editor.load(report);
    for (const name of ['Second', 'Third', 'Empty']) editor.createLayer(name);
    editor.assignFiguresToLayer([2], 'layer-2'); editor.assignFiguresToLayer([3], 'layer-3');
    editor.setActiveLayer('layer-1'); editor.select(1);
  }); await settle();
  await row('layer-2').click({modifiers: ['Control']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-2']);
  await row('layer-4').click({modifiers: ['Control']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-2', 'layer-4']);
  checks.push('Ctrl adds artwork and empty layers without selection publication resetting the rows');
  await row('layer-4').click({modifiers: ['Control']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-2']);
  assert.equal(await page.evaluate(() => styk.editor.activeLayerId), 'layer-2');
  await row('layer-2').click({modifiers: ['Control']}); await settle();
  assert.deepEqual(await selected(), ['layer-1']);
  await row('layer-3').click({modifiers: ['Meta']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-3']);
  checks.push('Ctrl removes the active row and Cmd adds a row across host UI updates');
  await row('layer-4').click(); await row('layer-2').click({modifiers: ['Shift']}); await settle();
  assert.deepEqual(await selected(), ['layer-2', 'layer-3', 'layer-4']);
  await row('layer-1').click({modifiers: ['Shift']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-2', 'layer-3', 'layer-4']);
  await row('layer-3').click({modifiers: ['Shift']}); await settle();
  assert.deepEqual(await selected(), ['layer-3', 'layer-4']);
  checks.push('Repeated Shift clicks extend and shrink from the original row');
  await row('layer-4').click();
  await page.getByRole('button', {name: 'Find layers', exact: true}).click();
  const search = page.getByRole('searchbox', {name: 'Find layers'});
  await search.fill('second'); await settle();
  await page.evaluate(() => styk.editor.renameLayer('layer-3', 'Third renamed')); await settle();
  assert.equal(await search.inputValue(), 'second'); assert.ok(await search.isVisible());
  assert.deepEqual(await selected(), ['layer-2'], 'An unrelated metadata refresh retains the visible search selection');
  await search.fill('no matching layer'); await settle();
  assert.equal(await search.inputValue(), 'no matching layer'); assert.ok(await search.isVisible());
  await search.press('Escape'); await settle();
  checks.push('Find layers remains open across unrelated UI refreshes and an empty search result');
  await page.evaluate(() => styk.editor.createLayerFolder('Shot', ['layer-2', 'layer-3'])); await settle();
  await row('layer-4').click(); await row('layer-1').click({modifiers: ['Shift']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-2', 'layer-3', 'layer-4']);
  assert.equal(await page.evaluate(() => [...styk.timeline.selectedLayers].some(id => id.startsWith('folder-'))), false);
  await page.screenshot({path: `${out}/folder-range.png`});
  checks.push('Ranges span folder children without selecting the folder as an editing layer');
  await page.evaluate(() => {
    const editor = styk.editor, report = editor.serialize(), layers = report._styk.layers;
    for (let index = 5; index <= 400; index++) {
      const id = `layer-${index}`; layers.order.push(id); layers.byId[id] = {name: `Crowd ${index}`, visible: true, locked: false};
      report._styk.layerSheet.tracks[id] = {keys: [], end: 0};
    }
    layers.nextId = 401; editor.load(report); editor.select(1);
  }); await settle();
  await row('layer-1').click();
  await page.evaluate(() => {
    const timeline = styk.timeline, index = timeline.tracks.findIndex(track => track.id === 'layer-200');
    timeline._scrollToY(timeline.layout.top(index) - (timeline.layout.contentTop - timeline.layout.header));
  }); await settle();
  await row('layer-200').click({modifiers: ['Control']}); await settle();
  assert.deepEqual(await selected(), ['layer-1', 'layer-200']);
  assert.ok(await page.evaluate(() => styk.timeline.labels.length < 25), 'The layer labels remain virtualized');
  checks.push('A recycled label selects its current layer while preserving an offscreen member');
  assert.deepEqual(errors, []); await writeFile(`${out}/report.json`, JSON.stringify({checks, errors}, null, 2));
  console.log(`PASS ${checks.length} layer selection browser checks`);
} catch (error) {
  console.log('Layer selection failure state', await page.evaluate(() => ({
    ids: styk.timeline.ids, active: styk.editor.activeLayerId, rowCount: styk.timeline.tracks?.length,
    rows: [...document.querySelectorAll('.sheet-layer:not([hidden])')].map(row => row.dataset.layerId),
    scrollTop: styk.timeline.scroll.scrollTop, clientHeight: styk.timeline.scroll.clientHeight,
    targetTop: styk.timeline.layout?.top(styk.timeline.tracks.findIndex(row => row.id === 'layer-200')),
  })).catch(() => null));
  console.log('Page errors', errors);
  throw error;
} finally {await browser.close();}
