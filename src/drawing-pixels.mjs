import {messageError} from './localized-error.mjs';
import {DRAWING_MAX_PIXELS} from './drawing-model.mjs';
import {TILE,TILE_BYTES,tileKey,TileStore} from './drawing-tiles.mjs';
import {lassoContains} from './drawing-lasso.mjs';
import {BrushStroke,dabShape,normalizeBrush,smudgeStride} from './drawing-brush.mjs';
import {brushAtlas,ensureTexture,sampleGrain,sampleTip} from './drawing-brush-textures.mjs';
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
export function assertPixels(pixels,width,height) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>DRAWING_MAX_PIXELS||
    !(pixels instanceof Uint8ClampedArray)||pixels.length!==width*height*4)throw messageError(new Error(''), "errors.drawingPixels.invalidDrawingPixelSurface", {});
}
export function compactTile(bytes){
  if(bytes==null)return null;
  if(bytes.byteOffset%4===0&&bytes.length%4===0){
    const words=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length>>2),first=words[0];
    for(let i=1;i<words.length;i++)if(words[i]!==first)return bytes;
    return bytes.slice(0,4);
  }
  for(let i=4;i<bytes.length;i++)if(bytes[i]!==bytes[i%4])return bytes;
  return bytes.slice(0,4);
}
// A uniform fully transparent tile is pruned on apply, so it equals absent.
const normSide=v=>v&&v.byteLength===4&&v[3]===0?null:v;
const sideEqual=(a,b)=>a===b||(a&&b&&a.length===b.length&&a.every((n,i)=>n===b[i]));
/** Tile-oriented undo records: {tx,ty,before,after} with each side null, a
 * 4-byte uniform array, or a full tile. `beforeTiles` maps tile keys to the
 * pre-edit pixels (or null when absent) and must cover every tile touched. */
/** The undo record is exact: every touched tile keeps its pre-edit pixels. An
 * edit is never refused for size — history eviction retires older records. */
export function tileChanges(store,beforeTiles) {
  const changes=[];
  for(const [key,beforeValue] of beforeTiles){
    const [tx,ty]=key.split(',').map(Number),afterValue=store.get(tx,ty)?.pixels??null;
    if(beforeValue===null&&afterValue===null)continue;
    if(beforeValue&&afterValue&&sideEqual(beforeValue,afterValue))continue;
    const before=normSide(compactTile(beforeValue)),after=normSide(compactTile(afterValue));
    if(before===null&&after===null)continue;
    changes.push({tx,ty,before,after});
  }
  return changes;
}
export function applyTileChanges(store,changes,direction) {
  for(const change of changes){const value=change[direction];if(value==null)store.delete(change.tx,change.ty);else store.set(change.tx,change.ty,value);}
}
export const pixelChangeBytes=tiles=>tiles.reduce((n,t)=>n+(t.before?.byteLength??0)+(t.after?.byteLength??0)+64,256);
/** Bounding rect of every tile intersected by a pixel-space rect. */
export function tileAlignedRect(x,y,width,height){
  const x0=Math.floor(x/TILE)*TILE,y0=Math.floor(y/TILE)*TILE;
  return{x:x0,y:y0,width:Math.ceil((x+width)/TILE)*TILE-x0,height:Math.ceil((y+height)/TILE)*TILE-y0};
}
const lum=(r,g,b)=>.3*r+.59*g+.11*b;
/** W3C non-separable SetLum/ClipColor on 0..255 channels. */
function setLum(r,g,b,l){const d=l-lum(r,g,b);r+=d;g+=d;b+=d;const L=lum(r,g,b),n=Math.min(r,g,b),x=Math.max(r,g,b);if(n<0){r=L+(r-L)*L/(L-n);g=L+(g-L)*L/(L-n);b=L+(b-L)*L/(L-n);}if(x>255){r=L+(r-L)*(255-L)/(x-L);g=L+(g-L)*(255-L)/(x-L);b=L+(b-L)*(255-L)/(x-L);}return [r,g,b];}
/** Separable blend functions B(Cb,Cs) on 0..255 channels. 'color' is
 * non-separable and handled with setLum; its entry here is unused. */
const blendChannel={multiply:(b,s)=>b*s/255,screen:(b,s)=>b+s-b*s/255,overlay:(b,s)=>b<=127.5?2*b*s/255:255-2*(255-b)*(255-s)/255,color:(b,s)=>s};
/** Deterministic pixel grain: pure function of integer pixel coords + seed. */
const hashPixel=(x,y,seed)=>{let h=(Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(seed,974711))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return ((h^(h>>>16))>>>0)/4294967296;};
const ZERO_TILE=new Uint8ClampedArray(TILE_BYTES);
const tileId=tileKey;

/** Exact CPU raster of dab shapes (drawing-brush.mjs) with tile-local stroke
 * coverage on an unbounded TileStore. Opacity caps an entire stroke
 * (indirect painting); flow accumulates dabs without multiplying it. Blend
 * modes composite the stroke's source colour against the pixels the stroke
 * first saw, alpha lock preserves their alpha, and an optional selection mask
 * clips coverage. A provisional tail (the untapered end of a stroke with a
 * taper-out) is rasterized into scratch coverage and replaced on every
 * update. `requireTile` lets a caller refuse tiles it never supplied instead
 * of painting over a blank guess. `sample()` drives the whole dab pipeline
 * for callers that paint from input points (tests, previews). */
