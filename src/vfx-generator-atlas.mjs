import {messageError} from './localized-error.mjs';
/** Procedural particle materials shared by the WebGPU and Canvas renderers.
 *
 * Each material is a run of 128-pixel cells (its variants) in one atlas row.
 * A texel holds coverage and a shading value that renderers multiply into the
 * particle colour: 0.5 keeps the colour, lower darkens and higher lightens it
 * toward white. Shading is stored premultiplied by coverage so filtered and
 * reduced levels stay correct. Rows are generated deterministically on first
 * use, so every renderer, worker and export draws identical materials. */
export const CELL=128,COLUMNS=8,ATLAS_LEVELS=4;
const ROW_LIST=['smoke','cloud','flame','toonFlame','star','bokeh','wisp','bolt','shard','rock','leaf','petal','flake','drop','splat','burst','cute'];
export const ATLAS_ROWS=ROW_LIST.length;
/** name → {row, col, count}: the cells a material's particles choose from. */
export const MATERIALS=Object.freeze(Object.fromEntries([...ROW_LIST.filter(n=>n!=='cute').map((name,row)=>[name,{row,col:0,count:COLUMNS}]),
 ['heart',{row:ROW_LIST.indexOf('cute'),col:0,count:4}],['toonStar',{row:ROW_LIST.indexOf('cute'),col:4,count:4}]].map(([k,v])=>[k,Object.freeze(v)])));

