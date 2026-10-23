import {messageTuple, tupleMessages, localizedText, localizedAttribute, localizedMarkup, appendLocalized} from '../localization-bindings.mjs';

import {t as interfaceText} from '../localization.mjs';

/**
 * The Advanced timeline under a finger (docs/TOUCH.md): its presentation and
 * its commands, mixed into layer-timeline.mjs's Timeline (the input side is
 * timeline-touch.mjs).
 *
 * A fingertip covers several frames, so a finger never has to hit one:
 *
 * - The playhead stands still in the middle of the grid and time slides
 *   under it. A swipe scrubs; letting go settles the nearest frame under the
 *   line. `_offsetX()` keeps half the grid's width of room before frame 1
 *   and after the end (`_pad()`), so every frame can reach the middle.
 *   Playback moves the line as with a mouse (only the line is written while
 *   playing); the grid centres the frame again when playback stops.
 * - What a frame needs is in the action bar, acting on the selected layer at
 *   the playhead: add or remove its key, hold the pose shorter or longer,
 *   copy, paste, easing, and Select, which turns the playhead into a range
 *   with a handle at each end (drag a handle, or scrub to move the far end).
 *   A range's bar moves its frames a frame at a time, copies, cuts, pastes
 *   and deletes them. Everything else is the frame's menu (More, or a press
 *   and hold on a frame).
 *
 * Every command runs the timeline's own (addTrackKey, clearKeys, copySelection,
 * the editor's sheet operations), so undo, locking and the clipboard behave
 * as with a mouse. The bar lives in the timeline header's actions slot
 * (timeline-header.mjs setActions) and is written only when what it shows
 * changes.
 */
import {sheetKeyAt} from '../layer-sheet.mjs';
import {icon} from '../icons.mjs';
import {setAttr, setHidden, setProp, setText} from '../ui/dom-write.mjs';

/** The touch interface's frame widths (px): where a new timeline starts, and pinch's range. */
export const TOUCH_ZOOM = Object.freeze({initial: 30, min: 10, max: 72});
/** How far from a range's edge a finger still takes its handle (px). */
export const HANDLE_REACH = 24;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** The action bar's buttons: [id, glyph, label]; sync decides which show and what they say. Done leads, so leaving a
 * range never needs a swipe along a bar longer than the window. */
const BUTTONS = [
  messageTuple(['done', 'check', interfaceText("common.done")], {2: {key: "common.done", params: {}}}),
  messageTuple(['key', 'diamond', interfaceText("timelineScrubber.addKey")], {2: {key: "timelineScrubber.addKey", params: {}}}),
  messageTuple(['shorter', 'minus', interfaceText("timelineScrubber.shorter")], {2: {key: "timelineScrubber.shorter", params: {}}}),
  messageTuple(['longer', 'plus', interfaceText("timelineScrubber.longer")], {2: {key: "timelineScrubber.longer", params: {}}}),
  messageTuple(['left', 'chevron-left', interfaceText("timelineScrubber.earlier")], {2: {key: "timelineScrubber.earlier", params: {}}}),
  messageTuple(['right', 'chevron-right', interfaceText("timelineScrubber.later")], {2: {key: "timelineScrubber.later", params: {}}}),
  messageTuple(['copy', 'duplicate', interfaceText("common.copy")], {2: {key: "common.copy", params: {}}}),
  messageTuple(['cut', 'cut', interfaceText("common.cut")], {2: {key: "common.cut", params: {}}}),
  messageTuple(['paste', 'clipboard', interfaceText("common.paste")], {2: {key: "common.paste", params: {}}}),
  messageTuple(['delete', 'trash', interfaceText('common.delete')], {2: {key: 'common.delete'}}),
  messageTuple(['easing', 'tween', interfaceText("timelineScrubber.easing")], {2: {key: "timelineScrubber.easing", params: {}}}),
  messageTuple(['select', 'sel-rect', interfaceText("timelineScrubber.select")], {2: {key: "timelineScrubber.select", params: {}}}),
  messageTuple(['more', 'more', interfaceText("timelineScrubber.more")], {2: {key: "timelineScrubber.more", params: {}}}),
];
const SINGLE = new Set(['key', 'shorter', 'longer', 'copy', 'paste', 'easing', 'select', 'more']);
const RANGE = new Set(['left', 'right', 'copy', 'cut', 'paste', 'delete', 'easing', 'done', 'more']);

