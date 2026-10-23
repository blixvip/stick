import {chromium} from './support/playwright.mjs';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{startBackend}=require('../desktop/backend.cjs');
const backend=await startBackend({appRoot:process.cwd()});let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`${backend.origin}/api/health`);
  const result=await page.evaluate(async()=>{
    const {glyphTextureDescriptor,cropGlyphTexture,drawGlyphMask}=await import('/src/renderer-glyphs.mjs');
    const {createRenderer}=await import('/src/renderer.mjs');
    const {createTextFigure}=await import('/src/text-authoring.mjs');
    const {emptyDocument,createObject,createFrame}=await import('/src/demo.mjs');
    const {buildGeometry}=await import('/src/pivot/geometry.mjs');
    const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs');
    const check=(value,message)=>{if(!value)throw new Error(message);};
    // A surrounding contour or hole cannot be discarded just because every
    // endpoint is outside the crop. Keep curves by their complete control hull.
    for(const willReadFrequently of[false,true])for(const source of[
      'M-100 -100H200V200H-100Z M10 10H30V30H10Z M500 500H550V550H500Z M80 0C-80 30 160 60 80 100Z',
      'm-100 -100h300v300h-300z m110 110h20v20h-20z',
      'M10 10A30 40 0 1 0 60 60Z M500 500H550V550H500Z',
    ]){
      const full=new OffscreenCanvas(128,128),cropped=new OffscreenCanvas(128,128),a=full.getContext('2d',{willReadFrequently}),b=cropped.getContext('2d',{willReadFrequently});
      a.setTransform(1,0,0,1,16,16);a.fillStyle='#fff';a.fill(new Path2D(source),'evenodd');
      drawGlyphMask(b,{mask:{source},width:128,height:128,left:-16,top:-16,scaleX:1,scaleY:1,offsetX:16,offsetY:16});
      const expected=a.getImageData(0,0,128,128).data,actual=b.getImageData(0,0,128,128).data;
      check(expected.every((n,i)=>n===actual[i]),'Contour culling changed path coverage or holes');
      full.width=cropped.width=1;
    }
    const output=[],report=emptyDocument();report.canvas_width=400;report.canvas_height=300;
    const figure=await createTextFigure({text:'S',fontSize:120,color:[60,140,225]});figure.figure_type_id=1;report.figure_types=[figure];
    const canvas=document.createElement('canvas'),renderer=await createRenderer(canvas,{editorRasterCache:{maxBytes:256*1024*1024}});
    renderer.resize(400,300,1);
    const surface=new OffscreenCanvas(400,300),ctx=surface.getContext('2d',{willReadFrequently:true});
    const pixels=()=>{ctx.clearRect(0,0,400,300);ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,400,300).data;};
    const resources=new PlaybackResources({preview:true});let revision=0;
    try{
      for(const mirror of[0,1])for(const scale of[12,-12])for(const angle of[0,.37]){
        const f=structuredClone(figure);f.segments[0].extra_u8_b=mirror;report.figure_types=[f];
        const object=createObject(f,1,-250,scale>0?750:-450,{scale,angles:[angle],field28:60});
        const frame=createFrame([object]);report.keyframes=[frame];let geometry=buildGeometry(report,frame);
        let full=glyphTextureDescriptor(geometry.orderedObjects[0].drawables,1,8192);
        object.root_x+=200-full.x-(full.axes[0]+full.axes[2])/2;
        object.root_y+=150-full.y-(full.axes[1]+full.axes[3])/2;
        geometry=buildGeometry(report,frame);full=glyphTextureDescriptor(geometry.orderedObjects[0].drawables,1,8192);
        const cropped=cropGlyphTexture(full,{x:0,y:0,width:400,height:300});
        if(!cropped)continue;
        check(cropped.bytes<full.bytes,'fixture must exercise a cropped large mask');
        const original=new OffscreenCanvas(full.width,full.height),originalCtx=original.getContext('2d',{willReadFrequently:true});drawGlyphMask(originalCtx,full);
        const part=new OffscreenCanvas(cropped.width,cropped.height),partCtx=part.getContext('2d',{willReadFrequently:true});drawGlyphMask(partCtx,cropped);
        const x=Math.round((cropped.left-full.left)*full.scaleX),y=Math.round((cropped.top-full.top)*full.scaleY);
        const a=originalCtx.getImageData(x,y,cropped.width,cropped.height).data,b=partCtx.getImageData(0,0,part.width,part.height).data;
        let alphaChanged=0,alphaMax=0;for(let i=3;i<a.length;i+=4)if(a[i]!==b[i]){alphaChanged++;alphaMax=Math.max(alphaMax,Math.abs(a[i]-b[i]));}
        original.width=part.width=1;
        const options={report,frame,geometry,view:{scale:1,x:0,y:0},cameraEnabled:true,artworkRevision:++revision};
        await renderer.prepareBackgrounds(report,frame);renderer.render(options);await renderer.device.queue.onSubmittedWorkDone();const expected=pixels();
        const packet=await compilePlaybackPacket(report,0,{resources,revision,cameraEnabled:true,scale:1});
        try{
          renderer.prepareFrame(packet,{report,cameraEnabled:true});renderer.renderPrepared(packet.key,options);await renderer.device.queue.onSubmittedWorkDone();const actual=pixels();
          let changed=0,max=0,total=0;for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);if(d)changed++;max=Math.max(max,d);total+=d;}
          // Canvas curve clipping and Float32 quad arithmetic can round edge
          // coverage differently, and playback masks rasterize on worker CPU
          // canvases while the editor's use an accelerated canvas (edge-only
          // means of 0.022-0.025 at 12x). Solid interiors and holes must stay exact.
          let interiorMismatch=0;
          for(let y=2;y<298;y++)for(let x=2;x<398;x++){
            const i=(y*400+x)*4;if(![0,1,2,3].some(c=>Math.abs(actual[i+c]-expected[i+c])>2))continue;
            let edge=false;for(let c=0;c<4&&!edge;c++)for(let dy=-2;dy<=2&&!edge;dy++)for(let dx=-2;dx<=2;dx++)if(Math.abs(expected[((y+dy)*400+x+dx)*4+c]-expected[i+c])>2){edge=true;break;}
            if(!edge)interiorMismatch++;
          }
          check(total/actual.length<.03&&interiorMismatch===0,`GPU crop differs: ${JSON.stringify({mirror,scale,angle,changed,max,mean:total/actual.length,interiorMismatch,alphaChanged,alphaMax})}`);
          output.push({mirror,scale,angle,originalBytes:full.bytes,croppedBytes:cropped.bytes,changed,max,mean:total/actual.length,alphaChanged,alphaMax});
        }finally{for(const entry of packet.compatibility)entry.bitmap?.close();renderer.clearPreparedFrames();}
      }
      const clones=Array.from({length:4},(_,i)=>({...structuredClone(figure),figure_type_id:i+1}));
      report.figure_types=clones;report.keyframes=[createFrame(clones.map((f,i)=>createObject(f,i+1,50+i*80,150,{scale:.5,color_override_raw:0xff0055aa+i*100})))];
      const unique=new PlaybackResources({preview:true});
      let packet=await compilePlaybackPacket(report,0,{resources:unique,revision:++revision});
      const budget=packet.byteLength+128;
      check(packet.compatibility.length===1&&packet.groups.length===4,'identical glyph definitions did not share one mask');
      for(const c of packet.compatibility)c.bitmap.close();unique.dispose();
      const pressure=new PlaybackResources({preview:true});let captures=0;
      const capture=pressure.artworkBitmaps.packetBitmap.bind(pressure.artworkBitmaps);
      pressure.artworkBitmaps.packetBitmap=(...args)=>{captures++;return capture(...args);};
      packet=await compilePlaybackPacket(report,0,{resources:pressure,revision:++revision,maxPacketBytes:budget});
      check(!packet.previewQuality.reduced&&packet.compatibility.length===1&&captures===1,'duplicate admission triggered false pressure');
      for(const c of packet.compatibility)c.bitmap.close();pressure.dispose();
      const planned=new PlaybackResources({preview:true});let plannedCaptures=0;
      const capturePlanned=planned.artworkBitmaps.packetBitmap.bind(planned.artworkBitmaps);
      planned.artworkBitmaps.packetBitmap=(...args)=>{plannedCaptures++;return capturePlanned(...args);};
      report.figure_types=[figure];report.keyframes=[createFrame([.7,.9,1.1,1.3].map((scale,i)=>createObject(figure,i+1,50+i*70,170,{scale})))];
      packet=await compilePlaybackPacket(report,0,{resources:planned,revision:++revision,maxPacketBytes:16000,scale:4});
      check(packet.previewQuality.reduced,'fixture must hit actual memory pressure');
      check(plannedCaptures===packet.compatibility.length,'rejected plans rasterized disposable masks');
      const reducedScale=packet.previewQuality.scale,admittedCaptures=plannedCaptures;for(const c of packet.compatibility)c.bitmap.close();
      const cancelledResources=new PlaybackResources({preview:true}),clonesToClose=[];
      const copy=cancelledResources.artworkBitmaps.packetBitmap.bind(cancelledResources.artworkBitmaps);
      cancelledResources.artworkBitmaps.packetBitmap=async(...args)=>{const bitmap=await copy(...args);clonesToClose.push(bitmap);return bitmap;};
      let aborted=false;
      try{await compilePlaybackPacket(report,0,{resources:cancelledResources,revision:++revision,maxPacketBytes:64*1024*1024,scale:4,cancelled:()=>clonesToClose.length>0});}
      catch(error){aborted=error.name==='AbortError';}
      check(aborted&&clonesToClose.length===1&&clonesToClose[0].width===0,'cancellation did not release the partial packet');cancelledResources.dispose();
      report.keyframes=Array.from({length:11},()=>createFrame([createObject(figure,1,100,150,{scale:.05})]));
      const recovered=[];
      for(let tick=0;tick<11;tick++){
        const next=await compilePlaybackPacket(report,tick,{resources:planned,revision:++revision,maxPacketBytes:16000,scale:4});
        recovered.push(next.previewQuality.scale);for(const c of next.compatibility)c.bitmap.close();
      }
      check(recovered.at(-1)>reducedScale,'lightweight consecutive frames never recovered detail');
      check(recovered[0]===reducedScale,'quality recovered without sustained headroom');planned.dispose();
      return {checks:output,adapter:renderer.stats.adapter,duplicateMaskSharing:true,cancellation:true,preflight:{admittedCaptures,reducedScale,recovered}};
    }finally{resources.dispose();renderer.destroy();}
  });
  assert.ok(result.checks.length>=4);assert.deepEqual(errors,[]);
  await mkdir('artifacts/playback-glyph-crop',{recursive:true});await writeFile('artifacts/playback-glyph-crop/report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();backend.stop();}
