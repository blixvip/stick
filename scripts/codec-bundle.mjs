// The Pivot codec's Python sources as one JSON document, for the in-browser
// codec (src/codec-web-engine.mjs writes them into the WebAssembly interpreter's
// file system). Used by the web build and by the tests, so both run exactly the
// files the desktop app freezes.
//
// Layout mirrors the repository, because server.py locates the codec modules
// relative to itself: backend/*.py and codecs/*.py.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Tests, benchmarks and profilers are development tools, not part of the codec.
const EXCLUDED = /^(test_|benchmark|profile_)/;

export async function codecBundle(root = appRoot) {
  const files = {};
  for (const directory of ['backend', 'codecs']) {
    const names = (await readdir(path.join(root, directory))).filter((name) => name.endsWith('.py') && !EXCLUDED.test(name)).sort();
    for (const name of names) files[`${directory}/${name}`] = await readFile(path.join(root, directory, name), 'utf8');
  }
  for (const required of ['backend/server.py', 'backend/browser_service.py', 'codecs/codec_bridge.py', 'codecs/piv_codec.py']) {
    if (!files[required]) throw new Error(`The codec bundle is missing ${required}.`);
  }
  return { files };
}
