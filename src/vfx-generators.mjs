/** Generated effects: particles, auras, beams, explosions and smoke.
 *
 * A particle is a pure function of its layer record, instance index, seed and
 * frame. Nothing is simulated or retained between frames, so seeking, reverse
 * scrubbing, playback workers and export all produce the same particles.
 * Values that may change while particles are alive (anchor position, emission
 * amount, direction, speed, size) are read at each particle's birth tick from
 * a small per-layer table that covers only the ticks of still-visible births.
 *
 * Effect styles compile into layers (vfx-generator-styles.mjs); this module
 * packs them into records and holds `evaluateParticle`, the reference
 * implementation used by the Canvas renderer. The WGSL in
 * vfx-generator-gpu.mjs mirrors it line for line. */
import {VFX_REGISTRY,isGeneratorType} from './vfx-registry.mjs';
import {vfxClips,sampleVfxClip,sampleVfxKeys,vfxFadeAt} from './vfx-clips.mjs';
import {vfxProperty} from './vfx.mjs';
import {SHAPE,EMIT,BLEND,COLOR_STOPS,FAR,MATERIALS} from './vfx-generator-layers.mjs';
import {COMPILERS} from './vfx-generator-styles.mjs';

export {SHAPE,EMIT,BLEND,COLOR_STOPS};
/** 32 vec4 per layer record: emission, motion and colour, the movieclip
 * transform (vec4 26–27) and materials with extended motion (vec4 28–31).
 * GPU records sit on 512-byte uniform offsets. */
export const RECORD_FLOATS=128,RECORD_BYTES=512;
export const LIMITS=Object.freeze({layerParticles:65536,batchParticles:262144,batchLayers:256,tableTicks:420,segments:192});
const TAU=Math.PI*2,EMPTY=Object.freeze([]);
const clamp=(v,a,b)=>v<a?a:v>b?b:v,mix=(a,b,t)=>a+(b-a)*t;
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};

// Hashing and value noise, bit-compatible with the WGSL versions.
const f32=Math.fround,INV32=1/4294967296;
export function pcg(v){const s=(Math.imul(v>>>0,747796405)+2891336453)>>>0,w=Math.imul(((s>>>((s>>>28)+4))^s)>>>0,277803737)>>>0;return ((w>>>22)^w)>>>0;}
export const hash=(n,k,seed)=>f32(pcg((pcg((n^Math.imul(seed,1664525))>>>0)+Math.imul(k,1013904223))>>>0))*INV32;
const hash2=(x,y)=>f32(pcg((Math.imul(x|0,73856093)^Math.imul(y|0,19349663))>>>0))*INV32;
export function vnoise(x,y){
 const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);
 return mix(mix(hash2(ix,iy),hash2(ix+1,iy),ux),mix(hash2(ix,iy+1),hash2(ix+1,iy+1),ux),uy);
}

// ---------------------------------------------------------------------------
// Clip activity: particles outlive their clip by their longest lifetime.
// ---------------------------------------------------------------------------
const tails=new WeakMap();
/** Frames after a clip ends during which its particles remain visible. */
export function generatorClipTail(clip){
 let tail=tails.get(clip);if(tail!==undefined)return tail;tail=0;
 if(clip.duration!==null)for(const effect of clip.effects){
  if(!isGeneratorType(effect.type))continue;
  const end=clip.start+clip.duration,params=resolvedParams(effect);if(params.delay>=clip.duration)continue;
  for(const l of compileEffect(effect.type,params,{start:clip.start+params.delay,end,window:clip.duration-params.delay,timed:true,bodyHeight:null,startPoint:[0,0],scene:false}))
   if(l.shape!==SHAPE.beam&&l.shape!==SHAPE.arc)tail=Math.max(tail,l.start+(l.emitDur>0?l.emitDur:l.burstJitter)+l.lifeMax+echoSpan(l)-end);
 }
 tail=Math.max(0,Math.ceil(tail));tails.set(clip,tail);return tail;
}
export const hasGenerators=clip=>clip.effects.some(e=>isGeneratorType(e.type));
export function generatorClipActiveAt(clip,tick){
 if(!clip.enabled||!clip.strength||!hasGenerators(clip)||tick<clip.start)return false;
 return clip.duration===null||tick<clip.start+clip.duration+generatorClipTail(clip);
}
// Effect objects are immutable, so their resolved parameters and compiled
// layers are reused across frames while the clip timing and anchor inputs match.
const resolved=new WeakMap(),compiled=new WeakMap();
function resolvedParams(effect){let p=resolved.get(effect);if(!p){const d=VFX_REGISTRY[effect.type].params;p={};for(const [k,v] of Object.entries(d))p[k]=effect.params[k]??v.default;resolved.set(effect,p);}return p;}
function compiledLayers(effect,params,ctx){
 const key=`${ctx.start}|${ctx.end}|${ctx.window}|${ctx.fadeOut}|${ctx.scene}|${ctx.bodyHeight}|${ctx.startPoint[0].toFixed(1)},${ctx.startPoint[1].toFixed(1)}`;
 let hit=compiled.get(effect);if(hit?.key!==key){hit={key,layers:compileEffect(effect.type,params,ctx)};compiled.set(effect,hit);}
 return hit.layers;
}
const echoSpan=l=>l.echoes?l.echoes.count*l.echoes.lag:0;
function compileEffect(type,params,ctx){return COMPILERS[type](params,ctx).filter(Boolean).filter(l=>l.shape===SHAPE.beam||l.shape===SHAPE.arc||l.count>0||l.rate>0||l.rateParam);}

