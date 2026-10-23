/**
 * The tutorials' engine and catalog (src/tutorials/, docs/TUTORIALS.md): steps are done by what the person
 * changed since the step began, and every tutorial's words exist. The real editor runs them in
 * tests/tutorials.browser.mjs.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TutorialEngine} from '../src/tutorials/tutorial-engine.mjs';
import {TUTORIALS, tutorialById, catalogKeys, PRACTICE_HAND} from '../src/tutorials/tutorial-catalog.mjs';
import english from '../src/locales/en.mjs';
import {placeholders} from '../src/locales/catalog-validation.mjs';
import {createTutorialProbe} from '../src/tutorials/tutorial-probe.mjs';

const lesson = {id: 'test', steps: [
  {id: 'look'},
  {id: 'zoom', done: (now, start) => now.zoom > start.zoom},
  {id: 'flip', done: now => now.ran.has('mirror')},
]};
function run(tutorial = lesson) {
  const editor = {zoom: 1}, events = [];
  const engine = new TutorialEngine(tutorial, {read: () => ({get zoom() { return editor.zoom; }}), onChange: change => events.push(change)});
  return {editor, events, engine};
}

test('a step that only explains waits for Next; a step that waits is done by a change since it began', () => {
  const {editor, events, engine} = run();
  editor.zoom = 2;
  engine.begin();
  assert.deepEqual(events.map(event => [event.kind, event.step?.id]), [['step', 'look']]);
  assert.equal(engine.waits, false);
  assert.equal(engine.pulse(), false, 'an explaining step is never done by itself');
  engine.next();
  assert.equal(engine.start.zoom, 2, 'the step reads the editor as it begins');
  assert.equal(engine.pulse(), false, 'the zoom it began with does not count');
  editor.zoom = 3;
  assert.equal(engine.pulse(), true);
  assert.equal(engine.pulse(), false, 'a step turns done once');
  assert.equal(events.at(-1).kind, 'satisfied');
  assert.equal(events.at(-1).now.zoom, 3);
  assert.equal(engine.progress, 2 / 3);
});

test('a command counts for the step that is waiting, and only from when it began', () => {
  const {engine} = run();
  engine.begin();
  engine.ran('mirror');
  engine.go(2);
  assert.equal(engine.pulse(), false, 'a command run before the step does not finish it');
  engine.ran('mirror');
  assert.equal(engine.pulse(), true);
});

test('back, go and finish: past the last step the tutorial is finished, once', () => {
  const {events, engine} = run();
  engine.begin();
  engine.go(2);
  engine.back();
  assert.equal(engine.step.id, 'zoom');
  engine.go(-4);
  assert.equal(engine.index, 0, 'never before the first step');
  engine.go(3);
  assert.equal(engine.finished, true);
  assert.equal(engine.progress, 1);
  assert.equal(engine.next(), false, 'a finished tutorial stays finished');
  assert.equal(events.filter(event => event.kind === 'finished').length, 1);
  engine.begin();
  assert.equal(engine.finished, false, 'it can begin again');
  assert.equal(engine.step.id, 'look');
});

test('a step whose test throws is simply not done', () => {
  const {engine} = run({id: 'broken', steps: [{id: 'x', done: now => now.missing.value}]});
  engine.begin();
  assert.equal(engine.pulse(), false);
  assert.throws(() => new TutorialEngine({steps: []}, {read: () => ({})}), TypeError);
  assert.throws(() => new TutorialEngine(lesson, {}), TypeError);
});

test('five tutorials, each short, each with ids, an icon and its practice set up', () => {
  assert.deepEqual(TUTORIALS.map(tutorial => tutorial.id), ['tour', 'canvas', 'posing', 'timeline', 'panels']);
  for (const tutorial of TUTORIALS) {
    assert.ok(Object.isFrozen(tutorial) && Object.isFrozen(tutorial.steps), tutorial.id);
    assert.ok(tutorial.steps.length >= 4 && tutorial.steps.length <= 8, `${tutorial.id} has ${tutorial.steps.length} steps`);
    assert.ok(['none', 'figure'].includes(tutorial.setup.selection), tutorial.id);
    assert.ok(tutorial.minutes >= 1 && tutorial.minutes <= 5, tutorial.id);
    assert.equal(new Set(tutorial.steps.map(step => step.id)).size, tutorial.steps.length, `${tutorial.id} step ids are unique`);
    assert.ok(tutorial.steps.some(step => step.done), `${tutorial.id} asks the person to do something`);
    for (const step of tutorial.steps) {
      const target = step.target;
      assert.ok(target.selector || ['stage', 'figure', 'origin', 'joint'].includes(target.canvas) || ['ruler', 'grid', 'labels'].includes(target.timeline), `${tutorial.id}.${step.id} target`);
      if (target.canvas === 'joint') assert.equal(target.segment, PRACTICE_HAND);
      if (step.demo) assert.ok(['click', 'drag', 'scroll', 'keys'].includes(step.demo.kind), `${tutorial.id}.${step.id} demo`);
      if (step.done) assert.ok(step.doneKey, `${tutorial.id}.${step.id} says when it is done`);
    }
  }
  assert.equal(tutorialById('canvas').id, 'canvas');
  assert.equal(tutorialById('nope'), null);
});

test('every word a tutorial shows is in the English catalog, with the parameters it is given', () => {
  const keys = catalogKeys();
  assert.ok(keys.length > 80, `${keys.length} keys`);
  for (const key of keys) assert.equal(typeof english[key], 'string', `${key} is in the English catalog`);
  // A step names its shortcut through {shortcut} only; titles and lines take no parameters.
  for (const key of keys) assert.ok(placeholders(english[key]).every(name => name === 'shortcut'), `${key} uses only {shortcut}`);
  for (const tutorial of TUTORIALS) for (const step of tutorial.steps) {
    const say = typeof step.sayKey === 'function' ? step.sayKey({touch: false, zoomGesture: 'ctrl-scroll', shortcut: () => 'Ctrl P'}) : step.sayKey;
    if (placeholders(english[say]).includes('shortcut')) assert.ok(step.shortcut, `${say} names the step's shortcut command`);
  }
});

test('each waiting step reads only what the editor probe offers', () => {
  const figure = {unique_id: 1, root_x: 480, root_y: 280, angles: [0.5, 1]};
  const editor = {selectedUid: 1, selectedJoint: -1, canUndo: false, canRedo: false, tick: 0, frame: {objects: [figure]},
    report: {keyframes: [{}], _styk: {layers: {order: ['layer-1']}, layerSheet: {tracks: {'layer-1': {keys: [{tick: 0}]}}}}}};
  const state = {tool: 'select', view: {scale: 1, x: 0, y: 0}, settings: {canvasZoomGesture: 'ctrl-scroll', canvasGrid: false, timelineMode: 'advanced'},
    handles: true, playing: false, onion: true, home: false};
  const read = createTutorialProbe({editor, state, mode: () => 'animate', fitted: () => true, touch: () => false,
    shell: () => ({registry: {isVisible: id => id !== 'library'}}), timeline: () => ({pxPerTick: 18}), overlays: {top: () => null}});
  const reading = read();
  assert.equal(reading.keys, 1);
  assert.equal(reading.pose, '0.500,1.000');
  assert.deepEqual(reading.panels, {properties: true, vfx: true, library: false, timeline: true});
  for (const tutorial of TUTORIALS) for (const step of tutorial.steps) {
    if (!step.done) continue;
    const now = new Proxy(Object.create(reading, {ran: {value: new Set()}}), {get(target, key) {
      if (!(key in target)) throw new Error(`${tutorial.id}.${step.id} reads ${String(key)}`);
      return Reflect.get(target, key);
    }});
    assert.equal(typeof step.done(now, reading), 'boolean', `${tutorial.id}.${step.id}`);
  }
});
