import assert from 'node:assert/strict';
import {chromium} from './support/playwright.mjs';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const output='artifacts/image-invalidation'; await mkdir(output,{recursive:true});
await writeFile(`${output}/fixture.html`,'<!doctype html><title>Image invalidation regression</title>');
const root=path.resolve('.'),server=createServer(async(req,res)=>{
  try { const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(root+path.sep))throw new Error('Invalid path');
    res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'text/html');
    res.end(await readFile(file));
  }catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1000,height:600}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/${output}/fixture.html`);
  const result=await page.evaluate(async()=>{
    const {createRenderer}=await import('/src/renderer.mjs');
    const images=new Map(),makeImage=(color,size=16)=>{
      const image=new OffscreenCanvas(size,size);Object.assign(image,{complete:true,naturalWidth:16,naturalHeight:16});
      const ctx=image.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,size,size);return image;
    };
    images.set('a',makeImage('#e03010'));
    for(let slot=1;slot<120;slot++)images.set(`b${slot}`,makeImage(`rgb(16,${80+slot%50},${170+slot%60})`));
    const make=async()=>{const canvas=document.createElement('canvas');document.body.append(canvas);
      const renderer=await createRenderer(canvas,{resources:{url:asset=>asset.asset_url,image:url=>images.get(url)}});
      if(!renderer.device)throw new Error('WebGPU is required for this regression.');renderer.resize(480,240,1);return {canvas,renderer};};
    const actual=await make(),control=await make();
    const fig={figure_type_id:1,segments:[],polyfills:[]},objects=[];
    for(let slot=0;slot<120;slot++){
      const x=8+slot%24*19,y=8+Math.floor(slot/24)*38,obj={unique_id:slot+1,object_slot:slot,figure_type_id:1,root_x:x,root_y:y,scale:1,field28:0};
      const asset={asset_url:slot===0?'a':`b${slot}`,anchor_start:{x:0,y:0},anchor_angle_rad:0,anchor_length:16};
      const item={type:'image',obj,fig,slot,index:0,asset,seg:{},start:{x,y},end:{x:x+16,y},angle:0,length:16,thickness:0,alpha:1,opacity:1,rgb:[255,255,255]};
      objects.push({obj,fig,slot,root:{x,y},segments:[],polys:[],drawables:[item]});
    }
    const report={version:5,canvas_width:480,canvas_height:240,figure_types:[fig],backgrounds:[]};
    const frame={objects:objects.map(g=>g.obj),background_id:0},geometry={objects:new Map(objects.map(g=>[g.slot,g])),orderedObjects:objects,token:{},warnings:[]};
    const options={report,frame,geometry,view:{scale:1,x:0,y:0},cameraEnabled:false};
    const surface=new OffscreenCanvas(480,240),ctx=surface.getContext('2d',{willReadFrequently:true}),observations=[];let lastPixels;
    const pixels=target=>{ctx.clearRect(0,0,480,240);ctx.drawImage(target.canvas,0,0);return ctx.getImageData(0,0,480,240).data;};
    const fullInvalidate=renderer=>{renderer.generation++;renderer.lastGeometry=null;renderer.clearPreparedFrames();
      for(const entry of renderer.backgroundImages?.values()??[])entry.texture.destroy();renderer.backgroundImages?.clear();renderer.backgroundKey='';};
    const check=async name=>{
      actual.renderer.render(options);const a=pixels(actual);
      control.renderer.render(options);const b=pixels(control);lastPixels=a;
      await Promise.all([actual.renderer.device.queue.onSubmittedWorkDone(),control.renderer.device.queue.onSubmittedWorkDone()]);
      let differences=0;
      for(let i=0;i<a.length;i++)if(a[i]!==b[i])differences++;
      if(differences)throw new Error(`${name}: ${differences} pixel-channel mismatches`);
      if(!a.some((v,i)=>i%4!==3&&v!==255))throw new Error('Empty fixture');
      observations.push({name,differences,rasterized:actual.renderer.stats.rasterizedObjects,controlRasterized:control.renderer.stats.rasterizedObjects});
    };
    try {
      await check('initial');const original=lastPixels.slice();
      images.set('a',makeImage('#30d050'));actual.renderer.invalidateImages(['a']);fullInvalidate(control.renderer);
      await check('replace one image');
      if(observations.at(-1).rasterized!==1||observations.at(-1).controlRasterized!==120)throw new Error('Independent textures were rebuilt');
      if(lastPixels.every((v,i)=>v===original[i]))throw new Error('Replacement pixels did not appear');
      images.set('a',makeImage('#b030d0',32));actual.renderer.invalidateImages(['a']);fullInvalidate(control.renderer);await check('resize decoded variant');
      images.delete('a');actual.renderer.invalidateImages(['a']);fullInvalidate(control.renderer);await check('remove image');
      images.set('a',makeImage('#30d050'));actual.renderer.invalidateImages(['a']);fullInvalidate(control.renderer);await check('restore image');
      // A background has a separate texture owner, even when artwork shares its URL.
      report.backgrounds=[{background_id:1,kind:1,asset_url:'a'}];frame.background_id=1;
      await check('background sharing image');images.set('a',makeImage('#dd7030'));
      actual.renderer.invalidateImages(['a']);fullInvalidate(control.renderer);await check('shared background replacement');
      frame.background_id=0;
      const next={...geometry,token:{}},staged=await actual.renderer.prepareSceneUpdate({...options,geometry:next});
      actual.renderer.invalidateImages(['a']);let cancelled=false;
      try{staged.activate();}catch(error){cancelled=error.name==='AbortError';}finally{staged.dispose();}
      if(!cancelled)throw new Error('Stale prepared scene was published');
      fullInvalidate(control.renderer);await check('cancel staged scene');
      let interrupted=false;
      try { await actual.renderer.prepareSceneUpdate({...options,geometry:next,sliceMs:.0001,yieldControl:async()=>{actual.renderer.invalidateImages(['a']);}}); }
      catch(error){interrupted=error.name==='AbortError';}
      if(!interrupted||actual.renderer.rasterCache.leases.size)throw new Error('Interrupted preparation retained its lease');
      fullInvalidate(control.renderer);await check('image arrival during cooperative preparation');
      const ghosts=objects.map(g=>{const obj={...g.obj,root_y:g.obj.root_y+20};return {...g,obj,root:{x:g.root.x,y:g.root.y+20},drawables:g.drawables.map(item=>({...item,obj,start:{x:item.start.x,y:item.start.y+20},end:{x:item.end.x,y:item.end.y+20}}))};});
      options.onionFrames=[{frame:{...frame,objects:ghosts.map(g=>g.obj)},geometry:{...geometry,token:{},objects:new Map(ghosts.map(g=>[g.slot,g])),orderedObjects:ghosts},opacity:.4}];
      await check('image onion skins');images.set('a',makeImage('#e040a0'));actual.renderer.invalidateImages(['a']);fullInvalidate(control.renderer);
      await check('image replacement updates onion composites');options.onionFrames=[];
      const timings={selective:[],full:[]};
      for(let iteration=0;iteration<24;iteration++){
        images.set('a',makeImage(iteration%2?'#3080f0':'#f08030'));
        for(const name of iteration%2?['full','selective']:['selective','full']){
          const renderer=name==='selective'?actual.renderer:control.renderer,start=performance.now();
          if(name==='selective')renderer.invalidateImages(['a']);else fullInvalidate(renderer);
          renderer.render(options);await renderer.device.queue.onSubmittedWorkDone();timings[name].push(performance.now()-start);
        }
      }
      await check('final measured pixels');
      for(const renderer of [actual.renderer,control.renderer]){
        renderer.rasterCache.maxBytes=0;renderer.rasterCache.retain(new Set(),renderer.generation);renderer.lastGeometry=null;
      }
      await check('eviction and regeneration');
      return {observations,timings,adapter:actual.renderer.stats.backend,retainedBytes:actual.renderer.rasterCache.bytes};
    }finally{
      for(const target of [actual,control]){const snapshot=document.createElement('canvas');snapshot.width=480;snapshot.height=240;
        if(lastPixels)snapshot.getContext('2d').putImageData(new ImageData(lastPixels,480,240),0,0);
        target.canvas.replaceWith(snapshot);target.renderer.destroy();}
    }
  });
  assert.deepEqual(errors,[]);
  const sourceHashes={};for(const name of ['src/renderer.mjs','src/renderer-raster-cache.mjs','src/preview-images.mjs','src/app.mjs'])
    sourceHashes[name]=createHash('sha256').update(await readFile(name)).digest('hex');
  await page.screenshot({path:`${output}/comparison.png`});
  await writeFile(`${output}/report.json`,JSON.stringify({node:process.version,sourceHashes,...result},null,2));
  console.log(JSON.stringify(result));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
