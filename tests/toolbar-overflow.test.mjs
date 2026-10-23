import test from 'node:test';
import assert from 'node:assert/strict';
import {OVERFLOW_ATTRIBUTE, computeOverflow, installToolbarOverflow, overflowMenuItems} from '../src/ui/toolbar-overflow.mjs';

const row = (...widths) => widths.map(width => (typeof width === 'number' ? {width} : width));

test('everything stays when the row fits, including the exact width', () => {
  assert.deepEqual(computeOverflow({items: row(40, 40, 40), available: 136, gap: 8, moreWidth: 28}),
    {visible: [0, 1, 2], overflow: [], width: 136, fits: true});
});

test('items leave from the end, and the More button takes its room and a gap', () => {
  // 3 × 40 + 2 × 8 = 136 > 120. Hiding the last leaves 40 + 8 + 40 + 8 + 28 = 124 > 120, so two go.
  const result = computeOverflow({items: row(40, 40, 40), available: 120, gap: 8, moreWidth: 28});
  assert.deepEqual(result, {visible: [0], overflow: [1, 2], width: 76, fits: true});
});

test('the lowest priority leaves first; pinned items never leave', () => {
  const items = row({width: 50, pinned: true}, {width: 50, priority: 2}, {width: 50, priority: 0}, {width: 50, priority: 1});
  assert.deepEqual(computeOverflow({items, available: 170, gap: 0, moreWidth: 20}).overflow, [2], 'priority 0 goes before the later priority 1');
  assert.deepEqual(computeOverflow({items, available: 125, gap: 0, moreWidth: 20}).overflow, [2, 3]);
  const tight = computeOverflow({items, available: 10, gap: 0, moreWidth: 20});
  assert.deepEqual([tight.visible, tight.fits], [[0], false], 'a pinned item stays even when nothing fits');
});

test('the overflow list keeps visual order for the More menu', () => {
  const items = row({width: 30, priority: 1}, {width: 30}, {width: 30, priority: 2}, {width: 30});
  assert.deepEqual(computeOverflow({items, available: 60, moreWidth: 30}).overflow, [0, 1, 3]);
  assert.deepEqual(computeOverflow({items: [], available: 0}), {visible: [], overflow: [], width: 0, fits: true});
});

test('overflowed controls become menu items that click the original control', () => {
  const events = [];
  globalThis.MouseEvent ??= class MouseEvent { constructor(type, init) { Object.assign(this, {type}, init); } };
  const control = (attributes, text = '') => ({
    textContent: text, disabled: false, dataset: {},
    getAttribute: name => attributes[name] ?? null,
    dispatchEvent: event => events.push([attributes['aria-label'] ?? text, event.type, event.shiftKey]),
  });
  const [onion, loop, audio] = overflowMenuItems([control({'aria-label': 'Onion skin', 'aria-pressed': 'true'}), control({'aria-pressed': 'false'}, ' Loop '),
    control({'aria-label': 'Audio', 'aria-disabled': 'true'})]);
  assert.deepEqual([onion.label, onion.checked, onion.disabled], ['Onion skin', true, false]);
  assert.deepEqual([loop.label, loop.checked], ['Loop', false]);
  assert.deepEqual([audio.disabled, 'checked' in audio], [true, false]);
  onion.run({shiftKey: true});
  assert.deepEqual(events, [['Onion skin', 'click', true]], 'modifiers pass through to the original control');
});