export class DrawingStroke {
  constructor(store,settings={},{requireTile,mask}={}) {
    if(!(store instanceof TileStore))throw messageError(new Error(''), "errors.drawingPixels.strokesDrawIntoATileStore", {});
    const brush=normalizeBrush(settings),mode=brush.erase?'erase':brush.blend;
    Object.assign(this,brush,{store,brush,requireTile,mask:mask??settings.mask??null,workingBytes:settings.workingBytes??768*1024*1024,maxBytes:settings.maxBytes??48*1024*1024,tiles:new Map(),bytes:256,dirtyTiles:new Set(),uncomposited:new Set(),tailTiles:new Set(),tailShapes:[],tailVersion:-1,dabs:0,
      mode,smudge:mode==='smudge',lock:brush.alphaLock&&mode!=='erase'&&mode!=='behind',
      // Nothing to erase or recolour where the stroke found no pixels.
      skipEmpty:mode==='erase'||(brush.alphaLock&&mode!=='behind'),
      tipOffset:brush.tip==='round'?-1:ensureTexture(brush.tip),grainOffset:brush.texture>0?ensureTexture(brush.grain):-1});
    this.pipeline=new BrushStroke(brush,shape=>this.addShape(shape));
    this.path=this.pipeline.path;
  }
  tile(tx,ty) {
    const key=tileId(tx,ty);let tile=this.tiles.get(key);if(tile)return tile;
    this.requireTile?.(tx,ty);
    const grain=this.texture>0;
    if((this.tiles.size+1)*TILE_BYTES*(grain?6:5)>this.workingBytes)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
    this.bytes+=TILE*TILE*(grain?12:8)+64;const existing=this.store.get(tx,ty);
    tile={tx,ty,before:existing?existing.pixels.slice():null,coverage:new Float32Array(TILE*TILE),pixels:this.store.writable(tx,ty).pixels,grain:grain?this.grainTile(tx,ty):null};tile.src=tile.before??ZERO_TILE;this.tiles.set(key,tile);return tile;
  }
  /** Per-pixel coverage cap 1 − texture·(1 − g) over one tile: grain is
   * anchored to the cel, so it is computed once per tile, not per dab. */
  grainTile(tx,ty){
    const out=new Float32Array(TILE*TILE),k=this.texture,ox=tx*TILE,oy=ty*TILE,offset=this.grainOffset,atlas=offset>=0?brushAtlas():null,scale=this.grainScale;
    for(let y=0;y<TILE;y++)for(let x=0;x<TILE;x++)out[y*TILE+x]=1-k*(1-(atlas?sampleGrain(atlas,offset,ox+x,oy+y,scale):hashPixel(ox+x,oy+y,this.seed)));
    return out;
  }
  /** Rasterize final dab shapes, then optionally replace the provisional tail. */
  paint(shapes,tail){
    if(this.closed)throw messageError(new Error(''), "errors.drawingBrush.theStrokeHasAlreadyEnded", {});
    for(const shape of shapes)this.addShape(shape);
    this.composite();
    // Final dabs composite over tail tiles from final coverage alone.
    if(tail!==undefined)this.setTail(tail);else if(shapes.length&&this.tailTiles.size)this.setTail(this.tailShapes);
  }
  /** Paint one path point as a single dab and write its pixels at once. */
  dab(p){const shape=dabShape(this.brush,p);this.paint(shape?[shape]:[]);}
  /** Accumulate one final dab. Colour depends only on final coverage and the
   * pixels the stroke first saw, so compositing is deferred to composite(),
   * which runs once per batch over each tile's dirty span instead of once
   * per overlapping dab. */
  addShape(shape){this.dabs++;if(this.smudge)this.smudgeDab(shape);else this.accumulate(shape,null);}
  /** Coverage of one dab into each tile's final coverage, or into `scratch`
   * (tile → coverage copy) for the provisional tail. */
  accumulate(shape,scratch){
    const {x:cx,y:cy,radius,opacity,flow,cos,sin,left,top,right,bottom}=shape,ellipse=this.roundness<.999,inv=1/this.roundness;
    const r2=radius*radius,hard=this.hardness>=.999,inner=radius>=1?(radius-1)*(radius-1):-1,invR=1/radius;
    const tipAt=this.tipOffset,atlas=tipAt>=0?brushAtlas():null,rotate=ellipse||atlas;
    // Soft falloff by squared distance: a per-stroke table replaces a square
    // root and smoothstep per pixel.
    const lut=hard?null:this.softLUT(),scale=lut?(lut.length-1)/r2:0,mask=this.mask;
    const coverageOf=tile=>{if(!scratch)return tile.coverage;let c=scratch.get(tile);if(!c){c=tile.coverage.slice();scratch.set(tile,c);}return c;};
    // Visit tiles once per dab, not once per pixel. Pressure may add paint,
    // but releasing pressure must never lift paint already laid in this stroke.
    for(let ty=Math.floor(top/TILE);ty*TILE<bottom;ty++)for(let tx=Math.floor(left/TILE);tx*TILE<right;tx++){
      let tile=this.tiles.get(tileId(tx,ty));
      if(!tile&&this.skipEmpty&&!this.store.has(tx,ty))continue;
      let cov=tile?coverageOf(tile):null,x0d=TILE,y0d=TILE,x1d=-1,y1d=-1;
      const ox=tx*TILE,oy=ty*TILE,y0=Math.max(top,oy),y1=Math.min(bottom,oy+TILE);
      for(let y=y0;y<y1;y++){
        const dy=y+.5-cy;let x0=Math.max(left,ox),x1=Math.min(right,ox+TILE);
        if(!ellipse){const span=r2-dy*dy;if(span<=0)continue;const w=Math.sqrt(span);x0=Math.max(x0,Math.floor(cx-w-.5));x1=Math.min(x1,Math.ceil(cx+w+.5));}
        const row=(y-oy)*TILE-ox;let rowHit=false;
        for(let x=x0;x<x1;x++){
          const q=row+x,previous=cov?cov[q]:0;
          // Saturated coverage cannot change: the common case under dense spacing.
          if(previous>=opacity)continue;
          let dx=x+.5-cx,ddy=dy;
          if(rotate){const u=dx*cos+ddy*sin;ddy=(ddy*cos-dx*sin)*inv;dx=u;}
          const d2=dx*dx+ddy*ddy;if(d2>=r2)continue;
          let e=(hard?(d2<=inner?1:clamp(radius-Math.sqrt(d2))):lut[(d2*scale)|0])*flow;
          if(atlas)e*=sampleTip(atlas,tipAt,dx*invR,ddy*invR);
          if(mask)e*=maskValue(mask,x,y);
          if(e<=0)continue;
          if(!tile){tile=this.tile(tx,ty);cov=coverageOf(tile);}
          // Grain caps the coverage a pixel can reach, so paper pits stay
          // lighter however many dabs overlap them.
          const cap=tile.grain?opacity*tile.grain[q]:opacity;if(previous>=cap)continue;
          cov[q]=previous+(cap-previous)*e;rowHit=true;
          const lx=x-ox;if(lx<x0d)x0d=lx;if(lx>x1d)x1d=lx;
        }
        if(rowHit){const ly=y-oy;if(ly<y0d)y0d=ly;y1d=ly;}
      }
      if(x1d>=0&&!scratch){
        const d=tile.pending;
        if(d){if(x0d<d.x0)d.x0=x0d;if(y0d<d.y0)d.y0=y0d;if(x1d>d.x1)d.x1=x1d;if(y1d>d.y1)d.y1=y1d;}else tile.pending={x0:x0d,y0:y0d,x1:x1d,y1:y1d};
        this.dirtyTiles.add(tile);this.uncomposited.add(tile);
      }
    }
  }
  /** Replace the provisional tail: tiles it covers composite final coverage
   * plus the tail, and tiles it left return to final coverage alone. */
  setTail(shapes){
    const scratch=new Map();
    for(const shape of shapes)this.accumulate(shape,scratch);
    for(const tile of new Set([...this.tailTiles,...scratch.keys()])){this.compositeTile(tile,scratch.get(tile)??tile.coverage,0,0,TILE-1,TILE-1);this.dirtyTiles.add(tile);}
    this.tailTiles=new Set(scratch.keys());this.tailShapes=shapes;
  }
  /** Smudge: carry the colour under the tip along the stroke. Each dab reads
   * the current pixels, so it composites immediately instead of through
   * deferred coverage; dab order is fixed, so batching stays deterministic.
   * Colours average premultiplied, so transparent pixels never tint. */
  smudgeDab({x:cx,y:cy,radius,opacity,flow,cos,sin,left,top,right,bottom}){
    const strength=opacity*flow,ellipse=this.roundness<.999,inv=1/this.roundness;
    const r2=radius*radius,hard=this.hardness>=.999,lut=hard?null:this.softLUT(),scale=lut?(lut.length-1)/r2:0,mask=this.mask;
    const weight=(x,y)=>{let dx=x+.5-cx,dy=y+.5-cy;if(ellipse){const u=dx*cos+dy*sin;dy=(dy*cos-dx*sin)*inv;dx=u;}const d2=dx*dx+dy*dy;if(d2>=r2)return 0;
      let e=hard?(d2<=(radius-1)*(radius-1)?1:clamp(radius-Math.sqrt(d2))):lut[(d2*scale)|0];
      if(mask){e*=maskValue(mask,x,y);}return e;};
    // Average the premultiplied colour under the tip on a grid of at most
    // 64×64 samples (the GPU brush samples the same grid), reading each
    // tile's pixels once instead of looking the tile up per pixel.
    const stride=smudgeStride(right-left,bottom-top);let sr=0,sg=0,sb=0,sa=0,sw=0;
    for(let ty=Math.floor(top/TILE);ty*TILE<bottom;ty++)for(let tx=Math.floor(left/TILE);tx*TILE<right;tx++){
      const ox=tx*TILE,oy=ty*TILE,t=this.tiles.get(tileId(tx,ty))?.pixels??this.store.get(tx,ty)?.pixels;
      const x0=left+Math.ceil((Math.max(left,ox)-left)/stride)*stride,y0=top+Math.ceil((Math.max(top,oy)-top)/stride)*stride,x1=Math.min(right,ox+TILE),y1=Math.min(bottom,oy+TILE);
      for(let y=y0;y<y1;y+=stride)for(let x=x0;x<x1;x+=stride){const e=weight(x,y);if(!e)continue;sw+=e;if(!t)continue;const j=((y-oy)*TILE+x-ox)*4,a=t[j+3]/255;sr+=t[j]*a*e;sg+=t[j+1]*a*e;sb+=t[j+2]*a*e;sa+=a*e;}
    }
    if(!sw)return;
    const sample=[sr/sw,sg/sw,sb/sw,sa/sw],length=this.smudgeLength,rate=this.colorRate;
    // The carried paint keeps `length` of itself and picks up the rest from the canvas.
    const carry=this.carry?this.carry.map((v,i)=>v*length+sample[i]*(1-length)):sample;
    if(rate>0){const [br,bg,bb]=this.color;const brush=[br,bg,bb,1];for(let i=0;i<4;i++)carry[i]=carry[i]*(1-rate)+(i<3?brush[i]:1)*rate;}
    this.carry=carry;
    for(let ty=Math.floor(top/TILE);ty*TILE<bottom;ty++)for(let tx=Math.floor(left/TILE);tx*TILE<right;tx++){
      let tile=this.tiles.get(tileId(tx,ty)),changed=false;
      for(let y=Math.max(top,ty*TILE);y<Math.min(bottom,ty*TILE+TILE);y++)for(let x=Math.max(left,tx*TILE);x<Math.min(right,tx*TILE+TILE);x++){
        const e=weight(x,y)*strength;if(e<=0)continue;
        if(!tile){if(!carry[3]&&!this.store.has(tx,ty))continue;tile=this.tile(tx,ty);}
        const px=tile.pixels,j=((y-ty*TILE)*TILE+x-tx*TILE)*4,a=px[j+3]/255;
        const pa=a*(1-e)+carry[3]*e;
        if(pa<=0){px[j]=px[j+1]=px[j+2]=px[j+3]=0;changed=true;continue;}
        px[j]=Math.round((px[j]*a*(1-e)+carry[0]*e)/pa);px[j+1]=Math.round((px[j+1]*a*(1-e)+carry[1]*e)/pa);px[j+2]=Math.round((px[j+2]*a*(1-e)+carry[2]*e)/pa);px[j+3]=Math.round(pa*255);changed=true;
      }
      if(changed)this.dirtyTiles.add(tile);
    }
  }
  softLUT(){
    if(this._softLUT)return this._softLUT;
    const n=4096,lut=new Float32Array(n+1),soft=1/Math.max(1e-6,1-this.hardness);
    for(let i=0;i<=n;i++){const t=clamp((1-Math.sqrt(i/n))*soft);lut[i]=t*t*(3-2*t);}
    return this._softLUT=lut;
  }
  /** Write each pending tile span's colour from its final coverage. */
  composite(){
    for(const tile of this.uncomposited){const d=tile.pending;if(!d)continue;tile.pending=null;this.compositeTile(tile,tile.coverage,d.x0,d.y0,d.x1,d.y1);}
    this.uncomposited.clear();
  }
  /** Colour of a tile span from `cov`: a pure function of coverage, the
   * pixels the stroke first saw, and the blend mode. */
  compositeTile(tile,cov,x0,y0,x1,y1){
    const mode=this.mode,lock=this.lock,blend=mode==='normal'||mode==='erase'||mode==='behind'?null:blendChannel[mode],[sr,sg,sb]=this.color;
    const src=tile.src,px=tile.pixels;
    for(let y=y0;y<=y1;y++)for(let q=y*TILE+x0,end=y*TILE+x1;q<=end;q++){
      const c=cov[q],j=q*4;
      if(!c){px[j]=src[j];px[j+1]=src[j+1];px[j+2]=src[j+2];px[j+3]=src[j+3];continue;}
      const ba=src[j+3]/255,br=src[j],bg=src[j+1],bb=src[j+2];
      if(mode==='erase'){px[j+3]=Math.round(ba*(1-c)*255);px[j]=br;px[j+1]=bg;px[j+2]=bb;continue;}
      if(mode==='behind'){const out=ba+c*(1-ba),k=c*(1-ba);px[j+3]=Math.round(out*255);px[j]=Math.round((br*ba+sr*k)/out);px[j+1]=Math.round((bg*ba+sg*k)/out);px[j+2]=Math.round((bb*ba+sb*k)/out);continue;}
      // Separable blend against the backdrop, weighted by backdrop alpha
      // (W3C compositing): Cs' = (1-ab)·Cs + ab·B(Cb,Cs).
      let r=sr,g=sg,b=sb;
      if(blend&&ba>0){
        let mr,mg,mb;
        if(mode==='color')[mr,mg,mb]=setLum(sr,sg,sb,lum(br,bg,bb));else{mr=blend(br,sr);mg=blend(bg,sg);mb=blend(bb,sb);}
        r=(1-ba)*sr+ba*mr;g=(1-ba)*sg+ba*mg;b=(1-ba)*sb+ba*mb;
      }
      if(lock){px[j+3]=src[j+3];px[j]=Math.round(br+(r-br)*c);px[j+1]=Math.round(bg+(g-bg)*c);px[j+2]=Math.round(bb+(b-bb)*c);continue;}
      const out=c+ba*(1-c),k=ba*(1-c);px[j+3]=Math.round(out*255);px[j]=Math.round((r*c+br*k)/out);px[j+1]=Math.round((g*c+bg*k)/out);px[j+2]=Math.round((b*c+bb*k)/out);
    }
  }
  /** Paint from one input point through the brush pipeline. */
  sample(input){
    if(this.closed)throw messageError(new Error(''), "errors.drawingBrush.theStrokeHasAlreadyEnded", {});
    this.pipeline.sample(input);this.composite();
    if(this.pipeline.hasTail&&this.pipeline.tailVersion!==this.tailVersion){this.tailVersion=this.pipeline.tailVersion;this.setTail(this.pipeline.tailShapes());}
  }
  cancel(){if(this.closed)return;for(const tile of this.tiles.values()){if(tile.before)this.store.set(tile.tx,tile.ty,tile.before);else this.store.delete(tile.tx,tile.ty);}this.closed=true;}
  finish(){if(this.closed)return[];this.pipeline.finish();this.composite();if(this.tailTiles.size)this.setTail([]);this.closed=true;
    const changes=[];for(const tile of this.tiles.values()){
      const after=this.store.get(tile.tx,tile.ty)?.pixels??null;
      if(tile.before&&after&&sideEqual(tile.before,after))continue;
      if(!tile.before&&!after)continue;
      const before=normSide(compactTile(tile.before)),afterCompact=normSide(compactTile(after));
      if(before===null&&afterCompact===null)continue;
      changes.push({tx:tile.tx,ty:tile.ty,before,after:afterCompact});
    }
    return changes;
  }
}

