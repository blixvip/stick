import test from 'node:test';
import assert from 'node:assert/strict';
import {BrushStroke,StrokePath,dabShape,normalizeBrush,pressureMap,jitterAt,LINEAR_PRESSURE,BRUSH_KEYS,BRUSH_DEFAULTS} from '../src/drawing-brush.mjs';
import {ATLAS_BYTES,TEXTURE_TIPS,TEXTURE_GRAINS,brushAtlas,ensureTexture,sampleGrain} from '../src/drawing-brush-textures.mjs';
import {DrawingStroke} from '../src/drawing-pixels.mjs';
import {TileStore} from '../src/drawing-tiles.mjs';
import {StrokeEngine} from '../src/drawing-stroke-engine.mjs';

const wave=(n,y=60)=>Array.from({length:n},(_,i)=>({x:20+i*4,y:y+Math.sin(i/9)*20,pressure:.3+.7*Math.abs(Math.sin(i/15)),time:i*4}));
const shapesOf=(settings,samples)=>{const out=[],stroke=new BrushStroke(settings,s=>out.push(s));for(const p of samples)stroke.sample(p);stroke.finish();return out;};
const pixels=store=>store.readRect(-64,-64,640,320);

test('a live taper-out repaints its tail every sample and leaves exactly the final stroke',()=>{
  // The provisional tail is painted at full size while drawing, then tapered
  // at pen-up; none of the provisional paint may survive.
  for(const settings of [{size:16,taperIn:30,taperOut:70,color:[200,30,40]},{size:20,taperOut:50,erase:true},{size:18,taperOut:60,tip:'chalk',texture:.6,grain:'paper'}]){
    const seed=()=>{const s=new TileStore();if(settings.erase)for(let tx=-1;tx<9;tx++)for(let ty=-1;ty<4;ty++)s.set(tx,ty,new Uint8ClampedArray([40,90,160,255]));return s;};
    const live=seed(),stroke=new DrawingStroke(live,settings);for(const p of wave(120))stroke.sample(p);stroke.finish();
    const once=seed();new DrawingStroke(once,settings).paint(shapesOf(settings,wave(120)));
    assert.deepEqual(pixels(live),pixels(once),JSON.stringify(settings));
  }
});

test('tapers thin both ends of a stroke to a point and a tap still paints a full dot',()=>{
  const shapes=shapesOf({size:20,pressureSize:false,taperIn:40,taperOut:40},Array.from({length:60},(_,i)=>({x:i*3,y:0})));
  const radii=shapes.map(s=>s.radius);
  assert.ok(radii[0]<2&&radii.at(-1)<2,'both ends come to a point');
  assert.ok(Math.max(...radii)>9.9,'the middle keeps the full size');
  // Spacing follows the shrinking tip, so the tapered ends stay continuous.
  for(let i=1;i<shapes.length;i++)assert.ok(Math.hypot(shapes[i].x-shapes[i-1].x,shapes[i].y-shapes[i-1].y)<=Math.max(.25,Math.max(shapes[i].radius,shapes[i-1].radius)*2*.12)+1e-6);
  const tap=shapesOf({size:20,pressureSize:false,taperIn:40,taperOut:40},[{x:5,y:5}]);
  assert.ok(tap.some(s=>s.radius===10),'a tap is a full-size dot');
});

test('the worker engine paints the same taper stroke as a direct raster',()=>{
  const settings={size:14,taperIn:20,taperOut:60,color:[10,20,30],seed:4},samples=wave(90),engine=new StrokeEngine();engine.begin(1,settings);
  let pending=[],seq=0;const stroke=new BrushStroke(settings,s=>pending.push(s)),tiles=new Map();
  const flush=()=>{const tail=stroke.tailShapes();for(const d of [...pending,...tail])for(const [tx,ty] of TileStore.tilesInRect(d.left,d.top,d.right-d.left,d.bottom-d.top))tiles.set(tx+','+ty,{tx,ty,pixels:null});
    engine.dabs(1,++seq,pending,[...tiles.values()],tail);pending=[];};
  samples.forEach((p,i)=>{stroke.sample(p);if(i%7===6)flush();});stroke.finish();flush();
  const store=new TileStore();for(const c of engine.end(1))if(c.after)store.set(c.tx,c.ty,c.after);
  const direct=new TileStore();new DrawingStroke(direct,settings).paint(shapesOf(settings,samples));
  assert.deepEqual(pixels(store),pixels(direct));
});

