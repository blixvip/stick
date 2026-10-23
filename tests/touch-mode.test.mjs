/**
 * The touch interface's decisions (src/touch/touch-mode.mjs) and the layout
 * solver's touch profile (docs/TOUCH.md): when it is on, which form factor a
 * window is, the attributes the root carries, and how the side panels fold
 * on phones and tablets while the desktop solution stays as it was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINGER_DRAW_SETTINGS, PHONE_MAX, TOUCH_SETTINGS, formFactor, installTouchMode, normalizeFingerDraw, normalizeTouchSetting,
  readOverride, resolveTouch, touchAttributes,
} from '../src/touch/touch-mode.mjs';
import {solveLayout} from '../src/shell/layout-solver.mjs';
import {defaultLayout} from '../src/shell/layout-schema.mjs';
import {DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings} from '../src/settings.mjs';

test('Automatic follows the primary pointer; On and Off force the touch interface', () => {
  assert.deepEqual(TOUCH_SETTINGS, ['auto', 'on', 'off']);
  assert.equal(resolveTouch({setting: 'auto', coarse: true}), true);
  assert.equal(resolveTouch({setting: 'auto', coarse: false}), false, 'a laptop with a touch screen keeps the desktop interface');
  assert.equal(resolveTouch({setting: 'on', coarse: false}), true);
  assert.equal(resolveTouch({setting: 'off', coarse: true}), false);
  assert.equal(resolveTouch({setting: 'nonsense', coarse: true}), true, 'an unknown setting reads as Automatic');
});

test('?ui=touch and ?ui=desktop override the setting for one page load', () => {
  assert.equal(readOverride('?ui=touch'), 'touch');
  assert.equal(readOverride('?ui=desktop&x=1'), 'desktop');
  assert.equal(readOverride('?ui=phone'), null);
  assert.equal(readOverride(''), null);
  assert.equal(resolveTouch({setting: 'off', override: 'touch'}), true);
  assert.equal(resolveTouch({setting: 'on', coarse: true, override: 'desktop'}), false);
});

test('A window whose shorter side is under 600px is a phone; its longer side names the orientation', () => {
  assert.equal(PHONE_MAX, 600);
  assert.deepEqual(formFactor(390, 844), {form: 'phone', orient: 'portrait', layout: 'phone-portrait'});
  assert.deepEqual(formFactor(844, 390), {form: 'phone', orient: 'landscape', layout: 'phone-landscape'});
  assert.deepEqual(formFactor(820, 1180), {form: 'tablet', orient: 'portrait', layout: 'tablet-portrait'});
  assert.deepEqual(formFactor(1180, 820), {form: 'tablet', orient: 'landscape', layout: 'tablet-landscape'});
  assert.deepEqual(formFactor(599, 900).form, 'phone');
  assert.deepEqual(formFactor(600, 600), {form: 'tablet', orient: 'landscape', layout: 'tablet-landscape'}, 'a square window is landscape');
  assert.deepEqual(formFactor(0, 0).form, 'phone', 'an unmeasured window never throws');
});

test('The root carries the layout only while the touch interface is on', () => {
  assert.deepEqual(touchAttributes({active: true, form: 'phone', orient: 'portrait', layout: 'phone-portrait'}),
    {input: 'touch', form: 'phone', orient: 'portrait', touchLayout: 'phone-portrait'});
  assert.deepEqual(touchAttributes({active: false, form: 'phone', orient: 'portrait', layout: 'phone-portrait'}),
    {input: 'pointer', form: null, orient: null, touchLayout: null});
});

test('The settings keep the touch interface and finger drawing, repairing unknown values', () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.touchInterface, 'auto');
  assert.equal(DEFAULT_EDITOR_SETTINGS.fingerDraw, 'auto');
  assert.deepEqual(FINGER_DRAW_SETTINGS, ['auto', 'always', 'never']);
  assert.equal(normalizeEditorSettings({touchInterface: 'on', fingerDraw: 'never'}).touchInterface, 'on');
  assert.equal(normalizeEditorSettings({touchInterface: 'on', fingerDraw: 'never'}).fingerDraw, 'never');
  assert.equal(normalizeEditorSettings({touchInterface: 'sometimes', fingerDraw: 7}).touchInterface, 'auto');
  assert.equal(normalizeFingerDraw('sometimes'), 'auto');
  assert.equal(normalizeTouchSetting(undefined), 'auto');
});

/** A minimal window and document for installTouchMode. */
function fakeWindow({width, height, coarse, search = ''}) {
  const listeners = new Map(), media = new Set();
  const root = {dataset: {}};
  const doc = {documentElement: root, getElementById: () => null, activeElement: null};
  const query = {matches: coarse, addEventListener: (type, fn) => media.add(fn)};
  const win = {
    document: doc, innerWidth: width, innerHeight: height, location: {search},
    matchMedia: () => query,
    addEventListener: (type, fn) => listeners.set(type, fn),
    resize(w, h) { this.innerWidth = w; this.innerHeight = h; listeners.get('resize')?.(); },
    setCoarse(value) { query.matches = value; for (const fn of media) fn(); },
  };
  return {win, root};
}

