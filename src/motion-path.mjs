/** Motion-path trails: a read-only projection of the evaluator onto the overlay.
 * Output-frame samples retain exact times; dense trails use bounded sampling.
 * Path data lives outside the document — edits write through ordinary editor
 * commands while a drag session supplies a virtual report for live resampling.
 */
import {evaluatedFrame, evaluatedNativeFrame, timeline, buildGeometry} from './pivot/geometry.mjs';
import {ikComponents} from './ik-joined.mjs';
import {sheetKeyAt, sheetTrack} from './layer-sheet.mjs';
import {layerIdForUid} from './layers.mjs';
import {animationChannels, animationChannelId, findAnimationChannel} from './animation-channels.mjs';
import {PlaybackTweenCache} from './playback-tween-cache.mjs';
import {falloffWeight} from './motion-path-falloff.mjs';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const EMPTY_SCENE = {objects: new Map()};

/** The node or camera the overlay currently shows a path for. */
export function motionPathTarget(editor, {camera = false} = {}) {
  if (camera) return {kind: 'camera'};
  const uid = editor.selectedUid;
  if (uid === null || uid === undefined || editor.selectedUids?.size !== 1) return null;
  const object = editor.selectionFrame?.objects.find(o => o.unique_id === uid);
  if (!object) return null;
  const figure = editor.report.figure_types.find(f => f.figure_type_id === object.figure_type_id);
  if (!figure?.segments?.length) return null;
  const joint = editor.selectedJoint >= 0 && editor.selectedJoint < figure.segments.length ? editor.selectedJoint : -1;
  return {kind: 'node', uid, handleId: joint < 0 ? 0 : Number(figure.segments[joint].segment_id), joint};
}

export function motionPathTargetKey(target) {
  return target ? (target.kind === 'camera' ? 'camera' : `${target.uid}:${target.handleId}`) : '';
}

/** Tip joints: segment ends that no other segment hangs from — hands, feet
 * and head on a stick figure — without assuming anatomical labels. */
export function figureTipJoints(figure) {
  const parents = new Set(), tips = [];
  for (const segment of figure?.segments ?? []) parents.add(Number(segment.parent_id));
  figure?.segments?.forEach((segment, index) => {
    if (segment.visible !== false && !parents.has(Number(segment.segment_id))) tips.push(index);
  });
  return tips;
}

/** Every trail target. `joints: 'tips'` follows each figure's origin and tip
 * joints so a whole character's arcs read at once; otherwise the primary
 * figure shows its selected joint and others their origins. The primary
 * target resolves first so its colour stays stable across selections. */
export function motionPathTargets(editor, {camera = false, all = false, joints = 'selected', maxTargets = 48} = {}) {
  if (camera) return [{kind: 'camera'}];
  const frame = editor.selectionFrame ?? editor.evaluatedFrame, out = [], seen = new Set();
  const figures = new Map(editor.report.figure_types.map(f => [f.figure_type_id, f]));
  const objects = new Map(frame?.objects.map(o => [o.unique_id, o]) ?? []);
  const add = (uid, figure, j) => {
    if (out.length >= maxTargets) return;
    const target = {kind: 'node', uid, handleId: j < 0 ? 0 : Number(figure.segments[j].segment_id), joint: j};
    const key = motionPathTargetKey(target);
    if (!seen.has(key)) { seen.add(key); out.push(target); }
  };
  const push = (uid, joint) => {
    if (uid === null || uid === undefined || out.length >= maxTargets) return;
    const figure = figures.get(objects.get(uid)?.figure_type_id);
    if (!figure?.segments?.length) return;
    const j = joint >= 0 && joint < figure.segments.length ? joint : -1;
    add(uid, figure, j);
    if (joints !== 'tips') return;
    add(uid, figure, -1);
    for (const tip of figureTipJoints(figure)) add(uid, figure, tip);
  };
  const selected = editor.selectedUids ?? new Set();
  if (all) {
    if (editor.selectedUid !== null && editor.selectedUid !== undefined)
      push(editor.selectedUid, editor.selectedJoint);
    for (const object of frame?.objects ?? []) { if (out.length >= maxTargets) break; push(object.unique_id, -1); }
  } else {
    if (selected.has(editor.selectedUid)) push(editor.selectedUid, editor.selectedJoint);
    for (const uid of selected) if (uid !== editor.selectedUid) push(uid, -1);
  }
  return out;
}

/** Display rows remain the single source of tick layout, including sheet clips.
 * `range` > 0 keeps only a ±window of ticks around the playhead. */
