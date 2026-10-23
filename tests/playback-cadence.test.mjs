import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackCadence} from '../src/playback-cadence.mjs';
import {PlaybackMeasurements} from '../src/telemetry-measurements.mjs';
import {TelemetryAccumulator,DesktopTelemetryClient} from '../src/telemetry-core.mjs';
import {UserActionError} from '../src/user-action-error.mjs';

test('24 FPS on 60 Hz retains legacy intervals without falsely reporting scheduling stalls',()=>{
  const collector=new TelemetryAccumulator();collector.configure({analytics:true,diagnostics:true});
  const rows=[];collector.performance={record:(...row)=>rows.push(row)};
  const measurements=new PlaybackMeasurements(collector),cadence=new PlaybackCadence();
  let deadline=0;
  for(let callback=0;callback<=120;callback++){
    const now=callback*1000/60;cadence.observe(now);
    if(now+1e-6>=deadline){measurements.present(now,24,true,{deadline,refreshMs:cadence.interval});deadline+=1000/24;}
  }
  assert.ok(collector.data.counters.playback_missed_deadlines>0,'Historical metric is preserved');
  const samples=rows.filter(row=>row[0]==='playback_lateness');
  assert.ok(samples.length>40);assert.ok(samples.every(row=>row[4]===0));
  const now=3000;cadence.observe(now);measurements.present(now,24,true,{deadline,refreshMs:cadence.interval});
  assert.equal(rows.at(-1)[0],'playback_lateness');assert.equal(rows.at(-1)[4],1);
  assert.ok(rows.at(-1)[1]>900);
  measurements.boundary(now+1);const count=rows.length;
  measurements.present(now+100,24,true,{deadline,refreshMs:cadence.interval});assert.equal(rows.length,count);
});

test('cadence stays bounded, rejects pauses and resets before measuring a new run',()=>{
  const cadence=new PlaybackCadence();for(let i=0;i<100;i++)cadence.observe(i*1000/60);
  assert.equal(cadence.count,32);assert.ok(Math.abs(cadence.interval-1000/60)<1e-6);
  cadence.observe(10000);assert.ok(cadence.interval<17);
  cadence.reset();assert.equal(cadence.interval,null);assert.equal(cadence.count,0);
});

test('expected command preconditions stay visible as errors without duplicate incident reporting',()=>{
  const client=new DesktopTelemetryClient(null);client.configure({diagnostics:true});let incidents=0;
  client.performance.incident=()=>incidents++;
  const error=new TypeError('Real failure');client.error(error);client.error(error,'import');
  assert.equal(incidents,1);assert.equal(client.data.errors[0].count,1);
  assert.throws(()=>{throw new UserActionError('Expand the driver');},/Expand the driver/);
  client.error(new UserActionError('Expand the driver'));assert.equal(incidents,1);assert.equal(client.data.errors.length,1);
  client.configure({diagnostics:false});client.error(new Error('Disabled'));assert.equal(incidents,1);
});
