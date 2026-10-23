/** One pending absolute pointer target per editor gesture. The owner keeps the
 * frame scheduler and commits; this queue never owns document or history state.
 * Modifier changes and substantial angular travel publish the previous target
 * before replacing it, preserving stretch transitions and authored full turns.
 */
export function createPoseInputQueue({apply, isCurrent, schedule}) {
  let owner = null, pending = null, lastAngle = null, travel = 0;
  const clear = () => { owner = null; pending = null; lastAngle = null; travel = 0; };
  const flush = () => {
    const sample = pending;
    pending = null;
    travel = 0;
    if (!sample) return false;
    if (!isCurrent(sample.drag, sample.gesture)) { clear(); return false; }
    apply(sample.event);
    return true;
  };
  return {
    clear,
    flush,
    get pending() { return pending; },
    enqueue({drag, gesture, event, modifiers, angle = null, initialAngle = null}) {
      if (!isCurrent(drag, gesture)) { clear(); return; }
      if (owner?.drag !== drag || owner.gesture !== gesture) {
        clear(); owner = {drag, gesture}; lastAngle = initialAngle;
      }
      // Pointer button transitions are part of the modifier signature too.
      // They must not reinterpret the preceding target on a later RAF.
      if (pending && pending.modifiers !== modifiers) flush();
      const delta = Number.isFinite(angle) && Number.isFinite(lastAngle)
        ? Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle)) : 0;
      if (pending && Math.abs(travel + delta) >= Math.PI / 2) flush();
      if (!isCurrent(drag, gesture)) { clear(); return; }
      travel += delta;
      lastAngle = angle;
      pending = {drag, gesture, event, modifiers};
      schedule();
    },
  };
}
