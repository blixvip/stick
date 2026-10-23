import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {initializeLayerSheet} from '../src/editor-layer-sheet.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateVfxOwner,createVfx,activeVfx} from '../src/vfx.mjs';
import {validateVfxClips,vfxRenderFrame,vfxClipActiveAt} from '../src/vfx-clips.mjs';
import {VFX_PRESETS,presetAvailable} from '../src/vfx-presets.mjs';
import {effectAvailable,isGeneratorType} from '../src/vfx-registry.mjs';
import {buildGeneratorBatch,evaluateParticle,generatorClipTail,generatorClipActiveAt,generatorSchedule,scheduleWalker,backgroundIsLight,rampColor,generatorBatchBounds,BLEND,RECORD_FLOATS} from '../src/vfx-generators.mjs';
import {GeneratorAnchors} from '../src/vfx-generator-anchors.mjs';
import {MATERIALS} from '../src/vfx-generator-atlas.mjs';
import {filterVfxClips} from '../src/vfx-clip-inspector.mjs';

/** Figure 1 walks right 40px per 20-frame key; figure 2 stands still. */
function fixture({dark=false}={}){
 const report=emptyDocument(),fig=report.figure_types[0];
 report.keyframes=[0,1,2,3,4,5,6,7].map(i=>{const f=createFrame([createObject(fig,1,120+i*40,300),createObject(fig,2,520,300)],20);if(dark)f._stykBackgroundColor=0xff101018;return f;});
 const e=new Editor({demo:false}).load(report);initializeLayerSheet(e.report);e._invalidate({timing:true});return e;
}
function frameAt(e,tick){e.seek(tick);const frame=e.evaluatedFrame;return {frame,geometry:buildGeometry(e.report,frame)};}
function batchAt(e,tick,options={}){const {frame,geometry}=frameAt(e,tick);return buildGeneratorBatch(e.report,frame,geometry,{sampler:options.sampler??new GeneratorAnchors(),...options});}
function particles(batch){const out=[],p={};for(const draw of batch?.draws??[])for(let i=0;i<draw.count;i++)if(evaluateParticle(batch,draw,i,p))out.push({record:draw.record,i,x:p.x,y:p.y,size:p.size,alpha:p.alpha});return out;}
const setParams=(e,id,values)=>{const c=e.getVfxClips().find(c=>c.id===id);e.setVfxClipParameters(id,c.effects[0].id,values);};

test('generators are timeline-only and never reach filter executors',()=>{
 for(const type of ['particles','aura','beam','explosion','smoke'])assert.equal(isGeneratorType(type),true);
 assert.throws(()=>validateVfxOwner({_stykVfx:{figure:[createVfx('explosion','fx')]}}),/effects timeline/);
 assert.deepEqual(activeVfx([createVfx('explosion','a'),createVfx('glow','b')]).map(e=>e.type),['glow']);
 const e=fixture();e.addVfxClip({kind:'figure',uid:1},'aura',{start:0,duration:20});e.addVfxClip({kind:'figure',uid:1},'glow',{start:0,duration:20});
 const {frame}=frameAt(e,5),owner=vfxRenderFrame(e.report,frame).objects.find(o=>o.unique_id===1);
 assert.deepEqual(owner._stykVfx.figure.map(e=>e.type),['glow']);
 validateVfxClips(structuredClone(e.report._styk.vfxClips));
});

test('a frame is identical whether seeked directly, after playback or after scrubbing back',()=>{
 const e=fixture(),sampler=new GeneratorAnchors();
 e.addVfxClip({kind:'figure',uid:1},'aura',{start:2,duration:40});e.addVfxClip({kind:'figure',uid:2},'explosion',{start:10,duration:20});e.addVfxClip({kind:'figure',uid:1},'particles',{start:0,duration:50});
 const direct=batchAt(e,30,{sampler:new GeneratorAnchors()});
 for(let t=0;t<30;t++)batchAt(e,t,{sampler});
 const played=batchAt(e,30,{sampler});batchAt(e,55,{sampler});batchAt(e,12,{sampler});const scrubbed=batchAt(e,30,{sampler});
 for(const other of [played,scrubbed]){assert.deepEqual([...other.records],[...direct.records]);assert.deepEqual([...other.table],[...direct.table]);}
 assert.ok(particles(direct).length>200);assert.deepEqual(particles(scrubbed),particles(direct));
});

