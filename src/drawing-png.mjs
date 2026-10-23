import {messageError} from './localized-error.mjs';
import {encodePNGPortable} from './sticknodes/decoder/png-browser.mjs';
import {DRAWING_MAX_PIXELS} from './drawing-model.mjs';
import {crc32} from './sticknodes/decoder/archive.mjs';
import {base64ToBytes,bytesToBase64} from './base64.mjs';
export function drawingPNGBytes(url){
  if(typeof url!=='string'||!url.startsWith('data:image/png;base64,'))throw messageError(new Error(''), "errors.drawingPng.drawingPixelsNeedAnEmbeddedPng", {});
  return base64ToBytes(url.slice(22));
}
export function drawingPNGDataURL(bytes){return 'data:image/png;base64,'+bytesToBase64(bytes);}
export async function encodeDrawingPNG(pixels,width,height){return drawingPNGDataURL(width*height*4<=SYNC_BYTES?encodeRGBAPNG(pixels,width,height):await encodePNGPortable({width,height,channels:4},pixels));}
import {deflateZlib,inflateZlib} from './zlib-sync.mjs';
// Small images (every 64×64 tile) inflate/deflate synchronously: stream setup
// costs more than the work. Larger ones keep the native streams off-thread.
const SYNC_BYTES=1024*1024;
const chunk=(type,data)=>{const out=new Uint8Array(data.length+12),view=new DataView(out.buffer);view.setUint32(0,data.length);for(let i=0;i<4;i++)out[4+i]=type.charCodeAt(i);out.set(data,8);view.setUint32(out.length-4,crc32(out.subarray(4,-4)));return out;};
/** Filtered PNG scanlines: mode 0 keeps rows unfiltered; 'adaptive' picks
 * None, Sub or Up per row by the smallest absolute residual. */
function scanlines(pixels,width,height,mode){
  const stride=width*4,scan=new Uint8Array((stride+1)*height);
  for(let y=0;y<height;y++){
    const row=y*stride,o=y*(stride+1);let filter=0;
    if(mode==='adaptive'){let none=0,sub=0,up=0;for(let x=0;x<stride;x++){const v=pixels[row+x],a=x>=4?pixels[row+x-4]:0,b=y?pixels[row+x-stride]:0;none+=v<128?v:256-v;const s=(v-a)&255;sub+=s<128?s:256-s;const u=(v-b)&255;up+=u<128?u:256-u;}filter=sub<none&&sub<=up?1:up<none?2:0;}
    scan[o]=filter;
    if(!filter)scan.set(pixels.subarray(row,row+stride),o+1);
    else for(let x=0;x<stride;x++){const v=pixels[row+x];scan[o+1+x]=filter===1?(v-(x>=4?pixels[row+x-4]:0))&255:(v-(y?pixels[row+x-stride]:0))&255;}
  }
  return scan;
}
/** Bytes that differ from the byte one pixel earlier: positions LZ77 cannot
 * reuse, a cheap predictor of compressed size. */
const breaks=scan=>{let n=0;for(let i=4;i<scan.length;i++)if(scan[i]!==scan[i-4])n++;return n;};
/** Synchronous lossless RGBA PNG for small images. Line art compresses best
 * unfiltered and soft gradients with row filters; the scan LZ77 can reuse
 * more of is deflated (within a few percent of trying both). */
export function encodeRGBAPNG(pixels,width,height){
  const plain=scanlines(pixels,width,height,0),adaptive=scanlines(pixels,width,height,'adaptive'),data=deflateZlib(breaks(adaptive)<breaks(plain)?adaptive:plain);
  const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=6;
  const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',data),chunk('IEND',new Uint8Array())];
  const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;
}
export function decodeDrawingPNG(url){return decodeDrawingPNGBytes(drawingPNGBytes(url));}
/** Decode our portable PNG without premultiplication, including filter modes
 * emitted by other conforming RGBA/RGB encoders. All allocations are bounded. */
