/**
 * The shell's commands as `actions` entries, so the menubar, the native
 * menu, the palette, hotkeys (hotkeys.mjs: Ctrl+1–4, Ctrl+\, Ctrl+Alt+M,
 * F6 and Ctrl+F6) and `[data-action]` buttons (the band's Properties button,
 * the timeline header's Timeline…) all run the same code. Labels and glyphs
 * are in command-catalog.mjs; ids are never renamed.
 *
 * `shell` is the dock host (dock-host.mjs), `keyboard` its keyboard paths
 * (dock-keyboard.mjs) and `layout` the Layout popover (layout-popover.mjs).
 */
export function installShellCommands(actions, {shell, keyboard, layout}) {
  Object.assign(actions, {
    'panel-toggle-properties': () => shell.togglePanel('properties'),
    'panel-toggle-vfx': () => shell.togglePanel('vfx'),
    'panel-toggle-library': () => shell.togglePanel('library'),
    'panel-toggle-structure': () => shell.togglePanel('structure'),
    'panel-toggle-timeline': () => shell.togglePanel('timeline'),
    'panel-hide-properties': () => shell.workspace.hide('properties'),
    'panel-hide-vfx': () => shell.workspace.hide('vfx'),
    'panel-hide-library': () => shell.workspace.hide('library'),
    'timeline-sheet': () => shell.toggleTimelineSheet(),
    'timeline-tall': () => shell.toggleTall(),
    'layout-focus': () => shell.workspace.focus(),
    'layout-reset': () => shell.workspace.resetWorkspace(),
    'layout-arrange': () => keyboard.startMove(),
    'layout-menu': () => layout?.toggle(),
    'focus-next-region': () => keyboard.focusRegion(1),
    'focus-previous-region': () => keyboard.focusRegion(-1),
  });
  return actions;
}
