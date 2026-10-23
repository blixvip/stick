import {drawingMetadata} from './drawing-model.mjs';

/** Snapshot live presenters without hashing or copying their pixels. Retained
 * geometry can stay identical while a decode, stroke or preview completes. */
export function drawingRasterInputs(items,resources,{published=false}={}){
  let inputs=null;
  for(const item of items)if(drawingMetadata(item.fig)){
    const entry=resources.drawing?.(item.fig);
    if(entry)(inputs??=[]).push({entry,stamp:entry.stamp,store:entry.store,owner:entry.owner,published,
      pixelStamp:entry.pixelStamp??0,revision:entry.revision,
      publishedRevision:entry.published?.revision,publishedUrl:entry.published?.url??null});
  }
  return inputs;
}
/** Adopt the captured publication, never a newer live entry. Native captures
 * own published pixels independently of derived previews completing later. */
export const publishedDrawingRasterInputs=inputs=>inputs?.map(input=>input.published?input:{...input,published:true})??inputs;
// The validity guard owns URL and resource identity checks; keys stay compact
// even when a publication is a large inline tile blob.
export const drawingRasterKey=inputs=>inputs?.map(input=>input.published
  ?input.entry.id+":published:"+input.pixelStamp+":"+input.revision+":"+input.publishedRevision
  :input.entry.id+":"+input.stamp+":"+(input.entry.owner?.surfaceVersion??0)).join("|")??"";
export const changedDrawingRaster=inputs=>inputs?.some(input=>{
  const {entry,stamp,store,owner}=input;
  return entry.disposed||entry.store!==store||entry.owner!==owner||(input.published
    ?(entry.pixelStamp??0)!==input.pixelStamp||entry.revision!==input.revision||
      entry.published?.revision!==input.publishedRevision||(entry.published?.url??null)!==input.publishedUrl
    :entry.stamp!==stamp);
});
export function sameDrawingRaster(a,b){
  return (a?.length??0)===(b?.length??0)&&!changedDrawingRaster(a)&&
    (a??[]).every((input,index)=>{
      const other=b[index];
      return input.entry===other.entry&&input.store===other.store&&input.owner===other.owner&&
        Boolean(input.published)===Boolean(other.published)&&(input.published
          ?input.pixelStamp===other.pixelStamp&&input.revision===other.revision&&
            input.publishedRevision===other.publishedRevision&&input.publishedUrl===other.publishedUrl
          :input.stamp===other.stamp);
    });
}