export const timelineTouchMethods = {
  /** Whether the touch interface is on (the timeline host passes its state as `touch`). */
  _touch() { return Boolean(this.touch?.active); },
  /** The room before frame 1 and after the end, so every frame can reach the centred playhead. */
  _pad() { return this._touch() ? Math.max(0, Math.round((this.width || 0) / 2 - this.pxPerTick / 2)) : 0; },
  /** The frame under the grid's middle. */
  tickAtCenter() { return Math.max(0, Math.round((this._offsetX() + this.width / 2) / this.pxPerTick - .5)); },

  /** Scrolls `tick` under the middle of the grid; `smooth` glides there. */
  centerTick(tick = Math.floor(this.editor.tick), {smooth = false} = {}) {
    if (!this._touch() || !this.width) return;
    const target = (tick + .5) * this.pxPerTick - this.width / 2;
    cancelAnimationFrame(this._centerFrame ?? 0);
    this._centerFrame = 0;
    const from = this._offsetX();
    if (!smooth || Math.abs(target - from) < 1) { this._scrollToX(target); return; }
    const begin = performance.now(), span = 180;
    const step = now => {
      const t = Math.min(1, (now - begin) / span), eased = 1 - (1 - t) ** 3;
      this._scrollToX(from + (target - from) * eased);
      this._centerFrame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this._centerFrame = requestAnimationFrame(step);
  },
  /** Centres the playhead after a seek, once per frame, unless a gesture or playback owns the grid. */
  _centerSoon() {
    if (!this._touch() || this._centerQueued) return;
    this._centerQueued = true;
    requestAnimationFrame(() => {
      this._centerQueued = false;
      if (!this.disposed && !this.gesture && !this.paused && !this.touchNavigation?.mode) this.centerTick(undefined, {smooth: true});
    });
  },

  // ---- Scrubbing: a swipe slides time under the centred playhead ----
  beginTouchScrub() {
    cancelAnimationFrame(this._centerFrame ?? 0);
    if (this.gesture?.kind === 'scrub') return;
    this.gesture = {kind: 'scrub', touch: true};
    this.onScrubStart?.();
  },
  touchScrubTo(tick) {
    if (this.gesture?.kind !== 'scrub') return;
    const last = Math.max(0, this.editor.totalTicks + 7), next = clamp(tick, 0, last);
    if (this.touchRange) { this.start = Math.min(this.rangeAnchor, next); this.end = Math.max(this.rangeAnchor, next); }
    this.pendingScrub = next;
    this.update(Boolean(this.touchRange));
  },
  endTouchScrub() {
    const g = this.gesture;
    if (g?.kind !== 'scrub') return;
    this._flushScrub({force: true});
    this.gesture = null;
    const tick = Math.floor(this.editor.tick);
    if (!this.touchRange) this.start = this.end = tick;
    this.onScrubEnd?.();
    this.onRangeChange?.(this.selectedFrameIndices);
    this.centerTick(tick, {smooth: true});
    this.update();
  },

  // ---- Ranges: Select turns the playhead into a range with a handle at each end ----
  toggleTouchRange(on = !this.touchRange) {
    this.touchRange = Boolean(on);
    if (this.touchRange) this.rangeAnchor = this.start;
    else { const tick = Math.floor(this.editor.tick); this.start = this.end = tick; }
    this.onRangeChange?.(this.selectedFrameIndices);
    this.update();
  },
  /** The range handle under a finger: 'start', 'end' or null. */
  touchHandleAt(clientX, clientY) {
    if (!this._touch() || !(this.touchRange || this.end > this.start)) return null;
    const index = this.tracks.findIndex(track => track.id === this.selectedTrackId);
    if (index < 0) return null;
    const box = this.scroll.getBoundingClientRect(), x = clientX - box.left, y = clientY - box.top;
    const top = this.rowY(index), size = this.rowSize(index);
    if (y < top - 12 || y > top + size + 12) return null;
    const sx = this._offsetX(), left = this.start * this.pxPerTick - sx, right = (this.end + 1) * this.pxPerTick - sx;
    const toLeft = Math.abs(x - left), toRight = Math.abs(x - right);
    if (Math.min(toLeft, toRight) > HANDLE_REACH) return null;
    return toLeft <= toRight ? 'start' : 'end';
  },
  /** A finger takes the range's `edge` handle: the other edge stays where it is while the finger moves. */
  grabTouchHandle(edge) {
    this.touchRange = true;
    this.rangeAnchor = edge === 'start' ? this.end : this.start;
  },
  /** The held handle is at `tick`: the range runs from the other edge to it, either way, and the playhead follows it. */
  dragTouchHandle(tick) {
    const next = clamp(tick, 0, Math.max(0, this.editor.totalTicks + 7));
    this.start = Math.min(this.rangeAnchor, next);
    this.end = Math.max(this.rangeAnchor, next);
    this.selecting = true;
    try { this.editor.seek(next, {allowBeyondEnd: true}); } finally { this.selecting = false; }
    this.onRangeChange?.(this.selectedFrameIndices);
    this.update();
  },

  // ---- Commands on the selected layer at the playhead ----
  /** The selected layer's key exactly at the range's start, and the exposure around it. */
  _touchKeyState() {
    const id = this.selectedTrackId, layer = this.editor.getLayer(id);
    const track = this.editor.report._styk.layerSheet?.tracks?.[id];
    if (!layer || !track) return {layer, track: null, key: null, here: false, exposure: null};
    const {key, next} = sheetKeyAt(track, this.start);
    const here = Boolean(key && key.tick === this.start);
    const exposure = key && this.start < (next?.tick ?? track.end) ? {start: key.tick, end: next?.tick ?? track.end} : null;
    return {layer, track, key, here, exposure};
  },
  /** Add key where the layer holds a pose from before, Remove key where one starts here. */
  touchKey() {
    const {here} = this._touchKeyState();
    return here ? this.clearKeys() : this.addTrackKey();
  },
  /** Holds the pose under the playhead one frame shorter or longer. */
  touchHold(delta) {
    const {exposure} = this._touchKeyState(), id = this.selectedTrackId;
    if (!exposure) return false;
    const length = Math.max(1, exposure.end - exposure.start + delta);
    return this._run(() => this.editor.sheetSetDuration(length, id, exposure.start));
  },
  /** Moves the selected frames a frame earlier or later, keys and holds with them. */
  touchMove(delta) {
    const ids = this.ids, shift = Math.max(-this.start, delta);
    if (!ids.length || !shift) return false;
    const {start, end} = this, editor = this.editor;
    const keys = ids.some(id => editor.layerFrameKeys(id).some(key => key.tick >= start && key.tick <= end));
    const done = this._run(() => keys
      ? editor.sheetMoveFrames(ids, start, end, shift, {copy: false, replace: this.getSettings?.().replaceKeyframesOnDrop !== false})
      : editor.sheetTransferFrames(ids, ids, start, end, start + shift, {copy: false}));
    if (!done) return false;
    this.start += shift; this.end += shift; this.rangeAnchor = this.start;
    this.selecting = true;
    try { editor.seek(this.start, {allowBeyondEnd: true}); } finally { this.selecting = false; }
    this.centerTick(this.start, {smooth: true});
    this.update();
    return true;
  },

  // ---- The action bar ----
  _mountTouchActions() {
    if (this.touchActions || !this.header?.setActions) return;
    const bar = this.touchActions = document.createElement('div');
    bar.className = 'tl-touch-actions';
    bar.setAttribute('role', 'toolbar');
    localizedAttribute(bar, 'aria-label', "timelineScrubber.frameActions", {});
    this.touchButtons = new Map();
    for (const tuple of BUTTONS) {
      const [id, glyph] = tuple, caption = tupleMessages(tuple)[2];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tl-touch-action';
      button.dataset.touchAction = id;
      localizedMarkup(button, `${icon(glyph)}<span></span>`);
      localizedText(button.lastChild, caption.key, caption.params);
      localizedAttribute(button, 'aria-label', caption.key, caption.params);
      button.addEventListener('click', event => this._runTouchAction(id, event), {signal: this.events.signal});
      appendLocalized(bar, button);
      this.touchButtons.set(id, button);
    }
    bar.addEventListener('scroll', () => this._fadeTouchActions(), {passive: true, signal: this.events.signal});
    this.header.setActions(bar);
    this._fadeTouchActions();
  },
  /** Fades the bar's edge where more buttons lie past it (a swipe along the bar reaches them). */
  _fadeTouchActions() {
    const bar = this.touchActions;
    if (!bar) return;
    setAttr(bar, 'data-more-before', bar.scrollLeft > 1);
    setAttr(bar, 'data-more-after', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1);
  },
  _unmountTouchActions() {
    if (!this.touchActions) return;
    if (this.header?.actions === this.touchActions) this.header.setActions(null);
    this.touchActions.remove();
    this.touchActions = null;
  },
  _runTouchAction(id, event) {
    const run = {
      key: () => this.touchKey(), shorter: () => this.touchHold(-1), longer: () => this.touchHold(1),
      left: () => this.touchMove(-1), right: () => this.touchMove(1),
      copy: () => this.copySelection(), cut: () => this.cutSelection(), paste: () => this.pasteSelection(),
      delete: () => this.removeFrames(), easing: () => this.showEasingPopover(),
      select: () => this.toggleTouchRange(true), done: () => this.toggleTouchRange(false),
      more: () => {
        const box = event.currentTarget.getBoundingClientRect();
        this._menu({clientX: box.left + box.width / 2, clientY: box.top, preventDefault() {}, currentTarget: null});
      },
    }[id];
    if (!run) return;
    const result = this._run(run);
    if (result?.then) result.then(() => this.update()); else this.update();
  },
  /** Shows the bar's buttons for a frame or a range, with what each would do here. Writes only changes. */
  _syncTouchActions() {
    if (!this.touchActions) return;
    const range = Boolean(this.touchRange || this.end > this.start);
    const {layer, here, exposure} = this._touchKeyState();
    const locked = !layer || this.ids.some(id => this.editor.getLayer(id)?.locked);
    const clipboard = Boolean(this.editor._sheetClipboard || this.sharedClipboard);
    if (this._touchActionsRange !== range) {
      // A range swaps the buttons: the bar starts again from its first (Done, or Key).
      this._touchActionsRange = range;
      setAttr(this.touchActions, 'data-range', range);
      this.touchActions.scrollLeft = 0;
      requestAnimationFrame(() => this._fadeTouchActions());
    }
    for (const [id, button] of this.touchButtons) {
      setHidden(button, !(range ? RANGE : SINGLE).has(id));
      let disabled = locked && id !== 'select' && id !== 'done' && id !== 'more' && id !== 'copy';
      if (id === 'key') {
        const descriptionKey = here ? 'timelineScrubber.removeKey' : 'timelineScrubber.addKey';
        localizedText(button.lastChild, (here ? "timelineScrubber.remove" : "timelineScrubber.key"), (here ? {} : {}));
        localizedAttribute(button, 'aria-label', descriptionKey);
        setAttr(button, 'data-on', here);
        localizedAttribute(button, 'data-tooltip', descriptionKey);
        disabled ||= here && this.start === 0;
      }
      if (id === 'shorter') disabled ||= !exposure || exposure.end - exposure.start <= 1;
      if (id === 'longer') disabled ||= !exposure;
      if (id === 'left') disabled ||= this.start <= 0;
      if (id === 'paste') disabled ||= !clipboard;
      if (id === 'easing') disabled ||= !exposure;
      setProp(button, 'disabled', Boolean(disabled));
    }
  },

  /** A range's handles: a bar at each edge with a knob a finger takes (the anchor row only). */
  _paintTouchHandles(ctx, y, size, sx) {
    const c = this.colors, step = this.pxPerTick, {top, height} = this._cellBox(y, size), mid = top + height / 2;
    for (const x of [this.start * step - sx, (this.end + 1) * step - sx]) {
      if (x < -12 || x > this.width + 12) continue;
      ctx.fillStyle = c['accent-line'];
      ctx.beginPath(); ctx.roundRect(x - 2, top - 4, 4, height + 8, 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, mid, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.surface;
      ctx.beginPath(); ctx.arc(x, mid, 4.5, 0, Math.PI * 2); ctx.fill();
    }
  },
};
