import {t as interfaceText} from '../localization.mjs';
import {appendLocalized, localizedMarkup, localizedAttribute, localizedText, clearTranslation} from '../localization-bindings.mjs';
/**
 * The stage header (experience.md §4.1-4.4, architecture.md §3.12): the
 * canvas's own 40px line, a sibling of #viewport above it, level with the
 * inspector's tabs. Nothing it holds is over the artwork, in the canvas hotkey
 * scope (hotkeyScopes() looks for #viewport) or under the canvas's wheel zoom.
 * index.html holds its markup; this module fills and updates it.
 *
 *   start   where you are, or the tool's options. The location crumb ("Scene
 *           960 × 540" and the background chip, one click from the colour
 *           picker; inside a movieclip or camera session the scope path, whose
 *           first part leaves the session) shows while nothing else does: a
 *           tool options bar rendered by ui/tool-options.mjs from the tool's
 *           descriptors (setToolOptions), or a host adopted as it is until its
 *           tool declares descriptors (adopt: Draw's quick bar until M7b; the
 *           chain and polygon controls, static in the markup, until M7a).
 *   centre  the one message. The host is ui/ui-toast.mjs's #toast, a manual
 *           popover in the top layer; placeMessage() says where it goes. It has
 *           priority over the start (it covers the crumb or the tool options
 *           while it shows: data-msg-over) but never over the view cluster, and
 *           it is never cut: centred in the header when that clears the view
 *           cluster, else centred in its room up to the cluster (at compact and
 *           minimal width up to zoom and Fit, the view toggles stepping aside:
 *           data-msg-over-view); when its whole text does not fit there it
 *           takes a line of its own just under the header (data-msg-drop). A
 *           message that would cover the start while focus is in it (an option
 *           being typed in) takes its own line instead.
 *   end     the view cluster: labelled toggles, whose words fold to their
 *           glyphs in a stage narrower than 820px (#handles-button "Joints",
 *           #paths-button "Paths", the Grid split with #canvas-guides-button
 *           and #guides-options-button, #vfx-preview "Effects"; Build's
 *           "Handles", "Highlight", "Isolate" and the construction background),
 *           each shown in the workspaces its [data-workspaces] names, then
 *           #zoom-label and Fit. One tab stop: the arrow keys move inside it.
 *
 * showMode() keeps the instruction of a pick mode while it lasts
 * ("Click the joint to join to · Cancel"). setViewMenu(true) folds the view
 * toggles into one View menu (a phone's touch interface, docs/TOUCH.md).
 * setLesson(element) shows a tutorial's strip in the start, in the crumb's
 * place (docs/TUTORIALS.md): a lesson adds no row. While it shows, a message
 * that would cover it takes its own line under the header instead, and the
 * view toggles keep their glyphs only.
 */
import {setAttr, setHidden, setText, setVar} from '../ui/dom-write.mjs';
import {createToolOptions} from '../ui/tool-options.mjs';
import {installRovingFocus} from '../ui/roving-focus.mjs';
import {icon} from '../icons.mjs';

/** The message's clearance from the view cluster and from the start's content. */
export const MESSAGE_GAP = 12;
/** A dropped message's distance under the header. */
export const DROP_GAP = 6;
const MESSAGE_ATTRIBUTES = ['data-msg-over', 'data-msg-over-view', 'data-msg-drop'];
const COMPACT_TIERS = new Set(['compact', 'minimal']);

/**
 * Where the message goes (the collision rule, pure): `head`, `keep` (the
 * cluster it never meets: the whole end, or zoom and Fit at compact width),
 * `view` (the view toggles, which step aside at compact width) and
 * `startRight` (where the start's content ends) are rects in window
 * coordinates; `width` is the message's whole width. Returns {x, top, place:
 * 'head' | 'drop', over, overView}: x is the message's centre, top the
 * header's middle (place 'head') or the dropped line's top.
 */
export function solveMessage({head, keep, view = null, startRight = head.left, width, pad = 8, compact = false, focusInStart = false,
  keepStart = false, gap = MESSAGE_GAP, dropGap = DROP_GAP}) {
  const left = head.left + pad, limit = keep.left - gap, room = limit - left;
  const drop = () => ({x: head.left + head.width / 2, top: head.bottom + dropGap, place: 'drop', over: false, overView: false});
  if (!(width <= room)) return drop();
  let x = head.left + head.width / 2;
  if (x + width / 2 > limit) x = left + room / 2;
  const over = x - width / 2 < startRight + gap;
  if (over && (focusInStart || keepStart)) return drop();
  const overView = Boolean(compact && view && view.width > 0 && x + width / 2 > view.left - gap);
  return {x, top: head.top + head.height / 2, place: 'head', over, overView};
}

