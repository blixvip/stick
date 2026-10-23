import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryAccumulator, DesktopTelemetryClient } from '../src/telemetry-core.mjs';
import { InteractionMeasurements, PlaybackMeasurements } from '../src/telemetry-measurements.mjs';
import { documentComplexity, workload } from '../src/telemetry-workload.mjs';
import { writeBrowserRecovery } from '../src/browser-recovery.mjs';

function collector(diagnostics = true) { const c = new TelemetryAccumulator(); c.configure({ analytics: diagnostics, diagnostics }); return c; }
const event = (interactionId, overrides = {}) => ({ interactionId, startTime: 1000, duration: 80, processingStart: 1020, processingEnd: 1040, ...overrides });

test('slow observations group each interaction by its maximum duration and keep only aggregate phases', () => {
  const c = collector(), m = new InteractionMeasurements(c);
  const source = event(123456789, { target: { textContent: 'PRIVATE TEXT' }, name: 'private-event-name' });
  m.observe([source, event(123456789, { duration: 144, processingStart: 1030, processingEnd: 1100 }), event(2, { duration: 64 })], { now: 1200 });
  m.flush();
  assert.equal(c.data.counters.input_observed_interactions, 2);
  assert.equal(c.data.timings.interaction_ms.count, 2); assert.equal(c.data.timings.interaction_ms.sum, 208); assert.equal(c.data.timings.interaction_ms.max, 144);
  assert.equal(c.data.timings.input_delay_ms.sum, 50);
  assert.equal(c.data.timings.input_processing_ms.sum, 90);
  assert.equal(c.data.timings.input_presentation_ms.sum, 68);
  assert.equal(c.data.timings.input_latency_ms, undefined, 'legacy responsiveness histogram receives no new samples');
  m.observe([source], { now: 1300 }); m.flush(); assert.equal(c.data.counters.input_observed_interactions, 2, 'recent interaction is not counted twice across flushes');
  const serialized = JSON.stringify(c.data);
  for (const raw of ['123456789', 'PRIVATE TEXT', 'private-event-name', 'interactionId', 'target']) assert.ok(!serialized.includes(raw));
});

test('interaction pending/recent IDs and observer batches are bounded, with explicit drop counts', () => {
  const c = collector(), m = new InteractionMeasurements(c);
  m.observe(Array.from({ length: 150 }, (_, index) => event(index + 1)), { now: 1200 });
  assert.equal(m.pending.size, 64); assert.equal(c.data.counters.input_observer_dropped, 86);
  m.flush(); assert.equal(c.data.counters.input_observed_interactions, 64);
  for (let batch = 0; batch < 3; batch++) {
    m.observe(Array.from({ length: 64 }, (_, index) => event(1000 + batch * 64 + index)), { now: 1200 }); m.flush();
  }
  assert.equal(m.pending.size, 0); assert.equal(m.recent.size, 128);
  assert.equal(c.data.counters.input_observed_interactions, 256);
  assert.ok(JSON.stringify(c.data).length < 1800);
});

test('slow interaction denominator includes only attributed foreground observations delivered by the observer', () => {
  const c = collector(), m = new InteractionMeasurements(c);
  m.observe([event(0), event(-1), event(1.5), event(1)], { now: 1200 });
  m.observe([event(2)], { now: 1200, foreground: false }); m.flush();
  assert.equal(c.data.counters.input_unattributed_samples, 3);
  assert.equal(c.data.counters.input_background_samples, 1);
  assert.equal(c.data.counters.input_observed_interactions, 1);
  assert.equal(c.data.timings.interaction_ms.count, 1);
  assert.equal(c.data.counters.edits, undefined);
});

test('foreground boundaries and very long input spans are retained separately from regular responsiveness', () => {
  const c = collector(), m = new InteractionMeasurements(c);
  m.observe([event(1)], { now: 1200 }); m.boundary(1500);
  m.observe([
    event(2, { startTime: 1400, processingStart: 1410, processingEnd: 1440 }),
    event(3, { startTime: 1600, duration: 3240000, processingStart: 1601, processingEnd: 1610 }),
    event(4, { startTime: 1600, duration: 3600001, processingStart: 1601, processingEnd: 1610 }),
    event(5, { startTime: 2500, processingStart: 2510, processingEnd: 2530 }),
  ], { now: 2000 });
  m.flush();
  assert.equal(c.data.timings.interaction_ms.count, 1); assert.equal(c.data.timings.interaction_ms.max, 80);
  assert.equal(c.data.counters.input_discontinuities, 4);
  assert.equal(c.data.timings.input_anomaly_ms.count, 3);
  assert.equal(c.data.timings.input_anomaly_ms.max, 3240000);
});

