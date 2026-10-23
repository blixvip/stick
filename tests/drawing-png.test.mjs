import {encodePNGPortable} from '../src/sticknodes/decoder/png-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rawPNG} from './preview-png-fixture.mjs';
import {crc32} from '../src/sticknodes/decoder/archive.mjs';
import {drawingPNGBytes,drawingPNGDataURL,decodeDrawingPNGBytes} from '../src/drawing-png.mjs';

function chunk(type,bytes){const result=Buffer.alloc(bytes.length+12);result.writeUInt32BE(bytes.length);result.write(type,4);result.set(bytes,8);result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;}
function splitData(png,{size=1,corrupt=false}={}){
  const parts=[png.subarray(0,8)];
  for(let pos=8;pos<png.length;){const length=png.readUInt32BE(pos),end=pos+length+12,type=png.toString('ascii',pos+4,pos+8);
    if(type==='IDAT'){
      const bytes=Buffer.from(png.subarray(pos+8,end-4));if(corrupt)bytes[bytes.length-1]^=255;
      for(let offset=0;offset<bytes.length;offset+=size)parts.push(chunk('IDAT',bytes.subarray(offset,offset+size)));
    }else parts.push(png.subarray(pos,end));pos=end;
  }
  return Buffer.concat(parts);
}
function filteredPNG(channels,filters,width=19){
  const height=filters.length,stride=width*channels,source=Uint8Array.from({length:height*stride},(_,i)=>(i*31+Math.floor(i/7)*17)%256),raw=Buffer.alloc(height*(stride+1));
  for(let y=0;y<height;y++){
    const filter=filters[y];raw[y*(stride+1)]=filter;
    for(let x=0;x<stride;x++){
      const i=y*stride+x,a=x>=channels?source[i-channels]:0,b=y?source[i-stride]:0,c=y&&x>=channels?source[i-stride-channels]:0;
      const prediction=a+b-c,distances=[a,b,c].map(n=>Math.abs(prediction-n)),p=[a,b,c][distances.indexOf(Math.min(...distances))];
      raw[y*(stride+1)+x+1]=(source[i]-[0,a,b,Math.floor((a+b)/2),p][filter]+256)%256;
    }
  }
  const expected=channels===4?new Uint8ClampedArray(source):Uint8ClampedArray.from({length:width*height*4},(_,i)=>i%4===3?255:source[Math.floor(i/4)*3+i%4]);
  return {png:rawPNG({width,height,color:channels===4?6:2,raw}),expected,width,height};
}

test('drawing PNG filters preserve every channel, including hidden RGB and alpha 1',async()=>{
  for(const channels of [3,4])for(const first of [0,1,2,3,4]){
    const {png,expected,width,height}=filteredPNG(channels,[first,4,0,1,2,3,4,0]),original=Buffer.from(png);
    const decoded=await decodeDrawingPNGBytes(png,{width,height});assert.deepEqual(decoded.pixels,expected);
    assert.deepEqual(await decodeDrawingPNGBytes(splitData(png)),decoded,'arbitrary IDAT boundaries preserve exact pixels');
    assert.deepEqual(png,original,'decoding does not mutate the encoded input');
  }
});

test('direct inflation rejects oversized, short and corrupt streams and settles writers',async()=>{
  const valid=filteredPNG(4,[0,1,2,3,4]),errors=[];
  const unhandled=error=>errors.push(error);process.on('unhandledRejection',unhandled);
  try{
    for(let repeat=0;repeat<3;repeat++){
      await assert.rejects(decodeDrawingPNGBytes(rawPNG({width:1,height:1,raw:Buffer.alloc(2*1024*1024)})),/expands beyond/);
      await assert.rejects(decodeDrawingPNGBytes(rawPNG({width:64,height:64,raw:Buffer.alloc(5)})),/incomplete/);
      await assert.rejects(decodeDrawingPNGBytes(splitData(valid.png,{size:7,corrupt:true})));
      await assert.rejects(decodeDrawingPNGBytes(rawPNG({width:1,height:1,raw:Buffer.from([5,1,2,3,4])})),/filter/);
    }
    assert.deepEqual((await decodeDrawingPNGBytes(valid.png)).pixels,valid.expected);
    await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(errors,[]);
  }finally{process.removeListener('unhandledRejection',unhandled);}
});

test('producer errors reject decoding even when the readable stream closes normally',async()=>{
  const Native=globalThis.DecompressionStream,expected=Error('Injected writer failure');let instance;
  globalThis.DecompressionStream=class{
    constructor(){instance=this;}
    readable=new ReadableStream({start(controller){controller.close();}});
    writable=new WritableStream({write(){throw expected;}});
  };
  const large=await encodePNGPortable({width:1024,height:512,channels:4},new Uint8ClampedArray(1024*512*4));
  try{await assert.rejects(decodeDrawingPNGBytes(large),error=>error===expected);}
  finally{globalThis.DecompressionStream=Native;}
  assert.equal(instance.readable.locked,false);assert.equal(instance.writable.locked,false);
});

test('embedded PNG base64 uses native bytes when available and exact portable fallback',t=>{
  const bytes=Uint8Array.from({length:8194},(_,i)=>i%256),url=drawingPNGDataURL(bytes);
  const descriptor=Object.getOwnPropertyDescriptor(Uint8Array,'fromBase64');
  t.after(()=>{if(descriptor)Object.defineProperty(Uint8Array,'fromBase64',descriptor);else delete Uint8Array.fromBase64;});
  assert.deepEqual(drawingPNGBytes(url),bytes);assert.deepEqual(drawingPNGBytes(url.replace(/=+$/,'')),bytes);
  Object.defineProperty(Uint8Array,'fromBase64',{configurable:true,value:undefined});assert.deepEqual(drawingPNGBytes(url),bytes);
  assert.throws(()=>drawingPNGBytes('data:image/jpeg;base64,AAAA'),/PNG/);assert.throws(()=>drawingPNGBytes('data:image/png;base64,!'));
});
