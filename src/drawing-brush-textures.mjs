/** Brush textures shared by the CPU raster and the GPU brush: image tips
 * (tip-local alpha masks) and paper grains (tileable height fields anchored to
 * the cel). Every texture is generated procedurally and deterministically, so
 * the stroke worker, the main thread and the GPU atlas hold identical bytes
 * without shipping image assets. Both rasterizers sample them with the same
 * bilinear formulas below (the WGSL copies live in drawing-gpu.mjs). */
export const TIP_SIZE=128,GRAIN_SIZE=256;
/** Image tips in atlas order; 'round' is the analytic tip and has no texture. */
export const TEXTURE_TIPS=['chalk','bristle','sponge'];
/** Grains in atlas order; 'noise' is per-pixel hash noise with no texture. */
export const TEXTURE_GRAINS=['paper','canvas'];
const TIP_BYTES=TIP_SIZE*TIP_SIZE,GRAIN_BYTES=GRAIN_SIZE*GRAIN_SIZE;
export const ATLAS_BYTES=TEXTURE_TIPS.length*TIP_BYTES+TEXTURE_GRAINS.length*GRAIN_BYTES;
/** Byte offset of a tip or grain in the shared atlas, or -1 for analytic ones. */
export const tipBase=tip=>{const i=TEXTURE_TIPS.indexOf(tip);return i<0?-1:i*TIP_BYTES;};
export const grainBase=grain=>{const i=TEXTURE_GRAINS.indexOf(grain);return i<0?-1:TEXTURE_TIPS.length*TIP_BYTES+i*GRAIN_BYTES;};

const hash=(x,y,seed)=>{let h=(Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(seed,974711))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return ((h^(h>>>16))>>>0)/4294967296;};
const smooth=t=>t*t*(3-2*t);
const smoothstep=(a,b,v)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
/** Tileable fractal value noise in [0,1]: octaves of lattice noise whose
 * periods divide `size`, so the texture wraps without seams. */
