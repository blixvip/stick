/**
 * Wires the overlay kit for tests/fixtures/ui-overlays.html. Commands only log
 * their id to fixture.log; a stand-in hotkey handler logs `hotkey:<id>` so a
 * test can check that typing never leaks past an open menu, palette or dialog.
 */
import {icon} from '/src/icons.mjs';
import {HotkeyManager} from '/src/hotkeys.mjs';
import {createOverlayManager} from '/src/ui/overlay-manager.mjs';
import {createCommandRegistry} from '/src/ui/command-registry.mjs';
import {CATALOG_REQUIREMENTS} from '/src/ui/command-catalog.mjs';
import {installMenuBar, openMenu} from '/src/ui/ui-menu.mjs';
import {createPopover} from '/src/ui/ui-popover.mjs';
import {installTooltips} from '/src/ui/ui-tooltip.mjs';
import {createToasts} from '/src/ui/ui-toast.mjs';
import {choose, confirm, createDialog, prompt} from '/src/ui/ui-dialog.mjs';
import {PALETTE_COMMAND, createCommandPalette} from '/src/ui/command-palette.mjs';
import {installToolbarOverflow, overflowMenuItems} from '/src/ui/toolbar-overflow.mjs';

const $ = id => document.getElementById(id);
const log = [];
const state = {mode: 'animate', figure: true, handles: true, paths: false, onion: false};
const actions = Object.fromEntries(['new', 'open', 'save', 'save-as', 'export', 'import', 'undo', 'redo', 'cut', 'copy', 'paste', 'paste-in-place',
  'duplicate', 'delete', 'select-all', 'zoom-in', 'zoom-out', 'zoom-reset', 'mirror', 'mirror-vertical', 'layer-front', 'layer-up', 'layer-down',
  'layer-back', 'help', 'settings', 'performance', 'split-segment'].map(id => [id, () => { log.push(id); }]));
actions['toggle-handles'] = () => { state.handles = !state.handles; log.push('toggle-handles'); };
actions['toggle-motion-paths'] = () => { state.paths = !state.paths; log.push('toggle-motion-paths'); };
actions['toggle-onion'] = () => { state.onion = !state.onion; log.push('toggle-onion'); $('toolbar').querySelector('[data-action="toggle-onion"]').setAttribute('aria-pressed', String(state.onion)); };

const hotkeys = new HotkeyManager({run: id => log.push(`hotkey:${id}`), release: () => {}});
const overlays = createOverlayManager({hotkeys, fallbackFocus: () => $('fixture-stage')});
overlays.install();
const commands = createCommandRegistry({
  actions, hotkeys, context: () => state, runHotkey: id => log.push(`hotkey:${id}`),
  // Every requirement the catalog uses gets an answer; this page is the web build, so desktop-only commands are off.
  requirements: {...Object.fromEntries(CATALOG_REQUIREMENTS.map(name => [name, () => false])), figure: context => context.figure || 'Select a figure first'},
  checked: (id, context) => ({'toggle-handles': context.handles, 'toggle-motion-paths': context.paths, 'toggle-onion': context.onion})[id],
});
const band = document.querySelector('.fixture-band');
const topInset = () => band.getBoundingClientRect().bottom + 6;
const menuOptions = {overlays, icon, resolve: id => commands.get(id), topInset};

// The app's two input paths: click delegation by data-action, and hotkeys behind the overlay gate.
document.addEventListener('click', event => {
  const control = event.target.closest?.('[data-action]');
  if (control) commands.run(control.dataset.action, {event, element: control, source: control.closest('.ui-menu') ? 'menu' : 'rail'});
});
document.addEventListener('keydown', event => {
  if (event.target.closest?.('input, textarea, select')) return;
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyP' && !overlays.blocksHotkeys()) { event.preventDefault(); commands.run('command-palette', {event}); return; }
  if (overlays.blocksHotkeys()) return;
  hotkeys.keydown(event, ['canvas']);
});
document.addEventListener('keyup', event => hotkeys.keyup(event), true);

