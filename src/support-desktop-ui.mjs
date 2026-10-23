import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
import {messageHTML, localizedText, appendLocalized, localizedAttribute, localizedMarkup} from './localization-bindings.mjs';

import { SupportCenter } from './support-center.mjs';
import { icon } from './icons.mjs';
export class SupportDesktopUI {
  constructor(bridge) { this.bridge = bridge; }
  /** Opens the private support center: a new report of `category`, or with `view: 'inbox'` the list of reports. */
  async open({ category, view } = {}) {
    if (!this.bridge?.supportRequest) return;
    if (!this.dialog) this.create();
    if (!this.dialog.open) this.dialog.showModal();
    // Every open waits for the center to start, and only the newest one applies its options, so reopening
    // with another type while the first open is still starting never ends on the older type.
    const request = this.request = {};
    if (!this.center && !this.starting) this.starting = this.initialize().catch(() => { localizedText(this.mount, "supportDesktopUi.supportCouldNotBeOpenedCloseThisWindow", {}); }).finally(() => { this.starting = null; });
    if (this.starting) await this.starting;
    if (request !== this.request) return;
    this.center?.setActive(true);
    if (category && !this.center?.thread && !this.center?.files?.length) this.center?.showCreate(category);
    else if (view === 'inbox' && this.center && this.center.root.dataset.view !== 'inbox') this.center.showInbox();
  }
  create() {
    if (!document.querySelector('[data-support-styles]')) {
      // The shared support-center.css, in the legacy cascade layer; features/feedback.css restyles it.
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./styles/support-bridge.css', import.meta.url).href; link.dataset.supportStyles = ''; appendLocalized(document.head, link);
    }
    this.dialog = document.createElement('dialog'); this.dialog.className = 'styk-feedback'; localizedAttribute(this.dialog, 'aria-label', "supportDesktopUi.bugReportsAndFeedback", {});
    localizedMarkup(this.dialog, `<header class="styk-feedback-head"><span class="styk-feedback-badge">${icon('message')}</span><div><h2 data-i18n="supportDesktopUi.feedback">${messageHTML("supportDesktopUi.feedback", {})}</h2><p data-i18n="supportDesktopUi.privateToYouAndTheDeveloper">${messageHTML("supportDesktopUi.privateToYouAndTheDeveloper", {})}</p></div><button type="button" class="styk-feedback-close" aria-label="Close feedback" data-i18n-aria-label="supportDesktopUi.closeFeedback">${icon('x')}</button></header><div class="styk-feedback-body"><p class="styk-feedback-loading" data-i18n="supportDesktopUi.openingYourPrivateInbox">${messageHTML("supportDesktopUi.openingYourPrivateInbox", {})}</p></div>`);
    this.mount = this.dialog.querySelector('.styk-feedback-body'); appendLocalized(document.body, this.dialog);
    this.dialog.querySelector('.styk-feedback-close').onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => this.center?.setActive(false));
    for (const type of ['keydown','keyup','click','pointerdown']) this.dialog.addEventListener(type, event => event.stopPropagation());
  }
  async initialize() {
    const context = await this.bridge.getSupportContext();
    const namespace = value => 'stykanimate.support.drafts.' + value.inboxId;
    const values = new Map(); let activeContext = context, pending = Promise.resolve();
    const seed = value => { activeContext = value; values.set(namespace(value), JSON.stringify(value.drafts || {})); values.set(namespace(value) + '-last', value.lastThread || ''); };
    seed(context);
    const storage = {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => {
        values.set(key, value);
        const state = { inboxId: activeContext.inboxId, drafts: JSON.parse(values.get(namespace(activeContext)) || '{}'), lastThread: values.get(namespace(activeContext) + '-last') || '' };
        pending = pending.catch(() => {}).then(() => this.bridge.saveSupportState(state));
        pending.catch(() => this.center?.notice(interfaceText("supportDesktopUi.draftCouldNotBeSavedOnThisDevice"), true));
      },
    };
    const api = async (path, options = {}) => {
      const input = { path, method: options.method || "GET" };
      if (options.headers?.['X-Support-Auto'] === '1') input.automatic = true;
      if (options.body instanceof Blob) { input.bytes = new Uint8Array(await options.body.arrayBuffer()); input.fileName = decodeURIComponent(options.headers['X-File-Name']); }
      else if (options.body != null) input.body = options.body;
      const result = await this.bridge.supportRequest(input);
      if (!result.ok) { const error = new Error(result.error); error.code = result.error; error.status = result.status; throw error; }
      return options.raw ? new Blob([result.bytes], { type: result.type }) : result.value;
    };
    this.center = new SupportCenter(this.mount, { api, context, storage, storageKey: namespace(context),
      subscribeLive: async (id, event) => {
        const remove = this.bridge.onSupportLive(value => { if (value.threadId === id) event(value.type); });
        try {
          const result = await this.bridge.connectSupportLive(id);
          if (!result.available) { const error = (result.error ? new Error(result.error) : messageError(new Error(''), "errors.supportDesktopUi.liveUnavailable")); error.code = result.error || 'live_unavailable'; error.status = result.status; throw error; }
          return () => { remove(); void this.bridge.disconnectSupportLive(result.connection); };
        } catch (error) { remove(); throw error; }
      },
      onThreadOpen: id => { try { storage?.setItem(this.center.storageKey + '-last', id); } catch { /* Session remains usable. */ } },
      copyAccess: () => this.bridge.copySupportAccess(), restoreAccess: async key => { await pending; await this.bridge.restoreSupportAccess(key); const restored = await this.bridge.getSupportContext(); seed(restored); this.center.storageKey = namespace(restored); },
      downloadFile: (threadId, fileId) => this.bridge.downloadSupportFile({ threadId, fileId }),
    });
    await this.center.start();
    let last; try { last = storage?.getItem(this.center.storageKey + '-last'); } catch { /* Storage unavailable. */ }
    if (!this.center.drafts.create?.title && !this.center.drafts.create?.description && this.center.items.some(item => item.id === last)) await this.center.openThread(last);
  }
}
