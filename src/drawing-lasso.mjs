import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,MIN_TILE,MAX_TILE,TileStore,tileKey,tileTransparent} from './drawing-tiles.mjs';
import {TRANSFORM_BYTES} from './drawing-transform.mjs';

export function lassoBounds(points){
  if(!Array.isArray(points)||points.length>8192||points.some(p=>!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=MIN_TILE*TILE&&n<=(MAX_TILE+1)*TILE)))throw messageError(new Error(''), "errors.drawingLasso.invalidLassoCoordinates", {});
  if(points.length<3)return null;
  const x=Math.floor(Math.min(...points.map(p=>p.x))),y=Math.floor(Math.min(...points.map(p=>p.y)));
  const width=Math.ceil(Math.max(...points.map(p=>p.x)))-x,height=Math.ceil(Math.max(...points.map(p=>p.y)))-y;
  return width&&height?{x,y,width,height}:null;
}

/** Match the even-odd scan conversion at the center of the hit pixel. The
 * polygon also describes selected empty space without allocating its pixels. */
export function lassoContains(points,x,y){
  x=Math.floor(x)+.5;y=Math.floor(y)+.5;let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i];
    if((a.y>y)!==(b.y>y)&&x<a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y))inside=!inside;
  }
  return inside;
}

/** Worker-side capture. Scan only occupied tile rows; one tile-sized coverage
 * buffer is reused. Empty distance and polygon area never allocate pixels.
 * Returned source and remainder are immutable previews, not document edits. */
export function captureSelection(store,points,{maxBytes=TRANSFORM_BYTES}={}){
  const bounds=lassoBounds(points),tiles=[];
  if(!bounds)return {bounds,tiles};
  if(!Number.isFinite(maxBytes)||maxBytes<0)throw messageError(new Error(''), "errors.drawingLasso.invalidSelectionMemoryBudget", {});
  const limit=()=>{throw messageError(new Error(''), "errors.drawingLasso.theSelectionExceedsTheDrawingWorkingMemoryLimit", {});};
  // Edge objects, row indices, crossings and the one reusable coverage tile.
  const overhead=points.length*128+store.size*96+TILE*TILE;
  let bytes=store.bytes+overhead;if(bytes>maxBytes)limit();
  const edges=[];
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    let a=points[j],b=points[i];if(a.y===b.y)continue;if(a.y>b.y)[a,b]=[b,a];edges.push({a,b});
  }
  edges.sort((u,v)=>u.a.y-v.a.y);
  const rows=new Map();
  for(const t of store){
    if(t.tx*TILE>=bounds.x+bounds.width||(t.tx+1)*TILE<=bounds.x||t.ty*TILE>=bounds.y+bounds.height||(t.ty+1)*TILE<=bounds.y)continue;
    let row=rows.get(t.ty);if(!row)rows.set(t.ty,row=[]);row.push(t);
  }
  let active=[],next=0;const coverage=new Uint8Array(TILE*TILE);
  for(const [ty,row] of [...rows].sort((a,b)=>a[0]-b[0])){
    const spans=[];let spanBytes=0;
    for(let y=0;y<TILE;y++){
      const cy=ty*TILE+y+.5;
      active=active.filter(e=>e.b.y>cy);
      while(next<edges.length&&edges[next].a.y<=cy){const e=edges[next++];if(e.b.y>cy)active.push(e);}
      const xs=active.map(({a,b})=>a.x+(cy-a.y)*(b.x-a.x)/(b.y-a.y)).sort((a,b)=>a-b);
      spanBytes+=xs.length*16;if(bytes+spanBytes>maxBytes)limit();spans.push(xs);
    }
    for(const t of row){
      coverage.fill(0);const ox=t.tx*TILE;let selected=0,remaining=0,covered=0;
      for(let y=0;y<TILE;y++){
        const xs=spans[y];
        for(let i=0;i+1<xs.length;i+=2){const a=Math.max(0,Math.ceil(xs[i]-.5)-ox),b=Math.min(TILE,Math.ceil(xs[i+1]-.5)-ox);if(b>a){coverage.fill(1,y*TILE+a,y*TILE+b);covered+=b-a;}}
      }
      if(!covered)continue;
      if(covered===coverage.length){if(!tileTransparent(t))selected=1;}
      else for(let p=0;p<coverage.length;p++)if(t.pixels[p*4+3]){if(coverage[p])selected++;else remaining++;}
      if(!selected)continue;
      const extra=remaining?TILE_BYTES*2:0;if(bytes+spanBytes+extra>maxBytes)limit();bytes+=extra;
      const pixels=remaining?t.pixels.slice():t.pixels,rest=remaining?t.pixels.slice():null;
      if(rest)for(let p=0;p<coverage.length;p++){if(coverage[p])rest[p*4+3]=0;else pixels[p*4+3]=0;}
      // Bounds belong to capture too: a fresh presenter must not scan every
      // captured RGBA byte on the UI thread just to locate its artwork.
      const captured={tx:t.tx,ty:t.ty,pixels,alphaBounds:remaining?undefined:t.alphaBounds},restTile=rest?{pixels:rest}:null;
      tileTransparent(captured);if(restTile)tileTransparent(restTile);
      tiles.push({...captured,full:!remaining,remaining:rest,remainingBounds:restTile?.alphaBounds??null});
    }
  }
  return {bounds,tiles};
}

