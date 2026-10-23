import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPerformance,recordPerformance,provenance} from '../src/telemetry-performance-schema.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelemetryService } from '../desktop/telemetry.cjs';
import { MAX_SNAPSHOT_BYTES, MAX_OPERATION_CONTEXTS, COUNTERS, TIMINGS, GAUGES, ERROR_MODULES, emptyHistogram, observe, operationContext, sanitizeError, validateSnapshot } from '../src/telemetry-schema.mjs';

const schemaPath = path.resolve('src/telemetry-schema.mjs');
const consent = { analytics: true, diagnostics: true };
const origin = 'https://stykanimate.example';
const initialTime = Date.parse('2026-09-10T10:00:00Z');
const histogram = (value = 120) => { const h = emptyHistogram(); observe(h, value); return h; };
const context = (overrides = {}, milliseconds = 120) => ({ ...operationContext({ operation: 'save', stage: 'serialize', format: 'native', size: '1-10mb', complexity: '100-999', fps: '25-30', outcome: 'succeeded', ...overrides }), timing: histogram(milliseconds) });

async function fixture(options = {}) {
  const directory = options.directory || await mkdtemp(path.join(tmpdir(), 'styk-telemetry-v2-'));
  const requests = [];
  const service = await new TelemetryService({ directory, schemaPath, version: '0.5.6', build: '0123456789abcdef', siteUrl: origin, now: () => initialTime,
    fetchImpl: async (url, init) => { requests.push({ url, ...init }); return new Response('{}'); }, ...options }).init({ timers: false });
  return { directory, service, requests };
}
const snapshot = service => service.preview().snapshots.at(-1);

test('v3 observations keep trusted build provenance across an upgrade and ignore renderer build spoofing',async()=>{
  const {service,directory}=await fixture({build:'a'.repeat(12)});await service.setConsent(consent);
  const performance=emptyPerformance();recordPerformance(performance,'frame',20,{},provenance({release:'99.0.0',build:'f'.repeat(12),traffic:'external'}));
  service.record({epoch:service.epoch,data:{performance}});await service.persist();
  const restored=await fixture({directory,version:'0.6.0',build:'b'.repeat(12)});
  restored.service.record({epoch:restored.service.epoch,data:{performance}});
  const rows=snapshot(restored.service).performance.rows;
  assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.provenance.build),['a'.repeat(12),'b'.repeat(12)]);assert.ok(rows.every(row=>row.provenance.release!=='99.0.0'));
  await service.close();await restored.service.close();
});
test('server reset receipt drops queued diagnostics, preserves usage and invalidates in-flight renderer deltas',async()=>{
  const {service}=await fixture({fetchImpl:async()=>new Response(JSON.stringify({accepted:true,diagnosticGeneration:4}))});await service.setConsent(consent);
  service.count('edits',9);service.count('save_failed',3);
  const epoch=service.epoch;assert.equal(await service.upload({force:true}),true);
  assert.equal(service.state.diagnosticGeneration,4);assert.equal(snapshot(service).counters.edits,9);assert.equal(snapshot(service).counters.save_failed,undefined);
  assert.ok(service.epoch>epoch);assert.equal(service.record({epoch,data:{counters:{save_failed:3}}}),false);
  service.count('save_failed',1);assert.equal(snapshot(service).counters.save_failed,1);await service.close();
});

test('context histograms and safe error fields survive cumulative upload and restart', async () => {
  let now = initialTime;
  const { service, directory, requests } = await fixture({ now: () => now });
  await service.setConsent(consent);
  const error = sanitizeError({ name: 'Error', code: 'ENOSPC', message: 'C:/private/name.styk' }, 'save', now, { stage: 'write', format: 'native', complexity: '100-999' });
  service.record({ epoch: service.epoch, data: { operationContexts: [context()], errors: [error] } });
  service.record({ epoch: service.epoch, data: { operationContexts: [context({}, 80)], errors: [{ ...error, lastAt: now + 5000 }] } });
  await service.upload();
  const sent = JSON.parse(requests[0].body);
  assert.equal(sent.schemaVersion, 3);
  assert.equal(sent.operationContexts.length, 1);
  assert.equal(sent.operationContexts[0].timing.count, 2);
  assert.equal(sent.operationContexts[0].timing.sum, 200);
  assert.equal(sent.errors[0].code, 'disk_full');
  assert.equal(sent.errors[0].stage, 'write');
  assert.equal(sent.errors[0].count, 2);
  assert.ok(!requests[0].body.includes('private'));
  assert.ok(!requests[0].body.includes('firstObservedAt'));
  now += 20 * 60000;
  await service.upload();
  assert.equal(requests.length, 1, 'an unchanged context report creates no extra hosting request');
  await service.close();
  const restored = await fixture({ directory, now: () => now });
  assert.deepEqual(snapshot(restored.service).operationContexts, sent.operationContexts);
  assert.deepEqual(snapshot(restored.service).errors, sent.errors);
  assert.ok(snapshot(restored.service).sequence > sent.sequence);
});

