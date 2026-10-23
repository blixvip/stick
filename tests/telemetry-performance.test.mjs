import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyPerformance,recordPerformance,mergePerformance,validatePerformance,trimPerformance,PERFORMANCE_METRICS,performancePercentile,provenance,performanceContext} from '../src/telemetry-performance-schema.mjs';
import {PerformanceMeasurements} from '../src/telemetry-performance.mjs';
import {GpuTiming,requestInstrumentedDevice} from '../src/gpu-timing.mjs';

test('diagnostics retain finer fast-action quantiles and reject malformed or private dimensions',()=>{
  const perf=emptyPerformance();for(const value of [8,12,16,20,25])recordPerformance(perf,'action_edit',value);
  assert.equal(performancePercentile(perf.rows[0]),25);assert.deepEqual(validatePerformance(perf),perf);
  const bad=structuredClone(perf);bad.rows[0].context.document='private.styk';assert.throws(()=>validatePerformance(bad));
  bad.rows[0].context=performanceContext();bad.rows[0].buckets[0]++;assert.throws(()=>validatePerformance(bad));
  assert.equal(JSON.stringify(perf).includes('private'),false);
});
test('bounded diagnostic families and byte budgets expose dropped coverage through merges',()=>{
  const perf=emptyPerformance();
  for(let i=0;i<100;i++)for(const metric of Object.keys(PERFORMANCE_METRICS))recordPerformance(perf,metric,12,{features:i%32});
  assert.ok(perf.rows.length<=48);assert.ok(perf.coverage.dropped>0);trimPerformance(perf);
  assert.ok(JSON.stringify(perf).length<=16000);assert.doesNotThrow(()=>validatePerformance(perf));
  const merged=emptyPerformance();mergePerformance(merged,perf,provenance({release:'0.6.0',build:'a'.repeat(12),traffic:'external'}));
  assert.ok(merged.rows.every(row=>row.provenance.release==='0.6.0'));
  assert.ok(merged.coverage.dropped>=perf.coverage.dropped);
});
test('fast actions are sampled, unresolved actions and background boundaries are explicit',()=>{
  let time=0;const collector={consent:{diagnostics:true}},meter=new PerformanceMeasurements(collector,{now:()=>time,random:()=>0});
  meter.action('edit');time=12;meter.frame(2,{},true);
  const row=meter.data.rows.find(row=>row.metric==='action_edit');assert.equal(row.count,1);assert.equal(row.sum,12);assert.equal(row.eligible,1);
  meter.action('pan');meter.boundary();assert.equal(meter.data.coverage.action_unpresented,1);
  collector.consent.diagnostics=false;const before=JSON.stringify(meter.data);meter.frame(500,{camera:400},true);meter.action('edit');assert.equal(JSON.stringify(meter.data),before);
});
test('recovery outcome and incident summaries retain durations without paths or browser invokers',()=>{
  let time=0;const meter=new PerformanceMeasurements({consent:{diagnostics:true}},{now:()=>time,random:()=>0});
  meter.recovery('gpu','started');meter.recovery('gpu','started');time=1500;meter.recovery('gpu','recovered');
  assert.equal(meter.data.rows.filter(row=>row.metric==='recovery_gpu').length,2);assert.equal(meter.data.rows.find(row=>row.context.outcome==='recovered').sum,1500);
  meter.loaf([{startTime:0,duration:300,styleAndLayoutStart:280,scripts:[{duration:200,sourceURL:'file:///private/name/app.mjs',invoker:'SECRET'}]}]);
  assert.ok(!JSON.stringify(meter.data).match(/private|SECRET/));assert.equal(meter.data.rows.find(row=>row.metric==='loaf_script').context.source,'app');
  assert.doesNotThrow(()=>validatePerformance(meter.drain()));
});
test('GPU timestamps keep one readback in flight and discard results after withdrawal',async()=>{
  globalThis.GPUBufferUsage={QUERY_RESOLVE:1,COPY_SRC:2,COPY_DST:4,MAP_READ:8};globalThis.GPUMapMode={READ:1};
  let enabled=true,resolveMap,allocations=0,results=[];
  const buffer={mapAsync:()=>new Promise(resolve=>resolveMap=resolve),getMappedRange:()=>new BigUint64Array([1000n,2001000n]).buffer,unmap(){},destroy(){}};
  const device={features:new Set(['timestamp-query']),createQuerySet:()=>({destroy(){}}),createBuffer:()=>{allocations++;return buffer;}};
  const timer=new GpuTiming(device,{enabled:()=>enabled,onTiming:n=>results.push(n)});
  const writes=timer.begin(true);assert.ok(writes);assert.equal(timer.begin(true),undefined);assert.equal(allocations,2);
  timer.submitted(writes);enabled=false;resolveMap();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(results,[]);assert.equal(timer.busy,false);timer.destroy();
  delete globalThis.GPUBufferUsage;delete globalThis.GPUMapMode;
});
test('optional GPU timing failure preserves the hardware renderer',async()=>{
  const calls=[],device={};
  const adapter={features:new Set(['timestamp-query']),async requestDevice(options){calls.push(options);if(options)throw new Error('Unavailable optional feature');return device;}};
  assert.equal(await requestInstrumentedDevice(adapter),device);assert.equal(calls.length,2);assert.equal(calls[1],undefined);
});

test('post-close memory phase stops being idle as soon as editing resumes',()=>{
  let time=0;const meter=new PerformanceMeasurements({consent:{diagnostics:true}},{now:()=>time,getContext:()=>({performance:{phase:'editing'},gauges:{gpu_memory_mb:1}})});
  meter.closedAt=0;time=16000;meter.resources();assert.equal(meter.resourcePhase,'idle');
  meter.action('edit');meter.resources();assert.equal(meter.closedAt,null);assert.equal(meter.resourcePhase,'editing');
});
