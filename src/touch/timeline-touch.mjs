/**
 * The Advanced timeline's grid under a finger (docs/TOUCH.md): the input side
 * of the touch timeline, whose presentation and commands are
 * timeline-scrubber.mjs's. With a mouse a press on the grid selects cells or
 * picks up keys at once; a fingertip covers several frames, so:
 *
 *   swipe sideways         scrubs: time slides under the centred playhead
 *                          (with momentum), and the frame under it settles
 *                          when the finger lifts
 *   swipe up or down       scrolls the rows
 *   tap                    selects that layer's frame and glides it under
 *                          the playhead
 *   double tap             a double-click: adds a key, or edits a key's easing
 *   press, hold, drag      the mouse's drag: selects frames, or moves the
 *                          selected keys (a buzz says the hold took)
 *   press and hold, lift   the frame's menu
 *   a range's handle       drags that end of the range (past the other end too)
 *   two fingers            pinch to zoom around the playhead
 *   the names column       a vertical swipe scrolls the rows
 *
 * The grid's own handlers stay the one implementation: a tap or a hold sends
 * them the press they would have had from a mouse (an untrusted copy at the
 * same point, for the same pointer), and every later event of that finger
 * reaches them untouched. Only trusted touch events are intercepted, in the
 * capture phase on the grid; pens and mice keep the desktop's behaviour.
 *
 * `host` is the timeline (layer-timeline.mjs with timeline-scrubber.mjs).
 */
import {HOLD_MS, SLOP, beyondSlop, isDoubleTap} from './touch-gestures.mjs';
import {haptic, swallowNextClick} from './long-press.mjs';

const FRICTION = 0.93, MIN_SPEED = 0.03, EDGE = 28;

