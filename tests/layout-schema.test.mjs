/**
 * Stored workspace layouts (src/shell/layout-schema.mjs): migration from
 * 1.1's studio layout and the earlier splitter layout, the downgrade round
 * trip, normalization, presets, saved layouts and the size budget. Ports the
 * preference cases of tests/studio-layout.test.mjs and
 * tests/workspace-layout.test.mjs to schema v2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRESETS, LAYOUT_BUDGET_BYTES, LAYOUT_FILE_LIMIT_BYTES, MAX_SAVED_LAYOUTS, TOMBSTONE_TTL_MS,
  activatePanel, applyPreset, canPlacePanel, canSavePreset, cleanLayoutName, defaultArrangement, defaultLayout,
  deletePreset, fitBudget, isFutureLayout, layoutBytes, migrateLayout, movePanel, normalizeArrangement,
  normalizeLayout, presetArrangement, presetsFor, renamePreset, resetLayout, resetMode, sameArrangement,
  savePreset, serializeLayout, setSharedSize, solvableArrangement, toggleFocus, trimLayout, updatePreset,
} from '../src/shell/layout-schema.mjs';
import {PANEL_CATALOG, normalizePanelDescriptor} from '../src/shell/panel-registry.mjs';

// StykAnimate 1.1's studio layout reader and writer (src/studio-layout.mjs at
// 1.1), frozen here so the downgrade contract outlives that module.
function constrainStudioLayout(preferences = {}, width = 1280, height = 640) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  preferences = preferences && typeof preferences === 'object' ? preferences : {};
  const right = clamp(Number(preferences.right) || 292, 230, Math.max(230, Math.min(390, width - 460)));
  const timeline = clamp(Number(preferences.timeline) || 280, 200, Math.max(200, height - 210));
  return {right, timeline};
}
/** 1.1's persist(): `preferences` is `{...loaded}` with the sizes the user dragged. */
const persist11 = preferences => ({...preferences, studioVersion: 1});

const NOW = 1_700_000_100_000;
const at = {now: NOW};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
const records = arrangement => Object.fromEntries(arrangement.panels.map(record => [record.id, record]));
const place = (arrangement, id) => {
  const record = records(arrangement)[id];
  return record && `${record.dock}${record.dock === record.side ? '' : `@${record.side}`}`;
};

// Frozen fixtures: what 1.1 writes, what the splitter layout before it wrote, and a v2 file.
const V1_UNTOUCHED = deepFreeze({studioVersion: 1, right: 310, timeline: 280});
const V1_CUSTOM = deepFreeze({studioVersion: 1, right: 330, timeline: 236});
const LEGACY = deepFreeze({left: 310, right: 300, timeline: 250, source: 'kept', floating: {left: {x: 25, y: 48, width: 330, height: 440}}});
const FIGHT_PANELS = [
  {id: 'library', dock: 'left', order: 0},
  {id: 'properties', dock: 'right', order: 0},
  {id: 'vfx', dock: 'float', side: 'right', order: 1, rect: {x: 40, y: 30, w: 280, h: 360}},
  {id: 'timeline', dock: 'bottom', order: 0},
];
const V2 = deepFreeze({
  studioVersion: 1, right: 300, timeline: 260,
  layoutVersion: 2,
  shared: {stamp: 1_700_000_000_000, sizes: {right: 300, bottom: 260, structure: 250, audioRows: 3}, later: true},
  modes: {
    animate: {stamp: 1_700_000_000_100, preset: 'user:u1', rail: 'left', bottomSpan: 'full', panels: FIGHT_PANELS, zoomMemory: 2},
    draw: {stamp: 0, preset: 'draw'},
    rig: {stamp: 5, preset: 'build-timeline'},
    camera: {stamp: 9, preset: 'camera'},
  },
  saved: [{id: 'u1', name: 'Fight setup', mode: 'animate', stamp: 1_700_000_000_050, arrangement: {rail: 'left', bottomSpan: 'full', panels: FIGHT_PANELS}, colour: 'blue'}],
  tombstones: [{id: 'u0', stamp: 1_700_000_000_010}],
  futureKey: {hello: 'world'},
});

test('a v1 studio layout becomes v2 with its sizes; the untouched 280px timeline means the default height', () => {
  const untouched = migrateLayout(V1_UNTOUCHED, at);
  assert.equal(untouched.source, 'v1');
  assert.equal(untouched.readOnly, false);
  assert.deepEqual(untouched.layout.shared.sizes, {right: 310});
  const custom = migrateLayout(V1_CUSTOM, at).layout;
  assert.deepEqual(custom.shared.sizes, {right: 330, bottom: 236});
  for (const mode of ['animate', 'draw', 'rig']) {
    assert.equal(custom.modes[mode].preset, DEFAULT_PRESETS[mode]);
    assert.ok(sameArrangement(custom.modes[mode], defaultArrangement(mode)));
  }
  // A v1 inspector narrower than the v2 panels allow is clamped, never stored below their minimum.
  assert.equal(migrateLayout({studioVersion: 1, right: 230}, at).layout.shared.sizes.right, 256);
});

test('the earlier splitter layout keeps its sizes and drops its floating docks', () => {
  const {layout, source} = migrateLayout(LEGACY, at);
  assert.equal(source, 'legacy');
  assert.deepEqual(layout.shared.sizes, {left: 310, right: 300, bottom: 250});
  assert.equal('floating' in layout, false);
  assert.equal(layout.source, 'kept');
  assert.equal(place(layout.modes.animate, 'properties'), 'right');
  // Old sidebar and floating preferences cannot consume the stage: nothing is docked left.
  assert.ok(layout.modes.animate.panels.every(record => record.dock !== 'left'));
});

