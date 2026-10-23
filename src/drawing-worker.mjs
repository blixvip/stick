import {errorMessageData} from './localized-error.mjs';
import {materializeDrawingTiles} from './drawing-preparation.mjs';

// Preparing a commit needs only the tile kernel. Load codecs, brush/fill and
// preview machinery on their first request, in the same bounded worker.
self.onmessage=async({data})=>{
  if(data.kind==='prepare-tiles'){
    try{
      const tiles=materializeDrawingTiles(data.tiles);
      self.postMessage({id:data.id,tiles},tiles.flatMap(t=>t.pixels?[t.pixels]:[]));
    }catch(error){self.postMessage({id:data.id,error:error.message, ...errorMessageData(error)});}
    return;
  }
  if(data.kind==='preview'){
    let preview;
    try{preview=await import('./drawing-worker-preview.mjs');}
    catch(error){self.postMessage({id:data.id,error:error.message, ...errorMessageData(error),fatal:true});return;}
    try{const bitmap=preview.drawingWorkerPreview(data);self.postMessage({id:data.id,bitmap},[bitmap]);}
    catch(error){self.postMessage({id:data.id,error:error.message, ...errorMessageData(error)});}
    return;
  }
  let operations;
  try{operations=await import('./drawing-worker-operations.mjs');}
  catch(error){self.postMessage({id:data.id,error:error.message, ...errorMessageData(error),fatal:true});return;}
  await operations.drawingWorkerOperation(data);
};
