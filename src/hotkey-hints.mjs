import { HOTKEY_BY_ID } from './hotkeys.mjs';
import { ariaKeyShortcut } from './ui/command-registry.mjs';
import {hotkeyLabelMessage} from './hotkey-labels.mjs';
import {localizedAttribute} from './localization-bindings.mjs';

/**
 * The HOTKEY_COMMANDS id whose shortcut a control shows, or null. Derived from
 * the control's command (data-hotkey-command, data-tool, data-action), never
 * from a second list of bindings.
 */
export function hotkeyCommandId(node, hotkeys = null) {
  const data = node?.dataset;
  if (!data) return null;
  let id = data.hotkeyCommand || (node.id === 'play-button' ? 'play-pan' : data.tool
    ? (HOTKEY_BY_ID.has(`tool-${data.tool}`) || !HOTKEY_BY_ID.has(data.tool) ? `tool-${data.tool}` : data.tool) : data.action);
  if (id === 'delete-single-segment') id = 'delete';
  // Build's part commands answer the everyday keys (Ctrl+D duplicates the part, the flip keys flip it).
  if (id === 'duplicate-segment') id = 'duplicate';
  if (id === 'mirror-segment') id = 'mirror';
  if (id === 'mirror-segment-vertical') id = 'mirror-vertical';
  if (id === 'play' && hotkeys && !hotkeys.label('play')) id = 'play-pan';
  return id && HOTKEY_BY_ID.has(id) ? id : null;
}

/**
 * Writes each shortcut control's hints from the user's bindings: the name
 * (data-hotkey-title, without the shortcut), the shortcut text
 * (data-hotkey-hint) and aria-keyshortcuts. Menu rows get their <kbd>.
 *
 * The tooltip (ui/ui-tooltip.mjs) shows "name · shortcut", so a `title` would
 * show a second, native tooltip: it is moved into data-hotkey-title (an
 * explicit data-hotkey-title wins) and removed. A control that took its
 * accessible name from that title keeps it as aria-label; accessible names
 * never include the shortcut.
 */
export function refreshHotkeyHints(hotkeys, root = document) {
  for (const node of root.querySelectorAll('[data-action],[data-tool],[data-hotkey-command]')) {
    const id = hotkeyCommandId(node, hotkeys);
    if (!id) continue;
    const label = hotkeys.label(id), kbd = node.querySelector('kbd');
    if (kbd) { kbd.textContent = label; continue; }
    const title = node.getAttribute('title');
    if (!node.dataset.hotkeyTitle) {
      const supplied = title || node.getAttribute('aria-label');
      if (supplied) node.dataset.hotkeyTitle = supplied.replace(/\s*(?:·.*|\([^)]*\))$/, '');
      else {
        const reference=hotkeyLabelMessage(id);
        localizedAttribute(node,'data-hotkey-title',reference.key,reference.params);
      }
    }
    if (title !== null) node.removeAttribute('title');
    if (!node.hasAttribute('aria-label') && !node.hasAttribute('aria-labelledby') && !node.textContent.trim()) {
      if (node.hasAttribute('data-i18n-hotkey-title')) {
        const reference=hotkeyLabelMessage(id);
        localizedAttribute(node,'aria-label',reference.key,reference.params);
      } else node.setAttribute('aria-label', node.dataset.hotkeyTitle);
    }
    if (node.dataset.hotkeyHint !== label) node.dataset.hotkeyHint = label;
    const bindings = hotkeys.bindings?.[id];
    if (bindings) {
      const keys = bindings.map(binding => ariaKeyShortcut(binding, hotkeys.mac)).join(' ');
      if (!keys) node.removeAttribute('aria-keyshortcuts');
      else if (node.getAttribute('aria-keyshortcuts') !== keys) node.setAttribute('aria-keyshortcuts', keys);
    }
  }
}
