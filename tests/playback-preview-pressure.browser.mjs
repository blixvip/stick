import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage();await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  const result=await page.evaluate(async()=>{
    const {emptyDocument,createFrame,createObject}=await import('/src/demo.mjs');
    const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs');
    const {SHAPE_FLOATS}=await import('/src/renderer-geometry.mjs');
    const report=emptyDocument();report.canvas_width=960;report.canvas_height=640;
    const figure=report.figure_types[0],vectors=Array.from({length:120},(_,i)=>createObject(figure,i+1,50+i%20*42,80+Math.floor(i/20)*80,{scale:.2}));
    const translucent=createObject(figure,9999,480,320,{scale:10,field28:128});
    report.keyframes=[createFrame([...vectors,translucent]),createFrame(vectors)];
    const resources=new PlaybackResources(),budget=192*1024,packets=[];
    try {
      const full=await compilePlaybackPacket(report,0,{resources,maxPacketBytes:32*1024*1024,scale:4});packets.push(full);
      const mixed=await compilePlaybackPacket(report,0,{resources,maxPacketBytes:budget,scale:4});packets.push(mixed);
      const vectorGroups=mixed.groups.filter(g=>g.uid!==9999);
      const sameVectors=vectorGroups.every(g=>{
        const expected=full.groups.find(v=>v.uid===g.uid);
        return g.compatibilityIndex===undefined&&g.instanceCount===expected.instanceCount&&
          mixed.shapes.slice(g.firstInstance*SHAPE_FLOATS,(g.firstInstance+g.instanceCount)*SHAPE_FLOATS).every((v,i)=>v===full.shapes[expected.firstInstance*SHAPE_FLOATS+i]);
      });
      const next=await compilePlaybackPacket(report,1,{resources,maxPacketBytes:budget,scale:4});packets.push(next);
      const dense=await compilePlaybackPacket(report,1,{resources,maxPacketBytes:24*1024,scale:4});packets.push(dense);
      return {mixed:{bytes:mixed.byteLength,quality:mixed.previewQuality,rasters:mixed.compatibility.length,vectors:vectorGroups.length,sameVectors},
        next:{quality:next.previewQuality,rasters:next.compatibility.length,objects:next.groups.length},
        dense:{bytes:dense.byteLength,rasters:dense.compatibility.length,objects:dense.groups.length},budget};
    } finally {for(const p of packets)for(const c of p.compatibility)c.bitmap?.close();resources.dispose();}
  });
  assert.ok(result.mixed.quality.reduced);assert.ok(result.mixed.bytes<=result.budget);
  assert.equal(result.mixed.rasters,1);assert.equal(result.mixed.vectors,120);assert.ok(result.mixed.sameVectors,'Pixel pressure must preserve exact vector commands');
  assert.equal(result.next.rasters,0);assert.equal(result.next.quality.reduced,false);assert.equal(result.next.objects,120);
  assert.ok(result.dense.bytes<=24*1024);assert.ok(result.dense.rasters>0);assert.equal(result.dense.objects,120);
  console.log(JSON.stringify(result));
}finally{await browser.close();}
