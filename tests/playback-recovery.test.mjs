import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { PlaybackCache } from '../src/playback.mjs';
import { createDemo } from '../src/demo.mjs';
import {playbackWorkerAdmission} from '../src/playback-budget.mjs';

// Real playback workers whose crash can be triggered from the test.
function crashableWorkers() {
  const created = [];
  const factory = () => {
    const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url)), listeners = {};
    const client = {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate: () => worker.terminate(),
      addEventListener: (name, callback) => {
        (listeners[name] ??= []).push(callback);
        worker.on(name, value => callback(name === 'message' ? { data: value } : value));
      },
      crash: () => { worker.terminate(); for (const callback of listeners.error || []) callback({ message: 'simulated worker crash' }); },
    };
    created.push(client); return client;
  };
  return { factory, created };
}

test('a crashed playback worker is replaced on the next preparation request', async () => {
  const { factory, created } = crashableWorkers(), errors = [];
  const cache = new PlaybackCache({ workerFactory: factory, onError: error => errors.push(error) });
  try {
    cache.load(createDemo(), { revision: 1 });
    await cache.prepareRange([0]); assert.ok(cache.get(0));
    created.at(-1).crash();
    assert.match(cache.failure?.message, /simulated worker crash/); assert.equal(errors.length, 1);
    await cache.prepareRange([1]);
    assert.ok(cache.get(1), 'the replacement worker reloads the document and prepares frames');
    assert.equal(cache.failure, null); assert.equal(created.length, 2); assert.equal(cache.stats.workerRestarts, 1);
  } finally { cache.dispose(); }
});

test('consecutive crashes are bounded per document revision and an edit earns another attempt', async () => {
  const { factory, created } = crashableWorkers();
  const cache = new PlaybackCache({ workerFactory: factory });
  try {
    const report = createDemo();
    cache.load(report, { revision: 1 });
    created.at(-1).crash();
    // A scene that kills every fresh pool before it delivers a frame.
    for (let restart = 0; restart < 2; restart++) {
      const request = cache.prepareRange([0]);
      created.at(-1).crash();
      await assert.rejects(request);
    }
    await assert.rejects(cache.prepareRange([0]), /simulated worker crash/);
    await assert.rejects(cache.planLayerMigration({}), /simulated worker crash/);
    assert.equal(created.length, 3, 'the same revision does not spawn a fourth pool');
    cache.load(report, { revision: 2 });
    await cache.prepareRange([0]); assert.ok(cache.get(0));
    assert.equal(created.length, 4);
  } finally { cache.dispose(); }
});

test('crash recovery preserves memory admission, interaction priority and replacement-pool ownership', async () => {
  const {factory}=crashableWorkers(),mib=1024*1024;
  const maxWorkerBytes=Math.ceil(3*playbackWorkerAdmission({maxWorkers:3,maxBytes:Infinity,frameBytes:16*mib}).perWorkerEstimate)+mib;
  const cache=new PlaybackCache({workerFactory:factory,workerCount:3,maxBytes:16*mib,maxWorkerBytes});
  try{
    const report=createDemo();report._styk.admissionFixture='x'.repeat(mib);
    cache.load(report,{revision:1});await cache.prepareRange([0,1]);
    assert.equal(cache.workers.length,2);const old=cache.workers.map(client=>client.worker);
    const expected=structuredClone(cache.get(0));old[0].crash();
    cache.setInteractionActive(true);const pending=cache.prepareRange([0,1]);
    assert.equal(cache.stats.workerRestarts,1);assert.equal(cache.workers.length,2);
    assert.ok(cache.workers.every(client=>!old.includes(client.worker)));
    old[1].crash();assert.equal(cache.failure,null,'a retired pool cannot fail the replacement');
    cache.setInteractionActive(false);await pending;
    assert.equal(cache.workers.length,2);assert.equal(cache.stats.workerAdmission.reduced,true);
    for(const key of ['shapes','transforms','uids','groups'])assert.deepEqual(cache.get(0)[key],expected[key],key);
    const primary=cache.worker;assert.equal(primary,cache.workers[0].worker);
    cache.load(createDemo(),{revision:2});await cache.prepareRange([0]);
    assert.equal(cache.workers.length,3);assert.equal(cache.worker,primary);
  }finally{cache.dispose();}
});
