/**
 * The editor UI fonts are local web fonts (src/styles/base/fonts.css) that load
 * on demand: the latin files at startup, other scripts when a language needs
 * them. Nothing waits for them. A canvas that drew text before its font
 * finished loading keeps the fallback glyphs until it paints again, so canvas
 * text painters repaint through onFontsReady.
 */
const callbacks = new Set();
let listening = false, frame = 0, uiFamily = '';

/**
 * A canvas font in the UI font stack, e.g. `canvasFont('11px')`. The family is
 * the document font (`--font-ui`, base/document.css), read once the stylesheets
 * apply; without a document it is sans-serif.
 */
export function canvasFont(size) {
  if (!uiFamily && typeof getComputedStyle === 'function' && globalThis.document?.documentElement) {
    const style = getComputedStyle(document.documentElement);
    if (style.getPropertyValue('--font-ui').trim()) uiFamily = style.fontFamily;
  }
  return `${size} ${uiFamily || 'sans-serif'}`;
}

function notify() {
  frame = 0;
  for (const callback of [...callbacks]) {
    try { callback(); } catch (error) { globalThis.reportError?.(error); }
  }
}

/**
 * Calls `callback` whenever document fonts finish loading, at most once per
 * frame. Stops when `signal` aborts or the returned function is called.
 */
export function onFontsReady(callback, {signal} = {}) {
  const fonts = globalThis.document?.fonts;
  if (!fonts || signal?.aborted) return () => {};
  if (!listening) {
    listening = true;
    fonts.addEventListener('loadingdone', () => { frame ||= requestAnimationFrame(notify); });
  }
  callbacks.add(callback);
  const remove = () => { callbacks.delete(callback); signal?.removeEventListener('abort', remove); };
  signal?.addEventListener('abort', remove, {once: true});
  return remove;
}