test('malformed phase timestamps and nonfinite times cannot contaminate normal histograms', () => {
  const c = collector(), m = new InteractionMeasurements(c);
  m.observe([
    event(1, { processingStart: 999 }), event(2, { processingEnd: 1010 }),
    event(3, { processingEnd: 1300 }), event(4, { processingEnd: 1090 }),
    event(5, { processingStart: NaN }), event(6, { duration: NaN }), event(7, { startTime: NaN }),
  ], { now: 1200 });
  m.observe([event(8)], { now: NaN }); m.flush();
  assert.equal(c.data.timings.interaction_ms, undefined);
  assert.equal(c.data.counters.input_discontinuities, 5);
  assert.equal(c.data.timings.input_anomaly_ms.count, 5);
  assert.equal(c.data.timings.input_processing_ms, undefined);
  m.observe([event(9, { processingEnd: 1088 })], { now: 1200 }); m.flush();
  assert.equal(c.data.timings.interaction_ms.count, 1, 'up to8ms browser duration rounding is tolerated');
});

test('playback uses each project target FPS with 10 percent tolerance and matching context sample counts', () => {
  const c = collector(), m = new PlaybackMeasurements(c);
  m.reset({ format: 'native', size: '1-10mb', complexity: '100-999' });
  m.present(0, 25, true); m.present(44, 25, true); m.present(88.01, 25, true);
  m.present(128.01, 50, true); m.present(144.01, 60, true);
  assert.equal(c.data.counters.playback_observed_intervals, 4);
  assert.equal(c.data.counters.playback_missed_deadlines, 2);
  m.flush();
  assert.equal(c.data.operationContexts.length, 2);
  assert.equal(c.data.operationContexts.find(row => row.fps === '25-30').timing.count, 2);
  assert.equal(c.data.operationContexts.find(row => row.fps === '31-60').timing.count, 2);
  assert.equal(c.data.operationContexts.reduce((sum, row) => sum + row.timing.count, 0), c.data.timings.playback_foreground_interval_ms.count);
  assert.equal(c.data.timings.playback_interval_ms, undefined);
  m.flush(); assert.equal(c.data.operationContexts[0].timing.count, 2, 'empty flush never doubles counts');
  m.present(164.01, 50, true); m.flush();
  assert.equal(c.data.operationContexts.find(row => row.fps === '31-60').timing.count, 3);
});

test('playback excludes background and crossing-boundary intervals and keeps long anomalies separate', () => {
  const c = collector(), m = new PlaybackMeasurements(c);
  m.present(0, 60, true); m.present(16, 60, true);
  m.boundary(30); m.present(40, 60, true);
  m.present(56, 60, false); m.present(72, 60, true); m.present(88, 60, true);
  m.present(62000, 60, true);
  m.present(NaN, 60, true); m.present(62016, 60, true); m.present(62032, 60, true);
  m.flush();
  assert.equal(c.data.counters.playback_observed_intervals, 3);
  assert.equal(c.data.counters.playback_background_intervals, 1);
  assert.equal(c.data.counters.playback_discontinuities, 2);
  assert.equal(c.data.timings.playback_foreground_interval_ms.max, 16);
  assert.equal(c.data.timings.playback_anomaly_ms.count, 2);
  assert.equal(c.data.timings.playback_anomaly_ms.max, 61912);
  assert.equal(c.data.operationContexts[0].timing.count, 3);
});

test('diagnostics disabled leaves observation and playback reports empty', () => {
  const c = collector(false), initial = structuredClone(c.data), i = new InteractionMeasurements(c), p = new PlaybackMeasurements(c);
  i.observe([event(1)], { now: 1200 }); i.flush();
  p.present(0, 60, true); p.present(16, 60, true); p.flush();
  assert.deepEqual(c.data, initial); assert.equal(i.pending.size, 0); assert.equal(i.recent.size, 0); assert.equal(p.groups.size, 0);
});

