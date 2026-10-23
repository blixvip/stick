import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../src/demo.mjs';
import {compilePlaybackPacket, packetTransferables, PlaybackResources} from '../src/playback-worker.mjs';
import {bitmapBytes, bitmapKey, packetFootprint, PlaybackBitmapPool} from '../src/playback-bitmap-pool.mjs';

test('isolated vectors transfer independently, retain final figure alpha, and reserve GPU residency', async()=>{
  const report=createDemo();report.keyframes[0].objects[0].field28=128;
  const before=structuredClone(report),resources=new PlaybackResources();
  try {
    const options={gpuIsolation:true,resources,maxPacketBytes:128*1024*1024};
    const packet=await compilePlaybackPacket(report,0,options),entry=packet.compatibility.find(e=>e.vectorRaster);
    assert.ok(entry);assert.equal(entry.bitmap,undefined);
    const group=packet.groups.find(g=>g.compatibilityIndex===packet.compatibility.indexOf(entry));
    assert.equal(packet.transforms[group.transformIndex*4+2],Math.fround(1-128/255));
    assert.ok(packet.byteLength>=bitmapBytes(entry)+entry.vectorRaster.data.byteLength);
    const transfer=packetTransferables(packet);assert.equal(new Set(transfer).size,transfer.length);
    const next=structuredClone(packet,{transfer});assert.equal(entry.vectorRaster.data.byteLength,0);
    assert.ok(next.compatibility.some(e=>e.vectorRaster.data.length>0));
    const again=await compilePlaybackPacket(report,0,options);
    assert.ok(again.compatibility.find(e=>e.vectorRaster).vectorRaster.data.length>0,'transfer cannot detach cached geometry');
    assert.deepEqual(report,before);
    const pool=new PlaybackBitmapPool();pool.acquire(again);assert.equal(pool.bytes,again.byteLength);pool.release(again);assert.equal(pool.bytes,0);
    assert.equal(packetFootprint(again).base,again.byteLength,'virtual texture reservation stays bounded even without bitmap ownership');
    assert.equal(bitmapKey(again,again.compatibility[0]),bitmapKey(next,next.compatibility[0]));
  } finally {resources.dispose();}
});

test('vector isolation is opt-in and unsupported bent alpha preserves native compatibility', async()=>{
  const report=createDemo();report.keyframes[0].objects[0].field28=128;
  const plain=await compilePlaybackPacket(report,0);assert.ok(plain.compatibility.length);
  assert.ok(plain.compatibility.every(e=>!e.vectorRaster));
  for(const figure of report.figure_types)for(const s of figure.segments){s.bend_rad=.4;s.transparency=128;}
  for(const frame of report.keyframes)for(const o of frame.objects){o.bend_flag=false;delete o.runtime_segments;}
  const bent=await compilePlaybackPacket(report,0,{gpuIsolation:true});
  assert.ok(bent.compatibility.length);assert.ok(bent.compatibility.every(e=>!e.vectorRaster));
});
