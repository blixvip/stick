import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackTweenCache} from '../src/playback-tween-cache.mjs';
import {evaluatedFrame,buildGeometry,invalidateEvaluationCaches} from '../src/pivot/geometry.mjs';
import {createDemo} from '../src/demo.mjs';
import {ensureLayerState} from '../src/layers.mjs';
import {initializeLayerSheet} from '../src/editor-layer-sheet.mjs';

test('constant endpoint caching retains exact native floating-point reconstruction',()=>{
  const report=createDemo(),first=report.keyframes[0];
  report.auto_easing=false;
  report.keyframes=[first,structuredClone(first)];
  for(const o of report.keyframes[1].objects){o.record_offset=400;o.record_end=800;}
  // One figure moves while the other figures remain constant.
  report.keyframes[1].objects[0].root_x+=37;
  const tweenCache=new PlaybackTweenCache();let prior;
  for(const t of [.03125,.3,.5,.9375,0,1,.125]){
    const actual=evaluatedFrame(report,0,t,undefined,{tweenCache}),expected=evaluatedFrame(report,0,t);
    assert.deepEqual(actual,expected);assert.deepEqual(buildGeometry(report,actual).drawables,buildGeometry(report,expected).drawables);
    if(t>0&&t<1){if(prior)assert.equal(actual.objects[1],prior.objects[1]);prior=actual;}
  }
});

test('easing, changed endpoints and replaced definitions cannot reuse a constant tween',()=>{
  const report=createDemo(),first=report.keyframes[0];report.keyframes=[first,structuredClone(first)];
  const tweenCache=new PlaybackTweenCache();
  evaluatedFrame(report,0,.1,undefined,{tweenCache});
  report.auto_easing=true;report.keyframes.push(structuredClone(first));report.keyframes[2].objects[1].root_x+=120;
  for(const t of [.2,.7])assert.deepEqual(evaluatedFrame(report,0,t,undefined,{tweenCache}),evaluatedFrame(report,0,t));
  report.auto_easing=false;report.keyframes[1]=structuredClone(first);report.keyframes[1].objects[1].angles[0]+=.001;
  for(const t of [.2,.7])assert.deepEqual(evaluatedFrame(report,0,t,undefined,{tweenCache}),evaluatedFrame(report,0,t));
  report.figure_types=structuredClone(report.figure_types);report.figure_types[0].segments[0].bend_rad=.4;
  assert.deepEqual(evaluatedFrame(report,0,.7,undefined,{tweenCache}),evaluatedFrame(report,0,.7));
});

test('worker cache bounds entry ownership and clears on snapshot invalidation',()=>{
  const cache=new PlaybackTweenCache({maxEntries:2}),figure={};
  for(let i=0;i<5;i++){const a={angles:[i]};cache.lookup(a,structuredClone(a),figure);assert.ok(cache.entries.size<=2);}
  cache.clear();assert.equal(cache.entries.size,0);
});

function sheetFixture(authored=false){
  const report=createDemo(),first=report.keyframes[0];report.auto_easing=false;
  report.keyframes=[first,structuredClone(first)];
  report.keyframes.forEach((frame,index)=>{frame.duration_raw=10;frame._styk={...frame._styk,frameId:`source-${index}`,easing:{interpolation:'linear'}};});
  report.keyframes[1].objects[0].root_x+=37;
  ensureLayerState(report);initializeLayerSheet(report);
  if(authored)for(const track of Object.values(report._styk.layerSheet.tracks))for(const [index,key] of track.keys.entries()){
    delete key.sourceTick;key.value={frameId:report.keyframes[index]._styk.frameId};
  }
  return report;
}

for(const authored of [false,true])test(`sheet ${authored?'authored':'imported'} spans reuse exact constant native tweens`,()=>{
  const report=sheetFixture(authored),tweenCache=new PlaybackTweenCache();let constant;
  for(const tick of [1,3.5,9,2.25]){
    const actual=evaluatedFrame(report,0,tick/10,tick,{tweenCache}),expected=evaluatedFrame(report,0,tick/10,tick);
    assert.deepEqual(actual,expected);assert.deepEqual(buildGeometry(report,actual).drawables,buildGeometry(report,expected).drawables);
    assert.ok(tweenCache.entries.size>0,'The sheet must pass the optional cache to its native evaluator.');
    if(constant)assert.equal(actual.objects[1],constant,'Unchanged endpoint artwork retains its evaluated identity.');
    constant=actual.objects[1];
  }
  for(const tick of [0,10])assert.deepEqual(evaluatedFrame(report,0,tick/10,tick,{tweenCache}),evaluatedFrame(report,0,tick/10,tick));
  const previous=constant;
  report.figure_types=structuredClone(report.figure_types);report.figure_types[0].segments[0].bend_rad=.4;
  invalidateEvaluationCaches(report);
  const changed=evaluatedFrame(report,0,.4,4,{tweenCache});
  assert.deepEqual(changed,evaluatedFrame(report,0,.4,4));assert.notEqual(changed.objects[1],previous);
  report.keyframes[1]=structuredClone(report.keyframes[1]);report.keyframes[1].objects[1].root_y+=11;
  invalidateEvaluationCaches(report);
  for(const tick of [2,7])assert.deepEqual(evaluatedFrame(report,0,tick/10,tick,{tweenCache}),evaluatedFrame(report,0,tick/10,tick));
});

test('sheet legacy native easing bypasses constant endpoint reuse',()=>{
  const report=sheetFixture();report.auto_easing=true;report.keyframes.push(structuredClone(report.keyframes[1]));
  report.keyframes[2].objects[1].root_x+=120;
  delete report.keyframes[0]._styk.easing;
  const tweenCache=new PlaybackTweenCache();
  for(const tick of [2,7]){
    const actual=evaluatedFrame(report,0,tick/10,tick,{tweenCache});
    assert.deepEqual(actual,evaluatedFrame(report,0,tick/10,tick));
    assert.equal(tweenCache.entries.size,0,'Legacy native easing must bypass constant endpoint reuse.');
  }
});
