import {SUPPORT_CATEGORIES, SUPPORT_STATUSES, SUPPORT_PRIORITIES, supportErrorMessage, supportLiveMessageKeys} from './support-localization.mjs';
import {presentError} from './error-presentation.mjs';
import {messageError, restoreMessageError} from './localized-error.mjs';
import {replaceLocalized, messageAttributes, tupleMessages, messageTuple, translatedElement, appendLocalized, localizedMarkup, localizedText, messageHTML, localizedAttribute, clearTranslation} from './localization-bindings.mjs';
import {interfaceLocalization, t as interfaceText} from './localization.mjs';

import { SUPPORT_LIMITS, supportFileType } from './support-contract.mjs';
import { prepareSupportFile } from './support-media.mjs';
import { SupportLiveUpdates, subscribeWebSupport } from './support-live-client.mjs';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) { if (text?.messageKey) localizedText(node,text.messageKey,text.messageParams); else node.textContent = text; } if (className) node.className = className; return node; };
const optionHtml = values => Object.entries(values).map(([value,label]) => `<option value="${value}"${label?.messageKey ? ' '+messageAttributes(label.messageKey,label.messageParams) : ''}>${label?.messageKey ? interfaceText(label.messageKey,label.messageParams) : label}</option>`).join('');
const formatBytes = value => value >= 1024 * 1024 ? `${interfaceLocalization.formatNumber(value / 1024 / 1024,{minimumFractionDigits:1,maximumFractionDigits:1})} MB` : `${interfaceLocalization.formatNumber(Math.ceil(value / 1024))} KB`;
const dateValue = (value, withTime = false) => ({format:'date',value,options:{month:'short',day:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})}});
const date = value => messageHTML('supportMessages.date',{date:dateValue(value)});
const byteValue = value => ({messageKey:value>=1024*1024?'supportMessages.megabytes':'supportMessages.kilobytes',messageParams:{size:{format:'number',value:value>=1024*1024?value/1024/1024:Math.ceil(value/1024),options:value>=1024*1024?{minimumFractionDigits:1,maximumFractionDigits:1}:{}}}});

