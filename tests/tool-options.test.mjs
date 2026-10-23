import test from 'node:test';
import assert from 'node:assert/strict';
import {OPTION_KINDS, hasDroppableLabel, normalizeToolOptions, optionColor, planToolOptions, structureKey, toolOptionsText} from '../src/ui/tool-options.mjs';

// Brush (experience.md §4.2): the colour pair and swap · Size, Opacity, Flow, Smooth · Mirror (a labelled pair,
// twin in the Brush section) · Pen pressure (home: Brush details › Dynamics). Fold order: Mirror → Pen pressure →
// Smooth → Flow. Widths are measured boxes; labelWidth is what dropping the item's word saves.
const brush = () => normalizeToolOptions([
  {id: 'colors', kind: 'colors', label: 'Colors', stroke: '#0c0d12', fill: '#ffffff', swap: {command: 'drawing-swap-colors'}},
  [
    {id: 'size', kind: 'field', label: 'Size', property: 'brushSize', unit: 'px'},
    {id: 'opacity', kind: 'field', label: 'Opacity', property: 'brushOpacity', unit: '%'},
    {id: 'flow', kind: 'field', label: 'Flow', property: 'brushFlow', unit: '%', fold: 5},
    {id: 'smooth', kind: 'field', label: 'Smooth', property: 'brushSmooth', unit: '%', fold: 4},
  ],
  {id: 'mirror', kind: 'toggles', label: 'Mirror', fold: 2, twin: 'mirror-twin-brush', items: [
    {id: 'mirror-x', kind: 'toggle', label: 'Mirror horizontally', icon: 'flip', command: 'drawing-mirror'},
    {id: 'mirror-y', kind: 'toggle', label: 'Mirror vertically', icon: 'flip-vertical'},
  ]},
  {id: 'pressure', kind: 'toggle', label: 'Pen pressure', icon: 'pen', fold: 3, home: 'Brush details › Dynamics', attributes: {'data-draw-setting': 'pressure'}},
]);
const BRUSH_WIDTHS = {colors: [52, 0], size: [80, 0], opacity: [100, 0], flow: [84, 0], smooth: [96, 0], mirror: [118, 44], pressure: [28, 0]};
const measured = (items, widths) => items.map(item => ({...item, width: widths[item.id][0], labelWidth: widths[item.id][1]}));
const plan = (items, available) => planToolOptions({items, available, gap: 4, groupGap: 12, moreWidth: 24});

// The row's real width, computed independently of the planner: items, cluster gaps, the More button.
function rowWidth(items, result, {gap = 4, groupGap = 12, moreWidth = 24} = {}) {
  const folded = new Set(result.folded), dropped = new Set(result.dropped);
  let width = 0, previous = null;
  for (const item of items) {
    if (folded.has(item.id)) continue;
    if (previous) width += previous.cluster === item.cluster ? gap : groupGap;
    width += item.width - (dropped.has(item.id) ? item.labelWidth : 0);
    previous = item;
  }
  if (result.more.length) width += (previous ? groupGap : 0) + moreWidth;
  return width;
}

// The planner's promises at one width: its width is the real row's, `fits` says so, and it neither folds an item
// nor drops a label the row had room for.
function assertSound(items, available) {
  const result = plan(items, available);
  assert.equal(result.width, rowWidth(items, result), `width at ${available}`);
  assert.equal(result.fits, result.width <= available, `fits at ${available}`);
  const byId = id => items.find(item => item.id === id);
  if (result.folded.length && result.fits) {
    // The last item to fold: the earliest forced one, else the highest fold, and of equals the earliest (later items fold first).
    const last = result.forced.length ? byId(result.forced[0])
      : result.folded.map(byId).sort((a, b) => b.fold - a.fold || a.index - b.index)[0];
    const folded = result.folded.filter(id => id !== last.id);
    const fewer = {...result, folded, more: folded.filter(id => !byId(id).twin && !byId(id).home)};
    assert.ok(rowWidth(items, fewer) > available, `${last.id} folded without need at ${available}`);
  }
  if (!result.folded.length && result.dropped.length) {
    const kept = result.dropped.slice(0, -1);
    assert.ok(result.dropped.some(id => rowWidth(items, {...result, dropped: result.dropped.filter(other => other !== id)}) > available),
      `every dropped label could come back at ${available} (${kept.join(', ')})`);
  }
  return result;
}

