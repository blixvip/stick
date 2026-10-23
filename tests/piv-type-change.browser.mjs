/** Regression: a Pivot rig replacement survives real worker import and playback.
 * Run: node tests/piv-type-change.browser.mjs
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './support/playwright.mjs';
import backendTools from '../desktop/backend.cjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'artifacts/piv-type-change');
await mkdir(out, {recursive: true});
const python = backendTools.pythonCandidates()[0];
const generated = spawnSync(python.command, [...python.args, '-c', String.raw`
import sys,zlib
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
from test_piv_type_changes import type_change_source
Path(sys.argv[1]).write_bytes(zlib.compress(type_change_source(frame_count=1129)))
`, path.join(out, 'type-change.piv')], {cwd: appRoot, encoding: 'utf8', windowsHide: true});
assert.equal(generated.status, 0, generated.error?.message || generated.stderr);
const source = await readFile(path.join(out, 'type-change.piv'));
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
  const checks = await page.evaluate(async bytes => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const source = new File([Uint8Array.from(bytes)], 'type-change.piv');
    check(await styk.importFiles([source]) !== false, 'Import was cancelled');
    const {editor} = styk, frames = editor.report.keyframes;
    check(frames.length === 1129 && editor.totalTicks === 1134, 'Import lost keyframes or timing');
    check(frames[0].objects[0].figure_type_id === 1 && frames[1].objects[0].figure_type_id === 2,
      'Import rewrote figure types');
    check(frames.every(f => f.objects[0].unique_id === 10), 'Import rewrote object identity');
    const original = frames[0].objects[0];
    editor.seek(2);
    let frame = editor.evaluatedFrame, pose = frame.objects.find(o => o.unique_id === 10);
    check(pose.figure_type_id === 1 && pose.root_x === original.root_x &&
      JSON.stringify(pose.angles) === JSON.stringify(original.angles), 'Inbetween must hold incompatible outgoing rig');
    const moving = frame.objects.find(o => o.unique_id === 20);
    check(moving.root_x > 350 && moving.root_x < 390, 'Other figures must keep interpolating');
    check(editor.geometry.objects.size === 3, 'Joined figures did not build geometry');
    editor.seek(4);
    frame = editor.evaluatedFrame; pose = frame.objects.find(o => o.unique_id === 10);
    check(pose.figure_type_id === 2 && pose.angles.length === 1 && pose.root_x === 190,
      'Replacement did not appear at the exact next key');
    check(editor.geometry.objects.size === 3, 'Replacement broke joined geometry');
    editor.seek(5);
    pose = editor.evaluatedFrame.objects.find(o => o.unique_id === 10);
    check(pose.figure_type_id === 2 && pose.root_x > 190 && pose.root_x < 230,
      'Compatible replacement keys did not resume interpolation');
    const {ImportClient} = await import('/src/import-client.mjs');
    const importer = new ImportClient();
    try {
      for (const format of ['piv', 'styk']) {
        const response = await fetch('/api/export', {method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({document: editor.serialize(), sourceId: styk.state.sourceId, format})});
        check(response.ok, `${format} export failed: ${await response.clone().text()}`);
        const reopened = await importer.importFile(new File([await response.arrayBuffer()], `restored.${format}`));
        check(reopened.document.keyframes.length === 1129, `${format} reopen lost frames`);
        const pose = reopened.document.keyframes[1].objects[0];
        check(pose.figure_type_id === 2 && pose.angles.length === 1 && pose.unique_id === 10,
          `${format} reopen lost replacement`);
      }
    } finally { importer.dispose(); }
    editor.seek(2); styk.fit();
    return ['1,129 keys and all durations retained', 'Outgoing rig held during inbetweens',
      'Other figures still interpolate', 'Replacement appears at the next key',
      'Joined geometry remains valid', 'Compatible keys resume interpolation', 'PIV and STYK save/reopen'];
  }, [...source]);
  await page.screenshot({path: path.join(out, 'before-transition.png')});
  await page.evaluate(() => { styk.editor.seek(4); });
  await page.screenshot({path: path.join(out, 'after-transition.png')});
  assert.ok(responses.some(r => r.status === 200 && r.type?.startsWith('application/vnd.stykanimate.piv-frames-v1')),
    'Real import must exercise the native frame transport');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'report.json'), JSON.stringify({checks, responses, errors}, null, 2));
  console.log(JSON.stringify({checks, responses, errors}, null, 2));
} finally {
  await browser?.close();
  backend.stop();
}