/** Adopt worker-owned buffers; the unselected cel tiles are shared copy-on-write. */
export function selectionStores(base,tiles){
  const source=new TileStore(),remainder=base.fork();
  for(const t of tiles){
    const key=tileKey(t.tx,t.ty);
    if(t.full)source.tiles.set(key,base.get(t.tx,t.ty));
    else source.tiles.set(key,{tx:t.tx,ty:t.ty,pixels:t.pixels instanceof Uint8ClampedArray?t.pixels:new Uint8ClampedArray(t.pixels),alphaBounds:t.alphaBounds,frozen:true});
    if(t.remaining)remainder.tiles.set(key,{tx:t.tx,ty:t.ty,pixels:t.remaining instanceof Uint8ClampedArray?t.remaining:new Uint8ClampedArray(t.remaining),alphaBounds:t.remainingBounds,frozen:true});else remainder.tiles.delete(key);
  }
  return {source,remainder};
}

export function captureMaskSelection(store,mask,{maxBytes=TRANSFORM_BYTES}={}){
  if(mask.points)return captureSelection(store,mask.points,{maxBytes});
  if(!(mask.mask instanceof Uint8Array)||mask.mask.length!==mask.width*mask.height)throw messageError(new Error(''), "errors.drawingLasso.invalidSelectionMask", {});
  const tiles=[];let bytes=store.bytes+mask.mask.byteLength;
  for(const t of store){let selected=0,remaining=0;const at=(p)=>{const x=t.tx*TILE+p%TILE-mask.x,y=t.ty*TILE+Math.floor(p/TILE)-mask.y;return x>=0&&y>=0&&x<mask.width&&y<mask.height&&mask.mask[y*mask.width+x];};
    for(let p=0;p<TILE*TILE;p++)if(t.pixels[p*4+3]){if(at(p))selected++;else remaining++;}
    if(!selected)continue;if(bytes+(remaining?TILE_BYTES*2:0)>maxBytes)throw messageError(new Error(''), "errors.drawingLasso.theSelectionExceedsTheDrawingWorkingMemoryLimit", {});bytes+=remaining?TILE_BYTES*2:0;
    const pixels=remaining?t.pixels.slice():t.pixels,rest=remaining?t.pixels.slice():null;if(rest)for(let p=0;p<TILE*TILE;p++){if(at(p))rest[p*4+3]=0;else pixels[p*4+3]=0;}
    const captured={pixels},r=rest?{pixels:rest}:null;tileTransparent(captured);if(r)tileTransparent(r);tiles.push({tx:t.tx,ty:t.ty,pixels,alphaBounds:captured.alphaBounds,full:!remaining,remaining:rest,remainingBounds:r?.alphaBounds??null});
  }
  return {bounds:mask,tiles};
}
