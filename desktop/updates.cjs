'use strict';
const { messageError } = require('./localization.cjs');


// Keep the release feed and filesystem access in the main process. The renderer
// receives only status, never installer paths or a configurable download URL.
function updateAvailabilityDetails({ packaged, platform, portable, installed, appImage }) {
  if (!packaged) return {message: 'Updates are available in the installed app. Development copies do not update.', messageKey: 'desktop.updates.developmentUnavailable'};
  if (platform === 'linux') {
    if (!appImage) return {message: 'Run the Linux AppImage to enable automatic updates.', messageKey: 'desktop.updates.linuxAppImageRequired'};
    try { require('./appimage-updater.cjs').writableAppImage(appImage); return {message: ''}; }
    catch { return {message: 'Move the AppImage to a writable folder, such as Applications in your home folder, and reopen it to enable automatic updates.', messageKey: 'desktop.updates.writableAppImageRequired'}; }
  }
  if (platform !== 'win32') return {message: 'Automatic updates require the Windows installer or Linux AppImage.', messageKey: 'desktop.updates.supportedInstallerRequired'};
  if (portable || !installed) return {message: 'Install StykAnimate using the Windows Setup installer to enable automatic updates.', messageKey: 'desktop.updates.windowsSetupRequired'};
  return {message: ''};
}
function updateAvailability(options) { return updateAvailabilityDetails(options).message; }

class UpdateService {
  constructor({ updater, currentVersion, unavailable = '', unavailableMessageKey, onState = () => {} }) {
    this.updater = updater;
    this.onState = onState;
    this.state = { status: unavailable ? 'unavailable' : 'idle', currentVersion, version: null, percent: 0, transferred: 0, total: 0, message: unavailable,
      ...(unavailable && unavailableMessageKey ? {messageKey: unavailableMessageKey} : {}) };
    if (unavailable) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => this.set({ status: 'checking', message: '', percent: 0, transferred: 0, total: 0 }));
    updater.on('update-available', info => this.set({ status: 'downloading', version: info.version, message: '' }));
    updater.on('update-not-available', () => this.set({ status: 'current', version: null, message: '' }));
    updater.on('download-progress', progress => this.set({
      status: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      transferred: Math.max(0, Number(progress.transferred) || 0), total: Math.max(0, Number(progress.total) || 0),
    }));
    updater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version, percent: 100, message: '' }));
    updater.on('error', error => this.fail(error));
  }

  snapshot() { return { ...this.state }; }
  set(next) {
    if (Object.hasOwn(next, 'message') && !Object.hasOwn(next, 'messageKey')) { delete this.state.messageKey; delete this.state.messageParams; }
    Object.assign(this.state, next); this.onState(this.snapshot());
  }
  fail(error) {
    console.warn('Update failed:', error?.message || error);
    this.set({ status: 'error', message: 'The update could not be completed. Check your connection and try again.', messageKey: 'desktop.updates.retryConnection' });
  }

  async check() {
    if (this.busy || ['unavailable', 'ready', 'restarting'].includes(this.state.status)) return this.snapshot();
    this.busy = true;
    this.set({ status: 'checking', message: '', percent: 0, transferred: 0, total: 0 });
    try {
      const result = await this.updater.checkForUpdates();
      if (this.state.status === 'downloading') await this.updater.downloadUpdate(result?.cancellationToken);
      else if (!result && this.state.status === 'checking') throw messageError(new Error(''), 'desktop.updates.errors.updateCheckDidNotRun', {});
    } catch (error) { this.fail(error); }
    finally { this.busy = false; }
    return this.snapshot();
  }

  async restart(prepare, onFailure = () => {}) {
    if (this.state.status !== 'ready' || this.restarting) return false;
    this.restarting = true;
    try {
      // Copy the AppImage asynchronously before the final save/close decision.
      // No long file operation may separate that decision from installation.
      if (this.updater.stageInstall) await this.updater.stageInstall();
      if (!await prepare()) return false;
      this.set({ status: 'restarting' });
      // Install only on this explicit request, then relaunch on either platform.
      this.updater.quitAndInstall(true, true);
      if (this.state.status === 'error') { onFailure(); return false; }
      return true;
    } catch (error) { onFailure(); this.fail(error); return false; }
    finally {
      try { await this.updater.discardStagedInstall?.(); }
      finally { this.restarting = false; }
    }
  }

  start() {
    if (this.state.status === 'unavailable' || this.timer) return;
    this.initialTimer = setTimeout(() => void this.check(), 10000);
    this.timer = setInterval(() => void this.check(), 60 * 60 * 1000);
    this.initialTimer.unref?.(); this.timer.unref?.();
  }
  dispose() { clearTimeout(this.initialTimer); clearInterval(this.timer); }
}

module.exports = { UpdateService, updateAvailability, updateAvailabilityDetails };
