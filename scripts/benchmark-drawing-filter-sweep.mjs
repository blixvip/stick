/** Compare current production filters with a frozen control root module, or
 * retain the audit's unmasked-invert prototype mode when no control is given.
 * Timings exclude fixture creation, GC, byte verification and publication.
 */
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {TileStore, TILE_BYTES} from '../src/drawing-tiles.mjs';
import {filterTiles} from '../src/drawing-pixels.mjs';

const args=process.argv.slice(2),controlIndex=args.indexOf('--control-ref');
const controlRef=controlIndex<0?null:args.splice(controlIndex,2)[1];
if(controlIndex>=0&&!controlRef)throw Error('--control-ref requires a Git revision.');
const output = args[0] ?? 'artifacts/codebase-sweep/drawing-filters.json';
const rows = [];
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const sourceFiles=['src/drawing-pixels.mjs','src/drawing-tiles.mjs','src/drawing-model.mjs','src/drawing-worker-operations.mjs','src/drawing-controller.mjs','scripts/benchmark-drawing-filter-sweep.mjs'];
const fingerprint=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update((await readFile(file,'utf8')).replaceAll('\r\n','\n')).digest('hex')])));
const sourceHashes=await fingerprint();
let control,controlSourceHash;
if(controlRef){
  const source=execFileSync('git',['show',`${controlRef}:src/drawing-pixels.mjs`],{encoding:'utf8',maxBuffer:4*1024*1024});
  controlSourceHash=createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex');
  // Both roots use the exact same current dependencies and TileStore class.
  const moduleSource=source.replace(/from\s+(['"])(\.[^'"]+)\1/g,(_,quote,specifier)=>`from ${quote}${pathToFileURL(path.resolve('src',specifier)).href}${quote}`);
  control=(await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)).filterTiles;
}
function tileInvert(store) {
  for (const {tx, ty} of store) {
    const pixels = store.writable(tx, ty).pixels;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) {
      pixels[i] = 255 - pixels[i]; pixels[i + 1] = 255 - pixels[i + 1]; pixels[i + 2] = 255 - pixels[i + 2];
    }
  }
}
function applyMode(store,mode,options){
  if(mode==='control')control(store,options);else if(mode==='production')filterTiles(store,options);else tileInvert(store);
}
function digest(store) {
  const hash = createHash('sha256');
  for (const tile of [...store].sort((a, b) => a.ty - b.ty || a.tx - b.tx)) {
    hash.update(`${tile.tx},${tile.ty}:`); hash.update(tile.pixels);
  }
  return hash.digest('hex');
}
for (const kind of ['dense-1024', 'sparse-4096']) {
  const store = new TileStore(), columns = kind.startsWith('dense') ? 16 : 64;
  for (let y = 0; y < columns; y++) for (let x = 0; x < columns; x++) {
    if (columns === 64 && !((x % 8 === 0 && y % 8 === 0) || (x === 63 && y === 63))) continue;
    const pixels = new Uint8ClampedArray(TILE_BYTES);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([i % 251, (i * 7) % 251, 77, i % 20 ? 255 : 0], i);
    store.set(x, y, pixels);
  }
  const original=digest(store),bounds=store.bounds,scenarios=controlRef?[{kind:'invert'},{kind:'brightness',brightness:21.7,contrast:-36.4},{kind:'hsl',hue:-127.3,saturation:41.6,lightness:-17.4,masked:true},...(kind==='dense-1024'?[{kind:'blur',radius:11}]:[])]:[{kind:'invert'}];
  for(const scenario of scenarios){
    const options={...scenario,bounds};
    if(scenario.masked)options.mask={...bounds,max:255,mask:Uint8Array.from({length:bounds.width*bounds.height},(_,i)=>[0,1,63,128,254,255][i%6])};
    const samples=[],modes=controlRef?['control','production']:['production','tile-prototype'];
    // Warm each filter/options shape before measuring its production control.
    for(let pass=0;pass<(controlRef?3:0);pass++)for(const mode of pass%2?[...modes].reverse():modes){
      const fork=store.fork();globalThis.gc?.();applyMode(fork,mode,options);fork.prune();
    }
    for(let pass=0;pass<6;pass++)for(const mode of pass%2?[...modes].reverse():modes){
      const fork=store.fork();globalThis.gc?.();
      const before=process.memoryUsage(),start=performance.now();
      applyMode(fork,mode,options);
      fork.prune();
      const elapsedMs=performance.now()-start,after=process.memoryUsage();
      samples.push({mode,pass,elapsedMs,arrayBufferDeltaBytes:after.arrayBuffers-before.arrayBuffers,tiles:fork.size,digest:digest(fork)});
      assert.equal(digest(store),original,'Filtering a fork must preserve original pixels.');
    }
    assert.equal(new Set(samples.map(row=>row.digest)).size,1,'Candidate pixels must match exactly.');
    const productionMs=median(samples.filter(row=>row.mode==='production'&&row.pass).map(row=>row.elapsedMs));
    const comparisonMode=controlRef?'control':'tile-prototype',comparisonMs=median(samples.filter(row=>row.mode===comparisonMode&&row.pass).map(row=>row.elapsedMs));
    rows.push({kind,filter:scenario.kind,masked:Boolean(scenario.masked),bounds,tiles:store.size,residentBytes:store.bytes,
      productionMedianMs:productionMs,...(controlRef?{controlMedianMs:comparisonMs,kernelSpeedup:comparisonMs/productionMs}:{candidateMedianMs:comparisonMs,kernelSpeedup:productionMs/comparisonMs}),samples});
    console.log(JSON.stringify({...rows.at(-1),samples:undefined}));
  }
}
assert.deepEqual(await fingerprint(),sourceHashes,'Measured source changed during the comparison.');
await mkdir(path.dirname(output), {recursive: true});
await writeFile(output, JSON.stringify({at: new Date().toISOString(), node: process.version,
  cpu: os.cpus()[0].model, sourceHashes,controlRef,controlSourceHash,mode:controlRef?'frozen-production-control':'audit-prototype',rows,
  scope:'Node filterTiles plus transparent-tile pruning on a copy-on-write fork. Frozen control changes only the drawing-pixels root; all its imports resolve to current production dependencies. Byte hashes and source-fork integrity are checked outside timing.',
  limitations: [controlRef?'Whole-cel invert, brightness/contrast, fractional-mask HSL and 1024x1024 blur. Worker transfer, controller preparation, history encoding, publication and UI latency are not measured.':'Unmasked whole-cel invert only; tile-prototype is an isolated audit candidate, not production code.',
    `${controlRef?'Three untimed alternating warmup pairs, then six':'Six'} alternating sample pairs, first measured pass excluded from medians; Node GC occurs outside timing. ArrayBuffer deltas are live-at-sample observations, not peak process memory.`]}, null, 2));
console.log(JSON.stringify(rows.map(({samples, ...row}) => row)));
