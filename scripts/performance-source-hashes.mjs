import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

/** Compare the actual implementation and native/WASM bytes around a benchmark. */
export async function performanceSourceHashes(root = process.cwd()) {
  const hashes = {}, digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const directory of ['src', 'desktop', 'backend', 'codecs', 'native', 'vendor']) {
    for (const entry of await readdir(path.join(root, directory), {recursive: true, withFileTypes: true})) {
      if (!entry.isFile() || !/\.(mjs|cjs|js|py|cpp|h|hpp|rs|wgsl|wasm|dll|exe)$/.test(entry.name)) continue;
      const filename = path.join(entry.parentPath, entry.name);
      hashes[path.relative(root, filename).replaceAll('\\', '/')] = digest(await readFile(filename));
    }
  }
  for (const name of ['package.json', 'package-lock.json']) hashes[name] = digest(await readFile(path.join(root, name)));
  return hashes;
}
