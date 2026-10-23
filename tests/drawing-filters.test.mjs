import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTiles,pointFilterWork,maskValue,applyTileChanges} from '../src/drawing-pixels.mjs';
import {TILE,TILE_BYTES,TileStore} from '../src/drawing-tiles.mjs';
import {DRAWING_MAX_PIXELS} from '../src/drawing-model.mjs';
import {drawingWorkerOperation} from '../src/drawing-worker-operations.mjs';

// The former dense pixel algorithm is an independent reference for this
// tile traversal refactor. In particular, rounding after a fractional mask
// and preserving invisible RGB must remain byte-identical.
const clamp=(n,min=0,max=1)=>Math.max(min,Math.min(max,n));
function densePointReference(source,width,height,{bounds,kind,mask,hue=0,saturation=0,lightness=0,brightness=0,contrast=0}){
  const out=source.slice();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,w=mask?maskValue(mask,bounds.x+x,bounds.y+y):1;
    if(!w||!source[i+3])continue;
    let r=source[i],g=source[i+1],b=source[i+2];
    if(kind==='invert'){r=255-r;g=255-g;b=255-b;}
    else if(kind==='brightness'){
      const k=clamp(1+contrast/100,0,4),o=brightness*2.55;
      r=(r-128)*k+128+o;g=(g-128)*k+128+o;b=(b-128)*k+128+o;
    }else{
      r/=255;g/=255;b/=255;
      const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2,d=max-min;
      let h=0,s=0;
      if(d){s=l>.5?d/(2-max-min):d/(max+min);h=(max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4)/6;}
      h=((h+hue/360)%1+1)%1;s=clamp(s*(1+saturation/100));
      const nextL=clamp(lightness>=0?l+(1-l)*lightness/100:l*(1+lightness/100));
      if(!s)r=g=b=nextL*255;
      else{
        const q=nextL<.5?nextL*(1+s):nextL+s-nextL*s,p=2*nextL-q;
        const channel=t=>{if(t<0)t+=1;if(t>1)t-=1;return(t<1/6?p+(q-p)*6*t:t<.5?q:t<2/3?p+(q-p)*(2/3-t)*6:p)*255;};
        r=channel(h+1/3);g=channel(h);b=channel(h-1/3);
      }
    }
    out[i]=Math.round(source[i]+(clamp(r,0,255)-source[i])*w);
    out[i+1]=Math.round(source[i+1]+(clamp(g,0,255)-source[i+1])*w);
    out[i+2]=Math.round(source[i+2]+(clamp(b,0,255)-source[i+2])*w);
  }
  return out;
}
function patternedStore(){
  const store=new TileStore();
  for(const [tx,ty] of [[-2,-1],[-1,0],[0,0],[1,1],[3,0]]){
    const pixels=new Uint8ClampedArray(TILE_BYTES);
    for(let p=0;p<TILE*TILE;p++)pixels.set([(p*13+tx+256)%256,(p*31+ty+256)%256,p*7%256,[0,1,73,255][p%4]],p*4);
    store.adopt(tx,ty,pixels);
  }
  return store;
}

