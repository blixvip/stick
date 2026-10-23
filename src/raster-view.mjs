/** Axis-aligned world coverage of an affine viewport, including rotated and
 * mirrored views. The renderer's matrix and viewport use CSS pixels. */
export function rasterViewport(matrix, width, height) {
  const [a,b,c,d,e,f] = matrix, det = a*d-b*c;
  if (!Number.isFinite(det) || !det) return null;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const [x,y] of [[0,0],[width,0],[0,height],[width,height]]) {
    const wx=(d*(x-e)-c*(y-f))/det, wy=(a*(y-f)-b*(x-e))/det;
    x0=Math.min(x0,wx);y0=Math.min(y0,wy);x1=Math.max(x1,wx);y1=Math.max(y1,wy);
  }
  return {x:x0,y:y0,width:x1-x0,height:y1-y0};
}

/** Crop on the complete artwork's pixel grid before applying texture limits.
 * Ordinary complete rasters retain their established dimensions and density.
 * Quantized, padded coverage amortizes small pans without changing that grid. */
export function rasterBounds(bounds, visible, resolution, maxDimension=8192, margin=0, padding=0) {
  const coverage=Math.min(margin,Math.floor(maxDimension/8));
  const step=coverage?Math.max(1,Math.min(128,2**Math.floor(Math.log2(maxDimension/8)))):1;
  let pixelScale=resolution;
  if (!visible || resolution<=8 && bounds.width*resolution<=maxDimension && bounds.height*resolution<=maxDimension)
    pixelScale=Math.min(resolution,maxDimension/bounds.width,maxDimension/bounds.height);
  const region = density => {
    const fullWidth=Math.max(1,Math.ceil(bounds.width*density)),fullHeight=Math.max(1,Math.ceil(bounds.height*density));
    const guard=2+coverage+padding*density;
    const x0=visible?Math.max(0,Math.floor(((visible.x-bounds.x)*density-guard)/step)*step):0;
    const y0=visible?Math.max(0,Math.floor(((visible.y-bounds.y)*density-guard)/step)*step):0;
    const x1=visible?Math.min(fullWidth,Math.ceil(((visible.x+visible.width-bounds.x)*density+guard)/step)*step):fullWidth;
    const y1=visible?Math.min(fullHeight,Math.ceil(((visible.y+visible.height-bounds.y)*density+guard)/step)*step):fullHeight;
    return {x0,y0,x1,y1,fullWidth,fullHeight};
  };
  let rect=region(pixelScale);
  if(rect.x1<=rect.x0||rect.y1<=rect.y0)return null;
  // Margin rounding is bounded separately so even a rotated viewport or an
  // unusually small device limit cannot create an oversized allocation.
  if(rect.x1-rect.x0>maxDimension||rect.y1-rect.y0>maxDimension){
    const reserve=2*(coverage+2+step);
    pixelScale=Math.min(pixelScale,Math.max(1,maxDimension-reserve)/Math.max((visible?.width??bounds.width)+2*padding,(visible?.height??bounds.height)+2*padding));
    rect=region(pixelScale);
  }
  const {x0,y0,x1,y1,fullWidth,fullHeight}=rect;
  return {x:bounds.x+x0/pixelScale,y:bounds.y+y0/pixelScale,width:(x1-x0)/pixelScale,height:(y1-y0)/pixelScale,
    pixelWidth:x1-x0,pixelHeight:y1-y0,pixelScale,fullPixels:fullWidth*fullHeight,
    cropped:x0!==0||y0!==0||x1!==fullWidth||y1!==fullHeight,padding};
}

/** Test visible artwork, rather than the whole viewport, against a retained
 * crop. A fully off-screen object needs no replacement; guard texels are kept
 * outside the required region for bilinear sampling. */
export function rasterCovers(raster, bounds, visible) {
  if(!raster?.cropped||!visible)return true;
  const padding=raster.padding??0;
  const x=Math.max(bounds.x,visible.x-padding),y=Math.max(bounds.y,visible.y-padding);
  const right=Math.min(bounds.x+bounds.width,visible.x+visible.width+padding),bottom=Math.min(bounds.y+bounds.height,visible.y+visible.height+padding);
  if(right<=x||bottom<=y)return true;
  const guard=1/raster.pixelScale,epsilon=1e-7;
  return x+epsilon>=raster.x+(raster.x>bounds.x?guard:0) && y+epsilon>=raster.y+(raster.y>bounds.y?guard:0) &&
    right-epsilon<=raster.x+raster.width-(raster.x+raster.width<bounds.x+bounds.width?guard:0) &&
    bottom-epsilon<=raster.y+raster.height-(raster.y+raster.height<bounds.y+bounds.height?guard:0);
}

/** Density of the complete raster a navigation gesture shows in place of a
 * crop it has outgrown: never above the view's own density, an ordinary
 * texture, or a few megapixels. It trades detail during motion for one
 * bounded paint; the settled view restores the requested density. */
export function gestureProxyResolution(resolution, bounds, maxDimension=8192, maxPixels=4*1024*1024) {
  return Math.max(1e-6,Math.min(resolution,8,maxDimension/Math.max(1,bounds.width),maxDimension/Math.max(1,bounds.height),
    Math.sqrt(maxPixels/Math.max(1,bounds.width*bounds.height))));
}

/** Pixels in one stand-in a pan paints for artwork its held crop no longer
 * covers. Painting cost grows with the pixel count, so this bounds the pause
 * a stand-in adds to the gesture. */
export const GESTURE_STAND_IN_PIXELS = 1024*1024;

/** A pan's stand-in for artwork its held crop no longer covers: the view
 * widened by half its size on every side, cropped on the artwork's grid at
 * the highest density that fits `maxPixels`, so one bounded paint covers a
 * long pan. The whole artwork replaces the crop when that is as sharp.
 * Returns the crop (undefined for the whole artwork, null when nothing is
 * visible) and its density; the settled view restores the requested one. */
export function gestureStandIn(bounds, visible, resolution, {maxDimension=8192, maxPixels=GESTURE_STAND_IN_PIXELS, padding=0}={}) {
  const whole={plan:undefined,density:gestureProxyResolution(resolution,bounds,maxDimension,maxPixels)};
  if(!visible)return whole;
  const view={x:visible.x-visible.width/2,y:visible.y-visible.height/2,width:visible.width*2,height:visible.height*2};
  const width=Math.min(bounds.x+bounds.width,view.x+view.width+padding)-Math.max(bounds.x,view.x-padding);
  const height=Math.min(bounds.y+bounds.height,view.y+view.height+padding)-Math.max(bounds.y,view.y-padding);
  if(!(width>0&&height>0))return {plan:null,density:whole.density};
  let density=Math.min(resolution,Math.sqrt(maxPixels/Math.max(1e-12,width*height)));
  for(let attempt=0;attempt<4&&density>whole.density;attempt++){
    const plan=rasterBounds(bounds,view,density,maxDimension,0,padding);
    if(!plan)return {plan:null,density};
    const pixels=plan.pixelWidth*plan.pixelHeight;
    // Guard texels and whole-pixel rounding can exceed the estimate slightly.
    if(pixels<=maxPixels)return plan.pixelScale<=whole.density?whole:{plan:plan.cropped?plan:undefined,density:plan.pixelScale};
    density=plan.pixelScale*Math.min(.98,Math.sqrt(maxPixels/pixels));
  }
  return whole;
}
