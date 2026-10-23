import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const parity=await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs'),{createVfx}=await import('/src/vfx.mjs'),{drawExportScene,drawExportSceneTiled,exportFrameGeometry}=await import('/src/export-frame-core.mjs'),{VfxGPU}=await import('/src/vfx-gpu.mjs');
  const paint={type:'linear',angle:35,stops:[{offset:0,color:[255,80,40],opacity:.6},{offset:.4,color:[100,255,90],opacity:1},{offset:1,color:[70,140,255],opacity:.8}]};
  const variants=[...['linear','radial','angular','diamond'].map(type=>['tint',{color:{...paint,type},mix:.8}]),['glow',{color:paint,mode:2,spread:3,coreMix:.3,coreColor:paint,blend:1,falloff:1.4}],['glow',{mode:1}],['outline',{mode:2,only:1,color:paint,width:8}],['outline',{mode:1,color:paint,width:7}],['shadow',{mode:1,color:paint,spread:2}],['blur',{mode:1,radius:12,angle:33}],['blur',{mode:2,radius:12}],['blur',{mode:3,radius:12}],['grade',{shadows:.3,highlights:-.2,gamma:1.3,tint:.2}],['pixelate',{linked:0,size:13,sizeY:7,offsetX:3,offsetY:-5}],['noise',{colored:1,pattern:1,size:15,softness:.5,contrast:2}],['vignette',{color:paint,centerX:.7,centerY:.4,aspect:1.3,roundness:.2}],['dissolve',{color:paint}],['rgbSplit',{amount:12,angle:45}],['wave',{strength:18,angle:32}],['shockwave',{centerX:.4,centerY:.55,radius:80}],['bloom',{color:paint,radius:24}],['lightSweep',{color:paint}],['crt',{curvature:.15,chromatic:3,color:paint}]];
  const results=[],gpu=new VfxGPU();
  for(const [type,params] of variants){
   const doc=emptyDocument();doc.canvas_width=320;doc.canvas_height=240;const object=createObject(doc.figure_types[0],1,160,200),frame=createFrame([object],20);doc.keyframes=[frame];const effect=createVfx(type,'test');Object.assign(effect.params,params);
   const scope=['vignette','shockwave','crt','grade','pixelate','noise','wave','bloom'].includes(type)?'scene':'figure';(scope==='scene'?frame:object)._stykVfx={figure:[effect]};
   const geometry=exportFrameGeometry(doc,frame),full=new OffscreenCanvas(320,240),tile=new OffscreenCanvas(320,240);drawExportScene(full.getContext('2d'),doc,frame,geometry,{});await drawExportSceneTiled(tile.getContext('2d'),doc,frame,geometry,{preload:async()=>{}},96);
   const a=full.getContext('2d').getImageData(0,0,320,240).data,b=tile.getContext('2d').getImageData(0,0,320,240).data;let max=0,total=0;for(let i=0;i<a.length;i++){const diff=Math.abs(a[i]-b[i]);max=Math.max(max,diff);total+=diff;}
   const input=new OffscreenCanvas(96,96),c=input.getContext('2d');c.fillStyle='#68a4d0';c.fillRect(25,25,46,46);gpu.run(input,[effect]);const error=gpu.gl.getError();results.push({type,mode:params.mode,scope,max,mean:total/a.length,error});
  }gpu.destroy();return results;
 });
 console.log('Expanded rendering',JSON.stringify(parity));for(const row of parity){assert.equal(row.error,0,JSON.stringify(row));assert.ok(row.max<=3,JSON.stringify(row));}
 // Rendering can be checked independently of the legacy pose-effect UI.
 if(!process.argv.includes('--render-only')){
 await page.getByRole('tab',{name:'VFX',exact:true}).click();await page.selectOption('#vfx-scope','figure');
 const add=async type=>{await page.locator('[data-vfx-action="add"]').click();await page.locator('.vfx-catalog [data-choice="'+type+'"]').click();};
 await add('glow');await add('shadow');
 let cards=page.locator('.vfx-effect');assert.equal(await cards.count(),2);assert.ok(await page.locator('.vfx-effect-title>.vfx-icon').count());
 // Search, dismiss, and preserve the selected effect.
 await page.locator('[data-vfx-action="add"]').click();await page.getByRole('searchbox',{name:'Search effects'}).fill('diss');assert.equal(await page.locator('.vfx-catalog-card').count(),1);await page.getByRole('searchbox').press('Escape');
 const selected=await page.evaluate(()=>styk.vfx.selected.id);await page.waitForFunction(()=>styk.vfxGizmos.handles.length>0);
 const grip=await page.evaluate(()=>{const h=styk.vfxGizmos.handles.find(h=>h.kind==='offset'),rect=document.getElementById('overlay').getBoundingClientRect();return {x:h.screen.x+rect.left,y:h.screen.y+rect.top,history:styk.editor._undo.length,params:styk.vfx.selectedEffect().effect.params};});
 await page.mouse.move(grip.x,grip.y);await page.mouse.down();await page.mouse.move(grip.x+25,grip.y+10,{steps:8});await page.mouse.up();
 const moved=await page.evaluate(()=>({history:styk.editor._undo.length,params:styk.vfx.selectedEffect().effect.params}));assert.equal(moved.history,grip.history+1);assert.ok(moved.params.offsetX>grip.params.offsetX);assert.ok(moved.params.offsetY>grip.params.offsetY);
 // Escape during a canvas drag cancels without another undo entry.
 const cancelGrip=await page.evaluate(()=>{const h=styk.vfxGizmos.handles.find(h=>h.kind==='offset'),r=document.getElementById('overlay').getBoundingClientRect();return {x:h.screen.x+r.left,y:h.screen.y+r.top};});await page.mouse.move(cancelGrip.x,cancelGrip.y);await page.mouse.down();await page.mouse.move(cancelGrip.x+30,cancelGrip.y);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.evaluate(()=>styk.editor._undo.length),moved.history);
 // Header selection owns the gizmos; switching tabs removes them.
 await cards.first().locator('[data-vfx-action="select"]').click();await page.waitForFunction(()=>styk.vfxGizmos.handles.some(h=>h.kind==='radius'));assert.notEqual(await page.evaluate(()=>styk.vfx.selected.id),selected);
 await page.getByRole('tab',{name:'Properties',exact:true}).click();await page.waitForFunction(()=>!styk.vfxGizmos.handles.length);await page.getByRole('tab',{name:'VFX',exact:true}).click();
 // Gradient picker updates editable values with one committed change.
 await cards.first().locator('[data-vfx-paint]').first().click();await page.locator('.paint-picker [data-mode="gradient"]').click();await page.getByRole('button',{name:'Close color picker',exact:true}).click();assert.equal(await page.evaluate(()=>styk.editor.vfxEffects(styk.vfx.targets()[0])[0].params.color.type),'linear');
 // Native drag reorder and keyboard reorder both use one undo entry.
 const order=await page.evaluate(()=>styk.editor.vfxEffects(styk.vfx.targets()[0]).map(e=>e.id));const drag=await cards.first().locator('[data-vfx-drag]').boundingBox(),drop=await cards.last().boundingBox();await page.mouse.move(drag.x+5,drag.y+8);await page.mouse.down();await page.mouse.move(drop.x+40,drop.y+25,{steps:12});await page.mouse.up();assert.deepEqual(await page.evaluate(()=>styk.editor.vfxEffects(styk.vfx.targets()[0]).map(e=>e.id)),order.toReversed());
 await cards.first().locator('[data-vfx-drag]').focus();await page.keyboard.press('Alt+ArrowDown');assert.deepEqual(await page.evaluate(()=>styk.editor.vfxEffects(styk.vfx.targets()[0]).map(e=>e.id)),order);
 const snapshot=await page.evaluate(()=>JSON.stringify(styk.editor.report));await page.locator('#vfx-preview').click();await page.waitForFunction(()=>!styk.vfxGizmos.handles.length);assert.equal(await page.locator('#vfx-preview').getAttribute('aria-pressed'),'false');assert.equal(await page.evaluate(()=>JSON.stringify(styk.editor.report)),snapshot);await page.locator('#vfx-preview').click();
 await page.getByRole('button',{name:'Add effect',exact:true}).click();await page.locator('.vfx-catalog [data-catalog-mode="presets"]').click();await page.locator('.vfx-catalog [data-choice="Ice"]').click();assert.ok(await cards.count()>2);
 await fs.mkdir('artifacts/vfx',{recursive:true});await page.screenshot({path:'artifacts/vfx/expanded-inspector.png'});await page.locator('[data-vfx-action="add"]').click();await page.screenshot({path:'artifacts/vfx/expanded-catalog.png'});await page.keyboard.press('Escape');await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'artifacts/vfx/expanded-dark.png'});
 }
 assert.deepEqual(errors,[]);await fs.mkdir('artifacts/vfx',{recursive:true});await fs.writeFile('artifacts/vfx/expanded-rendering.json',JSON.stringify(parity,null,2));console.log(process.argv.includes('--render-only')?'Expanded VFX rendering passed':'Expanded VFX controls passed');
}finally{await browser.close();}
