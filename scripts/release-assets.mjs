import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const yaml = createRequire(import.meta.url)('js-yaml');
export async function fileHash(filename, algorithm = 'sha512', encoding = 'base64') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest(encoding);
}
async function verifyFeed(directory, version, feed, binary) {
  const metadata = yaml.load(await readFile(path.join(directory, feed), 'utf8'));
  assert.equal(metadata.version, version, 'Update metadata version differs from the release.');
  assert.equal(metadata.path, binary, `Unexpected update target in ${feed}.`);
  assert.equal(metadata.files?.length, 1, 'Publish one architecture per feed.');
  const entry = metadata.files[0];
  assert.equal(entry.url, binary, 'Unexpected release asset name or URL.');
  assert.equal(entry.size, (await stat(path.join(directory, binary))).size);
  assert.equal(entry.sha512, await fileHash(path.join(directory, binary)), `Asset checksum differs from ${feed}.`);
  assert.equal(metadata.sha512, entry.sha512);
}

export async function verifyReleaseAssets(directory, version, platform = 'all') {
  assert.ok(['all', 'win32', 'linux'].includes(platform), 'Choose all, win32 or linux release assets.');
  const names = [];
  if (platform !== 'linux') {
    const setup = `StykAnimate-${version}-Setup-x64.exe`;
    await verifyFeed(directory, version, 'latest.yml', setup);
    names.push(setup, `${setup}.blockmap`, `StykAnimate-${version}-Portable-x64.exe`, 'latest.yml');
  }
  if (platform !== 'win32') {
    const appimage = `StykAnimate-${version}-linux-x86_64.AppImage`;
    await verifyFeed(directory, version, 'latest-linux.yml', appimage);
    names.push(appimage, 'latest-linux.yml');
  }
  for (const name of names) assert.ok((await stat(path.join(directory, name))).size > 0, `Missing release asset: ${name}`);
  return names.map(name => path.join(directory, name));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const args = process.argv.slice(2);
  const platform = args.find(arg => arg.startsWith('--platform='))?.slice(11) ?? 'all';
  const assets = await verifyReleaseAssets(args.find(arg => !arg.startsWith('--')) || `release/${version}`, version, platform);
  console.log(`Verified ${assets.length} public release assets and SHA-512 checksums for ${version} (${platform}).`);
}