const saveBlob = (blob, name) => { const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = name; appendLocalized(document.body, a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
function button(text, handler, className = '') { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', handler); return node; }
const statusLabel = (status, admin = false) => admin && status === 'waiting' ? {messageKey:'supportCenter.waitingForCreator'} : SUPPORT_STATUSES[status] || status;
function pill(status, admin = false) { const node = el('span', statusLabel(status, admin), 'sc-pill'); node.dataset.status = status; return node; }

/** One view and contract for the website, private moderation inbox, and Electron. */
export class SupportCenter {
  constructor(root, { api, admin = false, context = {}, copyAccess, restoreAccess, storageKey = 'styk-support-drafts', storage = null, downloadFile, onThreadOpen, subscribeLive } = {}) {
    Object.assign(this, { root, api, admin, context, copyAccess, restoreAccess, storageKey, storage, downloadFile, onThreadOpen });
    this.busy = false; this.thread = null; this.items = []; this.messages = new Map(); this.attachments = []; this.drafts = {}; this.previews = new Set(); this.generation = 0; this.lastActivity = Date.now(); this.active = true;
    try { this.drafts = JSON.parse(storage?.getItem(storageKey) || '{}'); } catch { /* Storage can be disabled. */ }
    this.mount();
    this.onActivity = () => { this.lastActivity = Date.now(); };
    this.live = new SupportLiveUpdates({ subscribe: subscribeLive || ((id, event) => subscribeWebSupport(this.api, id, event)), changed: () => { this.liveDirty = true; this.flushLive(); }, status: value => { const node = this.$('.sc-live'); if (node) localizedText(node,supportLiveMessageKeys[value]); } });
    this.onVisibility = () => this.schedule();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('focus', this.onVisibility);
    root.addEventListener('pointerdown', this.onActivity); root.addEventListener('keydown', this.onActivity);
    this.beforeUnload = event => { if (this.busy || this.pendingFiles.length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', this.beforeUnload);
  }
  $(selector) { return this.root.querySelector(selector); }
  /** Files are bound to the send they were queued with: a failed upload retries
   * its own list, never whatever happens to be selected in the form later. */
  get pendingFiles() { return this.pendingCreation?.queue ?? this.pendingMessage?.queue ?? (this.files ??= []); }
  mount() {
    this.root.classList.add('support-center');
    if (this.admin) { this.root.classList.add('sc-admin'); this.root.dataset.view = 'inbox'; this.mountAdmin(); return; }
    this.root.dataset.view = 'create';
    localizedMarkup(this.root, `<div class="sc-top"><nav class="sc-tabs" aria-label="Feedback" data-top-actions data-i18n-aria-label="supportCenter.feedback"></nav><details class="sc-access"><summary data-i18n="supportCenter.inboxAccess">${messageHTML("supportCenter.inboxAccess", {})}</summary><div class="sc-access-actions"></div></details></div>
      <div class="sc-notice" role="status" aria-live="polite" hidden></div><div data-recovery hidden></div>
      <div class="sc-grid"><aside class="sc-inbox"><div class="sc-inbox-header"><strong data-i18n="supportCenter.myReports">${messageHTML("supportCenter.myReports", {})}</strong><button type="button" class="sc-refresh" data-refresh data-i18n="supportCenter.refresh">${messageHTML("supportCenter.refresh", {})}</button></div><div data-filters></div><div class="sc-list" aria-label="Report conversations" data-i18n-aria-label="supportCenter.reportConversations"></div><button type="button" class="sc-load" data-more hidden data-i18n="supportCenter.loadMoreReports">${messageHTML("supportCenter.loadMoreReports", {})}</button></aside><div class="sc-body" data-body></div></div><div data-capacity></div>`);
    this.$('[data-refresh]').onclick = () => void this.refresh();
    this.$('[data-more]').onclick = () => void this.loadList(true);
    const create = translatedElement(button(interfaceText("supportCenter.newReport"), () => this.showCreate()), "supportCenter.newReport", {}); create.dataset.navCreate = '';
    const inbox = translatedElement(button(interfaceText("supportCenter.myReports"), () => this.showInbox()), "supportCenter.myReports", {}); inbox.dataset.navInbox = '';
    appendLocalized(this.$('[data-top-actions]'), create, inbox);
    if (this.copyAccess) appendLocalized(this.$('.sc-access-actions'), translatedElement(button(interfaceText("supportCenter.savePrivateAccessLink"), () => void this.accessPanel()), "supportCenter.savePrivateAccessLink", {}));
    if (this.restoreAccess) appendLocalized(this.$('.sc-access-actions'), translatedElement(button(interfaceText("supportCenter.openAnExistingInbox"), () => this.restorePanel()), "supportCenter.openAnExistingInbox", {}));
    if (this.context.source === 'desktop') { localizedText(this.$('.sc-access>summary'), "supportCenter.otherDevices", {}); localizedText(this.$('.sc-access-actions button'), "supportCenter.copyAccessLink", {}); }
  }
  /** Moderation workspace: queue rail, conversation list, and the open report with its properties. */
  mountAdmin() {
    localizedMarkup(this.root, `<div class="sc-notice" role="status" aria-live="polite" hidden></div><div data-recovery hidden></div>
      <div class="sc-workspace"><aside class="sc-nav" aria-label="Report queues and filters" data-i18n-aria-label="supportCenter.reportQueuesAndFilters"><div class="sc-layout" role="group" aria-label="Layout" data-i18n-aria-label="supportCenter.layout"><button type="button" data-layout="list" aria-pressed="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>${messageHTML("supportCenter.list", {})}</button><button type="button" data-layout="board" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="5" height="16" rx="1.2"/><rect x="9.5" y="4" width="5" height="10" rx="1.2"/><rect x="15.5" y="4" width="5" height="13" rx="1.2"/></svg>${messageHTML("supportCenter.board", {})}</button></div><div class="sc-nav-section"><h3 data-i18n="supportCenter.queues">${messageHTML("supportCenter.queues", {})}</h3><nav class="sc-queues" aria-label="Report queues" data-i18n-aria-label="supportCenter.reportQueues"></nav></div><div class="sc-nav-section" data-filters></div><div class="sc-nav-foot" data-capacity></div></aside>
      <div class="sc-grid"><aside class="sc-inbox"><div class="sc-inbox-header"><strong data-i18n="supportCenter.inbox">${messageHTML("supportCenter.inbox", {})}</strong><span class="sc-inbox-count" data-count hidden></span><button type="button" class="sc-refresh" data-refresh title="Refresh inbox" aria-label="Refresh inbox" data-i18n-title="supportCenter.refreshInbox" data-i18n-aria-label="supportCenter.refreshInbox"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg></button></div><div data-search></div><div class="sc-list" aria-label="Report conversations" data-i18n-aria-label="supportCenter.reportConversations"></div><button type="button" class="sc-load" data-more hidden data-i18n="supportCenter.loadMoreReports">${messageHTML("supportCenter.loadMoreReports", {})}</button></aside><div class="sc-body" data-body></div></div>
      <section class="sc-board" aria-label="Report board" hidden data-i18n-aria-label="supportCenter.reportBoard"></section></div>`);
    this.$('[data-refresh]').onclick = () => void this.refresh();
    this.$('[data-more]').onclick = () => void this.loadList(true);
    this.root.querySelectorAll('[data-layout]').forEach(node => node.onclick = () => void this.setLayout(node.dataset.layout));
    this.filters();
    this.layout = 'list'; this.boardItems = [];
    let saved = null; try { saved = localStorage.getItem('styk-admin-layout'); } catch { /* Layout preference is optional. */ }
    if (saved === 'board') this.pendingLayout = 'board';
  }
  /** Board view: one column per status, cards move by drag or by the accessible status control. */
  static get BOARD_COLUMNS() { return [messageTuple(['new', interfaceText("common.new")], {1: {key: "common.new", params: {}}}), messageTuple(['triaged', interfaceText("supportCenter.underReview")], {1: {key: "supportCenter.underReview", params: {}}}), messageTuple(['waiting', interfaceText("supportCenter.waitingForCreator")], {1: {key: "supportCenter.waitingForCreator", params: {}}}), messageTuple(['in_progress', interfaceText("supportCenter.inProgress")], {1: {key: "supportCenter.inProgress", params: {}}}), messageTuple(['resolved', interfaceText("supportCenter.resolved")], {1: {key: "supportCenter.resolved", params: {}}}), messageTuple(['closed', interfaceText("supportCenter.closed")], {1: {key: "supportCenter.closed", params: {}}})]; }
  async setLayout(layout) {
    if (!this.admin || this.layout === layout) return;
    this.hideCardPreview();
    if (layout === 'board' && (this.busy || this.pendingFiles.length || this.pendingMessage)) { this.notice({messageKey:"supportCenter.finishSendingOrRemoveSelectedFilesBeforeSwitching",messageParams:{}}); return; }
    this.layout = layout; this.root.dataset.layout = layout;
    try { localStorage.setItem('styk-admin-layout', layout); } catch { /* Preference stays in memory. */ }
    this.root.querySelectorAll('[data-layout]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.layout === layout)));
    const statusFilter = this.root.querySelector('[data-filters] [name=status]'); if (statusFilter) statusFilter.disabled = layout === 'board';
    this.$('.sc-grid').hidden = layout === 'board'; this.$('.sc-board').hidden = layout !== 'board';
    if (layout === 'board') { if (this.thread) { this.resetDetail(); this.thread = null; this.emptyDetail(); this.setView('inbox'); this.renderList(); } await this.loadBoard(); }
    else this.schedule();
  }
  async loadBoard() {
    if (this.boardBusy) return; this.boardBusy = true;
    const board = this.$('.sc-board'); board.setAttribute('aria-busy', 'true');
    try {
      const query = new URLSearchParams(this.query || {}); query.delete('status');
      const items = []; let cursor = null, pages = 0;
      // A bounded number of ordinary list pages; the board is a view of the same list, not a new query budget.
      do { if (cursor) query.set('cursor', cursor); const result = await this.api('/threads?' + query); if (this.disposed) return; items.push(...result.threads); cursor = result.nextCursor; pages++; } while (cursor && pages < 4);
      this.boardItems = items.filter((item, i, rows) => rows.findIndex(r => r.id === item.id) === i); this.boardTruncated = Boolean(cursor);
      this.renderBoard();
    } catch (error) { this.notice(supportErrorMessage(error), true); }
    finally { this.boardBusy = false; board.removeAttribute('aria-busy'); }
  }
  renderBoard() {
    this.hideCardPreview();
    const board = this.$('.sc-board'); if (!board) return; replaceLocalized(board);
    const today = new Date().toISOString().slice(0, 10), columns = el('div', null, 'sc-board-columns');
    for (const tuple of SupportCenter.BOARD_COLUMNS) {
      const [status,name]=tuple, caption={messageKey:tupleMessages(tuple)[1].key};
      const rows = this.boardItems.filter(row => status === 'closed' ? ['closed', 'spam'].includes(row.status) : row.status === status);
      const column = el('section', null, 'sc-column'); column.dataset.status = status; localizedAttribute(column, 'aria-label', "supportCenter.reports", {name: caption, length: rows.length});
      const head = el('header', null, 'sc-column-head'); appendLocalized(head, el('h3',caption),el('span',{messageKey:'supportMessages.count',messageParams:{count:rows.length}},'sc-column-count')); appendLocalized(column, head);
      const body = el('div', null, 'sc-column-body'); appendLocalized(column, body);
      if (!rows.length) appendLocalized(body, translatedElement(el('p', {messageKey:"supportCenter.nothingHere",messageParams:{}}, 'sc-column-empty'), "supportCenter.nothingHere", {}));
      for (const row of rows) appendLocalized(body, this.boardCard(row, today));
      column.ondragover = event => { if (!this.dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; column.classList.add('sc-drop'); };
      column.ondragleave = event => { if (!column.contains(event.relatedTarget)) column.classList.remove('sc-drop'); };
      column.ondrop = event => { event.preventDefault(); column.classList.remove('sc-drop'); const id = this.dragging || event.dataTransfer.getData('text/plain'); this.dragging = null; if (id) void this.moveCard(id, status); };
      appendLocalized(columns, column);
    }
    appendLocalized(board, columns);
    if (this.boardTruncated) appendLocalized(board, el('p', {messageKey:'supportMessages.latestReports',messageParams:{count:this.boardItems.length}}, 'sc-small sc-board-note'));
  }
  boardCard(row, today) {
    const card = el('article', null, 'sc-card'); card.dataset.id = row.id; card.draggable = true;
    if (row.unread) card.classList.add('sc-unread');
    card.dataset.priority = row.priority || 'normal';
    const priority = el('span', SUPPORT_PRIORITIES[card.dataset.priority], 'sc-priority sc-card-priority'); priority.dataset.priority = card.dataset.priority;
    localizedAttribute(priority, 'aria-label', "supportCenter.priority", {textContent: SUPPORT_PRIORITIES[card.dataset.priority]});
    const open = button(row.title, () => { void this.setLayout('list').then(() => this.openThread(row.id)); }, 'sc-card-title'); if (row.unread) { const dot = el('i', null, 'sc-dot'); localizedAttribute(dot, 'aria-label', "supportCenter.unreadReply", {}); open.prepend(dot); }
    const meta = el('div', null, 'sc-card-meta'); appendLocalized(meta, el('span', SUPPORT_CATEGORIES[row.category]), el('span', row.displayName || {messageKey:"supportCenter.creator",messageParams:{}}), el('time',{messageKey:'supportMessages.date',messageParams:{date:dateValue(row.createdAt)}}));
    const tags = el('div', null, 'sc-card-tags');
    if (row.status === 'spam') appendLocalized(tags, pill('spam', true));
    if (row.followUp) { const due = el('span', {messageKey:'supportMessages.followUp',messageParams:{date:dateValue(row.followUp+'T00:00:00')}}, 'sc-item-followup'); if (row.followUp <= today) due.dataset.due = ''; appendLocalized(tags, due); }
    if (row.assigned) appendLocalized(tags, translatedElement(el('span', {messageKey:"supportCenter.me",messageParams:{}}, 'sc-item-assignee'), "supportCenter.me", {}));
    if (row.tags) for (const tag of row.tags.split(',').map(value => value.trim()).filter(Boolean).slice(0, 3)) appendLocalized(tags, el('span', tag, 'sc-card-tag'));
    const move = el('select', null, 'sc-card-move'); localizedAttribute(move, 'aria-label', "supportCenter.moveTo", {title: row.title}); localizedMarkup(move, optionHtml({ ...SUPPORT_STATUSES, waiting: {messageKey:'supportCenter.waitingForCreator'} })); move.value = row.status;
    move.onchange = () => void this.moveCard(row.id, move.value);
    appendLocalized(card, priority, open, meta, tags, move);
    const preview = () => { clearTimeout(this.previewTimer); this.previewTimer = setTimeout(() => this.showCardPreview(card, open, row), 250); };
    card.onpointerenter = event => { if (event.pointerType !== 'touch') preview(); };
    card.onpointerleave = () => this.deferHideCardPreview();
    open.onfocus = preview;
    open.onblur = () => this.deferHideCardPreview();
    card.onpointerdown = () => this.hideCardPreview();
    card.ondragstart = event => { this.hideCardPreview(); this.dragging = row.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.id); card.classList.add('sc-dragging'); };
    card.ondragend = () => { this.dragging = null; card.classList.remove('sc-dragging'); this.root.querySelectorAll('.sc-drop').forEach(node => node.classList.remove('sc-drop')); };
    return card;
  }
  deferHideCardPreview() {
    clearTimeout(this.previewTimer); clearTimeout(this.previewHideTimer);
    this.previewHideTimer = setTimeout(() => this.hideCardPreview(), 180);
  }
  hideCardPreview() {
    clearTimeout(this.previewTimer); clearTimeout(this.previewHideTimer);
    this.previewAnchor?.removeAttribute('aria-describedby'); this.previewAnchor = null;
    this.cardPreview?.remove(); this.cardPreview = null;
    document.removeEventListener('keydown', this.previewKey);
    document.removeEventListener('scroll', this.previewScroll, true);
    window.removeEventListener('resize', this.previewResize);
  }
  showCardPreview(card, anchor, row) {
    this.hideCardPreview();
    if (!row.description || !card.isConnected || this.dragging || this.disposed || !this.active || this.layout !== 'board') return;
    const preview = el('div', row.description, 'sc-card-preview');
    preview.id = `sc-preview-${row.id}`; preview.setAttribute('role', 'tooltip'); preview.setAttribute('popover', 'manual');
    this.cardPreview = preview; this.previewAnchor = anchor;
    appendLocalized(this.root, preview); preview.showPopover(); anchor.setAttribute('aria-describedby', preview.id);
    const rect = card.getBoundingClientRect(), box = preview.getBoundingClientRect(), gap = 8;
    let left = rect.right + gap;
    if (left + box.width > innerWidth - gap) left = rect.left - box.width - gap;
    preview.style.left = `${Math.max(gap, Math.min(left, innerWidth - box.width - gap))}px`;
    preview.style.top = `${Math.max(gap, Math.min(rect.top, innerHeight - box.height - gap))}px`;
    preview.onpointerenter = () => clearTimeout(this.previewHideTimer);
    preview.onpointerleave = () => this.deferHideCardPreview();
    this.previewKey = event => { if (event.key === 'Escape') this.hideCardPreview(); };
    this.previewScroll = event => { if (!preview.contains(event.target)) this.hideCardPreview(); };
    this.previewResize = () => this.hideCardPreview();
    document.addEventListener('keydown', this.previewKey);
    document.addEventListener('scroll', this.previewScroll, true);
    window.addEventListener('resize', this.previewResize);
  }
  async moveCard(id, status) {
    const row = this.boardItems.find(item => item.id === id); if (!row || row.status === status || this.boardBusy) return;
    const previous = row.status; row.status = status; this.renderBoard();
    try {
      await this.api(`/threads/${id}`, { method: "PATCH", body: { status, priority: row.priority || 'normal', tags: row.tags || '', assigned: Boolean(row.assigned), followUp: row.followUp || '', duplicateOf: row.duplicateOf || '', version: Number(row.version) } });
      this.notice({messageKey:'supportCenter.movedTitleToValue1',messageParams:{title: row.title, value1: status === 'waiting' ? {messageKey: "supportCenter.waitingForCreator"} : SUPPORT_STATUSES[status]}});
      await this.loadBoard();
    } catch (error) { row.status = previous; this.renderBoard(); this.notice(supportErrorMessage(error), true); if (error.code === 'stale_report') await this.loadBoard(); }
  }
  setView(view) {
    this.root.dataset.view = view;
    this.$('[data-nav-create]')?.setAttribute('aria-current', view === 'create' ? 'page' : 'false');
    this.$('[data-nav-inbox]')?.setAttribute('aria-current', view !== 'create' ? 'page' : 'false');
  }
  showInbox() {
    if (this.busy || this.pendingFiles.length || this.pendingCreation || this.pendingMessage) { this.notice({messageKey:"supportCenter.finishSendingOrRemoveSelectedFilesBeforeSwitching2",messageParams:{}}); return; }
    this.resetDetail(); this.thread = null; this.setView('inbox'); if (this.admin) this.emptyDetail(); this.renderList(); void this.loadList();
  }
  async start() {
    try {
      const config = await this.api('/config'); if (this.disposed) return this; this.config = config;
      if (config.paused) this.notice({messageKey:"supportCenter.newReportsAreTemporarilyPausedExistingConversationsAre",messageParams:{}});
      if (this.admin) { this.emptyDetail(); await this.loadCapacity(); } else this.showCreate();
      if (this.admin && this.pendingLayout === 'board') { this.pendingLayout = null; await this.setLayout('board'); } else await this.loadList();
      if (!this.admin && this.items.length && !this.drafts.create?.title && !this.drafts.create?.description) this.setView('inbox');
    } catch (error) { if (this.disposed) return this; this.notice(supportErrorMessage(error), true); if (!this.admin && !this.$('form')) this.showCreate(); }
    this.schedule();
    return this;
  }
  notice(message, error = false) { const node = this.$('.sc-notice'); if (this.disposed || !node) return; presentError(node,message); node.hidden = !message; node.setAttribute('role', error ? 'alert' : 'status'); }
  saveDraft(key, data) {
    this.drafts[key] = data;
    // Bound browser storage and never persist File objects or admin notes.
    const entries = Object.entries(this.drafts).slice(-12); this.drafts = Object.fromEntries(entries);
    try { this.storage?.setItem(this.storageKey, JSON.stringify(this.drafts)); } catch { /* The in-memory draft remains. */ }
  }
  remember() {
    const form = this.$('[data-create]');
    if (form) { const draft = {}; for (const [key, value] of new FormData(form)) if (typeof value === 'string') draft[key] = value; draft.requestId = this.createId; this.saveDraft('create', draft); }
    const reply = this.$('[data-reply]'); if (reply && this.thread) this.saveDraft(this.thread.id, { message: reply.elements.message.value, requestId: this.replyId });
  }
  resetDetail(remember = true) {
    this.live?.stop(); this.liveDirty = false;
    if (remember) this.remember(); this.generation++; this.files = []; this.pendingMessage = null; this.pendingCreation = null; this.messages.clear();
    for (const url of this.previews) URL.revokeObjectURL(url); this.previews.clear();
    replaceLocalized(this.$('[data-body]'));
    delete this.$('[data-body]').dataset.threadView;
  }
  showCreate(category) {
    if (this.busy) { this.notice({messageKey:"supportCenter.pleaseWaitForTheCurrentSendToFinish",messageParams:{}}); return; }
    if (this.pendingCreation) { this.notice({messageKey:"supportCenter.retryTheRemainingAttachmentsOrContinueToThe",messageParams:{}}); return; }
    if (this.pendingFiles.length) { this.notice({messageKey:"supportCenter.sendOrRemoveTheSelectedFilesBeforeSwitching",messageParams:{}}); return; }
    this.resetDetail(); this.thread = null; this.setView('create'); this.renderList();
    const draft = this.drafts.create || {}; this.createId = draft.requestId || crypto.randomUUID();
    const box = this.$('[data-body]');
    localizedMarkup(box, `<form data-create novalidate><div class="sc-steps" aria-label="Report steps" data-i18n-aria-label="supportCenter.reportSteps"><button type="button" data-step-nav="1">1 <span data-i18n="supportCenter.report">${messageHTML("supportCenter.report", {})}</span></button><span class="sc-step-line"></span><button type="button" data-step-nav="2">2 <span data-i18n="supportCenter.details">${messageHTML("supportCenter.details", {})}</span></button></div>
      <div class="sc-fields" data-step="1">
      <label class="sc-full">${messageHTML("supportCenter.reportType", {})}<select name="category">${optionHtml(SUPPORT_CATEGORIES)}</select></label>
      <label class="sc-full">${messageHTML("supportCenter.title", {})}<input name="title" required minlength="5" maxlength="120" placeholder="A short summary" data-i18n-placeholder="supportCenter.aShortSummary"></label>
      <label class="sc-full">${messageHTML("supportCenter.description", {})}<textarea name="description" required minlength="10" maxlength="4000" placeholder="What happened, or what would you like to change?" data-i18n-placeholder="supportCenter.whatHappenedOrWhatWouldYouLikeTo"></textarea></label></div>
      <div class="sc-fields" data-step="2" hidden>
      <label class="sc-full" data-bug>${messageHTML("supportCenter.stepsToReproduce", {})}<textarea name="steps" maxlength="2000" placeholder="1. Open a project&#10;2. …" data-i18n-placeholder="supportCenter.message1OpenAProject102"></textarea></label>
      <label class="sc-full" data-bug>${messageHTML("supportCenter.expectedResult", {})}<textarea name="expected" maxlength="1000" placeholder="What should have happened?" data-i18n-placeholder="supportCenter.whatShouldHaveHappened"></textarea></label>
      <details class="sc-extra sc-full"><summary>${messageHTML("supportCenter.additionalDetails", {})}<span data-i18n="supportCenter.optional">${messageHTML("supportCenter.optional", {})}</span></summary><div class="sc-fields">
      <label>${messageHTML("supportCenter.yourName", {})}<input name="displayName" maxlength="50" autocomplete="nickname"></label>
      <label data-bug>${messageHTML("supportCenter.frequency", {})}<select name="frequency"><option value="" data-i18n="supportCenter.notSure">${messageHTML("supportCenter.notSure", {})}</option><option value="Every time" data-i18n="supportCenter.everyTime">${messageHTML("supportCenter.everyTime", {})}</option><option value="Sometimes" data-i18n="supportCenter.sometimes">${messageHTML("supportCenter.sometimes", {})}</option><option value="Only once" data-i18n="supportCenter.onlyOnce">${messageHTML("supportCenter.onlyOnce", {})}</option></select></label>
      <label>${messageHTML("supportCenter.appVersion", {})}<input name="version" maxlength="40" placeholder="e.g. 1.0.5" data-i18n-placeholder="supportCenter.eG105"></label><label>${messageHTML("supportCenter.operatingSystem", {})}<input name="platform" maxlength="80" placeholder="e.g. Windows 11" data-i18n-placeholder="supportCenter.eGWindows11"></label>
      <label class="sc-full" data-bug>${messageHTML("supportCenter.actualResult", {})}<textarea name="actual" maxlength="1000"></textarea></label></div></details></div>
      <div class="sc-full sc-create-files" data-file-mount></div>
      <footer class="sc-form-footer"><span class="sc-small" data-i18n="supportCenter.privateOnlyYouAndTheDeveloper">${messageHTML("supportCenter.privateOnlyYouAndTheDeveloper", {})}</span><div class="sc-actions"><button type="button" data-back hidden data-i18n="supportCenter.back">${messageHTML("supportCenter.back", {})}</button><button type="button" class="sc-primary" data-next data-i18n="supportCenter.continue">${messageHTML("supportCenter.continue", {})}</button><button type="submit" class="sc-primary" hidden data-i18n="supportCenter.sendReport">${messageHTML("supportCenter.sendReport", {})}</button></div></footer>
      <details class="sc-retention"><summary data-i18n="supportCenter.privacyLimits">${messageHTML("supportCenter.privacyLimits", {})}</summary><p data-i18n="supportCenter.reportsExpireAfter90DaysFilesAfter30">${messageHTML("supportCenter.reportsExpireAfter90DaysFilesAfter30", {})}</p></details></form>`);
    const form = this.$('[data-create]');
    for (const [name, value] of Object.entries({ version: this.context.version || '', platform: this.context.platform || '', ...draft })) if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
    if (category && Object.hasOwn(SUPPORT_CATEGORIES, category)) form.elements.category.value = category;
    const update = () => { const bug = ['bug', 'performance'].includes(form.elements.category.value); this.root.querySelectorAll('[data-bug]').forEach(node => node.hidden = !bug); form.elements.steps.required = bug; form.elements.expected.required = bug; };
    update(); form.elements.category.onchange = update; form.addEventListener('input', () => this.remember());
    this.filePicker(this.$('[data-file-mount]'));
    if (this.config?.paused) { form.querySelector('[type=submit]').disabled = true; }
    this.formStep = 1;
    const changeStep = (step, validate = true) => {
      if (this.busy || this.pendingCreation) return;
      if (step === 2 && validate) { const invalid = [...form.querySelectorAll('[data-step="1"] input,[data-step="1"] textarea')].find(node => !node.checkValidity()); if (invalid) { invalid.reportValidity(); return; } }
      this.formStep = step;
      for (const node of form.querySelectorAll('[data-step]')) node.hidden = Number(node.dataset.step) !== step;
      for (const node of form.querySelectorAll('[data-step-nav]')) node.setAttribute('aria-current', Number(node.dataset.stepNav) === step ? 'step' : 'false');
      form.querySelector('[data-back]').hidden = step === 1; form.querySelector('[data-next]').hidden = step === 2; form.querySelector('[type=submit]').hidden = step === 1;
    };
    form.querySelector('[data-next]').onclick = () => changeStep(2); form.querySelector('[data-back]').onclick = () => changeStep(1);
    form.querySelectorAll('[data-step-nav]').forEach(node => node.onclick = () => changeStep(Number(node.dataset.stepNav)));
    changeStep(1, false);
    form.onsubmit = event => {
      event.preventDefault(); if (this.formStep === 1) { changeStep(2); return; }
      const invalid = [...form.elements].find(node => node.willValidate && !node.checkValidity());
      if (invalid) { changeStep(Number(invalid.closest('[data-step]').dataset.step), false); const details = invalid.closest('details'); if (details) details.open = true; invalid.reportValidity(); return; }
      void this.createReport(form);
    };
  }
  filePicker(mount) {
    localizedMarkup(mount, `<label class="sc-file-zone"><span class="sc-upload-button"><span aria-hidden="true">＋</span>${messageHTML("supportCenter.addImagesVideosOrProjects", {})}</span><p data-i18n="supportCenter.dropFilesOrBrowse6Files24Mb">${messageHTML("supportCenter.dropFilesOrBrowse6Files24Mb", {})}</p><input type="file" multiple accept=".png,.jpg,.jpeg,.webp,.mp4,.webm,.styk" aria-label="Attach images, videos or .styk projects" data-i18n-aria-label="supportCenter.attachImagesVideosOrStykProjects"></label><div class="sc-preparing" role="status" hidden></div><div class="sc-files" data-pending-files></div>`);
    const input = mount.querySelector('input'), zone = mount.querySelector('label');
    if (this.config && !this.config.attachments) { input.disabled = true; localizedText(zone.querySelector('p'), "supportCenter.attachmentsAreTemporarilyUnavailableYouCanStillSend", {}); }
    input.onchange = () => { this.addFiles([...input.files]); input.value = ''; };
    zone.ondragover = event => { event.preventDefault(); if (!this.busy) zone.classList.add('sc-drag'); };
    zone.ondragleave = () => zone.classList.remove('sc-drag');
    zone.ondrop = event => { event.preventDefault(); zone.classList.remove('sc-drag'); this.addFiles([...event.dataTransfer.files]); };
    this.renderPendingFiles();
  }
  async addFiles(files) {
    if (this.busy || (this.config && !this.config.attachments) || (!this.admin && ['closed', 'spam'].includes(this.thread?.status))) return;
    if (this.pendingCreation || this.pendingMessage) { this.notice({messageKey:"supportCenter.finishOrCancelTheCurrentSendBeforeAdding",messageParams:{}}, true); return; }
    const pending = this.pendingFiles, current = this.thread?.fileCount || 0, used = this.thread?.fileBytes || 0;
    this.setBusy(true,{messageKey:'supportCenter.preparingFiles'}); this.preparing = new AbortController();
    const status = this.$('.sc-preparing'), label = el('span'); status.hidden = false;
    replaceLocalized(status, label, translatedElement(button(interfaceText("common.cancel"), () => this.preparing?.abort()), "common.cancel", {}));
    try {
      for (const original of files.slice(0, 6)) {
        if (current + pending.length >= 6) { this.notice({messageKey:"supportCenter.aConversationCanHoldUpTo6Files",messageParams:{}}, true); break; }
        try {
          localizedText(label, "supportCenter.preparing", {name: original.name});
          const file = await prepareSupportFile(original, { signal: this.preparing.signal, progress: percent => { localizedText(label, "supportCenter.compressing", {name: original.name, percent: percent}); } });
          if (used + pending.reduce((n, f) => n + f.file.size, 0) + file.size > SUPPORT_LIMITS.threadFileBytes) { this.notice({messageKey:"supportCenter.aConversationCanHoldUpTo6Files2",messageParams:{}}, true); break; }
          pending.push({ file, id: crypto.randomUUID(), originalBytes: original.size });
          this.renderPendingFiles();
        } catch (error) { if (error.name === 'AbortError') break; this.notice(supportErrorMessage(error), true); }
      }
    } finally { status.hidden = true; this.preparing = null; this.setBusy(false); }
  }
  renderPendingFiles() {
    const mount = this.$('[data-pending-files]'); if (!mount) return;
    for (const media of mount.querySelectorAll('[src]')) { URL.revokeObjectURL(media.src); this.previews.delete(media.src); } replaceLocalized(mount);
    this.pendingFiles.forEach((entry, index) => {
      const node = el('div', null, 'sc-file sc-attachment-card'), mime = supportFileType(entry.file.name);
      if (mime?.startsWith('image/') || mime?.startsWith('video/')) appendLocalized(node, this.mediaPreview(entry.file, mime, entry.file.name));
      else appendLocalized(node, translatedElement(el('div', {messageKey:"supportCenter.styk",messageParams:{}}, 'sc-project-preview'), "supportCenter.styk", {}));
      appendLocalized(node, el('span', entry.file.name, 'sc-file-name'), el('span', {messageKey:entry.originalBytes>entry.file.size?'supportMessages.compressedSize':'supportMessages.fileSize',messageParams:{size:byteValue(entry.file.size),percent:Math.round((1-entry.file.size/entry.originalBytes)*100)}}, 'sc-small'));
      const remove = button('×', () => { if (!this.busy) { this.pendingFiles.splice(index, 1); this.renderPendingFiles(); } }); localizedAttribute(remove, 'aria-label', "supportCenter.remove", {name: entry.file.name}); appendLocalized(node, remove); appendLocalized(mount, node);
    });
  }
  mediaPreview(blob, mime, name) {
    const video = mime.startsWith('video/'), media = el(video ? 'video' : 'img', null, 'sc-preview');
    if (video) { media.controls = true; media.preload = 'metadata'; media.playsInline = true; media.setAttribute('aria-label', name); }
    else media.alt = name;
    const url = URL.createObjectURL(blob); this.previews.add(url); media.src = url; return media;
  }
  setBusy(value,label={messageKey:'supportCenter.sending'}) {
    this.busy = value; this.root.setAttribute('aria-busy', String(value));
    this.root.querySelectorAll('[data-body] input,[data-body] select,[data-body] textarea,[data-body] button').forEach(node => node.disabled = value);
    const submit = this.$('[data-create] [type=submit]') || this.$('[data-reply] [type=submit]');
    if (submit) {
      if (value) {
        submit.dataset.previous=submit.textContent;submit.dataset.previousKey=submit.getAttribute('data-i18n')||'';
        presentError(submit,label);
      } else if (submit.dataset.previousKey) localizedText(submit,submit.dataset.previousKey);
      else {clearTranslation(submit);submit.textContent=submit.dataset.previous||interfaceText('supportCenter.sendMessage');}
    }
    if (!value) { this.syncComposerState(); this.flushLive(); }
  }
  async uploadPending(threadId, messageId, queue = this.files) {
    while (queue.length) {
      const entry = queue[0]; this.notice({messageKey:'supportCenter.uploadingName',messageParams:{name: entry.file.name}});
      await this.api(`/threads/${threadId}/files?message=${messageId}&upload=${entry.id}`, { method: "POST", body: entry.file, headers: { 'X-File-Name': encodeURIComponent(entry.file.name), 'Content-Type': 'application/octet-stream' } });
      queue.shift(); this.renderPendingFiles();
    }
  }
  async createReport(form) {
    if (this.busy || !form.reportValidity()) return;
    this.remember(); const payload = Object.fromEntries(new FormData(form)); payload.requestId = this.createId; payload.source = this.context.source || 'website';
    this.setBusy(true); let created;
    try {
      created = this.pendingCreation || await this.api('/threads', { method: "POST", body: payload });
      if (!this.pendingCreation) created.queue = this.files; this.pendingCreation = created; this.files = [];
      await this.uploadPending(created.id, created.messageId, created.queue);
      this.pendingCreation = null; this.saveDraft('create', {}); this.createId = crypto.randomUUID(); form.reset(); this.setBusy(false);
      await this.loadList(); await this.openThread(created.id); this.notice({messageKey:"supportCenter.reportSentRepliesWillAppearHere",messageParams:{}});
    } catch (error) {
      this.notice(created ? {messageKey:'supportCenter.yourReportWasSentButAFileCouldNot',messageParams:{value: supportErrorMessage(error)}} : supportErrorMessage(error), true);
      if (created) {
        const actions = el('div', null, 'sc-actions'); actions.dataset.retry = '';
        appendLocalized(actions, translatedElement(button(interfaceText("supportCenter.continueToConversation"), async () => { this.pendingCreation = null; this.files = []; form.reset(); this.saveDraft('create', {}); await this.loadList(); await this.openThread(created.id); }), "supportCenter.continueToConversation", {}));
        this.$('[data-retry]')?.remove(); appendLocalized(form, actions);
      }
    } finally { this.setBusy(false); if (this.pendingCreation) { localizedText(form.querySelector('[type=submit]'), "supportCenter.retryAttachments", {}); for (const node of form.querySelectorAll('input:not([type=file]),textarea')) node.readOnly = true; const fileInput = form.querySelector('[type=file]'); if (fileInput) fileInput.disabled = true; } }
  }
  async loadList(append = false) {
    if (this.listBusy) return; this.listBusy = true;
    const query = new URLSearchParams(this.query || {}); if (append && this.nextCursor) query.set('cursor', this.nextCursor);
    try { const result = await this.api('/threads?' + query); if (this.disposed) return; this.items = append ? [...this.items, ...result.threads].filter((item, i, rows) => rows.findIndex(r => r.id === item.id) === i) : result.threads; this.nextCursor = result.nextCursor; this.renderList(); }
    catch (error) { this.notice(supportErrorMessage(error), true); }
    finally { this.listBusy = false; }
  }
  renderList() {
    const list = this.$('.sc-list'); replaceLocalized(list);
    if (!this.items.length) { const empty = el('div', null, 'sc-empty'); appendLocalized(empty, el('h3', this.admin ? {messageKey:"supportCenter.noMatchingReports",messageParams:{}} : {messageKey:"supportCenter.noReportsYet",messageParams:{}})); if (!this.admin) appendLocalized(empty, translatedElement(button(interfaceText("supportCenter.newReport"), () => this.showCreate(), 'sc-primary'), "supportCenter.newReport", {})); appendLocalized(list, empty); }
    for (const row of this.items) {
      const node = button('', () => void this.openThread(row.id), 'sc-item'); node.setAttribute('aria-current', String(this.thread?.id === row.id));
      const title = el('span', row.title, 'sc-item-title'); if (row.unread) { const dot = el('i', null, 'sc-dot'); localizedAttribute(dot, 'aria-label', "supportCenter.unreadReply", {}); title.prepend(dot); node.classList.add('sc-unread'); }
      if (this.admin) {
        const top = el('div', null, 'sc-item-row'); appendLocalized(top, title, el('time',{messageKey:'supportMessages.date',messageParams:{date:dateValue(row.createdAt)}}));
        const meta = el('div', null, 'sc-item-meta'); appendLocalized(meta, el('span', SUPPORT_CATEGORIES[row.category]), el('span', row.displayName || {messageKey:"supportCenter.creator",messageParams:{}}));
        if (row.source === 'desktop') appendLocalized(meta, translatedElement(el('span', {messageKey:"supportCenter.app",messageParams:{}}), "supportCenter.app", {}));
        const tags = el('div', null, 'sc-item-tags'); appendLocalized(tags, pill(row.status, true));
        if (row.priority && row.priority !== 'normal') { const priority = el('span', SUPPORT_PRIORITIES[row.priority], 'sc-priority'); priority.dataset.priority = row.priority; appendLocalized(tags, priority); }
        if (row.followUp) { const due = el('span', {messageKey:'supportMessages.followUp',messageParams:{date:dateValue(row.followUp+'T00:00:00')}}, 'sc-item-followup'); if (row.followUp <= new Date().toISOString().slice(0, 10)) due.dataset.due = ''; appendLocalized(tags, due); }
        if (row.assigned) appendLocalized(tags, translatedElement(el('span', {messageKey:"supportCenter.me",messageParams:{}}, 'sc-item-assignee'), "supportCenter.me", {}));
        appendLocalized(node, top, meta, tags);
      } else {
        const meta = el('div', null, 'sc-item-meta'); appendLocalized(meta, el('span', SUPPORT_CATEGORIES[row.category]), el('time',{messageKey:'supportMessages.date',messageParams:{date:dateValue(row.createdAt)}}));
        appendLocalized(node, meta, title, pill(row.status));
      }
      appendLocalized(list, node);
    }
    this.$('[data-more]').hidden = !this.nextCursor;
    const count = this.$('[data-count]'); if (count) { count.textContent = `${this.items.length}${this.nextCursor ? '+' : ''}`; count.hidden = !this.items.length; }
    const inbox = this.$('[data-nav-inbox]'); if (inbox) localizedText(inbox, "supportCenter.myReports2", {value: this.items.length ? ` (${this.items.length}${this.nextCursor ? '+' : ''})` : ''});
  }
  emptyDetail() {
    localizedMarkup(this.$('[data-body]'), this.admin
      ? `<div class="sc-empty"><span class="sc-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/></svg></span><h3 data-i18n="supportCenter.selectAReport">${messageHTML("supportCenter.selectAReport", {})}</h3><p class="sc-small" data-i18n="supportCenter.pickAConversationFromTheInboxToRead">${messageHTML("supportCenter.pickAConversationFromTheInboxToRead", {})}</p></div>`
      : `<div class="sc-empty"><span class="sc-empty-icon" aria-hidden="true">☷</span><h3 data-i18n="supportCenter.selectAConversation">${messageHTML("supportCenter.selectAConversation", {})}</h3></div>`);
  }
  async openThread(id) {
    if (this.busy) { this.notice({messageKey:"supportCenter.pleaseWaitForTheCurrentSendToFinish",messageParams:{}}); return; }
    if (this.pendingCreation) { this.notice({messageKey:"supportCenter.retryTheRemainingAttachmentsOrContinueToThe",messageParams:{}}); return; }
    if (this.pendingFiles.length || this.pendingMessage) { this.notice({messageKey:"supportCenter.sendOrRemoveTheSelectedFilesBeforeSwitching2",messageParams:{}}); return; }
    this.resetDetail(); this.setView('thread'); const generation = this.generation; this.thread = null;
    appendLocalized(this.$('[data-body]'), translatedElement(el('p', {messageKey:"supportCenter.openingConversation",messageParams:{}}, 'sc-small'), "supportCenter.openingConversation", {}));
    try {
      const data = await this.api(`/threads/${id}`); if (generation !== this.generation) return;
      this.thread = data.thread; this.attachments = data.files; this.messages = new Map(data.messages.map(m => [m.id, m])); this.nextBefore = data.nextBefore;
      this.renderThread(); this.renderList();
      this.lastActivity = Date.now(); this.livePaused = false;
      this.onThreadOpen?.(id);
      if (!this.admin) this.$('.sc-ticket-heading').scrollIntoView({ block: 'start', behavior: 'instant' });
      if (data.thread.unread && data.seen && !data.nextAfter) { await this.api(`/threads/${id}/seen`, { method: "POST", body: { seq: data.seen } }); if (generation !== this.generation) return; const item = this.items.find(t => t.id === id); if (item) item.unread = false; this.renderList(); }
      this.schedule();
    } catch (error) { if (generation === this.generation) { this.emptyDetail(); this.notice(supportErrorMessage(error), true); } }
  }
  renderThread() {
    const row = this.thread, body = this.$('[data-body]'); replaceLocalized(body);
    body.dataset.threadView = '';
    const toolbar = el('div', null, 'sc-thread-toolbar');
    const back = button(this.admin ? interfaceText("supportCenter.inbox2") : interfaceText("supportCenter.myReports3"), () => this.showInbox(), 'sc-quiet'); if (this.admin) back.classList.add('sc-mobile-back'); appendLocalized(toolbar, back);
    const live = translatedElement(el('span', {messageKey:"supportCenter.connecting",messageParams:{}}, 'sc-live'), "supportCenter.connecting", {}); localizedAttribute(live, "title", "supportCenter.serverPushedUpdatesNoIdlePolling", {});
    const check = translatedElement(button(interfaceText("supportCenter.checkForReplies"), () => void this.refreshThread(), 'sc-quiet'), "supportCenter.checkForReplies", {});
    const actions = el('details', null, 'sc-report-menu'); appendLocalized(actions, el('summary', this.admin ? {messageKey:"supportCenter.actions",messageParams:{}} : {messageKey:"supportCenter.more",messageParams:{}}));
    const menu = el('div', null, 'sc-menu-actions');
    if (this.admin) appendLocalized(menu, translatedElement(button(interfaceText("supportCenter.copyReportId"), () => this.copyId()), "supportCenter.copyReportId", {}));
    appendLocalized(menu, translatedElement(button(interfaceText("supportCenter.exportConversation"), () => void this.exportThread()), "supportCenter.exportConversation", {}), translatedElement(button(interfaceText("supportCenter.deleteReport"), () => this.confirmDelete(toolbar), 'sc-danger'), "supportCenter.deleteReport", {})); appendLocalized(actions, menu);
    if (this.admin) appendLocalized(toolbar, live, check, actions); else appendLocalized(toolbar, check, live, actions);
    appendLocalized(body, toolbar);
    const header = el('header', null, 'sc-ticket-heading'), top = el('div', null, 'sc-actions'); appendLocalized(top, pill(row.status, this.admin), el('span', {messageKey:'supportMessages.ticketCategory',messageParams:{id:row.id.slice(0,8),category:SUPPORT_CATEGORIES[row.category]}}, 'sc-eyebrow'));
    appendLocalized(header, top, el('h2', row.title));
    if (this.admin) {
      const facts = el('div', null, 'sc-ticket-facts');
      appendLocalized(facts, el('span', row.displayName || {messageKey:"supportCenter.creator",messageParams:{}}), el('span', row.source === 'desktop' ? {messageKey:"supportCenter.fromTheApp",messageParams:{}} : {messageKey:"supportCenter.fromTheWebsite",messageParams:{}}), el('span', {messageKey:'supportMessages.openedAt',messageParams:{date:dateValue(row.createdAt)}}));
      if (row.details?.version) appendLocalized(facts, el('span', `v${row.details.version}`)); if (row.details?.platform) appendLocalized(facts, el('span', row.details.platform));
      appendLocalized(header, facts);
    }
    appendLocalized(body, header);
    // The administrator reads and replies in one column while properties stay beside it.
    const main = this.admin ? el('div', null, 'sc-thread-main') : body; if (this.admin) { appendLocalized(body, main); this.moderation(body); }
    const details = el('details', null, 'sc-details'), summary = translatedElement(el('summary', {messageKey:"supportCenter.reportDetails",messageParams:{}}), "supportCenter.reportDetails", {}); appendLocalized(details, summary); const dl = el('dl');
    const fields = [messageTuple(['steps',interfaceText("supportCenter.steps")], {1: {key: "supportCenter.steps", params: {}}}),messageTuple(['expected',interfaceText("supportCenter.expected")], {1: {key: "supportCenter.expected", params: {}}}),messageTuple(['actual',interfaceText("supportCenter.actual")], {1: {key: "supportCenter.actual", params: {}}}),messageTuple(['frequency',interfaceText("supportCenter.frequency")], {1: {key: "supportCenter.frequency", params: {}}}),messageTuple(['version',interfaceText("supportCenter.appVersion")], {1: {key: "supportCenter.appVersion", params: {}}}),messageTuple(['platform',interfaceText("supportCenter.system")], {1: {key: "supportCenter.system", params: {}}})].filter(([key]) => row.details?.[key]);
    if (this.admin) { appendLocalized(summary, el('span', fields.length ? fields.map(([, label]) => label).join(' · ') : {messageKey:"supportCenter.noReproductionDetails",messageParams:{}}, 'sc-details-preview')); }
    else appendLocalized(dl, translatedElement(el('dt', {messageKey:"supportCenter.opened",messageParams:{}}), "supportCenter.opened", {}), el('dd',{messageKey:'supportMessages.date',messageParams:{date:dateValue(row.createdAt)}}), translatedElement(el('dt', {messageKey:"supportCenter.expires",messageParams:{}}), "supportCenter.expires", {}), el('dd',{messageKey:'supportMessages.date',messageParams:{date:dateValue(row.expiresAt)}}));
    for (const [key, label] of fields) appendLocalized(dl, el('dt', label), el('dd', row.details[key]));
    if (this.admin) appendLocalized(dl, translatedElement(el('dt', {messageKey:"supportCenter.expires",messageParams:{}}), "supportCenter.expires", {}), el('dd',{messageKey:'supportMessages.date',messageParams:{date:dateValue(row.expiresAt)}}));
    appendLocalized(dl, translatedElement(el('dt', {messageKey:"supportCenter.sentFrom",messageParams:{}}), "supportCenter.sentFrom", {}), el('dd', row.source === 'desktop' ? {messageKey:"supportCenter.stykanimateApp",messageParams:{}} : {messageKey:"supportCenter.website",messageParams:{}})); appendLocalized(details, dl); appendLocalized(main, details);
    const conversation = el('div', null, 'sc-conversation'); conversation.setAttribute('role', 'log'); localizedAttribute(conversation, 'aria-label', "supportCenter.reportConversation", {}); conversation.setAttribute('aria-live', 'polite'); appendLocalized(main, conversation); this.renderMessages();
    const more = translatedElement(button(interfaceText("supportCenter.loadEarlierMessages"), () => void this.refreshThread(true), 'sc-load'), "supportCenter.loadEarlierMessages", {}); more.dataset.messagesMore = ''; more.hidden = !this.nextBefore; conversation.before(more);
    this.composer(main); this.syncComposerState();
    const generation = this.generation;
    requestAnimationFrame(() => { if (generation === this.generation && conversation.isConnected) conversation.scrollTop = conversation.scrollHeight; });
  }
  copyId() { void navigator.clipboard.writeText(this.thread.id).then(() => this.notice({messageKey:"supportCenter.reportIdCopied",messageParams:{}}), () => this.notice({messageKey:"supportCenter.clipboardUnavailableTheFullIdIsInThe",messageParams:{}}, true)); }
  renderMessages() {
    const mount = this.$('.sc-conversation'); if (!mount) return;
    const nearEnd = mount.scrollHeight - mount.scrollTop - mount.clientHeight < 80;
    for (const msg of this.messages.values()) {
      let node = mount.querySelector(`[data-message="${msg.id}"]`);
      if (!node) {
        node = el('article', null, 'sc-message'); node.dataset.message = msg.id; node.dataset.role = msg.role; node.dataset.seq = msg.seq;
        const event = this.admin && msg.role === 'note' && msg.body.startsWith('Moderation: ');
        if (event) node.dataset.event = '';
        const header = el('header'), author = event ? {messageKey:"supportCenter.moderationChange",messageParams:{}} : msg.role === 'note' ? (this.admin ? {messageKey:"supportCenter.privateNote",messageParams:{}} : {messageKey:"supportCenter.internalNoteOnlyYou",messageParams:{}}) : msg.role === 'developer' ? (this.admin ? {messageKey:"supportCenter.you",messageParams:{}} : {messageKey:"supportCenter.stykanimateDeveloper",messageParams:{}}) : this.thread.displayName;
        if (this.admin) { const avatar = el('span', msg.role === 'note' ? '✎' : (msg.role === 'developer' ? 'S' : (this.thread.displayName || "C")).slice(0, 1).toUpperCase(), 'sc-avatar'); avatar.dataset.role = msg.role; avatar.setAttribute('aria-hidden', 'true'); appendLocalized(node, avatar); }
        appendLocalized(header, el('strong', author), el('time',{messageKey:'supportMessages.date',messageParams:{date:dateValue(msg.createdAt,true)}})); appendLocalized(node, header, el('p', event ? msg.body.slice('Moderation: '.length) : msg.body));
        const next = [...mount.children].find(child => Number(child.dataset.seq) > msg.seq); mount.insertBefore(node, next || null);
      }
      for (const file of this.attachments.filter(f => f.messageId === msg.id)) if (!node.querySelector(`[data-file="${file.id}"]`)) {
        const attachment = el('div', null, 'sc-file sc-attachment-card'); attachment.dataset.file = file.id;
        if (!file.mime.startsWith('image/') && !file.mime.startsWith('video/')) appendLocalized(attachment, translatedElement(el('div', {messageKey:"supportCenter.styk",messageParams:{}}, 'sc-project-preview'), "supportCenter.styk", {}));
        appendLocalized(attachment, el('span', file.name, 'sc-file-name'), el('span',{messageKey:'supportMessages.fileSize',messageParams:{size:byteValue(file.bytes)}},'sc-small'));
        appendLocalized(attachment, translatedElement(button(interfaceText("supportCenter.download"), () => void this.getFile(file, false)), "supportCenter.download", {}));
        if (file.mime.startsWith('image/') || file.mime.startsWith('video/')) {
          attachment.prepend(translatedElement(el('div', {messageKey:"supportCenter.loadingPreview",messageParams:{}}, 'sc-preview-placeholder'), "supportCenter.loadingPreview", {}));
          const previewButton=translatedElement(button(interfaceText("supportCenter.preview"), () => void this.getFile(file,true)),"supportCenter.preview");previewButton.dataset.previewAttachment="";appendLocalized(attachment,previewButton);
          const generation = this.generation;
          this.previewQueue = (this.previewQueue || Promise.resolve()).catch(() => {}).then(() => { if (generation === this.generation && !this.disposed) return this.getFile(file, true); });
        }
        appendLocalized(attachment, translatedElement(button(interfaceText("common.remove"), () => { if (!this.busy) this.confirmFileDelete(file, attachment); }, 'sc-quiet'), "common.remove", {}));
        appendLocalized(node, attachment);
      }
    }
    // A removed/expired attachment must disappear without replacing text or the reply draft.
    mount.querySelectorAll('[data-file]').forEach(node => { if (!this.attachments.some(f => f.id === node.dataset.file)) node.remove(); });
    mount.querySelectorAll('[data-preview-file]').forEach(node => { if (!this.attachments.some(f => f.id === node.dataset.previewFile)) { URL.revokeObjectURL(node.src); this.previews.delete(node.src); node.remove(); } });
    if (nearEnd) mount.scrollTop = mount.scrollHeight;
  }
  composer(body) {
    const form = el('form', null, 'sc-composer'); form.dataset.reply = '';
    const placeholderKey=this.admin?"supportCenter.replyTo":"supportCenter.writeAReply",placeholderParams=this.admin?{name:this.thread.displayName||{messageKey:"supportCenter.creator"}}:{};
    const placeholder=interfaceText(placeholderKey,placeholderParams);
    localizedMarkup(form, `<label>${messageHTML("supportCenter.reply", {})}<textarea name="message" maxlength="4000" required placeholder="${placeholder.replaceAll('"', '&quot;')}"></textarea></label><details class="sc-attach"><summary data-i18n="supportCenter.attachFiles">Attach files</summary><div data-file-mount></div></details><footer><div>${this.admin ? `<label class="sc-check sc-switch"><input type="checkbox" name="internal"><span data-i18n="supportCenter.privateNote">${messageHTML("supportCenter.privateNote", {})}</span></label>` : ''}</div><button type="submit" class="sc-primary" data-i18n="supportCenter.sendMessage">Send message</button></footer>`);
    localizedAttribute(form.elements.message,'placeholder',placeholderKey,placeholderParams);
    const draft = this.drafts[this.thread.id] || {}; this.replyId = draft.requestId || crypto.randomUUID(); form.elements.message.value = draft.message || '';
    appendLocalized(body, form); this.filePicker(form.querySelector('[data-file-mount]'));
    form.addEventListener('input', () => this.remember());
    form.elements.message.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !this.busy) { event.preventDefault(); form.requestSubmit(); } });
    if (this.admin) form.elements.internal.onchange = () => { form.querySelector('.sc-attach').hidden = form.elements.internal.checked; form.classList.toggle('sc-note-mode', form.elements.internal.checked); localizedText(form.querySelector('[type=submit]'), (form.elements.internal.checked ? "supportCenter.savePrivateNote" : "supportCenter.sendMessage"), (form.elements.internal.checked ? {} : {})); localizedAttribute(form.elements.message,"placeholder",form.elements.internal.checked?"supportCenter.writeANoteOnlyYouCanSee":placeholderKey,form.elements.internal.checked?{}:placeholderParams); };
    form.onsubmit = event => { event.preventDefault(); void this.sendReply(form); };
  }
  syncComposerState() {
    const form = this.$('[data-reply]'); if (!form || this.admin || this.busy) return;
    const locked = ['closed', 'spam'].includes(this.thread?.status);
    form.elements.message.readOnly = locked || Boolean(this.pendingMessage);
    form.querySelector('[type=submit]').disabled = locked;
    form.querySelector('[type=file]').disabled = locked || this.config?.attachments === false;
    let notice = form.querySelector('[data-closed]');
    if (locked && !notice) { notice = translatedElement(el('p', {messageKey:"supportCenter.thisConversationIsClosedYourDraftStaysHere",messageParams:{}}, 'sc-small'), "supportCenter.thisConversationIsClosedYourDraftStaysHere", {}); notice.dataset.closed = ''; form.prepend(notice); }
    if (!locked) notice?.remove();
  }
  async sendReply(form) {
    if (this.busy || (!this.admin && ['closed', 'spam'].includes(this.thread?.status)) || !form.reportValidity()) return;
    const text = form.elements.message.value.trim(); if (!text) return;
    this.remember(); const id = this.thread.id, internal = form.elements.internal?.checked === true;
    this.setBusy(true);
    let optimistic;
    if (!this.pendingMessage) {
      optimistic = el('article', null, 'sc-message sc-sending'); optimistic.dataset.role = internal ? 'note' : this.admin ? 'developer' : 'creator';
      appendLocalized(optimistic, el('header', internal ? {messageKey:"supportCenter.privateNoteSending",messageParams:{}} : {messageKey:"supportCenter.sending",messageParams:{}}), el('p', text));
      const log = this.$('.sc-conversation'); appendLocalized(log, optimistic); log.scrollTop = log.scrollHeight;
    }
    try {
      const sent = this.pendingMessage || await this.api(`/threads/${id}/messages`, { method: "POST", body: { requestId: this.replyId, message: text, internal } });
      if (!this.pendingMessage && !internal) sent.queue = this.files; this.pendingMessage = sent; if (!internal) this.files = [];
      if (sent.message) { optimistic?.remove(); this.messages.set(sent.id, { ...sent.message, localReceipt: true }); this.renderMessages(); const log = this.$('.sc-conversation'); log.scrollTop = log.scrollHeight; }
      if (!internal) await this.uploadPending(id, sent.id, sent.queue);
      this.pendingMessage = null; this.files = []; form.elements.message.value = ''; this.replyId = crypto.randomUUID(); this.saveDraft(id, {});
      this.notice('');
      let status = form.querySelector('.sc-send-status'); if (!status) { status = el('span', null, 'sc-send-status'); status.setAttribute('role', 'status'); appendLocalized(form.querySelector('footer>div'), status); }
      localizedText(status, (internal ? "supportCenter.internalNoteSaved" : "supportCenter.messageSent"), (internal ? {} : {}));
      this.setBusy(false); await this.refreshThread();
      this.lastActivity = Date.now(); this.livePaused = false; this.schedule(); form.elements.message.focus();
    } catch (error) { this.notice(this.pendingMessage ? {messageKey:'supportCenter.messageSentAnAttachmentNeedsAttentionValueRetryOr',messageParams:{value: supportErrorMessage(error)}} : supportErrorMessage(error), true); }
    finally { optimistic?.remove(); this.setBusy(false); form.elements.message.readOnly = Boolean(this.pendingMessage); if (this.pendingMessage) { localizedText(form.querySelector('[type=submit]'), "supportCenter.retryAttachments", {}); const fileInput = form.querySelector('[type=file]'); if (fileInput) fileInput.disabled = true; } }
  }
  async refreshThread(more = false, automatic = false) {
    if (!this.thread || this.busy || this.detailBusy) return; this.detailBusy = true;
    const id = this.thread.id, generation = this.generation, after = Math.max(0, ...[...this.messages.values()].filter(m => !m.localReceipt).map(m => m.seq));
    const log = this.$('.sc-conversation'), oldHeight = log?.scrollHeight || 0, oldTop = log?.scrollTop || 0;
    try {
      const data = await this.api(`/threads/${id}?${more ? 'before=' + this.nextBefore : 'after=' + after}`, automatic ? { headers: { 'X-Support-Auto': '1' } } : {}); if (generation !== this.generation) return;
      const previous = this.thread.status; this.thread = data.thread; this.attachments = data.files; if (more) this.nextBefore = data.nextBefore;
      const moderation = this.$('[data-moderation]');
      if (moderation && !moderation.dataset.dirty) {
        for (const key of ['status','priority','tags','followUp','duplicateOf']) moderation.elements.namedItem(key).value = data.thread[key] || '';
        moderation.elements.assigned.checked = data.thread.assigned; moderation.dataset.version = data.thread.version;
      }
      data.messages.forEach(m => this.messages.set(m.id, m)); this.renderMessages();
      if (more && log) log.scrollTop = oldTop + log.scrollHeight - oldHeight;
      const moreButton = this.$('[data-messages-more]'); if (moreButton) moreButton.hidden = !this.nextBefore;
      if (previous !== data.thread.status) { const badge = this.$('.sc-ticket-heading .sc-pill'); badge.replaceWith(pill(data.thread.status, this.admin)); this.notice({messageKey:'supportCenter.reportStatusValue',messageParams:{value: statusLabel(data.thread.status, this.admin)}}); }
      this.syncComposerState();
      if (data.thread.unread && !data.nextAfter) await this.api(`/threads/${id}/seen`, { method: "POST", body: { seq: data.seen }, ...(automatic ? { headers: { 'X-Support-Auto': '1' } } : {}) });
      if (generation !== this.generation) return;
      const item = this.items.find(item => item.id === id); if (item) Object.assign(item, data.thread, { unread: false }); this.renderList();
    } catch (error) {
      if (generation === this.generation) {
        if (automatic) { this.live.stop(); this.livePaused = true; const status = this.$('.sc-live'); if (status) localizedText(status, "supportCenter.manualRefresh", {}); }
        else this.notice(supportErrorMessage(error), true);
        if (error.code === 'not_found') { this.resetDetail(); this.thread = null; this.items = this.items.filter(item => item.id !== id); this.renderList(); this.setView('inbox'); this.emptyDetail(); this.notice({messageKey:"supportCenter.thisConversationIsNoLongerAvailable",messageParams:{}}); }
      }
    } finally { this.detailBusy = false; this.flushLive(); }
  }
  async refresh() { if (this.busy) return; if (this.layout === 'board') await this.loadBoard(); else { await this.loadList(); if (this.thread) await this.refreshThread(); } if (this.admin) await this.loadCapacity(); }
  flushLive() {
    if (!this.liveDirty || this.busy || this.detailBusy || !this.thread || !this.active || document.hidden || this.livePaused) return;
    this.liveDirty = false; void this.refreshThread(false, true);
  }
  schedule() {
    if (this.disposed || !this.live) return;
    if (!this.active || document.hidden || !this.thread) { this.live.stop(); return; }
    if (this.config?.live === false || this.livePaused) { const status = this.$('.sc-live'); if (status) localizedText(status, "supportCenter.manualRefresh", {}); return; }
    this.live.start(this.thread.id);
  }
  filters() {
    // Search lives above the list; queue and filter controls live in the rail and share one form.
    const form = el('form', null, 'sc-filters'); form.id = 'sc-filters-' + crypto.randomUUID().slice(0, 8);
    localizedMarkup(form, `<div class="sc-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/></svg><input type="search" name="q" maxlength="120" placeholder="Search title or report ID" aria-label="Find a report" data-i18n-placeholder="supportCenter.searchTitleOrReportId" data-i18n-aria-label="supportCenter.findAReport"><input type="hidden" name="view"><button type="submit" aria-label="Search" data-i18n-aria-label="common.search" data-i18n="supportCenter.go">${messageHTML("supportCenter.go", {})}</button></div>`);
    const rail = this.$('[data-filters]');
    localizedMarkup(rail, `<h3 data-i18n="supportCenter.filter">${messageHTML("supportCenter.filter", {})}</h3><label>${messageHTML("supportCenter.type", {})}<select name="category" form="${form.id}"><option value="" data-i18n="supportCenter.allTypes">${messageHTML("supportCenter.allTypes", {})}</option>${optionHtml(SUPPORT_CATEGORIES)}</select></label><label>${messageHTML("supportCenter.status", {})}<select name="status" form="${form.id}"><option value="" data-i18n="supportCenter.anyStatus">${messageHTML("supportCenter.anyStatus", {})}</option>${optionHtml({ ...SUPPORT_STATUSES, waiting:{messageKey:'supportCenter.waitingForCreator'} })}</select></label><label class="sc-priority-filter">${messageHTML("supportCenter.priority2", {})}<select name="priority" form="${form.id}"><option value="" data-i18n="supportCenter.allPriorities">${messageHTML("supportCenter.allPriorities", {})}</option>${optionHtml(SUPPORT_PRIORITIES)}</select></label>`);
    form.onsubmit = event => { event.preventDefault(); this.query = Object.fromEntries(new FormData(form)); void (this.layout === 'board' ? this.loadBoard() : this.loadList()); };
    rail.querySelectorAll('select').forEach(select => select.onchange = () => form.requestSubmit());
    const queues = this.$('.sc-queues');
    for (const tuple of [messageTuple([interfaceText("supportCenter.allReports"),'',''], {0: {key: "supportCenter.allReports", params: {}}}),messageTuple([interfaceText("supportCenter.needsReply"),'unread',''], {0: {key: "supportCenter.needsReply", params: {}}}),messageTuple([interfaceText("supportCenter.new"),'','new'], {0: {key: "supportCenter.new", params: {}}}),messageTuple([interfaceText("supportCenter.inProgress"),'','in_progress'], {0: {key: "supportCenter.inProgress", params: {}}}),messageTuple([interfaceText("supportCenter.assignedToMe"),'assigned',''], {0: {key: "supportCenter.assignedToMe", params: {}}}),messageTuple([interfaceText("supportCenter.followUpDue"),'due',''], {0: {key: "supportCenter.followUpDue", params: {}}}),messageTuple([interfaceText("supportCenter.resolved"),'','resolved'], {0: {key: "supportCenter.resolved", params: {}}})]) {
      const [name,view,status]=tuple;
      const tab = button({messageKey:tupleMessages(tuple)[0].key}, () => {
        if (this.busy) return;
        form.elements.view.value = view; form.elements.status.value = status;
        for (const sibling of queues.children) sibling.setAttribute('aria-pressed', String(sibling === tab));
        form.requestSubmit();
      }); tab.setAttribute('aria-pressed', String(!view&&!status)); appendLocalized(queues, tab);
    }
    appendLocalized(this.$('[data-search]'), form);
  }
  moderation(body) {
    const row = this.thread, form = el('form', null, 'sc-tools'); form.dataset.moderation = '';
    localizedMarkup(form, `<div class="sc-tools-head"><h3 data-i18n="supportCenter.properties">${messageHTML("supportCenter.properties", {})}</h3><span class="sc-tools-state" data-dirty-label hidden data-i18n="supportCenter.unsaved">${messageHTML("supportCenter.unsaved", {})}</span></div>
      <label>${messageHTML("supportCenter.status", {})}<select name="status">${optionHtml({ ...SUPPORT_STATUSES, waiting:{messageKey:'supportCenter.waitingForCreator'} })}</select></label>
      <label>${messageHTML("supportCenter.priority2", {})}<select name="priority">${optionHtml(SUPPORT_PRIORITIES)}</select></label>
      <label class="sc-check sc-switch"><input type="checkbox" name="assigned"><span data-i18n="supportCenter.assignedToMe">${messageHTML("supportCenter.assignedToMe", {})}</span></label>
      <label>${messageHTML("supportCenter.followUpOn", {})}<input name="followUp" type="date"></label>
      <label>${messageHTML("supportCenter.tags", {})}<input name="tags" maxlength="150" placeholder="playback, export…" data-i18n-placeholder="supportCenter.playbackExport"></label>
      <button type="submit" class="sc-primary" data-i18n="supportCenter.saveChanges">${messageHTML("supportCenter.saveChanges", {})}</button>
      <details class="sc-organization"><summary data-i18n="supportCenter.duplicateAmpIdentity">${messageHTML("supportCenter.duplicateAmpIdentity", {})}</summary><div class="sc-fields"><label class="sc-full">${messageHTML("supportCenter.duplicateOfReportId", {})}<input name="duplicateOf" maxlength="32" pattern="[a-f0-9]{32}" placeholder="32 hexadecimal characters" data-i18n-placeholder="supportCenter.message32HexadecimalCharacters"></label></div><div class="sc-actions"><button type="button" data-copy-id data-i18n="supportCenter.copyReportId">${messageHTML("supportCenter.copyReportId", {})}</button></div></details>
      <dl class="sc-report-facts"><dt>${messageHTML("supportCenter.files", {})}</dt><dd>${messageHTML('supportMessages.filesUsage',{count:row.fileCount,size:byteValue(row.fileBytes)})}</dd><dt>${messageHTML("supportCenter.opened", {})}</dt><dd>${date(row.createdAt)}</dd><dt>${messageHTML("supportCenter.expires", {})}</dt><dd>${date(row.expiresAt)}</dd></dl>`);
    for (const key of ['status','priority','tags','followUp','duplicateOf']) form.elements.namedItem(key).value = row[key] || '';
    form.elements.assigned.checked = row.assigned; form.dataset.version = row.version;
    const dirty = () => { form.dataset.dirty = 'true'; form.querySelector('[data-dirty-label]').hidden = false; };
    form.addEventListener('input', dirty); form.addEventListener('change', dirty);
    form.querySelector('[data-copy-id]').onclick = () => this.copyId();
    form.onsubmit = async event => {
      event.preventDefault(); if (this.busy || !form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form)); values.assigned = form.elements.assigned.checked; values.version = Number(form.dataset.version);
      this.setBusy(true);
      try { await this.api(`/threads/${row.id}`, { method: "PATCH", body: values }); this.setBusy(false); await this.openThread(row.id); await this.loadList(); this.notice({messageKey:"supportCenter.changesSaved",messageParams:{}}); }
      catch (error) { this.notice(supportErrorMessage(error), true); } finally { this.setBusy(false); }
    };
    appendLocalized(body, form);
  }
  async loadCapacity() {
    try {
      const data = await this.api('/capacity'); if (this.disposed) return;
      const mount = this.$('[data-capacity]'), wasOpen = mount.querySelector('details')?.open; replaceLocalized(mount);
      const box = el('details', null, 'sc-capacity'); box.open = Boolean(wasOpen);
      const summary = el('summary'), headline = el('span', null, 'sc-capacity-headline'); appendLocalized(headline, translatedElement(el('span', {messageKey:"supportCenter.storage",messageParams:{}}, 'sc-small'), "supportCenter.storage", {}), el('strong', {messageKey:'supportMessages.storageUsage',messageParams:{used:byteValue(data.capacity.file_bytes),maximum:byteValue(data.limits.storageBytes)}}));
      const usage = el('progress'); usage.max = data.limits.storageBytes || 1; usage.value = data.capacity.file_bytes; localizedAttribute(usage, 'aria-label', "supportCenter.attachmentStorageUsed", {});
      appendLocalized(summary, headline, usage); if (data.capacity.paused) appendLocalized(summary, translatedElement(el('span', {messageKey:"supportCenter.intakePaused",messageParams:{}}, 'sc-capacity-paused'), "supportCenter.intakePaused", {})); appendLocalized(box, summary);
      const grid = el('div', null, 'sc-capacity-grid');
      for (const tuple of [messageTuple([interfaceText("supportCenter.filesReserved"), data.capacity.file_bytes, data.limits.storageBytes, formatBytes], {0: {key: "supportCenter.filesReserved", params: {}}}), messageTuple([interfaceText("supportCenter.reports2"), data.capacity.thread_count, data.limits.threads, String], {0: {key: "supportCenter.reports2", params: {}}}), messageTuple([interfaceText("supportCenter.creatorRequestsToday"), data.budget?.requests || 0, data.limits.dailyRequests, String], {0: {key: "supportCenter.creatorRequestsToday", params: {}}}), messageTuple([interfaceText("supportCenter.creatorWritesToday"), data.budget?.writes || 0, data.limits.dailyWrites, String], {0: {key: "supportCenter.creatorWritesToday", params: {}}})]) {
        const [name,value,maximum,format]=tuple, nameMessage=tupleMessages(tuple)[0];
        const item = el('div'); appendLocalized(item, el('span',{messageKey:nameMessage.key},'sc-small'), el('strong', {messageKey:'supportMessages.counterUsage',messageParams:{used:format===formatBytes?byteValue(value):value,maximum:format===formatBytes?byteValue(maximum):maximum}})); const bar = el('progress'); bar.max = maximum || 1; bar.value = value; localizedAttribute(bar,'aria-label',nameMessage.key); appendLocalized(item, bar); appendLocalized(grid, item);
      }
      appendLocalized(box, grid);
      appendLocalized(box, button({messageKey:data.capacity.paused?'supportCenter.resumeNewReports':'supportCenter.pauseNewReports'}, async event => { event.target.disabled = true; try { await this.api('/capacity', { method: "PATCH", body: { paused: !data.capacity.paused } }); await this.loadCapacity(); } catch (error) { this.notice(supportErrorMessage(error), true); event.target.disabled = false; } }, 'sc-capacity-toggle'));
      appendLocalized(box, el('p', {messageKey:'supportMessages.retention',messageParams:{availability:{messageKey:data.attachments?'supportCenter.privateAttachmentsEnabled':'supportCenter.attachmentStorageIsNotConnected'},held:data.heldBytes?{messageKey:'supportMessages.interruptedUploads',messageParams:{size:byteValue(data.heldBytes)}}:''}}, 'sc-small')); appendLocalized(mount, box);
    } catch (error) { this.notice(supportErrorMessage(error), true); }
  }
  async getFile(file, preview) {
    if (this.busy || this.fileLoading) return;
    this.fileLoading = true;
    const id = this.thread.id, generation = this.generation;
    try {
      if (!preview && this.downloadFile) { await this.downloadFile(id, file.id); return; }
      const blob = await this.api(`/threads/${id}/files/${file.id}`, { raw: true });
      if (preview) {
        if (generation !== this.generation) return;
        const mount = this.root.querySelector(`[data-file="${file.id}"]`); if (!mount) return;
        if (mount.querySelector('.sc-preview')) return;
        mount.querySelector('.sc-preview-placeholder')?.remove();
        const media = this.mediaPreview(blob, file.mime, file.name); media.dataset.previewFile = file.id; mount.prepend(media);
        const preview=mount.querySelector('[data-preview-attachment]'); if (preview) preview.hidden = true;
      } else saveBlob(blob, file.name);
    } catch (error) { this.notice(supportErrorMessage(error), true); }
    finally { this.fileLoading = false; }
  }
  confirmFileDelete(file, mount) {
    if (mount.querySelector('[data-confirm]')) return;
    const confirm = translatedElement(button(interfaceText("supportCenter.permanentlyRemove"), async () => { confirm.disabled = true; try { await this.api(`/threads/${this.thread.id}/files/${file.id}`, { method: "DELETE" }); await this.refreshThread(); this.notice({messageKey:"supportCenter.attachmentRemoved",messageParams:{}}); } catch (error) { this.notice(supportErrorMessage(error), true); confirm.disabled = false; } }, 'sc-danger'), "supportCenter.permanentlyRemove", {}); confirm.dataset.confirm = ''; appendLocalized(mount, confirm);
  }
  confirmDelete(mount) {
    if (this.$('.sc-delete-confirm')) return;
    const id = this.thread.id, box = el('div', null, 'sc-delete-confirm'); box.setAttribute('role', 'alert'); appendLocalized(box, translatedElement(el('h3', {messageKey:"supportCenter.deleteThisConversation",messageParams:{}}), "supportCenter.deleteThisConversation", {}), el('p', {messageKey:'supportMessages.deleteFiles',messageParams:{count:this.thread.fileCount,size:byteValue(this.thread.fileBytes)}}));
    appendLocalized(box, translatedElement(button(interfaceText("supportCenter.permanentlyDelete"), async () => { if (this.busy) return; this.setBusy(true); try { const deleted = await this.api(`/threads/${id}`, { method: "DELETE" }); this.setBusy(false); this.resetDetail(); this.thread = null; this.setView('inbox'); this.admin ? this.emptyDetail() : this.showCreate(); await this.loadList(); if (this.admin) await this.loadCapacity(); this.notice(deleted.cleanupPending ? {messageKey:"supportCenter.reportDeletedFileCleanupWillRetryAutomatically",messageParams:{}} : {messageKey:"supportCenter.reportDeleted",messageParams:{}}); } catch (error) { this.notice(supportErrorMessage(error), true); } finally { this.setBusy(false); } }, 'sc-danger'), "supportCenter.permanentlyDelete", {}), translatedElement(button(interfaceText("common.cancel"), () => box.remove()), "common.cancel", {})); mount.after(box);
  }
  async exportThread() {
    if (this.busy) return; this.setBusy(true,{messageKey:'supportCenter.exporting'});
    try {
      let after = 0, data, messages = [];
      do { data = await this.api(`/threads/${this.thread.id}?after=${after}`); messages.push(...data.messages); after = data.nextAfter; } while (after);
      saveBlob(new Blob([JSON.stringify({ thread: data.thread, messages, files: data.files }, null, 2)], { type: 'application/json' }), `StykAnimate-report-${this.thread.id.slice(0,8)}.json`); this.notice({messageKey:"supportCenter.conversationExportedAttachmentsCanBeDownloadedSeparately",messageParams:{}});
    } catch (error) { this.notice(supportErrorMessage(error), true); } finally { this.setBusy(false); }
  }
  async accessPanel() {
    this.$('.sc-access').open = false;
    const mount = this.$('[data-recovery]'); mount.hidden = false; mount.className = 'sc-recovery'; replaceLocalized(mount);
    appendLocalized(mount, translatedElement(el('h3', {messageKey:"supportCenter.saveYourInbox",messageParams:{}}), "supportCenter.saveYourInbox", {}), translatedElement(el('p', {messageKey:"supportCenter.anyoneWithThisLinkCanOpenYourReports",messageParams:{}}, 'sc-small'), "supportCenter.anyoneWithThisLinkCanOpenYourReports", {}));
    appendLocalized(mount, translatedElement(button(interfaceText("supportCenter.copyPrivateAccessLink"), async () => { try { await this.copyAccess(); this.notice({messageKey:"supportCenter.privateAccessLinkCopiedKeepItSomewhereSafe",messageParams:{}}); } catch { this.notice({messageKey:"supportCenter.theLinkCouldNotBeCopiedPleaseEnable",messageParams:{}}, true); } }, 'sc-primary'), "supportCenter.copyPrivateAccessLink", {}), translatedElement(button(interfaceText("common.done"), () => mount.hidden = true, 'sc-quiet'), "common.done", {}));
  }
  restorePanel() {
    if (this.busy) return;
    this.$('.sc-access').open = false;
    const mount = this.$('[data-recovery]'); mount.hidden = false; mount.className = 'sc-recovery';
    localizedMarkup(mount, `<h3 data-i18n="supportCenter.openAnInbox">${messageHTML("supportCenter.openAnInbox", {})}</h3><p class="sc-small" data-i18n="supportCenter.saveYourCurrentAccessLinkBeforeSwitching">${messageHTML("supportCenter.saveYourCurrentAccessLinkBeforeSwitching", {})}</p><form><label>${messageHTML("supportCenter.privateAccessLink", {})}<input name="access" type="password" autocomplete="off" required placeholder="Paste your saved link" data-i18n-placeholder="supportCenter.pasteYourSavedLink"></label><div class="sc-actions"><button class="sc-primary" type="submit" data-i18n="supportCenter.openInbox">${messageHTML("supportCenter.openInbox", {})}</button><button type="button" data-cancel data-i18n="common.cancel">${messageHTML("supportCenter.cancel", {})}</button></div></form>`);
    mount.querySelector('[data-cancel]').onclick = () => mount.hidden = true;
    mount.querySelector('form').onsubmit = async event => {
      event.preventDefault(); if (this.busy) return; const raw = event.target.elements.access.value.trim(); let key = raw;
      if (this.listBusy || this.detailBusy || this.fileLoading) { this.notice({messageKey:"supportCenter.waitForTheCurrentInboxRequestToFinish",messageParams:{}}); return; }
      if (this.pendingFiles.length || this.pendingCreation || this.pendingMessage) { this.notice({messageKey:"supportCenter.sendOrRemoveTheSelectedFilesAndFinish",messageParams:{}}); return; }
      try {
        if (raw.includes('#')) key = new URLSearchParams(new URL(raw).hash.slice(1)).get('key');
        if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error();
        // Save under the old identity before changing the credential or draft namespace.
        this.remember(); this.setBusy(true,{messageKey:'supportCenter.openingInbox'}); this.generation++;
        await this.restoreAccess(key);
        this.resetDetail(false); this.thread = null; this.items = []; this.nextCursor = null; this.drafts = {};
        try { this.drafts = JSON.parse(this.storage?.getItem(this.storageKey) || '{}'); } catch { /* Keep the restored inbox usable without local storage. */ }
        mount.hidden = true; event.target.reset(); this.setBusy(false); this.showCreate(); await this.loadList(); this.notice({messageKey:"supportCenter.privateInboxOpened",messageParams:{}});
      }
      catch { this.notice({messageKey:"supportCenter.thatAccessLinkCouldNotBeOpenedCheck",messageParams:{}}, true); }
      finally { this.setBusy(false); }
    };
  }
  setActive(value) { if (!value) this.hideCardPreview(); this.active = value; if (!value) this.preparing?.abort(); this.schedule(); }
  dispose() { this.hideCardPreview(); this.live.stop(); this.disposed = true; this.generation++; clearTimeout(this.timer); this.preparing?.abort(); this.remember(); for (const url of this.previews) URL.revokeObjectURL(url); this.root.removeEventListener('pointerdown', this.onActivity); this.root.removeEventListener('keydown', this.onActivity); document.removeEventListener('visibilitychange', this.onVisibility); window.removeEventListener('focus', this.onVisibility); window.removeEventListener('beforeunload', this.beforeUnload); }
}

export function createWebSupportApi({ base = '/api/v1/support', getKey } = {}) {
  return async (path, options = {}) => {
    const rawBody = options.body instanceof Blob;
    const response = await fetch(base + path, { method: options.method || "GET", credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(rawBody ? 90000 : 20000),
      headers: { ...(getKey ? { Authorization: `Bearer ${getKey()}` } : {}), ...(options.body == null || rawBody ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(options.body == null ? {} : { body: rawBody ? options.body : JSON.stringify(options.body) }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); const error = restoreMessageError((data.error ? new Error(data.error) : messageError(new Error(''), "errors.supportCenter.serviceUnavailable")), data); error.code = data.error; error.status = response.status; throw error; }
    return options.raw ? response.blob() : response.json();
  };
}
