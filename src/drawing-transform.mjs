import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,TileStore,tileKey,tileTransparent,assertTileCoordinates} from './drawing-tiles.mjs';
import {levelStore} from './drawing-raster.mjs';

export const TRANSFORM_BYTES=384*1024*1024;
const limit=()=>{throw messageError(new Error(''), "errors.drawingTransform.theTransformExceedsTheDrawingWorkingMemoryLimit", {});};
export const tileIntersects=(t,r)=>t.tx*TILE<r.x+r.width&&(t.tx+1)*TILE>r.x&&t.ty*TILE<r.y+r.height&&(t.ty+1)*TILE>r.y;

export function transformBounds(r,m){
  const xs=[],ys=[];
  for(const x of [r.x,r.x+r.width])for(const y of [r.y,r.y+r.height]){xs.push(m[0]*x+m[2]*y+m[4]);ys.push(m[1]*x+m[3]*y+m[5]);}
  const x=Math.floor(Math.min(...xs)),y=Math.floor(Math.min(...ys));
  return {x,y,width:Math.ceil(Math.max(...xs))-x,height:Math.ceil(Math.max(...ys))-y};
}
export function inverseMatrix(m){
  if(!Array.isArray(m)||m.length!==6||!m.every(Number.isFinite))throw messageError(new Error(''), "errors.drawingTransform.invalidDrawingTransform", {});
  const [a,b,c,d,x,y]=m,det=a*d-b*c;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw messageError(new Error(''), "errors.drawingTransform.theDrawingTransformIsSingular", {});
  return [d/det,-b/det,-c/det,a/det,(c*y-d*x)/det,(b*x-a*y)/det];
}
export function multiplyMatrix(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}

function filterLevel(matrix,filter){
  inverseMatrix(matrix);
  if(!['smooth','nearest'].includes(filter))throw messageError(new Error(''), "errors.drawingTransform.invalidDrawingTransformFilter", {});
  const [a,b,c,d]=matrix,det=a*d-b*c,q=a*a+b*b+c*c+d*d;
  const largest=Math.sqrt((q+Math.sqrt(Math.max(0,q*q-4*det*det)))/2),smallest=Math.abs(det)/largest;
  return filter==='nearest'?0:Math.max(0,Math.min(8,Math.floor(Math.log2(1/smallest)+1e-9)));
}
function supportBounds(b,matrix,filter,level){
  const f=2**level,halo=filter==='nearest'?0:f/2,x=Math.floor(b.x/f)*f,y=Math.floor(b.y/f)*f;
  const right=Math.ceil((b.x+b.width)/f)*f,bottom=Math.ceil((b.y+b.height)/f)*f;
  return transformBounds({x:x-halo,y:y-halo,width:right-x+2*halo,height:bottom-y+2*halo},matrix);
}
/** Include the filter footprint when collecting existing destination tiles.
 * Otherwise edge pixels could replace a neighboring tile that was not seeded. */
export function transformSupportBounds(bounds,matrix,filter='smooth'){return supportBounds(bounds,matrix,filter,filterLevel(matrix,filter));}

/** Plan only occupied source tiles. Neither coordinate distance nor the full
 * image's bounding rectangle can cause an allocation. Preflight all output
 * and mip tiles before rasterizing or touching a destination. */
function planTransform(source,matrix,filter,maxBytes,baseBytes,tileCost){
  if(!Number.isFinite(maxBytes)||maxBytes<0)throw messageError(new Error(''), "errors.drawingTransform.invalidDrawingTransformOptions", {});
  const level=filterLevel(matrix,filter);
  const coverage=Array.from({length:level},()=>new Set());let mipBytes=0;
  for(const t of source)for(let k=1;k<=level;k++){
    const keys=coverage[k-1],key=tileKey(Math.floor(t.tx/2**k),Math.floor(t.ty/2**k));
    if(!keys.has(key)){keys.add(key);mipBytes+=TILE_BYTES+96;if(baseBytes+mipBytes>maxBytes)limit();}
  }
  const candidates=new Map(),maxTiles=Math.floor((maxBytes-baseBytes-mipBytes)/(tileCost+96));
  if(maxTiles<0)limit();
  for(const tile of source){
    if(tileTransparent(tile))continue;
    const b=tile.alphaBounds,rect=supportBounds({...b,x:tile.tx*TILE+b.x,y:tile.ty*TILE+b.y},matrix,filter,level);
    const x0=Math.floor(rect.x/TILE),y0=Math.floor(rect.y/TILE),x1=Math.floor((rect.x+rect.width-1)/TILE),y1=Math.floor((rect.y+rect.height-1)/TILE);
    assertTileCoordinates(x0,y0);assertTileCoordinates(x1,y1);
    if((x1-x0+1)*(y1-y0+1)>maxTiles)limit();
    for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++){
      const key=tileKey(tx,ty);if(!candidates.has(key)){if(candidates.size>=maxTiles)limit();candidates.set(key,{tx,ty});}
    }
  }
  return {level,candidates};
}

