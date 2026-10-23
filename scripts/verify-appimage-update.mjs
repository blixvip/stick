// Two real AppImages, isolated from the user's app, profile and update cache.
// Exercises the production updater with a bad checksum, retry, Cancel, ordinary
// quit, atomic replacement, the single-instance lock, and automatic relaunch.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, cp, stat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
if (process.platform !== 'linux') throw new Error('The AppImage probe requires Linux.');
const root = process.cwd(), id = Date.now().toString(36);
const output = path.join(root, 'artifacts', 'updates');
const probe = path.join(output, `appimage-probe-${id}`);
const fixture = path.join(probe, 'app'), target = path.join(probe, 'target');
const installed = path.join(probe, 'Installed app', 'StykAnimate-0.0.1.AppImage');
await mkdir(fixture, { recursive: true });
await mkdir(path.dirname(installed));
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const requests = [];
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
  if (!/^(latest-linux\.yml|update-test-0\.0\.2\.AppImage)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    requests.push(name);
    const file = path.join(target, name);
    if (name.endsWith('.yml')) {
      let yaml = await readFile(file, 'utf8');
      const rejected = await stat(path.join(probe, 'checksum-rejected')).then(() => true, () => false);
      if (!rejected) yaml = yaml.replace(/sha512: .+/g, `sha512: ${Buffer.alloc(64).toString('base64')}`);
      response.writeHead(200, { 'Content-Type': 'text/yaml' }).end(yaml);
    } else {
      response.writeHead(200, { 'Content-Length': (await stat(file)).size, 'Content-Type': 'application/octet-stream' });
      createReadStream(file).pipe(response);
    }
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'pipe', timeout: 180000, ...options });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${file} exited ${code ?? signal}: ${output}`)));
  });
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
try {
  // Install the repository's locked production dependency graph, then give the
  // fixture its own identity. Never resolve a fresh set of updater dependencies.
  for (const file of ['package.json', 'package-lock.json']) await copyFile(file, path.join(fixture, file));
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: fixture });
  // Mirror the packaged layout: desktop modules load their messages from ../src.
  await mkdir(path.join(fixture, 'desktop'));
  for (const file of ['updates.cjs', 'appimage-updater.cjs', 'localization.cjs']) await copyFile(path.join(root, 'desktop', file), path.join(fixture, 'desktop', file));
  for (const file of ['localization.mjs', 'localized-error.mjs', 'validation-labels.mjs', 'message-error-core.mjs']) await cp(path.join(root, 'src', file), path.join(fixture, 'src', file));
  await cp(path.join(root, 'src', 'locales'), path.join(fixture, 'src', 'locales'), { recursive: true, filter: file => !path.extname(file) || file.endsWith('.mjs') });
  await writeFile(path.join(fixture, 'probe.json'), JSON.stringify({ root: probe, installed }));
  await writeFile(path.join(fixture, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const config = require('./probe.json');
app.setPath('userData', path.join(config.root, 'profile'));
if (!app.requestSingleInstanceLock()) app.exit(2);
app.whenReady().then(async () => {
  const version = app.getVersion();
  const file = name => path.join(config.root, name);
  fs.appendFileSync(file('launches.jsonl'), JSON.stringify({ version, appImage: process.env.APPIMAGE }) + '\\n');
  if (version === '0.0.2') {
    assert.equal(fs.readFileSync(path.join(app.getPath('userData'), 'preserved.txt'), 'utf8'), 'saved before restart');
    fs.writeFileSync(file('updated.json'), JSON.stringify({ version, appImage: process.env.APPIMAGE, profilePreserved: true }));
    app.quit(); return;
  }
  const { UpdateService, updateAvailability } = require('./desktop/updates.cjs');
  assert.equal(updateAvailability({ packaged: app.isPackaged, platform: process.platform, appImage: process.env.APPIMAGE }), '');
  const { LinuxAppImageUpdater } = require('./desktop/appimage-updater.cjs');
  const updater = new LinuxAppImageUpdater();
  updater.disableDifferentialDownload = true;
  const service = new UpdateService({ updater, currentVersion: version, onState: state => {
    fs.appendFileSync(file('states.jsonl'), JSON.stringify(state) + '\\n');
  }});
  if (!fs.existsSync(file('checksum-rejected'))) {
    await service.check();
    assert.equal(service.snapshot().status, 'error');
    assert.equal(await service.restart(async () => true), false);
    fs.writeFileSync(file('checksum-rejected'), 'true');
  }
  await service.check();
  assert.equal(service.snapshot().status, 'ready');
  if (!fs.existsSync(file('normal-quit'))) {
    assert.equal(await service.restart(async () => false), false);
    assert.equal(service.snapshot().status, 'ready');
    fs.writeFileSync(file('normal-quit'), 'true');
    app.quit(); return;
  }
  assert.equal(await service.restart(async () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'preserved.txt'), 'saved before restart');
    return true;
  }), true);
}).catch(error => { fs.writeFileSync(path.join(config.root, 'error.txt'), error.stack); app.exit(1); });
`);
  const fixtureMetadata = { name: `styk-appimage-probe-${id}`, productName: 'StykAnimate Update Probe', version: '0.0.1',
    main: 'main.cjs', description: 'Isolated Linux updater verification', author: 'StykAnimate', dependencies: metadata.dependencies };
  for (const version of ['0.0.1', '0.0.2']) {
    fixtureMetadata.version = version;
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify(fixtureMetadata));
    await build({ projectDir: fixture, targets: Platform.LINUX.createTarget(['AppImage'], Arch.x64), publish: 'never', config: {
      appId: `app.stykanimate.update-probe.${id}`, productName: fixtureMetadata.productName,
      electronVersion: metadata.devDependencies.electron, electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
      toolsets: metadata.build.toolsets,
      directories: { app: fixture, output: version === '0.0.1' ? path.join(probe, 'baseline') : target },
      files: ['main.cjs', 'desktop/**/*', 'src/**/*', 'probe.json', 'package.json'],
      publish: [{ provider: 'generic', url }],
      linux: { executableName: 'styk-update-probe', category: 'Graphics', icon: path.join(root, 'desktop/assets/stykanimate.png') },
      appImage: { artifactName: 'update-test-${version}.AppImage' },
    } });
  }
  await copyFile(path.join(probe, 'baseline', 'update-test-0.0.1.AppImage'), installed);
  const before = await digest(installed), expected = await digest(path.join(target, 'update-test-0.0.2.AppImage'));
  const env = { ...process.env, XDG_CACHE_HOME: path.join(probe, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  await writeFile(path.join(probe, 'first-launch.log'), await run(installed, ['--ozone-platform=x11'], { env }));
  assert.equal(await digest(installed), before, 'Cancel and ordinary quit must leave the old AppImage intact.');
  await writeFile(path.join(probe, 'update-launch.log'), await run(installed, ['--ozone-platform=x11'], { env }));
  let updated;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { updated = JSON.parse(await readFile(path.join(probe, 'updated.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(updated?.version, '0.0.2', 'The updated AppImage must relaunch automatically.');
  assert.equal(updated.appImage, installed, 'Existing launchers must keep working.');
  assert.equal(await digest(installed), expected, 'The installed bytes must match the downloaded update.');
  const states = (await readFile(path.join(probe, 'states.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(states.some(state => state.status === 'error'));
  assert.ok(states.some(state => state.status === 'downloading' && state.transferred > 0));
  assert.ok(states.some(state => state.status === 'restarting'));
  const launches = (await readFile(path.join(probe, 'launches.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(launches.map(launch => launch.version), ['0.0.1', '0.0.1', '0.0.2']);
  const evidence = { passed: true, from: '0.0.1', to: updated.version, realDownload: true, checksumRejected: true, cancelPreserved: true,
    ordinaryQuitPreserved: true, realAppImageReplacement: true, realRelaunch: true, launcherPathPreserved: true,
    profilePreserved: updated.profilePreserved, before, after: expected, requests, directory: probe };
  await writeFile(path.join(output, 'appimage-smoke.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  server.close(); server.closeAllConnections();
  await rm(path.join(probe, 'cache'), { recursive: true, force: true });
}
