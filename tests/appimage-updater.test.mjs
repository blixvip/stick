import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm, readdir, symlink, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { LinuxAppImageUpdater } = require('../desktop/appimage-updater.cjs');
const { UpdateService, updateAvailability } = require('../desktop/updates.cjs');
const linux = { skip: process.platform !== 'linux' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'styk-appimage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = path.join(directory, 'My StykAnimate-1.2.0.AppImage');
  const download = path.join(directory, 'StykAnimate-1.3.0.AppImage');
  await writeFile(original, 'old app', { mode: 0o755 });
  await writeFile(download, 'verified new app', { mode: 0o600 });
  const relaunches = [];
  const electronApp = new EventEmitter();
  let lockReleased = false;
  electronApp.releaseSingleInstanceLock = () => { lockReleased = true; };
  const updater = new LinuxAppImageUpdater({ appImage: original, adapter: { version: '1.2.0' },
    electronApp, spawn: (execPath, args, options) => {
      assert.equal(lockReleased, true);
      relaunches.push({ execPath, args, ...options });
      return { on() {}, unref() {} };
    } });
  updater.logger = null;
  updater.downloadedUpdateHelper = { file: download, downloadedFileInfo: {} };
  const service = new UpdateService({ updater, currentVersion: '1.2.0' });
  service.set({ status: 'ready', version: '1.3.0' });
  // Use the real BaseUpdater validation and our real filesystem installer, but
  // never quit the test runner. The packaged probe covers actual quit/relaunch.
  updater.quitAndInstall = (silent, relaunch) => updater.install(silent, relaunch);
  return { directory, original, download, updater, service, relaunches, electronApp };
}

test('Linux updates require a packaged, writable AppImage and writable parent', linux, async t => {
  const f = await fixture(t);
  const options = { packaged: true, platform: 'linux', appImage: f.original };
  assert.equal(updateAvailability(options), '');
  for (const overrides of [{ packaged: false }, { appImage: undefined }, { appImage: f.directory }, { appImage: f.original + '-missing' }]) {
    assert.ok(updateAvailability({ ...options, ...overrides }));
  }
  if (process.getuid() !== 0) {
    await chmod(f.original, 0o555);
    assert.match(updateAvailability(options), /writable/);
    await chmod(f.original, 0o755);
    await chmod(f.directory, 0o555);
    try { assert.match(updateAvailability(options), /writable/); }
    finally { await chmod(f.directory, 0o755); }
  }
});

test('a versioned AppImage and symlink launcher keep their path after installation', linux, async t => {
  const f = await fixture(t);
  const launcher = path.join(f.directory, 'launcher.AppImage');
  await symlink(f.original, launcher);
  f.updater.appImage = launcher;
  assert.equal(await f.service.restart(async () => {
    assert.equal(await readFile(f.original, 'utf8'), 'old app');
    return true;
  }), true);
  assert.equal(await readFile(launcher, 'utf8'), 'verified new app');
  assert.equal((await stat(f.original)).mode & 0o777, 0o755);
  assert.deepEqual(f.relaunches, [], 'Relaunch must wait until the old app quits.');
  f.electronApp.emit('quit');
  assert.equal(f.relaunches[0].execPath, f.original);
  assert.deepEqual(f.relaunches[0].args, process.argv.slice(1));
  assert.equal(f.relaunches[0].cwd, f.directory);
  assert.equal(f.relaunches[0].detached, true);
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.stykanimate-update-')), false);
  assert.equal(await readFile(f.download, 'utf8'), 'verified new app', 'The download cache remains available for retry.');
});

test('cancelled or failed save leaves the original app and removes the staged file', linux, async t => {
  for (const prepare of [async () => false, async () => { throw new Error('Save failed'); }]) {
    const f = await fixture(t);
    assert.equal(await f.service.restart(prepare), false);
    assert.equal(await readFile(f.original, 'utf8'), 'old app');
    assert.deepEqual(f.relaunches, []);
    assert.equal((await readdir(f.directory)).length, 2);
  }
});

test('failed staging preserves the original app, restores close protection, and permits retry', linux, async t => {
  const f = await fixture(t);
  f.updater.downloadedUpdateHelper.file += '-missing';
  let prepared = false, restored = false;
  assert.equal(await f.service.restart(async () => { prepared = true; return true; }, () => { restored = true; }), false);
  assert.equal(prepared, false);
  assert.equal(restored, true);
  assert.equal(await readFile(f.original, 'utf8'), 'old app');
  assert.deepEqual(f.relaunches, []);
  assert.equal((await readdir(f.directory)).length, 2);
  f.updater.downloadedUpdateHelper.file = f.download;
  f.service.set({ status: 'ready' });
  assert.equal(await f.service.restart(async () => true), true);
});

test('a missing staged file cannot unlink the installed app', linux, async t => {
  const f = await fixture(t);
  assert.equal(await f.service.restart(async () => {
    await rm(f.updater.stagedInstall.file);
    return true;
  }), false);
  assert.equal(await readFile(f.original, 'utf8'), 'old app');
  assert.deepEqual(f.relaunches, []);
});

test('a concurrently replaced AppImage is not overwritten', linux, async t => {
  const f = await fixture(t);
  assert.equal(await f.service.restart(async () => {
    const replacement = path.join(f.directory, 'another-install');
    await writeFile(replacement, 'separate update', { mode: 0o755 });
    await rename(replacement, f.original);
    return true;
  }), false);
  assert.equal(await readFile(f.original, 'utf8'), 'separate update');
  assert.deepEqual(f.relaunches, []);
});