/** Existing destination tiles must be seeded from the same sparse support
 * used by the transform, including filtering across tile boundaries. */
export function transformTileCoverage(source,matrix,filter='smooth',maxBytes=TRANSFORM_BYTES){
  return planTransform(source,matrix,filter,maxBytes,source.bytes,TILE_BYTES).candidates;
}

/** A serialized tile index can seed destination pixels without decoding PNGs
 * on the UI thread. Full tile support conservatively includes transparent edges. */
export function indexedTileCoverage(tiles,matrix,filter='smooth',maxBytes=TRANSFORM_BYTES){
  const source={bytes:tiles.length*TILE_BYTES,*[Symbol.iterator](){for(const {tx,ty} of tiles)yield{tx,ty,alphaBounds:{x:0,y:0,width:TILE,height:TILE}};}};
  return transformTileCoverage(source,matrix,filter,maxBytes);
}

/** Cache the four adjacent tiles used by bilinear interpolation. Sampling
 * accumulates premultiplied colors and never round-trips through a canvas. */
function sampler(store){
  const xs=Array(4),ys=Array(4),pixels=Array(4);
  return (x,y,weight,out)=>{
    if(!weight)return;
    const tx=Math.floor(x/TILE),ty=Math.floor(y/TILE),slot=(tx&1)+2*(ty&1);
    if(xs[slot]!==tx||ys[slot]!==ty){xs[slot]=tx;ys[slot]=ty;pixels[slot]=store.get(tx,ty)?.pixels;}
    const p=pixels[slot];if(!p)return;
    const i=((y-ty*TILE)*TILE+x-tx*TILE)*4,alpha=p[i+3]*weight;
    out[0]+=p[i]*alpha;out[1]+=p[i+1]*alpha;out[2]+=p[i+2]*alpha;out[3]+=alpha;
  };
}

/** Worker-side affine source-over. The caller owns a private destination;
 * authoritative cels are published only after this operation succeeds.
 * `before` optionally captures exact undo sides for paste/selection. */
