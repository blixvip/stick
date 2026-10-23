import {validationLabel} from "./validation-labels.mjs";
import {messageError} from './localized-error.mjs';
/** Native rig relationships. Definitions contain stable handle references; poses
 * retain the existing angle/length channels. A connector's length channel is its
 * normalized sliding position (0..1), not its rendered span. No solver state is
 * carried between frames: arbitrary seeks and collapsed spans are deterministic.
 */
import {animationRotation} from './animation-origin.mjs';
import {projection} from './spatial-projection.mjs';
import {sameAnglePath,validateAnglePath,sampleAnglePath} from './rig-angle-path.mjs';
import {sameWeightedJoint,validateWeightedJoint,remapWeightedJoint,weightedJoint} from './rig-weighted.mjs';
import {sameSpatial,validateSpatial,remapSpatial,evaluateSpatial,spatialSkin} from './rig-spatial.mjs';
const plans = new WeakMap();
const EPS = 1e-8;
export const clampRig = (n, min, max) => Math.max(min, Math.min(max, n));
const number = (n, label, min, max) => {
  if (!Number.isFinite(n) || n < min || n > max) throw messageError(new Error(''), "errors.cameraMotion.mustBeBetweenAnd", {label: validationLabel(label), min: min, max: max});
};
export function hasRigConstraints(figure) { return figure.segments.some(s => s._stykRig); }
export function documentHasRigConstraints(document,seen=new Set()) {
  if(seen.has(document))return false;seen.add(document);
  return document.figure_types.some(f=>hasRigConstraints(f)||(f._styk?.movieclip&&documentHasRigConstraints(f._styk.movieclip.document,seen)));
}

/** O(V+E) compilation, iterative even for deeply nested connectors. Metadata is
 * immutable in commands; numeric signatures also catch external in-place edits. */
