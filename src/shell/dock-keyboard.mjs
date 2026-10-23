import {t as interfaceText} from '../localization.mjs';
import {appendLocalized, localizedText} from '../localization-bindings.mjs';
/**
 * Keyboard paths through the shell (WCAG 2.5.7: every drag has one).
 *
 * - F6 and Ctrl+F6 (`focus-next-region`, `focus-previous-region`) cycle the
 *   regions: band → rail → left dock → stage header → stage → right dock →
 *   timeline → floating panels. Each region takes focus at its selected tab,
 *   its first control or itself; hidden and folded regions are skipped.
 * - Ctrl+Alt+M (`layout-arrange`) moves the focused panel: the arrow keys
 *   step through the places it may go (Dock left, Dock right, Float), one
 *   calm drop target previews the place and says its name, Enter commits and
 *   Escape (or Tab, or a click) cancels. The instruction is announced with the
 *   first place, never shown as a sentence. While it moves, no other key
 *   reaches the editor.
 */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const PLACE_KEYS = Object.freeze({left:'dockKeyboard.dockLeft', right:'dockKeyboard.dockRight', float:'dockKeyboard.floatHere'});
/** A region's main collection, where focus lands before its first control. */
export const COLLECTIONS = '[role="tree"][aria-label], [role="grid"][aria-label], [role="listbox"][aria-label]';

const shown = element => Boolean(element?.isConnected && element.getClientRects().length && !element.closest('[hidden], [inert]'));

/**
 * `host` is the dock host (dock-host.mjs). `announce(text)` speaks a short
 * status (a polite live region).
 */
export function createDockKeyboard({document: doc = globalThis.document, window: win = globalThis.window, host, announce = () => {}} = {}) {
  const panelName = id => {
    const panel = host.registry.get(id);
    return panel?.titleKey ? {messageKey:panel.titleKey} : panel?.title ?? id;
  };
  const regionList = () => {
    const {hosts, bottom, stage, viewport, band, rail, floats} = host.regions();
    const head = stage?.querySelector(':scope > .stage-head');
    return [band, rail, hosts.left, head, viewport, hosts.right, bottom, ...floats].filter(element => shown(element));
  };

  /**
   * The element a region takes focus at: its selected tab, the stage itself,
   * the timeline's named collection (the "Layer frames" grid, or Simple's
   * frame list), else its first control. Never an unnamed container.
   */
  function entry(region) {
    const tab = [...region.querySelectorAll('[role="tab"][aria-selected="true"]')].find(shown);
    if (tab) return tab;
    if (region.matches('#viewport')) return region;
    const collection = [...region.querySelectorAll(COLLECTIONS)].find(element => shown(element) && element.tabIndex >= 0);
    if (collection) return collection;
    return [...region.querySelectorAll(FOCUSABLE)].find(element => shown(element) && !element.disabled && element.tabIndex >= 0) ?? null;
  }

  /** Moves focus `step` regions on (1: F6, -1: Ctrl+F6). */
  function focusRegion(step = 1) {
    const regions = regionList();
    if (!regions.length) return false;
    const active = doc.activeElement;
    let index = regions.findIndex(region => region.contains(active));
    for (let tries = 0; tries < regions.length; tries++) {
      index = index < 0 ? (step > 0 ? 0 : regions.length - 1) : (index + step + regions.length) % regions.length;
      const target = entry(regions[index]);
      if (target) {
        target.focus({preventScroll: true});
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Keyboard move

  let move = null;
  const zone = doc.createElement('div');
  zone.className = 'ui-drop-zone shell-drop';
  zone.hidden = true;
  const zoneLabel = doc.createElement('span');
  zoneLabel.className = 'ui-drop-label';
  appendLocalized(zone, zoneLabel);

  const panelOf = element => {
    const panel = element?.closest?.('[data-panel]');
    if (!panel) return null;
    const id = panel.dataset.panel;
    return id && id !== 'timeline' && host.registry.has(id) ? id : null;
  };

  function preview({announce: speak = true} = {}) {
    const target = move.targets[move.index];
    const workspace = doc.querySelector('.workspace');
    if (zone.parentElement !== workspace) appendLocalized(workspace, zone);
    zone.dataset.target = target;
    zone.hidden = false;
    localizedText(zoneLabel, PLACE_KEYS[target]);
    if (speak) announce(interfaceText(PLACE_KEYS[target]));
  }

  function finish(commit) {
    if (!move) return;
    const {id, targets, index, restore} = move;
    move = null;
    zone.hidden = true;
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('pointerdown', onPointer, true);
    if (!commit) { announce(interfaceText("dockKeyboard.moveCancelled")); restore?.focus?.({preventScroll: true}); return; }
    const target = targets[index];
    if (target === 'float') host.workspace.float(id);
    else host.workspace.dock(id, target);
    announce(interfaceText('dockKeyboard.panelLocation', {title:panelName(id), place:{messageKey:PLACE_KEYS[target]}}));
    host.showPanel(id);
  }

  function onKey(event) {
    if (!move) return;
    const step = {ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1}[event.key];
    if (step) move.index = (move.index + step + move.targets.length) % move.targets.length;
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      finish(false);
      return;
    } else {
      // Any other key belongs to the move: it never reaches the editor's shortcuts (H would pick the Hand tool).
      if (!['Shift', "Control", 'Alt', "Meta"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    preview();
  }
  const onPointer = () => finish(false);

  /** Starts moving the panel that holds focus (or `id`); false when there is none that can move. */
  function startMove(id = panelOf(doc.activeElement)) {
    if (move) finish(false);
    if (!id) { announce(interfaceText("dockKeyboard.focusAPanelToMoveIt")); return false; }
    const targets = ['left', 'right', 'float'].filter(target => host.canPlace(id, target));
    if (targets.length < 2) { announce(interfaceText("dockKeyboard.thisPanelStaysWhereItIs")); return false; }
    const presentation = host.presentation(id);
    const current = presentation === 'float' ? 'float' : host.solution?.panels[id]?.side;
    const start = Math.max(0, targets.indexOf(current));
    move = {id, targets, index: (start + 1) % targets.length, restore: doc.activeElement};
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('pointerdown', onPointer, true);
    // One message, so the instructions are not overwritten by the first place in the same task.
    preview({announce: false});
    announce(interfaceText('dockKeyboard.moveInstructions', {title:panelName(id), place:{messageKey:PLACE_KEYS[move.targets[move.index]]}}));
    return true;
  }

  return {
    focusRegion,
    startMove,
    cancelMove: () => finish(false),
    get moving() { return move ? {id: move.id, target: move.targets[move.index]} : null; },
    destroy() { finish(false); zone.remove(); },
  };
}