// ---------------------------------------------------------------------------
// Batches: everything one frame needs to draw, as transferable typed arrays.
// ---------------------------------------------------------------------------
/** Anchor data for one target at one tick, read from evaluated geometry. */
export function anchorFromGeometry(geometry,frame,target,{body=false,includeAttached=false}={}){
 const byUid=uidIndex(geometry),g=byUid.get(target.uid);if(!g)return null;
 let point=g.root;
 if(target.kind==='segment'){const joint=g.joints?.get(target.handleId);if(!joint||target.figureTypeId!==undefined&&target.figureTypeId!==g.obj.figure_type_id)return null;point=joint;}
 const members=includeAttached?subtree(frame,g.slot).map(slot=>geometry.objects.get(slot)).filter(Boolean):[g];
 const segments=[];let top=Infinity,bottom=-Infinity,left=Infinity,right=-Infinity;
 const add=(x0,y0,x1,y1)=>{segments.push(x0,y0,x1,y1);top=Math.min(top,y0,y1);bottom=Math.max(bottom,y0,y1);left=Math.min(left,x0,x1);right=Math.max(right,x0,x1);};
 for(const member of members)for(const item of member.drawables??EMPTY){
  if(!item.start||!item.end)continue;
  if(item.type==='circle'){const cx=(item.start.x+item.end.x)/2,cy=(item.start.y+item.end.y)/2,r=Math.abs(item.length)/2;for(let i=0;i<8;i++){const a=i/8*TAU,b=(i+1)/8*TAU;add(cx+Math.cos(a)*r,cy+Math.sin(a)*r,cx+Math.cos(b)*r,cy+Math.sin(b)*r);}}
  else if(item.points?.length>2){const pts=item.points,step=Math.max(1,Math.ceil((pts.length-1)/4));for(let i=0;i<pts.length-1;i+=step){const j=Math.min(pts.length-1,i+step);add(pts[i].x,pts[i].y,pts[j].x,pts[j].y);}}
  else add(item.start.x,item.start.y,item.end.x,item.end.y);
 }
 if(!segments.length){top=bottom=point.y;left=right=point.x;}
 let data=segments;
 if(segments.length/4>LIMITS.segments){const count=segments.length/4,stride=count/LIMITS.segments;data=[];for(let i=0;i<LIMITS.segments;i++){const j=Math.floor(i*stride)*4;data.push(segments[j],segments[j+1],segments[j+2],segments[j+3]);}}
 return {point:[point.x,point.y],center:[(left+right)/2,(top+bottom)/2],bottom,height:bottom-top,segments:body?Float32Array.from(data):null};
}
const uidIndexes=new WeakMap();
function uidIndex(geometry){let index=uidIndexes.get(geometry);if(!index){index=new Map();for(const g of geometry.objects?.values?.()??EMPTY)if(g?.obj)index.set(g.obj.unique_id,g);uidIndexes.set(geometry,index);}return index;}
const childMaps=new WeakMap();
function subtree(frame,slot){let children=childMaps.get(frame);if(!children){children=new Map();frame.objects.forEach((o,i)=>{const p=o?.join?.target_object_slot;if(p!==undefined){const list=children.get(p)??[];list.push(i);children.set(p,list);}});childMaps.set(frame,children);}const out=[slot];for(let i=0;i<out.length;i++)for(const c of children.get(out[i])??EMPTY)if(!out.includes(c))out.push(c);return out;}

/** The largest value a keyed parameter reaches, which sizes emission capacity. */
/** A keyed parameter as a function of tick, plus the largest value it reaches
 * (which sizes emission capacity). Unkeyed parameters are constants. */
function keyedChannel(clip,effect,param){
 const property=vfxProperty(effect.type,effect.id,param),keys=clip.keys[property],fallback=effect.params[param]??VFX_REGISTRY[effect.type].params[param].default;
 if(!keys?.length)return {max:fallback,at:()=>fallback};
 let max=fallback;for(const k of keys)max=Math.max(max,k.value);
 return {max,at:tick=>sampleVfxKeys(keys,Math.max(0,tick-clip.start+clip.offset),fallback,property)};
}

/** Solid-colour scenes decide how Auto layers blend; images count as dark. */
export function backgroundIsLight(report,frame){
 if(report?._styk?.layers?.fixed?.scene?.visible===false)return false;
 const lum=raw=>{const n=Number(raw)>>>0;return (n>>>24)<13?null:.2126*(n>>>16&255)/255+.7152*(n>>>8&255)/255+.0722*(n&255)/255;};
 const light=l=>l!==null&&l>.6;
 if(frame?._stykBackgroundColor!==undefined)return light(lum(frame._stykBackgroundColor));
 const bg=report?.backgrounds?.find(b=>Number(b.background_id)===Number(frame?.background_id));
 if(!bg)return true;
 if(bg.paint?.stops?.length){let sum=0;for(const s of bg.paint.stops)sum+=(.2126*s.color[0]+.7152*s.color[1]+.0722*s.color[2])/255;return sum/bg.paint.stops.length>.6;}
 if(bg.kind===3||bg.kind===4){const a=lum(bg.color_a),b=lum(bg.color_b);return a!==null&&b!==null&&(a+b)/2>.6;}
 if(bg.kind===2||bg.color!==undefined)return light(lum(bg.color));
 return false;
}
const IDENTITY=Object.freeze([1,0,0,1,0,0]);
/** Canvas-style affine product p·m: apply m first, then p. */
const compose=(p,m)=>[p[0]*m[0]+p[2]*m[1],p[1]*m[0]+p[3]*m[1],p[0]*m[2]+p[2]*m[3],p[1]*m[2]+p[3]*m[3],p[0]*m[4]+p[2]*m[5]+p[4],p[1]*m[4]+p[3]*m[5]+p[5]];
const MAX_NESTING=4;