export function motionPathTicks(editor, {maxPoints = 1600, range = 0, target} = {}) {
  const total = editor.totalTicks;
  if (total <= 0) return {ticks: [], keyTicks: new Set(), stride: 1};
  const center = clamp(editor.tick, 0, total - 1);
  const low = range > 0 ? Math.max(0, center - range) : 0;
  const high = range > 0 ? Math.min(total - 1, center + range) : total - 1;
  const count = Math.max(0, high - low + 1), budget = Math.max(3, Math.floor(maxPoints));
  const keyTicks = (target && keyTicksForTarget(editor, target)) ?? keyTicksFor(editor);
  const included = new Set([low, high]);
  if (editor.tick >= low && editor.tick <= high) included.add(editor.tick);
  // Key-heavy documents must obey the same bound as long interpolated spans.
  const keys = [...keyTicks].filter(t => t > low && t < high).sort((a, b) => a - b);
  const keyBudget = Math.min(keys.length, Math.floor((budget - included.size) / 2));
  for (let i = 0; i < keyBudget; i++) included.add(keys[Math.floor(i * keys.length / keyBudget)]);
  const stride = count <= budget ? 1 : Math.max(1, Math.ceil(count / Math.max(1, budget - included.size)));
  for (let t = low; t <= high && included.size < budget; t += stride) included.add(t);
  const ticks = [...included].sort((a, b) => a - b);
  return {ticks, keyTicks, stride};
}

/** Times that own an authored or stored pose for this target. */
function keyTicksFor(editor) {
  const report = editor.report, ticks = new Set(), sheet = report._styk?.layerSheet;
  if (sheet) {
    const track = sheetTrack(report, editor.selectedUid != null ? layerIdForUid(report, editor.selectedUid) : 'camera');
    for (const key of track?.keys ?? []) if (!key.patchOnly && key.tick < sheet.duration) ticks.add(key.tick);
    return ticks;
  }
  if (animationChannels(report).length) {
    for (const channel of animationChannels(report)) {
      if (channel.target.kind === 'scene') continue;
      for (const key of channel.keys) if (!key.hidden) ticks.add(key.tick);
    }
    return ticks;
  }
  const rows = timeline(report);
  for (const row of rows) if (row.count > 0) ticks.add(row.start);
  return ticks;
}

/** Per-target keyed times, used only for the emphasized markers. */
export function keyTicksForTarget(editor, target) {
  const report = editor.report, sheet = report._styk?.layerSheet, ticks = new Set();
  if (sheet) {
    const id = target.kind === 'camera' ? 'camera' : layerIdForUid(report, target.uid);
    for (const key of sheetTrack(report, id)?.keys ?? []) if (!key.patchOnly && key.tick < sheet.duration) ticks.add(key.tick);
    return ticks;
  }
  const channels = animationChannels(report);
  if (!channels.length) return null;
  const figureChannel = target.kind === 'node' ? findAnimationChannel(report, {kind: 'figure', uid: target.uid}, 'pose') : null;
  const layerId = target.kind === 'node' ? layerIdForUid(report, target.uid) : null;
  for (const channel of channels) {
    const t = channel.target;
    const owns = target.kind === 'camera'
      ? t.kind === 'camera'
      : (t.kind === 'figure' && t.uid === target.uid) || (t.kind === 'layer' && t.id === layerId && !figureChannel && channel.property === 'pose');
    if (!owns) continue;
    for (const key of channel.keys) if (!key.hidden) ticks.add(key.tick);
  }
  return ticks;
}

/** Join-connected uids on both endpoint frames of a native span. */
function nativeComponentUids(report, index, uid) {
  const needed = new Set();
  for (const frame of [report.keyframes[index], report.keyframes[index + 1]]) {
    if (!frame) continue;
    const objects = frame.objects, slot = objects.findIndex(o => o.unique_id === uid);
    if (slot < 0) continue;
    const slots = new Set([slot]), queue = [slot];
    let s = slot;
    while (objects[s]?.join) { s = objects[s].join.target_object_slot; if (slots.has(s) || !objects[s]) break; slots.add(s); queue.push(s); }
    for (let q = 0; q < queue.length; q++)
      for (const [i, child] of objects.entries())
        if (child.join && slots.has(child.join.target_object_slot) && !slots.has(i)) { slots.add(i); queue.push(i); }
    for (const i of slots) needed.add(objects[i].unique_id);
  }
  return needed;
}

