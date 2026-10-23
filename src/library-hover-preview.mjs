import {localizedAttribute, appendLocalized, localizedText} from './localization-bindings.mjs';
import {readLibraryFile} from './library-files.mjs';

/** One disposable worker and one frame in flight; no decoded-document cache. */
export class LibraryHoverPreview {
  constructor(desktop) { this.desktop = desktop; }
  start(card, item) {
    if (this.current?.card === card) return;
    this.stop();
    const session = {card, controller: new AbortController()}; this.current = session;
    session.delay = setTimeout(() => this.load(session, item), 180);
  }
  async load(session, item) {
    const active = () => this.current === session && session.card.isConnected;
    try {
      const file = await readLibraryFile(this.desktop, item.path, {signal: session.controller.signal});
      if (!active()) return;
      const worker = new Worker(new URL('./library-preview-worker.mjs', import.meta.url), {type: 'module', name: 'Library hover preview'});
      session.worker = worker;
      const fail = () => { if (active()) { this.stop(); localizedAttribute(session.card, "title", "libraryHoverPreview.animationPreviewUnavailableDoubleClickToInsertThis", {}); } };
      worker.onerror = event => { event.preventDefault(); fail(); };
      worker.onmessageerror = fail;
      session.timeout = setTimeout(fail, 60000);
      worker.onmessage = ({data}) => {
        if (!active()) { data.bitmap?.close(); return; }
        if (data.error) { fail(); return; }
        if (!data.bitmap) return;
        clearTimeout(session.timeout);
        if (!session.canvas) {
          session.canvas = document.createElement('canvas'); session.canvas.className = 'library-animation';
          session.canvas.width = session.canvas.height = 320; session.canvas.setAttribute('aria-hidden', 'true');
          appendLocalized(session.card.querySelector('.library-thumbnail'), session.canvas);
          session.card.classList.add('library-preview-playing');
          localizedText(session.card.querySelector('.library-preview-hint'), "libraryHoverPreview.playing", {});
          session.started = performance.now();
        }
        const context = session.canvas.getContext('2d');
        context.clearRect(0, 0, 320, 320); context.drawImage(data.bitmap, 0, 0); data.bitmap.close();
        session.canvas.dataset.tick = String(data.tick);
        session.card.style.setProperty('--library-progress', String((data.tick + 1) / data.duration));
        // Contrast stays stable for the whole hover, including color-changing clips.
        if (data.matte) session.card.style.setProperty('--library-matte', data.matte);
        session.delay = setTimeout(() => {
          if (!active()) return;
          session.timeout = setTimeout(fail, 15000);
          worker.postMessage({operation: 'frame', elapsed: (performance.now() - session.started) / 1000});
        }, 1000 / Math.min(24, data.fps));
      };
      worker.postMessage({operation: 'animation', file, baseURL: location.href});
    } catch (error) {
      if (active()) { this.stop(); if (error.name !== 'AbortError') localizedAttribute(session.card, "title", "libraryHoverPreview.animationPreviewUnavailableDoubleClickToInsertThis", {}); }
    }
  }
  stop() {
    const session = this.current; this.current = null;
    if (!session) return;
    clearTimeout(session.delay); clearTimeout(session.timeout); session.controller.abort(); session.worker?.terminate();
    session.canvas?.remove(); session.card.classList.remove('library-preview-playing');
    const hint = session.card.querySelector('.library-preview-hint'); if (hint) localizedText(hint, "libraryHoverPreview.hoverToPlay", {});
    if (session.card.dataset.matte) session.card.style.setProperty('--library-matte', session.card.dataset.matte);
  }
}
