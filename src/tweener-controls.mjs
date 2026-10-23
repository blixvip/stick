import {t as interfaceText} from './localization.mjs';
import {appendLocalized, localizedAttribute, localizedMarkup, localizedText, messageAttributes} from './localization-bindings.mjs';
import {icon} from './icons.mjs';
const TYPES = {
  breakdown: {labelKey: "tweenerControls.breakdown", color:'#8b5cf6', path:"M12 3 20 12 12 21 4 12Z"},
  neighbor: {labelKey: "tweenerControls.blendToNeighbor", color:'#168aad', path:"M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"},
  push: {labelKey: "tweenerControls.push", color:'#df7620', path:"M9 12H3m0 0 4-4m-4 4 4 4m8-4h6m0 0-4-4m4 4-4 4"},
  relax: {labelKey: "tweenerControls.relax", color:'#22966c', path:"M3 12h6m0 0L5 8m4 4-4 4m16-4h-6m0 0 4-4m-4 4 4 4"},
};
const glyph = type => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${TYPES[type].path}"/></svg>`;

/** Toolbar multi-tool; the host canvas owns pointer capture, pan and cancellation.
 * One captured pose gesture is updated at most once per animation frame. */
export class TweenerControls {
  constructor({button, editor, viewport, getTool, onSelect, beforeEdit, onError}) {
    Object.assign(this, {button, editor, viewport, getTool, onSelect, beforeEdit, onError});
    this.mode='breakdown';this.abort=new AbortController();const options={signal:this.abort.signal};
    const tool=this.tool=document.createElement('div');tool.className='tweener-tool';
    button.before(tool);appendLocalized(tool, button);
    const arrow=this.arrow=document.createElement('button');arrow.type='button';arrow.className='tweener-arrow';
    localizedAttribute(arrow, 'aria-label', "tweenerControls.chooseTweenType", {});arrow.setAttribute('aria-haspopup','menu');
    arrow.setAttribute('aria-controls','tweener-types');arrow.setAttribute('aria-expanded','false');
    localizedMarkup(arrow, '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3 8 3 8 9Z" fill="currentColor"/></svg>');appendLocalized(tool, arrow);
    const menu=this.menu=document.createElement('div');menu.id='tweener-types';menu.className='tweener-types';
    menu.setAttribute('popover','auto');menu.setAttribute('role','menu');localizedAttribute(menu, 'aria-label', "tweenerControls.tweenType", {});
    localizedMarkup(menu, Object.entries(TYPES).map(([type,{labelKey,color}])=>`<button type="button" role="menuitemradio" data-tween-type="${type}" style="--tween-color:${color}">${glyph(type)}<span ${messageAttributes(labelKey)}>${interfaceText(labelKey)}</span><span class="tween-chosen" aria-hidden="true">✓</span></button>`).join(''));
    appendLocalized(document.body, menu);
    const hud=this.hud=document.createElement('output');hud.className='tweener-hud';hud.hidden=true;localizedMarkup(hud,'<span></span>  <span></span>');localizedAttribute(hud, 'aria-label', "tweenerControls.tweenAmount", {});appendLocalized(viewport, hud);
    button.addEventListener('click',event=>{event.stopPropagation();this.activate(this.mode);},options);
    arrow.addEventListener('click',event=>{event.stopPropagation();this.openMenu();},options);
    tool.addEventListener('contextmenu',event=>{event.preventDefault();this.openMenu();},options);
    tool.addEventListener('keydown',event=>{
      if(["ArrowDown","ArrowRight"].includes(event.key)){event.preventDefault();event.stopPropagation();this.openMenu();}
    },options);
    menu.addEventListener('click',event=>{const choice=event.target.closest('[data-tween-type]');if(choice){event.stopPropagation();this.activate(choice.dataset.tweenType);this.closeMenu();viewport.focus({preventScroll:true});}},options);
    menu.addEventListener('keydown',event=>{
      event.stopPropagation();const choices=[...menu.querySelectorAll('button')],i=choices.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();this.closeMenu();arrow.focus();}
      else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
        event.preventDefault();choices[event.key==='Home'?0:event.key==='End'?choices.length-1:(i+(event.key==='ArrowUp'?-1:1)+choices.length)%choices.length].focus();
      }
    },options);
    menu.addEventListener('toggle',event=>arrow.setAttribute('aria-expanded',String(event.newState==='open')),options);
    window.addEventListener('resize',()=>this.closeMenu(),options);
    editor.addEventListener('change',()=>{if(this.session&&editor._drag!==this.session)this.finish(false);},options);
    this.sync();
  }
  activate(mode) {this.mode=mode;this.onSelect();this.sync();}
  sync() {
    const type=TYPES[this.mode],active=this.getTool()==='tweener';
    this.tool.style.setProperty('--tween-color',type.color);
    this.tool.classList.toggle('active',active);this.button.setAttribute('aria-pressed',String(active));
    localizedAttribute(this.button, 'aria-label', "tweenerControls.tweener", {label: {messageKey:type.labelKey}});
    localizedAttribute(this.button, "title", "tweenerControls.dragHorizontallyOnCanvasArrowForTweenTypes", {label: {messageKey:type.labelKey}});
    // The rail shows one in-between glyph (never a key diamond); the type's own glyph and colour are in its menu and HUD.
    if(!this.button.querySelector('svg'))localizedMarkup(this.button, icon('tween'));
    this.viewport.classList.toggle('tweener-active',active);
    this.hud.style.setProperty('--tween-color',type.color);
    localizedText(this.hud.firstElementChild,type.labelKey);
    for(const choice of this.menu.querySelectorAll('[data-tween-type]'))choice.setAttribute('aria-checked',String(choice.dataset.tweenType===this.mode));
    if(active){
      const hint=this.viewport.querySelector('#viewport-hint');
      if(hint)localizedText(hint, "tweenerControls.dragHorizontallyShiftForPrecisionEscRightClick", {label: {messageKey:type.labelKey}});
    }else this.closeMenu();
  }
  openMenu() {
    if(this.menu.matches(':popover-open')){this.closeMenu();return;}
    this.menu.showPopover();const r=this.tool.getBoundingClientRect(),m=this.menu.getBoundingClientRect();
    this.menu.style.left=`${Math.max(8,Math.min(innerWidth-m.width-8,r.right+10))}px`;
    this.menu.style.top=`${Math.max(8,Math.min(innerHeight-m.height-8,r.top))}px`;
    this.menu.querySelector('[aria-checked=true]').focus();
  }
  closeMenu() {if(this.menu.matches(':popover-open'))this.menu.hidePopover();}
  begin(event) {
    this.closeMenu();
    try {
      this.beforeEdit?.();this.editor.beginTween();this.session=this.editor._drag;
      this.startX=this.lastX=event.clientX;this.value=this.mode==='breakdown'?.5:0;this.moved=false;
      return true;
    }catch(error){this.finish(false);this.onError?.(error);return false;}
  }
  move(event) {
    if(!this.session||!Number.isFinite(event?.clientX))return;
    const dx=event.clientX-this.lastX;
    if(!this.moved&&Math.abs(event.clientX-this.startX)<3)return;
    this.moved=true;this.lastX=event.clientX;
    this.value=Math.max(this.mode==='neighbor'?-1:0,Math.min(1,this.value+dx/(event.shiftKey?3000:300)));
    this.pending=this.value;this.hud.hidden=false;
    this.hud.lastElementChild.textContent=`${Math.round(this.value*100)}%`;
    if(!this.raf)this.raf=requestAnimationFrame(()=>{this.raf=0;this.flush();});
  }
  flush() {
    if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;
    if(this.pending===undefined||this.editor._drag!==this.session)return;
    const value=this.pending;this.pending=undefined;
    try{this.editor.updateTween(value,this.mode);}catch(error){this.finish(false);this.onError?.(error);}
  }
  finish(apply,event) {
    if(apply){this.move(event);this.flush();}
    if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;this.pending=undefined;
    const session=this.session;this.session=null;this.hud.hidden=true;
    try{if(session&&this.editor._drag===session){if(apply&&this.moved)this.editor.commitDrag();else this.editor.cancelDrag();}}
    catch(error){if(this.editor._drag===session)this.editor.cancelDrag();this.onError?.(error);}
  }
  destroy() {this.finish(false);this.closeMenu();this.abort.abort();this.menu.remove();this.hud.remove();this.tool.before(this.button);this.tool.remove();this.viewport.classList.remove('tweener-active');}
}
