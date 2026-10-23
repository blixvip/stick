import test from 'node:test';
import assert from 'node:assert/strict';
import {zoomRefinementSweep} from '../scripts/zoom-refinement-sweep.mjs';

async function measure({publishDuringReadback=false,publishDuringStableReadback=false,publishWhileWaiting=false,fittedMismatch=false,waitError=false}={}){
  const previous={document:globalThis.document,canvas:globalThis.OffscreenCanvas,
    performance:Object.getOwnPropertyDescriptor(globalThis,'performance')};
  const state={clock:0,ready:!publishDuringReadback&&!publishDuringStableReadback&&!publishWhileWaiting,created:[],copies:[],paints:[],waits:0};
  const key=`__zoomSweepTest${Math.random().toString(36).slice(2)}`;globalThis[key]=state;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>state.clock}});
  globalThis.document={createElement:()=>({})};
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;state.copies.push(this);}
    getContext(){return {
      drawImage:canvas=>{this.pixel=canvas.pixel;},
      getImageData:()=>{const data=new Uint8ClampedArray(this.width*this.height*4);
        for(let i=0;i<data.length;i+=4)data.set([this.pixel,this.pixel,this.pixel,255],i);
        return {data};}
    };}
  };
  state.publish=()=>{state.ready=true;state.invalidate?.();};
  const moduleURL=variant=>'data:text/javascript,'+encodeURIComponent(`
    export async function createRenderer(canvas){
      const state=globalThis[${JSON.stringify(key)}],variant=${JSON.stringify(variant)};let fences=0;
      const renderer={canvas,stats:{backend:'WebGPU',rasterizedObjects:0,
        artworkRefinement:{pending:0,bytes:0,completed:0,failed:0}},artworkBytes:16,artworkBudget:128,
        device:{addEventListener(){},queue:{async onSubmittedWorkDone(){
          fences++;
          if(${publishDuringReadback}&&variant==='current'&&!state.ready)state.publish();
          if(${publishDuringStableReadback}&&variant==='current'&&fences===3&&!state.ready)state.publish();
        }}},
        resize(width,height){canvas.width=width;canvas.height=height;},
        render(options){
          const fitted=options.view.scale<1;
          canvas.pixel=(state.ready?40:20)+(${fittedMismatch}&&variant==='current'&&fitted?1:0);
          state.paints.push({variant,fitted,ready:state.ready,changing:options.viewChanging});state.clock++;
        },async whenArtworkReady(){},destroy(){this.destroyed=true;}
      };state.created.push(renderer);return renderer;
    }`);
  const editor={tick:1,totalTicks:2,report:{canvas_width:100,canvas_height:100},
    evaluatedFrame:{},geometry:{objects:new Map(),drawables:[]},seek(tick){this.tick=tick;}};
  let unsubscribed=false;
  try{
    const result=await zoomRefinementSweep({editor,resources:{},ticks:[0],width:160,height:100,forceCanvas2D:false,
      baselineRendererURL:moduleURL('baseline'),currentRendererURL:moduleURL('current'),
      subscribeResources:invalidate=>{state.invalidate=invalidate;return()=>{state.invalidate=null;unsubscribed=true;};},
      waitResourcesReady:async()=>{state.waits++;if(waitError)throw new Error('Resource readiness failed.');
        if(publishWhileWaiting&&!state.ready)state.publish();}});
    return {result,state,originalTickRestored:editor.tick===1,unsubscribed};
  }finally{
    globalThis.document=previous.document;globalThis.OffscreenCanvas=previous.canvas;
    Object.defineProperty(globalThis,'performance',previous.performance);delete globalThis[key];
  }
}

test('sweep retains a raw publication race and checks resource-idle fitted parity',async()=>{
  const {result,state,originalTickRestored,unsubscribed}=await measure({publishDuringReadback:true});
  const row=result.rows[0];
  assert.equal(row.initialDifference.mean,15);assert.equal(row.rawInitialPassed,false);
  assert.deepEqual(row.initialReadbacks,[{variant:'baseline',repaintVersion:0},{variant:'current',repaintVersion:1}]);
  assert.equal(row.stableInitialDifference.max,0);assert.equal(row.stableInitialPassed,true);
  assert.deepEqual(row.stableInitialReadbacks,[{variant:'baseline',repaintVersion:1},{variant:'current',repaintVersion:1}]);
  assert.equal(row.baselineInitial.cpuMs,1);assert.equal(row.currentInitial.cpuMs,1);
  assert.equal(row.resourceCallbacks.length,2);assert.equal(result.passed,true);
  assert.equal(originalTickRestored,true);assert.equal(unsubscribed,true);
  assert.ok(state.created.every(renderer=>renderer.destroyed));
  assert.ok(state.copies.every(canvas=>canvas.width===1&&canvas.height===1));
});

test('sweep waits for derived resources before the untimed fitted recapture and zoom',async()=>{
  const {result,state}=await measure({publishWhileWaiting:true});const row=result.rows[0];
  assert.equal(row.initialDifference.max,0);assert.equal(row.rawInitialPassed,true);
  assert.equal(row.stableInitialDifference.max,0);assert.equal(row.stableInitialPassed,true);
  assert.equal(row.initialReadbacks[0].repaintVersion,0);assert.equal(row.stableInitialReadbacks[0].repaintVersion,1);
  assert.ok(state.waits>0);assert.ok(state.paints.filter(paint=>paint.changing).every(paint=>paint.ready));
  assert.equal(row.baselineGesture.cpuMs,1);assert.equal(row.currentGesture.cpuMs,1);assert.equal(result.passed,true);
});

test('sweep repeats the untimed pair if resources publish between its fitted readbacks',async()=>{
  const {result,state}=await measure({publishDuringStableReadback:true});const row=result.rows[0];
  assert.equal(row.rawInitialPassed,true);assert.equal(row.initialReadbacks[0].repaintVersion,0);
  assert.equal(row.stableInitialDifference.max,0);assert.equal(row.stableInitialPassed,true);
  assert.deepEqual(row.stableInitialReadbacks,[{variant:'baseline',repaintVersion:1},{variant:'current',repaintVersion:1}]);
  assert.equal(row.resourceCallbacks.length,2);assert.equal(result.passed,true);
  assert.ok(state.paints.filter(paint=>paint.fitted&&paint.ready).length>=4);
});

test('sweep rejects a stable fitted mismatch without relaxing its strict threshold',async()=>{
  const {result}=await measure({fittedMismatch:true});const row=result.rows[0];
  assert.equal(row.rawInitialPassed,false);assert.equal(row.stableInitialDifference.mean,.75);
  assert.equal(row.stableInitialPassed,false);assert.equal(row.settledDifference.max,0);assert.equal(row.finalDifference.max,0);
  assert.equal(result.meanTolerance,.02);assert.equal(result.alphaTolerance,1);
  assert.equal(result.passed,false);assert.deepEqual(result.failedTicks,[0]);
});

test('sweep retains raw evidence and releases renderers when the resource-idle barrier fails',async()=>{
  const {result,state,originalTickRestored,unsubscribed}=await measure({waitError:true});const row=result.rows[0];
  assert.equal(row.rawInitialPassed,true);assert.equal(row.initialDifference.max,0);
  assert.equal(row.error.message,'Resource readiness failed.');assert.equal(result.passed,false);
  assert.equal(originalTickRestored,true);assert.equal(unsubscribed,true);
  assert.ok(state.created.every(renderer=>renderer.destroyed));
  assert.ok(state.copies.every(canvas=>canvas.width===1&&canvas.height===1));
});
