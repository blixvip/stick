import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('artifacts/compatibility-canvas');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true});
const results = [];
try {
  for (const failure of ['unavailable', 'requestDevice']) {
    const page = await browser.newPage({viewport: {width: 1280, height: 850}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(failure => Object.defineProperty(navigator, 'gpu', {value: failure === 'unavailable' ? undefined : {
      requestAdapter: async () => ({requestDevice: async () => {throw new Error('D3D12 create command queue failed with DXGI_ERROR_DEVICE_REMOVED (0x887A0005)');}}),
    }}), failure);
    await page.goto(process.env.STYK_URL || 'http://127.0.0.1:47831');
    await page.waitForFunction(() => window.styk?.ready);
    assert.equal(await page.evaluate(() => styk.state.renderer.context.getContextAttributes().willReadFrequently), true,
      'Fallback must request a software-oriented Canvas surface after GPU failure');
    await page.evaluate(async () => {
      const {defaultFigure, createFrame, createObject} = await import('/src/demo.mjs');
      const figure = defaultFigure();
      const report = {version: 5, canvas_width: 640, canvas_height: 480, fps: 12, backgrounds: [], figure_types: [figure],
        keyframes: Array.from({length: 12}, (_, i) => createFrame([createObject(figure, 1, 180 + i * 20, 220)]))};
      styk.editor.markSaved();
      await styk.acceptImport({document: report, kind: 'piv'}, 'Compatibility.piv');
    });
    await page.waitForTimeout(300);
    const pixels = () => page.evaluate(() => {
      const c = document.querySelector('#scene'), data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 100 && data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) ink++;
      return {ink, stats: styk.state.renderer.stats, tick: styk.editor.tick};
    });
    const opened = await pixels();
    await page.screenshot({path: path.join(out, `${failure}-opened.png`)});
    assert.ok(opened.ink > 100, 'Imported figures must paint visible pixels');
    const saved = path.join(out, `${failure}-reopened.styk`);
    const bytes = await page.evaluate(async () => {
      const {DocumentExporter} = await import('/src/document-export.mjs');
      const exporter = new DocumentExporter();
      try {return Array.from(new Uint8Array(await (await exporter.export(styk.editor.report, {name: 'Compatibility'})).arrayBuffer()));}
      finally {exporter.dispose();}
    });
    await writeFile(saved, Buffer.from(bytes));
    await page.evaluate(() => styk.editor.markSaved());
    await page.locator('#file-input').setInputFiles(saved);
    await page.waitForFunction(name => styk.editor.name === name, `${failure}-reopened`);
    await page.waitForTimeout(100);
    assert.ok((await pixels()).ink > 100, 'Opening a saved file must display figures');
    await page.evaluate(() => styk.editor.seek(0));
    await page.waitForTimeout(100);
    assert.ok((await pixels()).ink > 100, 'Seeking must preserve figures');
    await page.locator('#play-button').click();
    await page.waitForTimeout(450);
    const playing = await pixels();
    assert.ok(playing.ink > 100, 'Playback must display figures');
    assert.ok(playing.tick > 0, 'Playback must advance');
    await page.locator('#play-button').click();
    await page.waitForTimeout(100);
    assert.ok((await pixels()).ink > 100, 'Pausing must display figures');
    // Model browser context restoration: its backing pixels have been erased,
    // and an idle editor must repaint without a mouse move or another seek.
    await page.evaluate(() => {
      const c = document.querySelector('#scene');
      c.dispatchEvent(new Event('contextlost'));
      c.width = c.width;
    });
    assert.equal((await pixels()).ink, 0);
    await page.evaluate(() => document.querySelector('#scene').dispatchEvent(new Event('contextrestored')));
    await page.waitForFunction(() => {
      const c = document.querySelector('#scene'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) return true;
      return false;
    });
    assert.ok((await pixels()).ink > 100, 'Restoration must repaint an idle canvas');
    await page.screenshot({path: path.join(out, `${failure}-restored.png`)});
    if (process.env.COMPATIBILITY_SAMPLE) {
      await page.evaluate(async sample => {
        const {ImportClient} = await import('/src/import-client.mjs');
        const client = new ImportClient();
        try {
          const imported = await client.openSample(sample);
          styk.editor.markSaved(); await styk.acceptImport(imported, sample.split('/').at(-1));
          styk.editor.seek(0);
        } finally {client.dispose();}
      }, process.env.COMPATIBILITY_SAMPLE);
      await page.waitForTimeout(200);
      assert.ok((await pixels()).ink > 100, 'Real PIV import must display figures');
      await page.screenshot({path: path.join(out, `${failure}-piv.png`)});
    }
    assert.deepEqual(errors, []);
    results.push({failure, opened, playing});
    await page.close();
  }
  await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log('Compatibility canvas: import, seek, playback, pause and context restoration passed for both GPU failure modes.');
} finally {await browser.close();}