export function rigConstraintPlan(figure) {
  const steps=rigConstraintPlanSteps(figure);let result;do{result=steps.next();}while(!result.done);return result.value;
}
export function* rigConstraintPlanSteps(figure) {
  const segments = figure.segments;
  const previous = plans.get(figure);
  if (previous?.segments === segments && previous.signature.length === segments.length && segments.every((s,i)=>{
    const p=previous.signature[i],r=s._stykRig,c=r?.connector,d=r?.stretch,f=r?.follow;
    return p.id===s.segment_id&&p.parent===s.parent_id&&p.start===c?.start&&p.end===c?.end&&p.span===c?.restLength&&
      p.rest===d?.restLength&&p.min===d?.min&&p.max===d?.max&&p.width===d?.width&&p.driver===f?.driver&&p.mode===f?.mode&&p.influence===f?.influence&&p.orientation===r?.orientation&&
      p.branch===d?.branch&&p.source===d?.source&&p.restPosition===d?.restPosition&&p.automatic===f?.automatic&&
      p.responseMode===r?.response?.mode&&p.multiplier===r?.response?.multiplier&&p.reset===r?.response?.reset&&
      p.lockMode===r?.angleLock?.mode&&p.lockSpace===r?.angleLock?.space&&p.lockReference===r?.angleLock?.reference&&p.lockAngle===r?.angleLock?.angle&&p.lockRest===r?.angleLock?.restAngle&&p.lockFigureRest===r?.angleLock?.figureRestAngle&&p.lockMultiplier===r?.angleLock?.multiplier&&
      p.secondaryReference===r?.angleLock?.secondary?.reference&&p.secondaryRest===r?.angleLock?.secondary?.restAngle&&p.secondaryMultiplier===r?.angleLock?.secondary?.multiplier&&sameAnglePath(p.anglePath,r?.anglePath)&&sameWeightedJoint(p.weighted,r?.weighted)&&sameSpatial(p.spatial,r?.spatial);
  })) return previous;
  const signature=new Array(segments.length),ids=new Map(),outgoing=new Array(segments.length),dependenciesByIndex=new Array(segments.length),indegree=new Uint32Array(segments.length);
  for(let i=0;i<segments.length;i++){
    const s=segments[i],r=s._stykRig,c=r?.connector,d=r?.stretch,f=r?.follow;
    signature[i]={id:s.segment_id,parent:s.parent_id,start:c?.start,end:c?.end,span:c?.restLength,rest:d?.restLength,min:d?.min,max:d?.max,width:d?.width,driver:f?.driver,mode:f?.mode,influence:f?.influence,orientation:r?.orientation};
    if(r?.anglePath)signature[i].anglePath=structuredClone(r.anglePath);
    if(r?.weighted)signature[i].weighted=structuredClone(r.weighted);
    if(r?.spatial)signature[i].spatial=structuredClone(r.spatial);
    Object.assign(signature[i],{branch:d?.branch,source:d?.source,restPosition:d?.restPosition,automatic:f?.automatic,
      responseMode:r?.response?.mode,multiplier:r?.response?.multiplier,reset:r?.response?.reset,
      lockMode:r?.angleLock?.mode,lockSpace:r?.angleLock?.space,lockReference:r?.angleLock?.reference,lockAngle:r?.angleLock?.angle,lockRest:r?.angleLock?.restAngle,lockFigureRest:r?.angleLock?.figureRestAngle,lockMultiplier:r?.angleLock?.multiplier,
      secondaryReference:r?.angleLock?.secondary?.reference,secondaryRest:r?.angleLock?.secondary?.restAngle,secondaryMultiplier:r?.angleLock?.secondary?.multiplier});
    ids.set(s.segment_id,i);outgoing[i]=[];
    if((i&255)===255)yield {phase:'rig',stage:'references',completed:i+1,total:segments.length};
  }
  const reference = (id, label, root = false) => {
    if (!Number.isInteger(id) || (!ids.has(id) && !(root && id === 0))) throw messageError(new Error(''), "errors.rigConstraints.refersToAMissingJointRemoveOrReconnect", {label: validationLabel(label)});
  };
  for(let i=0;i<segments.length;i++) {
    const s=segments[i];
    const r=s._stykRig, c=r?.connector, d=r?.stretch, f=r?.follow;
    if(r && (typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k=>!['connector','stretch','follow','orientation','response','angleLock','anglePath','weighted','spatial'].includes(k)))) throw messageError(new Error(''), "errors.rigConstraints.invalidRigBehavior", {});
    if(r?.orientation!==undefined&&!['inherit','world'].includes(r.orientation))throw messageError(new Error(''), "errors.rigConstraints.chooseAValidAttachmentOrientation", {});
    const dependencies = new Set([s.parent_id]);
    if(r?.spatial){
      if(c||d||f||r.response||r.angleLock||r.anglePath||r.weighted)throw messageError(new Error(''), "errors.rigConstraints.spatialArticulationOwnsItsTransformApplyOtherRelationships", {});
      validateSpatial(r.spatial,reference,dependencies,segments,ids);
    }
    if(r?.weighted){
      if(c||d||f||r.response||r.angleLock||r.anglePath)throw messageError(new Error(''), "errors.rigConstraints.aWeightedJointFollowsItsAnchorsApplyOther", {});
      validateWeightedJoint(r.weighted,reference,dependencies);
    }
    if(r?.anglePath){
      if(c||d||f||r.response||r.angleLock)throw messageError(new Error(''), "errors.rigConstraints.anAnglePathJointIsPositionedByIts", {});
      validateAnglePath(r.anglePath,reference,dependencies);
      if(r.anglePath.source!==undefined&&!segments[ids.get(r.anglePath.source)]._stykRig?.anglePath?.keys)throw messageError(new Error(''), "errors.rigConstraints.chooseAnAnglePathJointAsTheDepth", {});
    }
    if(c) {
      reference(c.start,'Connector start',true); reference(c.end,'Connector end',true);
      if(c.start === c.end) throw messageError(new Error(''), "errors.rigConstraints.chooseTwoDifferentConnectorAnchors", {});
      number(c.restLength,'Connector rest span',EPS,1e6);
      dependencies.add(c.start); dependencies.add(c.end);
    }
    if(d) {
      number(d.restLength,'Stretch rest length',EPS,1e6);
      number(d.min,'Minimum stretch',0,100); number(d.max,'Maximum stretch',Math.max(.01,d.min),100);
      if(!['keep','inverse','scale'].includes(d.width)) throw messageError(new Error(''), "errors.rigConstraints.chooseAValidStretchWidthResponse", {});
      if(d.branch!==undefined&&typeof d.branch!=='boolean')throw messageError(new Error(''), "errors.rigConstraints.invalidStretchBranchSetting", {});
      if(d.source!==undefined&&(!c||!['span','slide','combined'].includes(d.source)))throw messageError(new Error(''), "errors.rigConstraints.chooseAValidConnectorStretchSource", {});
      if(d.restPosition!==undefined)number(d.restPosition,'Rest slide position',EPS,1);
      if(d.source&&d.source!=='span'&&d.restPosition===undefined)throw messageError(new Error(''), "errors.rigConstraints.setANonzeroRestSlidePositionFirst", {});
    }
    if(f) {
      reference(f.driver,'Stretch driver');
      if(!segments[ids.get(f.driver)]._stykRig?.stretch) throw messageError(new Error(''), "errors.rigConstraints.theSelectedStretchDriverIsNotEnabledRemove", {});
      if(!['stretch','rigid'].includes(f.mode)) throw messageError(new Error(''), "errors.rigConstraints.chooseStretchOrFollowWithoutDeforming", {});
      number(f.influence,'Stretch influence',-4,4); dependencies.add(f.driver);
      if(f.automatic!==undefined&&typeof f.automatic!=='boolean')throw messageError(new Error(''), "errors.rigConstraints.invalidAutomaticStretchBinding", {});
      if(c) throw messageError(new Error(''), "errors.rigConstraints.aConnectorFollowsItsAnchorsApplyStretchTo", {});
    }
    const response=r?.response,lock=r?.angleLock;
    for(const value of [response,lock])if(value!==undefined&&value!==null&&(typeof value!=='object'||Array.isArray(value)))throw messageError(new Error(''), "errors.rigConstraints.invalidRigResponseOrAngleLock", {});
    if(response){
      if(!['stretch','rigid','stop'].includes(response.mode??'stretch'))throw messageError(new Error(''), "errors.rigConstraints.chooseAValidStretchResponse", {});
      if(response.multiplier!==undefined)number(response.multiplier,'Stretch multiplier',-10,10);
      if(response.reset!==undefined&&typeof response.reset!=='boolean')throw messageError(new Error(''), "errors.rigConstraints.invalidStretchImpulseReset", {});
    }
    if(lock){
      if(c)throw messageError(new Error(''), "errors.rigConstraints.connectorAnglesAreControlledByTheirAnchorsLock", {});
      if(!['world','figure','parent'].includes(lock.mode))throw messageError(new Error(''), "errors.rigConstraints.chooseAValidAngleLock", {});
      if(lock.space!==undefined&&!['rendered','authored'].includes(lock.space))throw messageError(new Error(''), "errors.rigConstraints.chooseAValidAngleLockSpace", {});
      number(lock.angle,'Locked angle',-1e6,1e6);number(lock.multiplier,'Angle multiplier',-10,10);
      if(lock.mode==='parent'){reference(lock.reference,'Angle reference');dependencies.add(lock.reference);number(lock.restAngle,'Reference angle',-1e6,1e6);}
      if(lock.mode==='figure')number(lock.restAngle,'Figure reference angle',-1e6,1e6);
      if(lock.figureRestAngle!==undefined)number(lock.figureRestAngle,'Parent lock figure reference angle',-1e6,1e6);
      if(lock.secondary!=null){
        if(lock.mode!=='parent'||typeof lock.secondary!=='object'||Array.isArray(lock.secondary))throw messageError(new Error(''), "errors.rigConstraints.aSecondAngleReferenceRequiresAParentAngle", {});
        reference(lock.secondary.reference,'Second angle reference');dependencies.add(lock.secondary.reference);
        number(lock.secondary.restAngle,'Second reference angle',-1e6,1e6);number(lock.secondary.multiplier,'Second rotation multiplier',-10,10);
      }
    }
    dependenciesByIndex[i]=[...dependencies].filter(Boolean).map(id=>ids.get(id));
    for(const id of dependencies) {reference(id,'Rig parent',true);if(id) {const p=ids.get(id);outgoing[p].push(i);indegree[i]++;}}
    if((i&255)===255)yield {phase:'rig',stage:'dependencies',completed:i+1,total:segments.length};
  }
  const order=[];indegree.forEach((n,i)=>{if(!n)order.push(i);});
  for(let q=0;q<order.length;q++) {for(const child of outgoing[order[q]]) if(--indegree[child]===0)order.push(child);
    if((q&255)===255)yield {phase:'rig',stage:'order',completed:q+1,total:segments.length};}
  if(order.length!==segments.length) throw messageError(new Error(''), "errors.rigConstraints.thisRigWouldDependOnItselfChooseAnchors", {});
  // Resolve inherited impulses once. Explicit older bindings retain their
  // original response; automatic bindings also include subsequently drawn parts.
  const inputs=new Array(segments.length),outputs=new Array(segments.length),blocked=new Array(segments.length);
  for(const i of order){
    const r=segments[i]._stykRig??{},parent=ids.get(segments[i].parent_id),f=r.follow;
    let source=f&&!f.automatic?{driver:ids.get(f.driver),axis:ids.get(f.driver),legacy:true}:
      (r.stretch&&!r.connector)||r.weighted||r.spatial?undefined:outputs[parent];
    if(source?.legacy&&outputs[parent]?.driver===source.driver)source.axis=outputs[parent].axis;
    blocked[i]=r.stretch?undefined:blocked[parent];
    if(r.response?.mode==='stop'){blocked[i]=source?.driver??blocked[i];source=undefined;}
    if(source?.driver===blocked[i]&&blocked[i]!==undefined)source=undefined;
    inputs[i]=source;
    outputs[i]=r.response?.mode==='stop'?undefined:r.stretch?.branch?{driver:i,axis:i}:
      source&&r.response?.reset?{...source,axis:i,legacy:false}:source?.legacy?(r.response?{...source,legacy:false}:undefined):source;
    if((i&255)===255)yield {phase:'rig',stage:'impulses',completed:i+1,total:segments.length};
  }
  const plan={segments,signature,ids,order,inputs,outputs,dependencies:dependenciesByIndex};plans.set(figure,plan);return plan;
}

