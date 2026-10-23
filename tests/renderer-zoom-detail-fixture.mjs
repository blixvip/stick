import {samplingFixture} from './export-sampling-fixture.mjs';
import {emptyDocument,createObject,createFrame,defaultFigure} from '../src/demo.mjs';
import {buildGeometry,drawGeometry} from '../src/pivot/geometry.mjs';
import {cameraMatrix,objectBounds,rasterResolution} from '../src/renderer-geometry.mjs';

const check=(condition,message)=>{if(!condition)throw Error(message);};
const summary=values=>{const a=[...values].sort((a,b)=>a-b);return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
const retainedBytes=r=>r.rasterCache?.bytes??r.artworkBytes??0;
const noNewRaster=(r,previous)=>r.device?(r.stats.rasterizedObjects??0)===0:(r.stats.rasterizedObjects??0)===previous;
function reference(report,frame,geometry,view,width,height,dpr,cameraEnabled=false){
  const canvas=document.createElement('canvas');canvas.width=width*dpr;canvas.height=height*dpr;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),m=cameraMatrix({report,frame,view,cameraEnabled});
  ctx.setTransform(...m.map(n=>n*dpr));drawGeometry(ctx,geometry);
  return canvas;
}

export async function zoomDetailState({forceCanvas2D=false}={}){
  const {createRenderer}=await import('../src/renderer.mjs'),{createVfx}=await import('../src/vfx.mjs');
  const {compilePlaybackPacket,PlaybackResources}=await import('../src/playback-worker.mjs');
  const checks=[],rows=[],errors=[],renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D,editorRasterCache:{maxBytes:32*1024*1024}});
  const verify=(condition,message)=>{check(condition,message);checks.push(message);};
  renderer.device?.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const width=384,height=256;renderer.resize(width,height,1);
  try{
    for(const kind of ['outline','text','opacity','shadow'])for(const flip of [false,true]){
      const report=samplingFixture({kind:kind==='text'?'text':'outline'}),figure=report.figure_types[0],frame=report.keyframes[0];
      for(let i=2;i<=4;i++)figure.segments.push({...figure.segments[0],segment_id:i,length:5,angle_rad:2+i*.2});
      if(kind==='opacity')frame.objects[0].field28=55;
      if(kind==='shadow'){
        const effect=createVfx('shadow','crop-shadow');Object.assign(effect.params,{radius:.4,offsetX:1,offsetY:.5,opacity:.7});
        frame.objects[0]._stykVfx={figure:[effect]};
      }
      frame.camera={is_default:false,x:0,y:0,scale:.25,angle_rad:.23};
      const geometry=buildGeometry(report,frame),item=geometry.drawables[0],dx=item.end.x-item.start.x,dy=item.end.y-item.start.y,len=Math.hypot(dx,dy);
      const target=kind==='text'?item.start:{x:item.start.x+dx*.45-dy/len*item.thickness*.5,y:item.start.y+dy*.45+dx/len*item.thickness*.5};
      const view={scale:8,rotation:.37,flip,x:0,y:0},m=cameraMatrix({report,frame,view});
      view.x=width/2-(m[0]*target.x+m[2]*target.y+m[4])+.31;view.y=height/2-(m[1]*target.x+m[3]*target.y+m[5])+.27;
      const options={report,frame,geometry,view,cameraEnabled:true,clipToCanvas:false,editorBackgroundColor:0x00ffffff};
      renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();
      let expected=reference(report,frame,geometry,view,width,height,1,true);
      if(kind==='shadow'){
        // Object effects are painted in artwork axes before camera rotation.
        // Compare the crop with that complete native raster at the same density;
        // directly filtering rotated screen pixels uses different shadow axes.
        const bounds=objectBounds(geometry.drawables,renderer.resources),density=rasterResolution(32);
        const full=new OffscreenCanvas(Math.ceil(bounds.width*density),Math.ceil(bounds.height*density)),ctx=full.getContext('2d');
        ctx.setTransform(density,0,0,density,-bounds.x*density,-bounds.y*density);drawGeometry(ctx,geometry,renderer.resources);
        expected=document.createElement('canvas');expected.width=width;expected.height=height;
        const out=expected.getContext('2d');out.setTransform(...cameraMatrix(options));out.drawImage(full,bounds.x,bounds.y,full.width/density,full.height/density);
      }
      const diff=difference(read(renderer.canvas),read(expected));
      verify(diff.visible>100&&diff.mean<1,`${kind}: native camera, view rotation and mirror preserve zoomed coverage (${diff.mean.toFixed(3)})`);
      rows.push({kind,flip,backend:renderer.stats.backend,diff});
      if(kind==='text'&&!flip){
        options.view={...view,x:view.x+10000};renderer.render(options);
        verify(difference(read(renderer.canvas),new Uint8ClampedArray(width*height*4)).visible===0,'Fully off-screen artwork paints no stale pixels');
        // Translation in document coordinates follows both camera rotations;
        // use the inverse matrix to return exactly to the inspected viewport.
        const det=m[0]*m[3]-m[1]*m[2];options.dragTranslations=new Map([[1,{x:-10000*m[3]/det,y:10000*m[1]/det}]]);renderer.render(options);
        await renderer.device?.queue.onSubmittedWorkDone();
        verify(difference(read(renderer.canvas),read(expected)).mean<1,'Dragging a culled figure back into view admits its crop');
        options.dragTranslations=undefined;renderer.render(options);
        verify(difference(read(renderer.canvas),new Uint8ClampedArray(width*height*4)).visible===0,'Releasing the drag discards pixels outside the viewport');
        options.view=view;renderer.render(options);
        if(renderer.device){
          const incoming=structuredClone(report),liveBuffer=renderer.shapeBuffer;
          const initial=await renderer.prepareInitialScene({...options,report:incoming,frame:incoming.keyframes[0],geometry:undefined,sliceMs:.05});
          verify(renderer.shapeBuffer===liveBuffer,'Preparing an incoming zoomed scene leaves the live scene intact');
          renderer.activatePreparedScene(initial);
          const initialBuffer=renderer.shapeBuffer;
          renderer.render({...options,report:incoming,frame:incoming.keyframes[0],geometry:initial.geometry});
          await renderer.device.queue.onSubmittedWorkDone();
          verify(renderer.stats.preparation==='retained'&&renderer.stats.compiledObjects===0&&renderer.stats.uploadBytes===0&&difference(read(renderer.canvas),read(expected)).mean<1,'First zoomed presentation uses complete staged crops without recompilation');
          initial.dispose();verify(renderer.shapeBuffer===initialBuffer,'Published crop buffers survive disposal of their staging handle');
          renderer.render(options);
          let stagedView={...view};const oldBuffer=renderer.shapeBuffer;
          const prepared=await renderer.prepareSceneUpdate({...options,getView:()=>stagedView,sliceMs:.05});
          stagedView={...view,x:view.x+300};let stale=false;
          try{prepared.activate();}catch(error){stale=error.name==='AbortError';}finally{prepared.dispose();}
          verify(stale&&renderer.shapeBuffer===oldBuffer&&!oldBuffer.destroyed,'A stale cropped scene cannot replace the live layout');
          let cancelled=false,currentChecks=0;
          try{await renderer.prepareSceneUpdate({...options,sliceMs:.01,checkCurrent:()=>++currentChecks<4});}
          catch(error){cancelled=error.name==='AbortError';}
          verify(cancelled&&renderer.rasterCache.leases.size===0&&renderer.shapeBuffer===oldBuffer,'Cancellation releases crop leases and preserves the live buffers');
        }
      }
    }
    for(const kind of ['circle','circleFill'])for(const length of [49.3,-49.3]){
      const report=samplingFixture({kind}),figure=report.figure_types[0],frame=report.keyframes[0];
      figure.segments[0].length=length;
      figure.segment_decode={global_style:{u28:new Uint32Array(new Float32Array([3]).buffer)[0],rgb:[220,40,20],u30:0}};
      const geometry=buildGeometry(report,frame),item=geometry.drawables[0],target={x:(item.start.x+item.end.x)/2+Math.abs(length)/2+item.thickness/2,y:(item.start.y+item.end.y)/2};
      const view={scale:32,x:width/2-target.x*32+.31,y:height/2-target.y*32+.27},options={report,frame,geometry,view,cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff};
      renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();
      const expected=reference(report,frame,geometry,view,width,height,1),diff=difference(read(renderer.canvas),read(expected));
      verify(diff.visible>100&&diff.mean<1,`${kind} with signed length ${length}: zoomed outline retains native coverage (${diff.mean.toFixed(3)})`);
      rows.push({kind,length,backend:renderer.stats.backend,diff});
      if(renderer.device){
        verify(renderer.stats.outlinedVectorObjects===1&&renderer.stats.textureObjects===0,'Opaque native outlines stay vector sharp through high zoom');
        const low={scale:2,x:width/2-target.x*2+.31,y:height/2-target.y*2+.27};renderer.render({...options,view:low});
        verify(renderer.stats.outlinedVectorObjects===0&&renderer.stats.textureObjects===1,'Returning to ordinary zoom restores its established raster path');
        renderer.render(options);verify(renderer.stats.textureObjects===0&&renderer.stats.rasterizedObjects===0,'Returning to vector zoom reuses compiled outline records');
        if(kind==='circle'&&length>0){
          let views=0;
          const staged=await renderer.prepareSceneUpdate({...options,getView:()=>++views===1?view:low,sliceMs:.01});
          staged.activate();renderer.render({...options,view:low});
          verify(renderer.stats.preparation==='retained'&&renderer.stats.outlinedVectorObjects===0&&renderer.stats.compiledObjects===0&&renderer.stats.uploadBytes===0,'A staged edit crossing back to ordinary zoom publishes its final painter before the first draw');
          staged.dispose();renderer.render(options);
          const incoming=structuredClone(report);views=0;
          const initial=await renderer.prepareInitialScene({...options,report:incoming,frame:incoming.keyframes[0],geometry:undefined,getView:()=>++views===1?view:low,sliceMs:.01});
          renderer.activatePreparedScene(initial);renderer.render({...options,report:incoming,frame:incoming.keyframes[0],geometry:initial.geometry,view:low});
          verify(renderer.stats.preparation==='retained'&&renderer.stats.outlinedVectorObjects===0&&renderer.stats.compiledObjects===0&&renderer.stats.uploadBytes===0,'An incoming scene crossing back to ordinary zoom is complete before publication');
          initial.dispose();renderer.render(options);
        }
      }
    }
    if(renderer.device){
      const thin=samplingFixture({kind:'outline'}),thinFrame=thin.keyframes[0];
      thin.figure_types[0].segments[0].thickness=.1;
      const thinGeometry=buildGeometry(thin,thinFrame),item=thinGeometry.drawables[0],target={x:(item.start.x+item.end.x)/2,y:(item.start.y+item.end.y)/2};
      for(const scale of [32,9,32]){
        const view={scale,x:width/2-target.x*scale+.31,y:height/2-target.y*scale+.27},options={report:thin,frame:thinFrame,geometry:thinGeometry,view,cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff};
        renderer.render(options);await renderer.device.queue.onSubmittedWorkDone();
        const expected=reference(thin,thinFrame,thinGeometry,view,width,height,1);
        verify(renderer.stats.outlinedVectorObjects===0&&renderer.stats.textureObjects===1&&difference(read(renderer.canvas),read(expected)).mean<1,'A thin native outline keeps native coverage while zooming down within the high-zoom range');
      }
      renderer.rasterCache.maxBytes=2*1024*1024;
      const report=samplingFixture({kind:'outline'}),base=report.figure_types[0];
      base.segment_decode.global_style.u30=80;
      report.figure_types=Array.from({length:12},(_,i)=>{const f=structuredClone(base);f.figure_type_id=i+1;f.segments[0].color_rgb=[20+i*15,40,180];return f;});
      const frame=createFrame(report.figure_types.map((f,i)=>createObject(f,i+1,i?300:30,30)));
      report.keyframes=[frame];const geometry=buildGeometry(report,frame),options={report,frame,geometry,view:{scale:32,x:-40*32,y:-30*32},cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff};
      renderer.render(options);options.view={...options.view,x:options.view.x-270*32};renderer.render(options);
      verify(renderer.rasterCache.stats.activeBytes<=2*1024*1024&&renderer.stats.previewReduced,'Panning into dense artwork replans detail within the existing allocation');
      options.view={...options.view,x:options.view.x+270*32};renderer.render(options);
      options.dragTranslations=new Map(frame.objects.slice(1).map(obj=>[obj.unique_id,{x:-270,y:0}]));renderer.render(options);
      verify(renderer.rasterCache.stats.activeBytes<=2*1024*1024,'Dragging many culled figures into view keeps the active allocation bounded');
      const resources=new PlaybackResources({preview:true});
      try{
        const native=samplingFixture({kind:'outline'});native.canvas_width=width;native.canvas_height=height;
        native.keyframes[0].camera={is_default:false,x:-130,y:-90,scale:1/32,angle_rad:.19};
        const packet=await compilePlaybackPacket(native,0,{resources,revision:1,maxPacketBytes:8*1024*1024,maxTextureDimension:4096});
        try{
          verify(packet.resolution===32&&packet.compatibility.length>0,'Worker preparation keeps native camera density beyond 8x');
          verify(packet.compatibility.every(entry=>entry.bitmap?.width<=4096&&entry.bitmap?.height<=4096)&&packet.byteLength<=8*1024*1024,'Zoomed worker crops obey texture and packet limits');
          const opts={report:native,frame:packet.frame,view:{scale:1},cameraEnabled:true,editorBackgroundColor:0x00ffffff};
          renderer.prepareFrame(packet,opts);verify(renderer.renderPrepared(packet.key,opts),'A cropped zoomed packet can be presented');
          await renderer.device.queue.onSubmittedWorkDone();
          verify(difference(read(renderer.canvas),new Uint8ClampedArray(width*height*4)).visible>100,'The prepared camera crop retains visible artwork');
        }finally{for(const entry of packet.compatibility)entry.bitmap?.close();renderer.clearPreparedFrames();}
      }finally{resources.dispose();}
    }
    verify(!errors.length,'Crop invalidation and disposal produce no GPU validation errors');
    return {checks,rows,errors};
  }finally{renderer.destroy();}
}
function read(canvas){const copy=new OffscreenCanvas(canvas.width,canvas.height),ctx=copy.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,copy.width,copy.height).data;}
function difference(actual,expected){let sum=0,partial=0,visible=0;for(let i=0;i<actual.length;i++){sum+=Math.abs(actual[i]-expected[i]);if(i%4===3){partial+=Number(actual[i]>0&&actual[i]<255);visible+=Number(actual[i]>0);}}return {mean:sum/actual.length,partial,visible};}

