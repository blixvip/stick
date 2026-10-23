/**
 * The panel registry (src/shell/panel-registry.mjs): descriptors, late roots,
 * visibility with onVisibility callbacks, and the constraint data the layout
 * schema and solver read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PANEL_CATALOG, createPanelRegistry, normalizePanelDescriptor, panelCanHide, panelInMode} from '../src/shell/panel-registry.mjs';
import {defaultLayout} from '../src/shell/layout-schema.mjs';
import {solveLayout} from '../src/shell/layout-solver.mjs';

test('the catalogue describes today\'s panels with their limits and places', () => {
  assert.deepEqual(PANEL_CATALOG.map(panel => [panel.id, panel.docks, panel.floatable, panel.min, panel.pref, panel.max]), [
    ['properties', ['right', 'left'], true, 256, 320, 420],
    ['vfx', ['right', 'left'], true, 256, 320, 420],
    ['library', ['right', 'left'], true, 256, 320, 460],
    ['structure', ['left', 'right'], true, 200, 232, 360],
    ['timeline', ['bottom'], false, 168, null, null],
  ]);
  const byId = Object.fromEntries(PANEL_CATALOG.map(panel => [panel.id, panel]));
  assert.equal(panelInMode(byId.structure, 'rig'), true);
  assert.equal(panelInMode(byId.structure, 'animate'), false);
  assert.equal(panelCanHide(byId.timeline, 'rig'), true);
  assert.equal(panelCanHide(byId.timeline, 'draw'), false);
  assert.equal(panelCanHide(byId.properties, 'animate'), true);
  assert.equal(byId.timeline.maxFraction, 0.6);
  assert.equal(byId.structure.stageMin, null, 'Structure narrows to 200 and folds only under the 360px #viewport floor');
  assert.ok(Object.isFrozen(PANEL_CATALOG) && PANEL_CATALOG.every(Object.isFrozen));
});

test('descriptors are validated', () => {
  for (const bad of [null, {}, {id: 'Bad'}, {id: 'x'}, {id: 'x', docks: ['top']}, {id: 'x', docks: ['left'], modes: ['studio']}]) {
    assert.throws(() => normalizePanelDescriptor(bad), TypeError, JSON.stringify(bad));
  }
  const panel = normalizePanelDescriptor({id: 'notes', regions: ['left', 'left'], min: 300, pref: 100, max: 200, canHide: ['draw', 'nope']});
  assert.deepEqual([panel.docks, panel.min, panel.pref, panel.max, panel.canHide, panel.floatable, panel.defaultDock], [['left'], 300, 300, 300, ['draw'], false, null]);
  // A default dock must be a fold or one of the panel's docks.
  assert.equal(normalizePanelDescriptor({id: 'notes', docks: ['left'], defaultDock: 'strip'}).defaultDock, 'strip');
  assert.equal(normalizePanelDescriptor({id: 'notes', docks: ['left'], defaultDock: 'right'}).defaultDock, null);
});

test('Build is named build or rig alike', () => {
  const panel = normalizePanelDescriptor({id: 'rigging', docks: ['left'], modes: ['build'], canHide: ['build']});
  assert.deepEqual([panel.modes, panel.canHide], [['rig'], ['rig']]);
  const byId = Object.fromEntries(PANEL_CATALOG.map(item => [item.id, item]));
  assert.equal(panelInMode(byId.structure, 'build'), true);
  assert.equal(panelCanHide(byId.timeline, 'build'), true);
  const registry = createPanelRegistry();
  assert.deepEqual(registry.list({mode: 'build'}).map(item => item.id), registry.list({mode: 'rig'}).map(item => item.id));
  assert.ok(registry.list({mode: 'build'}).some(item => item.id === 'structure'));
});

test('late roots complete a catalogue panel and re-announce it', () => {
  const registry = createPanelRegistry();
  const defined = [];
  registry.on('define', event => defined.push(event.id));
  const before = registry.constraints();
  assert.equal(registry.root('library'), null);
  const root = {id: 'user-library'};
  const descriptor = registry.define({id: 'library', root: () => root});
  assert.equal(registry.root('library'), root);
  assert.equal(descriptor.max, 460, 'the catalogue limits are kept');
  assert.deepEqual(defined, ['library']);
  assert.notEqual(registry.constraints(), before, 'the constraint snapshot is rebuilt');
  assert.equal(registry.constraints(), registry.constraints());
  // A new panel is solved like any other.
  registry.define({id: 'notes', title: 'Notes', docks: ['left'], min: 220, pref: 240, max: 320, modes: ['animate']});
  assert.deepEqual(registry.list({mode: 'rig'}).map(panel => panel.id), ['properties', 'vfx', 'library', 'structure', 'timeline']);
  const solution = solveLayout(defaultLayout(), {width: 1440, height: 900, mode: 'animate', panels: registry.constraints()});
  assert.equal(solution.panels.notes.presentation, 'docked');
  assert.equal(solution.regions.left.size, 232);
  assert.throws(() => registry.define(null), TypeError);
  assert.throws(() => registry.on('nope', () => {}), TypeError);
});

test('visibility changes call onVisibility once per change', () => {
  const registry = createPanelRegistry();
  const calls = [];
  registry.define({id: 'vfx', onVisibility: (visible, id) => calls.push(['descriptor', id, visible])});
  const controller = new AbortController();
  registry.onVisibility('vfx', visible => calls.push(['watcher', visible]), {signal: controller.signal});
  const events = [];
  registry.on('visibility', event => events.push(event.changed));
  assert.equal(registry.isVisible('vfx'), false);
  assert.deepEqual(registry.setVisibility({vfx: true, properties: true, nothing: true}), ['vfx', 'properties']);
  assert.deepEqual(registry.setVisibility('vfx', true), []);
  controller.abort();
  registry.setVisibility('vfx', false);
  assert.deepEqual(calls, [['descriptor', 'vfx', true], ['watcher', true], ['descriptor', 'vfx', false]]);
  assert.deepEqual(events, [['vfx', 'properties'], ['vfx']]);
  // A failing callback does not stop the others.
  const reported = [];
  const original = globalThis.reportError;
  globalThis.reportError = error => reported.push(error.message);
  try {
    registry.onVisibility('library', () => { throw new Error('boom'); });
    registry.onVisibility('library', visible => calls.push(['after', visible]));
    registry.setVisibility('library', true);
  } finally {
    globalThis.reportError = original;
  }
  assert.deepEqual(reported, ['boom']);
  assert.deepEqual(calls.at(-1), ['after', true]);
});

test('a callback that arrives while its panel is visible hears it at once', () => {
  const registry = createPanelRegistry();
  const layout = defaultLayout();
  const toLibrary = {...layout, modes: {...layout.modes, animate: {...layout.modes.animate,
    panels: layout.modes.animate.panels.map(record => (record.side !== 'right' ? record : record.id === 'library' ? {...record, active: true} : {...record, active: false}))}}};
  const solution = solveLayout(toLibrary, {width: 1440, height: 900, mode: 'animate'});
  assert.equal(solution.panels.library.visible, true);
  registry.applySolution(solution);
  // The Library root is defined late, while its tab is already the shown one.
  const calls = [];
  const onVisibility = (visible, id) => calls.push([id, visible]);
  registry.define({id: 'library', root: () => ({}), onVisibility});
  assert.deepEqual(calls, [['library', true]]);
  registry.applySolution(solution);
  registry.define({id: 'library', title: 'Library'});
  assert.deepEqual(calls, [['library', true]], 'a re-define keeping the callback does not repeat it');
  // A hidden panel's late callback waits for a change.
  registry.define({id: 'vfx', onVisibility});
  assert.deepEqual(calls, [['library', true]]);
  // Watchers can ask for the current state.
  const watched = [];
  registry.onVisibility('library', visible => watched.push(visible), {immediate: true});
  registry.onVisibility('vfx', visible => watched.push(visible), {immediate: true});
  registry.onVisibility('library', visible => watched.push(`later ${visible}`));
  assert.deepEqual(watched, [true, false]);
});

test('a solution drives visibility; activate asks the dock host', () => {
  const registry = createPanelRegistry();
  const solution = solveLayout(defaultLayout(), {width: 1440, height: 900, mode: 'animate'});
  assert.deepEqual(registry.applySolution(solution).sort(), ['properties', 'timeline']);
  assert.equal(registry.isVisible('vfx'), false);
  // A panel open as a sheet stays visible through a re-solve.
  assert.deepEqual(registry.applySolution(solution, {open: ['vfx']}), ['vfx']);
  assert.deepEqual(registry.applySolution(solution, {open: ['vfx']}), []);
  assert.deepEqual(registry.applySolution(solution), ['vfx']);
  const low = solveLayout(defaultLayout(), {width: 1440, height: 500, mode: 'animate'});
  assert.deepEqual(registry.applySolution(low), ['timeline']);
  const activated = [];
  registry.on('activate', event => activated.push(event.id));
  assert.equal(registry.activate('library'), true);
  assert.equal(registry.activate('nothing'), false);
  assert.deepEqual(activated, ['library']);
});