export function remapRigReferences(segment, remap) {
  const r=segment._stykRig;if(!r)return;
  segment._stykRig={...r,
    ...(r.spatial?{spatial:remapSpatial(r.spatial,remap)}:{}),
    ...(r.weighted?{weighted:remapWeightedJoint(r.weighted,remap)}:{}),
    ...(r.anglePath?{anglePath:{...r.anglePath,...Object.fromEntries(['driver','pitch','origin','source'].filter(k=>r.anglePath[k]!==undefined).map(k=>[k,remap.get(r.anglePath[k])??r.anglePath[k]]))}}:{}),
    ...(r.connector?{connector:{...r.connector,start:remap.get(r.connector.start)??r.connector.start,end:remap.get(r.connector.end)??r.connector.end}}:{}),
    ...(r.follow?{follow:{...r.follow,driver:remap.get(r.follow.driver)??r.follow.driver}}:{}),
    ...(r.angleLock?.reference!==undefined?{angleLock:{...r.angleLock,reference:remap.get(r.angleLock.reference)??r.angleLock.reference,
      ...(r.angleLock.secondary?{secondary:{...r.angleLock.secondary,reference:remap.get(r.angleLock.secondary.reference)??r.angleLock.secondary.reference}}:{})}}:{})};
}
export function rigWidth(ratio, response) {
  return response==='inverse'?1/Math.max(.01,ratio):response==='scale'?ratio:1;
}
export const derivedRigJoint=segment=>Boolean(spatialSkin(segment)||segment?._stykRig?.connector||segment?._stykRig?.angleLock||segment?._stykRig?.anglePath||segment?._stykRig?.weighted);
export function rigIKAllowed(figure,index) {
  return Boolean(figure.segments[index])&&!derivedRigJoint(figure.segments[index]);
}
/** One lightweight context per evaluated object; outputs are bounded by its rig.
 * Positions belong to the caller's normal geometry, never a second scene graph. */