test('the editor setting builderOutlinerWidth seeds the Structure width once', () => {
  const legacy = {builderOutlinerWidth: 300};
  assert.equal(migrateLayout(V1_CUSTOM, {...at, legacy}).layout.shared.sizes.structure, 300);
  assert.equal(migrateLayout(null, {...at, legacy}).layout.shared.sizes.structure, 300);
  assert.equal(migrateLayout(V1_CUSTOM, {...at, legacy: {builderOutlinerWidth: 236}}).layout.shared.sizes.structure, undefined);
  assert.equal(migrateLayout(V1_CUSTOM, {...at, legacy: {builderOutlinerWidth: 900}}).layout.shared.sizes.structure, 360);
  // Once the file is v2 the stored width wins.
  assert.equal(migrateLayout(V2, {...at, legacy}).layout.shared.sizes.structure, 250);
});

test('v2 keys survive 1.1 reading the file and writing {...loaded, studioVersion: 1} back', () => {
  const written = serializeLayout(migrateLayout(V2, at).layout, at);
  // 1.1 reads the mirror as its v1 layout.
  assert.equal(written.studioVersion, 1);
  assert.deepEqual(constrainStudioLayout(written, 1440, 900), {right: 300, timeline: 260});
  // 1.1's persist() after the user drags its inspector and timeline.
  const replayed = persist11({...written, right: 344, timeline: 300});
  for (const key of ['layoutVersion', 'shared', 'modes', 'saved', 'tombstones', 'futureKey']) assert.deepEqual(replayed[key], written[key], key);
  const {layout, source} = migrateLayout(replayed, at);
  assert.equal(source, 'v2');
  assert.deepEqual(layout.shared.sizes, {right: 344, bottom: 300, structure: 250, audioRows: 3});
  assert.equal(layout.shared.stamp, V2.shared.stamp + 1, 'a mirror change wins merges');
  assert.equal(place(layout.modes.animate, 'library'), 'left');
  assert.equal(place(layout.modes.animate, 'vfx'), 'float@right');
  assert.deepEqual(records(layout.modes.animate).vfx.rect, {x: 40, y: 30, w: 280, h: 360});
  assert.equal(layout.saved[0].name, 'Fight setup');
  assert.deepEqual(layout.tombstones, [{id: 'u0', stamp: 1_700_000_000_010}]);
  assert.deepEqual(layout.futureKey, {hello: 'world'});
  assert.equal(layout.modes.animate.zoomMemory, 2);
  assert.deepEqual(layout.modes.camera, {stamp: 9, preset: 'camera'});
  assert.equal(layout.shared.later, true);
  assert.equal(layout.saved[0].colour, 'blue');
  // 1.1's splitter double-click deletes its key: the default comes back.
  const {timeline, ...reset} = replayed;
  assert.equal(migrateLayout(reset, at).layout.shared.sizes.bottom, undefined);
  // An unchanged mirror changes nothing.
  assert.equal(migrateLayout(written, at).layout.shared.stamp, V2.shared.stamp);
});

test('a layout from a newer version is used read-only with presets and left as it is', () => {
  const future = deepFreeze({...V2, layoutVersion: 3, modes: {animate: {something: 'new'}}});
  assert.equal(isFutureLayout(future), true);
  assert.equal(isFutureLayout(V2), false);
  const result = migrateLayout(future, at);
  assert.equal(result.source, 'future');
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.layout, defaultLayout(at));
});

test('invalid stored layouts do not prevent the editor from opening', () => {
  const defaults = defaultLayout(at);
  for (const value of [null, undefined, 'invalid', 42, [], {layoutVersion: 'two', modes: 5, shared: 'x'},
    {right: 'bad', timeline: 'bad', studioVersion: 1}, {layoutVersion: 2, modes: {animate: {panels: 'x', rail: 3}}, saved: 'x', shared: {sizes: []}}]) {
    const {layout} = migrateLayout(value, at);
    assert.deepEqual(layout.modes, defaults.modes, JSON.stringify(value));
    assert.deepEqual(layout.shared.sizes, {}, JSON.stringify(value));
    assert.deepEqual(layout.saved, []);
  }
  assert.equal(migrateLayout('invalid', at).source, 'invalid');
  assert.equal(migrateLayout({layoutVersion: 1.5}, at).source, 'invalid');
  assert.equal(migrateLayout(undefined, at).source, 'empty');
  assert.equal(migrateLayout({}, at).source, 'empty');
});