/** Generator layers of one document at one frame. Movieclip containers that
 * carry generated effects contribute their inner layers, drawn beside the
 * container in its transform and opacity. */
/** Samples beyond an interactive frame budget come back as a symbol: use the
 * current pose for now and let the renderer refine on the next frame. */
const pendingSample=(sampler,report,target,tick,options,fallback,state)=>{const a=sampler.sample(report,target,tick,options);if(typeof a==='symbol'){state.incomplete=true;return fallback;}return a;};
function collectLayers(report,frame,geometry,{sampler,matrix=IDENTITY,container=null,opacity=1,depth=0,state},layers){
 const tick=frame?._vfxTimelineTick,clips=tick===undefined?EMPTY:vfxClips(report);
 const width=report.canvas_width,height=report.canvas_height;
 for(const clip of clips){
  if(layers.length>=LIMITS.batchLayers)return;
  if(!generatorClipActiveAt(clip,tick))continue;
  const scene=clip.target.kind==='scene',timed=clip.duration!==null,end=timed?clip.start+clip.duration:FAR,elapsed=clamp(tick-clip.start,0,timed?clip.duration:FAR);
  const strength=clip.strength*(timed?vfxFadeAt(clip,elapsed):1)*opacity;
  if(strength<=0)continue;
  const effects=sampleVfxClip(clip,Math.min(tick,timed?end-1e-6:tick));
  for(const [index,effect] of effects.entries()){
   if(!isGeneratorType(effect.type)||!effect.enabled)continue;
   const p=resolvedParams(effect),alpha=strength*p.effectStrength;if(alpha<=0)continue;
   const wantsBody=effect.type==='aura'||effect.type==='particles'&&p.shape===2,attached=clip.includeAttached||effect.type==='aura';
   const current=scene?null:anchorFromGeometry(geometry,frame,clip.target,{body:wantsBody,includeAttached:attached});
   if(!scene&&!current)continue;
   if(timed&&p.delay>=clip.duration)continue;
   const stagePoint=[p.x*width,p.y*height],start=clip.start+p.delay;if(tick<start)continue;
   const startAnchor=scene?null:(tick<=start+.5||!sampler?current:(pendingSample(sampler,report,clip.target,start,{includeAttached:clip.includeAttached},current,state)??current));
   // Auras scale with the target's height, in steps so compiled layers can be reused.
   const ctx={start,end,window:timed?clip.duration-p.delay:FAR,timed,fadeOut:clip.fadeOut,scene,bodyHeight:current?Math.round(current.height/4)*4:null,
    startPoint:scene?stagePoint:(effect.type==='explosion'&&clip.target.kind==='figure'?startAnchor.center:startAnchor.point)};
   let aim=null;
   if(effect.type==='beam'){aim=[p.aimX*width,p.aimY*height];if(p.aimUid){const a=anchorFromGeometry(geometry,frame,p.aimHandle?{kind:'segment',uid:p.aimUid,handleId:p.aimHandle}:{kind:'figure',uid:p.aimUid});if(a)aim=a.point;}}
   const seedBase=(Math.imul(p.seed+1,2654435761)+Math.imul(index+1,40503))>>>0;
   for(const [li,spec] of compiledLayers(effect,p,ctx).entries())
    layers.push({report,tick,clip,effect,spec,alpha,matrix,seed:((seedBase+Math.imul(li+1,97531))>>>0)&0xffffff,
     uid:container??(scene?null:clip.target.uid),scene:container===null&&scene,current,point:scene?stagePoint:current.point,aim,
     // Scene explosions stand on the ground at their own position.
     ground:scene?(effect.type==='explosion'?stagePoint[1]+40*p.size:height):(startAnchor?.bottom??height),step:p.step+1,attached});
  }
 }
 if(depth>=MAX_NESTING)return;
 for(const g of geometry?.objects?.values?.()??EMPTY){
  const nested=g?.nestedGenerators;if(!nested)continue;
  collectLayers(nested.report,nested.frame,nested.geometry,{sampler,matrix:compose(matrix,nested.matrix),container:container??g.obj.unique_id,opacity:opacity*nested.opacity,depth:depth+1,state},layers);
 }
}

/** Collect generator layers for one frame. `sampler` supplies anchor data for
 * earlier ticks (vfx-generator-anchors.mjs); without one, trails follow the
 * current pose. Returns null when nothing generated is visible. */
export function buildGeneratorBatch(report,frame,geometry,{sampler=null,density=1}={}){
 const layers=[],state={incomplete:false};collectLayers(report,frame,geometry,{sampler,state},layers);
 const batch=layers.length?packBatch(layers,sampler,density,backgroundIsLight(report,frame),state):null;
 if(batch&&state.incomplete)batch.incomplete=true;
 return batch;
}

/** Two passes: plan every layer's capacity and birth rows, then fill one typed
 * table. Body outlines are shared by all layers of one effect: world-space
 * trails keep one outline per birth tick, attached effects one current outline.
 * Echoes, halos and outlines are extra draws of the same particles. */