function rowAt(rows, tick) {
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  return low;
}

/** Geometry for just the join/IK components holding `uids`. The draw order
 * names only those slots, so the builder skips every unrelated figure — a trail
 * sample costs its own character, not the whole scene. */
function componentScene(report, frame, uids) {
  const slots = new Map();
  frame.objects.forEach((object, slot) => { if (uids.has(object?.unique_id)) slots.set(object.unique_id, slot); });
  if (!slots.size) return {slots, scene: EMPTY_SCENE};
  const wanted = new Set(slots.values()), dirty = new Set();
  for (const group of ikComponents(frame)) if (group.some(slot => wanted.has(slot))) for (const slot of group) dirty.add(slot);
  const scene = buildGeometry(report, {...frame, object_draw_order: [...dirty].sort((a, b) => a - b)},
    {previous: EMPTY_SCENE, dirtySlots: dirty});
  return {slots, scene};
}

/** Topmost figure of a joined chain — the body a relative trail stays with. */
function componentRoot(frame, slot) {
  const seen = new Set([slot]);
  let root = slot;
  while (frame.objects[root]?.join) {
    const next = Number(frame.objects[root].join.target_object_slot);
    if (seen.has(next) || !frame.objects[next]) break;
    seen.add(next); root = next;
  }
  return root;
}

function frameAt(report, rows, tick, {tweenCache, authored, needed}) {
  const index = rowAt(rows, tick), row = rows[index];
  const t = row?.count > 0 ? clamp((tick - row.start) / row.count, 0, 1) : 0;
  if (authored) return evaluatedFrame(report, index, t, tick);
  return evaluatedNativeFrame(report, index, t, tweenCache, needed?.(index));
}

/** Uids a native evaluation needs for these node uids at one row. */
const nativeNeeds = (report, uids) => index => {
  const needed = new Set();
  for (const uid of uids) for (const id of nativeComponentUids(report, index, uid)) needed.add(id);
  return needed;
};

/** Evaluate one display tick once for every target and resolve their points.
 * Each point also carries its body reference (`rx`, `ry`) unless the target is
 * that reference itself, which lets the overlay show trails relative to it. */
export function samplePathTargets(report, targets, tick, {rows, tweenCache, authored} = {}) {
  rows ??= timeline(report);
  authored ??= Boolean(report._styk?.layerSheet || animationChannels(report).length);
  const uids = new Set();
  for (const target of targets) if (target.kind === 'node') uids.add(target.uid);
  const camera = targets.some(target => target.kind === 'camera');
  const frame = frameAt(report, rows, tick, {tweenCache, authored, needed: camera ? null : nativeNeeds(report, uids)});
  const {slots, scene} = uids.size && frame ? componentScene(report, frame, uids) : {slots: new Map(), scene: EMPTY_SCENE};
  return targets.map(target => {
    if (target.kind === 'camera') {
      const view = frame?.camera;
      return {x: report.canvas_width / 2 + Number(view?.x ?? 0), y: report.canvas_height / 2 + Number(view?.y ?? 0)};
    }
    const slot = slots.get(target.uid);
    const point = slot === undefined ? null : scene.objects.get(slot)?.joints.get(target.handleId);
    if (!point) return null;
    const root = componentRoot(frame, slot);
    if (root === slot && !target.handleId) return {x: point.x, y: point.y};
    const reference = scene.objects.get(root)?.root;
    return reference ? {x: point.x, y: point.y, rx: reference.x, ry: reference.y} : {x: point.x, y: point.y};
  });
}

/** Evaluate one display tick against `report` and resolve the target point. */
export function samplePathPoint(report, target, tick, options = {}) {
  return samplePathTargets(report, [target], tick, options)[0];
}

const pathRecord = (tick, value, keyTicks) => ({tick, x: value?.x, y: value?.y, rx: value?.rx, ry: value?.ry,
  key: keyTicks?.has(tick) ?? false, missing: !value});

/** Sampled trail for one target: compact point records keyed by display tick. */
export function sampleMotionPath(report, editor, target, {ticks, keyTicks, tweenCache} = {}) {
  ticks ??= motionPathTicks(editor).ticks;
  keyTicks ??= keyTicksForTarget(editor, target) ?? keyTicksFor(editor);
  const rows = timeline(report), authored = Boolean(report._styk?.layerSheet || animationChannels(report).length);
  const points = [];
  for (const tick of ticks) points.push(pathRecord(tick, samplePathPoint(report, target, tick, {rows, tweenCache, authored}), keyTicks));
  return {target, points};
}