test('normalization keeps every panel in a place it allows', () => {
  const arrangement = normalizeArrangement({panels: [
    {id: 'timeline', dock: 'left', order: 0},
    {id: 'properties', dock: 'float', order: 4},
    {id: 'vfx', dock: 'float', side: 'left'},
    {id: 'library', dock: 'float'},
    {id: 'structure', dock: 'left'},
    {id: 'vfx', dock: 'right'},
  ]}, 'animate');
  assert.equal(place(arrangement, 'timeline'), 'bottom');
  assert.equal(place(arrangement, 'properties'), 'float@right', 'Properties can float');
  assert.equal(place(arrangement, 'vfx'), 'float@left', 'the first record of an id wins');
  assert.equal(place(arrangement, 'library'), 'right', 'at most two panels float');
  assert.deepEqual(records(arrangement).structure, {id: 'structure', dock: 'left'}, 'Structure is placed only in Build; its record is kept as it is');
  // A third floating panel docks back on its side.
  const catalog = [...PANEL_CATALOG, normalizePanelDescriptor({id: 'notes', docks: ['right'], floatable: true, min: 200, pref: 240, max: 300})];
  const three = normalizeArrangement({panels: ['vfx', 'library', 'notes'].map(id => ({id, dock: 'float'}))}, 'animate', {catalog});
  assert.deepEqual(three.panels.filter(record => record.dock === 'float').map(record => record.id), ['vfx', 'library']);
  assert.equal(place(three, 'notes'), 'right');
  // The timeline may be Hidden only in Build, where it is the default.
  assert.equal(place(normalizeArrangement({panels: [{id: 'timeline', dock: 'hidden'}]}, 'animate'), 'timeline'), 'strip@bottom');
  assert.equal(place(normalizeArrangement({panels: [{id: 'timeline', dock: 'hidden'}]}, 'rig'), 'timeline'), 'hidden@bottom');
  assert.equal(place(normalizeArrangement({}, 'rig'), 'timeline'), 'hidden@bottom');
  // Missing panels come back in the default preset's place; tab orders are consecutive; one active tab per island.
  const partial = normalizeArrangement({panels: [{id: 'library', dock: 'right', order: 7, active: true}, {id: 'vfx', dock: 'right', order: 3, active: true}]}, 'animate');
  assert.deepEqual(partial.panels.filter(record => record.side === 'right').map(record => [record.id, record.order, record.active ?? false]),
    [['properties', 0, false], ['vfx', 1, true], ['library', 2, false]]);
  assert.equal(place(partial, 'timeline'), 'bottom');
  const build = normalizeArrangement({panels: []}, 'build');
  assert.equal(place(build, 'structure'), 'strip@left');
});

test('records of panels this version does not know are kept but bounded', () => {
  const arrangement = normalizeArrangement({panels: [
    {id: 'audio-mixer', dock: 'left', order: 1, extra: {deep: true}},
    {id: 'Bad Id', dock: 'left'},
    {id: 'broken', dock: 7},
    {id: 'notes', dock: 'drawer', side: 'drawer'},
    ...Array.from({length: 12}, (_, index) => ({id: `extra-${index}`, dock: 'right'})),
  ]}, 'animate');
  const unknown = arrangement.panels.filter(record => !['properties', 'vfx', 'library', 'timeline'].includes(record.id));
  assert.equal(unknown[0].id, 'audio-mixer');
  assert.deepEqual(unknown[0].extra, {deep: true});
  assert.deepEqual(unknown[1], {id: 'notes', dock: 'drawer', side: 'drawer'}, 'a dock type from a newer version is kept');
  assert.equal(unknown.length, 8);
  assert.ok(!unknown.some(record => record.id === 'Bad Id' || record.id === 'broken'));
  // Built-in presets never carry them.
  assert.equal(presetArrangement('animate', 'animate').panels.length, 4);
});

// A 2.x file from a newer version: data this version does not read (all reported lost in review).
const NEWER_RECORDS = [
  {id: 'properties', dock: 'right', order: 0, pinned: true, collapsedSections: ['motion']},
  {id: 'vfx', dock: 'top', side: 'top', order: 0, height: 180},
  {id: 'library', dock: 'right', order: 1},
  {id: 'timeline', dock: 'bottom', order: 0},
  {id: 'structure', dock: 'left', order: 0, pinned: true},
];
const NEWER = deepFreeze({
  layoutVersion: 2, studioVersion: 1,
  shared: {stamp: 3, sizes: {}},
  modes: {
    animate: {stamp: 4, preset: 'animate', rail: 'left', bottomSpan: 'full', panels: NEWER_RECORDS, splitRatio: 0.4,
      focus: {rail: 'left', bottomSpan: 'full', panels: NEWER_RECORDS, splitRatio: 0.3}},
    draw: {stamp: 5, preset: 'storyboard'},
    rig: {stamp: 6, preset: 'build'},
  },
  saved: [{id: 'u1', name: 'Wide', mode: 'animate', stamp: 7, arrangement: {rail: 'left', bottomSpan: 'full', panels: NEWER_RECORDS, splitRatio: 0.6}}],
  tombstones: [],
});

test('a newer 2.x file keeps what this version does not read through a save', () => {
  const layout = normalizeLayout(NEWER, at);
  const written = serializeLayout(layout, at);
  const again = serializeLayout(migrateLayout(written, at).layout, at);
  assert.deepEqual(again, written, 'a second round trip changes nothing');
  const animate = written.modes.animate;
  // (a) Extra fields on a known panel's record.
  assert.deepEqual(animate.panels.find(record => record.id === 'properties'), {id: 'properties', dock: 'right', order: 0, active: true, pinned: true, collapsedSections: ['motion']});
  // (b) Unknown arrangement keys in the entry, its Focus snapshot and a saved layout.
  assert.equal(animate.splitRatio, 0.4);
  assert.equal(animate.focus.splitRatio, 0.3);
  assert.equal(written.saved[0].arrangement.splitRatio, 0.6);
  // (c) A known panel's record in a workspace this version keeps it out of.
  assert.deepEqual(animate.panels.find(record => record.id === 'structure'), {id: 'structure', dock: 'left', order: 0, pinned: true});
  // (d) A known panel on a dock this version does not know: kept as it is.
  assert.deepEqual(animate.panels.find(record => record.id === 'vfx'), {id: 'vfx', dock: 'top', side: 'top', order: 0, height: 180});
  assert.deepEqual(written.saved[0].arrangement.panels.find(record => record.id === 'vfx'), {id: 'vfx', dock: 'top', side: 'top', order: 0, height: 180});
  // Each panel still has exactly one record.
  assert.deepEqual(animate.panels.map(record => record.id).sort(), ['library', 'properties', 'structure', 'timeline', 'vfx']);
});

