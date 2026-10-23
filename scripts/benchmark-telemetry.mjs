import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TelemetryAccumulator } from '../src/telemetry-core.mjs';
const iterations = 250000, rounds = 7;
const result = {};
for (const active of [false, true]) {
  const collector = new TelemetryAccumulator(); collector.configure({ analytics: active, diagnostics: active });
  const samples = [];
  for (let round = 0; round < rounds + 1; round++) {
    const start = performance.now();
    for (let n = 0; n < iterations; n++) { collector.count('edits'); collector.timing('frame_ms', n % 80); }
    const elapsed = performance.now() - start; if (round) samples.push(elapsed / iterations);
    collector.reset();
  }
  samples.sort((a, b) => a - b);
  result[active ? 'enabled' : 'disabled'] = { medianMsPerCounterAndTiming: samples[3], worstMsPerCounterAndTiming: samples.at(-1), iterations, rounds };
}
assert.ok(result.enabled.medianMsPerCounterAndTiming < .05, 'collector should consume less than0.05ms per combined sample');
const bounded = new TelemetryAccumulator(); bounded.configure({ analytics: true, diagnostics: true });
for (let n = 0; n < 100000; n++) { bounded.count('edits'); bounded.timing('frame_ms', n % 1000); }
result.accumulatorBytesAfter100kEvents = Buffer.byteLength(JSON.stringify(bounded.data));
assert.ok(result.accumulatorBytesAfter100kEvents < 2000);
result.note = 'Collector microbenchmark on this machine; excludes IPC, disk, network and manual traces. Renderer samples CPU submission time once every30 rendered frames and batches every15s.';
result.checkedAt = new Date().toISOString();
await mkdir('artifacts', { recursive: true }); await writeFile(path.resolve('artifacts/telemetry-performance.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
