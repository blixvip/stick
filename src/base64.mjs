/** Binary transport helpers shared by document containers and drawing tiles.
 * Callers own their format/size validation before decoding untrusted payloads. */
export function bytesToBase64(bytes){
  let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return btoa(text);
}
export function base64ToBytes(text){
  if(typeof Uint8Array.fromBase64==='function')return Uint8Array.fromBase64(text);
  const binary=atob(text),bytes=new Uint8Array(binary.length);for(let i=0;i<bytes.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;
}
