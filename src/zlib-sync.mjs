import {messageError} from './localized-error.mjs';
/** Small synchronous zlib (RFC 1950/1951) for drawing tiles. Per-tile
 * CompressionStream/DecompressionStream calls cost about a millisecond of
 * stream overhead each; tiles are 16 KB, so a synchronous codec is an order
 * of magnitude faster. deflateZlib emits one LZ77 + dynamic-Huffman block; inflateZlib reads stored, fixed and dynamic blocks,
 * validates the Adler-32 checksum and never grows past `limit` bytes. */

const LENGTH_BASE=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LENGTH_EXTRA=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DIST_BASE=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const reverse=(code,bits)=>{let r=0;for(let i=0;i<bits;i++){r=(r<<1)|(code&1);code>>>=1;}return r;};

// Fixed literal/length codes, bit-reversed for an LSB-first writer.
const FIXED_CODE=new Uint16Array(288),FIXED_BITS=new Uint8Array(288);
for(let v=0;v<288;v++){
  let code,bits;
  if(v<144){code=0x30+v;bits=8;}else if(v<256){code=0x190+v-144;bits=9;}else if(v<280){code=v-256;bits=7;}else{code=0xc0+v-280;bits=8;}
  FIXED_CODE[v]=reverse(code,bits);FIXED_BITS[v]=bits;
}
const DIST_CODE=Uint8Array.from({length:30},(_,d)=>reverse(d,5));
// Length (3..258) → symbol index into LENGTH_BASE; distance → code via lookup.
const LENGTH_SYMBOL=new Uint8Array(259);
for(let s=0;s<29;s++)for(let l=LENGTH_BASE[s];l<(s<28?LENGTH_BASE[s+1]:259);l++)LENGTH_SYMBOL[l]=s;
LENGTH_SYMBOL[258]=28;
const distSymbol=d=>{let lo=0,hi=29;while(lo<hi){const mid=(lo+hi+1)>>1;if(DIST_BASE[mid]<=d)lo=mid;else hi=mid-1;}return lo;};

const CL_ORDER=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
export function adler32(bytes){let a=1,b=0;for(let i=0;i<bytes.length;){const end=Math.min(bytes.length,i+5552);for(;i<end;i++){a+=bytes[i];b+=a;}a%=65521;b%=65521;}return ((b<<16)|a)>>>0;}

/** Huffman code lengths for `freq`, limited to `limit` bits. At least two
 * symbols always get codes so every inflater accepts the tree as complete. */
function codeLengths(freq,limit){
  const n=freq.length,lengths=new Uint8Array(n),weights=Array.from(freq);
  let used=0;for(const w of weights)if(w)used++;
  for(let s=0;used<2&&s<n;s++)if(!weights[s]){weights[s]=1;used++;}
  for(;;){
    const leaves=[];for(let s=0;s<n;s++)if(weights[s])leaves.push(s);
    leaves.sort((a,b)=>weights[a]-weights[b]||a-b);
    // Two-queue Huffman: leaves ascending, internal nodes in creation order.
    const count=leaves.length,parent=new Int32Array(2*count),weight=new Float64Array(2*count);
    for(let i=0;i<count;i++)weight[i]=weights[leaves[i]];
    let li=0,ii=count,next=count;
    const take=()=>{if(li<count&&(ii>=next||weight[li]<=weight[ii]))return li++;return ii++;};
    while(next<2*count-1){const a=take(),b=take();weight[next]=weight[a]+weight[b];parent[a]=parent[b]=next;next++;}
    const depth=new Uint8Array(2*count);let max=0;
    for(let i=2*count-3;i>=0;i--){depth[i]=depth[parent[i]]+1;}
    for(let i=0;i<count;i++){lengths[leaves[i]]=depth[i];if(depth[i]>max)max=depth[i];}
    if(max<=limit)return lengths;
    lengths.fill(0);for(let s=0;s<n;s++)if(weights[s])weights[s]=Math.max(1,weights[s]>>1);
  }
}
/** Canonical codes for lengths, bit-reversed for an LSB-first writer. */
function canonical(lengths){
  const counts=new Uint16Array(16),next=new Uint16Array(16),codes=new Uint16Array(lengths.length);
  for(const l of lengths)if(l)counts[l]++;
  let code=0;for(let l=1;l<16;l++){code=(code+counts[l-1])<<1;next[l]=code;}
  for(let s=0;s<lengths.length;s++){const l=lengths[s];if(l)codes[s]=reverse(next[l]++,l);}
  return codes;
}

