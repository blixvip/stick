/**
 * A tutorial in progress (docs/TUTORIALS.md): which step it is on, whether the
 * person did it, and when it is finished. Pure: it knows no DOM, no editor and
 * no clock. Its owner (tutorials.mjs) tells it when something happened
 * (pulse) and which commands ran (ran); the presenter draws what it reports.
 *
 * `read()` returns the editor as the steps read it (tutorial-probe.mjs). The
 * engine reads once when a step begins and compares later readings with it,
 * so a step is done by what the person changed, never by how the editor
 * happened to be.
 *
 * Events (onChange({kind, ...})): 'step' (a step began), 'satisfied' (its
 * `done` turned true), 'finished' (the last step was left).
 */
export class TutorialEngine {
  constructor(tutorial, {read, onChange = () => {}} = {}) {
    if (!tutorial?.steps?.length) throw new TypeError('A tutorial needs at least one step.');
    if (typeof read !== 'function') throw new TypeError('A tutorial reads the editor through read().');
    this.tutorial = tutorial;
    this.read = read;
    this.onChange = onChange;
    this.index = -1;
    this.start = null;
    this.commands = new Set();
    this.satisfied = false;
    this.finished = false;
  }

  get count() { return this.tutorial.steps.length; }
  get step() { return this.tutorial.steps[this.index] ?? null; }
  get first() { return this.index <= 0; }
  get last() { return this.index === this.count - 1; }
  /** True when the step waits for the person to do something. */
  get waits() { return typeof this.step?.done === 'function'; }
  /** How far the tutorial is, 0 to 1: finished steps over all steps. */
  get progress() { return this.finished ? 1 : Math.max(0, this.index + (this.satisfied ? 1 : 0)) / this.count; }

  /** Begins (or begins again) at the first step. */
  begin() { this.finished = false; return this.go(0); }

  /** Goes to step `index`; past the last one the tutorial is finished. */
  go(index) {
    if (this.finished) return false;
    if (index >= this.count) return this.finish();
    this.index = Math.max(0, index);
    this.start = freeze(this.read());
    this.commands = new Set();
    this.satisfied = false;
    this.onChange({kind: 'step', step: this.step, index: this.index});
    return true;
  }
  next() { return this.go(this.index + 1); }
  back() { return this.go(this.index - 1); }

  /** A command ran (an action's id). It counts for the step that is waiting. */
  ran(command) {
    if (this.finished || this.index < 0 || typeof command !== 'string') return;
    this.commands.add(command);
  }

  /**
   * Something happened: asks the step whether it is done. Returns true the
   * one time it turns done. A step that only explains is never done here.
   */
  pulse() {
    const step = this.step;
    if (this.finished || !step || this.satisfied || typeof step.done !== 'function') return false;
    const now = Object.create(this.read(), {ran: {value: this.commands, enumerable: true}});
    let done = false;
    try { done = Boolean(step.done(now, this.start)); } catch { done = false; }
    if (!done) return false;
    this.satisfied = true;
    this.onChange({kind: 'satisfied', step, index: this.index, now});
    return true;
  }

  finish() {
    if (this.finished) return false;
    this.finished = true;
    this.satisfied = true;
    this.onChange({kind: 'finished'});
    return true;
  }
}

/** A reading kept for later comparison: its values as they are now, whatever getters produced them. */
function freeze(reading) {
  const copy = {};
  for (const key in reading) {
    const value = reading[key];
    copy[key] = value && typeof value === 'object' ? Object.freeze({...value}) : value;
  }
  return Object.freeze(copy);
}