test('bursts and trails keep the position their target had at birth',()=>{
 const e=fixture(),id=e.addVfxClip({kind:'figure',uid:1},'explosion',{start:4,duration:30});
 const start=frameAt(e,4),x0=start.geometry.objects.get(0).root.x,later=batchAt(e,40),x40=frameAt(e,40).geometry.objects.get(0).root.x;
 assert.ok(x40-x0>50,'the target moved away');
 const r=later.records,rows=[];for(const draw of later.draws){const o=draw.record*RECORD_FLOATS,start=r[o+30];rows.push(later.table[start*4]);}
 for(const x of rows)assert.ok(Math.abs(x-x0)<40,`burst anchor ${x} stays near ${x0}`);
 // A continuous emitter that follows its target moves with it; a trail stays behind.
 const trail=e.addVfxClip({kind:'figure',uid:1},'particles',{start:0,duration:80});e.deleteVfxClip(id);
 setParams(e,trail,{speed:0,spread:0,gravity:0,life:40,variation:0,rate:2});
 const mean=b=>{const ps=particles(b);return ps.reduce((n,p)=>n+p.x,0)/ps.length;};
 const trailed=mean(batchAt(e,50));setParams(e,trail,{space:1});const followed=mean(batchAt(e,50));
 assert.ok(followed-trailed>15,`follow (${followed}) sits ahead of trail (${trailed})`);
});

test('particles outlive their clip unless the clip fades out',()=>{
 const e=fixture(),id=e.addVfxClip({kind:'figure',uid:2},'explosion',{start:0,duration:10});const clip=()=>e.getVfxClips()[0];
 const tail=generatorClipTail(clip());assert.ok(tail>30);
 assert.equal(vfxClipActiveAt(clip(),15),false);assert.equal(generatorClipActiveAt(clip(),15),true);
 assert.deepEqual(filterVfxClips([clip()],{tick:15}).map(c=>c.id),[id]);
 assert.ok(particles(batchAt(e,15)).length>20);
 assert.equal(batchAt(e,10+tail+1),null);
 e.setVfxClip(id,{fadeOut:4});assert.equal(batchAt(e,15),null,'a faded clip leaves nothing behind');
});

test('keyed emission changes only newly born particles and preview density is a subset',()=>{
 const e=fixture(),id=e.addVfxClip({kind:'figure',uid:2},'particles',{start:0,duration:60}),c=()=>e.getVfxClips()[0],fx=()=>c().effects[0];
 setParams(e,id,{life:40,rate:6});
 const steady=particles(batchAt(e,45)).length;
 e.setVfxClipParameter(id,fx().id,'rate',6,{key:true,tick:0});e.setVfxClipParameter(id,fx().id,'rate',6,{key:true,tick:20});e.setVfxClipParameter(id,fx().id,'rate',0,{key:true,tick:21});
 const keyed=particles(batchAt(e,45)).length;
 assert.ok(keyed>0&&keyed<steady/2,`particles born before the change survive (${keyed}); later births stop (${steady})`);
 const full=particles(batchAt(e,12)),thin=particles(batchAt(e,12,{density:.4})),key=p=>`${p.record}:${p.i}`,all=new Map(full.map(p=>[key(p),p]));
 assert.ok(thin.length>0&&thin.length<full.length);
 for(const p of thin)assert.deepEqual(p,all.get(key(p)),'thinned particles are unchanged members of the full set');
});

test('draws are placed behind or in front of their own target and hidden targets hide effects',()=>{
 const batch={draws:[{uid:1,placement:'behind',scene:false},{uid:1,placement:'front',scene:false},{uid:2,placement:'front',scene:false},{uid:null,placement:'behind',scene:true},{uid:null,placement:'front',scene:true},{uid:9,placement:'front',scene:false}]};
 const order=[],walker=scheduleWalker(generatorSchedule(batch,new Set([2])),draws=>order.push(...draws.map(d=>`${d.scene?'scene':d.uid}:${d.placement}`)));
 walker.begin();for(const uid of [5,1,1,3])walker.object(uid),order.push(`art${uid}`);walker.end();
 assert.deepEqual(order,['scene:behind','art5','1:behind','art1','art1','1:front','art3','9:front','scene:front']);
});

