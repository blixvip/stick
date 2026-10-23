import {localizedAttribute} from '../localization-bindings.mjs';
import {setAttr, setText} from '../ui/dom-write.mjs';

/**
 * The open projects as tabs in the top band (experience.md §2, docs/PROJECT-TABS.md),
 * where the project's name used to be.
 *
 *   <div class="project-tabs-list" role="tablist">
 *     <div class="project-tab" role="tab" aria-selected data-project data-state>
 *       <span class="project-tab-art"><canvas></canvas></span>     the stage as the project was last seen
 *       <span class="project-tab-name">Rooftop fight</span>
 *       <span class="project-tab-end"><span class="project-tab-dot"></span><button class="project-tab-close"></button></span>
 *     </div>
 *   </div>
 *
 * A tab's dot means unsaved changes; under the pointer it gives its place to
 * Close. `data-state` is `edited`, `saving`, `saved` (for a moment after a
 * save) or absent. The tabs share the room the band has: they shrink to
 * their picture before anything else in the band folds (features/band.css),
 * so adding a tab never moves the band's other controls.
 *
 * Click or Enter brings a project to the front, middle-click or Delete closes
 * it, a double-click or F2 renames it, a drag reorders, a right-click (or the
 * Menu key) opens its menu. The arrow keys move focus along the tabs without
 * switching, as switching is not free.
 *
 * This module only draws `tabs` (project-tabs.mjs) and reports what the person
 * asked for: `activate(id)`, `close(id)`, `rename(id)`, `menu(id, point)`.
 * It also keeps each project's picture (`setPicture(id, bitmap)`, an
 * ImageBitmap it owns from then on and closes with the tab).
 * It writes only what changed, and never a class on a switch, so the band's
 * measurement (topbar.mjs) runs again only when a tab is added or removed.
 */
const SAVED_MS = 2200;
const PICTURE = Object.freeze({width: 64, height: 40});