/** Runs in the collaborative preview or the standalone regression driver.
 * Baseline modules are an exact source snapshot served under a separate URL. */
export async function zoomDetailQuality({baseline='/tmp/zoom-detail-baseline',forceCanvas2D=false,scales=[16,32,100],dprs=[1,2]}={}){
  const current=await import('../src/renderer.mjs'),old=baseline?await import(`${baseline}/src/renderer.mjs`):null;
  const checks=[],rows=[],images=[],errors=[];
  const renderer=await current.createRenderer(document.createElement('canvas'),{forceCanvas2D,editorRasterCache:{maxBytes:32*1024*1024}});
  const before=old&&await old.createRenderer(document.createElement('canvas'),{forceCanvas2D,editorRasterCache:{maxBytes:32*1024*1024}});
  renderer.device?.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const verify=(condition,message)=>{check(condition,message);checks.push(message);};
  try{
    for(const kind of ['outline','text'])for(const dpr of dprs)for(const scale of scales){
      const report=samplingFixture({kind});
      // Compatibility mode caches groups with four or more primitives. Extra
      // short branches exercise that path without covering the inspected edge.
      if(kind==='outline')for(let i=2;i<=4;i++)report.figure_types[0].segments.push({...report.figure_types[0].segments[0],segment_id:i,length:5,angle_rad:2+i*.2});
      const frame=report.keyframes[0];if(kind==='outline')frame.objects=[createObject(report.figure_types[0],1,30.3,30.7)];
      const geometry=buildGeometry(report,frame),item=geometry.drawables[0],width=384,height=256;
      const dx=item.end.x-item.start.x,dy=item.end.y-item.start.y,len=Math.hypot(dx,dy);
      const target=kind==='text'?item.start:{x:item.start.x+dx*.45-dy/len*item.thickness*.5,y:item.start.y+dy*.45+dx/len*item.thickness*.5};
      const view={scale,x:width/2-target.x*scale+.31,y:height/2-target.y*scale+.27};
      const options={report,frame,geometry,view,cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff};
      renderer.resize(width,height,dpr);before?.resize(width,height,dpr);
      const expected=reference(report,frame,geometry,view,width,height,dpr),wanted=read(expected);
      renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();
      const actual=difference(read(renderer.canvas),wanted),previous=before?(before.render(options),await before.device?.queue.onSubmittedWorkDone(),difference(read(before.canvas),wanted)):null;
      verify(actual.visible>100,`${kind} ${scale}x DPR ${dpr} paints the inspected boundary`);
      verify(actual.mean<.6,`${kind} ${scale}x DPR ${dpr} matches direct artwork coverage`);
      if(previous&&previous.mean>.6)verify(actual.mean<previous.mean*.65,`${kind} ${scale}x DPR ${dpr} improves the original preview`);
      else if(previous)verify(actual.mean<=previous.mean+.1,`${kind} ${scale}x DPR ${dpr} preserves an already sharp preview`);
      rows.push({kind,scale,dpr,backend:renderer.stats.backend,current:actual,baseline:previous,bytes:retainedBytes(renderer)});
      if(kind==='outline'&&scale===32&&dpr===1)images.push({name:'current',url:renderer.canvas.toDataURL()},{name:'reference',url:expected.toDataURL()},...(before?[{name:'baseline',url:before.canvas.toDataURL()}]:[]));
      let rasters=renderer.stats.rasterizedObjects??0;
      renderer.render(options);verify(noNewRaster(renderer,rasters),'An unchanged zoomed scene does not rerasterize');
      const texture=renderer.layout?.find(e=>e.texture)?.texture;
      options.view={...view,x:view.x+8};renderer.render(options);
      if(renderer.device)verify(renderer.layout.find(e=>e.texture)?.texture===texture,'A small pan retains the same cropped texture');
      options.dragTranslations=new Map([[1,{x:.1,y:.1}]]);renderer.render(options);
      verify(noNewRaster(renderer,rasters),'A small figure drag retains cropped pixels');
      options.dragTranslations=undefined;options.view={...view,x:view.x+600};renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();
      const moved=reference(report,frame,geometry,options.view,width,height,dpr);
      verify(difference(read(renderer.canvas),read(moved)).mean<2,'A pan outside retained coverage redraws the exposed artwork');
      options.view=view;renderer.render(options);
      if(renderer.device)verify((renderer.stats.rasterizedObjects??0)===0,'Returning to a retained crop reuses its pixels');
      verify(retainedBytes(renderer)<=32*1024*1024,'Retained pixels obey the existing cache budget');
    }
    verify(errors.length===0,'Zooming produces no GPU validation errors');
    return {checks,rows,images,errors};
  }finally{renderer.destroy();before?.destroy();}
}