/** Revision-aware path store. One live session resamples only its edit window.
 * Sampling is time-budgeted: each call works until a shared deadline so a dense
 * scene refines progressively over frames instead of blocking input for seconds.
 * Targets sampled together share one evaluation per display tick.
 * Entries carry `complete` — callers should schedule another frame while false. */
export class MotionPathCache {
  constructor({maxPaths = 64, budgetMs = 6} = {}) {
    this.maxPaths = maxPaths; this.budgetMs = budgetMs;
    this.paths = new Map(); this.tweenCache = new PlaybackTweenCache();
    this.ghostEntry = null; this.cursor = 0;
  }
  clear() { this.paths.clear(); this.tweenCache.clear(); this.ghostEntry = null; this.rows = this.rowsFor = this.rowsVersion = null; }
  /** Pointer input reads prepared data; it never evaluates the animation. */
  peek(editor, target) {
    const entry = this.paths.get(motionPathTargetKey(target));
    return entry?.base === editor.report && entry.revision === editor.revision &&
      entry.layerRevision === editor.layerRevision ? entry : null;
  }
  get(editor, target, options = {}) {
    return this.sample(editor, [target], options)[0] ?? null;
  }
  /** Plan (or reuse) one target's entry without sampling it. */
  plan(editor, target, {range = 0, maxPoints = 1600} = {}) {
    const key = motionPathTargetKey(target);
    if (!key) return null;
    let entry = this.paths.get(key);
    const stale = !entry || entry.base !== editor.report || entry.revision !== editor.revision ||
      entry.totalTicks !== editor.totalTicks || entry.layerRevision !== editor.layerRevision ||
      entry.range !== range || entry.maxPoints !== maxPoints || (range > 0 && entry.center !== editor.tick) ||
      (editor.tick < editor.totalTicks && !entry.tickSet.has(editor.tick));
    if (!stale) return entry;
    const plan = motionPathTicks(editor, {range, maxPoints, target});
    // Keep the previous trail while it resamples so edits morph it instead of
    // clearing and re-growing it; a replaced document or a retimed scene must
    // start empty because its ticks no longer mean the same thing.
    const sameDocument = entry?.base === editor.report && entry.totalTicks === editor.totalTicks;
    const reusable = sameDocument && entry.revision === editor.revision && entry.layerRevision === editor.layerRevision && !entry.liveRange;
    const keep = sameDocument ? new Map(plan.ticks.filter(t => entry.points.has(t)).map(t => [t, entry.points.get(t)])) : new Map();
    // The playhead's surroundings matter most — sample nearest ticks first.
    const todo = plan.ticks.filter(t => !reusable || !keep.has(t)).sort((a, b) => Math.abs(a - editor.tick) - Math.abs(b - editor.tick));
    entry = {key, target, base: editor.report, revision: editor.revision, layerRevision: editor.layerRevision,
      totalTicks: editor.totalTicks, range, maxPoints, center: editor.tick, ticks: plan.ticks, tickSet: new Set(plan.ticks), keyTicks: plan.keyTicks,
      points: keep, todo: new Set(todo), liveRange: entry?.liveRange ?? null, version: 0,
      tweenCache: this.tweenCache, complete: false};
    this.paths.delete(key); this.paths.set(key, entry);
    while (this.paths.size > this.maxPaths) this.paths.delete(this.paths.keys().next().value);
    return entry;
  }
  /** Sample every target cooperatively until one shared deadline. Targets that
   * need the same display tick are resolved by a single evaluation. */
  sample(editor, targets, {session, range = 0, deadline, maxPoints = 1600} = {}) {
    const entries = targets.map(target => this.plan(editor, target, {range, maxPoints}));
    const active = entries.filter(Boolean);
    if (!active.length) return entries;
    // Edits mutate the document in place, so its rows are keyed by revision too.
    const report = session?.report ?? editor.report, version = `${editor.revision}:${editor.layerRevision}`;
    if (this.rowsFor !== report || this.rowsVersion !== version) { this.rows = timeline(report); this.rowsFor = report; this.rowsVersion = version; }
    const rows = this.rows, authored = Boolean(report._styk?.layerSheet || animationChannels(report).length);
    const liveRange = session?.range;
    for (const entry of active) {
      const staleRange = !session && entry.liveRange ? entry.liveRange : null;
      // Each virtual report is immutable for one pointer update. Queue its window
      // once, then let later renders finish it instead of restarting at its center.
      if (staleRange || (liveRange && entry.sampledReport !== report)) {
        const urgent = entry.ticks.filter(t =>
          (liveRange && t >= liveRange[0] && t < liveRange[1]) ||
          (staleRange && t >= staleRange[0] && t < staleRange[1]));
        const center = session?.tick ?? editor.tick;
        urgent.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
        entry.todo = new Set([...urgent, ...entry.todo]);
      }
      entry.sampledReport = report;
    }
    const until = deadline ?? performance.now() + this.budgetMs;
    let started = false;
    for (;;) {
      // Round-robin the leading entry so trails with distinct plans all refine.
      let lead = null;
      for (let n = 0; n < active.length && !lead; n++) {
        const entry = active[(this.cursor + n) % active.length];
        if (entry.todo.size) { lead = entry; this.cursor = (this.cursor + n + 1) % active.length; }
      }
      if (!lead) break;
      // Always sample at least once per call so a zero budget still progresses.
      if ((started || deadline !== undefined) && performance.now() > until) break;
      started = true;
      const tick = lead.todo.values().next().value;
      const needers = active.filter(entry => entry.todo.has(tick));
      const values = samplePathTargets(report, needers.map(entry => entry.target), tick, {rows, tweenCache: this.tweenCache, authored});
      needers.forEach((entry, i) => {
        entry.points.set(tick, pathRecord(tick, values[i], entry.keyTicks));
        entry.todo.delete(tick);
        entry.orderedPoints = null; entry.version++;
      });
    }
    for (const entry of active) {
      entry.complete = !entry.todo.size;
      entry.liveRange = liveRange ?? null;
      entry.live = session ?? null;
    }
    return entries;
  }
  /** The target's component posed at `tick` — the ghost shown while a trail
   * point is hovered or dragged. One evaluation per distinct request; `version`
   * names the document revision because edits mutate the report in place. */
  ghost(report, target, tick, version) {
    if (target?.kind !== 'node') return null;
    const key = motionPathTargetKey(target), cached = this.ghostEntry;
    if (cached?.report === report && cached.version === version && cached.key === key && cached.tick === tick) return cached.value;
    const authored = Boolean(report._styk?.layerSheet || animationChannels(report).length);
    const frame = frameAt(report, timeline(report), tick, {tweenCache: this.tweenCache, authored, needed: nativeNeeds(report, [target.uid])});
    let value = null;
    if (frame) {
      const {slots, scene} = componentScene(report, frame, new Set([target.uid])), slot = slots.get(target.uid);
      if (slot !== undefined) {
        const reference = scene.objects.get(componentRoot(frame, slot))?.root;
        value = {objects: [...scene.objects.values()].filter(Boolean), rx: reference?.x, ry: reference?.y};
      }
    }
    this.ghostEntry = {report, version, key, tick, value};
    return value;
  }
}