/**
 * createStageHead({root, toasts, toolOptions}) → {root, start, end, update,
 * setZoom, setToolOptions, adopt, placeMessage, releaseMessage, showMode,
 * destroy}. `toasts()` returns the message kit (created after this
 * module: its host placement asks placeMessage). `toolOptions` is the
 * createToolOptions configuration the header's bar shares (registry, context,
 * icon, t, overlays, onChange, onFold), or a function returning it when the
 * bar is first needed.
 */
export function createStageHead({root, toasts = () => null, toolOptions = {}, openMenu = null, Observer = globalThis.ResizeObserver} = {}) {
  const doc = root.ownerDocument, win = doc.defaultView ?? globalThis;
  const controller = new AbortController(), {signal} = controller;
  const start = root.querySelector('[data-slot="stage-start"]');
  const end = root.querySelector('[data-slot="stage-end"]');
  const crumb = start.querySelector('.ui-crumb');
  const scene = crumb.querySelector('[data-crumb="scene"]');
  const sceneName = scene.querySelector('.ui-crumb-name');
  const size = scene.querySelector('.ui-crumb-meta');
  const chip = crumb.querySelector('.ui-crumb-swatch');
  const view = end.querySelector('[data-view]');
  const zoom = end.querySelector('[data-zoom]');
  const zoomValue = zoom.querySelector('.stage-zoom-value');
  // The scope path's current part, after the Scene inside a session ("Scene › Punch").
  const separator = doc.createElement('span');
  separator.className = 'ui-crumb-sep';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '›';
  separator.hidden = true;
  const here = doc.createElement('span');
  here.className = 'ui-crumb-here';
  here.hidden = true;
  const hereName = doc.createElement('span');
  appendLocalized(here, hereName);
  chip.before(separator, here);
  let bar = null, shownMode = '', modeHandle = null, placed = false, lesson = null;

  // The view menu (setViewMenu): one "View" button in the view cluster's place, where the header has no room for
  // the toggles (a phone's touch interface). Its rows are the cluster's shown controls, and each runs by clicking its
  // control, so the toggles keep one implementation and their states.
  const viewButton = doc.createElement('button');
  viewButton.type = 'button';
  viewButton.className = 'ui-button stage-view-menu';
  viewButton.dataset.variant = 'ghost';
  viewButton.dataset.size = 'sm';
  localizedMarkup(viewButton, `${icon('eye')}<span class="stage-zoom-chevron">${icon('chevron-down')}</span>`);
  viewButton.setAttribute('aria-haspopup', 'menu');
  viewButton.setAttribute('aria-expanded', 'false');
  localizedAttribute(viewButton, 'aria-label', "stageHead.viewOptions", {});
  localizedAttribute(viewButton, 'data-tooltip', "stageHead.viewOptions", {});
  viewButton.hidden = true;
  view.before(viewButton);
  const viewItems = () => [...view.querySelectorAll('button')].filter(button => !button.closest('[hidden]') && !button.hidden).map(button => {
    const pressed = button.getAttribute('aria-pressed');
    const name = button.getAttribute('aria-label') || button.dataset.tooltip || button.textContent.trim();
    const settings = button.classList.contains('ui-split-more');
    return {
      label: settings ? `${name}…` : name, icon: settings ? 'settings' : button.dataset.icon ?? null,
      ...(pressed === 'true' || pressed === 'false' ? {checked: pressed === 'true'} : {}),
      disabled: button.disabled,
      run: () => button.click(),
    };
  });
  viewButton.addEventListener('click', () => openMenu?.(viewItems(), viewButton, {label: interfaceText("stageHead.viewOptions"), labelKey: "stageHead.viewOptions"}), {signal});
  /** Shows the view toggles as one menu (true) or as the cluster (false). */
  function setViewMenu(on) {
    setAttr(root, 'data-view-menu', Boolean(on));
    setHidden(viewButton, !on);
    focus.refresh();
  }

  // The end is one tab stop; the arrow keys move inside it and never reach the canvas's keys.
  const focus = installRovingFocus(end, {items: () => end.querySelectorAll('button'), signal});

  const reposition = () => { if (placed) toasts()?.reposition?.(); };
  const observer = Observer ? new Observer(reposition) : null;
  observer?.observe(root);
  observer?.observe(start);
  start.addEventListener('focusin', reposition, {signal});
  start.addEventListener('focusout', () => win.setTimeout(reposition, 0), {signal});

  /** The element that shows or hides with a view control: its split group, or the control. */
  const hostOf = element => (element.parentElement?.classList.contains('ui-split') ? element.parentElement : element);

  /**
   * Writes what the header shows (compare-first: an unchanged header writes
   * nothing). `view` is {mode ('animate' | 'draw' | 'rig'), size ("960 × 540"),
   * background ({css, label}), session ({done, name, icon}) or null, and the
   * view toggles' states: handles, motionPaths, grid, vfx, staticHandles,
   * highlight}.
   */
  function update(state) {
    const {mode = 'animate', session = null} = state;
    setAttr(root, 'data-workspace', mode);
    for (const element of end.querySelectorAll('[data-workspaces]'))
      setHidden(hostOf(element), !element.dataset.workspaces.split(' ').includes(mode));
    setText(size, state.size ?? '');
    setHidden(size, Boolean(session));
    setAttr(scene, 'data-action', session?.done ?? 'scene-settings');
    localizedAttribute(scene, 'data-tooltip', (session ? "stageHead.backToTheSceneDone" : "stageHead.sceneProperties"), (session ? {} : {}));
    // Its words may fold away in a narrow header (the size first, then the name): the accessible name keeps them.
    localizedAttribute(scene,'aria-label',session?'stageHead.sceneBackToTheScene':'movieclipUi.scene2',session?{}:{scene:state.size??''});
    setHidden(separator, !session);
    setHidden(here, !session);
    if (session?.nameKey) localizedText(hereName, session.nameKey, session.nameParams);
    else { clearTranslation(hereName); setText(hereName, session?.name ?? ''); }
    setHidden(chip, Boolean(session) || !state.background);
    if (state.background) {
      setVar(chip.firstElementChild, '--swatch', state.background.css);
      localizedAttribute(chip, 'aria-label', 'stageHead.backgroundColourLabelOpensTheColourPicker', {label: state.background.label});
      localizedAttribute(chip, 'data-tooltip', 'stageHead.backgroundColourLabel', {label: state.background.label});
    }
    // A toggle shows its state by looking pressed (and says it through aria-pressed); its tooltip is its name.
    toggle(interfaceText("stageHead.handlesButton"), state.handles);
    toggle(interfaceText("stageHead.pathsButton"), state.motionPaths);
    toggle('#canvas-guides-button', state.grid);
    toggle(interfaceText("stageHead.vfxPreview"), state.vfx);
    toggle(interfaceText("stageHead.dataActionBuilderStaticHandles"), state.staticHandles);
    toggle(interfaceText("stageHead.dataActionBuilderHighlight"), state.highlight);
    toggle(interfaceText("stageHead.dataActionToggleIsolate"), state.isolate);
    focus.refresh();
  }
  function toggle(selector, pressed) {
    const button = end.querySelector(selector);
    if (button) setAttr(button, 'aria-pressed', String(Boolean(pressed)));
  }

  /** The zoom value ("95%"), written on every view change. */
  function setZoom(text) { setText(zoomValue, text); }

  /**
   * The active tool's options (ui/tool-options.mjs descriptors), or none: the
   * crumb shows again. The bar is created on first use and kept.
   */
  function setToolOptions(descriptors = [], {tool = '', label = '', labelKey, labelParams} = {}) {
    const list = descriptors ?? [];
    if (!bar && !list.length) return null;
    if (!bar) {
      bar = createToolOptions({...(typeof toolOptions === 'function' ? toolOptions() : toolOptions), descriptors: list, tool, label, labelKey, labelParams, popoverMount: root});
      bar.element.classList.add('stage-options');
      crumb.after(bar.element);
    } else bar.update(list, {tool, label, labelKey, labelParams});
    setHidden(bar.element, !list.length);
    reposition();
    return bar;
  }

  /** Re-parents a legacy host (it keeps its id, handlers and state) into the start, after the crumb and the bar. */
  function adopt(element) {
    if (element && element.parentElement !== start) appendLocalized(start, element);
    return element;
  }

  const rectOf = element => element?.getBoundingClientRect();
  const shown = element => Boolean(element && !element.hidden && element.getClientRects().length);
  /** Where the start's visible content ends (its first shown child's parts; Draw's quick bar by its row). */
  function startRight() {
    const box = rectOf(start);
    const content = [...start.children].find(shown);
    if (!content) return box.left;
    const parts = content.matches('.drawing-quickbar') ? content.querySelectorAll('.draw-quick-row > *') : content.children;
    let right = box.left;
    for (const part of parts) if (shown(part)) right = Math.max(right, rectOf(part).right);
    return Math.min(right, box.right);
  }

  /**
   * The message's place for a pill of `width` × `height`, or null while the
   * header is not shown (the message then keeps its fallback place). Marks the
   * header with what the message covers.
   */
  function placeMessage({width}) {
    releaseMessage();
    if (!shown(root)) return null;
    const head = rectOf(root);
    if (!(head.width > 0)) return null;
    const compact = COMPACT_TIERS.has(doc.documentElement.dataset.tier);
    const viewShown = shown(view) && [...view.children].some(shown);
    const keep = rectOf(compact && viewShown ? zoom : end);
    const pad = parseFloat(win.getComputedStyle(root).paddingInlineStart) || 8;
    const solved = solveMessage({head, keep, view: viewShown ? rectOf(view) : null, startRight: startRight(), width, pad, compact,
      focusInStart: start.contains(doc.activeElement), keepStart: shown(lesson)});
    if (solved.place === 'drop') setAttr(root, 'data-msg-drop', true);
    setAttr(root, 'data-msg-over', solved.over);
    setAttr(root, 'data-msg-over-view', solved.overView);
    placed = true;
    return solved;
  }
  /** The message closed (or moved into a dialog): the start and the view toggles show again. */
  function releaseMessage() {
    placed = false;
    for (const name of MESSAGE_ATTRIBUTES) setAttr(root, name, false);
  }

  /**
   * A pick mode's instruction while it lasts, or null when no mode is active.
   * `mode` is {key, title, message, icon, cancel()}: the title is the verb in
   * bold; `cancel` adds a Cancel action (Esc still cancels too). The same key
   * keeps the message and updates its words. Its own tone keeps a press on
   * the canvas (which clears passing info messages) from ending it.
   */
  function showMode(mode) {
    const key = mode?.key ?? '';
    const kit = toasts();
    if (!kit) return;
    if (mode && key === shownMode && modeHandle) { modeHandle.update?.({title: mode.title ?? '', message: mode.message ?? ''}); return; }
    if (!mode && !modeHandle) { shownMode = ''; return; }
    const previous = modeHandle;
    modeHandle = null;
    shownMode = key;
    previous?.dismiss();
    if (!mode) return;
    let handle = null;
    handle = kit.show({slot: 'mode', variant: 'mode', tone: 'mode', key: `mode:${key}`, title: mode.title ?? '', message: mode.message ?? '', icon: mode.icon ?? null,
      timeout: 0, dismissible: false,
      actions: mode.cancel ? [{label: mode.cancelLabel ?? interfaceText("stageHead.cancel"), tip: interfaceText("stageHead.esc"), tipKey: "stageHead.esc", run: () => mode.cancel()}] : [],
      onDismiss: () => { if (handle && modeHandle === handle) modeHandle = null; }});
    modeHandle = handle;
  }

  /**
   * A tutorial's strip (docs/TUTORIALS.md) in the start, where the crumb is, or null to end it. The strip is the
   * tutorial's own element; the header only gives it its place and keeps messages off it.
   */
  function setLesson(element) {
    if (lesson === (element ?? null)) return;
    lesson?.remove();
    lesson = element ?? null;
    if (lesson) appendLocalized(start, lesson);
    setAttr(root, 'data-lesson', Boolean(lesson));
    reposition();
  }

  return {
    root, start, end, update, setZoom, setToolOptions, adopt, placeMessage, releaseMessage, showMode, setViewMenu, setLesson,
    get toolOptions() { return bar; },
    destroy() { controller.abort(); observer?.disconnect(); bar?.destroy?.(); modeHandle?.dismiss(); },
  };
}