/** zlib-wrapped deflate: greedy LZ77 (32 KiB window) and one dynamic-Huffman
 * block with length-limited codes, so output is compact and fast to make. */
export function deflateZlib(input){
  const n=input.length,litLen=new Uint16Array(n+1),dists=new Uint16Array(n+1),litFreq=new Uint32Array(286),distFreq=new Uint32Array(30);let tokens=0;
  const HASH=1<<15,MASK=HASH-1,head=new Int32Array(HASH).fill(-1),prev=new Int32Array(Math.max(1,n));
  // Longest match at i within the window, from the hash chain (chain-limited).
  let matchDist=0;
  const longest=i=>{
    if(i+2>=n)return 0;
    const h=((input[i]<<10)^(input[i+1]<<5)^input[i+2])&MASK;let candidate=head[h],chain=24,best=0;const max=n-i<258?n-i:258;
    while(candidate>=0&&i-candidate<=32768&&chain-->0){
      if(input[candidate+best]===input[i+best]&&input[candidate]===input[i]){let l=1;while(l<max&&input[candidate+l]===input[i+l])l++;if(l>best){best=l;matchDist=i-candidate;if(l>=max||l>=128)break;}}
      candidate=prev[candidate];
    }
    return best;
  };
  const insert=k=>{if(k+2>=n)return;const h=((input[k]<<10)^(input[k+1]<<5)^input[k+2])&MASK;prev[k]=head[h];head[h]=k;};
  const literal=v=>{litLen[tokens]=v;dists[tokens++]=0;litFreq[v]++;};
  for(let i=0;i<n;){
    const bestLen=longest(i),bestDist=matchDist;insert(i);
    if(bestLen>=3){
      litLen[tokens]=256+bestLen;dists[tokens++]=bestDist;litFreq[257+LENGTH_SYMBOL[bestLen]]++;distFreq[distSymbol(bestDist)]++;
      // Index the start of long matches only: runs stay fast to compress.
      const stop=Math.min(i+bestLen,i+16);for(let k=i+1;k<stop;k++)insert(k);
      i+=bestLen;
    }else{literal(input[i]);i++;}
  }
  litFreq[256]=1;
  const lLen=codeLengths(litFreq,15),dLen=codeLengths(distFreq,15),lCode=canonical(lLen),dCode=canonical(dLen);
  let hlit=286;while(hlit>257&&!lLen[hlit-1])hlit--;let hdist=30;while(hdist>1&&!dLen[hdist-1])hdist--;
  // Run-length code the two length tables with symbols 16/17/18.
  const all=[...lLen.subarray(0,hlit),...dLen.subarray(0,hdist)],rle=[],clFreq=new Uint32Array(19);
  for(let i=0;i<all.length;){
    const v=all[i];let run=1;while(i+run<all.length&&all[i+run]===v)run++;
    if(v===0&&run>=3){const r=Math.min(run,138);rle.push(r>=11?[18,r-11]:[17,r-3]);clFreq[r>=11?18:17]++;i+=r;continue;}
    rle.push([v,0]);clFreq[v]++;i++;run--;
    while(run>=3){const r=Math.min(run,6);rle.push([16,r-3]);clFreq[16]++;i+=r;run-=r;}
  }
  const cLen=codeLengths(clFreq,7),cCode=canonical(cLen);let hclen=19;while(hclen>4&&!cLen[CL_ORDER[hclen-1]])hclen--;
  let buf=new Uint8Array(Math.max(256,(n>>1)+1024)),pos=0,bitBuf=0,bitCount=0;
  const put=(value,bits)=>{bitBuf|=value<<bitCount;bitCount+=bits;while(bitCount>=8){if(pos>=buf.length){const next=new Uint8Array(buf.length*2);next.set(buf);buf=next;}buf[pos++]=bitBuf&255;bitBuf>>>=8;bitCount-=8;}};
  buf[pos++]=0x78;buf[pos++]=0x01;
  put(1,1);put(2,2);put(hlit-257,5);put(hdist-1,5);put(hclen-4,4);
  for(let i=0;i<hclen;i++)put(cLen[CL_ORDER[i]],3);
  for(const [sym,extra] of rle){put(cCode[sym],cLen[sym]);if(sym===16)put(extra,2);else if(sym===17)put(extra,3);else if(sym===18)put(extra,7);}
  for(let t=0;t<tokens;t++){
    const v=litLen[t];
    if(v<256){put(lCode[v],lLen[v]);continue;}
    const len=v-256,s=LENGTH_SYMBOL[len];put(lCode[257+s],lLen[257+s]);if(LENGTH_EXTRA[s])put(len-LENGTH_BASE[s],LENGTH_EXTRA[s]);
    const dist=dists[t],d=distSymbol(dist);put(dCode[d],dLen[d]);if(DIST_EXTRA[d])put(dist-DIST_BASE[d],DIST_EXTRA[d]);
  }
  put(lCode[256],lLen[256]);if(bitCount>0)put(0,8-bitCount);
  const sum=adler32(input);if(pos+4>buf.length){const next=new Uint8Array(pos+4);next.set(buf);buf=next;}
  buf[pos++]=sum>>>24;buf[pos++]=(sum>>>16)&255;buf[pos++]=(sum>>>8)&255;buf[pos++]=sum&255;
  return buf.slice(0,pos);
}

