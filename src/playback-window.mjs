/** Exact lookahead within a half-open playback range. Non-looping playback
 * drains its final packets without competing with a speculative next loop. */
export function playbackWindow(start,count,range,{loop=false,bidirectional=false}={}) {
  const ticks=[],span=range.end-range.start;
  if(span<=0||count<=0)return ticks;
  const behind=bidirectional?Math.min(4,Math.floor(count/4),Math.max(0,start-range.start)):0;
  for(let n=0;n<Math.min(count-behind,span);n++){
    const next=Math.max(start,range.start)+n;
    if(!loop&&next>=range.end)break;
    ticks.push(range.start+(next-range.start)%span);
  }
  for(let n=1;n<=behind;n++){
    const tick=start-n;
    if(tick>=range.start&&tick<range.end&&!ticks.includes(tick))ticks.push(tick);
  }
  return ticks;
}

/** Session playback limits use zero-based, half-open ticks. Shortening an
 * animation keeps a non-empty range inside its new duration. */
export function normalizePlaybackRange(range, totalTicks) {
  const total = Math.max(0, Math.floor(Number(totalTicks)) || 0);
  if (!total || !range || !Number.isFinite(range.startTick) || !Number.isFinite(range.endTick))
    return {start: 0, end: total};
  const start = Math.min(total - 1, Math.max(0, Math.floor(range.startTick)));
  const end = Math.min(total, Math.max(start + 1, Math.floor(range.endTick)));
  return {start, end};
}

/** Inclusive, one-based output frames in the UI; never stored-frame indices. */
export function playbackRangeFromFrames(first, last, totalTicks) {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const {start, end} = normalizePlaybackRange({
    startTick: Math.min(Math.round(first), Math.round(last)) - 1,
    endTick: Math.max(Math.round(first), Math.round(last)),
  }, totalTicks);
  return end > start ? {startTick: start, endTick: end} : null;
}

export function playbackLookaheadSize(count, cores = 4) {
  return Math.max(Math.min(count, 8), Math.round(count * Math.min(1, cores / 8)));
}

/** Expensive cold preparation gets a quarter-second runway. Cheap vector
 * scenes keep the short startup, and neither mode waits beyond its queue. */
export function playbackStartupWindow(fps, compileMs, cores = 4) {
  const seconds = compileMs > 500 / fps ? .25 : .1;
  return Math.min(playbackLookaheadSize(24, cores), Math.max(2, Math.ceil(fps * seconds)));
}
