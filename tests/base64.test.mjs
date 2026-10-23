import test from 'node:test';
import assert from 'node:assert/strict';
import {base64ToBytes,bytesToBase64} from '../src/base64.mjs';

test('binary transport matches standard base64 at padding and chunk boundaries',t=>{
  const descriptor=Object.getOwnPropertyDescriptor(Uint8Array,'fromBase64');
  t.after(()=>{if(descriptor)Object.defineProperty(Uint8Array,'fromBase64',descriptor);else delete Uint8Array.fromBase64;});
  for(const fallback of [false,true]){
    if(fallback)Object.defineProperty(Uint8Array,'fromBase64',{configurable:true,value:undefined});
    for(const length of [0,1,2,3,32767,32768,32769,65539]){
      const source=Uint8Array.from({length:length+6},(_,i)=>(i*31)%256).subarray(3,3+length),encoded=bytesToBase64(source);
      assert.equal(encoded,Buffer.from(source).toString('base64'));assert.deepEqual(base64ToBytes(encoded),source);
      assert.deepEqual(base64ToBytes(encoded.replace(/=+$/,'')),source);assert.deepEqual(base64ToBytes(encoded.replace(/.{24}/g,'$&\n')),source);
    }
    for(const invalid of ['!', 'a', 'a===', 'abcd=abc', 'ab_c', 'ab-c'])assert.throws(()=>base64ToBytes(invalid));
  }
});