test('context cardinality and cumulative counters stay bounded and report dropped samples', async () => {
  const { service } = await fixture(); await service.setConsent(consent);
  for (const operation of ['save', 'import', 'export']) for (const format of ['native', 'pivot', 'sticknodes', 'png', 'svg', 'gif', 'jpeg', 'video']) {
    service.record({ epoch: service.epoch, data: { operationContexts: [context({ operation, format })] } });
  }
  assert.equal(snapshot(service).operationContexts.length, MAX_OPERATION_CONTEXTS);
  assert.equal(snapshot(service).counters.dropped_operation_contexts, 24 - MAX_OPERATION_CONTEXTS);
  const huge = histogram(1); huge.count = huge.sum = huge.buckets[0] = 1e9;
  service.record({ epoch: service.epoch, data: { timings: { frame_ms: huge }, counters: { edits: 1e9 } } });
  service.record({ epoch: service.epoch, data: { timings: { frame_ms: histogram(2) }, counters: { edits: 1 } } });
  assert.equal(snapshot(service).timings.frame_ms.count, 1e9);
  assert.equal(snapshot(service).counters.edits, 1e9);
  assert.equal(snapshot(service).counters.dropped_samples, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(validateSnapshot(snapshot(service)))) < MAX_SNAPSHOT_BYTES);
});

test('even fully populated bounded summaries remain uploadable within 32 KiB', async () => {
  const { service, requests } = await fixture(); await service.setConsent(consent);
  const huge = histogram(3600000); huge.count = 1e9; huge.sum = 3.6e15; huge.buckets.fill(62500000);
  const errors = Array.from({ length: 20 }, (_, index) => ({ ...sanitizeError({ name: 'TypeError' }), fingerprint: index.toString(16).padStart(8, '0'), count: 1e9,
    frames: ERROR_MODULES.slice(0, 5).map(module => ({ module, line: 1000000 })) }));
  service.record({ epoch: service.epoch, data: {
    counters: Object.fromEntries(COUNTERS.map(key => [key, 1e9])), timings: Object.fromEntries(TIMINGS.map(key => [key, huge])),
    gauges: Object.fromEntries(GAUGES.map(key => [key, 1e9])), errors,
    operationContexts: Array.from({ length: 12 }, (_, index) => ({ ...context({ operation: index < 6 ? 'save' : 'export', format: ['native', 'pivot', 'sticknodes', 'png', 'svg', 'gif'][index % 6] }), timing: huge })),
  } });
  assert.equal(snapshot(service).operationContexts.length, 12);
  assert.equal(snapshot(service).errors.length, 20);
  assert.equal(await service.upload(), true);
  assert.equal(requests.length, 1);
  assert.ok(Buffer.byteLength(requests[0].body) <= MAX_SNAPSHOT_BYTES);
  validateSnapshot(JSON.parse(requests[0].body));
});

test('trusted release metadata changes without attributing mixed internal days to beta users', async () => {
  let now = initialTime;
  const { service, directory } = await fixture({ now: () => now }); await service.setConsent(consent);
  service.record({ epoch: service.epoch, data: { counters: { open: 2 }, app: { version: '999.0.0', channel: 'development', traffic: 'internal', build: 'ffffffffffff' } } });
  assert.equal(snapshot(service).app.version, '0.5.6'); assert.equal(snapshot(service).app.traffic, 'external');
  await service.close();
  const internal = (await fixture({ directory, development: true, internal: false, version: '0.5.7', build: 'fedcba9876543210', now: () => now })).service;
  assert.deepEqual(snapshot(internal).app, { version: '0.5.7', channel: 'development', traffic: 'mixed', build: 'fedcba9876543210' });
  assert.equal(snapshot(internal).counters.open, 2);
  await internal.close();
  const external = (await fixture({ directory, version: '0.5.7', now: () => now })).service;
  assert.equal(snapshot(external).app.traffic, 'mixed');
  now += 86400000; external.count('edits');
  assert.equal(snapshot(external).app.traffic, 'external');
});

test('legacy queued reports retain schema1 while upgraded current days keep totals and unknown provenance', async () => {
  const { service, directory } = await fixture(); await service.setConsent(consent);
  service.count('save_succeeded', 3); service.count('recovery_failed', 7);
  const legacy = JSON.parse(JSON.stringify(snapshot(service)));
  legacy.schemaVersion = 1; legacy.app = { version: '0.5.5', channel: 'beta' }; delete legacy.operationContexts; delete legacy.firstSuccess;
  legacy.milestones = { first_launch: '2026-09-09' };
  service.state.days = { '2026-09-09': { ...legacy, day: '2026-09-09', sequence: legacy.sequence - 1 }, '2026-09-10': legacy };
  service.state.milestones = { ...legacy.milestones }; service.state.acknowledged = legacy;
  delete service.state.firstObservedAt; delete service.state.firstSuccess; await service.persist();
  const restored = await fixture({ directory, version: '0.5.6' });
  const current = snapshot(restored.service);
  assert.equal(restored.service.preview().snapshots[0].schemaVersion, 1);
  assert.equal(current.schemaVersion, 3); assert.equal(current.app.version, '0.5.6'); assert.equal(current.app.traffic, 'unknown');
  assert.equal(current.counters.save_succeeded, 3); assert.equal(current.counters.recovery_failed, 7);
  assert.equal(restored.service.state.firstObservedAt, undefined);
  restored.service.milestone('first_save'); assert.deepEqual(snapshot(restored.service).firstSuccess, {});
  await restored.service.upload(); assert.equal(JSON.parse(restored.requests[0].body).schemaVersion, 1);
});