test('descriptors form clusters by group or by nested arrays, and say which labels can drop', () => {
  const items = brush();
  assert.deepEqual(items.map(item => [item.id, item.cluster]),
    [['colors', 0], ['size', 1], ['opacity', 1], ['flow', 1], ['smooth', 1], ['mirror', 2], ['pressure', 3]]);
  assert.deepEqual(items.map(item => item.fold), [null, null, null, 5, 4, 2, 3]);
  assert.deepEqual(items.filter(item => item.droppable).map(item => item.id), ['mirror'], 'the pair\'s shared label; field labels scrub and stay');
  const grouped = normalizeToolOptions([
    {id: 'a', kind: 'button', label: 'A', group: 'x'}, {id: 'b', kind: 'button', label: 'B', group: 'x'},
    {id: 'c', kind: 'button', label: 'C'}, {id: 'd', kind: 'button', label: 'D'}, {id: 'e', kind: 'button', label: 'E', group: 'x'},
  ]);
  assert.deepEqual(grouped.map(item => item.cluster), [0, 0, 1, 2, 3], 'only consecutive items of one group share a cluster');
  assert.ok(Object.isFrozen(grouped) && Object.isFrozen(grouped[0]));
  assert.deepEqual(OPTION_KINDS, ['toggle', 'toggles', 'button', 'split', 'select', 'field', 'stepper', 'colors', 'recent', 'segmented']);
});

test('malformed descriptors fail loudly: they are a tool\'s code, not user data', () => {
  assert.throws(() => normalizeToolOptions([{kind: 'toggle'}]), /needs an id/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'slider'}]), /unsupported kind/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'toggle'}, {id: 'a', kind: 'button'}]), /Duplicate tool option id: a/);
  assert.throws(() => normalizeToolOptions([{id: 'm', kind: 'toggles', items: [{id: 'm', kind: 'toggle'}]}]), /Duplicate/, 'ids are unique across nested toggles');
  assert.throws(() => normalizeToolOptions([{id: 'm', kind: 'toggles', items: [{id: 'n', kind: 'select', options: [1]}]}]), /unsupported kind/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'toggle', attributes: {onclick: 'x()'}}]), /only data-\* and aria-\*/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'toggle', attributes: {style: 'color:red'}}]), /only data-\* and aria-\*/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'select', options: []}]), /no options/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'toggle', elementId: 'has space'}]), /invalid element id/);
  assert.throws(() => normalizeToolOptions([{id: 'a', kind: 'toggle', twin: '#nope'}]), /invalid twin/);
});

test('a label drops only where it is a word beside a glyph or an outside label', () => {
  assert.equal(hasDroppableLabel({kind: 'toggle', label: 'Whole branch', showLabel: true, icon: 'builder-branch'}), true);
  assert.equal(hasDroppableLabel({kind: 'toggle', label: 'Whole branch', showLabel: true}), false, 'a word with no glyph would leave an empty button');
  assert.equal(hasDroppableLabel({kind: 'toggle', label: 'Pen pressure', icon: 'pen'}), false, 'an icon toggle shows no word');
  assert.equal(hasDroppableLabel({kind: 'select', label: 'Drag', showLabel: true}), true);
  assert.equal(hasDroppableLabel({kind: 'select', label: 'Drag', showLabel: true, dropLabel: false}), false);
  assert.equal(hasDroppableLabel({kind: 'field', label: 'Size'}), false);
  assert.equal(hasDroppableLabel({kind: 'toggles', label: 'Mirror', items: []}), true);
});

test('a row that fits keeps every label and item', () => {
  const items = measured(brush(), BRUSH_WIDTHS);
  const result = plan(items, 606);
  assert.deepEqual(result, {dropped: [], folded: [], more: [], twins: [], homes: [], forced: [], width: 606, fits: true});
});

