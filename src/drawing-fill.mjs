import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,TileStore,tileKey,assertTileCoordinates} from './drawing-tiles.mjs';
import {tileChanges,maskValue} from './drawing-pixels.mjs';

const AREA=TILE*TILE,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// This limit belongs to the optional dense composited source, not tile fills.
export const FILL_SOURCE_MAX_PIXELS=64*1024*1024;

/** Prepare a four-connected flood without changing its source. Masks are
 * allocated only for tiles reached by the flood and its morphology halo.
 * Budget failure therefore leaves even direct callers' artwork untouched. */
function prepareFloodTiles(store,{x,y,color=[0,0,0,255],tolerance=16,expansion=0,gap=0,bounds,source,clip=null,maxBytes=768*1024*1024}={}){
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isSafeInteger)||bounds.width<1||bounds.height<1||!Number.isSafeInteger(bounds.x+bounds.width-1)||!Number.isSafeInteger(bounds.y+bounds.height-1))throw messageError(new Error(''), "errors.drawingFill.invalidFillBounds", {});
  const left=bounds.x,top=bounds.y,right=left+bounds.width,bottom=top+bounds.height;
  const tx0=Math.floor(left/TILE),ty0=Math.floor(top/TILE),tx1=Math.floor((right-1)/TILE),ty1=Math.floor((bottom-1)/TILE);
  assertTileCoordinates(tx0,ty0);assertTileCoordinates(tx1,ty1);
  if(![x,y,tolerance,expansion,gap,maxBytes].every(Number.isFinite)||maxBytes<0||color.length!==4||!color.every(Number.isFinite)||source&&(!(source instanceof Uint8ClampedArray)||bounds.width*bounds.height>FILL_SOURCE_MAX_PIXELS||source.length!==bounds.width*bounds.height*4))throw messageError(new Error(''), "errors.drawingFill.invalidFillOptions", {});
  const output=new TileStore(),before=new Map();x=Math.floor(x);y=Math.floor(y);
  if(x<left||y<top||x>=right||y>=bottom)return {output,before};
  tolerance=clamp(tolerance,0,255);expansion=Math.round(clamp(expansion,0,16));gap=Math.round(clamp(gap,0,8));
  color=Uint8ClampedArray.from(color);
  const word=new Uint32Array(color.buffer)[0];
  const rgba=source?source.subarray(((y-top)*bounds.width+x-left)*4,((y-top)*bounds.width+x-left)*4+4):store.pixel(x,y),alpha=rgba[3]/255,r=rgba[0]*alpha,g=rgba[1]*alpha,b=rgba[2]*alpha;
  const matches=(red,green,blue,a)=>Math.abs(red*a/255-r)<=tolerance&&Math.abs(green*a/255-g)<=tolerance&&Math.abs(blue*a/255-b)<=tolerance&&Math.abs(a-rgba[3])<=tolerance;
  let bytes=store.bytes+(source?.byteLength??0);
  const reserve=n=>{if(bytes+n>maxBytes)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});bytes+=n;};
  reserve(0);
  const masks=new Map(),indexed=[],candidates=new Set();
  function tile(tx,ty){
    if(tx<tx0||tx>tx1||ty<ty0||ty>ty1)return null;
    const key=tileKey(tx,ty);let t=masks.get(key);if(t)return t;
    reserve(512);if(indexed.length>=0x100000)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
    t={tx,ty,key,id:indexed.length,x0:Math.max(0,left-tx*TILE),y0:Math.max(0,top-ty*TILE),x1:Math.min(TILE,right-tx*TILE),y1:Math.min(TILE,bottom-ty*TILE),filled:0};
    indexed.push(t);masks.set(key,t);return t;
  }
  function matching(t){
    if(t.matching!==undefined)return t.matching;
    const pixels=source??store.get(t.tx,t.ty)?.pixels;
    if(!pixels)return t.matching=+matches(0,0,0,0);
    reserve(AREA);const mask=new Uint8Array(AREA);let any=false,all=true;
    for(let py=t.y0;py<t.y1;py++)for(let px=t.x0;px<t.x1;px++){
      const i=source?((t.ty*TILE+py-top)*bounds.width+t.tx*TILE+px-left)*4:(py*TILE+px)*4;
      const value=matches(pixels[i],pixels[i+1],pixels[i+2],pixels[i+3]);mask[py*TILE+px]=+value;any||=value;all&&=value;
    }
    if(all||!any){bytes-=AREA;return t.matching=+all;}
    return t.matching=mask;
  }
  const radius=gap+expansion,side=TILE+2*radius;
  reserve(radius?side*side:0);const scratch=radius?new Uint8Array(side*side):null;
  // Manhattan distance gives exactly the existing four-neighbour gap closing
  // and expansion rules. Fill the halo tile-by-tile, never by document bounds.
  function distances(t,radius,selected){
    const width=TILE+2*radius,x=t.tx*TILE-radius,y=t.ty*TILE-radius;
    scratch.fill(radius+1,0,width*width);let any=false;
    for(let ty=Math.floor(y/TILE);ty<=Math.floor((y+width-1)/TILE);ty++)for(let tx=Math.floor(x/TILE);tx<=Math.floor((x+width-1)/TILE);tx++){
      const other=selected?masks.get(tileKey(tx,ty)):tile(tx,ty);if(!other||selected&&!other.filled)continue;
      const value=selected?(other.full?1:other.visited):matching(other);
      if(selected?value===0:value===1)continue;
      const px0=Math.max(other.x0,x-tx*TILE),py0=Math.max(other.y0,y-ty*TILE),px1=Math.min(other.x1,x+width-tx*TILE),py1=Math.min(other.y1,y+width-ty*TILE);
      for(let py=py0;py<py1;py++)for(let px=px0;px<px1;px++){
        const p=py*TILE+px,seed=selected?(value===1||value[p]===2):(value===0||!value[p]);
        if(seed){scratch[(ty*TILE+py-y)*width+tx*TILE+px-x]=0;any=true;}
      }
    }
    if(!any)return null;
    for(let py=0;py<width;py++)for(let px=0;px<width;px++){const p=py*width+px;scratch[p]=Math.min(scratch[p],px?scratch[p-1]+1:255,py?scratch[p-width]+1:255);}
    for(let py=width-1;py>=0;py--)for(let px=width-1;px>=0;px--){const p=py*width+px;scratch[p]=Math.min(scratch[p],px+1<width?scratch[p+1]+1:255,py+1<width?scratch[p+width]+1:255);}
    return scratch;
  }
  function eligible(t){
    if(t.open!==undefined)return t.open;
    if(!gap)return t.open=matching(t);
    const distance=distances(t,gap,false);if(!distance)return t.open=1;
    const width=TILE+2*gap;let any=false,all=true;
    for(let py=t.y0;py<t.y1;py++)for(let px=t.x0;px<t.x1;px++){const value=distance[(py+gap)*width+px+gap]>gap;any||=value;all&&=value;}
    if(all||!any)return t.open=+all;
    reserve(AREA);const mask=new Uint8Array(AREA);
    for(let py=t.y0;py<t.y1;py++)for(let px=t.x0;px<t.x1;px++)mask[py*TILE+px]=+(distance[(py+gap)*width+px+gap]>gap);
    return t.open=mask;
  }
  reserve(4096);let stack=new Uint32Array(1024),length=0;
  function push(t,p){
    if(!t||t.full||t.pending||t.visited?.[p])return;
    const open=eligible(t);if(open!==1&&!open[p])return;
    if(open===1)t.pending=true;
    else{if(!t.visited){reserve(AREA);t.visited=new Uint8Array(AREA);}t.visited[p]=1;}
    if(length===stack.length){reserve(stack.byteLength*2);const next=new Uint32Array(stack.length*2);next.set(stack);bytes-=stack.byteLength;stack=next;}
    stack[length++]=t.id*AREA+p;
  }
  const filled=[];
  const blank=!source&&store.size===0;
  if(blank){
    if(color.every(n=>n===0))return {output,before};
    const count=(tx1-tx0+1)*(ty1-ty0+1);
    if(count>Math.floor((maxBytes-bytes)/(TILE_BYTES+832)))throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
    for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++){const t=tile(tx,ty);t.full=true;t.filled=(t.x1-t.x0)*(t.y1-t.y0);filled.push(t);}
  }else{
    const start=tile(Math.floor(x/TILE),Math.floor(y/TILE));push(start,(y-start.ty*TILE)*TILE+x-start.tx*TILE);
  }
  while(length){
    const seed=stack[--length],t=indexed[Math.floor(seed/AREA)],p=seed%AREA;
    if(t.full||t.visited?.[p]===2)continue;
    if(!t.filled){
      // Empty reached tiles will need output. Reserve that storage now so an
      // open sparse region cannot explore far beyond the affordable result.
      if(word!==0&&!store.has(t.tx,t.ty)){reserve(TILE_BYTES+256);t.outputReserved=true;}
      filled.push(t);
    }
    const open=eligible(t),visited=t.visited;
    if(open===1){
      t.full=true;t.filled=(t.x1-t.x0)*(t.y1-t.y0);
      if(t.x0===0){const other=tile(t.tx-1,t.ty);for(let py=t.y0;py<t.y1;py++)push(other,py*TILE+TILE-1);}
      if(t.x1===TILE){const other=tile(t.tx+1,t.ty);for(let py=t.y0;py<t.y1;py++)push(other,py*TILE);}
      if(t.y0===0){const other=tile(t.tx,t.ty-1);for(let px=t.x0;px<t.x1;px++)push(other,(TILE-1)*TILE+px);}
      if(t.y1===TILE){const other=tile(t.tx,t.ty+1);for(let px=t.x0;px<t.x1;px++)push(other,px);}
      continue;
    }
    const row=Math.floor(p/TILE),rowStart=row*TILE;let px=p%TILE;
    while(px>t.x0&&open[rowStart+px-1]&&visited[rowStart+px-1]!==2)px--;
    if(px===0)push(tile(t.tx-1,t.ty),rowStart+TILE-1);
    for(;px<t.x1&&open[rowStart+px]&&visited[rowStart+px]!==2;px++){
      visited[rowStart+px]=2;t.filled++;
      if(row>t.y0)push(t,(row-1)*TILE+px);else if(row===0)push(tile(t.tx,t.ty-1),(TILE-1)*TILE+px);
      if(row+1<t.y1)push(t,(row+1)*TILE+px);else if(row===TILE-1)push(tile(t.tx,t.ty+1),px);
    }
    if(px===TILE)push(tile(t.tx+1,t.ty),rowStart);
  }
  const halo=radius&&!blank?1:0;
  for(const t of filled)for(let dy=-halo;dy<=halo;dy++)for(let dx=-halo;dx<=halo;dx++){
    const candidate=tile(t.tx+dx,t.ty+dy);if(candidate&&!candidates.has(candidate)){reserve(64);candidates.add(candidate);}
  }
  for(const t of candidates){
    const old=store.get(t.tx,t.ty)?.pixels;let pixels=null;
    const distance=radius&&!t.full?distances(t,radius,true):null,width=TILE+2*radius;
    if(!t.full&&radius&&!distance)continue;
    const writable=()=>{
      // History retains source/output buffers or compacts them to four bytes;
      // adoption and worker transfer do not make another full pixel copy.
      if(!t.outputReserved)reserve(TILE_BYTES+256);pixels=old?.slice()??new Uint8ClampedArray(TILE_BYTES);
      before.set(t.key,old??null);return pixels;
    };
    if(!clip&&t.full&&t.x0===0&&t.y0===0&&t.x1===TILE&&t.y1===TILE){
      if(old&&new Uint32Array(old.buffer,old.byteOffset,AREA).every(n=>n===word)||!old&&word===0)continue;
      new Uint32Array(writable().buffer).fill(word);
    }else for(let py=t.y0;py<t.y1;py++)for(let px=t.x0;px<t.x1;px++){
      if(!t.full&&!(radius?distance[(py+radius)*width+px+radius]<=radius:t.visited?.[py*TILE+px]===2))continue;
      if(clip&&!maskValue(clip,t.tx*TILE+px,t.ty*TILE+py))continue;
      const i=(py*TILE+px)*4;
      if(color[0]===(old?.[i]??0)&&color[1]===(old?.[i+1]??0)&&color[2]===(old?.[i+2]??0)&&color[3]===(old?.[i+3]??0))continue;
      (pixels??writable()).set(color,i);
    }
    if(pixels)output.adopt(t.tx,t.ty,pixels);
  }
  return {output,before};
}

/** Adopt only after preparation and history both succeed. */
export function floodTiles(store,options){
  const {output,before}=prepareFloodTiles(store,options),changes=tileChanges(output,before);
  for(const tile of output)store.adopt(tile.tx,tile.ty,tile.pixels);
  return changes;
}
