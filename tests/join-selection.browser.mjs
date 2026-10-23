import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('artifacts/join-selection'); await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1560, height: 1000}}), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, value) => {assert.ok(value, name); checks.push(name); console.log('PASS', name);};
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function fixture(mode = 'advanced') {
  await page.evaluate(async mode => {
    const {emptyDocument, defaultFigure, createObject, createFrame} = await import('/src/demo.mjs');
    const report = emptyDocument(), figure = defaultFigure();
    figure.segments[3].is_static = true; figure.segments[3].aux_code = 1;
    report.figure_types = [figure];
    report.keyframes = [0, 1].map(() => createFrame([createObject(figure, 101, 230, 280), createObject(figure, 707, 550, 280), createObject(figure, 909, 830, 280)]));
    styk.settingsUI.commit({timelineMode: mode, showHandles: true}); styk.editor.load(report);
    styk.state.tool = 'select'; styk.state.onion = false; styk.state.handles = true;
    styk.state.applyRange = false; styk.state.rangeIndices = [0]; styk.state.hidden.clear(); styk.state.locked.clear();
    styk.state.view = {x: 50, y: 30, scale: 1}; styk.editor.select(707);
  }, mode);
  await page.locator('#viewport').focus(); await settle();
}
const point = (uid, index) => page.evaluate(({uid, index}) => {
  const {editor, state} = styk, g = [...editor.geometry.objects.values()].find(g => g.obj.unique_id === uid);
  const p = index < 0 ? g.root : g.segments[index].end;
  const rect = document.getElementById('overlay').getBoundingClientRect();
  return {x: rect.x + state.view.x + p.x * state.view.scale, y: rect.y + state.view.y + p.y * state.view.scale};
}, {uid, index});
const click = async (uid, index, options) => {const p = await point(uid, index); await page.mouse.click(p.x, p.y, options); await settle();};
const menu = () => page.locator('#menu [data-action="join-figure"]');
const joined = () => page.evaluate(() => styk.editor.selectionFrame.objects.find(o => o.unique_id === 707).join);
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready);
  for (const mode of ['advanced', 'simple']) {
    await fixture(mode);
    await click(707, 6); await page.keyboard.press('j'); await settle();
    check(`${mode}: J from a segment starts joining without hiding handles`, await page.evaluate(() => styk.state.tool === 'attach' && styk.state.handles));
    await page.screenshot({path: path.join(out, `${mode}-join-targets.png`)});
    await click(101, 3);
    check(`${mode}: hidden static parent handle accepts the join`, (await joined())?.target_unique_id === 101 && (await joined())?.target_handle_id === 4);
    check(`${mode}: joining keeps the selected child node`, await page.evaluate(() => styk.editor.selectedUid === 707 && styk.editor.selectedJoint === 6));
    const root = await page.evaluate(() => ({...styk.editor.geometry.objects.get(1).root}));
    await click(707, 6, {button: 'right'});
    check(`${mode}: node context menu exposes Unjoin and J`, /Unjoin figure/.test(await menu().innerText()) && /J/.test(await menu().innerText()));
    await page.screenshot({path: path.join(out, `${mode}-unjoin-menu.png`)});
    await menu().click();
    check(`${mode}: context action detaches with no visible jump`, !(await joined()) && JSON.stringify(await page.evaluate(() => styk.editor.geometry.objects.get(1).root)) === JSON.stringify(root));
    await page.locator('#viewport').focus(); await page.keyboard.press('Control+z');
    check(`${mode}: undo restores the attachment`, Boolean(await joined()));
    await page.keyboard.press('j'); check(`${mode}: J also detaches`, !(await joined()));
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
    check(`${mode}: undo joining restores the original free figure`, !(await joined()));

    await fixture(mode); await click(707, 3);
    check(`${mode}: hidden static node is softly selected without history`, await page.evaluate(() => styk.editor.selectedUid === 707 && styk.editor.selectedJoint === 3 && !styk.editor.canUndo && !styk.state.drag && !styk.editor._drag));
    const before = await page.evaluate(() => JSON.stringify(styk.editor.frame));
    let p = await point(707, 3); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 30, p.y + 20); await page.mouse.up();
    check(`${mode}: ordinary drag on a static node does not move the pose`, await page.evaluate(() => JSON.stringify(styk.editor.frame)) === before);
    await page.keyboard.down('Shift'); await click(101, 3); await page.keyboard.up('Shift');
    check(`${mode}: Shift-click static node adds a figure`, await page.evaluate(() => styk.editor.selectedUids.size === 2));
    await page.keyboard.press('j'); check(`${mode}: ambiguous multi-selection does not start joining`, await page.evaluate(() => styk.state.tool === 'select'));
    await page.evaluate(() => {styk.editor.select(707); styk.editor.joinTo(101, 4); styk.editor.select(909);});
    p = await point(101, 3); await page.mouse.dblclick(p.x, p.y); await settle();
    check(`${mode}: static-node double-click selects its branch with attachments`, await page.evaluate(() => styk.editor.branchSelected && styk.editor.selectedUid === 101 && styk.editor.selectedJoint === 3 && styk.editor.selectedUids.has(707) && !styk.editor.selectedUids.has(909)));
  }
  await fixture();
  await page.locator('#inspector [data-action="join-figure"]').click();
  check('Inspector connection button starts the shared action', await page.evaluate(() => styk.state.tool === 'attach'));
  await click(101, 3);
  check('Inspector button changes to Unjoin', /Unjoin/.test(await page.locator('#inspector [data-action="join-figure"]').getAttribute('data-hotkey-title')));
  await page.screenshot({path: path.join(out, 'inspector-connection.png')});
  await page.locator('#inspector [data-action="join-figure"]').click();
  check('Inspector button unjoins the same figure', !(await joined()));
  await fixture(); await click(707, 6);
  await page.evaluate(() => {
    styk.timeline.start = 0; styk.timeline.end = 1; styk.timeline.selectedLayers = new Set(['layer-1']);
    styk.state.applyRange = true;
  });
  await page.keyboard.press('j');
  check('Join gesture captures the selected authored range', await page.evaluate(() => styk.state.figureJoin.indices?.sheetTicks?.length === 2));
  await click(101, 3);
  check('Range join updates both selected ticks in one undo step', await page.evaluate(() => {
    const e = styk.editor; const first = e.object.join?.target_unique_id; e.seek(1);
    return first === 101 && e.object.join?.target_unique_id === 101 && e._undo.length === 1;
  }));
  await page.locator('#viewport').focus(); await page.keyboard.press('Control+z');
  check('Range undo restores both free poses', await page.evaluate(() => {
    const e = styk.editor; e.seek(0); const first = !e.object.join; e.seek(1); return first && !e.object.join;
  }));
  await fixture();
  await click(707, 6, {button: 'right'}); await menu().click();
  check('Context menu starts the same join gesture as J', await page.evaluate(() => styk.state.tool === 'attach' && styk.state.figureJoin.uid === 707));
  await page.keyboard.press('Escape'); check('Escape cancels without creating history', await page.evaluate(() => styk.state.tool === 'select' && !styk.editor.canUndo));
  await page.keyboard.press('j'); await page.keyboard.press('j');
  check('Pressing J again cancels the pending join', await page.evaluate(() => styk.state.tool === 'select' && !styk.editor.canUndo));
  await page.keyboard.press('j'); await page.evaluate(() => styk.editor.select(909));
  check('Changing selection cancels a pending join', await page.evaluate(() => styk.state.tool === 'select' && !styk.state.figureJoin));
  await click(707, 6); await page.keyboard.press('j'); await page.evaluate(() => styk.editor.selectFrame(1));
  check('Changing frames cancels a pending join', await page.evaluate(() => styk.state.tool === 'select' && !styk.state.figureJoin));
  await fixture(); await page.keyboard.press('Shift+j');
  check('Shift J retains the visibility command', await page.evaluate(() => !styk.state.handles));
  await page.keyboard.press('j'); await click(101, 3);
  check('Joining works while ordinary handles are hidden', Boolean(await joined()));
  await fixture();
  await page.evaluate(() => styk.state.locked.add(707)); await page.keyboard.press('j');
  check('Locked source cannot join', await page.evaluate(() => styk.state.tool === 'select'));
  await fixture(); await page.evaluate(() => {styk.editor.select(707); styk.editor.joinTo(101, 3); styk.editor.select(101, 2);});
  await page.keyboard.press('j');
  check('Join gesture excludes the source and its descendants', await page.evaluate(() => !styk.state.figureJoin.targets.has(101) && !styk.state.figureJoin.targets.has(707) && styk.state.figureJoin.targets.has(909)));
  await page.keyboard.press('Escape');
  const branchPoint = await point(101, 2); await page.mouse.dblclick(branchPoint.x, branchPoint.y); await settle();
  check('Dynamic-node double-click retains branch selection', await page.evaluate(() => styk.editor.branchSelected && styk.editor.selectedUids.size === 2));
  await page.keyboard.press('j'); await click(909, 6);
  check('J on a branch joins its owning figure without detaching its children', await page.evaluate(() => {
    const objects = styk.editor.selectionFrame.objects;
    return objects[0].join?.target_unique_id === 909 && objects[1].join?.target_unique_id === 101;
  }));
  await fixture(); await page.locator('#inspector input').first().focus(); await page.keyboard.press('j');
  check('J does not run while typing in a property field', await page.evaluate(() => styk.state.tool === 'select'));
  await page.locator('#viewport').focus();
  await page.evaluate(() => styk.settingsUI.commit({hotkeys: {...styk.hotkeys.bindings, 'join-figure': ['KeyQ']}}));
  await page.keyboard.press('j'); check('Custom binding removes J', await page.evaluate(() => styk.state.tool === 'select'));
  await page.keyboard.press('q'); check('Custom binding starts joining', await page.evaluate(() => styk.state.tool === 'attach'));
  await page.keyboard.press('Escape'); await click(707, 6, {button: 'right'});
  check('Context menu displays the custom shortcut', /Q/.test(await menu().innerText()));
  await page.keyboard.press('Escape');
  await page.evaluate(() => styk.builder.enter()); await page.keyboard.press('q');
  check('Join shortcut is inactive inside the figure builder', await page.evaluate(() => styk.state.tool !== 'attach'));
  check('No uncaught browser errors', errors.length === 0);
  await writeFile(path.join(out, 'report.json'), JSON.stringify({checks, errors}, null, 2));
} catch (error) {
  await page.screenshot({path: path.join(out, 'failure.png')}); throw error;
} finally {await browser.close();}
