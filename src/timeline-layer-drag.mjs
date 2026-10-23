import {edgeSpeed, edgeStep} from './timeline-navigation.mjs';

/** A folder child's indent in the layer list (features/layer-folders.css). */
const INDENT = 16;
/** The strip at the list's top and foot where a held drag scrolls the rows: thinner than half a row, so the gap above
 * the first row in view and below the last can be reached without the list sliding; the speed rises past the edge. */
const ZONE = 10;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const content = row => row.kind === 'layer' || row.kind === 'folder';

/**
 * Reordering by dragging a row of the layer list (docs/LAYER-FOLDERS.md). A layer drags with the other selected
 * layers when it is one of them; a folder drags its layers as a block. A line shows where the rows will land, indented
 * when that is inside a folder, and a folder lights up when the drop goes into it. Held near the list's top or foot,
 * the drag scrolls the rows. The drop is one layer command; Escape, or a release outside a target, changes nothing.
 */
export const timelineLayerDragMethods = {
  _mountLayerDrag() {
    const labels = this.labelViewport;
    this._on(labels, 'pointerdown', event => this._layerDragDown(event));
    this._on(labels, 'pointermove', event => this._layerDragMove(event));
    this._on(labels, 'pointerup', event => this._layerDragEnd(event, true));
    this._on(labels, 'pointercancel', event => this._layerDragEnd(event, false));
    this._on(labels, 'lostpointercapture', event => this._layerDragEnd(event, false));
    this._on(window, 'keydown', event => {
      if (event.key !== 'Escape' || !this.layerDrag?.active) return;
      event.preventDefault(); event.stopPropagation(); this._layerDragEnd(null, false);
    }, {capture: true});
  },
  _layerDragDown(event) {
    if (event.button !== 0 || event.pointerType === 'touch' || this.layerDrag?.active) return;
    const node = event.target.closest?.('.sheet-layer');
    if (!node || event.target.closest('.sheet-layer-state, .sheet-camera-disclosure, .vfx-channel-trigger, input')) return;
    const row = this.tracks.find(track => track.id === node._id);
    if (row?.kind !== 'layer' && !(row?.kind === 'folder' && row.layerIds.length)) return;
    this.layerDrag = {pointer: event.pointerId, id: row.id, folder: row.kind === 'folder', name: row.name, x: event.clientX, y: event.clientY, active: false};
  },
  _layerDragMove(event) {
    const drag = this.layerDrag;
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.active) {
      // A press released outside the list never reached pointerup here.
      if (!event.buttons) { this.layerDrag = null; return; }
      if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) <= 4 || !this._layerDragStart(drag)) return;
    }
    drag.clientX = event.clientX; drag.clientY = event.clientY;
    this._layerDragTrack();
    const rect = this.labelViewport.getBoundingClientRect(), top = rect.top + (this.layout.pinned ? this.layout.systemHeight : 0), y = event.clientY;
    // A drag that starts in an edge zone scrolls only once it moves toward that edge.
    drag.speed = y > rect.bottom - ZONE && y > drag.y ? edgeSpeed(y - rect.bottom + ZONE) : y < top + ZONE && y < drag.y ? -edgeSpeed(top + ZONE - y) : 0;
    if (!drag.speed) drag.clock = {};
    else if (!drag.frame) drag.frame = requestAnimationFrame(now => this._layerDragStep(now));
  },
  _layerDragStart(drag) {
    const row = this.tracks.find(track => track.id === drag.id);
    if (!row) { this.layerDrag = null; return false; }
    const selected = this.ids.filter(id => this.editor.getLayer(id)?.kind === 'layer');
    drag.ids = new Set(drag.folder ? row.layerIds : selected.includes(drag.id) ? selected : [drag.id]);
    drag.active = true; drag.inside = null; drag.clock = {};
    this._cancelGesture(); this.renaming?.finish(true);
    try { this.labelViewport.setPointerCapture(drag.pointer); } catch { /* the pointer has already lifted */ }
    this.root.dataset.layerDrag = 'true';
    drag.line = document.createElement('div'); drag.line.className = 'sheet-layer-drop'; drag.line.hidden = true; this.labelViewport.append(drag.line);
    drag.chip = document.createElement('div'); drag.chip.className = 'sheet-layer-drag-chip';
    drag.chip.textContent = !drag.folder && drag.ids.size > 1 ? `${drag.name} +${drag.ids.size - 1}` : drag.name; this.root.append(drag.chip);
    this.update();
    return true;
  },
  /** Follows the pointer: the chip beside it, the line at the gap (or the folder lit) the drop would use. */
  _layerDragTrack() {
    const drag = this.layerDrag, target = drag.target = this._layerDropTarget(drag), root = this.root.getBoundingClientRect();
    drag.chip.style.transform = `translate(${Math.round(drag.clientX - root.left + 14)}px,${Math.round(drag.clientY - root.top + 12)}px)`;
    drag.line.hidden = target?.line === undefined;
    if (!drag.line.hidden) { drag.line.style.transform = `translateY(${target.line - 1}px)`; drag.line.style.insetInlineStart = `${8 + (target.folderId ? INDENT : 0)}px`; }
    const inside = target?.inside ?? null;
    if (drag.inside !== inside) { drag.inside = inside; this.update(); }
  },
  _layerDragStep(now) {
    const drag = this.layerDrag;
    if (!drag?.active) return;
    drag.frame = 0;
    if (!drag.speed) return;
    const before = this.scroll.scrollTop, step = edgeStep(drag.clock, drag.speed, now);
    this.scroll.scrollTop = before + step;
    // The end of the list: nothing left to scroll that way.
    if (step && this.scroll.scrollTop === before) return;
    if (step) this._layerDragTrack();
    drag.frame = requestAnimationFrame(next => this._layerDragStep(next));
  },
  /**
   * Where a drop at the pointer lands: {order, folderId, line, inside}. `order` is the whole stack (back to front) with
   * the dragged layers at the gap, `folderId` the folder they join (null: none; undefined for a dragged folder, whose
   * layers stay in it), `line` the gap's y in the label column and `inside` the folder row a drop goes into.
   * Over a layer the gap is above or below it, in its folder; below a folder's last layer, a pointer left of the
   * indent leaves the folder. Over a folder's row the drop goes into it, or above it from the row's top quarter.
   * A dragged folder lands above or below whole folders only. Effect lanes count as part of the layer above them.
   */
  _layerDropTarget(drag) {
    const layout = this.layout, tracks = this.tracks, rect = this.labelViewport.getBoundingClientRect(), scrolled = this._offsetY();
    const first = tracks.findIndex(content);
    if (first < 0) return null;
    const state = this.editor.report._styk.layers, display = state.order.toReversed(), folderOf = id => state.byId[id]?.folderId ?? null;
    const space = Math.max(layout.pinned ? layout.systemHeight : 0, drag.clientY - rect.top) + scrolled;
    let index = clamp(layout.at(space), first, tracks.length - 1), fraction = clamp((space - layout.top(index)) / layout.size(index), 0, 1);
    while (index > first && !content(tracks[index])) { index--; fraction = 1; }
    // The foot of a row's block: the row itself and the effect lanes under it.
    const foot = at => { while (at + 1 < tracks.length && !content(tracks[at + 1])) at++; return at; };
    const lineAt = (at, below) => (below ? layout.top(foot(at)) + layout.size(foot(at)) : layout.top(at)) - scrolled;
    const row = tracks[index], children = id => display.filter(layer => folderOf(layer) === id);
    let gap = null, folderId, line, inside;
    if (drag.folder) {
      const owner = row.kind === 'folder' ? row.id : row.folderId ?? null, block = owner ? children(owner) : [row.id];
      if (owner === drag.id || !block.length) return null;
      const below = fraction >= .5, shown = tracks.map((track, at) => owner ? track.id === owner || track.folderId === owner ? at : -1 : track.id === row.id ? at : -1).filter(at => at >= 0);
      gap = below ? display.indexOf(block.at(-1)) + 1 : display.indexOf(block[0]);
      line = lineAt(below ? shown.at(-1) : shown[0], below);
    } else if (row.kind === 'folder') {
      const kids = children(row.id);
      if (kids.length && fraction < .25) { gap = display.indexOf(kids[0]); folderId = null; line = lineAt(index, false); }
      else { const rest = kids.filter(id => !drag.ids.has(id)); if (rest.length) gap = display.indexOf(rest[0]); folderId = inside = row.id; }
    } else {
      const below = fraction >= .5, next = tracks[foot(index) + 1];
      gap = display.indexOf(row.id) + (below ? 1 : 0); folderId = row.folderId ?? null; line = lineAt(index, below);
      if (below && folderId && next?.folderId !== folderId && drag.clientX - rect.left < 8 + INDENT + 12) folderId = null;
    }
    const rest = display.filter(id => !drag.ids.has(id)), moved = display.filter(id => drag.ids.has(id));
    const at = gap === null ? null : display.slice(0, gap).filter(id => !drag.ids.has(id)).length;
    const next = at === null ? display : [...rest.slice(0, at), ...moved, ...rest.slice(at)];
    return {order: next.toReversed(), folderId, line, inside};
  },
  _layerDragEnd(event, commit) {
    const drag = this.layerDrag;
    if (!drag || event && event.pointerId !== drag.pointer) return;
    this.layerDrag = null;
    if (!drag.active) return;
    cancelAnimationFrame(drag.frame ?? 0); drag.line.remove(); drag.chip.remove(); delete this.root.dataset.layerDrag;
    if (this.labelViewport.hasPointerCapture(drag.pointer)) this.labelViewport.releasePointerCapture(drag.pointer);
    // The release that ends a drag is not a click on the row under it.
    const swallow = click => { click.stopPropagation(); click.preventDefault(); };
    window.addEventListener('click', swallow, {capture: true, once: true}); setTimeout(() => window.removeEventListener('click', swallow, {capture: true}));
    const target = commit ? drag.target : null;
    if (target) {
      if (target.folderId) this.collapsedFolders.delete(target.folderId);
      this._run(() => this.editor.arrangeLayers(target.order, [...drag.ids], target.folderId));
    }
    this.labelSignature = null; this.update();
  },
};
