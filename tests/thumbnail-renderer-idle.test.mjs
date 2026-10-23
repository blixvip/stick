import test from 'node:test';
import assert from 'node:assert/strict';
import {ThumbnailRenderer} from '../src/thumbnail-renderer.mjs';

const bitmap = () => ({closed: 0, close() {this.closed++;}});
const canvas = () => ({width: 8, height: 8, getContext: () => ({setTransform() {}, clearRect() {}, drawImage() {}})});
function setup(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker'),
    previousCanvas = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'), workers = [];
  globalThis.Worker = class {
    constructor() {this.handlers = {}; this.messages = []; workers.push(this);}
    addEventListener(type, fn) {(this.handlers[type] ??= []).push(fn);}
    postMessage(message) {
      this.messages.push(message);
      if (message.id === undefined || message.operation === 'cancel') return;
      queueMicrotask(() => {
        const data = message.operation === 'render'
          ? {id: message.id, ok: true, bitmap: bitmap(), renderMs: 1, mediaBytes: 0}
          : {id: message.id, ok: true};
        for (const fn of this.handlers.message || []) fn({data});
      });
    }
    terminate() {this.terminated = true;}
  };
  globalThis.OffscreenCanvas = class {};
  const editor = {report: {keyframes: [{name: 'a', objects: {}}], figure_types: {}, frame_delay_ms: 16}, frameIndex: 0, addEventListener() {}};
  const renderer = new ThumbnailRenderer(editor, {idleMs: 20});
  t.after(() => {
    renderer.destroy();
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker); else delete globalThis.Worker;
    if (previousCanvas) Object.defineProperty(globalThis, 'OffscreenCanvas', previousCanvas); else delete globalThis.OffscreenCanvas;
  });
  return {renderer, workers};
}

test('an idle thumbnail worker releases its document mirror and resnapshots on wake', async t => {
  const {renderer, workers} = setup(t);
  assert.equal(await renderer.renderThumbnail(0, canvas()), true);
  const first = workers[0];
  assert.equal(renderer.loadedVersion, renderer.version);
  assert.ok(first.messages.some(message => message.operation === 'snapshot-complete'));
  t.mock.timers.tick(80);
  assert.equal(first.terminated, true);
  assert.equal(renderer.worker, null);
  assert.equal(renderer.fullSnapshot, true);
  assert.equal(await renderer.renderThumbnail(0, canvas()), true);
  assert.equal(workers.length, 2, 'a fresh worker is spawned after the idle release');
  const modes = workers[1].messages.filter(message => message.operation === 'snapshot-chunk').map(message => message.mode);
  assert.ok(modes.length > 0 && modes.every(mode => mode === 'document'), 'the restarted worker receives a full document snapshot');
  assert.ok(workers[1].messages.some(message => message.operation === 'snapshot-complete'));
});

test('continued requests postpone the idle release', async t => {
  const {renderer, workers} = setup(t);
  for (let i = 0; i < 5; i++) {
    assert.equal(await renderer.renderThumbnail(0, canvas()), true);
    t.mock.timers.tick(8);
    assert.notEqual(workers[0].terminated, true, 'the worker stays alive while renders keep arriving');
  }
  assert.equal(workers.length, 1);
  t.mock.timers.tick(80);
  assert.equal(workers[0].terminated, true, 'the worker releases once renders stop');
});
