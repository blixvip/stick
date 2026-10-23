'use strict';
// Internal Electron entry point. The Node driver supplies an isolated profile.
// executeJavaScript uses Electron IPC; no DevTools session pauses new workers.
const {app, dialog} = require('electron');
const {writeFile} = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const actualMemoryBytes=os.totalmem(),memoryHintGiB=Number(process.env.STYK_BENCH_MEMORY_GIB||0);
assert.ok(!memoryHintGiB||Number.isFinite(memoryHintGiB)&&memoryHintGiB>=.5&&memoryHintGiB<=128);
// Policy simulation only: this neither limits physical RAM nor emulates a GPU.
if(memoryHintGiB)os.totalmem=()=>memoryHintGiB*1073741824;
const input = process.env.STYK_BENCH_INPUT, output = process.env.STYK_BENCH_OUTPUT;
assert.ok(input && output && process.env.STYK_USER_DATA_DIR, 'Run through the benchmark driver');
const sessionCycles=Number(process.env.STYK_BENCH_SESSION_CYCLES||0);
assert.ok(Number.isInteger(sessionCycles)&&sessionCycles>=0&&sessionCycles<=1000);
if(sessionCycles)app.commandLine.appendSwitch('enable-precise-memory-info');
if(sessionCycles&&process.env.STYK_BENCH_SESSION_GC==='1')app.commandLine.appendSwitch('js-flags','--expose-gc');
const exportFormats = (process.env.STYK_BENCH_EXPORT_FORMATS || 'piv,piv,styk').split(',');
assert.ok(exportFormats.length <= 3 && exportFormats.every(format => ['piv', 'styk'].includes(format)));
const playbackFrames=Number(process.env.STYK_BENCH_PLAYBACK_FRAMES||64);
assert.ok(Number.isInteger(playbackFrames)&&playbackFrames>0&&playbackFrames<=5000);
const started = performance.now(); let running = false;
// Let the driver stop a timed-out run through normal backend cleanup.
process.stdin.on('data', () => app.exit(1));
let selectedInput=input;
dialog.showOpenDialog = async () => ({canceled: false, filePaths: [selectedInput]});
app.on('browser-window-created', (_event, window) => {
  if (running) return; running = true;
  window.setIgnoreMouseEvents(true); window.setFocusable(false); window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', () => run(window).catch(async error => {
    console.error(error.stack || error); app.exit(1);
  }));
});
async function run(window) {
  const execute = code => window.webContents.executeJavaScript(code);
  const deadline = performance.now() + 60000;
  while (!await execute('Boolean(window.styk?.ready)')) {
    if (performance.now() > deadline) throw new Error('Editor readiness timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const readyAt = Date.now(), startupMs = performance.now() - started;
  const baseline = {versions: process.versions, processes: app.getAppMetrics()};
  const baselineHealth = await execute("fetch('/api/health').then(r => r.json())");
  // The driver disables collection before launch in this disposable profile.
  // Close the release splash before timing the import.
  await execute("for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); styk.editor.markSaved();");
  // A benchmark-only opt-out compares the ordinary transport on identical
  // production bytes. It does not alter document, worker, or rendering settings.
  if(process.env.STYK_BENCH_PLAYBACK_TRANSPORT === 'document')
    await execute("import('/src/playback.mjs').then(({PlaybackCache})=>{PlaybackCache.prototype.stageNativeSnapshot=()=>false;})");
  if(process.env.STYK_BENCH_WORKER_ADMISSION==='off')
    await execute("import('/src/playback.mjs').then(({PlaybackCache})=>{PlaybackCache.prototype._admitWorkers=function(){if(this.workers.length!==this.workerLimit)this._resizeWorkers(this.workerLimit);};})");
  const imported = await execute(`(async () => {
    const tasks = [], errors = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
    const onError = event => errors.push(event.message); window.addEventListener('error', onError);
    observer.observe({type: 'longtask'});
    const started = performance.now();
    try {
      await styk.actions.open();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {ms: performance.now() - started, timings: styk.state.lastImport, editorLoad: styk.editor.lastLoadTimings,
        frames: styk.editor.report.keyframes.length, figures: styk.editor.report.figure_types.length, renderer: styk.state.renderer.stats,
        longTasks: [...tasks, ...observer.takeRecords().map(entry => entry.duration)], errors};
    } finally {observer.disconnect(); window.removeEventListener('error', onError);}
  })()`);
  assert.ok(imported.frames > 1); assert.equal(imported.timings.cache_hit, false); assert.deepEqual(imported.errors, []);
  const processes = app.getAppMetrics();
  const editing = process.env.STYK_BENCH_EDITING === '1' ? await require('./benchmark-editing-desktop.cjs')(window) : null;
  const seekGpu=process.env.STYK_BENCH_SEEK_GPU?await require('./benchmark-seek-gpu.cjs')(window,
    {timestamps:process.env.STYK_BENCH_SEEK_GPU==='timed'}):null;
  const playbackMemorySamples=[];
  const memoryTimer=process.env.STYK_BENCH_PLAYBACK==='1'?setInterval(()=>playbackMemorySamples.push({at:performance.now()-started,
    processes:app.getAppMetrics().map(({pid,type,memory})=>({pid,type,memory}))}),250):null;
  const playback = process.env.STYK_BENCH_PLAYBACK === '1' ? await execute(`(async () => {
    const renderer = styk.state.renderer, render = renderer.renderPrepared;
    if (typeof render !== 'function') throw new Error('Playback attribution requires the WebGPU path');
    const presented = [], tasks = [], errors = [], before = structuredClone(styk.performance());
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => ({at:e.startTime,ms:e.duration}))));
    const onError = event => errors.push(event.message); window.addEventListener('error', onError);
    observer.observe({type:'longtask'});
    const firstTick = styk.editor.tick >= styk.editor.totalTicks-1 ? 0 : styk.editor.tick;
    const started = performance.now(), target = Math.min(${playbackFrames}, styk.editor.totalTicks-firstTick);
    renderer.renderPrepared = function(...args) {
      const at = performance.now(), result = render.apply(this, args), tick = styk.editor.tick;
      if (result && styk.state.playing && presented.at(-1)?.tick !== tick)
        presented.push({tick,at:performance.now()-started,submitMs:performance.now()-at});
      return result;
    };
    const priorLoop = styk.state.loop; styk.state.loop = false;
    try {
      await styk.actions.play();
      while (presented.length < target && styk.state.playing) {
        if (performance.now()-started > Math.max(120000,Math.min(480000,target*250))) throw new Error('Playback probe timed out');
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const after = structuredClone(styk.performance());
      if (presented.length !== target || presented.some((frame,index) => frame.tick !== firstTick+index))
        throw new Error('Playback probe did not present every requested consecutive tick: '+JSON.stringify({firstTick,target,presented,
          playing:styk.state.playing,failure:after.playback.failure,error:document.querySelector('#renderer-error')?.textContent}));
      return {firstTick,requestedFrames:target,firstFrameMs:presented[0].at,presented,before,after,
        longTasks:[...tasks,...observer.takeRecords().map(e => ({at:e.startTime,ms:e.duration}))],errors};
    } finally {
      if (styk.state.playing) await styk.actions.play();
      renderer.renderPrepared = render; styk.state.loop = priorLoop;
      observer.disconnect(); window.removeEventListener('error', onError);
    }
  })()`) : null;
  clearInterval(memoryTimer);
  if (playback) assert.deepEqual(playback.errors, []);
  const playbackProcesses = playback ? app.getAppMetrics() : null;
  const digest = await execute(`(async () => {
    const r = styk.editor.report;
    const bytes = new TextEncoder().encode(JSON.stringify({figure_types: r.figure_types, keyframes: r.keyframes, backgrounds: r.backgrounds, fps: r.fps, width: r.canvas_width, height: r.canvas_height}));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
  })()`);
  const health = await execute("fetch('/api/health').then(r => r.json())");
  await writeFile(path.join(output, 'import.png'), (await window.webContents.capturePage()).toPNG());
  const exports = process.env.STYK_BENCH_EXPORT === '1' ? await execute(`(async () => {
    const {DocumentExporter} = await import('/src/document-export.mjs');
    const exporter = new DocumentExporter(), rows = [];
    try {
      for (const format of ${JSON.stringify(exportFormats)}) {
        const tasks = [], observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
        observer.observe({type: 'longtask'});
        let output, timings;
        try {
          output = await exporter.export(styk.editor.report, {sourceId: styk.state.sourceId, format, name: 'Benchmark'});
          timings = {...exporter.lastTimings};
        } finally {tasks.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect();}
        const bytes = await output.arrayBuffer();
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
        rows.push({format, bytes: output.size, sha256, timings, longTasks: tasks});
      }
      return rows;
    } finally {exporter.dispose();}
  })()`) : null;
  const session=sessionCycles?await require('./benchmark-session-memory.cjs')(window,{cycles:sessionCycles,input,
    alternate:process.env.STYK_BENCH_ALTERNATE_INPUT,output,forcedGC:process.env.STYK_BENCH_SESSION_GC==='1',
    choose:file=>{selectedInput=file;},metrics:()=>app.getAppMetrics()}):null;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({readyAt, startupMs, baseline, baselineHealth, imported, processes, digest, health,
    exports, playback, playbackProcesses, playbackMemorySamples, editing, session, seekGpu,
    environment: {cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramBytes: actualMemoryBytes, memoryHintGiB:memoryHintGiB||null, os: os.release()}}, null, 2));
  // Wait for the main-process acknowledgement before asking to close. Merely
  // marking the renderer saved can race its asynchronous desktop state update.
  await execute('(async()=>{styk.editor.markSaved();await stykDesktop.setDocumentState({name:styk.editor.name,dirty:false});})()');
  app.quit();
}
require('../desktop/main.cjs');