// Each reference pass allocates its own temporary, as the original blur did.
function denseBlurReference(source,width,height,{bounds,radius,mask}){
  const r=Math.max(1,Math.round(clamp(radius,1,64)/Math.sqrt(3))),pre=new Float32Array(source.length),next=new Float32Array(source.length),out=source.slice();
  const pass=(src,dst)=>{
    const tmp=new Float32Array(src.length),w=2*r+1;
    for(let y=0;y<height;y++)for(let c=0;c<4;c++){let sum=0;const row=y*width;for(let x=-r;x<=r;x++)sum+=src[(row+Math.min(width-1,Math.max(0,x)))*4+c];for(let x=0;x<width;x++){tmp[(row+x)*4+c]=sum/w;sum+=src[(row+Math.min(width-1,x+r+1))*4+c]-src[(row+Math.max(0,x-r))*4+c];}}
    for(let x=0;x<width;x++)for(let c=0;c<4;c++){let sum=0;for(let y=-r;y<=r;y++)sum+=tmp[(Math.min(height-1,Math.max(0,y))*width+x)*4+c];for(let y=0;y<height;y++){dst[(y*width+x)*4+c]=sum/w;sum+=tmp[(Math.min(height-1,y+r+1)*width+x)*4+c]-tmp[(Math.max(0,y-r)*width+x)*4+c];}}
  };
  for(let i=0;i<source.length;i+=4){const a=source[i+3]/255;pre[i]=source[i]*a;pre[i+1]=source[i+1]*a;pre[i+2]=source[i+2]*a;pre[i+3]=source[i+3];}
  pass(pre,next);pass(next,pre);pass(pre,next);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const w=mask?maskValue(mask,bounds.x+x,bounds.y+y):1;if(!w)continue;
    const i=(y*width+x)*4,a=next[i+3],b=a>0?[next[i]*255/a,next[i+1]*255/a,next[i+2]*255/a,a]:[0,0,0,0];
    for(let c=0;c<4;c++)out[i+c]=Math.round(source[i+c]+(b[c]-source[i+c])*w);
  }
  return out;
}

test('blur scratch reuse preserves exact dense three-pass output and mask bytes',()=>{
  for(const [width,height,radius] of [[1,1,64],[19,23,1],[95,81,7.3]]){
    const store=patternedStore(),bounds={x:-71,y:-13,width,height},source=store.readRect(bounds.x,bounds.y,width,height),mask={...bounds,max:255,mask:Uint8Array.from({length:width*height},(_,i)=>[0,1,127,128,255][i%5])};
    const expected=denseBlurReference(source,width,height,{bounds,radius,mask});
    filterTiles(store,{bounds,kind:'blur',radius,mask});
    assert.deepEqual(store.readRect(bounds.x,bounds.y,width,height),expected);
  }
});

for(const options of [{kind:'invert'},{kind:'brightness',brightness:37.2,contrast:-63.5},{kind:'brightness',brightness:-12.8,contrast:240},{kind:'hsl',hue:-241.7,saturation:73.4,lightness:21.9},{kind:'hsl',hue:127.2,saturation:-42.6,lightness:-37.5}]){
  test(`${options.kind} matches dense bytes across partial negative tiles and fractional masks`,()=>{
    const store=patternedStore(),bounds={x:-113,y:-47,width:227,height:139},rect={x:-128,y:-64,width:384,height:192};
    const original=store.readRect(rect.x,rect.y,rect.width,rect.height),source=store.readRect(bounds.x,bounds.y,bounds.width,bounds.height);
    const mask={x:-91,y:-35,width:193,height:107,max:255,mask:Uint8Array.from({length:193*107},(_,i)=>[0,1,63,128,254,255][i%6])};
    const expected=new TileStore();expected.writeRect(rect.x,rect.y,rect.width,rect.height,original);
    expected.writeRect(bounds.x,bounds.y,bounds.width,bounds.height,densePointReference(source,bounds.width,bounds.height,{...options,bounds,mask}));
    filterTiles(store,{...options,bounds,mask});
    assert.deepEqual(store.readRect(rect.x,rect.y,rect.width,rect.height),expected.readRect(rect.x,rect.y,rect.width,rect.height));
    assert.equal(store.size,5,'empty gaps never create tiles');
  });
}

test('unmasked brightness tables preserve dense rounding at channel boundaries',()=>{
  for(const [brightness,contrast] of [[0,0],[.19607843137254902,0],[12.5,72.5],[-22.7,-98.6],[57.3,350],[NaN,12]]){
    const store=patternedStore(),bounds={x:-113,y:-47,width:227,height:139},source=store.readRect(bounds.x,bounds.y,bounds.width,bounds.height),options={kind:'brightness',brightness,contrast,bounds};
    const expected=densePointReference(source,bounds.width,bounds.height,options);
    filterTiles(store,options);assert.deepEqual(store.readRect(bounds.x,bounds.y,bounds.width,bounds.height),expected);
  }
});

