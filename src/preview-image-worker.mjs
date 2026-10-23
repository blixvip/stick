import {errorMessageData} from './localized-error.mjs';
import {ImageResources} from './image-resources.mjs';

const moduleReadyMs = performance.now();
let resources;
// ImageResources retains immutable decoded bitmaps. Identity, unlike dimensions,
// proves that a new transferred copy contains exactly the previously sent pixels.
const variants = new WeakMap(); let nextVariant = 0;
self.onmessage = async ({data}) => {
  const images = []; let sent = false;
  const started = performance.now();
  try {
    resources ||= new ImageResources({baseURL: data.baseURL, maxBytes: data.maxBytes, preview: true});
    await resources.preload(data.items, data.options);
    const preloaded = performance.now();
    for (const url of new Set(data.items.map(item => resources.url(item.asset)).filter(Boolean))) {
      const source = resources.images.get(url);
      if (!source) continue;
      if (!variants.has(source)) variants.set(source, ++nextVariant);
      const bitmap = await createImageBitmap(source);
      // Clones drop expandos; the crop rectangle travels in the message instead.
      images.push({url, bitmap, variant: variants.get(source), width: source.naturalWidth, height: source.naturalHeight,
        ...(source.srcW !== undefined ? {srcX: source.srcX, srcY: source.srcY, srcW: source.srcW, srcH: source.srcH} : {})});
    }
    const timings = {moduleReadyMs, preloadMs: preloaded - started, bitmapCopyMs: performance.now() - preloaded,
      images: images.length, decodedBytes: resources.bytes};
    self.postMessage({id: data.id, images, reduced: resources.pressureReduced, timings}, images.map(image => image.bitmap));
    sent = true;
  } catch (error) { self.postMessage({id: data.id, error: error.message, ...errorMessageData(error)}); }
  finally {if (!sent) for (const image of images) image.bitmap.close();}
};
