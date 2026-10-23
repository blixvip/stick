'use strict';
const { messageError } = require('./localization.cjs');


const fs = require('node:fs');
const path = require('node:path');
const { AppImageUpdater } = require('electron-updater');

function writableAppImage(file) {
  const destination = fs.realpathSync(file);
  if (!fs.statSync(destination).isFile()) throw messageError(new Error(''), 'desktop.appimageUpdater.errors.theAppImageIsNotAFile', {});
  fs.accessSync(destination, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  fs.accessSync(path.dirname(destination), fs.constants.W_OK | fs.constants.X_OK);
  return destination;
}

// Keep electron-updater's provider, differential downloads, checksum validation
// and cache. Its 6.6.2 AppImage installer unlinks the old file before moving the
// download, and renames versioned filenames, breaking existing desktop entries.
// Stage beside the real target instead, then atomically replace that exact path.
class LinuxAppImageUpdater extends AppImageUpdater {
  constructor({ appImage = process.env.APPIMAGE, electronApp = require('electron').app, adapter,
    spawn = require('node:child_process').spawn } = {}) {
    super(undefined, adapter);
    this.appImage = appImage;
    this.electronApp = electronApp;
    this.spawn = spawn;
  }

  async stageInstall() {
    await this.discardStagedInstall();
    if (!this.installerPath || !this.downloadedUpdateHelper?.downloadedFileInfo) throw messageError(new Error(''), 'desktop.appimageUpdater.errors.noVerifiedAppImageUpdateIsAvailable', {});
    const destination = writableAppImage(this.appImage);
    const original = fs.statSync(destination);
    const directory = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.stykanimate-update-'));
    this.stagedInstall = { directory, file: path.join(directory, 'update.AppImage'), destination, original };
    try {
      await fs.promises.copyFile(this.installerPath, this.stagedInstall.file, fs.constants.COPYFILE_EXCL);
      const handle = await fs.promises.open(this.stagedInstall.file, 'r+');
      try { await handle.chmod(0o755); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { await this.discardStagedInstall(); throw error; }
  }

  doInstall() {
    const staged = this.stagedInstall;
    if (!staged) throw messageError(new Error(''), 'desktop.appimageUpdater.errors.theAppImageUpdateHasNotBeenStaged', {});
    const destination = writableAppImage(this.appImage);
    const current = fs.statSync(destination);
    if (destination !== staged.destination || current.dev !== staged.original.dev || current.ino !== staged.original.ino ||
        current.size !== staged.original.size || current.mtimeMs !== staged.original.mtimeMs) {
      throw messageError(new Error(''), 'desktop.appimageUpdater.errors.theRunningAppImageChangedRestartItBeforeUpdating', {});
    }
    fs.renameSync(staged.file, destination);
    // Electron's relaunch helper fails under this AppImage runtime. Launch from
    // the final quit event, after releasing the single-instance lock, without
    // depending on an executable or working directory in the old mounted image.
    this.electronApp.once('quit', () => {
      this.electronApp.releaseSingleInstanceLock();
      const env = { ...process.env };
      delete env.APPIMAGE_EXIT_AFTER_INSTALL;
      const child = this.spawn(destination, process.argv.slice(1), {
        detached: true, stdio: 'ignore', cwd: path.dirname(destination), env,
      });
      child.on('error', error => this._logger.error(`Could not reopen updated AppImage: ${error.message}`));
      child.unref();
    });
    return true;
  }

  async discardStagedInstall() {
    const staged = this.stagedInstall;
    this.stagedInstall = null;
    if (staged) await fs.promises.rm(staged.directory, { recursive: true, force: true })
      .catch(error => this._logger.warn(`Could not remove staged AppImage: ${error.message}`));
  }
}

module.exports = { LinuxAppImageUpdater, writableAppImage };