test('Brush folds labels first, then Mirror to its twin, Pen pressure home, then Smooth and Flow into More options', () => {
  const items = measured(brush(), BRUSH_WIDTHS);
  const at = available => plan(items, available);

  let result = at(600);
  assert.deepEqual([result.dropped, result.folded], [['mirror'], []], 'the word "Mirror" goes before anything folds');

  result = at(540);
  assert.deepEqual([result.folded, result.twins, result.more], [['mirror'], ['mirror-twin-brush'], []]);
  assert.equal(result.width, 476, 'no More options button: the pair is shown by its twin in the Brush section');

  result = at(470);
  assert.deepEqual([result.folded, result.homes, result.more], [['mirror', 'pressure'], [{id: 'pressure', home: 'Brush details › Dynamics'}], []]);

  result = at(430);
  assert.deepEqual([result.folded, result.more], [['smooth', 'mirror', 'pressure'], ['smooth']]);
  assert.equal(result.width, 52 + 12 + (80 + 4 + 100 + 4 + 84) + 12 + 24, 'More options takes its room and a cluster gap');

  result = at(360);
  assert.deepEqual(result.more, ['flow', 'smooth'], 'More options lists them in row order');
  assert.ok(result.fits);

  result = at(290);
  assert.deepEqual([result.folded, result.forced], [['flow', 'smooth', 'mirror', 'pressure'], []], 'Size, Opacity and the colours stay while they fit');

  result = at(200);
  assert.deepEqual([result.more, result.forced, result.fits], [['opacity', 'flow', 'smooth'], ['opacity'], true],
    'below its declared folds the row moves Opacity into More options rather than cutting it off');
  result = at(20);
  assert.deepEqual([result.folded.length, result.width, result.fits], [7, 24, false], 'at worst only More options is left');
});

test('Edit joints drops the toggles\' words, then "Drag", before Snapping goes to View › Build', () => {
  const items = measured(normalizeToolOptions([
    {id: 'mode', kind: 'select', label: 'Drag', showLabel: true, labelFold: 3, elementId: 'rig-mode', options: [{value: 'joint', label: 'Move joint'}, {value: 'branch', label: 'Rotate branch'}]},
    [
      {id: 'branch', kind: 'toggle', label: 'Whole branch', showLabel: true, accent: true, icon: 'builder-branch', labelFold: 1, elementId: 'builder-branch'},
      {id: 'snap', kind: 'toggle', label: 'Snapping', showLabel: true, icon: 'builder-snap', labelFold: 2, fold: 2, home: 'View › Build', elementId: 'builder-snap'},
    ],
  ]), {mode: [150, 36], branch: [118, 90], snap: [96, 68]});
  // Full: 150 + 12 + 118 + 4 + 96 = 380.
  assert.deepEqual(plan(items, 380).dropped, []);
  assert.deepEqual(plan(items, 300).dropped, ['branch'], 'Whole branch shows its glyph first (380 − 90 = 290)');
  assert.deepEqual(plan(items, 230).dropped, ['branch', 'snap']);
  let result = plan(items, 200);
  assert.deepEqual([result.dropped, result.folded], [['mode', 'branch', 'snap'], []], 'then the "Drag" label (222 − 36 = 186)');
  result = plan(items, 170);
  assert.deepEqual([result.folded, result.homes, result.more], [['snap'], [{id: 'snap', home: 'View › Build'}], []]);
  assert.equal(result.width, 114 + 12 + 28);
});

test('a folded item with a twin and a home is shown by its twin', () => {
  const items = measured(normalizeToolOptions([
    {id: 'a', kind: 'button', label: 'A'},
    {id: 'b', kind: 'toggle', label: 'B', fold: 1, twin: 'b-twin', home: 'Somewhere'},
  ]), {a: [100, 0], b: [40, 0]});
  const result = plan(items, 120);
  assert.deepEqual([result.twins, result.homes, result.more], [['b-twin'], [], []]);
});

test('cluster gaps are exact even when a cluster\'s first item folds and the rest stay', () => {
  // The first item of cluster 1 folds; the cluster's gap still stands before the next item.
  const items = measured(normalizeToolOptions([
    {id: 'a', kind: 'button', label: 'A'},
    [{id: 'b', kind: 'button', label: 'B', fold: 1}, {id: 'c', kind: 'button', label: 'C', fold: 2}, {id: 'd', kind: 'button', label: 'D'}],
  ]), {a: [100, 0], b: [50, 0], c: [50, 0], d: [30, 0]});
  for (let available = 300; available >= 0; available--) assertSound(items, available);
  // Full: 100 + 12 + 50 + 4 + 50 + 4 + 30 = 250. Without B: 100 + 12 + 50 + 4 + 30, then More options: 232.
  assert.deepEqual(plan(items, 240).folded, ['b']);
  assert.equal(plan(items, 232).width, 232);
  const tight = plan(items, 231);
  assert.deepEqual(tight.folded, ['b', 'c'], 'one pixel short, C folds too');
  assert.equal(tight.width, 100 + 12 + 30 + 12 + 24);
});

