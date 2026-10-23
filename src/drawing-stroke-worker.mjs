import {errorMessageData} from './localized-error.mjs';
import {StrokeEngine} from './drawing-stroke-engine.mjs';

const engine=new StrokeEngine();

self.onmessage=({data})=>{
  const {kind,stroke:id}=data;
  try{
    if(kind==='begin')engine.begin(id,data.settings);
    else if(kind==='dabs'){
      const result=engine.dabs(id,data.seq,data.dabs,data.tiles,data.tail);
      if(result)self.postMessage({kind:'tiles',stroke:id,seq:data.seq,tiles:result.tiles,dirty:result.dirty},result.tiles.map(t=>t.pixels));
    }
    else if(kind==='end'){
      const changes=engine.end(id);
      self.postMessage({kind:'done',stroke:id,changes:changes??[]},(changes??[]).flatMap(c=>[c.before?.buffer,c.after?.buffer].filter(Boolean)));
    }
    else if(kind==='cancel')engine.cancel(id);
  }catch(error){engine.cancel(id);self.postMessage({kind:'error',stroke:id,message:error.message, ...errorMessageData(error)});}
};