const FAST=9;
/** Canonical Huffman decode table: counts per length and symbols by code,
 * plus a FAST-bit lookup (symbol<<4 | length) for codes up to FAST bits. */
function huffman(lengths){
  const counts=new Uint16Array(16),offsets=new Uint16Array(16),symbols=new Uint16Array(lengths.length);
  for(const l of lengths)counts[l]++;counts[0]=0;
  let left=1;for(let l=1;l<16;l++){left<<=1;left-=counts[l];if(left<0)throw messageError(new Error(''), "errors.zlibSync.invalidDeflateHuffmanTable", {});}
  for(let l=1;l<15;l++)offsets[l+1]=offsets[l]+counts[l];
  for(let s=0;s<lengths.length;s++)if(lengths[s])symbols[offsets[lengths[s]]++]=s;
  const fast=new Int32Array(1<<FAST).fill(-1),next=new Uint16Array(16);let code=0;
  for(let l=1;l<16;l++){code=(code+counts[l-1])<<1;next[l]=code;}
  for(let s=0;s<lengths.length;s++){const l=lengths[s];if(!l)continue;const c=next[l]++;if(l>FAST)continue;for(let j=reverse(c,l);j<1<<FAST;j+=1<<l)fast[j]=(s<<4)|l;}
  return {counts,symbols,fast};
}
const FIXED_LIT=huffman(Array.from({length:288},(_,v)=>v<144?8:v<256?9:v<280?7:8)),FIXED_DIST=huffman(new Array(30).fill(5));

/** Inflate a zlib stream. `expected`, when given, must match the output size
 * exactly; `limit` bounds allocation for untrusted input. */
