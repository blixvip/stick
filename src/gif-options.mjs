import {messageError} from './localized-error.mjs';
/** Native GIF defaults are content-based, separate from edge smoothing. */
export function normalizeGIFDither(value = false) {
  if (typeof value !== "boolean")
    throw messageError(new TypeError(''), "errors.gifOptions.gifDitheringMustBeEnabledOrDisabled", {});
  return value;
}
export function defaultGIFDither(report) {
  if (!report) return false;
  for (const background of report.backgrounds ?? []) {
    if (background.kind !== 2) return true;
  }
  for (const figure of report.figure_types ?? []) {
    if (figure.image_assets?.length) return true;
    if (
      figure.segments?.some(
        (segment) =>
          segment.segment_type === "image" ||
          segment.segment_kind === "image" ||
          segment.primitive_code === 2,
      )
    )
      return true;
  }
  return false;
}
