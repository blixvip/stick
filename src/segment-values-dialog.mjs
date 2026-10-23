import {presentError} from './error-presentation.mjs';
import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';

import {appendLocalized, localizedMarkup, messageAttributes, messageHTML, localizedText} from './localization-bindings.mjs';
import { PropertyControls, formatPropertyValue } from "./property-controls.mjs";
import {
  parseSegmentValues,
  formatSegmentValues,
} from "./editor-handle-commands.mjs";
import { icon } from "./icons.mjs";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const keys = ["angle", "bend", "length"];
const CSS = `
dialog.segment-values-dialog{width:min(380px,calc(100vw - 32px));max-width:380px}
.segment-values-dialog .dialog-head{border-bottom:1px solid var(--theme-border, #e5e5e5);padding:15px 18px}
.segment-values-dialog .dialog-head h2{font-size:13px}
.segment-values-dialog .dialog-body{padding:16px 18px}
.segment-values-caption{font-size:11px;color:var(--theme-muted, #767676);margin:0 0 14px}
.segment-values-fields{display:grid;gap:9px}
.segment-values-fields .field{min-height:36px;background:var(--theme-field, #f5f5f5);display:flex;align-items:center;border:1px solid transparent;border-radius:5px;padding:0 9px!important;gap:8px!important}
.segment-values-fields .field:focus-within{border-color:var(--theme-accent, #0d99ff);background:var(--theme-panel, #fff)}
.segment-values-fields .property-scrub{font-size:11px!important;min-width:64px}
.segment-values-fields input{background:transparent;flex:1;width:0;font:12px inherit;border:0;outline:none;padding:8px 0;appearance:textfield;text-align:right}
.segment-values-fields small{font-size:10px;color:var(--theme-muted, #999);min-width:17px;text-align:right}
.segment-values-relative{display:flex;gap:7px;align-items:center;font-size:11px;margin:15px 0 8px}
.segment-values-relative input{accent-color:#0d99ff;margin:0}
.segment-values-help{font-size:10px!important;line-height:1.5;margin:0 0 15px}
.segment-values-clipboard-tools{display:flex;gap:7px}.segment-values-clipboard-tools .button{flex:1;font-size:11px;justify-content:center}
.segment-values-dialog .form-error{font-size:11px;margin:10px 0 0;line-height:1.4}
.segment-values-dialog [hidden]{display:none!important}
#segment-values-status{font-size:10px;min-height:14px;margin:8px 0 0}
.segment-clipboard-fallback{margin-top:12px;display:grid;gap:7px}
.segment-clipboard-fallback label{font-size:11px}
#segment-clipboard-input{width:100%;box-sizing:border-box;border:1px solid var(--theme-border, #ddd);border-radius:4px;padding:8px;font:12px inherit;min-height:52px;resize:vertical}
.segment-clipboard-fallback .button{justify-self:end;font-size:11px}
.segment-values-dialog .dialog-actions{border-top:1px solid var(--theme-border, #e5e5e5);margin:0;padding:12px 18px}
`;