/** Ordered point list for drawing/hit-testing, skipping absent ticks. */
export function pathPoints(entry) {
  if (entry.orderedPoints) return entry.orderedPoints;
  const out = [];
  for (const tick of entry.ticks) {
    const point = entry.points.get(tick);
    if (point && !point.missing) out.push(point);
  }
  entry.orderedPoints = out;
  return out;
}

/** Callers' projections (view × camera) are affine, so three probes recover the
 * matrix and each sample then costs two multiply-adds instead of a call. */
export function affineProjection(project) {
  if (Array.isArray(project)) return project;
  const o = project({x: 0, y: 0}), ex = project({x: 1, y: 0}), ey = project({x: 0, y: 1});
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y];
}

/** The playhead sample whose body reference anchors a relative trail. */
function relativeAnchor(entry, relative, tick) {
  if (!relative) return null;
  const anchor = entry.points.get(tick);
  return anchor && !anchor.missing && anchor.rx !== undefined ? anchor : null;
}

/**
 * Screen positions of an entry's drawable samples, cached until its samples,
 * the projection or the relative anchor change. Drawing and pointer hit tests
 * share them, so hovering never re-projects a trail. `breaks[i]` marks a
 * missing pose between samples i-1 and i; unsampled ticks do not break it.
 */
export function projectMotionPath(entry, project, {relative = false, tick} = {}) {
  const m = affineProjection(project), anchor = relativeAnchor(entry, relative, tick);
  const ax = anchor?.rx, ay = anchor?.ry, cached = entry.screen;
  if (cached && cached.version === entry.version && cached.ticks === entry.ticks && cached.points === entry.points &&
      cached.ax === ax && cached.ay === ay && cached.m.every((v, i) => v === m[i])) return cached;
  const samples = [], breaks = [];
  let gap = false;
  for (const t of entry.ticks) {
    const sample = entry.points.get(t);
    if (!sample) continue;
    if (sample.missing) { gap = samples.length > 0; continue; }
    samples.push(sample); breaks.push(gap); gap = false;
  }
  const n = samples.length, xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = samples[i];
    let x = p.x, y = p.y;
    if (anchor && p.rx !== undefined) { x += ax - p.rx; y += ay - p.ry; }
    xs[i] = m[0] * x + m[2] * y + m[4]; ys[i] = m[1] * x + m[3] * y + m[5];
  }
  return entry.screen = {version: entry.version, ticks: entry.ticks, points: entry.points, m, ax, ay, samples, breaks, xs, ys, speed: null};
}

