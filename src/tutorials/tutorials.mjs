/**
 * The tutorials (docs/TUTORIALS.md): starting one, feeding it what happens in
 * the editor, and ending it. A tutorial runs in the real editor, in Animate,
 * with the Advanced timeline, on a practice animation of its own.
 *
 *   - Starting opens the practice animation as a new project (the `new`
 *     command), beside the person's own, and sets it up as the tutorial needs.
 *     The next tutorial starts over on the same practice animation while it is
 *     still in front and untouched since.
 *   - While it runs, the practice animation is never "unsaved": what a lesson
 *     changes is not work to lose, so closing the window asks nothing and no
 *     recovery copy is written for it. Editing on after the tutorial is
 *     ordinary editing again.
 *   - A step is done by what the person does. The editor is read only when
 *     something happens (a press, a key, the wheel, a command, an edit): one
 *     reading per frame at most, and twice more shortly after for what settles
 *     late (playback starting, a zoom gliding). Nothing polls between events.
 *   - Opening another project, a new one or Home ends the tutorial.
 *
 * DOM-free at import. ctx (from app.mjs): {editor, state, actions, overlays,
 * stageHead, toasts, guarded, fail, toast, fit(), setTool(tool), viewport,
 * ready (resolves once the editor started), commands(), settings(), shell(),
 * timeline(), studio(), home(), touch(), mode(), fitted(), updateTitle()};
 * getters for what the app creates later.
 */
import {t as interfaceText} from '../localization.mjs';
import {TUTORIALS, tutorialById} from './tutorial-catalog.mjs';
import {TutorialEngine} from './tutorial-engine.mjs';
import {createTutorialProbe} from './tutorial-probe.mjs';
import {createTutorialTargets} from './tutorial-targets.mjs';
import {createTutorialPresenter, ADVANCE_AFTER_MS} from './tutorial-presenter.mjs';

/** The late readings after an event: what an action started may show only then. */
const SETTLE_MS = [320, 1200];
const PULSE_EVENTS = ['pointerup', 'keyup', 'click', 'input', 'change'];