export function installTimelineTouch(host, {touch, signal, window: win = globalThis.window} = {}) {
  const grid = host.scroll, doc = grid.ownerDocument;
  const fingers = new Map();
  let press = null, pinch = null, lastTap = null, momentum = 0, syntheticDouble = -Infinity, edgeScroll = 0;

  const on = (target, type, fn, options = {}) => target.addEventListener(type, fn, {...options, signal});
  const ours = event => touch?.active && event.isTrusted && event.pointerType === 'touch';
  const take = event => { event.stopImmediatePropagation(); if (event.cancelable) event.preventDefault(); };
  /** Stops a glide; a glide that was scrubbing settles its frame. */
  const stopMomentum = ({settle = true} = {}) => {
    if (!momentum) return;
    win.cancelAnimationFrame(momentum);
    momentum = 0;
    if (settle) host.endTouchScrub?.();
  };
  /** Slides time by `dx` px: the grid scrolls and the frame under the playhead follows. */
  const scrub = dx => {
    host._scrollToX(host._offsetX() + dx);
    host.touchScrubTo?.(host.tickAtCenter());
  };
  /** A copy of `event` for the grid's own handlers: the mouse's left button at the finger. */
  const replay = (type, event, extra = {}) => {
    const init = {bubbles: true, cancelable: true, composed: true, view: win, clientX: event.clientX, clientY: event.clientY,
      screenX: event.screenX, screenY: event.screenY, pointerId: event.pointerId, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra};
    grid.dispatchEvent(type.startsWith('pointer') ? new win.PointerEvent(type, init) : new win.MouseEvent(type, init));
  };
  const clearPress = () => { if (press) clearTimeout(press.timer); press = null; };

  /** Momentum after a sideways flick: time keeps sliding, slowing, and the last frame settles under the playhead. */
  function glide(vx) {
    stopMomentum({settle: false});
    let last = win.performance.now();
    const step = now => {
      const dt = Math.min(48, now - last);
      last = now;
      scrub(vx * dt);
      vx *= FRICTION ** (dt / 16);
      if (Math.abs(vx) > MIN_SPEED) momentum = win.requestAnimationFrame(step);
      else { momentum = 0; host.endTouchScrub?.(); }
    };
    momentum = win.requestAnimationFrame(step);
  }
  /** While a handle is dragged near the grid's edge, time slides that way. */
  function edgeRun(x) {
    const box = grid.getBoundingClientRect();
    const speed = x < box.left + EDGE ? -6 : x > box.right - EDGE ? 6 : 0;
    win.cancelAnimationFrame(edgeScroll);
    edgeScroll = 0;
    if (!speed || press?.mode !== 'handle') return;
    const step = () => {
      if (press?.mode !== 'handle') return;
      host._scrollToX(host._offsetX() + speed);
      host.dragTouchHandle(host._hit({clientX: press.lastX, clientY: press.y}).tick);
      edgeScroll = win.requestAnimationFrame(step);
    };
    edgeScroll = win.requestAnimationFrame(step);
  }

  on(grid, 'pointerdown', event => {
    if (!ours(event)) return;
    stopMomentum();
    fingers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (fingers.size === 2) {
      // A second finger: whatever the first began becomes a pinch, zooming around the playhead.
      take(event);
      if (press?.mode === 'grid') host._cancelGesture?.();
      if (press?.mode === 'scrub') host.endTouchScrub?.();
      clearPress();
      const [a, b] = [...fingers.values()];
      pinch = {distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), zoom: host.pxPerTick, y: (a.y + b.y) / 2};
      return;
    }
    if (fingers.size > 2) { take(event); return; }
    take(event);
    // A range's handle takes the finger at once.
    const edge = host.touchHandleAt?.(event.clientX, event.clientY);
    if (edge) {
      press = {id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, mode: 'handle'};
      host.grabTouchHandle(edge);
      haptic(win);
      return;
    }
    press = {id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, mode: 'pending', event,
      samples: [{x: event.clientX, y: event.clientY, t: event.timeStamp}]};
    press.timer = setTimeout(() => {
      if (!press || press.mode !== 'pending') return;
      // The hold took: the grid gets the press a mouse would have given it.
      press.mode = 'grid';
      haptic(win);
      replay('pointerdown', press.event);
    }, HOLD_MS);
  }, {capture: true});

  on(grid, 'pointermove', event => {
    if (!ours(event)) return;
    if (fingers.has(event.pointerId)) fingers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (pinch) {
      take(event);
      if (fingers.size < 2) return;
      const [a, b] = [...fingers.values()];
      const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), y = (a.y + b.y) / 2;
      host.setZoom(pinch.zoom * distance / pinch.distance);
      if (Math.abs(y - pinch.y) > 0.5) { grid.scrollTop += pinch.y - y; pinch.y = y; }
      return;
    }
    if (press?.id !== event.pointerId) return;
    if (press.mode === 'grid') return;   // the grid's own drag
    take(event);
    if (press.mode === 'handle') {
      press.lastX = event.clientX;
      host.dragTouchHandle(host._hit(event).tick);
      edgeRun(event.clientX);
      return;
    }
    if (press.mode === 'pending') {
      if (!beyondSlop(press, {x: event.clientX, y: event.clientY}, SLOP)) return;
      clearTimeout(press.timer);
      // The first clear direction decides: sideways scrubs, up or down scrolls the rows.
      const sideways = Math.abs(event.clientX - press.x) >= Math.abs(event.clientY - press.y);
      press.mode = sideways ? 'scrub' : 'rows';
      press.last = {x: event.clientX, y: event.clientY};
      if (sideways) host.beginTouchScrub?.();
    }
    if (press.mode === 'scrub') scrub(press.last.x - event.clientX);
    else grid.scrollTop += press.last.y - event.clientY;
    press.last = {x: event.clientX, y: event.clientY};
    press.samples.push({x: event.clientX, y: event.clientY, t: event.timeStamp});
    if (press.samples.length > 6) press.samples.shift();
  }, {capture: true});

  const lift = event => {
    if (!ours(event)) return;
    fingers.delete(event.pointerId);
    if (pinch) { take(event); if (!fingers.size) { pinch = null; host.centerTick?.(undefined, {smooth: true}); } return; }
    if (press?.id !== event.pointerId) return;
    const current = press;
    clearPress();
    win.cancelAnimationFrame(edgeScroll);
    if (current.mode === 'grid') {
      if (event.type === 'pointercancel') return;   // the grid cancels its own gesture
      // A hold lifted where it began: the frame's menu (the grid has already had its press and release).
      if (!beyondSlop(current, {x: event.clientX, y: event.clientY}, SLOP)) {
        setTimeout(() => replay('contextmenu', event, {button: 2, buttons: 0}), 0);
        swallowNextClick(doc, {pointerId: event.pointerId});
      }
      return;
    }
    take(event);
    if (current.mode === 'handle') { host.centerTick?.(undefined, {smooth: true}); return; }
    if (current.mode === 'scrub') {
      const first = current.samples[0], last = current.samples.at(-1), dt = Math.max(1, last.t - first.t);
      if (event.type !== 'pointercancel' && event.timeStamp - last.t < 80 && Math.abs(first.x - last.x) / dt > 0.2) glide((first.x - last.x) / dt);
      else host.endTouchScrub?.();
      return;
    }
    if (current.mode === 'rows' || event.type === 'pointercancel') return;
    // A tap: the grid's press and release at the finger; a second tap close by is a double-click.
    replay('pointerdown', current.event);
    replay('pointerup', event);
    const tap = {x: event.clientX, y: event.clientY, time: event.timeStamp};
    if (isDoubleTap(lastTap, tap)) {
      lastTap = null;
      syntheticDouble = win.performance.now();
      replay('dblclick', event, {detail: 2});
    } else lastTap = tap;
  };
  on(grid, 'pointerup', lift, {capture: true});
  on(grid, 'pointercancel', lift, {capture: true});
  // One double-click per double tap: the browser's own, when it sends one after ours, is dropped.
  on(grid, 'dblclick', event => {
    if (event.isTrusted && touch?.active && win.performance.now() - syntheticDouble < 450) event.stopImmediatePropagation();
  }, {capture: true});

  // The names column: a vertical swipe scrolls the rows; a tap stays a tap on the row's buttons.
  const labels = host.labelViewport;
  let rowPan = null;
  if (labels) {
    on(labels, 'pointerdown', event => {
      if (!ours(event) || event.target.closest('input')) return;
      stopMomentum();
      rowPan = {id: event.pointerId, y: event.clientY, x: event.clientX, top: grid.scrollTop, moved: false};
    }, {capture: true});
    on(labels, 'pointermove', event => {
      if (rowPan?.id !== event.pointerId) return;
      if (!rowPan.moved && !beyondSlop(rowPan, {x: event.clientX, y: event.clientY}, SLOP)) return;
      rowPan.moved = true;
      take(event);
      grid.scrollTop = rowPan.top + rowPan.y - event.clientY;
    }, {capture: true});
    const end = event => {
      if (rowPan?.id !== event.pointerId) return;
      if (rowPan.moved) { take(event); swallowNextClick(doc, {pointerId: event.pointerId}); }
      rowPan = null;
    };
    on(labels, 'pointerup', end, {capture: true});
    on(labels, 'pointercancel', end, {capture: true});
  }
  signal?.addEventListener('abort', () => { stopMomentum({settle: false}); clearPress(); win.cancelAnimationFrame(edgeScroll); }, {once: true});

  return {
    /** The current gesture: 'pending', 'scrub', 'rows', 'grid', 'handle', 'pinch', 'glide' or null. */
    get mode() { return pinch ? 'pinch' : press?.mode ?? (momentum ? 'glide' : null); },
  };
}
