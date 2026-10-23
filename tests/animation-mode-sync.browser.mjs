import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('PASS',label);};
const mode=async value=>{
  await page.evaluate(()=>styk.settingsUI.open('interface'));
  await page.locator(`[data-setting="timelineMode"][value="${value}"]`).check();
  await page.keyboard.press('Escape');
  await page.waitForFunction(value=>styk.state.settings.timelineMode===value,value);
};
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const report=emptyDocument();report.keyframes=[100,200,300].map(x=>createFrame([createObject(report.figure_types[0],1,x,240)],5));
    styk.editor.load(report);styk.editor.selectFrame(2);styk.editor.select(1);
    styk.editor.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:100},
      {target:{kind:'figure',uid:1},property:'x',tick:10,value:300}]);
    styk.fit();
  });
  await mode('simple');
  check('Settings mounts Simple using the current Advanced pose',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===300&&Boolean(document.querySelector('.sheet-filmstrip'))));
  await page.evaluate(async()=>{
    const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('/src/native-property-edit.mjs');
    const token=beginNativePropertyEdit(styk.editor,'root_x');previewNativePropertyEdit(token,420);commitNativePropertyEdit(token);
  });
  check('Simple writes the pose edit straight into the layer sheet',await page.evaluate(()=>!styk.editor.frameDraft&&styk.editor.evaluatedFrame.objects[0].root_x===420&&styk.editor.animationChannels.length===0));
  await page.locator('.sheet-add-frame').click();
  await mode('advanced');
  check('The filmstrip edit and added key remain in Advanced',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===420&&!styk.editor.frameDraft));
  await page.evaluate(()=>styk.editor.undo());
  check('Advanced undo removes the added key',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===420));
  await page.evaluate(()=>styk.editor.redo());
  await mode('simple');
  await page.evaluate(async()=>{
    const {beginNativePropertyEdit,previewNativePropertyEdit,commitNativePropertyEdit}=await import('/src/native-property-edit.mjs');
    const token=beginNativePropertyEdit(styk.editor,'root_x');previewNativePropertyEdit(token,500);commitNativePropertyEdit(token);
  });
  await mkdir('artifacts/animation-mode-sync',{recursive:true});
  await page.waitForFunction(()=>document.querySelectorAll('.sheet-preview canvas').length>=3);
  await page.screenshot({path:'artifacts/animation-mode-sync/simple.png'});
  await mode('advanced');
  check('Switching back to Advanced preserves the authored pose and sheet',await page.evaluate(async()=>{
    const e=styk.editor;
    return Boolean(e.report._styk.layerSheet)&&e.evaluatedFrame.objects[0].root_x===500;
  }));
  await page.evaluate(()=>styk.editor.seek(styk.editor.totalTicks-1));
  check('The final playback tick holds the authored pose',await page.evaluate(()=>styk.editor.evaluatedFrame.objects[0].root_x===500));
  const sheetBefore=await page.evaluate(()=>JSON.stringify(styk.editor.report._styk.layerSheet));
  for(let i=0;i<3;i++){await mode('simple');await mode('advanced');}
  check('Repeated mode switches retain the sheet, clear obsolete ranges, and mount one timeline',await page.evaluate(before=>JSON.stringify(styk.editor.report._styk.layerSheet)===before&&styk.state.rangeIndices.length===0&&styk.state.loopRange===null&&!document.querySelector('.sheet-filmstrip'),sheetBefore));
  await page.screenshot({path:'artifacts/animation-mode-sync/advanced.png'});
  await mode('simple');
  await page.evaluate(()=>{
    styk.editor.select(styk.editor.evaluatedFrame.objects[0].unique_id);
    window.modeBefore={timeline:styk.timeline,revision:styk.editor.revision};
    styk.settingsUI.open('interface');
  });
  await page.locator('[data-setting="timelineMode"][value="advanced"]').click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>styk.state.settings.timelineMode==='advanced');
  check('A mode switch replaces the timeline and keeps the document revision',await page.evaluate(()=>{
    const e=styk.editor;
    return styk.state.settings.timelineMode==='advanced'&&styk.timeline!==modeBefore.timeline&&e.revision===modeBefore.revision;
  }));
  assert.deepEqual(errors,[]);
  await writeFile('artifacts/animation-mode-sync/report.json',JSON.stringify({checks,errors},null,2));
} finally {await browser.close();}
