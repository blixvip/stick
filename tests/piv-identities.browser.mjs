/** Real file-input/worker/editor regression. Optional argument: an external PIV.
 * node tests/piv-identities.browser.mjs [path/to/reported.piv]
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './support/playwright.mjs';
import backendTools from '../desktop/backend.cjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = process.argv[2];
const out = path.join(appRoot, 'artifacts/piv-identities', external ? 'reported' : 'synthetic');
await mkdir(out, {recursive: true});
let source = external && path.resolve(external);
if (!source) {
  source = path.join(out, 'identities.piv');
  const python = backendTools.pythonCandidates()[0];
  const generated = spawnSync(python.command, [...python.args, '-c', String.raw`
import sys,zlib
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
from test_piv_identities import identity_source
Path(sys.argv[1]).write_bytes(zlib.compress(identity_source()))
`, source], {cwd: appRoot, encoding: 'utf8', windowsHide: true});
  assert.equal(generated.status, 0, generated.error?.message || generated.stderr);
}
const backend = await backendTools.startBackend({appRoot});
let browser;
try {
  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 960}});
  const errors = [], responses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/import')
      responses.push({status: response.status(), type: response.headers()['content-type']});
  });
  await page.goto(backend.origin);
  await page.waitForFunction(() => window.styk?.ready);
  await page.locator('input[type=file]').first().setInputFiles(source);
  await page.waitForFunction(() => styk.state.lastImportWarnings?.some(w => w.code === 'piv_duplicate_object_ids'),
    null, {timeout: 240000});
  await page.screenshot({path: path.join(out, 'import-notes.png')});
  assert.match(await page.locator('.import-notes-dialog[open]').innerText(), /Pivot import notes/);
  await page.locator('.import-notes-dialog[open] .ui-dialog-close').click();
  const checks = await page.evaluate(() => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const {editor} = styk, frames = editor.report.keyframes;
    let objectCount = 0;
    for (const frame of frames) {
      const ids = new Set(frame.objects.map(o => o.unique_id));
      check(ids.size === frame.objects.length, 'An identity collision reached the editor');
      check(new Set(frame.object_draw_order_unique_ids).size === frame.objects.length, 'Draw order lost figures');
      for (const object of frame.objects) if (object.join) {
        check(frame.objects[object.join.target_object_slot]?.unique_id === object.join.target_unique_id,
          'Join no longer matches the source slot');
      }
      objectCount += frame.objects.length;
    }
    const repairs = editor.report.piv_identity_recovery.objects;
    const affected = [...new Set(repairs.map(r => r.keyframe_index))];
    for (const index of affected) {
      editor.selectFrame(index);
      check(editor.geometry.objects.size === frames[index].objects.length, `Geometry lost figures in key ${index+1}`);
    }
    editor.selectFrame(affected[0]); styk.fit();
    return {keys: frames.length, ticks: editor.totalTicks, objectCount, repairs: repairs.length,
      affectedKeyframes: affected.map(i => i+1), warnings: styk.state.lastImportWarnings};
  });
  await page.screenshot({path: path.join(out, 'recovered-frame.png')});
  if (external) {
    assert.deepEqual({keys: checks.keys, ticks: checks.ticks, objectCount: checks.objectCount, repairs: checks.repairs},
      {keys: 4513, ticks: 4620, objectCount: 385736, repairs: 7});
  } else {
    checks.roundtrip = await page.evaluate(async () => {
      const {DocumentExporter} = await import('/src/document-export.mjs');
      const {ImportClient} = await import('/src/import-client.mjs');
      const exporter = new DocumentExporter(), importer = new ImportClient();
      try {
        const document = styk.editor.serialize();
        document.keyframes[0].objects.find(o => o.unique_id === 5).root_x += .25;
        const summary = report => report.keyframes.map(f => ({duration: f.duration_raw,
          order: f.object_draw_order_unique_ids, objects: f.objects.map(o => ({id:o.unique_id,
            type:o.figure_type_id, x:o.root_x, angles:o.angles, target:o.join?.target_unique_id ?? null})).sort((a,b)=>a.id-b.id)}));
        const expected = JSON.stringify(summary(document));
        for (const format of ['piv', 'styk']) {
          // Exercise the frame-preserving PIV writer directly. The UI export
          // worker intentionally bakes output ticks and joined root positions.
          let blob;
          if (format === 'piv') {
            const response = await fetch('/api/export', {method:'POST', headers:{'Content-Type':'application/json'},
              body:JSON.stringify({document, sourceId:styk.state.sourceId, format})});
            if (!response.ok) throw new Error(await response.text());
            blob = await response.blob();
          } else blob = await exporter.export(document, {sourceId: styk.state.sourceId, format, name:'identity-regression'});
          const restored = await importer.importFile(new File([blob], `restored.${format}`));
          if (JSON.stringify(summary(restored.document)) !== expected) throw new Error(`${format} roundtrip lost recovered content`);
        }
        return ['edited PIV save/reopen', 'native STYK save/reopen'];
      } finally { exporter.dispose(); importer.dispose(); }
    });
  }
  assert.ok(responses.some(r => r.status === 200 && r.type?.startsWith('application/vnd.stykanimate.piv-frames-v1')));
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'report.json'), JSON.stringify({checks, responses, errors}, null, 2));
  console.log(JSON.stringify({checks, responses, errors}, null, 2));
} finally { await browser?.close(); backend.stop(); }