/** Mark every pixel within Manhattan distance `k` of a set pixel — exactly `k`
 * steps of 4-neighbour dilation — restricted to `box` grown by k. One pass
 * suffices for k=1; larger k use a two-pass distance transform. */
function dilateL1(src,width,height,k,box){
  if(k<=0)return src;
  const x0=Math.max(0,box.x0-k),y0=Math.max(0,box.y0-k),x1=Math.min(width-1,box.x1+k),y1=Math.min(height-1,box.y1+k),out=new Uint8Array(width*height);
  if(k===1){
    for(let y=y0;y<=y1;y++){const row=y*width;for(let x=x0;x<=x1;x++){const p=row+x;if(src[p]||(x>0&&src[p-1])||(x<width-1&&src[p+1])||(y>0&&src[p-width])||(y<height-1&&src[p+width]))out[p]=1;}}
    return out;
  }
  const cap=k+1,d=out;
  for(let y=y0;y<=y1;y++){const row=y*width;for(let x=x0;x<=x1;x++){const p=row+x;let v=src[p]?0:cap;if(v){if(x>x0&&d[p-1]+1<v)v=d[p-1]+1;if(y>y0&&d[p-width]+1<v)v=d[p-width]+1;}d[p]=v;}}
  for(let y=y1;y>=y0;y--){const row=y*width;for(let x=x1;x>=x0;x--){const p=row+x;let v=d[p];if(!v)continue;if(x<x1&&d[p+1]+1<v)v=d[p+1]+1;if(y<y1&&d[p+width]+1<v)v=d[p+width]+1;d[p]=v;}}
  for(let y=y0;y<=y1;y++){const row=y*width;for(let x=x0;x<=x1;x++){const p=row+x;d[p]=d[p]<=k?1:0;}}
  return d;
}
/** Flood within an explicit pixel-space bounds rect. Transparency ignores RGB
 * of fully transparent pixels. Tolerance compares premultiplied RGBA to avoid
 * invisible RGB halos. Gap closing blocks pixels within `gap` of a boundary,
 * floods by scanline spans, then grows the region back by gap + expansion.
 * Work runs per tile: absent tiles classify in one step, and fully covered
 * tiles are written as compact uniform tiles. `clip` (a selection mask)
 * confines both the flood and its growth; `select` returns the region as a
 * mask instead of painting it (the magic wand). */