export async function decodeDrawingPNGBytes(bytes,{width:expectedWidth,height:expectedHeight}={}){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),signature=[137,80,78,71,13,10,26,10];if(!signature.every((n,i)=>bytes[i]===n))throw messageError(new Error(''), "errors.drawingPng.invalidDrawingPngSignature", {});
  let width,height,channels;const parts=[];
  for(let pos=8;pos+12<=bytes.length;){const length=view.getUint32(pos),end=pos+12+length;if(end>bytes.length)throw messageError(new Error(''), "errors.drawingPng.truncatedDrawingPng", {});const type=String.fromCharCode(...bytes.subarray(pos+4,pos+8)),data=bytes.subarray(pos+8,pos+8+length);
    if(crc32(bytes.subarray(pos+4,pos+8+length))!==view.getUint32(pos+8+length))throw messageError(new Error(''), "errors.drawingPng.drawingPngChecksumMismatch", {});
    if(type==='IHDR'){width=view.getUint32(pos+8);height=view.getUint32(pos+12);channels=data[9]===6?4:data[9]===2?3:0;if(!width||!height||width>8192||height>8192||width*height>DRAWING_MAX_PIXELS||data[8]!==8||!channels||data[12]!==0)throw messageError(new Error(''), "errors.drawingPng.drawingsRequireABoundedNonInterlaced8Bit", {});if((expectedWidth!==undefined&&width!==expectedWidth)||(expectedHeight!==undefined&&height!==expectedHeight))throw messageError(new Error(''), "errors.drawingPng.drawingPngDimensionsDoNotMatchItsTile", {});}
    if(type==='IDAT')parts.push(data);if(type==='IEND')break;pos=end;
  }
  if(!channels||!parts.length)throw messageError(new Error(''), "errors.drawingPng.drawingPngIsMissingPixelData", {});
  const stride=width*channels,expected=(stride+1)*height;let scan;
  if(expected<=SYNC_BYTES){
    const joined=parts.length===1?parts[0]:new Uint8Array(parts.reduce((n,p)=>n+p.length,0));if(parts.length>1){let o=0;for(const p of parts){joined.set(p,o);o+=p.length;}}
    try{scan=inflateZlib(joined,{expected});}catch(error){throw messageError(new Error(''), /expands/.test(error.message)?'errors.drawingPng.drawingPngExpandsBeyondItsDeclaredDimensions':/size mismatch|Truncated/.test(error.message)?'errors.drawingPng.drawingPngHasIncompletePixelData':'errors.drawingPng.corruptPixelData');}
  }else{
  scan=new Uint8Array(expected);const stream=new DecompressionStream('deflate'),reader=stream.readable.getReader(),writer=stream.writable.getWriter();let offset=0,writeError;
  // IDAT already owns byte views. Feeding them directly avoids a Blob and its
  // asynchronous read pipeline per tile. Await backpressure and settle the
  // producer on every exit, including expansion-limit and corrupt-stream errors.
  const written=(async()=>{try{for(const part of parts)await writer.write(part);await writer.close();}catch(error){writeError=error;await writer.abort(error).catch(()=>{});}finally{writer.releaseLock();}})();
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.length>expected)throw messageError(new Error(''), "errors.drawingPng.drawingPngExpandsBeyondItsDeclaredDimensions", {});scan.set(value,offset);offset+=value.length;}await written;if(writeError)throw writeError;}
  finally{await reader.cancel().catch(()=>{});await written;reader.releaseLock();}
  if(offset!==expected)throw messageError(new Error(''), "errors.drawingPng.drawingPngHasIncompletePixelData", {});
  }
  const output=new Uint8ClampedArray(width*height*4);
  const paeth=(a,b,c)=>{const p=a+b-c,x=Math.abs(p-a),y=Math.abs(p-b),z=Math.abs(p-c);return x<=y&&x<=z?a:y<=z?b:c;};
  for(let y=0;y<height;y++){
    const start=y*(stride+1)+1,filter=scan[start-1];if(filter>4)throw messageError(new Error(''), "errors.drawingPng.invalidDrawingPngFilter", {});
    // Reconstruct filtered rows in the bounded scan buffer. Portable drawing
    // PNGs use filter zero: those RGBA rows need only a native byte copy.
    if(filter)for(let x=0;x<stride;x++){
      const left=x>=channels?scan[start+x-channels]:0,up=y?scan[start+x-stride-1]:0,corner=y&&x>=channels?scan[start+x-stride-1-channels]:0;
      scan[start+x]=(scan[start+x]+(filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner)))&255;
    }
    if(channels===4)output.set(scan.subarray(start,start+stride),y*stride);
    else for(let x=0;x<width;x++){const a=start+x*3,b=(y*width+x)*4;output[b]=scan[a];output[b+1]=scan[a+1];output[b+2]=scan[a+2];output[b+3]=255;}
  }
  return {width,height,pixels:output};
}