export function pickMotionPathPoint(entry, point, {project, radius = 9, excludeTick, tick, relative = false} = {}) {
  const {samples, xs, ys} = projectMotionPath(entry, project, {relative, tick});
  let best = radius * radius, hit = -1;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (excludeTick !== undefined && sample.tick === excludeTick) continue;
    const distance = (xs[i] - point.x) ** 2 + (ys[i] - point.y) ** 2;
    if (distance < best || (distance === best && (hit < 0 ||
        (tick !== undefined && Math.abs(sample.tick - tick) < Math.abs(samples[hit].tick - tick))))) {
      best = distance; hit = i;
    }
  }
  return hit < 0 ? null : {...samples[hit], distance: Math.sqrt(best)};
}

/** Slow → fast. Shared with the settings legend. */
export const MOTION_PATH_SPEED_COLORS = ['#3b82f6', '#06b6d4', '#22c55e', '#a3c211', '#eab308', '#f97316', '#ef4444'];

/** Per-segment speed bucket: screen distance per frame against the trail's
 * 90th percentile, so spacing reads as colour — cool is slow, warm is fast. */
function speedBuckets(screen) {
  if (screen.speed) return screen.speed;
  const {samples, xs, ys} = screen, n = samples.length, speed = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++)
    speed[i - 1] = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) / Math.max(1, samples[i].tick - samples[i - 1].tick);
  const sorted = Float64Array.from(speed).sort(), reference = sorted[Math.floor((sorted.length - 1) * 0.9)] || 1;
  const buckets = new Uint8Array(speed.length), top = MOTION_PATH_SPEED_COLORS.length - 1;
  for (let i = 0; i < speed.length; i++) buckets[i] = Math.round(Math.min(1, speed[i] / reference) * top);
  return screen.speed = buckets;
}

const CELL = 12, cellOf = value => clamp(Math.floor(value / CELL), -32000, 32000) + 32768;

/**
 * Screen-space layout keeps dense/held paths legible without changing their
 * editable samples. Markers outside `bounds` (plus a margin) are skipped.
 */
export function layoutMotionPath(entry, project, {tick, hover, dragging, dots = true, labels = false, relative = false, bounds, currentBadge = true, badgeSuffix = ''} = {}) {
  const screen = projectMotionPath(entry, project, {relative, tick});
  const {samples, xs, ys} = screen, n = samples.length;
  const priority = p => p.tick === dragging?.tick ? 4 : p.tick === hover?.tick ? 3 : p.tick === tick ? 2 : p.key ? 1 : 0;
  // Stable priority makes the current/hovered point win at overlapping
  // positions: special points first, then keys, then the rest in time order.
  const order = [], keys = [], rest = [];
  for (let i = 0; i < n; i++) {
    const rank = priority(samples[i]);
    (rank >= 2 ? order : rank ? keys : rest).push(i);
  }
  order.sort((a, b) => priority(samples[b]) - priority(samples[a]) || a - b);
  order.push(...keys);
  if (dots) order.push(...rest);
  const margin = 24, cells = new Map(), markers = [], badges = [];
  const overlaps = (x, y, distance) => {
    const cx = cellOf(x), cy = cellOf(y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const p of cells.get((cx + dx) * 65536 + cy + dy) ?? [])
        if ((x - p.x) ** 2 + (y - p.y) ** 2 < distance ** 2) return true;
    return false;
  };
  for (const i of order) {
    const p = samples[i], x = xs[i], y = ys[i], rank = priority(p);
    if (bounds && rank < 3 && (x < -margin || y < -margin || x > bounds.width + margin || y > bounds.height + margin)) continue;
    if (overlaps(x, y, rank ? 7 : 9)) continue;
    const key = cellOf(x) * 65536 + cellOf(y), marker = {tick: p.tick, key: p.key, x, y, rank};
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(marker);
    markers.push(marker);
    if (badges.length >= 48 || !(rank >= 3 || (labels && (rank === 2 ? currentBadge : p.key || i === 0 || i === n - 1)))) continue;
    const text = rank >= 3 && badgeSuffix ? `${p.tick + 1} ${badgeSuffix}` : String(p.tick + 1), width = text.length * 6.2 + 12;
    const box = {x: x + 9, y: y - 23, width, height: 18, text, rank};
    if (badges.some(b => box.x < b.x + b.width + 5 && box.x + width + 5 > b.x && box.y < b.y + b.height + 4 && box.y + box.height + 4 > b.y)) continue;
    badges.push(box);
  }
  return {screen, markers, badges};
}

