import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const out='artifacts/camera-motion';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(name,passed)=>{assert.ok(passed,name);checks.push(name);console.log('PASS',name);};
const near=(a,b)=>Math.abs(a-b)<1e-8;
const field=key=>page.locator(`[data-property="${key}"]`);
const label=key=>page.locator(`[data-property-row="${key}"] [data-property-scrub]`);
const snapshot=()=>page.evaluate(()=>({clip:styk.editor.getCameraMotions()[0],parallax:styk.editor.getLayer('layer-1').parallax,undo:styk.editor._undo.length,active:styk.properties.active,draws:styk.state.drawCalls}));
async function begin(key){
  await label(key).scrollIntoViewIfNeeded();
  const r=await label(key).boundingBox(),p={x:r.x+r.width/2,y:r.y+r.height/2};
  await page.mouse.move(p.x,p.y);await page.mouse.down();return p;
}
async function drag(key,dx,modifier){
  const p=await begin(key);
  if(modifier)await page.keyboard.down(modifier);
  await page.mouse.move(p.x+dx,p.y,{steps:5});
  if(modifier)await page.keyboard.up(modifier);
  await page.mouse.up();
}
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(()=>{const e=styk.editor;e.newDocument();e.addFigure();styk.settingsUI.commit({timelineMode:'advanced',onionCount:0});styk.state.onion=false;styk.fit();});
  await page.getByRole('button',{name:'Select layer Camera',exact:true}).click();
  await page.locator('[data-camera-tab="motion"]').click();
  await page.locator('[data-motion-add="impact"]').click();
  // Exact per-axis values live under Fine tune.
  await page.locator('.motion-advanced > summary').click();
  await field('motion_moveX').waitFor();

  let before=await snapshot(),p=await begin('motion_moveX');
  await page.mouse.move(p.x+20,p.y,{steps:10});
  await page.waitForFunction(n=>styk.state.drawCalls>n,before.draws);
  let live=await snapshot();
  check('Dragging previews motion and redraws before release without history',live.clip.params.moveX===28&&live.undo===before.undo&&live.active);
  await page.screenshot({path:`${out}/motion-scrub.png`});
  await page.mouse.up();
  let after=await snapshot();
  check('Release commits one motion command',after.clip.params.moveX===28&&after.undo===before.undo+1&&!after.active);
  await page.evaluate(()=>styk.editor.undo());
  check('Undo restores the exact pre-drag clip',JSON.stringify((await snapshot()).clip)===JSON.stringify(before.clip));
  await page.evaluate(()=>styk.editor.redo());
  check('Redo restores the dragged value',(await snapshot()).clip.params.moveX===28);

  p=await begin('motion_moveX');await page.mouse.move(p.x+20,p.y);
  await page.keyboard.press('Control+z');await page.mouse.up();after=await snapshot();
  check('Undo during a drag releases the gesture and undoes the last committed edit',after.clip.params.moveX===18&&!after.active&&after.undo===before.undo);
  await page.waitForFunction(()=>Number(document.querySelector('[data-property="motion_moveX"]').value)===18);
  await page.evaluate(()=>styk.editor.redo());

  p=await begin('motion_moveX');
  await page.mouse.move(p.x+10,p.y);
  await page.keyboard.down('Shift');await page.mouse.move(p.x+20,p.y);await page.keyboard.up('Shift');
  await page.keyboard.down('Alt');await page.mouse.move(p.x+30,p.y);await page.keyboard.up('Alt');
  await page.mouse.up();
  check('Modifier changes apply continuously in field units',near((await snapshot()).clip.params.moveX,33.55));
  before=await snapshot();p=await begin('motion_moveX');await page.mouse.move(p.x+60,p.y,{steps:5});
  await page.keyboard.press('Escape');await page.mouse.up();after=await snapshot();
  check('Escape restores the baseline without a history entry',JSON.stringify(after.clip)===JSON.stringify(before.clip)&&after.undo===before.undo&&!after.active);
  check('Cancelled drag releases capture and cursor',await page.evaluate(()=>!document.body.classList.contains('styk-property-scrubbing')&&!document.querySelector('#inspector').hasPointerCapture(1)));
  await drag('motion_moveX',-100);
  check('Motion drag clamps at the parameter bound',(await snapshot()).clip.params.moveX===0);
  // Rotation and Zoom are sliders; their keyboard steps commit in field units.
  let undo=(await snapshot()).undo;await page.locator('input[type="range"][data-motion-field="roll"]').focus();await page.keyboard.press('ArrowRight');
  check('The rotation slider steps in tenths of a degree',near((await snapshot()).clip.params.roll,1.6)&&(await snapshot()).undo===undo+1);
  await page.locator('input[type="range"][data-motion-field="zoom"]').focus();await page.keyboard.press('ArrowRight');
  check('The zoom slider steps in percentage units',near((await snapshot()).clip.params.zoom,.05));
  check('A slider and its typed value agree',Number(await page.locator('input[type="number"][data-motion-field="zoom"]').inputValue())===5);
  await drag('motion_duration',16,'Shift');
  check('Timing stays in whole frames with fine adjustment',(await snapshot()).clip.duration===14);
  await drag('motion_start',5);
  check('Start retains the one-based inspector offset',(await snapshot()).clip.start===5&&Number(await field('motion_start').inputValue())===6);
  await drag('motion_fadeIn',25,'Shift');
  check('Fade dragging stays in whole frames',(await snapshot()).clip.params.fadeIn===3);
  await drag('motion_frequency',10,'Shift');
  check('Advanced speed supports fractional adjustment',near((await snapshot()).clip.params.frequency,6.05));

  await field('motion_moveX').fill('12.123456');await field('motion_moveX').press('Enter');
  before=await snapshot();await label('motion_moveX').click();
  check('Clicking a label focuses typing',await field('motion_moveX').evaluate(e=>document.activeElement===e));
  await field('motion_moveX').press('Tab');after=await snapshot();
  check('Click and blur preserve exact values without history',after.clip.params.moveX===12.123456&&after.undo===before.undo);
  await label('motion_moveX').focus();await page.keyboard.press('ArrowRight');
  check('Focused labels support keyboard adjustment',near((await snapshot()).clip.params.moveX,12.623));

  await page.evaluate(()=>styk.editor.setLayerLocked('camera',true));
  before=await snapshot();p=await begin('motion_moveX');await page.mouse.move(p.x+20,p.y);await page.mouse.up();after=await snapshot();
  check('Locked camera fields reject scrubbing and skip label tab stops',after.undo===before.undo&&JSON.stringify(after.clip)===JSON.stringify(before.clip)&&!after.active&&await label('motion_moveX').getAttribute('tabindex')==='-1');
  await page.evaluate(()=>{styk.editor.setLayerLocked('camera',false);styk.editor.setLayerParallax('layer-1',{enabled:true,x:.45});styk.editor.setCameraValues({x:80});styk.timeline._selectLayer('layer-1');});
  await field('parallax_x').waitFor();
  before=await snapshot();p=await begin('parallax_x');await page.mouse.move(p.x+20,p.y,{steps:10});live=await snapshot();
  check('Linked parallax previews both axes and readouts during drag',near(live.parallax.x,.65)&&near(live.parallax.y,.65)&&Number(await field('parallax_y').inputValue())===65&&Number(await page.locator('[data-parallax-field="movement"]').inputValue())===65&&live.undo===before.undo);
  await page.mouse.up();after=await snapshot();
  check('Linked parallax commits once',after.undo===before.undo+1&&!after.active);
  await page.evaluate(()=>styk.editor.undo());
  check('Parallax undo restores both axes',JSON.stringify((await snapshot()).parallax)===JSON.stringify(before.parallax));
  await page.evaluate(()=>styk.editor.redo());
  before=await snapshot();p=await begin('parallax_y');await page.mouse.move(p.x+15,p.y);await page.keyboard.press('Escape');await page.mouse.up();
  await page.waitForFunction(()=>Number(document.querySelector('[data-property="parallax_x"]').value)===65);
  after=await snapshot();
  check('Parallax cancellation restores both linked readouts and model',JSON.stringify(after.parallax)===JSON.stringify(before.parallax)&&after.undo===before.undo&&Number(await field('parallax_y').inputValue())===65);
  await page.locator('[data-parallax-field="linked"]').uncheck();
  await drag('parallax_y',20,'Alt');after=await snapshot();
  check('Unlinked parallax scrubs independently with fine precision',near(after.parallax.x,.65)&&near(after.parallax.y,.652));
  before=await snapshot();p=await begin('parallax_x');await page.mouse.move(p.x+10,p.y);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();after=await snapshot();
  check('Window blur cancels a captured parallax edit',JSON.stringify(after.parallax)===JSON.stringify(before.parallax)&&after.undo===before.undo&&!after.active);
  await page.locator('[data-section="parallax-preview"] summary').click();
  await page.locator('[data-parallax-preview]').fill('50');
  await page.screenshot({path:`${out}/parallax-scrub.png`});
  await page.evaluate(()=>styk.editor.setLayerLocked('layer-1',true));before=await snapshot();
  await drag('parallax_x',20);after=await snapshot();
  check('Locked layers reject parallax scrubbing',after.undo===before.undo&&!after.active&&JSON.stringify(after.parallax)===JSON.stringify(before.parallax));
  await page.evaluate(()=>{styk.editor.setLayerLocked('layer-1',false);styk.timeline._selectMotion(styk.editor.getCameraMotions()[0].id);styk.settingsUI.commit({theme:'dark'});});
  await page.setViewportSize({width:1280,height:720});
  await page.locator('.motion-advanced summary').click();
  await label('motion_start').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${out}/motion-scrub-dark.png`});
  const layout=await page.locator('.motion-card').evaluate(e=>({right:e.getBoundingClientRect().right,fields:[...e.querySelectorAll('input')].map(i=>({key:i.dataset.property,width:i.getBoundingClientRect().width,right:i.getBoundingClientRect().right}))}));
  await writeFile(`${out}/scrub-layout.json`,JSON.stringify(layout,null,2));
  check('Drag labels retain compact inspector layout',layout.fields.every(i=>i.width>=23&&i.right<=layout.right+1));
  check('No browser errors',errors.length===0);
  await writeFile(`${out}/scrub-results.json`,JSON.stringify({checks,errors},null,2));
}finally{await browser.close();}
