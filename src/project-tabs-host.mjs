import {ProjectTabs} from './project-tabs.mjs';
import {sessionUnsaved} from './editor-sessions.mjs';

/**
 * The open projects and the one editor they share (docs/PROJECT-TABS.md).
 *
 * One project is live: it alone has the editor's document, the renderer, the
 * playback and thumbnail workers and the preview caches. Every other open
 * project rests as a detached editor session (editor-sessions.mjs) beside what
 * the application keeps for it (`hooks.capture()`): no worker mirrors it, no
 * cache holds its frames and no timer runs for it. Bringing a project to the
 * front is the document replacement every module already handles after a load,
 * with the project's own history and state instead of a fresh one.
 *
 * The application supplies `hooks`:
 *   settle()            finishes the edit in progress and leaves Draw and Build; resolves false to stay
 *   capture()           what the application holds for the project in front, read before it leaves
 *   restore(state)      puts a captured state back, before the editor publishes the project
 *   shown(record, state) after a project came to the front, with the state it rested with
 *   idle()              true when nothing the person is doing would be disturbed by background work
 *   checkpoint(record, signal)  writes a resting project's recovery copy; resolves true once it is stored
 *   confirmClose()      asks about unsaved changes of the project in front; resolves false to keep it open
 *   blank()             loads a new, empty document in place (the last project closed)
 *   release(record)     ends what a closed project held outside the editor
 *   refuse(reason)      tells the person why nothing happened ('limit', 'busy')
 *   busy()              true while a save or an import holds the project in front
 */