test('withdrawal immediately discards pending interaction identifiers and playback groups', () => {
  const client = new DesktopTelemetryClient(null);
  try {
    client.applyStatus({ epoch: 1, consent: { analytics: true, diagnostics: true } });
    client.interactions.observe([event(100)], { now: 1200 });
    client.playbackStart(); client.playbackPresent(0, 60); client.playbackPresent(16, 60);
    assert.equal(client.interactions.pending.size, 1); assert.equal(client.playbackMeasurements.groups.size, 1);
    client.applyStatus({ epoch: 2, consent: { analytics: false, diagnostics: false } });
    assert.equal(client.interactions, null); assert.equal(client.playbackMeasurements, null); assert.equal(client.timer, null);
    assert.deepEqual(client.data.counters, {}); assert.deepEqual(client.data.timings, {}); assert.deepEqual(client.data.operationContexts, []);
  } finally { client.dispose(); }
});

test('desktop browser subscription requests slow event observations without starting a playback loop', async () => {
  const oldObserver = globalThis.PerformanceObserver, oldDocument = globalThis.document;
  const subscriptions = [], callbacks = [];
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ['event'];
    constructor(callback) { callbacks.push(callback); }
    observe(options) { subscriptions.push(options); }
    disconnect() {}
  };
  globalThis.document = { hidden: false, hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
  const client = new DesktopTelemetryClient({ recordTelemetry: async () => {} });
  try {
    client.applyStatus({ epoch: 1, consent: { analytics: false, diagnostics: true } });
    assert.deepEqual(subscriptions, [{ type: 'event', buffered: false, durationThreshold: 40 }]);
    assert.equal(callbacks.length, 1);
    assert.equal(client.data.timings.playback_foreground_interval_ms, undefined);
  } finally {
    client.dispose();
    if (oldObserver === undefined) delete globalThis.PerformanceObserver; else globalThis.PerformanceObserver = oldObserver;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
});

test('workload estimates only the first frame, stops at fixed table limits and returns no raw fields', () => {
  let laterReads = 0;
  const report = { figure_types: [{ figure_type_id: 'private-figure-name', segments: new Array(100) }], keyframes: [{ objects: [{ figure_type_id: 'private-figure-name' }] }], privateDocument: 'PRIVATE DOCUMENT' };
  Object.defineProperty(report.keyframes, 1, { get() { laterReads++; throw new Error('later frames must not be read'); } });
  assert.equal(documentComplexity(report), '100-999'); assert.equal(laterReads, 0);
  const result = workload({ report, format: 'C:/private/project.PIV', bytes: 1250000, fps: 60 });
  assert.deepEqual(result, { format: 'pivot', size: '1-10mb', complexity: '100-999', fps: '31-60' });
  assert.ok(!JSON.stringify(result).includes('private')); assert.equal(laterReads, 0);
  const oversizedFigures = new Array(1025); Object.defineProperty(oversizedFigures, 0, { get() { throw new Error('oversized definitions must not be traversed'); } });
  assert.equal(documentComplexity({ figure_types: oversizedFigures, keyframes: [{ objects: [] }] }), 'unknown');
  const oversizedObjects = new Array(1025); Object.defineProperty(oversizedObjects, 0, { get() { throw new Error('oversized objects must not be traversed'); } });
  assert.equal(documentComplexity({ figure_types: [], keyframes: [{ objects: oversizedObjects }] }), 'unknown');
  const thresholdObjects = [{ figure_type_id: 1 }]; Object.defineProperty(thresholdObjects, 1, { get() { throw new Error('stop after top bucket'); } });
  assert.equal(documentComplexity({ figure_types: [{ figure_type_id: 1, segments: new Array(10000) }], keyframes: [{ objects: thresholdObjects }] }), '10000-plus');
});

test('missing or malformed workload data remains unknown and optional measurements never throw', () => {
  assert.deepEqual(workload(), { format: 'unknown', size: 'unknown', complexity: 'unknown', fps: 'unknown' });
  for (const report of [{}, { figure_types: [], keyframes: [] }, { figure_types: [null], keyframes: [{ objects: [] }] },
    { figure_types: [], keyframes: [{ objects: [null] }] }, { figure_types: [{ figure_type_id: 1 }], keyframes: [{ objects: [{ figure_type_id: 1 }] }] }]) {
    assert.equal(documentComplexity(report), 'unknown');
  }
});

function recoveryDatabase({ putError = null, transactionError = null, openError = null, records = [] } = {}) {
  const calls = { opened: 0, closed: 0, aborted: 0, put: [] }, request = {};
  const tx = { error: null, abort() { calls.aborted++; queueMicrotask(() => tx.onabort?.()); }, objectStore(name) {
    assert.ok(['documents','metadata'].includes(name)); return {
      getAll(){const request={result:records};queueMicrotask(()=>request.onsuccess?.());return request;},
      put(value, key) { if (putError) throw putError; if(name==='documents')calls.put.push({ value, key }); }
    };
  } };
  const db = { close() { calls.closed++; }, createObjectStore() {}, transaction(name, mode) {
    assert.deepEqual(name, ['documents','metadata']); assert.equal(mode, 'readwrite'); if (transactionError) throw transactionError; return tx;
  } };
  const database = { open(name, version) { calls.opened++; assert.equal(name, 'stykanimate-recovery'); assert.equal(version, 2);
    queueMicrotask(() => { if (openError) { request.error = openError; request.onerror?.(); } else { request.result = db; request.onsuccess?.(); } });
    return request;
  } };
  return { database, calls, tx };
}

test('browser recovery resolves true only after its transaction commits', async () => {
  const f = recoveryDatabase(), controller = new AbortController();
  let settled = false;
  const result = writeBrowserRecovery(new Blob(['document']), 'recovery-name', controller.signal, f.database).then(value => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.equal(f.calls.put.length, 1); assert.equal(settled, false, 'put submission is not a committed recovery');
  f.tx.oncomplete(); assert.equal(await result, true); assert.equal(f.calls.closed, 1);
  controller.abort(); assert.equal(f.calls.aborted, 0, 'commit removes abort listener');
});

test('browser recovery reports cancellation before open, before transaction and during write as false', async () => {
  for (const moment of ['before-open', 'before-transaction', 'during-write']) {
    const f = recoveryDatabase(), controller = new AbortController();
    if (moment === 'before-open') controller.abort();
    const result = writeBrowserRecovery(new Blob(), 'name', controller.signal, f.database);
    if (moment === 'before-transaction') controller.abort();
    if (moment === 'during-write') { await new Promise(setImmediate); controller.abort(); }
    assert.equal(await result, false);
    assert.equal(f.calls.opened, moment === 'before-open' ? 0 : 1);
    assert.equal(f.calls.closed, moment === 'before-open' ? 0 : 1);
    assert.equal(f.calls.put.length, moment === 'during-write' ? 1 : 0);
  }
});

test('browser recovery rejects storage failures instead of reporting success or cancellation', async () => {
  for (const failure of ['openError', 'transactionError', 'putError', 'transaction-event', 'unexpected-abort']) {
    const error = new Error(`Storage failure: ${failure}`), f = recoveryDatabase({ [failure]: error }), controller = new AbortController();
    const result = writeBrowserRecovery(new Blob(), 'name', controller.signal, f.database);
    const rejected = assert.rejects(result, failure === 'unexpected-abort' ? /Recovery transaction aborted/ : error);
    if (failure === 'transaction-event' || failure === 'unexpected-abort') {
      await new Promise(setImmediate);
      if (failure === 'transaction-event') { f.tx.error = error; f.tx.onerror(); } else f.tx.onabort();
    }
    await rejected;
    assert.ok(f.calls.closed > 0 || failure === 'openError');
  }
});

test('browser recovery aborts count and byte capacity failures before submitting project bytes', async () => {
  for(const records of [Array.from({length:8},(_,i)=>({id:String(i),size:1})),[{id:'other',size:512*1024*1024}]]){
    const f=recoveryDatabase({records});
    await assert.rejects(writeBrowserRecovery(new Blob(['new work']),'name',undefined,f.database),/Recovery storage is full/);
    assert.equal(f.calls.put.length,0);
    assert.equal(f.calls.aborted,1);
    assert.equal(f.calls.closed,1);
  }
});
