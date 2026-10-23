import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {CameraVfx,cameraSceneAffine,cameraSceneCovers} from '../src/vfx-camera.mjs';
import {initVfxDevice,releaseVfxDevice,vfxSurfaceDimension} from '../src/vfx-gpu.mjs';
import {createLayerState} from '../src/layers.mjs';

let previousCanvas,device;
class Canvas {
  constructor(width,height){this.width=width;this.height=height;this.context={canvas:this,clears:0,images:[],globalAlpha:1,
    save(){},restore(){},translate(){},scale(){},transform(){},beginPath(){},rect(){},clip(){},fillRect(){},
    clearRect(){this.clears++;},setTransform(...matrix){this.matrix=matrix;},drawImage(...args){this.images.push(args);},
    getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};},isContextLost(){return false;}};}
  getContext(kind){return kind==='2d'?this.context:null;}
}
beforeEach(()=>{
  previousCanvas=globalThis.OffscreenCanvas;globalThis.OffscreenCanvas=Canvas;
  device={limits:{maxTextureDimension2D:4096},lost:new Promise(()=>{})};initVfxDevice(device);
});
afterEach(()=>{releaseVfxDevice(device);globalThis.OffscreenCanvas=previousCanvas;});
function fixture(){
  const group={obj:{unique_id:1},drawables:[]};
  const layers=createLayerState();layers.order.push('layer-2');layers.byId['layer-2']={name:'Other',visible:true,locked:false};
  return {report:{canvas_width:320,canvas_height:240,backgrounds:[{background_id:0,kind:2,color:0xff112233}],_styk:{layers}},frame:{objects:[],background_id:0},
    geometry:{objects:new Map([[0,group]]),orderedObjects:[group],drawables:[]},view:{x:0,y:0,scale:1}};
}
function run(camera,options,resources={}){const output=new Canvas(960,720);camera.render(output.context,options,1,resources);return output.context;}
function drawingFixture(){
  const options=fixture(),group=options.geometry.orderedObjects[0];
  const fig={_styk:{drawing:{version:2,celId:'cel-camera',revision:3}},image_assets:[{styk_tiles:'published-tiles'}]};
  const item={type:'image',slot:0,opacity:1,obj:group.obj,fig,asset:{anchor_length:0},seg:{}};
  group.drawables=options.geometry.drawables=[item];
  const drawing={id:'cel-camera',revision:3,stamp:1,pixelStamp:2,store:{},owner:{},published:{revision:3,url:'published-tiles'},deferred:[]};
  return {options,drawing,resources:{drawing:()=>drawing}};
}

test('hidden unsupported images do not invalidate covered native camera density',()=>{
  for(const hiddenBy of ['session','layer']){
    const camera=new CameraVfx(),options=fixture(),group=options.geometry.orderedObjects[0],resources={};
    const item={type:'image',slot:0,obj:group.obj,opacity:1,asset:{anchor_length:0},seg:{}};
    group.drawables=options.geometry.drawables=[item];
    if(hiddenBy==='session')options.hiddenUids=new Set([1]);
    else options.report._styk.layers.byId['layer-1'].visible=false;
    try{
      run(camera,options,resources);
      run(camera,{...options,viewChanging:true,view:{scale:2}},resources);
      assert.equal(camera.context.clears,1,`An image hidden by ${hiddenBy} cannot change camera pixels.`);
      assert.equal(camera.canvas.width,320);
      if(hiddenBy==='session')options.hiddenUids=new Set();
      else options.report._styk.layers.byId['layer-1'].visible=true;
      run(camera,{...options,viewChanging:true,view:{scale:2}},resources);
      assert.equal(camera.context.clears,2,'Making unsupported media visible requires immediate native preparation.');
      assert.equal(camera.canvas.width,640);
    }finally{camera.destroy();}
  }
});

test('covered camera navigation reprojects one completed source and settles at native target density',()=>{
  const camera=new CameraVfx(),options=fixture(),resources={};
  try{
    run(camera,options,resources);assert.equal(camera.context.clears,1);
    for(let step=1;step<=32;step++){
      const scale=1+step/16,output=run(camera,{...options,viewChanging:true,view:{scale,x:13.25,y:-7.5}},resources);
      assert.equal(camera.canvas.width,320);assert.equal(camera.canvas.height,240);
      assert.deepEqual(output.matrix,[scale,0,0,scale,13.25,-7.5]);
      assert.equal(output.images.at(-1)[3],320);assert.equal(output.images.at(-1)[4],240);
    }
    assert.equal(camera.context.clears,1,'Zooming should not repaint the complete native camera source.');
    run(camera,{...options,view:{scale:3,x:13.25,y:-7.5}},resources);
    assert.equal(camera.context.clears,2);assert.equal(camera.canvas.width,960);assert.equal(camera.canvas.height,720);
  }finally{camera.destroy();}
});

