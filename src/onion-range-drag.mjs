import {onionDragValue} from './onion-range.mjs';

/** Fixed-origin pointer gestures shared by ruler handles and settings fields. */
export class OnionRangeDrag {
  constructor(controller,direction,target,sign=1){
    Object.assign(this,{controller,direction,target,sign});this.events=new AbortController();
    this.key=direction==='before'?'onionRangeBefore':'onionRangeAfter';
    const on=(node,type,fn)=>node.addEventListener(type,fn,{signal:this.events.signal});
    on(target,'pointerdown',event=>{
      if(event.button!==0||this.drag)return;
      event.preventDefault();event.stopPropagation();
      target.focus({preventScroll:true});controller.begin(this);const range=controller.snapshot()[direction];
      this.drag={id:event.pointerId,x:event.clientX,start:range.span,max:range.max,precision:event.shiftKey};
      target.setPointerCapture(event.pointerId);
    });
    on(target,'pointermove',event=>{
      if(event.pointerId!==this.drag?.id)return;
      event.preventDefault();event.stopPropagation();
      const value=onionDragValue(this.drag.start,sign*(event.clientX-this.drag.x),this.drag.max,this.drag.precision);
      if(value!==controller.snapshot()[direction].span)controller.preview(this,{[this.key]:value});
    });
    on(target,'pointerup',event=>{if(event.pointerId===this.drag?.id){event.stopPropagation();this.finish(true);}});
    on(target,'pointercancel',()=>this.finish(false));
    on(target,'lostpointercapture',()=>this.finish(false));
    on(target,'click',event=>event.stopPropagation());
    on(window,'blur',()=>this.finish(false));
    on(target,'keydown',event=>{
      if(event.key==='Escape'&&this.drag){event.preventDefault();event.stopPropagation();this.finish(false);}
    });
    this.unsubscribe=controller.subscribe(()=>{if(this.drag&&controller.session?.owner!==this)this.release();});
  }
  release(){const drag=this.drag;this.drag=null;if(drag&&this.target.hasPointerCapture(drag.id))this.target.releasePointerCapture(drag.id);}
  finish(commit){this.release();if(commit)this.controller.commit(this);else this.controller.cancel(this);}
  destroy(){this.finish(false);this.unsubscribe();this.events.abort();}
}