const FALLOFF_COLOR = '#f97316';

/** Falloff preview: rings sized and weighted by each frame's influence, keys a
 * release will change filled with the trail colour, and added hold keys drawn
 * as squares. `influence` is {tick, radius, shape, changed: Set, edges: Set}. */
function drawInfluence(context, screen, markers, influence, color, alpha) {
  const {samples, xs, ys} = screen, {tick, radius, shape} = influence, buckets = [[], [], [], [], []];
  for (let i = 0; i < samples.length; i++) {
    const distance = Math.abs(samples[i].tick - tick);
    if (!distance || distance > radius) continue;
    const weight = falloffWeight(distance, radius, shape);
    buckets[Math.min(4, Math.floor(weight * 5))].push(i);
  }
  buckets.forEach((list, b) => {
    if (!list.length) return;
    const weight = (b + 0.5) / 5, r = 3 + weight * 8;
    context.beginPath();
    for (const i of list) { context.moveTo(xs[i] + r, ys[i]); context.arc(xs[i], ys[i], r, 0, Math.PI * 2); }
    context.globalAlpha = (0.1 + weight * 0.28) * alpha; context.fillStyle = FALLOFF_COLOR; context.fill();
  });
  for (const p of markers) {
    if (influence.changed?.has(p.tick) && !influence.edges?.has(p.tick) && p.tick !== tick) {
      const r = 5;
      context.beginPath(); context.moveTo(p.x, p.y - r); context.lineTo(p.x + r, p.y); context.lineTo(p.x, p.y + r); context.lineTo(p.x - r, p.y); context.closePath();
      context.globalAlpha = alpha; context.fillStyle = color; context.fill(); context.strokeStyle = '#ffffff'; context.lineWidth = 1.5; context.stroke();
    } else if (influence.edges?.has(p.tick)) {
      context.beginPath(); context.rect(p.x - 3.5, p.y - 3.5, 7, 7);
      context.globalAlpha = alpha; context.fillStyle = '#ffffff'; context.fill(); context.strokeStyle = '#64748b'; context.lineWidth = 1.5; context.stroke();
    }
  }
}

/** Neutral contrast halo, quieter past, crisp keys, optional speed colours,
 * an optional falloff preview and collision-free labels. */
