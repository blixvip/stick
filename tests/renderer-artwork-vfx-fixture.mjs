import {samplingFixture} from './export-sampling-fixture.mjs';
import {createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {createVfx} from '../src/vfx.mjs';

const check=(condition,message,details)=>{if(!condition)throw Object.assign(Error(message),{details});};
const read=canvas=>{
  const copy=new OffscreenCanvas(canvas.width,canvas.height),ctx=copy.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,copy.width,copy.height).data;
};
function difference(actual,expected){
  check(actual.length===expected.length,'Pixel references must have identical dimensions');
  let sum=0,max=0,painted=0,far=0;
  for(let i=0;i<actual.length;i+=4){
    let pixel=0;
    for(let c=0;c<4;c++){const d=Math.abs(actual[i+c]-expected[i+c]);sum+=d;max=Math.max(max,d);pixel=Math.max(pixel,d);}
    if(actual[i]+actual[i+1]+actual[i+2]<765)painted++;if(pixel>24)far++;
  }
  return {mean:sum/actual.length,max,painted,far,pixels:actual.length/4};
}
const effect=(type,id,params={})=>{const value=createVfx(type,id);Object.assign(value.params,params);return value;};
/** Native outlined strokes always paint through Canvas, so their figure effects
 * exercise the artwork route rather than the vector one. */
function scene(effects,{opacity=1}={}){
  const report=samplingFixture({kind:'outline'}),figure=report.figure_types[0],base=figure.segments[0];
  figure.segment_decode.global_style.u30=80;
  figure.segments=Array.from({length:8},(_,i)=>({...base,segment_id:i+1,parent_id:0,length:46,angle_rad:i*Math.PI/4+.413,color_rgb:[40+i*24,170-i*12,220]}));
  figure.segment_count=figure.segments.length;report.canvas_width=256;report.canvas_height=192;
  const object=createObject(figure,1,128.4,96.3,opacity<1?{field28:Math.round((1-opacity)*255)}:{});object._stykVfx=effects;
  const frame=createFrame([object]);report.keyframes=[frame];
  return {report,frame,geometry:buildGeometry(report,frame)};
}
/** Canvas artwork filtered on the presenting device must match the same
 * artwork filtered inside the Canvas painter. Runs in the real WebGPU renderer. */
export async function artworkVfxParity({rendererURL='../src/renderer.mjs',onProgress=()=>{}}={}){
  const {createRenderer}=await import(rendererURL);
  const width=384,height=288,checks=[],rows=[],errors=[],renderers=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const make=async disableVectorVfx=>{
    const renderer=await createRenderer(document.createElement('canvas'),{gpuDrawing:false,sharedArtwork:false});
    renderer.resize(width,height,1);renderer.disableVectorVfx=disableVectorVfx;renderers.push(renderer);
    renderer.device?.addEventListener('uncapturederror',event=>errors.push(event.error.message));return renderer;
  };
  const cases=[
    ['glow',{figure:[effect('glow','a',{radius:5,intensity:1.2})]}],
    ['blur',{figure:[effect('blur','a',{radius:2.5})]}],
    ['directional blur and glow',{figure:[effect('blur','a',{mode:1,radius:6,angle:54}),effect('glow','b',{radius:8,intensity:1.2})]}],
    ['outline',{figure:[effect('outline','a',{width:1.4,mode:2})]}],
    ['bloom and tint',{figure:[effect('bloom','a',{threshold:.5,radius:6,intensity:1.3}),effect('tint','b',{mix:.4})]}],
    ['half strength',{figure:[effect('blur','a',{radius:3,effectStrength:.48})]}],
  ];
  try{
    const current=await make(false),reference=await make(true);
    verify(current.device&&current.stats.backend==='WebGPU','The artwork effect regression executes the real WebGPU renderer');
    for(const [name,effects] of cases)for(const scale of [1.3,2.6,24]){
      const s=scene(effects),view={scale,x:width/2-128.4*scale+.31,y:height/2-96.3*scale+.27};
      const options={report:s.report,frame:s.frame,geometry:s.geometry,view,cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0xffffffff};
      const before=current.stats.artworkVfxObjects??0;
      current.render(options);reference.render(options);
      await current.device.queue.onSubmittedWorkDone();await reference.device.queue.onSubmittedWorkDone();
      verify((current.stats.artworkVfxObjects??0)===before+1,`${name} ${scale}x: the figure stack is filtered on the device`);
      verify(!(reference.stats.artworkVfxObjects>0),`${name} ${scale}x: the reference filters inside the Canvas painter`);
      const diff=difference(read(current.canvas),read(reference.canvas));
      // Path-only artwork paints on a software surface here and an accelerated
      // one in the reference; native edges differ slightly before filtering.
      verify(diff.painted>400&&diff.mean<.5&&diff.far<=diff.pixels*.002,`${name} ${scale}x: device-filtered artwork matches Canvas filtering (${diff.mean.toFixed(4)})`,diff);
      rows.push({name,scale,diff});
    }
    // Opacity composites after the effect stack: that order belongs to the Canvas painter.
    const translucent=scene({figure:[effect('glow','a',{radius:5})]},{opacity:.5}),before=current.stats.artworkVfxObjects??0;
    const options={report:translucent.report,frame:translucent.frame,geometry:translucent.geometry,view:{scale:2,x:width/2-128.4*2,y:height/2-96.3*2},cameraEnabled:false,clipToCanvas:false,editorBackgroundColor:0xffffffff};
    current.render(options);reference.render(options);
    await current.device.queue.onSubmittedWorkDone();await reference.device.queue.onSubmittedWorkDone();
    const diff=difference(read(current.canvas),read(reference.canvas));
    verify((current.stats.artworkVfxObjects??0)===before&&diff.painted>400&&diff.max===0,'A translucent figure keeps the complete Canvas painter and exact pixels',diff);
    verify(!errors.length,'Device-filtered artwork produces no GPU validation errors',errors);
    return {checks,rows,errors,backend:current.stats.backend};
  }finally{for(const renderer of renderers)renderer.destroy();}
}

