import test from 'node:test';
import assert from 'node:assert/strict';
import {zoomGestureBenchmark} from '../scripts/zoom-gesture-benchmark.mjs';

test('zoom measurement observes gesture and late steady tasks while excluding initial work',async()=>{
  const previous={document:globalThis.document,canvas:globalThis.OffscreenCanvas,
    observer:globalThis.PerformanceObserver,performance:Object.getOwnPropertyDescriptor(globalThis,'performance')};
  const state={clock:0,observer:null,painted:[],destroyed:false};globalThis.__zoomGestureBenchmarkTest=state;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>state.clock}});
  globalThis.document={createElement:()=>({})};
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4)})};}
  };
  globalThis.PerformanceObserver=class {
    static supportedEntryTypes=['longtask'];
    constructor(){this.records=[];state.observer=this;}
    observe(){this.active=true;}
    takeRecords(){return this.records.splice(0);}
    disconnect(){this.active=false;this.disconnectedAfter=state.painted.at(-1);}
  };
  const source=`export async function createRenderer(canvas){
    const state=globalThis.__zoomGestureBenchmarkTest;let finalPaints=0;
    const emit=(name,duration)=>{
      state.painted.push(name);
      if(state.observer?.active)state.observer.records.push({name,startTime:state.clock,duration});
      state.clock+=duration;
    };
    return {canvas,stats:{backend:'Canvas test',rasterizedObjects:0,
      artworkRefinement:{pending:0,bytes:0,completed:0,failed:0,cancelled:0}},artworkBytes:16,artworkBudget:128,
      resize(width,height){canvas.width=width;canvas.height=height;},
      render(options){
        if(options.viewChanging)emit('gesture-block',60);
        else if(options.view.scale<1)emit('initial-block',75);
        else {finalPaints++;if(finalPaints===1)emit('settle-block',55);if(finalPaints===18)emit('steady-last-block',65);}
      },destroy(){state.destroyed=true;}};
  }`;
  try{
    const result=await zoomGestureBenchmark({rendererURL:'data:text/javascript,'+encodeURIComponent(source),forceCanvas2D:true,
      report:{canvas_width:100,canvas_height:100},frame:{},geometry:{objects:new Map(),drawables:[]},
      width:160,height:100,steps:1,defer:true,awaitRefinement:true});
    assert.deepEqual(result.gestureLongTasks.map(task=>[task.name,task.phase,task.ms]),[['gesture-block','gesture',60]]);
    assert.deepEqual(result.refinement.longTasks.map(task=>[task.name,task.phase]),[['settle-block','settle']]);
    assert.deepEqual(result.postSettlementLongTasks.map(task=>[task.name,task.phase]),[['steady-last-block','steady']]);
    assert.equal(result.interactionLongTasks.length,3);
    assert.ok(result.interactionLongTasks.every(task=>task.name!=='initial-block'));
    assert.equal(result.interactionPhaseBounds[0].start,75);
    assert.equal(state.observer.disconnectedAfter,'steady-last-block');assert.equal(state.observer.active,false);
    assert.equal(state.destroyed,true);assert.equal(result.refinement.longTasksSupported,true);
    assert.equal(result.refinement.peakPublishedBytes,16);
  }finally{
    globalThis.document=previous.document;globalThis.OffscreenCanvas=previous.canvas;
    globalThis.PerformanceObserver=previous.observer;Object.defineProperty(globalThis,'performance',previous.performance);
    delete globalThis.__zoomGestureBenchmarkTest;
  }
});