test('camera content, authority and editing changes paint immediately during navigation',()=>{
  const mutations=[
    options=>({...options,report:{...options.report}}),options=>({...options,frame:{...options.frame}}),
    options=>({...options,geometry:{...options.geometry}}),options=>({...options,preparedFrame:{uids:[1]}}),
    options=>({...options,artworkRevision:1}),options=>({...options,resourceRevision:1}),
    options=>({...options,hiddenUids:new Set([1])}),options=>({...options,dragTranslations:new Map([[1,{x:3,y:7}]])}),
    options=>({...options,cameraEnabled:false}),options=>({...options,liveEditing:true}),options=>({...options,playing:true}),
    options=>{options.frame.camera={x:7,y:-2,scale:1.1,angle_rad:.2};return options;},
    options=>{options.frame._stykBackgroundColor=0xff884422;return options;},
    options=>{options.report._styk.layers.byId['layer-1'].visible=false;return options;},
    options=>{options.report._styk.layers.byId['layer-1'].parallax={enabled:true,linked:true,x:.5,y:.5,reference:{x:0,y:0}};return options;},
    options=>{options.report._styk.layers.assignments['1']='layer-2';return options;},
    options=>{options.report.backgrounds[0].color=0xff998877;return options;},
    options=>{options.report._styk.layers.byId['layer-1'].visible=false;return options;},
    options=>{options.report._styk.layers.byId['layer-1'].parallax={enabled:true,linked:true,x:.5,y:.5,reference:{x:0,y:0}};return options;},
    options=>{options.report.canvas_width=400;return options;},
  ];
  for(const mutate of mutations){
    const camera=new CameraVfx(),options=fixture(),resources={};
    try{run(camera,options,resources);run(camera,{...mutate(options),viewChanging:true,view:{scale:2}},resources);
      assert.equal(camera.context.clears,2,'Changed content must bypass the retained density.');
      assert.ok(camera.canvas.width>320);
    }finally{camera.destroy();}
  }
  const camera=new CameraVfx(),options=fixture();
  try{run(camera,options,{});run(camera,{...options,viewChanging:true,view:{scale:2}},{});assert.equal(camera.context.clears,2);}
  finally{camera.destroy();}
});

test('cold sources and image-bearing camera scenes keep immediate native density',()=>{
  for(const withImage of [false,true]){
    const camera=new CameraVfx(),options=fixture(),resources={};
    if(withImage){const item={type:'image',slot:0,opacity:1,obj:{unique_id:1},asset:{anchor_length:0}};
      options.geometry.drawables=[item];options.geometry.orderedObjects[0].drawables=[item];}
    try{
      run(camera,{...options,viewChanging:true,view:{scale:2}},resources);assert.equal(camera.canvas.width,640);
      run(camera,{...options,viewChanging:true,view:{scale:3}},resources);
      assert.equal(camera.context.clears,withImage?2:1);
      assert.equal(camera.canvas.width,withImage?960:640);
    }finally{camera.destroy();}
  }
  const camera=new CameraVfx(),options=fixture(),resources={};
  options.report.backgrounds=[{background_id:1,kind:1,data_url:'data:image/png;base64,fixture'}];options.frame.background_id=1;
  try{run(camera,options,resources);run(camera,{...options,viewChanging:true,view:{scale:2}},resources);
    assert.equal(camera.canvas.width,640);assert.equal(camera.context.clears,2);
  }finally{camera.destroy();}
});

test('connected child layer bindings invalidate retained camera content',()=>{
  const camera=new CameraVfx(),options=fixture(),resources={};
  options.geometry.objects.set(1,{obj:{unique_id:2},drawables:[]});
  try{run(camera,options,resources);options.report._styk.layers.assignments['2']='layer-2';
    run(camera,{...options,viewChanging:true,view:{scale:2}},resources);
    assert.equal(camera.context.clears,2,'A child outside compressed painter groups changed layers.');
    assert.equal(camera.canvas.width,640);
  }finally{camera.destroy();}
});

