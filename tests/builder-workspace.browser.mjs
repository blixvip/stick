import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
const output='artifacts/builder-workspace';await mkdir(output,{recursive:true});
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try {
  await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47841');await page.waitForFunction(()=>window.styk?.ready);
  const enter=()=>page.locator('[data-workspace-mode="rig"]').click();
  await enter();await settle();
  // Structure starts folded to its strip; docked, it keeps its tree, its foot and its splitter.
  assert.equal(await page.locator('.builder-tree').isVisible(),false);
  await page.evaluate(()=>styk.workspace.dock('structure','left'));await settle();
  assert.equal(await page.locator('.workspace > .studio-rail [data-tool]:visible').count(),7);
  assert.equal(await page.locator('.timeline-panel').isVisible(),false);
  await page.locator('#builder-timeline-toggle').click();await settle();
  assert.equal(await page.locator('.timeline-panel').isVisible(),true);
  await page.locator('#builder-timeline-toggle').click();await settle();
  // The part's commands are its tiles in Properties: none while the figure itself is selected.
  assert.equal(await page.locator('.ui-quick [data-action="split-segment"]').count(),0);
  await page.locator('.builder-tree-row').first().click();await settle();
  assert.equal(await page.locator('.ui-quick [data-action="split-segment"]').isEnabled(),true);
  const before=await page.evaluate(()=>styk.editor.figure.segments.length);
  await page.locator('.ui-quick [data-action="split-segment"]').click();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments.length),before+1);
  await page.keyboard.press('Control+z');await settle();
  assert.equal(await page.evaluate(()=>styk.editor.figure.segments.length),before);
  // Whole branch is one of the rail's Build options.
  const whole=page.locator('.rail-quick [data-action="toggle-builder-branch"]');
  await whole.click();await settle();
  assert.equal(await whole.getAttribute('aria-pressed'),'true');
  await whole.click();
  await page.locator('.builder-footer [data-action="zoom-selection"]').click();await settle();
  await page.screenshot({path:`${output}/desktop.png`});
  // Structure's width is the left dock's: its splitter steps 12px from the 232px default.
  const resize=page.getByRole('separator',{name:'Resize figure structure'});await resize.focus();await page.keyboard.press('ArrowRight');
  assert.equal(await resize.getAttribute('aria-valuenow'),'244');await page.keyboard.press('Home');
  // Canvas selection expands collapsed ancestors and keyboard follows selection.
  await page.locator('.builder-tree-row').first().locator('.builder-twisty').click();
  await page.evaluate(()=>styk.editor.select(styk.editor.selectedUid,2));await settle();
  assert.equal(await page.locator('.builder-tree-row[aria-selected="true"]').count(),1);
  await page.locator('.builder-tree').focus();await page.keyboard.press('ArrowDown');await settle();
  assert.ok(await page.locator('.builder-tree').getAttribute('aria-activedescendant'));
  await page.setViewportSize({width:1100,height:760});await settle();
  await page.locator('.builder-footer [data-action="zoom-selection"]').click();await settle();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.ok((await page.locator('.builder-tree').boundingBox()).height>80);
  assert.ok((await page.locator('#viewport').boundingBox()).height>180);
  await page.screenshot({path:`${output}/compact.png`});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await settle();
  await page.screenshot({path:`${output}/dark.png`});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.locator('#builder-timeline-toggle').click();await settle();
  assert.equal(await page.locator('.timeline-panel').isVisible(),true);
  await page.screenshot({path:`${output}/timeline.png`});
  await page.locator('#builder-done').click();await settle();
  if(await page.locator('#builder-exit-update').count()) await page.locator('#builder-exit-update').click();
  assert.equal(await page.evaluate(()=>styk.builder.active),false);
  assert.equal(await page.locator('.workspace > .studio-rail').count(),1);
  await enter();await settle();assert.ok(await page.locator('.builder-tree-row').count());
  // Exercise a real new-figure drawing session and discard its commands.
  await page.locator('#builder-done').click();
  await page.evaluate(()=>styk.editor.select(null));await enter();await settle();
  assert.equal(await page.locator('.builder-outliner-empty').isVisible(),true);
  const rect=await page.locator('#overlay').boundingBox();
  await page.mouse.move(rect.x+120,rect.y+70);await page.mouse.down();await page.mouse.move(rect.x+220,rect.y+130,{steps:5});await page.mouse.up();await settle();
  assert.equal(await page.evaluate(()=>styk.builder.session.figure.segments.length),1);
  assert.equal(await page.locator('.builder-outliner-empty').isVisible(),false);
  await page.locator('#builder-done').click();await page.locator('#builder-exit-discard').click();
  assert.equal(await page.evaluate(()=>styk.builder.active),false);
  assert.deepEqual(errors,[]);
  console.log('PASS builder workspace: side toolbar, selection gating, split/undo, branch scope, timeline toggle, fit, resize keyboard, hierarchy reveal/navigation, compact layout, repeated sessions, drawing and discard; no page errors.');
} finally {await browser.close();}
