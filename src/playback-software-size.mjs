/** Whole-artboard compatibility packets use the view density, independently
 * of the camera transform. Share this footprint with controller admission so
 * the first cold queue obeys the same residency limit as measured packets. */
export function softwareFrameSize(report,{scale=1,quality=1,maxTextureDimension=8192}={}) {
  const pixelScale=Math.min(scale*quality,maxTextureDimension/report.canvas_width,maxTextureDimension/report.canvas_height);
  const pixelWidth=Math.max(1,Math.ceil(report.canvas_width*pixelScale)),pixelHeight=Math.max(1,Math.ceil(report.canvas_height*pixelScale));
  const bitmapBytes=pixelWidth*pixelHeight*4;
  return {pixelScale,pixelWidth,pixelHeight,bitmapBytes,byteLength:bitmapBytes+128};
}
