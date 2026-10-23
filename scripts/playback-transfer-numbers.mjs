/** Benchmark-only numeric-array experiment; not imported by production. */
const ownSet=(target,key,value)=>Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});

export function packNumbers(chunk){
  const result={},arrays=[],seen=new WeakMap(),stack=[{value:chunk,parent:result,key:'chunk'}];
  let numericBytes=0;
  while(stack.length){
    const {value,parent,key}=stack.pop();
    if(value===null||typeof value!=='object'){ownSet(parent,key,value);continue;}
    if(seen.has(value)){ownSet(parent,key,seen.get(value));continue;}
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(!array&&prototype!==Object.prototype&&prototype!==null){ownSet(parent,key,value);continue;}
    const keys=Object.keys(value);
    if(array&&value.length>=32&&keys.length===value.length&&keys.every((key,index)=>key===String(index)&&typeof value[index]==='number')){
      const packed=Float64Array.from(value);seen.set(value,packed);arrays.push(packed);numericBytes+=packed.byteLength;
      ownSet(parent,key,packed);continue;
    }
    const copy=array?new Array(value.length):{};seen.set(value,copy);ownSet(parent,key,copy);
    for(let i=keys.length-1;i>=0;i--)stack.push({value:value[keys[i]],parent:copy,key:keys[i]});
  }
  return {...result,arrays,numericBytes};
}

export function unpackNumbers(message){
  const arrays=new Set(message.arrays),seen=new WeakSet(),decoded=new Map(),root={chunk:message.chunk};
  const stack=[{parent:root,key:'chunk'}];
  while(stack.length){
    const {parent,key}=stack.pop(),value=parent[key];
    if(arrays.has(value)){
      if(!decoded.has(value))decoded.set(value,Array.from(value));
      ownSet(parent,key,decoded.get(value));continue;
    }
    if(value===null||typeof value!=='object'||seen.has(value)||ArrayBuffer.isView(value))continue;
    seen.add(value);
    for(const key of Object.keys(value))stack.push({parent:value,key});
  }
  return root.chunk;
}
