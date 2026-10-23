import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const output=process.env.STYK_SELECTION_ARTIFACTS||'artifacts/drawing-selection';await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47839');await page.waitForFunction(()=>window.styk?.ready);
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.evaluate(async()=>{
    const {emptyDocument}=await import('/src/demo.mjs');
    styk.state.settings.autosaveSeconds=0;
    window.freshSelection=async()=>{const e=styk.editor,d=styk.drawing;e.load(emptyDocument());e.createDrawingLayer();d.settings.filter='nearest';d.settings.resolution=1;const target=e.prepareDrawingCel({pixelsPerUnit:1,world:{x:0,y:0}}),surface=await d.owner.surface(target.figure);return {e,d,target,surface};};
    window.box=(x,y,width,height)=>[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}];
  });
  const sparse=await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshSelection();
    e.commitDrawingPixels(target,[{tx:-100000,ty:-100000,before:null,after:new Uint8ClampedArray([127,5,249,1])},{tx:100000,ty:100000,before:null,after:new Uint8ClampedArray([31,63,95,255])}]);
    const original=[...surface.store].map(t=>t.pixels.slice()),start=performance.now();
    await d.makeSelection({target:e.drawingTarget(),surface,points:box(-6400000,-6400000,12800064,12800064)});
    const ms=performance.now()-start,sourceBytes=d.selection.source.bytes,selectionBounds=d.selection.bounds;
    d.selection.dx=128;d.previewSelection();const untouched=[...surface.store].every((t,i)=>t.pixels.every((n,j)=>n===original[i][j]));
    const commit=e.commitDrawingPixels.bind(e);let transientsDuringCommit;
    e.commitDrawingPixels=(...args)=>{transientsDuringCommit=d.owner.stats.transients;return commit(...args);};
    try{await d.applySelection();}finally{e.commitDrawingPixels=commit;}
    const exact=surface.store.pixel(-6399872,-6400000).join(',')==='127,5,249,1'&&surface.store.pixel(6400128,6400000).join(',')==='31,63,95,255';
    await d.history('undo');const undo=[...surface.store].every((t,i)=>t.pixels.every((n,j)=>n===original[i][j]));
    return {ms,sourceBytes,selectionBounds,untouched,exact,undo,transientsDuringCommit,transients:d.owner.stats.transients};
  });
  check('selection crosses 12.8 million pixels with only two source tiles',sparse.sourceBytes===32768&&sparse.selectionBounds.width===12800064);
  check('preview is nondestructive and distant moves retain exact low-alpha colors and undo',sparse.untouched&&sparse.exact&&sparse.undo);
  check('committing releases all temporary selection surfaces',sparse.transients===0);
  check('live selection surfaces stay accounted while the commit reserves replacement pixels',sparse.transientsDuringCommit===3);

  for(const navigation of ['cancel','seek','document']){
    await page.evaluate(async()=>{
      const {e,d,target,surface}=await freshSelection();e.commitDrawingPixels(target,[{tx:0,ty:0,before:null,after:new Uint8ClampedArray([127,5,249,1])}]);
      window.selectionOwner=d.owner;window.requestOriginal=d.owner.worker.request.bind(d.owner.worker);window.held=false;
      d.owner.worker.request=async(kind,...args)=>{const result=await requestOriginal(kind,...args);if(kind==='select'){window.held=true;await new Promise(resolve=>window.release=resolve);}return result;};
      window.work=d.makeSelection({target:e.drawingTarget(),surface,points:box(0,0,64,64)}).then(()=>false,error=>error.name==='AbortError');
    });
    await page.waitForFunction(()=>window.held);
    const result=await page.evaluate(async navigation=>{
      const d=styk.drawing,e=styk.editor,revision=e.revision;
      if(navigation==='cancel')d.cancel();
      else if(navigation==='seek')e.seek(e.tick+1);
      else {const {emptyDocument}=await import('/src/demo.mjs');e.load(emptyDocument());}
      release();const aborted=await work;
      selectionOwner.worker.request=requestOriginal;
      return {aborted,selection:!!d.selection,transients:selectionOwner.stats.transients,working:selectionOwner.stats.workingBytes,unchanged:navigation==='document'||e.revision===revision};
    },navigation);
    check(`${navigation} rejects a stale selection reply and releases its memory`,result.aborted&&!result.selection&&!result.transients&&!result.working&&result.unchanged);
  }

  const pointer=await page.evaluate(async()=>{
    const {e,d,target}=await freshSelection(),{worldToScreen}=await import('/src/renderer-geometry.mjs');
    e.commitDrawingPixels(target,[{tx:1,ty:1,before:null,after:new Uint8ClampedArray([45,90,180,255])}]);d.tool='lasso';
    const rect=d.viewport.getBoundingClientRect();
    return box(72,72,32,32).map(p=>{const s=worldToScreen(p,{report:e.report,frame:e.evaluatedFrame,view:styk.state.view,cameraEnabled:false});return {x:rect.left+s.x*rect.width/d.viewport.clientWidth,y:rect.top+s.y*rect.height/d.viewport.clientHeight};});
  });
  await page.mouse.move(pointer[0].x,pointer[0].y);await page.mouse.down();await page.waitForFunction(()=>styk.drawing.gesture?.kind==='lasso');
  for(const p of pointer.slice(1))await page.mouse.move(p.x,p.y,{steps:4});await page.mouse.move(pointer[0].x,pointer[0].y);await page.mouse.up();
  await page.waitForFunction(()=>styk.drawing.selection&&!styk.drawing.operation);
  check('pointer release creates the selection and leaves authoritative pixels unchanged',await page.evaluate(()=>{const d=styk.drawing;return d.selection.source.bounds.width>=31&&d.selection.source.bounds.width<=33&&d.selection.surface.store.pixel(80,80).join(',')==='45,90,180,255'&&d.selection.surface.pinned;}));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!styk.drawing.selection);
  check('Escape releases a completed pointer selection',await page.evaluate(()=>styk.drawing.owner.stats.transients===0));

  const dense=await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshSelection(),tiles=[];
    for(let ty=0;ty<64;ty++)for(let tx=0;tx<64;tx++)tiles.push({tx,ty,before:null,after:new Uint8ClampedArray([127,63,31,255])});
    e.commitDrawingPixels(target,tiles);await d.barrier();
    const baseBytes=d.owner.stats.bytes,start=performance.now();let previous=start,maxGapMs=0,ticks=0;
    const timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-previous);previous=now;ticks++;},5);
    try{
      await d.makeSelection({target:e.drawingTarget(),surface,points:box(0,0,8192,8192)});
      const selectionMs=performance.now()-start,sourceBytes=d.selection.source.bytes,residentBytes=d.owner.stats.bytes;
      const presenter=d.selection.presenter,previewStart=performance.now();let preview=false;
      while(performance.now()-previewStart<15000){
        const scratch=presenter.scratch({x:0,y:0,width:4096,height:4096},{level:2});
        if(scratch?.canvas.getContext('2d').getImageData(500,500,1,1).data[3]===255){preview=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const previewMs=performance.now()-previewStart,worker=!!d.owner.previews.worker.worker,scratchBytes=d.owner.stats.scratchBytes;
      d.selection.dx=64;d.previewSelection();const commitStart=performance.now();await d.applySelection();const commitMs=performance.now()-commitStart;
      const moved=surface.store.pixel(0,0)[3]===0&&surface.store.pixel(4096,0).join(',')==='127,63,31,255';
      await d.history('undo');const undo=surface.store.pixel(0,0).join(',')==='127,63,31,255'&&surface.store.pixel(4096,0)[3]===0;
      return {selectionMs,previewMs,commitMs,baseBytes,sourceBytes,residentBytes,scratchBytes,preview,worker,moved,undo,ticks,maxGapMs,transients:d.owner.stats.transients};
    }finally{clearInterval(timer);}
  });
  console.log(JSON.stringify({dense}));
  check('an 8K lasso shares the dense 4K cel without allocating selected pixel buffers',dense.sourceBytes===64*1024*1024&&dense.residentBytes===dense.baseBytes);
  check('dense selection preview becomes visible through the bounded worker cache',dense.preview&&dense.worker&&dense.scratchBytes<=64*1024*1024);
  check('large selected pixels move and undo exactly',dense.moved&&dense.undo&&dense.transients===0);
  check('input tasks run during worker selection and transform',dense.ticks>10);

  // Leave a visible selection for the screenshot, with enough resolution to
  // inspect the moved edge and the preserved cel underneath it.
  await page.evaluate(async()=>{
    const {e,d,target,surface}=await freshSelection();e.commitDrawingPixels(target,[{tx:1,ty:1,before:null,after:new Uint8ClampedArray([40,100,210,255])},{tx:2,ty:1,before:null,after:new Uint8ClampedArray([230,130,40,255])}]);
    d.tool='lasso';await d.makeSelection({target:e.drawingTarget(),surface,points:box(80.25,70.25,80,42)});d.selection.dy=70;d.previewSelection();d.onUI();
  });
  check('fractional lasso geometry retains its original transform pivot',await page.evaluate(()=>styk.drawing.selection.cx===120.25&&styk.drawing.selection.cy===91.25));
  const bounded=await page.evaluate(async()=>{
    const d=styk.drawing,s=d.selection,owner=d.owner,budget=owner.scratchBudget;
    const target=s.target,surface=s.surface,points=s.points;d.cancelSelection();owner.scratchBudget=12*256*256;
    try{
      await d.makeSelection({target,surface,points});d.selection.dy=70;d.previewSelection();
      const p=d.selection.presenter,large=p.scratch({x:0,y:0,width:512,height:512}),small=p.scratch({x:0,y:0,width:512,height:512},{level:1});
      const ctx=small.canvas.getContext('2d'),base=ctx.getImageData(34,34,1,1).data,moved=ctx.getImageData(48,76,1,1).data;
      return !large&&base[3]===255&&moved[3]===255&&owner.stats.scratchBytes<=owner.scratchBudget;
    }finally{d.cancelSelection();owner.scratchBudget=budget;await d.makeSelection({target,surface,points});d.selection.dy=70;d.previewSelection();}
  });
  check('compositor and child previews coexist under a constrained scratch budget',bounded);
  await page.waitForTimeout(200);await page.screenshot({path:output+'/workspace.png'});
  check('no uncaught browser errors',errors.length===0);
  await writeFile(output+'/result.json',JSON.stringify({checks,sparse,dense,errors},null,2));
}finally{await browser.close();}
