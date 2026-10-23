import {createRenderer} from '../src/renderer.mjs';
import {defaultFigure,createObject,createFrame} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {drawCameraMonitor} from '../src/camera-monitor.mjs';

const check=(condition,message,details)=>{if(!condition)throw Object.assign(Error(message),{details});};
function pixels(canvas,width=canvas.width,height=canvas.height){return canvas.getContext('2d').getImageData(0,0,width,height).data;}
function compare(a,b){
  let max=0,total=0,changed=0;
  for(let i=0;i<a.length;i+=4)for(let c=0;c<4;c++){
    const difference=Math.abs((c===3?a[i+c]:a[i+c]*a[i+3]/255)-(c===3?b[i+c]:b[i+c]*b[i+3]/255));
    max=Math.max(max,difference);total+=difference;if(difference>=1)changed++;
  }
  return {max,mean:total/a.length,changed};
}
const rasterDetails=item=>item&&{bytes:item.bytes,width:item.canvas?.width??item.bitmap?.width,
  height:item.canvas?.height??item.bitmap?.height,resolution:item.resolution,bounds:item.bounds,raster:item.raster};
async function renderer(resources={}){
  return createRenderer(document.createElement('canvas'),{forceCanvas2D:true,asyncArtwork:false,resources});
}

/** Run directly through the collaborative preview. These checks exercise real
 * Canvas pixels, drawing presenters and prepared surfaces without app startup. */
