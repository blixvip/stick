import {appendLocalized, localizedAttribute, messageAttributes} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
/** Krita-style slider fields for drawing settings: a filled bar showing the
 * label and value. Pressing or dragging sets the value (sizes on a log
 * scale), arrow keys step it (Shift for larger steps), the wheel steps it in
 * the canvas quick bar, and double-click types an exact value. The owner
 * supplies get/set, so one delegated installation drives the inspector and
 * the quick bar, and every slider for a key updates live without a re-render. */
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export const SLIDERS={
  size:{label:interfaceText("drawingSliders.size"), labelKey: "drawingSliders.size", labelParams: {},min:.5,max:2048,unit:'px',log:true},
  opacity:{label:interfaceText("drawingSliders.opacity"), labelKey: "drawingSliders.opacity", labelParams: {},min:0,max:100,unit:'%',scale:100},
  flow:{label:interfaceText("drawingSliders.flow"), labelKey: "drawingSliders.flow", labelParams: {},min:1,max:100,unit:'%',scale:100},
  hardness:{label:interfaceText("drawingSliders.hardness"), labelKey: "drawingSliders.hardness", labelParams: {},min:0,max:100,unit:'%',scale:100},
  stabilization:{label:interfaceText("drawingSliders.smooth"), labelKey: "drawingSliders.smooth", labelParams: {},min:0,max:95,unit:'%',scale:100},
  spacingRatio:{label:interfaceText("drawingSliders.spacing"), labelKey: "drawingSliders.spacing", labelParams: {},min:1,max:100,unit:'%',scale:100},
  roundness:{label:interfaceText("drawingSliders.roundness"), labelKey: "drawingSliders.roundness", labelParams: {},min:5,max:100,unit:'%',scale:100},
  angle:{label:interfaceText("drawingSliders.angle"), labelKey: "drawingSliders.angle", labelParams: {},min:0,max:360,unit:'°'},
  scatter:{label:interfaceText("drawingSliders.scatter"), labelKey: "drawingSliders.scatter", labelParams: {},min:0,max:400,unit:'%',scale:100},
  texture:{label:interfaceText("drawingSliders.strength"), labelKey: "drawingSliders.strength", labelParams: {},min:0,max:100,unit:'%',scale:100},
  grainScale:{label:interfaceText("drawingSliders.grainScale"), labelKey: "drawingSliders.grainScale", labelParams: {},min:.25,max:8,unit:'×',log:true},
  taperIn:{label:interfaceText("drawingSliders.taperStart"), labelKey: "drawingSliders.taperStart", labelParams: {},min:0,max:400,unit:'px'},
  taperOut:{label:interfaceText("drawingSliders.taperEnd"), labelKey: "drawingSliders.taperEnd", labelParams: {},min:0,max:400,unit:'px'},
  sizeJitter:{label:interfaceText("drawingSliders.sizeJitter"), labelKey: "drawingSliders.sizeJitter", labelParams: {},min:0,max:100,unit:'%',scale:100},
  opacityJitter:{label:interfaceText("drawingSliders.opacityJitter"), labelKey: "drawingSliders.opacityJitter", labelParams: {},min:0,max:100,unit:'%',scale:100},
  angleJitter:{label:interfaceText("drawingSliders.angleJitter"), labelKey: "drawingSliders.angleJitter", labelParams: {},min:0,max:100,unit:'%',scale:100},
  smudgeLength:{label:interfaceText("drawingSliders.smudgeLength"), labelKey: "drawingSliders.smudgeLength", labelParams: {},min:0,max:100,unit:'%',scale:100},
  colorRate:{label:interfaceText("drawingSliders.colorMix"), labelKey: "drawingSliders.colorMix", labelParams: {},min:0,max:100,unit:'%',scale:100},
  tolerance:{label:interfaceText("drawingSliders.tolerance"), labelKey: "drawingSliders.tolerance", labelParams: {},min:0,max:255,unit:''},
  gap:{label:interfaceText("drawingSliders.closeGaps"), labelKey: "drawingSliders.closeGaps", labelParams: {},min:0,max:8,unit:'px',integer:true},
  expansion:{label:interfaceText("drawingSliders.expand"), labelKey: "drawingSliders.expand", labelParams: {},min:0,max:16,unit:'px',integer:true},
  filterRadius:{label:interfaceText("drawingSliders.blur"), labelKey: "drawingSliders.blur", labelParams: {},min:1,max:64,unit:'px'},
  hue:{label:interfaceText("drawingSliders.hue"), labelKey: "drawingSliders.hue", labelParams: {},min:-180,max:180,unit:'°'},
  saturation:{label:interfaceText("drawingSliders.saturation"), labelKey: "drawingSliders.saturation", labelParams: {},min:-100,max:100,unit:'%'},
  lightness:{label:interfaceText("drawingSliders.lightness"), labelKey: "drawingSliders.lightness", labelParams: {},min:-100,max:100,unit:'%'},
  brightness:{label:interfaceText("drawingSliders.brightness"), labelKey: "drawingSliders.brightness", labelParams: {},min:-100,max:100,unit:'%'},
  contrast:{label:interfaceText("drawingSliders.contrast"), labelKey: "drawingSliders.contrast", labelParams: {},min:-100,max:300,unit:'%'},
  sizeCurve:{label:interfaceText("drawingSliders.sizeCurve"), labelKey: "drawingSliders.sizeCurve", labelParams: {},min:.1,max:4,unit:'',decimals:2},
  opacityCurve:{label:interfaceText("drawingSliders.opacityCurve"), labelKey: "drawingSliders.opacityCurve", labelParams: {},min:.1,max:4,unit:'',decimals:2},
};
/** Setting value → the number the slider shows (percent settings ×100). */
export const displayValue=(key,value)=>Number(value??0)*(SLIDERS[key]?.scale??1);
const fraction=(key,shown)=>{const d=SLIDERS[key];if(d.log)return (Math.log(clamp(shown,d.min,d.max))-Math.log(d.min))/(Math.log(d.max)-Math.log(d.min));return (clamp(shown,d.min,d.max)-d.min)/(d.max-d.min);};
const shownAt=(key,f)=>{const d=SLIDERS[key];f=clamp(f,0,1);const v=d.log?Math.exp(Math.log(d.min)+f*(Math.log(d.max)-Math.log(d.min))):d.min+f*(d.max-d.min);return round(key,v);};
const round=(key,v)=>{const d=SLIDERS[key];if(d.integer)return Math.round(v);if(d.decimals)return Math.round(v*10**d.decimals)/10**d.decimals;if(d.log)return v<10?Math.round(v*10)/10:Math.round(v);return Math.round(v);};
export const formatSlider=(key,shown)=>{const d=SLIDERS[key];const n=d.decimals?shown.toFixed(d.decimals):d.log&&shown<10?shown.toFixed(1).replace(/\.0$/,''):String(Math.round(shown));return d.unit==='°'?n+'°':d.unit?`${n} ${d.unit}`:n;};
/** One slider field; `compact` omits the label for the quick bar's tight rows. */
export function sliderMarkup(key,value,{label,labelKey,compact=false,title}={}){
  const d=SLIDERS[key];if(!d)return '';
  const shown=displayValue(key,value),pct=(fraction(key,shown)*100).toFixed(2),nameKey=labelKey??(label===undefined?d.labelKey:undefined),name=nameKey?interfaceText(nameKey):label,
    nameMessage=nameKey?{messageKey:nameKey}:name;
  return `<div class="draw-slider${compact?' is-compact':''}" data-draw-slider="${key}" role="slider" tabindex="0" aria-label="${name}" ${nameKey?messageAttributes(nameKey,{},'aria-label'):''} aria-valuemin="${d.min}" aria-valuemax="${d.max}" aria-valuenow="${shown}" aria-valuetext="${formatSlider(key,shown)}" title="${title??interfaceText('drawingSliders.interactionHint',{name:nameMessage})}" ${title===undefined?messageAttributes('drawingSliders.interactionHint',{name:nameMessage},'title'):''}><span class="draw-slider-fill" style="width:${pct}%"></span><span class="draw-slider-label" ${nameKey?messageAttributes(nameKey):''}>${name}</span><span class="draw-slider-value">${formatSlider(key,shown)}</span></div>`;
}
/** Refresh every slider for `key` to the setting value. */
export function refreshSliders(key,value,root=document){
  if(!SLIDERS[key])return; // Colours and toggles have no slider fields.
  const shown=displayValue(key,value),pct=(fraction(key,shown)*100).toFixed(2)+'%',text=formatSlider(key,shown);
  for(const el of root.querySelectorAll(`[data-draw-slider="${key}"]`)){
    const fill=el.querySelector('.draw-slider-fill'),label=el.querySelector('.draw-slider-value');
    if(fill&&fill.style.width!==pct)fill.style.width=pct;if(label&&label.textContent!==text&&!el.classList.contains('is-editing'))label.textContent=text;
    el.setAttribute('aria-valuenow',String(shown));el.setAttribute('aria-valuetext',text);
  }
}
/** Delegate slider interaction on `root`. set(key, settingValue, {live})
 * applies a value; end(key) runs once an interaction finishes. */
