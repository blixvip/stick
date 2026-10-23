/** Conservative culling for the exact polyline points Canvas already paints.
 * Keep unknown/non-finite geometry. The caller must exclude effects that sample
 * outside the clip; stroke state still advances before this test is applied. */
export function primitiveOutsideRasterClip(item, clip, width) {
  if (!clip || !Number.isFinite(width)) return false;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  if (item.type === 'circle') {
    const radius = (Math.abs(item.length) + width) / 2;
    const x = (item.start.x + item.end.x) / 2, y = (item.start.y + item.end.y) / 2;
    left = x - radius; right = x + radius; top = y - radius; bottom = y + radius;
  } else if (item.type === 'line' || item.type === 'poly') {
    for (const point of item.points) {
      left = Math.min(left, point.x); right = Math.max(right, point.x);
      top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
    }
    // A square cap may extend farther along an axis than half the width.
    const margin = width * Math.SQRT1_2;
    left -= margin; right += margin; top -= margin; bottom += margin;
  } else return false;
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) return false;
  const guard = clip.guard || 0;
  return right < clip.x - guard || bottom < clip.y - guard ||
    left > clip.x + clip.width + guard || top > clip.y + clip.height + guard;
}
