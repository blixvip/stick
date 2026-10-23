import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve(process.env.STYK_RENDER_ARTIFACTS||'artifacts/drawing-render'),url=process.env.STYK_URL||'http://127.0.0.1:47839';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.stack));
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
try{
  await page.goto(url);await page.waitForFunction(()=>window.styk?.ready);
  // Scene readback works for both Canvas 2D and WebGPU surfaces via toDataURL.
  await page.evaluate(()=>{
    window.readScene=async()=>{const c=document.querySelector('#scene');const image=new Image();image.src=c.toDataURL();await image.decode();
      const o=new OffscreenCanvas(image.naturalWidth,image.naturalHeight),ctx=o.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(image,0,0);return {data:ctx.getImageData(0,0,o.width,o.height),width:o.width,height:o.height};};
    window.kick=()=>{const v=document.querySelector('#viewport'),r=v.getBoundingClientRect();v.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:0,deltaY:0,clientX:r.left+10,clientY:r.top+10}));};
    // Re-anchor the view so the canvas center stays at the viewport center at
    // any zoom; rotation pivots about the canvas center too.
    window.setView=({scale=1,rotation=0})=>{const r=document.querySelector('#viewport').getBoundingClientRect(),w=styk.editor.report.canvas_width,h=styk.editor.report.canvas_height;
      Object.assign(styk.state.view,{x:r.width/2-w*scale/2,y:r.height/2-h*scale/2,scale,rotation});kick();};
    // Sample the live scene across every tile boundary that crosses the solid
    // core of the test stroke. A rendered seam shows as non-inked pixels where
    // the authoritative store says the band is opaque.
    window.seamScan=async()=>{
      const {drawingPixelMatrix,transformPoint}=await import('/src/drawing-model.mjs');
      const {worldToScreen}=await import('/src/renderer-geometry.mjs');
      const e=styk.editor,d=styk.drawing,fig=e.drawingTarget().figure;
      const item=e.geometry.drawables.find(i=>i.type==='image'&&i.fig===fig);
      const store=d.owner.entry(fig).store,b=store?.bounds;
      if(!item||!b)return {ink:0,gaps:-1,boundaries:0};
      const pm=drawingPixelMatrix(item),opts={report:e.report,frame:e.evaluatedFrame,view:styk.state.view,cameraEnabled:false};
      const M=(x,y)=>worldToScreen(transformPoint(pm,{x,y}),opts);
      const shot=await readScene(),cr=document.querySelector('#scene').getBoundingClientRect(),vr=document.querySelector('#viewport').getBoundingClientRect();
      const ox=cr.left-vr.left,oy=cr.top-vr.top,px=shot.data.data;
      // Samples off the visible surface are skipped, not counted as gaps.
      const sample=(x,y)=>{const p=M(x,y);x=Math.round(p.x-ox);y=Math.round(p.y-oy);
        if(x<0||y<0||x>=shot.width||y>=shot.height)return null;
        const i=(y*shot.width+x)*4;return px[i+3]>200&&px[i+2]>150&&px[i]<140&&px[i+1]<140;};
      // A rendered pixel is only guaranteed inked when the whole filter
      // footprint is opaque — at 25% zoom one screen pixel covers 4x4 source
      // pixels, so require a +/-4 px opaque neighborhood.
      const solid=(x,y)=>{x=Math.round(x);y=Math.round(y);
        for(let dy=-4;dy<=4;dy+=2)for(let dx=-4;dx<=4;dx+=2)if(store.pixel(x+dx,y+dy)[3]<200)return false;return true;};
      let ink=0,gaps=0,boundaries=0;
      // Vertical tile boundaries crossed by the band core, sampled along the
      // crossing row and along the boundary through the band interior.
      const ymid=b.y+b.height/2,probe=(x,y)=>{if(!solid(x,y))return;const v=sample(x,y);if(v===null)return;boundaries++;if(v)ink++;else gaps++;};
      for(let tx=Math.ceil(b.x/64);tx*64<b.x+b.width;tx++){
        const xb=tx*64;
        for(let dx=-6;dx<=6;dx++)probe(xb+dx,ymid); // along the crossing row
        for(let y=b.y+6;y<b.y+b.height-6;y+=6)probe(xb,y); // along the boundary
      }
      // Horizontal boundaries, same treatment.
      const xmid=b.x+b.width/2;
      for(let ty=Math.ceil(b.y/64);ty*64<b.y+b.height;ty++){
        const yb=ty*64;
        for(let dy=-6;dy<=6;dy++)probe(xmid,yb+dy);
        for(let x=b.x+6;x<b.x+b.width-6;x+=6)probe(x,yb);
      }
      return {ink,gaps,boundaries};
    };
    // Plain ink coverage for the playback check.
    window.inkCount=async()=>{const {data,width,height}=await readScene(),d=data.data;let ink=0;
      for(let i=0;i<d.length;i+=4)if(d[i+3]>200&&d[i+2]>150&&d[i]<140&&d[i+1]<140)ink++;
      return ink;};
  });
  await page.evaluate(()=>{styk.state.settings.autosaveSeconds=0;});
  await page.locator('[data-workspace-mode="draw"]').click();
  await page.locator('[data-draw-action="new"]').first().click();
  await page.evaluate(()=>{Object.assign(styk.drawing.settings,{resolution:1,size:48,color:'#2040d8',hardness:1,flow:1,opacity:1,stabilization:0,texture:0});});
  // One long straight stroke: a solid band crossing many tile boundaries.
  const rect=await page.locator('#viewport').boundingBox();
  const start={x:rect.x+rect.width*.2,y:rect.y+rect.height*.45},end={x:start.x+640,y:start.y+80};
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.waitForFunction(()=>Boolean(styk.drawing.gesture));
  await page.mouse.move(end.x,end.y,{steps:64});await page.mouse.up();await page.waitForFunction(()=>!styk.drawing.gesture);
  // Park the pointer off-canvas so the brush cursor ring never joins a scan.
  await page.mouse.move(3,3);
  check('the test stroke committed a tile-backed cel',await page.evaluate(()=>styk.editor.drawingTarget().figure._styk.drawing.version===2&&styk.editor.undoLabel==='Brush stroke'));
  await page.evaluate(()=>styk.drawing.barrier());
  await page.screenshot({path:path.join(output,'stroke.png')});

  for(const mode of ['canvas','gpu']){
    await page.evaluate(mode=>{styk.settingsUI.commit({rendererMode:mode});},mode);
    await page.waitForFunction(mode=>styk.state.renderer?.stats.backend&&(mode==='canvas'?/canvas/i.test(styk.state.renderer.stats.backend):/webgpu/i.test(styk.state.renderer.stats.backend)),mode,{timeout:15000});
    const backend=await page.evaluate(()=>styk.state.renderer.stats.backend);
    for(const scale of [.25,8]){
      await page.evaluate(scale=>setView({scale,rotation:0}),scale);
      await page.waitForTimeout(120);
      const scan=await page.evaluate(()=>seamScan());
      check(`${backend} at ${scale*100}% paints the stroke without seams`,scan.boundaries>10&&scan.ink>10&&scan.gaps===0);
    }
    await page.evaluate(()=>setView({scale:2,rotation:Math.PI/6}));
    await page.waitForTimeout(120);
    const rotated=await page.evaluate(()=>seamScan());
    check(`${backend} at 30° rotation paints the stroke without seams`,rotated.boundaries>10&&rotated.ink>10&&rotated.gaps===0);
    // A sub-tile pan keeps the anchored scratch: no tile re-blits.
    await page.evaluate(()=>setView({scale:1}));
    await page.waitForTimeout(120);
    const blits=await page.evaluate(()=>{const e=styk.drawing.owner.entry(styk.editor.drawingTarget().figure);return [...e._scratches?.values()??[]].reduce((n,s)=>n+s.blits,0)||null;});
    await page.evaluate(()=>{styk.state.view.x-=3;kick();});
    await page.waitForTimeout(120);
    const after=await page.evaluate(()=>{const e=styk.drawing.owner.entry(styk.editor.drawingTarget().figure);return [...e._scratches?.values()??[]].reduce((n,s)=>n+s.blits,0)||null;});
    check(`${backend} a 3px pan reuses the anchored tile scratch`,blits!==null&&after===blits);
  }

  // Export at 2x resolution must resolve source detail: compare a full-quality
  // export frame against a direct 2x render of the same geometry.
  const sharpness=await page.evaluate(async()=>{
    const {ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
    const {createRenderer}=await import('/src/renderer.mjs'),{buildGeometry}=await import('/src/pivot/geometry.mjs');
    const e=styk.editor,d=styk.drawing,W=e.report.canvas_width,H=e.report.canvas_height;
    // Render only the drawing in both paths: the default document's figure
    // uses slightly different AA in the export worker vs the live renderer,
    // which would otherwise dominate the comparison. Objects stay in place
    // (layers index them by slot); other figures' segments are made fully
    // transparent instead.
    const target=e.drawingTarget(),uid=target.object.unique_id,keep=target.object.figure_type_id;
    const filtered={...e.report,figure_types:e.report.figure_types.map(f=>f.figure_type_id===keep?f:{...f,segments:f.segments.map(s=>({...s,transparency:255}))})};
    const exporter=new ExportFrameRenderer({width:W*2,height:H*2,smoothing:'edges',getRevision:()=>e.revision});
    try{
      await exporter.load(filtered);await exporter.renderTick(e.tick);
      const exported=exporter.context.getImageData(0,0,exporter.canvas.width,exporter.canvas.height);
      const c=document.createElement('canvas'),renderer=await createRenderer(c,{forceCanvas2D:true,resources:{drawing:f=>d.resource(f)}});
      try{
        const geometry=buildGeometry(e.report,e.evaluatedFrame);
        const hiddenUids=new Set(geometry.drawables.map(i=>i.obj.unique_id).filter(u=>u!==uid));
        renderer.resize(W*2,H*2,1);
        renderer.render({report:e.report,frame:e.evaluatedFrame,geometry,hiddenUids,view:{x:0,y:0,scale:2},cameraEnabled:false,clipToCanvas:true,vfxEnabled:false});
        const live=c.getContext('2d').getImageData(0,0,c.width,c.height);
        const w=Math.min(exported.width,live.width),h=Math.min(exported.height,live.height);
        let max=0,compared=0,inked=0;
        for(let i=0;i<w*h;i++){const a=i*4;
          if(exported.data[a+3]>100)inked++;
          for(let k=0;k<4;k++){const diff=Math.abs(exported.data[a+k]-live.data[a+k]);if(diff>max)max=diff;}
          compared++;}
        return {max,compared,inked};
      }finally{renderer.destroy();}
    }finally{exporter.dispose();}
  });
  check('2x export edge matches the live 2x render within 8/255',sharpness.inked&&sharpness.compared>10000&&sharpness.max<=8);

  // Memory and playback need a multi-tick document: 30 distinct copied cels,
  // each stamped with a small stroke on top of the copied band.
  await page.evaluate(async()=>{
    const e=styk.editor,d=styk.drawing,{DrawingStroke}=await import('/src/drawing-pixels.mjs');
    const id=e.drawingTarget().id;
    for(let i=1;i<30;i++)e.nextDrawing([id],{blank:false,length:1});
    for(let i=0;i<30;i++){e.seek(i);const target=e.prepareDrawingCel(),surface=await d.owner.surface(target.figure);
      const stroke=new DrawingStroke(surface.store,{size:12});stroke.sample({x:20+i*4,y:20});stroke.sample({x:60+i*4,y:40});e.commitDrawingPixels(target,stroke.finish());}
    await d.barrier();e.seek(0);
  });
  check('the timeline grew to 30 distinct drawing cels',await page.evaluate(()=>styk.editor.totalTicks>=30&&styk.editor.drawingResources.stats.entries>=30));

  // Playback presents the drawing through the prepared-frame path.
  await page.locator('#play-button').click();
  await page.waitForFunction(()=>styk.state.playing&&styk.editor.tick>0,{timeout:15000});
  await page.waitForTimeout(300);
  const playback=await page.evaluate(async()=>({ink:await inkCount(),frames:styk.performance().playback.readyFrames,playing:styk.state.playing}));
  await page.locator('#play-button').click();
  check('prepared-frame playback paints the drawing',playback.playing&&playback.frames>0&&playback.ink>100);

  await page.evaluate(()=>styk.settingsUI.commit({rendererMode:'auto'}));
  // Scrub across the populated frames, then check every budget.
  for(const tick of [0,15,29,0])await page.evaluate(tick=>{styk.editor.seek(tick);kick();},tick),await page.waitForTimeout(80);
  const memory=await page.evaluate(()=>{const s=styk.editor.drawingResources.stats;return {bytes:s.bytes,levelBytes:s.levelBytes,scratchBytes:s.scratchBytes,gpu:styk.state.renderer.stats.drawingGpuBytes??0};});
  check('tile, mip and scratch caches stay inside their budgets',memory.bytes<=192*1024*1024&&memory.levelBytes<=64*1024*1024&&memory.scratchBytes<=64*1024*1024);
  check('drawing GPU textures stay inside the 96 MiB budget',memory.gpu<=96*1024*1024);
  check('no uncaught browser errors',errors.length===0);
  await writeFile(path.join(output,'render.json'),JSON.stringify({checks,errors,sharpness,memory,playback,browser:await browser.version()},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'failure.json'),JSON.stringify({message:error.message,errors,checks},null,2));throw error;}
finally{await browser.close();}
