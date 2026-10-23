import {validationLabel} from "./validation-labels.mjs";
import {messageError} from './localized-error.mjs';
import {rigConstraintPlan, clampRig, rigIKAllowed} from './rig-constraints.mjs';
import {segmentBranchIndices} from './editor-builder.mjs';
import {animationRotation} from './animation-origin.mjs';

const clone = value => structuredClone(value);
const finite = (value,min,max,label) => {
  if(!Number.isFinite(value)||value<min||value>max)throw messageError(new Error(''), "errors.cameraMotion.mustBeBetweenAnd", {label: validationLabel(label), min: min, max: max});
  return value;
};
/** Validate a proposed shallow definition before publication. History journals
 * only relationship fields, never artwork or unaffected animation poses. */
function change(editor,label,changes) {
  if(!editor.figure || !changes.size)return false;
  if(editor.dragging)editor.commitDrag();
  const figure=editor.figure, segments=figure.segments.slice();
  for(const [i,rig] of changes)segments[i]={...segments[i],_stykRig:rig};
  const proposed={...figure,segments};rigConstraintPlan(proposed);
  for(const frame of editor._allSourceFrames())for(const o of frame.objects)if(o.figure_type_id===figure.figure_type_id&&o._stykIK)
    for(const [id,c] of Object.entries(o._stykIK))if(c.enabled&&!rigIKAllowed(proposed,segments.findIndex(s=>s.segment_id===Number(id))))throw messageError(new Error(''), "errors.editorRigConstraints.disableIkOnTheAffectedPartsBeforeBinding", {});
  const before=[],after=[];
  for(const [i,rig] of changes) {
    const old=figure.segments[i]._stykRig;
    if(JSON.stringify(old)===JSON.stringify(rig))continue;
    const path=['segments',i,'_stykRig'];
    before.push({path,exists:old!==undefined,value:old===undefined?undefined:clone(old)});
    after.push({path,exists:rig!==undefined,value:rig===undefined?undefined:clone(rig)});
  }
  if(!after.length)return false;
  const selection=editor._selectionState();
  for(const e of after){const s=figure.segments[e.path[1]];if(e.exists)s._stykRig=e.value;else delete s._stykRig;}
  editor._record({kind:'native-properties',scope:'figure',index:editor.report.figure_types.indexOf(figure),label,
    before:{entries:before,removeEmptyParents:[]},after:{entries:after,removeEmptyParents:[]},
    beforeSelection:selection,afterSelection:selection,definition:true,structural:false,timing:false});
  editor._invalidateFigure(figure.figure_type_id);editor._emit('edit',{label,definition:true});return true;
}


function appendRigJoint(editor,definition,label) {
  const figure=editor.figure;if(!figure)throw messageError(new Error(''), "errors.editorRigConstraints.selectAFigureBeforeAddingARigJoint", {});
  if(figure.segments.length>=30000)throw messageError(new Error(''), "errors.editorRigConstraints.figureSegmentCapacityReached", {});
  const id=Math.max(0,...figure.segments.map(s=>s.segment_id))+1;
  if(id>65535)throw messageError(new Error(''), "errors.editorBuilderBranch.figureJointCapacityReached", {});
  const segment={segment_id:id,bend_rad:0,thickness:0,primitive_code:0,aux_code:0,flags:0,
    segment_type:'line',segment_kind:'line',color_rgb:[13,153,255],transparency:0,visible:true,z_order:figure.segments.length+1,...definition};
  rigConstraintPlan({...figure,segments:[...figure.segments,segment]});
  editor._topologyEdit(label,next=>{
    next.segments.push(segment);
    for(const frame of editor._allSourceFrames())for(const o of frame.objects)if(o.figure_type_id===next.figure_type_id){
      o.angles.push(segment.angle_rad);if(o.len_flag)o.lengths.push(segment.length);if(o.bend_flag)o.bends.push(0);delete o.runtime_segments;
    }
    editor.selectedJoint=next.segments.length-1;
  },{appendOnly:true});return segment;
}

