import {_electron as electron,chromium} from './support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output=path.resolve('artifacts/renderer-glyphs');await mkdir(output,{recursive:true});
const source=process.argv[2],desktop=Boolean(source)||process.env.STYK_DESKTOP==='1';
const host=desktop?await electron.launch({args:[process.cwd()],env:{...process.env,STYK_USER_DATA_DIR:path.join(output,'profile')}}):await chromium.launch({channel:'chrome',headless:true});
try {
  const page=desktop?await host.firstWindow():await host.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  if(!desktop)await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  await page.waitForFunction(()=>window.styk?.ready);
  if(source){
    await page.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();styk.editor.markSaved();});
    await page.locator('#file-input').setInputFiles(source);
    await page.waitForFunction(name=>!styk.state.importing&&styk.editor.name===name,path.basename(source,'.piv'),{timeout:180000});
  }
  const result=await page.evaluate(async source=>{
    const {createRenderer}=await import('/src/renderer.mjs'),{createTextFigure}=await import('/src/text-authoring.mjs');
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs'),{buildGeometry,evaluatedFrame,timeline}=await import('/src/pivot/geometry.mjs');
    const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs'),{storedFrameReport}=await import('/src/pivot-frame-draft.mjs');
    const {glyphTextureDescriptor}=await import('/src/renderer-glyphs.mjs');
    const width=1200,height=720,make=async sharedArtwork=>{const c=document.createElement('canvas'),r=await createRenderer(c,{sharedArtwork,editorRasterCache:{maxBytes:512*1024*1024}});r.resize(width,height,1);return r;};
    const actual=await make(true),reference=await make(false),worker=await make(true),resources=new PlaybackResources({preview:true});
    const surface=document.createElement('canvas');surface.width=width;surface.height=height;const ctx=surface.getContext('2d',{willReadFrequently:true});
    const pixels=r=>{ctx.clearRect(0,0,width,height);ctx.drawImage(r.canvas,0,0);return ctx.getImageData(0,0,width,height).data;};
    const compare=(a,b)=>{
      let sum=0,changed=0,max=0,interiorMismatch=0;
      for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);sum+=d;max=Math.max(max,d);if(d>16)changed++;}
      // Raster grids rotate differently. Large channel differences must stay
      // at existing edges, rather than move/fill holes or change solid artwork.
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=(y*width+x)*4;if(![0,1,2,3].some(c=>Math.abs(a[i+c]-b[i+c])>16))continue;
        let edge=false;
        for(let c=0;c<4&&!edge;c++){
          let low=255,high=0;
          for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
            const j=(Math.max(0,Math.min(height-1,y+dy))*width+Math.max(0,Math.min(width-1,x+dx)))*4+c;
            low=Math.min(low,b[j]);high=Math.max(high,b[j]);
          }
          edge=high-low>16;
        }
        if(!edge)interiorMismatch++;
      }
      return {mean:sum/a.length,changedFraction:changed/a.length,max,interiorMismatch};
    };
    const checks=[],images=[];let report=emptyDocument();report.canvas_width=width;report.canvas_height=height;
    const figure=await createTextFigure({text:'O',fontSize:110,color:[40,120,220]});figure.figure_type_id=1;report.figure_types=[figure];
    const draw=async(name,frame,view={scale:1,x:0,y:0},cameraEnabled=false)=>{
      const geometry=buildGeometry(report,frame),options={report,frame,geometry,view,cameraEnabled};
      for(const r of[actual,reference]){await r.prepareBackgrounds(report,frame);r.render(options);await r.device.queue.onSubmittedWorkDone();}
      const a=pixels(actual),b=pixels(reference),comparison=compare(a,b);
      checks.push({name,...comparison,uniqueTextures:actual.stats.uniqueTextures,referenceTextures:reference.stats.uniqueTextures,rasterized:actual.stats.rasterizedObjects,reduced:actual.stats.previewReduced,referenceReduced:reference.stats.previewReduced});
      if(name==='native etched glyphs'){images.push({name:'optimized',data:actual.canvas.toDataURL()},{name:'reference',data:reference.canvas.toDataURL()});}
      return {a,geometry};
    };
    try {
      for(const reverse of[0,1])for(const mirror of[0,1])for(const scale of[1.5,-1.5]){
        const f=structuredClone(figure);f.segments[0].extra_u8_a=reverse;f.segments[0].extra_u8_b=mirror;report.figure_types=[f];
        const obj=createObject(f,1,500,420,{scale,field28:104,angles:[.37],color_override_raw:0xff3bac60});
        report.keyframes=[createFrame([obj])];await draw(`reverse=${reverse}, mirror=${mirror}, scale=${scale}`,report.keyframes[0]);
      }
      report.figure_types=[figure];
      const objects=Array.from({length:6},(_,i)=>createObject(figure,i+1,100+i*150,350,{scale:1,field28:i*30,angles:[i*.1],color_override_raw:(0xff000000|i*35<<16|128<<8|220)>>>0}));
      report.keyframes=[createFrame(objects),createFrame(objects.map(o=>({...o,root_x:o.root_x+5,root_y:o.root_y-4})))];
      await draw('six tinted and rotated copies share a mask',report.keyframes[0]);
      const first=await compilePlaybackPacket(report,0,{resources,cameraEnabled:false}),second=await compilePlaybackPacket(report,1,{resources,cameraEnabled:false});
      try {
        if(first.compatibility.length!==1||second.compatibility.length!==1||second.sharing.rasterCacheMisses)throw new Error('Translated glyph copies did not retain one shared mask.');
        for(const p of[first,second]){await worker.prepareBackgrounds(report,p.frame);worker.prepareFrame(p,{report,cameraEnabled:false});worker.renderPrepared(p.key,{report,view:{scale:1,x:0,y:0},cameraEnabled:false});await worker.device.queue.onSubmittedWorkDone();}
        const uploaded=worker.preparedFrames.stats.textureUploads;
        if(uploaded!==1)throw new Error(`Repeated glyph frames uploaded ${uploaded} textures.`);
        checks.push({name:'worker mask reuse',masks:first.compatibility.length,uploads:uploaded,hits:second.sharing.rasterCacheHits});
        const {a}=await draw('editor and prepared glyph positions',report.keyframes[1]);
        checks.push({name:'editor/prepared pixels',...compare(a,pixels(worker))});
      }finally{for(const p of[first,second])for(const c of p.compatibility)c.bitmap.close();}
      if(source){
        const original=storedFrameReport(styk.editor.report),entries=timeline(original),tick=1810,entry=entries.find(e=>tick>=e.start&&tick<e.start+e.count);
        const frame=evaluatedFrame(original,entry.index,(tick-entry.start)/entry.count,tick);
        report={...original,keyframes:[frame]};
        await draw('native etched glyphs',frame,{scale:1.6,x:120,y:20},true);
        const g=buildGeometry(report,frame);checks.push({name:'native accelerated objects',objects:[...g.objects.values()].filter(g=>glyphTextureDescriptor(g.drawables,2)).length});
        const packet=await compilePlaybackPacket(report,0,{revision:2,resources,scale:2,cameraEnabled:true,maxPacketBytes:256*1024*1024});
        try {
          await worker.prepareBackgrounds(report,packet.frame);worker.prepareFrame(packet,{report,cameraEnabled:true});
          worker.renderPrepared(packet.key,{report,view:{scale:1.6,x:120,y:20},cameraEnabled:true});await worker.device.queue.onSubmittedWorkDone();
          checks.push({name:'native software-worker/editor pixels',...compare(pixels(actual),pixels(worker))});
          images.push({name:'worker',data:worker.canvas.toDataURL()});
        }finally{for(const c of packet.compatibility)c.bitmap.close();}
      }
      // Crossing from a capped object raster to a quantized glyph mask under
      // pressure must count the actual mask allocation at the chosen density.
      report=emptyDocument();report.figure_types=[figure];report.keyframes=[createFrame([.52,.73,100].map((scale,i)=>createObject(figure,i+1,100+i*180,350,{scale})))];
      actual.rasterCache.maxBytes=96*1024;
      actual.render({report,frame:report.keyframes[0],geometry:buildGeometry(report,report.keyframes[0]),view:{scale:1,x:0,y:0},cameraEnabled:false});
      await actual.device.queue.onSubmittedWorkDone();
      if(!actual.stats.previewReduced||actual.rasterCache.stats.activeBytes>actual.rasterCache.maxBytes)throw new Error('Quantized glyph allocations escaped the editable texture budget.');
      checks.push({name:'quantized glyph pressure',bytes:actual.rasterCache.stats.activeBytes,budget:actual.rasterCache.maxBytes});
      return {checks,images,adapter:actual.stats.adapter};
    } finally {resources.dispose();actual.destroy();reference.destroy();worker.destroy();}
  },Boolean(source));
  for(const image of result.images)await writeFile(path.join(output,`${image.name}.png`),Buffer.from(image.data.split(',')[1],'base64'));
  delete result.images;await writeFile(path.join(output,'report.json'),JSON.stringify({...result,errors},null,2));console.log(JSON.stringify(result,null,2));
  assert.deepEqual(errors,[]);
  for(const c of result.checks)if(c.mean!==undefined){assert.ok(c.mean<1.5,`${c.name}: mean pixel error ${c.mean}`);assert.ok(c.interiorMismatch<86,`${c.name}: ${c.interiorMismatch} differences outside existing edges`);assert.ok(!c.reduced&&!c.referenceReduced);}
}finally{await host.close();}
