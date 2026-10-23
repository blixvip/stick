import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import {pcmWave} from '../src/audio-pcm.mjs';

const out = 'artifacts/audio-navigation'; await mkdir(out, {recursive:true});
const samples = Float32Array.from({length:48000 * 4}, (_, i) => Math.sin(i * Math.PI * 440 / 24000) * (.25 + .2 * Math.sin(i / 3000) ** 2));
await writeFile(`${out}/Dialogue.wav`, new Uint8Array(await pcmWave([samples]).arrayBuffer()));
const browser = await chromium.launch({channel:'chrome', headless:true, ignoreDefaultArgs:['--hide-scrollbars'], args:['--autoplay-policy=no-user-gesture-required']}), page = await browser.newPage({viewport:{width:1440, height:1000}}), errors = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const button = page.getByRole('button', {name:'Audio', exact:true});
try {
  await page.goto(process.env.STYK_URL ?? 'http://127.0.0.1:47831'); await page.waitForFunction(() => window.styk?.ready); await settle();
  assert.equal(await button.count(), 1); assert.equal(await button.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.audio-timeline').isVisible(), false);
  assert.ok((await page.locator('body').innerText()).includes('Untitled animation')); assert.deepEqual(errors, []);
  const baseHeight = await page.locator('.timeline-panel').evaluate(node => node.clientHeight);
  await page.screenshot({path:`${out}/default.png`});
  console.log('Dev server verified: app renders, Audio icon is available, no persistent audio bar.');
  await button.click(); await settle();
  assert.equal(await page.getByText('Add music, dialogue or sound effects', {exact:true}).isVisible(), true);
  await page.screenshot({path:`${out}/empty.png`});
  await page.getByRole('button', {name:'Close audio', exact:true}).click(); await settle();
  assert.equal(await button.evaluate(node => document.activeElement === node), true, 'Closing returns keyboard focus to the Audio icon');
  assert.equal(await page.locator('.timeline-panel').evaluate(node => node.clientHeight), baseHeight);
  await page.evaluate(async () => {
    const {emptyDocument, createFrame, createObject} = await import('/src/demo.mjs'), report = emptyDocument(); report.fps = 12;
    report.keyframes = Array.from({length:8}, (_, i) => createFrame([createObject(report.figure_types[0], 1, 220 + i * 20, 250)], 24));
    styk.settingsUI.commit({timelineMode:'advanced'}); styk.editor.load(report); styk.fit();
  });
  await button.click(); await page.getByLabel('Choose audio recording').setInputFiles(`${out}/Dialogue.wav`);
  await page.waitForFunction(() => styk.editor.report._styk.audio?.tracks.length === 1); await settle();
  await page.getByRole('button', {name:'New audio track', exact:true}).click(); await settle();
  assert.equal(await page.locator('.timeline-panel').evaluate(node => node.clientHeight), baseHeight, 'Importing and adding audio tracks preserves timeline height');
  const geometry = await page.evaluate(() => {
    const audio = styk.timeline.audio, host = styk.timeline, main = host.main.getBoundingClientRect(), clip = audio.clipLayer.querySelector('[data-clip]').getBoundingClientRect();
    return {integrated:host.main.contains(audio.root), bodyScroll:audio.body.scrollHeight > audio.body.clientHeight, audioRuler:!audio.ruler.hidden, audioPlayhead:getComputedStyle(audio.playhead).display, left:clip.left, expected:main.left + host.labelWidth, top:audio.root.getBoundingClientRect().top, expectedTop:main.top + host.audioTop - host.scroll.scrollTop};
  });
  assert.equal(geometry.integrated, true); assert.equal(geometry.bodyScroll, false); assert.equal(geometry.audioRuler, false); assert.equal(geometry.audioPlayhead, 'none');
  assert.ok(Math.abs(geometry.left - geometry.expected) < 2, JSON.stringify(geometry)); assert.ok(Math.abs(geometry.top - geometry.expectedTop) < 2, JSON.stringify(geometry));
  await page.screenshot({path:`${out}/advanced.png`});
  // The frame grid and audio lanes share time, navigation, and contextual tools.
  await page.locator('.audio-clip').first().click({position:{x:35,y:35}}); await settle();
  await page.getByRole('button',{name:'Audio clip controls',exact:true}).click();
  assert.equal(await page.locator('.audio-clip-popover').isVisible(), true);
  assert.ok(await page.locator('.audio-clip-popover').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  assert.equal(await page.getByRole('button', {name:'Add Frame', exact:true}).isVisible(), false);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {styk.timeline.scroll.scrollTop = 0;}); await settle();
  await page.locator('.sheet-scroll').click({position:{x:20,y:78}}); await settle();
  assert.equal(await page.locator('.audio-clip-popover').isVisible(), false);
  assert.equal(await page.getByRole('button', {name:'Add Frame', exact:true}).isVisible(), true);
  await page.evaluate(() => {
    const host = styk.timeline, id = styk.editor.report._styk.audio.tracks[0].clips[0].id;
    styk.editor.setAudioClip(id, {start:2}); host.setZoom(20); host._scrollToX(120); host.scroll.scrollTop = 40;
  }); await settle();
  const aligned = await page.evaluate(() => {
    const host = styk.timeline, audio = host.audio, clip = audio.clipLayer.querySelector('[data-clip]').getBoundingClientRect(), main = host.main.getBoundingClientRect();
    return {x:clip.left, expectedX:main.left + host.labelWidth + audio.tickX(24), y:clip.top, expectedY:main.top + host.audioTop + 36 + 3 - host.scroll.scrollTop};
  });
  assert.ok(Math.abs(aligned.x - aligned.expectedX) < 2 && Math.abs(aligned.y - aligned.expectedY) < 2, JSON.stringify(aligned));
  await page.evaluate(() => {styk.timeline.setZoom(14); styk.timeline._scrollToX(0); styk.timeline.scroll.scrollTop = 0;}); await settle();
  const assetState = await page.evaluate(() => JSON.stringify(styk.editor.report._styk.audio));
  const history = await page.evaluate(() => styk.editor._undo.length);
  await button.click(); await settle(); assert.equal(await page.locator('.audio-timeline').isVisible(), false);
  assert.equal(await button.getAttribute('data-has-audio'), 'true');
  assert.equal(await page.evaluate(() => JSON.stringify(styk.editor.report._styk.audio)), assetState);
  await button.click(); await settle();
  assert.equal(await page.evaluate(() => styk.editor._undo.length), history);
  await page.evaluate(() => {styk.editor.seek(24); styk.actions.play();});
  await page.waitForFunction(() => styk.audioEngine.running && styk.editor.tick >= 26);
  await button.click(); await settle();
  const playingTick = await page.evaluate(() => styk.editor.tick);
  await page.waitForFunction(tick => styk.editor.tick > tick + 3 && styk.audioEngine.running, playingTick);
  assert.equal(await page.locator('.audio-timeline').isVisible(), false, 'Hiding controls leaves playback running');
  await button.click(); await settle();
  assert.equal(await page.evaluate(() => styk.audioEngine.running), true);
  await page.evaluate(() => styk.actions.play());
  await page.evaluate(() => styk.settingsUI.commit({timelineMode:'simple'})); await settle();
  assert.equal(await button.getAttribute('aria-expanded'), 'true'); assert.equal(await page.locator('.sheet-filmstrip').isVisible(), false);
  await page.screenshot({path:`${out}/simple.png`});
  await page.evaluate(()=>styk.timeline.setZoom(160));await settle();
  assert.ok(await page.evaluate(()=>Math.abs(styk.timeline.audio.xTick(styk.timeline.audio.tickX(24))-24)<1e-8),'Simple audio mapping follows zoom');
  await page.evaluate(()=>styk.timeline.setZoom(112));await settle();
  await button.click(); await settle(); assert.equal(await page.locator('.sheet-filmstrip').isVisible(), true);
  assert.equal(await page.locator('.audio-timeline').isVisible(), false);
  await page.setViewportSize({width:960, height:720}); await button.click(); await settle(); await page.screenshot({path:`${out}/compact.png`});
  assert.equal(await page.locator('.audio-timeline').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  const horizontal = page.getByRole('region', {name:'Audio timeline position', exact:true});
  assert.equal(await horizontal.isVisible(), true);
  await horizontal.press('End'); await settle();
  const endScroll = await page.evaluate(() => ({audio:styk.timeline.audio.horizontal.scrollLeft, frames:styk.timeline.strip.scrollLeft}));
  assert.ok(endScroll.audio > 0 && Math.abs(endScroll.audio - endScroll.frames) <= 1, JSON.stringify(endScroll));
  await horizontal.press('Home'); await settle();
  assert.equal(await page.evaluate(() => styk.timeline.strip.scrollLeft), 0);
  await page.screenshot({path:`${out}/compact.png`});
  // A saved old "expanded audio" preference must not reopen the tab on launch.
  await page.evaluate(() => localStorage.setItem('stykanimate.audio-view.v1', JSON.stringify({expanded:true, focused:true, height:480})));
  await page.reload(); await page.waitForFunction(() => window.styk?.ready); await settle();
  assert.equal(await button.getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('.audio-timeline').isVisible(), false);
  assert.deepEqual(errors, []); await writeFile(`${out}/results.json`, JSON.stringify({geometry, aligned, errors}, null, 2));
  console.log('PASS optional Audio tab, shared Advanced scrolling/zoom/ruler/playhead, contextual tools, focus return, hidden playback, Simple tab, compact layout and closed-on-launch behavior');
} catch (error) { await page.screenshot({path:`${out}/failure.png`}); throw error; }
finally { await browser.close(); }
