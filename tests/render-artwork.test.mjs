import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtworkRegistry} from '../src/render-artwork.mjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

test('unshared artwork identities cannot alias between independent worker realms',async()=>{
  // Independent module instances model worker-local counters starting at zero.
  const {ArtworkRegistry:First}=await import('../src/render-artwork.mjs?realm=first');
  const {ArtworkRegistry:Second}=await import('../src/render-artwork.mjs?realm=second');
  const a=new First({maxBytes:1}),b=new Second({maxBytes:1}),{g,moved}=pair();
  moved.obj.futureRenderFlag='different artwork';
  const left=a.get(g,g.drawables),right=b.get(moved,moved.drawables);
  assert.equal(left.definition.unshared,true);assert.equal(right.definition.unshared,true);
  assert.notEqual(await a.contentKey(left),await b.contentKey(right));
});

function pair(){
  const e=new Editor({demo:false});e.addFigure();const g=e.geometry.objects.get(0);
  const translate=p=>({x:p.x+32,y:p.y-16});
  const obj={...g.obj,unique_id:999,object_slot:1,root_x:g.obj.root_x+32,root_y:g.obj.root_y-16,record_offset:987654};
  const moved={...g,obj,root:translate(g.root)};
  moved.drawables=g.drawables.map(item=>({...item,obj,slot:1,start:item.start&&translate(item.start),end:item.end&&translate(item.end),points:item.points?.map(translate)}));
  return{e,g,moved};
}
test('exact translated artwork shares content identity without sharing document objects',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  assert.notEqual(g.obj,moved.obj);assert.equal(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  assert.equal(cache.stats.hits,1);
});
test('subpixel geometry differences are not quantized away',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  const first=cache.get(g,g.drawables);moved.drawables[0].points[0]={...moved.drawables[0].points[0],x:moved.drawables[0].points[0].x+1e-9};
  assert.notEqual(first,cache.get(moved,moved.drawables));
});

test('surface depth and facing participate in exact artwork identity',()=>{
  for(const [left,right] of [
    [{depthValues:[1,2,3]},{depthValues:[1,2,3+1e-9]}],
    [{depthValues:[]},{}], [{culled:false},{culled:true}], [{culled:false},{}],
    [{depthValues:[null]},{depthValues:[0]}],
  ]){
    const {g,moved}=pair(),cache=new ArtworkRegistry();
    Object.assign(g.drawables[0],left);Object.assign(moved.drawables[0],right);
    assert.notEqual(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  }
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  Object.assign(g.drawables[0],{depthValues:[1,2,3],culled:false});Object.assign(moved.drawables[0],{depthValues:[1,2,3],culled:false});
  assert.equal(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
});

test('runtime cache payloads do not duplicate the exact evaluated artwork signature',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  g.obj.runtime_segments=[{length:1}];moved.obj.runtime_segments=[{length:999,cacheOnly:true}];
  assert.equal(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  moved.drawables=moved.drawables.map((item,i)=>i?item:{...item,length:item.length+1});
  assert.notEqual(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
});
test('instance styles, tint, image flags and unknown future properties distinguish artwork',()=>{
  for(const change of [o=>o.image_text_flags=1,o=>o.futureRenderFlag=123]){
    const {g,moved}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);change(moved.obj);
    assert.notEqual(first,cache.get(moved,moved.drawables));
  }
  const {g,moved}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);
  moved.drawables[0]={...moved.drawables[0],rgb:[1,2,3]};
  assert.notEqual(first,cache.get(moved,moved.drawables));
});
test('definition snapshots detect in-place edits and history reconstruction',()=>{
  const {e,g}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);
  g.fig.segments[0].thickness+=2;cache.begin();
  const next=buildGeometry(e.report,e.frame).objects.get(0);
  assert.notEqual(first,cache.get(next,next.drawables));
});
test('registry entries and coordinate bytes remain bounded',()=>{
  const {g}=pair(),cache=new ArtworkRegistry({maxEntries:2,maxBytes:1024*1024});
  for(let i=0;i<10;i++){const next={...g,obj:{...g.obj,futureRenderFlag:i}};cache.get(next,next.drawables);}
  assert.equal(cache.lru.size,2);assert.ok(cache.bytes<=cache.maxBytes);assert.equal(cache.stats.evictions,8);
});

