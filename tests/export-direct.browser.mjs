/** Fused worker PNGs retain canvas pixels, alpha/matte and bounded lifetime. */
import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import backend from '../desktop/backend.cjs';
const output=path.resolve('artifacts/export-direct');await mkdir(output,{recursive:true});
const service=await backend.startBackend({appRoot:process.cwd()});let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(service.origin+'/api/health');
  const result=await page.evaluate(async()=>{
    const {ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
    const {samplingFixture}=await import('/tests/export-sampling-fixture.mjs');
    const checks=[],check=(ok,label)=>{if(!ok)throw new Error(label);checks.push(label);};
    const width=769,height=577;
    const {exportFrameGeometry,exportDrawGroups,exportGroupOutside,drawExportSceneSequential}=await import('/src/export-frame-core.mjs');
    const {PlaybackResources}=await import('/src/playback-resources.mjs');
    for(const kind of ['line','squareLine','circle','curve','outline','poly','text']){
      const report=samplingFixture({kind,opacity:.7,gradient:true}),frame=report.keyframes[0],object=frame.objects[0];
      frame.objects=Array.from({length:30},(_,i)=>({...object,unique_id:i+1,root_x:object.root_x+(i-15)*19}));
      frame.object_draw_order=frame.objects.map((_,i)=>i);frame.object_draw_order_unique_ids=frame.objects.map(o=>o.unique_id);
      const geometry=exportFrameGeometry(report,frame),resources=new PlaybackResources(),groups=exportDrawGroups(geometry,resources);
      const a=new OffscreenCanvas(128,128),b=new OffscreenCanvas(128,128),ca=a.getContext('2d',{willReadFrequently:true}),cb=b.getContext('2d',{willReadFrequently:true});
      let culled=0;
      try{
        for(const x of [0,128,256]){
          const viewport={width:384,height:288,x,y:40};
          await drawExportSceneSequential(ca,report,frame,geometry,resources,viewport,undefined,groups);
          await drawExportSceneSequential(cb,report,frame,geometry,resources,viewport,undefined,groups.map(g=>({...g,bounds:null})));
          const pixels=ca.getImageData(0,0,128,128).data,reference=cb.getImageData(0,0,128,128).data;
          check(pixels.every((v,i)=>v===reference[i]),`${kind}: culled tile ${x} equals full painter order`);
          culled+=groups.filter(g=>exportGroupOutside(g.bounds,{matrix:[3,0,0,3,-x,-40],width:128,height:128})).length;
        }
        check(culled>0,`${kind}: off-tile groups actually skipped`);
      }finally{resources.dispose();a.width=b.width=1;}
    }
    for(const smoothing of ['edges','sprites','none']){
      const report=samplingFixture({kind:'outline',opacity:.7});
      const renderer=new ExportFrameRenderer({width,height,smoothing,maxWorkingBytes:64*1024*1024});
      try{
        await renderer.load(report);
        const native=await renderer.renderNativeTick(0,{preserveAlpha:true});
        check(renderer.canvas.width===1,`${smoothing}: native path allocates no presentation frame`);
        const bitmap=await createImageBitmap(native.blob),surface=new OffscreenCanvas(width,height),ctx=surface.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(bitmap,0,0);bitmap.close();const a=ctx.getImageData(0,0,width,height).data;
        const canvas=await renderer.renderTick(0),b=renderer.context.getImageData(0,0,width,height).data;
        check(a.every((v,i)=>v===b[i]),`${smoothing}: alpha PNG equals independent canvas delivery`);
        ctx.clearRect(0,0,width,height);ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);ctx.drawImage(canvas,0,0);
        const expected=ctx.getImageData(0,0,width,height).data;
        const opaque=await renderer.renderNativeTick(0,{preserveAlpha:false}),black=await createImageBitmap(opaque.blob);
        ctx.clearRect(0,0,width,height);ctx.drawImage(black,0,0);black.close();
        const actual=ctx.getImageData(0,0,width,height).data;
        check(actual.every((v,i)=>v===expected[i]),`${smoothing}: in-place matte equals legacy black canvas`);
        const next=await renderer.renderNativeTick(0,{preserveAlpha:true}),again=await createImageBitmap(next.blob);
        ctx.clearRect(0,0,width,height);ctx.drawImage(again,0,0);again.close();
        check(ctx.getImageData(0,0,width,height).data.every((v,i)=>v===a[i]),`${smoothing}: opaque delivery does not leak into next transparent frame`);
        if(smoothing==='sprites')window.directPNG=canvas.toDataURL();
        surface.width=surface.height=1;
      }finally{renderer.dispose();}
      check(renderer.canvas.width===1,`${smoothing}: disposal releases presentation pixels`);
    }
    return {checks};
  });
  assert.deepEqual(errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify({...result,errors},null,2));
  await writeFile(path.join(output,'sprites.png'),Buffer.from((await page.evaluate(()=>window.directPNG)).split(',')[1],'base64'));
  console.log(JSON.stringify(result));
}finally{await browser?.close();await service.stop();}
