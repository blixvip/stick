import {drawingMetadata,EMPTY_PNG} from './drawing-model.mjs';
import {decodeTileBlob,tileStoreFromList} from './drawing-tile-codec.mjs';
import {flattenedDrawingPNG} from './drawing-raster.mjs';

/** Pivot formats cannot carry tile blobs: replace each v2 drawing figure with
 * an ordinary sprite whose PNG covers the tile bounds at source resolution
 * (largest fitting mip level past 16 Mpx). The PNG's anchor_start is the
 * drawing_anchor expressed in flattened-pixel coordinates, so placement is
 * identical. v1 cels keep their PNG and metadata untouched. */
export async function flattenDrawingFigures(report,{seen=new Set(),stats=null}={}) {
  if(!report||seen.has(report))return 0;seen.add(report);
  let flattened=0;
  for(const figure of report.figure_types??[]){
    const d=drawingMetadata(figure),asset=figure.image_assets?.[0];
    if(d?.version===2&&asset){
      const anchor=asset.drawing_anchor??asset.anchor_start??{x:0,y:0};
      const holder={store:tileStoreFromList(asset.styk_tiles?await decodeTileBlob(asset.styk_tiles):[])};
      const flat=await flattenedDrawingPNG(holder);
      if(stats&&flat?.level>0)stats.downsampled=(stats.downsampled??0)+1;
      if(flat){
        const angle=asset.anchor_angle_rad??0,start={x:anchor.x-flat.x,y:anchor.y-flat.y};
        Object.assign(asset,{data_url:flat.dataUrl,width:flat.width,height:flat.height,
          display_width:flat.width*flat.scale,display_height:flat.height*flat.scale,
          anchor_start:start,anchor_end:{x:start.x+asset.anchor_length*Math.cos(angle),y:start.y+asset.anchor_length*Math.sin(angle)}});
      }else Object.assign(asset,{data_url:EMPTY_PNG,width:1,height:1,display_width:1,display_height:1});
      delete asset.styk_tiles;delete asset.drawing_anchor;
      delete figure._styk.drawing;flattened++;
    }
    if(figure._styk?.movieclip?.document)flattened+=await flattenDrawingFigures(figure._styk.movieclip.document,{seen,stats});
  }
  if(report._styk?.movieclipSource?.document)flattened+=await flattenDrawingFigures(report._styk.movieclipSource.document,{seen,stats});
  return flattened;
}
