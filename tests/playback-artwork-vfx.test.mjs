import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {createDemo} from '../src/demo.mjs';
import {createVfx,vfxPadding} from '../src/vfx.mjs';

function globals(t) {
  for (const [key,value] of Object.entries({OffscreenCanvas:class {},scheduler:{yield:async()=>{}}})) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key];});
  }
}
const glow=()=>{const effect=createVfx('glow','glow');effect.params.radius=12;return effect;};
/** One image that paints through Canvas, 40 units wide and centered at `x`. */
function imageScene(x,{owner,figure}={}) {
  const report=createDemo(),obj={unique_id:1,scale:1,...(figure?{_stykVfx:{figure}}:{})},root={x,y:100};
  const item={type:'image',slot:0,obj,fig:{},seg:{},opacity:1,alpha:1,
    start:{x:x-20,y:100},end:{x:x+20,y:100},angle:0,points:[{x:x-20,y:80},{x:x+20,y:80},{x:x+20,y:120},{x:x-20,y:120}],
    asset:{display_width:40,display_height:40,anchor_length:40,anchor_angle_rad:0},...(owner?{_movieclipOwner:owner,_movieclipPart:0}:{})};
  const group={slot:0,obj,root,drawables:[item]};
  const geometry={objects:new Map([[0,group]]),orderedObjects:[group],drawables:[item],warnings:[]};
  return {report,geometryCache:{get:()=>geometry}};
}
/** Record what the packet asks the surface to paint, without native pixels. */
function resources() {
  const painted=[];
  return {painted,async preload(){},imageKey:()=>'',rasterSurface:()=>({}),
    artworkBitmaps:{beginFrame(){},async packetBitmap(key,rasterize){painted.push({key,rasterize});return {width:8,height:8,close(){}};}}};
}
const compile=(scene,options)=>compilePlaybackPacket(scene.report,0,{geometryCache:scene.geometryCache,sharedArtwork:false,resources:resources(),...options});

test('a packet for a WebGPU presenter carries separable effect artwork unfiltered with its stack',async t=>{
  globals(t);
  for(const [name,extra,scale] of [['figure stack',{figure:[glow()]},1],['movieclip owner',{owner:{opacity:1,effects:[glow()],scale:2}},2]]){
    const packet=await compile(imageScene(200,extra),{gpuIsolation:true});
    assert.equal(packet.compatibility.length,1,name);
    const [entry]=packet.compatibility;
    assert.ok(entry.bitmap,name);
    assert.deepEqual(entry.vfx.stack.map(effect=>effect.id),['glow'],name);
    assert.equal(entry.vfx.scale,scale,name);
    // The domain is the artwork itself; the raster bounds add the effect halo.
    assert.ok(entry.vfx.domain.width<entry.bounds.width&&entry.vfx.domain.width>=40,name);
    assert.ok(entry.bounds.x<entry.vfx.domain.x&&entry.bounds.x+entry.bounds.width>entry.vfx.domain.x+entry.vfx.domain.width,name);
  }
});

test('other presenters and inseparable effects keep filtering inside the packet painter',async t=>{
  globals(t);
  const software=await compile(imageScene(200,{figure:[glow()]}),{gpuIsolation:false});
  assert.equal(software.compatibility.length,1);assert.equal(software.compatibility[0].vfx,undefined);
  const translucent=await compile(imageScene(200,{owner:{opacity:.5,effects:[glow()],scale:1}}),{gpuIsolation:true});
  assert.equal(translucent.compatibility[0].vfx,undefined,'Owner opacity composites after its effects.');
  const plain=await compile(imageScene(200),{gpuIsolation:true});
  assert.equal(plain.compatibility[0].vfx,undefined);
});

test('a cropped unfiltered source keeps the artwork its effects sample beyond the artboard',async t=>{
  globals(t);
  // Centered on the left artboard edge: half of the image lies outside the camera.
  const scene=()=>imageScene(0,{figure:[glow()]});
  const deferred=(await compile(scene(),{gpuIsolation:true})).compatibility[0];
  const filtered=(await compile(scene(),{gpuIsolation:false})).compatibility[0];
  assert.ok(deferred.vfx&&!filtered.vfx);
  const padding=vfxPadding([glow()],1);
  assert.ok(padding>0);
  assert.ok(filtered.bounds.x>-padding/2,'The packet painter samples beyond its own crop.');
  assert.ok(deferred.bounds.x<=-padding+1e-6,`The device filters only what it receives (${deferred.bounds.x} vs ${-padding}).`);
  assert.ok(deferred.bounds.x>-20-padding-8,'The crop still omits artwork no visible pixel samples.');
});