function packBatch(layers,sampler,density,light,state={}){
 const plans=[],blocks=new Map();let particles=0,rowCount=0,drawCount=0;
 // Layers of one target share their earlier-tick samples within this batch.
 const memo=new Map(),sampleAt=(l,tau,fallback)=>{
  let byTick=memo.get(l.clip.target);if(!byTick)memo.set(l.clip.target,byTick=new Map());
  const key=l.attached?-1-tau:tau;if(byTick.has(key))return byTick.get(key)??fallback;
  const a=sampler.sample(l.report,l.clip.target,tau,{includeAttached:l.attached});
  if(typeof a==='symbol'){state.incomplete=true;return fallback;}
  byTick.set(key,a);return a??fallback;};
 for(const l of layers){
  if(plans.length>=LIMITS.batchLayers)break;
  const s=l.spec,tick=l.tick,cs=l.clip.start,te=l.step>1?cs+Math.floor((tick-cs)/l.step)*l.step:tick;
  const beam=s.shape===SHAPE.beam||s.shape===SHAPE.arc,burst=s.emitDur<=0&&!beam,start=s.prewarm?s.start-s.lifeMax:s.start,echo=echoSpan(s);
  let count=beam?s.count:0,rate=0,rateMax=1;
  if(!beam){
   if(s.rateParam){rateMax=Math.max(1e-6,keyedChannel(l.clip,l.effect,s.rateParam).max);rate=s.rate*rateMax;}
   else rate=s.rate;
   if(s.emitDur>0){const window=s.prewarm?s.emitDur+s.lifeMax:s.emitDur;count=Math.min(Math.ceil(rate*s.lifeMax)+2,Math.ceil(rate*Math.min(window,FAR))+2);}
   else count=Math.round(s.count);
  }
  count=Math.max(0,Math.min(LIMITS.layerParticles,count,LIMITS.batchParticles-particles));
  if(!count)continue;
  const first=burst?Math.floor(start):Math.max(Math.floor(start),Math.floor(te-s.lifeMax-echo)-1);
  const last=burst?Math.ceil(start+s.burstJitter)+1:Math.min(Math.ceil(te)+1,Math.floor(start+(s.prewarm?s.emitDur+s.lifeMax:s.emitDur))+1);
  if(!beam&&(last<first||te<start||burst&&te>start+s.burstJitter+s.lifeMax+echo))continue;
  const tick0=beam?Math.floor(te):first,ticks=Math.max(1,Math.min(LIMITS.tableTicks,(beam?0:last-first)+1));
  let block=null;
  if(s.body&&l.current?.segments?.length){
   const world=Boolean(s.world&&sampler&&l.clip.target.kind!=='scene');
   let byEffect=blocks.get(l.current);if(!byEffect)blocks.set(l.current,byEffect={});
   block=byEffect[world?'world':'fixed']??={l,world,first:Infinity,last:-Infinity,segCount:l.current.segments.length/4};
   if(world){block.first=Math.min(block.first,tick0);block.last=Math.max(block.last,tick0+ticks-1);}
  }
  const copies=beam?(s.outline?1:0):(s.echoes?.count??0)+(s.halo?1:0)+(s.outline?1:0);
  plans.push({l,te,beam,burst,start,count,rate,rateMax,tick0,ticks,block});particles+=count;rowCount+=ticks;drawCount+=1+copies;
 }
 if(!plans.length)return null;
 let floats=rowCount*8;
 for(const byEffect of blocks.values())for(const block of Object.values(byEffect)){block.rows=block.world?Math.min(LIMITS.tableTicks,block.last-block.first+1):1;if(!block.world)block.first=0;floats+=block.rows*block.segCount*4;}
 const table=new Float32Array(floats),records=new Float32Array(drawCount*RECORD_FLOATS),draws=[];let at=0,drawn=0;
 // Shared outlines first: one sampled body per birth tick of the union window.
 for(const byEffect of blocks.values())for(const block of Object.values(byEffect)){
  const {l,segCount}=block,size=segCount*4;block.start=at/4;
  for(let k=0;k<block.rows;k++){
   const tau=block.first+k;let data=l.current.segments;
   if(block.world&&Math.abs(tau-l.tick)>.5){const a=sampleAt(l,tau,null);if(a?.segments)data=fitSegments(a.segments,segCount);}
   table.set(data.length===size?data:data.subarray(0,size),at);at+=size;
  }
 }
 for(const plan of plans){
  const {l,count,rate,rateMax,tick0,ticks,block,burst}=plan,s=l.spec,report=l.report,tick=l.tick;
  const tableStart=at/4,rateAt=s.rateParam?keyedChannel(l.clip,l.effect,s.rateParam).at:null;
  const [dirAt,speedAt,sizeAt]=s.keyed?['direction','speed','size'].map(param=>keyedChannel(l.clip,l.effect,param).at):[null,null,null];
  for(let k=0;k<ticks;k++){
   const tau=tick0+k;let anchor=l.point;
   if(s.fixed)anchor=s.fixed;
   else if(l.clip.target.kind!=='scene'&&s.world&&sampler&&Math.abs(tau-tick)>.5){const a=sampleAt(l,tau,undefined);anchor=a===undefined?l.point:a?.point??null;}
   const inWindow=s.prewarm||tau>=Math.floor(l.clip.start)&&(l.clip.duration===null||tau<l.clip.start+l.clip.duration);
   let emit=anchor?(burst?1:inWindow?1:0):0;
   if(emit&&rateAt&&rateMax>0)emit=rateAt(tau)/rateMax;
   table[at]=anchor?.[0]??0;table[at+1]=anchor?.[1]??0;table[at+2]=clamp(emit*density,0,1);
   table[at+3]=dirAt?dirAt(tau)*Math.PI/180:0;table[at+4]=speedAt?speedAt(tau):1;table[at+5]=sizeAt?sizeAt(tau):1;
   // Aimed streams leave toward the beam's aim; their speed scales with its distance.
   if(s.aimed&&anchor&&l.aim){const dx=l.aim[0]-anchor[0],dy=l.aim[1]-anchor[1];table[at+3]=Math.atan2(dy,dx);table[at+4]=Math.max(.15,Math.hypot(dx,dy)/100);}
   at+=8;
  }
  let c=s.colors??[[1,1,1,1]];const op=s.opacity??[1],blend=s.blend===BLEND.auto?(light?BLEND.normal:BLEND.add):s.blend;
  // Auto layers painted solid on a light stage borrow their nearest saturated
  // colour for white-hot stops, which would otherwise vanish against it.
  if(light&&s.blend===BLEND.auto&&!plan.beam)c=inkStops(c);
  const aim=l.aim??l.point,m=l.matrix,material=s.material?MATERIALS[s.material]:null,rec=[
   plan.start,s.emitDur>0?(s.prewarm?s.emitDur+s.lifeMax:s.emitDur):0,count,rate,
   s.lifeMin,s.lifeMax,l.step,l.seed,
   s.speedMin,s.speedMax,s.angle,s.spread,
   s.gravity,s.drag,s.radial,s.turb,
   s.turbScale,s.spin,s.shape,blend,
   s.size0,s.size1,s.stretch,s.softness,
   s.fadeIn,s.fadeOut,s.alpha*l.alpha,s.colorMode,
   s.emitShape,s.emitRadius,tableStart,tick0,
   ticks,block?block.start:0,block?block.segCount:0,block?.world?block.rows:0,
   l.point[0],l.point[1],aim[0],aim[1],
   s.inherit,s.burstJitter,s.sizeJitter,s.sizeCurve,
   s.collide,l.ground,report.canvas_width,report.canvas_height,
   0,0,l.clip.start,l.clip.duration===null?FAR:l.clip.start+l.clip.duration,
   s.clipFadeIn,s.clipFadeOut,tick,s.prewarm,
   s.beamW,s.wobble,s.grow,s.fireStart,
   s.fireEnd,s.fadeFrames,s.arcSegs,s.arcAmp];
  for(let j=0;j<COLOR_STOPS;j++){const x=c[Math.min(c.length-1,j)];rec.push(x[0],x[1],x[2],x[3]);}
  for(let j=0;j<COLOR_STOPS;j++)rec.push(op[Math.min(op.length-1,j)]);
  rec.push(m[0],m[1],m[2],m[3],m[4],m[5],Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]))||1,block?.world?block.first:0);
  rec.push(plan.beam?s.beamStyle:material?material.row+1:0,material?material.col*16+material.count:0,s.shade,s.rotate,
   s.spinJitter,s.orbit,s.curl,s.curlScale,
   s.sizeMode,1,0,Math.max(.05,s.squash),
   s.flicker,s.aspect,s.frameRate,s.wind);
  const row=material?material.row:-1,push=(r,shape,drawBlend,drawRow)=>{records.set(r,draws.length*RECORD_FLOATS);draws.push({record:draws.length,count,shape,blend:drawBlend,uid:l.uid,placement:s.placement,scene:l.scene,material:drawRow});drawn+=count;};
  // Older echoes first, then the halo and outline beneath the particles themselves.
  if(s.echoes&&!plan.beam)for(let k=s.echoes.count;k>=1;k--){const r=rec.slice();r[54]=tick-k*s.echoes.lag;r[26]*=s.echoes.alpha**k;r[121]=s.echoes.size**k;push(r,s.shape,blend,row);}
  if(s.halo&&!plan.beam){const r=rec.slice();r[18]=SHAPE.disc;r[23]=2.2;r[112]=0;r[121]=s.halo.scale;r[125]=1;r[26]*=s.halo.alpha;push(r,SHAPE.disc,blend,-1);}
  if(s.outline){const r=rec.slice(),o=s.outline.color;for(let j=0;j<COLOR_STOPS;j++)r.splice(64+j*4,4,o[0],o[1],o[2],1);r[19]=BLEND.normal;r[114]=0;r[122]=s.outline.width;push(r,s.shape,BLEND.normal,row);}
  push(rec,s.shape,blend,row);
 }
 return {tick:plans[0].l.tick,records,table,draws,particles:drawn};
}
const nearWhite=c=>Math.min(c[0],c[1],c[2])>.82;
function inkStops(colors){
 if(colors.every(nearWhite))return colors;
 return colors.map((c,i)=>{if(!nearWhite(c))return c;let best=null;for(let d=1;d<colors.length&&!best;d++)for(const j of [i+d,i-d])if(colors[j]&&!nearWhite(colors[j])){best=colors[j];break;}return [best[0],best[1],best[2],c[3]];});
}
function fitSegments(segments,count){if(!segments)return null;if(segments.length===count*4)return segments;const out=new Float32Array(count*4);for(let i=0;i<count;i++){const j=Math.min(segments.length/4-1,Math.floor(i*segments.length/4/count))*4;out.set(segments.subarray(j,j+4),i*4);}return out;}
/** A draw's stage transform: its movieclip matrix then its parallax/drag offset. */
export function drawMatrix(batch,draw){const R=batch.records,o=draw.record*RECORD_FLOATS;return [R[o+104],R[o+105],R[o+106],R[o+107],R[o+108]+R[o+48],R[o+109]+R[o+49]];}

