import test from 'node:test';
import assert from 'node:assert/strict';
import {ImportClient} from '../src/import-client.mjs';

function environment(t,options={}) {
  const workers=[],controls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{controls.push({url:new URL(url),options});return new Response(null,{status:204});});
  class Worker extends EventTarget {
    constructor(){super();workers.push(this);this.messages=[];}
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated=true;}
    emit(type,data){const event=new Event(type,{cancelable:true});Object.assign(event,data);this.dispatchEvent(event);}
    complete(result){this.emit('message',{data:{id:this.messages.at(-1).id,ok:true,result}});}
  }
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'Worker',descriptor);else delete globalThis.Worker;});
  const client=new ImportClient({baseURL:'http://localhost',timeoutMs:0,...options});
  t.after(()=>client.dispose());return {workers,client,controls};
}

for(const event of ['error','messageerror'])test(`the next import recovers after a worker ${event}`,async t=>{
  const {client,workers,controls}=environment(t),first=client.openSample('sample.piv');
  workers[0].emit(event,{message:'Worker stopped'});
  await assert.rejects(first,{telemetryCode:event==='error'?'worker_failed':'snapshot_failed'});
  assert.equal(workers[0].terminated,true);assert.equal(client.pending.size,0);
  assert.equal(controls.length,1);assert.equal(controls[0].url.searchParams.get('id'),workers[0].messages[0].jobId);
  const next=client.openSample('next.piv');assert.equal(workers.length,2);
  workers[0].emit('error',{message:'Late error from old worker'});
  workers[0].emit('message',{data:{id:2,ok:true,result:{wrong:true}}});
  assert.equal(workers[1].terminated,undefined);
  workers[1].complete({document:{keyframes:[]}});
  assert.deepEqual(await next,{document:{keyframes:[]}});
  assert.equal(workers[0].messages.length,1,'failed work is never silently retried');
  assert.equal(controls.length,1,'successful replacement work is not cancelled');
});

test('cancelling pending imports signals each backend identity once and rejects stale completion',async t=>{
  const {client,workers,controls}=environment(t,{token:'local-test'});
  const first=client.openSample('a.piv'),second=client.openSample('b.piv');
  const ids=workers[0].messages.map(message=>message.jobId);
  assert.equal(new Set(ids).size,2);
  client.cancelPending();client.dispose();
  await assert.rejects(first,{name:'AbortError'});await assert.rejects(second,{name:'AbortError'});
  workers[0].emit('message',{data:{id:1,ok:true,result:{stale:true}}});
  assert.deepEqual(controls.map(request=>request.url.searchParams.get('id')),ids);
  assert.ok(controls.every(request=>request.options.headers.Authorization==='Bearer local-test'));
  assert.equal(client.pending.size,0);
});

test('a timed-out worker releases all pending work and the next import gets a fresh worker',async t=>{
  const {client,workers}=environment(t,{timeoutMs:10});
  await assert.rejects(client.openSample('stalled.piv'),{code:'import_timeout',telemetryStage:'decode'});
  assert.equal(workers[0].terminated,true);assert.equal(client.pending.size,0);
  const next=client.openSample('valid.piv');workers[1].complete({ok:true});assert.deepEqual(await next,{ok:true});
});

test('worker rejection preserves diagnostics and does not discard a healthy worker',async t=>{
  const {client,workers}=environment(t),pending=client.openSample('bad.piv');
  workers[0].emit('message',{data:{id:1,ok:false,error:{message:'Bad file',name:'TypeError',telemetryCode:'invalid_document',telemetryStage:'decode',telemetryFrames:[{module:'import-worker.mjs',line:55}]}}});
  await assert.rejects(pending,error=>error.name==='TypeError'&&error.telemetryCode==='invalid_document'&&error.telemetryFrames[0].line===55);
  const next=client.openSample('valid.piv');workers[0].complete({ok:true});
  assert.deepEqual(await next,{ok:true});assert.equal(workers.length,1);
  client.dispose();await assert.rejects(client.openSample('next.piv'),/disposed/);assert.equal(workers.length,1);
});
