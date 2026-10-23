import {messageError} from '../localized-error.mjs';
// Editing operations work on frame data, preserving figure definitions and assets.
import {isStatic} from './geometry.mjs';
export function nextIdentity(report) {
  let max = 0;
  for (const f of report.keyframes)
    for (const o of f.objects) max = Math.max(max, Number(o.unique_id));
  if (max >= 0x7ffffffe)
    throw messageError(new Error(''), "errors.structure.noPositiveObjectIdentitiesRemain", {});
  return max + 1;
}
export function frameOrder(frame) {
  return (frame.object_draw_order || frame.objects.map((_, i) => i))
    .map((i) => frame.objects[i]?.unique_id)
    .filter((x) => x !== undefined);
}
export function setOrder(frame, ids) {
  const map = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
  frame.object_draw_order_unique_ids = ids;
  frame.object_draw_order = ids.map((id) => map.get(id));
}
export function normalizeFrame(frame) {
  const ids = frameOrder(frame);
  for (const o of frame.objects)
    if (o.join)
      o.join.target_unique_id =
        frame.objects[o.join.target_object_slot]?.unique_id;
  frame.objects.sort((a, b) => (a.unique_id | 0) - (b.unique_id | 0));
  const slots = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
  frame.objects.forEach((o, i) => {
    o.object_slot = i;
    if (o.join) o.join.target_object_slot = slots.get(o.join.target_unique_id);
  });
  setOrder(frame, ids);
  return frame;
}
export function deleteObject(report, index, slot, geometry) {
  const frame = structuredClone(report.keyframes[index]),
    removed = frame.objects[slot];
  if (!removed) throw messageError(new Error(''), "errors.structure.selectAFigureFirst", {});
  for (let i = 0; i < frame.objects.length; i++) {
    const o = frame.objects[i];
    if (o.join?.target_object_slot === slot) {
      const g = geometry?.objects.get(i);
      if (g) {
        o.root_x = g.root.x;
        o.root_y = g.root.y;
      }
      o.join = null;
    }
  }
  for (const o of frame.objects)
    if (o.join)
      o.join.target_unique_id =
        frame.objects[o.join.target_object_slot]?.unique_id;
  const ids = frameOrder(frame).filter((id) => id !== removed.unique_id);
  frame.objects.splice(slot, 1);
  const slots = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
  frame.objects.forEach((o, i) => {
    o.object_slot = i;
    if (o.join) o.join.target_object_slot = slots.get(o.join.target_unique_id);
  });
  setOrder(frame, ids);
  return frame;
}
/** Joins address object slots, never UIDs or segment-array indices. */
export function resolveJoinSelection(frame, uids, ancestors = false) {
  const objects = frame.objects, requested = new Set(uids), selectedSlots = [], children = new Map();
  objects.forEach((object, slot) => {
    if (requested.has(object.unique_id)) selectedSlots.push(slot);
    if (object.join) {
      const parent = object.join.target_object_slot, list = children.get(parent);
      if (list) list.push(slot); else children.set(parent, [slot]);
    }
  });
  const rootSlots = new Set(), resolved = new Map();
  for (const selected of selectedSlots) {
    let slot = selected;
    if (ancestors) {
      const path = [], visiting = new Set();
      while (!resolved.has(slot) && objects[slot]?.join) {
        if (visiting.has(slot)) throw messageError(new Error(''), "errors.editorSelection.figuresContainACyclicJoin", {});
        visiting.add(slot); path.push(slot); slot = objects[slot].join.target_object_slot;
        if (!objects[slot]) throw messageError(new Error(''), "errors.editorSelection.joinTargetIsMissing", {});
      }
      slot = resolved.get(slot) ?? slot;
      for (const visited of path) resolved.set(visited, slot);
    }
    rootSlots.add(slot);
  }
  const affected = new Set(rootSlots), queue = [...rootSlots];
  for (let q = 0; q < queue.length; q++) for (const slot of children.get(queue[q]) ?? [])
    if (!affected.has(slot)) { affected.add(slot); queue.push(slot); }
  // Stable slot order makes motionless drags compare equal even when selection
  // order differs from native object order.
  const affectedSlots = [], orderedRoots = [];
  objects.forEach((object, slot) => {
    if (affected.has(slot)) affectedSlots.push(slot);
    if (rootSlots.has(slot)) orderedRoots.push(slot);
  });
  return {rootSlots: orderedRoots, affectedSlots,
    rootUids: orderedRoots.map(slot => objects[slot].unique_id),
    affectedUids: affectedSlots.map(slot => objects[slot].unique_id)};
}
export function moveLayer(frame, slot, direction) {
  const out = structuredClone(frame),
    ids = frameOrder(out),
    id = out.objects[slot]?.unique_id,
    index = ids.indexOf(id),
    next = index + direction;
  if (index < 0 || next < 0 || next >= ids.length) return out;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  setOrder(out, ids);
  return out;
}
export function rotationEdits(
  report,
  index,
  slot,
  joint,
  delta,
  includeJoint = true,
  {isolate = false} = {},
) {
  const frame = report.keyframes[index],
    types = new Map(report.figure_types.map((f) => [f.figure_type_id, f])),
    obj = frame.objects[slot],
    fig = types.get(obj.figure_type_id),
    handles = new Set([fig.segments[joint].segment_id]);
  const childHandles = new Map(), byHandle = new Map(fig.segments.map(s => [s.segment_id, s]));
  // The native isolation mask tests the complete auxiliary byte. Ordinary
  // handle visibility uses its static bit; the other source bits are retained.
  const staticGroup = segment => segment.aux_code === undefined ? isStatic(segment) : Boolean(segment.aux_code);
  for (const s of fig.segments) {
    const list = childHandles.get(s.parent_id) || [];
    list.push(s.segment_id); childHandles.set(s.parent_id, list);
  }
  const handleQueue = [...handles];
  for (let q = 0; q < handleQueue.length; q++)
    for (const id of childHandles.get(handleQueue[q]) || [])
      if (!handles.has(id) && (!isolate || staticGroup(byHandle.get(id)))) { handles.add(id); handleQueue.push(id); }
  const changes = [];
  fig.segments.forEach((s, i) => {
    if (handles.has(s.segment_id) && (includeJoint || i !== joint))
      changes.push({
        path: `/keyframes/${index}/objects/${slot}/angles/${i}`,
        value: obj.angles[i] + delta,
      });
  });
  const queue = [{ slot, handles, isolatedBoundary: isolate }],
    visited = new Set([slot]);
  const joinedChildren = new Map();
  frame.objects.forEach((child, i) => {
    if (!child.join) return;
    const list = joinedChildren.get(child.join.target_object_slot) || [];
    list.push(i); joinedChildren.set(child.join.target_object_slot, list);
  });
  for (let q = 0; q < queue.length; q++) {
    const parent = queue[q];
    for (const i of joinedChildren.get(parent.slot) || []) {
      const child = frame.objects[i];
      if (
        !child.join ||
        visited.has(i) ||
        child.join.target_object_slot !== parent.slot ||
        !parent.handles.has(child.join.target_handle_id)
      )
        continue;
      const childFig = types.get(child.figure_type_id);
      // Native isolation crosses a join only when every segment attached
      // directly to that child's origin is static. Once admitted, its entire
      // joined subtree rotates, including dynamic segments farther along it.
      if (parent.isolatedBoundary && !childFig.segments.filter(s => s.parent_id === 0).every(staticGroup)) continue;
      visited.add(i);
      child.angles.forEach((angle, j) =>
        changes.push({
          path: `/keyframes/${index}/objects/${i}/angles/${j}`,
          value: angle + delta,
        }),
      );
      queue.push({
        slot: i,
        handles: new Set([0, ...childFig.segments.map((s) => s.segment_id)]),
        isolatedBoundary: false,
      });
    }
  }
  return changes;
}
