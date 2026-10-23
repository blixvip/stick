/** Matched source-Electron import baseline, including native boundary costs.
 * Fresh isolated profiles, alternating scanner order, read-only source fixture.
 * Reports readiness/submission, not physical display latency or cold-disk launch.
 */
import {_electron as electron} from '../tests/support/playwright.mjs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performanceSourceHashes as sourceHashes} from './performance-source-hashes.mjs';

const source = process.argv[2];
if (!source) throw new Error('Provide a PIV fixture path.');
const pairs = Number(process.argv[3] ?? 2);
assert.ok(Number.isInteger(pairs) && pairs >= 1 && pairs <= 10);
const scanner = process.env.STYK_BENCH_SCANNER;
assert.ok(!scanner || ['python', 'cpp'].includes(scanner), 'STYK_BENCH_SCANNER must be python or cpp');
const output = path.resolve('artifacts/performance-architecture-audit', `desktop-${Date.now()}`);
await mkdir(output, {recursive: true});
const filename = path.resolve(source), sourceBytes = await readFile(filename);
const sha = value => createHash('sha256').update(value).digest('hex');
const report = {at: new Date().toISOString(), source: {name: path.basename(filename), bytes: sourceBytes.length, sha256: sha(sourceBytes)},
  sourceHashes: await sourceHashes(),
  environment: {node: process.version, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(), os: os.release()}, rows: [],
  limitations: ['Source Electron, fresh profiles; OS file/shader caches are not flushed.',
    'Startup includes Playwright launch/connection overhead; readiness is two rAFs after styk.ready.',
    'Import includes native file IPC, HTTP, worker reconstruction, editor preparation and two rAFs.',
    'Working-set sums can double-count shared pages; backend is reported separately.',
    'No physical display, GPU timestamp, OS allocation or long-session leak measurement.']};
let expectedDigest;
for (let pair = 0; pair < pairs; pair++) for (const mode of (scanner ? [scanner] : pair % 2 ? ['cpp', 'python'] : ['python', 'cpp'])) {
  const profile = path.join(output, `${pair}-${mode}`), env = {...process.env,
    STYK_USER_DATA_DIR: profile, STYK_LIBRARY_DIR: path.join(profile, 'library'),
    STYK_DISABLE_NATIVE_SCAN: mode === 'python' ? '1' : '0'};
  delete env.ELECTRON_RUN_AS_NODE;
  const start = performance.now();
  const app = await electron.launch({args: [process.cwd()], cwd: process.cwd(), env, timeout: 60000});
  try {
    const page = await app.firstWindow(), errors = [];
    const moduleRequests = [];
    page.context().on('requestfinished', request => {
      if (process.env.STYK_BENCH_NETWORK === '1' && /\.mjs(?:\?|$)/.test(request.url()) && moduleRequests.length < 2048)
        moduleRequests.push({path: new URL(request.url()).pathname, timing: request.timing()});
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 60000});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const startupMs = performance.now() - start;
    const baseline = await app.evaluate(({app}) => ({versions: process.versions, processes: app.getAppMetrics()}));
    const baselineHealth = await page.evaluate(() => fetch('/api/health').then(r => r.json()));
    assert.equal(baselineHealth.nativeFrameScanner, mode);
    await app.evaluate(({BrowserWindow}) => {const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setIgnoreMouseEvents(true); win.setFocusable(false); win.showInactive();});
    await page.evaluate(() => {for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); styk.editor.markSaved();});
    await app.evaluate(({dialog}, file) => {dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]});}, filename);
    await app.evaluate(() => {globalThis.auditMeter = {last: performance.now(), maxGapMs: 0}; auditMeter.timer = setInterval(() => {const now = performance.now(); auditMeter.maxGapMs = Math.max(auditMeter.maxGapMs, now - auditMeter.last); auditMeter.last = now;}, 5);});
    if (process.env.STYK_BENCH_TRACE === '1') await app.evaluate(({contentTracing}) => contentTracing.startRecording({
      included_categories: ['blink', 'loading', 'v8', 'devtools.timeline', 'toplevel', 'disabled-by-default-devtools.timeline', 'disabled-by-default-v8.cpu_profiler'],
    }));
    const imported = await page.evaluate(async () => {
      const tasks = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({type: 'longtask'});
      const start = performance.now();
      try {
        await styk.actions.open();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {ms: performance.now() - start, timings: styk.state.lastImport, editorLoad: styk.editor.lastLoadTimings, frames: styk.editor.report.keyframes.length,
          figures: styk.editor.report.figure_types.length, renderer: styk.state.renderer.stats,
          longTasks: [...tasks, ...observer.takeRecords().map(entry => entry.duration)],
          jsMemory: performance.memory ? {used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize} : null};
      } finally {observer.disconnect();}
    });
    const main = await app.evaluate(({app}) => {clearInterval(auditMeter.timer); const {maxGapMs} = auditMeter; delete globalThis.auditMeter; return {maxTimerGapMs: maxGapMs, processes: app.getAppMetrics()};});
    const trace = process.env.STYK_BENCH_TRACE === '1'
      ? await app.evaluate(({contentTracing}, file) => contentTracing.stopRecording(file), path.join(output, `${pair}-${mode}-trace.json`)) : undefined;
    assert.ok(imported.frames > 1);
    assert.equal(imported.timings?.cache_hit, false);
    const digest = await page.evaluate(async () => {
      const r = styk.editor.report;
      const data = new TextEncoder().encode(JSON.stringify({figure_types: r.figure_types, keyframes: r.keyframes, backgrounds: r.backgrounds, fps: r.fps, width: r.canvas_width, height: r.canvas_height}));
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), v => v.toString(16).padStart(2, '0')).join('');
    });
    expectedDigest ??= digest;
    assert.equal(digest, expectedDigest, 'Parsed scene must match across all variants');
    const health = await page.evaluate(() => fetch('/api/health').then(r => r.json()));
    await page.screenshot({path: path.join(output, `${pair}-${mode}.png`)});
    assert.deepEqual(errors, []);
    report.rows.push({pair, mode, startupMs, baseline, baselineHealth, imported, main, health, digest, errors, trace,
      ...(process.env.STYK_BENCH_NETWORK === '1' ? {moduleRequests} : {})});
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pair, mode, startupMs, importMs: imported.ms, decodeMs: imported.timings?.decode_ms, output}));
  } finally {
    await app.evaluate(({app}) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
assert.equal(sha(await readFile(filename)), report.source.sha256, 'Input fixture must remain unchanged');
report.sourceUnchanged = true;
const finalHashes = await sourceHashes();
report.changedSourcePaths = [...new Set([...Object.keys(report.sourceHashes), ...Object.keys(finalHashes)])]
  .filter(name => report.sourceHashes[name] !== finalHashes[name]);
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
assert.deepEqual(report.changedSourcePaths, [], 'Application sources changed during the comparison; discard its performance conclusion');
console.log(`REPORT ${output}`);
