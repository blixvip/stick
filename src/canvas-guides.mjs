import {t as interfaceText} from './localization.mjs';

import {localizedMarkup, appendLocalized, localizedAttribute, messageHTML} from './localization-bindings.mjs';
import {icon} from './icons.mjs';
import {PropertyControls} from './property-controls.mjs';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** Workspace-only aids. Fixed DOM size; no document edits or renderer resources. */
/** Guides and grid over the canvas, and their settings popover. `button` shows the grid's state (the stage
 * header's Grid toggle runs toggle-grid); `trigger`, the split button's chevron, opens the popover (without a
 * trigger the button opens it, as the view pill's did). */
export class CanvasGuides {
  constructor({button, trigger = button, viewport, getState, onChange}) {
    Object.assign(this, {button, trigger, viewport, getState, onChange});
    this.overlay = document.createElement('div');
    this.overlay.className = 'canvas-aids';
    localizedMarkup(this.overlay, `<div class="canvas-aids-grid"></div>
      <div class="canvas-guide vertical"><button type="button" aria-label="Move vertical guide" title="Drag vertical guide · Arrow keys to adjust" data-i18n-aria-label="canvasGuides.moveVerticalGuide" data-i18n-title="canvasGuides.dragVerticalGuideArrowKeysToAdjust"></button></div>
      <div class="canvas-guide horizontal"><button type="button" aria-label="Move horizontal guide" title="Drag horizontal guide · Arrow keys to adjust" data-i18n-aria-label="canvasGuides.moveHorizontalGuide" data-i18n-title="canvasGuides.dragHorizontalGuideArrowKeysToAdjust"></button></div>`);
    appendLocalized(viewport, this.overlay);
    this.grid = this.overlay.firstElementChild;
    this.panel = document.createElement('div');
    this.panel.id = 'canvas-guides-panel';
    this.panel.className = 'canvas-guides-panel ui-popover';
    this.panel.setAttribute('popover', 'auto');
    this.panel.setAttribute('role', 'dialog');
    localizedAttribute(this.panel, 'aria-label', "canvasGuides.guidesAndGrid", {});
    const visibility = (key, name) => `<label class="guide-icon-toggle" title="${name}"><input type="checkbox" data-setting="${key}" aria-label="${name}">${icon('eye')}</label>`;
    localizedMarkup(this.panel, `<header class="ui-popover-head"><strong class="ui-popover-title">${icon('grid')}${messageHTML("canvasGuides.guidesGrid", {})}</strong><button type="button" class="ui-popover-close guide-close" aria-label="Close guides and grid" title="Close" data-i18n-aria-label="canvasGuides.closeGuidesAndGrid" data-i18n-title="common.close">${icon('close')}</button></header>
      <section aria-label="Guides" data-i18n-aria-label="canvasGuides.guides">
        <div class="guide-section-head"><span data-i18n="canvasGuides.guides">${messageHTML("canvasGuides.guides", {})}</span><div class="guide-actions">
          <label class="guide-icon-toggle" title="Lock guides" data-i18n-title="canvasGuides.lockGuides"><input type="checkbox" data-setting="canvasGuidesLocked" aria-label="Lock guides" data-i18n-aria-label="canvasGuides.lockGuides">${icon('lock')}</label>
          <button type="button" class="guide-center" aria-label="Center guides" title="Center guides" data-i18n-aria-label="canvasGuides.centerGuides" data-i18n-title="canvasGuides.centerGuides">${icon('center')}</button>
        </div></div>
        <div class="guide-control-row"><span class="guide-axis">${icon('line')}<span data-i18n="canvasGuides.vertical">${messageHTML("canvasGuides.vertical", {})}</span></span><label class="guide-value"><input type="number" data-position="X" min="0" step="1" aria-label="Vertical guide position" data-i18n-aria-label="canvasGuides.verticalGuidePosition"><small>px</small></label>${visibility('canvasGuideVertical', interfaceText("canvasGuides.showVerticalGuide"))}</div>
        <div class="guide-control-row"><span class="guide-axis horizontal-axis">${icon('line')}<span data-i18n="canvasGuides.horizontal">${messageHTML("canvasGuides.horizontal", {})}</span></span><label class="guide-value"><input type="number" data-position="Y" min="0" step="1" aria-label="Horizontal guide position" data-i18n-aria-label="canvasGuides.horizontalGuidePosition"><small>px</small></label>${visibility('canvasGuideHorizontal', interfaceText("canvasGuides.showHorizontalGuide"))}</div>
      </section>
      <section aria-label="Grid" data-i18n-aria-label="canvasGuides.grid">
        <div class="guide-section-head"><span class="guide-grid-title" data-i18n="canvasGuides.grid">${messageHTML("canvasGuides.grid", {})}</span>${visibility('canvasGrid', interfaceText("canvasGuides.showGrid"))}</div>
        <label class="guide-control-row"><span data-i18n="canvasGuides.cellSize">${messageHTML("canvasGuides.cellSize", {})}</span><span class="guide-value"><input type="number" min="4" max="1000" step="1" data-setting="canvasGridSpacing" aria-label="Grid cell size" data-i18n-aria-label="canvasGuides.gridCellSize"><small>px</small></span></label>
        <label class="guide-control-row guide-opacity"><span data-i18n="canvasGuides.opacity">${messageHTML("canvasGuides.opacity", {})}</span><input type="range" min="0.05" max="0.6" step="0.01" data-setting="canvasGridOpacity" aria-label="Grid opacity" data-i18n-aria-label="canvasGuides.gridOpacity"><output class="guide-opacity-value"></output></label>
      </section>`);
    appendLocalized(document.body, this.panel);
    for (const input of this.panel.querySelectorAll('input[type="number"]')) {
      const key = input.dataset.position ? 'canvasGuide' + input.dataset.position : input.dataset.setting;
      input.dataset.property = key;
      input.dataset.propertyStep = '1';
      input.dataset.propertyPrecision = '2';
      input.step = 'any';
      const field = input.closest('.guide-value');
      field.dataset.propertyRow = key;
      field.dataset.propertyScrub = '';
      field.tabIndex = -1;
      localizedAttribute(field, "title", "canvasGuides.dragToAdjustClickToTypeShiftFine", {});
    }
    const sizeFor = (key, report) => key === 'canvasGuideX' ? report.canvas_width : key === 'canvasGuideY' ? report.canvas_height : 1;
    this.values = new PropertyControls(this.panel, {
      getValue: key => { const {settings, report} = getState(); return settings[key] * sizeFor(key, report); },
      canHandle: key => key === 'canvasGridSpacing' || !getState().settings.canvasGuidesLocked,
      begin: ({key}) => ({size: sizeFor(key, getState().report)}),
      preview: ({key, value, token}) => { this.valuePreview = {[key]: value / token.size}; this.render(); },
      commit: ({key, value, token}) => { this.valuePreview = null; onChange({[key]: value / token.size}); },
      cancel: () => { this.valuePreview = null; this.sync(); },
    });
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      if (this.panel.matches(':popover-open')) this.panel.hidePopover();
      else { this.sync(); this.panel.showPopover(); this.position(); this.panel.querySelector("input").focus({preventScroll: true}); }
    });
    this.panel.addEventListener('toggle', e => {
      trigger.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState === 'closed') this.values.commit();
    });
    this.panel.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.panel.hidePopover(); trigger.focus(); }
    });
    this.panel.addEventListener('click', e => e.stopPropagation());
    this.panel.querySelector('.guide-close').onclick = () => { this.panel.hidePopover(); trigger.focus(); };
    this.panel.addEventListener('input', e => {
      if (e.target.dataset.setting === 'canvasGridOpacity') this.onChange({canvasGridOpacity: Number(e.target.value)});
    });
    this.panel.querySelector('.guide-center').onclick = () => onChange({canvasGuideX: .5, canvasGuideY: .5, canvasGuideVertical: true, canvasGuideHorizontal: true});
    this.panel.addEventListener('change', e => {
      const input = e.target, key = input.dataset.setting;
      if (input.type === 'number' && (!input.value || !input.validity.valid)) { this.sync(); return; }
      if (key) onChange({[key]: input.type === 'checkbox' ? input.checked : Number(input.value)});
      else if (input.dataset.position) {
        const axis = input.dataset.position, {report} = getState();
        onChange({['canvasGuide' + axis]: Number(input.value) / (axis === 'X' ? report.canvas_width : report.canvas_height)});
      }
    });
    for (const [axis, cls] of [['X', 'vertical'], ['Y', 'horizontal']]) {
      const handle = this.overlay.querySelector('.' + cls + ' button');
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || getState().settings.canvasGuidesLocked) return;
        e.preventDefault(); e.stopPropagation();
        const {settings, view, report} = getState(), size = axis === 'X' ? report.canvas_width : report.canvas_height;
        this.drag = {axis, pointer: e.pointerId, handle, start: axis === 'X' ? e.clientX : e.clientY,
          original: settings['canvasGuide' + axis], scale: view.scale, size, report};
        this.preview = this.drag.original;
        handle.setPointerCapture(e.pointerId); handle.focus();
      });
      handle.addEventListener('pointermove', e => {
        const drag = this.drag; if (!drag || drag.handle !== handle) return;
        const delta = (axis === 'X' ? e.clientX : e.clientY) - drag.start;
        this.preview = clamp(Math.round((drag.original * drag.size) + delta / drag.scale) / drag.size, 0, 1);
        this.render();
      });
      handle.addEventListener('pointerup', () => this.finishDrag(true));
      handle.addEventListener('pointercancel', () => this.finishDrag(false));
      handle.addEventListener('lostpointercapture', () => this.finishDrag(false));
      handle.addEventListener('keydown', e => {
        if (e.key === 'Escape' && this.drag) { e.preventDefault(); e.stopPropagation(); this.finishDrag(false); return; }
        if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const {settings, report} = getState(); if (settings.canvasGuidesLocked) return;
        const amount = (["ArrowLeft","ArrowUp"].includes(e.key) ? -1 : 1) * (e.shiftKey ? 10 : 1);
        onChange({['canvasGuide' + axis]: clamp(settings['canvasGuide' + axis] + amount / (axis === 'X' ? report.canvas_width : report.canvas_height), 0, 1)});
      });
    }
    window.addEventListener('resize', () => { this.render(); if (this.panel.matches(':popover-open')) this.position(); });
    this.sync();
  }
  finishDrag(commit) {
    const drag = this.drag; if (!drag) return;
    const value = this.preview; this.drag = null; this.preview = null;
    if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    if (commit) this.onChange({['canvasGuide' + drag.axis]: value});
    this.render();
  }
  /** Under its trigger (the stage header), else above it where the window is too short below. */
  position() {
    const r = this.trigger.getBoundingClientRect(), p = this.panel;
    p.style.left = `${clamp(r.right - p.offsetWidth, 8, Math.max(8, innerWidth - p.offsetWidth - 8))}px`;
    const below = r.bottom + 8, above = r.top - p.offsetHeight - 8;
    p.style.top = `${clamp(below + p.offsetHeight <= innerHeight - 8 || above < 8 ? below : above, 8, Math.max(8, innerHeight - p.offsetHeight - 8))}px`;
  }
  sync() {
    const {settings, report} = this.getState();
    for (const input of this.panel.querySelectorAll('[data-setting]')) {
      if (input.type === 'checkbox') input.checked = settings[input.dataset.setting];
      else if (this.values?.activeKey !== input.dataset.property) input.value = settings[input.dataset.setting];
    }
    for (const input of this.panel.querySelectorAll('[data-position]')) {
      const axis = input.dataset.position, size = axis === 'X' ? report.canvas_width : report.canvas_height;
      input.max = size;
      if (this.values?.activeKey !== input.dataset.property) input.value = Number((settings['canvasGuide' + axis] * size).toFixed(2));
      input.disabled = settings.canvasGuidesLocked;
    }
    this.panel.querySelector('.guide-center').disabled = settings.canvasGuidesLocked;
    this.panel.querySelector('.guide-opacity-value').value = `${Math.round(settings.canvasGridOpacity * 100)}%`;
    if (this.trigger === this.button) this.button.classList.toggle('active', settings.canvasGrid || settings.canvasGuideVertical || settings.canvasGuideHorizontal);
    this.render();
  }
  render() {
    const {settings, view:v, report:r, hidden} = this.getState();
    const s = this.valuePreview ? {...settings, ...this.valuePreview} : settings;
    if (this.drag && (hidden || s.canvasGuidesLocked || this.drag.report !== r)) this.finishDrag(false);
    const inactive = hidden || !(s.canvasGrid || s.canvasGuideVertical || s.canvasGuideHorizontal);
    if (this.overlay.hidden !== Boolean(inactive)) this.overlay.hidden = Boolean(inactive);
    if (inactive) return;
    const w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    const x = this.drag?.axis === 'X' ? this.preview : s.canvasGuideX, y = this.drag?.axis === 'Y' ? this.preview : s.canvasGuideY;
    const signature = [w,h,v.x,v.y,v.scale,r.canvas_width,r.canvas_height,s.canvasGrid,s.canvasGridSpacing,s.canvasGridOpacity,s.canvasGuideVertical,s.canvasGuideHorizontal,s.canvasGuidesLocked,x,y].join(',');
    if (signature === this.signature) return; this.signature = signature;
    const left = Math.max(0,v.x), top = Math.max(0,v.y), right = Math.min(w,v.x+r.canvas_width*v.scale), bottom = Math.min(h,v.y+r.canvas_height*v.scale);
    this.grid.hidden = !s.canvasGrid || right <= left || bottom <= top;
    // Coarsen below eight screen pixels to prevent moiré and unbounded density.
    const base = s.canvasGridSpacing * v.scale, step = base * Math.max(1, 2 ** Math.ceil(Math.log2(8 / base)));
    Object.assign(this.grid.style, {left:left+'px',top:top+'px',width:Math.max(0,right-left)+'px',height:Math.max(0,bottom-top)+'px',backgroundSize:`${step}px ${step}px`,backgroundPosition:`${v.x-left}px ${v.y-top}px`,opacity:s.canvasGridOpacity});
    for (const [axis, cls, value, size, shown] of [['X','vertical',x,r.canvas_width,s.canvasGuideVertical],['Y','horizontal',y,r.canvas_height,s.canvasGuideHorizontal]]) {
      const line = this.overlay.querySelector('.'+cls), handle = line.firstElementChild;
      const position = (axis === 'X' ? v.x : v.y) + value * size * v.scale;
      line.hidden = !shown || position < 0 || position > (axis === 'X' ? w : h);
      line.style[axis === 'X' ? 'left' : 'top'] = position+'px';
      handle.style[axis === 'X' ? 'left' : 'top'] = (position > (axis === 'X' ? w - 60 : h - 32) ? (axis === 'X' ? -54 : -27) : 4) + 'px';
      handle.textContent = `${axis} ${Math.round(value*size)}`;
      handle.disabled = s.canvasGuidesLocked;
    }
  }
}
