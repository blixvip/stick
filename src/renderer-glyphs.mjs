import {hasDrawableVfx} from './vfx-canvas.mjs';
import {SHAPE, shapeRecord} from './renderer-geometry.mjs';

// A mask describes immutable glyph pixels, not an object pose or camera crop.
// Pixel ownership stays in the existing bounded worker/editor/GPU caches.
const masks = new WeakMap();
let serial = 0;
function maskFor(glyph) {
  const b = glyph?.bounds, path = glyph?.svg_path;
  if (!path || !b || ![b.left,b.top,b.right,b.bottom].every(Number.isFinite) || b.right <= b.left || b.bottom <= b.top) return null;
  const signature = `${b.left},${b.top},${b.right},${b.bottom}`;
  let mask = masks.get(glyph);
  if (!mask || mask.source !== path || mask.signature !== signature) {
    mask = {id: ++serial, source: path, signature, bounds: {...b}};
    masks.set(glyph, mask);
  }
  return mask;
}

/** Single solid glyphs can tint/fade after isolation. Compound figures, effects,
 * outlines and gradients retain the complete Canvas painter implementation. */
export function glyphTextureDescriptor(items, resolution, maxDimension = 4096) {
  if (items.length !== 1) return null;
  const s = items[0], asset = s.asset;
  if (s.type !== 'text' || !asset?.normalized_svg_path || !asset.bounds?.width || s._movieclipOwner ||
      hasDrawableVfx(s) || s.fig?.segment_decode?.global_style?.u28 ||
      ((s.seg?.paint || s.seg?.secondary) && Number(s.obj.color_override_raw) >>> 24 !== 255)) return null;
  let placement;
  for (const p of asset.placements || []) if (p.visible) { if (placement) return null; placement = p; }
  if (!placement) return null;
  const mask = maskFor(asset.glyphs?.[placement.glyph_index]);
  if (!mask) return null;
  const reverse = Boolean(s.seg.extra_u8_a ?? s.seg.extra?.[1]);
  const mirror = Boolean(s.seg.extra_u8_b ?? s.seg.extra?.[2]) !== Boolean(s.obj.image_text_flags);
  const start = reverse ? s.end : s.start, angle = s.angle + (reverse ? Math.PI : 0) - (mirror ? Math.PI : 0);
  const xs = Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y) / asset.bounds.width * (mirror ? -1 : 1), ys = Number(s.obj.scale ?? 1);
  const spanX = mask.bounds.right-mask.bounds.left, spanY = mask.bounds.bottom-mask.bounds.top;
  if (![xs,ys,angle,resolution,placement.x,placement.y,asset.bounds.left,asset.bounds.bottom].every(Number.isFinite) || !xs || !ys || resolution <= 0) return null;
  // Quantized dimensions allow camera motion and stretching to reuse masks.
  // Extra sampling detail limits filtering under rotation; never admit a mask
  // below the requested density just to fit a very large glyph.
  const requiredX = spanX*Math.abs(xs)*resolution+4, requiredY = spanY*Math.abs(ys)*resolution+4;
  if (requiredX > maxDimension || requiredY > maxDimension) return null;
  const dimension = required => Math.min(maxDimension, 2 ** Math.ceil(Math.log2(Math.max(8,(required-4)*1.25+4))));
  const width=dimension(requiredX), height=dimension(requiredY), scaleX=(width-4)/spanX, scaleY=(height-4)/spanY;
  const left=mask.bounds.left-2/scaleX, top=mask.bounds.top-2/scaleY;
  const cos=Math.cos(angle), sin=Math.sin(angle), px=(placement.x-asset.bounds.left+left)*xs, py=(placement.y-asset.bounds.bottom+top)*ys;
  const x=start.x+px*cos-py*sin, y=start.y+px*sin+py*cos;
  const axes=[width/scaleX*xs*cos,width/scaleX*xs*sin,-height/scaleY*ys*sin,height/scaleY*ys*cos];
  return {mask,width,height,scaleX,scaleY,left,top,x,y,axes,variant:`${width}x${height}`,bytes:width*height*4,
    color:[...s.rgb.map(n=>n/255),Math.max(0,Math.min(1,s.alpha))*Math.max(0,Math.min(1,s.opacity))]};
}

export async function glyphTextureKey({mask,variant}) {
  mask.digest ??= crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['styk-glyph-mask-v1',mask.source,mask.signature])))
    .then(bytes=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join(''));
  return `glyph:${await mask.digest}:${variant}`;
}

/** Conservative bounds for independent absolute SVG subpaths. Bezier control
 * hulls contain every point on their curves. Unsupported/relative commands
 * retain the original painter rather than approximating a path or its winding. */
