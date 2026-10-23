import {chromium} from '../tests/support/playwright.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const files = process.argv.slice(2);
assert.ok(files.length, 'Pass one or more project filenames');
const out = path.resolve('artifacts/compatibility-files');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const results = [];
try {
  for (const file of files) {
    const name = path.basename(file, path.extname(file)), slug = name.replace(/[^a-z0-9]+/gi, '-');
    const page = await browser.newPage({viewport: {width: 1500, height: 1000}}), errors = [];
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => {errors.push(e.message); console.log('PAGE ERROR', e.message);});
    await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', {value: {
      requestAdapter: async () => ({requestDevice: async () => {throw new Error('D3D12 create command queue failed with DXGI_ERROR_DEVICE_REMOVED (0x887A0005)');}}),
    }}));
    const row = {file, samples: [], errors}; results.push(row);
    console.log('Opening', file);
    try {
      await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
      await page.waitForFunction(() => window.styk?.ready);
      const started = Date.now();
      await page.locator('#file-input').setInputFiles(file);
      await page.waitForFunction(name => styk.editor.name === name, name);
      await page.waitForFunction(() => !styk.state.dirtyRender && !styk.state.editablePreparing);
      row.openMs = Date.now() - started;
      row.document = await page.evaluate(() => ({frames: styk.editor.report.keyframes.length, ticks: styk.editor.totalTicks,
        backend: styk.state.renderer.stats.backend, reason: styk.state.renderer.stats.reason,
        softwareSurface: styk.state.renderer.context.getContextAttributes().willReadFrequently}));
      assert.equal(row.document.backend, 'Canvas 2D fallback');
      assert.equal(row.document.softwareSurface, true);
      const snapshot = async label => {
        const sample = await page.evaluate(() => {
          const c = document.querySelector('#scene'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let ink = 0, opaque = 0, hash = 2166136261;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 100) {opaque++; if (Math.min(d[i], d[i + 1], d[i + 2]) < 180) ink++;}
            hash = Math.imul(hash ^ d[i], 16777619); hash = Math.imul(hash ^ d[i+1], 16777619);
          }
          return {tick: styk.editor.tick, frame: styk.editor.frameIndex, ink, opaque, hash: hash >>> 0,
            objects: styk.editor.evaluatedFrame.objects.length, stats: {...styk.state.renderer.stats}, playing: styk.state.playing};
        });
        sample.label = label; row.samples.push(sample);
        await page.screenshot({path: path.join(out, `${slug}-${label}.png`)});
        console.log(name, label, JSON.stringify({tick: sample.tick, ink: sample.ink, objects: sample.objects, frameMs: sample.stats.frameMs}));
        assert.ok(sample.ink > 100, `${name}: ${label} is blank`);
        return sample;
      };
      await snapshot('opened');
      for (const [label, tick] of [['first', 0], ['middle', Math.floor(row.document.ticks / 2)], ['last', row.document.ticks - 1]]) {
        await page.evaluate(tick => styk.editor.seek(tick), tick);
        await page.waitForFunction(() => !styk.state.dirtyRender && !styk.state.editablePreparing);
        await snapshot(label);
      }
      // Start from frame zero even if import initially selected the last frame.
      await page.evaluate(() => styk.editor.seek(0));
      await page.locator('#play-button').click();
      await page.waitForFunction(() => styk.editor.tick > 0);
      await snapshot('playing');
      await page.waitForTimeout(1000);
      await snapshot('playing-later');
      await page.locator('#play-button').click();
      await page.waitForFunction(() => !styk.state.playing && !styk.state.dirtyRender && !styk.state.editablePreparing);
      await snapshot('paused');
      await page.evaluate(() => {
        const c = document.querySelector('#scene'); c.dispatchEvent(new Event('contextlost')); c.width = c.width;
        c.dispatchEvent(new Event('contextrestored'));
      });
      await page.waitForFunction(() => !styk.state.dirtyRender);
      await snapshot('restored');
      assert.deepEqual(errors, []);
      row.passed = true;
    } catch (error) {
      row.passed = false; row.failure = error.stack;
      await page.screenshot({path: path.join(out, `${slug}-failure.png`)}).catch(() => {});
      console.log('FAILED', name, error.message);
    } finally {
      await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
      await page.close();
    }
  }
} finally {await browser.close();}
assert.ok(results.every(row => row.passed), 'Some compatibility checks failed; see artifacts/compatibility-files/results.json');
