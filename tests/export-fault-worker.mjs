/** Inject a lost 2D surface into the real export worker protocol. */
const queued = [], buffer = event => {queued.push(event.data); event.stopImmediatePropagation();};
self.addEventListener('message', buffer);
const getContext = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (...args) {
  const ctx = getContext.apply(this, args);
  if (args[0] === '2d' && ctx && !ctx.__faultInstalled) {
    ctx.__faultInstalled = true;
    let lost = false;
    const clearRect = ctx.clearRect.bind(ctx);
    ctx.clearRect = (...values) => {clearRect(...values); lost = true;};
    ctx.isContextLost = () => lost;
  }
  return ctx;
};
await import('/src/export-frame-worker.mjs');
self.removeEventListener('message', buffer);
for (const data of queued) self.dispatchEvent(new MessageEvent('message', {data}));