export function glyphPathContours(source) {
  if(typeof source!=='string'||source.length>256*1024)return null;
  const tokens=[...source.matchAll(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)];
  const contours=[];let position=0,index=0,command=null,x=0,y=0,startX=0,startY=0,contour=null;
  const arity={M:2,L:2,H:1,V:1,C:6,Q:4};
  const point=(px,py)=>{contour.left=Math.min(contour.left,px);contour.top=Math.min(contour.top,py);contour.right=Math.max(contour.right,px);contour.bottom=Math.max(contour.bottom,py);};
  for(const token of tokens){if(!/^[\s,]*$/.test(source.slice(position,token.index)))return null;position=token.index+token[0].length;}
  if(!/^[\s,]*$/.test(source.slice(position)))return null;
  while(index<tokens.length){
    const token=tokens[index];
    if(/^[A-Za-z]$/.test(token[0])){
      command=token[0];index++;
      if(command==='Z'){
        if(!contour)return null;x=startX;y=startY;command=null;continue;
      }
      if(!arity[command])return null;
      if(command==='M'){
        if(contour){contour.end=token.index;contours.push(contour);if(contours.length>=1024)return null;}
        contour={start:token.index,end:source.length,left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
      }
    }
    const count=arity[command];if(!count||!contour||index+count>tokens.length)return null;
    const values=tokens.slice(index,index+count).map(t=>Number(t[0]));if(!values.every(Number.isFinite))return null;
    index+=count;
    if(command==='H'){x=values[0];point(x,y);}
    else if(command==='V'){y=values[0];point(x,y);}
    else{
      for(let n=0;n<count;n+=2)point(values[n],values[n+1]);
      x=values[count-2];y=values[count-1];
      if(command==='M'){startX=x;startY=y;command='L';}
    }
  }
  if(contour)contours.push(contour);
  return contours.length?contours:null;
}

function glyphMaskPath(glyph) {
  const {mask}=glyph;
  mask.path??=new Path2D(mask.source);
  if(glyph.offsetX!==undefined){
    mask.contours??=glyphPathContours(mask.source)||false;
    if(mask.contours){
      const left=glyph.left-1/glyph.scaleX,top=glyph.top-1/glyph.scaleY;
      const right=glyph.left+(glyph.width+1)/glyph.scaleX,bottom=glyph.top+(glyph.height+1)/glyph.scaleY;
      const visible=mask.contours.filter(c=>c.right>=left&&c.left<=right&&c.bottom>=top&&c.top<=bottom);
      if(visible.length<mask.contours.length)return new Path2D(visible.map(c=>mask.source.slice(c.start,c.end)).join(' '));
    }
  }
  return mask.path;
}

/** Crop large masks on their existing pixel grid. Quantized coverage keeps small
 * camera movements reusable; ordinary masks still share across all placements.
 * The guard preserves bilinear sampling at the visible boundary. */
export function cropGlyphTexture(glyph, visible) {
  if (!visible || glyph.bytes <= 1024 * 1024) return glyph;
  const {x,y,axes:[ax,ay,bx,by],width,height}=glyph,det=ax*by-ay*bx;
  if (!Number.isFinite(det) || !det) return glyph;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const [px,py] of [[visible.x,visible.y],[visible.x+visible.width,visible.y],
    [visible.x,visible.y+visible.height],[visible.x+visible.width,visible.y+visible.height]]){
    const dx=px-x,dy=py-y,u=(dx*by-dy*bx)/det*width,v=(dy*ax-dx*ay)/det*height;
    minX=Math.min(minX,u);maxX=Math.max(maxX,u);minY=Math.min(minY,v);maxY=Math.max(maxY,v);
  }
  const tile=128;
  const x0=Math.max(0,Math.floor((minX-2)/tile)*tile),y0=Math.max(0,Math.floor((minY-2)/tile)*tile);
  const x1=Math.min(width,Math.ceil((maxX+2)/tile)*tile),y1=Math.min(height,Math.ceil((maxY+2)/tile)*tile);
  if(x1<=x0||y1<=y0)return null;
  const w=x1-x0,h=y1-y0;
  // Cropping a nearly visible mask loses broad cross-pose sharing for little
  // benefit. Require a substantial reduction before creating a crop variant.
  if(w*h>width*height/2)return glyph;
  return {...glyph,width:w,height:h,bytes:w*h*4,left:glyph.left+x0/glyph.scaleX,top:glyph.top+y0/glyph.scaleY,
    offsetX:-glyph.left*glyph.scaleX-x0,offsetY:-glyph.top*glyph.scaleY-y0,
    x:x+ax*x0/width+bx*y0/height,y:y+ay*x0/width+by*y0/height,
    axes:[ax*w/width,ay*w/width,bx*h/height,by*h/height],
    variant:`${glyph.variant}:${x0},${y0},${w},${h}`};
}

export function drawGlyphMask(ctx, glyph) {
  const {scaleX,scaleY,left,top}=glyph;
  ctx.setTransform(scaleX,0,0,scaleY,glyph.offsetX??-left*scaleX,glyph.offsetY??-top*scaleY);
  ctx.fillStyle='#fff'; ctx.fill(glyphMaskPath(glyph),'evenodd');
}

export function glyphTextureShape(glyph, root, transform) {
  return new Float32Array(shapeRecord({a:[glyph.x-root.x,glyph.y-root.y,0,0],b:glyph.axes,
    color:glyph.color,mode:SHAPE.GLYPH,transform}));
}

export function glyphVisible(glyph, visible) {
  if (!visible) return true;
  const {x,y,axes:[ax,ay,bx,by]}=glyph;
  return Math.max(x,x+ax,x+bx,x+ax+bx)>=visible.x && Math.min(x,x+ax,x+bx,x+ax+bx)<=visible.x+visible.width &&
    Math.max(y,y+ay,y+by,y+ay+by)>=visible.y && Math.min(y,y+ay,y+by,y+ay+by)<=visible.y+visible.height;
}
