import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {CameraVfx} from '../src/vfx-camera.mjs';
import {CameraGpuSource} from '../src/vfx-camera-gpu.mjs';
import {initVfxDevice,releaseVfxDevice} from '../src/vfx-gpu.mjs';

let previousCanvas,device;
class Canvas{
  constructor(width,height){this.width=width;this.height=height;this.context={canvas:this,images:[],
    save(){},restore(){},setTransform(){},beginPath(){},rect(){},clip(){},clearRect(){},
    drawImage(...args){this.images.push(args);},isContextLost(){return false;}};}
  getContext(kind){return kind==='2d'?this.context:null;}
}
beforeEach(()=>{
  previousCanvas=globalThis.OffscreenCanvas;globalThis.OffscreenCanvas=Canvas;
  device={limits:{maxTextureDimension2D:4096},lost:new Promise(()=>{})};initVfxDevice(device);
});
afterEach(()=>{releaseVfxDevice(device);globalThis.OffscreenCanvas=previousCanvas;});
const fixture=()=>({report:{canvas_width:800,canvas_height:400},frame:{objects:[],camera:{scale:3}},
  geometry:{objects:new Map(),orderedObjects:[],drawables:[]},cameraEnabled:false,view:{scale:1.04}});
const render=(camera,options,resources)=>{const output=new Canvas(960,432);camera.render(output.context,options,1,resources);return output;};

test('capped GPU camera samples final layout density once after a covered gesture',()=>{
  let resolution=1.189207115002721,queries=0,paints=0;
  const camera=new CameraVfx({getPaintRevision(){queries++;return resolution;},paint(context){paints++;context.canvas.pixels=resolution;}});
  const options=fixture(),resources={};
  try{
    render(camera,options,resources);assert.equal(camera.canvas.width,2048);assert.equal(camera.canvas.height,1024);
    assert.equal(paints,1);assert.equal(queries,1);
    for(let i=1;i<=32;i++)render(camera,{...options,viewChanging:true,view:{scale:1.04*Math.exp(2.4*i/32)}},resources);
    assert.equal(paints,1);assert.equal(queries,1,'Eased steps never inspect the viewport layout density.');
    resolution=13.454342644059432;
    const settled={...options,view:{scale:11.464103435867266}};
    render(camera,settled,resources);assert.equal(paints,2);assert.equal(queries,2);
    const fresh=new CameraVfx({getPaintRevision:()=>resolution,paint(context){context.canvas.pixels=resolution;}});
    try{render(fresh,settled,resources);assert.equal(camera.canvas.pixels,fresh.canvas.pixels,'Settled pixels use the same source density as a fresh final paint.');}
    finally{fresh.destroy();}
    for(let i=0;i<16;i++)render(camera,settled,resources);
    assert.equal(paints,2,'A published final source stays warm.');
    render(camera,{...settled,resourceRevision:1},resources);assert.equal(paints,3,'Resource changes still repaint immediately.');
  }finally{camera.destroy();}
});

test('vector-only capped sources never read raster density or repaint just for zoom',()=>{
  let queries=0,paints=0;
  const renderer={stats:{textureObjects:0,croppedTextureObjects:0,outlinedVectorObjects:0},get lastRasterResolution(){queries++;return 8;}};
  const source={renderer},camera=new CameraVfx({getPaintRevision:()=>CameraGpuSource.prototype.paintRevision.call(source),paint(){paints++;}});
  const options=fixture(),resources={};
  try{
    render(camera,options,resources);
    for(let i=1;i<=32;i++)render(camera,{...options,viewChanging:true,view:{scale:1.04*Math.exp(2.4*i/32)}},resources);
    render(camera,{...options,view:{scale:11.464103435867266}},resources);
    assert.equal(queries,0);assert.equal(paints,1);
  }finally{camera.destroy();}
});

test('prepared GPU sources preserve packet authority without querying editor layout',()=>{
  let queries=0,paints=0;
  const camera=new CameraVfx({getPaintRevision(){queries++;return 8;},paint(){paints++;}});
  const options={...fixture(),preparedFrame:{uids:[]}},resources={};
  try{
    render(camera,options,resources);
    for(let i=1;i<=32;i++)render(camera,{...options,viewChanging:true,view:{scale:1.04*Math.exp(2.4*i/32)}},resources);
    const final={...options,view:{scale:11.464103435867266}};
    render(camera,final,resources);assert.equal(queries,0);assert.equal(paints,1);
    render(camera,{...final,preparedFrame:{uids:[]}},resources);assert.equal(queries,0);assert.equal(paints,2);
  }finally{camera.destroy();}
});

test('GPU source density gate follows texture, crop and outline ownership scalars',()=>{
  let reads=0;
  const renderer={stats:{},get lastRasterResolution(){reads++;return 13.454342644059432;}},source={renderer};
  assert.equal(CameraGpuSource.prototype.paintRevision.call(source),undefined);assert.equal(reads,0);
  for(const key of ['textureObjects','croppedTextureObjects','outlinedVectorObjects']){
    renderer.stats={[key]:1};assert.equal(CameraGpuSource.prototype.paintRevision.call(source),13.454342644059432);
  }
  assert.equal(reads,3);
});

test('an uncapped GPU camera holds its painted density while an unchanged scene is navigated',()=>{
  let paints=0;
  const camera=new CameraVfx({getPaintRevision:()=>undefined,paint(){paints++;}});
  const options={...fixture(),frame:{objects:[],camera:{scale:1}},view:{scale:.4}},resources={};
  try{
    render(camera,options,resources);assert.equal(camera.canvas.width,320);assert.equal(paints,1);
    for(let i=1;i<=16;i++)render(camera,{...options,viewChanging:true,view:{scale:.4*4**(i/16)}},resources);
    assert.equal(paints,1,'Each zoom step below the size cap would otherwise repaint and upload the scene.');
    assert.equal(camera.canvas.width,320);
    render(camera,{...options,view:{scale:1.6}},resources);
    assert.equal(paints,2);assert.equal(camera.canvas.width,1280,'The settled view restores its requested density.');
    render(camera,{...options,viewChanging:true,view:{scale:.8}},resources);assert.equal(paints,2);
    render(camera,{...options,view:{scale:.8}},resources);assert.equal(paints,3);assert.equal(camera.canvas.width,640);
    // Changed content, editing and playback always paint at the density they request.
    const revised={...options,geometry:{objects:new Map(),orderedObjects:[],drawables:[]}};
    render(camera,{...revised,viewChanging:true,view:{scale:1.2}},resources);assert.equal(paints,4);assert.equal(camera.canvas.width,960);
    render(camera,{...revised,viewChanging:true,liveEditing:true,view:{scale:.6}},resources);assert.equal(paints,5);assert.equal(camera.canvas.width,480);
    render(camera,{...revised,viewChanging:true,playing:true,view:{scale:.5}},resources);assert.equal(paints,6);assert.equal(camera.canvas.width,400);
  }finally{camera.destroy();}
});
