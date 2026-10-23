import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {unpackNativeFrameResponse, materializeNativeFrames} from '../src/import-wire.mjs';
import {Editor} from '../src/editor.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('recovered native IDs match JSON import and keep separate editable geometry and joins', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'styk-identities-'));
  try {
    const python = backend.pythonCandidates()[0];
    const generated = spawnSync(python.command, [...python.args, '-c', String.raw`
import sys
from pathlib import Path
sys.path.insert(0, str(Path('backend').resolve()))
import server
from test_piv_identities import identity_source
root = Path(sys.argv[1]); source = identity_source(); store = server.ProjectStore(server.WORKSPACE)
(root/'fixture.wire').write_bytes(store.import_bytes(source, 'identities.piv', prefer_native=True))
(root/'fixture.json').write_bytes(store.import_bytes(source, 'identities.piv', as_json=True))
`, temp], {cwd: app, encoding: 'utf8', windowsHide: true});
    assert.equal(generated.status, 0, generated.error?.message || generated.stderr);
    const raw = await readFile(path.join(temp, 'fixture.wire'));
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset+raw.byteLength);
    const packet = unpackNativeFrameResponse(buffer);
    const expected = JSON.parse(await readFile(path.join(temp, 'fixture.json'), 'utf8'));
    const result = await materializeNativeFrames(packet.result, buffer, packet.offset);
    assert.deepEqual(result.document, expected.document);
    const editor = new Editor({demo: false}).load(result.document);
    assert.equal(editor.totalTicks, 8);
    for (const index of [0, 1, 2, 3]) {
      editor.selectFrame(index);
      assert.equal(editor.geometry.objects.size, 6);
      const frame = editor.report.keyframes[index];
      assert.equal(new Set(frame.objects.map(o => o.unique_id)).size, 6);
      assert.equal(frame.objects[4].join.target_unique_id, frame.objects[2].unique_id);
    }
    editor.selectFrame(0);
    const before = structuredClone(editor.frame);
    editor.select(5); editor.moveSelection(9, 0);
    assert.equal(editor.frame.objects.find(o => o.unique_id === 5).root_x, 289);
    assert.equal(editor.frame.objects.find(o => o.unique_id === 10).root_x, 160);
    assert.ok(editor.undo()); assert.deepEqual(editor.frame, before);
    assert.ok(editor.redo());
    // A raw/unrepaired transfer must fail atomically at the frontend boundary.
    const invalid = buffer.slice(0), fresh = unpackNativeFrameResponse(invalid);
    const repair = fresh.result.document.piv_identity_recovery.objects[0];
    new DataView(invalid).setUint32(fresh.offset+repair.record_offset-fresh.result.nativeFrames.sourceOffset,
      repair.source_unique_id, true);
    await assert.rejects(materializeNativeFrames(fresh.result, invalid, fresh.offset), /Duplicate native figure identity/);
    assert.deepEqual(fresh.result.document.keyframes, []);
  } finally { await rm(temp, {recursive: true, force: true}); }
});
