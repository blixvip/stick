import {messageError} from './localized-error.mjs';
import {decodePreview, fitImage, imageInfo, imageBlob} from './preview-image.mjs';
import {drawingMetadata} from './drawing-model.mjs';

const tileDrawing=item=>item.type==='image'&&drawingMetadata(item.fig)?.version===2;

export const assetURL = (a) =>
  a?.asset_url ||
  a?.data_url ||
  a?.url ||
  (a?.base64
    ? `data:${a.mime_type || "image/png"};base64,${a.base64}`
    : null) ||
  a?.asset_path_relative ||
  a?.asset_path ||
  a?.path;

const invertMatrix = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return det ? [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det] : null;
};
const applyMatrix = ([a, b, c, d, e, f], x, y) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
const unionRect = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const containsRect = (outer, inner) =>
  outer.x <= inner.x && outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
/** The source-pixel rectangle a decoded bitmap covers. Uncropped variants span
 * their logical (original) size, not their allocated pixel size. */
const bitmapSourceRect = bitmap => bitmap.srcW !== undefined
  ? { x: bitmap.srcX, y: bitmap.srcY, width: bitmap.srcW, height: bitmap.srcH }
  : { x: 0, y: 0, width: bitmap.naturalWidth || bitmap.width, height: bitmap.naturalHeight || bitmap.height };
const bitmapResolution = bitmap => {
  const rect = bitmapSourceRect(bitmap);
  return Math.min(bitmap.width / Math.max(1, rect.width), bitmap.height / Math.max(1, rect.height));
};
/** One decoded variant serves a draw when it covers the needed source region
 * at the needed sampling density. Keeping larger variants avoids re-decoding
 * multi-megabyte sources on every zoom or pan direction change. */
const bitmapCovers = (bitmap, rect, resolution) => {
  if (!bitmap) return false;
  const source = bitmapSourceRect(bitmap);
  // Both axes must carry enough samples. Allow the same whole-pixel rounding
  // as the decoder, avoiding repeated decodes of unchanged odd-size images.
  return containsRect(source, rect) &&
    bitmap.width >= Math.max(1, Math.floor(source.width * resolution + 1e-6)) &&
    bitmap.height >= Math.max(1, Math.floor(source.height * resolution + 1e-6));
};

/** The source-pixel crop and sampling density one image item needs for a draw.
 * `view` is {matrix, width, height} (document→output pixels, as on export) or
 * {visible, scale} (document-space rect and output pixels per document unit,
 * as in playback). Returns null when the placement is unknown, {empty} when
 * the image cannot appear in the output, or {x,y,width,height,density}. */
export function imageDrawNeed(item, sourceWidth, sourceHeight, view) {
  const a = item.asset;
  if (!view || !item.start || !item.end) return null;
  // drawGeometry skips segments without an anchor entirely.
  if (!a?.anchor_length) return { empty: true };
  let visible, outScale;
  if (view.matrix) {
    const inverse = invertMatrix(view.matrix);
    // A singular output projection cannot show any part of the image.
    if (!inverse) return { empty: true };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[0, 0], [view.width, 0], [0, view.height], [view.width, view.height]]) {
      const p = applyMatrix(inverse, px, py);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    visible = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    outScale = Math.max(Math.hypot(view.matrix[0], view.matrix[1]), Math.hypot(view.matrix[2], view.matrix[3]));
  } else { visible = view.visible; outScale = view.scale; }
  if (!visible) return null;
  if (!(outScale > 0)) return { empty: true };
  if (!(sourceWidth > 0 && sourceHeight > 0)) return null;
  const displayWidth = a.display_width ?? sourceWidth, displayHeight = a.display_height ?? sourceHeight;
  if (!(displayWidth > 0 && displayHeight > 0)) return null;
  const kx = displayWidth / sourceWidth, ky = displayHeight / sourceHeight;
  const reverse = Boolean(item.seg?.extra_u8_a ?? item.seg?.extra?.[1]);
  const mirror = Boolean(item.seg?.extra_u8_b ?? item.seg?.extra?.[2]) !== Boolean(item.obj?.image_text_flags);
  const start = reverse ? item.end : item.start;
  const scale = Math.hypot(item.end.x - item.start.x, item.end.y - item.start.y) / a.anchor_length;
  if (!(scale > 0)) return { empty: true };
  const angle = (mirror ? item.angle + a.anchor_angle_rad - Math.PI : item.angle - a.anchor_angle_rad) + (reverse ? Math.PI : 0);
  const cos = Math.cos(angle), sin = Math.sin(angle), mx = mirror ? -1 : 1, anchor = a.anchor_start || { x: 0, y: 0 };
  // Matches drawGeometry: translate(start)·rotate(angle)·scale(±s,s)·translate(-anchor)·display-stretch.
  const matrix = [mx * scale * kx * cos, mx * scale * kx * sin, -scale * ky * sin, scale * ky * cos,
    start.x - mx * scale * cos * anchor.x + scale * sin * anchor.y,
    start.y - mx * scale * sin * anchor.x - scale * cos * anchor.y];
  const inverse = invertMatrix(matrix);
  if (!inverse) return { empty: true };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[visible.x, visible.y], [visible.x + visible.width, visible.y],
    [visible.x, visible.y + visible.height], [visible.x + visible.width, visible.y + visible.height]]) {
    const p = applyMatrix(inverse, px, py);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  // Guard pixels keep nearest-neighbour sampling exact along the crop edges.
  const cx0 = Math.max(0, Math.floor(x0 - 2)), cy0 = Math.max(0, Math.floor(y0 - 2));
  const cx1 = Math.min(sourceWidth, Math.ceil(x1 + 2)), cy1 = Math.min(sourceHeight, Math.ceil(y1 + 2));
  if (cx1 <= cx0 || cy1 <= cy0) return { empty: true };
  return { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0, density: outScale * scale * Math.max(kx, ky) };
}

