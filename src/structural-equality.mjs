/** Exact structural equality for plain document data, as a recursive
 * Object.keys/every comparison computes it, without a closure or filtered key
 * array per element. Retained-geometry and tween caches compare whole poses on
 * every playback tick, so the numeric arrays of large figures dominate.
 *
 * Numbers use Object.is. Arrays compare element by element and, like
 * Array.prototype.every, skip holes in the first argument. Other objects compare
 * their own enumerable string keys. */
export function sameData(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const array = Array.isArray(a);
  if (array !== Array.isArray(b)) return false;
  if (!array) return sameRecord(a, b);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!(i in a)) continue;
    const x = a[i], y = b[i];
    if (!Object.is(x, y) && !(x && y && typeof x === 'object' && typeof y === 'object' && sameData(x, y))) return false;
  }
  return true;
}

/** Record equality over own enumerable string keys. `skip(key, owner)` omits
 * top-level keys of either record; nested values always compare in full. */
export function sameRecord(a, b, skip) {
  let count = 0;
  for (const key of Object.keys(a)) {
    if (skip?.(key, a)) continue;
    count++;
    if (!Object.hasOwn(b, key) || !sameData(a[key], b[key])) return false;
  }
  for (const key of Object.keys(b)) if (!skip?.(key, b)) count--;
  return count === 0;
}