/** One native model gesture spans this dialog. Field gestures only update its preview. */
export class SegmentValuesDialog {
  constructor({
    dialog,
    content,
    editor,
    clipboard = globalThis.navigator?.clipboard,
    onClose = () => {},
    onError = () => {},
  }) {
    Object.assign(this, {
      dialog,
      content,
      editor,
      clipboard,
      onClose,
      onError,
    });
    this.relative = false;
    if (!document.getElementById("segment-values-style")) {
      const style = document.createElement("style");
      style.id = "segment-values-style";
      style.textContent = `@layer legacy{${CSS}}`;
      appendLocalized(document.head, style);
    }
  }
  open({ relative = this.relative, editMode = false, isolate = false } = {}) {
    if (this.session) this.cancel();
    const editor = this.editor,
      segment = editor.figure?.segments[editor.selectedJoint];
    if (!segment)
      throw messageError(new Error(''), "errors.segmentValuesDialog.selectASegmentHandleToEditItsValues", {});
    if (editor.dragging)
      throw messageError(new Error(''), "errors.segmentValuesDialog.finishTheCurrentGestureBeforeEditingSegmentValues", {});
    this.relative = Boolean(relative);
    this.options = { relative: this.relative, editMode, isolate };
    if (!editor.beginSegmentValueEdit(this.options))
      throw messageError(new Error(''), "errors.segmentValuesDialog.thisSegmentCannotBeEdited", {});
    this.session = {
      drag: editor._drag,
      report: editor.report,
      uid: editor.selectedUid,
      joint: editor.selectedJoint,
      frame: editor.frameIndex,
      tick: editor.tick,
    };
    this.events = new AbortController();
    const signal = this.events.signal;
    this.dialog.classList.add("segment-values-dialog");
    localizedMarkup(this.content, `<div class="dialog-head"><h2 data-i18n="segmentValuesDialog.segmentValues">Segment values</h2><button class="icon-button" data-segment-close aria-label="Close segment values" data-i18n-aria-label="segmentValuesDialog.closeSegmentValues">${icon("close")}</button></div>
      <div class="dialog-body"><p class="segment-values-caption" ${messageAttributes("segmentValuesDialog.segment", {value: editor.figure.name || interfaceText("segmentValuesDialog.figure"), segment_id: segment.segment_id, value2: editMode ? {messageKey: "segmentValuesDialog.handleEdit"} : ""})}>${esc(editor.figure.name || interfaceText("segmentValuesDialog.figure"))} · Segment ${segment.segment_id}${editMode ? interfaceText("segmentValuesDialog.handleEdit") : ""}</p>
      <div class="segment-values-fields">${keys.map((key) => `<div class="property-row" data-property-row="${key}"><label class="field"><span class="property-scrub" data-property-scrub tabindex="0" role="button" aria-label="Scrub segment ${key}" ${messageAttributes("segmentValuesDialog.scrubSegment", {key:{messageKey:"inspectorView."+key}}, "aria-label")}><span ${messageAttributes("inspectorView."+key)}>${interfaceText("inspectorView."+key)}</span></span><input id="segment-${key}" type="number" step="any" data-property="${key}" data-property-step="1" data-property-precision="3" ${key === "length" ? 'min="1.401298464324817e-45"' : ""} aria-label="Segment ${key}" ${messageAttributes("segmentValuesDialog.segment2", {key:{messageKey:"inspectorView."+key}}, "aria-label")}><small>${key === "length" ? "px" : "°"}</small></label></div>`).join("")}</div>
      <label class="segment-values-relative"><input id="segment-relative" type="checkbox" ${this.relative ? "checked" : ""}>${messageHTML("segmentValuesDialog.relativeAngle", {})}</label>
      <p class="segment-values-help" id="segment-values-reference"></p>
      <div class="segment-values-clipboard-tools"><button class="button" id="segment-values-copy">${icon("copy")}${messageHTML("segmentValuesDialog.copyValues", {})}</button><button class="button" id="segment-values-paste">${icon("clipboard")}${messageHTML("segmentValuesDialog.pasteValues", {})}</button></div>
      <p id="segment-values-status" role="status"></p><p id="segment-values-error" class="form-error" role="alert" hidden></p>
      <div class="segment-clipboard-fallback" id="segment-clipboard-fallback" hidden><label for="segment-clipboard-input" data-i18n="segmentValuesDialog.angleBendLength">Angle : Bend : Length</label><textarea id="segment-clipboard-input" maxlength="100" spellcheck="false" placeholder="30:-15:42.5"></textarea><button class="button" id="segment-clipboard-use" data-i18n="segmentValuesDialog.useValues">Use values</button></div></div>
      <div class="dialog-actions"><button class="button" id="segment-values-cancel" data-i18n="segmentValuesDialog.cancel">Cancel</button><button class="button primary" id="segment-values-apply" data-i18n="segmentValuesDialog.apply">Apply</button></div>`);
    this.$ = (id) => this.content.querySelector("#" + id);
    this.sync();
    // This observer runs before the delegated controller consumes the input.
    this.content.addEventListener(
      "input",
      (event) => {
        if (event.target.matches("input[data-property]"))
          this.$("segment-values-apply").disabled =
            !Number.isFinite(event.target.valueAsNumber) ||
            !event.target.validity.valid;
      },
      { capture: true, signal },
    );
    this.controls = new PropertyControls(this.content, {
      canHandle: (key) => keys.includes(key),
      getValue: (key) => this.values()[key],
      begin: ({ key }) => ({ key, value: this.values()[key] }),
      preview: ({ key, value }) => this.preview({ [key]: value }),
      commit: () => {},
      cancel: ({ token }) => {
        if (token && this.current()) this.preview({ [token.key]: token.value });
      },
      onError: (error) => this.error(error),
    });
    this.content.addEventListener(
      "property-edit-end",
      () => {
        if (this.current()) {
          this.sync();
          this.$("segment-values-apply").disabled = false;
        }
      },
      { signal },
    );
    this.$("segment-relative").addEventListener(
      "change",
      () => {
        this.relative = this.$("segment-relative").checked;
        this.options.relative = this.relative;
        this.sync();
      },
      { signal },
    );
    this.$("segment-values-copy").addEventListener("click", () => this.copy(), {
      signal,
    });
    this.$("segment-values-paste").addEventListener(
      "click",
      () => this.paste(),
      { signal },
    );
    this.$("segment-clipboard-use").addEventListener(
      "click",
      () => this.usePastedText(this.$("segment-clipboard-input").value),
      { signal },
    );
    this.$("segment-values-apply").addEventListener(
      "click",
      () => this.apply(),
      { signal },
    );
    this.$("segment-values-cancel").addEventListener(
      "click",
      () => this.cancel(),
      { signal },
    );
    this.content.addEventListener(
      "click",
      (event) => {
        if (event.target.closest("[data-segment-close]")) this.cancel();
      },
      { signal },
    );
    this.content.addEventListener(
      "keydown",
      (event) => {
        const input = event.target.matches("input,textarea");
        if (
          (event.ctrlKey || event.metaKey) &&
          !input &&
          ["c", "v"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.key.toLowerCase() === "c" ? this.copy() : this.paste();
        }
      },
      { signal },
    );
    this.content.addEventListener(
      "paste",
      (event) => {
        if (event.target.id === "segment-clipboard-input") return;
        const text = event.clipboardData?.getData("text/plain");
        if (text?.includes(":")) {
          event.preventDefault();
          this.finishField();
          this.usePastedText(text);
        }
      },
      { signal },
    );
    this.dialog.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        this.cancel();
      },
      { signal },
    );
    this.dialog.addEventListener("close", () => this.finish(false), { signal });
    if (!this.dialog.open) this.dialog.showModal();
    // Focus a label, rather than auto-selecting a numeric field: Escape then
    // cancels the dialog until the user explicitly starts a field gesture.
    this.content.querySelector("[data-property-scrub]").focus();
    return this;
  }
  current() {
    const s = this.session,
      e = this.editor;
    return Boolean(
      s &&
        e._drag === s.drag &&
        e.report === s.report &&
        e.selectedUid === s.uid &&
        e.selectedJoint === s.joint &&
        e.frameIndex === s.frame &&
        e.tick === s.tick,
    );
  }
  assertCurrent() {
    if (!this.current())
      throw messageError(new Error(''), "errors.segmentValuesDialog.theSelectionChangedReopenSegmentValues", {});
  }
  values() {
    this.assertCurrent();
    return this.editor.segmentValues(this.options);
  }
  sync() {
    const values = this.values();
    for (const key of keys) {
      const input = this.$("segment-" + key);
      input.value = formatPropertyValue(values[key], 3);
      input.dataset.propertyValue = String(values[key]);
      input.removeAttribute("aria-invalid");
      input.setCustomValidity("");
    }
    localizedText(this.$("segment-values-reference"), (this.relative ? "segmentValuesDialog.angleIsMeasuredFromTheIncomingSegmentS" : "segmentValuesDialog.angleIsMeasuredFromTheCanvasXAxis"), (this.relative ? {} : {}));
  }
  preview(values) {
    this.assertCurrent();
    for (const [key, value] of Object.entries(values)) {
      if (
        !Number.isFinite(value) ||
        !Number.isFinite(
          Math.fround(key === "length" ? value : (value * Math.PI) / 180),
        )
      )
        throw messageError(new Error(''), "errors.segmentValuesDialog.enterFiniteValuesSupportedByTheNativeFigure", {});
      if (key === "length" && !(Math.fround(value) > 0))
        throw messageError(new Error(''), "errors.editorHandleCommands.segmentLengthMustBeGreaterThanZero", {});
    }
    this.editor.setSegmentValues(values, this.options);
    this.$("segment-values-error").hidden = true;
  }
  finishField() {
    const active = this.content.ownerDocument.activeElement;
    if (active?.matches("input[data-property]")) active.blur();
  }
  async copy() {
    const signal = this.events.signal;
    try {
      this.finishField();
      const text = formatSegmentValues(this.values());
      this.editor._segmentValuesClipboard = text;
      if (!this.clipboard?.writeText)
        throw messageError(new Error(''), "errors.segmentValuesDialog.clipboardWritingIsUnavailableCopyTheSelectedValues", {});
      await this.clipboard.writeText(text);
      if (!signal.aborted)
        localizedText(this.$("segment-values-status"), "segmentValuesDialog.segmentValuesCopied", {});
    } catch (error) {
      if (!signal.aborted) {
        if (this.current()) {
          this.fallback(formatSegmentValues(this.values()), true);
          this.error(
            messageError(new Error(''), "errors.segmentValuesDialog.copyTheSelectedAngleBendLengthValuesBelow", {}),
          );
        } else this.error(error);
      }
    }
  }
  async paste() {
    const signal = this.events.signal;
    try {
      this.finishField();
      if (!this.clipboard?.readText)
        throw messageError(new Error(''), "errors.segmentValuesDialog.clipboardReadingIsUnavailable", {});
      const text = await this.clipboard.readText();
      if (!signal.aborted) this.usePastedText(text);
    } catch (error) {
      if (!signal.aborted) {
        this.fallback("", false);
        this.error(
          messageError(new Error(''), "errors.segmentValuesDialog.pasteAngleBendLengthBelowToUseClipboard", {}),
        );
      }
    }
  }
  usePastedText(text) {
    try {
      this.finishField();
      const values = parseSegmentValues(text),
        count = Object.keys(values).length;
      if (count) {
        this.preview(values);
        this.sync();
        localizedText(this.$("segment-values-status"), 'counts.pastedValues', {count});
      } else {
        this.$("segment-values-error").hidden = true;
        localizedText(this.$("segment-values-status"), "segmentValuesDialog.noNumericSegmentValuesFoundExistingValuesAre", {});
      }
      return Boolean(count);
    } catch (error) {
      this.error(error);
      return false;
    }
  }
  fallback(text, select) {
    this.$("segment-clipboard-fallback").hidden = false;
    this.$("segment-clipboard-input").value = text;
    this.$("segment-clipboard-input").focus();
    if (select) this.$("segment-clipboard-input").select();
  }
  error(error) {
    if (!this.session) return;
    presentError(this.$("segment-values-error"), error);
    this.$("segment-values-error").hidden = false;
    this.onError(error);
  }
  apply() {
    try {
      this.finishField();
      this.assertCurrent();
      this.controls?.destroy();
      this.controls = null;
      this.editor.commitDrag();
      this.finish(true);
    } catch (error) {
      this.error(error);
    }
  }
  cancel() {
    this.finish(false);
  }
  finish(applied) {
    if (!this.session) return;
    const session = this.session;
    this.controls?.destroy();
    this.controls = null;
    if (!applied && this.editor._drag === session.drag)
      this.editor.cancelDrag();
    this.session = null;
    this.events.abort();
    this.dialog.classList.remove("segment-values-dialog");
    if (this.dialog.open) this.dialog.close();
    this.onClose({ applied });
  }
  destroy() {
    this.finish(false);
  }
}
