import {descriptorAttributes, messageHTML, messageAttributes, localizedText} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

import {hotkeyLabelMessage,hotkeyCategoryMessages,hotkeyScopeMessages} from './hotkey-labels.mjs';
import { icon } from './icons.mjs';
import { HOTKEY_COMMANDS, DEFAULT_HOTKEYS, eventBinding, formatBinding, findHotkeyConflicts } from './hotkeys.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

/** Shortcut editor owns only its draft and focus; EditorSettings owns persistence. */
export class HotkeySettings {
  constructor(settings) {
    this.settings = settings; this.query = ''; this.recording = null; this.conflict = null; this.message = '';
    settings.dialog.addEventListener('keydown', event => this.keydown(event), true);
    settings.dialog.addEventListener('close', () => this.cancel());
    settings.dialog.addEventListener('click', event => this.click(event));
    settings.dialog.addEventListener('input', event => {
      if (!event.target.matches('[data-hotkey-search]')) return;
      this.query = event.target.value;
      this.filter();
    });
    settings.dialog.addEventListener('focusout', event => {
      if (this.recording && event.target.matches('[data-hotkey-record]')) this.cancel();
    });

  }
  cancel() {
    this.recording = null;
    for (const button of this.settings.content.querySelectorAll('[data-hotkey-record][aria-pressed=true]')) {
      button.setAttribute('aria-pressed', 'false'); button.textContent = button.dataset.label;
    }
  }
  html() {
    this.recording = null;
    const bindings = this.settings.value.hotkeys;
    return `<div class="hotkey-toolbar"><label class="hotkey-search">${icon("search")}<input type="search" data-hotkey-search aria-label="Search shortcuts" placeholder="Search shortcuts…" value="${escape(this.query)}" data-i18n-aria-label="hotkeySettings.searchShortcuts" data-i18n-placeholder="hotkeySettings.searchShortcuts2"></label><button type="button" class="ui-button" data-size="sm" data-hotkey-reset-all>${icon("undo")}${messageHTML("hotkeySettings.resetAll", {})}</button></div>
      <div class="hotkey-status" role="status" aria-live="polite"${descriptorAttributes(this, "message")}>${escape(this.message)}</div><p class="hotkey-empty" data-hotkey-empty hidden data-i18n="hotkeySettings.noShortcutsFound">No shortcuts found.</p>
      ${this.conflict ? `<div class="hotkey-conflict" role="alert">${icon("alert")}<div><p${descriptorAttributes(this.conflict, "message")}>${escape(this.conflict.message)}</p><div><button type="button" class="ui-button" data-size="sm" data-variant="primary" data-hotkey-replace data-i18n="hotkeySettings.replaceConflictingShortcuts">Replace conflicting shortcuts</button><button type="button" class="ui-button" data-size="sm" data-hotkey-cancel data-i18n="hotkeySettings.cancel">Cancel</button></div></div></div>` : ''}
      ${[...new Set(HOTKEY_COMMANDS.map(c => c.category))].map(category => `<section class="styk-settings-group hotkey-group"><h4 ${messageAttributes(hotkeyCategoryMessages[category].key)}>${escape(interfaceText(hotkeyCategoryMessages[category].key))}</h4><div class="styk-settings-card styk-settings-shortcuts-list">${HOTKEY_COMMANDS.filter(c => c.category === category).map(command => {
        const keys = bindings[command.id],ref=hotkeyLabelMessage(command.id),label=interfaceText(ref.key,ref.params),labelRef={messageKey:ref.key,messageParams:ref.params},scope=hotkeyScopeMessages[command.scope];
        return `<div class="hotkey-row" data-hotkey-id="${command.id}"><div class="hotkey-name"><span ${messageAttributes(ref.key,ref.params)}>${escape(label)}</span><small ${messageAttributes(scope.key)}>${escape(interfaceText(scope.key))}</small></div><div class="hotkey-bindings">${keys.map((key, index) => `<span class="hotkey-binding"><button type="button" data-hotkey-record="${index}" data-label="${escape(formatBinding(key))}" aria-pressed="false" aria-label="Change ${escape(label)}: ${escape(formatBinding(key))}" ${messageAttributes("hotkeySettings.change", {label: labelRef, value: formatBinding(key)}, "aria-label")}>${escape(formatBinding(key))}</button><button type="button" data-hotkey-remove="${index}" aria-label="Remove ${escape(label)}: ${escape(formatBinding(key))}" ${messageAttributes("hotkeySettings.remove", {label: labelRef, value: formatBinding(key)}, "aria-label")}>${icon("x")}</button></span>`).join('')}${!keys.length ? `<small class="hotkey-unassigned" data-i18n="hotkeySettings.unassigned">Unassigned</small>` : ''}${keys.length < 4 ? `<button type="button" class="hotkey-add" data-hotkey-record="${keys.length}" data-label="+" aria-pressed="false" aria-label="Add shortcut for ${escape(label)}" ${messageAttributes("hotkeySettings.addShortcutFor", {label: labelRef}, "aria-label")}>+</button>` : ''}<button type="button" class="hotkey-reset" data-hotkey-reset title="Reset ${escape(label)}" aria-label="Reset ${escape(label)}" ${messageAttributes("hotkeySettings.resetShortcut",{label:labelRef},"title")} ${messageAttributes("hotkeySettings.resetShortcut",{label:labelRef},"aria-label")}>${icon("undo")}</button></div></div>`;
      }).join('')}</div></section>`).join('')}`;
  }
  render(focusId) {
    const top = this.settings.content.scrollTop;
    this.settings.render(); this.filter(); this.settings.content.scrollTop = top;
    if (focusId) this.settings.content.querySelector(`[data-hotkey-id="${focusId}"] [data-hotkey-record]`)?.focus({preventScroll: true});
  }
  filter() {
    const query = this.query.trim().toLowerCase();
    for (const row of this.settings.content.querySelectorAll('.hotkey-row')) row.hidden = !`${row.textContent} ${row.closest('.hotkey-group')?.querySelector('h4')?.textContent??''}`.toLowerCase().includes(query);
    for (const group of this.settings.content.querySelectorAll('.hotkey-group')) group.hidden = !group.querySelector('.hotkey-row:not([hidden])');
    const empty = this.settings.content.querySelector('[data-hotkey-empty]');
    if (empty) empty.hidden = Boolean(this.settings.content.querySelector('.hotkey-row:not([hidden])'));
  }
  click(event) {
    const button = event.target.closest('button'); if (!button) return;
    const id = button.closest('[data-hotkey-id]')?.dataset.hotkeyId;
    if (button.hasAttribute('data-hotkey-record')) {
      this.cancel(); this.conflict = null;
      this.recording = {id, index: Number(button.dataset.hotkeyRecord)};
      button.setAttribute('aria-pressed', 'true'); localizedText(button, "hotkeySettings.pressKeys", {}); button.focus();
    } else if (button.hasAttribute('data-hotkey-remove')) {
      const keys = [...this.settings.value.hotkeys[id]]; keys.splice(Number(button.dataset.hotkeyRemove), 1); this.assign(id, keys);
    } else if (button.hasAttribute('data-hotkey-reset')) this.assign(id, [...DEFAULT_HOTKEYS[id]]);
    else if (button.hasAttribute('data-hotkey-reset-all')) { this.conflict = null; this.settings.commit({hotkeys: DEFAULT_HOTKEYS}); this.messageKey="hotkeySettings.allShortcutsRestoredToDefaults";this.messageParams={};this.message = interfaceText(this.messageKey); this.render(); }
    else if (button.hasAttribute('data-hotkey-replace') && this.conflict) this.assign(this.conflict.id, this.conflict.keys, true);
    else if (button.hasAttribute('data-hotkey-cancel')) { this.conflict = null; this.render(); }
    else if (button.hasAttribute('data-tab')) { this.cancel(); this.conflict = null; }
  }
  keydown(event) {
    if (!this.recording) return;
    if (event.key === 'Tab') { this.cancel(); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') { this.cancel(); return; }
    if (event.repeat) return;
    const binding = eventBinding(event); if (!binding) return;
    const {id, index} = this.recording, keys = [...this.settings.value.hotkeys[id]];
    keys[index] = binding; this.cancel(); this.assign(id, [...new Set(keys)]);
  }
  assign(id, keys, replace = false) {
    const next = {...this.settings.value.hotkeys};
    const conflicts = [...new Set(keys.flatMap(key => findHotkeyConflicts(next, id, key)))];
    if (conflicts.length && !replace) {
      const value={format:'list',value:conflicts.map(command=>{const ref=hotkeyLabelMessage(command.id);return {messageKey:ref.key,messageParams:ref.params};}),options:{style:'short',type:'conjunction'}};
      this.conflict = {id, keys, message: interfaceText("hotkeySettings.alreadyAssignedInThisContextReplaceThoseBindings", {value}), messageKey: "hotkeySettings.alreadyAssignedInThisContextReplaceThoseBindings", messageParams: {value}};
      this.render();
      this.settings.content.scrollTop = 0;
      this.settings.content.querySelector('[data-hotkey-cancel]')?.focus({preventScroll:true});
      return;
    }
    for (const command of conflicts) next[command.id] = next[command.id].filter(key => !keys.some(candidate => findHotkeyConflicts({[command.id]: [key]}, id, candidate).some(c => c.id === command.id)));
    next[id] = keys; this.conflict = null;
    this.settings.commit({hotkeys: next});
    const ref=hotkeyLabelMessage(id);
    this.messageKey='hotkeySettings.assignmentSummary';this.messageParams={label:{messageKey:ref.key,messageParams:ref.params},bindings:keys.length?keys.map(k=>formatBinding(k)).join(' / '):{messageKey:'hotkeySettings.unassigned'}};
    this.message=interfaceText(this.messageKey,this.messageParams);
    this.render(id);
  }
}
