import {messageError} from './localized-error.mjs';
import {DrawingSmoother} from './drawing-smoother.mjs';
import {TEXTURE_TIPS,TEXTURE_GRAINS} from './drawing-brush-textures.mjs';

/** The brush model: settings, the stroke path and the dab pipeline. It is
 * pure geometry — no pixels — and runs on the main thread, so every dab's
 * final shape and bounds are known before any raster work is dispatched. The
 * CPU raster (drawing-pixels.mjs DrawingStroke) and the GPU brush
 * (drawing-gpu.mjs) consume the same dab shapes and differ only in floating
 * point width. */
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
export const BRUSH_BLENDS=['normal','behind','multiply','screen','overlay','color','smudge'];
export const BRUSH_ANGLE_MODES=['fixed','direction','tilt'];
export const BRUSH_TIPS=['round',...TEXTURE_TIPS];
export const BRUSH_GRAINS=['noise',...TEXTURE_GRAINS];
export const STABILIZER_MODES=['average','string'];
/** Cubic Bézier control points (x1,y1,x2,y2) of the identity pressure curve. */
export const LINEAR_PRESSURE=Object.freeze([.25,.25,.75,.75]);
/** Every setting a brush preset defines, with its default. Presets, saved
 * brushes, per-tool tips and the preview all read this one list. */
export const BRUSH_DEFAULTS=Object.freeze({
  size:8,opacity:1,flow:1,hardness:1,
  pressureSize:true,pressureOpacity:false,pressureFlow:false,sizeCurve:1,opacityCurve:1,
  stabilization:0,stabilizerMode:'average',spacingRatio:.12,
  tip:'round',roundness:1,angle:0,angleMode:'fixed',
  scatter:0,sizeJitter:0,opacityJitter:0,angleJitter:0,taperIn:0,taperOut:0,
  texture:0,grain:'noise',grainScale:1,
  blend:'normal',alphaLock:false,smudgeLength:.8,colorRate:0,
});
export const BRUSH_KEYS=Object.keys(BRUSH_DEFAULTS);
/** Settings measured in document units: the caller scales them to cel pixels. */
export const BRUSH_LENGTHS=['size','taperIn','taperOut','grainScale'];
const NUMBERS=['size','opacity','flow','hardness','sizeCurve','opacityCurve','stabilization','spacingRatio','roundness','angle','scatter','sizeJitter','opacityJitter','angleJitter','taperIn','taperOut','texture','grainScale','smudgeLength','colorRate','pixelsPerUnit'];

