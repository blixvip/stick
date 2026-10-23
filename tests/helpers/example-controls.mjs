/** Test sweeps translate normalized fixture parameters to ordinary joint edits.
 * These adapters are not shipped as app controls or saved with a figure. */
import {MECHANISM_RIG_EXAMPLES} from '../../src/rig-mechanism-examples.mjs';
import {animationRotation} from '../../src/animation-origin.mjs';
export const rigAssetControls=figure=>MECHANISM_RIG_EXAMPLES.find(r=>r.id===figure._styk?.rigExample?.id)?.build().controls??[];
export function rigAssetControlValues(editor){
  const f=editor.figure,o=editor.object,values={};
  for(const c of rigAssetControls(f)){
    const i=f.segments.findIndex(s=>s.segment_id===c.handle),raw=c.channel==='angle'?o.angles[i]-animationRotation(f,o):o.len_flag?o.lengths[i]:f.segments[i].length;
    values[c.key]=(raw-c.offset)/c.scale;
  }
  return values;
}
export function rigAssetControlChange(editor,target){
  const c=rigAssetControls(editor.figure).find(c=>c.key===target.dataset.rigAsset),value=target.valueAsNumber;
  if(!c||!Number.isFinite(value)||value<c.min||value>c.max)throw new Error('Invalid test parameter.');
  const previous=editor.selectedJoint;editor.select(editor.selectedUid,editor.figure.segments.findIndex(s=>s.segment_id===c.handle));
  try{
    const raw=c.offset+value*c.scale+(c.channel==='angle'?animationRotation(editor.figure,editor.object):0);
    if(c.channel==='slide')editor.setConnectorPosition(raw);else editor.updateSegment(c.channel==='angle'?{angle_rad:raw}:{length:raw});
  }finally{editor.select(editor.selectedUid,previous);}
}
