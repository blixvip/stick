import {drawGeometry} from './pivot/geometry.mjs';
/** Preserve painter ordering and native stroke state without cloning artwork.
 * An optional generator walker draws effects between each target's runs. */
export function drawParallaxGeometry(ctx,geometry,resources,offsetFor,outputRect,walker){
  const strokeState={width:1};let slot,items=[];
  const draw=()=>{if(!items.length)return;const uid=items[0].obj.unique_id;walker?.object(uid);const d=offsetFor(uid);ctx.save();try{ctx.translate(d.x,d.y);drawGeometry(ctx,{drawables:items,strokeState,outputRect:outputRect&&{x:d.x+outputRect.x,y:d.y+outputRect.y,width:outputRect.width,height:outputRect.height}},resources);}finally{ctx.restore();}};
  walker?.begin();
  for(const item of geometry.drawables){if(items.length&&item.slot!==slot){draw();items=[];}slot=item.slot;items.push(item);}draw();
  walker?.end();
}