test('Auto blending glows on dark scenes and keeps colours solid on light ones',()=>{
 const light=fixture(),dark=fixture({dark:true});
 for(const e of [light,dark])e.addVfxClip({kind:'figure',uid:1},'aura',{start:0,duration:40});
 assert.equal(backgroundIsLight(light.report,frameAt(light,5).frame),true);assert.equal(backgroundIsLight(dark.report,frameAt(dark,5).frame),false);
 const flames=b=>b.draws.find(d=>d.material===MATERIALS.flame.row);
 assert.equal(flames(batchAt(light,10)).blend,BLEND.normal);assert.equal(flames(batchAt(dark,10)).blend,BLEND.add);
 const b=batchAt(light,10),c=rampColor(b,flames(b),.5,[0,0,0,0]);
 assert.ok(Math.max(c[0],c[1],c[2])>.99&&Math.min(c[0],c[1],c[2])<.6,'solid colours stay saturated');
});

test('new generated effects start at the playhead with their own seed and undo as one step',()=>{
 const e=fixture();e.seek(17);const n=e._undo.length;
 const a=e.addVfxClip({kind:'figure',uid:1},'explosion'),b=e.addVfxClip({kind:'figure',uid:1},'explosion'),[ca,cb]=e.getVfxClips();
 assert.deepEqual([ca.start,ca.duration],[17,36]);assert.notEqual(ca.effects[0].params.seed,cb.effects[0].params.seed);
 const smoke=e.addVfxClip({kind:'scene'},'smoke');assert.deepEqual([e.getVfxClips().find(c=>c.id===smoke).start,e.getVfxClips().find(c=>c.id===smoke).duration],[17,72]);
 assert.ok(Object.values(VFX_PRESETS).every(p=>p.effects.every(([type])=>!isGeneratorType(type))),'presets hold filters only');assert.equal(presetAvailable(VFX_PRESETS['Golden hour'],true,effectAvailable),true);
 assert.equal(effectAvailable('aura',true),false);assert.equal(effectAvailable('explosion',true),true);
 assert.equal(e._undo.length,n+3);e.undo();e.undo();e.undo();assert.equal(e.getVfxClips().length,0);assert.ok(a&&b);
});

test('anchor samples evaluate only the target assembly and reset after edits',()=>{
 const e=fixture(),sampler=new GeneratorAnchors(),target={kind:'figure',uid:1};
 const first=sampler.sample(e.report,target,20,{body:true});assert.ok(first.segments.length>=8);
 assert.equal(sampler.sample(e.report,target,20,{body:true}),first);assert.equal(sampler.stats.hits,1);
 e._invalidate({timing:true});
 assert.notEqual(sampler.sample(e.report,target,20,{body:true}),first,'an edit invalidates retained poses');
});

test('generated effects inside a movieclip draw beside the container in its transform',()=>{
 const e=fixture();e.seek(0);e.select(2);e.createMovieclip({start:0,end:60});
 const container=e.selectedUid,typeId=e.figure.figure_type_id;
 // Effects authored inside the clip become part of the reusable asset.
 e.enterMovieclip(typeId);e.addVfxClip({kind:'figure',uid:e.evaluatedFrame.objects[0].unique_id},'explosion',{start:0,duration:40});e.leaveMovieclip();
 assert.equal(e.getVfxClips().length,0,'the parent timeline is unchanged');
 const batch=batchAt(e,12);
 assert.ok(batch?.draws.length,'the explosion inside the clip renders');
 assert.ok(batch.draws.every(d=>d.uid===container),'nested draws are placed beside their container');
 const bounds=generatorBatchBounds(batch),g=[...frameAt(e,12).geometry.objects.values()].find(g=>g?.obj.unique_id===container);
 assert.ok(bounds&&Math.abs(bounds.x+bounds.width/2-g.root.x)<220,'particles surround the container on stage');
 assert.deepEqual(particles(batchAt(e,12)),particles(batch),'nested sampling is deterministic');
});
