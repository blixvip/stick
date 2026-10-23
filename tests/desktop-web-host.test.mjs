import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import hostModule from '../desktop/web-host.cjs';

async function until(predicate) {
  const end=Date.now()+3000;
  while(!predicate()){if(Date.now()>end)throw new Error('Condition timed out');await delay(5);}
}
function request(origin,pathname='/',{method='GET',headers={},body}={}) {
  let client;
  const result=new Promise((resolve,reject)=>{
    client=http.request(origin,{method,path:pathname,headers,agent:false},response=>{
      const chunks=[];response.on('data',data=>chunks.push(data));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    client.on('error',reject);client.end(body);
  });
  return {result,cancel:()=>client.destroy(new Error('Client cancelled'))};
}
async function fixture(t,options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'styk-web-host-')),root=path.join(directory,'web');
  await mkdir(path.join(root,'src'),{recursive:true});
  await writeFile(path.join(root,'index.html'),'<h1>Editor shell</h1>');
  await writeFile(path.join(root,'src','worker.mjs'),'export const ready = true;');
  await writeFile(path.join(directory,'secret.json'),'private');
  let resolve,reject,codecOptions;
  const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const errors=[];
  const host=await hostModule.startDesktopHost({appRoot:root,maxApiRequests:2,onError:value=>errors.push(value),
    startCodec:opts=>{codecOptions=opts;opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});return ready;},...options});
  t.after(async()=>{await host.stop();await rm(directory,{recursive:true,force:true});});
  return {host,root,directory,resolve,reject,errors,get codecOptions(){return codecOptions;}};
}
async function codec(t,handler) {
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  return {origin:`http://127.0.0.1:${server.address().port}`,stop(){server.closeAllConnections();},server};
}

test('static shell, worker modules, HEAD and revalidation work before codec readiness',async t=>{
  const f=await fixture(t);
  const first=await request(f.host.origin).result;
  assert.equal(first.status,200);assert.equal(first.body.toString(),'<h1>Editor shell</h1>');
  assert.equal(first.headers['cache-control'],'no-cache');
  const head=await request(f.host.origin,'/',{method:'HEAD'}).result;
  assert.equal(head.body.length,0);assert.equal(head.headers['content-length'],first.headers['content-length']);
  assert.equal((await request(f.host.origin,'/',{headers:{'If-None-Match':`W/${first.headers.etag}`}}).result).status,304);
  const module=await request(f.host.origin,'/src/worker.mjs').result;
  assert.equal(module.headers['content-type'],'text/javascript');
  assert.match(module.body.toString(),/ready/);
  assert.equal(f.host.child,undefined);assert.equal(f.host.pendingRequests,0);
});

test('session authentication precedes startup admission and reaches the codec',async t=>{
  const token='integration-session',f=await fixture(t,{token});
  assert.equal((await request(f.host.origin).result).status,200);
  await until(()=>Boolean(f.codecOptions));assert.equal(f.codecOptions.token,token);
  for(const authorization of [undefined,'Bearer wrong']){
    assert.equal((await request(f.host.origin,'/api/samples',{headers:authorization?{Authorization:authorization}:{}}).result).status,401);
  }
  assert.equal(f.host.pendingRequests,0,'unauthorized calls cannot occupy the codec startup queue');
  const valid=request(f.host.origin,'/api/samples',{headers:{Authorization:`Bearer ${token}`}});
  await until(()=>f.host.pendingRequests===1);
  assert.equal((await request(f.host.origin,'/api/cancel?id=test',{method:'POST',headers:{'Content-Length':0}}).result).status,401);
  assert.equal(f.host.pendingRequests,1);
  const upstream=await codec(t,(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);res.writeHead(200);res.end('protected');
  });
  f.resolve(upstream);await f.host.ready;assert.equal((await valid.result).body.toString(),'protected');
});