/** A toolbar of fixed-width controls: just the DOM the engine reads and writes. */
function fakeToolbar(names, {width = 50, available}) {
  const control = (name, size) => {
    const inline = new Map(), attributes = new Map();
    const element = {
      name, hidden: false, dataset: {},
      style: {
        getPropertyValue: property => inline.get(property)?.value ?? '',
        getPropertyPriority: property => inline.get(property)?.priority ?? '',
        setProperty: (property, value, priority = '') => { inline.set(property, {value, priority}); },
        removeProperty: property => { inline.delete(property); },
      },
      hasAttribute: name => attributes.has(name),
      setAttribute: (name, value) => { attributes.set(name, String(value)); },
      removeAttribute: name => { attributes.delete(name); },
      get shown() { return !element.hidden && inline.get('display')?.value !== 'none'; },
      getBoundingClientRect: () => ({width: element.shown ? size : 0}),
    };
    return element;
  };
  const controls = names.map(name => control(name, width)), more = control('more', 20);
  more.hidden = true;
  const toolbar = {clientWidth: available, getClientRects: () => [{}],
    ownerDocument: {defaultView: {getComputedStyle: () => ({columnGap: '0px', paddingLeft: '0px', paddingRight: '0px'})}}};
  const frames = [], observers = [];
  class Mutations { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} }
  const options = {items: () => controls, more, Observer: null, Mutations, requestFrame: callback => frames.push(callback), cancelFrame: () => {}};
  return {toolbar, controls, more, options, pending: () => frames.length, flush: () => { for (const frame of frames.splice(0)) frame(); },
    mutate: records => { for (const callback of observers) callback(records); }};
}

test('the engine never writes `hidden`: owners keep hiding and showing controls while they overflow', () => {
  const {toolbar, controls: [undo, redo, copy, mirror], more, options, flush, mutate, pending} = fakeToolbar(['undo', 'redo', 'copy', 'mirror'], {available: 190});
  undo.style.setProperty('display', 'inline-flex');
  const changes = [], controller = new AbortController();
  const overflow = installToolbarOverflow(toolbar, {...options, signal: controller.signal, onChange: list => changes.push(list.map(item => item.name))});
  flush();
  assert.deepEqual(overflow.overflowed.map(item => item.name), ['mirror'], '4 × 50 = 200 > 190: the last goes, More takes its place');
  assert.deepEqual([mirror.hidden, mirror.hasAttribute(OVERFLOW_ATTRIBUTE), mirror.shown, more.hidden], [false, true, false, false]);

  mirror.hidden = true;   // the owner hides it (a mode switch) while it waits in More
  mutate([{type: 'attributes', attributeName: 'hidden', target: mirror}]);
  flush();
  assert.deepEqual([mirror.hidden, mirror.hasAttribute(OVERFLOW_ATTRIBUTE), more.hidden], [true, false, true], 'released, still hidden, More gone');
  toolbar.clientWidth = 400;
  overflow.update();
  assert.equal(mirror.hidden, true, 'widening never shows what its owner hid');

  toolbar.clientWidth = 190;
  overflow.update();
  mirror.hidden = false;   // the owner shows it again at the same width
  mutate([{type: 'attributes', attributeName: 'hidden', target: mirror}]);
  flush();
  assert.deepEqual([mirror.shown, mirror.hasAttribute(OVERFLOW_ATTRIBUTE), more.hidden], [false, true, false], 'it goes to More instead of being clipped');

  toolbar.clientWidth = 120;
  overflow.update();
  assert.deepEqual(overflow.overflowed.map(item => item.name), ['copy', 'mirror']);
  toolbar.clientWidth = 400;
  overflow.update();
  assert.equal(undo.style.getPropertyValue('display'), 'inline-flex', "the owner's own inline display is untouched");
  assert.deepEqual([copy.shown, mirror.shown, redo.shown, more.hidden], [true, true, true, true]);
  mutate([{type: 'attributes', attributeName: 'hidden', target: more}]);
  assert.equal(pending(), 0, 'the More button showing or hiding schedules nothing');

  toolbar.clientWidth = 190;
  overflow.update();
  controller.abort();
  assert.deepEqual([mirror.shown, mirror.hasAttribute(OVERFLOW_ATTRIBUTE), more.hidden], [true, false, true], 'uninstalling puts every control back');
  assert.deepEqual(changes, [['mirror'], [], ['mirror'], ['copy', 'mirror'], [], ['mirror']]);
});
