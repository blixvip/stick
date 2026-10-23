import {t as interfaceText} from './localization.mjs';

import {localizedMarkup, messageAttributes} from './localization-bindings.mjs';
import {icon} from './icons.mjs';
import {OnionRangeDrag} from './onion-range-drag.mjs';
import {setAttr, setProp} from './ui/dom-write.mjs';

/** A reusable frame-span editor: explicit typing, single-frame steps and scrub. */
export class OnionFrameField {
  constructor(controller,direction){
    this.controller=controller;this.direction=direction;this.key=direction==='before'?'onionRangeBefore':'onionRangeAfter';
    this.events=new AbortController();
    const labelKey=direction==='before'?'onionFrameField.before':'onionFrameField.after',label=interfaceText(labelKey);
    const directionMessage={messageKey:labelKey};
    this.root=document.createElement('div');this.root.className='onion-frame-field';this.root.dataset.direction=direction;
    // The kit's stepper (components/stepper.css): the side's name scrubs, − and + step one frame.
    localizedMarkup(this.root, `<button type="button" class="onion-scrub" aria-label="Drag frames ${direction}" title="Drag to adjust · 8 pixels per frame · Shift for precision" ${messageAttributes("onionFrameField.dragFrames", {direction: directionMessage}, "aria-label")} ${messageAttributes(labelKey)} data-i18n-title="onionFrameField.dragToAdjust8PixelsPerFrameShift">${label}</button><div class="onion-stepper ui-stepper"><button type="button" class="ui-icon-button" data-size="sm" data-step="-1" aria-label="Decrease frames ${direction}" ${messageAttributes("onionFrameField.decreaseFrames", {direction: directionMessage}, "aria-label")}>${icon('minus')}</button><input class="ui-stepper-input" type="number" min="0" step="1" aria-label="Frames ${direction}" ${messageAttributes("onionFrameField.frames", {direction: directionMessage}, "aria-label")}><button type="button" class="ui-icon-button" data-size="sm" data-step="1" aria-label="Increase frames ${direction}" ${messageAttributes("onionFrameField.increaseFrames", {direction: directionMessage}, "aria-label")}>${icon('plus')}</button></div>`);
    this.input=this.root.querySelector('input');this.scrub=this.root.querySelector('.onion-scrub');
    const on=(target,type,fn,options={})=>target.addEventListener(type,fn,{...options,signal:this.events.signal});
    on(this.root,'keydown',event=>{
      event.stopPropagation();
      if(event.key==='Escape'){event.preventDefault();this.typed=false;this.finish(false);this.input.blur();}
      if(event.key==='Enter'&&event.target===this.input){event.preventDefault();this.saveInput();this.input.blur();}
    });
    on(this.root,'click',event=>{
      event.stopPropagation();const step=event.target.closest('[data-step]');
      if(step){const range=controller.snapshot()[direction];controller.change(this,{[this.key]:Math.max(0,Math.min(range.max,range.span+Number(step.dataset.step)))});}
    });
    on(this.input,'input',()=>{this.typed=true;});
    on(this.input,'change',()=>this.saveInput());
    on(this.input,'blur',()=>this.sync());
    this.gesture=new OnionRangeDrag(controller,direction,this.scrub);
    this.unsubscribe=controller.subscribe(()=>this.sync());this.sync();
  }
  saveInput(){
    const value=this.input.valueAsNumber,range=this.controller.snapshot()[this.direction];
    if(Number.isFinite(value)&&Number.isInteger(value)&&value>=0&&value<=range.max&&(this.typed||value!==range.span))this.controller.change(this,{[this.key]:value});
    this.typed=false;
    this.sync(true);
  }
  finish(commit){this.gesture.finish(commit);this.sync(true);}
  sync(force=false){
    const range=this.controller.snapshot()[this.direction];
    // Runs on every editor change (each frame while playing): write only what changed.
    setAttr(this.input,'max',String(range.max));
    if(force||document.activeElement!==this.input)setProp(this.input,'value',String(range.span));
    setProp(this.root.querySelector('[data-step="-1"]'),'disabled',range.span===0);
    setProp(this.root.querySelector('[data-step="1"]'),'disabled',range.span===range.max);
    setProp(this.scrub,'disabled',range.max===0);
  }
  destroy(){this.gesture.destroy();this.unsubscribe();this.events.abort();this.root.remove();}
}
