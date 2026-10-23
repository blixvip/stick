import {restoreMessageError, messageError} from './localized-error.mjs';

import {documentChunks} from './document-transport.mjs';
import {cameraSamplingReport,sampleMotionBake} from './camera-motion-bake.mjs';
const abort=()=>messageError(new DOMException('', 'AbortError'), "errors.cameraMotionBakeClient.cameraBakeCancelled", {});
/** One short-lived worker, acknowledged camera snapshot chunks, one bounded typed
 * result. Only followed figures cross this boundary; other artwork and media do not. */
export async function prepareCameraBake(report,options){
  if(typeof Worker==='undefined')return sampleMotionBake(report,options);
  const worker=new Worker(new URL('./camera-motion-bake-worker.mjs',import.meta.url),{type:'module'}),{signal}=options;
  let pending;
  const cancelled=()=>{pending?.reject(abort());worker.terminate();};
  worker.onmessage=({data})=>{if(data.type==='error')pending?.reject(restoreMessageError(new Error(data.message), data));else pending?.resolve(data);pending=null;};
  worker.onerror=event=>{pending?.reject((event.message ? new Error(event.message) : messageError(new Error(''), "errors.cameraMotionBakeClient.cameraBakeWorkerFailed")));pending=null;};
  const send=message=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(abort());return;}pending={resolve,reject};worker.postMessage(message);});
  signal?.addEventListener('abort',cancelled,{once:true});
  try{
    const source=cameraSamplingReport(report);
    for(const chunk of documentChunks(source,{maxBytes:64*1024,maxRecords:128,timeBudgetMs:3})){await send({type:'chunk',chunk});await new Promise(resolve=>setTimeout(resolve,0));}
    const {values}=await send({type:'bake',start:options.start,end:options.end});const frames=[];
    for(let i=0;i<values.length;i+=8){if(signal?.aborted)throw abort();frames.push({tick:values[i],restore:Boolean(values[i+7]),camera:{is_default:false,x:values[i+1],y:values[i+2],scale:values[i+3],angle_rad:values[i+4],_parallaxMotionOffset:{x:values[i+5],y:values[i+6]}}});if(i%4096===0)await new Promise(resolve=>setTimeout(resolve,0));}
    return frames;
  }finally{signal?.removeEventListener('abort',cancelled);worker.terminate();}
}
