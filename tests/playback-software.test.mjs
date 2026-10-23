import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackCache } from '../src/playback.mjs';
import { compilePlaybackPacket, packetTransferables } from '../src/playback-worker.mjs';
import { ensureLayerState } from '../src/layers.mjs';
import { createDemo } from '../src/demo.mjs';
import { nodeWorkerFactory } from './playback.test.mjs';

test('software packets carry one composited surface record instead of vectors', async () => {
  const report = createDemo();
  const packet = await compilePlaybackPacket(report, 0, { softwareFrames: true, hiddenKey: 'sig' });
  assert.equal(packet.softwareFrames, true);
  assert.equal(packet.hiddenKey, 'sig');
  assert.equal(packet.shapes.length, 0);
  assert.deepEqual([...packet.transforms], [0, 0, 1, 1]);
  assert.equal(packet.groups.length, 0);
  assert.equal(packet.cameraEnabled, true);
  assert.equal(packet.storedFrames, false);
  assert.equal(packet.frameIndex, 0);
  assert.ok(packet.uids instanceof Uint32Array && packet.uids.length > 0);
  assert.ok(packet.byteLength > 128);
  // Node has no OffscreenCanvas: the packet still transfers and reports safely.
  assert.equal(packet.compatibility.length, 0);
  packetTransferables(packet);
});

test('software packets bake session-hidden and layer-hidden figures out of the uid set', async () => {
  const report = createDemo(), all = await compilePlaybackPacket(report, 0, { softwareFrames: true });
  const hiddenUid = all.uids[0];
  const packet = await compilePlaybackPacket(report, 0, { softwareFrames: true, hiddenUids: [hiddenUid] });
  assert.ok(!packet.uids.includes(hiddenUid), 'A hidden uid remained in the baked visibility set.');
  assert.equal(packet.uids.length, all.uids.length - 1);
  const layered = createDemo(); ensureLayerState(layered);
  for (const layer of Object.values(layered._styk.layers.byId)) layer.visible = false;
  const layerHidden = await compilePlaybackPacket(layered, 0, { softwareFrames: true });
  assert.equal(layerHidden.uids.length, 0, 'Layer-hidden figures stayed in the packet.');
});

test('software packets honor the camera view baked into their surface', async () => {
  const report = createDemo(); report.keyframes[0].camera = { x: 200, y: 100, angle_rad: .25, scale: .5 };
  const camera = await compilePlaybackPacket(report, 0, { softwareFrames: true });
  const neutral = await compilePlaybackPacket(report, 0, { softwareFrames: true, cameraEnabled: false });
  assert.equal(camera.cameraEnabled, true); assert.equal(neutral.cameraEnabled, false);
  assert.notEqual(camera.resolution, neutral.resolution, 'Camera zoom should change the baked surface density.');
  await assert.rejects(compilePlaybackPacket(report, 0, { softwareFrames: true, cameraEnabled: 'false' }), /boolean/);
});

test('the playback cache prepares and releases software packets through the worker', async () => {
  const report = createDemo(), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report, { softwareFrames: true, hiddenUids: [1], hiddenKey: 'one' });
    await cache.prepareRange([0, 1]);
    const packet = cache.get(0);
    assert.equal(packet.softwareFrames, true);
    assert.equal(packet.hiddenKey, 'one');
    assert.ok(!packet.uids.includes(1));
    cache.updateView({ softwareFrames: true, hiddenUids: [1], hiddenKey: 'two' });
    assert.equal(cache.get(0), null, 'A visibility signature change must drop baked packets.');
    await cache.prepareRange([0]);
    const latest = cache.get(0);
    assert.equal(latest.hiddenKey, 'two');
    assert.notEqual(latest.key, packet.key, 'A hidden-signature change must recompile under a new revision.');
  } finally { cache.dispose(); }
});

test('switching packet formats evicts stale surfaces and camera-only view changes retain them', async () => {
  const report = createDemo(), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report, { softwareFrames: true, hiddenKey: 'a' });
    await cache.prepareRange([0]);
    cache.updateView({ softwareFrames: false });
    assert.equal(cache.get(0), null, 'Vector playback must not present a baked software surface.');
    await cache.prepareRange([0]);
    const vector = cache.get(0);
    assert.equal(vector.softwareFrames, undefined);
    assert.ok(vector.shapes.length > 0);
    cache.updateView({ softwareFrames: true, hiddenKey: 'a' });
    assert.equal(cache.get(0), null, 'Software playback must not reuse vector packets.');
    await cache.prepareRange([0]);
    const packet = cache.get(0);
    assert.equal(packet.cameraEnabled, true);
    cache.updateView({ softwareFrames: true, hiddenKey: 'a', cameraEnabled: false });
    // Baked packets are view-cropped: reading under the other camera mode
    // evicts so the current view recompiles, while GPU prepared frames retain.
    assert.equal(cache.get(0), null, 'A camera toggle must not present the other crop.');
    await cache.prepareRange([0]);
    assert.equal(cache.get(0).cameraEnabled, false);
  } finally { cache.dispose(); }
});

test('stale and evicted software packets release their transferred bitmaps', async () => {
  const messages = [], cache = new PlaybackCache({ workerFactory: () => ({
    postMessage: message => messages.push(message), addEventListener() {}, terminate() {}
  }) });
  cache.report = createDemo(); cache.totalTicks = 4; cache.softwareFrames = true; cache.hiddenKey = 'x';
  try {
    const pending = cache.prepareRange([0]);
    await new Promise(resolve => setImmediate(resolve));
    let closed = 0;
    cache._receive({ type: 'packet', revision: cache.revision - 1, tick: 0, packet: {
      tick: 0, revision: cache.revision - 1, softwareFrames: true, byteLength: 64,
      compatibility: [{ bitmap: { width: 2, height: 2, close() { closed++; } } }] } });
    assert.equal(closed, 1, 'A stale-revision surface must close before packet accounting.');
    cache._receive({ type: 'packet', revision: cache.revision, tick: 0, packet: {
      tick: 0, revision: cache.revision, softwareFrames: true, hiddenKey: 'x', byteLength: 64,
      compatibility: [{ bitmap: { width: 2, height: 2, close() { closed++; } } }] } });
    await pending;
    cache.invalidate();
    assert.equal(closed, 2, 'Invalidation must close the prepared surface.');
    assert.equal(cache.stats.bytes, 0);
  } finally { cache.dispose(); }
});
