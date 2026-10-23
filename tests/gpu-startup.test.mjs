import test from 'node:test';
import assert from 'node:assert/strict';
import {gpuStartupBudget} from '../src/gpu-startup.mjs';

test('GPU startup accepts completed stages and preserves failures', async () => {
  const budget = gpuStartupBudget(1000);
  assert.equal(await budget.wait(Promise.resolve(42)), 42);
  await assert.rejects(budget.wait(Promise.reject(new Error('driver failure'))), /driver failure/);
});

test('GPU startup times out, releases late devices, and rejects subsequent stages', async () => {
  const budget = gpuStartupBudget(15);
  let complete, released = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  await assert.rejects(budget.wait(pending, value => value.destroy()), /timed out/);
  complete({destroy() { released++; }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
  await assert.rejects(budget.wait(Promise.resolve('late')), /timed out/);
});

test('an elapsed budget cannot be renewed by another immediately resolved stage', async () => {
  const budget = gpuStartupBudget(10);
  assert.equal(await budget.wait(Promise.resolve('adapter')), 'adapter');
  await new Promise(resolve => setTimeout(resolve, 20));
  let released = false;
  await assert.rejects(budget.wait(Promise.resolve('device'), () => { released = true; }), /timed out/);
  assert.equal(released, true);
});