test('The touch mode writes the root and tells its listeners about each change, not about every resize', () => {
  const {win, root} = fakeWindow({width: 390, height: 844, coarse: true});
  const mode = installTouchMode({window: win, getSetting: () => 'auto'});
  assert.equal(root.dataset.input, 'touch');
  assert.equal(root.dataset.touchLayout, 'phone-portrait');
  const heard = [];
  mode.on((state, previous) => heard.push([previous?.layout, state.active ? state.layout : 'off']));
  win.resize(390, 800);
  assert.equal(heard.length, 0, 'the same layout is not a change');
  win.resize(844, 390);
  assert.equal(root.dataset.touchLayout, 'phone-landscape');
  assert.equal(root.dataset.orient, 'landscape');
  win.setCoarse(false);
  assert.equal(root.dataset.input, 'pointer');
  assert.equal(root.dataset.touchLayout, undefined);
  assert.deepEqual(heard, [['phone-portrait', 'phone-landscape'], ['phone-landscape', 'off']]);
  mode.destroy();
});

test('The keyboard rising under a text field keeps the layout; turning the phone still changes it', () => {
  const {win, root} = fakeWindow({width: 390, height: 660, coarse: true});
  const mode = installTouchMode({window: win, getSetting: () => 'auto'});
  win.document.activeElement = {closest: selector => (selector.includes('input') ? {} : null)};
  win.resize(390, 360);
  assert.equal(root.dataset.touchLayout, 'phone-portrait', 'the keyboard took the height, not the orientation');
  win.resize(660, 360);
  assert.equal(root.dataset.touchLayout, 'phone-landscape', 'a new width is a real turn');
  win.document.activeElement = null;
  win.resize(390, 660);
  assert.equal(root.dataset.touchLayout, 'phone-portrait');
  mode.destroy();
});

const LAYOUT = defaultLayout({now: 1_700_000_100_000});
const solve = (width, height, touch, mode = 'animate') => solveLayout(LAYOUT, {width, height, mode, bandMin: 626, artboard: {width: 960, height: 540},
  // As the dock host does in touch mode: the workspace's own box, with no band above it.
  ...(touch ? {touch: {active: true, ...formFactor(width, height)}, measured: {band: 0}} : {})});

test('On a phone the inspector is a sheet and the tool bar takes its touch size', () => {
  for (const [width, height] of [[390, 640], [784, 360]]) {
    const solution = solve(width, height, true);
    assert.equal(solution.touch, 'phone');
    assert.equal(solution.regions.right.state, 'sheet', `${width}×${height}`);
    assert.equal(solution.panels.properties.presentation, 'sheet');
    assert.deepEqual(solution.band, [], 'the band folds nothing: the touch stylesheet lays it out');
  }
  const side = solve(784, 360, true);
  assert.equal(side.rail.orientation, 'vertical');
  assert.equal(side.rail.width, 56);
  assert.ok(side.stageInsets.left >= 56 + 8, 'the artboard keeps clear of the tools down the side');
});

test('Upright, a phone lays the tools along the stage\u2019s bottom and keeps the timeline\u2019s body docked', () => {
  const upright = solve(390, 640, true);
  assert.equal(upright.rail.orientation, 'horizontal');
  assert.equal(upright.rail.rect.height, 56);
  assert.equal(upright.rail.rect.y + upright.rail.rect.height + 8, upright.viewport.y + upright.viewport.height, 'along the bottom edge');
  assert.ok(upright.stageInsets.bottom >= 56 + 8 && upright.stageInsets.left < 56, 'the artboard gives the tools height, not width');
  assert.equal(upright.regions.bottom.state, 'docked', 'the frames stay in view even at the low height tier');
  assert.equal(upright.regions.bottom.size, Math.round(0.47 * 640));
  const side = solve(844, 360, true);
  assert.equal(side.regions.bottom.state, 'docked', 'on its side the timeline stays docked');
  assert.equal(side.regions.bottom.size, 52 + 44 + 48, 'its header, the ruler and one finger-tall row');
});

test('On a tablet the inspector docks while the stage keeps 560px, and opens as a sheet otherwise, never a strip', () => {
  const landscape = solve(1180, 768, true);
  assert.equal(landscape.touch, 'tablet');
  assert.equal(landscape.regions.right.state, 'docked');
  assert.ok(landscape.stage.width >= 560);
  const portrait = solve(820, 1104, true);
  assert.equal(portrait.regions.right.state, 'sheet');
  assert.ok(portrait.stage.width >= 560);
});

test('Build keeps Structure one tap away on a phone: its strip', () => {
  const solution = solve(784, 360, true, 'rig');
  assert.ok(['strip', 'hidden'].includes(solution.regions.left.state));
  assert.notEqual(solution.panels.structure.presentation, 'docked');
});

test('Without the touch interface the solution is the desktop one', () => {
  const desktop = solve(1180, 768, false), again = solveLayout(LAYOUT, {width: 1180, height: 768, mode: 'animate', bandMin: 626, artboard: {width: 960, height: 540}, touch: {active: false, form: 'tablet'}});
  assert.equal(desktop.touch, null);
  assert.deepEqual(again, desktop, 'an inactive touch state changes nothing');
});

test('an earlier on/off finger drawing choice becomes Always', () => {
  assert.equal(normalizeEditorSettings({fingerDrawing: true}).fingerDraw, 'always');
  assert.equal(normalizeEditorSettings({fingerDrawing: false}).fingerDraw, 'auto');
  assert.equal(normalizeEditorSettings({fingerDrawing: true, fingerDraw: 'never'}).fingerDraw, 'never');
  assert.equal('fingerDrawing' in normalizeEditorSettings({fingerDrawing: true}), false);
});
