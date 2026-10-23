import {localizedMarkup, appendLocalized} from './localization-bindings.mjs';
import {hexColor} from './paint.mjs';

/** A small, pointer-transparent loupe with one readback in flight and no idle polling. */
export function createColorMagnifier({anchor,signal,sample}) {
  const lens=document.createElement('div');
  lens.className='paint-magnifier';lens.setAttribute('popover','manual');lens.setAttribute('aria-hidden','true');
  localizedMarkup(lens, '<div class="paint-magnifier-glass"><canvas width="11" height="11"></canvas><i></i></div><div class="paint-magnifier-label"><span></span><code></code></div>');
  appendLocalized(anchor.closest('dialog') || document.body, lens);
  const ctx=lens.querySelector('canvas').getContext('2d'),label=lens.querySelector('code'),swatch=lens.querySelector('span');
  let point,timer,request,lastSample=0;
  const hide=()=>{
    point=null;clearTimeout(timer);timer=null;
    request?.abort();request=null;
    if(lens.matches(':popover-open'))lens.hidePopover();
  };
  const schedule=()=>{
    if((timer!==null && timer!==undefined) || request || !point || signal.aborted)return;
    timer=setTimeout(update,Math.max(0,1000/30-(performance.now()-lastSample)));
  };
  const position=()=>{
    // Flip beside the pointer near window edges; never cover the sampled pixel.
    const x=point.x+24+124>innerWidth-8?point.x-148:point.x+24;
    const y=point.y+24+156>innerHeight-8?point.y-180:point.y+24;
    lens.style.left=Math.max(8,x)+'px';lens.style.top=Math.max(8,y)+'px';
  };
  async function update() {
    timer=null;
    if(!point || signal.aborted)return;
    const current=point,controller=new AbortController();request=controller;lastSample=performance.now();
    try {
      const {color,pixels}=await sample(current.x,current.y,controller.signal,5);
      if(controller.signal.aborted || !point || signal.aborted)return;
      ctx.putImageData(pixels,0,0);
      const hex=hexColor(color).toUpperCase();label.textContent=hex;swatch.style.background=hex;
      position();
      if(!lens.matches(':popover-open'))lens.showPopover();
    } catch {
      if(!controller.signal.aborted && lens.matches(':popover-open'))lens.hidePopover();
    } finally {
      if(request===controller){request=null;if(point!==current)schedule();}
    }
  }
  signal.addEventListener('abort',()=>{hide();lens.remove();},{once:true});
  return {
    move(event){point={x:event.clientX,y:event.clientY};position();schedule();},
    hide,
  };
}