test('first successful save/export wall-clock buckets survive restart without exact timestamp uploads', async () => {
  let now = initialTime;
  const { service, directory } = await fixture({ now: () => now }); await service.setConsent({ analytics: true, diagnostics: false });
  now += 120000; service.milestone('first_save');
  assert.deepEqual(snapshot(service).firstSuccess, { save: '1-5m' });
  await service.close(); now += 40 * 60000;
  const restored = await fixture({ directory, now: () => now });
  restored.service.milestone('first_export');
  assert.deepEqual(snapshot(restored.service).firstSuccess, { save: '1-5m', export: '30m-2h' });
  now += 10 * 86400000; restored.service.count('edits');
  assert.deepEqual(snapshot(restored.service).firstSuccess, { save: '1-5m', export: '30m-2h' });
  await restored.service.upload();
  assert.ok(!restored.requests[0].body.includes('firstObservedAt'));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'telemetry-state.json'), 'utf8')).firstObservedAt, initialTime);
});

test('category withdrawal and stale IPC cannot retain or inject new context and activation details', async () => {
  let now = initialTime;
  const { service } = await fixture({ now: () => now }); await service.setConsent(consent);
  now += 10000; service.milestone('first_save');
  service.record({ epoch: service.epoch, data: { operationContexts: [context()] } });
  const previousEpoch = service.epoch;
  await service.setConsent({ analytics: false, diagnostics: true });
  assert.deepEqual(snapshot(service).firstSuccess, {}); assert.equal(service.state.firstObservedAt, undefined);
  assert.equal(snapshot(service).operationContexts.length, 1);
  assert.equal(service.record({ epoch: previousEpoch, data: { operationContexts: [context()] } }), false);
  service.record({ epoch: service.epoch, data: { firstSuccess: { export: 'under-1m' }, milestones: { first_export: '2026-09-10' } } });
  assert.deepEqual(snapshot(service).firstSuccess, {});
  await service.setConsent({ analytics: true, diagnostics: false });
  service.record({ epoch: service.epoch, data: { operationContexts: [context()], firstSuccess: { save: 'over-24h' } } });
  assert.deepEqual(snapshot(service).operationContexts, []); assert.deepEqual(snapshot(service).firstSuccess, {});
  await service.deleteData(); assert.deepEqual(service.state.firstSuccess, {}); assert.equal(service.state.firstObservedAt, undefined);
});

test('same-day re-opt-in preserves acknowledged first success without inventing a replacement launch timer', async () => {
  let now = initialTime;
  const { service, directory, requests } = await fixture({ now: () => now }); await service.setConsent(consent);
  now += 120000; service.milestone('first_save'); await service.upload();
  const accepted = JSON.parse(requests[0].body);
  assert.deepEqual(accepted.firstSuccess, { save: '1-5m' });
  const oldEpoch = service.epoch;
  await service.setConsent({ analytics: false, diagnostics: false });
  assert.equal(service.state.firstObservedAt, undefined); assert.deepEqual(service.state.firstSuccess, {});
  now += 120000; await service.setConsent(consent); service.count('edits');
  assert.deepEqual(snapshot(service).firstSuccess, accepted.firstSuccess);
  assert.equal(service.state.firstObservedAt, undefined);
  assert.equal(service.record({ epoch: oldEpoch, data: { milestones: { first_export: '2026-09-10' } } }), false);
  service.milestone('first_export');
  assert.deepEqual(snapshot(service).firstSuccess, { save: '1-5m' }, 'unknown elapsed time after withdrawal stays unmeasured');
  await service.close();
  const restored = await fixture({ directory, now: () => now });
  assert.deepEqual(snapshot(restored.service).firstSuccess, accepted.firstSuccess);
  assert.equal(restored.service.state.firstObservedAt, undefined);
  assert.ok(snapshot(restored.service).sequence > accepted.sequence);
});

test('restoring queued reports enforces the current category choice even if stored row consent is stale', async () => {
  const { service, directory } = await fixture(); await service.setConsent(consent);
  service.milestone('first_save'); service.count('edits');
  service.record({ epoch: service.epoch, data: { operationContexts: [context()] } });
  service.state.consent.analytics = false;
  await service.persist();
  const restored = (await fixture({ directory })).service;
  assert.deepEqual(snapshot(restored).firstSuccess, {});
  assert.deepEqual(snapshot(restored).milestones, {});
  assert.equal(snapshot(restored).counters.edits, undefined);
  assert.equal(snapshot(restored).operationContexts.length, 1);
  assert.equal(restored.state.firstObservedAt, undefined);
  assert.equal(snapshot(restored).consent.analytics, false);
});