/** Clamped, validated brush settings. Idempotent, so any layer may normalize. */
export function normalizeBrush(settings={}){
  const b={...BRUSH_DEFAULTS,color:[0,0,0],erase:false,seed:0,pixelsPerUnit:1,pressureCurve:LINEAR_PRESSURE};
  for(const key in settings)if(settings[key]!==undefined)b[key]=settings[key];
  if(!NUMBERS.every(key=>Number.isFinite(b[key]))||!Array.isArray(b.color)||b.color.length!==3||!b.color.every(Number.isFinite))throw messageError(new Error(''), "errors.drawingBrush.invalidBrushSettings", {});
  const curve=Array.isArray(b.pressureCurve)&&b.pressureCurve.length===4&&b.pressureCurve.every(Number.isFinite)?b.pressureCurve.map(n=>clamp(n)):LINEAR_PRESSURE;
  const blend=BRUSH_BLENDS.includes(b.blend)?b.blend:'normal',smudge=blend==='smudge'&&!b.erase;
  return {
    size:clamp(b.size,.5,8192),color:b.color.map(n=>clamp(n,0,255)),opacity:clamp(b.opacity),flow:clamp(b.flow),hardness:clamp(b.hardness),erase:Boolean(b.erase),
    pressureSize:Boolean(b.pressureSize),pressureOpacity:Boolean(b.pressureOpacity),pressureFlow:Boolean(b.pressureFlow),sizeCurve:clamp(b.sizeCurve,.1,4),opacityCurve:clamp(b.opacityCurve,.1,4),pressureCurve:curve,
    stabilization:clamp(b.stabilization,0,.95),stabilizerMode:STABILIZER_MODES.includes(b.stabilizerMode)?b.stabilizerMode:'average',spacingRatio:clamp(b.spacingRatio,.01,1),
    // Smudge picks up paint dab by dab, so it keeps the analytic round tip
    // and cannot repaint a provisional tail: it has no taper-out.
    tip:!smudge&&BRUSH_TIPS.includes(b.tip)?b.tip:'round',roundness:clamp(b.roundness,.05,1),angle:((b.angle%360)+360)%360,angleMode:BRUSH_ANGLE_MODES.includes(b.angleMode)?b.angleMode:'fixed',
    scatter:clamp(b.scatter,0,4),sizeJitter:clamp(b.sizeJitter),opacityJitter:clamp(b.opacityJitter),angleJitter:clamp(b.angleJitter),
    taperIn:clamp(b.taperIn,0,1e5),taperOut:smudge?0:clamp(b.taperOut,0,1e5),
    texture:smudge?0:clamp(b.texture),grain:BRUSH_GRAINS.includes(b.grain)?b.grain:'noise',grainScale:clamp(b.grainScale,.05,64),
    blend,alphaLock:Boolean(b.alphaLock),smudgeLength:clamp(b.smudgeLength),colorRate:clamp(b.colorRate),
    seed:b.seed>>>0,pixelsPerUnit:clamp(b.pixelsPerUnit,.01,64),
  };
}
/** Radius of a dab at this (curve-mapped) pressure before jitter and taper. */
export function dabRadius(brush,pressure=1){return brush.size*(brush.pressureSize?Math.max(.05,clamp(pressure)**brush.sizeCurve):1)/2;}
/** Smudge samples the colour under its tip every `stride` pixels, bounding
 * the pickup to a 64×64 grid however large the tip is. */
export const smudgeStride=(width,height)=>Math.max(1,Math.ceil(Math.max(width,height)/64));

const curves=new Map();
/** Pen pressure through the cubic Bézier curve (0,0)–(x1,y1)–(x2,y2)–(1,1), as
 * a 257-entry table; null for the identity curve. */
export function pressureMap(curve=LINEAR_PRESSURE){
  const [x1,y1,x2,y2]=curve;if(Math.abs(x1-y1)<1e-6&&Math.abs(x2-y2)<1e-6)return null;
  const key=curve.join();let lut=curves.get(key);
  if(!lut){
    const bez=(t,a,b)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;lut=new Float32Array(257);
    for(let i=0;i<=256;i++){const x=i/256;let lo=0,hi=1;for(let k=0;k<32;k++){const mid=(lo+hi)/2;if(bez(mid,x1,x2)<x)lo=mid;else hi=mid;}lut[i]=clamp(bez((lo+hi)/2,y1,y2));}
    if(curves.size>32)curves.clear();curves.set(key,lut);
  }
  return p=>{const f=clamp(p)*256,i=Math.min(255,Math.floor(f));return lut[i]+(lut[i+1]-lut[i])*(f-i);};
}
/** Deterministic per-dab jitter in [0,1): a hash of the stroke seed, the dab
 * index and the channel, so a dab's jitter never depends on painting order. */
export function jitterAt(seed,index,channel){
  let h=Math.imul(seed^0x9E3779B9,0x85EBCA6B)^Math.imul(index+1,0xC2B2AE35)^Math.imul(channel+1,0x27D4EB2F);
  h=Math.imul(h^(h>>>16),0x7FEB352D);h=Math.imul(h^(h>>>15),0x846CA68B);
  return ((h^(h>>>16))>>>0)/4294967296;
}
/** Final tip of one path dab — pressure, taper, size/opacity/angle jitter and
 * scatter — with its pixel bounds [left,top,right,bottom). Pure: the same dab
 * always has the same shape. Returns null for a dab that deposits nothing. */
