import test from 'node:test';
import assert from 'node:assert/strict';
import {VfxGizmos} from '../src/vfx-gizmos.mjs';

test('inactive VFX controls do not request scene evaluation or geometry',()=>{
  const gizmos=Object.create(VfxGizmos.prototype);
  gizmos.getOptions=()=>{throw new Error('Unexpected scene evaluation');};
  for(const inspector of [{visible:false},{visible:true,selectedEffect:()=>null},{visible:true,selectedEffect:()=>({effect:{enabled:false}})}]){
    gizmos.inspector=inspector;assert.equal(gizmos.control(),null);
  }
});