export function floodTiles(store,{x,y,color=[0,0,0,255],tolerance=16,expansion=0,gap=0,bounds,source,clip=null,select=false}={}) {
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isInteger)||bounds.width<1||bounds.height<1||bounds.width*bounds.height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingFill.invalidFillBounds", {});
  const {width,height}=bounds,count=width*height;
  x=Math.floor(x)-bounds.x;y=Math.floor(y)-bounds.y;if(x<0||y<0||x>=width||y>=height)return;
  if(![tolerance,expansion,gap].every(Number.isFinite)||color.length!==4||!color.every(Number.isFinite))throw messageError(new Error(''), "errors.drawingFill.invalidFillOptions", {});
  tolerance=clamp(tolerance,0,255);expansion=Math.round(clamp(expansion,0,16));gap=Math.round(clamp(gap,0,8));
  const origin=source?new Uint8ClampedArray(source):null;
  const sample=(px,py)=>{if(origin)return origin.subarray((py*width+px)*4,(py*width+px)*4+4);return store.pixel(bounds.x+px,bounds.y+py);};
  // Premultiplied comparison in integers: |c·a/255 − t| ≤ tol ⇔ |c·a − t·255| ≤ tol·255.
  const t=sample(x,y),ta=t[3],tr=t[0]*ta,tg=t[1]*ta,tb=t[2]*ta,tol=tolerance*255;
  const eligible=(r,g,b,a)=>{if(Math.abs(a-ta)>tolerance)return 0;const dr=r*a-tr,dg=g*a-tg,db=b*a-tb;return dr<=tol&&dr>=-tol&&dg<=tol&&dg>=-tol&&db<=tol&&db>=-tol?1:0;};
  const open=new Uint8Array(count),empty=eligible(0,0,0,0);
  if(origin){for(let p=0,i=0;p<count;p++,i+=4)open[p]=eligible(origin[i],origin[i+1],origin[i+2],origin[i+3]);}
  else for(const [tx,ty] of TileStore.tilesInRect(bounds.x,bounds.y,width,height)){
    const tile=store.get(tx,ty),ox=tx*TILE-bounds.x,oy=ty*TILE-bounds.y,sx=Math.max(0,-ox),ex=Math.min(TILE,width-ox),sy=Math.max(0,-oy),ey=Math.min(TILE,height-oy);
    if(!tile){if(empty)for(let py=sy;py<ey;py++){const row=(py+oy)*width+ox;open.fill(1,row+sx,row+ex);}continue;}
    const src=tile.pixels;
    for(let py=sy;py<ey;py++){const row=(py+oy)*width+ox;for(let px=sx,i=(py*TILE+sx)*4;px<ex;px++,i+=4)open[row+px]=eligible(src[i],src[i+1],src[i+2],src[i+3]);}
  }
  // Close gaps by blocking pixels near nonmatching boundaries.
  if(gap){
    let closedCount=0;for(let p=0;p<count;p++)closedCount+=1-open[p];
    if(closedCount*(2*gap*gap+2*gap+1)<4*count){
      // Sparse boundaries (typical line art): stamp a diamond around each one.
      const blocked=new Uint8Array(count);
      for(let p=0;p<count;p++){if(open[p])continue;const px=p%width,py=(p-px)/width;
        for(let dy=-gap;dy<=gap;dy++){const yy=py+dy;if(yy<0||yy>=height)continue;const w=gap-Math.abs(dy),row=yy*width;blocked.fill(1,row+Math.max(0,px-w),row+Math.min(width-1,px+w)+1);}}
      for(let p=0;p<count;p++)if(blocked[p])open[p]=0;
    }else{const closed=new Uint8Array(count);for(let p=0;p<count;p++)closed[p]=1-open[p];const blocked=dilateL1(closed,width,height,gap,{x0:0,y0:0,x1:width-1,y1:height-1});for(let p=0;p<count;p++)if(blocked[p])open[p]=0;}
  }
  const clipAt=clip?(p=>{const cx=p%width+bounds.x-clip.x,cy=(p-p%width)/width+bounds.y-clip.y;return cx>=0&&cy>=0&&cx<clip.width&&cy<clip.height?clip.mask[cy*clip.width+cx]:0;}):null;
  if(clipAt)for(let p=0;p<count;p++)if(open[p]&&!clipAt(p))open[p]=0;
  const start=y*width+x;if(!open[start])return select?null:undefined;
  const mask=new Uint8Array(count),stack=[start],box={x0:x,y0:y,x1:x,y1:y};
  while(stack.length){
    const p=stack.pop();if(mask[p]||!open[p])continue;
    const row=p-p%width,ry=row/width;let l=p,r=p;
    while(l>row&&open[l-1]&&!mask[l-1])l--;
    while(r<row+width-1&&open[r+1]&&!mask[r+1])r++;
    mask.fill(1,l,r+1);
    if(l-row<box.x0)box.x0=l-row;if(r-row>box.x1)box.x1=r-row;if(ry<box.y0)box.y0=ry;if(ry>box.y1)box.y1=ry;
    for(const next of [row-width,row+width]){
      if(next<0||next>=count)continue;
      const off=next-row;let inRun=false;
      for(let q=l+off;q<=r+off;q++){if(open[q]&&!mask[q]){if(!inRun){stack.push(q);inRun=true;}}else inRun=false;}
    }
  }
  const k=gap+expansion,grown=dilateL1(mask,width,height,k,box),word=(color[3]<<24|color[2]<<16|color[1]<<8|color[0])>>>0;
  const gx0=Math.max(0,box.x0-k),gy0=Math.max(0,box.y0-k),gx1=Math.min(width-1,box.x1+k),gy1=Math.min(height-1,box.y1+k);
  if(clipAt)for(let py=gy0;py<=gy1;py++)for(let px=gx0;px<=gx1;px++){const p=py*width+px;if(grown[p]&&!clipAt(p))grown[p]=0;}
  if(select){const w=gx1-gx0+1,h=gy1-gy0+1,out=new Uint8Array(w*h);for(let py=0;py<h;py++)out.set(grown.subarray((py+gy0)*width+gx0,(py+gy0)*width+gx0+w),py*w);return cropMask({x:bounds.x+gx0,y:bounds.y+gy0,width:w,height:h,mask:out});}
  const uniform=new Uint8ClampedArray([color[0],color[1],color[2],color[3]]);
  for(const [tx,ty] of TileStore.tilesInRect(bounds.x+gx0,bounds.y+gy0,gx1-gx0+1,gy1-gy0+1)){
    const ox=tx*TILE-bounds.x,oy=ty*TILE-bounds.y,sx=Math.max(0,-ox),ex=Math.min(TILE,width-ox),sy=Math.max(0,-oy),ey=Math.min(TILE,height-oy);
    let filled=0;
    for(let py=sy;py<ey;py++){const row=(py+oy)*width+ox;for(let px=sx;px<ex;px++)filled+=grown[row+px];}
    if(!filled)continue;
    // A tile the fill covers completely becomes one uniform colour.
    if(filled===TILE*TILE){store.set(tx,ty,uniform);continue;}
    const tile=store.writable(tx,ty),out32=new Uint32Array(tile.pixels.buffer,tile.pixels.byteOffset,TILE*TILE);
    for(let py=sy;py<ey;py++){const row=(py+oy)*width+ox;for(let px=sx;px<ex;px++)if(grown[row+px])out32[py*TILE+px]=word;}
  }
}