export function createTutorials(ctx) {
  const {editor, state, actions, overlays, guarded} = ctx;
  const doc = ctx.viewport?.ownerDocument ?? globalThis.document, win = doc?.defaultView ?? globalThis;
  const read = createTutorialProbe(ctx);
  let presenter = null, engine = null, run = null, practice = null, restoreMode = null, starting = false;
  let pulseFrame = 0, settleTimers = [], advanceTimer = 0;
  // The practice animations this session made: one that is still in front is used again.
  const practiced = new WeakSet();
  const listeners = new Set();
  const changed = () => { for (const listener of [...listeners]) listener(); };

  const done = () => [...(state.settings.tutorialsDone ?? [])];
  /** The first tutorial not finished yet, after `after` when given. */
  const nextAfter = (after = null) => {
    const finished = new Set(done()), order = after ? [...TUTORIALS.slice(TUTORIALS.indexOf(after) + 1), ...TUTORIALS.slice(0, TUTORIALS.indexOf(after))] : TUTORIALS;
    return order.find(item => !finished.has(item.id)) ?? null;
  };

  function ensurePresenter() {
    presenter ??= createTutorialPresenter({
      document: doc, stageHead: ctx.stageHead, overlays, toasts: ctx.toasts, commands: ctx.commands,
      targets: createTutorialTargets({editor, state, viewport: ctx.viewport, timeline: ctx.timeline, document: doc}),
      app: () => ({touch: Boolean(ctx.touch?.()), zoomGesture: state.settings.canvasZoomGesture, shortcut: command => ctx.commands()?.shortcut(command) ?? ''}),
      onNext: guarded(() => { cancelAdvance(); engine?.next(); }),
      onBack: guarded(() => { cancelAdvance(); engine?.back(); }),
      onGo: guarded(index => { cancelAdvance(); engine?.go(index); }),
      onLeave: guarded(() => leave()),
      onRestart: guarded(() => (engine ? start(engine.tutorial.id) : false)),
      onHome: guarded(() => { leave(); ctx.home()?.show({section: 'learn'}); }),
      onStart: guarded(tutorial => start(tutorial.id)),
      onResume: guarded(() => ctx.studio()?.changeMode('animate')),
    });
    return presenter;
  }

  // ---- What happens in the editor reaches the engine ---------------------------------------------------------------
  const cancelAdvance = () => { win.clearTimeout(advanceTimer); advanceTimer = 0; };
  function evaluate() {
    pulseFrame = 0;
    if (!engine || engine.finished) return;
    // What a lesson changes is not unsaved work (see the module comment).
    if (practice && editor.report === practice && editor.dirty && !editor.dragging && !state.drag) { editor.dirty = false; ctx.updateTitle?.(); }
    presenter.pulse();
    engine.pulse();
  }
  function pulse() {
    if (!engine || engine.finished) return;
    if (!pulseFrame) pulseFrame = win.requestAnimationFrame(evaluate);
    for (const timer of settleTimers) win.clearTimeout(timer);
    settleTimers = SETTLE_MS.map(delay => win.setTimeout(() => { if (!pulseFrame && engine) pulseFrame = win.requestAnimationFrame(evaluate); }, delay));
  }
  function onEngine(change) {
    if (!presenter || !engine) return;
    if (change.kind === 'finished') {
      const tutorial = engine.tutorial;
      if (!done().includes(tutorial.id)) ctx.settings()?.commit({tutorialsDone: [...done(), tutorial.id]});
      presenter.update(change, {next: nextAfter(tutorial)});
      changed();
      return;
    }
    presenter.update(change);
    if (change.kind === 'satisfied') {
      cancelAdvance();
      advanceTimer = win.setTimeout(() => { advanceTimer = 0; engine?.next(); }, ADVANCE_AFTER_MS);
    }
  }

  // ---- Starting and ending -------------------------------------------------------------------------------------------
  /** Starts tutorial `id` on a practice animation. Resolves false when none could open (too many projects are open). */
  async function start(id) {
    const tutorial = tutorialById(id);
    if (!tutorial || starting) return false;
    starting = true;
    try {
      await ctx.ready;
      if (engine) end();
      // Out of Draw and Build first: both finish what they hold, and Build may ask.
      if (ctx.mode() !== 'animate') await ctx.studio()?.changeMode('animate');
      if (ctx.mode() !== 'animate') return false;
      const before = editor.report;
      if (practiced.has(before) && !editor.dirty && !editor.dragging) {
        editor.newDocument();
        state.hidden.clear(); state.locked.clear();
      } else {
        await actions.new();
        if (editor.report === before) return false;
      }
      practice = editor.report;
      practiced.add(practice);
      editor.name = interfaceText('tutorials.practice');
      editor.dirty = false;
      ctx.updateTitle?.();
      const settings = ctx.settings();
      restoreMode = state.settings.timelineMode === 'advanced' ? null : state.settings.timelineMode;
      if (restoreMode) settings?.commit({timelineMode: 'advanced'});
      ctx.home()?.hide();
      ctx.setTool?.('select');
      // Properties in front where the panels are docked; a sheet over the stage (a small window) is not opened for it.
      const shell = ctx.shell?.();
      if (shell?.presentation('properties') === 'docked' && !shell.registry.isVisible('properties')) shell.showPanel('properties', {focus: false});
      if (shell?.presentation('timeline') === 'hidden') shell.showPanel('timeline', {focus: false});
      const first = (editor.selectionFrame ?? editor.frame)?.objects?.[0];
      editor.select(tutorial.setup?.selection === 'figure' && first ? first.unique_id : null);
      ctx.fit?.();

      run = new AbortController();
      const {signal} = run;
      for (const name of PULSE_EVENTS) doc.addEventListener(name, pulse, {capture: true, passive: true, signal});
      doc.addEventListener('wheel', pulse, {capture: true, passive: true, signal});
      editor.addEventListener('change', event => {
        // Another document took the practice animation's place: the tutorial is over.
        if (event.detail?.kind === 'document' && editor.report !== practice) { end(); return; }
        pulse();
      }, {signal});
      overlays?.addEventListener?.('open', pulse, {signal});
      overlays?.addEventListener?.('close', pulse, {signal});

      engine = new TutorialEngine(tutorial, {read, onChange: onEngine});
      // The first step begins before anything shows it: the presenter draws a step, never an engine at rest.
      engine.begin();
      ensurePresenter().show(engine);
      changed();
      return true;
    } finally { starting = false; }
  }

  /** Ends the tutorial where it is. The practice animation stays open, as an ordinary one. */
  function end() {
    if (!engine) return false;
    cancelAdvance();
    for (const timer of settleTimers) win.clearTimeout(timer);
    settleTimers = [];
    if (pulseFrame) { win.cancelAnimationFrame(pulseFrame); pulseFrame = 0; }
    run?.abort(); run = null;
    presenter?.hide();
    if (practice && editor.report === practice && editor.dirty && !editor.dragging) { editor.dirty = false; ctx.updateTitle?.(); }
    engine = null; practice = null;
    if (restoreMode) { const mode = restoreMode; restoreMode = null; ctx.settings()?.commit({timelineMode: mode}); }
    changed();
    return true;
  }
  const leave = () => end();

  Object.assign(actions, {
    /** Help › Tutorials: Home, at its Learn section. */
    tutorials: () => { ctx.home()?.show({section: 'learn'}); },
    "tutorial-leave": () => leave(),
  });

  return {
    list: TUTORIALS,
    start: (id) => start(id),
    leave,
    /** The app's command wrapper reports every command it runs: a step may be waiting for exactly that one. */
    ran(command) { if (engine && !engine.finished) { engine.ran(command); pulse(); } },
    /** Calls `listener()` when a tutorial starts, finishes or ends; returns the unsubscribe function. */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    done,
    next: () => nextAfter(),
    get active() { return engine?.tutorial ?? null; },
    get engine() { return engine; },
    get presenter() { return presenter; },
    destroy() { end(); presenter?.destroy(); presenter = null; },
  };
}