export function inflateZlib(data,{expected,limit=64*1024*1024}={}){
  if(data.length<6||(data[0]&15)!==8||((data[0]<<8)|data[1])%31||data[1]&32)throw messageError(new Error(''), "errors.zlibSync.invalidZlibHeader", {});
  let pos=2,bitBuf=0,bitCount=0,out=new Uint8Array(expected??Math.min(limit,Math.max(1024,data.length*4))),len=0;
  const need=n=>{while(bitCount<n){if(pos>=data.length)throw messageError(new Error(''), "errors.zlibSync.truncatedDeflateStream", {});bitBuf|=data[pos++]<<bitCount;bitCount+=8;}};
  const bits=n=>{if(!n)return 0;need(n);const v=bitBuf&((1<<n)-1);bitBuf>>>=n;bitCount-=n;return v;};
  const ensure=n=>{if(len+n<=out.length)return;if(expected!==undefined||len+n>limit)throw messageError(new Error(''), "errors.zlibSync.deflateStreamExpandsBeyondItsBound", {});let size=out.length*2;while(size<len+n)size*=2;const next=new Uint8Array(Math.min(limit,size));next.set(out.subarray(0,len));out=next;};
  // Peeking past the deflate data reads into the Adler-32 trailer, which always
  // follows; pre-fetched whole bytes are handed back before reading it.
  const fill=()=>{while(bitCount<=24){bitBuf|=(pos<data.length?data[pos]:0)<<bitCount;pos++;bitCount+=8;}};
  const decode=table=>{
    if(bitCount<FAST)fill();
    const hit=table.fast[bitBuf&((1<<FAST)-1)];
    if(hit>=0){const l=hit&15;bitBuf>>>=l;bitCount-=l;if(pos-(bitCount>>3)>data.length)throw messageError(new Error(''), "errors.zlibSync.truncatedDeflateStream", {});return hit>>4;}
    const {counts,symbols}=table;let code=0,first=0,index=0;
    for(let l=1;l<16;l++){code|=bits(1);const count=counts[l];if(code-count<first)return symbols[index+(code-first)];index+=count;first+=count;first<<=1;code<<=1;}
    throw messageError(new Error(''), "errors.zlibSync.invalidDeflateCode", {});
  };
  for(let final=0;!final;){
    final=bits(1);const type=bits(2);
    if(type===0){
      pos-=bitCount>>3;bitBuf=0;bitCount=0;if(pos+4>data.length)throw messageError(new Error(''), "errors.zlibSync.truncatedStoredBlock", {});
      const n=data[pos]|(data[pos+1]<<8),nn=data[pos+2]|(data[pos+3]<<8);pos+=4;if((n^0xffff)!==nn)throw messageError(new Error(''), "errors.zlibSync.invalidStoredBlockLength", {});
      if(pos+n>data.length)throw messageError(new Error(''), "errors.zlibSync.truncatedStoredBlock", {});ensure(n);out.set(data.subarray(pos,pos+n),len);len+=n;pos+=n;continue;
    }
    let lit,dist;
    if(type===1){lit=FIXED_LIT;dist=FIXED_DIST;}
    else if(type===2){
      const hlit=bits(5)+257,hdist=bits(5)+1,hclen=bits(4)+4,cl=new Array(19).fill(0);
      for(let i=0;i<hclen;i++)cl[CL_ORDER[i]]=bits(3);
      const clTable=huffman(cl),lengths=[];
      while(lengths.length<hlit+hdist){
        const sym=decode(clTable);
        if(sym<16)lengths.push(sym);
        else if(sym===16){if(!lengths.length)throw messageError(new Error(''), "errors.zlibSync.invalidDeflateRepeat", {});const r=3+bits(2),v=lengths.at(-1);for(let i=0;i<r;i++)lengths.push(v);}
        else{const r=sym===17?3+bits(3):11+bits(7);for(let i=0;i<r;i++)lengths.push(0);}
      }
      if(lengths.length>hlit+hdist)throw messageError(new Error(''), "errors.zlibSync.invalidDeflateCodeLengths", {});
      lit=huffman(lengths.slice(0,hlit));dist=huffman(lengths.slice(hlit));
    }else throw messageError(new Error(''), "errors.zlibSync.invalidDeflateBlockType", {});
    for(;;){
      const sym=decode(lit);
      if(sym<256){ensure(1);out[len++]=sym;continue;}
      if(sym===256)break;
      const s=sym-257;if(s>=29)throw messageError(new Error(''), "errors.zlibSync.invalidDeflateLength", {});
      const length=LENGTH_BASE[s]+bits(LENGTH_EXTRA[s]),d=decode(dist);if(d>=30)throw messageError(new Error(''), "errors.zlibSync.invalidDeflateDistance", {});
      const distance=DIST_BASE[d]+bits(DIST_EXTRA[d]);if(distance>len)throw messageError(new Error(''), "errors.zlibSync.deflateDistanceExceedsOutput", {});
      ensure(length);for(let k=0;k<length;k++,len++)out[len]=out[len-distance];
    }
  }
  pos-=bitCount>>3;bitBuf=0;bitCount=0;
  if(pos+4>data.length)throw messageError(new Error(''), "errors.zlibSync.missingZlibChecksum", {});
  const sum=((data[pos]<<24)|(data[pos+1]<<16)|(data[pos+2]<<8)|data[pos+3])>>>0;
  const result=len===out.length?out:out.slice(0,len);
  if(adler32(result)!==sum)throw messageError(new Error(''), "errors.zlibSync.zlibChecksumMismatch", {});
  if(expected!==undefined&&len!==expected)throw messageError(new Error(''), "errors.zlibSync.deflateStreamSizeMismatch", {});
  return result;
}