test('non-finite and non-numeric attributes cannot alias absent or finite values',()=>{
  for(const [a,b] of [[undefined,NaN],[null,Infinity],[1,'1']]){
    const {g,moved}=pair(),cache=new ArtworkRegistry();
    g.drawables[0]={...g.drawables[0],opacity:a};moved.drawables[0]={...moved.drawables[0],opacity:b};
    assert.notEqual(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  }
});

test('embedded media payloads fingerprint once and keep artwork shareable',()=>{
  const payload='x'.repeat(2*1024*1024);
  const fig={segments:[],image_assets:[{data_url:payload,anchor_length:4,anchor_start:{x:0,y:0}}]};
  const g={obj:{unique_id:1},fig,root:{x:0,y:0},drawables:[{type:'image',asset:fig.image_assets[0],start:{x:0,y:0},end:{x:4,y:0},seg:{},index:0}]};
  const cache=new ArtworkRegistry({maxBytes:4*1024*1024});
  const artwork=cache.get(g,g.drawables);
  assert.ok(!artwork.definition.unshared,'a multi-megabyte payload must not make the figure definition unshareable');
  assert.ok(artwork.metadata.length<64*1024,'the payload must not be serialized into the per-packet signature');
  const moved={...g,drawables:g.drawables.map(item=>({...item}))};
  assert.equal(cache.get(moved,moved.drawables),artwork);
  const different={...g,drawables:g.drawables.map(item=>({...item,asset:{...item.asset,data_url:payload+'y'}}))};
  assert.notEqual(cache.get(different,different.drawables),artwork);
});

test('embedded media short-hash collisions never share local or cross-worker artwork',async()=>{
  const payloads=['0w7kc1j','1dvdycr'].map(suffix=>'x'.repeat(600)+suffix);
  const fnv=text=>{let h=2166136261;for(const c of text)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
  assert.equal(fnv(payloads[0]),fnv(payloads[1]));
  const make=payload=>{const asset={data_url:payload,anchor_length:4},fig={segments:[],image_assets:[asset]};
    return {obj:{unique_id:1},fig,root:{x:0,y:0},drawables:[{type:'image',asset,start:{x:0,y:0},end:{x:4,y:0},seg:{},index:0}]};};
  const a=make(payloads[0]),b=make(payloads[1]),registry=new ArtworkRegistry();
  const left=registry.get(a,a.drawables),right=registry.get(b,b.drawables);
  assert.notEqual(left,right);
  assert.notEqual(await registry.contentKey(left),await registry.contentKey(right));
  const other=new ArtworkRegistry();assert.equal(await registry.contentKey(left),await other.contentKey(other.get(a,a.drawables)));
});

test('image metadata edits invalidate artwork even when embedded bytes are unchanged',async()=>{
  const asset={data_url:'x'.repeat(600),anchor_length:4,display_width:80},fig={segments:[],image_assets:[asset]};
  const g={obj:{unique_id:1},fig,root:{x:0,y:0},drawables:[{type:'image',asset,start:{x:0,y:0},end:{x:4,y:0},seg:{},index:0}]};
  const registry=new ArtworkRegistry(),before=registry.get(g,g.drawables),key=await registry.contentKey(before);
  asset.display_width=120;registry.begin(2);
  const after=registry.get(g,g.drawables);
  assert.notEqual(after,before);assert.notEqual(await registry.contentKey(after),key);
});

test('cross-packet content identity survives registry eviction and keeps subpixel differences',async()=>{
  const {g}=pair(),cache=new ArtworkRegistry({maxEntries:1});
  const first=cache.get(g,g.drawables),key=await cache.contentKey(first);
  cache.get({...g,obj:{...g.obj,futureRenderFlag:1}},g.drawables);assert.equal(cache.stats.evictions,1);
  const rebuilt={...g},next=cache.get(rebuilt,rebuilt.drawables);
  assert.notEqual(next.id,first.id);assert.equal(await cache.contentKey(next),key);
  cache.clear();const afterClear={...g};assert.equal(await cache.contentKey(cache.get(afterClear,afterClear.drawables)),key);
  const changed={...g,drawables:g.drawables.map((item,i)=>i?item:{...item,thickness:item.thickness+1e-9})};
  assert.notEqual(await cache.contentKey(cache.get(changed,changed.drawables)),key);
});

test('content keys are synchronous, content-addressed and independent of WebCrypto',()=>{
  const {g,moved}=pair(),first=new ArtworkRegistry(),second=new ArtworkRegistry(),saved=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true,writable:true});
  try{
    const key=first.contentKey(first.get(g,g.drawables));
    assert.match(key,/^h128:[0-9a-f]{32}$/);
    // A translated copy has identical object-local artwork, so a separate worker registry agrees.
    assert.equal(second.contentKey(second.get(moved,moved.drawables)),key);
    const changed={...g,drawables:g.drawables.map(item=>({...item,thickness:(item.thickness||1)+.25}))};
    assert.notEqual(first.contentKey(first.get(changed,changed.drawables)),key);
  }finally{Object.defineProperty(globalThis,'crypto',saved);}
});

test('pose inputs identify artwork through their evaluated drawables only',()=>{
  // Joint angles, lengths and bends are recorded exactly by the drawables; the
  // same drawn pose with different pose arrays is the same artwork.
  const {g,moved}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);
  moved.obj.angles=(moved.obj.angles||[]).map(angle=>angle+Math.PI*2);moved.obj.lengths=[1,2,3];moved.obj.bends=[.5];moved.obj.len_flag=1;moved.obj.bend_flag=1;
  assert.equal(cache.get(moved,moved.drawables),first);
  const bent={...moved,drawables:moved.drawables.map((item,i)=>i?item:{...item,bend:(item.bend||0)+1e-6})};
  assert.notEqual(cache.get(bent,bent.drawables),first);
});
test('unknown drawable fields distinguish artwork after a known layout was verified',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);
  const unknown={...moved,drawables:moved.drawables.map((item,i)=>i?item:{...item,futureStroke:'dashed'})};
  assert.notEqual(cache.get(unknown,unknown.drawables),first);
  const other={...moved,drawables:moved.drawables.map((item,i)=>i?item:{...item,futureStroke:'dotted'})};
  assert.notEqual(cache.get(other,other.drawables),cache.get(unknown,unknown.drawables));
  assert.equal(cache.get(moved,moved.drawables),first,'the verified layout still shares exact artwork');
});
