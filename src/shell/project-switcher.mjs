import {localizedAttribute, localizedText} from '../localization-bindings.mjs';
import {createPopover} from '../ui/ui-popover.mjs';
import {drawCover} from './project-tabs-view.mjs';

/**
 * Ctrl+Tab (docs/PROJECT-TABS.md): the open projects as a board of pictures
 * under the tabs, most recently used first, as Alt+Tab shows windows.
 *
 * Pressed and released, it goes to the project used before this one. Held, the
 * board stays: Tab (Shift+Tab) or an arrow moves along it, releasing the
 * modifier switches, Escape stays. A card can be clicked too. Run without a
 * held modifier (the command palette, a menu, a rebound key), there is nothing
 * to release, so it switches at once.
 *
 * The board only reads `tabs` and asks `activate(id)`; `picture(id)` gives the
 * picture a tab already has. Nothing is rendered for it.
 */
const CARD = Object.freeze({width: 208, height: 117});

export function createProjectSwitcher({tabs, anchor, activate, picture = () => null, overlays = null, document: doc = anchor.ownerDocument, window: win = doc.defaultView} = {}) {
  let popover = null, order = [], index = 0, cards = [], listening = null;

  const select = (next) => {
    index = (next + order.length) % order.length;
    cards.forEach((card, at) => card.setAttribute('aria-selected', String(at === index)));
    cards[index]?.focus({preventScroll: true});
    cards[index]?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  };
  const close = (reason) => { listening?.abort(); listening = null; popover?.hide(reason); popover = null; cards = []; };
  const commit = () => {
    const target = order[index];
    close('commit');
    if (target && tabs.get(target.id)) activate(target.id);
  };

  function card(item) {
    const button = doc.createElement('button'), art = doc.createElement('span'), name = doc.createElement('span'), state = doc.createElement('span');
    button.type = 'button'; button.className = 'project-switcher-card'; button.setAttribute('role', 'option'); button.dataset.project = item.id;
    art.className = 'project-switcher-art'; art.setAttribute('aria-hidden', 'true');
    const bitmap = picture(item.id);
    if (bitmap) {
      const canvas = doc.createElement('canvas');
      canvas.width = CARD.width; canvas.height = CARD.height;
      drawCover(canvas, bitmap);
      art.append(canvas);
    }
    name.className = 'project-switcher-name'; name.textContent = item.name || 'Untitled';
    state.className = 'project-switcher-state';
    if (item.dirty) localizedText(state, 'app.edited', {});
    else localizedText(state, 'app.saved', {});
    button.append(art, name, state);
    button.addEventListener('click', () => { index = order.indexOf(item); commit(); });
    return button;
  }

  function show(start) {
    const grid = doc.createElement('div'), hint = doc.createElement('span');
    grid.className = 'project-switcher-grid'; grid.setAttribute('role', 'listbox');
    localizedAttribute(grid, 'aria-label', 'projectTabs.openProjects', {});
    cards = order.map(card);
    grid.append(...cards);
    localizedText(hint, 'projectTabs.switcherHint', {});
    popover = createPopover({anchor, placement: 'bottom-start', body: grid, foot: hint, dismiss: 'manual', keyboardScope: true, overlays,
      labelKey: 'projectTabs.openProjects', className: 'project-switcher', document: doc,
      onClose: () => { listening?.abort(); listening = null; popover = null; cards = []; }});
    popover.show();
    select(start);
    listening = new AbortController();
    const {signal} = listening;
    // Before the popover's own key handling and the editor's hotkeys: every key here belongs to the board.
    win.addEventListener('keydown', event => {
      const step = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
      if (step) select(index + step);
      else if (event.key === 'Enter' || event.key === ' ') commit();
      else if (event.key === 'Escape') close('escape');
      else if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
    }, {capture: true, signal});
    win.addEventListener('keyup', event => {
      if (['Control', 'Meta', 'Alt'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) commit();
    }, {capture: true, signal});
    win.addEventListener('blur', () => close('blur'), {signal});
  }

  return {
    /** Runs the command. `event` is the key press that asked for it, when there was one. */
    open(event = null) {
      if (tabs.size < 2) return false;
      const backwards = Boolean(event?.shiftKey);
      if (popover?.isOpen) { select(index + (backwards ? -1 : 1)); return true; }
      order = tabs.recency;
      const start = backwards ? order.length - 1 : 1;
      if (!(event && (event.ctrlKey || event.metaKey || event.altKey))) { activate(order[start].id); return true; }
      show(start);
      return true;
    },
    close: () => close('hide'),
    get isOpen() { return Boolean(popover?.isOpen); },
  };
}
