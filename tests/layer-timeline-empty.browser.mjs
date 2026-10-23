import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';

const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const snapshot=()=>page.evaluate(()=>{
  const report=styk.editor.serialize();
  // Marquee selection can change the persisted active layer, but no content.
  delete report._styk.layers.activeId;
  return JSON.stringify(report);
});
const cell=(tick,id)=>page.evaluate(async({tick,id})=>{
  const t=styk.timeline,b=t.scroll.getBoundingClientRect(),index=t.tracks.findIndex(row=>row.id===id);
  return {x:b.x+(tick+.5)*t.pxPerTick-t._offsetX(),y:b.y+t.rowY(index)+t.rowSize(index)/2};
},{tick,id});
const drag=async(from,to,copy=false)=>{
  if(copy)await page.keyboard.down('Alt');
  await page.mouse.move(from.x,from.y);await page.mouse.down();
  await page.mouse.move(to.x,to.y,{steps:6});await page.mouse.up();
  if(copy)await page.keyboard.up('Alt');
  await settle();
};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),report=emptyDocument();
    report.keyframes=[0,60].map(x=>createFrame([createObject(report.figure_types[0],1,200+x,250)],12));
    styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(report);
    styk.editor.createLayer('Empty');styk.editor.sheetInsertKey(['layer-1'],5,{blank:true});styk.fit();
  });await settle();
  const end=await page.evaluate(()=>styk.editor.report._styk.layerSheet.tracks['layer-1'].end);
  // Selected cells at/beyond the exclusive end and on a keyless layer must
  // only change selection, including Alt copies and cross-layer gestures.
  for(const [tick,id,target,copy] of [[end,'layer-1','layer-1',false],[end+2,'layer-1','layer-1',true],[end+2,'layer-1','layer-2',false],[3,'layer-2','layer-2',false]]){
    const from=await cell(tick,id);await page.mouse.click(from.x,from.y);await settle();
    const before=await snapshot();await drag(from,await cell(tick+3,target),copy);
    assert.deepEqual(JSON.parse(await snapshot()),JSON.parse(before),`Empty drag ${id}:${tick} to ${target}, copy=${copy}`);
  }
  // Authored blank keys and held pose/blank cells are still movable, undoably.
  for(const tick of [5,7,2]){
    const from=await cell(tick,'layer-1');await page.mouse.click(from.x,from.y);await settle();
    const before=await snapshot();await drag(from,await cell(tick+2,'layer-1'));
    assert.notEqual(await snapshot(),before,`Existing exposure at ${tick} must move`);
    assert.equal(await page.evaluate(()=>styk.timeline.start),tick+2);
    await page.evaluate(()=>styk.editor.undo());await settle();assert.equal(await snapshot(),before);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS empty/end/keyless cell drags preserve document; blank keys and held pose/blank exposures move with exact undo');
}finally{await browser.close();}