/** Shared owner of decoded images and bounded encoded-source copies. It has no
 * scene evaluator, GPU state or raster-cache dependency. */
export class ImageResources {
  constructor({
    baseURL = globalThis.location?.href,
    token = "",
    // Soft retention target: assets required together may exceed it at full resolution.
    maxBytes = 96 * 1024 * 1024,
    preview = false,
    hardMaxBytes = Infinity,
    // Absolute ceiling for pixels required simultaneously by one draw. Retention
    // still targets hardMaxBytes; required decodes may exceed it up to this
    // limit rather than refusing an export that would fit in real memory.
    absoluteMaxBytes,
  } = {}) {
    Object.assign(this, { baseURL, token, maxBytes, preview, hardMaxBytes });
    this.absoluteMaxBytes = absoluteMaxBytes ?? hardMaxBytes;
    this.images = new Map();
    this.bytes = 0;
    this.disposed = false;
    this.controller = new AbortController();
    this.sources = new Map(); this.sourceBytes = 0;
    this.reduced = false;
  }

  url = assetURL;
  image = (url) => {
    const image = this.images.get(url);
    if (image) {
      this.images.delete(url);
      this.images.set(url, image);
    }
    return image;
  };
  trimImages(needed, incomingBytes = 0) {
    for (const [url, bitmap] of this.images) {
      if (this.bytes + incomingBytes <= this.maxBytes) break;
      if (needed.has(url)) continue;
      this.images.delete(url);
      this.bytes -= bitmap.width * bitmap.height * 4;
      bitmap.close();
    }
  }
  check = () => {
    if (this.disposed) throw messageError(new DOMException('', "AbortError"), "errors.imageResources.playbackAssetsWereInvalidated", {});
  };
  checkImageBudget(incomingBytes = 0) {
    if (this.bytes + incomingBytes > Math.max(this.hardMaxBytes, this.absoluteMaxBytes)) {
      const error = messageError(new Error(''), "errors.imageResources.thisFrameNeedsMoreImageMemoryThanThe", {});
      error.code = 'export_memory_limit'; throw error;
    }
  }
  async source(url) {
    this.check();
    if (this.sources.has(url)) return this.sources.get(url);
    const blob = await imageBlob(url, this.baseURL, this.token, this.controller.signal); this.check();
    const info = await imageInfo(blob); this.check();
    // Compressed copies are disposable too; source files remain in the document.
    while (this.sources.size && this.sourceBytes + blob.size > this.maxBytes / 2) {
      const [key, value] = this.sources.entries().next().value;
      this.sources.delete(key); this.sourceBytes -= value.blob.size;
    }
    const source = {blob, info};
    if (blob.size <= this.maxBytes / 2) { this.sources.set(url, source); this.sourceBytes += blob.size; }
    return source;
  }
  imageKey(items) {
    return [...new Set(items.filter(item => item.type === 'image').map(item => {
      const d = drawingMetadata(item.fig);
      return d?.version === 2 ? `drawing:${d.celId}:${d.revision}` : this.url(item.asset);
    }))].map(url => {
      if (url.startsWith('drawing:')) return url;
      const image = this.images.get(url), source = image && bitmapSourceRect(image);
      return image ? `${image.width}x${image.height}@${source.x},${source.y},${source.width}x${source.height}` : '0x0';
    }).join(',');
  }
  /** Merge every item's source-space requirement for one URL: 'whole' when any
   * draw needs the complete image, 'none' when none can appear, or a crop
   * rectangle with the maximum required density. */
  urlNeed(items, url, sourceWidth, sourceHeight, view,viewFor) {
    let merged = null, density = 0, whole = !view&&!viewFor;
    for (const item of items) {
      if (item.type !== 'image' || this.url(item.asset) !== url) continue;
      const need = imageDrawNeed(item, sourceWidth, sourceHeight, viewFor?viewFor(item,view):view);
      if (need?.empty) continue;
      // A null need means the placement is unknown — synthetic items like
      // background images have no anchors, and unverified metadata must never
      // hide a visible image. Provably invisible placements return {empty}
      // from imageDrawNeed and are the only needs that skip decoding.
      if (!need) { whole = true; continue; }
      density = Math.max(density, need.density);
      merged = merged ? unionRect(merged, need) : { x: need.x, y: need.y, width: need.width, height: need.height };
    }
    if (whole || !merged) return whole ? 'whole' : 'none';
    merged.density = density;
    return merged;
  }
  /** Decode one asset variant: only the needed source crop at the needed
   * sampling density when that is known, the complete source otherwise. */
  async decodeVariant(blob, need, maxDimension, sourceWidth, sourceHeight) {
    if (need !== 'whole' && need !== 'none' && typeof blob?.arrayBuffer === 'function') {
      const resolution = Math.min(1, need.density);
      const bitmap = await decodePreview(blob, {
        width: sourceWidth, height: sourceHeight, maxPixels: Math.max(1, Math.ceil(need.width * resolution) * Math.ceil(need.height * resolution)),
        maxDimension, crop: need, check: this.check});
      return bitmap;
    }
    return createImageBitmap(blob);
  }
  async preload(items, {scale = 1, maxDimension = 4096, visible, plan,viewFor} = {}) {
    if (this.disposed)
      throw messageError(new DOMException('', "AbortError"), "errors.imageResources.playbackAssetsWereInvalidated", {});
    const view = plan ? {matrix: plan.matrix, width: plan.width, height: plan.height}
      : visible ? {visible, scale} : null;
    // v2 drawing cels decode their tile blob through the provider; the 1×1
    // carrier PNG is never fetched or decoded as an image.
    const needed = new Set(
      items
        .filter((s) => s.type === "image" && !tileDrawing(s))
        .map((s) => this.url(s.asset))
        .filter(Boolean),
    );
    if (this.preview) {
      const requests = new Map();
      // Metadata inspection does not decode pixels. Every simultaneous image gets
      // a share proportional to the pixels actually needed by this draw.
      for (const item of items) {
        if (item.type !== 'image' || tileDrawing(item)) continue;
        const asset = item.asset, url = this.url(asset); if (!url) continue;
        let request = requests.get(url);
        if (!request) {
          // A retained variant already knows the logical dimensions. Fetch or
          // rebuild encoded bytes only if this draw actually needs a new decode.
          const retained = this.images.get(url), source = retained ? null : await this.source(url);
          const width = retained?.naturalWidth || source?.info?.width || asset.width || asset.pixel_width || 4096;
          const height = retained?.naturalHeight || source?.info?.height || asset.height || asset.pixel_height || 4096;
          request = {source, width, height, density: 0, crop: null, whole: false}; requests.set(url, request);
        }
        // Merge every parallax projection before fitting or replacing sources.
        const itemView=viewFor?viewFor(item,view):view;
        const need = imageDrawNeed(item, request.width, request.height, itemView);
        if (need?.empty) continue;
        if (!need) {
          request.whole = true;
          const objectScale = item.start && item.end && asset.anchor_length
            ? Math.hypot(item.end.x - item.start.x, item.end.y - item.start.y) / asset.anchor_length : 1;
          const displayScale = Math.max((asset.display_width ?? request.width) / request.width, (asset.display_height ?? request.height) / request.height);
          const itemScale=viewFor?(itemView?.matrix?Math.max(Math.hypot(itemView.matrix[0],itemView.matrix[1]),Math.hypot(itemView.matrix[2],itemView.matrix[3])):itemView?.scale??scale):scale;
          request.density = Math.max(request.density, 2 ** Math.ceil(Math.log2(Math.max(1 / 65536, objectScale * itemScale * displayScale))));
          continue;
        }
        request.crop = request.crop ? unionRect(request.crop, need) : {x: need.x, y: need.y, width: need.width, height: need.height};
        request.density = Math.max(request.density, 2 ** Math.ceil(Math.log2(Math.max(1 / 65536, Math.min(1, need.density)))));
      }
      let requestedPixels = 0;
      for (const request of requests.values()) {
        if (!request.whole && !request.crop) {request.target = null; continue;}
        const crop = request.whole || !request.crop ? {x: 0, y: 0, width: request.width, height: request.height} : request.crop;
        request.crop = crop;
        request.target = fitImage(crop.width, crop.height, crop.width * crop.height * Math.min(1, request.density) ** 2, maxDimension);
        requestedPixels += request.target.width * request.target.height;
      }
      const allowance = Math.max(1, Math.floor(this.maxBytes / 4)), ratio = Math.min(1, Math.sqrt(allowance / Math.max(1, requestedPixels)));
      const targets = new Map();
      for (const [url, request] of requests) {
        if (!request.target) continue;
        const width = Math.max(1, Math.floor(request.target.width * ratio));
        const resolution = width / request.crop.width;
        targets.set(url, {...request, pixels:Math.max(1, Math.ceil(request.crop.width*resolution)*Math.ceil(request.crop.height*resolution)), resolution});
      }
      // Reserve every simultaneous image's needed pixels before spending spare
      // space on larger retained variants or a union crop for future pans.
      let reservedPixels = [...targets.values()].reduce((sum, target) => sum + target.pixels, 0);
      // Whole-pixel rounding can exceed the proportional allowance slightly.
      // Keep the existing sampling dimensions whenever they already fit.
      if (reservedPixels > allowance) {
        const fraction = allowance / reservedPixels;
        for (const target of targets.values()) {
          target.pixels = Math.max(1, Math.floor(target.pixels * fraction));
          const fitted = fitImage(target.crop.width, target.crop.height, target.pixels, maxDimension);
          target.resolution = Math.min(fitted.width / target.crop.width, fitted.height / target.crop.height);
        }
        reservedPixels = [...targets.values()].reduce((sum, target) => sum + target.pixels, 0);
      }
      const active = new Set(targets.keys());
      for (const [url, target] of targets) {
        const available = Math.max(target.pixels, allowance - (reservedPixels - target.pixels));
        const old = this.images.get(url);
        // Larger covering variants are kept to avoid churn, except under pixel
        // pressure where they would keep this draw over its allowance.
        const oldPixels = old ? old.width * old.height : 0;
        if (bitmapCovers(old, target.crop, target.resolution) && oldPixels <= available &&
            !(ratio < 1 && oldPixels > target.pixels * 1.05)) {
          reservedPixels += oldPixels - target.pixels; targets.delete(url); continue;
        }
        // Coverage grows toward the union of the retained variant while it
        // fits alongside all other images, so pans decode larger regions rarely.
        if (old && ratio >= 1) {
          const union = unionRect(target.crop, bitmapSourceRect(old)), grown = Math.min(1, Math.max(target.resolution, bitmapResolution(old)));
          const pixels = Math.ceil(union.width * grown) * Math.ceil(union.height * grown);
          if (pixels <= available) {
            reservedPixels += pixels - target.pixels; target.crop = union; target.pixels = pixels;
          }
        }
      }
      // Release all superseded variants before decoding replacements. An image
      // outside the draw may be evicted too, even if its URL appeared in items.
      for (const url of targets.keys()) {
        const old = this.images.get(url);
        if (old) { this.images.delete(url); this.bytes -= old.width * old.height * 4; old.close(); }
      }
      this.trimImages(active, [...targets.values()].reduce((sum, target) => sum + target.pixels * 4, 0));
      for (const [url, target] of targets) {
        const source = target.source || await this.source(url);
        const bitmap = await decodePreview(source.blob, {
          width: target.width, height: target.height, maxPixels: target.pixels, maxDimension,
          crop: target.crop, check: this.check});
        this.images.set(url, bitmap); this.bytes += bitmap.width * bitmap.height * 4;
      }
      this.reduced = [...needed].some(url => {
        const image = this.images.get(url), request = requests.get(url);
        return request?.target && image && (image.width + 1 < request.target.width || image.height + 1 < request.target.height);
      });
      this.pressureReduced = ratio < 1;
      return;
    }
    // Release a previous oversized working set even when every new asset is cached.
    this.trimImages(needed);
    this.checkImageBudget();
    for (const url of needed) {
      const retained = this.images.get(url);
      if (retained) {
        const width = retained.naturalWidth || retained.width, height = retained.naturalHeight || retained.height;
        const need = this.urlNeed(items, url, width, height, view,viewFor);
        if (need === 'none' || bitmapCovers(retained, need === 'whole' ? {x:0,y:0,width,height} : need,
            need === 'whole' ? 1 : Math.min(1,need.density))) continue;
      }
      const blob = await imageBlob(url, this.baseURL, this.token, this.controller.signal);
      const metadata = typeof blob?.arrayBuffer === 'function' ? await imageInfo(blob) : null;
      this.check();
      const asset = items.find(item => item.type === 'image' && this.url(item.asset) === url)?.asset;
      const sourceWidth = metadata?.width || asset?.width || 0, sourceHeight = metadata?.height || asset?.height || 0;
      const need = this.urlNeed(items, url, sourceWidth, sourceHeight, view,viewFor);
      const resolution = need === 'whole' || need === 'none' ? 1 : Math.min(1, need.density);
      const old = this.images.get(url);
      if (need === 'none' || bitmapCovers(old, need === 'whole' ? {x: 0, y: 0, width: sourceWidth, height: sourceHeight} : need, resolution)) continue;
      // Tiles and frames that overlap the retained variant decode their union
      // once instead of re-decoding every time the needed region moves.
      let target = need;
      if (old && need !== 'whole' && need !== 'none') {
        const union = unionRect(need, bitmapSourceRect(old)), grown = Math.min(1, Math.max(resolution, bitmapResolution(old)));
        const grownPixels = Math.ceil(union.width * grown) * Math.ceil(union.height * grown);
        if (grownPixels * 4 <= Math.min(this.hardMaxBytes, Math.max(this.maxBytes, 1)) - (this.bytes - old.width * old.height * 4))
          target = {...union, density: grown};
      }
      // Preload owns these variants serially. A crop that no longer covers the
      // draw can be released before decoding its replacement; counting both
      // would reject a moving camera even when each required crop fits.
      if (old) { this.images.delete(url); this.bytes -= old.width * old.height * 4; old.close(); }
      const density = target === 'whole' ? 1 : Math.min(1, target.density);
      const expectedPixels = target === 'whole' ? sourceWidth * sourceHeight
        : Math.ceil(target.width * density) * Math.ceil(target.height * density);
      this.trimImages(needed, expectedPixels * 4);
      this.checkImageBudget(expectedPixels * 4);
      const bitmap = await this.decodeVariant(blob, target, maxDimension, sourceWidth, sourceHeight);
      if (this.disposed) {
        bitmap.close();
        throw messageError(new DOMException('', "AbortError"), "errors.imageResources.playbackAssetsWereInvalidated", {});
      }
      const decodedBytes = bitmap.width * bitmap.height * 4;
      // Evict unused assets, but never reject images required by the current draw.
      this.trimImages(needed, decodedBytes);
      try {this.checkImageBudget(decodedBytes);} catch (error) {bitmap.close(); throw error;}
      // Native drawGeometry deliberately accepts the same image contract in both contexts.
      bitmap.complete = true;
      bitmap.naturalWidth = sourceWidth || bitmap.width;
      bitmap.naturalHeight = sourceHeight || bitmap.height;
      this.images.set(url, bitmap);
      this.bytes += decodedBytes;
    }
  }
  dispose() {
    this.disposed = true;
    this.controller.abort(); this.sources.clear(); this.sourceBytes = 0;
    for (const image of this.images.values()) image.close();
    this.images.clear();
    this.bytes = 0;
  }
}