export function createProjectTabsHost({editor, hooks, tabs = new ProjectTabs()}) {
  let running = false, parking = null, stamp = 0, restingTimer = null;
  const record = (fields = {}) => ({name: editor.name, dirty: false, saved: null, session: null, state: null, blank: false, ...fields});
  // The project the editor started with.
  tabs.add(record({blank: true}));
  tabs.addEventListener('change', () => { stamp++; });

  /** One switch, close or open at a time; a second request while one runs is dropped, never queued behind it. */
  async function exclusive(operation) {
    if (running) return false;
    if (hooks.busy?.()) { hooks.refuse?.('busy'); return false; }
    running = true;
    try { return await operation(); }
    finally { running = false; }
  }

  function leave(front) {
    front.state = hooks.capture();
    front.dirty = editor.dirty; front.name = editor.name;
    front.session = editor.detachDocument();
  }
  function enter(next) {
    const {session, state} = next;
    next.checkpoint?.abort();
    next.session = null; next.state = null;
    tabs.activate(next.id);
    hooks.restore(state);
    editor.resumeDocument(session);
    hooks.shown?.(next, state);
    scheduleResting();
  }

  /**
   * A project that left the front with changes its recovery copy does not have
   * yet is owed one. It cannot change while it rests, so one write settles it;
   * the write waits for a quiet moment and yields to the project in front.
   */
  const owed = () => tabs.items.find(item => item.session && item.dirty && item.state && !item.state.recoveryCurrent && (item.checkpointFailures ?? 0) < 3);
  function scheduleResting(delay = 1500) {
    if (restingTimer !== null || !hooks.checkpoint || !owed()) return;
    restingTimer = setTimeout(checkpointResting, delay);
  }
  async function checkpointResting() {
    restingTimer = null;
    const item = owed();
    if (!item) return;
    if (running || !hooks.idle()) { scheduleResting(1000); return; }
    const controller = item.checkpoint = new AbortController();
    let retry = 250;
    try {
      if (await hooks.checkpoint(item, controller.signal) && item.state) item.state.recoveryCurrent = true;
    } catch (error) {
      if (error?.name !== 'AbortError') { item.checkpointFailures = (item.checkpointFailures ?? 0) + 1; retry = 15000; hooks.checkpointFailed?.(error, item); }
    } finally {
      if (item.checkpoint === controller) item.checkpoint = null;
    }
    scheduleResting(retry);
  }

  /** Brings an open project to the front. Resolves false when it stays where it is. */
  function activate(id) {
    return exclusive(async () => {
      const next = tabs.get(id);
      if (!next || !next.session) return Boolean(next);
      if (!(await hooks.settle())) return false;
      if (tabs.get(id) !== next || !next.session) return false;
      leave(tabs.active);
      enter(next);
      return true;
    });
  }

  /**
   * Whether the project in front gives its place to the next one opened: an
   * empty animation nobody touched has nothing to keep beside the new project.
   */
  function replaceable() {
    const front = tabs.active;
    return Boolean(front?.blank && !editor.dirty && !editor.canUndo && !editor.canRedo && !editor._movieclipScopes?.length);
  }
  /** True when another project can open; says why when it cannot. */
  function canOpen() {
    if (replaceable() || !tabs.full) return true;
    hooks.refuse?.('limit');
    return false;
  }
  /**
   * The editor's onDetach for a load that opens a new tab: the project in
   * front rests from this instant. `opened()` or `failed()` must follow.
   */
  function park(session) {
    const front = tabs.active;
    front.state = hooks.capture();
    front.dirty = sessionUnsaved(session);
    front.name = session.name;
    front.session = session;
    parking = front;
  }
  /** The load published: the editor's document is a project of its own, in front. */
  function opened({blank = false} = {}) {
    const front = tabs.active;
    if (parking === front) { parking = null; scheduleResting(); return tabs.add(record({blank})); }
    // The untouched empty animation gave its place.
    front.blank = blank; front.saved = null;
    tabs.update(front.id, {name: editor.name, dirty: editor.dirty});
    return front;
  }
  /** The load failed after the project in front was parked: it comes back as it was. */
  function failed() {
    const front = parking;
    if (!front) return false;
    parking = null;
    const {session, state} = front;
    front.session = null; front.state = null;
    hooks.restore(state);
    editor.resumeDocument(session);
    hooks.shown?.(front, state);
    return true;
  }

  /**
   * Closes a project. It comes to the front first, so the question about its
   * unsaved changes is asked about what the person sees. The last project
   * closes into a new, empty one: the window always has a project.
   */
  function close(id = tabs.activeId) {
    return exclusive(async () => {
      const target = tabs.get(id);
      if (!target) return false;
      if (!(await hooks.settle())) return false;
      if (target.session) { leave(tabs.active); enter(target); }
      if (!(await hooks.confirmClose())) return false;
      if (tabs.get(id) !== target || tabs.activeId !== id) return false;
      const next = tabs.successor(id);
      target.state = hooks.capture();
      if (!next) {
        const session = editor.detachDocument();
        hooks.blank();
        hooks.release({...target, session});
        editor.discardDocument(session);
        target.blank = true; target.saved = null; target.state = null;
        tabs.update(id, {name: editor.name, dirty: false});
        hooks.shown?.(target);
        return true;
      }
      target.session = editor.detachDocument();
      enter(next);
      tabs.remove(id);
      target.checkpoint?.abort();
      hooks.release(target);
      editor.discardDocument(target.session);
      return true;
    });
  }

  /** Closes every other project that has nothing unsaved; the ones with changes stay, each asks on its own. */
  function closeSaved({keep = tabs.activeId} = {}) {
    return exclusive(async () => {
      let closed = 0;
      for (const item of [...tabs.items]) {
        if (item.id === keep || item.id === tabs.activeId || item.dirty || !item.session) continue;
        tabs.remove(item.id);
        item.checkpoint?.abort();
        hooks.release(item);
        editor.discardDocument(item.session);
        closed++;
      }
      return closed;
    });
  }

  /**
   * Saves every project with unsaved changes, the one in front last so it is
   * the one left in front. `save` saves the project in front and resolves
   * false when the person cancelled; saving stops there.
   */
  async function saveAll(save) {
    const origin = tabs.activeId;
    for (const item of [...tabs.items.filter(item => item.id !== origin), tabs.get(origin)]) {
      if (!item || !tabs.get(item.id)) continue;
      if (item.session ? !item.dirty : !editor.dirty) continue;
      if (item.session && !(await activate(item.id))) return false;
      if (!(await save())) return false;
    }
    if (tabs.activeId !== origin && tabs.get(origin)) await activate(origin);
    return true;
  }

  /** What the tab of the project in front shows; the application calls this as its title changes. */
  function sync({name = editor.name, dirty = editor.dirty, saved} = {}) {
    const front = tabs.active;
    if (!front || front.session) return false;
    if (dirty || editor.canUndo) front.blank = false;
    return tabs.update(front.id, saved === undefined ? {name, dirty} : {name, dirty, saved});
  }

  /** What closing the window would lose, for the question the desktop asks. */
  function summary() {
    const front = tabs.active, unsaved = tabs.items.filter(item => (item === front && !item.session ? editor.dirty : item.dirty));
    return {open: tabs.size, unsaved: unsaved.length, unsavedName: unsaved[0] ? (unsaved[0] === front && !front.session ? editor.name : unsaved[0].name) : '', stamp};
  }

  return {tabs, activate, close, closeSaved, saveAll, sync, summary, replaceable, canOpen, park, opened, failed,
    settle: () => hooks.settle(),
    /** Stops background work (the window closes). */
    dispose() { clearTimeout(restingTimer); restingTimer = null; for (const item of tabs.items) item.checkpoint?.abort(); },
    get running() { return running; }};
}
