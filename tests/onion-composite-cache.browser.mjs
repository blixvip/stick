import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from './support/playwright.mjs';
import backend from '../desktop/backend.cjs';

const server=await backend.startBackend({appRoot:process.cwd()});
const browser=await chromium.launch({channel:'chrome',headless:true});
const out='artifacts/onion-composite-cache';await mkdir(out,{recursive:true});
try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.origin);await page.waitForFunction(()=>window.styk?.ready);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const {buildGeometry}=await import('/src/pivot/geometry.mjs');
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {createDrawingFigure,drawingPixelMatrix}=await import('/src/drawing-model.mjs');
    const {DrawingResources}=await import('/src/drawing-resources.mjs');
    const checks=[],gpuErrors=[];
    const require=(value,message)=>{if(!value)throw Error(message);};
    const make=async(forceCanvas2D,extra={})=>{
      const r=await createRenderer(document.createElement('canvas'),{forceCanvas2D,...extra});r.resize(240,180,1);
      r.device?.addEventListener('uncapturederror',e=>gpuErrors.push(e.error.message));return r;
    };
    const pixels=async(r,options)=>{
      r.render(options);await r.device?.queue.onSubmittedWorkDone();
      const bitmap=await createImageBitmap(r.canvas),c=new OffscreenCanvas(r.canvas.width,r.canvas.height),ctx=c.getContext('2d');
      ctx.drawImage(bitmap,0,0);bitmap.close();return ctx.getImageData(0,0,c.width,c.height).data;
    };
    const same=(a,b,label)=>{let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));require(max<=1,`${label}: difference ${max}`);return max;};
    const report=emptyDocument(),red=report.figure_types[0];report.canvas_width=240;report.canvas_height=180;
    red.segments=[{...red.segments[0],segment_id:1,parent_id:0,length:90,angle_rad:0,thickness:35,color_rgb:[230,30,40]}];red.segment_count=1;
    const green=structuredClone(red);green.figure_type_id=2;green.segments[0].color_rgb=[20,180,50];report.figure_types.push(green);
    const frame=createFrame([createObject(green,10,90,90),createObject(green,11,65,55)]);
    const ghosts=[createFrame([createObject(red,1,25,85),createObject(red,2,65,85)]),createFrame([createObject(red,1,25,110)])];
    report.keyframes=[...ghosts,frame];
    const onionFrames=ghosts.map((f,i)=>({frame:f,geometry:buildGeometry(report,f),opacity:i?.25:.5}));
    const base={report,frame,geometry:buildGeometry(report,frame),view:{x:0,y:0,scale:1},cameraEnabled:false,onionFrames};
    for(const forceCanvas2D of [false,true]) {
      const r=await make(forceCanvas2D),fresh=await make(forceCanvas2D,{onionCache:{maxBytes:0}});
      try {
        const verify=async(name,options,expectWarm=true)=>{
          const a=await pixels(r,options),b=await pixels(fresh,options);
          const max=same(a,b,`${r.stats.backend} ${name}`);
          const warm=await pixels(r,options);same(warm,b,`${name} warm`);
          if(expectWarm)require(r.stats.onionRenderedFrames===0,`${name} unnecessarily repainted unchanged ghosts`);
          checks.push({backend:r.stats.backend,name,maxDifference:max});return a;
        };
        await verify('baseline',base);
        await verify('live translation',{...base,dragTranslations:new Map([[10,{x:20,y:15}]])});
        await verify('hidden ghost',{...base,hiddenUids:new Set([2])});
        await verify('visibility restored',base);
        await verify('pan',{...base,view:{x:11,y:-8,scale:1}});
        await verify('zoom',{...base,view:{x:-35,y:-20,scale:1.5}});
        await verify('rotation and flip',{...base,view:{x:200,y:20,scale:1,rotation:.2,flip:true}});
        await verify('opacity',{...base,onionFrames:onionFrames.map(o=>({...o,opacity:.7}))});
        await verify('above live artwork',{...base,onionFrames:onionFrames.map(o=>({...o,showOnTop:true}))});
        await verify('anchored on both sides of live artwork',{...base,onionFrames:onionFrames.map((o,i)=>({...o,beforeUid:i?11:10}))});
        await verify('reverse order',{...base,onionFrames:[...onionFrames].reverse()});
        await verify('remove one ghost',{...base,onionFrames:[onionFrames[0]]});
        await verify('restore ghost count',base);
        const moved=createFrame([createObject(red,1,110,80)]);
        await verify('new committed pose',{...base,onionFrames:[{frame:moved,geometry:buildGeometry(report,moved),opacity:.5}]});
        report._styk={layers:{order:['layer-1'],defaultLayerId:'layer-1',assignments:{},byId:{'layer-1':{parallax:{enabled:true,x:.5,y:.5,reference:{x:0,y:0}}}}}};
        const camera={...frame,camera:{is_default:false,x:30,y:15,scale:1,angle_rad:0}};
        await verify('camera and parallax',{...base,frame:camera,cameraEnabled:true});
        report._styk.layers.byId['layer-1'].parallax.x=1.5;
        await verify('parallax without geometry replacement',{...base,frame:camera,cameraEnabled:true});
        delete report._styk;
        for(const msaa of forceCanvas2D?[1]:[1,4]){
          if(!forceCanvas2D){await r.setMsaa(msaa);await fresh.setMsaa(msaa);}
          r.resize(320,200,1);fresh.resize(320,200,1);await verify(`resize and MSAA ${msaa}`,base);
        }
        await verify('disable',{...base,onionFrames:[]});
        require((r.stats.onionCacheBytes??0)===0&&(r.stats.onionCompositeBytes??0)===0,'Disabled onions retained surfaces');
        await verify('re-enable',base);
        const nextReport=structuredClone(report),nextFrame=nextReport.keyframes.at(-1);
        await verify('replace document',{...base,report:nextReport,frame:nextFrame,geometry:buildGeometry(nextReport,nextFrame),
          onionFrames:nextReport.keyframes.slice(0,-1).map(f=>({frame:f,geometry:buildGeometry(nextReport,f),opacity:.5}))});
      }finally{r.destroy();fresh.destroy();}

      // The old mixed LRU rebuilt all six frames and their object rasters every
      // presentation here: completed viewport frames alone exceed 64 MiB.
      const dense=await make(forceCanvas2D);
      try{
        dense.resize(1360,768,2);
        const six={...base,onionFrames:Array.from({length:6},(_,i)=>({...onionFrames[i%2],opacity:.1+i*.02}))};
        for(let i=0;i<4;i++){
          await pixels(dense,six);
          if(i){require(dense.stats.onionRenderedFrames===0,'High-DPI cache thrashing');require(dense.stats.onionRasterizedObjects===0||!forceCanvas2D,'Object raster cache thrashing');}
        }
        checks.push({backend:dense.stats.backend,name:'six high-DPI ghosts',frames:dense.stats.onionRenderedFrames,
          hits:dense.stats.onionFrameHits,cacheBytes:dense.stats.onionCacheBytes,compositeBytes:dense.stats.onionCompositeBytes});
      }finally{dense.destroy();}

      const limited=await make(forceCanvas2D,{onionCache:{maxBytes:240*180*4*2}});
      const uncached=await make(forceCanvas2D,{onionCache:{maxBytes:0}});
      try{
        const live=createFrame(Array.from({length:5},(_,i)=>createObject(green,10+i,40+i*25,50+i*15)));
        const split={...base,frame:live,geometry:buildGeometry(report,live),onionFrames:Array.from({length:5},(_,i)=>
          ({...onionFrames[i%2],beforeUid:10+i}))};
        await pixels(limited,split);
        for(let i=0;i<3;i++){
          same(await pixels(limited,split),await pixels(uncached,split),'small-budget anchored layers');
          const cache=limited.onionComposite?.cache??limited.onionLayers;
          require(cache.bytes<=cache.maxBytes,'Layer cache exceeded its budget');
          require(limited.stats.onionFrameHits>0&&limited.stats.onionRenderedFrames===5-cache.entries.size,'Admission thrashed within one presentation');
        }
        checks.push({backend:limited.stats.backend,name:'small-budget anchored layers',hits:limited.stats.onionFrameHits,frames:limited.stats.onionRenderedFrames});
      }finally{limited.destroy();uncached.destroy();}

      // Drawing pixels can change while the immutable geometry identity stays.
      const drawing=createDrawingFigure(),doc=emptyDocument();doc.figure_types=[drawing];
      const cel=createFrame([createObject(drawing,1,0,0)]),blank=createFrame([]);doc.keyframes=[cel,blank];
      const owner=new DrawingResources(doc),surface=await owner.surface(drawing);
      const drawingRenderer=await make(forceCanvas2D,{resources:{drawing:f=>owner.presenter(f)}});
      try{
        const geometry=buildGeometry(doc,cel),m=drawingPixelMatrix(geometry.drawables[0]);
        const opts={report:doc,frame:blank,geometry:buildGeometry(doc,blank),cameraEnabled:false,clipToCanvas:false,
          view:{x:40-m[4],y:40-m[5],scale:1},onionFrames:[{frame:cel,geometry,opacity:.5}]};
        const sample=data=>Array.from(data.slice((60*240+60)*4,(60*240+60)*4+4));
        surface.store.set(0,0,new Uint8ClampedArray([30,60,220,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
        const before=sample(await pixels(drawingRenderer,opts));
        await pixels(drawingRenderer,opts);require(drawingRenderer.stats.onionRenderedFrames===0,'Drawing ghost not cached');
        surface.store.set(0,0,new Uint8ClampedArray([220,30,60,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
        const after=sample(await pixels(drawingRenderer,opts));
        require(before.join()!==after.join(),'Drawing pixels stayed stale');require(drawingRenderer.stats.onionRenderedFrames===1,'Drawing stamp did not invalidate onion');
        checks.push({backend:drawingRenderer.stats.backend,name:'live drawing pixels',before,after});
      }finally{drawingRenderer.destroy();owner.dispose();}
    }
    return {checks,gpuErrors};
  });
  assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[]);
  await writeFile(`${out}/report.json`,JSON.stringify({...result,errors},null,2));
  console.log(`PASS ${result.checks.length} onion cache checks: warm pixels, painter order, transforms, parallax, opacity, history inputs, drawing pixels, high DPI, resize, MSAA and release`);
}finally{await browser.close();server.stop();}
