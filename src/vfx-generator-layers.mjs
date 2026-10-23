import {messageError} from './localized-error.mjs';
/** Vocabulary of generated-effect layers: the sub-emitters that effect styles
 * compile into and vfx-generators.mjs packs into GPU records. Sizes and speeds
 * are stage pixels and pixels per frame; lives are frames. */
import {vfxPaint} from './vfx-paint.mjs';
import {samplePaint} from './paint.mjs';
import {MATERIALS} from './vfx-generator-atlas.mjs';

export const SHAPE=Object.freeze({disc:0,streak:1,ring:2,chunk:3,beam:4,arc:5,sprite:6,square:7});
export const EMIT=Object.freeze({point:0,body:1,beamLine:2,ring:3,beamTip:4,ground:5,line:6,stage:7});
export const BLEND=Object.freeze({normal:0,add:1,auto:2});
/** Sprite orientation: random with spin, along the motion, upright with a slight tilt, or fixed. */
export const ROTATE=Object.freeze({random:0,motion:1,upright:2,fixed:3});
/** Size over life: eased curve, fast puff, pop in and shrink away, flicker. */
export const GROW=Object.freeze({curve:0,puff:1,pop:2,flicker:3});
export const COLOR_STOPS=8,FAR=1e7;
export {MATERIALS};

const LAYER={placement:'front',start:0,emitDur:0,count:0,rate:0,lifeMin:10,lifeMax:10,speedMin:1,speedMax:1,angle:0,spread:0,gravity:0,wind:0,drag:0,radial:0,turb:0,turbScale:.01,spin:0,spinJitter:0,shape:SHAPE.disc,blend:BLEND.auto,
 size0:4,size1:4,stretch:1,softness:1,fadeIn:.1,fadeOut:.3,alpha:1,colorMode:0,emitShape:EMIT.point,emitRadius:0,inherit:0,burstJitter:0,sizeJitter:.3,sizeCurve:1,collide:0,clipFadeIn:0,clipFadeOut:0,prewarm:0,
 beamW:0,wobble:0,grow:1,fireStart:0,fireEnd:FAR,fadeFrames:1,arcSegs:14,arcAmp:0,beamStyle:0,colors:null,world:false,fixed:null,body:false,
 // Materials and extended motion.
 material:null,shade:1,rotate:ROTATE.random,aspect:1,frameRate:0,orbit:0,squash:1,curl:0,curlScale:.012,sizeMode:GROW.curve,flicker:0,
 // Extra draws of the same particles: trailing echoes, a soft glow halo and a flat outline.
 echoes:null,halo:null,outline:null,aimed:false};
/** A layer specification; a material makes it a textured sprite unless a shape is given. */
export function layer(options){
 const spec={...LAYER,...options};
 if(spec.material&&!('shape' in options))spec.shape=SHAPE.sprite;
 if(spec.material&&!MATERIALS[spec.material])throw messageError(new Error(''), "errors.vfxGeneratorLayers.unknownParticleMaterial", {material: spec.material});
 return spec;
}

const clamp=(v,a,b)=>v<a?a:v>b?b:v,mix=(a,b,t)=>a+(b-a)*t;
export const rgb=hex=>[(hex>>>16&255)/255,(hex>>>8&255)/255,(hex&255)/255];
export const tone=(c,t,to)=>c.map((v,i)=>v+(to[i]-v)*t);
export const WHITE=[1,1,1],BLACK=[0,0,0];
export function paintColor(value,at=.5){const s=samplePaint(vfxPaint(value),at);return s.color.map(v=>v/255);}
/** Eight evenly spaced stops: [r,g,b,intensity] plus stop opacity. */
export function ramp(stops){
 const colors=[],opacity=[];
 for(let i=0;i<COLOR_STOPS;i++){const x=i/(COLOR_STOPS-1)*(stops.length-1),j=Math.min(stops.length-2,Math.floor(x)),f=stops.length>1?x-j:0,a=stops[stops.length>1?j:0],b=stops[stops.length>1?j+1:0];
  colors.push([mix(a[0][0],b[0][0],f),mix(a[0][1],b[0][1],f),mix(a[0][2],b[0][2],f),mix(a[1],b[1],f)]);opacity.push(mix(a[2]??1,b[2]??1,f));}
 return {colors,opacity};
}
/** Stops as [colour, intensity, opacity?]. */
export const stops=(...entries)=>ramp(entries.map(([c,i,o=1])=>[c,i,o]));
export function paintRamp(value,intensity=1){
 const p=vfxPaint(value),colors=[],opacity=[];
 for(let i=0;i<COLOR_STOPS;i++){const s=samplePaint(p,i/(COLOR_STOPS-1));colors.push([s.color[0]/255,s.color[1]/255,s.color[2]/255,intensity]);opacity.push(s.opacity);}
 return {colors,opacity};
}
/** Gradient colours: effects such as fireworks pick one colour per particle. */
export const isGradient=value=>{const p=vfxPaint(value);return p.type!=='solid'&&p.stops.length>1;};
/** Hue-preserving colour of the same brightness family, for outlines and shadows. */
export const ink=c=>{const m=Math.max(c[0],c[1],c[2],1e-3);return c.map(v=>clamp(v/m*.18,0,1));};
