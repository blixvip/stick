import {messageError} from './localized-error.mjs';
import {spatialCamera,spatialShape,validateSpatialPose,spatialPerspectiveAvailable} from './spatial-projection.mjs';
import {spatialBone} from './rig-spatial.mjs';

/** Small authored pose values; all evaluation stays in the existing rig graph. */
export const editorSpatialShapeMethods={
 getSpatialCamera(){return spatialCamera(this.object);},
 setSpatialCamera(patch){
  const object=this.object,figure=this.figure;if(!object||!figure?.segments.some(spatialBone))return false;
  const camera={...spatialCamera(object),...patch},state={...object._stykSpatial,camera};
  if(camera.strength&&!spatialPerspectiveAvailable(this.selectionFrame.objects,object,this.report.figure_types))throw messageError(new Error(''), "errors.editorSpatialShape.perspectiveRequiresASingleSpatialFigureSeparateJoined", {});
  validateSpatialPose({...object,_stykSpatial:state},figure);
  if(Object.entries(camera).every(([k,v])=>v===spatialCamera(object)[k]))return false;
  return this._objectEdit('Adjust perspective',o=>{o._stykSpatial=state;delete o.runtime_segments;});
 },
 getSpatialProportions(){
  const f=this.figure,o=this.object,s=f?.segments[this.selectedJoint];if(!o||!spatialBone(s))return null;
  return {...spatialShape(o,s.segment_id),canResizeLength:s.length>1e-9,length:s.length>1e-9?(o.len_flag?o.lengths[this.selectedJoint]:s.length)/s.length:1};
 },
 setSpatialProportions(patch){
  const before=this.getSpatialProportions();if(!before)return false;
  if(!before.canResizeLength&&(patch.size!==undefined||patch.length!==undefined))throw messageError(new Error(''), "errors.editorSpatialShape.useFigureScaleToResizeAZeroLength", {});
  for(const[k,v]of Object.entries(patch))if(!['size','length','width','taper'].includes(k)||!Number.isFinite(v)||v<(k==='taper'?-.9:.1)||v>(k==='taper'?3:5))throw messageError(new Error(''), "errors.editorSpatialShape.chooseProportionsWithinTheControlRange", {});
  const f=this.figure,index=this.selectedJoint,id=f.segments[index].segment_id;
  // Size carries all descendant bones (e.g. foot + toes) as one part. Length,
  // width and taper remain local adjustments; bindings blend their boundaries.
  const affected=new Set([id]);
  if(patch.size!==undefined){let changed=true;while(changed){changed=false;for(const s of f.segments)if(spatialBone(s)&&affected.has(s._stykRig.spatial.parent)&&!affected.has(s.segment_id)){affected.add(s.segment_id);changed=true;}}}
  const factor=patch.size===undefined?1:patch.size/Math.max(.000001,before.length);
  const shape={...this.object._stykSpatial?.shape},lengths=this.object.len_flag?this.object.lengths.slice():f.segments.map(s=>s.length);
  for(let i=0;i<f.segments.length;i++){
    const s=f.segments[i];if(!affected.has(s.segment_id))continue;
    const current=spatialShape(this.object,s.segment_id);
    shape[s.segment_id]={width:current.width*factor,taper:current.taper};lengths[i]*=factor;
  }
  for(const key of ['width','taper'])if(patch[key]!==undefined)shape[id][key]=patch[key];
  if(patch.length!==undefined)lengths[index]=f.segments[index].length*patch.length;
  const state={...this.object._stykSpatial,shape};validateSpatialPose({...this.object,_stykSpatial:state},f);
  return this._objectEdit('Adjust rig proportions',o=>{
    this._releaseSpatialChain(o);o._stykSpatial=state;
    if(patch.size!==undefined||patch.length!==undefined){o.lengths=lengths;o.len_flag=1;}
    delete o.runtime_segments;
  },{posed:true});
 },
 resetSpatialProportions(){
  if(!this.getSpatialProportions())return false;
  return this.setSpatialProportions({...this.getSpatialProportions().canResizeLength?{length:1}:{},width:1,taper:0});
 },
};