test('across every width the plan is exact, nested and drops every label before folding', () => {
  const items = measured(brush(), BRUSH_WIDTHS);
  let previous = new Set();
  for (let available = 700; available >= 0; available -= 1) {
    const result = assertSound(items, available);
    if (result.folded.length) assert.deepEqual(result.dropped, ['mirror'], `labels drop before items fold (${available})`);
    const folded = new Set(result.folded);
    for (const id of previous) assert.ok(folded.has(id), `${id} stays folded as the row narrows (${available})`);
    previous = folded;
  }
});

test('update() writes only state in place: fold orders, tips, limits and hooks are structure', () => {
  const key = descriptors => structureKey(normalizeToolOptions(descriptors));
  const size = {id: 'size', kind: 'field', label: 'Size', property: 'brushSize', value: 8, fold: 1, min: 0};
  const snap = {id: 'snap', kind: 'toggle', label: 'Snapping', icon: 'builder-snap', pressed: false, disabled: false, twin: 'snap-twin'};
  const base = key([size, snap]);
  assert.equal(key([{...size, value: 12}, {...snap, pressed: true, disabled: true}]), base, 'values, pressed and disabled are written in place');
  assert.equal(key([{min: 0, fold: 1, value: 3, property: 'brushSize', label: 'Size', kind: 'field', id: 'size'}, snap]), base, 'key order does not matter');
  for (const change of [{fold: 2}, {labelFold: 1}, {tip: 'Brush size'}, {min: 1}, {max: 9}, {step: 2}, {precision: 1}, {property: 'brushFlow'},
    {description: 'Size in pixels'}, {attributes: {'data-draw-setting': 'size'}}])
    assert.notEqual(key([{...size, ...change}, snap]), base, JSON.stringify(change));
  for (const change of [{twin: 'other'}, {home: 'View › Build'}, {accent: true}, {shiftCommand: 'layer-up'}])
    assert.notEqual(key([size, {...snap, ...change}]), base, JSON.stringify(change));
  const select = options => key([{id: 'mode', kind: 'select', value: 'joint', options}]);
  assert.notEqual(select([{value: 'joint'}, {value: 'branch'}]), select([{value: 'joint'}, {value: 'part'}]), 'an option\'s value is structure');
  const pair = pressed => key([{id: 'mirror', kind: 'toggles', label: 'Mirror', items: [{id: 'mirror-x', kind: 'toggle', icon: 'flip', pressed}]}]);
  assert.equal(pair(true), pair(false), 'a nested toggle\'s state is state too');
  const colors = (stroke, recent) => key([{id: 'colors', kind: 'colors', stroke, fill: '#ffffff'}, {id: 'recent', kind: 'recent', colors: recent}]);
  assert.equal(colors('#000000', ['#e8553a']), colors('#0c0d12', ['#0d99ff', '#18a058']));
});

test('colours are validated before they reach a swatch; strings fall back to English', () => {
  assert.equal(optionColor('#0c0d12'), '#0c0d12');
  assert.equal(optionColor(' #FFF '), '#FFF');
  for (const bad of ['red', 'url(x)', '#12', 'var(--x)', '#0c0d12;background:red', null]) assert.equal(optionColor(bad), null, String(bad));
  assert.equal(toolOptionsText(null, 'toolOptions.more'), 'More options');
  assert.equal(toolOptionsText(null, 'toolOptions.decrease', {name: 'Amount'}), 'Decrease Amount');
  assert.equal(toolOptionsText(key => (key === 'toolOptions.more' ? 'Altre opzioni' : key), 'toolOptions.more'), 'Altre opzioni');
  assert.equal(toolOptionsText(() => { throw new Error('missing'); }, 'toolOptions.recent'), 'Recent colors');
});
