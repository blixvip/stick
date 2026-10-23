import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseChangelog, prepareReleaseNotes, checkReleaseNotes, releaseOutputs } from '../scripts/changelog.mjs';

const history = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Pending fix.\n\n## [0.10.0]\n\nCurrent release\n\n### Added\n\n- New feature.\n\n## [0.9.0]\n\nPrevious release\n\n### Fixed\n\n- Old fix.\n';

test('accepts numeric descending versions and an empty Unreleased section', () => {
  assert.equal(parseChangelog(history)[1].version, '0.10.0');
  assert.equal(parseChangelog(history.replace('### Fixed\n\n- Pending fix.\n\n', ''))[0].groups.length, 0);
});

for (const [name, source] of [
  ['duplicate versions', history.replace('0.9.0', '0.10.0')],
  ['ascending versions', history.replace('0.9.0', '0.11.0')],
  ['duplicate entries across releases', history.replace('Old fix.', 'NEW feature!')],
  ['duplicate entries within a category', history.replace('- New feature.', '- New feature.\n- new FEATURE!')],
  ['duplicate categories', history.replace('- New feature.', '- New feature.\n\n### Added\n\n- Another feature.')],
  ['unordered categories', history.replace('### Added\n\n- New feature.', '### Fixed\n\n- New feature.\n\n### Added\n\n- Another feature.')],
  ['unknown category', history.replace('### Added', '### Improvements')],
  ['empty category', history.replace('- New feature.', '')],
  ['missing release title', history.replace('Current release\n', '')],
  ['invalid version', history.replace('0.10.0', 'v0.10.0')],
  ['missing Unreleased', history.replace('## [Unreleased]', '## [1.0.0]')],
  ['malformed heading', history.replace('## [0.10.0]', '## 0.10.0')],
]) test(`rejects ${name}`, () => assert.throws(() => parseChangelog(source)));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-changelog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'desktop'));
  await writeFile(path.join(directory, 'CHANGELOG.md'), history);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.10.0' }));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.10.0', packages: { '': { version: '0.10.0' } } }));
  return directory;
}

test('generates only the newest release, is idempotent, and catches partial/stale outputs', async t => {
  const directory = await fixture(t);
  await prepareReleaseNotes(directory, { env: {} });
  const notes = await readFile(path.join(directory, 'release-notes.md'), 'utf8');
  assert.match(notes, /New feature/);
  assert.doesNotMatch(notes, /Pending fix|Old fix/);
  const info = JSON.parse(await readFile(path.join(directory, 'desktop/release-info.json'), 'utf8'));
  assert.deepEqual(info, { version: '0.10.0', title: 'Current release', notes: ['New feature.'], groups: [{name:'Added',notes:['New feature.']}] });
  await prepareReleaseNotes(directory, { env: {} });
  assert.equal(await readFile(path.join(directory, 'release-notes.md'), 'utf8'), notes);
  await checkReleaseNotes(directory, { env: {} });
  await writeFile(path.join(directory, 'desktop/release-info.json'), '{}');
  await assert.rejects(checkReleaseNotes(directory, { env: {} }), /stale/);
  await prepareReleaseNotes(directory, { env: {} });
  await writeFile(path.join(directory, 'release-notes.md'), 'Old output');
  await assert.rejects(checkReleaseNotes(directory, { env: {} }), /stale/);
  await prepareReleaseNotes(directory, { env: {} });
  assert.ok(!(await readdir(directory)).some(file => file.endsWith('.tmp')));
  assert.ok(!(await readdir(path.join(directory, 'desktop'))).some(file => file.endsWith('.tmp')));
});

test('invalid history cannot overwrite saved notes', async t => {
  const directory = await fixture(t);
  await prepareReleaseNotes(directory, { env: {} });
  const before = await readFile(path.join(directory, 'release-notes.md'), 'utf8');
  await writeFile(path.join(directory, 'CHANGELOG.md'), history.replace('Old fix.', 'New feature.'));
  await assert.rejects(prepareReleaseNotes(directory, { env: {} }), /Duplicate/);
  assert.equal(await readFile(path.join(directory, 'release-notes.md'), 'utf8'), before);
});

test('requires matching package and both lockfile versions', async t => {
  const directory = await fixture(t);
  for (const lock of [
    { version: '0.9.0', packages: { '': { version: '0.10.0' } } },
    { version: '0.10.0', packages: { '': { version: '0.9.0' } } },
  ]) {
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    await assert.rejects(prepareReleaseNotes(directory, { env: {} }), /version must match/);
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.11.0' }));
  await assert.rejects(prepareReleaseNotes(directory, { env: {} }), /Newest changelog version/);
});

test('enforces the release tag without depending on the CI test process tag', async t => {
  const directory = await fixture(t);
  await releaseOutputs(directory, { env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.10.0' } });
  await assert.rejects(releaseOutputs(directory, { env: { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.9.0' } }), /Release tag must match/);
});

test('rolling pending changes into a new version preserves history and exports only that version', async t => {
  const directory = await fixture(t);
  const next = history.replace('## [Unreleased]\n\n### Fixed', '## [Unreleased]\n\n## [0.11.0]\n\nNext release\n\n### Fixed');
  assert.ok(next.endsWith(history.slice(history.indexOf('## [0.10.0]'))));
  await writeFile(path.join(directory, 'CHANGELOG.md'), next);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.11.0' }));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.11.0', packages: { '': { version: '0.11.0' } } }));
  await prepareReleaseNotes(directory, { env: {} });
  const info = JSON.parse(await readFile(path.join(directory, 'desktop/release-info.json'), 'utf8'));
  assert.deepEqual(info, { version: '0.11.0', title: 'Next release', notes: ['Pending fix.'], groups: [{name:'Fixed',notes:['Pending fix.']}] });
});

