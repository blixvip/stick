import test from 'node:test';
import assert from 'node:assert/strict';
import {vfxPreviewGeometry} from '../src/vfx-preview.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
test('repeated effects bypass preserves geometry identity without editing artwork',()=>{
  const report=emptyDocument(),frame=createFrame([createObject(report.figure_types[0],1,40,60)]);
  const original=buildGeometry(report,frame),snapshot=JSON.stringify(original.drawables);
  const view=vfxPreviewGeometry(original);
  assert.notEqual(view,original);assert.equal(vfxPreviewGeometry(view),view);
  assert.equal(vfxPreviewGeometry(original),view);assert.equal(JSON.stringify(original.drawables),snapshot);
});
