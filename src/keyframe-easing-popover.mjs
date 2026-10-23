import {presentError} from './error-presentation.mjs';
import {messageError} from './localized-error.mjs';
import {messageHTML, appendLocalized, localizedAttribute, localizedMarkup, localizedText} from './localization-bindings.mjs';

import {icon} from './icons.mjs';
import {createEasingControls} from './keyframe-easing-view.mjs';
import {placeFloating, presentsAsSheet} from './ui/anchor-position.mjs';

const STYLES = `
.styk-easing-popover{position:fixed;inset:auto;margin:0;padding:6px;width:232px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;border:1px solid var(--theme-border, #dce1e7);border-radius:8px;background:var(--theme-panel, #fff);color:var(--theme-text, #333);box-shadow:0 4px 20px var(--theme-shadow, #0002);font:11px Inter,InterFallback,'Segoe UI',sans-serif}
.styk-easing-popover *{box-sizing:border-box}
.styk-easing-popover [hidden]{display:none!important}
.styk-easing-header{display:flex;align-items:center;justify-content:space-between;padding:1px 5px 5px;color:var(--theme-muted, #77808c);font-size:10px}
.styk-easing-header button{border:0;background:none;color:var(--theme-muted, #77808c);font-size:17px;padding:0 3px;cursor:pointer}
.styk-easing-options{display:grid;gap:1px}
.styk-easing-options button{display:flex;align-items:center;justify-content:space-between;width:100%;height:28px;border:0;border-radius:4px;padding:0 9px;background:var(--theme-panel, #fff);color:var(--theme-secondary, #454b55);text-align:left;cursor:pointer;font:inherit}
.styk-easing-options button:hover,.styk-easing-options button:focus-visible{background:var(--theme-hover, #f0f5fa);outline:none}
.styk-easing-options button[aria-checked=true]{background:var(--theme-selected, #e8f4ff);color:var(--theme-accent, #0877c5)}
.styk-easing-options button[aria-checked=true]::after{content:'✓'}
.styk-easing-options button:disabled{opacity:.35;cursor:default}
.styk-easing-curve{display:block;width:100%;height:124px;margin-top:7px;border:1px solid var(--theme-border, #e5eaf0);border-radius:5px;background:var(--theme-subtle, #f8fafc);touch-action:none}
.styk-easing-curve circle{cursor:grab;stroke-width:2}
.styk-easing-curve text{font:9px sans-serif;fill:var(--theme-muted, #8390a0)}
.styk-easing-points{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;margin:7px 0}
.styk-easing-points label{font-size:9px;color:var(--theme-muted, #7c8693)}
.styk-easing-points input{width:100%;height:25px;margin-top:3px;border:1px solid var(--theme-border, #dce1e7);border-radius:4px;padding:0 4px;font:10px inherit;background:var(--theme-panel, #fff);color:var(--theme-secondary, #454b55);appearance:textfield}
.styk-easing-points input:focus{outline:1px solid var(--theme-accent, #0d99ff)}
.styk-easing-apply{display:block;width:100%;height:27px;border:0;border-radius:4px;background:var(--primary);color:var(--on-primary);font:inherit;cursor:pointer}
.styk-easing-apply:disabled{opacity:.4;cursor:default}
.styk-easing-error{color:var(--theme-danger, #c43d3d);font-size:10px;line-height:1.4}
.styk-easing-error:empty{display:none}
`;

function keyAnchor(host, indices) {
  if(host.easingAnchor)return host.easingAnchor;
  const card = host.cards?.get(indices[0]), rect = card?.querySelector('.styk-simple-preview, .sheet-preview')?.getBoundingClientRect() ?? (host.strip??host.scroll).getBoundingClientRect();
  return {x: rect.left + rect.width / 2, y: rect.top};
}

