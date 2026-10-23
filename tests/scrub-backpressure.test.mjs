import test from 'node:test';
import assert from 'node:assert/strict';
import {Timeline} from '../src/layer-timeline.mjs';

test('busy scrubbing coalesces targets and release forces the exact final seek',()=>{
  const seeks=[],previews=[];
  const timeline=Object.assign(Object.create(Timeline.prototype),{
    editor:{tick:0,seek(tick,options){this.tick=tick;seeks.push({tick,options});}},
    canScrub:()=>false,onScrub:tick=>previews.push(tick),pendingScrub:3,
  });
  timeline._flushScrub();timeline.pendingScrub=17;timeline._flushScrub();
  assert.equal(timeline.editor.tick,0);assert.equal(timeline.pendingScrub,17);
  timeline.canScrub=()=>true;timeline._flushScrub();
  assert.deepEqual(previews,[17]);assert.equal(timeline.pendingScrub,null);
  timeline.canScrub=()=>false;timeline.pendingScrub=29;
  timeline._flushScrub({force:true});
  assert.deepEqual(seeks,[17,29].map(tick=>({tick,options:{evaluate:false,allowBeyondEnd:true}})));
  assert.equal(timeline.editor.tick,29);assert.equal(timeline.pendingScrub,null);
});

test('pending scrub follows the pointer visually without changing document time',()=>{
    const timeline=Object.assign(Object.create(Timeline.prototype),{
      editor:{tick:2},pendingScrub:11,pxPerTick:14,_offsetX:()=>0,
      playhead:{style:{}},playheadLabel:{textContent:''},
    });
    timeline._syncPlayhead();
    assert.equal(timeline.playheadLabel.textContent,'12');
    assert.equal(timeline.playhead.style.transform,'translateX(161px)');assert.equal(timeline.editor.tick,2);
    timeline.pendingScrub=0;timeline._syncPlayhead();
    assert.equal(timeline.playheadLabel.textContent,'1');assert.equal(timeline.playhead.style.transform,'translateX(7px)');assert.equal(timeline.editor.tick,2);
    timeline.pendingScrub=null;timeline._syncPlayhead();
    assert.equal(timeline.playheadLabel.textContent,'3');assert.equal(timeline.playhead.style.transform,'translateX(35px)');assert.equal(timeline.editor.tick,2);
});