test('HSL specialization preserves grayscale, tied channels and fractional-mask rounding',()=>{
  const pixels=new Uint8ClampedArray(TILE_BYTES),bounds={x:0,y:0,width:TILE,height:TILE};
  for(let p=0;p<TILE*TILE;p++){
    const value=p%256,next=(value+1)%256;
    pixels.set([[value,value,value,255],[value,value,next,1],[value,next,value,73],[next,value,value,255]][Math.floor(p/256)%4],p*4);
  }
  const weighted={...bounds,max:255,mask:Uint8Array.from({length:TILE*TILE},(_,i)=>[0,1,63,128,254,255][i%6])};
  for(const mask of [null,weighted])for(const [hue,saturation,lightness] of [[0,0,0],[719.9,100,50],[-360.1,-100,-50],[127.2,73.4,21.9],[NaN,12,-37.5],[23,NaN,12]]){
    const store=new TileStore();store.adopt(0,0,pixels.slice());
    const options={bounds,kind:'hsl',mask,hue,saturation,lightness};
    filterTiles(store,options);
    assert.deepEqual(store.get(0,0).pixels,densePointReference(pixels,TILE,TILE,options));
  }
});

test('point filtering retains no-op tiles, encoded PNGs, hidden RGB and frozen source forks',()=>{
  const store=new TileStore(),pixels=new Uint8ClampedArray(TILE_BYTES);
  pixels.set([17,32,91,0]);pixels.set([10,20,30,127],4);
  store.adopt(-1,0,pixels);store.set(3,0,new Uint8ClampedArray([40,50,60,255]));
  const original=store.get(-1,0),untouched=store.get(3,0),png=new Uint8Array([1,2,3]);original.png=png;
  const frozen=store.fork(),before=new Map(),bounds={x:-64,y:0,width:64,height:64};
  filterTiles(store,{bounds,kind:'brightness',before});
  assert.equal(store.get(-1,0),original);assert.equal(original.png,png);assert.equal(before.size,0);
  filterTiles(store,{bounds,kind:'invert',before});
  assert.deepEqual(store.pixel(-64,0),[17,32,91,0],'transparent RGB remains exact');
  assert.deepEqual(store.pixel(-63,0),[245,235,225,127]);
  assert.deepEqual(frozen.pixel(-63,0),[10,20,30,127],'a frozen fork keeps the original pixels');
  assert.equal(before.get('-1,0'),pixels,'history retains the original unchanged buffer');
  assert.equal(store.get(3,0),untouched);assert.equal(store.get(-1,0).png,undefined);
  filterTiles(store,{bounds,kind:'brightness',brightness:10,before});
  assert.equal(before.get('-1,0'),pixels,'repeated edits retain the earliest snapshot');
});

test('point filters bound occupied work instead of distant artwork coordinates',()=>{
  const store=new TileStore();store.set(-100000,0,new Uint8ClampedArray([20,40,60,255]));store.set(100000,0,new Uint8ClampedArray([70,90,110,255]));
  const bounds={x:-6400000,y:0,width:12800064,height:64};
  assert.deepEqual(pointFilterWork(store,bounds),{pixels:8192,bytes:2*TILE_BYTES});
  store.readRect=()=>assert.fail('point filters cannot allocate a dense surface');
  filterTiles(store,{bounds,kind:'invert'});
  assert.deepEqual(store.pixel(-6400000,0),[235,215,195,255]);
  assert.deepEqual(store.pixel(6400000,0),[185,165,145,255]);assert.equal(store.size,2);
  assert.throws(()=>filterTiles(store,{bounds,kind:'blur'}),/filter bounds/,'blur keeps its dense area guard');
});