/** A lasso mask allocated only around the polygon bounding box. */
export function maskValue(m,x,y){if(!m||x<m.x||y<m.y||x>=m.x+m.width||y>=m.y+m.height)return 0;return m.points?Number(lassoContains(m.points,x,y)):m.mask[(y-m.y)*m.width+x-m.x]/(m.max??1);}
export function lassoMask(points) {
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
  const x0=Math.floor(Math.min(...xs)),y0=Math.floor(Math.min(...ys)),width=Math.ceil(Math.max(...xs))-x0,height=Math.ceil(Math.max(...ys))-y0;
  if(width*height>DRAWING_MAX_PIXELS)return {x:x0,y:y0,width,height,points};
  const mask=new Uint8Array(Math.max(0,width)*Math.max(0,height));
  if(points.length<3||width<1||height<1)return{x:x0,y:y0,width:Math.max(0,width),height:Math.max(0,height),mask};
  for(let y=0;y<height;y++){const crosses=[],wy=y0+y+.5;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a.y>wy)!==(b.y>wy))crosses.push(a.x+(wy-a.y)*(b.x-a.x)/(b.y-a.y));}crosses.sort((a,b)=>a-b);for(let i=0;i+1<crosses.length;i+=2)for(let x=Math.max(0,Math.ceil(crosses[i]-.5-x0));x<Math.min(width,Math.ceil(crosses[i+1]-.5-x0));x++)mask[y*width+x]=1;}
  return{x:x0,y:y0,width,height,mask};
}

