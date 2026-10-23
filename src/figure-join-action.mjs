/** Figure commands resolve the owning instance, even for a node/branch selection.
 * A genuine multi-figure selection remains ambiguous, as in Pivot.
 */
export function figureJoinAction(editor) {
  const object = editor.object;
  if (!object || (editor.selectedUids.size !== 1 && !editor.branchSelected)) return null;
  return {uid: object.unique_id, kind: object.join ? 'unjoin' : 'join'};
}

/** One iterative pass per join gesture; never traverse ancestors per handle. */
export function joinTargetUids(frame, sourceUid) {
  const objects = frame.objects, source = objects.findIndex(object => object.unique_id === sourceUid);
  if (source < 0) return new Set();
  const children = new Map();
  objects.forEach((object, slot) => {
    if (!object.join) return;
    const target = object.join.target_object_slot;
    if (!children.has(target)) children.set(target, []);
    children.get(target).push(slot);
  });
  const excluded = new Set([source]), queue = [source];
  for (let i = 0; i < queue.length; i++) for (const slot of children.get(queue[i]) ?? [])
    if (!excluded.has(slot)) {excluded.add(slot); queue.push(slot);}
  return new Set(objects.filter((_, slot) => !excluded.has(slot)).map(object => object.unique_id));
}
