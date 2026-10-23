import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import backend from '../desktop/backend.cjs';

test('an already cancelled backend start does not launch a child',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(backend.startBackend({appRoot:'unused',signal:controller.signal}),{name:'AbortError'});
});

test('cancelling startup terminates a Python child that has not bound its port',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'styk-backend-lifetime-'));
  await mkdir(path.join(directory,'backend'));
  await writeFile(path.join(directory,'backend','server.py'),
    'import os,time\nprint("started:%s" % os.getpid(), flush=True)\nwhile True: time.sleep(1)\n');
  const controller=new AbortController();
  t.after(async()=>{controller.abort();await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  let pid;
  const running=backend.startBackend({appRoot:directory,signal:controller.signal,
    log:text=>{const match=/started:(\d+)/.exec(text);if(match)pid=Number(match[1]);}});
  running.catch(()=>{});
  const deadline=Date.now()+5000;
  while(!pid){if(Date.now()>deadline)throw new Error('Python test child did not start');await delay(10);}
  controller.abort();await assert.rejects(running,{name:'AbortError'});
  const stopped=Date.now()+3000;
  for(;;){
    try{process.kill(pid,0);}catch(error){assert.equal(error.code,'ESRCH');break;}
    if(Date.now()>stopped)throw new Error('Cancelled startup left its child running');await delay(10);
  }
});

test('cancelling a ready codec closes its child without reporting an unexpected failure',async t=>{
  const controller=new AbortController(),errors=[];
  t.after(()=>controller.abort());
  const service=await backend.startBackend({appRoot:process.cwd(),signal:controller.signal,onError:error=>errors.push(error)});
  const exited=once(service.child,'exit');controller.abort();await exited;
  assert.deepEqual(errors,[]);service.stop();
});