const TAU=Math.PI*2,PX=2/CELL,N=CELL*CELL;
const clamp=(v,a,b)=>v<a?a:v>b?b:v,mix=(a,b,t)=>a+(b-a)*t;
const len=(x,y)=>Math.sqrt(x*x+y*y);
const sstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
/** Coverage of a signed distance in cell units (negative inside), one texel wide. */
const aa=d=>clamp(.5-d/PX,0,1);
function random(seed){let s=seed>>>0;return()=>{s=(s+0x6d2b79f5)>>>0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
function hash2(x,y,s){let h=(Math.imul(x,374761393)+Math.imul(y,668265263)+Math.imul(s,-2048144789))|0;h=Math.imul(h^(h>>>13),1274126177);h^=h>>>16;return (h>>>0)/4294967296;}
function noise(x,y,s){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy),a=hash2(ix,iy,s),b=hash2(ix+1,iy,s),c=hash2(ix,iy+1,s),d=hash2(ix+1,iy+1,s);return a+(b-a)*ux+(c-a)*uy+(a-b-c+d)*ux*uy;}
function fbm(x,y,s,octaves){let sum=0,amp=.5,norm=0;for(let i=0;i<octaves;i++){sum+=noise(x,y,s+i*101)*amp;norm+=amp;x=x*2.03+17.1;y=y*2.03-9.7;amp*=.5;}return sum/norm;}
function segment(px,py,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,t=clamp(((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy||1),0,1),x=px-ax-dx*t,y=py-ay-dy*t;return Math.sqrt(x*x+y*y);}
/** Signed distance to a closed polygon [x0,y0,x1,y1,…]. */
function polygon(px,py,pts){
 let d=Infinity,inside=false;
 for(let i=0,j=pts.length-2;i<pts.length;j=i,i+=2){
  const ax=pts[j],ay=pts[j+1],bx=pts[i],by=pts[i+1],q=segment(px,py,ax,ay,bx,by);if(q<d)d=q;
  if(ay>py!==by>py&&px<(bx-ax)*(py-ay)/(by-ay)+ax)inside=!inside;
 }
 return inside?-d:d;
}
/** Nearest distance to discs packed as [x,y,radius,…]. */
function discs(u,v,c){let d=Infinity;for(let i=0;i<c.length;i+=3){const x=u-c[i],y=v-c[i+1],q=Math.sqrt(x*x+y*y)-c[i+2];if(q<d)d=q;}return d;}
/** Smooth noise evaluated on a coarse grid and bilinearly expanded to one value per texel. */
function noiseGrid(scaleX,scaleY,ox,oy,seed,octaves){
 const G=CELL/2+1,g=new Float32Array(G*G),out=new Float32Array(N);
 for(let j=0;j<G;j++)for(let i=0;i<G;i++)g[j*G+i]=fbm((i/(G-1)*2-1)*scaleX+ox,(j/(G-1)*2-1)*scaleY+oy,seed,octaves);
 for(let j=0,i=0;j<CELL;j++){const y=(j+.5)/2,iy=Math.min(G-2,y|0),fy=y-iy;for(let x=0;x<CELL;x++,i++){const X=(x+.5)/2,ix=Math.min(G-2,X|0),fx=X-ix,o=iy*G+ix;out[i]=mix(mix(g[o],g[o+1],fx),mix(g[o+G],g[o+G+1],fx),fy);}}
 return out;
}
// Light arrives from the upper left for every shaded material.
const LX=-.42,LY=-.72,LZ=.55;
const U=new Float32Array(CELL);for(let i=0;i<CELL;i++)U[i]=(i+.5)/CELL*2-1;
const edgeFade=(u,v)=>1-sstep(.9,.98,Math.max(Math.abs(u),Math.abs(v)));

/** Visit every texel with integer coordinates (no boxed arguments). */
function each(fn){for(let j=0,i=0;j<CELL;j++)for(let x=0;x<CELL;x++,i++)fn(x,j,i);}
/** Crisp shapes: coverage from a signed-distance grid, then toon shading with
 * a shadow crescent away from the light and highlight spots. */
function toon(A,S,D,shadow,offset,highlights){
 const dx=Math.round(-LX*offset*1.3/PX),dy=Math.round(-LY*offset/PX);
 each((x,j,i)=>{
  const a=aa(D[i]);A[i]=a;if(a<=0)return;
  const sx=x+dx,sy=j+dy,d=sx<CELL&&sy<CELL?D[sy*CELL+sx]:1,dark=clamp(.5+d/PX,0,1),u=U[x],v=U[j];let s=mix(.5,shadow,dark);
  for(let h=0;h<highlights.length;h+=3)s=mix(s,.76,aa(len(u-highlights[h],v-highlights[h+1])-highlights[h+2])*(1-dark));
  S[i]=s;
 });
}
const PAINTERS={
 smoke(k,r,A,S){
  // Soft union of billowing lobes with noisy edges, lit from the lobes' shape.
  const lobes=[0,.06,.56+r()*.08];for(let n=4+Math.floor(r()*3),i=0;i<n;i++){const a=r()*TAU,d=.22+r()*.2,rad=.34+r()*.16,x=Math.cos(a)*d,y=Math.sin(a)*d*.8-.02,f=Math.min(1,(.84-rad)/Math.max(len(x,y),1e-3));lobes.push(x*f,y*f,rad);}
  const L=Float64Array.from(lobes),D=new Float32Array(N),F=new Float32Array(N),detail=noiseGrid(2,2,k*3.1,-k*1.7,k*977+11,4);
  each((x,j,i)=>{const u=U[x],v=U[j];let keep=1;for(let l=0;l<L.length;l+=3){const du=u-L[l],dv=v-L[l+1],q=1-(du*du+dv*dv)/(L[l+2]*L[l+2]);if(q>0)keep*=1-q;}const base=1-keep,n=detail[i];D[i]=base+(n-.5)*.8*sstep(0,.35,base);F[i]=base+(n-.5)*.25;});
  each((x,j,i)=>{const u=U[x],v=U[j],n=detail[i];
   const a=sstep(.02,.62,D[i])*(1-sstep(.84,.97,len(u,v)))*(.74+.26*sstep(.3,.7,n));A[i]=a;if(a<=0)return;
   const gx=F[i+(x<CELL-1?1:0)]-F[i-(x>0?1:0)],gy=F[i+(j<CELL-1?CELL:0)]-F[i-(j>0?CELL:0)],nx=-gx*CELL/14,ny=-gy*CELL/14,lambert=Math.max(0,(nx*LX+ny*LY+LZ)/Math.sqrt(nx*nx+ny*ny+1));
   S[i]=clamp(.34+.36*lambert-.08*v+.1*(n-.5)-.06*sstep(.6,1.2,D[i]),0,1);
  });
 },
 cloud(k,r,A,S){
  // Cartoon cloud: overlapping circles with a crisp edge and cel shading.
  const c=[0,.14,.44+r()*.05];for(let n=3+Math.floor(r()*3),i=0;i<n;i++){const a=-Math.PI*(.05+r()*.9)+(i%2?0:Math.PI*.12),d=.28+r()*.18,rad=.24+r()*.15,x=Math.cos(a)*d,y=Math.sin(a)*d*.9+.08,s=Math.min(1,(.92-rad)/len(x,y));c.push(x*s,y*s,rad);}
  const C=Float64Array.from(c),sdf=(u,v)=>discs(u,v,C),lights=[];for(let i=0;i<9;i+=3)lights.push(C[i]-C[i+2]*.36,C[i+1]-C[i+2]*.42,C[i+2]*.22);
  const D=new Float32Array(N);each((x,j,i)=>{D[i]=sdf(U[x],U[j]);});toon(A,S,D,.28,.11,lights);
 },
 flame(k,r,A,S){
  const tongues=k>=5?[-.16,.9,1,.2,.72,.8]:[0,1,1],ragged=noiseGrid(3.4,2.1,k,-k*.7,k*631+6,4),sways=[];
  for(let t=0;t<tongues.length;t+=3){const s=new Float32Array(65);for(let q=0;q<65;q++){const h=q/64;s[q]=(fbm(h*1.7+k*2.3,k*5.1+tongues[t]*9,k*631+5,3)-.5)*.75*Math.pow(h,1.5);}sways.push(s);}
  each((x,j,i)=>{const u=U[x],v=U[j];
   let d=-1;
   for(let t=0;t<tongues.length;t+=3){
    const h=(.86-v)/(1.76*tongues[t+1]);if(h<0||h>1)continue;
    const w=.44*tongues[t+2]*(h<.28?Math.sqrt(Math.max(0,1-((.28-h)/.28)**2)):Math.pow(1-(h-.28)/.72,.85)),sway=sways[t/3][Math.round(h*64)];
    d=Math.max(d,1-Math.abs(u-tongues[t]-sway)/Math.max(w,1e-3));
   }
   d+=(ragged[i]-.5)*.75;
   A[i]=sstep(0,.42,d)*(1-sstep(.9,.98,Math.abs(u)));S[i]=.5+.5*sstep(.2,.95,d)*(1-.55*sstep(.2,1,-v));
  });
 },
 toonFlame(k,r,A,S){
  // Hard-edged cartoon flame licks with a lighter inner core.
  const licks=[];for(let n=k<4?1:2+(k&1),i=0;i<n;i++)licks.push(i?(r()-.5)*.5:(r()-.5)*.12,i?.55+r()*.25:1,i?.55+r()*.3:1,r()*10);
  const field=(u,v,inner)=>{let e=-Infinity;for(let l=0;l<licks.length;l+=4){const h=(.86-v)/(1.76*licks[l+1]);if(h<0||h>1)continue;const sway=Math.sin(h*3.2+licks[l+3])*.12*Math.pow(h,1.3),w=.42*licks[l+2]*(inner?.52:1)*(h<.26?Math.sqrt(Math.max(0,1-((.26-h)/.26)**2)):Math.pow(1-(h-.26)/.74,inner?1.3:.9));e=Math.max(e,w-Math.abs(u-licks[l]-sway*(inner?.8:1)));}return e;};
  each((x,j,i)=>{const u=U[x],v=U[j];A[i]=aa(-field(u,v,false));if(A[i]>0)S[i]=mix(.5,.82,aa(-field(u,v+.1,true)));});
 },
 star(k,r,A,S){
  const points=[4,4,6,8,4,6,5,8][k],sharp=[8,14,10,12,22,16,9,18][k],offset=k===2||k===5?Math.PI/6:0,reach=[.92,.95,.8,.88,.95,.72,.85,.9][k];
  each((x,j,i)=>{const u=U[x],v=U[j];
   const rr=len(u,v),a=Math.atan2(v,u)+offset;let spikes=Math.pow(Math.abs(Math.cos(a*points/2)),sharp);
   if(points===8)spikes=Math.max(Math.pow(Math.abs(Math.cos(a*2)),sharp),.55*Math.pow(Math.abs(Math.sin(a*2)),sharp));
   const core=Math.exp(-(rr*rr)/.0144),ray=Math.pow(Math.max(0,1-rr/(reach*mix(.1,1,spikes))),2.2)*Math.pow(spikes,.35),glow=Math.exp(-rr*6)*.5;
   A[i]=clamp(core+ray+glow,0,1)*(1-sstep(.9,.98,rr));S[i]=.5+.5*clamp(core*1.3+ray*.5,0,1);
  });
 },
 bokeh(k,r,A,S){
  const hex=k>=5,rim=.25+r()*.55,grain=noiseGrid(3,3,0,0,k*37+2,3);
  each((x,j,i)=>{const u=U[x],v=U[j];
   const q=hex?Math.max(Math.abs(u)*.866+Math.abs(v)*.5,Math.abs(v))-.74:len(u,v)-.8,edge=clamp(.5-q/(PX*2.5),0,1),ring=Math.exp(-Math.abs(q)/.07)*rim;
   A[i]=clamp(edge*(.55+.12*(grain[i]-.5))+ring*edge*.6,0,1);S[i]=.5+.4*ring;
  });
 },
 wisp(k,r,A,S){
  // Tapered crescents: [radius, half angle, scale] per arc.
  const arcs=[.55+r()*.3,1+r()*.6,1];if(k>=4)arcs.push(.4+r()*.25,.9+r()*.5,.7);const grain=noiseGrid(4,4,k,0,k*13+7,3);
  each((x,j,i)=>{const u=U[x],v=U[j];
   let a=0,s=.5;
   for(let c=0;c<arcs.length;c+=3){
    const R=arcs[c],half=arcs[c+1],scale=arcs[c+2],dy=v-(R-.45*scale),t=Math.atan2(u,-dy)/half*.5+.5;if(t<0||t>1)continue;
    const th=Math.max(.16*scale*Math.pow(Math.sin(Math.PI*t),.7)*(1-.35*t),1e-3),q=Math.abs(len(u,dy)-R)/th,cov=Math.exp(-q*q*2.2)*(.65+.35*grain[i]);
    if(cov>a){a=cov;s=.5+.3*Math.exp(-q*q*6);}
   }
   A[i]=a*edgeFade(u,v);S[i]=s;
  });
 },
 bolt(k,r,A,S){
  // A jagged main strike with a few forks; the core is white-hot.
  const main=[-.86,(r()-.5)*.3],lines=[];for(let n=7+Math.floor(r()*3),i=1;i<=n;i++)main.push(-.86+1.72*i/n,i===n?(r()-.5)*.3:(r()-.5)*.55);
  const count=main.length/2;for(let i=0;i<count-1;i++)lines.push(main[i*2],main[i*2+1],main[i*2+2],main[i*2+3],.034*(1-.4*i/count));
  for(let b=0,n=1+Math.floor(r()*2);b<n;b++){const at=2+Math.floor(r()*(count-4));let x=main[at*2],y=main[at*2+1];const dir=(r()>.5?1:-1)*(.5+r()*.6);for(let s=0;s<3;s++){const nx=clamp(x+.14+r()*.12,-.9,.9),ny=clamp(y+dir*(.08+r()*.12),-.88,.88);lines.push(x,y,nx,ny,.02*(1-s/3));x=nx;y=ny;}}
  const Lp=Float64Array.from(lines);
  each((x,j,i)=>{const u=U[x],v=U[j];let core=0,d=Infinity;for(let l=0;l<Lp.length;l+=5){const q=segment(u,v,Lp[l],Lp[l+1],Lp[l+2],Lp[l+3]);if(q<d)d=q;const c=aa(q-Lp[l+4]);if(c>core)core=c;}A[i]=clamp(core+Math.exp(-d/.06)*.55+Math.exp(-d/.2)*.18,0,1)*edgeFade(u,v);S[i]=.5+.5*core;});
 },
 shard(k,r,A,S){
  const n=3+Math.floor(r()*3),angles=[...Array(n)].map((_,i)=>(i+.2+r()*.6)/n*TAU).sort((a,b)=>a-b),stretch=.45+r()*.35,pts=[];
  for(const a of angles){const rad=.5+r()*.38;pts.push(Math.cos(a)*rad*stretch,Math.sin(a)*rad);}
  const P=Float64Array.from(pts),cut=r()*TAU,cx=Math.cos(cut),cy=Math.sin(cut);
  each((x,j,i)=>{const u=U[x],v=U[j];const d=polygon(u,v,P);A[i]=aa(d);if(A[i]>0)S[i]=(u*cx+v*cy>0?.66:.36)+(-d<.07?.14:0)+(u*LX+v*LY)*.1;});
 },
 rock(k,r,A,S){
  const n=7+Math.floor(r()*3),pts=[];for(let i=0;i<n;i++){const a=(i+r()*.5)/n*TAU,rad=.55+r()*.28;pts.push(Math.cos(a)*rad,Math.sin(a)*rad*.85);}
  const P=Float64Array.from(pts),grain=noiseGrid(4,4,0,0,k*71+9,4);
  each((x,j,i)=>{const u=U[x],v=U[j];const d=polygon(u,v,P);A[i]=aa(d);if(A[i]<=0)return;const nx=u/.8,ny=v/.8,nz=Math.sqrt(Math.max(0,1-nx*nx-ny*ny));S[i]=clamp(.2+.5*Math.max(0,nx*LX+ny*LY+nz*LZ)+.22*(grain[i]-.5)-(-d<.05?.08:0),0,1);});
 },
 leaf(k,r,A,S){
  const bend=(r()-.5)*.5,width=.22+r()*.1,R=.9,D=R-width,B=Math.sqrt(R*R-D*D),veins=4+Math.floor(r()*3);
  each((x,j,i)=>{const u=U[x],v=U[j];
   const bx=u+bend*v*v,ax=Math.abs(bx),ay=Math.abs(v+.06),shape=(ay-B)*D>ax*B?len(ax,ay-B):len(ax+D,ay)-R,stem=segment(u,v,-bend*(B-.14)*(B-.14),B-.14,.03-bend*.85,.92)-.022,d=Math.min(shape,stem);
   A[i]=aa(d);if(A[i]<=0)return;
   const vein=ax<.018||Math.abs(((v+.06)*veins+ax*3.2)%1-.5)>.44&&ax<width*.8;S[i]=stem<0?.4:vein?.66:bx>0?.42:.54;
  });
 },
 petal(k,r,A,S){
  const R=.42+r()*.08,cy=-.12,tip=.86,lean=(r()-.5)*.3,notch=.1+r()*.07;
  each((x,j,i)=>{const u=U[x],v=U[j];
   // Beyond the round top and the tip the width is zero: measure to those points instead.
   const lx=u-lean*(v-cy),w=v<cy?Math.sqrt(Math.max(0,R*R-(v-cy)*(v-cy))):R*Math.pow(Math.max(0,1-(v-cy)/(tip-cy)),1.15),d=v<cy-R?len(lx,v-cy+R):v>tip?len(lx,v-tip):Math.abs(lx)-w;
   const a=aa(d)*aa(notch-len(lx,v-(cy-R-.02)));A[i]=a;if(a>0)S[i]=mix(.48,.72,sstep(cy,tip,v))-(-d<.05?.06:0);
  });
 },
 flake(k,r,A,S){
  const branches=[];for(let n=2+Math.floor(r()*2),i=0;i<n;i++)branches.push(.28+i*.18+r()*.06,.1+r()*.12);const plate=k>=6?.16:0,th=.036+r()*.014,sector=Math.PI/3;
  each((x,j,i)=>{const u=U[x],v=U[j];
   const rr=len(u,v),a=Math.atan2(v,u),f=Math.abs(a-sector*Math.round(a/sector)),fx=rr*Math.cos(f),fy=rr*Math.sin(f);
   let d=segment(fx,fy,0,0,.82,0)-th;for(let b=0;b<branches.length;b+=2)d=Math.min(d,segment(fx,fy,branches[b],0,branches[b]+branches[b+1]*.5,branches[b+1]*.866)-th*.8);
   if(plate)d=Math.min(d,rr*Math.cos(Math.PI/6-f)-plate*.866);
   A[i]=clamp(aa(d)+Math.exp(-Math.max(d,0)/.05)*.22,0,1)*(1-sstep(.9,.98,rr));S[i]=.62+.26*aa(d+th*.5);
  });
 },
 drop(k,r,A,S){
  // Round leading head (cell top) with a trailing tail toward the cell bottom.
  const R=.36+r()*.06,cy=-.3,tail=.62+r()*.28;
  each((x,j,i)=>{const u=U[x],v=U[j];
   const w=v<cy?Math.sqrt(Math.max(0,R*R-(v-cy)*(v-cy))):R*Math.pow(Math.max(0,1-(v-cy)/(tail-cy)),1.5),d=v<cy-R?len(u,v-cy+R):v>tail?len(u,v-tail):Math.abs(u)-w;A[i]=aa(d);if(A[i]<=0)return;
   S[i]=mix(clamp(.5-.22*sstep(-.2,.4,u/R)+.1*sstep(.2,.8,-u/R)*sstep(cy,tail,v),0,1),.95,aa(len(u+R*.36,v-cy+R*.38)-R*.2));
  });
 },
 splat(k,r,A,S){
  const lobes=5+Math.floor(r()*4),phase=r()*TAU,spikes=[],drops=[];
  for(let i=0,n=2+Math.floor(r()*3);i<n;i++){const a=r()*TAU,l=.52+r()*.22;spikes.push(Math.cos(a)*l,Math.sin(a)*l,.045+r()*.035,l);}
  for(let i=0,n=5+Math.floor(r()*5);i<n;i++){const a=r()*TAU,l=.56+r()*.3,rad=.025+r()*.05,s=Math.min(1,(.92-rad)/l);drops.push(Math.cos(a)*l*s,Math.sin(a)*l*s,rad);}
  const Sp=Float64Array.from(spikes),Dr=Float64Array.from(drops);
  const sdf=(u,v)=>{const a=Math.atan2(v,u),rr=len(u,v);let d=rr-(.34+.06*Math.sin(a*lobes+phase)+.03*Math.sin(a*(lobes+3)-phase*2));
   for(let s=0;s<Sp.length;s+=4){const x=Sp[s],y=Sp[s+1],t=Sp[s+2];d=Math.min(d,segment(u,v,0,0,x,y)-t*(1-.4*rr/Sp[s+3]),len(u-x,v-y)-t*1.5);}
   return Math.min(d,discs(u,v,Dr));};
  const D=new Float32Array(N);each((x,j,i)=>{D[i]=sdf(U[x],U[j]);});toon(A,S,D,.4,.06,[-.12,-.14,.08]);
 },
 burst(k,r,A,S){
  // Comic starburst with a lighter inner band. It is star-shaped around its
  // centre, so inside means closer than the outline along the same ray.
  const n=9+Math.floor(r()*7),m=n*2,step=TAU/m,V=new Float64Array(m*2),ANG=new Float64Array(m+1);
  for(let i=0;i<m;i++){const a=(i+(r()-.5)*.35)*step,rad=i%2?.38+r()*.12:.72+r()*.22;ANG[i]=a;V[i*2]=Math.cos(a)*rad;V[i*2+1]=Math.sin(a)*rad;}ANG[m]=ANG[0]+TAU;
  const edge=(u,v,scale)=>{
   let a=(Math.atan2(v,u)+TAU)%TAU;if(a<ANG[0])a+=TAU;let e=Math.min(m-1,Math.floor(a/step));while(e>0&&a<ANG[e])e--;while(e<m-1&&a>=ANG[e+1])e++;
   const p=e,q=(e+1)%m,px=V[p*2],py=V[p*2+1],ex=V[q*2]-px,ey=V[q*2+1]-py,dx=Math.cos(a),dy=Math.sin(a),reach=(px*ey-py*ex)/(dx*ey-dy*ex)*scale;
   let d=Infinity;for(let o=-1;o<=1;o++){const s0=((e+o)%m+m)%m,s1=(s0+1)%m,s=segment(u,v,V[s0*2]*scale,V[s0*2+1]*scale,V[s1*2]*scale,V[s1*2+1]*scale);if(s<d)d=s;}
   return len(u,v)<reach?-d:d;};
  each((x,j,i)=>{const u=U[x],v=U[j];A[i]=aa(edge(u,v,1));if(A[i]>0)S[i]=mix(.5,.84,aa(edge(u,v,.56)));});
 },
 cute(k,r,A,S){
  let sdf,light;
  if(k<4){
   // Heart (Inigo Quilez's exact distance), tip down.
   const s=.74+k*.02,tilt=(k-1.5)*.08,cu=Math.cos(tilt),su=Math.sin(tilt);light=[-.3,-.3,.1];
   sdf=(u,v)=>{const x=Math.abs((u*cu-v*su)*s),y=(.72-(u*su+v*cu))*s;
    if(y+x>1)return (len(x-.25,y-.75)-Math.SQRT2/4)/s;
    const m=.5*Math.max(x+y,0);return Math.sqrt(Math.min(x*x+(y-1)*(y-1),(x-m)*(x-m)+(y-m)*(y-m)))*Math.sign(x-y)/s;};
  }else{
   // Rounded five-point star (Inigo Quilez's sdStar5).
   const rad=.66,rf=.48+(k-4)*.03,k1x=.809016994375,k1y=-.587785252292,bax=rf*-k1y,bay=rf*k1x-1,bb=bax*bax+bay*bay;light=[-.16,-.2,.1];
   sdf=(u,v)=>{let x=Math.abs(u),y=-v+.06,d=Math.max(k1x*x+k1y*y,0);x-=2*d*k1x;y-=2*d*k1y;d=Math.max(-k1x*x+k1y*y,0);x+=2*d*k1x;y-=2*d*k1y;x=Math.abs(x);y-=rad;
    const h=clamp((x*bax+y*bay)/bb,0,rad);return len(x-bax*h,y-bay*h)*Math.sign(y*bax-x*bay)-.07;};
  }
  const D=new Float32Array(N);each((x,j,i)=>{D[i]=sdf(U[x],U[j]);});toon(A,S,D,.34,.1,light);
 },
};

const rows=new Map();
/** One material row as a strip of CELL-high levels: {levels:[{width,height,data}]}
 * with interleaved [shade×coverage, coverage] bytes. */
export function atlasRow(row){
 let strip=rows.get(row);if(strip)return strip;
 const paint=PAINTERS[ROW_LIST[row]];if(!paint)throw messageError(new Error(''), "errors.vfxGeneratorAtlas.unknownParticleMaterialRow", {row: row});
 const width=CELL*COLUMNS,base=new Uint8Array(width*CELL*2),A=new Float32Array(N),S=new Float32Array(N);
 for(let k=0;k<COLUMNS;k++){
  A.fill(0);S.fill(.5);paint(k,random(Math.imul(row+1,-1640531535)^Math.imul(k+1,40503)),A,S);
  for(let y=0,i=0;y<CELL;y++)for(let x=0,o=(y*width+k*CELL)*2;x<CELL;x++,i++,o+=2){const a=clamp(A[i],0,1);base[o]=(clamp(S[i],0,1)*a*255+.5)|0;base[o+1]=(a*255+.5)|0;}
 }
 const levels=[{width,height:CELL,data:base}];
 for(let l=1;l<ATLAS_LEVELS;l++){
  const src=levels[l-1].data,sw=levels[l-1].width,w=sw>>1,h=levels[l-1].height>>1,data=new Uint8Array(w*h*2);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const a=((y*2)*sw+x*2)*2,b=a+sw*2,o=(y*w+x)*2;data[o]=(src[a]+src[a+2]+src[b]+src[b+2]+2)>>2;data[o+1]=(src[a+1]+src[a+3]+src[b+1]+src[b+3]+2)>>2;}
  levels.push({width:w,height:h,data});
 }
 strip=Object.freeze({row,levels});rows.set(row,strip);return strip;
}
/** Accept a row generated elsewhere by the same code; drawing already done
 * with a locally generated row is unaffected because the bytes are identical. */
function adoptRow(row,levels){
 if(rows.has(row)||!Number.isInteger(row)||row<0||row>=ATLAS_ROWS||levels?.length!==ATLAS_LEVELS)return;
 for(const [l,level] of levels.entries())if(level.width!==(CELL*COLUMNS)>>l||level.height!==CELL>>l||level.data?.length!==level.width*level.height*2)return;
 rows.set(row,Object.freeze({row,levels}));
}
let prewarm=null;
/** Share one bounded preparation job for the session. Startup and catalogue
 * previews await it so they do not race the worker with synchronous generation.
 * Unsupported/failed workers retain the deterministic on-demand fallback. */
export function prewarmAtlas(){
 if(prewarm)return prewarm;
 const missing=[...Array(ATLAS_ROWS).keys()].filter(row=>!rows.has(row));
 if(!missing.length)return Promise.resolve(true);
 if(typeof window==='undefined'||typeof Worker==='undefined')return Promise.resolve(false);
 prewarm=new Promise(resolve=>{
  let worker,timer,finished=false;
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);worker?.terminate();resolve(missing.every(row=>rows.has(row)));};
  try{
   worker=new Worker(new URL('./vfx-generator-atlas-worker.mjs',import.meta.url),{type:'module',name:'StykAnimate particle materials'});
   worker.onmessage=({data})=>{if(finished)return;if(data.done)finish();else adoptRow(data.row,data.levels);};
   worker.onerror=event=>{event.preventDefault();finish();};
   worker.onmessageerror=finish;
   timer=setTimeout(finish,8000);
   worker.postMessage({rows:missing});
  }catch{finish();}
 });
 return prewarm;
}
/** Shading applied to a particle colour, identical to shadeRgb() in the shader. */
export function shadeColor(r,g,b,s,out){
 if(s<.5){const k=.25+1.5*s;out[0]=r*k;out[1]=g*k;out[2]=b*k;}
 else{const k=(s-.5)*1.4;out[0]=r+(1-r)*k;out[1]=g+(1-g)*k;out[2]=b+(1-b)*k;}
 return out;
}
