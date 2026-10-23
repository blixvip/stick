/** Looks of generated effects: each effect type and style compiles its saved
 * parameters into layer specifications (vfx-generator-layers.mjs). Styles only
 * choose layers, materials, motion and colours; the engine is shared. */
import {SHAPE,EMIT,BLEND,ROTATE,GROW,layer,rgb,tone,WHITE,BLACK,paintColor,paintRamp,stops,ink,isGradient} from './vfx-generator-layers.mjs';

const TAU=Math.PI*2,UP=-Math.PI/2;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
/** Glow layers: Auto adds light on dark scenes and paints solid colour on light ones. */
const glowBlend=p=>p.blend===1?BLEND.add:p.blend===2?BLEND.normal:BLEND.auto;
/** Figures are authored at many scales; auras follow the target's height. */
const bodyScale=height=>clamp((height||200)/200,.25,4);
const DUST=[.54,.58,.65],ROCK=[.42,.38,.36],SMOKE=[rgb(0x4a3b35),rgb(0x3a3436),rgb(0x2e2c31)];

// ---------------------------------------------------------------------------
// Auras. Each style supplies a ground effect, body glow, main layers and
// particles; the effect's toggles choose which of them draw.
// ---------------------------------------------------------------------------
const AURAS=[
 function fire({col,I,S,T,sc,base}){
  const hot=tone(col,.6,WHITE),deep=tone(col,.55,BLACK),dust=tone(DUST,.25,col);
  return {
   ground:layer({...base,placement:'behind',rate:2.2,lifeMin:26,lifeMax:44,emitShape:EMIT.ground,emitRadius:44*sc,speedMin:1.2*sc,speedMax:3.2*S*sc,drag:.06,gravity:-.01*sc,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:8*sc,size1:30*S*sc,alpha:.3,blend:BLEND.normal,fadeIn:.15,fadeOut:.6,curl:8*T*sc,curlScale:.02/sc,...stops([tone(dust,.2,col),1],[dust,1])}),
   glow:layer({...base,placement:'behind',rate:5,lifeMin:10,lifeMax:16,emitShape:EMIT.body,emitRadius:8*sc,speedMin:.2*sc,speedMax:.7*sc,angle:UP,spread:1,gravity:-.02*sc,size0:26*S*sc,size1:38*S*sc,softness:2.2,alpha:.22,fadeIn:.3,fadeOut:.5,...stops([col,1.3*I],[col,1*I],[col,.5*I])}),
   main:[
    layer({...base,placement:'behind',rate:24,lifeMin:14,lifeMax:24,emitShape:EMIT.body,emitRadius:6*sc,speedMin:1.2*S*sc,speedMax:3*S*sc,angle:UP,spread:.55,gravity:-.1*S*sc,drag:.05,curl:12*T*sc,curlScale:.016/sc,material:'flame',rotate:ROTATE.motion,frameRate:3,aspect:1.35,size0:13*(.7+.3*S)*sc,size1:4*sc,sizeCurve:.8,alpha:.7,inherit:.6,fadeIn:.12,fadeOut:.5,...stops([hot,2*I],[col,1.6*I],[col,1*I],[deep,.6*I])}),
    layer({...base,placement:'front',rate:6,lifeMin:8,lifeMax:14,emitShape:EMIT.body,emitRadius:4*sc,speedMin:1*S*sc,speedMax:2.4*S*sc,angle:UP,spread:.5,gravity:-.08*S*sc,drag:.05,curl:8*T*sc,curlScale:.02/sc,material:'flame',rotate:ROTATE.motion,frameRate:2,aspect:1.3,size0:8*sc,size1:2.5*sc,alpha:.4,inherit:.6,fadeIn:.15,fadeOut:.5,...stops([hot,2.2*I],[col,1.4*I],[deep,.5*I])}),
   ],
   particles:layer({...base,rate:3,lifeMin:25,lifeMax:45,emitShape:EMIT.body,emitRadius:22*sc,speedMin:1*sc,speedMax:2.6*S*sc,angle:UP,spread:1.2,gravity:-.035*sc,drag:.02,curl:18*T*sc,curlScale:.02/sc,size0:2.4*sc,size1:.8*sc,softness:.35,sizeJitter:.5,flicker:.5,...stops([WHITE,3.5*I],[tone(col,.4,WHITE),3*I],[col,2.2*I],[col,1*I])}),
  };
 },
 function electric({col,I,S,T,sc,base}){
  const hot=tone(col,.55,WHITE);
  return {
   ground:layer({...base,rate:2.5,lifeMin:3,lifeMax:6,emitShape:EMIT.ground,emitRadius:40*sc,speedMin:0,speedMax:0,material:'bolt',rotate:ROTATE.fixed,frameRate:1,aspect:.7,size0:16*sc,size1:16*sc,flicker:.6,fadeIn:0,fadeOut:.3,...stops([WHITE,2.4*I],[hot,2*I],[col,1.4*I])}),
   glow:layer({...base,placement:'behind',rate:5,lifeMin:8,lifeMax:14,emitShape:EMIT.body,emitRadius:8*sc,speedMin:.2*sc,speedMax:.6*sc,spread:TAU,size0:24*S*sc,size1:34*S*sc,softness:2.4,alpha:.2,flicker:.35,fadeIn:.2,fadeOut:.5,...stops([col,1.4*I],[col,1*I],[col,.5*I])}),
   main:[
    layer({...base,placement:'behind',rate:9,lifeMin:3,lifeMax:6,emitShape:EMIT.body,emitRadius:10*sc,speedMin:0,speedMax:.4*sc,spread:TAU,curl:4*T*sc,material:'bolt',frameRate:1,size0:20*S*sc,size1:16*S*sc,sizeJitter:.45,flicker:.55,fadeIn:0,fadeOut:.35,...stops([WHITE,2.6*I],[hot,2.2*I],[col,1.6*I],[col,1*I])}),
    layer({...base,rate:4,lifeMin:2,lifeMax:4,emitShape:EMIT.body,emitRadius:6*sc,speedMin:0,speedMax:.3*sc,spread:TAU,material:'bolt',frameRate:1,size0:13*S*sc,size1:11*S*sc,sizeJitter:.4,flicker:.6,fadeIn:0,fadeOut:.3,...stops([WHITE,2.8*I],[hot,2.2*I],[col,1.6*I])}),
   ],
   particles:layer({...base,rate:5,lifeMin:5,lifeMax:11,emitShape:EMIT.body,emitRadius:12*sc,speedMin:3*sc,speedMax:8*sc,spread:TAU,gravity:.18*sc,drag:.05,shape:SHAPE.streak,stretch:1.1,size0:1.6*sc,size1:.6*sc,softness:.7,fadeOut:.5,...stops([WHITE,2.6*I],[hot,2*I],[col,1.4*I])}),
  };
 },
 function shadow({col,I,S,T,sc,base}){
  const dark=tone(col,.85,BLACK),abyss=tone(col,.94,BLACK),rim=tone(col,.25,WHITE);
  return {
   ground:layer({...base,placement:'behind',rate:2.4,lifeMin:30,lifeMax:52,emitShape:EMIT.ground,emitRadius:46*sc,speedMin:.6*sc,speedMax:2*sc,drag:.05,gravity:-.004*sc,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:10*sc,size1:34*S*sc,alpha:.55,blend:BLEND.normal,shade:.6,fadeIn:.2,fadeOut:.55,curl:10*T*sc,curlScale:.02/sc,...stops([dark,1],[abyss,1])}),
   glow:layer({...base,placement:'behind',rate:4,lifeMin:10,lifeMax:18,emitShape:EMIT.body,emitRadius:8*sc,speedMin:.2*sc,speedMax:.6*sc,angle:UP,spread:1,gravity:-.02*sc,size0:26*S*sc,size1:38*S*sc,softness:2,alpha:.3,fadeIn:.3,fadeOut:.5,...stops([col,1.2*I],[col,.8*I],[col,.4*I])}),
   main:[
    layer({...base,placement:'behind',rate:10,lifeMin:22,lifeMax:38,emitShape:EMIT.body,emitRadius:6*sc,speedMin:.6*S*sc,speedMax:1.8*S*sc,angle:UP,spread:.9,gravity:-.05*S*sc,drag:.04,curl:16*T*sc,curlScale:.018/sc,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:7*sc,size1:24*S*sc,alpha:.62,blend:BLEND.normal,shade:.7,inherit:.5,fadeIn:.15,fadeOut:.55,...stops([abyss,1],[dark,1],[tone(col,.7,BLACK),1,.8])}),
    layer({...base,placement:'behind',rate:6,lifeMin:14,lifeMax:24,emitShape:EMIT.body,emitRadius:4*sc,speedMin:.8*S*sc,speedMax:2*S*sc,angle:UP,spread:.8,gravity:-.05*S*sc,drag:.04,curl:12*T*sc,curlScale:.02/sc,material:'wisp',rotate:ROTATE.motion,aspect:.8,size0:12*sc,size1:18*S*sc,alpha:.5,inherit:.5,fadeIn:.2,fadeOut:.5,...stops([rim,1.4*I],[col,1.2*I],[col,.6*I])}),
   ],
   particles:layer({...base,rate:3,lifeMin:26,lifeMax:44,emitShape:EMIT.body,emitRadius:18*sc,speedMin:.6*sc,speedMax:1.6*sc,angle:UP,spread:1.4,gravity:-.02*sc,curl:14*T*sc,curlScale:.02/sc,size0:2.2*sc,size1:1*sc,softness:.4,flicker:.45,...stops([rim,2.2*I],[col,1.8*I],[col,1*I])}),
  };
 },
 function holy({col,I,S,T,sc,base}){
  const soft=tone(col,.55,WHITE);
  return {
   ground:layer({...base,placement:'behind',rate:.6,lifeMin:18,lifeMax:24,emitShape:EMIT.ground,emitRadius:0,speedMin:0,speedMax:0,aspect:.22,softness:1.4,size0:56*sc,size1:70*sc,sizeJitter:.1,alpha:.45,fadeIn:.35,fadeOut:.45,...stops([soft,1.4*I],[col,1*I])}),
   glow:layer({...base,placement:'behind',rate:4,lifeMin:12,lifeMax:20,emitShape:EMIT.body,emitRadius:10*sc,speedMin:.1*sc,speedMax:.4*sc,angle:UP,spread:1,gravity:-.01*sc,size0:32*S*sc,size1:44*S*sc,softness:2.6,alpha:.26,fadeIn:.3,fadeOut:.5,...stops([soft,1.3*I],[col,1*I],[col,.5*I])}),
   main:[
    layer({...base,placement:'behind',rate:8,lifeMin:18,lifeMax:30,emitShape:EMIT.body,emitRadius:14*sc,speedMin:1.2*S*sc,speedMax:2.4*S*sc,angle:UP,spread:.08,shape:SHAPE.streak,stretch:6,size0:2.2*sc,size1:1*sc,softness:1.2,alpha:.55,inherit:.4,fadeIn:.3,fadeOut:.5,...stops([WHITE,1.6*I],[soft,1.4*I],[col,1*I])}),
    layer({...base,rate:1.2,lifeMin:14,lifeMax:22,emitShape:EMIT.body,emitRadius:16*sc,speedMin:.2*sc,speedMax:.6*sc,angle:UP,spread:1,gravity:-.02*sc,material:'star',sizeMode:GROW.pop,spin:.04,spinJitter:1,size0:5*sc,size1:9*sc,alpha:.9,fadeIn:.1,fadeOut:.4,...stops([WHITE,2*I],[soft,1.6*I])}),
   ],
   particles:layer({...base,rate:3,lifeMin:30,lifeMax:50,emitShape:EMIT.body,emitRadius:24*sc,speedMin:.4*sc,speedMax:1.2*sc,angle:UP,spread:1.2,gravity:-.015*sc,curl:10*T*sc,curlScale:.02/sc,material:'bokeh',rotate:ROTATE.fixed,size0:3.6*sc,size1:1.8*sc,sizeJitter:.5,flicker:.4,alpha:.8,...stops([WHITE,1.8*I],[soft,1.4*I],[col,1*I])}),
  };
 },
 function ice({col,I,S,T,sc,base}){
  const frost=tone(col,.6,WHITE),deep=tone(col,.35,BLACK);
  return {
   ground:layer({...base,rate:1.6,lifeMin:16,lifeMax:26,emitShape:EMIT.ground,emitRadius:40*sc,speedMin:0,speedMax:0,material:'shard',rotate:ROTATE.upright,aspect:1.7,sizeMode:GROW.pop,size0:3*sc,size1:12*S*sc,sizeJitter:.5,blend:BLEND.normal,fadeIn:0,fadeOut:.2,outline:{width:1.2*sc,color:ink(deep)},...stops([frost,1],[col,1])}),
   glow:layer({...base,placement:'behind',rate:4,lifeMin:12,lifeMax:20,emitShape:EMIT.body,emitRadius:8*sc,speedMin:.1*sc,speedMax:.5*sc,spread:TAU,size0:26*S*sc,size1:36*S*sc,softness:2.4,alpha:.2,fadeIn:.3,fadeOut:.5,...stops([frost,1.2*I],[col,.9*I],[col,.4*I])}),
   main:[
    layer({...base,placement:'behind',rate:7,lifeMin:26,lifeMax:44,emitShape:EMIT.body,emitRadius:10*sc,speedMin:.3*sc,speedMax:1*sc,angle:Math.PI/2,spread:2.6,gravity:.012*sc,drag:.05,curl:12*T*sc,curlScale:.018/sc,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:8*sc,size1:26*S*sc,alpha:.2,shade:.6,fadeIn:.2,fadeOut:.55,...stops([frost,1*I],[col,.8*I,.6])}),
    layer({...base,rate:1.4,lifeMin:12,lifeMax:20,emitShape:EMIT.body,emitRadius:14*sc,speedMin:.1*sc,speedMax:.4*sc,spread:TAU,material:'star',sizeMode:GROW.pop,spin:.03,spinJitter:1,size0:4*sc,size1:7*sc,fadeIn:.1,fadeOut:.4,...stops([WHITE,2*I],[frost,1.6*I])}),
   ],
   particles:layer({...base,rate:2.4,lifeMin:30,lifeMax:52,emitShape:EMIT.body,emitRadius:24*sc,speedMin:.3*sc,speedMax:1*sc,angle:UP,spread:2,gravity:-.01*sc,curl:14*T*sc,curlScale:.02/sc,material:'flake',spin:.05,spinJitter:1,size0:4.5*sc,size1:3*sc,sizeJitter:.4,alpha:.9,fadeIn:.15,fadeOut:.35,...stops([WHITE,1.4*I],[frost,1.2*I])}),
  };
 },
 function wind({col,I,S,T,sc,base}){
  const pale=tone(col,.5,WHITE),dust=tone([.62,.6,.55],.3,col),swirl=.1+.06*T;
  return {
   ground:layer({...base,placement:'behind',rate:3,lifeMin:18,lifeMax:30,emitShape:EMIT.ground,emitRadius:30*sc,speedMin:2*sc,speedMax:5*sc,drag:.07,gravity:-.01*sc,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:6*sc,size1:20*sc,alpha:.3,blend:BLEND.normal,fadeIn:.1,fadeOut:.6,curl:10*T*sc,curlScale:.02/sc,...stops([dust,1])}),
   glow:layer({...base,placement:'behind',rate:3,lifeMin:12,lifeMax:20,emitShape:EMIT.body,emitRadius:10*sc,speedMin:.1*sc,speedMax:.4*sc,spread:TAU,size0:22*S*sc,size1:30*S*sc,softness:2.6,alpha:.14,fadeIn:.3,fadeOut:.5,...stops([pale,1*I],[col,.7*I])}),
   main:[
    layer({...base,rate:6,lifeMin:16,lifeMax:26,emitShape:EMIT.body,emitRadius:26*S*sc,speedMin:.2*sc,speedMax:.6*sc,angle:UP,spread:.6,gravity:-.03*S*sc,orbit:swirl,squash:.32,material:'wisp',rotate:ROTATE.motion,aspect:.7,size0:16*S*sc,size1:24*S*sc,alpha:.6,shade:.6,fadeIn:.25,fadeOut:.45,...stops([WHITE,1.2*I],[pale,1.1*I],[col,.9*I])}),
    layer({...base,placement:'behind',rate:4,lifeMin:16,lifeMax:26,emitShape:EMIT.body,emitRadius:22*S*sc,speedMin:.2*sc,speedMax:.6*sc,angle:UP,spread:.6,gravity:-.03*S*sc,orbit:-swirl*.9,squash:.32,material:'wisp',rotate:ROTATE.motion,aspect:.7,size0:14*S*sc,size1:20*S*sc,alpha:.4,shade:.6,fadeIn:.25,fadeOut:.45,...stops([pale,1*I],[col,.8*I])}),
   ],
   particles:layer({...base,rate:2,lifeMin:24,lifeMax:40,emitShape:EMIT.body,emitRadius:30*sc,speedMin:.4*sc,speedMax:1.2*sc,angle:UP,spread:.8,gravity:-.03*sc,orbit:swirl*1.2,squash:.35,material:'leaf',spin:.12,spinJitter:1,size0:4*sc,size1:4*sc,sizeJitter:.4,blend:BLEND.normal,fadeIn:.1,fadeOut:.3,...stops([tone([.45,.7,.3],.3,col),1],[tone([.75,.62,.25],.3,col),1])}),
  };
 },
 function toon({col,I,S,T,sc,base}){
  const light=tone(col,.45,WHITE),line=ink(col),flat={...base,blend:BLEND.normal};
  return {
   ground:layer({...flat,rate:1.8,lifeMin:12,lifeMax:20,emitShape:EMIT.ground,emitRadius:36*sc,speedMin:1.2*sc,speedMax:2.6*sc,drag:.08,gravity:-.02*sc,collide:1,material:'cloud',rotate:ROTATE.fixed,sizeMode:GROW.pop,size0:3*sc,size1:13*sc,sizeJitter:.4,fadeIn:0,fadeOut:0,outline:{width:2*sc,color:line},...stops([[.96,.95,.93],1],[[.86,.85,.84],1])}),
   glow:layer({...base,placement:'behind',rate:4,lifeMin:10,lifeMax:16,emitShape:EMIT.body,emitRadius:8*sc,speedMin:.2*sc,speedMax:.6*sc,angle:UP,spread:1,size0:24*S*sc,size1:34*S*sc,softness:1.6,alpha:.2,fadeIn:.3,fadeOut:.5,...stops([light,1*I],[col,.8*I])}),
   main:layer({...flat,placement:'behind',rate:14,lifeMin:10,lifeMax:16,emitShape:EMIT.body,emitRadius:8*sc,speedMin:1.6*S*sc,speedMax:3.2*S*sc,angle:UP,spread:.4,gravity:-.1*S*sc,drag:.05,curl:6*T*sc,curlScale:.02/sc,material:'toonFlame',rotate:ROTATE.motion,frameRate:2,aspect:1.3,sizeMode:GROW.pop,size0:6*sc,size1:17*(.7+.3*S)*sc,sizeJitter:.35,inherit:.6,fadeIn:0,fadeOut:0,outline:{width:2.5*sc,color:line},...stops([light,1],[col,1],[col,1],[tone(col,.3,BLACK),1])}),
   particles:layer({...flat,rate:1.2,lifeMin:14,lifeMax:22,emitShape:EMIT.body,emitRadius:24*sc,speedMin:.6*sc,speedMax:1.4*sc,angle:UP,spread:1.4,gravity:-.02*sc,material:'toonStar',spin:.08,spinJitter:1,sizeMode:GROW.pop,size0:2*sc,size1:6*sc,fadeIn:0,fadeOut:0,outline:{width:1.5*sc,color:line},...stops([tone(col,.7,WHITE),1],[light,1])}),
  };
 },
 function spirit({col,I,S,T,sc,base}){
  const hot=tone(col,.6,WHITE),dust=tone([.6,.58,.55],.2,col);
  return {
   ground:[
    layer({...base,placement:'behind',rate:3.5,lifeMin:14,lifeMax:24,emitShape:EMIT.ground,emitRadius:14*sc,speedMin:4*sc,speedMax:8*sc,drag:.1,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:6*sc,size1:22*sc,alpha:.32,blend:BLEND.normal,fadeIn:.1,fadeOut:.6,...stops([dust,1])}),
    layer({...base,rate:.9,lifeMin:40,lifeMax:70,emitShape:EMIT.ground,emitRadius:50*sc,speedMin:.3*sc,speedMax:.9*sc,angle:UP,spread:.3,gravity:-.012*sc,drag:.01,material:'rock',spin:.04,spinJitter:1,size0:3*sc,size1:3*sc,sizeJitter:.6,blend:BLEND.normal,fadeIn:.15,fadeOut:.2,...stops([ROCK,1],[tone(ROCK,.3,BLACK),1])}),
   ],
   glow:layer({...base,placement:'behind',rate:5,lifeMin:8,lifeMax:14,emitShape:EMIT.body,emitRadius:8*sc,speedMin:.4*sc,speedMax:1*sc,angle:UP,spread:.6,gravity:-.04*sc,size0:26*S*sc,size1:36*S*sc,softness:2.2,alpha:.24,fadeIn:.3,fadeOut:.5,...stops([hot,1.3*I],[col,1*I],[col,.5*I])}),
   main:[
    layer({...base,placement:'behind',rate:18,lifeMin:8,lifeMax:14,emitShape:EMIT.body,emitRadius:10*sc,speedMin:4*S*sc,speedMax:8*S*sc,angle:UP,spread:.12,drag:.02,shape:SHAPE.streak,stretch:2.6,size0:3*sc,size1:1.2*sc,softness:1.1,alpha:.7,inherit:.4,fadeIn:.15,fadeOut:.5,...stops([WHITE,2.2*I],[hot,1.8*I],[col,1.3*I],[col,.6*I])}),
    layer({...base,rate:6,lifeMin:6,lifeMax:10,emitShape:EMIT.body,emitRadius:6*sc,speedMin:5*S*sc,speedMax:9*S*sc,angle:UP,spread:.1,shape:SHAPE.streak,stretch:2.2,size0:1.6*sc,size1:.6*sc,softness:.9,alpha:.6,inherit:.4,fadeIn:.15,fadeOut:.5,...stops([WHITE,2.6*I],[hot,1.8*I])}),
   ],
   particles:layer({...base,rate:.8,lifeMin:3,lifeMax:5,emitShape:EMIT.body,emitRadius:14*sc,speedMin:0,speedMax:0,material:'bolt',frameRate:1,size0:14*sc,size1:12*sc,flicker:.5,fadeIn:0,fadeOut:.3,...stops([WHITE,2.4*I],[hot,2*I],[col,1.4*I])}),
  };
 },
];
function compileAura(p,ctx){
 const style=AURAS[p.style]??AURAS[0],sc=bodyScale(ctx.bodyHeight);
 const base={start:ctx.start,emitDur:ctx.window,clipFadeIn:ctx.timed?14:0,clipFadeOut:ctx.timed?16:0,world:Boolean(p.trail),body:true,rateParam:'density',blend:glowBlend(p)};
 const parts=style({col:paintColor(p.color),I:p.intensity,S:p.height,T:p.turbulence,sc,base});
 return [p.dust&&parts.ground,p.glow&&parts.glow,p.flames&&parts.main,p.embers&&parts.particles].flat();
}