test('point filters accept unaligned owned tiles and preserve their source bytes',()=>{
  const pixels=new Uint8ClampedArray(new ArrayBuffer(TILE_BYTES+1),1,TILE_BYTES),store=new TileStore();
  pixels.set([15,32,73,255]);store.adopt(0,0,pixels);
  filterTiles(store,{bounds:{x:0,y:0,width:1,height:1},kind:'invert'});
  assert.deepEqual(store.pixel(0,0),[240,223,182,255]);assert.deepEqual([...pixels.subarray(0,4)],[15,32,73,255]);
});

test('oversized occupied point work is rejected before any tile changes',()=>{
  const store=new TileStore(),pixels=new Uint8ClampedArray(TILE_BYTES).fill(127),count=DRAWING_MAX_PIXELS/(TILE*TILE)+1;
  for(let tx=0;tx<count;tx++)store.adopt(tx,0,pixels);
  const first=store.get(0,0),last=store.get(count-1,0),before=new Map();
  assert.throws(()=>filterTiles(store,{bounds:{x:0,y:0,width:count*TILE,height:TILE},kind:'invert',before}),/filter bounds/);
  assert.equal(store.get(0,0),first);assert.equal(store.get(count-1,0),last);assert.equal(before.size,0);
});

test('filter bounds reject fractional, infinite and overflowing coordinates',()=>{
  const store=new TileStore(),valid={x:-2,y:4,width:7,height:5};
  for(const bounds of [{...valid,x:.5},{...valid,y:Infinity},{...valid,width:NaN},{...valid,height:0},{...valid,x:Number.MAX_SAFE_INTEGER}]){
    assert.throws(()=>filterTiles(store,{bounds,kind:'invert'}),/filter bounds/);
  }
});

async function workerFilter(store,options){
  const previous=globalThis.self;
  let reply;
  globalThis.self={postMessage:(data,transfer=[])=>{reply=structuredClone(data,{transfer});}};
  try{
    const tiles=[...store].map(tile=>({tx:tile.tx,ty:tile.ty,pixels:tile.pixels.slice().buffer}));
    await drawingWorkerOperation({id:7,kind:'filter',bounds:options.bounds,options,tiles});
    assert.equal(reply.error,undefined);return reply.tiles;
  }finally{if(previous===undefined)delete globalThis.self;else globalThis.self=previous;}
}

test('worker point filters return exact changed-tile history and restore undo/redo',async()=>{
  const store=patternedStore(),before=store.readRect(-128,-64,384,192),bounds={x:-17,y:-9,width:35,height:43};
  const mask={x:-9,y:-3,width:23,height:27,max:255,mask:new Uint8Array(23*27).fill(128)};
  const expected=store.fork();filterTiles(expected,{bounds,mask,kind:'invert'});
  const changes=await workerFilter(store,{bounds,mask,kind:'invert'});
  assert.deepEqual(changes.map(t=>[t.tx,t.ty]),[[-1,0],[0,0]],'history excludes untouched and absent tiles');
  applyTileChanges(store,changes,'after');assert.deepEqual(store.readRect(-128,-64,384,192),expected.readRect(-128,-64,384,192));
  applyTileChanges(store,changes,'before');assert.deepEqual(store.readRect(-128,-64,384,192),before);
  applyTileChanges(store,changes,'after');assert.deepEqual(store.readRect(-128,-64,384,192),expected.readRect(-128,-64,384,192));
});

test('worker point filtering preserves entirely transparent tiles and sparse large bounds',async()=>{
  const store=new TileStore(),hidden=new Uint8ClampedArray(TILE_BYTES);hidden.set([99,88,77,0]);
  store.adopt(-100000,0,hidden);store.set(100000,0,new Uint8ClampedArray([20,40,60,255]));
  const changes=await workerFilter(store,{bounds:{x:-6400000,y:0,width:12800064,height:64},kind:'invert'});
  assert.equal(changes.length,1);assert.equal(changes[0].tx,100000);
  applyTileChanges(store,changes,'after');assert.deepEqual(store.pixel(-6400000,0),[99,88,77,0]);
});