export function dabShape(brush,p,seed=brush.seed){
  const pressure=clamp(p.pressure??1),i=p.index??0;
  let radius=dabRadius(brush,pressure)*(p.taper??1);
  if(brush.sizeJitter>0)radius*=1-brush.sizeJitter*jitterAt(seed,i,0);
  let x=p.x,y=p.y;
  if(brush.scatter>0){const a=jitterAt(seed,i,3)*Math.PI*2,d=jitterAt(seed,i,4)*brush.scatter*brush.size/2;x+=Math.cos(a)*d;y+=Math.sin(a)*d;}
  let opacity=brush.opacity*(brush.pressureOpacity?pressure**brush.opacityCurve:1);
  if(brush.opacityJitter>0)opacity*=1-brush.opacityJitter*jitterAt(seed,i,1);
  const flow=brush.flow*(brush.pressureFlow?pressure:1);
  if(opacity<=0||flow<=0||radius<=0)return null;
  let theta=brush.angle*Math.PI/180+(brush.angleMode==='direction'?p.dir??0:brush.angleMode==='tilt'&&(p.ax||p.ay)?Math.atan2(p.ay,p.ax):0);
  if(brush.angleJitter>0)theta+=(jitterAt(seed,i,2)*2-1)*Math.PI*brush.angleJitter;
  const cos=Math.cos(theta),sin=Math.sin(theta);
  let hx=radius,hy=radius;
  if(brush.roundness<.999){const rb=radius*brush.roundness;hx=Math.sqrt((radius*cos)**2+(rb*sin)**2);hy=Math.sqrt((radius*sin)**2+(rb*cos)**2);}
  return {x,y,radius,opacity,flow,cos,sin,left:Math.floor(x-hx),top:Math.floor(y-hy),right:Math.ceil(x+hx),bottom:Math.ceil(y+hy)};
}
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,pressure:a.pressure+(b.pressure-a.pressure)*t,time:a.time+(b.time-a.time)*t,ax:a.ax+(b.ax-a.ax)*t,ay:a.ay+(b.ay-a.ay)*t});
/** Taper profile: rises quickly from a point and eases into full size. */
const taperCurve=t=>t>=1?1:Math.max(.02,1-(1-Math.max(0,t))**2);

/** Input path → evenly spaced dabs carrying their arc length (`dist`).
 * 'average' stabilization is a distance-windowed trailing average over the
 * raw path, so every sample yields output with no dead zone; 'string' is a
 * pulled string (lazy nezumi): the tip moves only once the pointer is more
 * than the string length away, and the stroke ends at the tip. Consecutive
 * points are joined by quadratic midpoint segments, which keeps corners
 * smooth at zero lag. `spacingScale(dist)` shrinks spacing where a taper
 * shrinks the tip. */
