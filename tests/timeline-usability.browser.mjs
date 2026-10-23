/** Filmstrip and layer-sheet timeline usability: thumbnail discipline, controls, navigation. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from './support/playwright.mjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), out = path.join(root, 'artifacts');
await mkdir(out, {recursive: true});
const report = emptyDocument();
report.keyframes = Array.from({length: 6}, (_, index) => ({...createFrame([
  createObject(report.figure_types[0], 1, 180 + index * 40, 270),
  createObject(report.figure_types[0], 2, 420, 260),
], 8)}));
const fixture = new Editor({demo: false}).load(report);
const sourcePath = path.join(out, 'timeline-usability-source.styk');
await writeFile(sourcePath, JSON.stringify(fixture.serialize()));

const browser = await chromium.launch({channel:'chrome', headless:true});
const page = await browser.newPage({viewport:{width:1440,height:940}});
const errors = [], checks = [];
page.on('pageerror', error => {errors.push(error.message);console.error(error.stack);});
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS', label); };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const idle = async () => {
  await page.waitForFunction(() => { const t = styk.timeline; return !t.busy && !(t.queue?.length) && (t.previews === undefined || t.previews.size > 0); });
  await settle();
};
const mode = async value => {
  await page.evaluate(() => styk.settingsUI.open('interface'));
  await page.locator(`.styk-settings[open] [data-setting=timelineMode][value=${value}]`).check();
  await page.getByRole('button', {name:'Close settings',exact:true}).click();
  await settle();
};
try {
  await page.goto('http://127.0.0.1:47831');
  await page.waitForFunction(() => window.styk?.ready);
  await page.evaluate(() => { globalThis.__previousOpenDocument = styk.editor.report; });
  await page.locator('#file-input').setInputFiles(sourcePath);
  await page.waitForFunction(() => styk.editor.report !== globalThis.__previousOpenDocument);
  await mode('simple'); await idle();
  const baseline = await page.evaluate(() => ({renders:styk.thumbnails.stats.renders, snapshots:styk.thumbnails.stats.snapshots, version:styk.thumbnails.version}));
  for (const index of [0,1,2,1,0,2,0]) await page.locator(`#timeline [data-frame="${index}"] .sheet-preview`).click();
  await idle();
  check('Repeated frame navigation renders zero additional thumbnails', await page.evaluate(renders => styk.thumbnails.stats.renders === renders, baseline.renders));
  check('Clean seeks do not invalidate the thumbnail worker document', await page.evaluate(version => styk.thumbnails.version === version, baseline.version));

  const ids = await page.evaluate(() => ({
    ids: Object.values(styk.editor.report._styk.layerSheet.tracks).flatMap(track => track.keys.map(key => key.id)).sort(),
    total: styk.editor.totalTicks,
  }));
  const slider = page.locator('#timeline [data-frame="0"] input[type=range]');
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height/2); await page.mouse.down();
  await page.mouse.move(box.x + box.width*.65, box.y + box.height/2, {steps:20}); await page.mouse.up();
  await idle();
  check('Dragging the inbetweens slider retimes the span without losing any key', await page.evaluate(before =>
    JSON.stringify(Object.values(styk.editor.report._styk.layerSheet.tracks).flatMap(track => track.keys.map(key => key.id)).sort()) === JSON.stringify(before.ids)
      && styk.editor.totalTicks !== before.total, ids));
  check('A timing change resends the document at most once for all thumbnails', await page.evaluate(before =>
    styk.thumbnails.stats.snapshots - before.snapshots <= 1, baseline));
  await slider.press('ArrowLeft'); await idle();
  check('Slider keyboard edits remain inside the control', await page.evaluate(() => styk.editor.frameIndex === 0));
  const beforePatch = await page.evaluate(() => ({...styk.thumbnails.stats}));
  await page.evaluate(() => { const t = styk.timeline; t.previews.delete(t.selectedIndex); t.render(); });
  await idle();
  check('A thumbnail refresh without document changes resends nothing', await page.evaluate(before =>
    styk.thumbnails.stats.snapshots === before.snapshots && styk.thumbnails.stats.patches === before.patches &&
    styk.thumbnails.stats.renders > before.renders, beforePatch));

  const local = await page.evaluate(() => {
    const before = {...styk.thumbnails.stats};
    styk.editor.select(styk.editor.frame.objects[0].unique_id); styk.editor.moveSelection(12,0); styk.editor.commitDrag();
    return before;
  });
  await idle();
  check('Editing a pose refreshes the filmstrip thumbnails through a patch', await page.evaluate(before =>
    styk.thumbnails.stats.renders > before.renders && styk.thumbnails.stats.patches > before.patches &&
    styk.thumbnails.stats.snapshots === before.snapshots, local));
  await page.evaluate(() => styk.timeline.selectFrame(3)); await idle();
  check('Direct filmstrip navigation selects the requested keyframe', await page.evaluate(() => styk.timeline.selectedIndex === 3));
  await idle(); await page.screenshot({path:'artifacts/timeline-simple-redesign.png'});

  await mode('advanced');
  const grid = page.locator('#timeline .sheet-scroll');
  await grid.focus();
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  check('ArrowRight advances exactly one output frame', await page.evaluate(() => styk.editor.tick === 1));
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft moves back exactly one output frame', await page.evaluate(() => styk.editor.tick === 0));
  await page.getByLabel('Go to frame', {exact:true}).fill('17');
  await page.getByLabel('Go to frame', {exact:true}).press('Enter'); await settle();
  check('Go to frame uses one-based frame numbers', await page.evaluate(() => styk.editor.tick === 16));
  await page.evaluate(() => { const t = styk.timeline; styk.editor.select(styk.editor.frame.objects[0].unique_id);
    const row = t.tracks.findIndex(track => track.id === t.selectedTrackId); t._selectCell({row, tick:0}); t._selectCell({row, tick:10}, {extend:true}); });
  const sheetBefore = await page.evaluate(() => JSON.stringify(styk.editor.report._styk.layerSheet));
  const ruler = await grid.boundingBox();
  await page.mouse.move(ruler.x+80, ruler.y+14); await page.mouse.down();
  await page.mouse.move(ruler.x+200, ruler.y+14,{steps:15}); await page.mouse.up(); await settle();
  check('Scrubbing the ruler moves the playhead without altering authored keys', await page.evaluate(before =>
    styk.editor.tick !== 0 && JSON.stringify(styk.editor.report._styk.layerSheet) === before, sheetBefore));
  await page.locator('#timeline .sheet-zoom').fill('6'); await settle();
  check('The zoom slider rescales the sheet', await page.evaluate(() => styk.timeline.pxPerTick === 6));
  check('The view switch is removed', await page.locator('#timeline button[aria-label="Frames"]').count() === 0);
  await page.evaluate(()=>{styk.editor.select(styk.editor.frame.objects[0].unique_id);});
  check('The layer sheet follows the object selection',await page.evaluate(()=>{const t=styk.timeline;return t.selectedTrackId===styk.editor.layerForUid(styk.editor.selectedUid);}));
  await page.evaluate(()=>{styk.editor.select(null);});
  check('The layer sheet keeps a stable set of tracks',await page.evaluate(()=>{const t=styk.timeline;return t.tracks.length===2+styk.editor.report._styk.layers.order.length;}));
  await page.evaluate(() => { const t = styk.timeline; const row = t.tracks.findIndex(track => track.id === t.selectedTrackId); t._selectCell({row, tick:0}); });
  const beforeAdd = await page.evaluate(() => JSON.stringify(styk.editor.report._styk.layerSheet));
  await page.locator('.timeline-toolbar .sheet-add-button').click(); await settle();
  check('The Add Frame toolbar button inserts a layer key', await page.evaluate(before => JSON.stringify(styk.editor.report._styk.layerSheet) !== before, beforeAdd));
  await grid.focus(); await page.keyboard.press('a'); await settle();
  check('The add-frame hotkey inserts another key', await page.evaluate(before => JSON.stringify(styk.editor.report._styk.layerSheet) !== before, beforeAdd));
  await page.evaluate(()=>{styk.editor.undo();styk.editor.undo();});
  check('Onion skin is enabled by default',await page.locator('#onion-button').getAttribute('aria-pressed')==='true');
  await page.locator('#onion-settings-button').click();
  const onion=page.getByRole('dialog',{name:'Onion skin settings',exact:true});
  await onion.locator('[data-onion=onionBefore]').fill('3');
  await onion.locator('[data-onion=onionAfter]').fill('2');
  await settle();
  check('Onion controls live in the timeline toolbar',await page.locator('.timeline-toolbar #onion-button').count()===1);
  check('Onion directions have independent counts',await page.evaluate(()=>styk.state.settings.onionBefore===3&&styk.state.settings.onionAfter===2));
  await page.evaluate(()=>styk.editor.seek(24));await settle();
  const onionBuilds=await page.evaluate(()=>styk.onionCache.stats.builds);
  await onion.locator('[data-onion=onionOpacity]').fill('48');await settle();
  check('Changing onion opacity reuses sampled geometry',await page.evaluate(builds=>styk.onionCache.stats.builds===builds,onionBuilds));
  check('Enabled onion skins contain tinted geometry',await page.evaluate(()=>styk.onionCache.last.frames.length===5&&styk.onionCache.last.frames.some(s=>s.geometry.drawables.some(d=>d.rgb[0]>d.rgb[2]))));
  await onion.getByLabel('Show on top',{exact:true}).check();await settle();
  check('Show on top updates onion composition without rebuilding geometry',await page.evaluate(builds=>styk.state.settings.onionShowOnTop&&styk.onionCache.last.frames.every(s=>s.showOnTop)&&styk.onionCache.stats.builds===builds,onionBuilds));
  await page.screenshot({path:'artifacts/onion-show-on-top.png'});
  await onion.getByLabel('Show on top',{exact:true}).uncheck();await settle();
  check('Disabling Show on top restores behind-scene composition',await page.evaluate(()=>styk.onionCache.last.frames.every(s=>!s.showOnTop)));
  await onion.getByLabel('Show on top',{exact:true}).check();await settle();
  await onion.locator('summary').click();await settle();
  await onion.locator('[data-onion-scope=selected]').click();await settle();
  check('Onion scope applies immediately',await page.evaluate(()=>styk.state.settings.onionScope==='selected'));
  await page.screenshot({path:'artifacts/onion-skin-redesign.png'});
  await page.keyboard.press('Escape');await settle();
  check('Escape closes onion options without toggling playback',await onion.count()===0);
  await page.evaluate(()=>styk.settingsUI.open('animation'));
  check('Onion controls are removed from Settings',await page.locator('.styk-settings [data-setting^=onion]').count()===0);
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.locator('#onion-button').click();
  const beforeEase = await page.evaluate(() => JSON.stringify(styk.editor.report._styk.layerSheet));
  const targetEasing = await page.evaluate(() => styk.timeline.easing.value === 'linear' ? 'ease-in' : 'linear');
  await page.selectOption('#timeline .sheet-frame-tools .inline-select', targetEasing); await settle();
  check('The interpolation select retimes the selected span', await page.evaluate(before => JSON.stringify(styk.editor.report._styk.layerSheet) !== before, beforeEase));
  await page.evaluate(()=>styk.editor.undo());
  const heads = await page.evaluate(async () => {
    const t = styk.timeline;
    for (const tick of [1,4,8,12,2]) { styk.editor.seek(tick); t.resize(); await new Promise(requestAnimationFrame); }
    return document.querySelectorAll('#timeline .sheet-playhead').length;
  });
  check('Repeated layout changes leave exactly one playhead marker', heads === 1);
  await page.screenshot({path:'artifacts/timeline-advanced-redesign.png'});
  for (const width of [1100,900]) {
    await page.setViewportSize({width,height:800}); await settle();
    check(`Timeline controls fit at ${width}px window width`, await page.evaluate(() => {
      const t=styk.timeline, outer=t.root.getBoundingClientRect();
      return [...t.root.querySelectorAll('.sheet-footer button,.sheet-footer input,.sheet-footer select,.sheet-label-head button')].filter(n=>n.getClientRects().length).every(n=>{ const r=n.getBoundingClientRect(); return r.left>=outer.left-1 && r.right<=outer.right+1 && r.bottom<=outer.bottom+1; });
    }));
    await page.screenshot({path:`artifacts/timeline-advanced-${width}.png`});
  }
  await page.evaluate(()=>styk.settingsUI.flush());await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  check('Onion customization persists after reloading',await page.evaluate(()=>styk.state.settings.onionBefore===3&&styk.state.settings.onionAfter===2&&styk.state.settings.onionOpacity===.48&&styk.state.settings.onionScope==='selected'));
  check('Show on top persists after reloading',await page.evaluate(()=>styk.state.settings.onionShowOnTop===true));
  check('No browser errors', errors.length === 0);
  await writeFile('artifacts/timeline-usability-verification.json',JSON.stringify({checks,errors,baseline},null,2));
} finally { await browser.close(); }
