'use strict';
const { messageError } = require('./localization.cjs');

const crypto = require('node:crypto');
const { WorkspacePreferences } = require('./preferences.cjs');
const config = require('./service-config.json');
const MAX_FILE = 8 * 1024 * 1024;
function siteOrigin(value, development) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || development && url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw messageError(new Error(''), 'desktop.support.errors.invalidSupportServiceOrigin', {});
  return url.origin;
}
function validateRequest(value) {
  if (!value || typeof value !== 'object') throw messageError(new Error(''), 'desktop.support.errors.invalidSupportRequest', {});
  const path = value.path, method = value.method || 'GET';
  if (typeof path !== 'string' || path.length > 400 || !['GET','POST','DELETE'].includes(method)) throw messageError(new Error(''), 'desktop.support.errors.invalidSupportRequest', {});
  const url = new URL(path, 'https://support.invalid');
  if (url.origin !== 'https://support.invalid' || url.hash || !/^\/(?:config|threads(?:\/[a-f0-9]{32}(?:\/(?:messages|seen|files|live)(?:\/[a-f0-9]{32})?)?)?)$/.test(url.pathname)) throw messageError(new Error(''), 'desktop.support.errors.invalidSupportRoute', {});
  const valid = method === 'GET' || method === 'DELETE' && /^\/threads\/[a-f0-9]{32}(?:\/files\/[a-f0-9]{32})?$/.test(url.pathname) || method === 'POST' && (url.pathname === '/threads' || /^\/threads\/[a-f0-9]{32}\/(messages|seen|files|live)$/.test(url.pathname));
  if (!valid) throw messageError(new Error(''), 'desktop.support.errors.invalidSupportOperation', {});
  for (const [key, item] of url.searchParams) if (!['after','before','cursor','message','upload'].includes(key) || !/^[a-z0-9.-]{0,90}$/.test(item)) throw messageError(new Error(''), 'desktop.support.errors.invalidSupportQuery', {});
  const upload = /\/files$/.test(url.pathname) && method === 'POST';
  if (upload) { if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength > MAX_FILE || !value.bytes.length || typeof value.fileName !== 'string' || value.fileName.length > 200) throw messageError(new Error(''), 'desktop.main.errors.invalidAttachment', {}); }
  else if (value.body != null && Buffer.byteLength(JSON.stringify(value.body)) > 40000) throw messageError(new Error(''), 'desktop.support.errors.supportMessageIsTooLarge', {});
  return { path: url.pathname + url.search, method, upload };
}
async function boundedResponse(response, max) {
  if (Number(response.headers.get('content-length') || 0) > max) throw messageError(new Error(''), 'desktop.support.errors.supportResponseIsTooLarge', {});
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > max) { await reader.cancel(); throw messageError(new Error(''), 'desktop.support.errors.supportResponseIsTooLarge', {}); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
class SupportService {
  constructor({ directory, version, development = false, siteUrl = development ? process.env.STYK_SITE_URL || config.siteUrl : config.siteUrl, fetchImpl = fetch }) {
    this.store = new WorkspacePreferences(directory, { filename: 'support-access.json', maxBytes: 1024 });
    this.uiStore = new WorkspacePreferences(directory, { filename: 'support-drafts.json', maxBytes: 1024 * 1024 });
    this.uiPending = Promise.resolve();
    this.version = version; this.siteUrl = siteOrigin(siteUrl, development); this.fetch = fetchImpl; this.inflight = 0;
  }
  async init() {
    if (!this.ready) this.ready = (async () => { const stored = await this.store.get(); this.key = /^[a-f0-9]{64}$/.test(stored.key || '') ? stored.key : crypto.randomBytes(32).toString('hex'); await this.store.set({ key: this.key }); })().catch(error => { this.ready = null; throw error; });
    await this.ready; return this;
  }
  inboxId() { return crypto.createHash('sha256').update('support-drafts:' + this.key).digest('hex').slice(0, 24); }
  async context() {
    await this.init(); await this.uiPending;
    const inboxId = this.inboxId(), saved = (await this.uiStore.get())[inboxId] || {};
    return { version: this.version, platform: process.platform, source: 'desktop', inboxId, drafts: saved.drafts || {}, lastThread: saved.lastThread || '' };
  }
  async saveState(value) {
    await this.init();
    if (!value || value.inboxId !== this.inboxId() || !value.drafts || typeof value.drafts !== 'object' || Array.isArray(value.drafts)) throw messageError(new Error(''), 'desktop.support.errors.invalidSupportState', {});
    if (value.lastThread && !/^[a-f0-9]{32}$/.test(value.lastThread)) throw messageError(new Error(''), 'desktop.support.errors.invalidConversation', {});
    const fields = { category: 40, title: 120, description: 4000, steps: 2000, expected: 1000, actual: 1000, frequency: 40, version: 40, platform: 80, displayName: 50, requestId: 36, message: 4000 };
    const drafts = Object.create(null), entries = Object.entries(value.drafts);
    if (entries.length > 12) throw messageError(new Error(''), 'desktop.support.errors.tooManyDrafts', {});
    for (const [id, draft] of entries) {
      if (id !== 'create' && !/^[a-f0-9]{32}$/.test(id) || !draft || typeof draft !== 'object' || Array.isArray(draft)) throw messageError(new Error(''), 'desktop.support.errors.invalidDraft', {});
      drafts[id] = Object.create(null);
      for (const [key, text] of Object.entries(draft)) {
        if (!Object.hasOwn(fields, key) || typeof text !== 'string' || text.length > fields[key]) throw messageError(new Error(''), 'desktop.support.errors.invalidDraftField', {});
        drafts[id][key] = text;
      }
    }
    const saved = { drafts, lastThread: value.lastThread || '' }, inboxId = value.inboxId;
    if (Buffer.byteLength(JSON.stringify(saved)) > 384 * 1024) throw messageError(new Error(''), 'desktop.support.errors.draftsAreTooLarge', {});
    const pending = this.uiPending.then(async () => {
      const all = await this.uiStore.get(); delete all[inboxId];
      await this.uiStore.set(Object.fromEntries([...Object.entries(all).slice(-1), [inboxId, saved]]));
    });
    this.uiPending = pending.catch(() => {}); await pending; return { saved: true };
  }
  async accessLink() { await this.init(); return this.siteUrl + '/feedback/#key=' + this.key; }
  async restore(key) {
    if (!/^[a-f0-9]{64}$/.test(key || '') || this.inflight) throw messageError(new Error(''), 'desktop.support.errors.thePrivateInboxCannotBeChangedRightNow', {});
    this.closeLive(); await this.init(); await this.store.set({ key }); this.key = key; return { restored: true };
  }
  closeLive(expected) { if (expected != null && expected !== this.liveGeneration) return; this.liveGeneration = (this.liveGeneration || 0) + 1; this.liveSocket?.close(); this.liveSocket = null; }
  async connectLive(id, emit) {
    if (!/^[a-f0-9]{32}$/.test(id || '')) throw messageError(new Error(''), 'desktop.support.errors.invalidConversation2', {});
    this.closeLive(); const generation = this.liveGeneration;
    const ticket = await this.request({ path: `/threads/${id}/live`, method: 'POST' });
    if (generation !== this.liveGeneration) return { available: false };
    if (!ticket.ok) return { available: false, error: ticket.error, status: ticket.status };
    if (!ticket.value.available) return { available: false };
    const url = new URL(ticket.value.path, this.siteUrl);
    if (url.origin !== this.siteUrl || url.pathname !== '/api/v1/support/live') throw messageError(new Error(''), 'desktop.support.errors.invalidLiveEndpoint', {});
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); this.liveSocket = socket;
    const send = type => { if (generation === this.liveGeneration) emit({ threadId: id, type }); };
    socket.onopen = () => send('connected');
    socket.onmessage = event => { if (event.data === 'changed' || event.data === 'deleted') send(event.data); };
    socket.onclose = () => send('disconnected'); socket.onerror = () => { send('disconnected'); socket.close(); };
    return { available: true, connection: generation };
  }
  async request(value) {
    const { path, method, upload } = validateRequest(value); await this.init();
    if (this.inflight >= 2 || upload && this.uploading) throw messageError(new Error(''), 'desktop.support.errors.pleaseWaitForTheCurrentSupportRequest', {});
    this.inflight++; if (upload) this.uploading = true;
    try {
      let body = value.body;
      if (method === 'POST' && path === '/threads') body = { ...body, source: 'desktop', version: this.version, platform: process.platform };
      const headers = { Authorization: 'Bearer ' + this.key };
      if (value.automatic === true) headers['X-Support-Auto'] = '1';
      if (upload) { headers['Content-Type'] = 'application/octet-stream'; headers['X-File-Name'] = encodeURIComponent(value.fileName); }
      else if (body != null) headers['Content-Type'] = 'application/json';
      const response = await this.fetch(this.siteUrl + '/api/v1/support' + path, { method, headers, body: upload ? value.bytes : body == null ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(upload ? 90000 : 20000) });
      const isFile = method === 'GET' && /\/files\/[a-f0-9]{32}$/.test(path);
      // Thirty legal 4,000-character messages can exceed 256 KiB after UTF-8/JSON
      // encoding; even worst-case escaped text fits in this bounded 1 MiB page.
      const content = await boundedResponse(response, isFile && response.ok ? MAX_FILE : 1024 * 1024);
      if (!response.ok) { let code = 'service_unavailable'; try { code = JSON.parse(content.toString('utf8')).error || code; } catch { /* Bounded generic failure. */ } return { ok: false, status: response.status, error: code }; }
      if (isFile) return { ok: true, bytes: new Uint8Array(content), type: response.headers.get('content-type') || 'application/octet-stream', disposition: response.headers.get('content-disposition') || '' };
      return { ok: true, value: JSON.parse(content.toString('utf8')) };
    } finally { this.inflight--; if (upload) this.uploading = false; }
  }
}
module.exports = { SupportService, validateRequest, boundedResponse };
