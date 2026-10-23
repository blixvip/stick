import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserCodecHost} from '../src/codec-web-host.mjs';
import {codecJob, codecMode} from '../src/codec-job.mjs';

/** A Worker stand-in: records what the page posts and lets the test speak as the worker. */
class FakeWorker extends EventTarget {
  posted = [];
  terminated = false;
  postMessage(message, transfer = []) { this.posted.push({message, transfer}); }
  terminate() { this.terminated = true; }
  say(data) { this.dispatchEvent(Object.assign(new Event('message'), {data})); }
  fail(message) { this.dispatchEvent(Object.assign(new Event('error', {cancelable: true}), {message})); }
}
function fixture() {
  const workers = [];
  const host = new BrowserCodecHost({createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }});
  return {host, workers, types: worker => worker.posted.map(item => item.message.type)};
}

test('the worker is created lazily and one port per job is connected to it', () => {
  const {host, workers} = fixture();
  host.register('a');
  assert.equal(workers.length, 0, 'registering a job does not create the codec worker');
  const link = host.link('a');
  assert.equal(workers.length, 1);
  assert.ok(link.fields.codecPort instanceof MessagePort);
  assert.deepEqual(link.transfer, [link.fields.codecPort]);
  const connect = workers[0].posted[0];
  assert.equal(connect.message.type, 'connect');
  assert.equal(connect.message.jobId, 'a');
  assert.deepEqual(connect.transfer, [connect.message.port]);
  host.link('a');
  assert.equal(workers.length, 1, 'one worker serves every job');
});

test('releasing a finished job tells the worker to close its ports', () => {
  const {host, workers, types} = fixture();
  host.register('a'); host.link('a'); host.release('a');
  assert.deepEqual(types(workers[0]), ['connect', 'release']);
  host.release('a');
  assert.deepEqual(types(workers[0]), ['connect', 'release'], 'releasing twice is harmless');
});

test('cancelling the only running job stops the worker; the next job starts a fresh one', () => {
  const {host, workers} = fixture();
  host.register('a'); host.link('a');
  workers[0].say({type: 'busy', jobId: 'a'});
  host.cancel('a');
  assert.equal(workers[0].terminated, true);
  host.register('b');
  host.link('b');
  assert.equal(workers.length, 2, 'the interpreter restarts on demand');
});

test('cancelling while another job is waiting skips instead of discarding its request', () => {
  const {host, workers, types} = fixture();
  host.register('running'); host.register('waiting');
  host.link('running'); host.link('waiting');
  workers[0].say({type: 'busy', jobId: 'running'});
  host.cancel('running');
  assert.equal(workers[0].terminated, false, "the waiting job's request must survive");
  assert.ok(types(workers[0]).includes('skip'));
});

test('cancelling a queued job skips and releases that job and touches no other', () => {
  const {host, workers} = fixture();
  host.register('running'); host.register('queued');
  host.link('running'); host.link('queued');
  workers[0].say({type: 'busy', jobId: 'running'});
  host.cancel('queued');
  assert.equal(workers[0].terminated, false, 'the running job is unaffected');
  const aimedAtQueued = type => workers[0].posted.filter(item => item.message.type === type).map(item => item.message.jobId);
  assert.deepEqual(aimedAtQueued('skip'), ['queued']);
  assert.deepEqual(aimedAtQueued('release'), ['queued']);
});

test('cancelling also releases the job, so its port and skip entry do not accumulate', () => {
  const {host, workers, types} = fixture();
  host.register('running'); host.register('other');
  host.link('running'); host.link('other');
  workers[0].say({type: 'busy', jobId: 'running'});
  host.cancel('other');
  assert.deepEqual(types(workers[0]).slice(-2), ['skip', 'release'], 'skip first so queued requests are answered, then release');
});

test('a cancelled or unknown job cannot connect', () => {
  const {host, workers} = fixture();
  host.register('a'); host.cancel('a');
  assert.throws(() => host.link('a'), {name: 'AbortError'});
  assert.throws(() => host.link('never-registered'), {name: 'AbortError'});
  assert.equal(workers.length, 0);
});

test('cancelling after the work went idle does not stop a healthy worker', () => {
  const {host, workers} = fixture();
  host.register('a'); host.link('a');
  workers[0].say({type: 'busy', jobId: 'a'});
  workers[0].say({type: 'idle'});
  host.cancel('a');
  assert.equal(workers[0].terminated, false);
});

test('status reaches subscribers and a crashed worker is replaced on the next job', () => {
  const {host, workers} = fixture();
  const seen = [];
  const stop = host.subscribe(status => seen.push(status.state));
  host.register('a'); host.link('a');
  workers[0].say({type: 'status', state: 'loading', stage: 'runtime'});
  workers[0].say({type: 'status', state: 'ready'});
  workers[0].fail('out of memory');
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(seen, ['loading', 'ready', 'failed', 'stopped']);
  stop();
  host.register('b'); host.link('b');
  assert.equal(workers.length, 2);
});

test('messages from a replaced worker are ignored', () => {
  const {host, workers} = fixture();
  host.register('a'); host.link('a');
  workers[0].fail('boom');
  host.register('b'); host.link('b');
  workers[1].say({type: 'busy', jobId: 'b'});
  workers[0].say({type: 'idle'});
  host.cancel('b');
  assert.equal(workers[1].terminated, true, 'the stale idle message did not clear the busy job');
});

test('codecMode: the desktop app and plain pages use HTTP, the web build and ?codec=browser use the browser codec', () => {
  const page = (search, meta) => ({location: {search}, document: {querySelector: () => (meta ? {content: meta} : null)}});
  assert.equal(codecMode({stykDesktop: {}, ...page('?codec=browser')}), 'http', 'the desktop app always uses its own codec');
  assert.equal(codecMode(page('', null)), 'http');
  assert.equal(codecMode(page('', 'browser')), 'browser');
  assert.equal(codecMode(page('?codec=browser', null)), 'browser');
  assert.equal(codecMode(page('?codec=http', 'browser')), 'http', 'the URL overrides the page');
  assert.equal(codecMode(page('', 'nonsense')), 'http');
  assert.equal(codecMode({}), 'http');
});

test('an HTTP job links nothing and posts its cancellation once', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({url: String(url), init}); return new Response(null, {status: 204}); };
  try {
    const job = codecJob('http://127.0.0.1:47831', 'secret', {mode: 'http'});
    assert.deepEqual(job.link(), {fields: {}, transfer: []});
    job.cancel(); job.cancel();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://127.0.0.1:47831/api/cancel?id=${job.id}`);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
    const finished = codecJob('http://127.0.0.1:47831', '', {mode: 'http'});
    finished.finish(); finished.cancel();
    assert.equal(calls.length, 1, 'a finished job never posts a cancellation');
  } finally { globalThis.fetch = original; }
});

test('a browser job talks to the host, never to the network', () => {
  const {host, workers} = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the browser codec must not use fetch'); };
  try {
    const job = codecJob('http://127.0.0.1:1', '', {mode: 'browser', host});
    assert.ok(job.link().fields.codecPort instanceof MessagePort);
    workers[0].say({type: 'busy', jobId: job.id});
    job.cancel();
    assert.equal(workers[0].terminated, true);
    const done = codecJob('http://127.0.0.1:1', '', {mode: 'browser', host});
    done.finish(); done.cancel();
  } finally { globalThis.fetch = original; }
});
