import {messageError} from './localized-error.mjs';
import english from './locales/en-features/exportSampling.mjs';
/** Pivot's three pixel-export sampling choices. */
export const EXPORT_SMOOTHING = Object.freeze([
  Object.freeze({
    value: "edges",
    label: english["exportSampling.smoothEdges"], labelKey: "exportSampling.smoothEdges",
    description:
      english["exportSampling.smoothFigureEdgesWhileKeepingSharpSpritePixels"], descriptionKey: "exportSampling.smoothFigureEdgesWhileKeepingSharpSpritePixels",
  }),
  Object.freeze({
    value: "none",
    label: english["exportSampling.noSmoothing"], labelKey: "exportSampling.noSmoothing",
    description: english["exportSampling.aliasedFigureEdgesAndUnfilteredSpritePixels"], descriptionKey: "exportSampling.aliasedFigureEdgesAndUnfilteredSpritePixels",
  }),
  Object.freeze({
    value: "sprites",
    label: english["exportSampling.smoothSprites"], labelKey: "exportSampling.smoothSprites",
    description:
      english["exportSampling.renderAtTwiceTheSizeThenDownsampleFor"], descriptionKey: "exportSampling.renderAtTwiceTheSizeThenDownsampleFor",
  }),
]);
export function normalizeExportSmoothing(value = "edges") {
  if (!EXPORT_SMOOTHING.some((option) => option.value === value))
    throw messageError(new Error(''), "errors.exportSampling.chooseSmoothEdgesNoSmoothingOrSmoothSprites", {});
  return value;
}

/** Per-frame pixel bound for raster export paths. WebKit canvas surfaces stop
 * rendering past 16.7 MP, so Safari keeps that bound; other engines support
 * larger surfaces, and the export memory plan still rejects any frame the
 * device cannot actually hold. The 16,384-per-side canvas limit is unchanged. */
const SAFARI = typeof navigator !== "undefined" &&
  /^((?!chrome|chromium|crios|edg|android|fxios).)*safari/i.test(navigator.userAgent || "");
export const EXPORT_MAX_PIXELS = SAFARI ? 16777216 : 67108864;

export function exportSamplingSize(width, height, smoothing = "edges") {
  smoothing = normalizeExportSmoothing(smoothing);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    width * height > EXPORT_MAX_PIXELS
  )
    throw messageError(new Error(''), "errors.exportSampling.exportDimensionsMustBeWholePixelsUpTo", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)});
  const factor = smoothing === "sprites" ? 2 : 1;
  if (width * factor > 16384 || height * factor > 16384)
    throw messageError(new Error(''), "errors.exportSampling.smoothSpritesSupportsOutputDimensionsUpTo8", {});
  return {
    width,
    height,
    smoothing,
    factor,
    renderWidth: width * factor,
    renderHeight: height * factor,
  };
}

/** Exact 2× box filter, averaging premultiplied colors to preserve transparent edges. */
export function downsampleExportPixels(source, width, height) {
  if (source.length !== width * height * 16) throw messageError(new Error(''), "errors.exportSampling.invalidSupersampledExportTile", {});
  const output = new Uint8ClampedArray(width * height * 4), stride = width * 8;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = y * stride * 2 + x * 8, b = a + 4, c = a + stride, d = c + 4;
    const alpha = source[a+3] + source[b+3] + source[c+3] + source[d+3], at = (y * width + x) * 4;
    output[at+3] = Math.round(alpha / 4);
    if (alpha) for (let channel = 0; channel < 3; channel++)
      output[at+channel] = Math.round((source[a+channel]*source[a+3] + source[b+channel]*source[b+3] +
        source[c+channel]*source[c+3] + source[d+channel]*source[d+3]) / alpha);
  }
  return output;
}
