import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { RecoveryStore } = createRequire(import.meta.url)('../desktop/recovery.cjs');
const directory = () => mkdtemp(path.join(os.tmpdir(), 'stykanimate-recovery-test-'));
const document = JSON.stringify({ version: 5, keyframes: [{ objects: [] }] });
const data = Buffer.from(document).toString('base64');

test('recovery survives a new store instance with the canonical bytes unchanged', async () => {
  const root = await directory();
  const first = new RecoveryStore(root);
  assert.equal(await first.get(), null);
  await first.save({ data, name: 'Walking practice' });
  const restarted = new RecoveryStore(root);
  const result = await restarted.get();
  assert.equal(result.data, data);
  assert.equal(result.name, 'Walking practice');
  assert.equal(await readFile(path.join(root, 'recovery.styk'), 'utf8'), document);
  await restarted.delete();
  assert.equal(await restarted.get(), null);
});

test('serialized autosaves retain the latest complete document', async () => {
  const root = await directory();
  const store = new RecoveryStore(root);
  await Promise.all([
    store.save({ data: Buffer.from('first').toString('base64'), name: 'First' }),
    store.save({ data: Buffer.from('second').toString('base64'), name: 'Second' }),
    store.save({ data, name: 'Latest' }),
  ]);
  const result = await new RecoveryStore(root).get();
  assert.equal(result.data, data);
  assert.equal(result.name, 'Latest');
});

test('invalid or oversized writes preserve the previous recovery', async () => {
  const root = await directory();
  const store = new RecoveryStore(root, { maxBytes: 16 });
  const original = Buffer.from('original').toString('base64');
  await store.save({ data: original, name: 'Good' });
  await assert.rejects(store.save({ data: 'bad%%%=', name: 'Bad' }), /base64/);
  await assert.rejects(store.save({ data: Buffer.alloc(17).toString('base64') }), /limit/);
  assert.equal((await store.get()).data, original);
});

test('recovery tolerates missing or interrupted name metadata', async () => {
  const root = await directory();
  const store = new RecoveryStore(root);
  await store.save({ data, name: '../unsafe:name' });
  assert.equal((await store.get()).name, '.._unsafe_name');
  await writeFile(path.join(root, 'recovery.json'), '{');
  assert.equal((await new RecoveryStore(root).get()).data, data);
});

const slots = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'];
const put = async (store, slot, text, name) => {
  const { file } = store.paths(slot);
  await writeFile(file, text);
  await store.updateMetadata(name, slot);
};

test('each open project keeps its own copy beside the single copy of earlier versions', async () => {
  const root = await directory();
  const store = new RecoveryStore(root);
  await store.save({ data, name: 'Earlier version' });
  await put(store, slots[0], 'first project', 'First');
  await new Promise(resolve => setTimeout(resolve, 15));
  await put(store, slots[1], 'second project', 'Second');
  const listed = await new RecoveryStore(root).list();
  assert.deepEqual(listed.map(record => record.slot), [slots[1], slots[0], null]);
  assert.deepEqual(listed.map(record => record.name), ['Second', 'First', 'Earlier version']);
  assert.equal(listed[0].size, 'second project'.length);
  assert.equal((await store.info(slots[0])).name, 'First');
  assert.equal((await store.info()).name, 'Earlier version');
  await store.delete(slots[0]);
  assert.equal(await store.info(slots[0]), null);
  assert.equal(await readFile(store.paths(slots[1]).file, 'utf8'), 'second project');
  assert.equal((await store.get()).data, data);
  await store.deleteAll();
  assert.deepEqual(await store.list(), []);
});

test('a slot name is an issued identifier, never a path', async () => {
  const store = new RecoveryStore(await directory());
  for (const slot of ['../recovery', 'recovery', 'C:\Windows\win.ini', '0f8fad5b-d9cb-469f-a165-70867728950e/..', '', 42, {}])
    assert.throws(() => store.paths(slot), /no longer available/);
  assert.equal(path.dirname(store.paths(slots[0]).file), store.directory);
});

test('copies left behind make room oldest first, never one an open project owns', async () => {
  const root = await directory();
  const store = new RecoveryStore(root, { maxSlots: 2 });
  for (const [index, slot] of slots.entries()) {
    await put(store, slot, `project ${index}`, `Project ${index}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await store.save({ data, name: 'Earlier version' });
  assert.equal(await store.prune(new Set([slots[0]])), 1);
  const kept = (await store.list()).map(record => record.slot);
  assert.deepEqual(new Set(kept), new Set([null, slots[0], slots[2]]));
  assert.equal(await store.prune(new Set(slots)), 0);
});

test('an unreadable copy is left out of the list and stays on disk', async () => {
  const root = await directory();
  const store = new RecoveryStore(root, { maxBytes: 8 });
  await put(store, slots[0], 'tiny', 'Good');
  await writeFile(store.paths(slots[1]).file, 'far more than eight bytes');
  assert.deepEqual((await store.list()).map(record => record.slot), [slots[0]]);
  assert.equal(await readFile(store.paths(slots[1]).file, 'utf8'), 'far more than eight bytes');
});
