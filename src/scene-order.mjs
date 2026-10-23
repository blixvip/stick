/** Shared painter order for WebGPU and Canvas editor onion skins. */
function objectGroups(scene, opacity = 1, prefix = '', isOnion = false) {
  const groups = [];
  const add = (g, items) => groups.push({g, items, opacity, isOnion,
    key: prefix ? `${prefix}:${Number(g.obj.unique_id) >>> 0}` : Number(g.obj.unique_id) >>> 0});
  if (scene.orderedObjects) {
    for (const g of scene.orderedObjects) add(g, g.drawables);
  } else {
    const local = new Map();
    for (const item of scene.drawables) { let items = local.get(item.slot); if (!items) local.set(item.slot, items = []); items.push(item); }
    for (const [slot, items] of local) { const g = scene.objects.get(slot); if (g) add(g, items); }
  }
  return groups;
}

export function composeSceneGroups(geometry, onions = [], frame, report) {
  const groups = [], anchored = new Map(), onTop = [], layerSkins = new Map();
  const layers = report?._styk?.layers;
  const layerFor = group => layers.assignments[String(group.g.obj.unique_id)] ?? layers.defaultLayerId;
  for (const [index, onion] of onions.entries()) {
    const skin = objectGroups(onion.geometry, onion.opacity ?? .14, `onion-${index}`, true);
    for (const group of skin) group.onionIndex = index;
    if (onion.showOnTop) { for (const group of skin) onTop.push(group); }
    else if (onion.beforeUid === undefined || onion.beforeUid === null) {
      for (const group of skin) {
        if (!layers) {groups.push(group); continue;}
        const id = layerFor(group), list = layerSkins.get(id) ?? [];
        group.onionLayerKey = `${id}:${index}`;
        list.push(group); layerSkins.set(id, list);
      }
    }
    else {
      const uid = Number(onion.beforeUid) >>> 0, previous = anchored.get(uid);
      if (previous) { for (const group of skin) previous.push(group); } else anchored.set(uid, skin);
    }
  }
  let current = objectGroups(geometry);
  if (anchored.size && frame?.objects) {
    const bySlot = new Map(current.map(group => [group.g.slot, group]));
    current = (frame.object_draw_order || frame.objects.map((_, slot) => slot)).map(slot => {
      const g = geometry.objects.get(Number(slot));
      return bySlot.get(Number(slot)) || (g ? {g, items: [], opacity: 1, key: Number(g.obj.unique_id) >>> 0, isOnion: false} : null);
    }).filter(Boolean);
  }
  const positions = new Map(layers?.order.map((id, index) => [id, index]));
  let nextLayer = 0;
  for (const group of current) {
    if (layers) {
      const position = positions.get(layerFor(group));
      // A blank current exposure still has a place in the layer stack.
      while (nextLayer <= position) for (const skin of layerSkins.get(layers.order[nextLayer++]) ?? []) groups.push(skin);
    }
    const skins = anchored.get(Number(group.g.obj.unique_id) >>> 0);
    if (skins) for (const skin of skins) groups.push(skin);
    if (group.items.length) groups.push(group);
  }
  if (layers) while (nextLayer < layers.order.length) for (const skin of layerSkins.get(layers.order[nextLayer++]) ?? []) groups.push(skin);
  for (const group of onTop) groups.push(group);
  return groups;
}
