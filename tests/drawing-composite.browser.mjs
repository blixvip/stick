import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const output=process.env.STYK_COMPOSITE_ARTIFACTS||'artifacts/drawing-worker-composite/browser',baseline=process.env.STYK_COMPOSITE_BASELINE,checks=[],errors=[];await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>errors.push(error.message));const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  if(baseline)for(const file of ['src/drawing-controller.mjs','src/drawing-resources.mjs']){
    const body=execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8'});await page.route(`**/${file}`,route=>route.fulfill({contentType:'text/javascript',body}));
  }
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);await page.locator('[data-workspace-mode="draw"]').click();
  const immediate=await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs'),{TileStore}=await import('/src/drawing-tiles.mjs');
    const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.report.canvas_width=640;e.report.canvas_height=480;e.createDrawingLayer();styk.state.settings.autosaveSeconds=0;
    const first=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),store=new TileStore();
    for(let y=128;y<=384;y++)for(let x=128;x<=512;x++)if(x===128||x===512||y===128||y===384)store.writable(Math.floor(x/64),Math.floor(y/64)).pixels.set([20,30,40,255],((y%64)*64+x%64)*4);
    e.commitDrawingPixels(first,[...store].map(t=>({tx:t.tx,ty:t.ty,before:null,after:t.pixels})));e.createDrawingLayer();
    const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);
    window.compositeTarget=target;window.compositeSurface=surface;window.compositeHistory=e._undo.length;
    Object.assign(d.settings,{color:'#d02a30',opacity:1,tolerance:0,expansion:0,gap:0,sampleAll:true});
    let error;try{const pending=d.fill(target,surface,{x:256,y:256});window.lastCompositeOperation=d.operation;await pending;}catch(e){error=e.message;}
    return {error,pixel:surface.store?.pixel(256,256),outside:surface.store?.pixel(530,256),held:d.owner.working.has(lastCompositeOperation),pinned:surface.pinned};
  });
  await writeFile(output+'/immediate.json',JSON.stringify(immediate,null,2));
  if(baseline){console.log(JSON.stringify(immediate));await browser.close();process.exit(0);}
  check('sample-all fill immediately after ink on another layer succeeds',!immediate.error&&immediate.pixel?.join()==='208,42,48,255');
  check('other-layer ink bounds the fill and working memory is released',immediate.outside[3]===0&&!immediate.held&&!immediate.pinned);
  check('capture worker is released after completion',await page.evaluate(()=>!styk.drawing.owner.compositeWorker.worker&&styk.drawing.owner.compositeWorker.pending.size===0));
  await page.screenshot({path:output+'/filled.png'});
  await page.evaluate(()=>styk.drawing.history('undo'));
  check('sample-all undo removes its new cel in one command',await page.evaluate(()=>styk.editor._undo.length===compositeHistory&&!styk.editor.drawingTarget().figure));
  await page.evaluate(()=>styk.drawing.history('redo'));
  check('sample-all redo restores exact interior and clear exterior',await page.evaluate(()=>{const store=styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store;return store.pixel(256,256).join()==='208,42,48,255'&&store.pixel(530,256)[3]===0;}));
  const freshTarget=await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,target=e.drawingTarget(),surface=d.owner.entry(target.figure),changes=new Map();
    for(let y=129;y<384;y++){
      const tx=4,ty=Math.floor(y/64),key=`${tx},${ty}`;let change=changes.get(key);
      if(!change){const before=surface.store.get(tx,ty)?.pixels;change={tx,ty,before,after:before?.slice()??new Uint8ClampedArray(16384)};changes.set(key,change);}
      change.after.set([10,20,30,255],((y%64)*64+300%64)*4);
    }
    e.commitDrawingPixels(target,[...changes.values()]);const unpublished=surface.published?.revision!==surface.revision;
    d.settings.color='#aaddee';await d.fill(target,surface,{x:256,y:256});
    return {unpublished,left:surface.store.pixel(256,256),right:surface.store.pixel(400,256),wall:surface.store.pixel(300,256)};
  });
  check('capture includes the destination cel latest unpublished pixels',freshTarget.unpublished&&freshTarget.left.join()==='170,221,238,255'&&freshTarget.right.join()==='208,42,48,255'&&freshTarget.wall.join()==='10,20,30,255');
  await page.evaluate(async()=>{await styk.drawing.history('undo');await styk.drawing.history('undo');});
  const parity=await page.evaluate(async()=>{
    const {createVfx}=await import('/src/vfx.mjs'),{sendDrawingComposite}=await import('/src/drawing-composite-transport.mjs'),{drawGeometry,releaseGeometryResources}=await import('/src/pivot/geometry.mjs'),{PlaybackResources}=await import('/src/playback-resources.mjs');
    const obj={unique_id:1,scale:1,image_text_flags:0,color_override_raw:0},fig={figure_type_id:1},seg={segment_id:1,segment_kind:'line'},drawables=[];
    const line=(slot,points,rgb,extra={})=>({type:'line',obj,fig,seg,slot,start:points[0],end:points.at(-1),points,angle:0,length:300,bend:0,thickness:14,rgb,alpha:1,opacity:1,...extra});
    drawables.push(line(0,[{x:30,y:30},{x:530,y:330}],[180,50,20],{seg:{...seg,secondary:{rgb:[20,40,240],a:0}}}));
    drawables.push(line(1,[{x:250,y:20},{x:250,y:380}],[20,200,50],{opacity:.55}),line(1,[{x:80,y:256},{x:540,y:256}],[20,200,50],{opacity:.55}));
    drawables.push(line(2,[{x:255,y:5},{x:530,y:400}],[40,50,160],{_movieclipOwner:{opacity:.7,scale:1},_movieclipPart:0,_movieclipInner:{owner:{opacity:.5,scale:1},part:0}}));
    const bitmap=document.createElement('canvas');bitmap.width=47;bitmap.height=53;const bctx=bitmap.getContext('2d');bctx.fillStyle='#eecc22';bctx.fillRect(0,0,47,53);bctx.clearRect(10,10,20,20);
    drawables.push(line(3,[{x:220,y:215},{x:330,y:215}],[0,0,0],{type:'image',asset:{data_url:bitmap.toDataURL(),anchor_length:47,anchor_angle_rad:0,anchor_start:{x:0,y:0}},alpha:.75}));
    drawables.push(line(4,[{x:235,y:310},{x:295,y:310}],[170,50,210],{type:'text',asset:{normalized_svg_path:'M0 0',bounds:{left:0,bottom:0,width:60,height:40},placements:[{visible:true,glyph_index:0,x:0,y:0}],glyphs:[{svg_path:'M0 0 L60 0 L30 -40 Z'}]}}));
    const blur=createVfx('blur','capture-blur');blur.params.radius=5;drawables.push(line(5,[{x:400,y:100},{x:500,y:150}],[60,150,200],{obj:{...obj,_stykVfx:{figure:[blur]}}})); const bounds={x:-20,y:-30,width:600,height:430},cases=[];
    for(const filtered of [false,true])for(const matrix of [[1,0,0,1,0,0],[.1,.05,-.025,.09,60,20],[-1,0,0,1,550,0]]){
      const sample=filtered?drawables:drawables.slice(0,-1);const resources=new PlaybackResources({baseURL:location.href}),canvas=new OffscreenCanvas(bounds.width,bounds.height),ctx=canvas.getContext('2d');
      await resources.preload(sample);ctx.setTransform(...matrix.slice(0,4),matrix[4]-bounds.x,matrix[5]-bounds.y);drawGeometry(ctx,{drawables:sample},resources);const expected=ctx.getImageData(0,0,bounds.width,bounds.height).data;
      const worker=styk.drawing.owner.compositeWorker;let actual;
      try{await sendDrawingComposite(worker,sample,{maxBytes:64*1024*1024});actual=new Uint8ClampedArray((await worker.request('composite',{bounds,matrix,maxBytes:128*1024*1024,baseURL:location.href})).source);}
      finally{worker.dispose();resources.dispose();releaseGeometryResources(ctx);}
      let different=0,max=0,premultipliedMax=0;for(let i=0;i<actual.length;i++){if(actual[i]!==expected[i])different++;max=Math.max(max,Math.abs(actual[i]-expected[i]));}
      for(let i=0;i<actual.length;i+=4)for(let c=0;c<4;c++)premultipliedMax=Math.max(premultipliedMax,Math.abs(c===3?actual[i+c]-expected[i+c]:(actual[i+c]*actual[i+3]-expected[i+c]*expected[i+3])/255));const points=[];for(let i=0;i<actual.length;i+=4)if(actual.slice(i,i+4).some((v,j)=>v!==expected[i+j])&&points.length<12)points.push({x:(i/4)%bounds.width,y:Math.floor(i/4/bounds.width),a:Array.from(actual.slice(i,i+4)),e:Array.from(expected.slice(i,i+4))});cases.push({filtered,matrix,different,max,premultipliedMax,bytes:actual.length,points});
    }
    return cases;
  });
  await writeFile(output+'/parity.json',JSON.stringify(parity,null,2));
  check('worker capture exactly preserves gradients, grouped alpha, nested clips, images and glyphs under affine poses',parity.filter(c=>!c.filtered).every(c=>c.different===0));
  check('filtered capture preserves alpha and colour within two premultiplied channel levels',parity.filter(c=>c.filtered).every(c=>c.premultipliedMax<=2));
  await page.evaluate(()=>{
    const d=styk.drawing,worker=d.owner.compositeWorker,request=worker.request.bind(worker);window.originalCompositeRequest=request;
    worker.request=async(kind,...args)=>{if(kind==='composite'){window.compositeHeld=true;await new Promise(resolve=>window.releaseComposite=resolve);}return request(kind,...args);};
    const target=styk.editor.drawingTarget(),surface=d.owner.entry(target.figure);window.cancelBefore=Array.from(surface.store.pixel(256,256));window.cancelHistory=styk.editor._undo.length;
    d.settings.color='#2255cc';window.cancelResult=d.fill(target,surface,{x:256,y:256}).catch(error=>error.name);window.cancelOperation=d.operation;
  });
  await page.waitForFunction(()=>window.compositeHeld);await page.keyboard.press('Escape');await page.evaluate(()=>releaseComposite());
  check('Escape cancels staged capture without publishing pixels or history',await page.evaluate(async()=>await cancelResult==='AbortError'&&styk.editor._undo.length===cancelHistory&&styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store.pixel(256,256).every((v,i)=>v===cancelBefore[i])));
  check('cancelled capture releases worker and memory reservation',await page.evaluate(()=>!styk.drawing.owner.compositeWorker.worker&&!styk.drawing.owner.working.has(cancelOperation)));
  await page.evaluate(async()=>{const d=styk.drawing;d.owner.compositeWorker.request=originalCompositeRequest;await d.fill(styk.editor.drawingTarget(),d.owner.entry(styk.editor.drawingTarget().figure),{x:256,y:256});});
  check('capture works after cancellation',await page.evaluate(()=>styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store.pixel(256,256).join()==='34,85,204,255'));
  const failed=await page.evaluate(async()=>{
    const {sendDrawingComposite}=await import('/src/drawing-composite-transport.mjs'),d=styk.drawing,worker=d.owner.compositeWorker;
    try{await sendDrawingComposite(worker,[],{maxBytes:1024});await worker.request('composite',{bounds:{x:0,y:0,width:1024,height:1024},matrix:[1,0,0,1,0,0],maxBytes:1024});return null;}
    catch(error){return error.message;}finally{worker.dispose();}
  });
  check('capture allocation guard rejects insufficient worker memory',/working memory/.test(failed));
  const workerURL='**/src/drawing-composite-worker.mjs';await page.route(workerURL,route=>route.abort('failed'));
  const loadFailure=await page.evaluate(async()=>{
    const d=styk.drawing,e=styk.editor,target=e.drawingTarget(),surface=d.owner.entry(target.figure),history=e._undo.length;
    let error;try{await d.fill(target,surface,{x:256,y:256});}catch(e){error=e.message;}
    return {error,history:e._undo.length===history,pixel:surface.store.pixel(256,256),closed:!d.owner.compositeWorker.worker};
  });
  check('capture module failure rejects work and preserves pixels and history',loadFailure.error&&loadFailure.history&&loadFailure.closed&&loadFailure.pixel.join()==='34,85,204,255');
  await page.unroute(workerURL);
  await page.evaluate(async()=>{const d=styk.drawing;d.settings.color='#42cc77';await d.fill(styk.editor.drawingTarget(),d.owner.entry(styk.editor.drawingTarget().figure),{x:256,y:256});});
  check('capture recovers after a worker load failure',await page.evaluate(()=>styk.drawing.owner.entry(styk.editor.drawingTarget().figure).store.pixel(256,256).join()==='66,204,119,255'));
  check('no uncaught browser errors',errors.length===0);
  await writeFile(output+'/result.json',JSON.stringify({checks,errors,parity,browser:browser.version()},null,2));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({message:error.message,checks,errors},null,2));await page.screenshot({path:output+'/failure.png'});throw error;}
finally{await browser.close();}
