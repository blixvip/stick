import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { TelemetryAccumulator, DesktopTelemetryClient } from '../src/telemetry-core.mjs';
import { InteractionMeasurements, PlaybackMeasurements } from '../src/telemetry-measurements.mjs';
import { documentComplexity } from '../src/telemetry-workload.mjs';
import { PlaybackCadence } from '../src/playback-cadence.mjs';

const rounds = 7, playbackCalls = 250000, observerCallbacks = 25000;
const summarize = samples => { const sorted = [...samples].sort((a, b) => a - b); return { medianMicroseconds: sorted[Math.floor(sorted.length / 2)] * 1000, worstMicroseconds: sorted.at(-1) * 1000 }; };
const result = { checkedAt: new Date().toISOString(), node: process.version, rounds, playbackCallsPerRound: playbackCalls, observerCallbacksPerRound: observerCallbacks, eventEntriesPerCallback: 4 };

for (const enabled of [false, true]) {
  const playbackSamples = [], interactionSamples = [];
  let playbackReportBytes = 0, interactionReportBytes = 0, pendingIds = 0, recentIds = 0;
  for (let round = 0; round <= rounds; round++) {
    const client = new DesktopTelemetryClient(null);
    client.configure({ analytics: enabled, diagnostics: enabled }); client.isForeground = true;
    client.playbackMeasurements = new PlaybackMeasurements(client);
    client.playbackStart({ format: 'native', size: '1-10mb', complexity: '100-999' });
    const playbackStart = performance.now();
    const cadence=new PlaybackCadence();
    for (let n = 0; n < playbackCalls; n++) {
      const now=n*(1000/60);if(enabled)cadence.observe(now);
      client.playbackPresent(now,60,{deadline:now,refreshMs:cadence.interval});
      if (n % 900 === 899) client.playbackStop(); // The same aggregate flush performed by the15-second sampler.
    }
    client.playbackStop();
    const playbackElapsed = performance.now() - playbackStart;
    if (round) playbackSamples.push(playbackElapsed / playbackCalls);
    playbackReportBytes = Math.max(playbackReportBytes, Buffer.byteLength(JSON.stringify(client.data)));

    const c = new TelemetryAccumulator(); c.configure({ analytics: enabled, diagnostics: enabled });
    const measurements = new InteractionMeasurements(c);
    const entries = Array.from({ length: 4 }, (_, index) => ({ interactionId: index < 2 ? 1 : 2, startTime: 0, duration: index % 2 ? 144 : 80, processingStart: 20, processingEnd: 60 }));
    const interactionStart = performance.now();
    for (let n = 0; n < observerCallbacks; n++) {
      const at = n * 200;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]; entry.interactionId = n * 2 + (index < 2 ? 1 : 2); entry.startTime = at; entry.processingStart = at + 20; entry.processingEnd = at + 60;
      }
      measurements.observe(entries, { now: at + 160, foreground: true });
      if (n % 16 === 15) measurements.flush();
    }
    measurements.flush();
    const interactionElapsed = performance.now() - interactionStart;
    if (round) interactionSamples.push(interactionElapsed / observerCallbacks);
    interactionReportBytes = Math.max(interactionReportBytes, Buffer.byteLength(JSON.stringify(c.data)));
    pendingIds = Math.max(pendingIds, measurements.pending.size); recentIds = Math.max(recentIds, measurements.recent.size);
    if (enabled) {
      assert.equal(client.data.counters.playback_observed_intervals, playbackCalls - 1);
      assert.equal(client.data.operationContexts[0].timing.count, playbackCalls - 1);
      assert.equal(c.data.counters.input_observed_interactions, observerCallbacks * 2);
      assert.equal(c.data.counters.input_observer_dropped, undefined);
    } else {
      assert.deepEqual(client.data.counters, {}); assert.deepEqual(c.data.counters, {});
    }
  }
  result[enabled ? 'enabled' : 'disabled'] = {
    playbackPresentPerCall: summarize(playbackSamples), observerPerFourEntryCallback: summarize(interactionSamples),
    playbackAccumulatorBytes: playbackReportBytes, interactionAccumulatorBytes: interactionReportBytes, pendingIdsAfterFlush: pendingIds, retainedRecentIds: recentIds,
  };
}

const report = { figure_types: Array.from({ length: 1024 }, (_, figure_type_id) => ({ figure_type_id, segments: new Array(8) })), keyframes: [{ objects: Array.from({ length: 1024 }, (_, figure_type_id) => ({ figure_type_id })) }] };
const workloadSamples = [];
for (let round = 0; round <= rounds; round++) {
  const started = performance.now();
  for (let n = 0; n < 10000; n++) documentComplexity(report);
  if (round) workloadSamples.push((performance.now() - started) / 10000);
}
result.maxAllowedWorkloadEstimatePerCall = summarize(workloadSamples);
result.note = 'Local JavaScript microbenchmark, not end-to-end application FPS. Playback includes the public client method plus streaming aggregation and periodic summary flush. Observer callbacks receive reused synthetic entries; measurements include grouping/phase histograms, not browser PerformanceObserver delivery or entry allocation. Excludes IPC, disk, networking, native processes and GPU rendering. Disabled production reporting creates no observer/timer; invoking these methods is a conservative disabled-path test. Workload estimation runs at operation boundaries, never per frame.';
assert.ok(result.enabled.playbackPresentPerCall.medianMicroseconds < 50, 'per-presentation aggregation should stay below0.05ms on this machine');
assert.ok(result.enabled.observerPerFourEntryCallback.medianMicroseconds < 500, 'four-entry observer aggregation should stay below0.5ms on this machine');
assert.ok(result.enabled.playbackAccumulatorBytes < 4000 && result.enabled.interactionAccumulatorBytes < 4000);
assert.equal(result.enabled.retainedRecentIds, 128);
await mkdir('artifacts/telemetry', { recursive: true });
await writeFile('artifacts/telemetry/measurement-performance.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
