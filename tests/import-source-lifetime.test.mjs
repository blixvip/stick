import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTask} from 'node:timers/promises';
import {ImportClient} from '../src/import-client.mjs';
import {decodeSourceRecord} from '../src/source-record.mjs';

function environment(t,{cancel,release}={}) {
  const workers=[],controls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const request={url:new URL(url),options};controls.push(request);
    if(request.url.pathname==='/api/cancel' && cancel){const response=await cancel();if(response)return response;}
    if(request.url.pathname==='/api/source/release' && release)return release(request);
    return new Response(null,{status:204});
  });
  class Worker extends EventTarget {
    constructor(){super();workers.push(this);this.messages=[];}
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated=true;}
    reply(message,result){this.dispatchEvent(new MessageEvent('message',{data:{id:message.id,ok:true,result}}));}
    fail(){const event=new Event('error',{cancelable:true});event.message='Worker failed';this.dispatchEvent(event);}
  }
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'Worker',descriptor);else delete globalThis.Worker;});
  const client=new ImportClient({baseURL:'http://localhost',token:'local-test',timeoutMs:0});
  t.after(()=>client.dispose());return {client,workers,controls};
}
function complete(worker,message,sourceId=String(message.id)) {
  const result={document:{},sourceId,sourceOwner:message.sourceOwner};worker.reply(message,result);return result;
}
const released=controls=>controls.filter(request=>request.url.pathname==='/api/source/release').map(request=>JSON.parse(request.options.body).ownerId);

test('library imports do not retain originals while accepted project owners survive unrelated imports',async t=>{
  const {client,workers,controls}=environment(t),worker=workers[0];
  const project=client.openSample('project.piv',{project:true}),request=worker.messages[0];
  assert.match(request.sourceOwner,/^[a-f0-9]{32}$/);assert.notEqual(request.sourceOwner,request.jobId);
  complete(worker,request);const result=await project;client.adoptSource(result);
  for(let i=0;i<40;i++){
    const pending=client.openSample(`figure-${i}.stk`),library=worker.messages.at(-1);
    assert.equal(library.sourceOwner,undefined);complete(worker,library);await pending;
  }
  assert.equal(client.activeSourceOwner,result.sourceOwner);assert.equal(client.sourceOwners.size,1);assert.deepEqual(released(controls),[]);
  client.adoptSource(null);await nextTask();assert.deepEqual(released(controls),[result.sourceOwner]);
  assert.equal(controls.at(-1).options.headers.Authorization,'Bearer local-test');
});

test('project results have distinct owners and release only the replaced or rejected result',async t=>{
  const {client,workers,controls}=environment(t),worker=workers[0];
  const first=client.openSample('a.piv',{project:true}),second=client.openSample('b.piv',{project:true});
  const [a,b]=worker.messages;assert.notEqual(a.sourceOwner,b.sourceOwner);
  complete(worker,a);complete(worker,b);const [one,two]=await Promise.all([first,second]);
  client.adoptSource(one);await client.releaseSource(two);assert.equal(client.activeSourceOwner,one.sourceOwner);
  const third=client.openSample('c.piv',{project:true}),c=worker.messages.at(-1);complete(worker,c);client.adoptSource(await third);
  await nextTask();assert.deepEqual(released(controls),[two.sourceOwner,one.sourceOwner]);
  await client.releaseSource(two);assert.equal(released(controls).length,2);
  client.dispose();await nextTask();assert.deepEqual(released(controls),[two.sourceOwner,one.sourceOwner,c.sourceOwner]);
});

test('cancelled queued imports release only after cancellation acknowledgement, including disposal',async t=>{
  let acknowledge;const cancellation=new Promise(resolve=>acknowledge=resolve);
  const {client,workers,controls}=environment(t,{cancel:()=>cancellation}),worker=workers[0];
  const pending=client.openSample('queued.piv',{project:true}),message=worker.messages[0];
  client.cancelPending();client.dispose();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(controls.length,1);assert.equal(controls[0].url.pathname,'/api/cancel');
  assert.deepEqual(released(controls),[]);
  complete(worker,message);assert.equal(client.activeSourceOwner,null);
  acknowledge();await nextTask();assert.deepEqual(released(controls),[message.sourceOwner]);
});

test('import worker failure cleans pending owners and keeps the accepted original',async t=>{
  const {client,workers,controls}=environment(t),worker=workers[0];
  const project=client.openSample('accepted.piv',{project:true}),a=worker.messages[0];complete(worker,a);client.adoptSource(await project);
  const pending=client.openSample('failed.piv',{project:true}),b=worker.messages.at(-1);worker.fail();
  await assert.rejects(pending,{telemetryCode:'worker_failed'});await nextTask();
  assert.equal(client.activeSourceOwner,a.sourceOwner);assert.deepEqual(released(controls),[b.sourceOwner]);
});

