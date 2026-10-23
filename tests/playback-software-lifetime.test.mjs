import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaybackWorkerEndpoint,PlaybackResources} from '../src/playback-worker.mjs';
import {createDemo} from '../src/demo.mjs';
import {withVfx,releaseVfxSoftwareResources} from '../src/vfx-canvas.mjs';
import {releaseVfxGPU} from '../src/vfx-gpu.mjs';
import {VfxCPU} from '../src/vfx-cpu.mjs';
import {createVfx} from '../src/vfx.mjs';

function softwareRealm() {
  const previousCanvas=globalThis.OffscreenCanvas,previousImageData=globalThis.ImageData,runPixels=VfxCPU.prototype.runPixels;
  const executors=[];
  globalThis.OffscreenCanvas=class {
    constructor(width,height) {
      this.width=width;this.height=height;
      this.context={canvas:this,draws:[],isContextLost(){return false;},getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};},
        setTransform(){},fillRect(){},clearRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},
        drawImage(source){this.draws.push(source);},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(){}};
    }
    getContext(kind){return kind==='webgl2'?null:this.context;}
  };
  globalThis.ImageData=class {constructor(data,width,height){this.data=data;this.width=width;this.height=height;}};
  VfxCPU.prototype.runPixels=function(pixels,width,height) {
    if(!executors.includes(this))executors.push(this);
    const slot=this.slot(0,width,height);slot.pixels.set(pixels);return {pixels:slot.pixels,width,height};
  };
  const target=new OffscreenCanvas(32,32),context=target.getContext('2d'),stack=[createVfx('blur','lifetime')];
  const bounds={x:0,y:0,width:16,height:16},paint=ctx=>ctx.fillRect(3,3,8,8);
  return {
    executors,target,
    warm(){
      withVfx(context,stack,paint,{bounds,cacheHint:'unchanged'});
      const retained=context.draws.at(-1);
      withVfx(context,stack,paint,{bounds});
      return {retained,scratch:context.draws.at(-1),executor:executors.at(-1)};
    },
    reused(){withVfx(context,stack,paint,{bounds,cacheHint:'unchanged'});return context.draws.at(-1);},
    restore(){releaseVfxSoftwareResources();releaseVfxGPU();VfxCPU.prototype.runPixels=runPixels;globalThis.OffscreenCanvas=previousCanvas;globalThis.ImageData=previousImageData;},
  };
}

test('playback document disposal releases shared software pixels while retained revisions keep reuse',()=>{
  const realm=softwareRealm(),messages=[],receive=createPlaybackWorkerEndpoint(message=>messages.push(message));
  try {
    receive({type:'load',revision:1,report:createDemo(),softwareFrames:true});
    const first=realm.warm();assert.ok(first.retained.width>1);assert.ok(first.scratch.width>1);assert.ok(first.executor.slots[0].pixels.length);
    assert.equal(realm.reused(),first.retained);
    receive({type:'invalidate',revision:2,retainDocument:true});
    receive({type:'interaction',active:true});
    assert.equal(realm.reused(),first.retained,'View retention and suspension keep the current document filter warm.');
    new PlaybackResources().dispose();
    assert.ok(first.executor.slots.length,'A generic main/export resource owner cannot release the worker realm executor.');
    receive({type:'invalidate',revision:3});
    assert.equal(first.executor.slots.length,0);assert.equal(first.retained.width,1);assert.equal(first.scratch.width,1);assert.equal(realm.target.width,32);
    receive({type:'load',revision:4,report:createDemo(),softwareFrames:true});
    const recovered=realm.warm();assert.notEqual(recovered.retained,first.retained);assert.equal(realm.executors.length,2);assert.ok(realm.executors[1].slots.length);
    assert.equal(messages.filter(message=>message.type==='load-error').length,0);
  } finally {receive({type:'invalidate',revision:5});realm.restore();}
});

test('direct and aborted chunked replacement snapshots end the previous software lifetime',()=>{
  const realm=softwareRealm(),messages=[],receive=createPlaybackWorkerEndpoint(message=>messages.push(message));
  try {
    receive({type:'load',revision:1,report:createDemo(),softwareFrames:true});
    const first=realm.warm();
    receive({type:'load',revision:2,report:createDemo(),softwareFrames:true});
    assert.equal(first.executor.slots.length,0);assert.equal(first.retained.width,1);assert.equal(first.scratch.width,1);
    const replacement=realm.warm(),executor=realm.executors.at(-1);
    receive({type:'load-chunk',revision:3,sequence:1,chunk:{header:{}},options:{softwareFrames:true}});
    assert.equal(executor.slots.length,0);assert.equal(replacement.retained.width,1);assert.equal(replacement.scratch.width,1);
    receive({type:'load-native-chunk',revision:3,sequence:2,position:0,buffer:new ArrayBuffer(0)});
    assert.equal(messages.at(-1).type,'load-error','An aborted incoming native snapshot never owns retained software pixels.');
    receive({type:'load-complete',revision:3,sequence:3});
    receive({type:'load',revision:4,report:createDemo(),softwareFrames:true});
    const recovered=realm.warm();assert.ok(recovered.retained.width>1);assert.ok(realm.executors.at(-1).slots.length);assert.equal(realm.executors.length,3);
  } finally {receive({type:'invalidate',revision:5});realm.restore();}
});

test('playback teardown releases shared software pixels even when a resource owner throws',()=>{
  const realm=softwareRealm(),dispose=PlaybackResources.prototype.dispose,receive=createPlaybackWorkerEndpoint(()=>{});
  try {
    receive({type:'load',revision:1,report:createDemo(),softwareFrames:true});
    const first=realm.warm();
    PlaybackResources.prototype.dispose=function(){throw Error('Resource teardown failed');};
    assert.throws(()=>receive({type:'invalidate',revision:2}),/Resource teardown failed/);
    assert.equal(first.executor.slots.length,0);assert.equal(first.retained.width,1);assert.equal(first.scratch.width,1);
  } finally {PlaybackResources.prototype.dispose=dispose;receive({type:'invalidate',revision:3});realm.restore();}
});
