import test from 'node:test';
import assert from 'node:assert/strict';
import {COMMAND_BY_ID, CATALOG_REQUIREMENTS} from '../src/ui/command-catalog.mjs';
import {createCommandRegistry} from '../src/ui/command-registry.mjs';
import {icon} from '../src/icons.mjs';
import {PIN_GROUP, QUICK_ACTIONS, QUICK_CONTEXTS, QUICK_LIMITS, pinQuickAction, quickBudgetProblems, quickDefaults, quickLabel, quickPlacements,
  quickText, resolveQuickActions, unpinQuickAction, withShiftHint} from '../src/ui/quick-actions.mjs';

// A registry over stand-in actions, as the app builds it: labels, glyphs and shortcuts come from the catalog and
// HOTKEY_COMMANDS; every requirement holds unless the context says otherwise.
function registryFor(state = {mode: 'animate'}) {
  const ids = [...COMMAND_BY_ID.keys()];
  return createCommandRegistry({
    actions: Object.fromEntries(ids.map(id => [id, () => {}])),
    context: () => state,
    requirements: Object.fromEntries(CATALOG_REQUIREMENTS.map(name => [name, context => context[name] ?? true])),
    checked: (id, context) => (id === 'toggle-isolate' ? Boolean(context.isolate) : undefined),
    formatBinding: binding => binding.replace('Mod+', 'Ctrl+').replace(/Key([A-Z])/g, '$1'),
    onError: error => { throw error; },
  });
}
const describeWith = registry => id => (registry.has(id) ? registry.get(id) : null);
const row = (context, options = {}) => {
  const registry = options.registry ?? registryFor(options.state);
  return resolveQuickActions({context, describe: describeWith(registry), ...options});
};
const shape = resolved => resolved.groups.map(group => group.map(item => `${item.kind}:${item.kind === 'word' ? item.word : item.tile ?? item.label}`));

test('today\'s quick actions use existing commands and stay within the budget in every context', () => {
  for (const entry of QUICK_ACTIONS) {
    assert.ok(COMMAND_BY_ID.has(entry.id), `${entry.id} is a catalog command`);
    for (const placement of quickPlacements(entry)) {
      assert.ok(Object.hasOwn(QUICK_CONTEXTS, placement.context), `${entry.id}: ${placement.context} is a known context`);
      assert.ok(QUICK_CONTEXTS[placement.context].groups.includes(placement.group), `${entry.id}: group ${placement.group} is ordered`);
      if (placement.shift) assert.ok(COMMAND_BY_ID.has(placement.shift), `${entry.id}'s Shift variant ${placement.shift} exists`);
    }
  }
  const registry = registryFor({mode: 'animate'}), build = registryFor({mode: 'rig'});
  const describe = id => (describeWith(COMMAND_BY_ID.get(id)?.modes?.includes('rig') ? build : registry))(id);
  assert.deepEqual(quickBudgetProblems(QUICK_ACTIONS, {describe, drawing: name => icon(name)}), [], 'no two glyphs in a row draw the same');
  for (const context of Object.keys(QUICK_CONTEXTS)) {
    const defaults = quickDefaults(QUICK_ACTIONS, context);
    assert.ok(defaults.length >= 1 && defaults.length <= QUICK_LIMITS.defaults, `${context}: ${defaults.length} defaults`);
  }
});

test('the figure row: Flip · Front, Back (words; Shift: one step) · Duplicate, Delete, and a free slot', () => {
  const resolved = row('figure');
  assert.deepEqual(shape(resolved), [['glyph:Flip horizontally'], ['word:Front', 'word:Back'], ['glyph:Duplicate', 'glyph:Delete']]);
  const [flip, front] = resolved.items;
  assert.equal(flip.shortcut, 'Shift+H', 'the tooltip carries the key from the user\'s bindings');
  assert.equal(flip.icon, 'flip');
  assert.deepEqual([front.label, front.shift, front.shiftHint], ['Bring to front', 'layer-up', 'one step']);
  assert.equal(resolved.items.length, 5, 'the sixth slot waits for a pin');
  for (const context of ['figures', 'text', 'image']) assert.deepEqual(shape(row(context)), shape(resolved), `${context} uses the figure's row`);
});

test('the joint row: Front, Back · Flip limb, with Shift for one step', () => {
  const resolved = row('joint');
  assert.deepEqual(shape(resolved), [['word:Front', 'word:Back'], ['glyph:Flip limb']]);
  assert.deepEqual(resolved.groups[0].map(item => [item.id, item.icon, item.label, item.shift, item.shiftHint]),
    [['selection-front', 'bring-to-front', 'Bring to front', 'selection-up', 'one step'],
      ['selection-back', 'send-to-back', 'Send to back', 'selection-down', 'one step']]);
  const wholeFigure = registryFor({mode: 'animate', figure: true, joint: false});
  assert.equal(wholeFigure.get('selection-up').enabled, true, 'the shared command also accepts whole figures');
  assert.equal(wholeFigure.get('selection-down').enabled, true);
  assert.equal(wholeFigure.get('selection-front').enabled, true);
  assert.equal(wholeFigure.get('selection-back').enabled, true);
});