// ---------------------------------------------------------------------------
// Beams: energy, laser, cartoon, spiral, lightning and fire breath.
// ---------------------------------------------------------------------------
const BEAM_STYLE={energy:0,laser:1,toon:2,spiral:3};
function compileBeam(p,ctx){
 const col=paintColor(p.color),hot=tone(col,.5,WHITE),I=p.intensity,W=p.width,wr=W/16,charge=Math.round(p.charge),placement=p.layer?'behind':'front',style=p.style??0;
 const toon=style===2,line=ink(col),fireStart=ctx.start+charge,fireEnd=ctx.end,grow=Math.max(1,p.travel),firing=Math.max(1,fireEnd-fireStart);
 const beam={blend:toon?BLEND.normal:glowBlend(p),beamW:W,wobble:style===1?0:.35*p.wobble,grow,fireStart,fireEnd,fadeFrames:ctx.timed?Math.max(4,Math.min(12,ctx.fadeOut||8)):1,arcAmp:(14*p.wobble+6)*Math.max(.6,Math.sqrt(wr)),placement};
 const chargeIn=p.chargeParticles&&charge>0&&layer({...beam,start:ctx.start,emitDur:charge+2,rate:style===1?8:14,lifeMin:9,lifeMax:13,emitShape:EMIT.ring,emitRadius:72*Math.sqrt(wr),radial:-1,speedMin:6*Math.sqrt(wr),speedMax:6*Math.sqrt(wr),shape:SHAPE.streak,stretch:2.6,size0:2.6,size1:1.2,softness:toon?.05:.9,fadeIn:.25,fadeOut:.3,...stops([tone(col,.5,WHITE),2.2*I],[col,2.6*I],[WHITE,4*I],[WHITE,4*I])});
 const orb=p.orb&&layer({...beam,start:ctx.start,emitDur:Math.max(1,fireEnd-ctx.start),rate:1.5,lifeMin:6,lifeMax:8,emitRadius:2,size0:(style===1?12:18)*wr,size1:(style===1?15:22)*wr,softness:toon?.05:1.6,alpha:.9,fadeIn:toon?0:.2,fadeOut:toon?0:.6,clipFadeIn:Math.max(1,charge),clipFadeOut:ctx.timed?8:0,sizeJitter:.15,sizeMode:toon?GROW.flicker:GROW.curve,outline:toon?{width:3,color:line}:null,...stops([WHITE,3*I],[tone(col,.3,WHITE),2.2*I],[col,2*I],[col,1*I])});
 const flare=layer({...beam,start:fireStart+grow,emitDur:Math.max(1,firing-grow),rate:toon?.8:1.6,lifeMin:5,lifeMax:7,emitShape:EMIT.beamTip,emitRadius:2,material:toon?'burst':'star',sizeMode:toon?GROW.pop:GROW.curve,size0:24*Math.sqrt(wr),size1:34*Math.sqrt(wr),sizeJitter:.3,fadeIn:toon?0:.1,fadeOut:toon?0:.6,outline:toon?{width:3,color:line}:null,...stops([WHITE,2.6*I],[hot,2*I],[col,1.4*I])});
 const sparks=p.sparks>0&&layer({...beam,start:fireStart,emitDur:firing,rate:7*p.sparks,lifeMin:7,lifeMax:15,emitShape:EMIT.beamLine,emitRadius:10*wr,spread:.35,speedMin:7,speedMax:14,shape:SHAPE.streak,stretch:1.2,size0:2.2,size1:.8,softness:toon?.05:.8,fadeIn:.1,fadeOut:.5,...stops([tone(col,.6,WHITE),2.4*I],[col,1.8*I],[col,1.2*I],[col,.6*I])});
 const splash=p.splash&&p.sparks>0&&layer({...beam,start:fireStart+grow,emitDur:Math.max(1,firing-grow-4),rate:(style===1?10:7)*p.sparks,lifeMin:8,lifeMax:18,emitShape:EMIT.beamTip,emitRadius:8*wr,angle:Math.PI,spread:2.4,speedMin:4,speedMax:11,gravity:.28,drag:.04,shape:SHAPE.streak,stretch:1.1,size0:2.6,size1:1,softness:toon?.05:.7,fadeOut:.4,...stops([WHITE,4*I],[tone(col,.5,WHITE),3*I],[col,2*I],[col,.8*I])});
 const arcs=(n,{width=1,spread=1,glow=2.6}={})=>n>0&&layer({...beam,shape:SHAPE.arc,count:n*14,start:fireStart,arcAmp:beam.arcAmp*spread,size0:1.6*width*Math.max(1,wr*.6),...stops([tone(col,.35,WHITE),glow*I])});
 const core=beamStyle=>layer({...beam,shape:SHAPE.beam,count:1,start:fireStart,beamStyle,outline:toon?{width:3,color:line}:null,...stops([WHITE,3.2*I],[col,1.5*I])});
 if(style===4){
  // Lightning: forked arcs carry the strike, flashing where it starts and lands.
  const flash=at=>layer({...beam,start:fireStart,emitDur:firing,rate:1,lifeMin:2,lifeMax:3,emitShape:at,emitRadius:2,material:'star',size0:30*Math.sqrt(wr),size1:26*Math.sqrt(wr),flicker:.6,fadeIn:0,fadeOut:.4,...stops([WHITE,3*I],[hot,2.2*I],[col,1.4*I])});
  return [chargeIn,arcs(Math.max(3,p.arcs),{spread:1.6,glow:1.7}),flash(EMIT.point),p.splash&&flash(EMIT.beamTip),splash];
 }
 if(style===5){
  // Fire breath: flames stream toward the aim and reach it at the end of their life.
  const stream={placement,blend:beam.blend,start:fireStart,emitDur:firing,aimed:true,clipFadeOut:ctx.timed?Math.max(4,Math.min(12,ctx.fadeOut||8)):0};
  return [
   p.orb&&layer({...orb,start:fireStart,emitDur:firing,clipFadeIn:1,size0:14*wr,size1:18*wr}),
   layer({...stream,blend:BLEND.normal,start:fireStart+3,rate:6,lifeMin:22,lifeMax:30,emitRadius:.3*W,spread:.3,speedMin:4.2,speedMax:5,curl:10+8*p.wobble,curlScale:.015,gravity:-.05,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:.6*W,size1:2.4*W,alpha:.28,fadeIn:.3,fadeOut:.6,...stops([[.46,.44,.47],1],[[.3,.29,.31],1])}),
   layer({...stream,rate:26,lifeMin:13,lifeMax:18,emitRadius:.2*W,spread:.24,speedMin:6.2,speedMax:7.2,curl:6+8*p.wobble,curlScale:.02,gravity:-.03,material:'flame',rotate:ROTATE.motion,frameRate:2,aspect:1.2,sizeMode:GROW.puff,size0:.35*W,size1:1.6*W,sizeJitter:.3,alpha:.8,fadeIn:.05,fadeOut:.45,...stops([WHITE,2.4*I],[hot,2*I],[col,1.6*I],[tone(col,.5,BLACK),.8*I],[rgb(0x2a2220),.3])}),
   p.sparks>0&&layer({...stream,rate:8*p.sparks,lifeMin:12,lifeMax:20,emitRadius:.2*W,spread:.4,speedMin:6.5,speedMax:8.5,gravity:-.02,curl:10,curlScale:.03,size0:1.8,size1:.6,softness:.4,flicker:.5,...stops([WHITE,3*I],[hot,2.4*I],[col,1.6*I])}),
  ];
 }
 const kind=style===1?BEAM_STYLE.laser:toon?BEAM_STYLE.toon:style===3?BEAM_STYLE.spiral:BEAM_STYLE.energy;
 return [chargeIn,orb,core(kind),sparks,style===1||toon?null:arcs(style===3?Math.ceil(p.arcs/2):p.arcs),splash,p.splash&&flare];
}