/** Placement plan: which draws go before or after each target's artwork.
 * Targets missing from the drawn groups (culled or empty) draw at the end. */
export function generatorSchedule(batch,hidden){
 const before=new Map(),after=new Map(),sceneBefore=[],sceneAfter=[];
 for(const draw of batch?.draws??EMPTY){
  if(draw.uid!==null&&hidden?.has?.(draw.uid))continue;
  if(draw.scene)(draw.placement==='behind'?sceneBefore:sceneAfter).push(draw);
  else{const map=draw.placement==='behind'?before:after,list=map.get(draw.uid)??[];list.push(draw);map.set(draw.uid,list);}
 }
 return {before,after,sceneBefore,sceneAfter,empty:!before.size&&!after.size&&!sceneBefore.length&&!sceneAfter.length};
}
/** Walk painter-ordered uids and emit generator draws at their positions. */
export function scheduleWalker(schedule,emit){
 const started=new Set();let current=null;
 const leave=()=>{if(current!==null){const list=schedule.after.get(current);if(list){emit(list);schedule.after.delete(current);}current=null;}};
 return {
  begin(){if(schedule.sceneBefore.length)emit(schedule.sceneBefore);},
  object(uid){if(uid===current)return;leave();current=uid;if(!started.has(uid)){started.add(uid);const list=schedule.before.get(uid);if(list){emit(list);schedule.before.delete(uid);}}},
  end(){leave();for(const list of schedule.before.values())emit(list);for(const list of schedule.after.values())emit(list);schedule.before.clear();schedule.after.clear();if(schedule.sceneAfter.length)emit(schedule.sceneAfter);},
 };
}

