import test from 'node:test';
import assert from 'node:assert/strict';
import {installCanvasPinch, pinchView} from '../src/canvas-pinch.mjs';

test('the artwork under the starting midpoint follows the fingers', () => {
  const base = {x: 40, y: 30, scale: 0.5, rotation: 0.2};
  const start = {mid: {x: 200, y: 150}, distance: 100};
  // Spreading to twice the distance around the same midpoint doubles the zoom about that point.
  const zoomed = pinchView(base, start, {mid: {x: 200, y: 150}, distance: 200});
  assert.equal(zoomed.scale, 1);
  assert.equal(zoomed.x, 200 - (200 - 40) * 2); assert.equal(zoomed.y, 150 - (150 - 30) * 2);
  assert.equal(zoomed.rotation, 0.2, 'other view properties are kept');
  // The point of the artwork under the starting midpoint is under the current one.
  const artwork = {x: (start.mid.x - base.x) / base.scale, y: (start.mid.y - base.y) / base.scale};
  const moved = pinchView(base, start, {mid: {x: 260, y: 90}, distance: 150});
  assert.ok(Math.abs(moved.x + artwork.x * moved.scale - 260) < 1e-9 && Math.abs(moved.y + artwork.y * moved.scale - 90) < 1e-9);
  // Moving both fingers without changing their distance only pans.
  const panned = pinchView(base, start, {mid: {x: 230, y: 140}, distance: 100});
  assert.deepEqual([panned.scale, panned.x, panned.y], [0.5, 70, 20]);
  assert.equal(pinchView(base, start, {mid: start.mid, distance: 1e9}).scale, 100, 'zoom is limited like the wheel');
  assert.equal(pinchView(base, start, {mid: start.mid, distance: 0}).scale, 0.001, 'fingers together stop at the smallest zoom');
  assert.equal(pinchView(base, {mid: start.mid, distance: 0}, {mid: start.mid, distance: 50}).scale, 25, 'fingers that started together cannot divide by zero');
});

function canvas({enabled = () => true} = {}) {
  const overlay = new EventTarget();
  const log = {seen: [], starts: 0, ends: 0, views: []};
  let view = {x: 0, y: 0, scale: 1};
  const gesture = installCanvasPinch({overlay, viewport: {getBoundingClientRect: () => ({left: 10, top: 20})},
    getView: () => view, setView: next => { view = next; log.views.push(next); }, enabled,
    onStart: () => { log.starts++; }, onEnd: () => { log.ends++; }});
  // The canvas's own handlers come after the pinch listeners; whatever reaches them was not taken.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) overlay.addEventListener(type, event => log.seen.push(`${type}:${event.pointerId}`));
  const send = (type, pointerId, x, y, pointerType = 'touch') => overlay.dispatchEvent(Object.assign(new Event(type, {cancelable: true}), {pointerId, pointerType, clientX: x, clientY: y}));
  return {overlay, log, gesture, send, get view() { return view; }};
}

test('a single finger is left to the canvas', () => {
  const page = canvas();
  page.send('pointerdown', 1, 110, 120); page.send('pointermove', 1, 130, 140); page.send('pointerup', 1, 130, 140);
  assert.deepEqual(page.log.seen, ['pointerdown:1', 'pointermove:1', 'pointerup:1']);
  assert.equal(page.log.starts, 0); assert.equal(page.gesture.active, false);
});

test('a second finger cancels the first one\'s edit and pinches, without the canvas seeing either finger', () => {
  const page = canvas();
  page.send('pointerdown', 1, 110, 120);
  page.send('pointerdown', 2, 210, 120); // 100 px apart, midpoint (150, 100) in viewport coordinates
  assert.equal(page.log.starts, 1); assert.equal(page.gesture.active, true);
  page.send('pointermove', 2, 310, 120);  // 200 px apart
  assert.equal(page.view.scale, 2);
  assert.deepEqual([page.view.x, page.view.y], [200 - 150 * 2, 100 - 100 * 2], 'anchored at the midpoint, which moved from 150 to 200');
  page.send('pointermove', 1, 110, 120);
  assert.deepEqual(page.log.seen, ['pointerdown:1'], 'only the first finger\'s own press reached the canvas');
  page.send('pointerup', 2, 310, 120);
  assert.equal(page.log.ends, 1); assert.equal(page.gesture.active, false);
  // The finger still down cannot move a joint or select a figure, however it moves or lifts.
  page.send('pointermove', 1, 150, 150); page.send('pointerup', 1, 150, 150);
  assert.deepEqual(page.log.seen, ['pointerdown:1']);
  // The next touch is an ordinary press again.
  page.send('pointerdown', 3, 110, 120); page.send('pointerup', 3, 110, 120);
  assert.deepEqual(page.log.seen, ['pointerdown:1', 'pointerdown:3', 'pointerup:3']);
});

test('a third finger is ignored, and a cancelled touch ends the pinch', () => {
  const page = canvas();
  page.send('pointerdown', 1, 110, 120); page.send('pointerdown', 2, 210, 120);
  const views = page.log.views.length;
  page.send('pointerdown', 3, 160, 200); page.send('pointermove', 3, 170, 210);
  assert.equal(page.log.views.length, views, 'a third finger does not steer the pinch');
  assert.equal(page.log.starts, 1);
  page.send('pointercancel', 1, 110, 120);
  assert.equal(page.log.ends, 1);
  page.send('pointerup', 2, 210, 120); page.send('pointerup', 3, 160, 200);
  assert.deepEqual(page.log.seen, ['pointerdown:1'], 'no leftover finger reaches the canvas');
});

test('pinching starts from the first finger’s current position after its pan', () => {
  const page=canvas();
  page.send('pointerdown',1,110,120);page.send('pointermove',1,160,120);
  page.send('pointerdown',2,260,120);page.send('pointermove',2,360,120);
  assert.equal(page.view.scale,2);
  assert.equal(page.view.x,-150);
});

test('cancelling navigation ignores held fingers until they lift', () => {
  const page=canvas();
  page.send('pointerdown',1,110,120);page.send('pointerdown',2,210,120);
  page.gesture.cancel();const views=page.log.views.length;
  page.send('pointermove',1,150,150);page.send('pointerup',1,150,150);page.send('pointerup',2,210,120);
  assert.equal(page.log.views.length,views);assert.equal(page.log.ends,1);
  assert.deepEqual(page.log.seen,['pointerdown:1']);
});

test('mouse and pen are never pinches, and a disabled canvas ignores touch', () => {
  const page = canvas();
  page.send('pointerdown', 1, 110, 120, 'pen'); page.send('pointerdown', 2, 210, 120, 'mouse');
  assert.equal(page.log.starts, 0);
  assert.deepEqual(page.log.seen, ['pointerdown:1', 'pointerdown:2']);

  let on = false;
  const draw = canvas({enabled: () => on});
  draw.send('pointerdown', 1, 110, 120); draw.send('pointerdown', 2, 210, 120);
  assert.equal(draw.log.starts, 0, 'Draw mode keeps its own gesture');
  assert.deepEqual(draw.log.seen, ['pointerdown:1', 'pointerdown:2']);
});
