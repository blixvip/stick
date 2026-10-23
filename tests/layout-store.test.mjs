/**
 * Layout persistence (src/shell/layout-store.mjs): no writes on load,
 * debounced ordered saves, merge-on-write between windows, failures,
 * read-only newer layouts, the downgrade round trip with 1.1, the size
 * budget and the browser and desktop backends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_LAYOUT_KEY, LEGACY_LAYOUT_KEYS, createLayoutStore, desktopLayoutBackend, mergeLayouts, storageLayoutBackend,
} from '../src/shell/layout-store.mjs';
import {
  LAYOUT_FILE_LIMIT_BYTES, applyPreset, defaultLayout, deletePreset, layoutBytes, migrateLayout, movePanel,
  normalizeLayout, savePreset, serializeLayout, setSharedSize, toggleFocus,
} from '../src/shell/layout-schema.mjs';
import {PANEL_CATALOG, normalizePanelDescriptor} from '../src/shell/panel-registry.mjs';

const START = 1_700_000_000_000;

/** One preferences file shared by any number of windows; values cross it as the IPC clones them. */
function createDisk(initial = null) {
  const disk = {
    value: initial === null ? null : structuredClone(initial),
    reads: 0,
    writes: [],
    read: async () => { disk.reads++; return disk.value === null ? {} : structuredClone(disk.value); },
    write: async value => { disk.writes.push(structuredClone(value)); disk.value = structuredClone(value); },
  };
  return disk;
}

/** Manual timers and clock. */
function createClock() {
  const clock = {time: START, timers: new Map(), next: 1};
  clock.now = () => clock.time;
  clock.setTimer = (callback, delay) => { const id = clock.next++; clock.timers.set(id, {callback, due: clock.time + delay}); return id; };
  clock.clearTimer = id => { clock.timers.delete(id); };
  clock.advance = ms => {
    clock.time += ms;
    for (const [id, timer] of [...clock.timers]) if (timer.due <= clock.time) { clock.timers.delete(id); timer.callback(); }
  };
  return clock;
}

function openWindow(disk, clock = createClock(), options = {}) {
  const store = createLayoutStore({read: disk.read, write: disk.write, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options});
  return {store, clock};
}

const withLibraryLeft = layout => ({...layout, modes: {...layout.modes, animate: {...layout.modes.animate, ...movePanel(layout.modes.animate, 'library', 'left', {mode: 'animate'})}}});

test('loading migrates without writing, even when the window is too small for the layout', async () => {
  const disk = createDisk({studioVersion: 1, right: 330, timeline: 300});
  const {store} = openWindow(disk);
  const layout = await store.load();
  assert.equal(store.source, 'v1');
  assert.deepEqual(layout.shared.sizes, {right: 330, bottom: 300});
  assert.equal(Object.isFrozen(layout.shared.sizes), true, 'the store hands out frozen layouts');
  assert.equal(await store.flush(), true);
  assert.equal(disk.writes.length, 0);
  assert.equal(store.update(current => current), layout, 'an unchanged layout schedules nothing');
  await store.flush();
  assert.equal(disk.writes.length, 0);
});

test('updates are debounced into one ordered write that keeps the v1 mirror', async () => {
  const disk = createDisk();
  const {store, clock} = openWindow(disk);
  await store.load();
  store.update(layout => setSharedSize(layout, 'right', 300));
  clock.advance(100);
  store.update(layout => setSharedSize(layout, 'right', 310));
  clock.advance(100);
  store.update(layout => setSharedSize(layout, 'bottom', 260));
  assert.equal(disk.writes.length, 0);
  clock.advance(200);
  await store.flush();
  assert.equal(disk.writes.length, 1);
  const written = disk.writes[0];
  assert.deepEqual([written.studioVersion, written.right, written.timeline, written.layoutVersion], [1, 310, 260, 2]);
  assert.deepEqual(written.shared.sizes, {right: 310, bottom: 260});
  assert.ok(written.shared.stamp >= START, 'the changed section is stamped');
  assert.equal(written.modes.animate.stamp, 0, 'untouched workspaces keep their stamp');
  assert.deepEqual(written.modes.animate, {stamp: 0, preset: 'animate'});
});