test('packaged host uses its web resource root and excludes development artifacts',async t=>{
  const f=await fixture(t);
  for(const directory of ['vendor','assets','tests','artifacts'])await mkdir(path.join(f.root,directory));
  await writeFile(path.join(f.root,'vendor','codec.wasm'),Buffer.from([0,97,115,109]));
  await writeFile(path.join(f.root,'assets','icon.svg'),'<svg/>');
  await writeFile(path.join(f.root,'tests','private.json'),'{}');
  await writeFile(path.join(f.root,'artifacts','private.json'),'{}');
  const host=await hostModule.startDesktopHost({appRoot:path.join(f.directory,'missing-app'),
    resourcesPath:f.directory,packaged:true,startCodec:async()=>({origin:f.host.origin,stop(){}})});
  t.after(()=>host.stop());
  assert.equal((await request(host.origin).result).status,200);
  assert.equal((await request(host.origin,'/vendor/codec.wasm').result).headers['content-type'],'application/wasm');
  assert.equal((await request(host.origin,'/assets/icon.svg').result).status,200);
  for(const pathname of ['/tests/private.json','/artifacts/private.json'])
    assert.equal((await request(host.origin,pathname).result).status,403);
});

test('startup queue is bounded, cancelled clients release it and shutdown rejects readiness',async t=>{
  const {host}=await fixture(t);
  const first=request(host.origin,'/api/health'),second=request(host.origin,'/api/samples');
  first.result.catch(()=>{});second.result.catch(()=>{});
  await until(()=>host.pendingRequests===2);
  const busy=await request(host.origin,'/api/source?id=x').result;
  assert.equal(busy.status,503);assert.equal(JSON.parse(busy.body).code,'backend_busy');
  first.cancel();await assert.rejects(first.result,/cancelled/);await until(()=>host.pendingRequests===1);
  assert.equal((await request(host.origin).result).status,200,'Pending conversions cannot occupy the static host');
  await host.stop();await assert.rejects(second.result);await assert.rejects(host.ready,{name:'AbortError'});
  assert.equal(host.pendingRequests,0);
});

test('proxy streams queued binary bodies and preserves status, bytes and diagnostic headers',async t=>{
  const f=await fixture(t),body=Buffer.alloc(1024*1024,173);let received=0;
  const upstream=await codec(t,(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer local-test');assert.equal(req.url,'/api/export?test=1');
    const chunks=[];req.on('data',chunk=>{received+=chunk.length;chunks.push(chunk);});
    req.on('end',()=>{assert.deepEqual(Buffer.concat(chunks),body);res.writeHead(201,{'Content-Length':body.length,
      'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=test.piv','Server-Timing':'encode;dur=1.25'});res.end(body);});
  });
  const pending=request(f.host.origin,'/api/export?test=1',{method:'POST',body,headers:{'Content-Length':body.length,Authorization:'Bearer local-test'}});
  await until(()=>f.host.pendingRequests===1);assert.equal(received,0);
  f.resolve(upstream);await f.host.ready;
  const result=await pending.result;assert.equal(result.status,201);assert.deepEqual(result.body,body);
  assert.equal(result.headers['server-timing'],'encode;dur=1.25');
  assert.equal(result.headers['content-disposition'],'attachment; filename=test.piv');
  await until(()=>f.host.pendingRequests===0);
});

test('client cancellation closes a running proxy request and codec failures leave shell usable',async t=>{
  const f=await fixture(t);let active=false,closed=false;
  const upstream=await codec(t,(req,res)=>{active=true;res.on('close',()=>closed=true);});
  f.resolve(upstream);await f.host.ready;
  const pending=request(f.host.origin,'/api/source?id=test');pending.result.catch(()=>{});
  await until(()=>active);pending.cancel();await assert.rejects(pending.result);await until(()=>closed&&f.host.pendingRequests===0);
  f.codecOptions.onError('Codec exited');
  assert.equal((await request(f.host.origin,'/api/health').result).status,503);
  assert.equal((await request(f.host.origin).result).status,200);
  assert.deepEqual(f.errors,['Codec exited']);
});

test('failed startup returns actionable API errors without removing the editor origin',async t=>{
  const f=await fixture(t),pending=request(f.host.origin,'/api/samples');
  await until(()=>f.host.pendingRequests===1);f.reject(new Error('Simulated startup failure'));
  await assert.rejects(f.host.ready,/startup failure/);
  const response=await pending.result;assert.equal(response.status,503);
  assert.equal(JSON.parse(response.body).code,'backend_unavailable');
  assert.equal((await request(f.host.origin).result).status,200);
  assert.equal(f.host.pendingRequests,0);
});