// ---------------------------------------------------------------------------
// Reference particle evaluation (Canvas renderer and tests).
// ---------------------------------------------------------------------------
/** Evaluates instance `ii` of a draw. Writes into `out` and returns true when
 * the particle is alive. Coordinates are local to the draw; drawMatrix() maps
 * them to the stage. Mirrors vs() in vfx-generator-gpu.mjs. */
export function evaluateParticle(batch,draw,ii,out){
 const R=batch.records,T=batch.table,o=draw.record*RECORD_FLOATS,v=i=>R[o+i];
 const t=v(54),cs=v(50),step=v(6),seed=v(7)>>>0;
 const te=step>1?cs+Math.floor((t-cs)/step)*step:t;
 const start=v(0),emitDur=v(1),K=v(2),rate=v(3);
 let n,born;
 if(emitDur<=0){n=ii;born=start+hash(n,1,seed)*v(41);}
 else{
  const r=Math.max(rate,1e-4),span=te-start;if(span<0)return false;
  const nMax=Math.floor(span*r),m=((nMax-ii)%K+K)%K,ni=nMax-m;if(ni<0)return false;
  n=ni;born=start+(ni+hash(n,1,seed))/r;if(born>start+emitDur)return false;
 }
 const age=te-born,life=mix(v(4),v(5),hash(n,2,seed));
 if(age<0||age>=life)return false;
 const an=age/life,tick0=v(31),ticks=v(32),tb=v(30),fb=Math.floor(born);
 const k=clamp(fb-tick0,0,ticks-1),k1=Math.min(k+1,ticks-1),fr=clamp(born-fb,0,1);
 const row=(kk,c)=>T[(tb+kk*2)*4+c],row2=(kk,c)=>T[(tb+kk*2+1)*4+c];
 if(hash(n,15,seed)>=row(k,2))return false;
 let fade=1;
 if(v(52)>0)fade*=clamp((born-v(50))/v(52),0,1);
 if(v(53)>0)fade*=clamp((v(51)-born)/v(53),0,1);
 if(fade<=.001)return false;
 const ax=mix(row(k,0),row(k1,0),fr),ay=mix(row(k,1),row(k1,1),fr);
 let px=ax,py=ay,base=v(10)+row(k,3);
 // Squash flattens point and ring emitters into the plane an orbit turns in.
 const sq=v(123),r1=hash(n,3,seed),r2=hash(n,4,seed),da=hash(n,10,seed)*TAU,dr=Math.sqrt(hash(n,9,seed)),dx=Math.cos(da)*dr,dy=Math.sin(da)*dr*sq;
 const es=v(28),er=v(29);
 if(es===EMIT.body&&v(34)>0){
  // Shared outline block: one row per birth tick, or one fixed outline.
  const count=v(34),si=Math.min(Math.floor(r1*count),count-1),rows=v(35),row=rows>0?clamp(fb-v(111),0,rows-1):0,s=(v(33)+row*count+si)*4;
  px=mix(T[s],T[s+2],r2)+dx*er;py=mix(T[s+1],T[s+3],r2)+dy*er;
 }else if(es===EMIT.beamLine||es===EMIT.beamTip){
  const [bx,by]=beamTip(R,o,te),ex=bx-v(36),ey=by-v(37),len=Math.max(Math.hypot(ex,ey),1e-3);
  base+=Math.atan2(ey,ex);
  if(es===EMIT.beamLine){px=mix(v(36),bx,r2)-ey/len*(r1-.5)*2*er;py=mix(v(37),by,r2)+ex/len*(r1-.5)*2*er;}
  else{px=bx+dx*er;py=by+dy*er;}
 }else if(es===EMIT.ring){px=ax+Math.cos(r1*TAU)*er;py=ay+Math.sin(r1*TAU)*er*sq;}
 else if(es===EMIT.ground){px=ax+(r1-.5)*2*er;py=v(45)-3;}
 else if(es===EMIT.line){px=ax-Math.sin(base)*(r1-.5)*2*er;py=ay+Math.cos(base)*(r1-.5)*2*er;}
 else if(es===EMIT.stage){
  // The stage edge the particles travel away from, spanning the whole stage.
  const cx=Math.cos(base),cy=Math.sin(base),half=Math.abs(cx)*v(46)/2+Math.abs(cy)*v(47)/2+20,span=(Math.abs(cy)*v(46)+Math.abs(cx)*v(47))*1.2;
  px=v(46)/2-cx*half-cy*(r1-.5)*span;py=v(47)/2-cy*half+cx*(r1-.5)*span;
 }
 else{px=ax+dx*er;py=ay+dy*er;}
 const ang=base+(hash(n,5,seed)-.5)*v(11);let vx=Math.cos(ang),vy=Math.sin(ang);
 if(es===EMIT.ground){const sgn=hash(n,11,seed)>.5?1:-1,up=-.3*hash(n,12,seed),l=Math.hypot(sgn,up);vx=sgn/l;vy=up/l;}
 if(v(14)!==0){const rx=px-ax,ry=py-ay,rl=Math.hypot(rx,ry);if(rl>1e-3){const sg=Math.sign(v(14)),w=Math.abs(v(14));let mx=vx+(rx/rl*sg-vx)*w+1e-5,my=vy+(ry/rl*sg-vy)*w;const ml=Math.hypot(mx,my);vx=mx/ml;vy=my/ml;}}
 const spd=mix(v(8),v(9),hash(n,6,seed))*row2(k,0);vx*=spd;vy*=spd;
 if(v(40)!==0){const kp=Math.max(k-1,0);vx+=v(40)*(row(k,0)-row(kp,0));vy+=v(40)*(row(k,1)-row(kp,1));}
 // Launch velocity with drag, plus constant gravity and wind accelerations.
 const p0x=px,p0y=py,g=v(12),gx=v(127),kd=v(13);let gdx,gdy,gvx,gvy;
 if(kd>1e-4){const e=Math.exp(-kd*age),q=(1-e)/kd,w=(age-q)/kd;px+=vx*q;py+=vy*q;vx*=e;vy*=e;gdx=gx*w;gdy=g*w;gvx=gx*q;gvy=g*q;}
 else{const h=.5*age*age;px+=vx*age;py+=vy*age;gdx=gx*h;gdy=g*h;gvx=gx*age;gvy=g*age;}
 // Orbit around the emission anchor: a flattened ring around the vertical axis
 // at each particle's own height for body, line and ground emitters, otherwise
 // a turn of the whole offset in the squashed plane.
 const orb=v(117);
 if(orb!==0){
  const a=orb*age,c=Math.cos(a),s=Math.sin(a),rx=px-ax,wx=vx;
  if(es===EMIT.body||es===EMIT.line||es===EMIT.ground){px=ax+rx*c;py+=rx*s*sq;vx=wx*c-orb*rx*s;vy+=(wx*s+orb*rx*c)*sq;}
  else{const ry=(py-ay)/sq,wy=vy/sq,nx=rx*c-ry*s,ny=rx*s+ry*c;px=ax+nx;py=ay+ny*sq;vx=wx*c-wy*s-orb*ny;vy=(wx*s+wy*c+orb*nx)*sq;}
 }
 px+=gdx;py+=gdy;vx+=gvx;vy+=gvy;
 if(v(15)>0){const qx=p0x*v(16)+hash(n,7,seed)*37,qy=p0y*v(16),tt=te*.035,nx=vnoise(qx+tt,qy)*2-1,ny=vnoise(qx+19.1,qy+tt)*2-1;px+=nx*v(15)*an;py+=ny*v(15)*an;vx+=nx*v(15)/life;vy+=ny*v(15)/life;}
 // Curl noise: a divergence-free flow sampled where the particle is, so
 // neighbours swirl together like smoke.
 if(v(118)>0){
  const sc=v(119),qx=px*sc,qy=py*sc,tt=te*.02,e=.35;
  const psi=(x,y)=>vnoise(x+tt,y)+.5*vnoise(x*2.03+13.7,y*2.03-tt);
  const p0=psi(qx,qy),gxn=psi(qx+e,qy)-p0,gyn=psi(qx,qy+e)-p0,amount=v(118)*an/e;px+=gyn*amount;py-=gxn*amount;
 }
 if(v(44)>.5&&py>v(45)-1.5){py=v(45)-1.5;vy=0;}
 const sm=v(120);let grow;
 if(sm===1){const q=1-an;grow=1-q*q*q;}
 else if(sm===2){const q=1-Math.min(an*4,1);grow=1-q*q;}
 else grow=Math.pow(Math.max(an,1e-6),v(43));
 let size=row2(k,1)*mix(v(20),v(21),grow)*(1+(hash(n,8,seed)-.5)*2*v(42))*mix(.3,1,fade);
 if(sm===2)size*=1-smoothstep(.6,1,an);
 else if(sm===3){const h=hash(n,21,seed);size*=.55+.9*vnoise(te*.45+h*61.7,h*17.3);}
 // Echo, halo and outline draws scale or widen the same particle.
 size=size>0?size*v(121)+v(122):0;
 const fi=v(24)<=0?1:smoothstep(0,v(24),an),fo=v(25)<=0?1:1-smoothstep(1-v(25),1,an);
 let alpha=v(26)*fi*fo*fade;
 if(v(124)>0){const h=hash(n,22,seed);alpha*=1-v(124)*vnoise(te*.8+h*53.1,h*29.7);}
 const rm=v(115);let rotation;
 if(rm===1)rotation=vx*vx+vy*vy>1e-6?Math.atan2(vy,vx)+Math.PI/2:0;
 else if(rm===2)rotation=(hash(n,13,seed)-.5)*.35;
 else if(rm===3)rotation=0;
 else rotation=hash(n,13,seed)*TAU+v(17)*age*(1+v(116)*((hash(n,19,seed)*2-1)*1.5-1));
 let variant=0;
 if(v(112)>0&&v(18)===SHAPE.sprite){
  const code=v(113),cells=Math.max(1,code%16),fr=v(126);let vi=Math.min(cells-1,Math.floor(hash(n,20,seed)*cells));
  if(fr>0)vi=(vi+Math.floor(age/fr))%cells;variant=Math.floor(code/16)+vi;
 }
 out.x=px;out.y=py;out.vx=vx;out.vy=vy;out.size=Math.max(0,size);out.alpha=alpha;
 out.color=v(27)>.5?hash(n,16,seed):an;out.rotation=rotation;out.variant=variant;out.n=n;
 return out.alpha>0&&out.size>0;
}
/** Color at ramp position x and stop opacity. Additive layers clip bright
 * values toward white; normal layers keep their hue at full saturation. */
