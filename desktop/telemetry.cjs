'use strict';
const { messageError } = require('./localization.cjs');

const crypto = require('node:crypto');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { WorkspacePreferences } = require('./preferences.cjs');
const config = require('./service-config.json');
const DAY = 86400000, UPLOAD_INTERVAL = 15 * 60000;
const dayOf = time => new Date(time).toISOString().slice(0, 10);
const enabled = consent => Boolean(consent?.analytics || consent?.diagnostics);
const timeout = ms => AbortSignal.timeout(ms);
const boundedAdd = (a = 0, b = 0) => Math.min(1e9, a + b);
function mergeHistogram(target, incoming) {
  if (target.count + incoming.count > 1e9 || target.sum + incoming.sum > 3.6e15) return false;
  target.count += incoming.count; target.sum += incoming.sum; target.max = Math.max(target.max, incoming.max);
  incoming.buckets.forEach((n, i) => target.buckets[i] += n);
  return true;
}
function successBucket(milliseconds) {
  return milliseconds < 60000 ? 'under-1m' : milliseconds < 300000 ? '1-5m' : milliseconds < 1800000 ? '5-30m' : milliseconds < 7200000 ? '30m-2h' : milliseconds < DAY ? '2-24h' : 'over-24h';
}
function mergedTraffic(previous, current) {
  if (previous === current || previous === 'mixed' || previous === 'unknown') return previous;
  return 'mixed';
}
function endpoint(value, development = false) {
  if (!value) return '';
  try { const url = new URL(value); if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.protocol === 'https:' || development && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) ? url.origin : ''; } catch { return ''; }
}
class TelemetryService {
  constructor({ directory, schemaPath, version, development = false, internal = false, build = 'unknown', siteUrl = development ? process.env.STYK_SITE_URL || config.siteUrl : config.siteUrl, fetchImpl = fetch, now = Date.now, onState = () => {} }) {
    this.store = new WorkspacePreferences(directory, { filename: 'telemetry-state.json', maxBytes: 300 * 1024 });
    this.schemaPath = schemaPath; this.version = version; this.channel = development ? 'development' : config.channel; this.siteUrl = endpoint(siteUrl, development);
    // Classification comes from trusted main-process build settings, never renderer IPC.
    this.traffic = development || internal === true ? 'internal' : 'external'; this.build = typeof build === 'string' && /^[a-f0-9]{12,40}$/.test(build) ? build : 'unknown';
    this.fetch = fetchImpl; this.now = now; this.onState = onState; this.epoch = 1; this.lastUpload = 0; this.nextUpload = 0; this.status = 'Waiting for your choice'; this.unsaved = false;
    this.pending = Promise.resolve(); this.state = { consent: {}, days: {}, milestones: {}, firstSuccess: {}, deletions: [], sequence: 0, acknowledged: null };
  }
  async init({ timers = true } = {}) {
    this.schema = await import(pathToFileURL(this.schemaPath).href);
    const loaded = await this.store.get();
    this.state.sequence = Number.isSafeInteger(loaded.sequence) && loaded.sequence >= 0 ? loaded.sequence : 0;
    this.state.diagnosticGeneration=Number.isSafeInteger(loaded.diagnosticGeneration)?Math.max(0,loaded.diagnosticGeneration):0;
    if (loaded.consent?.policyVersion === this.schema.POLICY_VERSION) {
      this.state.consent = { analytics: loaded.consent.analytics === true, diagnostics: loaded.consent.diagnostics === true, policyVersion: this.schema.POLICY_VERSION, updatedAt: Number(loaded.consent.updatedAt) || this.now() };
      this.state.decided = loaded.decided === true;
    }
    if (/^[a-f0-9]{64}$/.test(loaded.token || '')) this.state.token = loaded.token;
    try { if (loaded.acknowledged?.day === dayOf(this.now())) this.state.acknowledged = this.schema.validateSnapshot(loaded.acknowledged); } catch { /* Invalid baseline is discarded. */ }
    this.state.deletions = (Array.isArray(loaded.deletions) ? loaded.deletions : []).filter(d => /^[a-f0-9]{64}$/.test(d?.token || '') && endpoint(d.url, true) === d.url).slice(0, 4);
    if (enabled(this.state.consent) && this.state.token) {
      for (const [day, data] of Object.entries(loaded.days || {}).slice(-7)) {
        try { if (this.now() - Date.parse(day) < 7 * DAY) this.state.days[day] = this.schema.validateSnapshot({ ...data, consent: this.state.consent }); } catch { /* Discard corrupt local summaries. */ }
      }
      this.state.milestones = Object.assign({}, ...Object.values(this.state.days).map(d => d.milestones));
      if (this.state.consent.analytics) for (const key of this.schema.MILESTONES) {
        const day = loaded.milestones?.[key];
        if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && dayOf(Date.parse(day)) === day && day <= dayOf(this.now())) this.state.milestones[key] = day;
      }
      if (this.state.consent.analytics) {
        const observedAt = loaded.firstObservedAt;
        if (Number.isFinite(observedAt) && observedAt >= 0 && observedAt <= this.now() && dayOf(observedAt) === this.state.milestones.first_launch) this.state.firstObservedAt = observedAt;
        for (const data of [...Object.values(this.state.days), loaded]) for (const key of ['save', 'export']) {
          if (this.schema.FIRST_SUCCESS_BUCKETS.includes(data.firstSuccess?.[key]) && this.state.milestones[`first_${key}`]) this.state.firstSuccess[key] ||= data.firstSuccess[key];
        }
      }
      this.ensureIdentity(); this.count('sessions_started'); this.milestone('first_launch');
      this.sessionCounted = this.state.consent.analytics;
      if (loaded.running && this.state.consent.diagnostics) this.count('unclean_starts');
    }
    this.state.running = enabled(this.state.consent); this.refreshStatus();
    await this.persist();
    this.timersEnabled = timers; this.configureTimer();
    return this;
  }
  configureTimer() {
    clearInterval(this.timer); this.timer = null;
    if (this.timersEnabled && (enabled(this.state.consent) || this.state.deletions.length)) {
      this.timer = setInterval(() => { if (enabled(this.state.consent) && this.unsaved) void this.persist().catch(() => {}); void this.upload().catch(() => {}); }, 60000); this.timer.unref?.();
    }
  }
  ensureIdentity() {
    if (!this.state.token) { this.state.token = crypto.randomBytes(32).toString('hex'); this.unsaved = true; }
    this.id = crypto.createHash('sha256').update(this.state.token).digest('hex');
  }
  refreshStatus() { this.status = this.state.deletions.length ? 'Deletion pending; retrying when online' : !enabled(this.state.consent) ? 'Collection is off' : !this.siteUrl ? 'Local only · service not configured' : 'Batched · sends at most every 15 minutes'; }
  getState() {
    return { epoch: this.epoch, decided: Boolean(this.state.decided), consent: { analytics: false, diagnostics: false, policyVersion: this.schema.POLICY_VERSION, ...this.state.consent },
      installationId: enabled(this.state.consent) ? this.id || null : null, siteUrl: this.siteUrl, publisher: config.publisher, contact: config.contact,
      status: this.status, lastUpload: this.lastUpload || null, pendingDays: Object.keys(this.state.days).length, deletionPending: this.state.deletions.length > 0 };
  }
  notify() { this.onState(this.getState()); }
  async setConsent(value) {
    if (typeof value?.analytics !== 'boolean' || typeof value?.diagnostics !== 'boolean') throw messageError(new TypeError(''), 'desktop.telemetry.errors.chooseAnalyticsAndDiagnosticsSeparately', {});
    this.epoch++; this.controller?.abort();
    this.state.consent = { analytics: value.analytics, diagnostics: value.diagnostics, policyVersion: this.schema.POLICY_VERSION, updatedAt: this.now() };
    this.state.decided = true; this.state.running = enabled(value);
    if (enabled(value)) {
      this.ensureIdentity();
      // Changing a category drops its unsent data. Retained server history can be deleted separately.
      for (const [day, data] of Object.entries(this.state.days)) this.state.days[day] = this.schema.validateSnapshot({ ...data, consent: this.state.consent, sequence: ++this.state.sequence });
      if (!value.analytics) { this.state.milestones = {}; this.state.firstSuccess = {}; delete this.state.firstObservedAt; }
      if (value.analytics && !this.sessionCounted) { this.count('sessions_started'); this.milestone('first_launch'); this.sessionCounted = true; }
    } else { this.state.days = {}; this.state.milestones = {}; this.state.firstSuccess = {}; delete this.state.firstObservedAt; }
    this.refreshStatus(); await this.persist(); this.configureTimer(); this.notify(); return this.getState();
  }
  today() {
    if (!enabled(this.state.consent)) return null;
    this.ensureIdentity(); const day = dayOf(this.now());
    if (this.state.acknowledged?.day !== day) this.state.acknowledged = null;
    for (const key of Object.keys(this.state.days)) if (this.now() - Date.parse(key) > 7 * DAY) delete this.state.days[key];
    if (!this.state.days[day] && this.state.acknowledged?.installationId === this.id) {
      this.state.days[day] = this.schema.validateSnapshot({ ...this.state.acknowledged, consent: this.state.consent, sequence: ++this.state.sequence });
      this.state.milestones = { ...this.state.days[day].milestones, ...this.state.milestones };
      this.state.firstSuccess = { ...this.state.days[day].firstSuccess, ...this.state.firstSuccess };
    }
    if (this.state.days[day]) {
      let current = this.state.days[day];
      if(current.schemaVersion<3&&this.state.diagnosticGeneration>0)current=this.schema.clearDiagnostics(current,this.state.diagnosticGeneration);
      const previousTraffic = current.app.traffic || (current.app.channel === 'development' ? 'internal' : 'unknown');
      const app = { version: this.version, channel: this.channel, traffic: mergedTraffic(previousTraffic, this.traffic), build: this.build };
      if (current.schemaVersion !== this.schema.SCHEMA_VERSION || JSON.stringify(current.app) !== JSON.stringify(app)) {
        this.state.days[day] = this.schema.validateSnapshot({ ...current, schemaVersion: this.schema.SCHEMA_VERSION,diagnosticGeneration:this.state.diagnosticGeneration||0, app, operationContexts: current.operationContexts || [], firstSuccess: this.state.firstSuccess, sequence: ++this.state.sequence });
      }
      return this.state.days[day];
    }
    return this.state.days[day] = { schemaVersion: this.schema.SCHEMA_VERSION, installationId: this.id, day, sequence: ++this.state.sequence, app: { version: this.version, channel: this.channel, traffic: this.traffic, build: this.build }, consent: { ...this.state.consent },
      environment: this.schema.sanitizeEnvironment({ os: process.platform, arch: process.arch, osVersion: process.platform === 'win32' ? Number(os.release().split('.')[2]) >= 22000 ? 'windows-11' : 'windows-10' : process.platform === 'darwin' ? 'mac' : 'linux',
        ramBucket: os.totalmem() <= 5 * 1073741824 ? '4-or-less' : os.totalmem() <= 9 * 1073741824 ? '8' : os.totalmem() <= 17 * 1073741824 ? '16' : os.totalmem() <= 33 * 1073741824 ? '32' : '64-plus',
        cpuBucket: os.availableParallelism() <= 2 ? '2-or-less' : os.availableParallelism() <= 4 ? '4' : os.availableParallelism() <= 8 ? '8' : os.availableParallelism() <= 16 ? '16' : '32-plus' }),
      counters: {}, timings: {}, gauges: {}, errors: [], operationContexts: [], performance:this.schema.emptyPerformance(),diagnosticGeneration:this.state.diagnosticGeneration||0, firstSuccess: { ...this.state.firstSuccess }, milestones: { ...this.state.milestones } };
  }
  record({ epoch, data, environment }) {
    if (epoch !== this.epoch || !enabled(this.state.consent) || !data) return false;
    const today = dayOf(this.now());
    if (!this.state.days[today] && Object.keys(data.counters || {}).every(key => key === 'idle_seconds') && !Object.keys(data.timings || {}).length && !Object.keys(data.gauges || {}).length && !Object.keys(data.milestones || {}).length && !data.errors?.length && !data.operationContexts?.length && !data.performance?.rows?.length && !data.performance?.incidents?.length) return false;
    const sequenceBefore = this.state.sequence, dayCount = Object.keys(this.state.days).length, acknowledged = this.state.acknowledged;
    const current = this.schema.validateSnapshot(this.today()); let changed = false;
    // today() can create, restore, or prune days and reset the acknowledged baseline.
    if (this.state.sequence !== sequenceBefore || Object.keys(this.state.days).length !== dayCount || this.state.acknowledged !== acknowledged) this.unsaved = true;
    const safe = this.schema.validateSnapshot({ ...current, counters: {}, timings: {}, gauges: {}, errors: [], milestones: {}, operationContexts: [], performance:this.schema.emptyPerformance(), ...data,
      schemaVersion: this.schema.SCHEMA_VERSION, diagnosticGeneration:this.state.diagnosticGeneration||0, installationId: this.id, day: current.day, sequence: current.sequence, app: current.app, consent: this.state.consent, firstSuccess: {}, environment: this.schema.sanitizeEnvironment(environment) });
    const source=this.schema.provenance({release:this.version,build:this.build,traffic:this.traffic,ram:current.environment.ramBucket,cpu:current.environment.cpuBucket,gpu:safe.environment.gpuFamily!=='unknown'?safe.environment.gpuFamily:current.environment.gpuFamily});
    const dropped = (key, n = 1) => { if (this.state.consent.diagnostics) { current.counters[key] = boundedAdd(current.counters[key], n); changed = true; } };
    for (const [key, n] of Object.entries(safe.counters)) if (n > 0) { current.counters[key] = boundedAdd(current.counters[key], n); changed = true; }
    for (const [key, h] of Object.entries(safe.timings)) {
      if (!h.count) continue; changed = true;
      const target = current.timings[key] ||= this.schema.emptyHistogram();
      if (!mergeHistogram(target, h)) dropped('dropped_samples', h.count);
    }
    for (const entry of safe.operationContexts) {
      if (!entry.timing.count) continue;
      const slot=this.schema.operationContextSlot(current.operationContexts,{...this.schema.operationContext(entry),provenance:source});
      if(slot.dropped)dropped('dropped_operation_contexts',slot.dropped);
      if(slot.row){if(mergeHistogram(slot.row.timing,entry.timing))changed=true;else dropped('dropped_operation_contexts',entry.timing.count);}
      else dropped('dropped_operation_contexts',entry.timing.count);
    }
    for (const [key, n] of Object.entries(safe.gauges)) if (current.gauges[key] === undefined || n > current.gauges[key]) { current.gauges[key] = n; changed = true; }
    for (const [key, day] of Object.entries(safe.milestones)) if (!current.milestones[key]) {
      current.milestones[key] = day; changed = true;
      if (['first_save', 'first_export'].includes(key) && Number.isFinite(this.state.firstObservedAt) && this.now() >= this.state.firstObservedAt) current.firstSuccess[key.slice(6)] = successBucket(this.now() - this.state.firstObservedAt);
    }
    for (const entry of safe.errors) { entry.provenance=source;const existing = current.errors.find(e => e.fingerprint === entry.fingerprint&&JSON.stringify(e.provenance)===JSON.stringify(source));
      if (!entry.count) continue; changed = true;
      if (existing) { existing.count = boundedAdd(existing.count, entry.count); existing.firstAt = Math.min(existing.firstAt, entry.firstAt); existing.lastAt = Math.max(existing.lastAt, entry.lastAt); }
      else if (current.errors.length < 20) current.errors.push(entry);
      else dropped('dropped_samples', entry.count);
    }
    for (const [key, value] of Object.entries(safe.environment)) if (value !== 'unknown' && value !== current.environment[key]) { current.environment[key] = value; changed = true; }
    if(safe.performance.rows.length||safe.performance.incidents.length||Object.keys(safe.performance.coverage).length){this.schema.mergePerformance(current.performance,safe.performance,source);changed=true;}
    // Use the latest heartbeat phase, not histogram insertion order across revisited phases.
    if(this.state.consent.diagnostics&&['unknown','editing','playing','before_open','opened','stopped','closed','idle'].includes(data.resourcePhase))this.resourcePhase=data.resourcePhase;
    if (changed) {
      // A valid IPC delta must never grow the persisted cumulative report past its transport limit.
      let validated;
      try { validated = this.schema.validateSnapshot(this.schema.fitSnapshot(current)); }
      catch {
        if (this.state.consent.diagnostics) { const previous = this.state.days[today]; previous.counters.dropped_samples = boundedAdd(previous.counters.dropped_samples, 1); previous.sequence = ++this.state.sequence; this.unsaved = true; }
        return false;
      }
      validated.sequence = ++this.state.sequence; this.state.days[today] = validated;
      this.state.milestones = { ...validated.milestones }; this.state.firstSuccess = { ...validated.firstSuccess };
      this.unsaved = true;
    }
    return changed;
  }
  count(key, n = 1) { this.record({ epoch: this.epoch, data: { counters: { [key]: n } } }); }
  milestone(key) {
    if (!this.state.consent.analytics) return;
    if (key === 'first_launch' && !this.state.milestones.first_launch && !this.state.acknowledged?.milestones?.first_launch) { this.state.firstObservedAt = this.now(); this.unsaved = true; }
    this.record({ epoch: this.epoch, data: { milestones: { [key]: dayOf(this.now()) } } });
  }
  error(name, operation, counter, context = {}) { if (this.state.consent.diagnostics) { if (counter) this.count(counter); this.record({ epoch: this.epoch, data: { errors: [this.schema.sanitizeError({ name, code: context.code }, operation, this.now(), context)] } }); } }
  sampleMemory(megabytes) { if (this.state.consent.diagnostics) this.record({ epoch: this.epoch, data: { gauges: { process_memory_mb: megabytes } } }); }
  sampleResources(values,phase='unknown'){
    if(!this.state.consent.diagnostics)return;
    const performance=this.schema.emptyPerformance();
    for(const [metric,value] of Object.entries(values))this.schema.recordPerformance(performance,metric,value,{phase});
    this.record({epoch:this.epoch,data:{performance}});
  }
  persist() {
    // set() serializes synchronously, so the flag is cleared as soon as the
    // snapshot is captured; a failed write re-arms it for the next interval.
    const write = this.store.set(this.state);
    this.unsaved = false;
    write.catch(() => { this.unsaved = true; });
    return write;
  }
  preview() { return { policyVersion: this.schema.POLICY_VERSION, retentionDays: 30, consent: this.getState().consent, snapshots: Object.values(this.state.days) }; }
  async upload({ force = false } = {}) {
    if (this.inflight || !this.siteUrl || !force && this.now() < this.nextUpload) return false;
    this.inflight = true;
    try {
      for (const deletion of [...this.state.deletions]) {
        const response = await this.fetch(deletion.url + '/api/v1/telemetry', { method: 'DELETE', headers: { Authorization: 'Bearer ' + deletion.token }, signal: timeout(5000), redirect: 'error' });
        if (!response.ok) throw messageError(new Error(''), 'desktop.telemetry.errors.deletionUnavailable', {});
        this.state.deletions = this.state.deletions.filter(item => item !== deletion); await this.persist();
      }
      if (!enabled(this.state.consent)) { this.refreshStatus(); this.configureTimer(); this.notify(); return true; }
      const snapshot = Object.values(this.state.days).sort((a, b) => a.day.localeCompare(b.day))[0];
      if (!snapshot) return true;
      if (this.state.acknowledged?.day === snapshot.day && this.state.acknowledged?.sequence === snapshot.sequence) return true;
      // Idle time is carried with the next useful report; leaving the app open must not produce idle-only uploads.
      if (!force && this.state.acknowledged?.day === snapshot.day) {
        const usefulReport = value => JSON.stringify({ ...this.schema.validateSnapshot(value), sequence: 0, counters: { ...value.counters, idle_seconds: 0 } });
        if (usefulReport(this.state.acknowledged) === usefulReport(snapshot)) return true;
      }
      const epoch = this.epoch, sequence = snapshot.sequence, day = snapshot.day;
      const payload = JSON.stringify(this.schema.validateSnapshot(snapshot));
      this.controller = new AbortController(); const abortTimer = setTimeout(() => this.controller?.abort(), 5000);
      let response;
      try { response = await this.fetch(this.siteUrl + '/api/v1/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.state.token }, body: payload, signal: this.controller.signal, redirect: 'error' }); }
      finally { clearTimeout(abortTimer); this.controller = null; }
      if (epoch !== this.epoch) return false;
      if (!response.ok) { const seconds = Number(response.headers.get('Retry-After')); this.nextUpload = this.now() + Math.max(UPLOAD_INTERVAL, Number.isFinite(seconds) ? Math.min(86400, seconds) * 1000 : UPLOAD_INTERVAL); throw messageError(new Error(''), 'desktop.telemetry.errors.serviceUnavailable', {}); }
      const receipt=await response.json().catch(()=>({}));
      if(Number.isSafeInteger(receipt.diagnosticGeneration)&&receipt.diagnosticGeneration>(this.state.diagnosticGeneration||0)){
        this.state.diagnosticGeneration=receipt.diagnosticGeneration;
        for(const [key,value] of Object.entries(this.state.days))this.state.days[key]={...this.schema.clearDiagnostics(value,receipt.diagnosticGeneration),sequence:++this.state.sequence};
        this.state.acknowledged=null;this.epoch++;this.unsaved=true;
        this.lastUpload=this.now();this.nextUpload=this.now()+UPLOAD_INTERVAL;await this.persist();this.notify();return true;
      }
      if (day !== dayOf(this.now()) && this.state.days[day]?.sequence === sequence) delete this.state.days[day];
      if (day === dayOf(this.now())) this.state.acknowledged = JSON.parse(payload);
      this.lastUpload = this.now(); this.nextUpload = this.now() + UPLOAD_INTERVAL + crypto.randomInt(0, 60000); this.refreshStatus(); await this.persist(); this.notify(); return true;
    } catch { this.nextUpload = Math.max(this.nextUpload, this.now() + UPLOAD_INTERVAL); this.status = this.state.deletions.length ? 'Deletion pending; retrying when online' : 'Offline or service busy · summaries queued locally'; this.notify(); return false; }
    finally { this.inflight = false; }
  }
  async deleteData() {
    this.epoch++; this.controller?.abort();
    if (this.state.token && this.siteUrl && !this.state.deletions.some(d => d.token === this.state.token)) {
      if (this.state.deletions.length >= 4) throw messageError(new Error(''), 'desktop.telemetry.errors.completeThePendingDeletionBeforeResettingAgain', {});
      this.state.deletions.push({ token: this.state.token, url: this.siteUrl });
    }
    this.state.token = null; this.id = null; this.state.days = {}; this.state.milestones = {}; this.state.firstSuccess = {}; delete this.state.firstObservedAt; this.state.acknowledged = null; this.state.running = false;
    this.state.consent = { analytics: false, diagnostics: false, policyVersion: this.schema.POLICY_VERSION, updatedAt: this.now() }; this.state.decided = true;
    await this.persist(); this.configureTimer(); this.refreshStatus(); this.notify(); await this.upload({ force: true }); return this.getState();
  }
  async feedback(value) {
    if (!this.siteUrl) throw messageError(new Error(''), 'desktop.telemetry.errors.notConfigured', {contact:config.contact});
    if (!['bug', 'idea', 'other'].includes(value?.category) || typeof value?.message !== 'string' || value.message.trim().length < 5 || value.message.length > 2000) throw messageError(new Error(''), 'desktop.telemetry.errors.use52000CharactersForYourFeedback', {});
    // Feedback is explicitly submitted; it never enables profiling or invents an installation identifier.
    this.ensureIdentity(); await this.persist();
    const response = await this.fetch(this.siteUrl + '/api/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.state.token }, body: JSON.stringify({ id: crypto.randomUUID(), category: value.category, message: value.message.trim(), appVersion: this.version, platform: process.platform }), signal: timeout(5000), redirect: 'error' });
    if (!response.ok) throw messageError(new Error(''), 'desktop.telemetry.errors.feedbackFailed', {contact:config.contact});
    return { sent: true };
  }
  async close() { clearInterval(this.timer); this.count('sessions_closed'); this.state.running = false; await this.persist(); }
}
module.exports = { TelemetryService, endpoint };
