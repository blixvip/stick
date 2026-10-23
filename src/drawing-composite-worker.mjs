import {errorMessageData, messageError} from './localized-error.mjs';

import {applyDocumentChunk} from './document-transport.mjs';
import {captureDrawingComposite} from './drawing-composite.mjs';

let snapshot=null,bytes=0,previewActive=false;
self.onmessage=async({data})=>{
  let bitmap;
  try{
    if(previewActive)throw messageError(new Error(''), "errors.rasterSurfaces.aRasterScratchSurfaceCannotBeUsedConcurrently", {});
    if(data.kind==='composite-chunk'){
      if(data.chunk.header){snapshot=null;bytes=0;}
      bytes+=data.chunk.estimatedBytes??64;
      if(bytes>data.maxBytes)throw messageError(new Error(''), "errors.drawingCompositeTransport.theFillExceedsTheDrawingWorkingMemoryLimit", {});
      snapshot=applyDocumentChunk(snapshot,data.chunk);
      self.postMessage({id:data.id});return;
    }
    if(data.kind==='preview-warm'){
      // Module loading only: no snapshot, scratch surface or resource owner.
      await Promise.all([import('./renderer-raster-capture.mjs'),import('./renderer-preview-drawing-resources.mjs'),import('./drawing-composite-transport.mjs'),import('./playback-resources.mjs')]);
      self.postMessage({id:data.id});return;
    }
    if((data.kind==='preview-raster'||data.kind==='preview-raster-plan')&&snapshot){
      const source=snapshot,snapshotBytes=bytes;snapshot=null;bytes=0;previewActive=true;
      try{
        const [{capturePreviewRaster,planPreviewRaster,planPreviewRasterResources},{drawingPreviewPlan,preparePreviewDrawings},{restoreDrawingComposite}]=await Promise.all([
          import('./renderer-raster-capture.mjs'),import('./renderer-preview-drawing-resources.mjs'),import('./drawing-composite-transport.mjs'),
        ]);
        const geometry=source.drawables?source:restoreDrawingComposite(source),drawingPlan=drawingPreviewPlan(geometry.drawables);
        const options={...data,snapshotBytes,resourceBytes:drawingPlan.bytes};
        if(data.kind==='preview-raster-plan'){
          if(data.scene===undefined&&(data.nativePadding!==true||geometry.drawables.length!==1||geometry.drawables[0].type!=='image'))throw messageError(new Error(''), 'errors.drawingComposite.invalidDrawingCompositeBounds', {});
          const plan=planPreviewRasterResources(geometry,{...options,allowDrawings:true});
          snapshot=geometry;bytes=snapshotBytes;
          self.postMessage({id:data.id,requiredBytes:plan.workingBytes});return;
        }
        planPreviewRaster(geometry,{...options,allowDrawings:drawingPlan.figures.length>0});
        let resources,result;
        try{
          resources=await preparePreviewDrawings(drawingPlan,{maxBytes:data.maxBytes});
          if(data.scene!==undefined&&!resources){
            const {PlaybackResources}=await import('./playback-resources.mjs');
            resources=new PlaybackResources({maxBytes:data.maxBytes,maxPacketBytes:0,maxRasterBytes:0,maxVectorBytes:0,maxSoftwareFilterBytes:data.maxBytes});
          }
          result=capturePreviewRaster(geometry,{...options,...(resources?{resources}:{})});bitmap=result.bitmap;
        }finally{resources?.dispose();}
        self.postMessage({id:data.id,...result},[bitmap]);bitmap=null;
      }finally{previewActive=false;}
      return;
    }
    if(data.kind!=='composite'||!snapshot)throw messageError(new Error(''), "errors.drawingCompositeWorker.missingDrawingCompositeSnapshot", {});
    const source=await captureDrawingComposite(snapshot,{...data,snapshotBytes:bytes});snapshot=null;
    self.postMessage({id:data.id,source:source.buffer},[source.buffer]);
  }catch(error){bitmap?.close();snapshot=null;self.postMessage({id:data.id,error:error.message, ...errorMessageData(error),...(typeof error.code==='string'?{code:error.code}:{})});}
};
