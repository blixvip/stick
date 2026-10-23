import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {AudioService}=createRequire(import.meta.url)('../desktop/audio-service.cjs');
test('audio IPC rejects invalid sizes, concurrent jobs, incomplete files, and cleans cancellation',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'styk-audio-test-'));
  const service=new AudioService({encoderPath:path.join(directory,'unused-encoder.exe'),tempRoot:directory});
  try{
    await assert.rejects(service.begin({size:33*1024*1024}),/32 MiB/);
    const first=await service.begin({size:4});await assert.rejects(service.begin({size:4}),/current audio/);
    await service.write(first.token,new Uint8Array([1,2]));await assert.rejects(service.finish(first.token),/incomplete/);assert.equal(service.jobs.size,0);assert.deepEqual(await readdir(directory),[]);
    const second=await service.begin({size:4});await assert.rejects(service.write(second.token,new Uint8Array(5)),/Invalid/);assert.deepEqual(await readdir(directory),[]);
    const third=await service.begin({size:4});await service.write(third.token,new Uint8Array([1,2,3,4]));assert.deepEqual(await service.cancel(third.token),{cancelled:true});assert.equal(service.jobs.size,0);
    await assert.rejects(service.read(third.token),/no longer active/);assert.deepEqual(await readdir(directory),[]);
  }finally{await service.dispose();await rmdir(directory);}
});