export function installProjectTabs(root, {tabs, activate, close, rename, menu, icon, document: doc = root.ownerDocument, now = () => Date.now()} = {}) {
  const list = root.querySelector('.project-tabs-list');
  const elements = new Map(), pictures = new Map(), abort = new AbortController(), signal = abort.signal;
  const idOf = target => target?.closest?.('.project-tab')?.dataset.project ?? null;
  let dragged = null;

  function create(item) {
    const tab = doc.createElement('div'), art = doc.createElement('span'), name = doc.createElement('span'),
      end = doc.createElement('span'), dot = doc.createElement('span'), button = doc.createElement('button');
    tab.className = 'project-tab'; tab.setAttribute('role', 'tab'); tab.dataset.project = item.id; tab.draggable = true;
    art.className = 'project-tab-art'; art.setAttribute('aria-hidden', 'true'); art.innerHTML = icon('scene');
    name.className = 'project-tab-name';
    end.className = 'project-tab-end';
    dot.className = 'project-tab-dot'; dot.setAttribute('aria-hidden', 'true');
    button.type = 'button'; button.className = 'project-tab-close'; button.tabIndex = -1; button.innerHTML = icon('close');
    end.append(dot, button);
    tab.append(art, name, end);
    return {tab, art, name, button, picture: null, saved: null, timer: 0};
  }

  function describe(entry, item) {
    const name = item.name || 'Untitled';
    setText(entry.name, name);
    // "Saved" shows for a moment after a save lands, then the tab is quiet again.
    if (typeof item.saved === 'number' && item.saved !== entry.saved && now() - item.saved < SAVED_MS) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { entry.timer = 0; if (elements.get(item.id) === entry) sync(); }, SAVED_MS - (now() - item.saved));
    }
    entry.saved = item.saved;
    const state = item.saved === 'saving' ? 'saving' : item.dirty ? 'edited' : entry.timer ? 'saved' : null;
    setAttr(entry.tab, 'data-state', state);
    const params = {name};
    if (state === 'edited') localizedAttribute(entry.tab, 'aria-label', 'projectTabs.nameEdited', params);
    else if (state === 'saving') localizedAttribute(entry.tab, 'aria-label', 'projectTabs.nameSaving', params);
    else if (typeof item.saved === 'number') localizedAttribute(entry.tab, 'aria-label', 'projectTabs.nameSavedAt',
      {name, time: {format: 'date', value: item.saved, options: {hour: 'numeric', minute: '2-digit'}}});
    else setAttr(entry.tab, 'aria-label', name);
    localizedAttribute(entry.button, 'aria-label', 'projectTabs.closeName', params);
    const bitmap = pictures.get(item.id) ?? null;
    if (bitmap !== entry.picture) {
      entry.picture = bitmap;
      if (!entry.picture) entry.art.innerHTML = icon('scene');
      else {
        let canvas = entry.art.querySelector('canvas');
        if (!canvas) { canvas = doc.createElement('canvas'); canvas.width = PICTURE.width; canvas.height = PICTURE.height; entry.art.replaceChildren(canvas); }
        drawCover(canvas, entry.picture);
      }
    }
  }

  /** Brings the DOM in line with the list; with a dozen tabs at most, one pass over them is the simplest exact way. */
  function sync() {
    const seen = new Set();
    let previous = null;
    for (const item of tabs.items) {
      let entry = elements.get(item.id);
      if (!entry) { entry = create(item); elements.set(item.id, entry); }
      seen.add(item.id);
      const selected = item.id === tabs.activeId;
      setAttr(entry.tab, 'aria-selected', String(selected));
      if (entry.tab.tabIndex !== (selected ? 0 : -1)) entry.tab.tabIndex = selected ? 0 : -1;
      describe(entry, item);
      const expected = previous ? previous.nextSibling : list.firstChild;
      if (entry.tab !== expected) list.insertBefore(entry.tab, expected);
      previous = entry.tab;
    }
    for (const [id, entry] of elements) if (!seen.has(id)) { clearTimeout(entry.timer); entry.tab.remove(); elements.delete(id); }
    for (const [id, bitmap] of pictures) if (!seen.has(id)) { bitmap.close?.(); pictures.delete(id); }
    if (list.style.getPropertyValue('--project-tabs') !== String(tabs.size)) list.style.setProperty('--project-tabs', String(tabs.size));
  }

  const focusTab = id => elements.get(id)?.tab.focus({preventScroll: true});
  list.addEventListener('click', event => {
    const id = idOf(event.target);
    if (!id) return;
    if (event.target.closest('.project-tab-close')) { event.stopPropagation(); close(id); return; }
    activate(id);
  }, {signal});
  // The middle button closes; its press must not start the browser's autoscroll.
  list.addEventListener('mousedown', event => { if (event.button === 1 && idOf(event.target)) event.preventDefault(); }, {signal});
  list.addEventListener('auxclick', event => { const id = idOf(event.target); if (id && event.button === 1) { event.preventDefault(); close(id); } }, {signal});
  list.addEventListener('dblclick', event => { const id = idOf(event.target); if (id && !event.target.closest('.project-tab-close')) rename(id); }, {signal});
  list.addEventListener('contextmenu', event => {
    const id = idOf(event.target);
    if (!id) return;
    event.preventDefault();
    const box = elements.get(id).tab.getBoundingClientRect();
    // The Menu key reports no pointer position: open under the tab.
    menu(id, event.clientX || event.clientY ? {left: event.clientX, bottom: event.clientY, invoker: elements.get(id).tab} : {left: box.left, bottom: box.bottom, invoker: elements.get(id).tab});
  }, {signal});
  list.addEventListener('keydown', event => {
    const id = idOf(event.target);
    if (!id || event.target.closest('.project-tab-close') || event.ctrlKey || event.metaKey || event.altKey) return;
    const index = tabs.indexOf(id), rtl = getComputedStyle(list).direction === 'rtl';
    const step = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    if (step) focusTab(tabs.items[(index + step + tabs.size) % tabs.size].id);
    else if (event.key === 'Home') focusTab(tabs.items[0].id);
    else if (event.key === 'End') focusTab(tabs.items.at(-1).id);
    else if (event.key === 'Enter' || event.key === ' ') activate(id);
    else if (event.key === 'Delete') close(id);
    else if (event.key === 'F2') rename(id);
    else return;
    event.preventDefault(); event.stopPropagation();
  }, {signal});

  // Reordering: the tab being dragged dims, and a line shows where it would land.
  const clearDrop = () => { for (const {tab} of elements.values()) tab.removeAttribute('data-drop'); };
  list.addEventListener('dragstart', event => {
    dragged = idOf(event.target);
    if (!dragged) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', '');
    elements.get(dragged).tab.dataset.dragging = '';
  }, {signal});
  list.addEventListener('dragover', event => {
    const id = idOf(event.target);
    if (!dragged || !id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = elements.get(id).tab.getBoundingClientRect(), after = event.clientX > box.left + box.width / 2;
    clearDrop();
    if (id !== dragged) elements.get(id).tab.dataset.drop = after ? 'after' : 'before';
  }, {signal});
  list.addEventListener('drop', event => {
    const id = idOf(event.target);
    if (!dragged || !id) return;
    event.preventDefault();
    const after = elements.get(id).tab.dataset.drop === 'after', from = tabs.indexOf(dragged);
    let to = tabs.indexOf(id) + (after ? 1 : 0);
    if (from < to) to--;
    tabs.move(dragged, to);
  }, {signal});
  list.addEventListener('dragend', () => { if (dragged) elements.get(dragged)?.tab.removeAttribute('data-dragging'); dragged = null; clearDrop(); }, {signal});

  tabs.addEventListener('change', sync, {signal});
  sync();
  return {
    sync,
    /** The picture of a project: drawn in its tab now, kept for the switcher. A closed project's bitmap is released. */
    setPicture(id, bitmap) {
      if (!bitmap) return false;
      if (!tabs.get(id)) { bitmap.close?.(); return false; }
      pictures.get(id)?.close?.();
      pictures.set(id, bitmap);
      const entry = elements.get(id), item = tabs.get(id);
      if (entry && item) describe(entry, item);
      return true;
    },
    picture: id => pictures.get(id) ?? null,
    element: id => elements.get(id)?.tab ?? null,
    focus: (id = tabs.activeId) => focusTab(id),
    destroy() {
      abort.abort();
      for (const entry of elements.values()) { clearTimeout(entry.timer); entry.tab.remove(); }
      for (const bitmap of pictures.values()) bitmap.close?.();
      elements.clear(); pictures.clear();
    },
  };
}

/** Draws `picture` (an ImageBitmap or a canvas) to fill `canvas`, cropped around its centre. */
export function drawCover(canvas, picture) {
  const context = canvas.getContext('2d');
  if (!context || !picture?.width || !picture?.height) return false;
  const scale = Math.max(canvas.width / picture.width, canvas.height / picture.height);
  const width = canvas.width / scale, height = canvas.height / scale;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(picture, (picture.width - width) / 2, (picture.height - height) / 2, width, height, 0, 0, canvas.width, canvas.height);
  return true;
}
