import {presentError, errorText} from './error-presentation.mjs';
import {clearTranslation, replaceLocalized, messageHTML, appendLocalized, localizedMarkup, localizedText, localizedAttribute} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
import english from './locales/en.mjs';

import {getVfwCapabilities, configureVfwCodec} from './vfw-video-export.mjs';
import {EXPORT_MAX_PIXELS} from './export-sampling.mjs';
import {icon} from './icons.mjs';

/* The export dialog's Encoding rows for Windows AVI (installed codecs): Codec
 * with Configure…, Quality, Keyframes and Rate, in the dialog kit's rows
 * (features/export.css). Shown only in the Windows app. */
const markup = `<div class="ui-dialog-row"><label class="ui-row-label" for="export-vfw-codec" data-i18n="vfwExportControls.codec">${messageHTML("vfwExportControls.codec", {})}</label><span class="export-inline"><span class="ui-select"><select id="export-vfw-codec" aria-label="Installed Windows AVI codec" disabled data-i18n-aria-label="vfwExportControls.installedWindowsAviCodec"><option data-i18n="vfwExportControls.checkingInstalledCodecs">${messageHTML("vfwExportControls.checkingInstalledCodecs", {})}</option></select>${icon('chevron-down')}</span><button id="export-vfw-configure" class="ui-button" data-variant="outline" data-size="sm" type="button" aria-haspopup="dialog" disabled data-i18n="vfwExportControls.configure">${messageHTML("vfwExportControls.configure", {})}</button></span></div>
<div class="ui-dialog-row"><label class="ui-row-label" for="export-vfw-quality" data-i18n="vfwExportControls.quality">${messageHTML("vfwExportControls.quality", {})}</label><span class="ui-field"><input class="ui-field-input" id="export-vfw-quality" type="number" min="0" max="100" step="1" value="90" disabled><span class="ui-field-unit">%</span></span></div>
<div class="ui-dialog-row"><label class="ui-row-label" for="export-vfw-keyframes" data-i18n="vfwExportControls.keyframes">${messageHTML("vfwExportControls.keyframes", {})}</label><span class="ui-field" title="0 uses the codec default" data-i18n-title="vfwExportControls.message0UsesTheCodecDefault"><span class="ui-field-label" data-i18n="vfwExportControls.every">${messageHTML("vfwExportControls.every", {})}</span><input class="ui-field-input" id="export-vfw-keyframes" type="number" min="0" max="1000000" step="1" value="0" disabled><span class="ui-field-unit" data-i18n="vfwExportControls.frames">frames</span></span></div>
<div class="ui-dialog-row"><label class="ui-row-label" for="export-vfw-bitrate" data-i18n="vfwExportControls.rate">${messageHTML("vfwExportControls.rate", {})}</label><span class="ui-field" title="0 uses the codec default" data-i18n-title="vfwExportControls.message0UsesTheCodecDefault"><input class="ui-field-input" id="export-vfw-bitrate" type="number" min="0" max="200" step="0.1" value="0" disabled><span class="ui-field-unit" data-i18n="vfwExportControls.mbitS">${messageHTML("vfwExportControls.mbitS", {})}</span></span></div>
<p class="export-note vfw-status" role="status"><span class="vfw-status-text"></span> <span class="vfw-config-state"></span></p>`;
const numeric = (element, min, max, labelKey, whole = false) => {
  if (!element.value.trim()) throw messageError(new Error(''), "errors.exportRequest.enter", {value:{messageKey:labelKey,diagnosticValue:english[labelKey].toLowerCase()}});
  const value = Number(element.value);
  if (!Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value)))
    throw messageError(new Error(''), "errors.exportRequest.mustBeFromTo", {label:{messageKey:labelKey,diagnosticValue:english[labelKey]}, value:whole ? {messageKey:'vfwExportControls.aWholeNumber',diagnosticValue:english['vfwExportControls.aWholeNumber']} : '', min, max});
  return value;
};

/**
 * Dialog-local controls. No observers, polling, or listeners survive dispose.
 * `listed` says whether installed codecs exist here (the Windows app);
 * `ready` whether the chosen codec was checked for the current size and no
 * codec settings dialog is open, with `reason` saying why not. `onChange`
 * runs whenever those change. A `button` (optional) mirrors them the way
 * today's export tile did: hidden when not listed, disabled when not ready or
 * when `canExport()` is false.
 */