test('paint-backed GPU camera preparation holds its density during navigation and restores it on settlement',()=>{
  const painted=[],camera=new CameraVfx({paint(_context,_options,width,height){painted.push([width,height]);}}),options=fixture(),resources={};
  try{run(camera,options,resources);run(camera,{...options,viewChanging:true,view:{scale:2}},resources);
    assert.deepEqual(painted,[[320,240]],'Repainting below the size cap moves the scene through Canvas on every zoom step.');
    run(camera,{...options,view:{scale:2}},resources);
    assert.deepEqual(painted,[[320,240],[640,480]]);
  }finally{camera.destroy();}
});

test('a camera source keeps native density without a graphics effect executor',()=>{
  releaseVfxDevice(device);assert.equal(vfxSurfaceDimension(),0);
  const camera=new CameraVfx(),options=fixture(),resources={};
  try{run(camera,options,resources);assert.equal(camera.canvas.width,320);assert.equal(camera.canvas.height,240);}
  finally{camera.destroy();}
});

test('prepared GPU camera frames do not scan unused editable image geometry',()=>{
  let paints=0;const camera=new CameraVfx({paint(){paints++;}}),options=fixture();
  options.preparedFrame={uids:[]};options.geometry={get orderedObjects(){throw Error('Unused editable image scan');},
    get objects(){throw Error('Unused editable layer scan');}};
  try{run(camera,options,{});assert.equal(paints,1);assert.equal(camera.canvas.width,320);}
  finally{camera.destroy();}
});

test('CameraVfx borrows published ownership through settled refinement, adoption and eviction',()=>{
  let entry,request,releases=0;const options=fixture(),resources={},camera=new CameraVfx({getSource:()=>entry,
    releaseSource(){releases++;if(entry){entry.destroyed=true;entry.bitmap?.close();if(entry.canvas)entry.canvas.width=entry.canvas.height=1;entry=null;}},
    retainSource(cameraSource){return entry={canvas:cameraSource.canvas,cameraSource};},refine(spec){request=spec;return true;}});
  try{
    run(camera,options,resources);assert.equal(camera.context.clears,1);assert.equal(camera.sourceOwned,false);
    run(camera,{...options,viewChanging:true,view:{scale:2}},resources);assert.equal(entry.deferDensity,true);
    const settled=run(camera,{...options,view:{scale:2}},resources);assert.equal(camera.context.clears,1);
    assert.equal(settled.images.at(-1)[0],entry.canvas);assert.ok(request.valid());assert.equal(request.target.width,640);
    const old=entry;old.destroyed=true;old.canvas.width=old.canvas.height=1;let closed=0;
    const bitmap={width:640,height:480,close(){closed++;}};entry={bitmap,cameraSource:request.target};
    const adopted=run(camera,{...options,view:{scale:2}},resources);assert.equal(camera.context.clears,1);
    assert.equal(adopted.images.at(-1)[0],bitmap);assert.equal(adopted.images.at(-1)[3],640);
    run(camera,{...options,viewChanging:true,view:{scale:3}},resources);assert.equal(request.valid(),false);
    entry.destroyed=true;bitmap.close();entry=null;
    run(camera,{...options,view:{scale:3}},resources);assert.equal(camera.context.clears,2);assert.equal(camera.canvas.width,960);
    assert.equal(closed,1,'Only the published owner closes the adopted bitmap.');assert.ok(releases>=2);
  }finally{camera.destroy();}
});

test('unadmitted native camera sources retain ordinary reuse and changed content bypasses pending refinement',()=>{
  const options=fixture(),resources={};let entry,requested=0,released=0;
  const camera=new CameraVfx({getSource:()=>entry,releaseSource(){released++;entry=null;},retainSource(){return null;},refine(){requested++;return true;}});
  try{run(camera,options,resources);run(camera,options,resources);assert.equal(camera.context.clears,1);assert.equal(camera.sourceOwned,true);}
  finally{camera.destroy();}
  const owned=new CameraVfx({getSource:()=>entry,releaseSource(){released++;entry=null;},retainSource(source){return entry={canvas:source.canvas,cameraSource:source};},refine(){requested++;return true;}});
  try{run(owned,options,resources);run(owned,{...options,viewChanging:true,view:{scale:2}},resources);
    options.frame._stykBackgroundColor=0xff778899;run(owned,{...options,view:{scale:2}},resources);
    assert.equal(owned.context.clears,2);assert.equal(requested,0);assert.ok(released>=2);
  }finally{owned.destroy();}
});