export function createRigEvaluation(figure, object, root, plan=rigConstraintPlan(figure), stateStorage, {project=true}={}) {
  const states=stateStorage??new Array(figure.segments.length), scale=Number(object.scale??1);
  const figureAngle=animationRotation(figure,object),camera=project?projection(object,root):null;
  return {plan, states, evaluate(i, input, joints) {
    const seg=figure.segments[i], r=seg._stykRig, c=r?.connector, d=r?.stretch, f=r?.follow, response=r?.response, lock=r?.angleLock;
    const parent=states[plan.ids.get(seg.parent_id)], rotation=r?.orientation==='world'?0:parent?.rotation??0;
    let {start,angle,length,bend}=input, width=1, inheritedRotation=rotation, ratio=1, handle, followAxis, followScale, position,span;
    if(r?.spatial)return states[i]=evaluateSpatial(r.spatial,{segment:seg,input,get:id=>states[plan.ids.get(id)],referenceRest:id=>figure.segments[plan.ids.get(id)].angle_rad??0,root,scale,figureAngle,mirror:Boolean(object.image_text_flags),restAngle:seg.angle_rad??0,camera,shape:object._stykSpatial?.shape?.[seg.segment_id]});
    if(r?.weighted)return states[i]=weightedJoint(r.weighted,joints,root,angle);
    if(r?.anglePath){
      const path=r.anglePath;let x,y,z,delta,origin;
      if(path.source!==undefined){const source=states[plan.ids.get(path.source)];({pathOrigin:origin,pathRotation:delta,pathDepth:z}=source);x=z;y=0;}
      else{
        delta=figureAngle-path.figureRestAngle;origin=joints.get(path.origin)??root;
        const turn=states[plan.ids.get(path.driver)].authoredAngle-path.restAngle-delta;
        [x,y,z]=sampleAnglePath(path.keys,turn);
        if(path.pitch!==undefined){const pitch=states[plan.ids.get(path.pitch)].authoredAngle-path.pitchRestAngle-delta,c=Math.cos(pitch),s=Math.sin(pitch),oldY=y;y=oldY*c-z*s;z=oldY*s+z*c;}
      }
      const c=Math.cos(delta),s=Math.sin(delta),dx=(x*c-y*s)*scale,dy=(x*s+y*c)*scale;
      start=origin;angle=Math.atan2(dy,dx);length=Math.hypot(dx,dy);handle={x:origin.x+dx,y:origin.y+dy};
      return states[i]={start,angle,authoredAngle:angle,length,bend:0,width:1,handle,rotation:angle-input.angle,ratio:1,impulseAngle:angle,
        space:{rotation:delta,locked:true},pathOrigin:origin,pathRotation:delta,pathDepth:z};
    }
    angle+=rotation;
    const source=plan.inputs[i],driver=source&&states[source.driver];
    let lockedAngle;
    if(lock){
      const figureDelta=lock.mode==='parent'&&lock.figureRestAngle!==undefined?animationRotation(figure,object)-lock.figureRestAngle:0;
      const reference=lock.mode==='parent'?states[plan.ids.get(lock.reference)]:null;
      const difference=lock.mode==='parent'?(lock.space==='authored'?reference.authoredAngle:reference.angle)-lock.restAngle-figureDelta:lock.mode==='figure'?animationRotation(figure,object)-lock.restAngle:0;
      lockedAngle=lock.angle+figureDelta+lock.multiplier*Math.atan2(Math.sin(difference),Math.cos(difference));
      if(lock.secondary){
        const other=states[plan.ids.get(lock.secondary.reference)],delta=(lock.space==='authored'?other.authoredAngle:other.angle)-lock.secondary.restAngle-figureDelta;
        lockedAngle+=lock.secondary.multiplier*Math.atan2(Math.sin(delta),Math.cos(delta));
      }
      if(lock.space==='authored'){angle=lockedAngle;inheritedRotation=angle-input.angle;}
    }
    const rawAngle=angle;
    const incoming=driver?.ratio??1;
    if(c) {
      start=joints.get(c.start)??root;
      const end=joints.get(c.end)??root, dx=end.x-start.x, dy=end.y-start.y, distance=Math.hypot(dx,dy);
      span=distance;
      bend=clampRig(bend,-Math.PI*1.99,Math.PI*1.99);
      const factor=Math.abs(bend)<EPS?1:2*Math.sin(bend/2)/bend;
      angle=distance>EPS?Math.atan2(dy,dx)-bend/2:input.angle+rotation;
      length=distance/factor;
      inheritedRotation=angle-input.angle-(scale<0?Math.PI:0);
      const t=clampRig(object.len_flag?object.lengths[i]:seg.length,0,1), sweep=bend*t;
      position=t;
      handle=Math.abs(bend)<EPS?{x:start.x+dx*t,y:start.y+dy*t}:
        {x:start.x+length/bend*(Math.sin(angle+sweep)-Math.sin(angle)),y:start.y+length/bend*(Math.cos(angle)-Math.cos(angle+sweep))};
    } else if(source&&(response?.mode??f?.mode??'stretch')==='stretch') {
      const widthResponse=figure.segments[source.driver]._stykRig.stretch.width;
      const amount=source.legacy&&response?.multiplier===undefined?
        clampRig((incoming<0?-1:1)*Math.pow(f.influence<0?Math.max(.01,Math.abs(incoming)):Math.abs(incoming),f.influence),-100,100):
        clampRig(1+(incoming-1)*(response?.multiplier??1),-100,100);
      followAxis=response?.reset?angle:states[source.axis].impulseAngle;followScale=amount;
      const relative=angle-followAxis;
      const x=Math.cos(relative)*amount,y=Math.sin(relative), factor=Math.hypot(x,y);
      angle=factor<EPS?angle:followAxis+Math.atan2(y,x);length*=factor;width*=rigWidth(Math.abs(amount),widthResponse);
    }
    if(d) {
      let actual=(c&&d.branch?span:Math.abs(length))/(Math.max(EPS,Math.abs(scale))*d.restLength);
      if(c){
        if(d.source==='slide')actual=position/d.restPosition;
        else if(d.source==='combined')actual*=position/d.restPosition;
        if(source&&response?.mode!=='rigid')actual*=clampRig(1+(incoming-1)*(response?.multiplier??1),-100,100);
      }
      ratio=c?(actual<0?-1:1)*clampRig(Math.abs(actual),d.min,d.max):clampRig(actual,d.min,d.max);
      // Connector endpoints are authoritative; limits bound their influence only.
      if(!c && actual>EPS)length*=ratio/actual;
      else if(!c && actual<=EPS)length=d.restLength*ratio*scale;
      width*=rigWidth(Math.abs(ratio),d.width);
    }
    if(lock&&lock.space!=='authored'){
      // Parent multipliers act within the figure. A whole-figure rotation must
      // still carry a counter-rotating attachment with the rest of its artwork.
      angle=lockedAngle;
      inheritedRotation=angle-input.angle;
    }
    const result={start,angle,authoredAngle:c||(lock&&lock.space!=='authored')?angle:rawAngle,length,bend,width,handle,position,connector:Boolean(c),rotation:inheritedRotation,ratio,
      impulseAngle:c?angle:response?.reset?rawAngle:angle,
      space:rotation||followScale!==undefined||lock?{rotation,followAxis,followScale,locked:Boolean(lock)}:undefined};
    states[i]=result;
    const outgoing=plan.outputs[i];
    if(outgoing&&!outgoing.legacy)result.childSpace={rotation:inheritedRotation,followAxis:states[outgoing.axis].impulseAngle,followScale:states[outgoing.driver].ratio};
    return result;
  }};
}