export async function zoomDetailBenchmark({baseline='/tmp/zoom-detail-baseline',forceCanvas2D=false,iterations=100,count=1000,scale=1,outlined=false,interaction='drag',rounds=3}={}){
  const modules=[['current',await import('../src/renderer.mjs')]];
  if(baseline)modules.unshift(['baseline',await import(`${baseline}/src/renderer.mjs`)]);
  const report=emptyDocument();report.canvas_width=960;report.canvas_height=540;
  const figure=defaultFigure();if(outlined)figure.segment_decode={global_style:{u28:new Uint32Array(new Float32Array([2]).buffer)[0],rgb:[60,90,140],u30:0}};
  report.figure_types=[figure];const frame=createFrame(Array.from({length:count},(_,i)=>createObject(figure,i+1,30+i%40*23,40+Math.floor(i/40)*20,{scale:.12})));report.keyframes=[frame];
  const geometry=buildGeometry(report,frame),samples=[],errors=[];
  const dragUid=scale>1?frame.objects.reduce((best,obj)=>Math.hypot(obj.root_x-165,obj.root_y-128)<Math.hypot(best.root_x-165,best.root_y-128)?obj:best).unique_id:1;
  try{
    for(const [version,module] of modules){
      const renderer=await module.createRenderer(document.createElement('canvas'),{forceCanvas2D});renderer.resize(960,540,1);
      renderer.device?.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const options={report,frame,geometry,view:{scale,x:scale>1?-150*scale:0,y:scale>1?-120*scale:0},cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0x00ffffff};
      const started=performance.now();renderer.render(options);await renderer.device?.queue.onSubmittedWorkDone();
      samples.push({version,renderer,options,coldMs:performance.now()-started,cpu:[],complete:[],rasterized:0,uploadBytes:0});
    }
    // Alternate order and interleave identical inputs to limit warm-up and
    // background-load bias. Completion timing includes the actual GPU queue.
    for(let round=0;round<rounds;round++)for(let i=0;i<iterations+20;i++)for(const sample of i%2?samples:[...samples].reverse()){
      const {renderer,options}=sample;
      if(interaction==='drag')options.dragTranslations=new Map([[dragUid,{x:(i%20)*.1,y:.1}]]);
      else if(interaction==='pan')options.view={...options.view,x:(scale>1?-150*scale:0)+(i%20)*2,y:scale>1?-120*scale:0};
      else if(interaction==='zoom')options.view={scale:scale*(1+i%20*.008),x:-150*scale,y:-120*scale};
      else if(interaction==='zoom-sweep')options.view={scale:scale*2**(Math.max(0,i-20)/40),x:-150*scale,y:-120*scale};
      const started=performance.now();renderer.render(options);const cpu=performance.now()-started;
      await renderer.device?.queue.onSubmittedWorkDone();const complete=performance.now()-started;
        if(i>=20){sample.cpu.push(cpu);sample.complete.push(complete);sample.rasterized+=renderer.device?renderer.stats.rasterizedObjects??0:Math.max(0,(renderer.stats.rasterizedObjects??0)-(sample.lastRasters??0));sample.uploadBytes+=renderer.stats.uploadBytes??0;}
        sample.lastRasters=renderer.stats.rasterizedObjects??0;
    }
    check(!errors.length,errors.join('\n'));
    return {settings:{iterations,count,scale,outlined,interaction,rounds,dragUid},errors,rows:samples.map(s=>({version:s.version,backend:s.renderer.stats.backend,adapter:s.renderer.stats.adapter,coldMs:s.coldMs,cpuMs:summary(s.cpu),completionMs:summary(s.complete),cpuOver50Ms:s.cpu.filter(n=>n>50).length,rasterized:s.rasterized,uploadBytes:s.uploadBytes,retainedBytes:retainedBytes(s.renderer),drawCalls:s.renderer.stats.drawCalls}))};
  }finally{for(const {renderer} of samples)renderer.destroy();}
}
