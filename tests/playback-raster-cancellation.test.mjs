import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {createDemo} from '../src/demo.mjs';
import {createVfx} from '../src/vfx.mjs';

function globals(t, yieldTask = async () => {}) {
  for (const [key,value] of Object.entries({OffscreenCanvas:class {},scheduler:{yield:yieldTask}})) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key];});
  }
}
function imageScene() {
  const report=createDemo(),obj={unique_id:1},root={x:0,y:0};
  const item={type:'image',slot:0,obj,fig:{},seg:{},opacity:1,alpha:1,
    start:{x:8,y:8},end:{x:10,y:8},angle:0,points:[{x:8,y:8},{x:10,y:8}],
    asset:{display_width:2,display_height:2,anchor_length:2,anchor_angle_rad:0}};
  const group={slot:0,obj,root,drawables:[item]};
  const geometry={objects:new Map([[0,group]]),orderedObjects:[group],drawables:[item],warnings:[]};
  return {report,geometryCache:{get:()=>geometry}};
}

test('pure vector packets retain their preparation path without new graphics task yields',async t=>{
  let yields=0;globals(t,async()=>{yields++;});
  const packet=await compilePlaybackPacket(createDemo(),0);
  assert.ok(packet.shapes.length>0);assert.equal(packet.compatibility.length,0);
  assert.equal(yields,0,'A vector-only packet has no raster allocation or graphics copy to suspend.');
});

test('interaction observed during image preload prevents subsequent raster allocation',async t=>{
  globals(t);const {report,geometryCache}=imageScene();let stopped=false,allocations=0;
  const resources={async preload(){stopped=true;},rasterSurface(){allocations++;throw new Error('Late raster allocation');}};
  await assert.rejects(compilePlaybackPacket(report,0,{resources,geometryCache,sharedArtwork:false,cancelled:()=>stopped}),{name:'AbortError'});
  assert.equal(allocations,0);
});

test('first compatibility capture yields to interaction before acquiring its native surface',async t=>{
  let stopped=false,yields=0,allocations=0;globals(t,async()=>{yields++;stopped=true;});
  const {report,geometryCache}=imageScene(),pool={acquire(){allocations++;throw new Error('Late native acquisition');}};
  const resources={async preload(){},rasterSurface:()=>pool};
  await assert.rejects(compilePlaybackPacket(report,0,{resources,geometryCache,sharedArtwork:false,cancelled:()=>stopped}),{name:'AbortError'});
  assert.equal(yields,1);assert.equal(allocations,0);
});

test('an interaction during asynchronous bitmap copy closes the packet copy without publishing it',async t=>{
  globals(t);const {report,geometryCache}=imageScene();let stopped=false,closed=0,copies=0;
  const resources={async preload(){},rasterSurface:()=>({}),artworkBitmaps:{beginFrame(){},async packetBitmap(){
    copies++;stopped=true;return {width:8,height:8,close(){closed++;}};
  }}};
  await assert.rejects(compilePlaybackPacket(report,0,{resources,geometryCache,sharedArtwork:false,cancelled:()=>stopped}),{name:'AbortError'});
  assert.equal(copies,1);assert.equal(closed,1);
});

test('first software frame acquisition yields to pending foreground interaction',async t=>{
  let stopped=false,yields=0,allocations=0;globals(t,async()=>{yields++;stopped=true;});
  const resources={softwareFrame(){allocations++;throw new Error('Late frame acquisition');}};
  await assert.rejects(compilePlaybackPacket(createDemo(),0,{softwareFrames:true,resources,cancelled:()=>stopped}),{name:'AbortError'});
  assert.equal(yields,1);assert.equal(allocations,0);
});

test('software scene effects yield again before constructing or painting the native camera',async t=>{
  const report=createDemo();report.keyframes[0]._stykVfx={figure:[createVfx('blur','interaction-camera')]};
  let stopped=false,yields=0,cameras=0,releases=0;globals(t,async()=>{if(++yields===2)stopped=true;});
  const pool={release(){releases++;}},resources={softwareFrameSurfaces:pool,
    softwareFrame:()=>({surface:{},context:{}}),softwareCamera(){cameras++;throw new Error('Late camera creation');}};
  await assert.rejects(compilePlaybackPacket(report,0,{softwareFrames:true,resources,cancelled:()=>stopped}),{name:'AbortError'});
  assert.equal(yields,2);assert.equal(cameras,0);assert.equal(releases,1);
});
