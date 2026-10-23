/**
 * How a tutorial shows (docs/TUTORIALS.md). It adds no row to the window:
 *
 *   the strip     in the stage header, where the scene's name is: the step's
 *                 one sentence, the step dots, Show me, Next (Skip while the
 *                 step waits for the person) and Leave
 *   the caption   the same sentence on a line of its own just under the
 *                 header, over the stage's margin, where the strip has no room
 *                 for it (a narrow stage, a small window): it is never cut
 *   the details   a popover under the strip, on request: every step, the
 *                 longer explanation, Start over and Leave
 *   the mark      a ring around the control or region the step is about, or
 *                 a dot on the exact joint to drag; it follows its target
 *   Show me       a pointer that acts the step out without doing it: it
 *                 presses, drags or scrolls in the air, then the person does it
 *
 * The presenter draws what the engine (tutorial-engine.mjs) reports and owns
 * no tutorial state. ctx: {stageHead, targets, overlays, toasts, commands(),
 * app() → what a step's words depend on, onNext, onBack, onGo(index),
 * onLeave, onRestart, onHome, onStart(tutorial), document}.
 */
import {localizedText, localizedAttribute, replaceLocalized, clearTranslation} from '../localization-bindings.mjs';
import {t as interfaceText} from '../localization.mjs';
import {icon} from '../icons.mjs';
import {createPopover} from '../ui/ui-popover.mjs';
import {bandBottom} from '../shell/topbar.mjs';

/** A step waits this long for the person before the mark pulses again and Show me plays once. */
export const NUDGE_AFTER_MS = 7000;
export const NUDGE_EVERY_MS = 11000;
/** After a step is done its praise shows this long before the next step. */
export const ADVANCE_AFTER_MS = 1300;
/** The mark follows its target for this long after something moved. */
const FOLLOW_MS = 700;
const RING_PAD = 5;

const resolveKey = (value, argument) => (typeof value === 'function' ? value(argument) : value);