test('records this version only keeps are solved at home or not at all, until the user moves them', () => {
  const entry = normalizeLayout(NEWER, at).modes.animate;
  // VFX on the unknown dock is solved as the last tab of its home island; Structure is not placed.
  const solvable = solvableArrangement(entry, 'animate');
  assert.equal(place(solvable, 'vfx'), 'right');
  assert.deepEqual(solvable.panels.filter(record => record.dock === 'right').map(record => [record.id, record.active ?? false]),
    [['properties', true], ['library', false], ['vfx', false]]);
  assert.equal(solvableArrangement(defaultArrangement('animate'), 'animate'), defaultArrangement('animate'), 'nothing to re-home: the same object');
  // Showing or moving it places it for good; moves of other panels leave it alone.
  assert.equal(place(activatePanel(entry, 'vfx', {mode: 'animate'}), 'vfx'), 'right');
  assert.equal(records(activatePanel(entry, 'vfx', {mode: 'animate'})).vfx.active, true);
  assert.equal(place(movePanel(entry, 'vfx', 'docked', {mode: 'animate'}), 'vfx'), 'right');
  assert.equal(place(movePanel(entry, 'vfx', 'left', {mode: 'animate'}), 'vfx'), 'left');
  const moved = movePanel(entry, 'library', 'left', {mode: 'animate'});
  assert.deepEqual(records(moved).vfx, records(entry).vfx);
  assert.deepEqual(records(moved).structure, records(entry).structure);
  assert.equal(activatePanel(entry, 'structure', {mode: 'animate'}), entry, 'a kept record of another workspace is never activated');
  // Focus folds it (it is shown docked) and restores it as it was.
  const layout = normalizeLayout(NEWER, at);
  const focused = toggleFocus({...layout, modes: {...layout.modes, animate: {...entry, focus: null}}}, 'animate', at);
  assert.equal(place(focused.modes.animate, 'vfx'), 'strip@right');
  assert.deepEqual(records(focused.modes.animate).structure, records(entry).structure);
  assert.deepEqual(records(toggleFocus(focused, 'animate', at).modes.animate).vfx, records(entry).vfx);
});

test('a compact entry naming a preset this version does not know stays compact', () => {
  const layout = normalizeLayout(NEWER, at);
  assert.equal(layout.modes.draw.preset, 'storyboard');
  assert.ok(sameArrangement(layout.modes.draw, defaultArrangement('draw')), 'solved as the workspace default');
  assert.deepEqual(serializeLayout(layout, at).modes.draw, {stamp: 5, preset: 'storyboard'});
  // A preset another workspace owns here counts as unknown too.
  assert.deepEqual(serializeLayout(normalizeLayout({modes: {draw: {stamp: 1, preset: 'timing'}}}, at), at).modes.draw, {stamp: 1, preset: 'timing'});
  // Once the user arranges the workspace, the arrangement is written.
  const moved = {...layout, modes: {...layout.modes, draw: {...layout.modes.draw, ...movePanel(layout.modes.draw, 'library', 'left', {mode: 'draw'})}}};
  assert.equal(serializeLayout(moved, at).modes.draw.panels[0].id, 'library');
});

test('a panel without a record takes its default dock', () => {
  const add = (fields) => [...PANEL_CATALOG, normalizePanelDescriptor({id: 'notes', docks: ['right'], min: 200, pref: 240, max: 300, ...fields})];
  assert.equal(place(normalizeArrangement(defaultArrangement('animate'), 'animate', {catalog: add({})}), 'notes'), 'right');
  assert.equal(place(normalizeArrangement(defaultArrangement('animate'), 'animate', {catalog: add({defaultDock: 'strip'})}), 'notes'), 'strip@right');
  assert.equal(place(normalizeArrangement(defaultArrangement('animate'), 'animate', {catalog: add({defaultDock: 'hidden'})}), 'notes'), 'hidden@right');
  // A stored record wins over the default dock.
  assert.equal(place(normalizeArrangement({panels: [{id: 'notes', dock: 'right'}]}, 'animate', {catalog: add({defaultDock: 'strip'})}), 'notes'), 'right');
});

