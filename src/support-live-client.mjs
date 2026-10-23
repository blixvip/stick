import {messageError} from './localized-error.mjs';
/** One receive-only connection per visible conversation. No idle polling or heartbeat. */
export class SupportLiveUpdates {
  constructor({ subscribe, changed, status }) { Object.assign(this, { subscribe, changed, status }); this.generation = 0; }
  start(id) {
    if (this.id === id && this.running) return;
    this.stop(); this.id = id; this.running = true; this.attempts = 0; void this.connect(this.generation);
  }
  async connect(generation) {
    if (!this.running || generation !== this.generation) return;
    if (++this.attempts > 5) { this.status('Manual refresh'); return; }
    this.status('Connecting…'); let failed = false;
    const disconnected = () => {
      if (failed || generation !== this.generation || !this.running) return; failed = true;
      clearTimeout(this.handshake);
      this.close?.(); this.close = null;
      if (this.attempts >= 5) { this.status('Manual refresh'); return; }
      this.status('Reconnecting…');
      this.timer = setTimeout(() => void this.connect(generation), Math.min(30000, 1000 * 2 ** (this.attempts - 1)) + Math.random() * 500);
    };
    this.handshake = setTimeout(disconnected, 10000);
    try {
      const close = await this.subscribe(this.id, event => {
        if (failed || generation !== this.generation || !this.running) return;
        if (event === 'connected') { clearTimeout(this.handshake); this.status('Live'); this.changed(); }
        else if (event === 'changed' || event === 'deleted') { clearTimeout(this.coalesce); this.coalesce = setTimeout(() => this.changed(), 150); }
        else if (event === 'disconnected') disconnected();
      });
      if (generation !== this.generation || failed) close?.(); else this.close = close;
    } catch (error) {
      if (failed || generation !== this.generation) return;
      clearTimeout(this.handshake);
      if (error?.status === 429 || ['live_unavailable','not_found'].includes(error?.code)) { this.status('Manual refresh'); return; }
      disconnected();
    }
  }
  stop() { this.running = false; this.id = null; this.generation++; clearTimeout(this.timer); clearTimeout(this.coalesce); clearTimeout(this.handshake); this.close?.(); this.close = null; }
}
export async function subscribeWebSupport(api, id, event) {
  const ticket = await api(`/threads/${id}/live`, { method: 'POST' });
  if (!ticket.available) { const error = messageError(new Error(''), "errors.supportLiveClient.liveUnavailable", {}); error.code = 'live_unavailable'; throw error; }
  const url = new URL(ticket.path, location.origin);
  if (url.origin !== location.origin || url.pathname !== '/api/v1/support/live') throw messageError(new Error(''), "errors.supportLiveClient.invalidLiveEndpoint", {});
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url); let closed = false;
  socket.onopen = () => event('connected');
  socket.onmessage = message => { if (message.data === 'changed' || message.data === 'deleted') event(message.data); };
  socket.onclose = () => { if (!closed) event('disconnected'); };
  socket.onerror = () => { if (!closed) { event('disconnected'); socket.close(); } };
  return () => { closed = true; socket.close(); };
}
