/** Still previews of generated effects for the effects catalogue: a small
 * figure on a dark stage at a characteristic frame, drawn with the Canvas
 * renderer. Previews render one per idle slot and are cached for the session. */
import {emptyDocument,createObject,createFrame} from './demo.mjs';
import {buildGeometry} from './pivot/geometry.mjs';
import {createVfx} from './vfx.mjs';
import {createVfxClip,frameWithVfxTime} from './vfx-clips.mjs';
import {buildGeneratorBatch,generatorSchedule,scheduleWalker} from './vfx-generators.mjs';
import {drawGeneratorDraws} from './vfx-generator-canvas.mjs';
import {isGeneratorType} from './vfx-registry.mjs';
import {prewarmAtlas} from './vfx-generator-atlas.mjs';

const STAGE={width:240,height:160},WIDTH=120,HEIGHT=80,cache=new Map(),queue=[];let scheduled=false;

/** Whether a catalogue entry has a generated preview: the generated effect types. */
export const hasEffectPreview=(mode,key)=>mode==='add'&&isGeneratorType(key);
/** A cached preview image URL, or null while it renders. */
export const cachedEffectPreview=(mode,key)=>cache.get(`${mode}:${key}`)??null;
/** Render the preview for `key` in idle time and hand it to `done(url)`. */
export function requestEffectPreview(mode,key,done){
 const id=`${mode}:${key}`,url=cache.get(id);if(url){done(url);return;}
 queue.push({id,mode,key,done});if(!scheduled){scheduled=true;void prewarmAtlas().then(()=>idle(drain));}
}
const idle=fn=>typeof requestIdleCallback==='function'?requestIdleCallback(fn,{timeout:250}):setTimeout(()=>fn({timeRemaining:()=>8}),16);
function drain(deadline){
 scheduled=false;
 while(queue.length){
  const job=queue.shift();let url=cache.get(job.id);
  if(url===undefined){try{url=renderPreview(job.mode,job.key);}catch{url=null;}cache.set(job.id,url);}
  if(url)job.done(url);
  if(deadline.timeRemaining()<4)break;
 }
 if(queue.length&&!scheduled){scheduled=true;idle(drain);}
}
/** The frame that shows an effect at its most characteristic moment. */
function previewTick(effects,duration){
 let tick=0;
 for(const [type,p={}] of effects){
  const t=type==='explosion'?[10,10,12,22,40,20,10,14,16,10][p.style??0]:type==='beam'?(p.charge??12)+(p.travel??6)+6:type==='aura'?40:type==='smoke'?(p.emission===1?16:46):p.emission===1?Math.min(10,(p.life??30)*.4):30;
  tick=Math.max(tick,t+(p.delay??0));
 }
 return Math.floor(duration===null?Math.max(tick,80):Math.min(tick,Math.max(1,duration-1)));
}
function renderPreview(mode,key){
 const effects=[[key,{}]],duration=48,scene=false,beam=key==='beam';
 const report=emptyDocument(),figure=report.figure_types[0];Object.assign(report,{canvas_width:STAGE.width,canvas_height:STAGE.height});
 const frame={...createFrame([createObject(figure,1,beam?48:STAGE.width/2,STAGE.height*.62,{scale:.42})],20),_stykBackgroundColor:0xff15131d};report.keyframes=[frame];
 const target=scene?{kind:'scene'}:{kind:'figure',uid:1},clip=createVfxClip(target,effects[0][0],'preview','effect0',{start:0,duration});
 clip.effects=effects.map(([type,params],i)=>{const effect=createVfx(type,`effect${i}`);return {...effect,params:{...effect.params,...params,seed:7,...(type==='beam'?{aimX:.9,aimY:.52}:{})}};});
 report._styk.vfxClips={version:1,clips:[clip]};
 const timed=frameWithVfxTime(report,frame,previewTick(effects,duration)),geometry=buildGeometry(report,timed),batch=buildGeneratorBatch(report,timed,geometry);
 const dpr=Math.min(2,globalThis.devicePixelRatio||1),canvas=document.createElement('canvas');canvas.width=Math.round(WIDTH*dpr);canvas.height=Math.round(HEIGHT*dpr);
 const ctx=canvas.getContext('2d');ctx.fillStyle='#15131d';ctx.fillRect(0,0,canvas.width,canvas.height);
 const scale=canvas.width/STAGE.width;ctx.setTransform(scale,0,0,scale,0,0);
 const drawFigure=()=>{ctx.strokeStyle=ctx.fillStyle='#d9dfeb';ctx.lineCap='round';for(const item of geometry.drawables){ctx.lineWidth=Math.max(1.5,(item.thickness||8)*.42);if(item.type==='circle'){ctx.beginPath();ctx.arc((item.start.x+item.end.x)/2,(item.start.y+item.end.y)/2,Math.abs(item.length)/2,0,Math.PI*2);ctx.fill();}else{ctx.beginPath();ctx.moveTo(item.start.x,item.start.y);ctx.lineTo(item.end.x,item.end.y);ctx.stroke();}}};
 const walker=batch?scheduleWalker(generatorSchedule(batch),draws=>drawGeneratorDraws(ctx,batch,draws)):null;
 walker?.begin();walker?.object(1);drawFigure();walker?.end();
 return canvas.toDataURL('image/png');
}
