// Canvas artwork whose figure effects are filtered on the WebGPU device while
// editing and in prepared playback, the scene-effect Camera image that stays
// on the device, and navigation that holds it, in the real desktop app: hardware
// WebGPU is required, which a headless test browser does not have everywhere.
//
//   node tests/renderer-artwork-vfx.desktop.mjs
import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';

const root = path.resolve('.'), output = path.join(root, 'artifacts/renderer-artwork-vfx');
await mkdir(output, {recursive:true});
const env = {...process.env, STYK_USER_DATA_DIR:path.join(output, `profile-${Date.now()}`)};
await mkdir(env.STYK_USER_DATA_DIR, {recursive:true});
await writeFile(path.join(env.STYK_USER_DATA_DIR,'telemetry-state.json'), JSON.stringify({decided:true,consent:{analytics:false,diagnostics:false,policyVersion:'2026-09-10',updatedAt:Date.now()}}));
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({args:[root], cwd:root, timeout:45000, env});
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout:30000});
  const result = await page.evaluate(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    const reports = [];
    try {
      const {artworkVfxParity, preparedArtworkVfxParity, sceneVfxCameraParity} = await import('/tests/renderer-artwork-vfx-fixture.mjs');
      const {zoomGestureState, zoomCameraHeldGPU} = await import('/tests/renderer-zoom-gesture-fixture.mjs');
      reports.push(await artworkVfxParity());
      reports.push(await preparedArtworkVfxParity());
      reports.push(await sceneVfxCameraParity());
      reports.push(await zoomGestureState({forceCanvas2D:false}));
      reports.push(await zoomCameraHeldGPU());
      return {reports};
    } catch (error) { return {reports, failure:{message:error.message, details:error.details, stack:error.stack}}; }
  });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({measuredAt:new Date().toISOString(), node:process.version, ...result, errors}, null, 2));
  console.log(JSON.stringify({output, checks:result.reports.reduce((count, report) => count + report.checks.length, 0), backends:[...new Set(result.reports.map(report => report.backend))], errors, failure:result.failure?.message}));
  assert.deepEqual(errors, []);
  assert.ifError(result.failure ? Error(result.failure.message) : undefined);
  assert.equal(result.reports.length, 5);
} finally { await app.close().catch(() => {}); }
