/** Compare the optimized renderer with the pre-change renderer and native
 * Canvas painter. Accepts any PIV and optional ticks; never saves the input. */
import {_electron as electron} from './support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const source=process.argv[2],ticks=process.argv.slice(3).map(Number);
const output=path.resolve('artifacts/renderer-opacity',process.env.STYK_PROBE_LABEL||'current');
await mkdir(output,{recursive:true});
const ref=process.env.STYK_BASELINE_REF||'HEAD',files=new Map();
const app=await electron.launch({args:[process.cwd()],env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}});
try {
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.context().route('**/baseline/**',async route=>{
    const file=new URL(route.request().url()).pathname.split('/baseline/')[1];
    if(!files.has(file))files.set(file,execFileSync('git',['show',`${ref}:${file}`],{maxBuffer:16*1024*1024}));
    await route.fulfill({body:files.get(file),contentType:'text/javascript'});
  });
  await page.waitForFunction(()=>window.styk?.ready);
  if(source){
    await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
    await page.locator('#file-input').setInputFiles(source);
    await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  }
  const result=await page.evaluate(async({source,ticks})=>{
    const {createRenderer,cameraMatrix}=await import('/src/renderer.mjs');
    const {createRenderer:oldRenderer}=await import('/baseline/src/renderer.mjs');
    const oldGeometry=await import('/baseline/src/pivot/geometry.mjs');
    const {buildGeometry,drawGeometry,timeline,evaluatedFrame}=await import('/src/pivot/geometry.mjs');
    const {drawBackground,backgroundBounds}=await import('/src/pivot/background.mjs');
    const {compilePlaybackPacket,PlaybackResources,playbackLocation}=await import('/src/playback-worker.mjs');
    const {RetainedGeometryCache}=await import('/src/playback-geometry-cache.mjs');
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const images=new Map(),resources={url:a=>a?.asset_url||a?.data_url,image:url=>images.get(url)};
    const make=async factory=>factory(document.createElement('canvas'),{resources,editorRasterCache:{maxBytes:512*1024*1024}});
    const actual=await make(createRenderer),reference=await make(oldRenderer),prepared=await make(createRenderer);
    const software=await createRenderer(document.createElement('canvas'),{resources,forceCanvas2D:true});
    const workerResources=new PlaybackResources({preview:true}),cache=new RetainedGeometryCache();
    const checks=[],screens=[];let revision=0;
    const compare=(a,b,width,height)=>{
      let sum=0,max=0,interior=0;
      for(let i=0;i<a.length;i++) {const d=Math.abs(a[i]-b[i]);sum+=d;max=Math.max(max,d);}
      for(let y=2;y<height-2;y++)for(let x=2;x<width-2;x++){
        const i=(y*width+x)*4;if(![0,1,2,3].some(c=>Math.abs(a[i+c]-b[i+c])>16))continue;
        let edge=false;
        for(let dy=-2;dy<=2&&!edge;dy++)for(let dx=-2;dx<=2&&!edge;dx++)for(let c=0;c<4;c++)
          if(Math.abs(b[i+c]-b[((y+dy)*width+x+dx)*4+c])>16){edge=true;break;}
        if(!edge)interior++;
      }
      return {mean:sum/a.length,max,interior,interiorFraction:interior/(width*height)};
    };
    const draw=async(report,tick,name,keep=false)=>{
      const entries=timeline(report),loc=playbackLocation(entries,tick),frame=evaluatedFrame(report,loc.index,loc.t,tick);
      const geometry=cache.get(report,frame,revision),old=oldGeometry.buildGeometry(report,frame);
      const joints=g=>JSON.stringify([...g.objects].map(([slot,g])=>({slot,root:g.root,joints:[...g.joints]})));
      if(joints(geometry)!==joints(old))throw new Error(`Joint geometry changed: ${name}`);
      const scale=Math.min(1,960/report.canvas_width,720/report.canvas_height),width=Math.ceil(report.canvas_width*scale),height=Math.ceil(report.canvas_height*scale),view={x:0,y:0,scale};
      for(const r of[actual,reference,prepared,software])r.resize(width,height,1);
      for(const [r,g] of [[actual,geometry],[reference,old]]){
        await r.prepareBackgrounds(report,frame);r.render({report,frame,geometry:g,view,artworkRevision:revision});await r.device.queue.onSubmittedWorkDone();
      }
      const surface=document.createElement('canvas');surface.width=width;surface.height=height;
      const ctx=surface.getContext('2d',{willReadFrequently:true});
      const pixels=canvas=>{ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,width,height).data;};
      const a=pixels(actual.canvas),b=pixels(reference.canvas);
      const packet=await compilePlaybackPacket(report,tick,{revision,scale,gpuIsolation:true,resources:workerResources,maxTextureDimension:4096,maxPacketBytes:256*1024*1024});
      try {
        await prepared.prepareBackgrounds(report,packet.frame);prepared.prepareFrame(packet,{report,view});
        if(!prepared.renderPrepared(packet.key,{report,view}))throw new Error('Prepared frame missing');
        await prepared.device.queue.onSubmittedWorkDone();
        const p=pixels(prepared.canvas);
        software.render({report,frame,geometry,view});const s=pixels(software.canvas);
        ctx.clearRect(0,0,width,height);ctx.save();ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();ctx.transform(...cameraMatrix({report,frame,view}));
        drawBackground(ctx,report,frame,report.canvas_width,report.canvas_height,{...resources,bounds:backgroundBounds(frame,report.canvas_width,report.canvas_height)});
        drawGeometry(ctx,old,resources);ctx.restore();const c=ctx.getImageData(0,0,width,height).data;
        checks.push({name,tick,baseline:compare(a,b,width,height),canvas:compare(a,c,width,height),software:compare(s,c,width,height),prepared:compare(p,a,width,height),rasters:packet.compatibility.length,vectorRasters:packet.compatibility.filter(e=>e.vectorRaster).length,bytes:packet.byteLength});
        if(keep)screens.push({name,data:actual.canvas.toDataURL()},{name:`${name}-reference`,data:reference.canvas.toDataURL()});
      }finally{for(const item of packet.compatibility)item.bitmap?.close();}
    };
    try {
      const report=emptyDocument();report.canvas_width=640;report.canvas_height=400;
      const segment={segment_id:1,parent_id:0,segment_type:'line',segment_kind:'line',length:140,angle_rad:0,thickness:28,color_rgb:[30,130,210],color_alpha:1};
      const figures=[
        {figure_type_id:1,segments:[segment]},
        {figure_type_id:2,segments:[{...segment,segment_kind:'squareLine',secondary:{rgb:[240,80,40],a:90}}]},
        {figure_type_id:3,segments:[{...segment,segment_type:'circle',segment_kind:'circleFill',length:60}]},
        {figure_type_id:4,segments:[{...segment,segment_type:'circle',segment_kind:'circle',length:60,thickness:8}]},
        {figure_type_id:5,segments:[segment,{...segment,segment_id:2,angle_rad:1.1,color_rgb:[220,50,70]}]},
        {figure_type_id:6,segments:[{...segment,bend_rad:1.2,color_alpha:.5}]}
      ];
      report.figure_types=figures;
      report.keyframes=[32,128,220,255,0,64].map(alpha=>createFrame(figures.map((f,i)=>createObject(f,i+1,40+(i%3)*210,80+Math.floor(i/3)*180,{field28:alpha}))));
      revision++;
      for(let tick=0;tick<report.keyframes.length;tick++)await draw(report,tick,`generated-${tick}`,tick===1);
      if(source){
        const report=styk.editor.report;
        for(const asset of [...report.backgrounds||[],...report.figure_types.flatMap(f=>f.image_assets||[])]){
          const url=resources.url(asset);if(!url||images.has(url))continue;const image=new Image();image.src=url;await image.decode();images.set(url,image);
        }
        revision++;if(!ticks.length)ticks=[0,Math.floor(styk.editor.totalTicks/2),styk.editor.totalTicks-1];
        for(const tick of ticks)await draw(report,tick,`native-${tick}`,true);
      }
      return {checks,screens};
    } finally {actual.destroy();reference.destroy();prepared.destroy();software.destroy();workerResources.dispose();}
  },{source,ticks});
  for(const screen of result.screens)await writeFile(path.join(output,`${screen.name}.png`),Buffer.from(screen.data.split(',')[1],'base64'));
  delete result.screens;
  await writeFile(path.join(output,'report.json'),JSON.stringify({source,ref,...result,errors},null,2));
  console.log(JSON.stringify(result));assert.deepEqual(errors,[]);
  for(const check of result.checks){
    assert.ok(check.baseline.mean<2&&check.baseline.interiorFraction<.001,`${check.name}: baseline pixels`);
    assert.ok(check.canvas.mean<2&&check.canvas.interiorFraction<.001,`${check.name}: Canvas pixels`);
    assert.ok(check.software.mean<2&&check.software.interiorFraction<.001,`${check.name}: compatibility renderer pixels`);
    assert.ok(check.prepared.mean<2&&check.prepared.interiorFraction<.001,`${check.name}: worker/editor pixels`);
  }
} finally {await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