/** Prepared playback must present the same pixels whether a figure's effects
 * were filtered while its packet was prepared or are filtered here from the
 * unfiltered artwork the packet carries, including artwork the camera crops. */
export async function preparedArtworkVfxParity({rendererURL='../src/renderer.mjs',workerURL='../src/playback-worker.mjs',onProgress=()=>{}}={}){
  const [{createRenderer},{compilePlaybackPacket,PlaybackResources}]=await Promise.all([import(rendererURL),import(workerURL)]);
  const width=384,height=288,checks=[],rows=[],errors=[],renderers=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const make=async()=>{
    const renderer=await createRenderer(document.createElement('canvas'),{gpuDrawing:false});
    renderer.resize(width,height,1);renderers.push(renderer);
    renderer.device?.addEventListener('uncapturederror',event=>errors.push(event.error.message));return renderer;
  };
  const cases=[
    ['glow',{figure:[effect('glow','a',{radius:5,intensity:1.2})]},{x:128.4,y:96.3}],
    ['directional blur and glow',{figure:[effect('blur','a',{mode:1,radius:6,angle:54}),effect('glow','b',{radius:8,intensity:1.2})]},{x:128.4,y:96.3}],
    ['outline',{figure:[effect('outline','a',{width:1.4,mode:2})]},{x:128.4,y:96.3}],
    // The artboard crops this figure: its halo samples artwork beyond the crop.
    ['glow across the artboard edge',{figure:[effect('glow','a',{radius:9,intensity:1.4})]},{x:12.6,y:30.2}],
    ['blur across the artboard corner',{figure:[effect('blur','a',{radius:4})]},{x:250.7,y:186.4}],
  ];
  const resources=new PlaybackResources({preview:true,softwareImages:true});
  try{
    const current=await make(),reference=await make();
    verify(current.device&&current.stats.backend==='WebGPU','The prepared effect regression executes the real WebGPU renderer');
    let revision=1;
    for(const [name,effects,at] of cases){
      const s=scene(effects),object=s.frame.objects[0];object.root_x=at.x;object.root_y=at.y;
      s.report._styk.layers.fixed.scene.visible=true;s.frame._stykBackgroundColor=0xffffffff;
      const view={scale:1.5,x:0,y:0},options={report:s.report,view,cameraEnabled:true};
      const shared={revision:revision++,scale:1.5,resources,maxPacketBytes:64*1024*1024,sharedArtwork:false};
      const deferred=await compilePlaybackPacket(s.report,0,{...shared,gpuIsolation:true});
      const filtered=await compilePlaybackPacket(s.report,0,{...shared,gpuIsolation:false});
      const entry=deferred.compatibility.find(item=>item.vfx);
      verify(entry?.bitmap&&entry.vfx.stack.length===effects.figure.length&&entry.vfx.domain&&entry.vfx.scale===1,`${name}: the packet carries unfiltered artwork and its figure stack`,
        {kinds:deferred.compatibility.map(item=>Object.keys(item))});
      verify(filtered.compatibility.length===deferred.compatibility.length&&filtered.compatibility.every(item=>item.bitmap&&!item.vfx),`${name}: without device filtering the packet carries filtered pixels`);
      const before=current.preparedFrames.stats.vfxArtwork??0;
      const present=async(renderer,packet)=>{
        const key=renderer.prepareFrame(packet,options);
        check(key&&renderer.renderPrepared(key,options),'The prepared frame presents');
        await renderer.device.queue.onSubmittedWorkDone();return read(renderer.canvas);
      };
      const pixels=await present(current,deferred),expected=await present(reference,filtered);
      verify((current.preparedFrames.stats.vfxArtwork??0)===before+1,`${name}: the device filters the uploaded artwork once`);
      const diff=difference(pixels,expected);
      verify(diff.painted>400&&diff.mean<.5&&diff.far<=diff.pixels*.002,`${name}: device-filtered playback matches packet-filtered playback (${diff.mean.toFixed(4)})`,diff);
      const replay=await present(current,deferred);
      verify((current.preparedFrames.stats.vfxArtwork??0)===before+1&&difference(replay,pixels).max===0,`${name}: replaying the frame reuses its filtered texture`);
      rows.push({name,diff});
      current.clearPreparedFrames();reference.clearPreparedFrames();
      for(const packet of [deferred,filtered])for(const item of packet.compatibility)item.bitmap?.close();
    }
    verify(!errors.length,'Device-filtered playback produces no GPU validation errors',errors);
    return {checks,rows,errors,backend:current.stats.backend};
  }finally{resources.dispose();for(const renderer of renderers)renderer.destroy();}
}