export class VfwExportControls {
  constructor({container, button = null, dialog, getDimensions, canExport = () => true, onError = () => {}, onChange = () => {}}) {
    this.container = container; this.button = button; this.dialog = dialog; this.getDimensions = getDimensions; this.canExport = canExport; this.onError = onError; this.onChangeCallback = onChange;
    this.generation = 0; this.disposed = false; this.configurations = new Map(); this.codecs = []; this.loadedKey = null;
    this.ready = false; this.reason = '';
    this.element = document.createElement('div'); this.element.className = 'vfw-export-controls'; appendLocalized(container, this.element);
    this.listed = Boolean(globalThis.stykDesktop?.getVfwCapabilities); this.element.hidden = !this.listed;
    if (this.button) this.button.hidden = !this.listed;
    if (!this.listed) return;
    localizedMarkup(this.element, markup);
    this.select = this.element.querySelector('#export-vfw-codec'); this.quality = this.element.querySelector('#export-vfw-quality'); this.keyframes = this.element.querySelector('#export-vfw-keyframes'); this.bitrate = this.element.querySelector('#export-vfw-bitrate'); this.configureButton = this.element.querySelector('#export-vfw-configure'); this.status = this.element.querySelector('.vfw-status-text'); this.configStatus = this.element.querySelector('.vfw-config-state');
    this.onChange = () => this._selection(); this.onConfigure = () => this.configure().catch(error => { if (!this.disposed) this.onError(error); });
    this.onInput = () => this.sizeChanged();
    this.onClose = () => { if (!dialog.open || !this.element.isConnected) this.dispose(); };
    this.select.addEventListener('change', this.onChange); this.configureButton.addEventListener('click', this.onConfigure); dialog.addEventListener('input', this.onInput); dialog.addEventListener('close', this.onClose);
    this.refresh();
  }
  /** The export size may have changed (typed, or a size preset): check the codecs again once it settles. */
  sizeChanged() {
    if (this.disposed || !this.listed) return;
    const key = this._currentKey(); clearTimeout(this.timer);
    if (key === this.requestedKey) { this._selection(); return; }
    this._setReady(false, interfaceText("vfwExportControls.checkingInstalledWindowsCodecs"), "vfwExportControls.checkingInstalledWindowsCodecs"); this.configureButton.disabled = true; this.timer = setTimeout(() => this.refresh(), 150);
  }
  _setReady(ready, reason, reasonKey, reasonParams) {
    const next = ready ? '' : reason, changed = ready !== this.ready || next !== this.reason || this.select?.value !== this.notifiedCodec;
    this.ready = ready; this.reason = next; this.reasonKey = ready ? undefined : reasonKey; this.reasonParams = reasonParams; this.notifiedCodec = this.select?.value;
    if (this.button) this.button.disabled = !ready || !this.canExport();
    // Only a change in what an export needs (ready, why not, the codec) is news; typing in a field is not.
    if (changed) this.onChangeCallback();
  }
  _setStatus(text, messageKey, messageParams) { if (text?.messageKey) presentError(this.status,text); else if (messageKey) localizedText(this.status,messageKey,messageParams); else {clearTranslation(this.status); this.status.textContent=text;} }
  _size() {
    const size = this.getDimensions();
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384 || size.width * size.height > EXPORT_MAX_PIXELS) throw messageError(new Error(''), "errors.vfwExportControls.chooseValidVideoDimensionsUpToMillionPixels", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)});
    return {width: size.width, height: size.height};
  }
  _currentKey() { try { const size = this._size(); return `${size.width}:${size.height}`; } catch { return null; } }
  _configurationKey() { return `${this.select?.value}|${this.loadedKey}`; }
  async refresh() {
    if (this.disposed || this.element.hidden) return;
    clearTimeout(this.timer); const generation = ++this.generation; let size;
    this.select.disabled = true; this.configureButton.disabled = true; this._setStatus(interfaceText("vfwExportControls.checkingInstalledWindowsCodecs"), "vfwExportControls.checkingInstalledWindowsCodecs"); this._setReady(false, interfaceText("vfwExportControls.checkingInstalledWindowsCodecs"), "vfwExportControls.checkingInstalledWindowsCodecs");
    try {
      size = this._size(); this.requestedKey = `${size.width}:${size.height}`;
      const key = this.requestedKey, previous = this.select.value, result = await getVfwCapabilities(size);
      if (this.disposed || generation !== this.generation || this._currentKey() !== key) return;
      if (result.platform && result.platform !== 'win32') { this.element.hidden = true; this.listed = false; if (this.button) this.button.hidden = true; this._setReady(false, interfaceText("vfwExportControls.installedWindowsCodecsAreUnavailableInThisApp")); return; }
      this.loadedKey = key; this.codecs = result.codecs ?? []; replaceLocalized(this.select);
      for (const codec of this.codecs) { const option = document.createElement('option'); option.value = codec.id; option.textContent = codec.label; option.disabled = !codec.supported; option.title = codec.reason || `${codec.fourcc} · ${codec.provider}`; if(codec.reasonKey) localizedAttribute(option,'title',codec.reasonKey,codec.reasonParams); appendLocalized(this.select, option); }
      const selected = this.codecs.find(codec => codec.id === previous && codec.supported) ?? this.codecs.find(codec => codec.supported && codec.kind === 'installed') ?? this.codecs.find(codec => codec.supported);
      if (!selected) { const option = document.createElement('option'); option.value = ''; localizedText(option, "vfwExportControls.noCompatibleCodec", {}); appendLocalized(this.select, option); this.select.value = ''; const reasonKey=result.reasonKey ?? (!result.reason ? 'vfwExportControls.noInstalledCodecAcceptsThisCanvasSize' : undefined),reason = result.reason || interfaceText("vfwExportControls.noInstalledCodecAcceptsThisCanvasSize"); this._setStatus(reason,reasonKey,result.reasonParams); this._setReady(false,reason,reasonKey,result.reasonParams); return; }
      this.select.value = selected.id; this.select.disabled = false; this._selection();
    } catch (error) { if (!this.disposed && generation === this.generation) { this.loadedKey = null; this._setStatus(error); this._setReady(false, errorText(error), error.messageKey, error.messageParams); } }
  }
  _selection() {
    if (this.disposed) return; const codec = this.codecs.find(codec => codec.id === this.select.value), ready = Boolean(codec?.supported && this.loadedKey === this._currentKey());
    this.configureButton.disabled = !ready || !codec?.configure || this.configuring;
    this.quality.disabled = !ready || !codec?.quality; this.keyframes.disabled = !ready || !codec?.keyframes; this.bitrate.disabled = !ready || !codec?.dataRate;
    this.configStatus.textContent = this.configurations.has(this._configurationKey()) ? interfaceText("vfwExportControls.customCodecSettings") : '';
    if (ready) {
      const [width,height] = this.loadedKey.split(':').map(Number);
      localizedText(this.status, 'vfwExportControls.codecReady', {fourcc:codec.fourcc, bits:codec.arch==='x86'?32:64, kind:{messageKey:codec.kind==='uncompressed'?'vfwExportControls.nativeUncompressedAvi':'vfwExportControls.installedWindowsCodec'},width,height});
    }
    const reason = this.configuring ? interfaceText("vfwExportControls.codecSettingsAreOpen") : codec?.reason || interfaceText("vfwExportControls.waitForTheInstalledCodecCheckOrChoose");
    this._setReady(ready && !this.configuring, reason, this.configuring ? "vfwExportControls.codecSettingsAreOpen" : codec?.reasonKey ?? (!codec?.reason ? "vfwExportControls.waitForTheInstalledCodecCheckOrChoose" : undefined), codec?.reasonParams);
  }
  /** The chosen codec's label ("Cinepak"), for the Encoding summary; '' before the check. */
  get codecLabel() { return this.codecs.find(codec => codec.id === this.select?.value)?.label ?? ''; }
  /** The typed values, as an ExportRequest's `vfw` (export-request.mjs). */
  fields() {
    if (!this.listed || this.disposed) return null;
    return {codecId: this.select.value, quality: this.quality.value, keyframes: this.keyframes.value, bitrateMbps: this.bitrate.value, configurationId: this.configurations.get(this._configurationKey())};
  }
  getOptions() {
    if (this.disposed || this.element.hidden) throw messageError(new Error(''), "errors.exportRequest.installedWindowsCodecsAreUnavailableInThisApp", {});
    const codec = this.codecs.find(codec => codec.id === this.select.value);
    if (!codec?.supported || this.loadedKey !== this._currentKey() || this.configuring) throw messageError(new Error(''), "errors.exportRequest.waitForTheInstalledCodecCheckOrChoose", {});
    return {codecId: codec.id, quality: codec.quality ? numeric(this.quality, 0, 100, "vfwExportControls.quality") / 100 : .9,
      keyframeEvery: codec.keyframes ? numeric(this.keyframes, 0, 1000000, "vfwExportControls.keyframeInterval", true) : 0,
      bitrate: codec.dataRate ? Math.round(numeric(this.bitrate, 0, 200, "vfwExportControls.bitrate") * 1000000) : 0,
      configurationId: this.configurations.get(this._configurationKey())};
  }
  /**
   * What an ExportRequest's Windows AVI export needs (export-request.mjs
   * vfwEncodeOptions, which derives exactly what getOptions returns): whether
   * installed codecs are available here, the chosen codec's capability,
   * whether it is ready (checked for the current size, no codec settings
   * dialog open) and the settings chosen with Configure codec… for this size.
   */
  requestContext() {
    if (this.disposed || this.element.hidden) return {available: false};
    return {available: true, codec: this.codecs.find(codec => codec.id === this.select.value) ?? null,
      ready: this.loadedKey === this._currentKey() && !this.configuring, configurationId: this.configurations.get(this._configurationKey())};
  }
  async configure() {
    const options = this.getOptions(), size = this._size(), key = this._configurationKey(), codec = this.codecs.find(codec => codec.id === options.codecId);
    if (!codec?.configure) return;
    this.configuring = true; this._selection(); localizedText(this.configStatus, "vfwExportControls.codecSettingsAreOpen", {});
    try {
      const result = await configureVfwCodec({codecId: options.codecId, ...size, configurationId: options.configurationId});
      if (!this.disposed && result?.configurationId) this.configurations.set(key, result.configurationId);
    } finally { this.configuring = false; if (!this.disposed) this._selection(); }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.generation++; clearTimeout(this.timer);
    this.select?.removeEventListener('change', this.onChange); this.configureButton?.removeEventListener('click', this.onConfigure); this.dialog.removeEventListener('input', this.onInput); this.dialog.removeEventListener('close', this.onClose); this.configurations.clear();
  }
}
