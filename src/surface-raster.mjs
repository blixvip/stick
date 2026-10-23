/** Small, bounded depth compositor for native projected solid fills and figure
 * meshes. Every rendering path paints the same depth-tested triangles through
 * drawGeometry, including worker/export canvases. */
const caches=new WeakMap(),TILE=1024,MAX_RETAINED_FLOATS=2*1024*1024;
export const depthSurface=s=>s?.type==='mesh'?!s.outline&&s.count>0:
  s?.type==='poly'&&s.poly?._stykSurface?.depthTest&&s.depthValues?.length===s.points.length&&s.points.length>=3&&s.points.length<=4&&s.alpha===1&&!s.outline;
const makeCanvas=(ctx,w,h)=>typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(w,h):Object.assign(ctx.canvas.ownerDocument.createElement('canvas'),{width:w,height:h});
function create(ctx){
  const canvas=makeCanvas(ctx,1,1),gl=canvas.getContext('webgl2',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:true});
  if(!gl)return {canvas:makeCanvas(ctx,1,1)};
  const shaders=[];
  const compile=(type,source)=>{const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
  const program=gl.createProgram();
  try{
    gl.attachShader(program,compile(gl.VERTEX_SHADER,`#version 300 es
    in vec3 point;in vec3 color;uniform vec4 box;uniform vec2 depth;out vec3 rgb;
    void main(){vec2 p=(point.xy-box.xy)/box.zw;gl_Position=vec4(p.x*2.-1.,1.-p.y*2.,.999-1.998*(point.z-depth.x)/depth.y,1.);rgb=color;}`));
    gl.attachShader(program,compile(gl.FRAGMENT_SHADER,`#version 300 es
    precision highp float;in vec3 rgb;out vec4 pixel;void main(){pixel=vec4(rgb,1.);}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    const buffer=gl.createBuffer();gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    for(const[name,offset]of [['point',0],['color',12]]){const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,24,offset);}
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.BLEND);
    return {canvas,gl,program,buffer,box:gl.getUniformLocation(program,'box'),depth:gl.getUniformLocation(program,'depth')};
  }catch{gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();return {canvas:makeCanvas(ctx,1,1)};}
  finally{for(const shader of shaders)gl.deleteShader(shader);}
}
export function releaseSurfaceRaster(ctx){const r=caches.get(ctx);if(!r)return;caches.delete(ctx);if(r.gl){r.gl.deleteBuffer(r.buffer);r.gl.deleteProgram(r.program);r.gl.getExtension('WEBGL_lose_context')?.loseContext();}r.canvas.width=r.canvas.height=1;}
function software(r,data,box,w,h){
  const ctx=r.canvas.getContext('2d'),pixels=ctx.createImageData(w,h),zbuffer=new Float64Array(w*h);zbuffer.fill(-Infinity);
  const sx=w/box[2],sy=h/box[3];
  for(let i=0;i<data.length;i+=18){
    const ax=(data[i]-box[0])*sx,ay=(data[i+1]-box[1])*sy,bx=(data[i+6]-box[0])*sx,by=(data[i+7]-box[1])*sy,cx=(data[i+12]-box[0])*sx,cy=(data[i+13]-box[1])*sy;
    const det=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(det)<1e-12)continue;
    const x0=Math.max(0,Math.floor(Math.min(ax,bx,cx))),x1=Math.min(w-1,Math.ceil(Math.max(ax,bx,cx))),y0=Math.max(0,Math.floor(Math.min(ay,by,cy))),y1=Math.min(h-1,Math.ceil(Math.max(ay,by,cy)));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const u=((x+.5-ax)*(cy-ay)-(y+.5-ay)*(cx-ax))/det,v=((bx-ax)*(y+.5-ay)-(by-ay)*(x+.5-ax))/det;
      if(u<-1e-7||v<-1e-7||u+v>1.0000001)continue;
      const z=data[i+2]+u*(data[i+8]-data[i+2])+v*(data[i+14]-data[i+2]),at=y*w+x;if(z<zbuffer[at])continue;zbuffer[at]=z;
      const p=at*4;pixels.data[p]=Math.round(data[i+3]*255);pixels.data[p+1]=Math.round(data[i+4]*255);pixels.data[p+2]=Math.round(data[i+5]*255);pixels.data[p+3]=255;
    }
  }
  ctx.putImageData(pixels,0,0);
}
export function paintDepthSurfaces(ctx,items){
  let r=caches.get(ctx);if(r?.gl?.isContextLost()){releaseSurfaceRaster(ctx);r={canvas:makeCanvas(ctx,1,1)};}
  if(!r)r=create(ctx);caches.set(ctx,r);
  const vertexCount=items.reduce((sum,s)=>sum+(s.type==='mesh'?s.count:s.points.length-2)*3,0),length=vertexCount*6;
  let data;
  if(length<=MAX_RETAINED_FLOATS){
    if(!r.data || r.data.length<length || r.data.length>Math.max(1024,length*4))
      r.data=new Float32Array(Math.max(1024,length));
    data=r.data.subarray(0,length);
  }else{r.data=undefined;data=new Float32Array(length);}
  let at=0,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(const s of items){
    if(s.type==='mesh'){
      // Onion skins tint every face with one colour.
      const mesh=s.spatialMesh,p=mesh.positions,d=mesh.depth,T=s.triangles,colors=mesh.colors.map(c=>(c=s.onionTint??c,[c[0]/255,c[1]/255,c[2]/255]));
      if(mesh.bounds){minX=Math.min(minX,mesh.bounds.x0);maxX=Math.max(maxX,mesh.bounds.x1);minY=Math.min(minY,mesh.bounds.y0);maxY=Math.max(maxY,mesh.bounds.y1);minZ=Math.min(minZ,mesh.zMin);maxZ=Math.max(maxZ,mesh.zMax);}
      for(let t=0;t<s.count;t++){
        const [red,green,blue]=colors[s.materials[t]];
        for(let k=0;k<3;k++){const v=T[t*3+k];data[at++]=p[v*2];data[at++]=p[v*2+1];data[at++]=d[v];data[at++]=red;data[at++]=green;data[at++]=blue;}
      }
      continue;
    }
    const red=s.rgb[0]/255,green=s.rgb[1]/255,blue=s.rgb[2]/255;
    for(let i=0;i<s.points.length;i++){
      const p=s.points[i],z=s.depthValues[i];
      minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);
      // Native triangles are already a fan. A clipped quad repeats corners
      // zero and two, using the values just written, without another scan.
      if(i>=3){data.copyWithin(at,at-18,at-12);at+=6;data.copyWithin(at,at-12,at-6);at+=6;}
      data[at++]=p.x;data[at++]=p.y;data[at++]=z;data[at++]=red;data[at++]=green;data[at++]=blue;
    }
  }
  if(!(maxX>minX&&maxY>minY))return;
  const matrix=ctx.getTransform(),scale=Math.max(1e-6,Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d)),inverse=matrix.inverse();
  const corners=[[0,0],[ctx.canvas.width,0],[0,ctx.canvas.height],[ctx.canvas.width,ctx.canvas.height]].map(([x,y])=>({x:inverse.a*x+inverse.c*y+inverse.e,y:inverse.b*x+inverse.d*y+inverse.f}));
  minX=Math.max(minX-2/scale,Math.min(...corners.map(p=>p.x)));minY=Math.max(minY-2/scale,Math.min(...corners.map(p=>p.y)));
  maxX=Math.min(maxX+2/scale,Math.max(...corners.map(p=>p.x)));maxY=Math.min(maxY+2/scale,Math.max(...corners.map(p=>p.y)));
  if(r.gl){const gl=r.gl;gl.useProgram(r.program);gl.bindBuffer(gl.ARRAY_BUFFER,r.buffer);
    if(!r.bufferBytes||r.bufferBytes<data.byteLength||r.bufferBytes>Math.max(4096,data.byteLength*4)){
      r.bufferBytes=Math.max(4096,data.byteLength);gl.bufferData(gl.ARRAY_BUFFER,r.bufferBytes,gl.STREAM_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER,0,data);gl.uniform2f(r.depth,minZ,Math.max(1e-8,maxZ-minZ));}
  const step=TILE/scale;
  for(let y=minY;y<maxY;y+=step)for(let x=minX;x<maxX;x+=step){
    const width=Math.min(step,maxX-x),height=Math.min(step,maxY-y),w=Math.max(1,Math.ceil(width*scale)),h=Math.max(1,Math.ceil(height*scale)),box=[x,y,width,height];
    if(r.canvas.width!==w)r.canvas.width=w;if(r.canvas.height!==h)r.canvas.height=h;
    if(r.gl){const gl=r.gl;gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.uniform4fv(r.box,box);gl.drawArrays(gl.TRIANGLES,0,vertexCount);gl.flush();}
    else software(r,data,box,w,h);
    ctx.drawImage(r.canvas,x,y,width,height);
  }
}