export function createTutorialPresenter(ctx) {
  const doc = ctx.document ?? globalThis.document, win = doc.defaultView ?? globalThis;
  const reducedMotion = () => Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const element = (tag, className, parent) => { const node = doc.createElement(tag); if (className) node.className = className; parent?.append(node); return node; };
  const glyph = (node, name) => { node.insertAdjacentHTML('afterbegin', icon(name)); return node; };
  const button = (className, {variant, size = 'sm', iconName, labelKey, labelParams, onClick} = {}) => {
    const node = element('button', className);
    node.type = 'button';
    if (variant) node.dataset.variant = variant;
    node.dataset.size = size;
    if (labelKey) { const label = element('span', 'ui-label', node); localizedText(label, labelKey, labelParams); }
    if (iconName) glyph(node, iconName);
    if (onClick) node.addEventListener('click', onClick);
    return node;
  };

  let engine = null, tutorial = null, popover = null, shown = false, finished = null, lastReading = null;
  let frame = 0, followUntil = 0, pointerDown = false, lastRect = '', nudgeTimer = 0, demoPlayed = new Set(), demo = null, paused = null;
  const controller = new AbortController(), {signal} = controller;

  // ---- The strip -------------------------------------------------------------------------------------------------
  const strip = element('div', 'tutorial-strip');
  strip.setAttribute('role', 'group');
  strip.dataset.ui = '';
  const title = button('ui-button tutorial-strip-title', {variant: 'ghost', iconName: 'learn', onClick: () => toggleDetails()});
  title.setAttribute('aria-haspopup', 'dialog');
  title.setAttribute('aria-expanded', 'false');
  const count = element('span', 'tutorial-strip-count', title);
  title.insertAdjacentHTML('beforeend', icon('chevron-down', 'tutorial-strip-chevron'));
  const dots = element('span', 'tutorial-dots');
  dots.setAttribute('aria-hidden', 'true');
  const say = element('p', 'tutorial-say');
  const sayIcon = element('span', 'tutorial-say-check', say);
  sayIcon.innerHTML = icon('check');
  const sayText = element('span', 'tutorial-say-text', say);
  const showMe = button('ui-button tutorial-show', {variant: 'outline', iconName: 'play', labelKey: 'tutorials.showMe', onClick: () => playDemo()});
  const backButton = button('ui-icon-button tutorial-back', {iconName: 'chevron-left', onClick: () => ctx.onBack()});
  localizedAttribute(backButton, 'aria-label', 'tutorials.back');
  localizedAttribute(backButton, 'data-tooltip', 'tutorials.back');
  const nextButton = button('ui-button tutorial-next', {variant: 'primary', labelKey: 'tutorials.next', onClick: () => ctx.onNext()});
  const homeButton = button('ui-button tutorial-home', {variant: 'outline', labelKey: 'tutorials.backToHome', onClick: () => ctx.onHome()});
  const nextTutorial = button('ui-button tutorial-next-tutorial', {variant: 'primary', iconName: 'arrow-right'});
  const nextTutorialLabel = element('span', 'ui-label');
  nextTutorial.prepend(nextTutorialLabel);
  nextTutorial.addEventListener('click', () => { if (finished?.next) ctx.onStart(finished.next); });
  const leave = button('ui-icon-button tutorial-leave', {iconName: 'close', onClick: () => ctx.onLeave()});
  localizedAttribute(leave, 'aria-label', 'tutorials.leave');
  localizedAttribute(leave, 'data-tooltip', 'tutorials.leave');
  strip.append(title, dots, say, backButton, showMe, nextButton, homeButton, nextTutorial, leave);

  // ---- The caption, the mark and Show me's pointer: fixed boxes above the editor, below menus and dialogs ----------
  const caption = element('p', 'tutorial-caption');
  caption.hidden = true;
  const captionCheck = element('span', 'tutorial-say-check', caption);
  captionCheck.innerHTML = icon('check');
  const captionText = element('span', 'tutorial-caption-text', caption);
  const mark = element('div', 'tutorial-mark');
  mark.hidden = true;
  mark.setAttribute('aria-hidden', 'true');
  const ghost = element('div', 'tutorial-ghost');
  ghost.hidden = true;
  ghost.setAttribute('aria-hidden', 'true');
  ghost.innerHTML = `<span class="tutorial-ghost-pointer">${icon('cursor')}</span><span class="tutorial-ghost-note"></span>`;
  const ghostNote = ghost.querySelector('.tutorial-ghost-note');

  const app = () => ctx.app();
  const shortcutOf = step => (step?.shortcut ? ctx.commands()?.shortcut(step.shortcut) ?? '' : '');

  // ---- Words -------------------------------------------------------------------------------------------------------
  function writeStrip() {
    if (!engine) return;
    const step = engine.step, done = engine.satisfied && !engine.finished;
    strip.dataset.state = engine.finished ? 'finished' : done ? 'done' : 'active';
    localizedAttribute(strip, 'aria-label', 'tutorials.stripLabel', {title: {messageKey: tutorial.titleKey}});
    localizedAttribute(title, 'aria-label', 'tutorials.stepsLabel', {title: {messageKey: tutorial.titleKey}});
    localizedAttribute(title, 'data-tooltip', 'tutorials.stepsLabel', {title: {messageKey: tutorial.titleKey}});
    if (engine.finished) {
      localizedText(count, 'tutorials.finishedCount', {});
      localizedText(sayText, 'tutorials.finished', {title: {messageKey: tutorial.titleKey}});
    } else {
      localizedText(count, 'tutorials.stepOf', {step: engine.index + 1, count: engine.count});
      const key = done ? resolveKey(step.doneKey, lastReading ?? {}) : resolveKey(step.sayKey, app());
      localizedText(sayText, key, {shortcut: shortcutOf(step)});
    }
    replaceLocalized(dots, ...tutorial.steps.map((_, index) => {
      const dot = doc.createElement('i');
      dot.dataset.state = engine.finished || index < engine.index || (index === engine.index && done) ? 'done' : index === engine.index ? 'current' : 'todo';
      return dot;
    }));
    const waits = engine.waits && !engine.finished;
    backButton.hidden = engine.finished || engine.first;
    showMe.hidden = !waits || done || !step?.demo;
    // A step that waits for the person can still be skipped: nobody is held on a step they cannot do.
    const skips = waits && !done;
    nextButton.hidden = engine.finished;
    nextButton.dataset.variant = skips ? 'ghost' : 'primary';
    if (!nextButton.hidden) localizedText(nextButton.querySelector('.ui-label'), skips ? 'tutorials.skip' : engine.last ? 'tutorials.finish' : 'tutorials.next', {});
    homeButton.hidden = !engine.finished;
    nextTutorial.hidden = !engine.finished || !finished?.next;
    if (!nextTutorial.hidden) localizedText(nextTutorialLabel, 'tutorials.nextTutorial', {title: {messageKey: finished.next.titleKey}});
    ctx.toasts?.announce?.(sayText.textContent);
    syncSay();
  }

  /**
   * The sentence shows in the strip while it fits there on one line, else on the caption under the header. The
   * strip's own sentence keeps its place either way (it only stops showing), so the measurement does not move.
   */
  function syncSay() {
    const below = Boolean(engine && shown && strip.getClientRects().length && sayText.scrollWidth > sayText.clientWidth + 1);
    strip.toggleAttribute('data-say-below', below);
    if (caption.hidden === below) caption.hidden = !below;
    if (!below) return;
    if (captionText.textContent !== sayText.textContent) captionText.textContent = sayText.textContent;
    caption.dataset.state = strip.dataset.state;
    placeCaption();
  }
  function placeCaption() {
    if (caption.hidden) return;
    const head = ctx.stageHead.root.getBoundingClientRect(), style = caption.style;
    style.setProperty('--x', `${Math.round(head.left + 8)}px`); style.setProperty('--y', `${Math.round(head.bottom + 6)}px`);
    style.setProperty('--w', `${Math.max(120, Math.round(head.width - 16))}px`);
  }
  const stripObserver = win.ResizeObserver ? new win.ResizeObserver(() => syncSay()) : null;
  stripObserver?.observe(strip);

  // ---- The details -------------------------------------------------------------------------------------------------
  function detailsBody() {
    const body = doc.createDocumentFragment();
    const line = element('p', 'tutorial-pop-line');
    localizedText(line, tutorial.lineKey, {});
    const list = element('ol', 'tutorial-steps');
    tutorial.steps.forEach((step, index) => {
      const state = engine.finished || index < engine.index || (index === engine.index && engine.satisfied) ? 'done' : index === engine.index ? 'current' : 'todo';
      const item = element('li', 'tutorial-step', list);
      item.dataset.state = state;
      const badge = element('span', 'tutorial-step-mark', item);
      if (state === 'done') badge.innerHTML = icon('check'); else badge.textContent = String(index + 1);
      const text = element('div', 'tutorial-step-text', item);
      // A finished step can be visited again; a later one waits its turn.
      const name = element(index < engine.index && !engine.finished ? 'button' : 'span', 'tutorial-step-name', text);
      if (name.localName === 'button') { name.type = 'button'; name.addEventListener('click', () => { hideDetails(); ctx.onGo(index); }); }
      localizedText(name, resolveKey(step.sayKey, app()), {shortcut: shortcutOf(step)});
      if (state === 'current' && step.moreKey) {
        const more = element('p', 'tutorial-step-more', text);
        localizedText(more, resolveKey(step.moreKey, app()), {shortcut: shortcutOf(step)});
        const keys = shortcutOf(step);
        if (keys) { const hint = element('p', 'tutorial-step-shortcut', text); localizedText(hint, 'tutorials.shortcut', {shortcut: keys}); }
      }
    });
    body.append(line, list);
    return body;
  }
  function detailsFoot() {
    const foot = element('div', 'tutorial-pop-foot');
    foot.append(
      button('ui-button', {variant: 'ghost', iconName: 'reset', labelKey: 'tutorials.startOver', onClick: () => { hideDetails(); ctx.onRestart(); }}),
      button('ui-button', {variant: 'ghost', labelKey: 'tutorials.leave', onClick: () => { hideDetails(); ctx.onLeave(); }}));
    return foot;
  }
  function showDetails({focus = true} = {}) {
    if (!engine || popover?.isOpen) return;
    popover = createPopover({
      anchor: title, placement: 'bottom-start', title: interfaceText(tutorial.titleKey), titleKey: tutorial.titleKey,
      body: detailsBody(), foot: detailsFoot(), overlays: ctx.overlays, icon: name => icon(name), className: 'tutorial-popover',
      topInset: bandBottom(doc), returnFocus: focus,
      onClose: () => { title.setAttribute('aria-expanded', 'false'); popover?.element.remove(); popover = null; },
    });
    popover.show();
    if (!focus) doc.activeElement?.blur?.();
  }
  function hideDetails() { popover?.hide('hide'); }
  function toggleDetails() { if (popover?.isOpen) hideDetails(); else showDetails(); }
  /** The open details follow the step: its list and the current explanation. */
  function refreshDetails() {
    if (!popover?.isOpen) return;
    replaceLocalized(popover.body, detailsBody());
    popover.update();
  }

  // ---- The mark ------------------------------------------------------------------------------------------------------
  const reading = () => (engine && !engine.finished && shown && strip.getClientRects().length ? ctx.targets.resolve(engine.step?.target) : null);
  function place() {
    const target = reading();
    const done = engine?.satisfied;
    if (!target || done) { if (!mark.hidden) { mark.hidden = true; lastRect = ''; } return; }
    const {rect, point} = target;
    const key = `${point ? 'dot' : 'ring'}|${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
    if (key === lastRect && !mark.hidden) return;
    lastRect = key;
    mark.hidden = false;
    mark.dataset.kind = point ? 'dot' : 'ring';
    const style = mark.style;
    if (point) {
      style.setProperty('--x', `${Math.round(point.x)}px`); style.setProperty('--y', `${Math.round(point.y)}px`);
      style.removeProperty('--w'); style.removeProperty('--h');
    } else {
      style.setProperty('--x', `${Math.round(rect.left - RING_PAD)}px`); style.setProperty('--y', `${Math.round(rect.top - RING_PAD)}px`);
      style.setProperty('--w', `${Math.round(rect.width + RING_PAD * 2)}px`); style.setProperty('--h', `${Math.round(rect.height + RING_PAD * 2)}px`);
    }
  }
  function tick(now) {
    frame = 0;
    place();
    placeCaption();
    if (engine && (pointerDown || now < followUntil)) frame = win.requestAnimationFrame(tick);
  }
  /** Something may have moved the target: follow it for a moment. */
  function follow(ms = FOLLOW_MS) {
    followUntil = Math.max(followUntil, win.performance.now() + ms);
    if (!frame && engine) frame = win.requestAnimationFrame(tick);
  }
  function pulseMark() {
    mark.classList.remove('is-pulsing');
    void mark.offsetWidth;
    mark.classList.add('is-pulsing');
  }

  // ---- Nudges: a waiting step draws the eye again, and shows itself once -----------------------------------------------
  function armNudge(delay = NUDGE_AFTER_MS) {
    win.clearTimeout(nudgeTimer);
    if (!engine || engine.finished || engine.satisfied) return;
    nudgeTimer = win.setTimeout(() => {
      if (!engine || engine.finished || engine.satisfied || doc.hidden) return armNudge(NUDGE_EVERY_MS);
      const step = engine.step;
      follow();
      pulseMark();
      if (engine.waits && step.demo && !demoPlayed.has(step.id) && !pointerDown && !ctx.overlays?.blocksHotkeys?.()) playDemo();
      armNudge(NUDGE_EVERY_MS);
    }, delay);
  }

  // ---- Show me -------------------------------------------------------------------------------------------------------
  function stopDemo() {
    demo?.abort();
    demo = null;
    ghost.hidden = true;
    ghost.removeAttribute('data-kind');
  }
  /**
   * Acts the step out with a pointer of its own. Nothing is pressed and no
   * event is sent: the editor is exactly as it was when it ends.
   */
  async function playDemo() {
    const step = engine?.step, target = reading();
    if (!step?.demo || !target || engine.satisfied) return;
    stopDemo();
    demoPlayed.add(step.id);
    const run = demo = new AbortController();
    const wait = ms => new Promise(resolve => { const timer = win.setTimeout(resolve, ms); run.signal.addEventListener('abort', () => { win.clearTimeout(timer); resolve(); }, {once: true}); });
    const {rect, point} = target, kind = step.demo.kind;
    const centre = point ?? (step.demo.at === 'corner' ? {x: rect.left + Math.min(90, rect.width * 0.18), y: rect.top + Math.min(70, rect.height * 0.2)} : {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
    const from = {x: Math.min(win.innerWidth - 60, centre.x + 120), y: Math.min(win.innerHeight - 60, centre.y + 90)};
    const move = (x, y) => { ghost.style.setProperty('--x', `${Math.round(x)}px`); ghost.style.setProperty('--y', `${Math.round(y)}px`); };
    const glide = async (a, b, ms) => {
      if (reducedMotion()) { move(b.x, b.y); return wait(Math.min(ms, 200)); }
      const start = win.performance.now();
      await new Promise(resolve => {
        const step2 = now => {
          if (run.signal.aborted) return resolve();
          const u = Math.min(1, (now - start) / ms), e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
          move(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e);
          if (u < 1) win.requestAnimationFrame(step2); else resolve();
        };
        win.requestAnimationFrame(step2);
      });
    };
    const keys = kind === 'keys' ? ctx.commands()?.shortcut(step.demo.command) ?? '' : (step.demo.keys ?? []).join(' + ');
    ghost.dataset.kind = kind;
    clearTranslation(ghostNote);
    if (kind === 'scroll') localizedText(ghostNote, resolveKey(step.sayKey, app()), {}); else ghostNote.textContent = keys;
    ghostNote.hidden = !(kind === 'scroll' || keys);
    ghost.hidden = false;
    ghost.classList.remove('is-down');
    try {
      move(from.x, from.y);
      await glide(from, centre, 620);
      if (run.signal.aborted) return;
      if (kind === 'drag') {
        ghost.classList.add('is-down');
        await wait(220);
        await glide(centre, {x: centre.x + (step.demo.dx ?? 60), y: centre.y + (step.demo.dy ?? 0)}, 820);
        ghost.classList.remove('is-down');
        await wait(420);
      } else if (kind === 'scroll') {
        ghost.classList.add('is-scrolling');
        await wait(1500);
        ghost.classList.remove('is-scrolling');
      } else if (kind === 'keys') {
        await wait(1400);
      } else {
        ghost.classList.add('is-down');
        await wait(280);
        ghost.classList.remove('is-down');
        await wait(520);
      }
    } finally {
      if (demo === run) { demo = null; ghost.hidden = true; ghost.classList.remove('is-down', 'is-scrolling'); }
    }
  }

  // ---- Paused: the strip has no room while a tool's options or another workspace take the header's start --------------
  function syncPaused() {
    const hiddenStrip = Boolean(engine && shown && !engine.finished && !strip.getClientRects().length);
    if (hiddenStrip === Boolean(paused)) return;
    if (!hiddenStrip) { paused.dismiss(); paused = null; return; }
    const notice = ctx.toasts?.show({
      key: 'tutorial-paused', slot: 'toast', icon: 'learn', timeout: 0, dismissible: false,
      title: interfaceText('tutorials.paused'), titleKey: 'tutorials.paused', message: interfaceText('tutorials.pausedHow'), messageKey: 'tutorials.pausedHow',
      actions: [{label: interfaceText('tutorials.resume'), labelKey: 'tutorials.resume', run: () => ctx.onResume()}, {label: interfaceText('tutorials.leave'), labelKey: 'tutorials.leave', run: () => ctx.onLeave()}],
      onDismiss: () => { if (paused === notice) paused = null; },
    });
    paused = notice ?? null;
  }

  doc.addEventListener('pointerdown', () => { pointerDown = true; stopDemo(); follow(); }, {capture: true, signal});
  for (const name of ['pointerup', 'pointercancel']) doc.addEventListener(name, () => { pointerDown = false; follow(); }, {capture: true, signal});
  win.addEventListener('resize', () => follow(), {signal});
  doc.addEventListener('scroll', () => follow(), {capture: true, passive: true, signal});

  return {
    strip,
    /** Starts showing `nextEngine`'s tutorial at the step it is on. */
    show(nextEngine) {
      engine = nextEngine; tutorial = nextEngine.tutorial; finished = null; lastReading = null; demoPlayed = new Set(); lastRect = '';
      if (!shown) { doc.body.append(caption, mark, ghost); ctx.stageHead.setLesson(strip); shown = true; }
      writeStrip();
      follow(1200);
      pulseMark();
      armNudge();
      syncPaused();
    },
    /** The engine changed: a step began, was done, or the tutorial finished. `outcome` names what comes next when it finished. */
    update(change, outcome = null) {
      if (!engine) return;
      if (change.kind === 'finished') { finished = outcome ?? {next: null}; stopDemo(); hideDetails(); win.clearTimeout(nudgeTimer); mark.hidden = true; }
      if (change.kind === 'satisfied') { lastReading = change.now; stopDemo(); win.clearTimeout(nudgeTimer); }
      if (change.kind === 'step') { stopDemo(); lastRect = ''; if (change.index > 0) hideDetails(); armNudge(); }
      writeStrip();
      refreshDetails();
      place();
      if (change.kind === 'step') { follow(1200); pulseMark(); }
    },
    /** Something happened in the editor: the mark follows, and a waiting step's nudge starts over. */
    pulse() { if (!engine) return; follow(); armNudge(); syncPaused(); syncSay(); },
    showDetails, hideDetails, playDemo,
    get paused() { return Boolean(paused); },
    get demoRunning() { return Boolean(demo); },
    /** Ends the presentation: the header gets its crumb back. */
    hide() {
      win.clearTimeout(nudgeTimer); stopDemo(); hideDetails();
      if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
      paused?.dismiss(); paused = null;
      if (shown) { ctx.stageHead.setLesson(null); caption.remove(); mark.remove(); ghost.remove(); shown = false; }
      mark.hidden = true; caption.hidden = true; engine = null; tutorial = null; finished = null;
    },
    destroy() { this.hide(); stripObserver?.disconnect(); controller.abort(); },
  };
}
