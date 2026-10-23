import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';

// Reordering the layer list by drag, naming a folder made while scrolled, row nodes that follow their rows through
// a scroll, and camera motions sharing lanes (docs/LAYER-FOLDERS.md, docs/TIMELINE.md, docs/camera-motion.md).
await mkdir('artifacts/timeline-layer-drag',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const row=id=>page.locator(`.sheet-layer[data-layer-id="${id}"]:visible`);
// The list front-most first; a layer in a folder reads "id@folder".
const list=()=>page.evaluate(()=>styk.editor.report._styk.layers.order.toReversed().map(id=>id.replace('layer-','')+(styk.editor.getLayer(id).folderId?`@${styk.editor.getLayer(id).folderId.replace('folder-','')}`:'')).join(' '));
const undoCount=()=>page.evaluate(()=>styk.editor._undo.length);
/** Presses on row `from`, drags to the point (`x` px into the list, `at` of the way down row `to`) and returns before the release. */
async function dragOver(from,to,{at=.75,x=70}={}){
  const source=await row(from).boundingBox(),target=await row(to).boundingBox(),startY=source.y+source.height/2,endY=target.y+target.height*at;
  await page.mouse.move(source.x+70,startY);await page.mouse.down();
  await page.mouse.move(source.x+70,startY+(endY>startY?6:-6),{steps:2});await page.mouse.move(target.x+x,endY,{steps:6});await settle();
}
const drag=async(from,to,options)=>{await dragOver(from,to,options);await page.mouse.up();await settle();};
try{
  await page.goto(process.env.STYK_URL??'http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
  // A fresh profile opens What's new over the editor; a reload gets past it.
  await page.reload();await page.waitForFunction(()=>window.styk?.ready);
  await page.evaluate(async()=>{const {emptyDocument}=await import('/src/demo.mjs');styk.settingsUI.commit({timelineMode:'advanced'});styk.editor.load(emptyDocument());for(let index=2;index<=30;index++)styk.editor.createLayer(`L${index}`);});await settle();
  assert.equal(await list(),Array.from({length:30},(_,index)=>30-index).join(' '));

  // A drag shows where the layer lands and commits one undo step; the press alone still selects.
  let steps=await undoCount();
  await dragOver('layer-30','layer-28');
  assert.equal(await page.locator('.sheet-layer-drop:visible').count(),1,'A line marks the gap');
  assert.equal(await page.locator('.sheet-layer-drag-chip').textContent(),'L30');
  assert.equal(await row('layer-30').getAttribute('data-dragging'),'true');
  await page.screenshot({path:'artifacts/timeline-layer-drag/line.png'});
  await page.mouse.up();await settle();
  assert.equal((await list()).slice(0,11),'29 28 30 27');assert.equal(await undoCount(),steps+1);
  assert.equal(await page.locator('.sheet-layer-drop, .sheet-layer-drag-chip').count(),0);
  await drag('layer-30','layer-29',{at:.25});assert.equal((await list()).slice(0,11),'30 29 28 27');
  await row('layer-27').locator('.sheet-layer-name').click();await settle();
  assert.deepEqual(await page.evaluate(()=>styk.timeline.ids),['layer-27'],'A press without a drag selects the layer');

  // Escape and a release outside a row's reach change nothing.
  steps=await undoCount();await dragOver('layer-30','layer-27');await page.keyboard.press('Escape');await settle();
  assert.equal(await page.locator('.sheet-layer-drop, .sheet-layer-drag-chip').count(),0);await page.mouse.up();await settle();
  assert.equal((await list()).slice(0,11),'30 29 28 27');assert.equal(await undoCount(),steps);

  // The selected layers drag together and keep their order.
  await row('layer-30').locator('.sheet-layer-name').click();await row('layer-28').locator('.sheet-layer-name').click({modifiers:['Control']});await settle();
  await dragOver('layer-28','layer-27');assert.equal(await page.locator('.sheet-layer-drag-chip').textContent(),'L28 +1');
  await page.mouse.up();await settle();
  assert.equal((await list()).slice(0,11),'29 27 30 28');
  await page.evaluate(()=>styk.editor.undo());await settle();assert.equal((await list()).slice(0,11),'30 29 28 27');

  // Grouping while scrolled keeps the rows where they are and opens the folder's name.
  await page.evaluate(()=>styk.timeline._scrollToY(420));await settle();
  const shown=await page.evaluate(()=>[...document.querySelectorAll('.sheet-layer:not([hidden])')].map(node=>node.dataset.layerId).filter(id=>id.startsWith('layer-')));
  const [upper,lower]=[shown[1],shown[2]];
  await row(upper).locator('.sheet-layer-name').click();await row(lower).locator('.sheet-layer-name').click({modifiers:['Control']});await settle();
  const before=await page.evaluate(()=>styk.timeline.scroll.scrollTop);
  await row(lower).click({button:'right'});await page.getByRole('menuitem',{name:'Organize',exact:true}).click();
  await page.getByRole('menuitem',{name:'Group selected layers in folder',exact:true}).click();await settle();
  assert.ok(Math.abs(await page.evaluate(()=>styk.timeline.scroll.scrollTop)-before)<=40,'Grouping does not jump the list to the top');
  assert.equal(await row('folder-1').count(),1,'The new folder is in view');
  assert.equal(await page.evaluate(()=>document.activeElement?.className),'sheet-layer-rename','Its name is open for typing');
  await page.keyboard.type('Shot 1');await page.keyboard.press('Enter');await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.getLayerFolders().map(folder=>folder.name)),['Shot 1']);
  // New folder from the header's menu: the empty folder comes into view at the top, named in place.
  await page.getByRole('button',{name:'More layer types',exact:true}).click();await page.getByRole('menuitem',{name:'New folder',exact:true}).click();await settle();
  assert.equal(await page.evaluate(()=>document.activeElement?.className),'sheet-layer-rename');
  await page.keyboard.type('Later');await page.keyboard.press('Enter');await settle();
  assert.deepEqual(await page.evaluate(()=>styk.editor.getLayerFolders().map(folder=>folder.name)),['Shot 1','Later']);
  assert.equal(await page.evaluate(()=>styk.timeline.pendingRename),null);

  // Into a folder, between its layers, and out again.
  const member=upper.replace('layer-',''),second=lower.replace('layer-','');
  // The folder as the second row under the pinned ones, clear of the list's edges (a drag held there scrolls).
  const place=async()=>{await page.evaluate(()=>{const timeline=styk.timeline,layout=timeline.layout,at=timeline.tracks.findIndex(track=>track.id==='folder-1');timeline._scrollToY(layout.top(at)-(layout.contentTop-layout.header)-layout.row);});await settle();};
  await place();
  const outsider=await page.evaluate(()=>{const rows=styk.timeline.tracks,at=rows.findIndex(track=>track.id==='folder-1');return rows[at-1].id;}),outside=outsider.replace('layer-','');
  await dragOver(outsider,'folder-1',{at:.7});
  assert.equal(await row('folder-1').getAttribute('data-drop'),'inside','The folder lights up');
  await page.screenshot({path:'artifacts/timeline-layer-drag/into-folder.png'});
  await page.mouse.up();await settle();
  assert.ok((await list()).includes(`${outside}@1 ${member}@1 ${second}@1`),await list());
  await drag(outsider,lower,{at:.25});assert.ok((await list()).includes(`${member}@1 ${outside}@1 ${second}@1`),await list());
  // Below the folder's last layer: inside it at the indent, outside it from the row's left edge.
  await drag(outsider,lower,{at:.8,x:70});assert.ok((await list()).includes(`${member}@1 ${second}@1 ${outside}@1`),await list());
  await drag(outsider,outsider,{at:.8,x:12});assert.ok((await list()).includes(`${member}@1 ${second}@1 ${outside} `),await list());
  // A folder drags its layers as a block.
  await place();
  const above=await page.evaluate(()=>{const rows=styk.timeline.tracks,at=rows.findIndex(track=>track.id==='folder-1');return rows[at-1].id;});
  steps=await undoCount();await drag('folder-1',above,{at:.4});
  assert.ok((await list()).includes(`${member}@1 ${second}@1 ${above.replace('layer-','')} `),await list());assert.equal(await undoCount(),steps+1);
  await row('folder-1').locator('.sheet-layer-name').click();await settle();
  assert.equal(await row(upper).count(),0,'A press without a drag still collapses the folder');
  await row('folder-1').locator('.sheet-layer-name').click();await settle();

  // Rows keep their nodes through a scroll, in row order for the keyboard.
  await page.evaluate(()=>styk.timeline._scrollToY(200));await settle();
  const kept=await page.evaluate(async()=>{
    const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const nodes=()=>new Map(styk.timeline.labels.filter(node=>!node.hidden).map(node=>[node._id,node]));
    const first=nodes();styk.timeline._scrollToY(200+styk.timeline.layout.row);await frame();const second=nodes();
    const same=[...second].filter(([id,node])=>first.get(id)===node).length,order=[...styk.timeline.labelViewport.querySelectorAll('.sheet-layer:not([hidden])')].map(node=>node.dataset.layerId);
    const rows=styk.timeline.tracks.map(track=>track.id).filter(id=>second.has(id));
    return {same,total:second.size,order,rows};
  });
  assert.ok(kept.same>=kept.total-1,'Scrolling one row refills one node');assert.deepEqual(kept.order,kept.rows,'Nodes stay in row order');

  // A wheel over the names glides the rows; the notches of a spin add up.
  await page.evaluate(()=>styk.timeline._scrollToY(0));await settle();
  const names=await page.locator('.sheet-labels').boundingBox();await page.mouse.move(names.x+60,names.y+names.height-20);
  await page.mouse.wheel(0,100);await page.mouse.wheel(0,100);await settle();
  const gliding=await page.evaluate(()=>styk.timeline.scroll.scrollTop);assert.ok(gliding>0&&gliding<200,`The rows are on their way (${gliding})`);
  await page.waitForFunction(()=>styk.timeline.scroll.scrollTop===200);

  // Camera motions share one Motion row: a sub-lane per motion playing at once, so the row is as tall as the overlap.
  await page.evaluate(()=>{for(let index=0;index<6;index++)styk.editor.addCameraMotion(index%2?'shake':'impact',{start:index*20,duration:12});});await settle();
  const motionRow=()=>page.evaluate(()=>{const timeline=styk.timeline,at=timeline.tracks.findIndex(track=>track.kind==='motion');return {rows:timeline.tracks.filter(track=>track.kind==='motion').length,lanes:timeline.tracks[at].laneCount,size:timeline.layout.size(at),row:timeline.layout.row};});
  let shape=await motionRow();assert.deepEqual([shape.rows,shape.lanes,shape.size],[1,1,shape.row],'Motions that never overlap fit one row of the usual height');
  await page.evaluate(()=>styk.editor.addCameraMotion('handheld',{start:30,duration:40}));await settle();
  shape=await motionRow();assert.deepEqual([shape.rows,shape.lanes,shape.size],[1,2,36],'An overlap adds a 14px sub-lane');
  assert.ok(await page.evaluate(()=>styk.timeline.layout.pinned),'Camera, its Motion row and Scene stay pinned in the default timeline');
  const grid=await page.locator('.sheet-scroll').boundingBox(),lane=await row('motion').boundingBox(),px=await page.evaluate(()=>styk.timeline.pxPerTick),clips=await page.evaluate(()=>styk.editor.getCameraMotions().map(clip=>clip.id));
  const top=lane.y+11,bottom=lane.y+25;
  await page.mouse.move(grid.x+44*px,bottom);await settle();
  assert.equal(await page.locator('.sheet-motion-tip').textContent(),'Handheld, frames 31–70','Hovering a clip names it and its frames');
  await page.mouse.click(grid.x+44*px,top);await settle();
  assert.equal(await page.evaluate(()=>styk.editor._selectedCameraMotion),clips[2],'A click picks the clip in the sub-lane under it');
  await page.mouse.click(grid.x+44*px,bottom);await settle();
  assert.equal(await page.evaluate(()=>styk.editor._selectedCameraMotion),clips[6]);
  await page.mouse.move(grid.x+46*px,top);await page.mouse.down();await page.mouse.move(grid.x+50*px,top,{steps:4});
  assert.equal(await page.locator('.sheet-motion-tip').textContent(),'Impact punch, frames 45–56','The tip follows a drag with the frames it will land on');
  await page.mouse.up();await settle();
  assert.equal(await page.evaluate(()=>styk.editor.getCameraMotions()[2].start),44,'Dragging moves that clip alone');
  await page.mouse.click(grid.x+15*px,top);await settle();
  assert.equal(await page.evaluate(()=>styk.editor._selectedCameraMotion),null,'An empty stretch clears the motion selection');
  await page.screenshot({path:'artifacts/timeline-layer-drag/motion-row.png'});
  steps=await undoCount();await row('motion').getByRole('button',{name:/^Hide /}).click();await settle();
  assert.ok(await page.evaluate(()=>styk.editor.getCameraMotions().every(clip=>!clip.enabled)),'The row\'s eye mutes every motion');
  assert.equal(await undoCount(),steps+1);await page.evaluate(()=>styk.editor.undo());await settle();
  // Collapsed, Camera keeps a ribbon of its motions; a press on it opens the row with that motion selected.
  await page.getByRole('button',{name:'Collapse camera motions',exact:true}).click();await settle();
  assert.equal(await row('motion').count(),0);
  const camera=await row('camera').boundingBox();await page.mouse.click(grid.x+64*px,camera.y+camera.height-3);await settle();
  assert.equal(await page.evaluate(()=>styk.editor._selectedCameraMotion),clips[3]);assert.equal(await row('motion').count(),1);
  assert.deepEqual(errors,[]);
  console.log('timeline layer drag: ok');
}finally{await browser.close();}
