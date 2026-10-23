import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

await mkdir('artifacts/layer-folders',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
page.setDefaultNavigationTimeout(60000);
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const row=id=>page.locator(`.sheet-layer[data-layer-id="${id}"]:visible`);
const snapshot=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));
try {
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(emptyDocument());for(const name of ['Floor','Drawings','Effects'])styk.editor.createLayer(name);});await settle();
  await row('layer-2').locator('.sheet-layer-name').click();
  await row('layer-3').locator('.sheet-layer-name').click({modifiers:['Control']});await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.ids),['layer-2','layer-3']);
  await row('layer-3').click({button:'right'});
  await page.getByRole('menuitem',{name:'Organize',exact:true}).click();
  await page.getByRole('menuitem',{name:'Group selected layers in folder',exact:true}).click();await settle();
  const rename=page.getByRole('textbox',{name:/Rename/});await rename.fill('Scene 1');await rename.press('Enter');await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.getLayerFolders().map(folder=>folder.name)),['Scene 1']);
  assert.equal(await page.evaluate(()=>Object.hasOwn(styk.editor.report._styk.layerSheet.tracks,'folder-1')),false);
  const beforeCollapse=await snapshot();
  await page.getByRole('button',{name:'Collapse Scene 1',exact:true}).click();await settle();
  assert.equal(await row('layer-2').count(),0);assert.equal(await snapshot(),beforeCollapse);
  const box=await row('folder-1').boundingBox(),grid=await page.locator('.sheet-scroll').boundingBox();
  await page.mouse.dblclick(grid.x+60,box.y+box.height/2);await settle();
  assert.equal(await snapshot(),beforeCollapse,'Folder cells cannot insert pose keys');
  await page.getByRole('button',{name:'Find layers',exact:true}).click();await page.getByRole('searchbox',{name:'Find layers'}).fill('scene 1');await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.tracks.filter(row=>row.kind==='layer').map(row=>row.id)),['layer-3','layer-2']);
  assert.equal(await snapshot(),beforeCollapse,'Searching a folder changes no saved data');
  await page.getByRole('searchbox',{name:'Find layers'}).press('Escape');await settle();
  await page.evaluate(()=>styk.timeline.selectTrack('layer-2'));await settle();
  assert.ok(await row('layer-2').count(),'Selecting a child reveals its collapsed folder');
  await row('folder-1').click({button:'right'});await page.getByRole('menuitem',{name:'Ungroup folder',exact:true}).click();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.getLayerFolders().length),0);assert.equal(await page.evaluate(()=>styk.editor.layers.filter(row=>row.kind==='layer').length),4);
  await page.evaluate(()=>styk.editor.undo());await settle();assert.equal(await snapshot(),beforeCollapse);
  await page.screenshot({path:'artifacts/layer-folders/advanced.png'});
  await page.evaluate(()=>styk.settingsUI.commit({timelineMode:'simple'}));await settle();
  await page.locator('#layers-button').click();await settle();
  const pick=page.locator('.tl-layers-row[data-layer-id="folder-1"] .tl-layers-pick');assert.equal(await pick.getAttribute('aria-expanded'),'true');
  await pick.click();assert.equal(await pick.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.tl-layers-row[data-layer-id="layer-2"]').count(),0);
  await pick.click();assert.equal(await page.locator('.tl-layers-row[data-layer-id="layer-2"]').count(),1);
  await page.screenshot({path:'artifacts/layer-folders/simple.png'});
  await pick.click();await page.locator('#layers-button').click();await settle();
  await page.evaluate(()=>styk.editor.load(styk.editor.serialize()));await settle();
  await page.locator('#layers-button').click();await settle();
  assert.equal(await pick.getAttribute('aria-expanded'),'true','Document replacement resets Simple collapse while the popover is closed');
  await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'advanced'});styk.timeline.selectTrack('layer-2');styk.timeline.focusSelectedLayers({lock:true});});await settle();
  await page.evaluate(()=>styk.timeline.newLayerFolder());await settle();
  const emptyRename=page.getByRole('textbox',{name:/Rename/});await emptyRename.fill('Empty shot');await emptyRename.press('Enter');await settle();
  assert.equal(await page.evaluate(()=>styk.editor.getLayerFocus().lock),true,'Folder creation preserves focus locks');
  await page.getByRole('button',{name:'Find layers',exact:true}).click();await page.getByRole('searchbox',{name:'Find layers'}).fill('empty shot');await settle();
  assert.equal(await row('folder-2').count(),1,'Empty folder names remain searchable during focus');
  await page.getByRole('searchbox',{name:'Find layers'}).press('Escape');await settle();assert.equal(await page.evaluate(()=>styk.editor.getLayerFocus().lock),true);
  await page.evaluate(()=>{styk.editor.clearLayerFocus();styk.timeline.toggleLayerFolder('folder-1');const copy=styk.editor.serialize();styk.editor.load(copy);});await settle();
  assert.equal(await page.evaluate(()=>styk.timeline.collapsedFolders.size),0,'A replacement document resets collapse state');
  assert.deepEqual(errors,[]);
  console.log('PASS folder menus, multi-selection, rename, collapse, folder cells, search, reveal, ungroup/undo and both timelines');
} catch(error) {
  console.error(error.message);
  if(!page.isClosed()) {
    console.log('Folder interaction state',await page.evaluate(()=>window.styk?{active:document.activeElement?.outerHTML,searchHidden:styk.timeline.searchField.hidden,searchRect:styk.timeline.layerSearch.getBoundingClientRect().toJSON(),rename:document.querySelector('.sheet-layer-rename')?.outerHTML,focus:[...styk.editor.getLayerFocus()?.ids??[]]}:{ready:false,url:location.href}).catch(()=>null));
    await page.screenshot({path:'artifacts/layer-folders/failure.png'}).catch(()=>{});
  }
  throw error;
} finally {await browser.close();}