/** Selection masks are {x,y,width,height,mask:Uint8Array} in cel pixel space,
 * one byte per pixel (0 or 1). */
export const rectPoints=(a,b)=>{const x0=Math.min(a.x,b.x),y0=Math.min(a.y,b.y),x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y);return [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];};
export const ellipsePoints=(a,b,n=96)=>{const cx=(a.x+b.x)/2,cy=(a.y+b.y)/2,rx=Math.abs(b.x-a.x)/2,ry=Math.abs(b.y-a.y)/2;return Array.from({length:n},(_,i)=>({x:cx+Math.cos(i/n*Math.PI*2)*rx,y:cy+Math.sin(i/n*Math.PI*2)*ry}));};
export const maskCount=m=>{let n=0;if(m)for(let i=0;i<m.mask.length;i++)n+=m.mask[i];return n;};
/** Rectangle mask covering `rect` entirely. */
export function rectMask(rect){if(rect.width*rect.height>DRAWING_MAX_PIXELS)return {...rect,points:rectPoints({x:rect.x,y:rect.y},{x:rect.x+rect.width,y:rect.y+rect.height})};return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,mask:new Uint8Array(rect.width*rect.height).fill(1)};}
/** Combine two masks: replace, add (union), subtract (a minus b) or intersect.
 * The result is cropped to its occupied bounding box, or null when empty. */