function fbm(size,{period=8,octaves=5,seed=1,gain=.5}={}){
  const out=new Float32Array(size*size);let amplitude=1,total=0;
  for(let o=0;o<octaves&&period<=size;o++,period*=2,amplitude*=gain){
    const lattice=new Float32Array(period*period),cell=size/period;
    for(let i=0;i<lattice.length;i++)lattice[i]=hash(i%period,Math.floor(i/period),seed*31+o);
    for(let y=0;y<size;y++){
      const gy=y/cell,y0=Math.floor(gy),fy=smooth(gy-y0),r0=(y0%period)*period,r1=((y0+1)%period)*period;
      for(let x=0;x<size;x++){
        const gx=x/cell,x0=Math.floor(gx),fx=smooth(gx-x0),c0=x0%period,c1=(x0+1)%period;
        const top=lattice[r0+c0]+(lattice[r0+c1]-lattice[r0+c0])*fx,bottom=lattice[r1+c0]+(lattice[r1+c1]-lattice[r1+c0])*fx;
        out[y*size+x]+=(top+(bottom-top)*fy)*amplitude;
      }
    }
    total+=amplitude;
  }
  for(let i=0;i<out.length;i++)out[i]/=total;
  return out;
}
const toBytes=values=>{const out=new Uint8Array(values.length);for(let i=0;i<values.length;i++)out[i]=Math.round(Math.max(0,Math.min(1,values[i]))*255);return out;};
const GENERATORS={
  // Rough disc with a ragged rim and pitted interior, like chalk or pastel.
  chalk(){
    const n=TIP_SIZE,noise=fbm(n,{period:8,octaves:4,seed:3}),rim=fbm(n,{period:4,octaves:3,seed:5}),out=new Float32Array(n*n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){const u=(x+.5)/n*2-1,v=(y+.5)/n*2-1,d=Math.hypot(u,v),i=y*n+x,edge=.72+.2*rim[i];out[i]=smoothstep(edge,edge-.14,d)*smoothstep(.22,.55,noise[i]);}
    return toBytes(out);
  },
  // A row of fine bristles across the tip's v axis: with the tip following
  // the stroke direction each bristle draws its own streak.
  bristle(){
    const n=TIP_SIZE,out=new Float32Array(n*n),count=17;
    for(let k=0;k<count;k++){
      const v0=-.86+1.72*k/(count-1)+(hash(k,1,7)-.5)*.06,u0=(hash(k,2,7)-.5)*.5,r=.05+.05*hash(k,3,7),strength=.55+.45*hash(k,4,7);
      for(let y=0;y<n;y++)for(let x=0;x<n;x++){const u=(x+.5)/n*2-1,v=(y+.5)/n*2-1,d=Math.hypot((u-u0)*.45,v-v0),i=y*n+x;out[i]=Math.max(out[i],smoothstep(r,r*.35,d)*strength);}
    }
    return toBytes(out);
  },
  // Porous blotches inside a soft disc.
  sponge(){
    const n=TIP_SIZE,noise=fbm(n,{period:8,octaves:4,seed:11}),out=new Float32Array(n*n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){const u=(x+.5)/n*2-1,v=(y+.5)/n*2-1,i=y*n+x;out[i]=smoothstep(.95,.7,Math.hypot(u,v))*smoothstep(.4,.6,noise[i]);}
    return toBytes(out);
  },
  // Cold-press paper tooth: a bright surface with fine pits where the
  // paper's valleys skip paint, over gentle low-frequency variation.
  paper(){
    const n=GRAIN_SIZE,tooth=fbm(n,{period:64,octaves:3,seed:23}),hills=fbm(n,{period:16,octaves:3,seed:21}),out=new Float32Array(n*n);
    for(let i=0;i<out.length;i++)out[i]=1-smoothstep(.5,.78,tooth[i]*.8+hills[i]*.2)*.9;
    return toBytes(out);
  },
  // Woven canvas: rounded warp and weft threads crossing in a plain weave,
  // with irregular fibres. Each thread bulges where it passes over the other.
  canvas(){
    const n=GRAIN_SIZE,noise=fbm(n,{period:64,octaves:3,seed:29}),fibre=fbm(n,{period:128,octaves:2,seed:31}),out=new Float32Array(n*n),thread=4;
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){
      const cx=Math.floor(x/thread),cy=Math.floor(y/thread),fx=(x%thread+.5)/thread,fy=(y%thread+.5)/thread;
      // Warp runs vertically (profile across x), weft horizontally (across y).
      const warp=Math.sin(fx*Math.PI),weft=Math.sin(fy*Math.PI),over=((cx+cy)&1)===0;
      const height=over?Math.max(warp*(.55+.45*Math.sin(fy*Math.PI)),weft*.45):Math.max(weft*(.55+.45*Math.sin(fx*Math.PI)),warp*.45);
      out[y*n+x]=.2+height*.55+noise[y*n+x]*.15+fibre[y*n+x]*.1;
    }
    return toBytes(out);
  },
};
let atlas=null;const ready=new Set();
/** The shared texture atlas; each texture is generated on first use. */
export function brushAtlas(){atlas??=new Uint8Array(ATLAS_BYTES);return atlas;}
/** Generate one tip or grain into the atlas (idempotent) and return its base. */
export function ensureTexture(name){
  const base=TEXTURE_TIPS.includes(name)?tipBase(name):grainBase(name);if(base<0)return -1;
  if(!ready.has(name)){brushAtlas().set(GENERATORS[name](),base);ready.add(name);}
  return base;
}
/** Bilinear tip mask at tip-local (u,v) ∈ [-1,1]², clamped at the edges. */
export function sampleTip(bytes,base,u,v){
  const n=TIP_SIZE,px=Math.max(0,Math.min(n-1,(u*.5+.5)*n-.5)),py=Math.max(0,Math.min(n-1,(v*.5+.5)*n-.5));
  const x0=Math.floor(px),y0=Math.floor(py),fx=px-x0,fy=py-y0,x1=Math.min(x0+1,n-1),y1=Math.min(y0+1,n-1);
  const a=bytes[base+y0*n+x0],b=bytes[base+y0*n+x1],c=bytes[base+y1*n+x0],d=bytes[base+y1*n+x1];
  return (a+(b-a)*fx+((c+(d-c)*fx)-(a+(b-a)*fx))*fy)/255;
}
/** Bilinear grain height at cel pixel (x,y), wrapping every GRAIN_SIZE/scale pixels. */
export function sampleGrain(bytes,base,x,y,scale){
  const n=GRAIN_SIZE,px=(x+.5)/scale-.5,py=(y+.5)/scale-.5,fx0=Math.floor(px),fy0=Math.floor(py),fx=px-fx0,fy=py-fy0;
  const x0=fx0&(n-1),y0=fy0&(n-1),x1=(fx0+1)&(n-1),y1=(fy0+1)&(n-1);
  const a=bytes[base+y0*n+x0],b=bytes[base+y0*n+x1],c=bytes[base+y1*n+x0],d=bytes[base+y1*n+x1];
  return (a+(b-a)*fx+((c+(d-c)*fx)-(a+(b-a)*fx))*fy)/255;
}
