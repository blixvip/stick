import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorRasterCache} from '../src/renderer-raster-cache.mjs';

function resource(resolution = 1, generation = 0, bytes = 10) {
  return {resolution, generation, bytes, texture: {destroyed: 0, destroy() {this.destroyed++;}}};
}

test('covered crops reuse pixels across pan boundaries and keep region identities during image invalidation',()=>{
  const cache=new EditorRasterCache({maxBytes:100}),artwork={},bounds={x:0,y:0,width:100,height:100};
  const a={...resource(32),regionKey:'a',contentKey:'drawing',imageURLs:[],raster:{x:0,y:0,width:30,height:30,pixelScale:32,cropped:true}};
  const b={...resource(32),regionKey:'b',contentKey:'drawing',imageURLs:[],raster:{x:40,y:40,width:30,height:30,pixelScale:32,cropped:true}};
  cache.set(artwork,a);cache.set(artwork,b);
  assert.equal(cache.get(artwork,32,0,'drawing','a'),a);
  assert.equal(cache.covered(artwork,32,0,'drawing',bounds,{x:5,y:5,width:20,height:20}),a);
  assert.equal(cache.covered(artwork,32,0,'other',bounds,{x:5,y:5,width:20,height:20}),undefined);
  assert.equal(cache.covered(artwork,32,0,'drawing',bounds,{x:25,y:25,width:20,height:20}),undefined);
  const lease=cache.lease([a]);cache.maxBytes=10;cache.retain(new Set([b]),0);
  assert.equal(a.texture.destroyed,0,'An old cropped layout remains protected until publication.');
  lease.release();cache.retain(new Set([b]),0);assert.equal(a.texture.destroyed,1);
  cache.invalidateImages(new Set(['unrelated']),0,1);
  assert.equal(cache.get(artwork,32,1,'drawing','b'),b);
  cache.clear();assert.equal(b.texture.destroyed,1);
});

test('image changes retain independent raster variants and invalidate shared image dependencies', () => {
  const cache = new EditorRasterCache({maxBytes:30}), artwork = {}, unrelated = {};
  const a = {...resource(),imageURLs:['a','shared']}, b = {...resource(2),imageURLs:['a','shared']};
  const c = {...resource(),imageURLs:['b']}, vector = {...resource(),imageURLs:[]}, unknown = resource();
  cache.set(artwork,a); cache.set(artwork,b); cache.set(unrelated,c); cache.set({},vector); cache.set({},unknown);
  const lease = cache.lease([a,c]);
  cache.invalidateImages(new Set(['a']),0,1);
  assert.equal(a.texture.destroyed,1); assert.equal(b.texture.destroyed,1); assert.equal(unknown.texture.destroyed,1);
  assert.equal(cache.get(unrelated,1,1),c); assert.equal(cache.get(unrelated,1,0),undefined);
  assert.equal(vector.texture.destroyed,0); assert.equal(cache.bytes,20);
  lease.release(); cache.retain(new Set([c]),1);
  cache.invalidateImages(new Set(['b']),1,2); assert.equal(c.texture.destroyed,1);
  cache.clear(); assert.equal(vector.texture.destroyed,1); assert.equal(cache.bytes,0);
});

test('selective image invalidation cannot revive a texture from an older generation', () => {
  const cache = new EditorRasterCache(), artwork = {};
  const old = {...resource(),imageURLs:[]}, current = {...resource(1,1),imageURLs:[]};
  cache.set(artwork,old); cache.set(artwork,current);
  cache.invalidateImages(new Set(['other']),1,2);
  assert.equal(old.texture.destroyed,1); assert.equal(cache.get(artwork,1,2),current);
  cache.clear(); assert.equal(current.texture.destroyed,1);
});

