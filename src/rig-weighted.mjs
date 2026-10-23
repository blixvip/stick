import {messageError} from './localized-error.mjs';
/** A bounded affine attachment in the existing rig graph. Anchors are evaluated
 * by the normal dependency plan; no solver, per-frame cache or pose state. */
export function sameWeightedJoint(a,b) {
  return a===b||Boolean(a&&b&&a.origin===b.origin&&a.anchors?.length===b.anchors?.length&&
    a.anchors.every((v,i)=>v.joint===b.anchors[i].joint&&v.weight===b.anchors[i].weight)&&sameWeightedJoint(a.depth,b.depth));
}
export function validateWeightedJoint(value,reference,dependencies,depth=false) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['origin','anchors',...(!depth?['depth']:[])].includes(k))||
    !Array.isArray(value.anchors)||value.anchors.length<1||value.anchors.length>16)throw messageError(new Error(''), "errors.rigWeighted.aWeightedJointRequires116Anchors", {});
  reference(value.origin,'Weighted origin',true);dependencies.add(value.origin);
  const seen=new Set();
  for(const anchor of value.anchors){
    if(!anchor||typeof anchor!=='object'||Array.isArray(anchor)||Object.keys(anchor).some(k=>!['joint','weight'].includes(k)))throw messageError(new Error(''), "errors.rigWeighted.invalidWeightedAnchor", {});
    reference(anchor.joint,'Weighted anchor',true);dependencies.add(anchor.joint);
    if(seen.has(anchor.joint)||anchor.joint===value.origin)throw messageError(new Error(''), "errors.rigWeighted.chooseDistinctWeightedAnchorsOutsideTheOrigin", {});
    seen.add(anchor.joint);
    if(!Number.isFinite(anchor.weight)||Math.abs(anchor.weight)>100)throw messageError(new Error(''), "errors.rigWeighted.anchorWeightMustBeBetween100And100", {});
  }
  if(value.depth!==undefined)validateWeightedJoint(value.depth,reference,dependencies,true);
}
export function remapWeightedJoint(value,remap) {
  return {origin:remap.get(value.origin)??value.origin,anchors:value.anchors.map(a=>({...a,joint:remap.get(a.joint)??a.joint})),
    ...(value.depth?{depth:remapWeightedJoint(value.depth,remap)}:{})};
}
function position(value,joints,root){
  const start=joints.get(value.origin)??root;let dx=0,dy=0;
  for(const {joint,weight} of value.anchors){const p=joints.get(joint)??root;dx+=(p.x-start.x)*weight;dy+=(p.y-start.y)*weight;}
  return {start,dx,dy};
}
export function weightedJoint(value,joints,root,inputAngle) {
  const {start,dx,dy}=position(value,joints,root);
  const angle=Math.hypot(dx,dy)<1e-8?inputAngle:Math.atan2(dy,dx);
  const depth=value.depth?position(value.depth,joints,root):null;
  return {start,angle,authoredAngle:angle,length:Math.hypot(dx,dy),bend:0,width:1,
    handle:{x:start.x+dx,y:start.y+dy},rotation:angle-inputAngle,ratio:1,impulseAngle:angle,
    ...(depth?{depthOffset:{x:depth.start.x+depth.dx-root.x,y:depth.start.y+depth.dy-root.y}}:{}),
    space:{rotation:angle-inputAngle,locked:true}};
}