test('the pen pressure curve maps pressure monotonically and the identity curve is free',()=>{
  assert.equal(pressureMap(LINEAR_PRESSURE),null);
  const soft=pressureMap([.1,.5,.4,.95]),firm=pressureMap([.6,.05,.9,.5]);
  assert.ok(Math.abs(soft(0))<1e-6&&Math.abs(soft(1)-1)<1e-6);
  assert.ok(soft(.3)>.3&&firm(.3)<.3,'soft lifts light pressure, firm lowers it');
  for(let p=0;p<1;p+=.05)assert.ok(soft(p+.05)>=soft(p)-1e-6);
  const light=shapesOf({size:20,pressureCurve:[.1,.5,.4,.95]},[{x:0,y:0,pressure:.2},{x:40,y:0,pressure:.2}]),linear=shapesOf({size:20},[{x:0,y:0,pressure:.2},{x:40,y:0,pressure:.2}]);
  assert.ok(light[0].radius>linear[0].radius);
});

test('a pulled string holds the tip until the pointer pulls it and ends at the tip',()=>{
  const dabs=[],path=new StrokePath({size:4,stabilization:.5,stabilizerMode:'string',pixelsPerUnit:1},p=>dabs.push(p));
  // String length is 32 px: small jitter around the start never moves the tip.
  path.sample({x:0,y:0});for(let i=0;i<40;i++)path.sample({x:Math.sin(i)*20,y:Math.cos(i)*20});
  assert.ok(dabs.every(d=>Math.hypot(d.x,d.y)<1e-9),'the tip rests while the pointer stays within reach');
  for(let x=0;x<=200;x+=2)path.sample({x,y:0});path.finish();
  assert.ok(Math.abs(dabs.at(-1).x-(200-32))<1e-6,'the stroke ends where the string left the tip');
});

test('dab jitter is a pure function of seed and index',()=>{
  const brush=normalizeBrush({size:30,sizeJitter:.8,opacityJitter:.5,angleJitter:1,scatter:1,roundness:.5,seed:9});
  const a=dabShape(brush,{x:10,y:10,index:7}),b=dabShape(brush,{x:10,y:10,index:7}),c=dabShape(brush,{x:10,y:10,index:8});
  assert.deepEqual(a,b);assert.notDeepEqual(a,c);
  const values=Array.from({length:2000},(_,i)=>jitterAt(3,i,0)),mean=values.reduce((n,v)=>n+v,0)/values.length;
  assert.ok(values.every(v=>v>=0&&v<1)&&Math.abs(mean-.5)<.03);
});

test('brush settings normalize new keys and smudge keeps a round untapered tip',()=>{
  assert.deepEqual(Object.keys(BRUSH_DEFAULTS),BRUSH_KEYS);
  const b=normalizeBrush({tip:'nope',grain:'nope',stabilizerMode:'nope',pressureCurve:[2,-1,'x',0],taperIn:-5});
  assert.equal(b.tip,'round');assert.equal(b.grain,'noise');assert.equal(b.stabilizerMode,'average');assert.deepEqual(b.pressureCurve,LINEAR_PRESSURE);assert.equal(b.taperIn,0);
  const smudge=normalizeBrush({blend:'smudge',tip:'chalk',taperOut:40,texture:.5});
  assert.equal(smudge.tip,'round');assert.equal(smudge.taperOut,0);assert.equal(smudge.texture,0);
  assert.deepEqual(normalizeBrush(b),b,'normalization is idempotent');
});

test('brush textures are deterministic, tileable and fit the atlas',()=>{
  for(const name of [...TEXTURE_TIPS,...TEXTURE_GRAINS])assert.ok(ensureTexture(name)>=0);
  const atlas=brushAtlas();assert.equal(atlas.length,ATLAS_BYTES);
  const copy=atlas.slice();for(const name of [...TEXTURE_TIPS,...TEXTURE_GRAINS])ensureTexture(name);assert.deepEqual(brushAtlas(),copy);
  for(const grain of TEXTURE_GRAINS){const base=ensureTexture(grain);for(const [x,y] of [[3,7],[-5,100],[250,-9]])assert.equal(sampleGrain(atlas,base,x,y,1),sampleGrain(atlas,base,x+256,y-512,1),grain);}
});
