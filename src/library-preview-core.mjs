import {timeline, evaluatedFrame, buildGeometry} from './pivot/geometry.mjs';

// Neutral mattes are presentation only. Saved PNGs and artwork stay transparent.
export const LIBRARY_MATTES = {light: '#edf0f4', neutral: '#858b94', dark: '#343b47'};
const linear = n => (n /= 255) <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
const luminance = (r, g, b) => .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
const candidates = Object.entries(LIBRARY_MATTES).map(([name, hex]) => ({name,
  light: luminance(...hex.slice(1).match(/../g).map(n => parseInt(n, 16)))}));

export function libraryPreviewMatte(pixels) {
  const scores = candidates.map(() => 0);
  let weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < .08) continue;
    const light = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    weight += alpha;
    candidates.forEach((candidate, index) => {
      const composite = light * alpha + candidate.light * (1 - alpha);
      const contrast = (Math.max(composite, candidate.light) + .05) / (Math.min(composite, candidate.light) + .05);
      scores[index] += alpha * Math.log(Math.min(7, contrast));
    });
  }
  return weight ? candidates[scores.indexOf(Math.max(...scores))].name : 'neutral';
}

export function libraryPreviewTimeline(report) {
  const rows = timeline(report), fps = Math.max(1, Number(report.fps) || 24);
  let duration = Math.max(1, (rows.at(-1)?.start ?? 0) + (rows.at(-1)?.count ?? 1));
  const types = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
  for (const object of report.keyframes[0].objects) {
    const clip = types.get(object.figure_type_id)?._styk?.movieclip;
    if (clip) duration = Math.max(duration, clip.duration * fps / clip.document.fps);
  }
  return {fps, duration, report, geometry(tick) {
    tick = ((tick % duration) + duration) % duration;
    let low = 0, high = rows.length - 1;
    while (low < high) { const mid = (low + high + 1) >>> 1; if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
    const row = rows[low];
    // The evaluated frame travels with its geometry for generated effects.
    const frame = evaluatedFrame(report, low, (tick - row.start) / Math.max(1, row.count), tick);
    return Object.assign(buildGeometry(report, frame), {sourceFrame: frame});
  }};
}