export function installDrawingSliders(root,{get,set,end,signal,wheel=false}){
  const commit=(key,shown,live)=>set(key,shown/(SLIDERS[key].scale??1),{live});
  root.addEventListener('pointerdown',event=>{
    const el=event.target.closest?.('[data-draw-slider]');if(!el||event.button!==0||el.classList.contains('is-editing'))return;
    event.preventDefault();event.stopPropagation();el.focus({preventScroll:true});
    const key=el.dataset.drawSlider,rect=el.getBoundingClientRect(),apply=e=>commit(key,shownAt(key,(e.clientX-rect.left)/rect.width),true);
    // While owned, inspector refreshes leave this slider's live state alone.
    el.setPointerCapture(event.pointerId);el.classList.add('is-dragging');el.setAttribute('data-inspector-owned','');apply(event);
    const move=e=>{if(e.pointerId===event.pointerId)apply(e);};
    const up=e=>{if(e.pointerId!==event.pointerId)return;el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);el.classList.remove('is-dragging');el.removeAttribute('data-inspector-owned');end?.(key);};
    el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);
  },{signal});
  root.addEventListener('keydown',event=>{
    const el=event.target.closest?.('[data-draw-slider]');if(!el||el.classList.contains('is-editing'))return;
    const key=el.dataset.drawSlider,d=SLIDERS[key],shown=displayValue(key,get(key));let next=null;
    const step=(d.log?Math.max(.1,shown*.1):d.integer?1:d.decimals?.05:Math.max(1,(d.max-d.min)/100))*(event.shiftKey?10:1);
    if(event.key==='ArrowRight'||event.key==='ArrowUp')next=shown+step;else if(event.key==='ArrowLeft'||event.key==='ArrowDown')next=shown-step;else if(event.key==='Home')next=d.min;else if(event.key==='End')next=d.max;else if(event.key==='Enter'){edit(el);event.preventDefault();return;}
    if(next==null)return;event.preventDefault();event.stopPropagation();commit(key,clamp(round(key,next),d.min,d.max),false);end?.(key);
  },{signal});
  if(wheel)root.addEventListener('wheel',event=>{
    const el=event.target.closest?.('[data-draw-slider]');if(!el)return;event.preventDefault();event.stopPropagation();
    const key=el.dataset.drawSlider,d=SLIDERS[key],shown=displayValue(key,get(key)),up=event.deltaY<0;
    const next=d.log?shown*(up?1.1:1/1.1):shown+(up?1:-1)*(d.integer?1:Math.max(1,(d.max-d.min)/50));
    commit(key,clamp(round(key,next),d.min,d.max),true);end?.(key);
  },{signal,passive:false});
  root.addEventListener('dblclick',event=>{const el=event.target.closest?.('[data-draw-slider]');if(el)edit(el);},{signal});
  function edit(el){
    const key=el.dataset.drawSlider,d=SLIDERS[key],value=el.querySelector('.draw-slider-value');if(!value)return;
    el.classList.add('is-editing');el.setAttribute('data-inspector-owned','');const input=document.createElement('input');input.type='number';input.className='draw-slider-input';input.min=String(d.min);input.max=String(d.max);input.step='any';input.value=String(displayValue(key,get(key)));localizedAttribute(input,'aria-label',d.labelKey,{});
    value.textContent='';appendLocalized(value, input);input.focus();input.select();
    const done=apply=>{if(!el.classList.contains('is-editing'))return;el.classList.remove('is-editing');el.removeAttribute('data-inspector-owned');const n=Number(input.value);input.remove();if(apply&&Number.isFinite(n))commit(key,clamp(round(key,n),d.min,d.max),false);refreshSliders(key,get(key),el.parentElement??document);end?.(key);};
    input.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();done(true);}else if(e.key==='Escape'){e.preventDefault();done(false);}});
    input.addEventListener('blur',()=>done(true),{once:true});
  }
}
