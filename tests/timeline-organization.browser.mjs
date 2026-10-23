import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const out='artifacts/timeline-organization';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
try{
await page.goto('http://127.0.0.1:47831');await page.waitForFunction(()=>window.styk?.ready);
await page.evaluate(()=>{styk.settingsUI.commit({timelineMode:'advanced'});for(const name of ['Character body','Character hands','Background','Lighting','Foreground'])styk.editor.createLayer(name);styk.timeline.selectTrack('layer-2');});await settle();
const snapshot=()=>page.evaluate(()=>JSON.stringify(styk.editor.serialize()));const before=await snapshot();
// Find layers is a button in the layer list's header; its field takes the title's place while it is used.
assert.equal(await page.getByRole('searchbox',{name:'Find layers'}).isVisible(),false);assert.ok(await page.locator('.sheet-label-title').isVisible());
await page.getByRole('button',{name:'Find layers',exact:true}).click();assert.ok(await page.getByRole('searchbox',{name:'Find layers'}).evaluate(e=>document.activeElement===e));assert.equal(await page.locator('.sheet-label-title').isVisible(),false);
await page.getByRole('searchbox',{name:'Find layers'}).fill('character');await settle();
assert.deepEqual(await page.evaluate(()=>styk.timeline.tracks.filter(r=>r.kind==='layer').map(r=>r.name)),['Character hands','Character body']);
assert.equal(await snapshot(),before);
await page.getByRole('searchbox',{name:'Find layers'}).fill('nothing');await settle();assert.equal(await page.evaluate(()=>styk.timeline.ids.some(id=>id.startsWith('layer-'))),false);assert.ok(await page.getByText('No matching layers',{exact:true}).isVisible());
await page.getByRole('searchbox',{name:'Find layers'}).press('Escape');await settle();
assert.equal(await page.getByRole('searchbox',{name:'Find layers'}).isVisible(),false,'An empty find field gives the title back');
// Focus selected layers (a layer's menu, the grid's menu); Show all waits in the layer list's header while a focus is on.
await page.evaluate(()=>{styk.timeline.selectTrack('layer-2');styk.timeline.focusSelectedLayers();});await settle();
assert.ok(await page.getByRole('button',{name:'Show all layers',exact:true}).isVisible());
assert.deepEqual(await page.evaluate(()=>styk.timeline.tracks.filter(r=>r.kind==='layer').map(r=>r.id)),['layer-2']);assert.equal(await snapshot(),before);
await page.evaluate(()=>styk.timeline.selectTrack('layer-4'));await settle();assert.equal(await page.evaluate(()=>styk.timeline.selectedTrackId),'layer-4');assert.deepEqual(await page.evaluate(()=>[...styk.timeline.focusedLayerIds]),['layer-2']);
assert.deepEqual(await page.evaluate(()=>styk.timeline.tracks.filter(r=>r.kind==='layer').map(r=>r.id)),['layer-2']);
await page.getByRole('button',{name:'Show all layers',exact:true}).click();await settle();assert.equal(await page.evaluate(()=>styk.timeline.focusedLayerIds),null);

// Multiple selected rows survive UI refresh and the layer's context menu.
await page.getByRole('button',{name:'Select layer Character body',exact:true}).click();
await page.getByRole('button',{name:'Select layer Character hands',exact:true}).click({modifiers:['Control']});await settle();
assert.deepEqual((await page.evaluate(()=>styk.timeline.ids)).sort(),['layer-2','layer-3']);
await page.getByRole('button',{name:'Select layer Character hands',exact:true}).click({button:'right'});
const beforeFocusLock=await snapshot(),focusHistory=await page.evaluate(()=>styk.editor._undo.length);
await page.getByRole('menuitem',{name:'Focus',exact:true}).click();
await page.getByRole('menuitem',{name:'Focus and lock',exact:true}).click();await settle();
assert.deepEqual((await page.evaluate(()=>[...styk.editor.getLayerFocus().ids])).sort(),['layer-2','layer-3']);
assert.equal(await page.evaluate(()=>styk.editor.getLayerFocus().lock),true);
assert.equal(await page.getByRole('button',{name:'Unlock Camera',exact:true}).isDisabled(),true);
assert.equal(await snapshot(),beforeFocusLock,'Temporary focus locks do not author saved layer flags');
assert.equal(await page.evaluate(()=>styk.editor._undo.length),focusHistory);
await page.getByRole('button',{name:'Show all layers',exact:true}).click();await settle();
assert.equal(await page.evaluate(()=>styk.editor.getLayerFocus()),null);
const divider=page.getByRole('separator',{name:'Resize layer names'});await divider.focus();await divider.press('ArrowRight');assert.equal(await page.evaluate(()=>styk.timeline.labelWidth),230);await divider.press('Home');assert.equal(await page.evaluate(()=>styk.timeline.labelWidth),220);
await page.getByRole('grid',{name:'Layer frames'}).press('Control+f');assert.ok(await page.getByRole('searchbox',{name:'Find layers'}).evaluate(e=>document.activeElement===e));await page.keyboard.press('Escape');
await page.getByRole('button',{name:'Fit timeline',exact:true}).click();await settle();assert.ok(await page.evaluate(()=>styk.timeline.pxPerTick>=1));
await page.evaluate(()=>{styk.timeline.selectTrack('layer-6');styk.timeline._scrollToY(0);});await settle();
await page.getByRole('button',{name:'Select layer Foreground',exact:true}).click({button:'right'});
await page.getByRole('menuitem',{name:'Layer color',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:'Violet',exact:true}).click();await settle();
assert.equal(await page.evaluate(()=>styk.editor.getLayer('layer-6').color),'violet');
await page.getByRole('grid',{name:'Layer frames'}).press('Control+z');await settle();assert.equal(await page.evaluate(()=>styk.editor.getLayer('layer-6').color),undefined);
await page.evaluate(()=>{styk.editor.setLayerColor(['layer-6'],'violet');styk.editor.setLayerColor(['layer-5'],'orange');styk.editor.setLayerColor(['layer-4'],'teal');});await settle();
await page.screenshot({path:out+'/light.png'});
await page.evaluate(()=>styk.settingsUI.commit({theme:'dark'}));await settle();await page.screenshot({path:out+'/dark.png'});
await page.setViewportSize({width:900,height:740});await settle();await page.screenshot({path:out+'/compact.png'});
assert.equal(await page.locator('.sheet-footer').count(),0);assert.ok(await page.locator('.timeline-toolbar').evaluate(e=>e.scrollWidth<=e.clientWidth));assert.ok(await page.locator('.timeline-footer').isHidden());
const dense=await page.evaluate(async()=>{
const e=styk.editor,t=styk.timeline,r=e.serialize();const state=r._styk.layers;
for(let i=7;i<=2000;i++){const id=`layer-${i}`;state.order.push(id);state.byId[id]={name:`Crowd ${i}`,visible:true,locked:false};r._styk.layerSheet.tracks[id]={keys:[],end:0};}state.nextId=2001;e.load(r);
let reads=0;const original=e.layerFrameKeys;e.layerFrameKeys=function(...args){reads++;return original.apply(this,args);};
const started=performance.now();t._reindex();const indexMs=performance.now()-started;e.layerFrameKeys=original;
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
return {rows:t.tracks.length,labels:t.labels.length,keyReads:reads,indexMs};
});assert.equal(dense.keyReads,0);assert.ok(dense.labels<20);assert.equal(dense.rows,2002);console.log('Dense timeline',dense);
assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({errors,checks:['search','no document mutation','empty search','focus','reveal hidden selection','keyboard resize','keyboard search','fit','compact overflow']},null,2));console.log('PASS timeline organization interactions');
}finally{await browser.close();}
