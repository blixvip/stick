import {t as interfaceText} from './localization.mjs';
import {icon} from './icons.mjs';
import {openMenu} from './ui/ui-menu.mjs';
import {LAYER_COLORS} from './layers.mjs';

const layerColorMessages = {blue: 'layerTimeline.color.blue', violet: 'layerTimeline.color.violet', rose: 'layerTimeline.color.rose', orange: 'layerTimeline.color.orange', green: 'layerTimeline.color.green', teal: 'layerTimeline.color.teal'};

/** A layer menu keeps its common edits at the root and related commands together. */
export function timelineLayerMenuGroups(host) {
  const editor = host.editor, selected = editor.getLayer(host.selectedTrackId);
  if (!selected) return [];
  const own = selected.kind === 'layer';
  const ids = host.ids.filter(id => editor.getLayer(id)?.kind === 'layer');
  const focusIds = ids.length > 1 ? ids : [selected.id];
  const command = (labelKey, symbol, action, options = {}) => ({label: interfaceText(labelKey), labelKey, symbol, action, ...options});
  return [
    [{heading: selected.name},
      own && command('layerTimeline.renameLayer', 'text', () => { const node = host.labels.find(node => !node.hidden && node._id === selected.id); if (node) host._renameLayer(node); }, {shortcut: 'F2'}),
      own && {label: interfaceText('layerTimeline.layerColor'), labelKey: 'layerTimeline.layerColor', symbol: 'palette', submenu: [[
        command('layerTimeline.noColor', null, () => editor.setLayerColor([selected.id], null), {swatch: 'var(--sheet-layer)', checked: !selected.color}),
        ...Object.keys(LAYER_COLORS).map(color => command(layerColorMessages[color], null, () => editor.setLayerColor([selected.id], color), {swatch: LAYER_COLORS[color], checked: selected.color === color})),
      ]]},
    ],
    [own && {label: interfaceText('timelineMenu.focus'), labelKey: 'timelineMenu.focus', symbol: 'layers', submenu: [[
      command(ids.length > 1 ? 'layerTimeline.focusSelectedLayers' : 'layerTimeline.focusThisLayer', 'layers', () => host.focusSelectedLayers({ids: focusIds})),
      command('timelineOrganization.focusAndLock', 'lock', () => host.focusSelectedLayers({ids: focusIds, lock: true})),
    ], [host.focusedLayerIds && command('layerTimeline.showAllLayers', 'layers', () => host.focusSelectedLayers())]]},
      {label: interfaceText('timelineMenu.organize'), labelKey: 'timelineMenu.organize', symbol: 'folder', submenu: [
        host.layerFolderMenuItems(),
        own ? [
          command('layerTimeline.moveLayerUp', 'up', () => host.reorderLayer(-1), {disabled: editor.report._styk.layers.order.at(-1) === selected.id}),
          command('layerTimeline.moveLayerDown', 'down', () => host.reorderLayer(1), {disabled: editor.report._styk.layers.order[0] === selected.id}),
        ] : [],
      ]},
      {label: interfaceText('timelineMenu.visibilityAndLock'), labelKey: 'timelineMenu.visibilityAndLock', symbol: 'eye', submenu: [[
        command(selected.visible === false ? 'layerTimeline.showLayer' : 'layerTimeline.hideLayer', selected.visible === false ? 'eye' : 'eye-off', () => editor.setLayerVisible(selected.id, selected.visible === false)),
        command(selected.savedLocked ? 'layerTimeline.unlockLayer' : 'layerTimeline.lockLayer', selected.savedLocked ? 'unlock' : 'lock', () => editor.setLayerLocked(selected.id, !selected.savedLocked), {disabled: Boolean(selected.focusLocked)}),
      ]]},
    ],
    [{label: interfaceText('timelineMenu.newLayer'), labelKey: 'timelineMenu.newLayer', symbol: 'plus', submenu: [[
      command('layerTimeline.newLayer', 'plus', () => host.newLayer()),
      command('layerTimeline.newDrawingLayer', 'brush', () => host.newLayer('drawing')),
    ]]}],
    [own && !selected.locked && editor.report._styk.layers.order.length > 1 && command('layerTimeline.deleteLayer', 'trash', () => host.deleteLayer(), {danger: true})],
  ];
}

/**
 * The timelines' right-click and ⋯ menus (the Advanced sheet, Simple's cards, audio clips, effect clips) on the
 * shared menu kit (ui/ui-menu.mjs), so they look and work like every other menu: named groups, submenus, checks,
 * red rows for what removes something, type-ahead and the arrow keys.
 *
 * `groups` is a list of groups (separators between them); a group is a list of rows, false and null skipped:
 *   {label, symbol, shortcut, action, checked, danger, disabled}   a command (`action` runs through host._run)
 *   {heading: 'Frames'}                                             the group's name
 *   {label, symbol, submenu: groups}                                a family in a submenu
 * The menu opens at the pointer (or under `event.currentTarget` from a button), closes on a document change or a
 * scroll of the timeline, and gives the focus back to the timeline.
 */
export function showTimelineMenu(host, event, groups) {
  host.menuEvents?.abort();
  host.menu?.remove();
  const events = host.menuEvents = new AbortController();
  const focusTarget = host.scroll ?? host.strip ?? host.lanes ?? null;
  const items = toItems(host, groups);
  if (!items.some(item => item && (item.run || item.submenu))) { events.abort(); return; }
  const anchor = event?.currentTarget?.nodeType === 1 && !event.clientX && !event.clientY ? event.currentTarget : null;
  const menu = openMenu({
    items,
    ...(anchor ? {anchor} : {point: {x: event?.clientX ?? 0, y: event?.clientY ?? 0}}),
    overlays: host.overlays ?? null,
    icon: name => icon(name),
    label: interfaceText("timelineMenu.timeline"), labelKey: "timelineMenu.timeline",
    invoker: focusTarget ?? document.activeElement,
    onClose: () => {
      events.abort();
      if (host.menu === handle) host.menu = null;
    },
  });
  const handle = host.menu = {element: menu.element, remove: () => menu.close('api', {restore: false}), close: reason => menu.close(reason)};
  focusTarget?.addEventListener('scroll', () => handle.remove(), {signal: events.signal});
  host.editor?.addEventListener('change', () => handle.remove(), {signal: events.signal});
  return handle;
}

/** Groups of timeline rows → the kit's menu items (separators between groups, submenus converted). */
function toItems(host, groups) {
  const items = [];
  for (const group of (groups ?? []).map(rows => (rows ?? []).filter(Boolean)).filter(rows => rows.length)) {
    if (items.length) items.push(null);
    for (const row of group) {
      if (row.heading) { items.push({label: row.heading, ...(row.headingKey ? {labelKey:row.headingKey,labelParams:row.headingParams} : {})}); continue; }
      // A menu shows one key per row (the first binding); Settings lists them all.
      const item = {label: row.label, icon: row.symbol ?? row.icon ?? null, shortcut: String(row.shortcut || '').split(' / ')[0] || false,
        danger: Boolean(row.danger), disabled: Boolean(row.disabled), swatch: row.swatch};
      if (row.labelKey) { item.labelKey=row.labelKey; item.labelParams=row.labelParams; }
      if (row.checked !== undefined) item.checked = Boolean(row.checked);
      if (row.submenu) item.submenu = toItems(host, row.submenu);
      else item.run = () => host._run(row.action);
      items.push(item);
    }
  }
  return items;
}
