import {_electron as electron} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';

const root = path.resolve('.'), output = path.join(root, 'artifacts', 'startup-fallback');
await mkdir(output, {recursive: true});
const app = await electron.launch({args: [root], cwd: root, timeout: 45000,
  env: {...process.env, STYK_USER_DATA_DIR: path.join(output, `profile-${Date.now()}`)}});
const results = [];
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 30000});
  assert.equal(await page.evaluate(() => styk.state.renderer.stats.backend), 'WebGPU');
  await page.addInitScript(() => {
    const mode = sessionStorage.getItem('startup-failure');
    if (mode === 'adapter-hang') Object.defineProperty(navigator, 'gpu', {value: {requestAdapter: () => new Promise(() => {})}});
    if (mode === 'shader-failure') GPUDevice.prototype.createShaderModule = () => { throw new Error('Simulated shader failure'); };
    if (mode === 'pipeline-hang') GPUDevice.prototype.createRenderPipelineAsync = () => new Promise(() => {});
    if (mode === 'configure-failure') GPUCanvasContext.prototype.configure = () => { throw new Error('Simulated configuration failure'); };
  });
  for (const mode of ['adapter-hang', 'shader-failure', 'pipeline-hang', 'configure-failure']) {
    await page.evaluate(mode => sessionStorage.setItem('startup-failure', mode), mode);
    const started = performance.now();
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.styk?.ready, undefined, {timeout: 15000});
    const result = await page.evaluate(() => ({backend: styk.state.renderer.stats.backend, reason: styk.state.renderer.stats.reason,
      errorHidden: document.querySelector('#renderer-error').hidden}));
    assert.equal(result.backend, 'Canvas 2D fallback');
    assert.equal(result.errorHidden, true);
    await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });
    await page.screenshot({path: path.join(output, `${mode}.png`)});
    results.push({mode, elapsedMs: Math.round(performance.now() - started), ...result});
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await app.close(); }