test('stored is what this window last read or wrote, never a fitted or pending layout', async () => {
  const disk = createDisk({studioVersion: 1, right: 330, timeline: 300});
  const {store, clock} = openWindow(disk);
  assert.equal(store.stored, null, 'nothing before load');
  await store.load();
  assert.deepEqual(store.stored, {studioVersion: 1, right: 330, timeline: 300});
  store.update(layout => setSharedSize(layout, 'right', 310));
  assert.deepEqual(store.stored, {studioVersion: 1, right: 330, timeline: 300}, 'a pending change is not stored yet');
  clock.advance(200);
  await store.flush();
  assert.deepEqual(store.stored, disk.value);
  assert.equal(store.stored.right, 310);
  const copy = store.stored;
  copy.right = 1;
  assert.equal(store.stored.right, 310, 'callers get a copy');
});

test('flush writes pending changes at once and writes land in order', async () => {
  const pending = [];
  const disk = createDisk();
  const slowWrite = value => new Promise(resolve => pending.push(() => { disk.value = structuredClone(value); disk.writes.push(structuredClone(value)); resolve(); }));
  const clock = createClock();
  const store = createLayoutStore({read: disk.read, write: slowWrite, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  await store.load();
  store.update(layout => setSharedSize(layout, 'right', 300));
  const first = store.flush();
  await new Promise(setImmediate);
  assert.equal(pending.length, 1, 'the first write is in flight');
  store.update(layout => setSharedSize(layout, 'right', 320));
  const second = store.flush();
  await new Promise(setImmediate);
  assert.equal(pending.length, 1, 'the second write waits for the first');
  pending.shift()();
  assert.equal(await first, true);
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  pending.shift()();
  assert.equal(await second, true);
  assert.deepEqual(disk.writes.map(value => value.right), [300, 320]);
  assert.equal(store.layout.shared.sizes.right, 320);
});

test('two windows keep each other\'s saved layouts and deletions', async () => {
  const disk = createDisk();
  const a = openWindow(disk);
  const b = openWindow(disk);
  await a.store.load();
  await b.store.load();
  a.clock.time += 10;
  a.store.update(layout => savePreset(withLibraryLeft(layout), {name: 'Fight setup', mode: 'animate', now: a.clock.now()}).layout);
  await a.store.flush();
  b.clock.time += 20;
  b.store.update(layout => savePreset(layout, {name: 'Clean draw', mode: 'draw', now: b.clock.now()}).layout);
  await b.store.flush();
  assert.deepEqual(disk.value.saved.map(item => item.name), ['Fight setup', 'Clean draw']);
  assert.deepEqual(b.store.layout.saved.map(item => item.name), ['Fight setup', 'Clean draw'], 'the other window\'s layout arrives with the merge');
  assert.equal(disk.value.modes.animate.preset.startsWith('user:'), true, 'window A\'s arrangement is kept');
  // B deletes A's layout; A, which still has it, saves something else: it stays deleted.
  const fight = b.store.layout.saved.find(item => item.name === 'Fight setup');
  b.clock.time += 30;
  b.store.update(layout => deletePreset(layout, fight.id, {now: b.clock.now()}));
  await b.store.flush();
  a.clock.time += 40;
  a.store.update(layout => setSharedSize(layout, 'right', 333));
  await a.store.flush();
  assert.deepEqual(disk.value.saved.map(item => item.name), ['Clean draw']);
  assert.equal(disk.value.right, 333);
  assert.ok(disk.value.tombstones.some(item => item.id === fight.id));
  assert.deepEqual(a.store.layout.saved.map(item => item.name), ['Clean draw']);
});

test('the newest change to a workspace wins a merge; the other workspaces are kept', async () => {
  const disk = createDisk();
  const a = openWindow(disk);
  const b = openWindow(disk);
  await a.store.load();
  await b.store.load();
  a.clock.time += 5;
  a.store.update(layout => withLibraryLeft(layout));
  b.clock.time += 50;
  b.store.update(layout => applyPreset(layout, 'rig', 'build-timeline'));
  await a.store.flush();
  await b.store.flush();
  const {layout} = migrateLayout(disk.value);
  assert.equal(layout.modes.animate.panels.find(record => record.id === 'library').dock, 'left');
  assert.equal(layout.modes.rig.preset, 'build-timeline');
  // Pure merge: ties keep the local copy.
  const base = defaultLayout();
  const disk2 = normalizeLayout({...base, modes: {...base.modes, draw: {...base.modes.draw, stamp: 9, rail: 'right', panels: base.modes.draw.panels}}});
  const local = normalizeLayout({...base, modes: {...base.modes, draw: {...base.modes.draw, stamp: 9}}});
  assert.equal(mergeLayouts(disk2, local).modes.draw.rail, 'left');
  assert.equal(mergeLayouts(disk2, {...local, modes: {...local.modes, draw: {...local.modes.draw, stamp: 8}}}).modes.draw.rail, 'right');
});

test('a save never rearranges this window with another window\'s arrangement', async () => {
  const disk = createDisk();
  const a = openWindow(disk);
  const b = openWindow(disk);
  await a.store.load();
  await b.store.load();
  a.clock.time += 5;
  a.store.update(layout => withLibraryLeft(layout));
  await a.store.flush();
  const origins = [];
  b.store.on('change', event => origins.push(event.origin));
  b.clock.time += 10;
  b.store.update(layout => setSharedSize(layout, 'bottom', 300));
  await b.store.flush();
  assert.deepEqual(origins, ['local'], 'only B\'s own change');
  assert.equal(b.store.layout.modes.animate.panels.find(record => record.id === 'library').dock, 'right', 'B\'s Library stays where B has it');
  // The disk keeps the newest of each: A's arrangement and B's timeline height.
  const {layout} = migrateLayout(disk.value);
  assert.equal(layout.modes.animate.panels.find(record => record.id === 'library').dock, 'left');
  assert.equal(layout.shared.sizes.bottom, 300);
  // B's next arrangement change is newer and wins on disk.
  b.clock.time += 10;
  b.store.update(current => applyPreset(current, 'animate', 'timing', {workspaceHeight: 800}));
  await b.store.flush();
  assert.equal(migrateLayout(disk.value).layout.modes.animate.preset, 'timing');
});

test('updates made before load() resolves are applied to the loaded layout', async () => {
  const disk = createDisk({studioVersion: 1, right: 330});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const clock = createClock();
  const store = createLayoutStore({read: async () => { await gate; return disk.read(); }, write: disk.write, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  const loading = store.load();
  assert.equal(store.update(layout => setSharedSize(layout, 'bottom', 400)).shared.sizes.bottom, undefined, 'queued until the layout is known');
  release();
  const layout = await loading;
  assert.deepEqual(layout.shared.sizes, {right: 330, bottom: 400}, 'the loaded layout with the change');
  await store.flush();
  assert.deepEqual([disk.value.right, disk.value.timeline], [330, 400]);
});

test('a panel catalogue given as a function follows panels defined later', async () => {
  let catalog = PANEL_CATALOG;
  const disk = createDisk();
  const {store} = openWindow(disk, createClock(), {catalog: () => catalog});
  await store.load();
  catalog = [...PANEL_CATALOG, normalizePanelDescriptor({id: 'notes', docks: ['left'], min: 200, pref: 240, max: 300, defaultDock: 'strip'})];
  store.update(layout => setSharedSize(layout, 'right', 300));
  assert.deepEqual(store.layout.modes.animate.panels.find(record => record.id === 'notes'), {id: 'notes', dock: 'strip', side: 'left', order: 0});
  await store.flush();
  assert.deepEqual(Object.keys(disk.value.modes.animate), ['stamp', 'preset'], 'still the preset: the new panel waits at its default dock');
  assert.equal(store.layout.modes.animate.panels.find(record => record.id === 'notes').dock, 'strip');
});

test('a change on disk between the reads is merged again before writing', async () => {
  const disk = createDisk();
  const other = normalizeLayout(null);
  const theirs = serializeLayout(savePreset(other, {name: 'Theirs', mode: 'animate', now: START + 1}).layout);
  let reads = 0;
  const read = async () => {
    reads++;
    if (reads === 3) disk.value = structuredClone(theirs);   // another window wrote between our reads
    return disk.read();
  };
  const clock = createClock();
  const store = createLayoutStore({read, write: disk.write, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  await store.load();
  clock.time += 10;
  store.update(layout => savePreset(layout, {name: 'Mine', mode: 'draw', now: clock.now()}).layout);
  await store.flush();
  assert.equal(reads, 3, 'load, the merge read and the check before writing');
  assert.deepEqual(disk.value.saved.map(item => item.name).sort(), ['Mine', 'Theirs']);
});

test('a failed write is reported, keeps the change and is retried by the next flush', async () => {
  const disk = createDisk();
  let failing = true;
  const errors = [];
  const clock = createClock();
  const store = createLayoutStore({
    read: disk.read,
    write: async value => { if (failing) throw new Error('disk full'); return disk.write(value); },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onError: error => errors.push(error.message),
  });
  const events = [];
  store.on('error', ({error}) => events.push(error.message));
  await store.load();
  store.update(layout => setSharedSize(layout, 'right', 300));
  assert.equal(await store.flush(), false);
  assert.deepEqual(errors, ['disk full']);
  assert.deepEqual(events, ['disk full']);
  assert.equal(store.error.message, 'disk full');
  assert.equal(store.layout.shared.sizes.right, 300, 'the change stays in the session');
  failing = false;
  assert.equal(await store.flush(), true);
  assert.equal(disk.value.right, 300);
  assert.equal(store.error, null);
  // A failing read never writes blind.
  const blind = createLayoutStore({read: async () => { throw new Error('no access'); }, write: disk.write, onError: () => {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  await blind.load();
  assert.equal(blind.source, 'error');
  blind.update(layout => setSharedSize(layout, 'right', 360));
  assert.equal(await blind.flush(), false);
  assert.equal(disk.value.right, 300);
});

test('a layout from a newer version is never overwritten', async () => {
  const future = {layoutVersion: 3, studioVersion: 1, right: 300, modes: {animate: {new: true}}};
  const disk = createDisk(future);
  const {store, clock} = openWindow(disk);
  const events = [];
  store.on('readonly', event => events.push(event.source));
  await store.load();
  assert.equal(store.readOnly, true);
  assert.equal(store.source, 'future');
  assert.deepEqual(events, ['future']);
  store.update(layout => setSharedSize(layout, 'right', 340));
  assert.equal(store.layout.shared.sizes.right, 340, 'changes apply for this session');
  clock.advance(1000);
  assert.equal(await store.flush(), true);
  assert.equal(disk.writes.length, 0);
  assert.deepEqual(disk.value, future);
  // A newer version appearing on disk while a save is pending also stops the write.
  const later = createDisk();
  const window = openWindow(later);
  await window.store.load();
  window.store.update(layout => setSharedSize(layout, 'right', 300));
  later.value = future;
  await window.store.flush();
  assert.equal(later.writes.length, 0);
  assert.equal(window.store.readOnly, true);
});

test('1.1 reading and writing the file between sessions keeps every v2 key', async () => {
  const disk = createDisk();
  const first = openWindow(disk);
  await first.store.load();
  first.clock.time += 10;
  first.store.update(layout => savePreset(withLibraryLeft(setSharedSize(layout, 'bottom', 260)), {name: 'Fight setup', mode: 'animate', now: first.clock.now()}).layout);
  await first.store.flush();
  const v2 = structuredClone(disk.value);
  // 1.1: const preferences = {...loaded}; the user drags the inspector; persist() writes {...preferences, studioVersion: 1}.
  disk.value = {...v2, right: 344, studioVersion: 1};
  const second = openWindow(disk);
  const layout = await second.store.load();
  assert.equal(second.store.source, 'v2');
  assert.equal(layout.shared.sizes.right, 344);
  assert.equal(layout.shared.sizes.bottom, 260);
  assert.equal(layout.modes.animate.panels.find(record => record.id === 'library').dock, 'left');
  assert.deepEqual(layout.saved.map(item => item.name), ['Fight setup']);
  second.clock.time += 1000;
  second.store.update(current => setSharedSize(current, 'left', 300));
  await second.store.flush();
  assert.deepEqual([disk.value.right, disk.value.timeline, disk.value.shared.sizes.left], [344, 260, 300]);
  assert.deepEqual(disk.value.saved.map(item => item.name), ['Fight setup']);
});

test('unknown keys on disk survive a save, and the file stays under its limit', async () => {
  const disk = createDisk({layoutVersion: 2, studioVersion: 1, fromNewerApp: {rows: [1, 2, 3]}, bulk: 'z'.repeat(LAYOUT_FILE_LIMIT_BYTES)});
  const {store} = openWindow(disk);
  const trims = [];
  store.on('trim', event => trims.push(...event.trimmed));
  await store.load();
  store.update(layout => setSharedSize(layout, 'right', 300));
  assert.equal(await store.flush(), true);
  assert.deepEqual(disk.value.fromNewerApp, {rows: [1, 2, 3]});
  assert.equal('bulk' in disk.value, false);
  assert.deepEqual(trims, ['key:bulk']);
  assert.ok(layoutBytes(disk.value) <= LAYOUT_FILE_LIMIT_BYTES);
  // What went is gone from the window too: the next save trims nothing.
  assert.equal('bulk' in store.layout, false);
  store.update(layout => setSharedSize(layout, 'right', 310));
  await store.flush();
  assert.deepEqual(trims, ['key:bulk']);
});

test('large unknown data inside a workspace is trimmed once and saving goes on', async () => {
  const disk = createDisk({layoutVersion: 2, studioVersion: 1, modes: {animate: {stamp: 1, preset: 'animate', blob: 'z'.repeat(17 * 1024)}}});
  const {store, clock} = openWindow(disk);
  const trims = [];
  store.on('trim', event => trims.push(event.trimmed));
  await store.load();
  store.update(layout => setSharedSize(layout, 'right', 300));
  assert.equal(await store.flush(), true);
  assert.equal(disk.value.right, 300);
  assert.equal('blob' in disk.value.modes.animate, false);
  assert.equal('blob' in store.layout.modes.animate, false);
  clock.time += 10;
  store.update(layout => setSharedSize(layout, 'right', 320));
  assert.equal(await store.flush(), true);
  assert.equal(disk.value.right, 320);
  assert.deepEqual(trims, [['key:modes.animate.blob']], 'one message, one save');
});

test('saved layouts and Focus the file cannot hold leave the window as well', async () => {
  const disk = createDisk();
  const {store, clock} = openWindow(disk);
  const trims = [];
  store.on('trim', event => trims.push(...event.trimmed));
  await store.load();
  clock.time += 1;
  store.update(layout => toggleFocus(savePreset(layout, {name: 'Old', mode: 'draw', now: clock.now()}).layout, 'animate'));
  await store.flush();
  const {id} = store.layout.saved[0];
  // A newer version leaves 15,400 bytes it needs: only without Focus and the saved layout does the file fit.
  disk.value = {...disk.value, fromNewer: 'q'.repeat(15_400)};
  clock.time += 1;
  store.update(layout => setSharedSize(layout, 'right', 300));
  assert.equal(await store.flush(), true);
  assert.deepEqual(trims, ['focus', `saved:${id}`]);
  assert.deepEqual([store.layout.saved.length, store.layout.modes.animate.focus], [0, null]);
  assert.equal(disk.value.fromNewer.length, 15_400);
  clock.time += 1;
  store.update(layout => setSharedSize(layout, 'right', 310));
  await store.flush();
  assert.equal(trims.length, 2, 'nothing comes back to be trimmed again');
});

test('a saved layout that two windows push past eight is reported', async () => {
  const disk = createDisk();
  const a = openWindow(disk);
  const b = openWindow(disk);
  await a.store.load();
  await b.store.load();
  a.clock.time += 1;
  a.store.update(layout => {
    for (let index = 0; index < 5; index++) layout = savePreset(layout, {name: `A${index}`, mode: 'animate', now: a.clock.now() + index}).layout;
    return layout;
  });
  await a.store.flush();
  const trims = [];
  b.store.on('trim', event => trims.push(...event.trimmed));
  b.clock.time += 100;
  b.store.update(layout => {
    for (let index = 0; index < 4; index++) layout = savePreset(layout, {name: `B${index}`, mode: 'draw', now: b.clock.now() + index}).layout;
    return layout;
  });
  await b.store.flush();
  assert.equal(disk.value.saved.length, 8);
  const oldest = a.store.layout.saved.reduce((x, y) => (y.stamp < x.stamp ? y : x));
  assert.deepEqual(trims, [`saved:${oldest.id}`]);
  assert.ok(!disk.value.saved.some(item => item.id === oldest.id));
});

test('stamps mark only what changed, and a deleted layout gets a tombstone', async () => {
  const disk = createDisk();
  const {store, clock} = openWindow(disk);
  await store.load();
  clock.time += 1;
  store.update(layout => savePreset(layout, {name: 'One', mode: 'animate', now: 5}).layout);
  const saved = store.layout;
  assert.deepEqual([saved.saved[0].stamp, saved.modes.animate.stamp].sort(), [START + 1, START + 2], 'the store stamps with its own clock, never twice alike');
  assert.equal(saved.modes.draw.stamp, 0);
  assert.equal(saved.shared.stamp, 0);
  clock.time += 1;
  store.update(layout => ({...layout, saved: []}));
  assert.deepEqual(store.layout.tombstones, [{id: saved.saved[0].id, stamp: START + 3}]);
  const destroyed = store.destroy();
  assert.equal(await destroyed, true);
  assert.equal(disk.writes.length, 1);
  assert.equal(store.update(layout => setSharedSize(layout, 'right', 300)), store.layout, 'a destroyed store ignores updates');
});

test('the browser backend uses localStorage and reads the older keys once', async () => {
  const items = new Map();
  const storage = {getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value))};
  const backend = storageLayoutBackend(storage);
  assert.equal(await backend.read(), null);
  items.set(LEGACY_LAYOUT_KEYS[1], JSON.stringify({left: 300, right: 280}));
  assert.deepEqual(await backend.read(), {left: 300, right: 280});
  items.set(LEGACY_LAYOUT_KEYS[0], JSON.stringify({studioVersion: 1, right: 330}));
  assert.deepEqual(await backend.read(), {studioVersion: 1, right: 330});
  const store = createLayoutStore({...backend, setTimer: () => 0, clearTimer: () => {}});
  await store.load();
  assert.equal(store.source, 'v1');
  store.update(layout => setSharedSize(layout, 'right', 350));
  await store.flush();
  assert.equal(JSON.parse(items.get(BROWSER_LAYOUT_KEY)).right, 350);
  assert.equal(items.get(LEGACY_LAYOUT_KEYS[0]), JSON.stringify({studioVersion: 1, right: 330}), 'older keys are left alone');
  assert.equal((await backend.read()).layoutVersion, 2);
  items.set(BROWSER_LAYOUT_KEY, '{broken');
  assert.equal(migrateLayout(await backend.read()).source, 'invalid');
  const blocked = storageLayoutBackend({getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }});
  assert.equal(await blocked.read(), null);
  await assert.rejects(blocked.write({}), /SecurityError/);
  await assert.rejects(storageLayoutBackend(null).write({}), /unavailable/);
});

test('the desktop backend is the workspace preferences IPC', async () => {
  const calls = [];
  const desktop = {
    getWorkspacePreferences: async () => { calls.push('get'); return {studioVersion: 1, right: 300}; },
    setWorkspacePreferences: async value => { calls.push(['set', value.right]); return {saved: true}; },
  };
  const store = createLayoutStore({...desktopLayoutBackend(desktop), setTimer: () => 0, clearTimer: () => {}});
  await store.load();
  store.update(layout => setSharedSize(layout, 'right', 320));
  await store.flush();
  assert.deepEqual(calls, ['get', 'get', 'get', ['set', 320]]);
  assert.throws(() => createLayoutStore({}), TypeError);
});
