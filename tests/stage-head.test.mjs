/**
 * The stage header's message rule (src/shell/stage-head.mjs solveMessage,
 * experience.md §4.3) and the message slot's priorities with the mode kind
 * (src/ui/ui-toast.mjs). The DOM half runs in tests/stage-chrome.browser.mjs.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {solveMessage, MESSAGE_GAP, DROP_GAP} from '../src/shell/stage-head.mjs';
import {createMessageQueue, MESSAGE_PRIORITY} from '../src/ui/ui-toast.mjs';

const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
// A 1000px stage header at y 44, its end (view cluster, zoom and Fit) 260px wide, the crumb ending at 220.
const head = rect(100, 44, 1000, 40);
const end = rect(832, 50, 260, 28), zoom = rect(1030, 50, 62, 28), view = rect(832, 50, 180, 28);

test('a message that clears the view cluster is centred in the header and leaves the start alone', () => {
  const spot = solveMessage({head, keep: end, view, startRight: 220, width: 300});
  assert.deepEqual(spot, {x: 600, top: 64, place: 'head', over: false, overView: false});
});

test('a message that would reach the view cluster centres in its room and covers the start while it shows', () => {
  const spot = solveMessage({head, keep: end, view, startRight: 220, width: 600});
  const room = end.left - MESSAGE_GAP - (head.left + 8);
  assert.equal(spot.place, 'head');
  assert.equal(spot.x, head.left + 8 + room / 2);
  assert.ok(spot.x + 300 <= end.left - MESSAGE_GAP, 'it ends before the view cluster');
  assert.equal(spot.over, true, 'it covers the crumb');
});

test('a message wider than its room takes a line of its own under the header: never cut, never over the cluster', () => {
  const spot = solveMessage({head, keep: end, view, startRight: 220, width: 800});
  assert.deepEqual(spot, {x: 600, top: head.bottom + DROP_GAP, place: 'drop', over: false, overView: false});
});

test('at compact width the room reaches zoom and Fit, and the view toggles step aside only when it meets them', () => {
  const near = solveMessage({head, keep: zoom, view, startRight: 220, width: 400, compact: true});
  assert.equal(near.place, 'head');
  assert.equal(near.overView, false, 'a message clear of the toggles leaves them');
  const wide = solveMessage({head, keep: zoom, view, startRight: 220, width: 880, compact: true});
  assert.equal(wide.place, 'head');
  assert.equal(wide.overView, true, 'the view toggles step aside');
  assert.ok(wide.x + 440 <= zoom.left - MESSAGE_GAP, 'zoom and Fit stay clear');
});

test('a message that would cover a focused tool option takes its own line instead', () => {
  const spot = solveMessage({head, keep: end, view, startRight: 700, width: 300, focusInStart: true});
  assert.equal(spot.place, 'drop');
});

test('a message that would cover a tutorial strip takes its own line instead', () => {
  const spot = solveMessage({head, keep: end, view, startRight: 700, width: 300, keepStart: true});
  assert.equal(spot.place, 'drop');
  assert.equal(solveMessage({head, keep: end, view, startRight: 220, width: 300, keepStart: true}).place, 'head', 'a message clear of the strip stays in the header');
});

test('a pick mode outranks updates and toasts, and gives way to recovery and errors', () => {
  assert.ok(MESSAGE_PRIORITY.error > MESSAGE_PRIORITY.recovery && MESSAGE_PRIORITY.recovery > MESSAGE_PRIORITY.mode
    && MESSAGE_PRIORITY.mode > MESSAGE_PRIORITY.update && MESSAGE_PRIORITY.update > MESSAGE_PRIORITY.toast && MESSAGE_PRIORITY.toast > MESSAGE_PRIORITY.hint);
  const queue = createMessageQueue();
  const toast = {id: 't', key: 't', slot: 'toast', persistent: false};
  const mode = {id: 'm', key: 'm', slot: 'mode', persistent: true};
  const error = {id: 'e', key: 'e', slot: 'error', persistent: true};
  assert.equal(queue.push(toast).show, toast);
  assert.equal(queue.push(mode).show, mode, 'the mode takes the slot from a toast');
  assert.equal(queue.push(error).show, error, 'an error takes it from the mode');
  assert.deepEqual(queue.waiting.map(message => message.id), ['m'], 'the persistent mode waits; the toast was dropped');
  assert.equal(queue.remove('e'), mode, 'the mode returns when the error goes');
});
