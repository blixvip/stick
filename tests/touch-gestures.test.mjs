/**
 * The touch interface's gestures and modifiers, as pure logic
 * (src/touch/touch-gestures.mjs, src/touch/modifier-dock.mjs): taps, holds,
 * drags, double taps, multi-finger taps, and the desktop events a modifier
 * turns a finger's events into.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {SLOP, beyondSlop, createMultiTap, isDoubleTap} from '../src/touch/touch-gestures.mjs';
import {MODIFIER_SETS, combinedModifiers, modifiersFor, shapedPointerInit} from '../src/touch/modifier-dock.mjs';
import {SHEET_DETENTS, sheetDetent} from '../src/touch/touch-shell.mjs';

test('A still finger may wander a little and stay still', () => {
  assert.equal(beyondSlop({x: 0, y: 0}, {x: 6, y: 8}), false);
  assert.equal(beyondSlop({x: 0, y: 0}, {x: 8, y: 8}), true);
  assert.equal(beyondSlop({x: 0, y: 0}, {x: SLOP, y: 0}), false);
});

test('Two taps close in time and place make a double tap', () => {
  const first = {x: 100, y: 100, time: 1000};
  assert.equal(isDoubleTap(first, {x: 110, y: 104, time: 1250}), true);
  assert.equal(isDoubleTap(first, {x: 110, y: 104, time: 1400}), false, 'too slow');
  assert.equal(isDoubleTap(first, {x: 160, y: 100, time: 1100}), false, 'too far apart');
  assert.equal(isDoubleTap(null, first), false);
});

test('Fingers that land and lift together, quickly and still, are a two- or three-finger tap', () => {
  const taps = createMultiTap();
  taps.down({id: 1, x: 0, y: 0, time: 0});
  taps.down({id: 2, x: 60, y: 0, time: 20});
  assert.equal(taps.up({id: 1, time: 120}), null, 'a finger is still down');
  assert.equal(taps.up({id: 2, time: 140}), 2);

  taps.down({id: 1, x: 0, y: 0, time: 1000});
  taps.down({id: 2, x: 60, y: 0, time: 1010});
  taps.down({id: 3, x: 30, y: 50, time: 1020});
  taps.up({id: 3, time: 1100});
  taps.up({id: 1, time: 1110});
  assert.equal(taps.up({id: 2, time: 1120}), 3);

  taps.down({id: 1, x: 0, y: 0, time: 2000});
  taps.down({id: 2, x: 60, y: 0, time: 2010});
  taps.move({id: 2, x: 120, y: 0});
  taps.up({id: 1, time: 2100});
  assert.equal(taps.up({id: 2, time: 2110}), 0, 'a pinch is not a tap');

  taps.down({id: 1, x: 0, y: 0, time: 3000});
  taps.down({id: 2, x: 60, y: 0, time: 3010});
  taps.up({id: 1, time: 3600});
  assert.equal(taps.up({id: 2, time: 3610}), 0, 'a long press with two fingers is not a tap');

  taps.down({id: 1, x: 0, y: 0, time: 4000});
  assert.equal(taps.up({id: 1, time: 4050}), 0, 'one finger is the tools’ tap, not a gesture');
});

test('Each workspace’s tools offer their own modifiers, named for what they do', () => {
  assert.deepEqual(modifiersFor('animate', 'select'), ['bend', 'stretch', 'add', 'transform', 'handles']);
  assert.deepEqual(modifiersFor('draw', 'drawing-brush'), ['line', 'pick', 'size']);
  assert.deepEqual(modifiersFor('draw', 'drawing-lasso'), ['add', 'subtract']);
  assert.deepEqual(modifiersFor('animate', 'hand'), [], 'panning needs none');
  assert.deepEqual(modifiersFor('nowhere', 'select'), []);
  assert.deepEqual(modifiersFor('animate', 'select', {spatial: true}).at(-1), 'depth', 'a figure with 3D parts adds Depth (hold D)');
  assert.ok(!modifiersFor('draw', 'drawing-brush', {spatial: true}).includes('depth'));
  for (const tools of Object.values(MODIFIER_SETS)) for (const names of Object.values(tools)) assert.ok(names.length <= 5, 'a column a thumb can reach (Depth may make six; the column scrolls)');
});

test('Modifiers combine into the right button and the keys', () => {
  assert.deepEqual(combinedModifiers(['bend', 'add']), {secondary: true, shift: true, ctrl: false, alt: false});
  assert.deepEqual(combinedModifiers(['stretch', 'transform']), {secondary: false, shift: false, ctrl: true, alt: true});
  assert.deepEqual(combinedModifiers(['handles']), {secondary: false, shift: false, ctrl: false, alt: false}, 'a held key is not a modifier key');
});

test('A finger’s events become the right button and held keys, as the desktop handlers expect', () => {
  const down = {type: 'pointerdown', clientX: 10, clientY: 20, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, bubbles: true, cancelable: true};
  const bent = shapedPointerInit(down, {secondary: true, shift: false, ctrl: true, alt: false});
  assert.equal(bent.button, 2);
  assert.equal(bent.buttons, 2);
  assert.equal(bent.ctrlKey, true);
  assert.equal(bent.shiftKey, false);
  assert.equal(bent.pointerId, 7);
  assert.equal(bent.pointerType, 'touch');
  const move = shapedPointerInit({...down, type: 'pointermove', button: -1}, {secondary: true});
  assert.equal(move.button, -1, 'a move reports no button change');
  assert.equal(move.buttons, 2, 'while the right button is held');
  const up = shapedPointerInit({...down, type: 'pointerup', buttons: 0}, {secondary: true});
  assert.equal(up.button, 2);
  assert.equal(up.buttons, 0);
  const keys = shapedPointerInit(down, {shift: true, alt: true});
  assert.equal(keys.button, 0);
  assert.equal(keys.buttons, 1);
  assert.deepEqual([keys.shiftKey, keys.altKey, keys.ctrlKey], [true, true, false]);
});

test('A bottom sheet rests at the nearest height, or closes when dragged low', () => {
  assert.deepEqual(SHEET_DETENTS, [0.42, 0.62, 0.92]);
  assert.equal(sheetDetent(0.95), 0.92);
  assert.equal(sheetDetent(0.7), 0.62);
  assert.equal(sheetDetent(0.5), 0.42);
  assert.equal(sheetDetent(0.31), 0.42);
  assert.equal(sheetDetent(0.2), null, 'closes');
  assert.equal(sheetDetent(Number.NaN), null);
});
