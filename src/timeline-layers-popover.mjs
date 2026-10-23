import {replaceLocalized, messageAttributes, localizedAttribute, localizedMarkup, localizedText} from './localization-bindings.mjs';

import {t as interfaceText, messageText as sayTimeline} from './localization.mjs';

/**
 * The Simple timeline's Layers popover (experience.md §5.6, reference/42): the
 * frame bar's "Layer ● Bubble ▾" (#layers-button) opens it. It lists the
 * animation's layers top first, as the Advanced layer list does, each with its
 * colour dot, its name (a drawing layer adds a brush glyph), and its eye and
 * lock at rest (quiet glyphs, full contrast while hidden or locked). Clicking a
 * row makes that layer the one Simple edits (its figures are selected, as a row
 * click in Advanced does); the foot adds a layer or a drawing layer.
 *
 * The rows are rebuilt only while the popover is open, from editor changes that
 * touch layers; nothing here runs during playback.
 */
import {createPopover} from './ui/ui-popover.mjs';
import {icon} from './icons.mjs';
import {LAYER_COLORS} from './layers.mjs';
import {layerFolderRows} from './layer-folders.mjs';
import {TimelineLayerView} from './timeline-layer-view.mjs';
import {createLayerFilter} from './timeline-layer-filter.mjs';

const element = (tag, parent, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
};

/**
 * anchor: the frame bar's layer button; editor; run(fn): runs a command and reports its error;
 * overlays, t, topInset: as the other timeline popovers. Returns {toggle(), hide(), isOpen, destroy()}.
 */