// ---------------------------------------------------------------------------
// Explosions. Every layer bursts from where the target was when the clip
// began; the style decides what the blast is made of.
// ---------------------------------------------------------------------------
const EXPLOSIONS=[
 function fireball({p,col,hot,low,I,S,D,s0,window,base}){
  const dust=rgb(0x8b7d73);
  return [
   p.dust&&layer({...base,placement:'behind',start:s0+2,count:26*D,burstJitter:4,lifeMin:30,lifeMax:56,emitShape:EMIT.ground,emitRadius:80*S,speedMin:3*S,speedMax:8*S,drag:.07,gravity:-.004,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:12*S,size1:42*S,alpha:.4,shade:.9,blend:BLEND.normal,fadeIn:.1,fadeOut:.6,...stops([dust,1])}),
   p.smoke>0&&layer({...base,start:s0+4,emitDur:Math.max(2,Math.min(8,window)),rate:5*p.smoke*D,lifeMin:50,lifeMax:90,emitRadius:26*S,spread:TAU,speedMin:.5*S,speedMax:2.2*S,gravity:-.035*S,drag:.04,curl:22*S,curlScale:.009/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:18*S,size1:64*S,sizeJitter:.3,alpha:.62*Math.min(1,p.smoke),blend:BLEND.normal,fadeIn:.1,fadeOut:.55,...stops([SMOKE[0],1],[SMOKE[1],1],[SMOKE[2],1])}),
   p.debris>0&&layer({...base,start:s0,count:22*p.debris,burstJitter:1,lifeMin:34,lifeMax:56,emitRadius:12*S,angle:UP,spread:3.6,speedMin:5*S,speedMax:13*S,gravity:.45,drag:.012,collide:1,spin:.3,spinJitter:1,material:'rock',size0:4.5*S,size1:4.5*S,sizeJitter:.6,blend:BLEND.normal,fadeIn:0,fadeOut:.15,...stops([tone(col,.4,[.35,.2,.12]),1.4],[rgb(0x4a3a30),1],[rgb(0x2a2422),1],[rgb(0x2a2422),1])}),
   p.fireball&&layer({...base,start:s0,count:34*D,burstJitter:3,lifeMin:18,lifeMax:34,emitRadius:14*S,spread:TAU,speedMin:1.5*S,speedMax:6*S,drag:.11,gravity:-.06*S,curl:14*S,curlScale:.012/S,material:'smoke',spin:.03,spinJitter:1,sizeMode:GROW.puff,size0:14*S,size1:46*S,sizeJitter:.35,shade:.8,alpha:.6,fadeIn:.03,fadeOut:.5,...stops([hot,1.3*I],[col,1.3*I],[col,1.1*I],[low,.9*I],[rgb(0x2a1a16),.4])}),
   p.fireball&&layer({...base,start:s0,count:16*D,burstJitter:1,lifeMin:8,lifeMax:14,emitRadius:8*S,spread:TAU,speedMin:4*S,speedMax:9*S,drag:.12,material:'flame',rotate:ROTATE.motion,aspect:1.4,size0:22*S,size1:8*S,alpha:.6,fadeIn:0,fadeOut:.5,...stops([WHITE,2*I],[hot,1.6*I],[col,1.2*I])}),
   p.sparks&&layer({...base,start:s0,count:36*D,burstJitter:2,lifeMin:14,lifeMax:32,emitRadius:10*S,angle:UP,spread:TAU,speedMin:6*S,speedMax:19*S,gravity:.36,drag:.03,collide:1,shape:SHAPE.streak,stretch:1.3,halo:{scale:2.4,alpha:.35},size0:2.4,size1:.9,softness:.6,fadeOut:.4,...stops([WHITE,1.3*I],[hot,1.3*I],[col,1.3*I],[low,1.1*I])}),
   p.sparks&&layer({...base,start:s0+2,count:30*D,burstJitter:8,lifeMin:30,lifeMax:60,emitRadius:30*S,spread:TAU,speedMin:.5*S,speedMax:2*S,gravity:-.03*S,drag:.03,curl:20*S,curlScale:.015/S,size0:2*S,size1:.8*S,softness:.4,flicker:.5,...stops([WHITE,2.5*I],[hot,2*I],[col,1.5*I],[col,.6*I])}),
   p.ring&&layer({...base,start:s0+1,count:1,lifeMin:14,lifeMax:14,shape:SHAPE.ring,size0:24*S,size1:260*S,sizeCurve:.45,softness:.08,sizeJitter:0,alpha:.8,fadeIn:0,fadeOut:.75,...stops([hot,.8*I],[col,.6*I],[col,.4*I],[col,.15*I])}),
   p.flash&&layer({...base,start:s0,count:1,lifeMin:6,lifeMax:6,size0:80*S,size1:170*S,sizeCurve:.5,softness:2.4,sizeJitter:0,fadeIn:0,fadeOut:.85,...stops([WHITE,1*I],[hot,.9*I],[col,.7*I],[col,.25*I])}),
  ];
 },
 function cartoon({p,col,S,D,s0,base}){
  const flat={...base,blend:BLEND.normal},line=ink(col),light=tone(col,.55,WHITE),lineW=Math.max(1.5,3*S);
  return [
   p.dust&&layer({...flat,placement:'behind',start:s0+2,count:12*D,burstJitter:3,lifeMin:16,lifeMax:26,emitShape:EMIT.ground,emitRadius:60*S,speedMin:3*S,speedMax:7*S,drag:.1,collide:1,material:'cloud',rotate:ROTATE.fixed,sizeMode:GROW.pop,size0:6*S,size1:20*S,fadeIn:0,fadeOut:0,outline:{width:lineW*.8,color:line},...stops([[.95,.93,.9],1],[[.84,.82,.8],1])}),
   p.smoke>0&&layer({...flat,start:s0+6,emitDur:6,rate:3*p.smoke*D,lifeMin:26,lifeMax:40,emitRadius:30*S,spread:TAU,speedMin:.6*S,speedMax:2*S,gravity:-.04*S,drag:.05,material:'cloud',rotate:ROTATE.fixed,sizeMode:GROW.pop,size0:10*S,size1:34*S,sizeJitter:.3,fadeIn:0,fadeOut:0,outline:{width:lineW*.8,color:[.1,.09,.1]},...stops([[.9,.89,.9],1],[[.72,.7,.74],1])}),
   p.debris>0&&layer({...flat,start:s0,count:12*p.debris,burstJitter:1,lifeMin:26,lifeMax:44,emitRadius:12*S,angle:UP,spread:3.6,speedMin:6*S,speedMax:13*S,gravity:.45,drag:.012,collide:1,spin:.3,spinJitter:1,material:'shard',size0:5*S,size1:5*S,sizeJitter:.5,fadeIn:0,fadeOut:0,outline:{width:lineW*.5,color:line},...stops([[.5,.44,.4],1],[[.36,.3,.28],1])}),
   p.fireball&&layer({...flat,start:s0,count:16*D,burstJitter:2,lifeMin:14,lifeMax:24,emitRadius:14*S,spread:TAU,speedMin:2*S,speedMax:6*S,drag:.14,gravity:-.05*S,material:'cloud',rotate:ROTATE.fixed,sizeMode:GROW.pop,size0:12*S,size1:40*S,sizeJitter:.35,fadeIn:0,fadeOut:0,outline:{width:lineW,color:line},...stops([[1,.97,.7],1],[light,1],[col,1],[tone(col,.35,BLACK),1])}),
   p.sparks&&layer({...flat,start:s0,count:22*D,burstJitter:1,lifeMin:6,lifeMax:10,emitRadius:30*S,spread:TAU,speedMin:14*S,speedMax:22*S,drag:.1,shape:SHAPE.streak,stretch:1.6,size0:3*S,size1:1*S,softness:.05,fadeIn:0,fadeOut:.3,...stops([WHITE,1],[light,1])}),
   p.sparks&&layer({...flat,start:s0+2,count:6*D,burstJitter:3,lifeMin:14,lifeMax:22,emitRadius:40*S,spread:TAU,speedMin:2*S,speedMax:4*S,drag:.06,material:'toonStar',spin:.15,spinJitter:1,sizeMode:GROW.pop,size0:3*S,size1:9*S,fadeIn:0,fadeOut:0,outline:{width:lineW*.6,color:line},...stops([[1,.92,.4],1])}),
   p.ring&&layer({...flat,start:s0+1,count:1,lifeMin:10,lifeMax:10,shape:SHAPE.ring,size0:30*S,size1:200*S,sizeCurve:.5,softness:.05,sizeJitter:0,fadeIn:0,fadeOut:.5,...stops([WHITE,1],[light,1])}),
   p.flash&&layer({...flat,start:s0,count:1,lifeMin:6,lifeMax:6,material:'burst',size0:60*S,size1:90*S,sizeJitter:0,fadeIn:0,fadeOut:0,outline:{width:lineW,color:line},...stops([WHITE,1],[light,1])}),
  ];
 },
 function plasma({p,col,hot,I,S,D,s0,base}){
  // Energy gathers for five frames, then bursts.
  const b=s0+5,pale=tone(col,.7,WHITE);
  return [
   layer({...base,start:s0,emitDur:5,rate:24*D,lifeMin:5,lifeMax:6,emitShape:EMIT.ring,emitRadius:90*S,radial:-1,speedMin:16*S,speedMax:18*S,shape:SHAPE.streak,stretch:1.6,size0:2.2,size1:1.2,softness:.8,fadeIn:.3,fadeOut:.2,...stops([col,1.6*I],[WHITE,2.6*I])}),
   p.dust&&layer({...base,placement:'behind',start:b,count:1,lifeMin:26,lifeMax:26,emitShape:EMIT.ground,aspect:.22,softness:1.2,size0:60*S,size1:170*S,sizeMode:GROW.puff,sizeJitter:0,alpha:.6,fadeIn:0,fadeOut:.7,...stops([pale,1.4*I],[col,1*I])}),
   p.smoke>0&&layer({...base,start:b+2,count:10*p.smoke*D,burstJitter:4,lifeMin:30,lifeMax:50,emitRadius:30*S,spread:TAU,speedMin:.5*S,speedMax:2*S,drag:.04,curl:18*S,curlScale:.01/S,material:'smoke',sizeMode:GROW.puff,size0:20*S,size1:60*S,alpha:.25,shade:.5,fadeIn:.2,fadeOut:.6,...stops([col,.8*I],[col,.4*I])}),
   p.debris>0&&layer({...base,start:b,emitDur:14,rate:1.6*p.debris,lifeMin:3,lifeMax:6,emitRadius:50*S,material:'bolt',frameRate:1,size0:40*S,size1:30*S,sizeJitter:.4,flicker:.5,fadeIn:0,fadeOut:.4,...stops([WHITE,2.6*I],[hot,2*I],[col,1.4*I])}),
   p.fireball&&layer({...base,start:b,count:3,burstJitter:2,lifeMin:14,lifeMax:20,emitRadius:6*S,size0:40*S,size1:110*S,sizeMode:GROW.puff,softness:1.8,sizeJitter:.2,alpha:.45,fadeIn:0,fadeOut:.7,...stops([WHITE,2*I],[pale,1.6*I],[col,1.2*I],[col,.4*I])}),
   p.sparks&&layer({...base,start:b,count:50*D,burstJitter:2,lifeMin:18,lifeMax:30,emitRadius:10*S,spread:TAU,speedMin:8*S,speedMax:12*S,drag:.08,material:'star',spin:.1,spinJitter:1,size0:7*S,size1:2*S,flicker:.3,echoes:{count:3,lag:2,alpha:.5,size:.8},...stops([WHITE,2.4*I],[pale,2*I],[col,1.5*I])}),
   p.sparks&&layer({...base,start:b,count:28*D,burstJitter:1,lifeMin:10,lifeMax:20,emitRadius:8*S,spread:TAU,speedMin:10*S,speedMax:22*S,drag:.05,shape:SHAPE.streak,stretch:1.3,size0:2,size1:.8,softness:.7,fadeOut:.4,...stops([WHITE,2.4*I],[pale,2*I],[col,1.4*I])}),
   p.ring&&layer({...base,start:b,count:1,lifeMin:14,lifeMax:14,shape:SHAPE.ring,size0:20*S,size1:240*S,sizeCurve:.4,softness:.12,sizeJitter:0,fadeIn:0,fadeOut:.7,...stops([WHITE,1.4*I],[pale,1.2*I],[col,.8*I])}),
   p.ring&&layer({...base,start:b+4,count:1,lifeMin:16,lifeMax:16,shape:SHAPE.ring,size0:10*S,size1:170*S,sizeCurve:.5,softness:.2,sizeJitter:0,alpha:.6,fadeIn:0,fadeOut:.7,...stops([pale,1.2*I],[col,.8*I])}),
   p.flash&&layer({...base,start:b,count:1,lifeMin:7,lifeMax:7,size0:90*S,size1:180*S,sizeCurve:.5,softness:2.2,sizeJitter:0,fadeIn:0,fadeOut:.85,...stops([WHITE,1.2*I],[pale,1*I],[col,.6*I])}),
  ];
 },
 function smokeBomb({p,col,I,S,D,s0,window,base}){
  const flat={...base,blend:BLEND.normal},light=tone(col,.35,WHITE),deep=tone(col,.35,BLACK);
  return [
   p.dust&&layer({...flat,placement:'behind',start:s0+1,count:18*D,burstJitter:3,lifeMin:40,lifeMax:70,emitShape:EMIT.ground,emitRadius:70*S,speedMin:4*S,speedMax:9*S,drag:.08,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:14*S,size1:48*S,alpha:.7,fadeIn:.05,fadeOut:.6,...stops([light,1],[col,1])}),
   p.fireball&&layer({...flat,start:s0,count:30*D,burstJitter:3,lifeMin:60,lifeMax:110,emitRadius:20*S,spread:TAU,speedMin:2*S,speedMax:7*S,drag:.08,gravity:-.01*S,curl:20*S,curlScale:.01/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:16*S,size1:70*S,sizeJitter:.3,alpha:.85,fadeIn:.03,fadeOut:.5,...stops([light,1],[col,1],[deep,1])}),
   p.smoke>0&&layer({...flat,start:s0+6,emitDur:Math.max(4,Math.min(24,window)),rate:1.5*p.smoke*D,lifeMin:50,lifeMax:80,emitRadius:50*S,spread:1,angle:UP,speedMin:.4*S,speedMax:1.2*S,gravity:-.02*S,drag:.03,curl:24*S,curlScale:.009/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:20*S,size1:60*S,alpha:.6,fadeIn:.2,fadeOut:.6,...stops([col,1],[light,1,.7])}),
   p.debris>0&&layer({...flat,start:s0,count:6*p.debris,burstJitter:1,lifeMin:20,lifeMax:30,emitRadius:8*S,angle:UP,spread:3.4,speedMin:8*S,speedMax:14*S,gravity:.18,drag:.05,material:'smoke',rotate:ROTATE.upright,size0:9*S,size1:5*S,echoes:{count:5,lag:2,alpha:.85,size:.92},alpha:.8,fadeIn:0,fadeOut:.5,...stops([col,1],[light,1])}),
   p.sparks&&layer({...base,start:s0,count:20*D,burstJitter:1,lifeMin:8,lifeMax:16,emitRadius:6*S,spread:TAU,speedMin:6*S,speedMax:12*S,gravity:.3,drag:.05,shape:SHAPE.streak,stretch:1.2,size0:2,size1:.8,softness:.6,fadeOut:.4,...stops([WHITE,2*I],[[1,.8,.4],1.6*I],[[1,.5,.2],1*I])}),
   p.ring&&layer({...flat,start:s0+1,count:1,lifeMin:12,lifeMax:12,shape:SHAPE.ring,size0:20*S,size1:170*S,sizeCurve:.45,softness:.2,sizeJitter:0,alpha:.4,fadeIn:0,fadeOut:.7,...stops([light,1])}),
   p.flash&&layer({...base,start:s0,count:1,lifeMin:4,lifeMax:4,size0:40*S,size1:70*S,softness:2,sizeJitter:0,fadeIn:0,fadeOut:.85,...stops([WHITE,1*I],[[1,.85,.6],.8*I])}),
  ];
 },
 function mushroom({p,col,hot,low,I,S,D,s0,window,base}){
  const flat={...base,blend:BLEND.normal},fire=[[WHITE,1.4],[hot,1.3],[col,1.2],[low,1],[SMOKE[0],1],[SMOKE[2],1]],dust=rgb(0x8b7d73);
  return [
   p.dust&&layer({...flat,placement:'behind',start:s0+3,count:34*D,burstJitter:6,lifeMin:50,lifeMax:80,emitShape:EMIT.ground,emitRadius:140*S,speedMin:4*S,speedMax:10*S,drag:.06,collide:1,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:16*S,size1:56*S,alpha:.55,fadeIn:.05,fadeOut:.6,...stops([dust,1])}),
   p.smoke>0&&layer({...flat,start:s0+1,emitDur:Math.max(6,Math.min(24,window)),rate:6*Math.min(2,p.smoke)*D,lifeMin:45,lifeMax:75,emitRadius:14*S,angle:UP,spread:.12,speedMin:3*S,speedMax:8*S,drag:.035,gravity:-.01*S,curl:10*S,curlScale:.012/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:12*S,size1:34*S,alpha:.9,fadeIn:.05,fadeOut:.4,...stops(...fire)}),
   p.fireball&&layer({...flat,start:s0+2,count:40*D,burstJitter:5,lifeMin:70,lifeMax:110,emitRadius:18*S,angle:UP,spread:.7,speedMin:11*S,speedMax:15*S,drag:.06,gravity:-.02*S,curl:16*S,curlScale:.01/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:20*S,size1:62*S,sizeJitter:.3,alpha:.95,fadeIn:.02,fadeOut:.35,...stops(...fire)}),
   p.fireball&&layer({...base,start:s0+2,count:14*D,burstJitter:4,lifeMin:24,lifeMax:40,emitRadius:18*S,angle:UP,spread:.6,speedMin:11*S,speedMax:14*S,drag:.06,material:'smoke',sizeMode:GROW.puff,size0:18*S,size1:50*S,alpha:.7,shade:.6,fadeIn:.05,fadeOut:.6,...stops([WHITE,1.4*I],[hot,1.3*I],[col,1*I],[low,.4*I])}),
   p.debris>0&&layer({...flat,start:s0,count:20*p.debris,burstJitter:2,lifeMin:34,lifeMax:56,emitRadius:14*S,angle:UP,spread:2.8,speedMin:6*S,speedMax:15*S,gravity:.45,drag:.012,collide:1,spin:.3,spinJitter:1,material:'rock',size0:5*S,size1:5*S,sizeJitter:.6,fadeIn:0,fadeOut:.15,...stops([ROCK,1],[tone(ROCK,.3,BLACK),1])}),
   p.sparks&&layer({...base,start:s0+3,count:40*D,burstJitter:12,lifeMin:40,lifeMax:70,emitRadius:40*S,spread:TAU,speedMin:.5*S,speedMax:2.5*S,gravity:-.05*S,drag:.03,curl:24*S,curlScale:.012/S,size0:2.2*S,size1:.8*S,softness:.4,flicker:.5,...stops([WHITE,2.5*I],[hot,2*I],[col,1.5*I],[col,.6*I])}),
   p.ring&&layer({...base,start:s0+1,count:1,lifeMin:20,lifeMax:20,shape:SHAPE.ring,size0:40*S,size1:420*S,sizeCurve:.45,softness:.1,sizeJitter:0,alpha:.7,fadeIn:0,fadeOut:.75,...stops([hot,.9*I],[col,.6*I],[col,.3*I])}),
   p.flash&&layer({...base,start:s0,count:1,lifeMin:9,lifeMax:9,size0:140*S,size1:300*S,sizeCurve:.5,softness:2.4,sizeJitter:0,fadeIn:0,fadeOut:.85,...stops([WHITE,1.2*I],[hot,1*I],[col,.7*I],[col,.25*I])}),
  ];
 },
 function firework({p,col,hot,I,S,D,s0,multi,base}){
  const colors=multi?paintRamp(p.color,1.6*I):stops([WHITE,2.6*I],[hot,2*I],[col,1.6*I],[tone(col,.4,BLACK),1*I]),mode=multi?1:0;
  return [
   p.fireball&&layer({...base,start:s0,count:70*D,burstJitter:1,lifeMin:30,lifeMax:44,emitRadius:3*S,spread:TAU,speedMin:7*S,speedMax:8.5*S,drag:.06,gravity:.05,material:'star',spin:.08,spinJitter:1,size0:11*S,size1:3*S,flicker:.35,colorMode:mode,halo:{scale:2.2,alpha:.3},echoes:{count:4,lag:2,alpha:.6,size:.8},fadeIn:0,fadeOut:.4,...colors}),
   p.sparks&&layer({...base,start:s0+14,count:40*D,burstJitter:10,lifeMin:8,lifeMax:18,emitRadius:100*S,material:'star',size0:4*S,size1:2*S,flicker:.9,colorMode:mode,fadeIn:.2,fadeOut:.4,...colors}),
   p.sparks&&layer({...base,start:s0,count:40*D,burstJitter:1,lifeMin:20,lifeMax:34,emitRadius:3*S,spread:TAU,speedMin:4*S,speedMax:7*S,drag:.05,gravity:.06,shape:SHAPE.streak,stretch:1.6,size0:1.6,size1:.6,softness:.7,colorMode:mode,fadeOut:.5,...colors}),
   p.smoke>0&&layer({...base,blend:BLEND.normal,start:s0+4,count:8*p.smoke*D,burstJitter:4,lifeMin:40,lifeMax:70,emitRadius:60*S,speedMin:.2,speedMax:.6,gravity:-.01,curl:16*S,curlScale:.01/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:20*S,size1:50*S,alpha:.09,fadeIn:.3,fadeOut:.6,...stops([[.6,.6,.64],1])}),
   p.ring&&layer({...base,start:s0,count:1,lifeMin:12,lifeMax:12,shape:SHAPE.ring,size0:10*S,size1:140*S,sizeCurve:.5,softness:.15,sizeJitter:0,alpha:.45,fadeIn:0,fadeOut:.7,...stops([hot,1*I],[col,.6*I])}),
   p.flash&&layer({...base,start:s0,count:1,lifeMin:5,lifeMax:5,size0:30*S,size1:60*S,softness:2,sizeJitter:0,fadeIn:0,fadeOut:.8,...stops([WHITE,1.4*I],[hot,1*I])}),
  ];
 },
 function electric({p,col,hot,I,S,D,s0,base}){
  const pale=tone(col,.6,WHITE);
  return [
   p.dust&&layer({...base,start:s0,emitDur:10,rate:1.6*D,lifeMin:3,lifeMax:5,emitShape:EMIT.ground,emitRadius:80*S,material:'bolt',rotate:ROTATE.fixed,frameRate:1,aspect:.6,size0:22*S,size1:22*S,flicker:.6,fadeIn:0,fadeOut:.3,...stops([WHITE,2.4*I],[pale,2*I],[col,1.4*I])}),
   p.smoke>0&&layer({...base,start:s0+2,count:8*p.smoke*D,burstJitter:4,lifeMin:24,lifeMax:40,emitRadius:30*S,spread:TAU,speedMin:.4*S,speedMax:1.4*S,drag:.04,curl:14*S,curlScale:.012/S,material:'smoke',sizeMode:GROW.puff,size0:18*S,size1:50*S,alpha:.22,shade:.5,fadeIn:.2,fadeOut:.6,...stops([col,.8*I],[col,.3*I])}),
   p.fireball&&layer({...base,start:s0,count:12*D,burstJitter:4,lifeMin:3,lifeMax:7,emitRadius:26*S,speedMin:0,speedMax:1*S,spread:TAU,material:'bolt',frameRate:1,size0:44*S,size1:60*S,sizeJitter:.3,flicker:.5,fadeIn:0,fadeOut:.4,...stops([WHITE,2.8*I],[pale,2.2*I],[col,1.6*I])}),
   p.debris>0&&layer({...base,start:s0+2,emitDur:16,rate:2*p.debris*D,lifeMin:3,lifeMax:6,emitRadius:70*S,material:'bolt',frameRate:1,size0:26*S,size1:20*S,sizeJitter:.4,flicker:.6,fadeIn:0,fadeOut:.35,...stops([WHITE,2.4*I],[pale,2*I],[col,1.2*I])}),
   p.fireball&&layer({...base,start:s0,count:2,lifeMin:10,lifeMax:14,emitRadius:4*S,size0:40*S,size1:80*S,softness:1.8,sizeJitter:.2,flicker:.4,alpha:.8,fadeIn:0,fadeOut:.7,...stops([WHITE,2*I],[pale,1.4*I],[col,.8*I])}),
   p.sparks&&layer({...base,start:s0,count:32*D,burstJitter:3,lifeMin:8,lifeMax:18,emitRadius:10*S,spread:TAU,speedMin:8*S,speedMax:20*S,gravity:.2,drag:.05,collide:1,shape:SHAPE.streak,stretch:1.2,size0:2,size1:.7,softness:.6,fadeOut:.4,...stops([WHITE,2.4*I],[pale,2*I],[col,1.4*I])}),
   p.ring&&layer({...base,start:s0+1,count:1,lifeMin:12,lifeMax:12,shape:SHAPE.ring,size0:20*S,size1:220*S,sizeCurve:.45,softness:.1,sizeJitter:0,flicker:.4,fadeIn:0,fadeOut:.7,...stops([WHITE,1.2*I],[pale,1*I],[col,.6*I])}),
   p.flash&&layer({...base,start:s0,count:1,lifeMin:6,lifeMax:6,size0:80*S,size1:160*S,softness:2.4,sizeJitter:0,fadeIn:0,fadeOut:.85,...stops([WHITE,1.2*I],[pale,1*I],[col,.5*I])}),
  ];
 },
 function magic({p,col,I,S,D,s0,multi,base}){
  const pale=tone(col,.6,WHITE),colors=multi?paintRamp(p.color,1.6*I):stops([WHITE,2.2*I],[pale,1.8*I],[col,1.4*I]),mode=multi?1:0;
  return [
   p.dust&&layer({...base,placement:'behind',start:s0,count:1,lifeMin:30,lifeMax:30,emitShape:EMIT.ground,aspect:.24,softness:1.2,size0:40*S,size1:150*S,sizeMode:GROW.puff,sizeJitter:0,alpha:.55,fadeIn:.1,fadeOut:.7,...stops([pale,1.4*I],[col,1*I])}),
   p.smoke>0&&layer({...base,start:s0+2,count:8*p.smoke*D,burstJitter:4,lifeMin:30,lifeMax:50,emitRadius:40*S,spread:TAU,speedMin:.3*S,speedMax:1.2*S,gravity:-.02*S,drag:.04,curl:18*S,curlScale:.012/S,material:'smoke',sizeMode:GROW.puff,size0:16*S,size1:46*S,alpha:.22,shade:.4,colorMode:mode,fadeIn:.2,fadeOut:.6,...colors}),
   p.fireball&&layer({...base,start:s0,count:40*D,burstJitter:2,lifeMin:24,lifeMax:40,emitRadius:10*S,spread:TAU,speedMin:2*S,speedMax:7*S,drag:.08,gravity:-.02*S,material:'bokeh',rotate:ROTATE.fixed,size0:7*S,size1:3*S,sizeJitter:.5,flicker:.3,colorMode:mode,fadeIn:0,fadeOut:.5,...colors}),
   p.fireball&&layer({...base,start:s0,count:30*D,burstJitter:1,lifeMin:30,lifeMax:45,emitRadius:10*S,spread:TAU,radial:1,speedMin:3*S,speedMax:5*S,drag:.05,orbit:.12,material:'star',spin:.1,spinJitter:1,size0:6*S,size1:2*S,colorMode:mode,echoes:{count:2,lag:2,alpha:.5,size:.8},fadeIn:0,fadeOut:.4,...colors}),
   p.debris>0&&layer({...base,start:s0+2,count:14*p.debris,burstJitter:2,lifeMin:30,lifeMax:50,emitRadius:10*S,angle:UP,spread:3,speedMin:4*S,speedMax:9*S,gravity:.2,drag:.03,material:'toonStar',spin:.15,spinJitter:1,size0:4*S,size1:3*S,colorMode:mode,fadeIn:0,fadeOut:.3,...colors}),
   p.sparks&&layer({...base,start:s0+4,emitDur:20,rate:3*D,lifeMin:10,lifeMax:18,emitRadius:110*S,material:'star',sizeMode:GROW.pop,size0:3*S,size1:7*S,flicker:.4,colorMode:mode,fadeIn:.1,fadeOut:.4,...colors}),
   p.ring&&layer({...base,start:s0,count:1,lifeMin:16,lifeMax:16,shape:SHAPE.ring,size0:20*S,size1:200*S,sizeCurve:.5,softness:.12,sizeJitter:0,fadeIn:0,fadeOut:.7,...stops([pale,1.2*I],[col,.9*I])}),
   p.ring&&layer({...base,start:s0+5,count:1,lifeMin:14,lifeMax:14,shape:SHAPE.ring,size0:10*S,size1:130*S,sizeCurve:.5,softness:.3,sizeJitter:0,alpha:.6,fadeIn:0,fadeOut:.7,...stops([pale,1*I],[col,.7*I])}),
   p.flash&&layer({...base,start:s0,count:1,lifeMin:12,lifeMax:12,material:'star',rotate:ROTATE.fixed,sizeMode:GROW.puff,size0:50*S,size1:110*S,sizeJitter:0,fadeIn:0,fadeOut:.8,...stops([WHITE,2*I],[pale,1.6*I],[col,1*I])}),
  ];
 },
 function dust({p,col,S,D,s0,window,base}){
  const flat={...base,blend:BLEND.normal},light=tone(col,.3,WHITE),deep=tone(col,.3,BLACK);
  return [
   p.dust&&layer({...flat,placement:'behind',start:s0,count:20*D,burstJitter:3,lifeMin:36,lifeMax:66,emitShape:EMIT.ground,emitRadius:30*S,speedMin:3*S,speedMax:9*S,drag:.07,gravity:-.004,collide:1,curl:12*S,curlScale:.012/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:14*S,size1:54*S,sizeJitter:.3,alpha:.75,fadeIn:.03,fadeOut:.6,...stops([light,1],[col,1])}),
   p.fireball&&layer({...flat,start:s0,count:12*D,burstJitter:2,lifeMin:30,lifeMax:56,emitRadius:14*S,angle:UP,spread:1.6,speedMin:2*S,speedMax:5*S,drag:.07,gravity:.01,curl:14*S,curlScale:.012/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:16*S,size1:46*S,sizeJitter:.3,alpha:.8,fadeIn:.03,fadeOut:.55,...stops([light,1],[col,1],[deep,1])}),
   p.smoke>0&&layer({...flat,start:s0+6,emitDur:Math.max(4,Math.min(16,window)),rate:1.2*p.smoke*D,lifeMin:40,lifeMax:70,emitRadius:50*S,angle:UP,spread:1,speedMin:.2*S,speedMax:.8*S,gravity:-.01*S,drag:.03,curl:16*S,curlScale:.01/S,material:'smoke',rotate:ROTATE.upright,sizeMode:GROW.puff,size0:16*S,size1:50*S,alpha:.4,fadeIn:.2,fadeOut:.6,...stops([col,1],[light,1])}),
   p.debris>0&&layer({...flat,start:s0,count:18*p.debris,burstJitter:1,lifeMin:24,lifeMax:40,emitRadius:14*S,angle:UP,spread:2.6,speedMin:4*S,speedMax:10*S,gravity:.45,drag:.012,collide:1,spin:.3,spinJitter:1,material:'rock',size0:3.5*S,size1:3.5*S,sizeJitter:.6,fadeIn:0,fadeOut:.15,...stops([tone(ROCK,.3,col),1],[tone(ROCK,.3,BLACK),1])}),
   p.sparks&&layer({...flat,start:s0,count:24*D,burstJitter:1,lifeMin:14,lifeMax:26,emitRadius:10*S,angle:UP,spread:2.8,speedMin:6*S,speedMax:14*S,gravity:.5,drag:.02,collide:1,spin:.4,spinJitter:1,material:'rock',size0:1.4*S,size1:1.4*S,sizeJitter:.5,fadeIn:0,fadeOut:.2,...stops([deep,1])}),
   p.ring&&layer({...flat,start:s0+1,count:1,lifeMin:14,lifeMax:14,shape:SHAPE.ring,size0:20*S,size1:180*S,sizeCurve:.45,softness:.3,sizeJitter:0,alpha:.35,fadeIn:0,fadeOut:.7,...stops([light,1])}),
  ];
 },
 function pixel({p,col,hot,low,S,D,s0,base}){
  const flat={...base,blend:BLEND.normal},square={shape:SHAPE.square,rotate:ROTATE.fixed,fadeIn:0,fadeOut:0,sizeJitter:0},steps=stops([WHITE,1],[[1,.95,.45],1],[hot,1],[col,1],[low,1],[tone(low,.5,BLACK),1]);
  return [
   p.dust&&layer({...flat,...square,placement:'behind',start:s0+1,count:16*D,burstJitter:2,lifeMin:16,lifeMax:26,emitShape:EMIT.ground,emitRadius:50*S,speedMin:2*S,speedMax:5*S,drag:.08,collide:1,size0:5*S,size1:2*S,...stops([[.72,.66,.6],1],[[.55,.5,.46],1])}),
   p.smoke>0&&layer({...flat,...square,start:s0+4,count:14*p.smoke*D,burstJitter:4,lifeMin:26,lifeMax:40,emitRadius:26*S,angle:UP,spread:1.4,speedMin:.6*S,speedMax:1.6*S,gravity:-.03*S,drag:.04,size0:9*S,size1:3*S,...stops([[.55,.54,.58],1],[[.38,.37,.42],1])}),
   p.debris>0&&layer({...flat,...square,start:s0,count:16*p.debris,burstJitter:1,lifeMin:24,lifeMax:40,emitRadius:8*S,angle:UP,spread:3,speedMin:5*S,speedMax:12*S,gravity:.45,drag:.01,collide:1,size0:3*S,size1:3*S,...stops([[.45,.4,.36],1])}),
   p.fireball&&layer({...flat,...square,start:s0,count:40*D,burstJitter:2,lifeMin:14,lifeMax:26,emitRadius:10*S,spread:TAU,speedMin:2*S,speedMax:8*S,drag:.1,gravity:.05,size0:7*S,size1:2*S,...steps}),
   p.sparks&&layer({...flat,...square,start:s0,count:30*D,burstJitter:1,lifeMin:10,lifeMax:18,emitRadius:6*S,spread:TAU,speedMin:9*S,speedMax:16*S,drag:.06,gravity:.3,collide:1,size0:2*S,size1:2*S,...steps}),
   p.ring&&layer({...flat,...square,start:s0+1,count:28,lifeMin:10,lifeMax:10,emitShape:EMIT.ring,emitRadius:14*S,radial:1,speedMin:12*S,speedMax:12*S,drag:.1,size0:4*S,size1:2*S,...stops([WHITE,1],[hot,1])}),
   p.flash&&layer({...flat,...square,start:s0,count:1,lifeMin:3,lifeMax:3,size0:34*S,size1:44*S,...stops([WHITE,1])}),
  ];
 },
];
function compileExplosion(p,ctx){
 const col=paintColor(p.color),style=EXPLOSIONS[p.style]??EXPLOSIONS[0];
 return style({p,col,hot:tone(col,.7,WHITE),low:tone(col,.45,BLACK),I:p.intensity,S:p.size,D:p.density,s0:ctx.start,window:ctx.window,multi:isGradient(p.color),
  base:{fixed:ctx.startPoint,blend:glowBlend(p)}});
}