test('island shares belong to the islands, not to the tabs that move between them', () => {
  const stacked = normalizeArrangement({panels: [
    {id: 'properties', dock: 'right', order: 0},
    {id: 'vfx', dock: 'right', order: 1},
    {id: 'library', dock: 'right', order: 2, group: 1},
  ], weights: {right: [3, 1]}}, 'animate');
  assert.deepEqual(stacked.weights, {right: [0.75, 0.25]}, 'shares are normalized to sum to 1');
  // Swapping Library and VFX between the islands keeps each island's share.
  const swapped = movePanel(movePanel(stacked, 'vfx', 'right', {mode: 'animate', group: 1}), 'library', 'right', {mode: 'animate', group: 0});
  assert.deepEqual(swapped.panels.filter(record => record.dock === 'right').map(record => [record.id, record.group ?? 0]),
    [['properties', 0], ['library', 0], ['vfx', 1]]);
  assert.deepEqual(swapped.weights, {right: [0.75, 0.25]});
  // One island left: no shares; invalid shares are equal; shares are stored only where islands stack.
  assert.deepEqual(movePanel(stacked, 'library', 'right', {mode: 'animate', group: 0}).weights, {});
  assert.deepEqual(normalizeArrangement({...stacked, weights: {right: [1, -1], left: [1, 1]}}, 'animate').weights, {right: [0.5, 0.5]});
  assert.deepEqual(normalizeArrangement({...stacked, weights: {right: [1, 999]}}, 'animate').weights, {right: [0.05, 0.95]});
  const layout = normalizeLayout({modes: {animate: {preset: 'animate', ...stacked}}}, at);
  assert.deepEqual(serializeLayout(layout, at).modes.animate.weights, {right: [0.75, 0.25]});
  assert.equal('weights' in serializeLayout(defaultLayout(at), at).modes.animate, false);
  assert.ok(!sameArrangement(stacked, {...stacked, weights: {right: [0.5, 0.5]}}));
});

test('shared sizes are clamped integers; non-finite values fall back to the default', () => {
  const layout = normalizeLayout({shared: {sizes: {right: 99999.7, left: 10, bottom: 'x', structure: 250.4, timelineLabels: -5, audioRows: 3.6, top: Infinity, __proto__: 1}}}, at);
  assert.deepEqual(layout.shared.sizes, {right: 460, left: 256, structure: 250, timelineLabels: 140, audioRows: 4});
  assert.equal(Object.getPrototypeOf(layout.shared.sizes), Object.prototype);
  assert.deepEqual(setSharedSize(layout, 'bottom', 333.3, at).shared.sizes.bottom, 333);
  assert.equal(setSharedSize(layout, 'right', null, at).shared.sizes.right, undefined);
});

test('normalization is idempotent and never mutates its input', () => {
  const input = deepFreeze(structuredClone(V2));
  const once = normalizeLayout(input, at);
  assert.deepEqual(normalizeLayout(once, at), once);
  assert.deepEqual(normalizeLayout(serializeLayout(once, at), at), once);
  assert.deepEqual(input, V2);
  once.shared.sizes.right = 1;
  assert.equal(V2.shared.sizes.right, 300);
  // Nested unknown data keeps its depth through a save (the preferences file allows 16 levels).
  const deep = {a: {b: {c: {d: {e: {f: {g: {h: {i: {j: 1}}}}}}}}}};
  assert.deepEqual(serializeLayout(normalizeLayout({deep}, at), at).deep, deep);
  assert.equal(normalizeLayout({fn: () => 1, date: new Date(0), nan: NaN, list: [1, undefined, Infinity, 'x']}, at).list.length, 2);
});

test('each workspace offers its presets; Build folds Structure to its strip on the left and hides the timeline', () => {
  assert.deepEqual(presetsFor('animate').map(preset => preset.id), ['animate', 'timing', 'focus', 'review']);
  assert.deepEqual(presetsFor('draw').map(preset => preset.id), ['focus', 'draw']);
  assert.deepEqual(presetsFor('build').map(preset => preset.id), ['focus', 'build', 'build-timeline']);
  const animate = defaultArrangement('animate');
  assert.deepEqual(animate.panels.map(record => [record.id, record.dock, record.order, record.active ?? false]),
    [['properties', 'right', 0, true], ['vfx', 'right', 1, false], ['library', 'right', 2, false], ['timeline', 'bottom', 0, true]]);
  assert.equal(animate.rail, 'left');
  assert.equal(animate.bottomSpan, 'full');
  assert.ok(sameArrangement(defaultArrangement('draw'), animate));
  const build = defaultArrangement('rig');
  assert.equal(place(build, 'structure'), 'strip@left');
  assert.equal(place(build, 'timeline'), 'hidden@bottom');
  assert.equal(place(presetArrangement('build-timeline', 'rig'), 'timeline'), 'bottom');
  const review = presetArrangement('review', 'animate');
  assert.deepEqual(['properties', 'vfx', 'library', 'timeline'].map(id => place(review, id)), ['hidden@right', 'hidden@right', 'hidden@right', 'strip@bottom']);
  assert.equal(presetArrangement('timing', 'draw'), null, 'Timing belongs to Animate');
  assert.equal(presetArrangement('focus', 'animate'), null, 'Focus is a toggle');
});

test('Timing writes 40% of the workspace to the one shared timeline height', () => {
  const layout = defaultLayout(at);
  const timing = applyPreset(layout, 'animate', 'timing', {...at, workspaceHeight: 856});
  assert.equal(timing.shared.sizes.bottom, 342);
  assert.equal(timing.modes.animate.preset, 'timing');
  assert.deepEqual(['properties', 'vfx', 'library'].map(id => place(timing.modes.animate, id)), ['right', 'strip@right', 'strip@right']);
  assert.deepEqual(timing.modes.draw, layout.modes.draw, 'other workspaces keep their arrangement');
  assert.equal(applyPreset(layout, 'draw', 'timing', at), layout, 'a preset of another workspace is ignored');
  assert.equal(applyPreset(layout, 'animate', 'nothing', at), layout);
  assert.throws(() => applyPreset(layout, 'studio', 'animate', at), TypeError);
  const back = applyPreset(timing, 'animate', 'animate', at);
  assert.ok(sameArrangement(back.modes.animate, defaultArrangement('animate')));
  assert.equal(back.shared.sizes.bottom, 342, 'the height is the user\'s until reset');
});