export function combineMasks(a,b,mode='replace'){
  if(mode==='replace'||!a)return mode==='subtract'||mode==='intersect'?null:cropMask(b);
  if(!b)return mode==='intersect'?null:cropMask(a);
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),width=Math.max(a.x+a.width,b.x+b.width)-x,height=Math.max(a.y+a.height,b.y+b.height)-y;
  if(width*height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingPixels.combinedSelectionExceedsThe16MegapixelMaskLimit", {});
  const out=new Uint8Array(width*height),at=maskValue;
  for(let py=0;py<height;py++)for(let px=0;px<width;px++){const u=at(a,px+x,py+y),v=at(b,px+x,py+y);out[py*width+px]=mode==='add'?(u|v):mode==='subtract'?(u&&!v?1:0):(u&v);}
  return cropMask({x,y,width,height,mask:out});
}
/** Invert a mask within `bounds` (the canvas region selections can reach). */
export function invertMask(m,bounds){
  if(bounds.width*bounds.height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingPixels.invertedSelectionExceedsThe16MegapixelMaskLimit", {});
  const out=new Uint8Array(bounds.width*bounds.height).fill(1);
  if(m)for(let py=0;py<m.height;py++)for(let px=0;px<m.width;px++){if(!maskValue(m,px+m.x,py+m.y))continue;const x=px+m.x-bounds.x,y=py+m.y-bounds.y;if(x>=0&&y>=0&&x<bounds.width&&y<bounds.height)out[y*bounds.width+x]=0;}
  return cropMask({...bounds,mask:out});
}
export function cropMask(m){
  if(!m)return null;if(m.points)return m;let x0=m.width,y0=m.height,x1=-1,y1=-1;
  for(let py=0;py<m.height;py++){const row=py*m.width;for(let px=0;px<m.width;px++)if(m.mask[row+px]){if(px<x0)x0=px;if(px>x1)x1=px;if(py<y0)y0=py;y1=py;}}
  if(x1<0)return null;if(x0===0&&y0===0&&x1===m.width-1&&y1===m.height-1)return m;
  const width=x1-x0+1,height=y1-y0+1,mask=new Uint8Array(width*height);
  for(let py=0;py<height;py++)mask.set(m.mask.subarray((py+y0)*m.width+x0,(py+y0)*m.width+x0+width),py*width);
  return {x:m.x+x0,y:m.y+y0,width,height,mask};
}
/** Boundary segments between selected and unselected pixels as flat
 * [x0,y0,x1,y1,…] runs in pixel space, merged along rows and columns, or null
 * when the outline exceeds `limit` segments (callers draw the bounds instead). */
export function maskEdges(m,limit=250000){
  if(!m)return null;const {width:w,height:h}=m,at=(px,py)=>px>=0&&py>=0&&px<w&&py<h?m.mask[py*w+px]:0,out=[];
  for(let py=0;py<=h;py++){let start=-1;for(let px=0;px<=w;px++){const edge=px<w&&at(px,py)!==at(px,py-1);if(edge&&start<0)start=px;else if(!edge&&start>=0){out.push(m.x+start,m.y+py,m.x+px,m.y+py);start=-1;if(out.length>limit*4)return null;}}}
  for(let px=0;px<=w;px++){let start=-1;for(let py=0;py<=h;py++){const edge=py<h&&at(px,py)!==at(px-1,py);if(edge&&start<0)start=py;else if(!edge&&start>=0){out.push(m.x+px,m.y+start,m.x+px,m.y+py);start=-1;if(out.length>limit*4)return null;}}}
  return out;
}
/** Paint `color` [r,g,b,a] over every selected pixel (source-over). */
export function fillMaskTiles(store,{mask,color}){
  const [r,g,b,a]=color.map(n=>clamp(n,0,255)),alpha=a/255;if(!mask||!alpha)return;
  for(const [tx,ty] of TileStore.tilesInRect(mask.x,mask.y,mask.width,mask.height)){
    const ox=tx*TILE,oy=ty*TILE;let tile=null;
    for(let py=Math.max(0,mask.y-oy);py<Math.min(TILE,mask.y+mask.height-oy);py++)for(let px=Math.max(0,mask.x-ox);px<Math.min(TILE,mask.x+mask.width-ox);px++){
      if(!maskValue(mask,px+ox,py+oy))continue;
      tile??=store.writable(tx,ty);const j=(py*TILE+px)*4,p=tile.pixels,ba=p[j+3]/255,out=alpha+ba*(1-alpha),k=ba*(1-alpha);
      p[j]=Math.round((r*alpha+p[j]*k)/out);p[j+1]=Math.round((g*alpha+p[j+1]*k)/out);p[j+2]=Math.round((b*alpha+p[j+2]*k)/out);p[j+3]=Math.round(out*255);
    }
  }
}

const hue2rgb=(p,q,t)=>{if(t<0)t+=1;if(t>1)t-=1;return t<1/6?p+(q-p)*6*t:t<.5?q:t<2/3?p+(q-p)*(2/3-t)*6:p;};
/** Keep the HSL arithmetic and final mask blend in their original order,
 * without allocating RGB/HSL tuples for every painted pixel. */
function filterHslTile(source,out,x0,y0,x1,y1,ox,oy,mask,hue,saturation,lightness){
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=(y*TILE+x)*4,w=mask?maskValue(mask,x+ox,y+oy):1;
    if(!w||!source[i+3])continue;
    let r=source[i]/255,g=source[i+1]/255,b=source[i+2]/255;
    const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;
    let h=0,s=0;
    if(max!==min){
      const d=max-min;s=l>.5?d/(2-max-min):d/(max+min);
      h=(max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4)/6;
    }
    h=((h+hue/360)%1+1)%1;s=clamp(s*(1+saturation/100));
    const nextL=clamp(lightness>=0?l+(1-l)*lightness/100:l*(1+lightness/100));
    if(!s)r=g=b=nextL*255;
    else{
      const q=nextL<.5?nextL*(1+s):nextL+s-nextL*s,p=2*nextL-q;
      r=hue2rgb(p,q,h+1/3)*255;g=hue2rgb(p,q,h)*255;b=hue2rgb(p,q,h-1/3)*255;
    }
    out[i]=Math.round(source[i]+(clamp(r,0,255)-source[i])*w);
    out[i+1]=Math.round(source[i+1]+(clamp(g,0,255)-source[i+1])*w);
    out[i+2]=Math.round(source[i+2]+(clamp(b,0,255)-source[i+2])*w);
  }
}
/** One horizontal-then-vertical box blur pass over premultiplied RGBA floats. */
function boxBlur(src,dst,tmp,width,height,r){
  const w=2*r+1;
  for(let y=0;y<height;y++)for(let c=0;c<4;c++){let sum=0;const row=y*width;for(let x=-r;x<=r;x++)sum+=src[(row+Math.min(width-1,Math.max(0,x)))*4+c];for(let x=0;x<width;x++){tmp[(row+x)*4+c]=sum/w;sum+=src[(row+Math.min(width-1,x+r+1))*4+c]-src[(row+Math.max(0,x-r))*4+c];}}
  for(let x=0;x<width;x++)for(let c=0;c<4;c++){let sum=0;for(let y=-r;y<=r;y++)sum+=tmp[(Math.min(height-1,Math.max(0,y))*width+x)*4+c];for(let y=0;y<height;y++){dst[(y*width+x)*4+c]=sum/w;sum+=tmp[(Math.min(height-1,y+r+1)*width+x)*4+c]-tmp[(Math.max(0,y-r)*width+x)*4+c];}}
}
/** Blur owns its bounded dense surfaces independently of sparse point filters. */
function blurTiles(store,bounds,mask,radius){
  if(bounds.width*bounds.height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingPixels.invalidFilterBounds", {});
  const {x:bx,y:by,width,height}=bounds,source=store.readRect(bx,by,width,height),out=new Uint8ClampedArray(source);
  const weight=(x,y)=>{if(!mask)return 1;return maskValue(mask,x+bx,y+by);};
  const r=Math.max(1,Math.round(clamp(radius,1,64)/Math.sqrt(3))),pre=new Float32Array(source.length),next=new Float32Array(source.length),scratch=new Float32Array(source.length);
  for(let i=0;i<source.length;i+=4){const a=source[i+3]/255;pre[i]=source[i]*a;pre[i+1]=source[i+1]*a;pre[i+2]=source[i+2]*a;pre[i+3]=source[i+3];}
  boxBlur(pre,next,scratch,width,height,r);boxBlur(next,pre,scratch,width,height,r);boxBlur(pre,next,scratch,width,height,r);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const w=weight(x,y);if(!w)continue;const i=(y*width+x)*4,a=next[i+3];
    const b=a>0?[next[i]*255/a,next[i+1]*255/a,next[i+2]*255/a,a]:[0,0,0,0];for(let c=0;c<4;c++)out[i+c]=Math.round(source[i+c]+(b[c]-source[i+c])*w);}
  store.writeRect(bx,by,width,height,out);
}
function assertFilterBounds(bounds){
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height,bounds.x+bounds.width,bounds.y+bounds.height].every(Number.isSafeInteger)||bounds.width<1||bounds.height<1)throw messageError(new Error(''), "errors.drawingPixels.invalidFilterBounds", {});
}
/** Point filters visit only existing tile intersections. Their pixel limit
 * follows occupied work, so distant paint does not allocate its empty bounds. */
