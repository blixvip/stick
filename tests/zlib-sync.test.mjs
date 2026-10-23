import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {deflateZlib,inflateZlib,adler32} from '../src/zlib-sync.mjs';
import {encodeRGBAPNG,decodeDrawingPNGBytes} from '../src/drawing-png.mjs';
import {encodeTile} from '../src/drawing-tile-codec.mjs';

let seed=11;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
const sample=k=>{const n=Math.floor(rnd()*40000),a=new Uint8Array(n),mode=k%5;
  for(let i=0;i<n;i++)a[i]=mode===0?Math.floor(rnd()*256):mode===1?(i%4===3?255:40+(i>>9)%3):mode===2?(rnd()<.9&&i>4?a[i-4]:Math.floor(rnd()*256)):mode===3?0:Math.floor(Math.sin(i/37)*60+rnd()*6)&255;return a;};

test('deflateZlib output inflates with zlib and inflateZlib reads every zlib level',()=>{
  for(let k=0;k<120;k++){
    const data=sample(k),ours=deflateZlib(data);
    assert.deepEqual(new Uint8Array(zlib.inflateSync(ours)),data);
    assert.deepEqual(inflateZlib(ours),data);
    for(const level of [0,1,6,9])assert.deepEqual(inflateZlib(zlib.deflateSync(data,{level}),{expected:data.length}),data);
  }
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')),0x11e60398);
});

test('inflateZlib rejects corrupt, truncated and oversized streams',()=>{
  let rejected=0;
  for(let k=0;k<150;k++){
    const data=sample(k+3);if(data.length<16)continue;const z=Buffer.from(zlib.deflateSync(data));
    z[2+Math.floor(rnd()*(z.length-6))]^=1<<Math.floor(rnd()*8);
    try{assert.deepEqual(inflateZlib(z,{limit:1<<20}),data);}catch(error){if(error.code==='ERR_ASSERTION')throw error;rejected++;}
  }
  assert.ok(rejected>50);
  const z=zlib.deflateSync(new Uint8Array(5000));
  assert.throws(()=>inflateZlib(z.subarray(0,z.length-5)),/Truncated|checksum/);
  assert.throws(()=>inflateZlib(z,{expected:100}),/bound/);
  assert.throws(()=>inflateZlib(z,{limit:1000}),/bound/);
});

test('fast tile PNGs round-trip exactly through every row filter',async()=>{
  const tile=new Uint8ClampedArray(64*64*4);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=(y*64+x)*4;
    // Rows exercise None (noise), Sub (horizontal ramps) and Up (vertical ramps).
    if(y<20)tile.set([Math.floor(rnd()*256),Math.floor(rnd()*256),Math.floor(rnd()*256),Math.floor(rnd()*256)],i);
    else if(y<40)tile.set([x*4,x*2,255-x*3,x*4],i);else tile.set([y*3,40,y*2,200],i);}
  const png=encodeRGBAPNG(tile,64,64),decoded=await decodeDrawingPNGBytes(png);
  assert.deepEqual(decoded.pixels,tile);
  const filters=new Set();const idat=zlib.inflateSync(Buffer.from(png.subarray(33+8,png.length-12-4)));for(let y=0;y<64;y++)filters.add(idat[y*257]);
  assert.ok(filters.size>=2,'rows choose different filters');
  // Uniform tiles reuse one encoding per colour and stay exact.
  const flat=new Uint8ClampedArray(64*64*4);for(let i=0;i<flat.length;i+=4)flat.set([10,20,30,40],i);
  const a=encodeTile(flat),b=encodeTile(flat);assert.deepEqual(a,b);assert.notEqual(a,b,'callers get their own copy');
  assert.deepEqual((await decodeDrawingPNGBytes(a)).pixels,flat);
  assert.ok(a.length<400,'a uniform tile compresses to a few hundred bytes');
});
