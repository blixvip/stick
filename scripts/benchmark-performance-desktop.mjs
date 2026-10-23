/** Real desktop import without an attached DevTools/Playwright session. */
import electron from 'electron';
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performanceSourceHashes} from './performance-source-hashes.mjs';
import {POLICY_VERSION} from '../src/telemetry-schema.mjs';

assert.ok(process.argv[2], 'Provide a read-only PIV fixture');
const source = path.resolve(process.argv[2]), label = process.argv[3] || String(Date.now());
assert.match(label, /^[a-zA-Z0-9_-]+$/, 'Use a plain artifact label');
const runs = Number(process.argv[4] || 3); assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20);
const output = path.resolve('artifacts/performance-goal', label);
await mkdir(output, {recursive: true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const harnessFiles=['scripts/benchmark-performance-desktop.mjs','scripts/benchmark-performance-desktop.cjs',
  'scripts/benchmark-editing-desktop.cjs','scripts/benchmark-session-memory.cjs','scripts/benchmark-seek-gpu.cjs'];
const harnessHashes=async()=>Object.fromEntries(await Promise.all(harnessFiles.map(async name=>[name,hash(await readFile(name))])));
const sourceBytes = await readFile(source);
const sessionCycles=Number(process.env.STYK_BENCH_SESSION_CYCLES||0);
assert.ok(Number.isInteger(sessionCycles)&&sessionCycles>=0&&sessionCycles<=1000);
const seekGpuMode=process.env.STYK_BENCH_SEEK_GPU||'';
assert.ok(['','timed','untimed'].includes(seekGpuMode));
const alternate=process.env.STYK_BENCH_ALTERNATE_INPUT?path.resolve(process.env.STYK_BENCH_ALTERNATE_INPUT):null;
assert.ok(!sessionCycles||alternate,'Session measurement requires STYK_BENCH_ALTERNATE_INPUT');
const alternateBytes=alternate?await readFile(alternate):null;
const expectedPivSha256 = process.env.STYK_BENCH_EXPECT_PIV_SHA256 || hash(sourceBytes);
assert.match(expectedPivSha256, /^[a-f0-9]{64}$/, 'An optional control export digest must be a SHA-256');
const report = {at: new Date().toISOString(), source: {name: path.basename(source), bytes: sourceBytes.length, sha256: hash(sourceBytes)},
  expectedPivSha256, exportFormats: process.env.STYK_BENCH_EXPORT === '1' ? (process.env.STYK_BENCH_EXPORT_FORMATS || 'piv,piv,styk').split(',') : [],
  playbackProbe: process.env.STYK_BENCH_PLAYBACK === '1',
  seekGpuMode:seekGpuMode||null,
  sessionProbe:sessionCycles?{cycles:sessionCycles,forcedGC:process.env.STYK_BENCH_SESSION_GC==='1',
    alternate:{name:path.basename(alternate),bytes:alternateBytes.length,sha256:hash(alternateBytes)}}:null,
  playbackFrames: Number(process.env.STYK_BENCH_PLAYBACK_FRAMES||64),
  editingProbe: process.env.STYK_BENCH_EDITING === '1',
  memoryHintGiB:Number(process.env.STYK_BENCH_MEMORY_GIB)||null,
  workerAdmission:process.env.STYK_BENCH_WORKER_ADMISSION==='off'?'disabled-control':'default',
  playbackTransport: process.env.STYK_BENCH_PLAYBACK_TRANSPORT === 'document' ? 'document-control' : 'default',
  sourceHashes: await performanceSourceHashes(),harnessHashes:await harnessHashes(), rows: [],
  limitations: ['No attached debugger. Source Electron with fresh profiles; OS caches are not flushed.',
    'Startup includes process launch and a readiness probe. Two rAFs establish submission readiness, not physical scanout.',
    'Process working-set sums can count shared pages repeatedly. Other workstation activity is not controlled.']};
let expectedDigest;
for (let run = 0; run < runs; run++) {
  const directory = path.join(output, String(run)); await mkdir(directory, {recursive: true});
  const env = {STYK_STARTUP_VIEW: 'editor', ...process.env, STYK_BENCH_INPUT: source, STYK_BENCH_OUTPUT: directory,
    ...(alternate?{STYK_BENCH_ALTERNATE_INPUT:alternate}:{}),
    STYK_USER_DATA_DIR: path.join(directory, 'profile'), STYK_LIBRARY_DIR: path.join(directory, 'library')};
  await mkdir(env.STYK_USER_DATA_DIR, {recursive: true});
  await writeFile(path.join(env.STYK_USER_DATA_DIR, 'telemetry-state.json'), JSON.stringify({decided: true,
    consent: {analytics: false, diagnostics: false, policyVersion: POLICY_VERSION, updatedAt: Date.now()}}), {flag: 'wx'});
  delete env.ELECTRON_RUN_AS_NODE;
  const launched = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['scripts/benchmark-performance-desktop.cjs'], {cwd: process.cwd(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let log = '';
    child.stdin.on('error', () => {});
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {log = (log + chunk).slice(-20000);});
    let forced;
    const timeout = setTimeout(() => {child.stdin.write('abort'); forced = setTimeout(() => child.kill(), 5000);}, Math.max(600000,sessionCycles*120000));
    child.on('error', error => {clearTimeout(timeout); clearTimeout(forced); reject(error);});
    child.on('exit', code => {
      clearTimeout(timeout); clearTimeout(forced); child.stdin.destroy();
      writeFile(path.join(directory, 'process.log'), log).then(() => code === 0 ? resolve() : reject(new Error(`Desktop benchmark exited ${code}: ${log.slice(-2000)}`)), reject);
    });
  });
  const row = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  if(row.session){
    assert.equal(row.session.rowsFile,'session-rows.jsonl');
    row.session.rows=(await readFile(path.join(directory,row.session.rowsFile),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(row.session.rows.length,row.session.completed);
  }
  row.launchToReadyMs = row.readyAt - launched;
  report.rows.push(row);
  // Keep failed correctness evidence too, without labeling it a valid baseline.
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  expectedDigest ??= row.digest; assert.equal(row.digest, expectedDigest, 'Every run must produce the same editable scene');
  for (const exported of row.exports || []) if (exported.format === 'piv') {
    assert.equal(exported.sha256, expectedPivSha256, 'Pivot export must match the original or explicitly pinned control digest');
    if (expectedPivSha256 === report.source.sha256) assert.equal(exported.bytes, report.source.bytes);
  }
  console.log(JSON.stringify({run, startupMs: row.launchToReadyMs, importMs: row.imported.ms, scene: row.imported.renderer.initialPreparation, output}));
}
report.sourceUnchanged = hash(await readFile(source)) === report.source.sha256;
if(alternate)report.alternateUnchanged=hash(await readFile(alternate))===hash(alternateBytes);
const final = await performanceSourceHashes();
report.changedSourcePaths = [...new Set([...Object.keys(final), ...Object.keys(report.sourceHashes)])].filter(key => final[key] !== report.sourceHashes[key]);
const finalHarness=await harnessHashes();report.changedHarnessPaths=harnessFiles.filter(name=>finalHarness[name]!==report.harnessHashes[name]);
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
assert.equal(report.sourceUnchanged, true);
if(alternate)assert.equal(report.alternateUnchanged,true);
assert.deepEqual(report.changedSourcePaths, [], 'Sources changed during the measurement');
assert.deepEqual(report.changedHarnessPaths, [], 'Harness changed during the measurement');
