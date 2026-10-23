import {localizedAttribute, localizedMarkup, localizedText, replaceLocalized} from './localization-bindings.mjs';
import {createPopover} from './ui/ui-popover.mjs';
import {icon} from './icons.mjs';
import {LAYER_COLORS} from './layers.mjs';
import {layerFolderRows} from './layer-folders.mjs';

const ROW = 36;
const element = (tag, parent, className) => {
  const node = document.createElement(tag); node.className = className; parent?.append(node); return node;
};

/** A live checklist shared by both timelines. Its row DOM is viewport bounded. */
export function createLayerFilter({anchor, editor, view, overlays = null, topInset = 0, selectedIds = () => []}) {
  const events = new AbortController(), body = element('div', null, 'tl-layer-filter-body');
  const help = element('p', body, 'tl-layer-filter-help'); localizedText(help, 'layerFilter.help');
  const focusNotice = element('div', body, 'tl-layer-filter-focus');
  localizedText(element('span', focusNotice, ''), 'layerFilter.focusActive');
  const endFocus = element('button', focusNotice, 'ui-button'); endFocus.type = 'button'; endFocus.dataset.size = 'sm'; endFocus.dataset.variant = 'ghost'; localizedText(endFocus, 'layerFilter.endFocus');
  const searchWrap = element('label', body, 'tl-layer-filter-search'); localizedMarkup(searchWrap, icon('search'));
  const search = element('input', searchWrap, ''); search.type = 'search';
  localizedAttribute(search, 'aria-label', 'layerFilter.search'); localizedAttribute(search, 'placeholder', 'layerFilter.search');
  const toolbar = element('div', body, 'tl-layer-filter-tools');
  const count = element('span', toolbar, 'tl-layer-filter-count'); count.setAttribute('role', 'status');
  const selected = element('button', toolbar, 'ui-button'); selected.type = 'button'; selected.dataset.size = 'sm'; selected.dataset.variant = 'ghost'; localizedText(selected, 'layerFilter.onlySelected');
  const viewport = element('div', body, 'tl-layer-filter-list'); viewport.setAttribute('role', 'list'); localizedAttribute(viewport, 'aria-label', 'layerFilter.list');
  const spacer = element('div', viewport, 'tl-layer-filter-spacer');
  const empty = element('p', body, 'tl-layer-filter-empty'); localizedText(empty, 'layerFilter.noMatches'); empty.hidden = true;
  const foot = element('div', null, 'tl-layer-filter-foot');
  const reset = element('button', foot, 'ui-button'); reset.type = 'button'; reset.dataset.variant = 'ghost'; localizedText(reset, 'layerFilter.reset');
  const done = element('button', foot, 'ui-button'); done.type = 'button'; localizedText(done, 'common.done');
  let rows = [], changes, paintedStart = -1;
  const popover = createPopover({anchor, titleKey: 'layerFilter.title', body, foot, className: 'tl-layer-filter-popover',
    placement: 'top-start', overlays, topInset, keyboardScope: true, icon,
    onOpen() {
      changes = new AbortController();
      editor.addEventListener('change', event => {
        const d = event.detail ?? {};
        if (d.kind === 'document') { search.value = ''; popover.hide('document'); return; }
        if (d.layers || d.structural || d.layerSelection || d.kind === 'history') refresh();
      }, {signal: changes.signal});
      view.addEventListener('change', refresh, {signal: changes.signal});
      refresh(); search.focus({preventScroll: true});
    }, onClose() { changes?.abort(); changes = null; rows = []; replaceLocalized(spacer); }});

  function refresh() {
    const all = [editor.getLayer('camera'), editor.getLayer('scene'), ...layerFolderRows(editor.getLayers().filter(row => row.kind === 'layer').reverse(), editor.report._styk.layers)];
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = row => terms.every(term => row.name.toLocaleLowerCase().includes(term));
    const matchingFolders = new Set(all.filter(row => row.kind === 'folder' && matches(row)).map(row => row.id));
    const matchingChildren = new Set(all.filter(row => row.folderId && matches(row)).map(row => row.folderId));
    rows = all.filter(row => matches(row) || row.folderId && matchingFolders.has(row.folderId) || row.kind === 'folder' && matchingChildren.has(row.id));
    const layers = all.filter(row => row.kind !== 'folder');
    focusNotice.hidden = !editor.getLayerFocus();
    localizedText(count, 'layerFilter.count', {shown: layers.filter(row => view.shown(row.id)).length, total: layers.length});
    selected.disabled = !selectedIds().some(id => editor.getLayer(id));
    reset.disabled = !view.active;
    empty.hidden = rows.length > 0; viewport.hidden = !rows.length;
    spacer.style.height = `${rows.length * ROW}px`;
    viewport.style.setProperty('--filter-list-height', `${Math.min(288, rows.length * ROW)}px`);
    viewport.scrollTop = Math.min(viewport.scrollTop, Math.max(0, rows.length * ROW - viewport.clientHeight));
    paint(); popover.update();
  }
  function paint(focusId) {
    const focused = focusId ?? (spacer.contains(document.activeElement) ? document.activeElement.dataset.filterId : null);
    const start = firstRow(), end = Math.min(rows.length, start + Math.ceil((viewport.clientHeight || 288) / ROW) + 4);
    paintedStart = start;
    const nodes = rows.slice(start, end).map((row, offset) => {
      const item = element('div', null, 'tl-layer-filter-item'); item.style.top = `${(start + offset) * ROW}px`;
      item.setAttribute('role', 'listitem'); item.setAttribute('aria-posinset', String(start + offset + 1)); item.setAttribute('aria-setsize', String(rows.length));
      item.dataset.folder = String(row.kind === 'folder'); item.dataset.child = String(Boolean(row.folderId));
      const label = element('label', item, 'ui-check-row');
      const check = element('input', label, 'ui-checkbox'); check.type = 'checkbox'; check.dataset.filterId = row.id;
      const state = row.kind === 'folder' ? view.folderState(row.id) : {checked: view.shown(row.id), mixed: false};
      check.checked = state.checked; check.indeterminate = state.mixed; check.setAttribute('aria-checked', state.mixed ? 'mixed' : String(state.checked));
      localizedAttribute(check, 'aria-label', 'layerFilter.show', {name: row.name});
      if (row.kind === 'folder' || ['camera', 'scene'].includes(row.kind)) localizedMarkup(element('span', label, 'tl-layer-filter-icon'), icon(row.kind));
      else { const dot = element('span', label, 'ui-dot'); dot.style.setProperty('--dot', LAYER_COLORS[row.color] ?? 'var(--sheet-layer)'); dot.setAttribute('aria-hidden', 'true'); }
      const name = element('span', label, 'tl-layer-filter-name'); name.textContent = row.name; name.title = row.name;
      if (row.kind === 'folder') { const n = element('span', label, 'tl-layer-filter-folder-count'); n.textContent = String(row.layerIds.length); }
      check.addEventListener('change', () => view.setShown(row.id, check.checked));
      check.addEventListener('keydown', event => {
        const index = start + offset, next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 :
          event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : null;
        if (next === null) return;
        event.preventDefault(); focusRow(next);
      });
      return item;
    });
    replaceLocalized(spacer, ...nodes);
    if (focused) spacer.querySelector(`[data-filter-id="${CSS.escape(focused)}"]`)?.focus({preventScroll: true});
  }
  function firstRow() { return Math.max(0, Math.floor(viewport.scrollTop / ROW) - 2); }
  function focusRow(index) {
    const top = index * ROW;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW - viewport.clientHeight;
    paint(rows[index]?.id);
  }
  // A scroll rebuilds the rows only when it changes their window, so a row under the keyboard survives the scroll
  // that brought it into view.
  viewport.addEventListener('scroll', () => { if (firstRow() !== paintedStart) paint(); }, {signal: events.signal});
  search.addEventListener('input', () => { viewport.scrollTop = 0; refresh(); }, {signal: events.signal});
  search.addEventListener('keydown', event => { if (event.key === 'ArrowDown' && rows.length) { event.preventDefault(); focusRow(0); } }, {signal: events.signal});
  selected.addEventListener('click', () => view.showOnly(selectedIds()), {signal: events.signal});
  reset.addEventListener('click', () => view.reset(), {signal: events.signal});
  endFocus.addEventListener('click', () => editor.clearLayerFocus(), {signal: events.signal});
  done.addEventListener('click', () => popover.hide('done'), {signal: events.signal});
  return {toggle: () => { if (!popover.isOpen) refresh(); popover.toggle(); }, hide: () => popover.hide(),
    destroy() { popover.hide('destroy'); events.abort(); changes?.abort(); popover.element.remove(); }};
}