test('published drawing scene gestures and pending jobs compare pixels without promoting an incomplete native source',()=>{
  const {options,drawing,resources}=drawingFixture();let entry,request,requested=0,closed=0;
  const camera=new CameraVfx({getSource:()=>entry,
    releaseSource(){if(entry){entry.bitmap?.close();entry=null;}},
    retainSource(cameraSource){return entry={canvas:cameraSource.canvas,cameraSource};},
    refine(spec){requested++;request=spec;return true;}});
  try{
    run(camera,options,resources);assert.equal(entry.cameraSource.drawingInputs[0].published,false);
    const initial=entry;drawing.stamp++;
    run(camera,{...options,viewChanging:true},resources);
    assert.equal(camera.context.clears,1);assert.equal(entry,initial);assert.equal(entry.deferDensity,true);
    assert.equal(entry.cameraSource.drawingInputs[0].stamp,1,'Temporary gesture reuse keeps the cold native dependency.');
    run(camera,options,resources);assert.equal(camera.context.clears,1);assert.equal(requested,1);
    assert.equal(request.target.width,initial.cameraSource.width,'A completed preview requests a full capture even at unchanged density.');
    assert.equal(request.target.drawingInputs[0].published,true);assert.ok(request.valid());
    assert.equal(entry.cameraSource.drawingInputs[0].published,false,'Only bitmap adoption can promote publication authority.');
    drawing.stamp++;run(camera,options,resources);assert.ok(request.valid());assert.equal(camera.context.clears,1);
    const bitmap={width:request.target.width,height:request.target.height,close(){closed++;}};
    entry={bitmap,cameraSource:request.target};initial.canvas.width=initial.canvas.height=1;
    run(camera,options,resources);drawing.stamp++;run(camera,options,resources);
    assert.equal(camera.context.clears,1);assert.equal(entry.bitmap,bitmap);assert.equal(entry.cameraSource.drawingInputs[0].published,true);
    drawing.pixelStamp++;assert.equal(request.valid(),false);
    run(camera,{...options,viewChanging:true,view:{scale:2}},resources);
    assert.equal(camera.context.clears,2);assert.equal(closed,1);assert.equal(entry.cameraSource.drawingInputs[0].published,false);
  }finally{camera.destroy();}
});

test('a derived preview completing at a settled cold view requests the published capture instead of repainting',()=>{
  const {options,drawing,resources}=drawingFixture();let entry,request,requested=0;
  const camera=new CameraVfx({getSource:()=>entry,releaseSource(){entry=null;},
    retainSource(cameraSource){return entry={canvas:cameraSource.canvas,cameraSource};},refine(spec){requested++;request=spec;return true;}});
  try{
    run(camera,options,resources);const initial=entry;assert.equal(camera.context.clears,1);assert.equal(requested,0,'An unchanged cold scene needs no capture.');
    run(camera,options,resources);assert.equal(requested,0);
    // No navigation happened: the preview worker finished under unchanged published tiles.
    drawing.stamp++;run(camera,options,resources);
    assert.equal(camera.context.clears,1,'The displayed scene is held rather than repainted on the UI thread.');
    assert.equal(requested,1);assert.equal(entry,initial);assert.equal(entry.deferDensity,true);
    assert.equal(request.target.width,initial.cameraSource.width);assert.equal(request.target.drawingInputs[0].published,true);assert.ok(request.valid());
    assert.equal(entry.cameraSource.drawingInputs[0].published,false,'Only bitmap adoption can promote publication authority.');
    // Editing and changed published pixels keep their immediate paint.
    run(camera,{...options,liveEditing:true},resources);assert.equal(camera.context.clears,2);assert.equal(request.valid(),false);
    drawing.stamp++;drawing.pixelStamp++;run(camera,options,resources);assert.equal(camera.context.clears,3);assert.equal(requested,1);
  }finally{camera.destroy();}
});

