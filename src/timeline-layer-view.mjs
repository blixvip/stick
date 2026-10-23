/** Timeline row visibility belongs to the view session, never saved artwork. */
export class TimelineLayerView extends EventTarget {
  constructor(editor) {
    super();
    this.editor = editor;
    this.hidden = new Set();
    this.events = new AbortController();
    editor.addEventListener('change', event => {
      const detail = event.detail ?? {};
      if (detail.kind === 'document') this.reset();
      else if (detail.layers || detail.structural || detail.kind === 'history') {
        const state = editor.report._styk.layers;
        let changed = false;
        for (const id of this.hidden) if (!['camera', 'scene'].includes(id) && !state.byId[id] && !state.folders?.byId[id]) {
          this.hidden.delete(id); changed = true;
        }
        if (changed) this.dispatchEvent(new Event('change'));
      }
    }, {signal: this.events.signal});
  }
  get active() { return this.hidden.size > 0; }
  shown(id) {
    const layer = this.editor.report._styk.layers.byId[id];
    return !this.hidden.has(id) && !(layer?.folderId && this.hidden.has(layer.folderId));
  }
  folderState(id) {
    const children = this.children(id), shown = children.filter(child => this.shown(child)).length;
    return {checked: children.length ? shown === children.length : this.shown(id), mixed: shown > 0 && shown < children.length};
  }
  children(id) {
    const state = this.editor.report._styk.layers;
    return state.order.filter(child => state.byId[child].folderId === id);
  }
  setShown(id, shown) {
    const state = this.editor.report._styk.layers;
    if (state.folders?.byId[id]) {
      if (shown) { this.hidden.delete(id); for (const child of this.children(id)) this.hidden.delete(child); }
      else this.hidden.add(id);
    } else {
      if (!['camera', 'scene'].includes(id) && !state.byId[id]) return;
      // Checking a child of an excluded folder makes the folder mixed; the
      // remaining children keep their unchecked state.
      const folderId = state.byId[id]?.folderId;
      if (shown && folderId && this.hidden.delete(folderId)) for (const child of this.children(folderId)) this.hidden.add(child);
      shown ? this.hidden.delete(id) : this.hidden.add(id);
    }
    this.dispatchEvent(new Event('change'));
  }
  showOnly(ids) {
    const state = this.editor.report._styk.layers;
    const visible = new Set(ids);
    for (const id of ids) if (state.folders?.byId[id]) for (const child of this.children(id)) visible.add(child);
    this.hidden = new Set(['camera', 'scene', ...state.order, ...Object.keys(state.folders?.byId ?? {})].filter(id => !visible.has(id)));
    // Selected children need their folder container, even when its name wasn't selected.
    for (const id of visible) if (state.byId[id]?.folderId) this.hidden.delete(state.byId[id].folderId);
    this.dispatchEvent(new Event('change'));
  }
  reset() {
    if (!this.active) return;
    this.hidden.clear(); this.dispatchEvent(new Event('change'));
  }
  project(rows) {
    return rows.filter(row => row.kind === 'folder' ? row.layerIds.length ? row.layerIds.some(id => this.shown(id)) : this.shown(row.id) :
      this.shown(row.kind === 'motion' ? 'camera' : row.id));
  }
  destroy() { this.events.abort(); this.hidden.clear(); }
}