export class StrokePath {
  constructor(settings,emit,{spacingScale=null}={}){const b=normalizeBrush(settings);Object.assign(this,{size:b.size,pressureSize:b.pressureSize,sizeCurve:b.sizeCurve,spacingRatio:b.spacingRatio,stabilization:b.stabilization,stabilizerMode:b.stabilizerMode,pixelsPerUnit:b.pixelsPerUnit,emit,spacingScale,count:0,dist:0});}
  /** Dab spacing at this pressure before the .25 px floor. */
  rawSpacing(pressure){return this.size*this.spacingRatio*(this.pressureSize?Math.max(.05,clamp(pressure)**this.sizeCurve):1);}
  /** Pulled-string length in cel pixels. */
  get stringLength(){return this.stabilization*64*this.pixelsPerUnit;}
  out(p,dist){this.lastDab=p;this.count++;p=lerp(p,p,0);p.dir=this.dir??0;p.dist=dist;this.emit(p);}
  smoothed(){return this.smoother.value();}
  sample(input) {
    if(this.closed)throw messageError(new Error(''), "errors.drawingBrush.theStrokeHasAlreadyEnded", {});
    if(![input.x,input.y,input.pressure??1,input.time??0].every(Number.isFinite))return;
    const p={x:input.x,y:input.y,pressure:input.pressure??1,time:input.time??0,ax:Number.isFinite(input.ax)?input.ax:0,ay:Number.isFinite(input.ay)?input.ay:0};
    this.rawLast=p;
    if(this.stabilization<=0){this.push(p);return;}
    if(this.stabilizerMode==='string'){
      const a=this.anchor;if(!a){this.anchor=p;this.push(p);return;}
      const dx=p.x-a.x,dy=p.y-a.y,d=Math.hypot(dx,dy),length=this.stringLength;
      // Inside the string's reach the tip rests; pressure still follows the pen.
      if(d<=length){a.pressure=p.pressure;return;}
      const k=(d-length)/d;this.anchor={...p,x:a.x+dx*k,y:a.y+dy*k};this.push(this.anchor);return;
    }
    this.smoother??=new DrawingSmoother(this.stabilization*48*this.pixelsPerUnit);
    this.push(this.smoother.add(p));
  }
  /** Push a path point: join it to the previous one with a quadratic midpoint
   * segment so every sample — smoothed or raw — produces a smooth curve. */
  push(p){
    if(!this.prevRaw){this.out(p,0);this.prevRaw=p;this.prevMid=null;this.remaining=0;return;}
    const prev=this.prevRaw,mid=lerp(prev,p,.5);
    this.curve(this.prevMid??prev,prev,mid);
    this.prevRaw=p;this.prevMid=mid;
  }
  /** Dab along the quadratic Bézier a→b with control c, sampled by arc length
   * at the running `spacing`/`remaining` accumulator. */
  curve(a,c,b){
    const scale=this.spacingScale?this.spacingScale(this.dist):1,spacingAt=pressure=>Math.max(.25,this.rawSpacing(pressure)*scale);
    const spacing=Math.min(spacingAt(a.pressure),spacingAt(c.pressure),spacingAt(b.pressure));
    const q=t=>{const u=1-t,w0=u*u,w1=2*u*t,w2=t*t;return{x:w0*a.x+w1*c.x+w2*b.x,y:w0*a.y+w1*c.y+w2*b.y,pressure:w0*a.pressure+w1*c.pressure+w2*b.pressure,time:w0*a.time+w1*c.time+w2*b.time,ax:w0*a.ax+w1*c.ax+w2*b.ax,ay:w0*a.ay+w1*c.ay+w2*b.ay};};
    const steps=Math.max(4,Math.min(64,Math.ceil((Math.hypot(c.x-a.x,c.y-a.y)+Math.hypot(b.x-c.x,b.y-c.y))/(spacing/2))));
    let prev=a;
    for(let i=1;i<=steps;i++){
      const p=q(i/steps),seg=Math.hypot(p.x-prev.x,p.y-prev.y);
      // Carry a fractional dab phase, not a distance at the previous tip size.
      // The smaller endpoint spacing keeps pressure ramps continuous too.
      if(seg>0)this.dir=Math.atan2(p.y-prev.y,p.x-prev.x);
      const step=Math.min(spacingAt(prev.pressure),spacingAt(p.pressure));
      let pos=(1-this.remaining)*step;
      while(seg>0&&seg>=pos){this.out(lerp(prev,p,pos/seg),this.dist+pos);pos+=step;}
      this.remaining=(this.remaining+seg/step)%1;this.dist+=seg;prev=p;
    }
  }
  finish(){if(this.closed)return;this.closed=true;
    // Drain the averaging tail: the smoothed point converges to the last
    // input, so the curve catches up smoothly instead of jumping.
    const smoother=this.smoother;
    if(smoother)while(smoother.size>1){smoother.shift();this.push(this.smoothed());}
    // A pulled string ends where its tip rests, not at the pointer.
    const end=this.anchor??this.rawLast;
    if(this.prevRaw&&end){
      // Close the final half-segment, then land the exact endpoint dab.
      if(end.x!==this.prevRaw.x||end.y!==this.prevRaw.y)this.push(end);
      this.push(this.prevRaw);
      if(this.lastDab?.x!==end.x||this.lastDab?.y!==end.y)this.out(end,this.dist);
    }
  }
}