export function pointFilterWork(store,bounds){
  assertFilterBounds(bounds);let pixels=0,bytes=0;
  for(const tile of store){
    const x=tile.tx*TILE,y=tile.ty*TILE,width=Math.min(x+TILE,bounds.x+bounds.width)-Math.max(x,bounds.x),height=Math.min(y+TILE,bounds.y+bounds.height)-Math.max(y,bounds.y);
    if(width>0&&height>0){pixels+=width*height;bytes+=TILE_BYTES;}
  }
  return {pixels,bytes};
}
/** Drawing filters over `bounds`, weighted by an optional selection mask:
 * blur (three box passes ≈ Gaussian, premultiplied so transparent pixels
 * never darken edges), hue/saturation/lightness, brightness/contrast and
 * invert. Pixels outside the mask keep their exact bytes. */
export function filterTiles(store,{bounds,kind,mask=null,radius=4,hue=0,saturation=0,lightness=0,brightness=0,contrast=0,before}){
  assertFilterBounds(bounds);
  if(!['blur','hsl','brightness','invert'].includes(kind))throw messageError(new Error(''), "errors.drawingController.unknownDrawingFilter", {});
  if(kind!=='blur'){
    if(pointFilterWork(store,bounds).pixels>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingPixels.invalidFilterBounds", {});
    const k=clamp(1+contrast/100,0,4),o=brightness*2.55;
    // Each channel has only 256 possible inputs. Keep the original floating
    // arithmetic in the table so fractional masks and half-byte ties agree.
    const brightnessValues=kind==='brightness'?Float64Array.from({length:256},(_,value)=>clamp((value-128)*k+128+o,0,255)):null;
    const brightnessBytes=brightnessValues&&!mask?Uint8ClampedArray.from(brightnessValues,(value,i)=>Math.round(i+(value-i))):null;
    for(const tile of store){
      const ox=tile.tx*TILE,oy=tile.ty*TILE,x0=Math.max(0,bounds.x-ox),y0=Math.max(0,bounds.y-oy),x1=Math.min(TILE,bounds.x+bounds.width-ox),y1=Math.min(TILE,bounds.y+bounds.height-oy),source=tile.pixels;
      if(x0>=x1||y0>=y1)continue;
      const out=source.slice();
      if(!mask&&(kind==='invert'||brightnessBytes)){
        // Unmasked byte transforms need no per-pixel mask arithmetic.
        for(let y=y0;y<y1;y++)for(let i=(y*TILE+x0)*4,end=(y*TILE+x1)*4;i<end;i+=4)if(source[i+3]){
          if(brightnessBytes){out[i]=brightnessBytes[source[i]];out[i+1]=brightnessBytes[source[i+1]];out[i+2]=brightnessBytes[source[i+2]];}
          else{out[i]=255-source[i];out[i+1]=255-source[i+1];out[i+2]=255-source[i+2];}
        }
      }else if(kind==='hsl')filterHslTile(source,out,x0,y0,x1,y1,ox,oy,mask,hue,saturation,lightness);
      else for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        const i=(y*TILE+x)*4,w=mask?maskValue(mask,x+ox,y+oy):1;if(!w||!source[i+3])continue;
        let r=source[i],g=source[i+1],b=source[i+2];
        if(kind==='invert'){r=255-r;g=255-g;b=255-b;}
        else{r=brightnessValues[r];g=brightnessValues[g];b=brightnessValues[b];}
        r=Math.round(source[i]+(clamp(r,0,255)-source[i])*w);g=Math.round(source[i+1]+(clamp(g,0,255)-source[i+1])*w);b=Math.round(source[i+2]+(clamp(b,0,255)-source[i+2])*w);
        out[i]=r;out[i+1]=g;out[i+2]=b;
      }
      // A changed tile usually differs in its first few bytes. Checking once
      // here keeps per-pixel work simple while preserving no-op tile identity.
      const a=source.byteOffset%4===0?new Uint32Array(source.buffer,source.byteOffset,TILE*TILE):source,b=a===source?out:new Uint32Array(out.buffer);
      let changed=false;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){changed=true;break;}
      if(changed){const key=tileKey(tile.tx,tile.ty);if(before&&!before.has(key))before.set(key,source);store.adopt(tile.tx,tile.ty,out);}
    }
    return;
  }
  blurTiles(store,bounds,mask,radius);
}