test('Build\'s part row carries words for Split and Duplicate, and Shift deletes the branch', () => {
  const resolved = row('part', {state: {mode: 'rig'}});
  assert.deepEqual(shape(resolved), [['word:Split', 'word:Duplicate'], ['glyph:Flip part horizontally', 'glyph:Flip part vertically'], ['glyph:Delete part']]);
  assert.deepEqual([resolved.items[4].shift, resolved.items[4].shiftHint], ['delete-segment', 'the branch']);
  assert.deepEqual(row('part', {state: {mode: 'animate'}}).items, [], 'Build\'s commands are hidden outside Build, so the row is empty');
});

test('the camera row: Level and Center · Reset; the frame range: Copy frames, Paste frames · Remove keys, Delete frames', () => {
  assert.deepEqual(shape(row('camera')), [['word:Level', 'word:Center'], ['glyph:Reset camera']]);
  const range = row('range');
  assert.deepEqual(shape(range), [['glyph:Copy frames', 'glyph:Paste frames'], ['word:Remove keys', 'glyph:Delete frames']]);
  assert.equal(range.items[2].label, 'Remove keyframes', 'the tooltip names the whole command');
  assert.equal(range.items[0].shortcut, 'Ctrl+C');
  assert.equal(quickLabel('range'), 'Frame actions');
});

test('a tooltip\'s keys carry what Shift does beside the shortcut', () => {
  const element = {dataset: {hotkeyHint: 'Delete', shiftHint: 'Shift: the branch'}};
  assert.equal(withShiftHint(element), 'Delete · Shift: the branch');
  assert.equal(withShiftHint(element, 'Del'), 'Del · Shift: the branch', 'the registry\'s shortcut, when the app passes it');
  assert.equal(withShiftHint({dataset: {shiftHint: 'Shift: one step'}}), 'Shift: one step');
  assert.equal(withShiftHint({dataset: {}}), '');
});

test('one pin takes the free slot; a second takes the last default\'s place, which stays in the menu', () => {
  let resolved = row('figure', {pins: ['reset-pose']});
  assert.equal(resolved.items.length, QUICK_LIMITS.slots);
  assert.deepEqual(resolved.groups.at(-1).map(item => [item.id, item.group, item.pinned]), [['reset-pose', PIN_GROUP, true]]);
  assert.deepEqual(resolved.displaced, []);

  resolved = row('figure', {pins: ['reset-pose', 'rotate']});
  assert.equal(resolved.items.length, QUICK_LIMITS.slots);
  assert.deepEqual(resolved.items.map(item => item.id), ['mirror', 'layer-front', 'layer-back', 'duplicate', 'reset-pose', 'rotate']);
  assert.deepEqual(resolved.displaced, ['delete']);

  resolved = row('figure', {pins: ['duplicate', 'no-such-command', 'split-segment', 'reset-pose', 'reset-pose']});
  assert.deepEqual(resolved.items.map(item => item.id), ['mirror', 'layer-front', 'layer-back', 'duplicate', 'delete', 'reset-pose'],
    'a pinned default, an unknown id, a command hidden in this workspace and a repeat are left out');

  resolved = row('figure', {pins: ['reset-pose', 'rotate', 'center', 'reset-color', 'select-same', 'join-figure', 'combine-figures']});
  assert.equal(resolved.items.length, QUICK_LIMITS.slots, 'never more than six buttons');
  assert.deepEqual(resolved.displaced, ['mirror', 'layer-front', 'layer-back', 'duplicate', 'delete']);
});

test('words where glyphs are ambiguous: a missing glyph and a repeated drawing become words', () => {
  const entries = [
    {id: 'a', quick: {context: 'x', group: 'one'}}, {id: 'b', quick: {context: 'x', group: 'one'}},
    {id: 'c', quick: {context: 'x', group: 'two'}}, {id: 'd', quick: {context: 'x', group: 'two', word: true}},
  ];
  const describe = id => ({a: {label: 'Copy', icon: 'duplicate'}, b: {label: 'Duplicate', icon: 'duplicate'}, c: {label: 'Mystery'},
    d: {label: 'Delete', icon: 'trash'}})[id];
  const resolved = resolveQuickActions({entries, context: 'x', describe, contexts: {}});
  assert.deepEqual(resolved.items.map(item => [item.id, item.kind, item.word]),
    [['a', 'glyph', null], ['b', 'word', 'Duplicate'], ['c', 'word', 'Mystery'], ['d', 'word', 'Delete']]);
  assert.deepEqual(resolved.problems, ['x: a and b share the glyph duplicate']);
});

