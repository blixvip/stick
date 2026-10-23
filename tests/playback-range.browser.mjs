/** Shared Playback range controls, inclusive endpoints and exact transport ticks.
 * Start npm run serve, then node tests/playback-range.browser.mjs. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

const URL=process.env.STYK_URL||'http://127.0.0.1:47831',out='artifacts/playback-range';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const mode=async timelineMode=>{await page.evaluate(timelineMode=>styk.settingsUI.commit({timelineMode}),timelineMode);await settle();await settle();};
const open=async()=>{await page.getByRole('button',{name:'Playback range',exact:true}).click();await page.getByRole('dialog',{name:'Playback range',exact:true}).waitFor();};
const setRange=async(first,last)=>{
  await open();
  await page.getByRole('spinbutton',{name:'First frame',exact:true}).fill(String(first));
  await page.getByRole('spinbutton',{name:'Last frame',exact:true}).fill(String(last));
  await page.getByRole('button',{name:'Apply range',exact:true}).click();await settle();
};
try{
  await mkdir(out,{recursive:true});await page.goto(URL);await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
    const {createDemo}=await import('/src/demo.mjs');const report=createDemo();
    for(const frame of report.keyframes)frame.duration_raw=6;
    styk.editor.load(report,'Playback range');styk.editor.setFPS(120);styk.editor.markSaved();
  });
  await mode('advanced');await setRange(50,100);
  assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:49,endTick:100});
  check('Advanced: an inclusive frame 50–100 range is visible and does not edit the animation',await page.evaluate(()=>document.querySelector('#playback-range-button').textContent==='50–100'&&!styk.editor.dirty));
  await page.evaluate(()=>{
    styk.state.loop=false;styk.editor.seek(0);window.rangeTicks=[];
    window.rangeListener=event=>{if(event.detail?.kind==='seek'&&styk.state.playing)window.rangeTicks.push(styk.editor.tick);};
    styk.editor.addEventListener('change',window.rangeListener);styk.actions.play();
  });
  await page.waitForFunction(()=>!styk.state.playing&&window.rangeTicks.length>0,null,{timeout:30000});
  const ticks=await page.evaluate(()=>window.rangeTicks);
  assert.deepEqual(ticks,Array.from({length:51},(_,index)=>49+index));
  check('Non-looping playback presents every tick from frame 50 through frame 100 and stops there',await page.evaluate(()=>styk.editor.tick===99));
  await setRange(50,52);
  await page.evaluate(()=>{styk.state.loop=true;styk.editor.seek(0);window.rangeTicks=[];styk.actions.play();});
  await page.waitForFunction(()=>window.rangeTicks.length>=10,null,{timeout:30000});
  await setRange(52,50);
  const loopTicks=await page.evaluate(()=>window.rangeTicks);
  assert.deepEqual(loopTicks.slice(0,10),[49,50,51,49,50,51,49,50,51,49]);
  check('Loop playback repeats only the chosen range in exact tick order',true);
  check('Applying a playback range pauses and cancels the active transport',await page.evaluate(()=>!styk.state.playing&&!styk.audioEngine.running));
  assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:49,endTick:52});
  await setRange(-10,500);assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:0,endTick:139});
  check('Reversed endpoints and bounds outside the animation are normalized',true);
  await open();await page.getByRole('button',{name:'Entire animation',exact:true}).click();
  assert.equal(await page.evaluate(()=>styk.state.loopRange),null);
  await page.evaluate(()=>{const t=styk.timeline,row=t.tracks.findIndex(layer=>layer.id===styk.editor.activeLayerId);t._selectCell({row,tick:4});t._selectCell({row,tick:8},{extend:true});});
  await open();await page.getByRole('button',{name:'Use selection',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:4,endTick:9});
  await page.evaluate(()=>styk.timeline.seek(20));
  assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:4,endTick:9});
  check('Advanced: Use selection fixes playback limits independently of later frame selections',true);
  await mode('simple');assert.equal(await page.evaluate(()=>styk.state.loopRange),null);
  await page.evaluate(()=>{styk.timeline.selectFrame(1);styk.timeline.selectFrame(2,{extend:true});});
  const selected=await page.evaluate(()=>styk.timeline.selectedTimeRange);
  await open();await page.getByRole('button',{name:'Use selection',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:selected.start,endTick:selected.end});
  check('Simple: Use selection includes the selected stored frames and their full inbetweens',selected.start===6&&selected.end===18);
  await setRange(50,100);await open();await page.waitForTimeout(180);await page.screenshot({path:`${out}/simple.png`});await page.keyboard.press('Escape');
  await mode('advanced');await setRange(50,100);
  await page.setViewportSize({width:900,height:700});await settle();await settle();
  check('An active range fits the narrow timeline header',await page.locator('.timeline-toolbar').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  await page.setViewportSize({width:1440,height:900});await settle();await settle();
  await page.evaluate(()=>{const e=styk.editor;e.sheetRemoveFrames(['scene','camera',...e.layers.filter(l=>l.kind==='layer').map(l=>l.id)],25,e.totalTicks-1);});
  assert.deepEqual(await page.evaluate(()=>styk.state.loopRange),{startTick:24,endTick:25});
  check('Shortening the animation clamps both limits to a valid remaining frame',await page.evaluate(()=>styk.editor.totalTicks===25));
  await open();await page.evaluate(()=>styk.editor.newDocument());await settle();
  check('A new document clears the range and its open editor',await page.evaluate(()=>styk.state.loopRange===null&&!document.querySelector('.tl-playback-range-popover:popover-open')));
  await page.setViewportSize({width:520,height:500});await settle();await settle();
  assert.equal(await page.locator('#playback-range-button').isVisible(),false);
  await page.locator('#timeline-menu-button').click();await page.getByRole('menuitem',{name:'Playback range',exact:true}).click();
  await page.getByRole('dialog',{name:'Playback range',exact:true}).waitFor();
  check('The compact timeline exposes Playback range through its menu',await page.getByRole('spinbutton',{name:'First frame',exact:true}).isVisible());
  await page.waitForTimeout(180);await page.screenshot({path:`${out}/compact.png`});await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);await writeFile(`${out}/report.json`,JSON.stringify({checks,ticks,loopTicks,errors},null,2));
}catch(error){await page.screenshot({path:`${out}/failure.png`});throw error;}
finally{await browser.close();}
