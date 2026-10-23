import test from 'node:test';
import assert from 'node:assert/strict';
import {packNumbers,unpackNumbers} from '../scripts/playback-transfer-numbers.mjs';

test('benchmark numeric packing preserves values, aliasing, sparse arrays and opaque typed views',()=>{
  const values=Array.from({length:40},(_,index)=>index/7);
  values.splice(0,4,-0,NaN,Infinity,-Infinity);
  const sparse=new Array(40);sparse[5]=7;sparse.extra='retained';
  const typed=new Float64Array([2,3]);
  const input={values,alias:values,sparse,typed};
  Object.defineProperty(input,'__proto__',{value:{retained:true},enumerable:true});
  const before=structuredClone(input),packed=packNumbers(input),result=unpackNumbers(structuredClone(packed));
  assert.deepEqual(result,before);assert.deepEqual(input,before);
  assert.equal(result.values,result.alias);assert.ok(Object.is(result.values[0],-0));
  assert.ok(!Object.hasOwn(result.sparse,0));assert.equal(result.sparse.extra,'retained');
  assert.ok(result.typed instanceof Float64Array);assert.ok(Object.hasOwn(result,'__proto__'));
  assert.equal(packed.numericBytes,40*8);
});
