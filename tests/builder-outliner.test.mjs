import test from 'node:test';
import assert from 'node:assert/strict';
import {FigureOutliner} from '../src/builder-outliner.mjs';

test('outliner handles 30,000 connected parts without recursive traversal', () => {
  const figure={segments:Array.from({length:30000},(_,i)=>({segment_id:i+1,parent_id:i}))};
  const outliner={collapsed:new Set()};
  const rows=FigureOutliner.prototype.buildRows.call(outliner,figure);
  assert.equal(rows.length,30000);assert.equal(rows.at(-1).depth,29999);
  outliner.collapsed.add(2);
  assert.deepEqual(FigureOutliner.prototype.buildRows.call(outliner,figure).map(r=>r.id),[1,2]);
});

test('outliner drop exclusion includes all descendants and terminates cycles', () => {
  const figure={segments:[{segment_id:1,parent_id:3},{segment_id:2,parent_id:1},{segment_id:3,parent_id:2},{segment_id:4,parent_id:0}]};
  const blocked=FigureOutliner.prototype.descendants.call({session:{figure}},1);
  assert.deepEqual([...blocked],[1,2,3]);
});

test('outliner keeps native sibling ordering, orphan roots, and polygon entries', () => {
  const figure={segments:[{segment_id:30,parent_id:10},{segment_id:10,parent_id:0},{segment_id:20,parent_id:10},{segment_id:40,parent_id:999}],polyfills:[{polyfill_id:7}]};
  const rows=FigureOutliner.prototype.buildRows.call({collapsed:new Set()},figure);
  assert.deepEqual(rows.filter(r=>r.kind==='segment').map(r=>r.id),[10,30,20,40]);
  assert.equal(rows.at(-2).kind,'header');assert.equal(rows.at(-1).id,'p7');
});
