import {messageError} from './localized-error.mjs';
import {TILE,tileKey,assertTileCoordinates} from './drawing-tiles.mjs';

/** Conservative quadratic coverage. Each midpoint curve is inside its three
 * input points' convex hull. Rasterize that hull by tile rows, inflated for
 * brush radius and stabilization, instead of seeding a batch's empty AABB. */
export function strokeRegion(points,margin,{maxTiles=65536}={}){
  const result=new Map();
  for(let i=0;i<points.length;i++){
    const hull=points.slice(Math.max(0,i-2),i+1);
    if(!hull.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))||!Number.isFinite(margin))throw messageError(new Error(''), "errors.drawingStrokeRegion.invalidStrokeCoordinates", {});
    const y0=Math.floor((Math.min(...hull.map(p=>p.y))-margin)/TILE),y1=Math.floor((Math.max(...hull.map(p=>p.y))+margin)/TILE);
    if(y1-y0>maxTiles)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
    for(let ty=y0;ty<=y1;ty++){
      const lo=ty*TILE-margin,hi=(ty+1)*TILE+margin,xs=[];
      for(let j=0;j<hull.length;j++){
        const a=hull[j],b=hull[(j+1)%hull.length];
        if(a.y>=lo&&a.y<=hi)xs.push(a.x);
        if(a.y!==b.y)for(const y of [lo,hi]){const t=(y-a.y)/(b.y-a.y);if(t>=0&&t<=1)xs.push(a.x+(b.x-a.x)*t);}
      }
      if(!xs.length)continue;
      const x0=Math.floor((Math.min(...xs)-margin)/TILE),x1=Math.floor((Math.max(...xs)+margin)/TILE);
      if(x1-x0>maxTiles)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
      for(let tx=x0;tx<=x1;tx++){
        assertTileCoordinates(tx,ty);result.set(tileKey(tx,ty),[tx,ty]);
        if(result.size>maxTiles)throw messageError(new Error(''), "errors.drawingController.theStrokeExceedsTheDrawingWorkingMemoryLimit", {});
      }
    }
  }
  return result.values();
}
