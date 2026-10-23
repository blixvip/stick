/** Canvas 2D drawing for generated effects: the compatibility renderer,
 * software playback packets, camera monitors, thumbnails and export.
 *
 * Particles come from evaluateParticle(), the same function the WebGPU shader
 * mirrors. Each layer's colour ramp is quantized into a few tinted sprites that
 * are reused across frames, so a particle costs one drawImage. Materials use
 * the shared procedural atlas, tinted and shaded once per colour. */
import {evaluateParticle,rampColor,beamTip,beamWidth,steppedTime,drawMatrix,vnoise,pcg,hash,SHAPE,BLEND,RECORD_FLOATS} from './vfx-generators.mjs';
import {atlasRow,prewarmAtlas,shadeColor,CELL} from './vfx-generator-atlas.mjs';

// Materials tint whole strips (every variant at once) at one reduced level per
// layer and on a coarser colour ramp, so a layer needs at most eight strips.
const LEVELS=32,MATERIAL_LEVELS=8,SPRITE=64,CACHE_LIMIT=96,MATERIAL_BYTES=32*1024*1024,TAU=Math.PI*2;
const sprites=new Map();
const canvasOf=(w,h)=>{if(typeof OffscreenCanvas!=='undefined')return new OffscreenCanvas(w,h);const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const css=(r,g,b)=>`rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;

/** Alpha falloff matching soft() in the shader, for a unit-radius disc. */
function discAlpha(d,softness){return d>=1?0:Math.pow(Math.max(1-d,1e-5),softness)*(1-smooth(1-2/SPRITE,1,d));}
function paintSprite(key,width,height,alphaAt){
 let sprite=sprites.get(key);if(sprite){sprites.delete(key);sprites.set(key,sprite);return sprite;}
 sprite=canvasOf(width,height);const c=sprite.getContext('2d'),image=c.createImageData(width,height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=alphaAt((x+.5)/width,(y+.5)/height),i=(y*width+x)*4;image.data[i]=image.data[i+1]=image.data[i+2]=255;image.data[i+3]=Math.round(Math.min(1,Math.max(0,a))*255);}
 c.putImageData(image,0,0);sprites.set(key,sprite);
 while(sprites.size>CACHE_LIMIT)sprites.delete(sprites.keys().next().value);
 return sprite;
}
const softKey=s=>Math.round(s*20)/20;
const discSprite=s=>paintSprite(`disc:${softKey(s)}`,SPRITE,SPRITE,(x,y)=>discAlpha(Math.hypot(x*2-1,y*2-1),softKey(s)));
// Streak body: soft vertical profile with the shader's tail-to-head fade.
const bodySprite=s=>paintSprite(`taper:${softKey(s)}`,SPRITE,SPRITE/2,(x,y)=>discAlpha(Math.abs(y*2-1)/(.3+.7*x),softKey(s))*(smooth(0,1,x)*.9+.1));
const ringSprite=th=>{const k=Math.round(th*100)/100,grow=1+k*2;return paintSprite(`ring:${k}`,SPRITE*2,SPRITE*2,(x,y)=>{const d=Math.hypot(x*2-1,y*2-1)*grow,rd=Math.abs(d-1)/Math.max(k,.01);return Math.pow(Math.max(1-rd,0),1.6)+.18*(1-smooth(0,1,d))*(d<=1?1:0);});};
const tints=new WeakMap();
/** A white sprite multiplied by one colour; cached by sprite and quantized colour. */
function tinted(sprite,r,g,b){
 const key=`${r},${g},${b}`;let byColor=tints.get(sprite);if(!byColor){byColor=new Map();tints.set(sprite,byColor);}
 let out=byColor.get(key);if(out)return out;
 out=canvasOf(sprite.width,sprite.height);const c=out.getContext('2d');c.drawImage(sprite,0,0);c.globalCompositeOperation='source-in';c.fillStyle=`rgb(${r},${g},${b})`;c.fillRect(0,0,sprite.width,sprite.height);
 byColor.set(key,out);if(byColor.size>LEVELS*4)byColor.delete(byColor.keys().next().value);return out;
}
const quant=v=>Math.round(Math.min(1,Math.max(0,v))*255);

const materials=new Map();let materialBytes=0;
/** One material row at one level with every variant side by side, coloured
 * and shaded as the shader does. */
function materialStrip(row,level,r,g,b,shade){
 const key=`${row}:${level}:${r},${g},${b}:${shade}`;let strip=materials.get(key);
 if(strip){materials.delete(key);materials.set(key,strip);return strip;}
 prewarmAtlas();const source=atlasRow(row).levels[level],src=source.data,count=source.width*source.height,tint=[0,0,0],cr=r/255,cg=g/255,cb=b/255;
 strip=canvasOf(source.width,source.height);const c=strip.getContext('2d'),image=c.createImageData(source.width,source.height),d=image.data;
 for(let i=0;i<count;i++){
  const a=src[i*2+1];if(!a)continue;const o=i*4;
  shadeColor(cr,cg,cb,.5+(Math.min(1,src[i*2]/a)-.5)*shade,tint);d[o]=quant(tint[0]);d[o+1]=quant(tint[1]);d[o+2]=quant(tint[2]);d[o+3]=a;
 }
 c.putImageData(image,0,0);materials.set(key,strip);materialBytes+=count*4;
 while(materialBytes>MATERIAL_BYTES){const [k,v]=materials.entries().next().value;materials.delete(k);materialBytes-=v.width*v.height*4;}
 return strip;
}
/** The reduced level whose cells are at most about twice a layer's largest
 * drawn size; full-size cells are left to the GPU. */
const levelFor=pixels=>pixels>40?1:pixels>18?2:3;

/** Draw a set of generator draws with the context already mapping stage
 * coordinates to pixels. Blend and alpha state are restored afterwards. */
export function drawGeneratorDraws(ctx,batch,draws){
 if(!batch||!draws?.length)return 0;
 const stage=ctx.getTransform(),p={},color=[0,0,0,0];let drawn=0;
 ctx.save();
 try{
  for(const draw of draws){
   // Particles are local to their draw: apply its movieclip transform and offset.
   ctx.setTransform(stage);ctx.transform(...drawMatrix(batch,draw));
   const m=ctx.getTransform(),px=1/(Math.sqrt(Math.abs(m.a*m.d-m.b*m.c))||1);
   ctx.globalCompositeOperation=draw.blend===BLEND.add?'lighter':'source-over';
   if(draw.shape===SHAPE.beam){drawBeam(ctx,batch,draw,px);drawn++;continue;}
   if(draw.shape===SHAPE.arc){drawn+=drawArcs(ctx,batch,draw,px);continue;}
   const o=draw.record*RECORD_FLOATS,R=batch.records,softness=R[o+23],stretch=R[o+22],sprite=draw.shape===SHAPE.sprite;
   const base=sprite||draw.shape===SHAPE.square?null:draw.shape===SHAPE.ring?ringSprite(softness):draw.shape===SHAPE.streak?bodySprite(softness):discSprite(softness),cap=draw.shape===SHAPE.streak?discSprite(softness):null;
   const row=R[o+112]-1,shade=Math.round(R[o+114]*10)/10,aspect=R[o+125],level=sprite?levelFor(2*(Math.max(R[o+20],R[o+21])*R[o+121]+R[o+122])*Math.max(1,aspect)/px):0,cell=CELL>>level;
   for(let i=0;i<draw.count;i++){
    if(!evaluateParticle(batch,draw,i,p))continue;
    const levels=sprite?MATERIAL_LEVELS:LEVELS;rampColor(batch,draw,Math.round(p.color*(levels-1))/(levels-1),color);
    const alpha=p.alpha*color[3];if(alpha<1/512)continue;
    const r=Math.max(p.size,px*.5);ctx.globalAlpha=Math.min(1,alpha);
    const rgb=[quant(color[0]),quant(color[1]),quant(color[2])];
    if(sprite){
     const hy=r*aspect+.5*Math.hypot(p.vx,p.vy)*stretch;
     ctx.setTransform(m);ctx.translate(p.x,p.y);ctx.rotate(p.rotation);
     ctx.drawImage(materialStrip(row,level,rgb[0],rgb[1],rgb[2],shade),p.variant*cell,0,cell,cell,-r,-hy,2*r,2*hy);ctx.setTransform(m);
    }else if(draw.shape===SHAPE.square){
     ctx.fillStyle=`rgb(${rgb})`;
     if(p.rotation){ctx.setTransform(m);ctx.translate(p.x,p.y);ctx.rotate(p.rotation);ctx.fillRect(-r,-r,2*r,2*r);ctx.setTransform(m);}
     else ctx.fillRect(p.x-r,p.y-r,2*r,2*r);
    }else if(draw.shape===SHAPE.chunk){
     ctx.setTransform(m);ctx.translate(p.x,p.y);ctx.rotate(p.rotation);ctx.fillStyle=`rgb(${rgb})`;
     const s=r,ky=.55+.6*hash(p.n,14,R[o+7]>>>0);ctx.beginPath();ctx.moveTo(-s,0);ctx.lineTo(0,-s/(ky+.25));ctx.lineTo(s,0);ctx.lineTo(0,s/(ky+.25));ctx.closePath();ctx.fill();ctx.setTransform(m);
    }else if(draw.shape===SHAPE.streak){
     const sp=Math.hypot(p.vx,p.vy),hl=.5*sp*stretch;
     if(hl<=.5){ctx.drawImage(tinted(cap,...rgb),p.x-r,p.y-r,2*r,2*r);}
     else{
      const ang=Math.atan2(p.vy,p.vx);ctx.setTransform(m);ctx.translate(p.x,p.y);ctx.rotate(ang);
      // Tapered, fading body and a round head: the shader's streak.
      const c=tinted(cap,...rgb),b=tinted(base,...rgb);
      ctx.drawImage(b,-2*hl,-r,2*hl,2*r);ctx.drawImage(c,SPRITE/2,0,SPRITE/2,SPRITE,0,-r,r,2*r);ctx.setTransform(m);
     }
    }else if(draw.shape===SHAPE.ring){const e=r*(1+softness*2);ctx.drawImage(tinted(base,...rgb),p.x-e,p.y-e,2*e,2*e);}
    else{const ry=r*aspect;ctx.drawImage(tinted(base,...rgb),p.x-r,p.y-ry,2*r,2*ry);}
    drawn++;
   }
  }
 }finally{ctx.restore();}
 return drawn;
}

const profiles=new Map();
/** Beam cross-section per style: core/body/glow colours from the shader's formula. */
function beamProfile(batch,draw,style){
 const out0=rampColor(batch,draw,0,[0,0,0,0]),out1=rampColor(batch,draw,1,[0,0,0,0]),key=style+':'+[...out0,...out1].map(v=>v.toFixed(3)).join();
 let sprite=profiles.get(key);if(sprite)return sprite;
 const h=128;sprite=canvasOf(1,h);const c=sprite.getContext('2d'),image=c.createImageData(1,h),edge=4.5/h;
 for(let y=0;y<h;y++){
  const d=Math.abs((y+.5)/h*2-1)*4.5,i=y*4;let rgb,a;
  if(style===2){const body=1-smooth(1-edge,1+edge,d),core=1-smooth(.45-edge,.45+edge,d);rgb=[0,1,2].map(ch=>out1[ch]+(out0[ch]-out1[ch])*core);a=body;}
  else{
   const [core,body,glow]=style===1?[1-smooth(.2-edge,.2+edge,d),1-smooth(.5-edge,.5+edge,d),Math.exp(-d/1.1)*.5]:[1-smooth(.26,.42,d),1-smooth(.45,1,d),Math.exp(-d/.9)*.45];
   a=Math.min(1,core+body*.7+glow*.5);rgb=[0,1,2].map(ch=>Math.min(1,out0[ch]*core+out1[ch]*(body*.8+glow))/(a>0?a:1));
  }
  for(let ch=0;ch<3;ch++)image.data[i+ch]=quant(rgb[ch]);image.data[i+3]=quant(a);
 }
 c.putImageData(image,0,0);profiles.set(key,sprite);if(profiles.size>32)profiles.delete(profiles.keys().next().value);return sprite;
}
function drawBeam(ctx,batch,draw,px){
 const R=batch.records,o=draw.record*RECORD_FLOATS,te=steppedTime(R,o),style=R[o+112];
 if(te<R[o+59]-1||te>R[o+60])return;
 let w=R[o+56]*beamWidth(R,o,te);if(w<=.05)return;w=w*R[o+121]+R[o+122];
 const ax=R[o+36],ay=R[o+37],[bx,by]=beamTip(R,o,te);
 const dx=bx-ax,dy=by-ay,len=Math.max(Math.hypot(dx,dy),1),ux=dx/len,uy=dy/len,wob=R[o+57],seed=(R[o+7]>>>0)%997;
 const sprite=beamProfile(batch,draw,style),m=ctx.getTransform(),segs=Math.max(8,Math.min(96,Math.ceil(len/12)));
 ctx.globalAlpha=Math.min(1,R[o+26]);
 const offset=x=>(vnoise(x*.018-te*.55,seed)-.5)*2*wob*w*smooth(0,80,x),center=x=>{const wv=offset(x);return [ax+ux*x-uy*wv,ay+uy*x+ux*wv];};
 for(let i=0;i<segs;i++){
  const x0=i/segs*len,x1=(i+1)/segs*len,[cx0,cy0]=center(x0),[cx1,cy1]=center(x1),ww=w*(.55+.45*smooth(0,70,(x0+x1)/2)),span=ww*4.5;
  const pulse=style===1||style===2?1:.8+.4*vnoise((x0+x1)/2*.035-te*1.7,3+seed);
  ctx.setTransform(m);ctx.translate(cx0,cy0);ctx.rotate(Math.atan2(cy1-cy0,cx1-cx0));
  ctx.globalAlpha=Math.min(1,R[o+26]*Math.min(1,pulse));ctx.drawImage(sprite,0,-span,Math.hypot(cx1-cx0,cy1-cy0)+px,2*span);
 }
 // Rounded ends reuse the cross-section as a disc.
 const end=rampColor(batch,draw,1,[0,0,0,0]).slice(0,3).map(quant),cap=style===2?tinted(discSprite(.05),...end):tinted(discSprite(2.2),...end);
 for(const [x,y,r] of style===2?[[ax,ay,w*1.1],[bx,by,w*2]]:[[ax,ay,w*.55*4.5],[bx,by,w*4.5]]){ctx.setTransform(m);ctx.translate(x,y);ctx.globalAlpha=Math.min(1,R[o+26]*(style===2?1:.6));ctx.drawImage(cap,-r*.5,-r*.5,r,r);}
 if(style===3){
  // Spiral strands, matching the shader's two phases and depth shading.
  const c0=rampColor(batch,draw,0,[0,0,0,0]),period=Math.max(24,w*3.2),step=Math.max(3,period/10);ctx.strokeStyle=css(c0[0],c0[1],c0[2]);ctx.lineCap='round';
  for(let s=0;s<2;s++)for(let x=0;x<len;x+=step){
   const x1=Math.min(len,x+step),ph=t=>t/period*TAU-te*.35+s*Math.PI,ww=w*(.55+.45*smooth(0,70,x)),pt=t=>{const sy=Math.sin(ph(t))*ww*.95+offset(t);return [ax+ux*t-uy*sy,ay+uy*t+ux*sy];};
   const [x0p,y0p]=pt(x),[x1p,y1p]=pt(x1);ctx.setTransform(m);ctx.globalAlpha=Math.min(1,R[o+26]*(.55+.45*Math.cos(ph((x+x1)/2))));ctx.lineWidth=Math.max(px,ww*.2+1.2);ctx.beginPath();ctx.moveTo(x0p,y0p);ctx.lineTo(x1p,y1p);ctx.stroke();
  }
 }
 ctx.setTransform(m);
}
function drawArcs(ctx,batch,draw,px){
 const R=batch.records,o=draw.record*RECORD_FLOATS,te=steppedTime(R,o);
 if(te<R[o+59]+R[o+58]||te>R[o+60])return 0;
 const seed=R[o+7]>>>0,segs=Math.max(1,R[o+62]|0),arcs=Math.floor(draw.count/segs);
 const ax=R[o+36],ay=R[o+37],[bx,by]=beamTip(R,o,te),dx=bx-ax,dy=by-ay,len=Math.max(Math.hypot(dx,dy),1),nx=-dy/len,ny=dx/len;
 const c=rampColor(batch,draw,0,[0,0,0,0]),alpha=R[o+26]*c[3]*beamWidth(R,o,te),r=R[o+20];
 if(alpha<=0)return 0;
 const stroke=css(c[0],c[1],c[2]);let drawn=0;
 ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=stroke;
 for(let arc=0;arc<arcs;arc++){
  const key=pcg((seed+Math.imul(arc,7919)+Math.imul(Math.floor(te/2),104729))>>>0);
  if(hash(arc,99,key)<.3)continue;
  const amp=R[o+63]*(.6+.8*hash(arc,98,key));ctx.beginPath();
  for(let k=0;k<=segs;k++){const f=k/segs,off=(hash(k,3,key)-.5)*2*amp*Math.sin(Math.PI*f),x=ax+dx*f+nx*off,y=ay+dy*f+ny*off;k?ctx.lineTo(x,y):ctx.moveTo(x,y);}
  ctx.globalAlpha=Math.min(1,alpha*.3);ctx.lineWidth=Math.max(px,r*6);ctx.stroke();
  ctx.globalAlpha=Math.min(1,alpha);ctx.lineWidth=Math.max(px,r*2);ctx.stroke();drawn++;
 }
 return drawn;
}
