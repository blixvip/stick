import {messageError} from './localized-error.mjs';
/** Read one rendered pixel using the canvas backing size, including preview scaling. */
export function sampleCanvasRegion(canvas, clientX, clientY, radius=0) {
  const rect=canvas.getBoundingClientRect();
  if(!rect.width || !rect.height || clientX<rect.left || clientY<rect.top || clientX>=rect.right || clientY>=rect.bottom)
    throw messageError(new Error(''), "errors.canvasColorSample.chooseAColorInsideTheCanvas", {});
  const size=radius*2+1;
  const pixel=document.createElement('canvas');pixel.width=pixel.height=size;
  const ctx=pixel.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(canvas,Math.floor((clientX-rect.left)*canvas.width/rect.width)-radius,Math.floor((clientY-rect.top)*canvas.height/rect.height)-radius,size,size,0,0,size,size);
  const pixels=ctx.getImageData(0,0,size,size),offset=(radius*size+radius)*4;
  return {color:Array.from(pixels.data.slice(offset,offset+3)),pixels};
}