export function drawMotionPath(context, entry, project, options = {}) {
  const {tick, color = '#0d99ff', faint = false, speed = false, strong = false, influence = null} = options;
  const {screen, markers, badges} = layoutMotionPath(entry, project, options);
  const {samples, breaks, xs, ys} = screen, n = samples.length;
  if (!n) return;
  const alpha = faint ? 0.25 : 1, width = strong ? 2.2 : 1.6;
  const buckets = speed && n > 1 ? speedBuckets(screen) : null;
  context.save();
  context.lineCap = 'round'; context.lineJoin = 'round';
  // One canvas path per style; segment i joins sample i-1 to sample i.
  const stroke = (lineWidth, style, opacity, accept) => {
    context.beginPath();
    let pen = false;
    for (let i = 1; i < n; i++) {
      if (!breaks[i] && accept(i)) {
        if (!pen) context.moveTo(xs[i - 1], ys[i - 1]);
        context.lineTo(xs[i], ys[i]); pen = true;
      } else pen = false;
    }
    context.lineWidth = lineWidth; context.strokeStyle = style; context.globalAlpha = opacity * alpha; context.stroke();
  };
  const past = i => samples[i].tick <= tick;
  stroke(width + 2.4, '#ffffff', 0.65, () => true);
  if (buckets) {
    MOTION_PATH_SPEED_COLORS.forEach((style, b) => {
      stroke(width + 0.6, style, 0.45, i => buckets[i - 1] === b && past(i));
      stroke(width + 0.6, style, 0.95, i => buckets[i - 1] === b && !past(i));
    });
  } else {
    stroke(width, color, 0.38, past);
    stroke(width, color, 0.85, i => !past(i));
  }
  // Batch small dots into a single fill instead of a canvas call per frame.
  context.beginPath();
  for (const p of markers) if (!p.rank) { context.moveTo(p.x + 2, p.y); context.arc(p.x, p.y, 2, 0, Math.PI * 2); }
  context.globalAlpha = 0.65 * alpha; context.fillStyle = color; context.fill();
  context.beginPath();
  for (const p of markers) if (p.rank === 1) {
    const r = 3.5;
    context.moveTo(p.x, p.y - r); context.lineTo(p.x + r, p.y);
    context.lineTo(p.x, p.y + r); context.lineTo(p.x - r, p.y); context.closePath();
  }
  context.globalAlpha = alpha; context.fillStyle = '#ffffff'; context.fill();
  context.strokeStyle = color; context.lineWidth = 1.5; context.stroke();
  if (influence) drawInfluence(context, screen, markers, influence, color, alpha);
  // The current frame is a ring; a hovered or dragged point fills with colour.
  for (let i = markers.length - 1; i >= 0; i--) {
    const p = markers[i], active = p.rank >= 3;
    if (p.rank < 2) continue;
    context.beginPath(); context.arc(p.x, p.y, active ? 11 : 9, 0, Math.PI * 2);
    context.globalAlpha = (active ? 0.22 : 0.15) * alpha; context.fillStyle = color; context.fill();
    context.beginPath(); context.arc(p.x, p.y, active ? 6 : 5, 0, Math.PI * 2);
    context.globalAlpha = alpha; context.fillStyle = active ? color : '#ffffff'; context.fill();
    context.strokeStyle = active ? '#ffffff' : color; context.lineWidth = 2; context.stroke();
  }
  context.font = '600 10px Inter, system-ui, sans-serif';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const b of badges) {
    context.globalAlpha = (b.rank >= 2 ? 1 : 0.82) * alpha;
    context.beginPath(); context.roundRect(b.x, b.y, b.width, b.height, 5);
    context.fillStyle = b.rank >= 3 ? color : '#263445'; context.fill();
    context.fillStyle = '#ffffff'; context.fillText(b.text, b.x + b.width / 2, b.y + b.height / 2);
  }
  context.restore();
}

/** The pose at a hovered or dragged trail point: a dashed stick outline of the
 * target's component, shifted like its trail when paths are shown relative. */
export function drawMotionPathGhost(context, ghost, project, {color = '#0d99ff', entry, relative = false, tick} = {}) {
  if (!ghost?.objects.length) return;
  const m = affineProjection(project), anchor = entry ? relativeAnchor(entry, relative, tick) : null;
  const dx = anchor && ghost.rx !== undefined ? anchor.rx - ghost.rx : 0, dy = anchor && ghost.ry !== undefined ? anchor.ry - ghost.ry : 0;
  const sx = p => m[0] * (p.x + dx) + m[2] * (p.y + dy) + m[4], sy = p => m[1] * (p.x + dx) + m[3] * (p.y + dy) + m[5];
  const scale = Math.hypot(m[0], m[1]);
  context.save();
  context.lineCap = 'round'; context.lineJoin = 'round';
  context.beginPath();
  for (const object of ghost.objects) for (const s of object.segments ?? []) {
    if (s.seg?.visible === false || s.type === 'image' || s.type === 'text') continue;
    if (s.type === 'circle') {
      const center = {x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2};
      const r = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) / 2 * scale, cx = sx(center), cy = sy(center);
      if (r > 0.5) { context.moveTo(cx + r, cy); context.arc(cx, cy, r, 0, Math.PI * 2); }
      continue;
    }
    const line = s.points?.length >= 2 ? s.points : [s.start, s.end];
    context.moveTo(sx(line[0]), sy(line[0]));
    for (let i = 1; i < line.length; i++) context.lineTo(sx(line[i]), sy(line[i]));
  }
  context.globalAlpha = 0.7; context.strokeStyle = '#ffffff'; context.lineWidth = 4.5; context.stroke();
  context.globalAlpha = 0.9; context.strokeStyle = color; context.lineWidth = 1.75; context.setLineDash([5, 3]); context.stroke();
  context.restore();
}
