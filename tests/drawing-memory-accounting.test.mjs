import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {TileStore,TILE_BYTES} from '../src/drawing-tiles.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';

const fixture=()=>{const report={figure_types:[]},owner=new DrawingResources(report,{history:false});owner.busy=true;return {owner,add(){const figure=createDrawingFigure();report.figure_types.push(figure);const entry=owner.entry(figure);entry.store=new TileStore();return {figure,entry};}};};
const pixel=()=>new Uint8ClampedArray([12,34,56,255]);
const exact=owner=>{const pixels=new Set();for(const e of owner.surfaces())for(const t of e.store??[])pixels.add(t.pixels);return [...pixels].reduce((n,p)=>n+p.byteLength,0);};

test('warm stroke reservations and cache limits do not rescan resident tiles',()=>{
  const {owner,add}=fixture();let visits=0;
  try{
    const entries=Array.from({length:50},()=>add().entry);
    for(const e of entries){for(let tx=0;tx<20;tx++)e.store.set(tx,0,pixel());e.levels=[e.store.fork()];}
    assert.equal(owner.stats.bytes,1000*TILE_BYTES);
    for(const e of entries){const iterate=e.store[Symbol.iterator].bind(e.store);e.store[Symbol.iterator]=function*(){for(const tile of iterate()){visits++;yield tile;}};}
    for(let i=0;i<30;i++){
      owner.reserve(TILE_BYTES,entries[0]);owner.replacementBytes(entries[0],[{tx:0,ty:0,pixels:pixel()}],'pixels');
      owner.scratchReserved(entries[0],4096);owner.levelsReserved(entries[0]);
    }
    assert.equal(visits,0,'unchanged drawings must not be traversed for each input batch');
  }finally{owner.dispose();}
});

test('memory follows forks, live writes, direct tile-map changes and surface replacement',()=>{
  const {owner,add}=fixture();
  try{
    const a=add().entry,b=add().entry;a.store.set(0,0,pixel());b.store=a.store.fork();
    assert.equal(owner.stats.bytes,TILE_BYTES);
    b.store.writable(0,0).pixels[0]=99;assert.equal(owner.stats.bytes,2*TILE_BYTES);
    b.store.tiles.set('0,0',a.store.get(0,0));assert.equal(owner.stats.bytes,TILE_BYTES);
    const old=b.store;b.store=new TileStore();b.store.set(1,1,pixel());assert.equal(owner.stats.bytes,2*TILE_BYTES);
    old.set(2,2,pixel());assert.equal(owner.stats.bytes,2*TILE_BYTES,'detached surfaces no longer count');
    const shared=owner.transient(a.store),fork=owner.transient(a.store.fork());assert.equal(owner.stats.bytes,2*TILE_BYTES);
    a.store.tiles.clear();assert.equal(owner.stats.bytes,2*TILE_BYTES,'a distinct fork still retains its tile');
    owner.releaseTransient(fork);assert.equal(owner.stats.bytes,TILE_BYTES);owner.releaseTransient(shared);
    b.store.set(2,2,new Uint8ClampedArray(4));assert.equal(owner.stats.bytes,2*TILE_BYTES);b.store.prune();assert.equal(owner.stats.bytes,TILE_BYTES);
    assert.equal(owner.stats.bytes,exact(owner));
  }finally{owner.dispose();assert.equal(owner.stats.bytes,0);}
});

test('replacement accounting preserves buffers shared within the same cel',()=>{
  const {owner,add}=fixture();
  try{
    const e=add().entry;e.store.set(0,0,pixel());e.store.tiles.set('1,0',{...e.store.get(0,0),tx:1});
    assert.equal(owner.stats.bytes,TILE_BYTES);
    const changes=[{tx:0,ty:0,after:pixel()},{tx:1,ty:0,after:pixel()}];
    assert.equal(owner.replacementBytes(e,changes.slice(0,1),'after'),TILE_BYTES,'one alias cannot release the shared buffer');
    assert.equal(owner.replacementBytes(e,changes,'after'),TILE_BYTES,'replacing both releases the old buffer once');
    owner.tileBudget=owner.hardBudget=TILE_BYTES;owner.flush=async()=>{};
    assert.throws(()=>owner.reserve(owner.replacementBytes(e,changes.slice(0,1),'after'),e),/memory is full/);
    assert.equal(e.store.pixel(0,0)[0],12,'rejected reservations preserve pixels');
  }finally{owner.dispose();}
});