// ---------------------------------------------------------------------------
// Smoke: procedural puffs that rise, drift and billow.
// ---------------------------------------------------------------------------
const SMOKES=[
 // Soft, thick, steam, cartoon and ground dust.
 {alpha:.45,rate:1,size:1,rise:1,life:1,stops:c=>[[tone(c,.2,WHITE),1,.9],[c,1],[c,1,.7]]},
 {alpha:.85,rate:1.4,size:1.2,rise:.8,life:1.1,stops:c=>[[tone(c,.15,WHITE),1],[c,1],[tone(c,.35,BLACK),1]]},
 {alpha:.16,rate:.6,size:.8,rise:1.7,life:.6,shade:.35,stops:c=>[[tone(c,.6,WHITE),1],[tone(c,.4,WHITE),1,.8]]},
 {alpha:1,rate:.7,size:1,rise:1,life:.8,toon:true,stops:c=>[[tone(c,.25,WHITE),1],[c,1]]},
 {alpha:.6,rate:1,size:1.1,rise:.25,life:.9,ground:true,stops:c=>[[tone(c,.2,WHITE),1],[c,1]]},
];
function compileSmoke(p,ctx){
 const col=paintColor(p.color),look=SMOKES[p.style]??SMOKES[0],ground=look.ground&&!ctx.scene,burst=p.emission===1,size=p.size*look.size,T=p.turbulence,drag=.04,rise=p.rise*look.rise,life=p.life*look.life;
 return [layer({placement:p.layer?'behind':'front',start:ctx.start,emitDur:burst?0:ctx.window,count:burst?p.count:0,rate:burst?0:look.rate,rateParam:burst?null:'amount',burstJitter:burst?3:0,
  lifeMin:Math.max(2,life*.75),lifeMax:Math.max(3,life*1.25),world:!p.space,
  emitShape:ground?EMIT.ground:EMIT.point,emitRadius:p.spread,angle:UP,spread:ground?0:.6,
  speedMin:ground?1+.5*size/24:Math.max(0,rise*.6),speedMax:ground?2.5+size/24:Math.max(0,rise*1.3),
  // Drag settles puffs at the rise and wind speeds: constant forces over drag.
  drag,gravity:-rise*drag,wind:p.wind*drag,collide:ground?1:0,
  curl:16*T*Math.sqrt(size/24),curlScale:.3/Math.max(size,4),
  material:look.toon?'cloud':'smoke',rotate:look.toon?ROTATE.fixed:ROTATE.upright,sizeMode:look.toon?GROW.pop:GROW.puff,size0:size*.45,size1:size*p.growth,sizeJitter:.35,
  shade:(look.shade??1)*p.shading,alpha:look.alpha,blend:BLEND.normal,fadeIn:look.toon?0:.12,fadeOut:look.toon?0:.6,
  clipFadeIn:ctx.timed&&!burst?6:0,clipFadeOut:ctx.timed&&!burst?10:0,outline:look.toon?{width:Math.max(1.2,size/12),color:ink(col)}:null,...stops(...look.stops(col))})];
}