export function transformTiles(source,matrix,{target=new TileStore(),before,filter='smooth',maxBytes=TRANSFORM_BYTES}={}){
  if(source===target)throw messageError(new Error(''), "errors.drawingTransform.transformSourceMustBeAnImmutableSnapshot", {});
  let historyBytes=0;for(const pixels of before?.values()??[])historyBytes+=pixels?.byteLength??0;
  const baseBytes=source.bytes+target.bytes+historyBytes+256*256*4;
  // A private destination allocates one tile per candidate: a new output tile
  // or the before-side of an existing one. Only shared frozen destinations
  // also need a writable copy. Source/target/already-captured bytes are above.
  const tileCost=TILE_BYTES*(before&&[...target].some(t=>t.frozen)?2:1);
  const plan=planTransform(source,matrix,filter,maxBytes,baseBytes,tileCost);
  const f=2**plan.level,input=levelStore({store:source},plan.level),m=[matrix[0]*f,matrix[1]*f,matrix[2]*f,matrix[3]*f,matrix[4],matrix[5]],inv=inverseMatrix(m);
  // Exact lattice mappings (translations, right-angle rotations, reflections)
  // avoid rounding and preserve every nonzero-alpha source byte.
  const lattice=inv.every(Number.isInteger)&&inv[0]**2+inv[1]**2===1&&inv[2]**2+inv[3]**2===1&&inv[0]*inv[2]+inv[1]*inv[3]===0;
  const nearest=filter==='nearest'||lattice,read=sampler(input),rgba=new Float64Array(4);
  // Whole-tile translations into empty space need neither sampling nor blending.
  // Keep the same preflight and undo contract as the general affine path, and
  // leave overlapping tiles to source-over below. Hidden RGB contributes nothing
  // under zero alpha, just as in the sampler.
  if(!plan.level&&matrix[0]===1&&matrix[1]===0&&matrix[2]===0&&matrix[3]===1&&matrix[4]%TILE===0&&matrix[5]%TILE===0){
    const dx=matrix[4]/TILE,dy=matrix[5]/TILE;
    for(const tile of source){
      if(tileTransparent(tile))continue;
      const tx=tile.tx+dx,ty=tile.ty+dy,key=tileKey(tx,ty);
      if(target.has(tx,ty))continue;
      if(before&&!before.has(key))before.set(key,null);
      const output=target.writable(tx,ty);output.pixels.set(tile.pixels);
      for(let i=0;i<TILE_BYTES;i+=4)if(!output.pixels[i+3])output.pixels.fill(0,i,i+3);
      output.alphaBounds=tile.alphaBounds;plan.candidates.delete(key);
    }
  }
  for(const [key,{tx,ty}] of plan.candidates){
    // One bounded source window per output tile removes Map lookups from the
    // common sampling loop. Extreme nearest-neighbor reductions still use
    // sparse lookups instead of allocating a large window of empty pixels.
    const rect=transformBounds({x:tx*TILE,y:ty*TILE,width:TILE,height:TILE},inv);
    const wx=rect.x-1,wy=rect.y-1,ww=rect.width+3,wh=rect.height+3;
    const window=ww<=256&&wh<=256?input.readRect(wx,wy,ww,wh):null;
    let pixels=null;
    for(let py=0;py<TILE;py++){
      const y=ty*TILE+py+.5,ox=tx*TILE+.5;
      const startX=inv[0]*ox+inv[2]*y+inv[4]-.5,startY=inv[1]*ox+inv[3]*y+inv[5]-.5;
      for(let px=0;px<TILE;px++){
        const x=startX+px*inv[0],y=startY+px*inv[1];let pr,pg,pb,alpha;
        if(window){
          if(nearest){const i=((Math.floor(y+.5)-wy)*ww+Math.floor(x+.5)-wx)*4;alpha=window[i+3];pr=window[i]*alpha;pg=window[i+1]*alpha;pb=window[i+2]*alpha;}
          else{
            const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,i=((iy-wy)*ww+ix-wx)*4,j=i+ww*4;
            const a0=window[i+3]*(1-fx)*(1-fy),a1=window[i+7]*fx*(1-fy),a2=window[j+3]*(1-fx)*fy,a3=window[j+7]*fx*fy;
            alpha=a0+a1+a2+a3;pr=window[i]*a0+window[i+4]*a1+window[j]*a2+window[j+4]*a3;
            pg=window[i+1]*a0+window[i+5]*a1+window[j+1]*a2+window[j+5]*a3;pb=window[i+2]*a0+window[i+6]*a1+window[j+2]*a2+window[j+6]*a3;
          }
        }else{
          rgba.fill(0);
          if(nearest)read(Math.floor(x+.5),Math.floor(y+.5),1,rgba);
          else{
          const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
          read(ix,iy,(1-fx)*(1-fy),rgba);read(ix+1,iy,fx*(1-fy),rgba);read(ix,iy+1,(1-fx)*fy,rgba);read(ix+1,iy+1,fx*fy,rgba);
          }
          [pr,pg,pb,alpha]=rgba;
        }
        const j=(py*TILE+px)*4;if(alpha<=0||alpha<.5&&!(pixels??target.get(tx,ty)?.pixels)?.[j+3])continue;
        if(!pixels){if(before&&!before.has(key))before.set(key,target.get(tx,ty)?.pixels.slice()??null);pixels=target.writable(tx,ty).pixels;}
        const base=pixels[j+3]*(1-alpha/255),out=alpha+base;
        pixels[j]=Math.round((pr+pixels[j]*base)/out);pixels[j+1]=Math.round((pg+pixels[j+1]*base)/out);pixels[j+2]=Math.round((pb+pixels[j+2]*base)/out);
        pixels[j+3]=Math.round(out);
      }
    }
  }
  return target;
}