test('mixed cel histories retain exact accounting across repeated sharing and deletion',()=>{
  const {owner,add}=fixture();const entries=Array.from({length:8},()=>add().entry);let seed=71;
  const next=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  try{
    for(let i=0;i<500;i++){
      const a=entries[next(entries.length)],b=entries[next(entries.length)],tx=next(8),kind=next(6);
      if(kind===0)a.store.set(tx,0,pixel());
      if(kind===1)a.store.delete(tx,0);
      if(kind===2)a.store.writable(tx,0).pixels[0]=next(256);
      if(kind===3)b.store=a.store.fork();
      if(kind===4)b.store=a.store;
      if(kind===5)a.store.tiles.clear();
      assert.equal(owner.stats.bytes,exact(owner),`memory after mutation ${i}`);
    }
  }finally{owner.dispose();}
});

test('retired entries and disposed owners release tile observers immediately',()=>{
  const a=fixture(),b=fixture(),entry=a.add().entry,peer=b.add().entry;
  entry.store.set(0,0,pixel());const store=entry.store;peer.store=store;
  try{
    assert.equal(a.owner.stats.bytes,TILE_BYTES);assert.equal(b.owner.stats.bytes,TILE_BYTES);
    assert.equal(store.pixelListeners.size,2);
    a.owner.report.figure_types=[];a.owner.collect();assert.equal(store.pixelListeners.size,1);
    store.set(1,0,pixel());assert.equal(b.owner.stats.bytes,2*TILE_BYTES);
    b.owner.dispose();assert.equal(store.pixelListeners.size,0);
    assert.equal(b.owner.pixelMemory.references.size,0,'the memory index retains no closed pixels');
  }finally{a.owner.dispose();b.owner.dispose();}
});

test('scratch eviction counts pinned canvases and worker bitmaps in one budget',()=>{
  const {owner,add}=fixture(),e=add().entry,closed=[];
  const scratch=(used,pinned=false)=>({used,pinned,canvas:{width:64,height:64}}),pinned=scratch(0,true),old=scratch(1),keep=scratch(2);
  e.used=0;e._scratches=new Map([['pinned',pinned],['old',old],['keep',keep]]);owner.scratchBudget=3*TILE_BYTES;
  owner.previews={bytes:TILE_BYTES,cache:new Map([['worker',{bytes:TILE_BYTES}]]),remove(key){this.bytes-=this.cache.get(key).bytes;this.cache.delete(key);closed.push(key);},drop(){},dispose(){}};
  try{
    assert.equal(owner.scratchReserved(e,TILE_BYTES,keep),true);
    assert.equal(old.canvas.width,1);assert.equal(pinned.canvas.width,64);assert.equal(keep.canvas.width,64);
    assert.deepEqual(closed,['worker']);assert.equal(owner.stats.scratchBytes,2*TILE_BYTES);
    assert.equal(owner.scratchReserved(e,2*TILE_BYTES,keep),false,'protected surfaces cannot be evicted to fake available space');
    assert.equal(owner.stats.scratchBytes,2*TILE_BYTES);
  }finally{owner.dispose();}
});

test('installing an empty result releases the replaced store without another reservation',()=>{
  const {owner,add}=fixture(),{figure,entry}=add();
  try{
    entry.store.set(0,0,pixel());const old=entry.store;assert.equal(owner.stats.bytes,TILE_BYTES);
    owner.install(figure,[]);
    assert.equal(old.pixelListeners.size,0);assert.equal(owner.pixelMemory.bytes,0);
    old.set(1,0,pixel());assert.equal(owner.pixelMemory.bytes,0);
  }finally{owner.dispose();}
});
