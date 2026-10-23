import test from 'node:test';
import assert from 'node:assert/strict';
import {computePosition, parsePlacement, placeFloating, positionArea, supportsAnchorPositioning, toRect, viewportBounds} from '../src/ui/anchor-position.mjs';

const WINDOW = {width: 1280, height: 720};
const button = (left, top, width = 80, height = 28) => ({left, top, width, height, right: left + width, bottom: top + height});
const place = (options) => computePosition({viewport: WINDOW, ...options});

test('placements parse, and points and rectangles normalise', () => {
  assert.deepEqual(parsePlacement('right-start'), {side: 'right', align: 'start'});
  assert.deepEqual(parsePlacement('top'), {side: 'top', align: 'center'});
  assert.deepEqual(parsePlacement('diagonal-middle'), {side: 'bottom', align: 'center'});
  assert.deepEqual(toRect({x: 10, y: 20}), {left: 10, top: 20, width: 0, height: 0, right: 10, bottom: 20});
  assert.deepEqual(viewportBounds({width: 500, height: 340}, {topInset: 50}), {left: 8, right: 492, top: 50, bottom: 332});
  assert.deepEqual(viewportBounds({width: 100, height: 40}, {topInset: 500}).top, 32, 'the inset never passes the bottom');
});

test('a menu that fits opens below its button, aligned to its start', () => {
  const result = place({anchor: button(100, 10), size: {width: 240, height: 300}});
  assert.deepEqual([result.x, result.y, result.placement, result.maxHeight], [100, 44, 'bottom-start', null]);
});

test('near the bottom it flips above; with no room either way it fits the larger side and scrolls', () => {
  const flipped = place({anchor: button(100, 600), size: {width: 240, height: 300}});
  assert.deepEqual([flipped.side, flipped.y, flipped.y + flipped.height], ['top', 294, 594]);
  const tall = place({anchor: button(100, 300), size: {width: 240, height: 900}});
  assert.equal(tall.side, 'bottom', '300 below the button beats 286 above it');
  assert.deepEqual([tall.y, tall.maxHeight, tall.y + tall.height], [334, 378, 712]);
});

test('the title band is never covered: the top stays below topInset', () => {
  const band = 50;
  const upward = place({anchor: button(100, 200), size: {width: 240, height: 400}, placement: 'top-start', topInset: band});
  assert.equal(upward.side, 'bottom', 'too little room between the band and the button: open below');
  const small = computePosition({anchor: {x: 250, y: 300}, size: {width: 240, height: 400}, viewport: {width: 500, height: 340}, topInset: band + 6, overlap: true});
  assert.ok(small.y >= band + 6, `menu top ${small.y} is below the band`);
  assert.ok(small.y + small.height <= 332 && small.x >= 8 && small.x + small.width <= 492, 'and the whole menu is inside a 500×340 window');
});

test('it shifts along the anchor to stay inside, and flips its alignment first when that fits', () => {
  const shifted = place({anchor: button(1200, 10), size: {width: 240, height: 100}, placement: 'bottom'});
  assert.equal(shifted.x, 1280 - 8 - 240);
  const aligned = place({anchor: button(1150, 10, 100), size: {width: 240, height: 100}, placement: 'bottom-start'});
  assert.deepEqual([aligned.align, aligned.x], ['end', 1250 - 240], 'right edges line up instead');
  const wide = place({anchor: button(10, 10), size: {width: 2000, height: 100}});
  assert.deepEqual([wide.x, wide.maxWidth], [8, 1264], 'wider than the window: capped');
});

test('context menus open at the pointer and flip left and up near the edges', () => {
  const corner = place({anchor: {x: 1200, y: 650}, size: {width: 232, height: 200}, offset: 2});
  assert.deepEqual([corner.side, corner.align], ['top', 'end']);
  assert.deepEqual([corner.x + corner.width, corner.y + corner.height], [1200, 648]);
  const open = place({anchor: {x: 300, y: 200}, size: {width: 232, height: 200}, offset: 2});
  assert.deepEqual([open.x, open.y], [300, 202]);
});

test('submenus open beside their row and flip to the left at the window edge', () => {
  const row = {left: 1000, right: 1232, top: 100, bottom: 128, width: 232, height: 28};
  const right = place({anchor: {...row, left: 400, right: 632}, size: {width: 232, height: 150}, placement: 'right-start', offset: 2});
  assert.deepEqual([right.side, right.x, right.y], ['right', 634, 100]);
  const left = place({anchor: row, size: {width: 232, height: 150}, placement: 'right-start', offset: 2});
  assert.deepEqual([left.side, left.x], ['left', 1000 - 2 - 232]);
});

test('a tooltip never covers its invoker, even where it cannot fit', () => {
  const top = place({anchor: button(600, 12), size: {width: 120, height: 24}, placement: 'top', fit: false});
  assert.deepEqual([top.side, top.y], ['bottom', 46], 'no room above the button: below it');
  const cramped = computePosition({anchor: button(10, 2, 80, 36), size: {width: 120, height: 24}, viewport: {width: 200, height: 40}, placement: 'top', fit: false});
  const anchor = button(10, 2, 80, 36);
  assert.ok(cramped.y + cramped.height <= anchor.top || cramped.y >= anchor.bottom, 'it stays off the button');
  const clamped = computePosition({anchor: button(10, 2, 80, 36), size: {width: 120, height: 24}, viewport: {width: 200, height: 40}, placement: 'top', fit: false, overlap: true});
  assert.ok(clamped.y >= 8 && clamped.y + clamped.height <= 32 + 24, 'overlap: true keeps it in the window instead');
});

test('CSS anchor positioning maps placements to position-area', () => {
  assert.equal(positionArea('bottom-start'), 'block-end span-inline-end');
  assert.equal(positionArea('top'), 'block-start');
  assert.equal(positionArea('right-start'), 'inline-end span-block-end');
  assert.equal(positionArea('left-end'), 'inline-start span-block-start');
  assert.equal(supportsAnchorPositioning(undefined), false);
  assert.equal(supportsAnchorPositioning({supports: () => true}), true);
});

test('placeFloating measures the box at the window corner, not where it was last placed', () => {
  // A shrink-to-fit box (the one tooltip) left near the right edge wraps and measures narrow and tall there.
  const style = {left: '1180px', top: '200px', maxWidth: '', maxHeight: ''};
  const element = {
    style, dataset: {}, ownerDocument: {defaultView: {innerWidth: 1280, innerHeight: 720}},
    getBoundingClientRect: () => (Number.parseFloat(style.left) > 1100 ? {width: 92, height: 48} : {width: 180, height: 24}),
  };
  const result = placeFloating(element, button(100, 300, 28, 28), {placement: 'top', offset: 6, fit: false});
  assert.deepEqual([result.width, result.height], [180, 24], 'measured at its natural size');
  assert.deepEqual([style.left, style.top], ['24px', '270px'], 'centred on the button, 6px above it');
  assert.equal(element.dataset.side, 'top');
});