test('drawing publication and live ownership changes reject pending scene captures immediately',()=>{
  const mutations=[
    drawing=>{drawing.pinned=true;},drawing=>{drawing.transient=true;},drawing=>{drawing.loading={};},
    drawing=>{drawing.deferred=[{}];},drawing=>{drawing.pixelStamp++;},drawing=>{drawing.revision++;},
    drawing=>{drawing.published={revision:2,url:'published-tiles'};},drawing=>{drawing.published={revision:3,url:'other'};},
    drawing=>{drawing.store={};},drawing=>{drawing.owner={};},drawing=>{drawing.disposed=true;},
  ];
  for(const mutate of mutations){
    const {options,drawing,resources}=drawingFixture();options.frame._stykBackgroundColor=0;let entry,request;
    const camera=new CameraVfx({getSource:()=>entry,releaseSource(){entry=null;},
      retainSource(cameraSource){return entry={canvas:cameraSource.canvas,cameraSource};},refine(spec){request=spec;return true;}});
    try{
      run(camera,options,resources);drawing.stamp++;run(camera,{...options,viewChanging:true},resources);
      run(camera,options,resources);assert.ok(request.valid());
      mutate(drawing);assert.equal(request.valid(),false,'A current published pixel/owner change cannot install stale pixels.');
      run(camera,{...options,viewChanging:true},resources);assert.equal(camera.context.clears,2,String(mutate));
    }finally{camera.destroy();}
  }
});

test('rejected scene jobs and legacy/GPU drawing cameras retain immediate live-preview invalidation',()=>{
  const {options,drawing,resources}=drawingFixture();let entry,requested=0;
  const camera=new CameraVfx({getSource:()=>entry,releaseSource(){entry=null;},
    retainSource(cameraSource){return entry={canvas:cameraSource.canvas,cameraSource};},refine(){requested++;return false;}});
  try{
    run(camera,options,resources);drawing.stamp++;run(camera,{...options,viewChanging:true},resources);
    assert.equal(camera.context.clears,1);run(camera,options,resources);assert.equal(camera.context.clears,2);assert.equal(requested,1);
    assert.equal(entry.cameraSource.drawingInputs[0].published,false);
    drawing.stamp++;run(camera,options,resources);assert.equal(camera.context.clears,3);
  }finally{camera.destroy();}
  for(const gpu of [false,true]){
    let paints=0;const legacy=new CameraVfx(gpu?{paint(){paints++;}}:{});
    try{
      run(legacy,options,resources);drawing.stamp++;run(legacy,{...options,viewChanging:true},resources);
      assert.equal(gpu?paints:legacy.context.clears,2);assert.equal(legacy.drawingInputs[0].published,false);
    }finally{legacy.destroy();}
  }
});

test('camera image coverage follows the projected artboard, including a transformed world-view camera',()=>{
  const report={canvas_width:320,canvas_height:240},frame={objects:[]};
  const centered=scale=>({x:480-160*scale,y:360-120*scale,scale});
  assert.equal(cameraSceneCovers({report,frame,view:centered(1)},1,960,720),false,'A fitted view shows space around the artboard.');
  assert.equal(cameraSceneCovers({report,frame,view:centered(3)},1,960,720),false,'Exact edge alignment keeps object painting for the antialiased border.');
  assert.equal(cameraSceneCovers({report,frame,view:centered(3.1)},1,960,720),true);
  assert.equal(cameraSceneCovers({report,frame,view:centered(3.1)},2,1920,1440),true,'Device pixel ratio scales both the image and the canvas.');
  assert.equal(cameraSceneCovers({report,frame,view:{x:480-160*8+900,y:360-120*8,scale:8}},1,960,720),false,'Panning past the edge exposes objects again.');
  assert.deepEqual(cameraSceneAffine({report,frame,view:{x:5,y:7,scale:2}},2),[4,0,0,4,10,14]);
  // In the neutral editor view the image follows the document camera.
  const moved={objects:[],camera:{x:400,y:0,scale:1,angle_rad:0}},world={report,frame:moved,view:centered(8),cameraEnabled:false};
  assert.equal(cameraSceneAffine(world,1)[4],centered(8).x+400*8);
  assert.equal(cameraSceneCovers(world,1,960,720),false,'A camera framing another region does not cover this viewport.');
  assert.equal(cameraSceneCovers({...world,cameraEnabled:true},1,960,720),true,'The camera view presents the image at the artboard.');
  const turned={objects:[],camera:{x:0,y:0,scale:1,angle_rad:Math.PI/4}};
  assert.equal(cameraSceneCovers({report,frame:turned,view:centered(3.1),cameraEnabled:false},1,960,720),false,'A rotated image leaves viewport corners uncovered.');
  assert.equal(cameraSceneCovers({report,frame:turned,view:centered(12),cameraEnabled:false},1,960,720),true);
  assert.equal(cameraSceneCovers({report,frame,view:centered(8),cameraEnabled:false},1,0,720),false);
});
