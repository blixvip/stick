import {chromium} from './support/playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='artifacts/camera-motion';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(`${process.env.STYK_URL||'http://127.0.0.1:47831'}/api/health`);
  const result=await page.evaluate(async()=>{
    const [{Editor},{createRenderer},{defaultFigure,createObject,createFrame,emptyDocument},{buildGeometry,evaluatedFrame},{drawExportScene,drawExportSceneSequential,drawExportSceneTiled},{exportSVG},{compilePlaybackPacket},{PlaybackResources},{drawCameraMonitor},{createVfx}]=await Promise.all([
      import('/src/editor.mjs'),import('/src/renderer.mjs'),import('/src/demo.mjs'),import('/src/pivot/geometry.mjs'),import('/src/export-frame-core.mjs'),import('/src/svg-export.mjs'),import('/src/playback-worker.mjs'),import('/src/playback-resources.mjs'),import('/src/camera-monitor.mjs'),import('/src/vfx.mjs')]);
    const w=320,h=240,pixels=async canvas=>{const bitmap=await createImageBitmap(canvas),surface=new OffscreenCanvas(w,h),ctx=surface.getContext('2d');ctx.drawImage(bitmap,0,0,w,h);bitmap.close();return ctx.getImageData(0,0,w,h).data;};
    const diff=(a,b)=>{let sum=0,significant=0;for(let i=0;i<a.length;i+=4){let max=0;for(let k=0;k<4;k++){const d=Math.abs(a[i+k]-b[i+k]);sum+=d;max=Math.max(max,d);}if(max>10)significant++;}return {mae:sum/a.length,percent:significant/(w*h)*100};};
    const records=[];
    for(const movieclip of [false,true])for(const effects of [false,true]){
      const report=emptyDocument();report.canvas_width=w;report.canvas_height=h;
      report.figure_types=[[10,160,240],[240,110,40],[40,190,100]].map((rgb,i)=>{const f=defaultFigure(i+1);f.segments=[{...f.segments[0],angle_rad:0,bend_rad:0,segment_kind:'squareLine',segment_type:'line',color_rgb:rgb,length:60,thickness:30}];f.segment_count=1;return f;});
      report.keyframes=[createFrame(report.figure_types.map((f,i)=>createObject(f,i+1,30+i*240,70+i*25,{field28:i===2?64:0})),24),createFrame([],1)];
      report.keyframes[0]._stykBackgroundColor=0xfffafafa;
      if(effects)report.keyframes[0]._stykVfx={figure:[{...createVfx('tint','test-tint'),params:{color:0xff2255,mix:.4}}]};
      const e=new Editor({demo:false,layerTimeline:true}).load(report);let members=[2,3];
      if(movieclip){e.selectMany(members);e.createMovieclip({start:0,end:24});members=[e.selectedUid];}
      const far=e.createLayer('Far');e.assignFiguresToLayer(members,far.id);e.setLayerParallax(far.id,{enabled:true,x:.25});e.setCameraValues({x:280,y:12,scale:.85,angle_rad:.12});e.addCameraMotion('impact',{start:0,duration:12});
      const frame=evaluatedFrame(e.report,0,0,0),geometry=buildGeometry(e.report,frame),resources=new PlaybackResources({baseURL:location.origin});
      const reference=new OffscreenCanvas(w,h);drawExportScene(reference.getContext('2d'),e.report,frame,geometry,resources);const expected=await pixels(reference);
      const sequential=new OffscreenCanvas(w,h);await drawExportSceneSequential(sequential.getContext('2d'),e.report,frame,geometry,resources);
      records.push({effects,path:'sequential export',...diff(expected,await pixels(sequential))});
      const tiled=new OffscreenCanvas(w,h);await drawExportSceneTiled(tiled.getContext('2d'),e.report,frame,geometry,resources,128);records.push({effects,path:'tiled export',...diff(expected,await pixels(tiled))});
      const svg=await exportSVG({report:e.report,frame,geometry,resources}),url=URL.createObjectURL(svg),img=new Image();img.src=url;await img.decode();const surface=new OffscreenCanvas(w,h);surface.getContext('2d').drawImage(img,0,0);URL.revokeObjectURL(url);records.push({effects,path:'SVG',...diff(expected,await pixels(surface))});
      const monitor=document.createElement('canvas');monitor.style.cssText=`width:${w}px;height:${h}px`;document.body.append(monitor);drawCameraMonitor(monitor,{report:e.report,frame,geometry,resources,onError:error=>{throw error;}});records.push({effects,path:'monitor',...diff(expected,await pixels(monitor))});monitor.remove();
      for(const fallback of [false,true]){
        const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas,{forceCanvas2D:fallback});renderer.resize(w,h,1);renderer.render({report:e.report,frame,geometry,view:{scale:1},cameraEnabled:true});await renderer.device?.queue.onSubmittedWorkDone();records.push({effects,path:fallback?'Canvas live':'GPU live',...diff(expected,await pixels(canvas))});
        const packet=await compilePlaybackPacket(e.report,0,{resources,softwareFrames:fallback});const key=renderer.prepareFrame(packet,{report:e.report,view:{scale:1}});renderer.renderPrepared(key,{report:e.report,view:{scale:1}});await renderer.device?.queue.onSubmittedWorkDone();records.push({effects,path:fallback?'Canvas prepared':'GPU prepared',...diff(expected,await pixels(canvas))});
        for(const entry of packet.compatibility)entry.bitmap?.close();renderer.destroy();
      }
      records.slice(-8).forEach(record=>record.movieclip=movieclip);resources.dispose();
    }
    return records;
  });
  await writeFile(`${out}/render-results.json`,JSON.stringify({result,errors},null,2));console.log(JSON.stringify(result,null,2));
  for(const row of result)assert.ok(row.mae<1.2&&row.percent<2,JSON.stringify(row));assert.deepEqual(errors,[]);
}finally{await browser.close();}
