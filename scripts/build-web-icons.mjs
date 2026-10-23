// Renders the install icons of the web build from mark.svg into web/icons/.
// The PNGs are committed; run this only when the mark changes:
//
//   node scripts/build-web-icons.mjs
//
// "any" icons keep the mark's rounded square. The maskable icon and the Apple
// touch icon are full-bleed (the platform applies its own mask or corners), with
// the figure inside the maskable safe zone (the centred 80% circle).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../tests/support/playwright.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'web', 'icons');

const mark = await readFile(path.join(appRoot, 'mark.svg'), 'utf8');
if (!mark.includes('rx="112"') || !mark.includes('<g transform="translate(91 48) scale(.65)">')) {
  throw new Error('mark.svg changed shape; update the full-bleed variants in scripts/build-web-icons.mjs.');
}
// The same drawing on a square with no rounded corners; `inset` shrinks the figure toward the centre.
const fullBleed = (inset) => mark.replace('rx="112"', 'rx="0"').replace('<g transform="translate(91 48) scale(.65)">',
  `<g transform="translate(256 256) scale(${inset}) translate(-256 -256)"><g transform="translate(91 48) scale(.65)">`).replace(/<\/g><\/svg>\s*$/, '</g></g></svg>');

const ICONS = [
  { file: 'icon-192.png', size: 192, svg: mark },
  { file: 'icon-512.png', size: 512, svg: mark },
  { file: 'icon-maskable-512.png', size: 512, svg: fullBleed(0.86) },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed(1) },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
try {
  const page = await browser.newPage();
  for (const { file, size, svg } of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await writeFile(path.join(output, file), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log(`web/icons/${file}`);
  }
} finally { await browser.close(); }
