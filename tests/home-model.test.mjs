/**
 * What Home lists and in which order (src/home/home-model.mjs, docs/HOME.md), Home's settings
 * (src/settings.mjs) and the canvases its Start tiles open (src/startup-document.mjs).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ALL_PROJECTS, PINNED_PROJECTS, folderScope, sameScope, projectOrigin, matchesQuery, orderProjects, visibleProjects,
  projectScopes, validScope, relativeTime, playSeconds, fileSize, tutorialProgress} from '../src/home/home-model.mjs';
import {DEFAULT_EDITOR_SETTINGS, normalizeEditorSettings} from '../src/settings.mjs';
import {STARTUP_CANVASES, createStartupDocument} from '../src/startup-document.mjs';

const project = (name, fields = {}) => ({id: name.toLowerCase().replace(/\W+/g, '-'), name, folder: '', pinned: false, openedAt: 0, modifiedAt: 0, ...fields});
const names = list => list.map(item => item.name);

test('a project is the app\'s own, Pivot or Stick Nodes by its extension', () => {
  assert.equal(projectOrigin('styk'), 'styk');
  assert.equal(projectOrigin('PIV'), 'pivot');
  assert.equal(projectOrigin('stknds'), 'sticknodes');
  assert.equal(projectOrigin('json'), 'styk');
});

test('search matches every word in the name or the folder, whatever the case or accents', () => {
  const duel = project('Duel sur le toit', {folder: 'Clients'});
  assert.ok(matchesQuery(duel, ''));
  assert.ok(matchesQuery(duel, '  TOIT  duel '));
  assert.ok(matchesQuery(duel, 'clients duel'));
  assert.ok(matchesQuery(project('Café scène'), 'cafe SCENE'));
  assert.equal(matchesQuery(duel, 'duel walk'), false);
});

test('pinned projects lead, then the chosen order; ties fall back to the name', () => {
  const projects = [
    project('Bravo', {openedAt: 30, modifiedAt: 1}),
    project('alpha', {openedAt: 10, modifiedAt: 3}),
    project('Charlie', {openedAt: 20, modifiedAt: 2, pinned: true}),
    project('Delta', {openedAt: 30, modifiedAt: null}),
  ];
  assert.deepEqual(names(orderProjects(projects, 'recent')), ['Charlie', 'Bravo', 'Delta', 'alpha']);
  assert.deepEqual(names(orderProjects(projects, 'name')), ['Charlie', 'alpha', 'Bravo', 'Delta']);
  assert.deepEqual(names(orderProjects(projects, 'modified')), ['Charlie', 'alpha', 'Bravo', 'Delta'], 'an unknown change time goes last');
  assert.deepEqual(names(projects), ['Bravo', 'alpha', 'Charlie', 'Delta'], 'the input is not reordered');
});

test('a scope, a search and an order make the visible list', () => {
  const projects = [project('Walk', {folder: 'Practice'}), project('Run', {folder: 'Practice', pinned: true}), project('Logo', {folder: 'Clients'})];
  assert.deepEqual(names(visibleProjects(projects, {scope: folderScope('Practice'), sort: 'name'})), ['Run', 'Walk']);
  assert.deepEqual(names(visibleProjects(projects, {scope: PINNED_PROJECTS})), ['Run']);
  assert.deepEqual(names(visibleProjects(projects, {scope: ALL_PROJECTS, query: 'lo', sort: 'name'})), ['Logo']);
});

test('the scopes count their projects; Pinned shows only when something is pinned', () => {
  const projects = [project('Walk', {folder: 'Practice'}), project('Logo')];
  assert.deepEqual(projectScopes(projects, ['Practice', 'Empty']).map(({scope, count}) => [scope.kind, scope.name, count]),
    [['all', undefined, 2], ['folder', 'Practice', 1], ['folder', 'Empty', 0]]);
  assert.equal(projectScopes([project('Run', {pinned: true})])[1].scope.kind, 'pinned');
  assert.ok(sameScope(folderScope('A'), folderScope('A')));
  assert.equal(sameScope(folderScope('A'), folderScope('B')), false);
  assert.ok(sameScope(ALL_PROJECTS, {kind: 'all'}));
});

test('a scope that no longer exists falls back to every project', () => {
  const projects = [project('Walk')];
  assert.equal(validScope(folderScope('Gone'), projects, ['Practice']), ALL_PROJECTS);
  assert.equal(validScope(PINNED_PROJECTS, projects, []), ALL_PROJECTS);
  const kept = folderScope('Practice');
  assert.equal(validScope(kept, projects, ['Practice']), kept);
});

test('times read as how long ago, in the largest whole unit', () => {
  const now = Date.UTC(2026, 9, 2, 12);
  assert.equal(relativeTime(now - 30000, now), null, 'under a minute is now');
  assert.equal(relativeTime(now + 60000, now), null, 'the future is now');
  assert.deepEqual(relativeTime(now - 5 * 60000, now), {value: -5, unit: 'minute'});
  assert.deepEqual(relativeTime(now - 3 * 3600000, now), {value: -3, unit: 'hour'});
  assert.deepEqual(relativeTime(now - 9 * 86400000, now), {value: -1, unit: 'week'});
  assert.deepEqual(relativeTime(now - 400 * 86400000, now), {value: -1, unit: 'year'});
  assert.equal(relativeTime(Number.NaN, now), null);
});

test('length and size read from the stored counts', () => {
  assert.equal(playSeconds({frames: 48, fps: 24}), 2);
  assert.equal(playSeconds({frames: 48, fps: 0}), null);
  assert.equal(playSeconds(null), null);
  assert.deepEqual(fileSize(300), {value: 1, unit: 'kilobyte'});
  assert.deepEqual(fileSize(200 * 1024), {value: 200, unit: 'kilobyte'});
  assert.deepEqual(fileSize(3.46 * 1024 * 1024), {value: 3.5, unit: 'megabyte'});
  assert.equal(fileSize(-1), null);
});

test('tutorial progress counts what is done and names the first one left', () => {
  const tutorials = [{id: 'tour'}, {id: 'canvas'}, {id: 'posing'}];
  const progress = tutorialProgress(tutorials, ['canvas', 'unknown']);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.next.id, 'tour');
  assert.deepEqual(progress.items.map(item => item.done), [false, true, false]);
  assert.equal(tutorialProgress(tutorials, ['tour', 'canvas', 'posing']).next, null);
});

test('Home\'s settings keep only known values', () => {
  assert.equal(DEFAULT_EDITOR_SETTINGS.showHomeOnStartup, true);
  const kept = normalizeEditorSettings({showHomeOnStartup: false, homeLayout: 'list', homeSort: 'name', tutorialsDone: ['tour', 'tour', 'Bad id', 7, 'posing']});
  assert.equal(kept.showHomeOnStartup, false);
  assert.equal(kept.homeLayout, 'list');
  assert.equal(kept.homeSort, 'name');
  assert.deepEqual(kept.tutorialsDone, ['tour', 'posing']);
  assert.ok(Object.isFrozen(kept.tutorialsDone));
  const reset = normalizeEditorSettings({showHomeOnStartup: 'no', homeLayout: 'cards', homeSort: 'size', tutorialsDone: 'tour'});
  assert.deepEqual([reset.showHomeOnStartup, reset.homeLayout, reset.homeSort, reset.tutorialsDone], [true, 'grid', 'recent', []]);
  assert.equal(normalizeEditorSettings({tutorialsDone: Array.from({length: 100}, (_, index) => `t${index}`)}).tutorialsDone.length, 64);
});

test('Start\'s canvases keep Blue where it stands, its hand and foot controls with it', () => {
  const landscape = createStartupDocument();
  const base = landscape.keyframes[0].objects[0];
  for (const [shape, canvas] of Object.entries(STARTUP_CANVASES)) {
    const report = createStartupDocument({canvas});
    const blue = report.keyframes[0].objects[0];
    assert.deepEqual([report.canvas_width, report.canvas_height], [canvas.width, canvas.height], shape);
    assert.equal(blue.root_x, Math.round(base.root_x / landscape.canvas_width * canvas.width), shape);
    assert.equal(blue.root_y, Math.round(base.root_y / landscape.canvas_height * canvas.height), shape);
    for (const [name, control] of Object.entries(blue._stykIK ?? {})) {
      if (!control.target) continue;
      const before = base._stykIK[name].target;
      assert.equal(control.target.x - blue.root_x, before.x - base.root_x, `${shape} ${name}`);
      assert.equal(control.target.y - blue.root_y, before.y - base.root_y, `${shape} ${name}`);
    }
  }
  assert.throws(() => createStartupDocument({canvas: {width: 0, height: 10}}), RangeError);
});
