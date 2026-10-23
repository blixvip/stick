import assert from 'node:assert/strict';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const categories = ['Added', 'Changed', 'Fixed', 'Performance', 'Removed', 'Security'];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const compare = (a, b) => {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
};

export function parseChangelog(source) {
  const sections = [];
  let section, category;
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^## \[([^\]]+)\]$/.exec(line);
    if (heading) {
      const version = heading[1];
      assert.ok(version === 'Unreleased' || versionPattern.test(version), `Invalid version: ${version}`);
      assert.ok(!sections.some(item => item.version === version), `Duplicate version: ${version}`);
      section = { version, title: '', groups: [] };
      sections.push(section);
      category = undefined;
    } else if (!section) {
      assert.ok(!line.startsWith('##'), 'Use ## [Unreleased] and ## [x.y.z] headings.');
    } else if (line.startsWith('### ')) {
      const name = line.slice(4);
      const index = categories.indexOf(name);
      assert.ok(index >= 0, `Unknown category: ${name}`);
      assert.ok(!category || index > categories.indexOf(category.name), 'Categories must be unique and ordered.');
      category = { name, notes: [] };
      section.groups.push(category);
    } else if (line.startsWith('- ')) {
      assert.ok(category, 'Each entry needs a category.');
      const note = line.slice(2).trim();
      assert.ok(normalized(note), 'Empty changelog entry.');
      category.notes.push(note);
    } else {
      assert.ok(section.version !== 'Unreleased' && !section.title && !category && !line.startsWith('#'), 'Use one release title and single-line bullet entries.');
      section.title = line;
    }
  }
  assert.equal(sections[0]?.version, 'Unreleased', 'Keep exactly one Unreleased section first.');
  assert.ok(sections.length > 1, 'At least one versioned release is required.');
  const seen = new Set();
  for (const [index, item] of sections.entries()) {
    if (index > 1) assert.ok(compare(sections[index - 1].version, item.version) > 0, 'Versions must be ordered newest first.');
    if (index > 0) assert.ok(item.title && item.groups.length, `Release ${item.version} needs a title and notes.`);
    for (const group of item.groups) {
      assert.ok(group.notes.length, `Empty category: ${group.name}`);
      for (const note of group.notes) {
        const key = normalized(note);
        assert.ok(!seen.has(key), `Duplicate changelog entry: ${note}`);
        seen.add(key);
      }
    }
  }
  return sections;
}

export async function releaseOutputs(directory = root, { env = process.env } = {}) {
  const [source, metadata, lock] = await Promise.all([
    readFile(path.join(directory, 'CHANGELOG.md'), 'utf8'),
    readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'package-lock.json'), 'utf8').then(JSON.parse),
  ]);
  const release = parseChangelog(source)[1];
  assert.equal(release.version, metadata.version, 'Newest changelog version must match package.json.');
  assert.equal(lock.version, metadata.version, 'package-lock.json version must match package.json.');
  assert.equal(lock.packages?.['']?.version, metadata.version, 'Lockfile root package version must match package.json.');
  if (env.GITHUB_REF_TYPE === 'tag') assert.equal(env.GITHUB_REF_NAME, `v${metadata.version}`, 'Release tag must match package.json.');
  const info = { version: release.version, title: release.title, notes: release.groups.flatMap(group => group.notes), groups: release.groups };
  const markdown = `# StykAnimate ${info.version}\n\n${info.title}\n\n${info.groups.map(group => `### ${group.name}\n\n${group.notes.map(note => `- ${note}`).join('\n')}`).join('\n\n')}\n\nFree to create. Powered by your support.\n\nStykAnimate is completely free. If it helps bring your ideas to life, a donation helps keep development moving. [Support development on Ko-fi](https://ko-fi.com/Q5Q41WY7QC).\n\nInstall the **Setup** version for automatic updates. Portable copies require manual updates.\n`;
  return { 'desktop/release-info.json': JSON.stringify(info, null, 2) + '\n', 'release-notes.md': markdown };
}

export async function checkReleaseNotes(directory = root, options) {
  const outputs = await releaseOutputs(directory, options);
  for (const [file, expected] of Object.entries(outputs)) {
    const actual = await readFile(path.join(directory, file), 'utf8');
    assert.equal(actual.replace(/\r\n/g, '\n'), expected, `${file} is stale; run npm run release:prepare and commit both generated files.`);
  }
}

export async function prepareReleaseNotes(directory = root, options) {
  const outputs = await releaseOutputs(directory, options);
  for (const [file, content] of Object.entries(outputs)) {
    const destination = path.join(directory, file);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // Individual replacement is atomic; an interrupted pair is detected by the next check.
  await checkReleaseNotes(directory, options);
}