/** Nonmodal, light-dismiss easing editor for the scene filmstrip. */
export function showKeyframeEasingPopover() {
  const indices = this.captureEasingSelection?.() ?? this.selectedFrameIndices;
  if (!indices.length) return;
  const report = this.editor.report;
  const settings = this.easingSettings(indices);
  const initial = settings.every(value => JSON.stringify(value) === JSON.stringify(settings[0])) ? settings[0] : null;
  this.easingPopover?.hidePopover();
  if (this.menu) this.menu.hidden = true;
  this.onSeek?.(this.editor.tick, this.editor.frameIndex);
  if (!document.querySelector('[data-styk-easing-style]')) {
    const style = document.createElement('style'); style.dataset.stykEasingStyle = ''; style.textContent = `@layer legacy{${STYLES}}`; appendLocalized(document.head, style);
  }
  const anchor = keyAnchor(this, indices), popover = document.createElement('div');
  popover.className = 'styk-easing-popover'; popover.popover = 'auto';
  popover.setAttribute('role', 'dialog'); localizedAttribute(popover, 'aria-label', "keyframeEasingPopover.keyframeEasing", {}); popover.setAttribute('aria-modal', 'false');
  localizedMarkup(popover, `<div class="styk-easing-header"><span data-i18n="keyframeEasingPopover.easing">${messageHTML("keyframeEasingPopover.easing", {})}</span><button type="button" aria-label="Close easing" data-i18n-aria-label="keyframeEasingPopover.closeEasing">${icon('close')}</button></div><form><div data-controls></div><p class="styk-easing-error" role="alert"></p><button class="styk-easing-apply" type="submit" data-i18n="common.apply">${messageHTML("keyframeEasingPopover.apply", {})}</button></form>`);
  appendLocalized(document.body, popover); this.easingPopover = popover;
  const events = new AbortController(), options = {signal: events.signal};
  const apply = popover.querySelector('[type=submit]'), error = popover.querySelector('[role=alert]');
  const position = () => {
    // An upright phone's touch interface shows it as a sheet from the bottom edge (anchor-position.mjs).
    if (presentsAsSheet(popover)) { placeFloating(popover, {x: anchor.x, y: anchor.y}); return; }
    const {width, height} = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, anchor.x - width / 2))}px`;
    popover.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, anchor.y - height - 10))}px`;
  };
  const close = (focus = true) => {
    if (popover.matches(':popover-open')) popover.hidePopover();
    events.abort(); popover.remove();
    if (this.easingPopover === popover) this.easingPopover = null;
    if (focus && !this._destroyed && !this.disposed) (this.strip??this.scroll).focus({preventScroll:true});
  };
  const save = () => {
    try {
      if (this.editor.report !== report) throw messageError(new Error(''), "errors.keyframeEasingPopover.theAnimationDocumentHasChangedReopenTheKeyframe", {});
      const easing = controls.read();
      this.applyEasing(indices, easing);
      close(); if (this.live) localizedText(this.live, "keyframeEasingPopover.keyframeEasingUpdated", {});
    } catch (failure) { presentError(error, failure); position(); }
  };
  const controls = createEasingControls(popover.querySelector('[data-controls]'), {initial,
    onChange: (valid, mode) => { apply.disabled = !valid; apply.hidden = mode !== 'bezier'; error.textContent = ''; position(); },
    onSelect: mode => { if (mode !== 'bezier') save(); },
  });
  popover.querySelector('form').addEventListener('submit', event => {event.preventDefault(); save();}, options);
  popover.querySelector('.styk-easing-header button').addEventListener('click', () => close(), options);
  popover.addEventListener('keydown', event => {event.stopPropagation(); if (event.key === 'Escape') {event.preventDefault(); close();}}, options);
  popover.addEventListener('toggle', event => {if (event.newState === 'closed') close(false);}, options);
  window.addEventListener('resize', () => close(false), options);
  (this.strip??this.scroll).addEventListener('scroll', () => close(false), options);
  this.editor.addEventListener('change', () => close(false), options);
  popover.showPopover(); position(); controls.focus();
}
