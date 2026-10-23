/**
 * Browser test of the app's own prompts (src/app-dialogs.mjs) on the dialog
 * kit: Save changes?, Discard frame changes?, the Stick Nodes pack picker and
 * Recent files. The desktop-only flows run against a stand-in for the desktop
 * bridge; Save changes? also runs through the app's New command.
 * Serve the repository (node scripts/serve.mjs --port 47832) and run
 * `node tests/app-dialogs.browser.mjs`; STYK_URL overrides the address.
 */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';

const base = process.env.STYK_URL || 'http://127.0.0.1:47832';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const page = await browser.newPage({viewport: {width: 1280, height: 720}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(8000);
const settle = (ms = 80) => page.waitForTimeout(ms);
const openDialogs = () => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.querySelector('.ui-dialog-title')?.textContent ?? dialog.id));
const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.dataset.recentId || document.activeElement?.textContent.trim());
const step = async (name, run) => {
  try { await run(); console.log(`ok ${name}`); } catch (error) { console.log(`not ok ${name}`); throw error; }
};

try {
  await page.goto(base);
  await page.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
  // The prompts with a stand-in desktop bridge and save, recording what they call.
  await page.evaluate(async () => {
    const {createAppDialogs} = await import('/src/app-dialogs.mjs');
    const calls = window.dialogCalls = [];
    const recent = [{id: 'a', name: 'Kick combo.styk', directory: 'C:\\Projects'}, {id: 'b', name: 'Lost.styk', directory: 'E:\\', missing: true},
      {id: 'c', name: 'Backflip.piv', directory: 'D:\\Pivot'}];
    const desktop = {listRecentFiles: async () => recent.map(entry => ({...entry})), clearRecentFiles: async () => { calls.push('clear'); recent.length = 0; },
      openRecentFile: async id => { calls.push(`open:${id}`); return {id}; }};
    window.saveResult = false;
    const actions = {};
    const api = createAppDialogs({editor: styk.editor, state: styk.state, actions, desktop, overlays: styk.ui.overlays,
      playbackMetrics: {snapshot: () => ({fps: null, targetFps: 24, startupMs: null, bufferingMs: 0, bufferingEvents: 0})},
      guarded: fn => (...args) => fn(...args), pause: () => {}, finishCurrentEdit: () => {}, promptText: async () => null,
      saveNative: async () => { calls.push('save'); await new Promise(resolve => setTimeout(resolve, 50)); return window.saveResult; },
      acceptNativeFile: async result => { calls.push(`accept:${result.id}`); }, updateTitle: () => {}, localization: () => styk.localization});
    window.prompts = {...api, actions};
  });

  // A new animation opens beside the project (project tabs): closing the project is what asks about its changes.
  await step('Save changes? names the project, starts on Save and Don\'t save lets the project close', async () => {
    await page.evaluate(() => { styk.editor.name = 'Kick combo'; styk.editor.dirty = true; window.pendingNew = styk.actions['close-project'](); });
    await page.locator('#save-changes').waitFor();
    assert.deepEqual(await openDialogs(), ['Save changes to Kick combo?']);
    assert.equal(await focused(), 'save-changes');
    assert.deepEqual(await page.locator('dialog[open] .ui-dialog-foot button').allTextContents(), ['Don\'t save', 'Cancel', 'Save']);
    await page.locator('#discard-changes').click();
    await page.evaluate(() => window.pendingNew);
    assert.deepEqual([await page.evaluate(() => [styk.editor.dirty, styk.editor.name === 'Kick combo']), await openDialogs()], [[false, false], []]);
  });

  await step('Save changes?: Cancel, Escape and × keep the document; a save that does not finish keeps the prompt open', async () => {
    for (const close of [() => page.locator('#keep-editing').click(), () => page.keyboard.press('Escape'), () => page.locator('dialog[open] .ui-dialog-close').click()]) {
      await page.evaluate(() => { styk.editor.dirty = true; window.answer = prompts.confirmReplace(); });
      await page.locator('#save-changes').waitFor();
      await close();
      assert.equal(await page.evaluate(() => window.answer), false);
      assert.deepEqual(await openDialogs(), []);
    }
    await page.evaluate(() => { dialogCalls.length = 0; styk.editor.name = 'Kick combo'; window.saveResult = false; window.answer = prompts.confirmReplace(); });
    await page.locator('#save-changes').waitFor();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => dialogCalls.includes('save') && !document.querySelector('dialog[aria-busy]'));
    await settle();
    assert.deepEqual([await openDialogs(), await focused(), await page.locator('#save-changes').isEnabled()], [['Save changes to Kick combo?'], 'save-changes', true],
      'a cancelled save leaves the prompt as it was, ready to try again');
    await page.evaluate(() => { window.saveResult = true; });
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.answer), true, 'once saved, the document may be replaced');
    assert.deepEqual(await openDialogs(), []);
  });

  await step('Discard frame changes? keeps today\'s default: Enter discards, Keep changes and Escape keep the draft', async () => {
    for (const [press, expected] of [[() => page.keyboard.press('Enter'), true], [() => page.locator('#keep-frame-draft').click(), false], [() => page.keyboard.press('Escape'), false]]) {
      await page.evaluate(() => { window.answer = prompts.confirmDiscardFrame(); });
      await page.locator('#discard-frame-draft').waitFor();
      assert.equal(await focused(), 'discard-frame-draft');
      await press();
      assert.equal(await page.evaluate(() => window.answer), expected);
    }
  });

  await step('the Stick Nodes picker is one tab stop: the first asset starts focused, arrows move, Enter picks, Escape cancels', async () => {
    const entries = [{index: 4, name: 'Hero rig'}, {index: 7, name: 'Sword'}, {index: 9, name: 'Walk cycle'}];
    await page.evaluate(entries => { window.answer = prompts.chooseSticknodesEntry(entries); }, entries);
    await page.locator('dialog[open] .ui-dialog-choice').first().waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Hero rig');
    assert.deepEqual(await page.locator('dialog[open] .ui-dialog-choice').evaluateAll(buttons => buttons.map(button => button.tabIndex)), [0, -1, -1]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Walk cycle');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.answer), 9);
    await page.evaluate(entries => { window.answer = prompts.chooseSticknodesEntry(entries); }, entries);
    await page.locator('dialog[open] .ui-dialog-choice').first().waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.answer), null);
  });

  await step('Recent files: the command returns once the list shows; arrows skip an unavailable file and Enter opens one after the list closes', async () => {
    await page.evaluate(() => { dialogCalls.length = 0; });
    await page.evaluate(() => prompts.actions['open-recent']());   // resolves with the list open
    assert.deepEqual(await openDialogs(), ['Recent files']);
    assert.equal(await focused(), 'a');
    assert.equal(await page.locator('[data-recent-id=b]').isDisabled(), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), 'c', 'the unavailable file is skipped');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => dialogCalls.includes('accept:c'));
    assert.deepEqual([await page.evaluate(() => dialogCalls), await openDialogs()], [['open:c', 'accept:c'], []]);
  });

  await step('Recent files: Clear history empties the list in place and leaves Close focused', async () => {
    await page.evaluate(() => prompts.actions['open-recent']());
    await page.locator('#clear-recent').click();
    await page.waitForFunction(() => document.querySelector('.recent-files')?.textContent === 'No recent files.');
    assert.deepEqual([await openDialogs(), await page.locator('#clear-recent').isHidden(), await focused()], [['Recent files'], true, 'Close']);
    await page.keyboard.press('Enter');
    assert.deepEqual(await openDialogs(), []);
  });

  await step('a prompt opens over another dialog and leaves it as it was', async () => {
    await page.evaluate(() => styk.actions.performance());
    await page.locator('#performance-dialog[open]').waitFor();
    await page.evaluate(() => { window.answer = prompts.confirmDiscardFrame(); });
    await page.locator('#discard-frame-draft').waitFor();
    assert.deepEqual(await openDialogs(), ['Performance', 'Discard frame changes?']);
    await page.keyboard.press('Escape');
    assert.deepEqual(await openDialogs(), ['Performance']);
    await page.keyboard.press('Escape');
    assert.deepEqual(await openDialogs(), []);
  });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
