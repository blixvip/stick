import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCodecEngine} from '../src/codec-web-engine.mjs';
import {codecBundle} from '../scripts/codec-bundle.mjs';
import {resolvePython} from '../scripts/run-python.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPyodide = existsSync(path.join(root, 'node_modules', 'pyodide', 'pyodide.mjs'));
const skip = hasPyodide ? false : 'pyodide is not installed (npm ci installs it)';
const decode = bytes => new TextDecoder().decode(bytes);
const encode = text => new TextEncoder().encode(text);
const JSON_ACCEPT = {Accept: 'application/json'};

async function realEngine(extra = {}) {
  const {loadPyodide} = await import('pyodide');
  const bundle = await codecBundle(root);
  const state = {boots: 0, statuses: []};
  const engine = createCodecEngine({
    onStatus: status => state.statuses.push(status.state),
    loadRuntime: async () => { state.boots++; return (state.py = await loadPyodide()); },
    loadBundle: async () => bundle,
    ...extra,
  });
  return {engine, state};
}
const scaffold = py => py.runPython("import server\nserver.bridge.scaffold({'canvas_width': 640, 'canvas_height': 480, 'fps': 24})").toJs();
const volatile = value => Array.isArray(value) ? value.map(volatile)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'timings').map(([key, v]) => [key, volatile(v)])) : value;

test('the codec boots on first use and serves health, import and export in WebAssembly', {skip, timeout: 120000}, async () => {
  const {engine, state} = await realEngine();
  assert.deepEqual(state.statuses, [], 'nothing loads before the first request');
  const health = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(decode(health.body)).host, 'browser');
  assert.deepEqual(state.statuses, ['loading', 'loading', 'ready']);

  const piv = scaffold(state.py);
  const imported = await engine.handle({method: 'POST', path: '/api/import?filename=blank.piv', headers: JSON_ACCEPT, body: piv});
  assert.equal(imported.status, 200);
  const result = JSON.parse(decode(imported.body));
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'piv');

  const request = encode(JSON.stringify({document: result.document, format: 'piv', filename: 'blank.piv', sourceId: result.sourceId}));
  const exported = await engine.handle({method: 'POST', path: '/api/export', headers: {'Content-Type': 'application/json'}, body: request});
  assert.equal(exported.status, 200);
  assert.match(exported.headers['Content-Disposition'], /blank\.piv/);
  assert.equal(exported.headers['X-Styk-Request-Bytes'], String(request.length));
  state.py.globals.set('exported', exported.body);
  assert.equal(state.py.runPython("import piv_codec\npiv_codec.decode_piv_bytes(bytes(exported.to_py()))['canvas_width']"), 640,
    'the exported bytes are a readable Pivot file with the original canvas');

  const source = await engine.handle({method: 'GET', path: `/api/source?id=${result.sourceId}`});
  assert.equal(decode(source.body.subarray(0, 8)), 'STYKSRC1', 'the imported source is retained for the session');
  assert.equal(state.boots, 1, 'one interpreter serves every request');
});

test('a bad file is a JSON 422, and the codec keeps working afterwards', {skip, timeout: 120000}, async () => {
  const {engine} = await realEngine();
  const bad = await engine.handle({method: 'POST', path: '/api/import?filename=x.piv', body: encode('this is not a pivot file')});
  assert.equal(bad.status, 422);
  assert.equal(JSON.parse(decode(bad.body)).code, 'invalid_project');
  const health = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(health.status, 200);
});

test('responses can be transferred to the page without copying', {skip, timeout: 120000}, async () => {
  const {engine} = await realEngine();
  const {body} = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(body.buffer.byteLength, body.length, 'the body owns exactly its bytes');
  const moved = structuredClone(body.buffer, {transfer: [body.buffer]});
  assert.equal(body.buffer.byteLength, 0);
  assert.ok(moved.byteLength > 0);
});

test('WebAssembly and native CPython return the same document for the same file', {skip, timeout: 180000}, async t => {
  const python = resolvePython();
  if (!python) return t.skip('Python 3.11+ is not installed');
  const {engine, state} = await realEngine();
  await engine.handle({method: 'GET', path: '/api/health'});
  const piv = scaffold(state.py);
  const inWasm = JSON.parse(decode((await engine.handle({method: 'POST', path: '/api/import?filename=blank.piv', headers: JSON_ACCEPT, body: piv})).body));
  const script = `
import json, sys
sys.path[:0] = [${JSON.stringify(path.join(root, 'backend'))}]
import server, browser_service
data = sys.stdin.buffer.read()
status, headers, body = browser_service.BrowserCodec().request('POST', '/api/import?filename=blank.piv', {'Accept': 'application/json'}, data)
sys.stdout.write(body.decode())`;
  const native = spawnSync(python.command, [...python.args, '-c', script], {input: Buffer.from(piv), encoding: 'utf8', maxBuffer: 1 << 26});
  assert.equal(native.status, 0, native.stderr);
  const inCPython = JSON.parse(native.stdout);
  assert.deepEqual(volatile(inWasm), volatile(inCPython));
});

test('a runtime that fails to load answers 503 and the next request tries again', {timeout: 60000}, async () => {
  let attempts = 0;
  const statuses = [];
  const engine = createCodecEngine({
    onStatus: status => statuses.push(status.state),
    loadRuntime: async () => { attempts++; throw new Error('network down'); },
    loadBundle: async () => ({files: {}}),
  });
  const first = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(first.status, 503);
  const body = JSON.parse(decode(first.body));
  assert.equal(body.code, 'codec_unavailable');
  assert.match(body.error, /network down/);
  await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(attempts, 2, 'a failed boot is not cached');
  assert.ok(statuses.includes('failed'));
});

test('a WebAssembly fault is a JSON 500 and the interpreter is rebuilt for the next request', {timeout: 60000}, async () => {
  let boots = 0;
  const destroyed = [];
  const proxy = () => ({destroy: () => destroyed.push(true)});
  const engine = createCodecEngine({
    loadRuntime: async () => {
      boots++;
      const faulty = boots === 1;
      return {
        FS: {mkdirTree() {}, writeFile() {}},
        runPython() {},
        toPy: () => proxy(),
        pyimport: () => ({handle: () => {
          if (faulty) throw new RuntimeError('memory access out of bounds');
          return {destroy() {}, toJs: () => [200, {}, new Uint8Array([1])]};
        }}),
      };
    },
    loadBundle: async () => ({files: {'backend/x.py': ''}}),
  });
  function RuntimeError(message) { return Object.assign(new Error(message), {name: 'RuntimeError'}); }
  const crashed = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(crashed.status, 500);
  assert.equal(JSON.parse(decode(crashed.body)).code, 'codec_error');
  assert.ok(destroyed.length >= 2, 'argument proxies are released even when the call faults');
  const recovered = await engine.handle({method: 'GET', path: '/api/health'});
  assert.equal(recovered.status, 200);
  assert.equal(boots, 2);
});
