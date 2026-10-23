import {messageError} from './localized-error.mjs';
import {sceneBackgroundColor} from './pivot/background.mjs';
import {PreviewImages} from './preview-images.mjs';

const imageItems = new WeakMap();
/** Drawing lists are immutable geometry resources, including nested clip
 * primitives. Reuse their image subset without flattening the whole scene on
 * every pointer frame just to discard its lines and polygons. */
export function frameImageDrawables(geometry) {
  const images = [];
  for (const group of geometry?.orderedObjects || []) {
    const items = group.drawables;
    let cached = imageItems.get(items);
    if (!cached) {cached = items.filter(item => item.type === 'image' && item.asset); imageItems.set(items, cached);}
    for (const item of cached) images.push(item);
  }
  return images;
}

export function backgroundImageAssets(report, frame) {
  if (frame && sceneBackgroundColor(report, frame) !== undefined) return [];
  const ids = frame ? new Set([Number(frame.background_id || 0), ...(frame.background_mix ? [Number(frame.background_id_b || 0)] : [])]) : null;
  return (report.backgrounds || []).filter(asset => (!ids || ids.has(Number(asset.background_id))) && ![2, 3, 4].includes(asset.kind) && asset.color === undefined);
}

export function frameImageAssets(geometry) {
  return [...new Set(frameImageDrawables(geometry).map(item => item.asset))];
}

/** A private image set. Incoming loads cannot clear or invalidate the live scene. */
export function createSceneImages({url, signal, checkCurrent = () => {}, imageFactory} = {}) {
  if (!imageFactory && typeof Worker !== 'undefined') {
    const images = new PreviewImages(), assets = new Map();
    let disposed = false;
    const check = () => {if (disposed || signal?.aborted) throw messageError(new DOMException('', 'AbortError'), "errors.renderer.scenePreparationCancelled", {}); checkCurrent();};
    const abort = () => images.clear();
    signal?.addEventListener('abort', abort, {once: true});
    return {images, check, resources: {url, image: address => images.get(address)},
      async load(next) {
        check(); for (const asset of next) assets.set(url(asset), asset);
        const timer = setInterval(() => {try {check();} catch {abort();}}, 50);
        try {await images.prepare([...assets].map(([url, asset]) => ({type: 'image', asset: {...asset, asset_url: url}})), {maxDimension: 2048}); check();}
        finally {clearInterval(timer);}
      },
      detach() {images.worker?.terminate(); images.worker = null; signal?.removeEventListener('abort', abort);},
      dispose() {disposed = true; signal?.removeEventListener('abort', abort); images.clear();},
    };
  }
  imageFactory ||= () => new Image();
  const images = new Map(), pending = new Map(), cancelWaits = new Set(); let disposed = false;
  const check = () => {
    if (disposed || signal?.aborted) throw messageError(new DOMException('', 'AbortError'), "errors.renderer.scenePreparationCancelled", {});
    checkCurrent();
  };
  // A model revision guard can change without an AbortSignal. Keep a stalled
  // decode cancellable in that path too; settled loads leave no timer/listener.
  const waitForDecode = decoded => new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cancelWaits.delete(cancel);
      signal?.removeEventListener('abort', cancel); callback(value);
    };
    const cancel = () => finish(reject, messageError(new DOMException('', 'AbortError'), "errors.renderer.scenePreparationCancelled", {}));
    const poll = () => {
      try {check(); timer = setTimeout(poll, 50);}
      catch (error) {finish(reject, error);}
    };
    cancelWaits.add(cancel); signal?.addEventListener('abort', cancel, {once: true});
    Promise.resolve(decoded).then(value => finish(resolve, value), error => finish(reject, error));
    poll();
  });
  const loadOne = asset => {
    check(); const address = url(asset);
    if (!address) return Promise.reject(messageError(new Error(''), "errors.scenePreparation.anInitialFrameImageHasNoReadableAsset", {}));
    if (pending.has(address)) return pending.get(address);
    const image = imageFactory(); image.decoding = 'async'; images.set(address, image);
    const promise = (async () => {
      image.src = address;
      await waitForDecode(image.complete ? Promise.resolve() : image.decode());
      check();
      if (!image.naturalWidth || !image.naturalHeight) throw messageError(new Error(''), "errors.scenePreparation.anInitialFrameImageCouldNotBeDecoded", {});
    })();
    pending.set(address, promise); return promise;
  };
  return {images, check,
    resources: {url, image: address => images.get(address) || null},
    async load(assets) {
      let next = 0;
      await Promise.all(Array.from({length: Math.min(4, assets.length)}, async () => {
        while (next < assets.length) {check(); await loadOne(assets[next++]);}
      }));
    },
    dispose() {
      disposed = true;
      for (const cancel of cancelWaits) cancel();
      for (const image of images.values()) if (!image.complete) image.src = '';
      images.clear(); pending.clear();
    },
  };
}

export const yieldSceneTask = globalThis.scheduler?.yield ? () => scheduler.yield() : () => new Promise(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {channel.port1.close(); channel.port2.close(); resolve();};
  channel.port2.postMessage(null);
});

export async function consumeSceneSteps(iterator, {sliceMs = 4, signal, checkCurrent = () => {}, yieldControl = yieldSceneTask, onProgress} = {}) {
  if (!Number.isFinite(sliceMs) || sliceMs <= 0 || sliceMs > 16) throw messageError(new RangeError(''), "errors.scenePreparation.scenePreparationSlicesMustBeGreaterThanZero", {});
  const check = () => {if (signal?.aborted) throw messageError(new DOMException('', 'AbortError'), "errors.renderer.scenePreparationCancelled", {}); checkCurrent();};
  const timings = {slices: 0, workMs: 0, maxSliceMs: 0};
  try {
    for (;;) {
      check(); const started = performance.now(); let step;
      do {step = iterator.next();} while (!step.done && performance.now() - started < sliceMs);
      const elapsed = performance.now() - started;
      timings.slices++; timings.workMs += elapsed; timings.maxSliceMs = Math.max(timings.maxSliceMs, elapsed);
      check(); if (step.done) return {value: step.value, timings};
      onProgress?.(step.value); check(); await yieldControl();
    }
  } finally {iterator.return?.();}
}
