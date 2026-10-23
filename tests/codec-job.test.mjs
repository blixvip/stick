import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {codecJob} from '../src/codec-job.mjs';
import {DocumentExporter} from '../src/document-export.mjs';

function controls(t){
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:new URL(url),options});return new Response(null,{status:204});});
  return calls;
}
async function until(check){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw new Error('Worker did not reach export');await delay(5);}}

test('a codec job signals cancellation once with its private identity and independent timeout',t=>{
  const calls=controls(t),job=codecJob('http://localhost:1234','local-test');
  assert.match(job.id,/^[a-f0-9]{32}$/);job.cancel();job.cancel();job.finish();
  assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/api/cancel');
  assert.equal(calls[0].url.searchParams.get('id'),job.id);
  assert.equal(calls[0].options.body,'');assert.equal(calls[0].options.keepalive,true);
  assert.equal(calls[0].options.headers.Authorization,'Bearer local-test');
  assert.equal(calls[0].options.signal.aborted,false);
  const completed=codecJob('http://localhost:1234');completed.finish();completed.cancel();assert.equal(calls.length,1);
});

function exporter(t,onExport){
  const calls=controls(t),workers=[];
  class Worker extends EventTarget{
    constructor(){super();this.messages=[];workers.push(this);}
    postMessage(message){
      this.messages.push(message);
      queueMicrotask(()=>{
        if(message.operation==='export'){onExport(this,message);return;}
        this.reply(message,{ok:true});
      });
    }
    reply(message,result){this.dispatchEvent(new MessageEvent('message',{data:{id:message.id,...result}}));}
    terminate(){this.terminated=true;}
  }
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'Worker',descriptor);else delete globalThis.Worker;});
  const owner=new DocumentExporter({baseURL:'http://localhost:1234',token:'local-test',timeoutMs:0});
  t.after(()=>owner.dispose());return {owner,workers,calls};
}

test('terminating a busy document worker still cancels its backend job',async t=>{
  const {owner,workers,calls}=exporter(t,()=>{}),controller=new AbortController();
  const pending=owner.export({figure_types:[],keyframes:[]},{format:'piv',signal:controller.signal});
  pending.catch(()=>{});
  await until(()=>workers[0]?.messages.some(message=>message.operation==='export'));
  controller.abort();await assert.rejects(pending,{name:'AbortError'});owner.dispose();
  assert.equal(workers[0].terminated,true);assert.equal(calls.length,1);
  assert.equal(calls[0].url.searchParams.get('id'),workers[0].messages[0].options.jobId);
  assert.equal(owner.jobs.size,0);
});

test('a completed document export does not cancel and a superseded result never publishes',async t=>{
  let revision=0,change=false;
  const {owner,calls}=exporter(t,(worker,message)=>{
    if(change)revision++;
    worker.reply(message,{ok:true,blob:new Blob(['native bytes'])});
  });
  const report={figure_types:[],keyframes:[]};
  const result=await owner.export(report,{getRevision:()=>revision});assert.equal(await result.text(),'native bytes');
  assert.equal(calls.length,0);
  change=true;await assert.rejects(owner.export(report,{getRevision:()=>revision}),{name:'AbortError'});
  assert.equal(calls.length,1);assert.equal(owner.jobs.size,0);
});