for (const failure of ['network','rejected']) test(`cleanup repeats the cancelled import identity after ${failure} cancellation failure`,async t=>{
  const {client,workers,controls}=environment(t,{cancel:()=>{if(failure==='network')throw new TypeError('Network failed');return new Response(null,{status:503});}}),worker=workers[0];
  const project=client.openSample('accepted.piv',{project:true}),a=worker.messages[0];complete(worker,a);client.adoptSource(await project);
  const pending=client.openSample('queued.piv',{project:true}),b=worker.messages.at(-1);
  client.cancelPending();await assert.rejects(pending,{name:'AbortError'});await nextTask();
  const cleanup=controls.find(request=>request.url.pathname==='/api/source/release');
  assert.deepEqual(JSON.parse(cleanup.options.body),{ownerId:b.sourceOwner,jobId:b.jobId});
  assert.equal(client.activeSourceOwner,a.sourceOwner);assert.deepEqual(released(controls),[b.sourceOwner]);
  complete(worker,b);assert.equal(client.activeSourceOwner,a.sourceOwner);
});

test('bulk source cleanup is serialized and retries temporary control-capacity failure',async t=>{
  let active=0,maxActive=0,attempts=0;
  const {client,workers,controls}=environment(t,{release:async()=>{
    active++;maxActive=Math.max(maxActive,active);await nextTask();active--;attempts++;
    return new Response(null,{status:attempts===1?503:204});
  }}),worker=workers[0],results=[];
  for(let i=0;i<8;i++){
    const pending=client.openSample(`project-${i}.piv`,{project:true}),message=worker.messages.at(-1);
    complete(worker,message);results.push(await pending);
  }
  await Promise.all(results.map(result=>client.releaseSource(result)));
  assert.equal(maxActive,1);assert.equal(attempts,9);assert.equal(client.sourceOwners.size,0);
  assert.deepEqual(new Set(released(controls)),new Set(results.map(result=>result.sourceOwner)));
});

test('pending and releasing originals share a bounded owner budget',async t=>{
  let finish;const cancelled=new Promise(resolve=>finish=resolve);
  const {client,workers}=environment(t,{cancel:()=>cancelled}),pending=[];
  for(let i=0;i<16;i++)pending.push(client.openSample(`project-${i}.piv`,{project:true}));
  await assert.rejects(client.openSample('over-budget.piv',{project:true}),{code:'source_retention_limit',status:413});
  assert.equal(workers[0].messages.length,16);assert.equal(client.sourceOwners.size,16);
  client.cancelPending();await Promise.all(pending.map(request=>assert.rejects(request,{name:'AbortError'})));
  await assert.rejects(client.openSample('cleanup-still-pending.piv',{project:true}),{code:'source_retention_limit'});
  finish();await client.sourceRelease;assert.equal(client.sourceOwners.size,0);
  const next=client.openSample('available-again.piv',{project:true}),message=workers[0].messages.at(-1);complete(workers[0],message);await next;
});

test('a backend result without the requested lease cannot replace an accepted original',async t=>{
  const {client,workers,controls}=environment(t),worker=workers[0];
  const project=client.openSample('accepted.piv',{project:true}),a=worker.messages[0];complete(worker,a);client.adoptSource(await project);
  const pending=client.openSample('unretained.piv',{project:true}),b=worker.messages.at(-1);
  worker.reply(b,{document:{},sourceId:'unsafe-expiring-source'});
  await assert.rejects(pending,/invalid source record/);await nextTask();
  assert.equal(client.activeSourceOwner,a.sourceOwner);assert.deepEqual(released(controls),[b.sourceOwner]);
});

function envelope(metadata,bytes=new Uint8Array([1,2,3])) {
  const text=new TextEncoder().encode(JSON.stringify(metadata)),buffer=new ArrayBuffer(12+text.length+bytes.length);
  const output=new Uint8Array(buffer);output.set(new TextEncoder().encode('STYKSRC1'));new DataView(buffer).setUint32(8,text.length,true);
  output.set(text,12);output.set(bytes,12+text.length);return buffer;
}
const metadata={kind:'piv',version:5,sha256:'a'.repeat(64),document_sha256:'b'.repeat(64),document_digest_version:3};
test('original-source envelopes reject malformed bounds and metadata before use',()=>{
  const valid=envelope(metadata);assert.deepEqual(decodeSourceRecord(valid),{metadata,bytes:new Uint8Array([1,2,3])});
  const badLength=valid.slice(0);new DataView(badLength).setUint32(8,0xffffffff,true);
  for(const buffer of [new ArrayBuffer(8),badLength,envelope(metadata,new Uint8Array()),envelope({...metadata,sha256:'wrong'}),envelope({...metadata,kind:'styk'})])assert.throws(()=>decodeSourceRecord(buffer),/invalid source record/);
});
