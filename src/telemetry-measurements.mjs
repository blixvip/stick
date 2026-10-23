import { emptyHistogram, observe, fpsBucket } from './telemetry-schema.mjs';
// Bounded summaries only. Interaction IDs stay in memory; no event targets are read.
const MAX_PENDING = 64, MAX_RECENT = 128, MAX_BATCH = 100, MAX_REGULAR_MS = 60000;
export class InteractionMeasurements {
  constructor(collector) { this.collector = collector; this.pending = new Map(); this.recent = new Set(); this.boundaryAt = 0; }
  boundary(now) { this.flush(); this.boundaryAt = now; }
  observe(entries, { now, foreground = true } = {}) {
    const c = this.collector;
    if (!c.consent.diagnostics || !Number.isFinite(now)) return;
    if (entries.length > MAX_BATCH) c.count('input_observer_dropped', entries.length - MAX_BATCH);
    for (let i = 0; i < Math.min(entries.length, MAX_BATCH); i++) {
      const e = entries[i];
      if (!Number.isFinite(e.duration) || e.duration < 0 || !Number.isFinite(e.startTime)) continue;
      if (!foreground) { c.count('input_background_samples'); continue; }
      if (e.startTime < this.boundaryAt || e.startTime > now || e.duration > MAX_REGULAR_MS) {
        c.count('input_discontinuities'); c.timing('input_anomaly_ms', e.duration); continue;
      }
      if (!Number.isSafeInteger(e.interactionId) || e.interactionId <= 0) { c.count('input_unattributed_samples'); continue; }
      if (this.recent.has(e.interactionId)) continue;
      const old = this.pending.get(e.interactionId);
      if (!old && this.pending.size >= MAX_PENDING) { c.count('input_observer_dropped'); continue; }
      if (!old || e.duration > old.duration) {
        const start = e.processingStart, end = e.processingEnd;
        const phases = Number.isFinite(start) && Number.isFinite(end) && start >= e.startTime && end >= start && end <= now && end - e.startTime <= e.duration + 8;
        if (!phases) { c.count('input_discontinuities'); c.timing('input_anomaly_ms', e.duration); continue; }
        this.pending.set(e.interactionId, { duration: e.duration, ...(phases ? { delay: start - e.startTime, processing: end - start, presentation: Math.max(0, e.duration - (end - e.startTime)) } : {}) });
      }
    }
  }
  flush() {
    for (const [id, e] of this.pending) {
      this.collector.count('input_observed_interactions');
      this.collector.timing('interaction_ms', e.duration);
      if (e.delay !== undefined) {
        this.collector.timing('input_delay_ms', e.delay);
        this.collector.timing('input_processing_ms', e.processing);
        this.collector.timing('input_presentation_ms', e.presentation);
      }
      this.recent.add(id);
      if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.values().next().value);
    }
    this.pending.clear();
  }
}

// Called on actual scene presentation, never on a new animation loop.
export class PlaybackMeasurements {
  constructor(collector) { this.collector = collector; this.reset(); }
  reset(context = {}) { this.last = null; this.boundaryAt = 0; this.context = context; this.groups = new Map(); }
  boundary(now) { this.boundaryAt = now; }
  present(now, fps, foreground, schedule) {
    const c = this.collector;
    if (!c.consent.diagnostics) { this.last = null; return; }
    if (!Number.isFinite(now)) { this.last = null; return; }
    const last = this.last; this.last = now;
    if (!foreground) { c.count('playback_background_intervals'); this.last = null; return; }
    if (last === null) return;
    const interval = now - last;
    if (last < this.boundaryAt || interval < 0 || interval > MAX_REGULAR_MS) {
      c.count('playback_discontinuities'); c.timing('playback_anomaly_ms', interval); return;
    }
    c.count('playback_observed_intervals');
    c.timing('playback_foreground_interval_ms', interval);
    const bucket = fpsBucket(fps);
    let h = this.groups.get(bucket);
    if (!h) { h = emptyHistogram(); this.groups.set(bucket, h); }
    observe(h, interval);
    // A 24 FPS project is assessed against its own intended interval, with 10% scheduling tolerance.
    const deadline = Number.isFinite(fps) && fps > 0 ? 1000 / fps : null;
    if (deadline && interval > deadline * 1.1) c.count('playback_missed_deadlines');
    c.performance?.record('playback_interval',interval,{fps:bucket},1,deadline&&interval>deadline*1.1?1:0);
    // Preserve historical intervals. Healthy 24 FPS on a 60 Hz display has
    // 33/50ms intervals. Allow one measured callback after the intended deadline
    // and retain submission delays/stalls beyond that allowance separately.
    if(deadline&&Number.isFinite(schedule?.deadline)&&schedule.deadline>=this.boundaryAt&&Number.isFinite(schedule?.refreshMs)&&schedule.refreshMs>=4&&schedule.refreshMs<=50){
      const late=Math.max(0,now-schedule.deadline-schedule.refreshMs);
      if(late<=MAX_REGULAR_MS)c.performance?.record('playback_lateness',late,{fps:bucket},1,late>deadline*.1?1:0);
    }
  }
  flush() {
    for (const [fps, timing] of this.groups) this.collector.operationSummary({ ...this.context, operation: 'playback', stage: 'playback', fps, outcome: 'succeeded' }, timing);
    this.groups.clear();
  }
}
