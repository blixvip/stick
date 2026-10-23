import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDrawingComposite,restoreDrawingComposite} from '../src/drawing-composite-transport.mjs';
import {applyDocumentChunk} from '../src/document-transport.mjs';

function receiver(){let snapshot,packets=[];return {packets,get snapshot(){return snapshot;},async request(kind,{chunk}){assert.equal(kind,'composite-chunk');packets.push(chunk);snapshot=applyDocumentChunk(snapshot,structuredClone(chunk));}};}
test('composite transport shares render definitions without visiting poses or figure libraries',async()=>{
  const never=()=>{throw Error('Non-render data visited');},obj={unique_id:5,scale:2,color_transition:{from:1,to:2,t:.4}},fig={figure_type_id:3,segment_decode:{global_style:{u30:30}}},asset={normalized_svg_path:'M0 0',glyphs:[{svg_path:'M0 0'}]},seg={segment_kind:'line',paint:{type:'linear'}};
  Object.defineProperty(obj,'angles',{enumerable:true,get:never});Object.defineProperty(fig,'segments',{enumerable:true,get:never});
  const items=Array.from({length:3000},(_,slot)=>({type:'text',obj,fig,asset,seg,slot,start:{x:slot,y:5},end:{x:slot+3,y:5},points:[],rgb:[2,3,4],alpha:1,opacity:1})),worker=receiver();
  await sendDrawingComposite(worker,items,{maxBytes:16*1024*1024});
  assert.equal(worker.snapshot.records.length,4);assert.ok(worker.packets.length>10);assert.ok(worker.packets.every(p=>(p.estimatedBytes??0)<=65536));
  const restored=restoreDrawingComposite(worker.snapshot).drawables;
  assert.equal(restored.length,3000);assert.equal(restored[0].obj,restored[2999].obj);assert.equal(restored[0].asset,restored[2999].asset);
  assert.deepEqual(restored[0].obj,{unique_id:5,scale:2,color_transition:{from:1,to:2,t:.4}});assert.deepEqual(restored[2999].end,items[2999].end);
});
test('composite transport splits large blobs and excludes hidden artwork',async()=>{
  const url='tiles:'+'.'.repeat(200000),figure={_styk:{drawing:{version:2,celId:'c',revision:3}},image_assets:[{styk_tiles:url}]},worker=receiver();
  await sendDrawingComposite(worker,[{obj:{unique_id:1},fig:figure,asset:{styk_tiles:url,anchor_length:10}},{obj:{unique_id:2},fig:{get segments(){throw Error('Hidden figure read');}}}],{maxBytes:2*1024*1024,visible:item=>item.obj.unique_id===1});
  assert.ok(worker.packets.every(p=>(p.estimatedBytes??0)<=65536));
  const [item]=restoreDrawingComposite(worker.snapshot).drawables;assert.equal(item.fig.image_assets[0].styk_tiles,url);assert.equal(item.asset.styk_tiles,undefined);assert.equal(item.asset.anchor_length,10);
});
test('composite transport stops on budget failure or cancellation between packets',async()=>{
  const item={obj:{},asset:{data_url:'.'.repeat(100000)}};
  await assert.rejects(sendDrawingComposite(receiver(),[item],{maxBytes:50000}),/working memory/);
  const worker=receiver(),check=()=>{if(worker.packets.length===2)throw new DOMException('Cancelled','AbortError');};
  await assert.rejects(sendDrawingComposite(worker,[item],{maxBytes:1000000,check}),{name:'AbortError'});assert.equal(worker.packets.length,2);
});
