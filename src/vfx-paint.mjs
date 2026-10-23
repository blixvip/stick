import {normalizePaint,samplePaint} from './paint.mjs';
export function vfxPaint(value){return typeof value==='number'?{type:'solid',angle:0,stops:[{offset:0,color:[value>>>16&255,value>>>8&255,value&255],opacity:1}]}:normalizePaint(value);}
export function interpolateVfxColor(a,b,t){
 if(typeof a==='number'&&typeof b==='number'){let value=0;for(let shift=0;shift<24;shift+=8)value|=Math.round(Math.max(0,Math.min(255,(a>>>shift&255)+((b>>>shift&255)-(a>>>shift&255))*t)))<<shift;return value;}
 const p=vfxPaint(a),q=vfxPaint(b);
 if(p.type!=='solid'&&q.type!=='solid'&&(p.type!==q.type||p.stops.length!==q.stops.length))return p;
 if(p.type==='solid'&&q.type!=='solid')p.stops=q.stops.map(s=>({...p.stops[0],offset:s.offset}));
 if(q.type==='solid'&&p.type!=='solid')q.stops=p.stops.map(s=>({...q.stops[0],offset:s.offset}));
 const count=Math.max(p.stops.length,q.stops.length),same=p.stops.length===q.stops.length;
 const stops=Array.from({length:count},(_,i)=>{const offset=i/(count-1||1),x=same?p.stops[i]:samplePaint(p,offset),y=same?q.stops[i]:samplePaint(q,offset);return {offset:same?x.offset+(y.offset-x.offset)*t:offset,color:x.color.map((v,j)=>Math.round(v+(y.color[j]-v)*t)),opacity:x.opacity+(y.opacity-x.opacity)*t};});
 return normalizePaint({type:p.type==='solid'?q.type:p.type,angle:p.angle+(q.angle-p.angle)*t,stops});
}