export async function compatibilityEditorChecks({onProgress=()=>{}}={}){
  const checks=[],rows=[];
  const verify=(condition,message,details)=>{if(!condition)onProgress({message,details,failed:true});check(condition,message,details);checks.push(message);onProgress({message,details});};
  // Ordinary native paths retain their complete source domain: cropping can
  // change Canvas edge coverage even when the raster grid is unchanged.
  const figure=defaultFigure(),object=createObject(figure,1,0,0),g={slot:0,obj:object,fig:figure,root:{x:0,y:0}};
  g.drawables=Array.from({length:360},(_,index)=>{
    const x=(index%20)*76+13.37,y=Math.floor(index/20)*54+11.61,start={x,y},end={x:x+31.27,y:y+22.83};
    return {type:'line',slot:0,obj:object,fig:figure,start,end,points:[start,end],length:Math.hypot(31.27,22.83),
      angle:Math.atan2(22.83,31.27),bend:0,thickness:1.17+index%4,opacity:1,alpha:1,rgb:[20,80,150],seg:{segment_kind:index%3?'line':'squareLine'}};
  });
  const far=createObject(figure,2,3000,3000),farFrame=createFrame([far]),farGeometry=buildGeometry({figure_types:[figure]},farFrame).orderedObjects[0];
  const frame=createFrame([object,far]),report={version:5,canvas_width:1700,canvas_height:1200,fps:24,backgrounds:[],figure_types:[figure],keyframes:[frame]};
  const geometry={objects:new Map([[0,g],[1,farGeometry]]),orderedObjects:[g,farGeometry],drawables:[...g.drawables,...farGeometry.drawables],warnings:[]};
  const options={report,frame,geometry,view:{scale:1.25},cameraEnabled:false,vfxEnabled:false,onionFrames:[],clipToCanvas:false};
  onProgress({phase:'ordinary-zoom renderer creation'});
  const candidate=await renderer(),reference=await renderer();
  try{
    onProgress({phase:'ordinary-zoom paints'});
    candidate.resize(320,240,1);reference.resize(2200,1600,1);
    // Disabled effects use a copy-on-write render view. Inspect the painted
    // groups returned by render(), rather than the editable source identity.
    const candidateGroup=candidate.render(options).objects.get(0),referenceGroup=reference.render(options).objects.get(0);
    const difference=compare(pixels(candidate.canvas),pixels(reference.canvas,320,240)),native=candidate.artwork.get(candidateGroup),complete=reference.artwork.get(referenceGroup);
    verify(candidate.stats.culledObjects>=1,'Off-screen figures are culled at ordinary zoom',candidate.stats.culledObjects);
    verify(Boolean(native)&&Boolean(complete)&&!native.raster?.cropped&&native.bytes===complete.bytes&&
      native.canvas.width===complete.canvas.width&&native.canvas.height===complete.canvas.height,
      'Ordinary native paths retain the complete raster domain',{native:rasterDetails(native),complete:rasterDetails(complete),
        candidateEntries:[...candidate.artwork.values()].map(rasterDetails),referenceEntries:[...reference.artwork.values()].map(rasterDetails)});
    verify(difference.max<=2&&difference.mean<.02,'Ordinary native paths match the complete artwork pixels',difference);
    const moved={...options,view:{scale:1.25,x:-700,y:-500}};
    candidate.render(moved);reference.render(moved);
    const panDifference=compare(pixels(candidate.canvas),pixels(reference.canvas,320,240));
    verify(candidate.artwork.get(candidateGroup)===native&&panDifference.max<=2&&panDifference.mean<.02,
      'Panning native paths reuses their complete domain with exact visible artwork',panDifference);
    rows.push({name:'ordinary-native-domain',difference,panDifference,bytes:native.bytes,completeBytes:complete.bytes});
  }finally{candidate.destroy();reference.destroy();}

  // Verified immutable image artwork can crop without moving native paths.
  // Four anchored images use the actual cached-object painter, with patterned
  // pixels in both the initial viewport and a pan beyond its retained margin.
  const source=document.createElement('canvas');source.width=160;source.height=120;
  const imageData=new ImageData(source.width,source.height);
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
    const i=(y*source.width+x)*4;
    imageData.data[i]=(x*17+y*3)%256;imageData.data[i+1]=(x*5+y*19)%256;imageData.data[i+2]=(x*11+y*7)%256;imageData.data[i+3]=255;
  }
  source.getContext('2d').putImageData(imageData,0,0);
  const image=await createImageBitmap(source);image.complete=true;image.naturalWidth=source.width;image.naturalHeight=source.height;source.width=source.height=1;
  const asset={asset_url:'fixture:verified-immutable-image',display_width:800,display_height:600,
    anchor_start:{x:0,y:0},anchor_length:256,anchor_angle_rad:0};
  const imageFigure={...defaultFigure(3),image_assets:[asset]},imageObject=createObject(imageFigure,3,0,0),imageFrame=createFrame([imageObject]);
  const imageGroup={slot:0,obj:imageObject,fig:imageFigure,root:{x:0,y:0}};
  imageGroup.drawables=Array.from({length:4},(_,index)=>{
    const start={x:13.37+(index%2)*800,y:11.61+Math.floor(index/2)*600},end={x:start.x+256,y:start.y};
    return {type:'image',slot:0,obj:imageObject,fig:imageFigure,asset,start,end,points:[start,end],length:256,
      angle:0,bend:0,thickness:0,opacity:1,alpha:1,rgb:[255,255,255],seg:{segment_kind:'image'}};
  });
  const imageReport={...report,figure_types:[imageFigure],keyframes:[imageFrame]},imageGeometry={objects:new Map([[0,imageGroup]]),orderedObjects:[imageGroup],drawables:imageGroup.drawables,warnings:[]};
  const imageOptions={...options,report:imageReport,frame:imageFrame,geometry:imageGeometry,view:{scale:1}},imageResources={image:url=>url===asset.asset_url?image:null};
  onProgress({phase:'verified image crop renderer creation'});
  let croppedImage,completeImage;
  try{
    croppedImage=await renderer(imageResources);completeImage=await renderer(imageResources);
    onProgress({phase:'verified image crop paints'});
    croppedImage.resize(320,240,1);completeImage.resize(2200,1600,1);
    const croppedGroup=croppedImage.render(imageOptions).objects.get(0),completeGroup=completeImage.render(imageOptions).objects.get(0);
    const initial=pixels(croppedImage.canvas),difference=compare(initial,pixels(completeImage.canvas,320,240)),crop=croppedImage.artwork.get(croppedGroup),complete=completeImage.artwork.get(completeGroup);
    verify(Boolean(crop?.raster?.cropped)&&Boolean(complete)&&!complete.raster?.cropped&&crop.bytes<complete.bytes*.6,
      'Verified immutable images keep a bounded ordinary-zoom crop',{crop:rasterDetails(crop),complete:rasterDetails(complete)});
    verify(difference.max===0,'Verified image crop matches the complete artwork pixels exactly',difference);
    const moved={...imageOptions,view:{scale:1,x:-700,y:-500}};
    croppedImage.render(moved);completeImage.render(moved);
    const panned=pixels(croppedImage.canvas),panDifference=compare(panned,pixels(completeImage.canvas,320,240)),replacement=croppedImage.artwork.get(croppedGroup);
    verify(replacement!==crop&&replacement?.raster?.cropped&&crop.canvas.width===1&&crop.canvas.height===1,
      'Panning beyond a verified image crop replaces and releases obsolete pixels');
    verify(panDifference.max===0&&compare(initial,panned).changed>1000,
      'Panning beyond verified image crop coverage restores exact distinct artwork',panDifference);
    rows.push({name:'ordinary-zoom-crop',difference,panDifference,bytes:crop.bytes,completeBytes:complete.bytes});
  }finally{croppedImage?.destroy();completeImage?.destroy();image.close();}

  const drawing=createDrawingFigure({figureTypeId:2,celId:'cel-compatibility-regression'});
  const objects=Array.from({length:24},(_,i)=>createObject(figure,i+1,40+(i%8)*76,100+Math.floor(i/8)*130));
  objects.splice(12,0,createObject(drawing,100,220,130));
  const mixedFrame=createFrame(objects),mixed={version:5,canvas_width:640,canvas_height:480,fps:24,backgrounds:[],figure_types:[figure,drawing],keyframes:[mixedFrame]};
  const owner=new DrawingResources(mixed,{history:false});owner.busy=true;
  onProgress({phase:'drawing surface preparation'});
  const surface=await owner.surface(drawing);
  onProgress({phase:'drawing renderer creation'});
  const live=await renderer({drawing:f=>owner.presenter(f)}),full=await renderer({drawing:f=>owner.presenter(f)});
  const mixedOptions={report:mixed,frame:mixedFrame,geometry:buildGeometry(mixed,mixedFrame),view:{scale:1},cameraEnabled:false,vfxEnabled:false,onionFrames:[],clipToCanvas:false};
  const translations=new Map([[6,{x:19,y:-7}]]);
  try{
    onProgress({phase:'drawing gesture paints'});
    live.resize(640,480,1);full.resize(640,480,1);
    surface.store.set(0,0,new Uint8ClampedArray([20,80,220,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
    live.render(mixedOptions);live.render({...mixedOptions,liveEditing:true,dragTranslations:translations});
    const before=live.stats.sceneLayerReuses||0;
    translations.set(6,{x:23,y:-3});live.render({...mixedOptions,liveEditing:true,dragTranslations:translations});
    verify((live.stats.sceneLayerReuses||0)>before,'A static drawing cel permits retained gesture layers');
    const builds=live.stats.sceneLayerBuilds||0;
    surface.store.set(0,0,new Uint8ClampedArray([220,30,60,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
    live.render({...mixedOptions,liveEditing:true,dragTranslations:translations});full.render({...mixedOptions,dragTranslations:translations});
    let difference=compare(pixels(live.canvas),pixels(full.canvas));
    verify(difference.max<=2,'Drawing stamp changes replace retained layer pixels immediately',difference);
    verify((live.stats.sceneLayerBuilds||0)>builds,'A changed drawing expands the live painter range');
    const reuses=live.stats.sceneLayerReuses||0;
    surface.store.set(0,0,new Uint8ClampedArray([60,220,30,255]));owner.present(surface,{x:0,y:0,width:64,height:64});
    live.render({...mixedOptions,liveEditing:true,dragTranslations:translations});full.render({...mixedOptions,dragTranslations:translations});
    difference=compare(pixels(live.canvas),pixels(full.canvas));
    verify(difference.max<=2&&(live.stats.sceneLayerReuses||0)>reuses,'Further drawing edits repaint their live range while retaining other layers',difference);
    surface.store.delete(0,0);owner.present(surface,{x:0,y:0,width:64,height:64});
    live.render({...mixedOptions,liveEditing:true,dragTranslations:translations});full.render({...mixedOptions,dragTranslations:translations});
    difference=compare(pixels(live.canvas),pixels(full.canvas));
    verify(difference.max<=2,'Erasing a drawing during a gesture removes its pixels',difference);
    rows.push({name:'drawing-layer-invalidation',difference,builds:live.stats.sceneLayerBuilds,reuses:live.stats.sceneLayerReuses});
    onProgress({phase:'large-display layer paint'});
    // 5,000x4,000 would require 160 MB for two complete retained layers.
    live.resize(5000,4000,1);live.render(mixedOptions);live.render({...mixedOptions,liveEditing:true,dragTranslations:translations});
    verify(live.stats.sceneLayerBytes>0&&live.stats.sceneLayerBytes<=96*1024*1024,'Compact artwork retains bounded layers on a large display',live.stats.sceneLayerBytes);
    const retained=[live.sceneLayers.below.canvas,live.sceneLayers.above.canvas];live.clearSceneLayers();
    verify(retained.every(canvas=>canvas.width===1&&canvas.height===1),'Ending a retained layer lifetime releases its pixel surfaces');
  }finally{live.destroy();full.destroy();owner.dispose();}

  const simpleFrame=createFrame([createObject(figure,1,190,230)]),simple={...mixed,figure_types:[figure],keyframes:[simpleFrame]};
  const prepared=await renderer(),monitor=document.createElement('canvas');monitor.style.cssText='width:320px;height:240px';document.body.append(monitor);
  try{
    onProgress({phase:'prepared monitor paint'});
    prepared.resize(640,480,1);prepared.render({report:simple,frame:simpleFrame,view:{scale:1},cameraEnabled:true,vfxEnabled:false});
    const bitmap=await createImageBitmap(prepared.canvas),key=prepared.prepareFrame({softwareFrames:true,key:'1:0',cameraEnabled:true,hiddenKey:'hidden-2',uids:Uint32Array.of(1),compatibility:[{bitmap}]},{report:simple});bitmap.close();
    const entry=prepared.prepared.get(key),expected=document.createElement('canvas');
    const result=drawCameraMonitor(monitor,{report:simple,frame:simpleFrame,geometry:{get drawables(){throw Error('Prepared camera monitor evaluated figures.');}},
      prepared:{renderer:prepared,key,hiddenKey:'hidden-2'}});
    verify(result,'Compatibility camera monitor presents an admitted frame without evaluating figures');
    expected.width=monitor.width;expected.height=monitor.height;expected.getContext('2d').drawImage(entry.canvas,0,0,monitor.width,monitor.height);
    const difference=compare(pixels(monitor),pixels(expected));verify(difference.max===0,'Prepared compatibility monitor borrows the exact completed frame pixels',difference);
    verify(prepared.renderPreparedInto(key,{report:simple,hiddenKey:'changed',target:{context:monitor.getContext('2d')}})===false,'Prepared compatibility monitor rejects changed visibility');
    verify(prepared.renderPreparedInto(key,{report:simple,hiddenKey:'hidden-2',cameraEnabled:false,target:{context:monitor.getContext('2d')}})===false,'Prepared compatibility monitor rejects a different camera mode');
    rows.push({name:'prepared-software-monitor',difference});
  }finally{prepared.destroy();monitor.remove();}
  return {checks,rows};
}
