import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {initializeLayerSheet} from '../src/editor-layer-sheet.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {vfxProperty,validateVfxValue} from '../src/vfx.mjs';
import {VFX_REGISTRY,isGeneratorType} from '../src/vfx-registry.mjs';
import {buildGeneratorBatch,evaluateParticle,BLEND,SHAPE,RECORD_FLOATS} from '../src/vfx-generators.mjs';
import {PARTICLE_LOOKS} from '../src/vfx-generator-styles.mjs';
import {atlasRow,ATLAS_ROWS,ATLAS_LEVELS,CELL,COLUMNS,MATERIALS} from '../src/vfx-generator-atlas.mjs';
import {GeneratorAnchors} from '../src/vfx-generator-anchors.mjs';

/** Figure 1 stands at x=160, figure 2 at x=520, on a dark stage. */
function fixture(){
 const report=emptyDocument(),fig=report.figure_types[0];
 report.keyframes=[0,1,2,3,4,5].map(()=>{const f=createFrame([createObject(fig,1,160,300),createObject(fig,2,520,300)],20);f._stykBackgroundColor=0xff101018;return f;});
 const e=new Editor({demo:false}).load(report);initializeLayerSheet(e.report);e._invalidate({timing:true});return e;
}
function batchAt(e,tick){e.seek(tick);const frame=e.evaluatedFrame;return buildGeneratorBatch(e.report,frame,buildGeometry(e.report,frame),{sampler:new GeneratorAnchors()});}
function particles(batch,filter=()=>true){const out=[],p={};for(const draw of batch?.draws??[])if(filter(draw))for(let i=0;i<draw.count;i++)if(evaluateParticle(batch,draw,i,p))out.push({draw,i,...p});return out;}
const addEffect=(e,type,params,target={kind:'figure',uid:1},timing={start:0,duration:60})=>{const id=e.addVfxClip(target,type,timing),clip=e.getVfxClips().find(c=>c.id===id);e.setVfxClipParameters(id,clip.effects[0].id,{seed:9,...params});return id;};
const digest=strip=>createHash('sha256').update(Buffer.concat(strip.levels.map(l=>Buffer.from(l.data)))).digest('hex');

test('particle materials are reduced levels of cells that stay clear of their neighbours',()=>{
 for(let row=0;row<ATLAS_ROWS;row++){
  const {levels}=atlasRow(row);assert.equal(levels.length,ATLAS_LEVELS);
  levels.forEach((l,i)=>{assert.equal(l.width,(CELL*COLUMNS)>>i);assert.equal(l.height,CELL>>i);assert.equal(l.data.length,l.width*l.height*2);});
  const base=levels[0];
  for(let k=0;k<COLUMNS;k++){
   let covered=0,edge=0;
   for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){const a=base.data[(y*base.width+k*CELL+x)*2+1];covered+=a>0;if(x===0||y===0||x===CELL-1||y===CELL-1)edge=Math.max(edge,a);}
   assert.ok(covered>CELL*CELL*.02,`row ${row} cell ${k} has a visible shape`);assert.equal(edge,0,`row ${row} cell ${k} leaves its border clear`);
  }
 }
 for(const m of Object.values(MATERIALS))assert.ok(m.row<ATLAS_ROWS&&m.col+m.count<=COLUMNS);
});

test('workers generate byte-identical materials',async()=>{
 const url=new URL('../src/vfx-generator-atlas.mjs',import.meta.url).href;
 const code=`const {parentPort}=require('node:worker_threads'),{createHash}=require('node:crypto');import(${JSON.stringify(url)}).then(({atlasRow})=>parentPort.postMessage([0,7,16].map(r=>createHash('sha256').update(Buffer.concat(atlasRow(r).levels.map(l=>Buffer.from(l.data)))).digest('hex'))));`;
 const remote=await new Promise((resolve,reject)=>{const w=new Worker(code,{eval:true});w.once('message',m=>{resolve(m);w.terminate();});w.once('error',reject);});
 assert.deepEqual(remote,[0,7,16].map(r=>digest(atlasRow(r))));
});

test('every style of every generated effect draws finite particles from valid cells',()=>{
 const types=Object.entries(VFX_REGISTRY).filter(([type])=>isGeneratorType(type));
 for(const [type,definition] of types){
  const styles=definition.params.style?.options??definition.params.look.options;
  for(const [index,name] of styles.entries()){
   const e=fixture(),param=definition.params.style?'style':'look',applies=definition.params.style?.applies?.[index]??{};
   addEffect(e,type,{[param]:index,...applies,...(type==='beam'?{aimUid:2,aimHandle:0}:{})});
   const tick=type==='beam'?(applies.charge??12)+(applies.travel??6)+6:type==='explosion'?12:30,batch=batchAt(e,tick);
   assert.ok(batch?.draws.length,`${type} ${name} draws`);
   const live=particles(batch);if(!batch.draws.every(d=>d.shape===SHAPE.beam||d.shape===SHAPE.arc))assert.ok(live.length>0,`${type} ${name} has live particles`);
   for(const p of live){
    assert.ok([p.x,p.y,p.size,p.alpha,p.rotation].every(Number.isFinite),`${type} ${name} particle values are finite`);
    if(p.draw.shape===SHAPE.sprite){const o=p.draw.record*RECORD_FLOATS,code=batch.records[o+113];assert.equal(p.draw.material,batch.records[o+112]-1);assert.ok(p.variant>=Math.floor(code/16)&&p.variant<Math.floor(code/16)+code%16,`${type} ${name} variant ${p.variant} is one of its cells`);}
   }
  }
 }
});

