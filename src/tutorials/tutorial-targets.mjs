/**
 * Where a tutorial step points (docs/TUTORIALS.md): a control, a region, or a
 * place on the canvas or in the timeline, as a rectangle in window
 * coordinates. A step names its target (tutorial-catalog.mjs); this module
 * finds it in the running editor, and returns null when it is not on screen
 * (a folded panel, a hidden control), so the presenter marks nothing rather
 * than something wrong.
 *
 *   {selector}                    the first shown element of a selector list
 *   {canvas: 'stage'}             the artboard, clipped to the stage
 *   {canvas: 'figure'}            the practice figure's bounds
 *   {canvas: 'origin'}            its origin handle
 *   {canvas: 'joint', segment}    the handle at the end of that segment
 *   {timeline: 'ruler' | 'grid' | 'labels'}
 *
 * A reading is {rect: {left, top, width, height}, point} where `point` is
 * set for a place the pointer goes to exactly (a handle): a dot marks it
 * instead of a ring. ctx: {editor, state, viewport, timeline()}.
 */
import {worldToScreen} from '../renderer-geometry.mjs';

const HANDLE = 22;
const FIGURE_PAD = 14;

const box = (left, top, width, height, point = null) => ({rect: {left, top, width, height}, point});
const shown = element => Boolean(element && !element.closest?.('[hidden]') && element.getClientRects().length && element.checkVisibility?.({visibilityProperty: true}) !== false);

export function createTutorialTargets({editor, state, viewport, timeline = () => null, document: doc = viewport?.ownerDocument ?? globalThis.document}) {
  const frame = () => editor.evaluatedFrame ?? editor.frame;
  /** A scene point in window coordinates. */
  const toWindow = point => {
    const local = worldToScreen(point, {report: editor.report, frame: frame(), view: state.view, cameraEnabled: false});
    const rect = viewport.getBoundingClientRect();
    return {x: rect.left + local.x * (rect.width / (viewport.clientWidth || rect.width || 1)), y: rect.top + local.y * (rect.height / (viewport.clientHeight || rect.height || 1))};
  };
  /** The practice figure: the first one on the frame. */
  const figure = () => {
    const first = frame()?.objects?.[0];
    if (!first) return null;
    for (const item of editor.geometry?.objects?.values?.() ?? []) if (item?.obj?.unique_id === first.unique_id) return item;
    return null;
  };
  /** Clips a rectangle to the stage; null when nothing of it shows. */
  const inStage = ({left, top, right, bottom}) => {
    const stage = viewport.getBoundingClientRect();
    const l = Math.max(left, stage.left), t = Math.max(top, stage.top), r = Math.min(right, stage.right), b = Math.min(bottom, stage.bottom);
    return r - l > 4 && b - t > 4 ? box(l, t, r - l, b - t) : null;
  };

  function canvasTarget(target) {
    if (!shown(viewport)) return null;
    if (target.canvas === 'stage') {
      const artboard = doc.getElementById('artboard')?.getBoundingClientRect();
      return artboard ? inStage(artboard) : null;
    }
    const item = figure();
    if (!item) return null;
    if (target.canvas === 'figure') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const segment of item.segments) for (const point of [segment.start, segment.end]) {
        if (!point) continue;
        const at = toWindow(point);
        minX = Math.min(minX, at.x); minY = Math.min(minY, at.y); maxX = Math.max(maxX, at.x); maxY = Math.max(maxY, at.y);
      }
      if (!Number.isFinite(minX)) return null;
      return inStage({left: minX - FIGURE_PAD, top: minY - FIGURE_PAD, right: maxX + FIGURE_PAD, bottom: maxY + FIGURE_PAD});
    }
    const world = target.canvas === 'origin' ? item.root : item.segments.find(segment => segment.seg?.segment_id === target.segment)?.end;
    if (!world) return null;
    const point = toWindow(world), stage = viewport.getBoundingClientRect();
    if (point.x < stage.left || point.x > stage.right || point.y < stage.top || point.y > stage.bottom) return null;
    return box(point.x - HANDLE / 2, point.y - HANDLE / 2, HANDLE, HANDLE, point);
  }

  function timelineTarget(target) {
    const root = doc.querySelector('.layer-timeline');
    if (!shown(root)) return null;
    if (target.timeline === 'labels') {
      const labels = root.querySelector('.sheet-labels');
      return shown(labels) ? fromElement(labels) : null;
    }
    const scroll = root.querySelector('.sheet-scroll');
    if (!shown(scroll)) return null;
    // The ruler alone: Camera and Scene's pinned rows under it are rows of their own (a press there selects them).
    const rect = scroll.getBoundingClientRect(), head = Math.min(rect.height, timeline()?.layout?.header ?? 32);
    return target.timeline === 'ruler' ? box(rect.left, rect.top, rect.width, head) : box(rect.left, rect.top + head, rect.width, Math.max(0, rect.height - head));
  }

  function fromElement(element) {
    const rect = element.getBoundingClientRect();
    return box(rect.left, rect.top, rect.width, rect.height);
  }

  return {
    /** The reading for a step's target, or null when it is not on screen. */
    resolve(target) {
      if (!target) return null;
      if (target.canvas) return canvasTarget(target);
      if (target.timeline) return timelineTarget(target);
      if (target.selector) {
        for (const element of doc.querySelectorAll(target.selector)) if (shown(element)) return fromElement(element);
      }
      return null;
    },
    /** The element behind a selector target (the control a "Show me" presses in the picture). */
    element(target) {
      if (!target?.selector) return null;
      return [...doc.querySelectorAll(target.selector)].find(shown) ?? null;
    },
  };
}
