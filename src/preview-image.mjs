import {messageError} from './localized-error.mjs';
/** PNG previews decode scanlines instead of allocating the entire source image.
 * Source dimensions remain separate from the disposable preview's pixel dimensions. */
export async function pngInfo(blob) {
  const header = new Uint8Array(await blob.slice(0, 33).arrayBuffer());
  if (header.length < 33 || ![137,80,78,71,13,10,26,10].every((n, i) => header[i] === n)) return null;
  const view = new DataView(header.buffer);
  const width = view.getUint32(16), height = view.getUint32(20), depth = header[24], color = header[25];
  return {width, height, depth, color, interlace: header[28]};
}

/** Inspect common raster headers without allocating decoded source pixels.
 * Native PIV backgrounds often contain BMPs without separate size metadata. */
export async function imageInfo(blob) {
  const png = await pngInfo(blob); if (png) return png;
  const bytes = new Uint8Array(await blob.slice(0, 54).arrayBuffer()), view = new DataView(bytes.buffer);
  if (bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77) {
    const dib = view.getUint32(14, true);
    const width = dib === 12 ? view.getUint16(18, true) : dib >= 40 && bytes.length >= 54 ? view.getInt32(18, true) : 0;
    const height = dib === 12 ? view.getUint16(20, true) : dib >= 40 && bytes.length >= 54 ? Math.abs(view.getInt32(22, true)) : 0;
    if (width > 0 && height > 0) return {width, height, format:'bmp'};
  }
  if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0,6)).match(/^GIF8[79]a$/)) {
    const width=view.getUint16(6,true),height=view.getUint16(8,true);
    if(width&&height)return {width,height,format:'gif'};
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset=2,width,height,orientation=1;
    // Metadata segments are length-prefixed. Skip their payloads instead of
    // reading compressed image data or allocating a full decoded photograph.
    for(let segments=0;segments<512&&offset+4<=blob.size;segments++){
      const h=new Uint8Array(await blob.slice(offset,offset+4).arrayBuffer());
      if(h[0]!==255)return null;
      const marker=h[1];if(marker===255){offset++;continue;}
      if(marker===218||marker===217)break;
      if(marker===1||(marker>=208&&marker<=216)){offset+=2;continue;}
      const length=h[2]*256+h[3];if(length<2||offset+2+length>blob.size)return null;
      if(marker>=192&&marker<=207&&![196,200,204].includes(marker)&&length>=8){
        const size=new DataView(await blob.slice(offset+5,offset+9).arrayBuffer());
        height=size.getUint16(0);width=size.getUint16(2);
      }
      if(marker===225&&length>=16){
        const exif=new Uint8Array(await blob.slice(offset+4,offset+2+length).arrayBuffer());
        if(String.fromCharCode(...exif.subarray(0,6))==='Exif\0\0'){
          const tiff=new DataView(exif.buffer,6),little=tiff.getUint16(0)===0x4949;
          if((little||tiff.getUint16(0)===0x4d4d)&&tiff.getUint16(2,little)===42){
            const directory=tiff.getUint32(4,little);
            if(directory+2<=tiff.byteLength)for(let i=0,n=tiff.getUint16(directory,little);i<n;i++){
              const p=directory+2+i*12;if(p+12>tiff.byteLength)break;
              if(tiff.getUint16(p,little)===0x112&&tiff.getUint16(p+2,little)===3&&tiff.getUint32(p+4,little)===1)
                orientation=tiff.getUint16(p+8,little);
            }
          }
        }
      }
      offset+=2+length;
    }
    if(width&&height)return orientation>=5&&orientation<=8?{width:height,height:width,format:'jpeg'}:{width,height,format:'jpeg'};
  }
  return null;
}

export async function imageBlob(url, baseURL, token = '', signal) {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(','), header = url.slice(5, comma), content = url.slice(comma + 1);
    if (comma < 0) throw messageError(new Error(''), "errors.previewImage.invalidEmbeddedImage", {});
    if (/;base64/i.test(header) && typeof Uint8Array.fromBase64 === 'function')
      return new Blob([Uint8Array.fromBase64(content)], {type: header.split(';')[0] || 'image/png'});
    const binary = /;base64/i.test(header) ? atob(content) : decodeURIComponent(content);
    const bytes = new Uint8Array(binary.length);
    // Indexed writes avoid a JS iterator/callback and a temporary substring
    // for every byte of embedded, uncompressed native BMP backgrounds.
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], {type: header.split(';')[0] || 'image/png'});
  }
  const resolved = new URL(url, baseURL), headers = {};
  if (token && resolved.origin === new URL(baseURL).origin) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(resolved, {headers, signal});
  if (!response.ok) throw messageError(new Error(''), "errors.previewImage.playbackImageCouldNotLoad", {status: response.status});
  return response.blob();
}