const MENUS = {
  file: () => commands.items(['new', 'open', null, 'save', 'save-as', null, 'import', 'export']),
  edit: () => commands.items(['undo', 'redo', null, 'cut', 'copy', 'paste', {label: 'Paste special', icon: 'clipboard', submenu: ['paste-in-place', 'paste-instance']},
    'duplicate', 'delete', null, 'select-all']),
  view: () => commands.items([{label: 'Canvas'}, 'toggle-handles', 'toggle-motion-paths', null, 'zoom-in', 'zoom-out', 'zoom-reset', null,
    {label: 'Arrange', icon: 'bring-to-front', submenu: () => ['layer-front', 'layer-up', 'layer-down', 'layer-back']}, 'split-segment']),
};
const selectionMenu = () => commands.items(['copy', 'paste', 'duplicate', null, {label: 'Flip', icon: 'flip', submenu: ['mirror', 'mirror-vertical']},
  {label: 'Arrange', icon: 'bring-to-front', submenu: ['layer-front', 'layer-up', 'layer-down', 'layer-back']}, null, 'delete']);
const menubar = installMenuBar(band.querySelector('nav'), {menus: MENUS, ...menuOptions});

const contextArea = $('context-area');
const openContextMenu = point => openMenu({...menuOptions, host: $('menu'), point, items: selectionMenu(), label: 'Selection', invoker: contextArea});
contextArea.addEventListener('contextmenu', event => { event.preventDefault(); openContextMenu({x: event.clientX, y: event.clientY}); });
contextArea.addEventListener('keydown', event => {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  const rect = contextArea.getBoundingClientRect();
  openContextMenu({x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
});
$('open-menu-host').addEventListener('click', event => openMenu({...menuOptions, host: $('menu'), anchor: event.currentTarget, items: MENUS.view(), label: 'View'}));

// Popover: two counts, like the onion settings.
const onionBody = document.createElement('div');
for (const [name, value] of [['Frames before', 2], ['Frames after', 1]]) {
  const label = document.createElement('label'), input = document.createElement('input');
  input.type = 'number'; input.min = '0'; input.max = '10'; input.value = String(value);
  input.setAttribute('aria-label', name);
  label.append(`${name} `, input);
  onionBody.append(label);
}
// A button in the popover that opens a dialog, like Rename in the Document popover: showModal hides the popover.
const renameFromPopover = document.createElement('button');
renameFromPopover.type = 'button';
renameFromPopover.id = 'popover-rename';
renameFromPopover.textContent = 'Rename…';
renameFromPopover.addEventListener('click', async () => {
  const name = await prompt({title: 'Rename layer', label: 'Name', value: 'Onion', overlays, icon});
  log.push(`popover-prompt:${name}`);
});
const popover = createPopover({anchor: $('open-popover'), title: 'Onion skin', closeLabel: 'Close onion settings', body: onionBody, foot: renameFromPopover,
  overlays, icon, topInset, keyboardScope: true});
$('open-popover').addEventListener('click', () => popover.toggle());

const tooltips = installTooltips(document, {shortcut: element => (element.dataset.command ? commands.shortcut(element.dataset.command) : element.dataset.hotkeyHint), topInset});

const toasts = createToasts({host: $('toast'), overlays, icon, area: () => $('fixture-stage').getBoundingClientRect(),
  feedback: {label: 'Send feedback', run: () => log.push('feedback')}});
$('toast-info').addEventListener('click', () => toasts.show({message: 'Motion paths on'}));
$('toast-undo').addEventListener('click', () => toasts.show({title: 'Deleted', message: '3 frames', action: {label: 'Undo', command: 'undo'}}));
$('toast-error').addEventListener('click', () => toasts.fail(new Error('Could not open whoosh.wav, it is in use')));
$('toast-task').addEventListener('click', () => {
  const task = toasts.task({title: 'Copying 3 figures', delay: 150});
  let progress = 0;
  const timer = setInterval(() => {
    progress += 0.2;
    task.progress(progress);
    if (progress >= 1) { clearInterval(timer); task.done({message: 'Copied 3 figures'}); }
  }, 250);
  task.signal.addEventListener('abort', () => { clearInterval(timer); log.push('task-cancelled'); });
});
$('toast-over-modal').addEventListener('click', () => {
  const dialog = createDialog({title: 'Export', size: 'md', body: 'A message raised while this dialog is open stays visible above it.', overlays, icon,
    actions: [{label: 'Close', value: 'close', variant: 'primary'}]});
  dialog.showModal();
  toasts.fail(new Error('The encoder stopped'));
});

$('open-confirm').addEventListener('click', async () => {
  const answer = await confirm({title: 'Save changes to Kick combo?', body: 'Your changes will be lost if you don’t save them.', confirmLabel: 'Save', overlays, icon,
    alternatives: [{label: 'Don’t save', value: 'discard', danger: true, id: 'discard-changes'}]});
  log.push(`confirm:${answer}`);
});
$('open-prompt').addEventListener('click', async () => {
  const name = await prompt({title: 'Rename project', label: 'Name', value: 'Kick combo', confirmLabel: 'Save name', maxLength: 120, inputId: 'rename-input', overlays, icon,
    validate: text => (text.trim() ? '' : 'Enter a name')});
  log.push(`prompt:${name}`);
});
$('open-choose').addEventListener('click', async () => {
  const choice = await choose({title: 'Finish editing the figure?', overlays, icon, options: [
    {value: 'update', id: 'builder-exit-update', label: 'Update all 3 Bubbles', description: 'Every copy of this figure changes.'},
    {value: 'import', id: 'builder-exit-import', label: 'Add as a new figure'},
    {value: 'discard', id: 'builder-exit-discard', label: 'Discard changes', danger: true},
  ]});
  log.push(`choose:${choice}`);
});
$('open-modal').addEventListener('click', () => {
  const body = document.createElement('div'), field = document.createElement('input'), opener = document.createElement('button');
  field.setAttribute('aria-label', 'Name');
  field.value = 'Bubble';
  opener.type = 'button';
  opener.id = 'modal-menu-button';
  opener.textContent = 'Arrange';
  opener.addEventListener('click', () => openMenu({...menuOptions, anchor: opener, items: MENUS.view(), label: 'Arrange'}));
  // A manual, keyboard-scoped popover inside the dialog (Go to frame style): it only closes itself.
  const pinned = document.createElement('button');
  pinned.type = 'button';
  pinned.id = 'modal-popover-button';
  pinned.textContent = 'Frame';
  const frameField = document.createElement('input');
  frameField.type = 'number';
  frameField.setAttribute('aria-label', 'Frame number');
  const inner = createPopover({anchor: pinned, title: 'Go to frame', body: frameField, dismiss: 'manual', keyboardScope: true, overlays, icon, topInset});
  pinned.addEventListener('click', () => inner.toggle());
  body.append(field, opener, pinned);
  const dialog = createDialog({title: 'Figure', size: 'md', body, overlays, icon, actions: [{label: 'Cancel', cancel: true}, {label: 'Done', value: 'done', variant: 'primary'}]});
  dialog.showModal().then(value => log.push(`modal:${value}`));
  window.fixture.modal = dialog;
});

// Toolbar overflow with a More menu of the controls that did not fit.
let overflowed = [];
const more = $('toolbar-more');
installToolbarOverflow($('toolbar'), {items: () => [...$('toolbar').querySelectorAll('[data-action]')], more, onChange: list => { overflowed = list; }});
more.addEventListener('click', () => openMenu({...menuOptions, anchor: more, items: overflowMenuItems(overflowed), label: 'More tools'}));

const palette = createCommandPalette({commands, overlays, icon, topInset, context: () => state, frameJump: frame => log.push(`frame:${frame}`),
  providers: [{id: 'learn', label: 'Learn', search: query => ['Flip and mirror a pose', 'Your first walk cycle'].filter(title => title.toLowerCase().includes(query.toLowerCase()))
    .map(title => ({id: title, label: title, icon: 'play', meta: 'Tutorial', run: () => log.push(`learn:${title}`)}))}]});
commands.define(PALETTE_COMMAND.id, {...PALETTE_COMMAND, run: () => palette.open()});
$('open-palette').addEventListener('click', () => palette.open());

overlays.markReady();
window.fixture = {overlays, commands, menubar, popover, tooltips, toasts, palette, log, state, ready: true};