test('style choices suggest valid values for every option',()=>{
 for(const [type,definition] of Object.entries(VFX_REGISTRY))for(const [param,d] of Object.entries(definition.params)){
  if(!d.applies)continue;
  assert.equal(d.applies.length,d.options.length,`${type}.${param} suggests values for each option`);
  for(const values of d.applies)for(const [key,value] of Object.entries(values))validateVfxValue(vfxProperty(type,'x',key),value);
 }
 assert.deepEqual(VFX_REGISTRY.particles.params.look.options,PARTICLE_LOOKS.map(l=>l.name),'saved look indices match the renderer');
});

test('echoes, halos and outlines redraw the same particles beneath them',()=>{
 const e=fixture();addEffect(e,'particles',{look:MATERIAL_LOOK('Cartoon star'),rate:6,life:30,speed:3,trail:2,glow:1,outline:1,outlineWidth:2,outlineColor:0x201020});
 const batch=batchAt(e,20),[echo2,echo1,halo,outline,fill]=batch.draws,o=d=>d.record*RECORD_FLOATS;
 assert.equal(batch.draws.length,5);assert.ok(batch.draws.every(d=>d.count===fill.count));
 assert.deepEqual([echo2,echo1].map(d=>batch.records[o(d)+54]),[16,18],'echoes show earlier frames, oldest first');
 assert.equal(halo.shape,SHAPE.disc);assert.equal(outline.blend,BLEND.normal);assert.equal(outline.shape,SHAPE.sprite);
 const at=(draw,i)=>{const p={};return evaluateParticle(batch,draw,i,p)?p:null;};
 const earlier=batchAt(e,18),past=(i)=>{const p={};return evaluateParticle(earlier,earlier.draws.at(-1),i,p)?p:null;};
 let checked=0;
 for(let i=0;i<fill.count;i++){
  const f=at(fill,i);if(!f)continue;
  assert.ok(Math.abs(at(halo,i).size-f.size*2.8)<1e-6);assert.ok(Math.abs(at(outline,i).size-(f.size+2))<1e-6);
  const a=at(echo1,i),b=past(i);if(a&&b){assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1e-3,'an echo is the particle where it was two frames ago');checked++;}
 }
 assert.ok(checked>3);
});
const MATERIAL_LOOK=name=>PARTICLE_LOOKS.findIndex(l=>l.name===name);

test('swirling particles orbit their emitter at a constant distance',()=>{
 const e=fixture();addEffect(e,'particles',{shape:1,radius:40,speed:0,spread:0,swirl:12,rate:4,life:40,variation:0,space:1});
 const batch=batchAt(e,30),anchor=[batch.records[36],batch.records[37]],live=particles(batch);
 assert.ok(live.length>10);
 for(const p of live)assert.ok(Math.abs(Math.hypot(p.x-anchor[0],p.y-anchor[1])-40)<.01,'orbit keeps the emitter radius');
 const angles=new Set(live.map(p=>Math.round(Math.atan2(p.y-anchor[1],p.x-anchor[0])*10)));assert.ok(angles.size>5);
});

test('fire breath streams toward its aim and reaches it',()=>{
 const e=fixture();addEffect(e,'beam',{style:5,...VFX_REGISTRY.beam.params.style.applies[5],aimUid:2,aimHandle:0});
 const batch=batchAt(e,30),flames=particles(batch,d=>d.material===MATERIALS.flame.row),origin=batch.records[36+batch.draws.find(d=>d.material===MATERIALS.flame.row).record*RECORD_FLOATS];
 assert.ok(flames.length>20);
 assert.ok(flames.filter(p=>p.vx>0).length>flames.length*.9,'flames travel toward the aim');
 assert.ok(Math.max(...flames.map(p=>p.x))-origin>(520-160)*.7,'the stream reaches most of the way to its target');
});

test('smoke rises and drifts with the wind',()=>{
 const e=fixture();addEffect(e,'smoke',{wind:3,rise:1.5,amount:4,life:60,spread:0});
 const batch=batchAt(e,50),live=particles(batch),ax=batch.records[36],ay=batch.records[37];
 const mean=k=>live.reduce((n,p)=>n+p[k],0)/live.length;
 assert.ok(live.length>50);assert.ok(mean('x')-ax>20,'wind carries smoke sideways');assert.ok(ay-mean('y')>20,'smoke rises');
 assert.ok(live.every(p=>p.draw.material===MATERIALS.smoke.row));
});

test('a start delay holds one effect of a group back',()=>{
 const e=fixture(),id=e.addVfxClip({kind:'figure',uid:1},'particles',{start:0,duration:48}),burst=e.addVfxGroupEffect(id,'explosion');
 e.setVfxClipParameters(id,burst,{style:7,delay:20});
 const magic=b=>particles(b).filter(p=>p.draw.material===MATERIALS.bokeh.row).length;
 assert.equal(magic(batchAt(e,10)),0,'the delayed burst has not started');
 assert.ok(magic(batchAt(e,26))>0,'it bursts after its delay');
});

test('aura ground effects are optional and off by default',()=>{
 const grounded=b=>b.draws.some(d=>b.records[d.record*RECORD_FLOATS+28]===5);
 for(let style=0;style<8;style++){
  const e=fixture();addEffect(e,'aura',{style});assert.equal(grounded(batchAt(e,30)),false,`style ${style} keeps off the ground`);
  const f=fixture();addEffect(f,'aura',{style,dust:1});assert.ok(grounded(batchAt(f,30)),`style ${style} has a ground effect when enabled`);
 }
});