export function fitImage(width, height, maxPixels, maxDimension = 8192) {
  const pixels = Math.max(1, Math.floor(maxPixels));
  const scale = Math.min(1, Math.sqrt(pixels / (width * height)), maxDimension / width, maxDimension / height);
  let fittedWidth = Math.max(1, Math.floor(width * scale)), fittedHeight = Math.max(1, Math.floor(height * scale));
  // Clamping a very thin dimension to one pixel must not push the other axis
  // beyond the pixel allowance (for example, a 1 × 100000 source).
  if (fittedWidth * fittedHeight > pixels) {
    if (fittedWidth >= fittedHeight) fittedWidth = Math.max(1, Math.floor(pixels / fittedHeight));
    else fittedHeight = Math.max(1, Math.floor(pixels / fittedWidth));
  }
  return {width:fittedWidth, height:fittedHeight};
}

const paeth = (a, b, c) => {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
  return x <= y && x <= z ? a : y <= z ? b : c;
};

/** Nearest-neighbour source sampling matches the editor's pixel-art image mode.
 * A crop at native size is also usable by export without a full decoded source. */
export async function samplePNG(blob, info, width, height, {check = () => {}, crop} = {}) {
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[info.color];
  if (info.interlace || !channels || ![1,2,4,8,16].includes(info.depth) ||
      (info.color !== 0 && info.color !== 3 && info.depth < 8)) return null;
  const parts = []; let palette, alpha;
  for (let offset = 8; offset + 12 <= blob.size;) {
    check();
    const chunk = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    const length = new DataView(chunk.buffer).getUint32(0), type = String.fromCharCode(...chunk.subarray(4));
    if (offset + length + 12 > blob.size) throw messageError(new Error(''), "errors.previewImage.truncatedPngImage", {});
    if (type === 'IDAT') parts.push(blob.slice(offset + 8, offset + 8 + length));
    if (type === 'PLTE') palette = new Uint8Array(await blob.slice(offset + 8, offset + 8 + length).arrayBuffer());
    if (type === 'tRNS') alpha = new Uint8Array(await blob.slice(offset + 8, offset + 8 + length).arrayBuffer());
    // Preserve embedded colour profiles through the browser's colour-managed decoder.
    if (type === 'iCCP' || type === 'cHRM' || type === 'gAMA') return null;
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (!parts.length || (info.color === 3 && !palette)) throw messageError(new Error(''), "errors.previewImage.pngImageHasNoPixelData", {});
  const rowBytes = Math.ceil(info.width * channels * info.depth / 8), stride = Math.max(1, Math.ceil(channels * info.depth / 8));
  const reader = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let chunk = new Uint8Array(), offset = 0, prior = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
  const readInto = async target => {
    let written = 0;
    while (written < target.length) {
      check();
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) throw messageError(new Error(''), "errors.previewImage.truncatedPngScanline", {});
        chunk = next.value; offset = 0;
      }
      const count = Math.min(target.length - written, chunk.length - offset);
      target.set(chunk.subarray(offset, offset + count), written); offset += count; written += count;
    }
  };
  const output = new Uint8ClampedArray(width * height * 4), filter = new Uint8Array(1);
  const area = crop || {x: 0, y: 0, width: info.width, height: info.height};
  const sourceY = y => Math.min(info.height - 1, area.y + Math.floor((y + .5) * area.height / height));
  const sample = index => info.depth === 16 ? row[index * 2] * 256 + row[index * 2 + 1]
    : info.depth === 8 ? row[index] : (row[Math.floor(index * info.depth / 8)] >> (8 - info.depth - index * info.depth % 8)) & ((1 << info.depth) - 1);
  const byte = value => Math.round(value * 255 / (2 ** info.depth - 1));
  const transparent = alpha && new DataView(alpha.buffer, alpha.byteOffset, alpha.byteLength);
  let targetY = 0;
  try {
    for (let y = 0; y < info.height && targetY < height; y++) {
      await readInto(filter); await readInto(row);
      if (filter[0] > 4) throw messageError(new Error(''), "errors.previewImage.invalidPngScanlineFilter", {});
      // The filter is constant for a whole scanline. Dispatch once instead of
      // testing all five predictors for every byte of a large source image.
      switch (filter[0]) {
        case 1: for (let i = stride; i < row.length; i++) row[i] += row[i-stride]; break;
        case 2: for (let i = 0; i < row.length; i++) row[i] += prior[i]; break;
        case 3:
          for (let i = 0; i < stride; i++) row[i] += prior[i] >> 1;
          for (let i = stride; i < row.length; i++) row[i] += (row[i-stride] + prior[i]) >> 1;
          break;
        case 4:
          for (let i = 0; i < stride; i++) row[i] += prior[i];
          for (let i = stride; i < row.length; i++) row[i] += paeth(row[i-stride],prior[i],prior[i-stride]);
          break;
      }
      while (targetY < height && sourceY(targetY) === y) {
        if (info.depth === 8 && info.color === 6 && width === area.width) {
          // Native-size RGBA crops already have the output byte layout. Copy
          // the scanline without per-channel calls or numeric conversions.
          output.set(row.subarray(area.x * 4, (area.x + width) * 4), targetY * width * 4);
          targetY++; continue;
        }
        if (info.depth === 8 && info.color === 6) {
          for (let x = 0, out = targetY * width * 4; x < width; x++, out += 4) {
            const index = Math.min(info.width-1, area.x+Math.floor((x+.5)*area.width/width))*4;
            output[out]=row[index]; output[out+1]=row[index+1]; output[out+2]=row[index+2]; output[out+3]=row[index+3];
          }
          targetY++; continue;
        }
        for (let x = 0; x < width; x++) {
          const sx = Math.min(info.width - 1, area.x + Math.floor((x + .5) * area.width / width)), index = sx * channels, out = (targetY * width + x) * 4;
          const r = sample(index), g = channels >= 3 ? sample(index + 1) : r, b = channels >= 3 ? sample(index + 2) : r;
          if (info.color === 3) {
            output[out] = palette[r * 3]; output[out + 1] = palette[r * 3 + 1]; output[out + 2] = palette[r * 3 + 2]; output[out + 3] = alpha?.[r] ?? 255;
          } else {
            output[out] = byte(r); output[out + 1] = byte(g); output[out + 2] = byte(b);
            output[out + 3] = info.color === 4 || info.color === 6 ? byte(sample(index + channels - 1))
              : transparent && ((info.color === 0 && transparent.byteLength >= 2 && r === transparent.getUint16(0)) ||
                (info.color === 2 && transparent.byteLength >= 6 && r === transparent.getUint16(0) && g === transparent.getUint16(2) && b === transparent.getUint16(4))) ? 0 : 255;
          }
        }
        targetY++;
      }
      [prior, row] = [row, prior];
      if (y % 128 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
    }
    // Finish the compressed stream to validate its end/checksum, without retaining
    // the remaining scanlines when only a crop was requested.
    while (!(await reader.read()).done) check();
    return output;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function decodePreview(blob, {width, height, maxPixels, maxDimension = 8192, crop, check = () => {}}) {
  check();
  const info = await imageInfo(blob), png = info && info.depth !== undefined;
  width = info?.width || width; height = info?.height || height;
  let originalWidth = width, originalHeight = height;
  // A crop requests only the source rectangle that can be sampled; decoded
  // bitmaps report it through srcX/srcY/srcW/srcH in source pixels.
  let area = null;
  if (crop && width > 0 && height > 0) {
    const x = Math.max(0, Math.min(width - 1, Math.floor(crop.x))), y = Math.max(0, Math.min(height - 1, Math.floor(crop.y)));
    area = {x, y, width: Math.max(1, Math.min(width, Math.ceil(crop.x + crop.width)) - x),
      height: Math.max(1, Math.min(height, Math.ceil(crop.y + crop.height)) - y)};
  }
  const sourceWidth = area?.width ?? width, sourceHeight = area?.height ?? height;
  let target = sourceWidth > 0 && sourceHeight > 0 ? fitImage(sourceWidth, sourceHeight, maxPixels, maxDimension) : null, bitmap;
  const cropped = area && (area.x > 0 || area.y > 0 || area.width < width || area.height < height);
  // A tiny crop must not force a large source allocation. For ordinary images,
  // however, decoding nearly the whole source scanline-by-scanline is much more
  // expensive than the browser codec. Bound its possible temporary RGBA source
  // to twice the requested pixel allowance, with an absolute 16 MiB ceiling.
  const boundedNativeDecode = png && info.width * info.height <= Math.min(4 * 1024 * 1024, maxPixels * 2);
  if (png && target && typeof DecompressionStream !== 'undefined' &&
      !boundedNativeDecode && (cropped || info.width * info.height > maxPixels)) {
    const pixels = await samplePNG(blob, info, target.width, target.height, {check, crop: area});
    if (pixels) bitmap = await createImageBitmap(new ImageData(pixels, target.width, target.height));
  }
  if (!bitmap) {
    bitmap = area
      ? await createImageBitmap(blob, area.x, area.y, area.width, area.height,
          target ? {resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'pixelated'} : {})
      : await createImageBitmap(blob, target ? {resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'pixelated'} : {});
    // Unknown source dimensions are learned once; subsequent copies are bounded.
    originalWidth ||= bitmap.width; originalHeight ||= bitmap.height;
    const bounded = fitImage(bitmap.width, bitmap.height, maxPixels, maxDimension);
    if (bounded.width !== bitmap.width || bounded.height !== bitmap.height) {
      const source = bitmap;
      try { bitmap = await createImageBitmap(source, {resizeWidth: bounded.width, resizeHeight: bounded.height, resizeQuality: 'pixelated'}); }
      finally { source.close(); }
    }
  }
  try { check(); } catch (error) { bitmap.close(); throw error; }
  bitmap.complete = true; bitmap.naturalWidth = originalWidth; bitmap.naturalHeight = originalHeight;
  if (area) { bitmap.srcX = area.x; bitmap.srcY = area.y; bitmap.srcW = area.width; bitmap.srcH = area.height; }
  return bitmap;
}