/** Scene effects filter the camera image, including its background and the
 * margin the effects sample. The WebGPU camera source stays on the device;
 * the Compatibility renderer paints the same scene through Canvas. Both must
 * agree for every background kind, with and without a transformed camera. */
export async function sceneVfxCameraParity({rendererURL='../src/renderer.mjs',deviceSource=true,onProgress=()=>{}}={}){
  const {createRenderer}=await import(rendererURL);
  const width=384,height=288,checks=[],rows=[],errors=[],renderers=[];
  const verify=(condition,message,details)=>{check(condition,message,details);checks.push(message);onProgress({checks:checks.length,message});};
  const make=async forceCanvas2D=>{
    const renderer=await createRenderer(document.createElement('canvas'),{forceCanvas2D,gpuDrawing:false,asyncArtwork:false});
    renderer.resize(width,height,1);renderers.push(renderer);
    renderer.device?.addEventListener('uncapturederror',event=>errors.push(event.error.message));return renderer;
  };
  const backgrounds={
    color:(report,frame)=>{report._styk.layers.fixed.scene.visible=true;frame._stykBackgroundColor=0xff496787;},
    gradient:(report,frame)=>{report._styk.layers.fixed.scene.visible=true;report.backgrounds=[{background_id:1,kind:3,color_a:0xff234567,color_b:0xffbbaacc,x1:.13,y1:.07,x2:.91,y2:.82}];frame.background_id=1;},
    'gradient mix':(report,frame)=>{report._styk.layers.fixed.scene.visible=true;report.backgrounds=[{background_id:1,kind:3,color_a:0xff234567,color_b:0xffbbaacc,x1:.13,y1:.07,x2:.91,y2:.82},
      {background_id:2,kind:2,color:0xff6a397b}];frame.background_id=1;frame.background_id_b=2;frame.background_mix=93;},
    radial:(report,frame)=>{report._styk.layers.fixed.scene.visible=true;report.backgrounds=[{background_id:1,kind:4,color_a:0xff203050,color_b:0xffffe0a0,x1:.4,y1:.45,x2:.1,y2:.9}];frame.background_id=1;},
    painted:(report,frame)=>{report._styk.layers.fixed.scene.visible=true;report.backgrounds=[{background_id:1,kind:2,color:0xffffffff,
      paint:{type:'diamond',angle:20,stops:[{offset:0,color:[250,220,120],opacity:1},{offset:.6,color:[60,120,200],opacity:1},{offset:1,color:[20,30,60],opacity:1}]}}];frame.background_id=1;},
  };
  const cameras={still:{is_default:true,x:0,y:0,scale:1,angle_rad:0},moved:{is_default:false,x:14.3,y:-9.6,scale:1.6,angle_rad:.21}};
  try{
    const gpu=await make(false),canvas=await make(true);
    verify(gpu.device&&gpu.stats.backend==='WebGPU','The scene effect regression executes the real WebGPU renderer');
    for(const [backgroundName,apply] of Object.entries(backgrounds))for(const [cameraName,camera] of Object.entries(cameras))for(const cameraEnabled of [true,false]){
      const s=scene({});s.frame.objects[0]._stykVfx=undefined;apply(s.report,s.frame);s.frame.camera={...camera};
      s.frame._stykVfx={figure:[effect('blur','scene',{radius:3})]};s.geometry=buildGeometry(s.report,s.frame);
      const view={scale:1.2,x:38.3,y:28.7},options={report:s.report,frame:s.frame,geometry:s.geometry,view,cameraEnabled,clipToCanvas:cameraEnabled,editorBackgroundColor:undefined};
      const name=`${backgroundName}, ${cameraName} camera, ${cameraEnabled?'camera view':'world view'}`;
      const paints=gpu.vfxViewport?.cameraSource?.stats?.paints??0;
      gpu.render(options);canvas.render(options);await gpu.device.queue.onSubmittedWorkDone();
      if(deviceSource)verify((gpu.vfxViewport.cameraSource.stats.paints??0)===paints+1,`${name}: the camera image is painted on the device`);
      const diff=difference(read(gpu.canvas),read(canvas.canvas));
      // The two renderers already differ along the artboard edge (about 1% of
      // these pixels) and on diamond paint (under 4%), with either camera source.
      verify(diff.painted>2000&&diff.mean<1&&diff.far<=diff.pixels*.04,`${name}: the device camera image matches the Canvas camera image (${diff.mean.toFixed(4)})`,diff);
      rows.push({name,diff});
    }
    if(!deviceSource)return {checks,rows,errors,backend:gpu.stats.backend};
    // Solid and gradient backgrounds are drawn by the device; a painted one is
    // uploaded when it or the camera changes, not for every camera paint.
    const source=gpu.vfxViewport.cameraSource,animate=async(apply,cameraFor)=>{
      const s=scene({});s.frame.objects[0]._stykVfx=undefined;apply(s.report,s.frame);
      s.frame._stykVfx={figure:[effect('blur','scene',{radius:3})]};
      const before={...source.stats};
      for(let step=0;step<4;step++){
        const frame={...s.frame,camera:cameraFor(step),objects:[{...s.frame.objects[0],root_x:120+step*7}]},geometry=buildGeometry(s.report,frame);
        gpu.render({report:s.report,frame,geometry,view:{scale:1.2,x:38.3,y:28.7},cameraEnabled:true});
      }
      await gpu.device.queue.onSubmittedWorkDone();
      return {paints:source.stats.paints-before.paints,uploads:source.stats.backgroundUploads-before.backgroundUploads};
    };
    const moving=step=>({is_default:false,x:4+step*3,y:-2,scale:1+step*.1,angle_rad:0});
    let counts=await animate(backgrounds.gradient,moving);
    verify(counts.paints===4&&counts.uploads===0,'A gradient background follows a moving camera without painting or uploading pixels',counts);
    counts=await animate(backgrounds.painted,()=>cameras.moved);
    verify(counts.paints===4&&counts.uploads===1,'A painted background that does not change is uploaded once while the scene animates',counts);
    counts=await animate(backgrounds.painted,moving);
    verify(counts.paints===4&&counts.uploads===4,'A painted background is uploaded again when the camera moves',counts);
    verify(!errors.length,'The device camera image produces no GPU validation errors',errors);
    return {checks,rows,errors,backend:gpu.stats.backend};
  }finally{for(const renderer of renderers)renderer.destroy();}
}
