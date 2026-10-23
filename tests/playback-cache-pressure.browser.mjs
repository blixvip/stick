import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();await page.goto(`${process.env.STYK_URL||'http://127.0.0.1:47831'}/api/health`);
  const result=await page.evaluate(async()=>{
    const {compilePlaybackPacket,PlaybackResources}=await import('/src/playback-worker.mjs');
    const {ArtworkRegistry}=await import('/src/render-artwork.mjs');
    const {PlaybackGeometryCache}=await import('/src/playback-geometry-cache.mjs');
    const {createFrame,createObject,emptyDocument}=await import('/src/demo.mjs');
    const report=emptyDocument(),figure=report.figure_types[0];
    let definitionReads=0;
    Object.defineProperty(figure,'signatureProbe',{enumerable:true,get(){definitionReads++;return 'unchanged definition';}});
    report.keyframes=Array.from({length:4},()=>createFrame([1,2,3].map(uid=>createObject(figure,uid,uid*230,280,{field28:30+uid*20}))));
    const resources=new PlaybackResources(),artworkRegistry=new ArtworkRegistry(),geometryCache=new PlaybackGeometryCache();
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const pixels=bitmap=>{const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;};
    let channelCount=0,hits=0,firstDefinitionReads;
    try{
      const first=await compilePlaybackPacket(report,0,{sharedArtwork:false});
      const sizes=first.compatibility.map(entry=>entry.bitmap.width*entry.bitmap.height*4);
      check(sizes.length===3,'Fixture must have three isolated opacity rasters');
      resources.artworkBitmaps.maxBytes=sizes[0]+sizes[1];
      for(const entry of first.compatibility)entry.bitmap.close();
      for(let tick=0;tick<4;tick++){
        const packet=await compilePlaybackPacket(report,tick,{revision:4,resources,artworkRegistry,geometryCache});
        const reference=await compilePlaybackPacket(report,tick,{sharedArtwork:false});
        if(!tick)firstDefinitionReads=definitionReads;
        else check(definitionReads===firstDefinitionReads,'An unchanged definition was serialized again');
        check(resources.artworkBitmaps.bytes<=resources.artworkBitmaps.maxBytes,'Retention exceeded budget');
        check(packet.compatibility.length===reference.compatibility.length,'Object isolation changed');
        for(let i=0;i<packet.compatibility.length;i++){
          const a=packet.compatibility[i],b=reference.compatibility[i];
          check(a.bitmap.width===b.bitmap.width&&a.bitmap.height===b.bitmap.height,'Raster size changed');
          const actual=pixels(a.bitmap),expected=pixels(b.bitmap);
          for(let j=0;j<actual.length;j++)check(actual[j]===expected[j],`Pixel changed at tick ${tick}, channel ${j}`);
          channelCount+=actual.length;a.bitmap.close();b.bitmap.close();
        }
        if(tick)check(packet.sharing.rasterCacheHits>=2,'Cache pressure evicted the recurring working set');
        hits+=packet.sharing.rasterCacheHits;
        check(artworkRegistry.definitionRevision===4,'Worker lost revision-scoped signature reuse');
      }
      // A definition edit advances the revision and produces fresh exact pixels.
      figure.segments[0].thickness+=7;
      const changed=await compilePlaybackPacket(report,0,{revision:5,resources,artworkRegistry,geometryCache});
      check(artworkRegistry.definitionRevision===5,'Definition revision was not invalidated');
      check(definitionReads>firstDefinitionReads,'Changed definitions were not read again');
      const fresh=await compilePlaybackPacket(report,0,{sharedArtwork:false});
      for(let i=0;i<changed.compatibility.length;i++){
        const actual=pixels(changed.compatibility[i].bitmap),expected=pixels(fresh.compatibility[i].bitmap);
        check(actual.length===expected.length&&actual.every((v,j)=>v===expected[j]),'Definition edit retained stale pixels');
        changed.compatibility[i].bitmap.close();fresh.compatibility[i].bitmap.close();
      }
      return {channelCount,hits,cacheBytes:resources.artworkBitmaps.bytes,maxBytes:resources.artworkBitmaps.maxBytes,differingChannels:0,definitionEdit:true};
    }finally{resources.dispose();}
  });
  assert.ok(result.hits>=6);await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/playback-cache-pressure.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