test('Focus folds docked and floating panels to strips and restores them', () => {
  const layout = normalizeLayout(V2, at);
  const focused = toggleFocus(layout, 'animate', at);
  const arrangement = focused.modes.animate;
  assert.deepEqual(['library', 'properties', 'vfx', 'timeline'].map(id => place(arrangement, id)), ['strip@left', 'strip@right', 'strip@right', 'strip@bottom']);
  assert.ok(sameArrangement(arrangement.focus, layout.modes.animate));
  assert.equal(toggleFocus(focused, 'animate', {...at, on: true}), focused);
  assert.deepEqual(applyPreset(layout, 'animate', 'focus', at), focused);
  // Focus survives a restart.
  assert.deepEqual(migrateLayout(serializeLayout(focused, at), at).layout.modes.animate, arrangement);
  const restored = toggleFocus(focused, 'animate', at).modes.animate;
  assert.ok(sameArrangement(restored, layout.modes.animate));
  assert.equal(restored.focus, null);
  // Build's timeline folds when shown and stays hidden when hidden.
  assert.equal(place(toggleFocus(layout, 'rig', at).modes.rig, 'timeline'), 'strip@bottom');
  assert.equal(place(toggleFocus(defaultLayout(at), 'rig', at).modes.rig, 'timeline'), 'hidden@bottom');
});

test('serialization writes the v1 mirror, compacts preset arrangements and stays JSON', () => {
  const defaults = serializeLayout(defaultLayout(at), at);
  assert.deepEqual(defaults, {studioVersion: 1, layoutVersion: 2, shared: {stamp: 0, sizes: {}},
    modes: {animate: {stamp: 0, preset: 'animate'}, draw: {stamp: 0, preset: 'draw'}, rig: {stamp: 0, preset: 'build'}}, saved: [], tombstones: []});
  const sized = serializeLayout(setSharedSize(defaultLayout(at), 'bottom', 300, at), at);
  assert.equal(sized.timeline, 300);
  assert.equal('right' in sized, false, 'a default size is not mirrored, so 1.1 keeps its own default');
  const moved = serializeLayout(normalizeLayout(V2, at), at);
  assert.deepEqual(moved.modes.animate.panels[0], {id: 'library', dock: 'left', order: 0, active: true});
  assert.deepEqual(moved.modes.animate.panels.find(record => record.id === 'vfx'), {id: 'vfx', dock: 'float', side: 'right', order: 1, rect: {x: 40, y: 30, w: 280, h: 360}});
  assert.deepEqual(moved.modes.rig, {stamp: 5, preset: 'build-timeline'});
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(moved))), JSON.stringify(moved));
  assert.ok(layoutBytes(moved) < 2048, `${layoutBytes(moved)} bytes`);
});

test('saved layouts: eight at most, clean names, rename, update and delete with a tombstone', () => {
  let layout = defaultLayout(at);
  assert.deepEqual(savePreset(layout, {name: '   ', mode: 'animate', ...at}).error, 'name');
  const first = savePreset(layout, {name: '  Fight\n setup  ', mode: 'animate', ...at});
  assert.equal(first.error, undefined);
  layout = first.layout;
  assert.equal(layout.saved[0].name, 'Fight setup');
  assert.equal(layout.saved[0].mode, 'animate');
  assert.equal(layout.modes.animate.preset, `user:${first.id}`);
  assert.equal(cleanLayoutName('x'.repeat(80)).length, 48);
  // Invisible format characters go (bidi overrides, zero-width spaces); joiners in emoji and scripts stay.
  assert.equal(cleanLayoutName('a\u202Eb\u200Bc\u2066d\uFEFF'), 'abcd');
  assert.equal(cleanLayoutName('\u202E\u200B \u200D'), '', 'nothing visible is no name');
  const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}';
  assert.equal(cleanLayoutName(`Team ${family}`), `Team ${family}`);
  assert.equal(cleanLayoutName('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'), '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', 'Persian keeps its ZWNJ');
  // Never cut inside an emoji sequence: the one that would pass 48 code points is left out.
  const cut = cleanLayoutName(`${'x'.repeat(45)}${family}`);
  assert.equal(cut, 'x'.repeat(45));
  assert.equal(cleanLayoutName(`${'x'.repeat(43)}${family}`), `${'x'.repeat(43)}${family}`);
  for (let index = 1; index < MAX_SAVED_LAYOUTS; index++) layout = savePreset(layout, {name: `Layout ${index}`, mode: 'draw', now: NOW + index}).layout;
  assert.equal(layout.saved.length, 8);
  assert.deepEqual(canSavePreset(layout, 'animate', at), {ok: false, reason: 'limit'});
  assert.equal(savePreset(layout, {name: 'Ninth', mode: 'animate', ...at}).error, 'limit');
  assert.equal(new Set(layout.saved.map(item => item.id)).size, 8);
  // Rename, update from the workspace, apply.
  const renamed = renamePreset(layout, first.id, 'Kick', at).layout;
  assert.equal(renamed.saved[0].name, 'Kick');
  assert.equal(renamePreset(layout, 'u404', 'x', at).error, 'missing');
  const docked = {...renamed, modes: {...renamed.modes, animate: {...renamed.modes.animate, ...movePanel(renamed.modes.animate, 'library', 'left', {mode: 'animate'})}}};
  const updated = updatePreset(docked, first.id, at).layout;
  assert.equal(place(updated.saved[0].arrangement, 'library'), 'left');
  const reset = resetMode(updated, 'animate', at);
  assert.equal(place(applyPreset(reset, 'animate', `user:${first.id}`, at).modes.animate, 'library'), 'left');
  // Delete leaves a tombstone; the workspace keeps its arrangement.
  const deleted = deletePreset(updated, first.id, {now: NOW + 100});
  assert.equal(deleted.saved.length, 7);
  assert.deepEqual(deleted.tombstones.find(item => item.id === first.id), {id: first.id, stamp: NOW + 100});
  assert.equal(deleted.modes.animate.preset, 'animate');
  assert.equal(place(deleted.modes.animate, 'library'), 'left');
  assert.deepEqual(canSavePreset(deleted, 'animate', at), {ok: true});
  // An older copy of a deleted layout does not come back.
  assert.equal(normalizeLayout({...deleted, saved: [...deleted.saved, updated.saved[0]]}, at).saved.length, 7);
});