test('glyphs are compared by what they draw: two names for one drawing are one glyph', () => {
  const entries = [{id: 'reset-pose', quick: {context: 'x', group: 'g'}}, {id: 'rotate', quick: {context: 'x', group: 'g'}}];
  const describe = id => ({'reset-pose': {label: 'Reset pose', icon: 'reset'}, rotate: {label: 'Rotate 15°', icon: 'rotate'}})[id];
  assert.deepEqual(resolveQuickActions({entries, context: 'x', describe, contexts: {}}).items.map(item => item.kind), ['glyph', 'glyph'], 'by name they differ');
  const same = resolveQuickActions({entries, context: 'x', describe, contexts: {}, drawing: () => '<svg>one drawing</svg>'});
  assert.deepEqual(same.items.map(item => [item.kind, item.word]), [['glyph', null], ['word', 'Rotate 15°']]);
  assert.deepEqual(same.problems, ['x: reset-pose and rotate share the glyph rotate']);
});

test('hidden defaults leave no gap, over-budget defaults stay in the menu, and group order follows the context', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => ({id, quick: {context: 'x', group: index % 2 ? 'odd' : 'even', word: true}}));
  const describe = id => ({label: id.toUpperCase(), hidden: id === 'a'});
  const resolved = resolveQuickActions({entries, context: 'x', describe, contexts: {x: {groups: ['odd', 'even']}}});
  assert.deepEqual(resolved.items.map(item => item.id), ['b', 'd', 'f', 'c', 'e'], 'odd first, as the context orders its groups; A is hidden');
  assert.deepEqual(resolved.overflow, ['g']);
  assert.match(resolved.problems[0], /more than 5 quick actions; g stay in the menu/);
  const four = resolveQuickActions({context: 'y', describe: () => ({label: 'L', icon: 'i'}), contexts: {},
    entries: ['p', 'q', 'r', 's'].map(id => ({id, quick: {context: 'y', group: id, word: true}}))});
  assert.match(four.problems[0], /4 groups; at most 3/);
});

test('placements, defaults and order within a group', () => {
  assert.deepEqual(quickPlacements({id: 'a'}), []);
  assert.deepEqual(quickPlacements({id: 'a', quick: {context: 'x'}}), [{context: 'x'}]);
  assert.deepEqual(quickPlacements({id: 'a', quick: [{context: 'x'}, null, {group: 'no context'}]}), [{context: 'x'}]);
  const entries = [{id: 'late', quick: {context: 'x', group: 'g', order: 2}}, {id: 'early', quick: {context: 'x', group: 'g', order: 1}}];
  assert.deepEqual(quickDefaults(entries, 'x', {contexts: {}}).map(item => item.id), ['early', 'late']);
});

test('pins are stored per context, newest last, without repeats, and a context with none is dropped', () => {
  const start = Object.freeze({figure: Object.freeze(['rotate'])});
  const pinned = pinQuickAction(start, 'figure', 'reset-pose');
  assert.deepEqual(pinned, {figure: ['rotate', 'reset-pose']});
  assert.deepEqual(start, {figure: ['rotate']}, 'the stored value is never changed in place');
  assert.deepEqual(pinQuickAction(pinned, 'figure', 'rotate'), {figure: ['reset-pose', 'rotate']}, 'pinning again moves it last');
  assert.deepEqual(pinQuickAction({}, 'joint', 'reset-pose', {max: 1}), {joint: ['reset-pose']});
  assert.deepEqual(pinQuickAction({joint: ['a', 'b']}, 'joint', 'c', {max: 2}), {joint: ['b', 'c']}, 'the oldest pin goes first');
  assert.deepEqual(unpinQuickAction(pinned, 'figure', 'rotate'), {figure: ['reset-pose']});
  assert.deepEqual(unpinQuickAction({figure: ['rotate'], joint: ['x']}, 'figure', 'rotate'), {joint: ['x']});
});

test('words, tile labels and row names translate through t, with English fallbacks', () => {
  // Like the app's localization.t: it fills {params} itself and returns the key when it has no text.
  const italian = {'quick.front': 'In primo piano', 'quick.figure': 'Azioni figura', 'quick.shift': 'Maiusc: {action}'};
  const t = (key, params = {}) => (italian[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token);
  const resolved = resolveQuickActions({context: 'figure', t, describe: describeWith(registryFor())});
  assert.equal(resolved.items[1].word, 'In primo piano');
  assert.equal(resolved.items[2].word, 'Back');
  assert.equal(quickLabel('figure', {t}), 'Azioni figura');
  assert.equal(quickLabel('joint'), 'Joint actions');
  assert.equal(quickLabel('nowhere'), 'Actions');
  assert.equal(quickText(t, 'quick.shift', null, {action: 'un passo'}), 'Maiusc: un passo');
  assert.equal(quickText(null, 'quick.shift', null, {action: 'one step'}), 'Shift: one step');
});
