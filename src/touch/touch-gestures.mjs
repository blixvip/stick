/**
 * Touch gesture classification, pure (docs/TOUCH.md): the hold's time and
 * the slop a still finger may wander, whether two taps make a double tap,
 * and whether a set of fingers that came down and lifted together was a
 * two- or three-finger tap. The DOM adapters (long-press.mjs, canvas-touch.mjs,
 * timeline-touch.mjs) feed them pointer samples and act on the answers.
 */

/** How long a still finger must stay down before it is a hold (ms). */
export const HOLD_MS = 480;
/** How far a finger may wander and still be a tap or a hold (CSS px). */
export const SLOP = 10;
/** The longest gap between the two taps of a double tap (ms), and how far apart they may land (CSS px). */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP = 28;
/** The longest a multi-finger tap may take from the first finger down to the last one up (ms). */
export const MULTI_TAP_MS = 360;

export const distance = (a, b) => Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.y ?? 0) - (a?.y ?? 0));

/** True when `point` has left `origin` by more than `slop`. */
export const beyondSlop = (origin, point, slop = SLOP) => distance(origin, point) > slop;

/** Whether `current` completes a double tap after `previous` (each {x, y, time} where the tap ended). */
export function isDoubleTap(previous, current, {gap = DOUBLE_TAP_MS, slop = DOUBLE_TAP_SLOP} = {}) {
  if (!previous || !current) return false;
  const elapsed = current.time - previous.time;
  return elapsed >= 0 && elapsed <= gap && distance(previous, current) <= slop;
}

/**
 * Tracks the fingers of one multi-finger gesture: from the first finger down
 * until the last one lifts. `down`, `move` and `up` take {id, x, y, time};
 * `up` returns the finished gesture's tap count (2 or 3) when every finger
 * lifted quickly without wandering, else 0; it returns null while fingers are
 * still down. `cancel()` forgets the gesture (a finger was cancelled).
 */
export function createMultiTap({slop = SLOP * 1.5, within = MULTI_TAP_MS} = {}) {
  const fingers = new Map();
  let start = 0, most = 0, wandered = false;
  return {
    down({id, x, y, time}) {
      if (!fingers.size) { start = time; most = 0; wandered = false; }
      fingers.set(id, {x, y});
      most = Math.max(most, fingers.size);
    },
    move({id, x, y}) {
      const origin = fingers.get(id);
      if (origin && beyondSlop(origin, {x, y}, slop)) wandered = true;
    },
    up({id, time}) {
      if (!fingers.delete(id)) return null;
      if (fingers.size) return null;
      const quick = time - start <= within;
      return quick && !wandered && most >= 2 && most <= 3 ? most : 0;
    },
    cancel() { fingers.clear(); wandered = true; },
    get count() { return fingers.size; },
    get most() { return most; },
  };
}
