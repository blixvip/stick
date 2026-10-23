/** Check alpha and compare actual PE icon resources against the selected vector icon. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Data, Resource, NtExecutable, NtExecutableResource} from 'resedit';
import {Resvg, initWasm} from '../vendor/resvg/index.mjs';

const root = path.resolve(import.meta.dirname, '..'), assets = path.join(root, 'desktop/assets');
const evidence = path.resolve(process.env.STYK_BRAND_EVIDENCE || path.join(root, 'artifacts/branding'));
const hash = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const result = {assets: [], executables: [], platformBuildsVerified: ['win32-x64']};
await initWasm(await readFile(path.join(root, 'vendor/resvg/index_bg.wasm')));
function verifyPNG(bytes, width) {
  assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), width);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><image width="${width}" height="${width}" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`;
  const renderer = new Resvg(svg), rendered = renderer.render(), pixels = rendered.pixels;
  assert.equal(pixels[3], 0); assert.equal(pixels[(width * width - 1) * 4 + 3], 0);
  assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255));
  rendered.free(); renderer.free();
}
for (const [file, width] of [['stykanimate.png', 512], ['stykanimate-1024.png', 1024]]) {verifyPNG(await readFile(path.join(assets, file)), width); result.assets.push({file, width, alpha: true});}
const ico = Data.IconFile.from(await readFile(path.join(assets, 'stykanimate.ico')));
const iconHash = item => hash(item.isRaw() ? item.bin : item.generate());
const expectedHashes = ico.icons.map(({data}) => iconHash(data));
for (const {data} of ico.icons) {
  const width = data.width || data.bitmapInfo.width;
  if (data.isRaw()) verifyPNG(Buffer.from(data.bin), width);
  else {const pixels = Buffer.from(data.pixels); assert.equal(pixels[3], 0); assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255));}
  result.assets.push({file: 'stykanimate.ico', width, alpha: true});
}
const icns = await readFile(path.join(assets, 'stykanimate.icns'));
assert.equal(icns.toString('ascii', 0, 4), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
for (let offset = 8; offset < icns.length;) {
  const type = icns.toString('ascii', offset, offset + 4), length = icns.readUInt32BE(offset + 4), png = icns.subarray(offset + 8, offset + length), width = png.readUInt32BE(16);
  verifyPNG(png, width); result.assets.push({file: 'stykanimate.icns', type, width, alpha: true}); offset += length;
}
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(metadata.build.win.signExecutable, false); assert.notEqual(metadata.build.win.signAndEditExecutable, false);
assert.equal(await readFile(path.join(root, 'mark.svg'), 'utf8'), await readFile(path.join(root, 'assets/brand/svg/stykanimate-app-icon-blue.svg'), 'utf8'));
assert.equal(await readFile(path.join(root, 'symbol.svg'), 'utf8'), await readFile(path.join(root, 'assets/brand/svg/stykanimate-symbol-blue.svg'), 'utf8'));
if (!process.argv.includes('--assets-only')) {
  const output = path.resolve(process.env.STYK_BRAND_BUILD || path.join(root, 'artifacts/rebrand-release'));
  const asar = createRequire(import.meta.url)('@electron/asar');
  for (const file of ['stykanimate.png', 'stykanimate.ico', 'stykanimate.icns']) assert.equal(hash(asar.extractFile(path.join(output, 'win-unpacked/resources/app.asar'), path.join('desktop', 'assets', file))), hash(await readFile(path.join(assets, file))));
  for (const file of ['mark.svg', 'symbol.svg']) assert.equal(hash(await readFile(path.join(output, 'win-unpacked/resources/web', file))), hash(await readFile(path.join(root, file))));
  const files = [path.join(output, 'win-unpacked/StykAnimate.exe'), path.join(output, `StykAnimate-${metadata.version}-Setup-x64.exe`), path.join(output, `StykAnimate-${metadata.version}-Portable-x64.exe`), path.join(evidence, 'StykAnimate-uninstaller.exe')];
  for (const file of files) {
    const buffer = await readFile(file), executable = NtExecutable.from(buffer), entries = NtExecutableResource.from(executable).entries;
    const groups = Resource.IconGroupEntry.fromEntries(entries);
    assert.ok(groups.length, `No icon resource: ${file}`);
    const actual = groups[0].getIconItemsFromEntries(entries).map(iconHash);
    assert.deepEqual([...actual].sort(), [...expectedHashes].sort(), `First/default icon resource differs: ${file}`);
    result.executables.push({file: path.relative(root, file), bytes: buffer.length, sha256: hash(buffer), defaultIconGroup: groups[0].id, sizes: ico.icons.map(({data}) => data.width || data.bitmapInfo.width), allIconsMatch: true});
  }
  const debug = await readFile(path.join(output, 'builder-debug.yml'), 'utf8');
  assert.ok(debug.includes('$appExe,0'), 'File associations must use the branded executable icon.');
  result.fileAssociationsUseApplicationIcon = true;
} else result.platformBuildsVerified = [];
await mkdir(evidence, {recursive: true});
await writeFile(path.join(evidence, `${process.argv.includes('--assets-only') ? 'assets' : 'native-brand'}-verification.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({passed: true, imageChecks: result.assets.length, executableChecks: result.executables.length, fileAssociations: result.fileAssociationsUseApplicationIcon || 'not packaged'}, null, 2));