test('resolution variants survive layout departures and return without replacing siblings', () => {
  const cache = new EditorRasterCache({maxBytes: 100}), artwork = {};
  const low = resource(), high = resource(2);
  cache.set(artwork, low); cache.retain(new Set([low]), 0);
  cache.set(artwork, high); cache.retain(new Set([high]), 0);
  assert.equal(cache.get(artwork, 1, 0), low);
  assert.equal(cache.get(artwork, 2, 0), high);
  cache.retain(new Set(), 0);
  assert.equal(cache.bytes, 20);
  assert.equal(low.texture.destroyed + high.texture.destroyed, 0);
  cache.clear(); cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.get(artwork, 1, 0), undefined);
  assert.equal(low.texture.destroyed, 1);
  assert.equal(high.texture.destroyed, 1);
});

test('publication protects the whole active layout and evicts unused resources in LRU order', () => {
  const cache = new EditorRasterCache({maxBytes: 30}), keys = [{}, {}, {}, {}];
  const values = keys.map(key => {const value = resource(); cache.set(key, value); return value;});
  // Allocation can exceed the budget while assembling the next layout.
  assert.equal(cache.bytes, 40);
  cache.get(keys[0], 1, 0);
  cache.retain(new Set([values[1]]), 0);
  assert.equal(values[2].destroyed, true);
  assert.equal(values[0].destroyed, undefined);
  assert.equal(cache.bytes, 30);
  assert.equal(cache.get(keys[2], 1, 0), undefined);
  assert.deepEqual(cache.previous(keys[2]), {resolution: 1, generation: 0, destroyed: true});
  cache.maxBytes = 0;
  cache.retain(new Set([values[0], values[1]]), 0);
  assert.equal(cache.bytes, 20);
  assert.equal(cache.stats.activeBytes, 20);
  cache.retain(new Set(), 0);
  assert.equal(cache.bytes, 0);
  assert.ok(values.every(value => value.texture.destroyed === 1));
});

test('generation changes cannot reuse stale pixels and entry limits bound tiny resources', () => {
  const cache = new EditorRasterCache({maxEntries: 1}), key = {};
  const before = resource(), after = resource(1, 1), other = resource(2, 1);
  cache.set(key, before);
  assert.equal(cache.get(key, 1, 1), undefined);
  cache.set(key, after); cache.retain(new Set([after]), 1);
  assert.equal(before.texture.destroyed, 1);
  assert.equal(cache.get(key, 1, 0), undefined);
  cache.set(key, other); cache.retain(new Set([other]), 1);
  assert.equal(after.texture.destroyed, 1);
  assert.equal(cache.lru.size, 1);
  assert.throws(() => cache.set(key, resource(2, 1)), /already exists/);
});

test('preparation leases protect both layouts until publication or cancellation',()=>{
  const cache=new EditorRasterCache({maxBytes:0}),first=resource(),next=resource();
  cache.set({},first);const lease=cache.lease([first]);cache.set({},next);lease.add(next);
  cache.retain(new Set([next]),0);assert.equal(first.destroyed,undefined);assert.equal(cache.bytes,20);
  lease.release();lease.release();cache.retain(new Set([next]),0);
  assert.equal(first.destroyed,true);assert.equal(next.destroyed,undefined);
  cache.clear();assert.equal(next.texture.destroyed,1);assert.equal(cache.leases.size,0);
});

test('drawing content variants preserve leased rasters until the new scene is published',()=>{
  const cache=new EditorRasterCache({maxEntries:1}),artwork={},cold={...resource(),contentKey:'cold'},decoded={...resource(),contentKey:'decoded'};
  cache.set(artwork,cold);const lease=cache.lease([cold]);cache.set(artwork,decoded);
  assert.equal(cache.get(artwork,1,0,'decoded'),decoded);assert.equal(cache.get(artwork,1,0,'cold'),cold);
  cache.retain(new Set([decoded]),0);assert.equal(cold.destroyed,undefined);lease.release();
  cache.retain(new Set([decoded]),0);assert.equal(cold.destroyed,true);assert.equal(decoded.destroyed,undefined);cache.clear();
});