export const editorRigConstraintMethods = {
  enableSmartStretch(enabled) {
    if(!enabled)return this.setRigBehavior({stretch:null});
    const figure=this.figure,index=this.selectedJoint,seg=figure?.segments[index];if(!seg)return false;
    const shape=this.geometry.objects.get(this.selectedSlot)?.segments[index];
    const scale=Math.max(1e-8,Math.abs(this.object.scale??1));
    const currentLength=shape?(seg._stykRig?.connector?
      Math.hypot(shape.end.x-shape.start.x,shape.end.y-shape.start.y):Math.abs(shape.length))/scale:
      seg._stykRig?.connector?.restLength??Math.abs(seg.length);
    const r={...seg._stykRig,stretch:{restLength:Math.max(.0001,currentLength),min:0,max:10,width:'keep',...seg._stykRig?.stretch,branch:true}};
    const changes=new Map([[index,r]]),children=new Map();
    figure.segments.forEach((s,i)=>{const list=children.get(s.parent_id)??[];list.push(i);children.set(s.parent_id,list);});
    const queue=[index];
    for(let q=0;q<queue.length;q++)for(const i of children.get(figure.segments[queue[q]].segment_id)??[]){
      const s=figure.segments[i];if(s._stykRig?.stretch)continue;
      queue.push(i);if(s._stykRig?.connector)continue;
      changes.set(i,{...s._stykRig,follow:{driver:seg.segment_id,mode:s._stykRig?.follow?.mode??'stretch',influence:s._stykRig?.follow?.influence??1,automatic:true}});
    }
    return change(this,'Enable Smart Stretch',changes);
  },
  addConnector(start,end,{position=.5,thickness=6}={}) {
    const figure=this.figure;if(!figure)throw messageError(new Error(''), "errors.editorRigConstraints.selectAFigureBeforeConnectingItsJoints", {});
    finite(position,0,1,'Slide position');finite(thickness,0,1e6,'Thickness');
    const g=this.geometry.objects.get(this.selectedSlot), a=g?.joints.get(start),b=g?.joints.get(end);
    if(!a||!b||start===end)throw messageError(new Error(''), "errors.editorRigConstraints.chooseTwoDifferentJointsInThisFigure", {});
    const span=Math.hypot(b.x-a.x,b.y-a.y)/Math.max(1e-8,Math.abs(this.object.scale));
    if(span<1e-8)throw messageError(new Error(''), "errors.editorRigConstraints.separateTheAnchorsBeforeCreatingAConnectorThey", {});
    return appendRigJoint(this,{parent_id:start,length:position,angle_rad:Math.atan2(b.y-a.y,b.x-a.x),thickness,
      _stykRig:{connector:{start,end,restLength:span}}},'Connect joints');
  },
  addWeightedJoint(origin,anchors) {
    const weighted={origin,anchors:clone(anchors)};
    return appendRigJoint(this,{parent_id:origin,length:0,angle_rad:0,name:'Weighted joint',_stykRig:{weighted}},'Add weighted joint');
  },
  setRigBehavior(patch) {
    const figure=this.figure,index=this.selectedJoint,seg=figure?.segments[index];if(!seg)return false;
    const r={...seg._stykRig}, changes=new Map();
    for(const key of Object.keys(patch))if(!['connector','stretch','follow','orientation','response','angleLock','anglePath','weighted','spatial'].includes(key))throw messageError(new Error(''), "errors.editorRigConstraints.unknownRigBehavior", {});
    for(const key of ['response','angleLock','anglePath','weighted','spatial'])if(key in patch){if(patch[key])r[key]={...r[key],...patch[key]};else delete r[key];}
    if('orientation' in patch)r.orientation=patch.orientation;
    if('connector' in patch) {
      if(!r.connector)throw messageError(new Error(''), "errors.editorRigConstraints.createAConnectorWithConnectJoints", {});
      if(!patch.connector)throw messageError(new Error(''), "errors.editorRigConstraints.deleteTheConnectorToRemoveItOrReconnect", {});
      r.connector={...r.connector,...patch.connector};
    }
    if('stretch' in patch) {
      if(patch.stretch) {
        const span=r.connector?.restLength??seg.length;
        r.stretch={restLength:span,min:0,max:10,width:'keep',...r.stretch,...patch.stretch};
      } else {
        delete r.stretch;
        figure.segments.forEach((s,i)=>{if(s._stykRig?.follow?.driver===seg.segment_id){const next={...s._stykRig};delete next.follow;changes.set(i,Object.keys(next).length?next:undefined);}});
      }
    }
    if('follow' in patch) {if(patch.follow)r.follow={mode:'stretch',influence:1,...r.follow,...patch.follow};else delete r.follow;}
    changes.set(index,Object.keys(r).length?r:undefined);
    return change(this,'Edit rig behavior',changes);
  },
  setAngleLock(mode) {
    const seg=this.figure?.segments[this.selectedJoint];if(!seg)return false;
    if(mode==='off')return this.setRigBehavior({angleLock:null});
    const geometry=this.geometry.objects.get(this.selectedSlot),plan=rigConstraintPlan(this.figure),shape=geometry.segments[this.selectedJoint];
    const lock={mode,angle:shape.angle,multiplier:1};
    if(mode==='figure')lock.restAngle=animationRotation(this.figure,this.object);
    if(mode==='parent'){
      let index=plan.ids.get(seg.parent_id);
      while(index!==undefined){
        const parent=this.figure.segments[index],isStatic=parent.aux_code!==undefined?Boolean(parent.aux_code&1):Boolean(parent.static_raw??parent.flag_bits?.is_static??parent.is_static??(parent.flags&256));
        if(!isStatic)break;index=plan.ids.get(parent.parent_id);
      }
      if(index===undefined)throw messageError(new Error(''), "errors.editorRigConstraints.thisJointHasNoMovableParentUseWorld", {});
      lock.reference=this.figure.segments[index].segment_id;lock.restAngle=geometry.segments[index].angle;
      lock.figureRestAngle=animationRotation(this.figure,this.object);
    }
    return this.setRigBehavior({angleLock:{...lock,secondary:null}});
  },
  setSecondaryAngleReference(reference) {
    const lock=this.figure?.segments[this.selectedJoint]?._stykRig?.angleLock;
    if(lock?.mode!=='parent')throw messageError(new Error(''), "errors.editorRigConstraints.chooseAParentAngleLockFirst", {});
    if(reference===0)return this.setRigBehavior({angleLock:{secondary:null}});
    const index=this.figure.segments.findIndex(s=>s.segment_id===reference);
    if(index<0)throw messageError(new Error(''), "errors.editorRigConstraints.chooseAnExistingSecondAngleReference", {});
    const shape=this.geometry.objects.get(this.selectedSlot).segments[index];
    const angle=lock.space==='authored'?(shape.authoredAngle??shape.angle):shape.angle;
    const figureDelta=lock.figureRestAngle===undefined?0:animationRotation(this.figure,this.object)-lock.figureRestAngle;
    return this.setRigBehavior({angleLock:{secondary:{reference,restAngle:angle-figureDelta,multiplier:1}}});
  },
  bindStretchParts(driver,{mode='stretch',influence=1,branch=false}={}) {
    const figure=this.figure;if(!figure)return false;
    const selected=figure.segments[this.selectedJoint];if(!selected)return false;
    const indices=branch?segmentBranchIndices(figure.segments,selected.segment_id):
      this.selectedSegmentIds.size>1?figure.segments.flatMap((s,i)=>this.selectedSegmentIds.has(s.segment_id)?[i]:[]):[this.selectedJoint];
    const changes=new Map();
    for(const i of indices) {
      const s=figure.segments[i];if(s.segment_id===driver||s._stykRig?.connector)continue;
      const r={...s._stykRig};if(driver){r.follow={driver,mode,influence};delete r.response;}else{delete r.follow;r.response={...r.response,mode:'stop'};}
      changes.set(i,Object.keys(r).length?r:undefined);
    }
    return change(this,'Set stretch parts',changes);
  },
  setConnectorPosition(position) {
    const index=this.selectedJoint,seg=this.figure?.segments[index];if(!seg?._stykRig?.connector)return false;
    finite(position,0,1,'Slide position');
    return this._objectEdit('Slide connector',o=>{if(!o.len_flag)o.lengths=this.figure.segments.map(s=>s.length);o.len_flag=1;o.lengths[index]=position;delete o.runtime_segments;},{posed:true});
  },
  slideConnector(x,y) {
    finite(x,-1e9,1e9,'Joint X');finite(y,-1e9,1e9,'Joint Y');
    const s=this.geometry.objects.get(this.selectedSlot)?.segments[this.selectedJoint];if(!s?.connector)return false;
    // Project onto the rendered centerline, including curves. Ties choose the
    // first interval, so a collapsed connector retains its previous position.
    let best=Infinity,t=null,total=0;const points=s.points, distances=[];
    for(let i=1;i<points.length;i++){const d=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);distances.push(d);total+=d;}
    if(total<1e-8)return false;
    let before=0;
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,d=distances[i-1];
      if(d<1e-8)continue;
      const u=clampRig(((x-a.x)*dx+(y-a.y)*dy)/(d*d),0,1),distance=(x-a.x-dx*u)**2+(y-a.y-dy*u)**2;
      if(distance<best){best=distance;t=(before+u*d)/total;}before+=d;
    }
    return t===null?false:this.setConnectorPosition(t);
  },
};
