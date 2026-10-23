import {messageError} from './localized-error.mjs';

/**
 * The open projects of one window: their order in the band, which one is in
 * front and the order they were last used in. This is a list of records, free
 * of the editor, the renderer and the DOM. project-tabs-host.mjs moves the
 * documents; shell/project-tabs-view.mjs draws the tabs.
 *
 * A record is {id, name, dirty, saved, ...}: `id` is this list's own, the rest
 * belongs to whoever opened the project. Exactly one project is in front
 * whenever the list is not empty.
 */
export const MAX_OPEN_PROJECTS = 12;

export class ProjectTabs extends EventTarget {
  constructor({limit = MAX_OPEN_PROJECTS} = {}) {
    super();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('The open project limit must be a positive integer.');
    this.limit = limit;
    this.items = [];
    this.activeId = null;
    this.recent = [];
    this.serial = 0;
  }

  get size() { return this.items.length; }
  get full() { return this.items.length >= this.limit; }
  get active() { return this.get(this.activeId); }
  get(id) { return this.items.find(item => item.id === id) ?? null; }
  indexOf(id) { return this.items.findIndex(item => item.id === id); }
  /** The open projects, the one in front first, then the others most recently used first. */
  get recency() { return this.recent.map(id => this.get(id)).filter(Boolean); }

  _changed(kind, detail = {}) {
    const event = new Event('change');
    Object.defineProperty(event, 'detail', {value: {kind, ...detail}});
    this.dispatchEvent(event);
  }

  /** Opens a project in front, beside the one that was there. */
  add(record = {}) {
    if (this.full) throw messageError(new Error(''), 'errors.projectTabs.closeAProjectToOpenAnother', {count: this.limit});
    const item = {name: '', dirty: false, saved: null, ...record, id: `project-${++this.serial}`};
    const at = this.indexOf(this.activeId);
    this.items.splice(at < 0 ? this.items.length : at + 1, 0, item);
    this.activeId = item.id;
    this.recent = [item.id, ...this.recent];
    this._changed('add', {id: item.id});
    return item;
  }

  /** Brings an open project to the front. Returns false when it already is. */
  activate(id) {
    if (!this.get(id)) throw messageError(new Error(''), 'errors.editorSessions.thisProjectIsNoLongerOpen', {});
    if (id === this.activeId) return false;
    this.activeId = id;
    this.recent = [id, ...this.recent.filter(other => other !== id)];
    this._changed('activate', {id});
    return true;
  }

  /** The project that comes to the front when `id` closes: the one used before it. */
  successor(id = this.activeId) {
    return this.recency.find(item => item.id !== id) ?? null;
  }

  /**
   * Closes a project. The one in front can close only once another is in
   * front, or as the last one; its owner activates the successor first.
   */
  remove(id) {
    const index = this.indexOf(id);
    if (index < 0) return null;
    if (id === this.activeId && this.items.length > 1) throw new Error('Bring another project to the front before closing this one.');
    const [item] = this.items.splice(index, 1);
    this.recent = this.recent.filter(other => other !== id);
    if (id === this.activeId) this.activeId = null;
    this._changed('remove', {id});
    return item;
  }

  /** Moves a tab to `index` in the band. */
  move(id, index) {
    const from = this.indexOf(id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(this.items.length - 1, Math.trunc(index)));
    if (to === from) return false;
    this.items.splice(to, 0, ...this.items.splice(from, 1));
    this._changed('move', {id});
    return true;
  }

  /** Changes what a tab shows (its name, its unsaved state). Writes and notifies only what changed. */
  update(id, patch) {
    const item = this.get(id);
    if (!item) return false;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || Object.is(item[key], value)) continue;
      item[key] = value; changed = true;
    }
    if (changed) this._changed('update', {id});
    return changed;
  }

  /** The tab `step` places from the one in front, around the band's ends. */
  neighbour(step = 1) {
    const index = this.indexOf(this.activeId);
    if (index < 0 || this.items.length < 2) return null;
    return this.items[((index + step) % this.items.length + this.items.length) % this.items.length];
  }

  /** How many open projects have unsaved changes, and their records. */
  get unsaved() { return this.items.filter(item => item.dirty); }
}
