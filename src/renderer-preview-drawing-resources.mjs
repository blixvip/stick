import {messageError} from './localized-error.mjs';
import {drawingMetadata} from './drawing-model.mjs';
import {TILE,TILE_BYTES} from './drawing-tiles.mjs';
import {TILE_BLOB_PREFIX,TILE_BLOB_MAX_CHARACTERS,TILE_BLOB_MAX_TILES} from './drawing-tile-codec.mjs';
import {base64ToBytes} from './base64.mjs';
import {canRefineDrawingItems} from './renderer-preview-drawings.mjs';

const SCRATCH_LIMIT=32*1024*1024;
const invalid=()=>messageError(new Error(''), 'errors.drawingComposite.invalidDrawingCompositeBounds', {});
const budgetError=()=>Object.assign(messageError(new Error(''), 'errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit', {}),{code:'preview_raster_budget'});

function tileCount(url){
  if(url==null)return 0;
  if(typeof url!=='string'||!url.startsWith(TILE_BLOB_PREFIX)||url.length>TILE_BLOB_PREFIX.length+TILE_BLOB_MAX_CHARACTERS)throw invalid();
  // The fixed header carries the allocation count. Decode at most 18 bytes
  // here, before the existing provider can allocate any tile or full blob.
  let header;
  try{header=base64ToBytes(url.slice(TILE_BLOB_PREFIX.length,TILE_BLOB_PREFIX.length+24));}
  catch{throw invalid();}
  if(header.length<16)throw invalid();
  const view=new DataView(header.buffer,header.byteOffset,header.byteLength);
  const count=view.getUint32(12,true);
  if(view.getUint32(0)!==0x54595453||view.getUint32(4,true)!==1||view.getUint32(8,true)!==TILE||count>TILE_BLOB_MAX_TILES)throw invalid();
  return count;
}

function coverage(bounds,level=0){
  if(!bounds)return {width:0,height:0};
  if(![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isSafeInteger)||bounds.width<1||bounds.height<1||
    !Number.isSafeInteger(bounds.x+bounds.width)||!Number.isSafeInteger(bounds.y+bounds.height))throw invalid();
  const scale=TILE*2**level;
  return {width:(Math.ceil((bounds.x+bounds.width)/scale)-Math.floor(bounds.x/scale))*TILE,
    height:(Math.ceil((bounds.y+bounds.height)/scale)-Math.floor(bounds.y/scale))*TILE};
}

/** Worker-only admission for sparse published drawings. Retain the actual
 * tile count, never allocate the empty rectangle between distant marks.
 * Every mip has at most the original tile count. Presenter scratch is bounded
 * by its existing four-anchor LRU and global limit; its level-eight strip
 * fallback needs at most one core with the existing one-tile sampling halo.
 * Encoded-byte overlap includes base64 conversion and per-tile PNG inflation. */
export function drawingPreviewPlan(items){
  const figures=[],seen=new Map();
  let decodedBytes=0,encodedBytes=0,maxEncodedBytes=0,scratchBytes=0,stripBytes=0,tiles=0,tinted=false;
  for(const item of items){
    const drawing=drawingMetadata(item.fig);
    if(item.type!=='image'){
      if(!canRefineDrawingItems([item]))throw invalid();
      continue;
    }
    if(drawing?.version!==2||typeof drawing.celId!=='string'||!Number.isSafeInteger(drawing.revision)||drawing.revision<0)throw invalid();
    tinted||=Boolean(item.onionTint);
    const url=item.fig.image_assets?.[0]?.styk_tiles,previous=seen.get(drawing.celId);
    if(previous){if(previous.revision!==drawing.revision||previous.url!==url)throw invalid();continue;}
    const count=tileCount(url),base=coverage(drawing.bounds),last=coverage(drawing.bounds,8);
    if(count>0&&!drawing.bounds)throw invalid();
    const encoded=url?Math.ceil((url.length-TILE_BLOB_PREFIX.length)*3/4):0;
    tiles+=count;decodedBytes+=count*TILE_BYTES;encodedBytes+=encoded;maxEncodedBytes=Math.max(maxEncodedBytes,encoded);
    const scratch=Math.min(4096,base.width)*Math.min(4096,base.height)*4;
    scratchBytes+=4*scratch;
    stripBytes=Math.max(stripBytes,Math.min(4096+2*TILE,last.width)*Math.min(4096+2*TILE,last.height)*4);
    seen.set(drawing.celId,{revision:drawing.revision,url});figures.push(item.fig);
  }
  scratchBytes=Math.min(SCRATCH_LIMIT,scratchBytes);
  // Existing tint canvases can retain one global LRU plus an oversized strip.
  // Ordinary live artwork has no tint owner or allocation.
  const tintBytes=tinted?Math.max(SCRATCH_LIMIT,stripBytes):0;
  const bytes=figures.length?9*decodedBytes+encodedBytes+6*maxEncodedBytes+scratchBytes+stripBytes+tintBytes+tiles*512+128*1024:0;
  if(!Number.isSafeInteger(bytes))throw budgetError();
  return Object.freeze({figures:Object.freeze(figures),bytes,decodedBytes,encodedBytes,scratchBytes,stripBytes,tintBytes,
    providerBudgetBytes:Math.max(decodedBytes,3*scratchBytes)});
}

/** Use the existing worker drawing/tint owner for one capture, then dispose it
 * before transferring its bitmap. This creates no document mirror or retained
 * editor cache. Native path-only captures need no resource allocation. */
export async function preparePreviewDrawings(plan,{maxBytes=plan.bytes,check=()=>{}}={}){
  if(!Number.isFinite(maxBytes)||maxBytes<plan.bytes)throw budgetError();
  check();
  if(!plan.figures.length)return null;
  const {PlaybackResources}=await import('./playback-resources.mjs');
  check();
  const resources=new PlaybackResources({maxBytes:0,hardMaxBytes:0,absoluteMaxBytes:0});
  resources.drawingProvider.budgetBytes=plan.providerBudgetBytes;
  resources.drawingProvider.hardBytes=plan.decodedBytes;
  try{
    await resources.drawingProvider.prepare(plan.figures);check();
    return resources;
  }catch(error){resources.dispose();throw error;}
}
