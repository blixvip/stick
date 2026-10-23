import {errorMessageData} from './localized-error.mjs';
import {applyDocumentChunk} from './document-transport.mjs';
import {sampleMotionBake} from './camera-motion-bake.mjs';
let report;
self.onmessage=async({data})=>{
  try{
    if(data.type==='chunk'){report=applyDocumentChunk(report,data.chunk);postMessage({type:'ack'});}
    else if(data.type==='bake'){
      const frames=await sampleMotionBake(report,data),values=new Float64Array(frames.length*8);
      frames.forEach(({tick,camera:c,restore},i)=>values.set([tick,c.x,c.y,c.scale,c.angle_rad,c._parallaxMotionOffset.x,c._parallaxMotionOffset.y,Number(restore)],i*8));
      postMessage({type:'done',values},[values.buffer]);report=null;
    }
  }catch(error){postMessage({type:'error',message:error.message, ...errorMessageData(error)});report=null;}
};