/** Invert the derived local space for predictable direct posing of details. */
export function authoredRigTarget(shape,x,y,pose) {
  const space=shape.rigSpace;if(!space)return {x,y};
  let dx=x-shape.start.x,dy=y-shape.start.y;
  if(space.followScale!==undefined){
    const c=Math.cos(space.followAxis),s=Math.sin(space.followAxis);let side=-dx*s+dy*c,along;
    if(Math.abs(space.followScale)<1e-4&&pose&&Math.abs(shape.bend??0)<1e-7){
      // An edge-on fixed-length control has lost one visible coordinate. Lift
      // the remaining coordinate onto its authored circle, keeping the nearest
      // branch instead of dividing pointer noise by zero or flipping the joint.
      const radius=Math.abs(pose.length);side=clampRig(side,-radius,radius);
      const prior=pose.length*Math.cos(pose.angle+space.rotation-space.followAxis);
      along=(prior<0?-1:1)*Math.sqrt(Math.max(0,radius*radius-side*side));
    }else{
      if(Math.abs(space.followScale)<1e-8)throw messageError(new Error(''), "errors.rigConstraints.expandTheStretchDriverBeforePosingAFully", {});
      along=(dx*c+dy*s)/space.followScale;
    }
    dx=along*c-side*s;dy=along*s+side*c;
  }
  const c=Math.cos(space.rotation),s=Math.sin(space.rotation);
  return {x:shape.start.x+dx*c+dy*s,y:shape.start.y-dx*s+dy*c};
}
