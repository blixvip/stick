import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.STYK_TEST_URL||'http://127.0.0.1:47832');await page.waitForFunction(()=>window.styk?.ready);
 const result=await page.evaluate(async()=>{
  const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
  const {createVfx}=await import('/src/vfx.mjs');
  const {drawExportScene,drawExportSceneTiled,exportFrameGeometry}=await import('/src/export-frame-core.mjs');
  const {drawParallaxGeometry}=await import('/src/parallax-draw.mjs');
  const {parallaxResolver}=await import('/src/layer-parallax.mjs');
  const {drawBackground,backgroundBounds}=await import('/src/pivot/background.mjs');
  const {cameraMatrix}=await import('/src/renderer-geometry.mjs');
  const {releaseGeometryResources}=await import('/src/pivot/geometry.mjs');
  const {VfxGPU,releaseVfxGPU}=await import('/src/vfx-gpu.mjs');
  const {ExportFrameRenderer}=await import('/src/export-frame-renderer.mjs');
  const {createRenderer}=await import('/src/renderer.mjs');
  const effect=(type,params={})=>{const fx=createVfx(type,type);Object.assign(fx.params,params);return fx;};
  const shock=()=>effect('shockwave',{radius:95,thickness:90,strength:128});
  const pixels=canvas=>{const c=new OffscreenCanvas(canvas.width,canvas.height).getContext('2d');c.drawImage(canvas,0,0);return c.getImageData(0,0,canvas.width,canvas.height).data;};
  // Compare visible premultiplied color; unpremultiplication at alpha 1 can
  // amplify a one-byte raster rounding difference to 255 in invisible RGB.
  const diff=(a,b)=>{let max=0,total=0;for(let i=0;i<a.length;i++){const alpha=(i|3),d=i%4===3?Math.abs(a[i]-b[i]):Math.abs(a[i]*a[alpha]-b[i]*b[alpha])/255;max=Math.max(max,d);total+=d;}return {max,mean:total/a.length};};
  const png=async canvas=>Array.from(new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer()));
  const copy=canvas=>{const out=new OffscreenCanvas(canvas.width,canvas.height);out.getContext('2d').drawImage(canvas,0,0);return out;};
  function fixture(camera,transparent=false){
   const report=emptyDocument();report.canvas_width=320;report.canvas_height=240;
   const fig=report.figure_types[0],base=fig.segments[0];
   fig.segments=[{...base,segment_id:1,parent_id:0,length:900,angle_rad:0,thickness:18,color_rgb:[30,160,220]}];fig.segment_count=1;
   const objects=[];
   for(let i=0;i<33;i++)objects.push(createObject(fig,i+1,-300,-300+i*28));
   const frame=createFrame(objects,4);if(camera)frame.camera=camera;
   if(transparent)frame._stykBackgroundColor=0;
   report.keyframes=[frame];return {report,frame};
  }
  // Independent oracle: deliberately oversized world painting followed by one
  // filter and a final crop. It never calls the production scene/tile planner.
  function reference(report,frame,geometry,width=320,height=240,clipped=false,resources={}){
   const margin=512,s=width/report.canvas_width,source=new OffscreenCanvas(width+2*margin,height+2*margin),ctx=source.getContext('2d');
   ctx.translate(margin,margin);ctx.scale(s,s);
   if(clipped){ctx.beginPath();ctx.rect(0,0,report.canvas_width,report.canvas_height);ctx.clip();}
   ctx.transform(...cameraMatrix({report,frame}));
   drawBackground(ctx,report,frame,report.canvas_width,report.canvas_height,{...resources,bounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,true,report,{x:-margin/s,y:-margin/s,width:(width+2*margin)/s,height:(height+2*margin)/s}),paintBounds:backgroundBounds(frame,report.canvas_width,report.canvas_height,true,report)});
   drawParallaxGeometry(ctx,geometry,resources,parallaxResolver(report,frame));
   const gpu=new VfxGPU();
   try{const filtered=gpu.run(source,frame._stykVfx.figure,{scale:s,origin:{x:-margin,y:-margin},outputSize:{width,height}}),out=new OffscreenCanvas(width,height);out.getContext('2d').drawImage(filtered,-margin,-margin);return out;}
   finally{gpu.destroy();releaseGeometryResources(ctx);}
  }
  const rows=[],images={};
  const variants=[['shockwave',[shock()]],['shockwave-negative',[effect('shockwave',{radius:170,thickness:100,strength:-128,centerX:.35,centerY:.6})]],
   ['wave',[effect('wave',{strength:55,angle:37,wavelength:78})]],['turbulence',[effect('turbulence',{amount:65,size:80,evolution:2.3})]],
   ['rgbSplit',[effect('rgbSplit',{amount:50,angle:63})]],...Array.from({length:4},(_,mode)=>['blur-'+mode,[effect('blur',{radius:mode?16:27,mode,angle:47})]]),
   ['bloom',[effect('bloom',{radius:25})]],['pixelate',[effect('pixelate',{size:23,offsetX:7,offsetY:-11})]],
   ['crt',[effect('crt',{curvature:.12,chromatic:3})]],
   ['stack',[effect('blur',{radius:8}),effect('wave',{strength:30,angle:80}),shock(),effect('noise',{amount:.3}),effect('bloom',{radius:12})]],
   ['partial',[{...shock(),params:{...shock().params,effectStrength:.35}}]],
   ['subpixel-blur',Array.from({length:16},(_,i)=>({...effect('blur',{radius:.1}),id:`blur-${i}`}))]];
  for(const camera of [null,{x:43,y:-31,scale:.8,angle_rad:.37}])for(const [name,stack] of variants){
   const {report,frame}=fixture(camera);frame._stykVfx={figure:stack};const geometry=exportFrameGeometry(report,frame);
   const expected=reference(report,frame,geometry),full=new OffscreenCanvas(320,240);drawExportScene(full.getContext('2d'),report,frame,geometry,{});
   const fullDiff=diff(pixels(full),pixels(expected));
   if(fullDiff.max>3)throw new Error(`Overscan oracle ${name}: ${JSON.stringify({camera,fullDiff})}`);
   for(const tileSize of [67,128]){
    const tiled=new OffscreenCanvas(320,240);await drawExportSceneTiled(tiled.getContext('2d'),report,frame,geometry,{preload:async()=>{}},tileSize);
    const difference=diff(pixels(tiled),pixels(expected));rows.push({name,camera:Boolean(camera),tileSize,...difference});
    if(difference.max>3)throw new Error(`Tile sampling ${JSON.stringify(rows.at(-1))}`);
    releaseGeometryResources(tiled.getContext('2d'));
   }
   if(name==='shockwave'&&!camera){
    const before=reference(report,frame,geometry,320,240,true);images.before=await png(before);images.after=await png(full);
    if(diff(pixels(before),pixels(expected)).mean<5)throw new Error('Fixture did not expose the old camera clipping bug');
    const alpha=pixels(full).filter((_,i)=>i%4===3);if(Math.min(...alpha)!==255)throw new Error('Opaque camera gained holes');
   }
   releaseGeometryResources(full.getContext('2d'));
  }
  const backgroundCanvas=document.createElement('canvas');backgroundCanvas.width=16;backgroundCanvas.height=12;
  const bc=backgroundCanvas.getContext('2d');bc.fillStyle='#e65839';bc.fillRect(0,0,16,12);bc.fillStyle='#55d274';bc.fillRect(8,0,8,6);
  const image=new Image();image.src=backgroundCanvas.toDataURL();await image.decode();
  const resources={url:asset=>asset.data_url,image:()=>image,preload:async()=>{}};
  const backgrounds=[{kind:1,data_url:image.src,mime_type:'image/png'},
   {kind:3,x1:0,y1:0,x2:1,y2:1,color_a:0xffee5544,color_b:0xff44aaee},
   {paint:{type:'radial',stops:[{offset:0,color:[220,60,60],opacity:1},{offset:1,color:[60,200,220],opacity:1}]}}];
  for(const [index,background] of backgrounds.entries()){
   const {report,frame}=fixture({x:43,y:-31,scale:.8,angle_rad:.37});report.backgrounds=[{...background,background_id:1}];frame.background_id=1;frame._stykVfx={figure:[shock()]};
   const geometry=exportFrameGeometry(report,frame),expected=reference(report,frame,geometry,320,240,false,resources),full=new OffscreenCanvas(320,240),tiled=new OffscreenCanvas(320,240);
   drawExportScene(full.getContext('2d'),report,frame,geometry,resources);await drawExportSceneTiled(tiled.getContext('2d'),report,frame,geometry,resources,67);
   const fullDiff=diff(pixels(full),pixels(expected)),tileDiff=diff(pixels(tiled),pixels(expected));
   if(fullDiff.max>3||tileDiff.max>3)throw new Error(`Background sampling ${JSON.stringify({index,fullDiff,tileDiff})}`);
   const worker=new ExportFrameRenderer({width:320,height:240});try{await worker.load(report);const workerDiff=diff(pixels(await worker.renderTick(0)),pixels(expected));if(workerDiff.max>3)throw new Error(`Background worker ${JSON.stringify({index,workerDiff})}`);rows.push({background:index,fullDiff,tileDiff,workerDiff});}finally{worker.dispose();}
   releaseGeometryResources(full.getContext('2d'));releaseGeometryResources(tiled.getContext('2d'));
  }
  // Actual worker consumers: bitmap frames, alpha-preserving PNG sequences,
  // native-video PNG input (MP4/AVI), SVG fallback and 2x sprite sampling.
  for(const transparent of [false,true])for(const smoothing of ['edges','sprites','none']){
   const {report,frame}=fixture({x:43,y:-31,scale:.8,angle_rad:.37},transparent);frame._stykVfx={figure:[shock()]};
   const geometry=exportFrameGeometry(report,frame),expected=reference(report,frame,geometry),exporter=new ExportFrameRenderer({width:320,height:240,smoothing});
   try{await exporter.load(report);const output=copy(await exporter.renderTick(0)),native=await exporter.renderNativeTick(0,{preserveAlpha:transparent});
    const bitmap=await createImageBitmap(native.blob),nativeCanvas=copy(bitmap);bitmap.close();
    const bitmapDiff=diff(pixels(output),pixels(expected)),nativeDiff=diff(pixels(output),pixels(nativeCanvas));
    if(smoothing==='edges'&&bitmapDiff.max>3||nativeDiff.max>1)throw new Error(`Worker sampling ${JSON.stringify({transparent,smoothing,bitmapDiff,nativeDiff})}`);
    if(smoothing==='sprites'){
     const {downsampleExportPixels}=await import('/src/export-sampling.mjs');const high=reference(report,frame,geometry,640,480);
     const difference=diff(pixels(output),downsampleExportPixels(pixels(high),320,240));if(difference.max>3)throw new Error(`Supersampling ${JSON.stringify(difference)}`);
    }
    rows.push({worker:true,transparent,smoothing,...(smoothing==='sprites'?{supersampling:true}:{bitmapDiff}),nativeDiff});
    if(!transparent&&smoothing==='edges')images.native=Array.from(new Uint8Array(await native.blob.arrayBuffer()));
    const svg=await exporter.renderSVGTick(0);if(!(await svg.text()).includes('data:image/png'))throw new Error('Missing SVG effect raster');
   }finally{exporter.dispose();}
  }
  for(const forceCanvas2D of [true,false])for(const compatibility of [false,true]){
   const {report,frame}=fixture();frame._stykVfx={figure:[shock()]};
   if(compatibility)for(const obj of frame.objects)obj._stykVfx={figure:[effect('tint',{mix:.5})]};
   const geometry=exportFrameGeometry(report,frame),expected=reference(report,frame,geometry);
   const {ThumbnailRenderer}=await import('/src/thumbnail-renderer.mjs'),{Editor}=await import('/src/editor.mjs');
   const thumbnail=document.createElement('canvas');thumbnail.width=320;thumbnail.height=240;
   const thumbnails=new ThumbnailRenderer(new Editor({demo:false}).load(report));
   try{if(!await thumbnails.renderThumbnail(0,thumbnail))throw new Error('Thumbnail did not render');const difference=diff(pixels(thumbnail),pixels(expected));if(difference.mean>.1)throw new Error(`Thumbnail sampling ${JSON.stringify(difference)}`);rows.push({thumbnail:true,compatibility,difference});}finally{thumbnails.destroy();}
   const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D});renderer.resize(320,240,1);
   try{const options={report,frame,geometry,view:{x:0,y:0,scale:1}};renderer.render(options);const live=pixels(renderer.canvas),difference=diff(live,pixels(expected));
    if(difference.mean>.5)throw new Error(`Preview sampling ${JSON.stringify({forceCanvas2D,difference})}`);
    const worker=new Worker('/src/playback-worker.mjs',{type:'module'});
    try{const packet=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Playback timeout')),15000);worker.onmessage=({data})=>{if(data.type==='loaded')worker.postMessage({type:'prepare',revision:1,ticks:[0]});if(data.type==='packet'){clearTimeout(timer);resolve(data.packet);}if(['error','load-error'].includes(data.type)){clearTimeout(timer);reject(new Error(data.message));}};worker.postMessage({type:'load',report,revision:1,scale:1,gpuIsolation:false,softwareFrames:forceCanvas2D,baseURL:location.origin});});
     if(compatibility&&!packet.compatibility.length)throw new Error('Fixture did not exercise cropped raster playback');
     const key=renderer.prepareFrame(packet,{report,view:options.view});if(!renderer.renderPrepared(key,{report,view:options.view}))throw new Error('Prepared rendering unavailable');
     const prepared=diff(pixels(renderer.canvas),live);if(prepared.mean>.5)throw new Error(`Prepared sampling ${JSON.stringify(prepared)}`);
     for(const item of packet.compatibility)item.bitmap?.close();rows.push({backend:renderer.stats.backend,compatibility,difference,prepared});
    }finally{worker.terminate();}
    if(renderer.stats.warnings?.length)throw new Error(JSON.stringify(renderer.stats.warnings));
   }finally{renderer.destroy();}
  }
  // A large sprite must be decoded/rasterized beyond the camera, including
  // worker packets that deliberately retain cropped compatibility bitmaps.
  {
   const spriteCanvas=document.createElement('canvas');spriteCanvas.width=512;spriteCanvas.height=384;
   const ctx=spriteCanvas.getContext('2d');ctx.fillStyle='#ef9850';ctx.fillRect(0,0,512,384);ctx.fillStyle='#46b2d5';
   for(let y=0;y<384;y+=32)ctx.fillRect(0,y,512,16);
   const sprite=new Image();sprite.src=spriteCanvas.toDataURL();await sprite.decode();
   const {report,frame}=fixture(),fig=report.figure_types[0];
   fig.segments=[{...fig.segments[0],primitive_code:2,segment_kind:'image',segment_type:'image',extra_u16:0,length:960,angle_rad:0,thickness:0}];
   fig.image_assets=[{asset_index:0,data_url:sprite.src,mime_type:'image/png',width:512,height:384,display_width:960,display_height:720,anchor_start:{x:0,y:0},anchor_length:960,anchor_angle_rad:0}];
   report.keyframes=[createFrame([createObject(fig,1,-320,-240)],4)];const pose=report.keyframes[0];pose._stykVfx={figure:[shock()]};
   const geometry=exportFrameGeometry(report,pose),resource={url:a=>a.data_url,image:()=>sprite},expected=reference(report,pose,geometry,320,240,false,resource);
   const exporter=new ExportFrameRenderer({width:320,height:240});
   try{await exporter.load(report);const difference=diff(pixels(await exporter.renderTick(0)),pixels(expected));if(difference.mean>.2)throw new Error(`Sprite export crop ${JSON.stringify(difference)}`);rows.push({spriteExport:true,difference});}finally{exporter.dispose();}
   const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs');
   for(const forceCanvas2D of [false,true]){
    const resourceOwner=new PlaybackResources({baseURL:location.origin,preview:true}),renderer=await createRenderer(document.createElement('canvas'),{resources:resource,forceCanvas2D});renderer.resize(320,240,1);
    try{const packet=await compilePlaybackPacket(report,0,{revision:1,scale:1,softwareFrames:forceCanvas2D,gpuIsolation:false,resources:resourceOwner});
     const key=renderer.prepareFrame(packet,{report});if(!renderer.renderPrepared(key,{report,view:{scale:1}}))throw new Error('Sprite packet did not render');const difference=diff(pixels(renderer.canvas),pixels(expected));if(difference.mean>.2)throw new Error(`Sprite playback crop ${JSON.stringify({forceCanvas2D,difference})}`);
     for(const item of packet.compatibility)item.bitmap?.close();rows.push({spritePlayback:true,backend:renderer.stats.backend,difference});
    }finally{resourceOwner.dispose();renderer.destroy();}
   }
  }
  releaseVfxGPU();return {rows,images};
 });
 assert.deepEqual(errors,[]);await fs.mkdir('artifacts/vfx/camera-sampling',{recursive:true});
 for(const [name,bytes] of Object.entries(result.images))await fs.writeFile(`artifacts/vfx/camera-sampling/${name}.png`,Uint8Array.from(bytes));
 await fs.writeFile('artifacts/vfx/camera-sampling/report.json',JSON.stringify(result.rows,null,2));console.log(JSON.stringify(result.rows,null,2));
}finally{await browser.close();}