test('evicted recyclable textures are reused best-fit, stay bounded and are released on clear', () => {
  const cache = new EditorRasterCache({maxBytes: 0, maxRecycledBytes: 250});
  const recyclable = (width, height, generation = 0) => ({...resource(1, generation, width * height), poolClass: 'vector:bgra8unorm', allocatedWidth: width, allocatedHeight: height});
  const small = recyclable(10, 10), large = recyclable(12, 12), exact = resource();
  for (const item of [small, large, exact]) cache.set({}, item);
  cache.retain(new Set(), 1);
  assert.equal(exact.texture.destroyed, 1, 'textures without a recycling class are destroyed');
  assert.equal(small.texture.destroyed + large.texture.destroyed, 0); assert.equal(cache.recycledBytes, 244);
  assert.equal(cache.take('bitmap:rgba8unorm', 9, 9), undefined, 'classes never mix');
  assert.equal(cache.take('vector:bgra8unorm', 20, 20), undefined, 'too small');
  assert.equal(cache.take('vector:bgra8unorm', 9, 9).texture, small.texture, 'smallest allocation that fits');
  assert.equal(cache.take('vector:bgra8unorm', 5, 5), undefined, 'at most twice the requested area');
  const extra = recyclable(11, 11); cache.set({}, extra); cache.retain(new Set(), 2);
  assert.equal(large.texture.destroyed, 1, 'the oldest recycled texture makes room'); assert.ok(cache.recycledBytes <= 250);
  cache.clear(); assert.equal(extra.texture.destroyed, 1); assert.equal(cache.recycledBytes, 0);
});

test('navigation finds the sharpest retained raster of the whole artwork, never a crop or stale content',()=>{
  const cache=new EditorRasterCache({maxBytes:100}),artwork={},other={};
  const coarse={...resource(1),contentKey:'drawing'},fitted={...resource(2.38),contentKey:'drawing'};
  const crop={...resource(45),contentKey:'drawing',regionKey:'crop',raster:{x:0,y:0,width:30,height:30,pixelScale:45,cropped:true}};
  const stale={...resource(8,0),contentKey:'earlier'},elsewhere={...resource(4),contentKey:'drawing'};
  cache.set(artwork,coarse);cache.set(artwork,fitted);cache.set(artwork,crop);cache.set(artwork,stale);cache.set(other,elsewhere);
  assert.equal(cache.sharpest(artwork,0,'drawing'),fitted);
  assert.equal(cache.sharpest(artwork,1,'drawing'),undefined,'Another resource generation has no usable pixels.');
  assert.equal(cache.sharpest({},0,'drawing'),undefined);
  // Presenting the retained raster makes it the most recently used entry.
  cache.maxBytes=10;cache.retain(new Set(),0);
  assert.equal(fitted.texture.destroyed,0);assert.equal(crop.texture.destroyed,1);assert.equal(coarse.texture.destroyed,1);
  cache.delete(fitted);assert.equal(cache.sharpest(artwork,0,'drawing'),undefined);
  cache.clear();
});

test('a pan reuses the sharpest retained raster that covers its view, including a crop',()=>{
  const cache=new EditorRasterCache({maxBytes:100}),artwork={},bounds={x:0,y:0,width:100,height:100};
  const fitted={...resource(2),contentKey:'d'};
  const near={...resource(40),contentKey:'d',regionKey:'a',raster:{x:0,y:0,width:30,height:30,pixelScale:40,cropped:true}};
  const far={...resource(64),contentKey:'d',regionKey:'b',raster:{x:60,y:60,width:30,height:30,pixelScale:64,cropped:true}};
  cache.set(artwork,fitted);cache.set(artwork,near);cache.set(artwork,far);
  assert.equal(cache.sharpest(artwork,0,'d',bounds,{x:5,y:5,width:10,height:10}),near);
  assert.equal(cache.sharpest(artwork,0,'d',bounds,{x:65,y:65,width:10,height:10}),far);
  assert.equal(cache.sharpest(artwork,0,'d',bounds,{x:40,y:40,width:10,height:10}),fitted,'Crops that miss the view do not count.');
  assert.equal(cache.sharpest(artwork,0,'d'),fitted,'Without a view only the whole artwork counts.');
  cache.clear();
});

