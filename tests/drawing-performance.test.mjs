import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingSmoother,MAX_SMOOTHING_SAMPLES} from '../src/drawing-smoother.mjs';
import {DrawingStroke} from '../src/drawing-pixels.mjs';
import {BrushStroke,normalizeBrush,dabShape} from '../src/drawing-brush.mjs';
import {TileStore} from '../src/drawing-tiles.mjs';
import {DrawingController} from '../src/drawing-controller.mjs';
import {StrokeEngine} from '../src/drawing-stroke-engine.mjs';
import {ReferenceSmoother} from './helpers/drawing-reference-smoother.mjs';

test('incremental smoothing matches the original centroid and release tail',()=>{
  for(const step of [0,.001,.25,12]){
    const a=new DrawingSmoother(45.6),b=new ReferenceSmoother(45.6);
    const close=(p,q)=>{for(const k of ['x','y','pressure','time'])assert.ok(Math.abs(p[k]-q[k])<1e-7,`${step}: ${k}: ${p[k]} != ${q[k]}`);};
    for(let i=0;i<3000;i++){const p={x:-1000+i*step,y:500+Math.sin(i/37)*step,pressure:.5+.4*Math.sin(i/20),time:100000+i*4};close(a.add(p),b.add(p));assert.equal(a.size,b.size);}
    while(a.size>1){a.shift();b.shift();close(a.value(),b.value());}
  }
});
test('stationary input retains bounded smoothing state',()=>{
  const a=new DrawingSmoother(48);
  for(let i=0;i<100000;i++)a.add({x:23,y:-12,pressure:.7,time:i});
  assert.equal(a.size,MAX_SMOOTHING_SAMPLES);assert.ok(a.points.length<MAX_SMOOTHING_SAMPLES*2);
  assert.deepEqual(a.value(),{x:23,y:-12,pressure:.7,time:100000-(MAX_SMOOTHING_SAMPLES+2)/3,ax:0,ay:0});
});
test('optimized smoothing preserves raster output for pressure, soft paint and erase',()=>{
  for(const erase of [false,true]){
    const stores=[new TileStore(),new TileStore()];
    if(erase)for(const s of stores)for(let x=-1;x<4;x++)s.set(x,0,new Uint8ClampedArray([70,100,190,180]));
    const strokes=stores.map(s=>new DrawingStroke(s,{size:12,stabilization:.8,hardness:.4,pressureOpacity:true,erase}));
    strokes[1].path.smoother=new ReferenceSmoother(.8*48);
    for(let i=0;i<400;i++)for(const s of strokes)s.sample({x:-10+i*.5,y:30+15*Math.sin(i/27),pressure:.2+.8*(i%71)/70,time:i*3});
    assert.deepEqual(strokes[0].finish(),strokes[1].finish());
  }
});
function controller(){
  const c=Object.create(DrawingController.prototype),messages=[];
  const owner={strokeWorker:{post:m=>messages.push(m)},present(){}};
  const s={id:1,pending:[],queue:[],qi:0,paths:[],brush:normalizeBrush({size:4,color:[200,40,60],opacity:.5,pressureSize:false}),sent:new Set(),before:new Map(),posted:new Map(),seq:0,outstanding:0,owner,surface:{store:new TileStore()}};
  Object.assign(c,{sessions:new Map([[1,s]]),owner,strokeStats:{batches:0,maxQueueDepth:0},onRender(){},cancel(){},onError(e){throw e;}});
  return {c,s,messages};
}
test('worker batches seed existing pixels along cross-batch bridges',()=>{
  const {c,s,messages}=controller(),engine=new StrokeEngine();
  for(let x=0;x<8;x++)s.surface.store.set(x,0,new Uint8ClampedArray([10,20,30,255]));
  const expected=s.surface.store.fork(),settings={size:4,color:[200,40,60],opacity:.5,pressureSize:false};
  const reference=new DrawingStroke(expected,settings),pipeline=new BrushStroke(settings,p=>s.pending.push(p));engine.begin(1,settings);
  for(const x of [10,230,450]){
    const point={x,y:30,pressure:1,time:x};reference.sample(point);pipeline.sample(point);s.outstanding=0;c.flushStroke(s);
    const m=messages.at(-1);engine.dabs(1,m.seq,m.dabs,m.tiles);
  }
  pipeline.finish();s.outstanding=0;c.flushStroke(s);const last=messages.at(-1);engine.dabs(1,last.seq,last.dabs,last.tiles);assert.deepEqual(engine.end(1),reference.finish());
});
test('backpressure keeps one bounded dab batch in flight and ends after its acknowledgement',()=>{
  const {c,s,messages}=controller();
  // A tip this size batches 512 dabs; smaller tips batch more per round trip.
  s.brush=normalizeBrush({size:40,color:[200,40,60],pressureSize:false});
  for(let i=0;i<1200;i++)s.pending.push(dabShape(s.brush,{x:i,y:20,pressure:1}));c.flushStroke(s);
  assert.equal(s.outstanding,1);assert.equal(messages[0].dabs.length,512);assert.equal(s.pending.length,688);
  s.ended=true;c.flushStroke(s);assert.equal(messages.length,1);
  for(let seq=1;seq<=3;seq++)c.strokeMessage({kind:'tiles',stroke:1,seq,tiles:[]});
  assert.deepEqual(messages.map(m=>m.kind),['dabs','dabs','dabs','end']);
  assert.equal(messages.filter(m=>m.kind==='dabs').flatMap(m=>m.dabs).length,1200);assert.equal(c.strokeStats.maxQueueDepth,1);
});
test('a long fast stroke with a fine brush queues samples instead of overflowing the dab queue',()=>{
  // The Pencil preset at 2× spaces its dabs a quarter pixel apart: this path
  // produces well over 65,536 dabs, which once cancelled the whole stroke.
  globalThis.requestAnimationFrame??=()=>0;globalThis.cancelAnimationFrame??=()=>{};
  const {c,s,messages}=controller();
  Object.assign(s,{brush:normalizeBrush({size:4,spacingRatio:.05,texture:.6,flow:.7,pressureSize:true}),mirrors:[p=>p],matrix:[1,0,0,1,0,0]});
  c.strokePaths(s);
  for(let i=0;i<=4000;i++)c.sampleStroke.call(Object.assign(Object.create(c),{gesture:{kind:'stroke',session:s},point:()=>({x:i*8,y:20+Math.sin(i/50)*30})}),{clientX:0,clientY:0,pointerType:'mouse',timeStamp:i});
  assert.ok(s.queue.length>4000,'samples wait in the compact input queue');
  let most=0,guard=0;s.ended=true;c.flushStroke(s);
  while(messages.at(-1)?.kind==='dabs'&&guard++<10000){most=Math.max(most,s.pending.length);c.strokeMessage({kind:'tiles',stroke:1,seq:messages.at(-1).seq,tiles:[]});}
  const dabs=messages.filter(m=>m.kind==='dabs').flatMap(m=>m.dabs);
  assert.equal(messages.at(-1).kind,'end');assert.ok(dabs.length>65536,`${dabs.length} dabs painted`);
  assert.ok(messages.filter(m=>m.kind==='dabs').every(m=>m.dabs.length<=s.batch),'every batch is bounded');
  assert.ok(most<s.batch*8,'pending dabs stay near one batch');
});
