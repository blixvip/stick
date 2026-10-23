import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 assert.ok(await page.locator('body').innerText());
 const result=await page.evaluate(async()=>{
  const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{buildGeometry,drawGeometry}=await import('/src/pivot/geometry.mjs'),
   {createVfx}=await import('/src/vfx.mjs'),{withVfx}=await import('/src/vfx-canvas.mjs'),{objectBounds}=await import('/src/renderer-geometry.mjs'),
   {connectedVfxGeometry}=await import('/src/vfx-connected.mjs'),{createRenderer}=await import('/src/renderer.mjs'),
   {compilePlaybackPacket}=await import('/src/playback-worker.mjs'),{drawExportScene,drawExportSceneTiled}=await import('/src/export-frame-core.mjs');
  const doc=emptyDocument();doc.canvas_width=320;doc.canvas_height=300;
  const fig=doc.figure_types[0];fig.segments=[{...fig.segments[0],length:200,angle_rad:0,thickness:24}];fig.segment_count=1;
  const root=createObject(fig,1,60,120),child=createObject(fig,2,60,120,{angles:[.55],join:{target_object_slot:0,target_unique_id:1,target_handle_id:0}}),
   foreign=createObject(fig,3,160,40,{angles:[Math.PI/2],color_override_raw:0xffcc6622});
  const frame=createFrame([root,child,foreign],10);frame.object_draw_order=[0,2,1];frame.object_draw_order_unique_ids=[1,3,2];doc.keyframes=[frame];
  const makeCanvas=()=>{const c=document.createElement('canvas');c.width=320;c.height=300;return c;};
  const pixels=canvas=>{const c=makeCanvas(),ctx=c.getContext('2d');ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,320,300).data;};
  const difference=(a,b)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;};
  const rows=[],screens=[],drags=[];
  for(const alpha of [0,128])for(const type of ['tint','wave','glow','vignette','pixelate']){
   foreign.field28=alpha;const effect=createVfx(type,'test');if(type==='tint'){effect.params.color=0xff0044;effect.params.mix=1;}
   // Independent painter-order reference: filter the two native parts around
   // the untouched foreign object, using the complete assembly's coordinates.
   delete root._stykVfx;delete root._stykVfxScope;
   const raw=buildGeometry(doc,frame),domain=objectBounds([raw.objects.get(0),raw.objects.get(1)].flatMap(g=>g.drawables),{vfxBounds:false});
   const reference=makeCanvas(),context=reference.getContext('2d');context.fillStyle='white';context.fillRect(0,0,320,300);
   for(const g of raw.orderedObjects){const paint=target=>drawGeometry(target,{drawables:g.drawables});
    if(g.slot===2)paint(context);else withVfx(context,[effect],paint,{bounds:objectBounds(g.drawables),domainBounds:domain});}
   const expected=pixels(reference);root._stykVfx={figure:[effect]};root._stykVfxScope=1;
   const geometry=buildGeometry(doc,frame),before=JSON.stringify(doc),view=connectedVfxGeometry(geometry,frame,doc);
   if(view.orderedObjects.map(g=>g.slot).join()!=='0,2,1'||JSON.stringify(doc)!==before)throw new Error('Native order or document changed');
   for(const forceCanvas2D of [false,true]){
    const canvas=makeCanvas(),renderer=await createRenderer(canvas,{forceCanvas2D});renderer.resize(320,300,1);
    try{
     const options={report:doc,frame,geometry,view:{x:0,y:0,scale:1}};renderer.render(options);const live=pixels(canvas);
     const packet=await compilePlaybackPacket(doc,0,{softwareFrames:forceCanvas2D,scale:1,gpuIsolation:!forceCanvas2D}),key=renderer.prepareFrame(packet,{report:doc,view:options.view});
     if(!renderer.renderPrepared(key,{report:doc,view:options.view}))throw new Error('Prepared interleaved frame rejected');
     const prepared=pixels(canvas);rows.push({alpha,type,backend:renderer.stats.backend,live:difference(live,expected),prepared:difference(prepared,expected)});
     if(type==='tint'&&!alpha){const sample=(x,y)=>Array.from(live.slice((y*320+x)*4,(y*320+x)*4+3));
      if(sample(160,120)[2]<150||sample(160,181)[0]<200)throw new Error(`Front/back overlap changed: ${JSON.stringify({back:sample(160,120),front:sample(160,181),expectedBack:Array.from(expected.slice((120*320+160)*4,(120*320+160)*4+3)),expectedFront:Array.from(expected.slice((181*320+160)*4,(181*320+160)*4+3)),diff:difference(live,expected)})}`);}
     for(const item of packet.compatibility??[])item.bitmap?.close();packet.softwareBitmap?.close();
    }finally{renderer.destroy();}
   }
   const direct=makeCanvas();drawExportScene(direct.getContext('2d'),doc,frame,geometry,{});
   const tiled=makeCanvas();await drawExportSceneTiled(tiled.getContext('2d'),doc,frame,geometry,{preload:async()=>{}},96);
   rows.push({alpha,type,backend:'export',live:difference(pixels(direct),expected),prepared:difference(pixels(tiled),expected)});
   if(type==='tint')screens.push(direct.toDataURL());
  }
  const {Editor}=await import('/src/editor.mjs');
  for(const forceCanvas2D of [false,true]){
   const e=new Editor({demo:false}).load(structuredClone(doc));e.select(1);
   const canvas=makeCanvas(),renderer=await createRenderer(canvas,{forceCanvas2D});renderer.resize(320,300,1);
   try{
    const options=()=>({report:e.report,frame:e.evaluatedFrame,geometry:e.geometry,view:{x:0,y:0,scale:1}});
    renderer.render(options());const before=pixels(canvas);e.beginTranslationDrag();
    renderer.render({...options(),dragTranslations:new Map([[1,{x:12,y:-8}],[2,{x:12,y:-8}]])});const preview=pixels(canvas);
    e.moveSelection(12,-8,{fromStart:true});e.commitDrag();renderer.render(options());
    const committed=pixels(canvas);e.undo();renderer.render(options());
    drags.push({backend:renderer.stats.backend,previewCommit:difference(preview,committed),undo:difference(before,pixels(canvas))});
   }finally{renderer.destroy();}
  }
  const e=styk.editor;e.load(doc);e.select(1);styk.vfx.setVisible(true);styk.vfx.scope='figure';styk.vfx.sync();
  return {rows,screens,drags};
 });
 await page.getByRole('tab',{name:'VFX',exact:true}).click();
 await page.getByLabel('Effect target',{exact:true}).selectOption('connected');
 assert.equal(await page.evaluate(()=>styk.editor.animationValue({kind:'figure',uid:1},'vfxScope')),1);
 assert.deepEqual(errors,[]);
 await fs.mkdir('artifacts/vfx',{recursive:true});
 for(const [i,data] of result.screens.entries())await fs.writeFile(`artifacts/vfx/interleaved-${i}.png`,Buffer.from(data.split(',')[1],'base64'));
 await page.screenshot({path:'artifacts/vfx/interleaved-inspector.png'});
 await fs.writeFile('artifacts/vfx/interleaved.json',JSON.stringify(result.rows,null,2));
 console.log(JSON.stringify(result.rows,null,2));
 console.log(JSON.stringify(result.drags));
 for(const row of result.drags){assert.ok(row.previewCommit<.1,JSON.stringify(row));assert.ok(row.undo<.1,JSON.stringify(row));}
 for(const row of result.rows){assert.ok(row.live<.8,JSON.stringify(row));assert.ok(row.prepared<.8,JSON.stringify(row));}
}finally{await browser.close();}