// ---------------------------------------------------------------------------
// Particles: the general emitter with every material and motion control.
// ---------------------------------------------------------------------------
/** Registry "Look" options, in saved order. Solid looks default to solid blending. */
export const PARTICLE_LOOKS=[
 {name:'Soft glow',shape:SHAPE.disc,softness:1.4},{name:'Spark',shape:SHAPE.streak,softness:.6},{name:'Dot',shape:SHAPE.disc,softness:.12},{name:'Ring',shape:SHAPE.ring,softness:.12},
 {name:'Shard',material:'shard',solid:true},{name:'Smoke',material:'smoke',solid:true,rotate:ROTATE.upright,sizeMode:GROW.puff},
 {name:'Star',material:'star'},{name:'Bokeh',material:'bokeh',rotate:ROTATE.fixed},{name:'Flame',material:'flame',rotate:ROTATE.motion,aspect:1.3,frameRate:3},
 {name:'Cartoon cloud',material:'cloud',solid:true,rotate:ROTATE.fixed},{name:'Cartoon flame',material:'toonFlame',solid:true,rotate:ROTATE.motion,aspect:1.3,frameRate:2},
 {name:'Leaf',material:'leaf',solid:true},{name:'Petal',material:'petal',solid:true},{name:'Snowflake',material:'flake'},{name:'Drop',material:'drop',solid:true,rotate:ROTATE.motion,stretch:.4},
 {name:'Heart',material:'heart',solid:true,rotate:ROTATE.upright},{name:'Cartoon star',material:'toonStar',solid:true},{name:'Pixel',shape:SHAPE.square,solid:true,rotate:ROTATE.fixed},
 {name:'Lightning',material:'bolt',frameRate:1},{name:'Wisp',material:'wisp',rotate:ROTATE.motion},{name:'Rock',material:'rock',solid:true},{name:'Splat',material:'splat',solid:true},{name:'Burst',material:'burst',solid:true},
];
const EMITTERS=[EMIT.point,EMIT.ring,EMIT.body,EMIT.line];
const DEG=Math.PI/180;
function compileParticles(p,ctx){
 const look=PARTICLE_LOOKS[p.look]??PARTICLE_LOOKS[0],v=p.variation,burst=p.emission===1,stage=ctx.scene&&p.shape===3&&p.radius===0;
 const emitShape=stage?EMIT.stage:EMITTERS[p.shape]??EMIT.point,solid=look.solid||look.shape===SHAPE.chunk;
 return [layer({placement:p.layer?'behind':'front',start:ctx.start,emitDur:burst?0:ctx.window,count:burst?p.count:0,rate:burst?0:1,rateParam:burst?null:'rate',
  lifeMin:Math.max(1,p.life*(1-v*.5)),lifeMax:Math.max(1,p.life*(1+v*.5)),speedMin:1-v*.6,speedMax:1+v*.6,spread:p.spread*DEG,gravity:p.gravity,wind:p.wind,drag:p.drag,turb:p.turbulence,turbScale:.015,
  shape:look.shape??SHAPE.sprite,material:look.material??null,softness:look.softness??1,stretch:look.shape===SHAPE.streak?p.stretch:look.stretch??0,
  blend:p.blend===1?BLEND.add:p.blend===2?BLEND.normal:solid?BLEND.normal:BLEND.auto,size0:1,size1:p.endSize,sizeJitter:v*.5,fadeIn:.08,fadeOut:p.fade,colorMode:p.colorMode,
  rotate:p.rotation?p.rotation-1:look.rotate??ROTATE.random,spin:p.spin*DEG,spinJitter:v,aspect:look.aspect??1,frameRate:look.frameRate??0,sizeMode:p.sizeMode?p.sizeMode-1:look.sizeMode??GROW.curve,
  orbit:p.swirl*DEG,curl:p.flow,curlScale:.015,flicker:p.twinkle,shade:p.shading,
  halo:p.glow>0?{scale:2.8,alpha:.45*p.glow}:null,outline:p.outline?{width:p.outlineWidth,color:paintColor(p.outlineColor)}:null,echoes:p.trail>0?{count:p.trail,lag:2,alpha:.6,size:.85}:null,
  emitShape,emitRadius:p.radius,collide:p.ground,world:!p.space,body:emitShape===EMIT.body,burstJitter:burst?2:0,prewarm:stage&&!burst?1:0,keyed:true,...paintRamp(p.color)})];
}

export const COMPILERS={aura:compileAura,beam:compileBeam,explosion:compileExplosion,particles:compileParticles,smoke:compileSmoke};
