/** Consecutive onion frames form one painter-order layer. Never combine ghosts
 * separated by live artwork: anchored and on-top onions keep their order. */
export function onionLayerEnd(entries, start) {
  let end = start + 1;
  while (end < entries.length && entries[end].isOnion) end++;
  return end;
}
export function onionLayerKeys(entries) {
  const keys = [];
  for (let i = 0; i < entries.length; i++) if (entries[i].isOnion) {
    keys.push(entries[i].onionLayerKey ?? entries[i].onionIndex); i = onionLayerEnd(entries, i) - 1;
  }
  return keys;
}

/** Bounded residency for completed viewport layers, shared by both backends.
 * Admission is fixed before drawing, so an oversized visible range cannot
 * evict surfaces it just rendered. Spare surfaces are recycled between keys;
 * no resource is destroyed while the current command encoder may use it. */
export class OnionSurfaceCache {
  constructor({maxBytes, maxEntries = 24, create, dispose}) {
    Object.assign(this, {maxBytes, maxEntries, create, dispose});
    this.entries = new Map(); this.free = []; this.admitted = new Set();
    this.width = this.height = this.bytes = 0;
  }
  begin(keys, width, height) {
    if (width !== this.width || height !== this.height) this.clear();
    this.width = width; this.height = height;
    const count = Math.max(0, Math.min(this.maxEntries, Math.floor(this.maxBytes / (width * height * 4))));
    this.admitted = new Set([...new Set(keys)].slice(0, count));
    for (const [key, entry] of this.entries) if (!this.admitted.has(key)) {
      this.entries.delete(key); this.free.push(entry.surface);
    }
    while (this.entries.size + this.free.length > this.admitted.size) {
      this.dispose(this.free.pop()); this.bytes -= width * height * 4;
    }
  }
  acquire(key) {
    if (!this.admitted.has(key)) return null;
    let entry = this.entries.get(key);
    if (!entry) {
      let surface = this.free.pop();
      if (!surface) {surface = this.create(this.width, this.height); this.bytes += this.width * this.height * 4;}
      entry = {surface}; this.entries.set(key, entry);
    }
    return entry;
  }
  clear() {
    for (const entry of this.entries.values()) this.dispose(entry.surface);
    for (const surface of this.free) this.dispose(surface);
    this.entries.clear(); this.free.length = 0; this.admitted.clear(); this.bytes = 0;
    this.width = this.height = 0;
  }
}