export function createLayersPopover({anchor, editor, run, view, overlays = null, t = null, topInset = 0}) {
  const say = (key, params) => sayTimeline(t, key, params);
  const events = new AbortController();
  const ownsView = !view; view ??= new TimelineLayerView(editor);
  let selectedIds = new Set([editor.activeLayerId]), selectionAnchor = editor.activeLayerId, filterPopover, renameFolderId;
  const collapsedFolders = new Set();
  editor.addEventListener('change', event => {
    if (event.detail?.kind === 'document') { collapsedFolders.clear(); selectedIds = new Set([editor.activeLayerId]); selectionAnchor = editor.activeLayerId; }
  }, {signal: events.signal});
  const body = element('div', null, 'tl-layers-body');
  const list = element('div', body, 'tl-layers-list');
  list.setAttribute('role', 'list');
  localizedAttribute(list, 'aria-label', "layers.list", {});
  // The foot: New layer with its word, the rarer kinds as glyphs with tooltips, Group while several layers are
  // selected, and Filter layers at the far end (it narrows the list instead of adding to it).
  const foot = element('div', null, 'tl-layers-foot');
  const footButton = (glyph, key, action, {word = false} = {}) => {
    const button = element('button', foot, word ? 'ui-button' : 'ui-icon-button');
    button.type = 'button';
    button.dataset.size = 'sm';
    if (word) {
      button.dataset.variant = 'ghost';
      localizedMarkup(button, `${icon(glyph)}<span class="ui-label" ${messageAttributes(key, {})}>${say(key)}</span>`);
    } else {
      localizedMarkup(button, icon(glyph));
      localizedAttribute(button, 'aria-label', key, {});
      localizedAttribute(button, 'data-tooltip', key, {});
    }
    button.addEventListener('click', () => run(action), {signal: events.signal});
    return button;
  };
  footButton('plus', "layers.newLayer", () => editor.selectSheetLayer(editor.createLayer().id, {contents: false}), {word: true});
  footButton('brush', "layers.drawingLayer", () => editor.selectSheetLayer(editor.createDrawingLayer().id, {contents: false}));
  footButton('folder', 'layerFolders.newFolder', () => {
    const folder = editor.createLayerFolder(interfaceText('layerFolders.newFolder')); renameFolderId = folder.id; render(); return folder;
  });
  const group = footButton('folder-plus', 'layerFolders.group', () => editor.createLayerFolder(interfaceText('layerFolders.newFolder'), [...selectedIds].filter(id=>editor.getLayer(id)?.kind==='layer'&&view.shown(id))));
  const filter = footButton('filter', 'layerFilter.title', () => {
    filterPopover ??= createLayerFilter({anchor: filter, editor, view, overlays, topInset, selectedIds: () => [...selectedIds].filter(id => view.shown(id))});
    filterPopover.toggle();
  });
  filter.classList.add('tl-layers-filter');
  filter.setAttribute('aria-haspopup', 'dialog'); filter.setAttribute('aria-expanded', 'false');

  let changes = null;
  const popover = createPopover({
    anchor, placement: 'top-start', title: say("layers.title"), titleKey: "layers.title", titleParams: {}, closeLabel: say("layers.close"), closeLabelKey: "layers.close", closeLabelParams: {}, body, foot,
    overlays, t, topInset, className: 'tl-layers-popover', icon: name => icon(name),
    onOpen() {
      changes = new AbortController();
      editor.addEventListener('change', event => {
        const detail = event.detail ?? {};
        if (detail.kind === 'document' || detail.layers || detail.layerSelection || detail.structural || detail.kind === 'history') render();
      }, {signal: changes.signal});
    },
    onClose() { filterPopover?.hide(); changes?.abort(); changes = null; },
  });
  view.addEventListener('change', () => { if (popover.isOpen) render(); }, {signal: events.signal});

  function iconButton(parent, glyph, label, on, action) {
    const button = element('button', parent, 'ui-icon-button');
    button.type = 'button';
    button.dataset.size = 'sm';
    button.dataset.on = String(on);
    localizedMarkup(button, icon(glyph));
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
    button.addEventListener('click', event => { event.stopPropagation(); run(action); });
    return button;
  }
  /** One row per content layer, top first; the active layer is current. */
  function render() {
    selectedIds = new Set([...selectedIds].filter(id => editor.getLayer(id)?.kind === 'layer'));
    if (!selectedIds.has(editor.activeLayerId) && editor.getLayer(editor.activeLayerId)?.kind === 'layer') selectedIds = new Set([editor.activeLayerId]);
    filter.dataset.active = String(view.active);
    group.hidden = [...selectedIds].filter(id => view.shown(id)).length < 2;
    const active = editor.activeLayerId, focused = list.contains(document.activeElement) ? document.activeElement : null;
    const refocus = focused && {id: focused.closest('[data-layer-id]')?.dataset.layerId, index: [...focused.parentElement.children].indexOf(focused),
      pick: focused.matches('.tl-layers-pick')};
    const projected = view.project(layerFolderRows(editor.getLayers().filter(layer => layer.kind === 'layer').reverse(), editor.report._styk.layers, collapsedFolders));
    const rows = projected.map(layer => {
      const row = element('div', null, 'ui-list-row tl-layers-row');
      row.setAttribute('role', 'listitem');
      row.dataset.layerId = layer.id;
      row.dataset.selected = String(selectedIds.has(layer.id));
      row.dataset.hidden = String(layer.visible === false);
      row.setAttribute('aria-current', String(layer.id === active));
      row.style.paddingInlineStart = layer.folderId ? '18px' : '';
      const pick = element('button', row, 'tl-layers-pick');
      pick.type = 'button';
      pick.setAttribute('aria-pressed', String(selectedIds.has(layer.id)));
      pick.setAttribute('aria-description', say("layers.choose", {name: layer.name}));
      if(layer.kind==='folder') {
        localizedMarkup(pick, `${icon(layer.collapsed?'chevron-right':'chevron-down')}${icon('folder')}<span class="ui-list-row-label"></span>`);
        pick.querySelector('.ui-list-row-label').textContent=layer.name;
        pick.setAttribute('aria-expanded',String(!layer.collapsed));
        localizedAttribute(pick,'aria-label',layer.collapsed?'layerFolders.expand':'layerFolders.collapse',{name:layer.name});
        pick.addEventListener('click',()=>{collapsedFolders.has(layer.id)?collapsedFolders.delete(layer.id):collapsedFolders.add(layer.id);render();});
        pick.addEventListener('dblclick', () => renameFolder(row, layer));
        pick.addEventListener('keydown', event => { if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); renameFolder(row, layer); } });
        return row;
      }
      const dot = element('span', pick, 'ui-dot');
      dot.setAttribute('aria-hidden', 'true');
      dot.style.setProperty('--dot', LAYER_COLORS[layer.color] ?? 'var(--sheet-layer)');
      element('span', pick, 'ui-list-row-label', layer.name);
      if (layer.drawing) pick.insertAdjacentHTML('beforeend', icon('brush', 'tl-layers-kind'));
      pick.addEventListener('click', event => run(() => {
        const ids = projected.filter(row => row.kind === 'layer').map(row => row.id);
        if (event.shiftKey) {
          const a = ids.indexOf(selectionAnchor), b = ids.indexOf(layer.id);
          const range = ids.slice(Math.min(a < 0 ? b : a, b), Math.max(a < 0 ? b : a, b) + 1);
          selectedIds = event.ctrlKey || event.metaKey ? new Set([...selectedIds, ...range]) : new Set(range);
        } else if (event.ctrlKey || event.metaKey) {
          selectedIds.has(layer.id) ? selectedIds.delete(layer.id) : selectedIds.add(layer.id);
          if (!selectedIds.size) selectedIds.add(layer.id);
          selectionAnchor = layer.id;
        } else { selectedIds = new Set([layer.id]); selectionAnchor = layer.id; }
        const primary = selectedIds.has(layer.id) ? layer.id : [...selectedIds].at(-1);
        editor.selectSheetLayer(primary, {contents: false}); render();
      }));
      const actions = element('span', row, 'ui-list-row-actions');
      const hidden = layer.visible === false;
      iconButton(actions, hidden ? 'eye-off' : 'eye', say(hidden ? 'layers.show' : 'layers.hide', {name: layer.name}), hidden,
        () => editor.setLayerVisible(layer.id, hidden));
      const lock = iconButton(actions, layer.locked ? 'lock' : 'unlock', say(layer.locked ? 'layers.unlock' : 'layers.lock', {name: layer.name}), Boolean(layer.locked),
        () => editor.setLayerLocked(layer.id, !layer.savedLocked));
      lock.disabled = Boolean(layer.focusLocked);
      return row;
    });
    if (!rows.length) { const empty = element('p', null, 'tl-layer-filter-empty'); localizedText(empty, 'layerTimeline.noMatchingLayers'); rows.push(empty); }
    replaceLocalized(list, ...rows);
    // A row rebuilt under the keyboard keeps the focus on the same control.
    if (refocus) {
      const row = list.querySelector(`[data-layer-id="${CSS.escape(refocus.id ?? '')}"]`);
      (refocus.pick ? row?.querySelector('.tl-layers-pick') : row?.querySelector('.ui-list-row-actions')?.children[refocus.index])?.focus({preventScroll: true});
    }
    if (renameFolderId) {
      const id = renameFolderId; renameFolderId = null;
      const row = list.querySelector(`[data-layer-id="${CSS.escape(id)}"]`), folder = projected.find(layer => layer.id === id);
      if (row && folder) renameFolder(row, folder);
    }
  }

  function renameFolder(row, folder) {
    if (row.querySelector('input')) return;
    const pick = row.querySelector('.tl-layers-pick'), input = element('input', row, 'tl-layers-rename');
    input.value = folder.name; localizedAttribute(input, 'aria-label', 'layerTimeline.rename', {name: folder.name});
    input.maxLength = 160;
    pick.hidden = true; input.focus(); input.select(); let finished = false;
    const finish = save => {
      if (finished) return; finished = true; input.remove(); pick.hidden = false; pick.focus({preventScroll: true});
      if (save && input.value.trim() && input.value.trim() !== folder.name) run(() => editor.renameLayerFolder(folder.id, input.value.trim()));
    };
    input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter'); } });
    input.addEventListener('blur', () => finish(true));
  }

  return {
    toggle() { if (!popover.isOpen) render(); popover.toggle(); },
    hide() { popover.hide('close'); },
    get isOpen() { return popover.isOpen; },
    destroy() { popover.hide('destroy'); filterPopover?.destroy(); changes?.abort(); events.abort(); if (ownsView) view.destroy(); popover.element.remove(); },
  };
}