test('saved layouts are capped and tombstones expire after 30 days', () => {
  const saved = Array.from({length: 11}, (_, index) => ({id: `u${index}`, name: `L${index}`, mode: 'animate', stamp: index}));
  const tombstones = [
    ...Array.from({length: 20}, (_, index) => ({id: `ut${index}`, stamp: NOW - index})),
    {id: 'uold', stamp: NOW - TOMBSTONE_TTL_MS - 1},
  ];
  const layout = normalizeLayout({saved: [...saved, {id: 'bad id', name: 'x', mode: 'animate'}, {id: 'u99', name: '', mode: 'animate'}], tombstones}, at);
  assert.deepEqual(layout.saved.map(item => item.id), ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  assert.equal(layout.tombstones.length, 16);
  assert.ok(!layout.tombstones.some(item => item.id === 'uold'));
  assert.equal(layout.tombstones[0].id, 'ut0', 'the newest are kept');
});

test('a layout that would pass the budget cannot be saved as a preset', () => {
  const base = layoutBytes(serializeLayout(defaultLayout(at), at));
  const bulky = normalizeLayout({padding: 'x'.repeat(LAYOUT_BUDGET_BYTES - base - 300)}, at);
  assert.ok(layoutBytes(serializeLayout(bulky, at)) <= LAYOUT_BUDGET_BYTES);
  assert.deepEqual(canSavePreset(bulky, 'animate', at), {ok: false, reason: 'budget'});
  assert.equal(savePreset(bulky, {name: 'Big', mode: 'animate', ...at}).error, 'budget');
});

test('trimming keeps a stored layout under the file limit, losing the least first', () => {
  const layout = normalizeLayout({...structuredClone(V2), tombstones: Array.from({length: 16}, (_, index) => ({id: `ut${index}`, stamp: NOW - index}))}, at);
  const small = fitBudget(serializeLayout(layout, at));
  assert.deepEqual(small.trimmed, []);
  assert.equal(small.ok, true);
  // Over the soft budget only tombstones go.
  const soft = fitBudget(serializeLayout({...layout, note: 'x'.repeat(LAYOUT_BUDGET_BYTES)}, at));
  assert.deepEqual(soft.trimmed, ['tombstones']);
  assert.ok(soft.bytes <= LAYOUT_FILE_LIMIT_BYTES);
  assert.equal(soft.value.saved.length, 1);
  // Over the file limit: focus snapshots, then old saved layouts, then the largest unknown keys.
  const focused = toggleFocus(layout, 'animate', at);
  const hard = fitBudget(serializeLayout({...focused, huge: 'y'.repeat(LAYOUT_FILE_LIMIT_BYTES), small: 1}, at));
  assert.equal(hard.ok, true);
  assert.ok(hard.bytes <= LAYOUT_FILE_LIMIT_BYTES);
  assert.deepEqual(hard.trimmed, ['tombstones', 'focus', 'saved:u1', 'key:huge']);
  assert.equal(hard.value.small, 1);
  assert.equal(hard.value.layoutVersion, 2);
  assert.equal(hard.value.studioVersion, 1);
  // What went can be taken out of the in-memory layout too, so it is not merged back.
  const trimmedLayout = trimLayout(normalizeLayout({...focused, huge: 'y'}, at), hard.removed, at);
  assert.deepEqual([trimmedLayout.saved.length, trimmedLayout.modes.animate.focus, 'huge' in trimmedLayout, trimmedLayout.tombstones.length],
    [0, null, false, hard.value.tombstones.length]);
});

test('trimming reaches unknown data at any depth before giving up', () => {
  const blob = 'z'.repeat(LAYOUT_FILE_LIMIT_BYTES / 4);
  const records = [{id: 'properties', dock: 'right', memo: blob}, {id: 'mixer', dock: 'left', data: blob}];
  const layout = normalizeLayout({
    shared: {sizes: {}, later: blob},
    modes: {animate: {preset: 'animate', rail: 'left', panels: records, blob, keep: 1}, camera: {blob}},
    saved: [{id: 'u1', name: 'One', mode: 'draw', stamp: 1, notes: blob, arrangement: {panels: records}}],
  }, at);
  const fitted = fitBudget(serializeLayout(layout, at), {budget: Infinity, limit: 2048});
  assert.equal(fitted.ok, true, 'the layout is still saved');
  assert.equal(fitted.trimmed[0], 'saved:u1', 'the oldest saved layout goes first, as before');
  assert.deepEqual(fitted.trimmed.slice(1).sort(), ['key:modes.animate.blob', 'key:modes.animate.panels.mixer', 'key:modes.animate.panels.properties.memo', 'key:modes.camera', 'key:shared.later']);
  assert.equal(fitted.value.modes.animate.keep, 1, 'small unknown keys stay');
  assert.deepEqual(Object.keys(fitted.value.modes.animate.panels.find(record => record.id === 'properties')), ['id', 'dock', 'order']);
  // A 17 KiB blob in a mode entry no longer blocks every save.
  const single = fitBudget(serializeLayout(normalizeLayout({modes: {animate: {preset: 'animate', blob: 'z'.repeat(17 * 1024)}}}, at), at));
  assert.deepEqual([single.ok, single.trimmed, single.removed], [true, ['key:modes.animate.blob'], [['modes', 'animate', 'blob']]]);
});

test('moving panels follows each panel\'s allowed places', () => {
  const animate = defaultArrangement('animate');
  const left = movePanel(animate, 'library', 'left', {mode: 'animate'});
  assert.equal(place(left, 'library'), 'left');
  assert.equal(records(left).library.active, true);
  assert.equal(records(left).properties.active, true, 'Properties stays the right island\'s tab');
  const tab = movePanel(left, 'vfx', 'left', {mode: 'animate', index: 0});
  assert.deepEqual(tab.panels.filter(record => record.dock === 'left').map(record => [record.id, record.active ?? false]), [['vfx', true], ['library', false]]);
  assert.deepEqual(activatePanel(tab, 'library', {mode: 'animate'}).panels.filter(record => record.dock === 'left').map(record => record.active ?? false), [false, true]);
  const floated = movePanel(animate, 'vfx', 'float', {mode: 'animate', rect: {x: 1, y: 2, w: 300, h: 400}});
  assert.deepEqual(records(floated).vfx.rect, {x: 1, y: 2, w: 300, h: 400});
  assert.equal(place(floated, 'vfx'), 'float@right');
  const docked = movePanel(floated, 'vfx', 'docked', {mode: 'animate'});
  assert.equal(place(docked, 'vfx'), 'right');
  assert.equal(records(docked).vfx.active, true);
  // Refused moves return the arrangement unchanged.
  assert.equal(movePanel(animate, 'timeline', 'left', {mode: 'animate'}), animate);
  assert.equal(movePanel(animate, 'timeline', 'hidden', {mode: 'animate'}), animate);
  assert.equal(place(movePanel(animate, 'properties', 'float', {mode: 'animate'}), 'properties'), 'float@right');
  assert.equal(movePanel(animate, 'structure', 'left', {mode: 'animate'}), animate);
  assert.throws(() => movePanel(animate, 'vfx', 'left', {}), TypeError, 'the workspace is required');
  assert.deepEqual(['left', 'right', 'bottom', 'float', 'strip', 'hidden'].filter(target => canPlacePanel('library', target, {mode: 'animate'})), ['left', 'right', 'float', 'strip', 'hidden']);
  assert.deepEqual(['left', 'right', 'bottom', 'float', 'strip', 'hidden'].filter(target => canPlacePanel('timeline', target, {mode: 'rig'})), ['bottom', 'strip', 'hidden']);
  assert.equal(canPlacePanel('library', 'left', {mode: 'nowhere'}), false);
});

test('splitting a dock creates two active islands and preserves them through storage', () => {
  for (const split of ['before', 'after']) {
    const start = defaultArrangement('animate');
    const arranged = movePanel(start, 'vfx', 'right', {mode: 'animate', split});
    const grouped = id => records(arranged)[id].group ?? 0;
    assert.equal(grouped('vfx'), split === 'before' ? 0 : 1);
    assert.equal(grouped('properties'), split === 'before' ? 1 : 0);
    assert.equal(grouped('library'), grouped('properties'));
    assert.equal(records(arranged).vfx.active, true);
    assert.equal(records(arranged).properties.active, true);
    assert.deepEqual(arranged.weights.right, [.5, .5]);
    const stored = normalizeLayout({modes: {animate: {...arranged, preset: 'animate'}}});
    const restored = migrateLayout(serializeLayout(stored)).layout;
    assert.ok(sameArrangement(restored.modes.animate, arranged));
    assert.equal(movePanel(arranged, 'library', 'right', {mode: 'animate', split}), arranged, 'no third island');
    const merged = movePanel(arranged, 'vfx', 'right', {mode: 'animate', group: grouped('properties')});
    assert.ok(merged.panels.filter(record => record.dock === 'right').every(record => !record.group));
  }
});

test('reset returns workspaces and sizes to their defaults and keeps saved layouts', () => {
  const layout = normalizeLayout(V2, at);
  const one = resetMode(layout, 'animate', at);
  assert.ok(sameArrangement(one.modes.animate, defaultArrangement('animate')));
  assert.equal(one.modes.animate.zoomMemory, 2, 'unknown keys stay');
  assert.deepEqual(one.modes.rig, layout.modes.rig);
  const all = resetLayout(layout, at);
  assert.deepEqual(all.shared.sizes, {});
  assert.equal(all.shared.later, true);
  for (const mode of ['animate', 'draw', 'rig']) assert.ok(sameArrangement(all.modes[mode], defaultArrangement(mode)));
  assert.equal(all.saved.length, 1);
});

