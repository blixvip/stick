import {messageError} from './localized-error.mjs';

/** Named drawing substitutions select existing single frames. No interpolation
 * or new playback channel is introduced. */
import {quaternionPose} from './rig-spatial.mjs';
export function validateDrawingSets(asset){
 const rotation=asset.drawingRotation;
 if(rotation!==undefined&&(!rotation||Object.keys(rotation).some(k=>!['steps','tiltThreshold'].includes(k))||!Number.isInteger(rotation.steps)||rotation.steps<2||rotation.steps>32||!Number.isFinite(rotation.tiltThreshold)||rotation.tiltThreshold<=0||rotation.tiltThreshold>=Math.PI/2||!asset.drawingSets))throw messageError(new Error(''), "errors.movieclipDrawings.rotatingDrawingsNeed232DirectionsAndA", {});
 const sets=asset.drawingSets;if(sets===undefined)return;
 const name=s=>typeof s==='string'&&s.trim().length>0&&s.length<=120;
 if(!Array.isArray(sets)||!sets.length||sets.length>128)throw messageError(new Error(''), "errors.movieclipDrawings.drawingSetsNeed1128Groups", {});
 for(const set of sets){if(!set||!name(set.name)||!Array.isArray(set.views)||!set.views.length||set.views.length>256)throw messageError(new Error(''), "errors.movieclipDrawings.aDrawingSetNeedsANameAnd1", {});
  if(rotation&&set.views.length!==rotation.steps*3)throw messageError(new Error(''), "errors.movieclipDrawings.rotatingDrawingsNeedLevelUpAndDownViews", {});
  for(const v of set.views)if(!v||!name(v.name)||!Number.isInteger(v.frame)||v.frame<0||v.frame>=asset.duration)throw messageError(new Error(''), "errors.movieclipDrawings.drawingViewsMustSelectExistingClipFrames", {});}
}
export function drawingSelection(asset,object){
 const frame=object._stykMovieclip?.offset??0,sets=asset.drawingSets;
 let group=sets.findIndex(s=>s.views.some(v=>v.frame===frame));if(group<0)group=0;
 return{group,view:Math.max(0,sets[group].views.findIndex(v=>v.frame===frame))};
}
/** Pure, stateless quantization: scrubbing and reverse playback select exactly
 * the same drawing. Form remains the existing authored single-frame offset. */
export function rotatedDrawing(asset,object,q,reference){
 if(!asset.drawingRotation||!q)return null;
 const [x,y,z,w]=q,fx=2*(w*y+x*z),fy=2*(y*z-w*x),fz=1-2*(x*x+y*y),
   {steps,tiltThreshold}=asset.drawingRotation,
   projectedRoll=Math.atan2(-2*(x*y-w*z),1-2*(x*x+z*z)),
   pose=reference?quaternionPose(q,reference):null,
   roll=pose?.bend??projectedRoll,
   yaw=pose?.turn??Math.atan2(fx*Math.cos(roll)+fy*Math.sin(roll),fz),pitch=pose?.pitch??Math.asin(Math.max(-1,Math.min(1,fx*Math.sin(roll)-fy*Math.cos(roll)))),
   direction=((Math.floor(yaw/(Math.PI*2)*steps+.5)%steps)+steps)%steps,
   tilt=pitch < -tiltThreshold?1:pitch > tiltThreshold?2:0,
   view=tilt*steps+direction,group=drawingSelection(asset,object).group;
 return {group,view,frame:asset.drawingSets[group].views[view].frame,roll};
}

/** Native angle hints disambiguate equivalent Euler branches at side/back
 * views. They are read from this evaluated pose, never retained across frames. */
export function drawingRotationReference(parent,joint,figureAngle){
 const sign=parent.obj.image_text_flags?-1:1,reference={bend:joint.spatialFrame.nativeBend,turn:0,pitch:0};
 let current=joint;
 while(current?.spatialFrame){
  const s=current.seg._stykRig.spatial;
  for(const key of ['turn','pitch']){const control=parent.segments.find(p=>p.seg.segment_id===s[key]);reference[key]+=((control.authoredAngle??control.angle)-figureAngle)*sign-(control.seg.angle_rad??0);}
  current=s.parent?parent.segments.find(p=>p.seg.segment_id===s.parent):null;
 }
 return reference;
}
