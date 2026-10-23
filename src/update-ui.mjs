import {messageTuple, tupleMessages, clearTranslation, localizedText, messageHTML, localizedAttribute, localizedMarkup, appendLocalized} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';

export class UpdateUI {
  constructor(desktop, { onRestart, document: doc = document } = {}) {
    this.desktop = desktop;
    if (!desktop?.getUpdateState) return;
    this.element = doc.createElement('aside');
    this.element.className = 'update-notice';
    this.element.hidden = true;
    localizedAttribute(this.element, 'aria-label', "updateUi.appUpdate", {});
    localizedMarkup(this.element, `<div class="update-copy" role="status" aria-live="polite"><strong></strong><span></span></div><progress max="100" aria-label="Update download progress" data-i18n-aria-label="updateUi.updateDownloadProgress"></progress><div class="update-actions"><button class="button primary" type="button"></button><button class="button subtle update-dismiss" type="button" aria-label="Dismiss update notice" data-i18n-aria-label="updateUi.dismissUpdateNotice" data-i18n="updateUi.later">${messageHTML("updateUi.later", {})}</button></div>`);
    appendLocalized(doc.body, this.element);
    this.title = this.element.querySelector('strong');
    this.detail = this.element.querySelector('.update-copy span');
    this.progress = this.element.querySelector('progress');
    this.action = this.element.querySelector('.primary');
    this.dismiss = this.element.querySelector('.update-dismiss');
    this.dismiss.onclick = () => { this.dismissed = this.state?.status; this.element.hidden = true; };
    this.action.onclick = async () => {
      this.action.disabled = true;
      try {
        if (this.state.status === 'ready') await onRestart?.();
        else if (this.state.status === 'unavailable') await desktop.openUpdateReleases();
        else await this.check();
      } catch { this.render({ ...this.state, status: 'error', message: interfaceText("updateUi.theUpdateCouldNotBeCompletedPleaseTry"), messageKey: "updateUi.theUpdateCouldNotBeCompletedPleaseTry" }); }
      finally { this.action.disabled = false; }
    };
    let received = false;
    this.unsubscribe = desktop.onUpdateState(state => { received = true; this.render(state); });
    desktop.getUpdateState().then(state => { if (!received) this.render(state); }).catch(() => {});
  }

  async check() {
    if (!this.element) return;
    this.dismissed = null;
    this.manual = true;
    this.render(await this.desktop.getUpdateState());
    this.render(await this.desktop.checkForUpdates());
  }

  render(state) {
    this.state = state;
    const { status, version, currentVersion, message } = state;
    const active = ['downloading', 'ready', 'restarting'].includes(status);
    this.element.hidden = !(active || this.manual || status === 'error') || this.dismissed === status;
    if (status === 'idle') this.element.hidden = true;
    const labels = {
      checking: messageTuple([interfaceText("updateUi.checkingForUpdates"), `Installed version ${currentVersion}`], {1:{key:"updateUi.installedVersion",params:{version:currentVersion}},0: {key: "updateUi.checkingForUpdates", params: {}}}),
      downloading: messageTuple([`Downloading StykAnimate ${version}`, ''], {
        0: {key: 'updateUi.downloadingVersion', params: {version}},
        1: {
          key: state.total ? 'updateUi.downloadingProgressWithSize' : 'updateUi.downloadingProgress',
          params: {
            percent: Math.floor(state.percent || 0),
            transferred: {format: 'number', value: (state.transferred || 0) / 1048576, options: {minimumFractionDigits: 1, maximumFractionDigits: 1}},
            total: {format: 'number', value: (state.total || 0) / 1048576, options: {minimumFractionDigits: 1, maximumFractionDigits: 1}},
          },
        },
      }),
      ready: messageTuple([`StykAnimate ${version} is ready`, interfaceText("updateUi.restartToInstallTheUpdateYouCanSave")], {0:{key:"updateUi.versionReady",params:{version}},1: {key: "updateUi.restartToInstallTheUpdateYouCanSave", params: {}}}),
      restarting: messageTuple([interfaceText("updateUi.restartingStykanimate"), interfaceText("updateUi.installingTheDownloadedUpdate")],{0:{key:"updateUi.restartingStykanimate"},1:{key:"updateUi.installingTheDownloadedUpdate"}}),
      current: messageTuple([interfaceText("updateUi.youReUpToDate"), `StykAnimate ${currentVersion}`], {0: {key: "updateUi.youReUpToDate", params: {}}}),
      unavailable: messageTuple([interfaceText("updateUi.automaticUpdates"), message], {0: {key: "updateUi.automaticUpdates", params: {}}}),
      error: messageTuple([interfaceText("updateUi.updateInterrupted"), message], {0: {key: "updateUi.updateInterrupted", params: {}}}),
    };
    const row=labels[status]||['',''],bindings=tupleMessages(row);
    [this.title,this.detail].forEach((element,index)=>{const binding=bindings[index]||(index===1&&state.messageKey?{key:state.messageKey,params:state.messageParams}:null);if(binding)localizedText(element,binding.key,binding.params);else{clearTranslation(element);element.textContent=row[index]||'';}});
    this.progress.hidden = status !== 'downloading';
    this.progress.value = state.percent || 0;
    this.action.hidden = !['ready', 'error', 'unavailable'].includes(status);
    localizedText(this.action, (status === 'ready' ? "updateUi.restartToUpdate" : (status === 'unavailable' ? "updateUi.openDownloads" : "updateUi.tryAgain")), (status === 'ready' ? {} : (status === 'unavailable' ? {} : {})));
    this.dismiss.hidden = status === 'restarting';
    localizedText(this.dismiss, (status === 'ready' || status === 'downloading' ? "updateUi.later" : "updateUi.dismiss"), (status === 'ready' || status === 'downloading' ? {} : {}));
  }
}