export function rampColor(batch,draw,x,out){
 const R=batch.records,o=draw.record*RECORD_FLOATS,y=clamp(x,0,1)*(COLOR_STOPS-1),i=Math.min(COLOR_STOPS-2,Math.floor(y)),f=y-i,a=o+64+i*4,b=a+4;
 const intensity=mix(R[a+3],R[b+3],f),add=R[o+19]===BLEND.add,dim=!add&&intensity<1;
 for(let c=0;c<3;c++)out[c]=mix(R[a+c],R[b+c],f)*(dim?1:intensity);
 const peak=add?1:Math.max(1,out[0],out[1],out[2]);for(let c=0;c<3;c++)out[c]=Math.min(1,out[c]/peak);
 out[3]=mix(R[o+96+i],R[o+97+i],f)*(dim?Math.max(0,intensity):1);return out;
}
export function beamTip(R,o,te){const k=clamp((te-R[o+59])/Math.max(R[o+58],1),0,1),e=1-(1-k)*(1-k);return [mix(R[o+36],R[o+38],e),mix(R[o+37],R[o+39],e)];}
export function beamWidth(R,o,te){return smoothstep(R[o+59]-1,R[o+59]+2,te)*(1-smoothstep(R[o+60]-R[o+61],R[o+60],te));}
export function steppedTime(R,o){const t=R[o+54],cs=R[o+50],step=R[o+6];return step>1?cs+Math.floor((t-cs)/step)*step:t;}
/** Farthest reach of a drawn particle from its centre. */
export function particleExtent(R,o,shape,p){
 if(shape===SHAPE.ring)return p.size*(1+R[o+23]*2);
 if(shape===SHAPE.streak)return p.size+Math.hypot(p.vx,p.vy)*R[o+22];
 if(shape===SHAPE.sprite)return Math.max(p.size,p.size*R[o+125]+.5*Math.hypot(p.vx,p.vy)*R[o+22]);
 if(shape===SHAPE.square||shape===SHAPE.chunk)return p.size*1.42;
 return p.size*Math.max(1,R[o+125]);
}
/** Visible bounds of a batch in stage coordinates, for culling and tiles. */
export function generatorBatchBounds(batch){
 let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;const p={};
 for(const draw of batch?.draws??EMPTY){
  const o=draw.record*RECORD_FLOATS,R=batch.records;let lx0=Infinity,ly0=Infinity,lx1=-Infinity,ly1=-Infinity;
  const grow=(x,y,r)=>{lx0=Math.min(lx0,x-r);ly0=Math.min(ly0,y-r);lx1=Math.max(lx1,x+r);ly1=Math.max(ly1,y+r);};
  if(draw.shape===SHAPE.beam||draw.shape===SHAPE.arc){const [bx,by]=beamTip(R,o,steppedTime(R,o)),pad=(R[o+56]+R[o+122])*4+R[o+63]+16;grow(R[o+36],R[o+37],pad);grow(bx,by,pad);}
  else for(let i=0;i<draw.count;i++)if(evaluateParticle(batch,draw,i,p))grow(p.x,p.y,particleExtent(R,o,draw.shape,p));
  if(lx0>lx1)continue;
  const [a,b,c,d,e,f]=drawMatrix(batch,draw);
  for(const [x,y] of [[lx0,ly0],[lx1,ly0],[lx0,ly1],[lx1,ly1]]){const X=a*x+c*y+e,Y=b*x+d*y+f;x0=Math.min(x0,X);y0=Math.min(y0,Y);x1=Math.max(x1,X);y1=Math.max(y1,Y);}
 }
 return x0<=x1?{x:x0,y:y0,width:x1-x0,height:y1-y0}:null;
}

