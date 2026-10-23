/** Rasterize the selected vector identity; no bitmap tracing or background flattening. */
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Resvg, initWasm} from '../vendor/resvg/index.mjs';

const root = path.resolve(import.meta.dirname, '..');
let initialized;
export async function buildBrandAssets() {
  await (initialized ||= initWasm(await readFile(path.join(root, 'vendor/resvg/index_bg.wasm'))));
  const source = path.join(root, 'assets/brand/svg/stykanimate-app-icon-blue.svg');
  const svg = await readFile(source, 'utf8');
  const output = path.join(root, 'desktop/assets');
  await mkdir(output, {recursive: true});
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
  const rendered = new Map();
  for (const size of sizes) {
    const renderer = new Resvg(svg, {fitTo: {mode: 'width', value: size}, font: {loadSystemFonts: false}});
    const image = renderer.render(), pixels = Buffer.from(image.pixels), png = Buffer.from(image.asPng());
    if (pixels[3] !== 0 || pixels[(size * size - 1) * 4 + 3] !== 0) throw new Error(`Icon corners lost alpha at ${size}px.`);
    if (!pixels.some((value, i) => i % 4 === 3 && value > 0 && value < 255)) throw new Error(`Missing antialiased alpha at ${size}px.`);
    rendered.set(size, {png, pixels}); image.free(); renderer.free();
  }
  // Small Windows images use 32-bit DIBs plus AND masks; 256px uses lossless PNG.
  const icoSizes = sizes.filter(size => size <= 256), directory = Buffer.alloc(6 + icoSizes.length * 16), chunks = [];
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(icoSizes.length, 4);
  let offset = directory.length;
  for (const [index, size] of icoSizes.entries()) {
    const {png, pixels} = rendered.get(size), maskStride = Math.ceil(size / 32) * 4;
    let data = png;
    if (size < 256) {
      data = Buffer.alloc(40 + size * size * 4 + maskStride * size);
      data.writeUInt32LE(40, 0); data.writeInt32LE(size, 4); data.writeInt32LE(size * 2, 8);
      data.writeUInt16LE(1, 12); data.writeUInt16LE(32, 14); data.writeUInt32LE(size * size * 4, 20);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const from = (y * size + x) * 4, to = 40 + ((size - 1 - y) * size + x) * 4;
        data[to] = pixels[from + 2]; data[to + 1] = pixels[from + 1]; data[to + 2] = pixels[from]; data[to + 3] = pixels[from + 3];
        if (!pixels[from + 3]) data[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x % 8);
      }
    }
    const entry = 6 + index * 16;
    directory[entry] = size % 256; directory[entry + 1] = size % 256;
    directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
    chunks.push(data); offset += data.length;
  }
  const icnsParts = [];
  for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]) {
    const png = rendered.get(size).png, header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(8 + png.length, 4);
    icnsParts.push(header, png);
  }
  const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns'); icnsHeader.writeUInt32BE(8 + icnsParts.reduce((n, b) => n + b.length, 0), 4);
  await writeFile(path.join(output, 'stykanimate.ico'), Buffer.concat([directory, ...chunks]));
  await writeFile(path.join(output, 'stykanimate.icns'), Buffer.concat([icnsHeader, ...icnsParts]));
  await writeFile(path.join(output, 'stykanimate.png'), rendered.get(512).png);
  await writeFile(path.join(output, 'stykanimate-1024.png'), rendered.get(1024).png);
  await copyFile(source, path.join(root, 'mark.svg'));
  await copyFile(path.join(root, 'assets/brand/svg/stykanimate-symbol-blue.svg'), path.join(root, 'symbol.svg'));
  await writeFile(path.join(output, 'brand-manifest.json'), JSON.stringify({source: 'assets/brand/svg/stykanimate-app-icon-blue.svg', sourceSHA256: createHash('sha256').update(svg).digest('hex'), color: '#0D99FF', transparentCorners: true, icoSizes, icnsSizes: [16, 32, 64, 128, 256, 512, 1024]}, null, 2) + '\n');
  console.log(`Generated Gesture PNG, ICO (${icoSizes.join(', ')}px), and ICNS; transparent alpha verified.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await buildBrandAssets();
