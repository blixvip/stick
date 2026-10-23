/** Thin ESM wrapper over the vendored bokuweb-zstd-wasm build (MIT).
 *  Single-shot frame compress/decompress on Uint8Array; init() is idempotent. */
let modulePromise;

async function wasmBinary() {
  const url = new URL('./zstd.wasm', import.meta.url);
  if (typeof process !== 'undefined' && process.versions?.node && url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return fs.readFile(url);
  }
  const response = await fetch(url, {credentials: 'same-origin'});
  if (!response.ok) throw new Error(`Cannot load zstd.wasm (${response.status}).`);
  return response.arrayBuffer();
}

export function init() {
  modulePromise ??= (async () => {
    const {Module} = await import('./zstd.js');
    const binary = await wasmBinary();
    await new Promise((resolve, reject) => {
      Module.onRuntimeInitialized = resolve;
      Module.onAbort = reject;
      Module.init(binary);
    });
    return Module;
  })();
  return modulePromise;
}

function copyIn(Module, bytes) {
  const ptr = Module._malloc(bytes.byteLength);
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function copyOut(Module, ptr, length) {
  return Module.HEAPU8.slice(ptr, ptr + length);
}

export async function compress(data, level = 3) {
  const Module = await init();
  const src = copyIn(Module, data);
  const bound = Module._ZSTD_compressBound(data.byteLength);
  const dst = Module._malloc(bound);
  try {
    const size = Module._ZSTD_compress(dst, bound, src, data.byteLength, level);
    if (Module._ZSTD_isError(size)) throw new Error('zstd compression failed.');
    return copyOut(Module, dst, size);
  } finally { Module._free(src); Module._free(dst); }
}

export async function decompress(data, rawLength) {
  const Module = await init();
  const src = copyIn(Module, data);
  const dst = Module._malloc(rawLength);
  try {
    const size = Module._ZSTD_decompress(dst, rawLength, src, data.byteLength);
    if (Module._ZSTD_isError(size)) throw new Error('The StykAnimate file is damaged (zstd decode failed).');
    return copyOut(Module, dst, size);
  } finally { Module._free(src); Module._free(dst); }
}