/** One stroke's dab pipeline: pressure curve → StrokePath → tapers →
 * dabShape. Final dabs reach `paint(shape)` in order. With a taper-out the
 * dabs within `taperOut` of the pen stay provisional (`tailShapes()`, drawn
 * at full size and replaced every frame) until the stroke ends; then that
 * tail is re-spaced along its path and tapered to a point. A tap still paints
 * a full dot. `seed` separates the jitter of mirrored paths. */
export class BrushStroke {
  constructor(settings,paint,{seed}={}){
    const brush=this.brush=normalizeBrush(settings);
    Object.assign(this,{paint,seed:(seed??brush.seed)>>>0,pressure:pressureMap(brush.pressureCurve),index:0,tail:[],tailVersion:0,tailCache:null,closed:false});
    this.path=new StrokePath(brush,p=>this.emit(p),{spacingScale:brush.taperIn>0?d=>this.taperIn(d):null});
  }
  taperIn(dist){return this.brush.taperIn>0?taperCurve(dist/this.brush.taperIn):1;}
  /** Map one input sample through the pressure curve into the path. */
  sample(input){
    if(this.closed)throw messageError(new Error(''), "errors.drawingBrush.theStrokeHasAlreadyEnded", {});
    this.path.sample(this.pressure&&input.pressure!=null?{...input,pressure:this.pressure(input.pressure)}:input);
  }
  emit(p){
    p.index=this.index++;
    const length=this.brush.taperOut;
    if(!(length>0)){this.final(p,this.taperIn(p.dist));return;}
    // Dabs further than the taper length behind the pen can no longer change.
    const tail=this.tail;tail.push(p);this.tailVersion++;
    let n=0;while(n<tail.length-1&&p.dist-tail[n].dist>=length)n++;
    if(n)for(const q of tail.splice(0,n))this.final(q,this.taperIn(q.dist));
  }
  final(p,taper){p.taper=taper;const shape=dabShape(this.brush,p,this.seed);if(shape)this.paint(shape);}
  /** Provisional shapes of the untapered tail, cached until the tail changes. */
  tailShapes(){
    if(this.tailCache?.version===this.tailVersion)return this.tailCache.shapes;
    const shapes=[];for(const p of this.tail){p.taper=this.taperIn(p.dist);const shape=dabShape(this.brush,p,this.seed);if(shape)shapes.push(shape);}
    this.tailCache={version:this.tailVersion,shapes};return shapes;
  }
  get hasTail(){return this.brush.taperOut>0;}
  finish(){
    if(this.closed)return;
    this.path.finish();this.closed=true;
    const tail=this.tail;this.tail=[];this.tailVersion++;
    if(this.path.dist<1){
      // A tap paints a full dot whatever the tapers.
      for(const p of tail)this.final(p,1);
      const last=this.path.lastDab;if(!tail.length&&this.brush.taperIn>0&&last)this.final({...last,dir:this.path.dir??0,dist:0,index:this.index++},1);
      return;
    }
    if(tail.length)this.taperTail(tail);
  }
  /** Re-space the tail along its dabs at the shrinking tip's spacing. */
  taperTail(tail){
    const end=tail.at(-1).dist,length=this.brush.taperOut;let i=0;
    for(let d=tail[0].dist;d<=end;){
      while(i<tail.length-2&&tail[i+1].dist<d)i++;
      const a=tail[i],b=tail[Math.min(i+1,tail.length-1)],span=b.dist-a.dist,t=span>0?clamp((d-a.dist)/span):0;
      const p=lerp(a,b,t),taper=Math.min(this.taperIn(d),taperCurve((end-d)/length));
      Object.assign(p,{dir:t<.5?a.dir:b.dir,dist:d,index:this.index++});this.final(p,taper);
      d+=Math.max(.25,this.path.rawSpacing(p.pressure)*taper);
    }
  }
}