test('cancellation has independent capacity and disconnected clients signal the exact codec identity',async t=>{
  const f=await fixture(t),received=[],cancelled=[];
  const upstream=await codec(t,(req,res)=>{
    if(req.url.startsWith('/api/cancel?')){
      cancelled.push({id:new URL(req.url,'http://localhost').searchParams.get('id'),auth:req.headers.authorization});
      res.writeHead(204);res.end();return;
    }
    received.push(req.headers['x-styk-job-id']);
  });
  f.resolve(upstream);await f.host.ready;
  const first=request(f.host.origin,'/api/source?id=first',{headers:{Authorization:'Bearer local-test'}});
  const second=request(f.host.origin,'/api/source?id=second');first.result.catch(()=>{});second.result.catch(()=>{});
  await until(()=>received.length===2);assert.ok(received.every(id=>/^[a-f0-9]{32}$/.test(id)));
  assert.equal((await request(f.host.origin,'/api/source?id=full').result).status,503);
  const control=await request(f.host.origin,`/api/cancel?id=${received[1]}`,{method:'POST',headers:{'Content-Length':0}}).result;
  assert.equal(control.status,204,'A full work queue must not block cancellation');
  first.cancel();second.cancel();await assert.rejects(first.result);await assert.rejects(second.result);
  await until(()=>cancelled.some(item=>item.id===received[0]));
  assert.equal(cancelled.find(item=>item.id===received[0]).auth,'Bearer local-test');
  await until(()=>f.host.pendingRequests===0);
});

test('static and proxy paths reject traversal, escaped links, private files and remote origins',async t=>{
  const f=await fixture(t);
  await symlink(f.directory,path.join(f.root,'src','escape'),process.platform==='win32'?'junction':'dir');
  for(const pathname of ['/package.json','/desktop/main.cjs','/src/escape/secret.json','/src/%2e%2e/../secret.json',
    '/src/..%5csecret.json','/src/file.json:private','/.desktop-data/preferences.json']){
    const response=await request(f.host.origin,pathname).result;assert.equal(response.status,403,pathname);
    assert.notEqual(response.body.toString(),'private');
  }
  assert.equal((await request(f.host.origin,'/src/%xx').result).status,400);
  assert.equal((await request(f.host.origin,'/api/health',{headers:{Origin:'https://example.test'}}).result).status,403);
  assert.equal((await request(f.host.origin,'/api/health',{headers:{Host:'example.test'}}).result).status,403);
  assert.equal((await request(f.host.origin,'/api/health',{headers:{Origin:'null'}}).result).status,403);
  assert.equal((await request(f.host.origin,'/api/export',{method:'POST',headers:{'Content-Length':256*1024*1024+1}}).result).status,413);
  assert.equal(f.host.pendingRequests,0);
});

test('original-source cleanup has control capacity when the conversion queue is full',async t=>{
  const f=await fixture(t),conversions=[];
  const upstream=await codec(t,(req,res)=>{
    if(req.url==='/api/source/release'){
      assert.equal(req.headers.authorization,'Bearer local-test');
      const chunks=[];req.on('data',chunk=>chunks.push(chunk));
      req.on('end',()=>{assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{ownerId:'a'.repeat(32)});res.writeHead(204);res.end();});
      return;
    }
    conversions.push(res);
  });
  f.resolve(upstream);await f.host.ready;
  const first=request(f.host.origin,'/api/source?id=first'),second=request(f.host.origin,'/api/source?id=second');
  first.result.catch(()=>{});second.result.catch(()=>{});
  await until(()=>conversions.length===2);
  assert.equal((await request(f.host.origin,'/api/source?id=full').result).status,503);
  const body=JSON.stringify({ownerId:'a'.repeat(32)});
  assert.equal((await request(f.host.origin,'/api/source/release',{method:'POST',body,
    headers:{Authorization:'Bearer local-test','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}).result).status,204);
  first.cancel();second.cancel();await assert.rejects(first.result);await assert.rejects(second.result);
});
