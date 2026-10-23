'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Runs while packaging, never while editing or rendering. Identifies source code, not a device.
async function buildTelemetryInfo(root, { internal = process.env.STYK_INTERNAL_BUILD === '1' } = {}) {
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && !['__pycache__', 'node_modules'].includes(entry.name)) await collect(relative);
      else if (entry.isFile() && /\.(mjs|cjs|py)$/.test(entry.name)) files.push(relative);
    }
  }
  for (const dir of ['src', 'desktop', 'backend', 'codecs']) await collect(dir);
  files.push('package.json'); files.sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); hash.update(createHash('sha256').update(await fs.readFile(path.join(root, file))).digest()); }
  const info = { build: hash.digest('hex').slice(0, 16), internal: Boolean(internal) };
  await fs.writeFile(path.join(root, 'desktop', 'telemetry-build.json'), JSON.stringify(info) + '\n');
  return info;
}
module.exports = { buildTelemetryInfo };
