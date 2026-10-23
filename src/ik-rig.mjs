/** Projection adapter for the existing IK solver. Only dependencies of the
 * driven bones participate in iterative evaluation; surface vertices are never
 * rebuilt during a solve. Authored angles remain the animation channels. */
import {spatialBone,spatialPoint,quatMultiply,quaternionPose,betweenVectors} from './rig-spatial.mjs';
import {animationRotation} from './animation-origin.mjs';
import {inverseQuaternion,spatialWorldVector,spatialWorldQuaternion,spatialKnee,spatialIKOrientation} from './ik-spatial.mjs';
import {createRigEvaluation,rigConstraintPlan} from './rig-constraints.mjs';

export function rigIKContext(figure,object,root,handles,angles,lengths,plan=rigConstraintPlan(figure)) {
 const needed=new Set(),queue=handles.map(id=>plan.ids.get(Number(id))).filter(i=>i!==undefined);
 for(let q=0;q<queue.length;q++){
  const i=queue[q];if(needed.has(i))continue;needed.add(i);
  for(const dependency of plan.dependencies[i])queue.push(dependency);
 }
 const order=plan.order.filter(i=>needed.has(i)),sourcePlans=new Map();
 function evaluate(all=false){
  const current=lengths(),points=new Map([[0,root]]),states=[],contexts=new Map();
  const evaluation=figure._rigSources?null:createRigEvaluation(figure,object,root,plan,states,{project:false});
  for(const i of all?plan.order:order){
   const s=figure.segments[i],start=points.get(s.parent_id)??root,bend=object.bend_flag?object.bends[i]:s.bend_rad??0;
   const length=(current?.[i]??(object.len_flag?object.lengths[i]:s.length))*object.scale;
   let p;
   const source=figure._rigSources?.[i];
   if(source){
    let context=contexts.get(source.group);
    if(!context){
     const g=source.group,origin=points.get(g.rootId)??root;
     if(!sourcePlans.has(g))sourcePlans.set(g,rigConstraintPlan(g.figure));
     context={evaluation:createRigEvaluation(g.figure,g.object,origin,sourcePlans.get(g),[],{project:false}),joints:{get:id=>points.get(id?g.ids.get(id):g.rootId)}};
     contexts.set(g,context);
    }
    p=context.evaluation.evaluate(source.index,{start,angle:angles[i],length,bend},context.joints);states[i]=p;
   }else p=evaluation.evaluate(i,{start,angle:angles[i],length,bend},points);
   const b=p.bend;
   const span=p.length*(Math.abs(b)<1e-8?1:2*Math.sin(b/2)/b),a=p.angle+b/2;
   points.set(s.segment_id,p.handle??{x:p.start.x+Math.cos(a)*span,y:p.start.y+Math.sin(a)*span});
  }
  return {points,states};
 }
 function refine(chain,target,{iterations=40,tolerance=1e-4}={}){
  const endpoint=figure.segments[chain.at(-1)].segment_id;
  const variables=[...new Set(chain.flatMap(i=>spatialBone(figure.segments[i])?[i,plan.ids.get(figure.segments[i]._stykRig.spatial.turn),plan.ids.get(figure.segments[i]._stykRig.spatial.pitch)]:[i]))];
  let sample=evaluate(),p=sample.points.get(endpoint),error=Math.hypot(target.x-p.x,target.y-p.y),used=0;
  for(;used<iterations&&error>tolerance;used++){
   const dx=target.x-p.x,dy=target.y-p.y,jacobian=[];let xx=1e-5,xy=0,yy=1e-5;
   for(const i of variables){
    const angle=angles[i],step=1e-4;angles[i]=angle+step;const plus=evaluate().points.get(endpoint);angles[i]=angle-step;const minus=evaluate().points.get(endpoint);angles[i]=angle;
    const x=(plus.x-minus.x)/(2*step),y=(plus.y-minus.y)/(2*step);jacobian.push([x,y]);xx+=x*x;xy+=x*y;yy+=y*y;
   }
   const determinant=xx*yy-xy*xy;if(!Number.isFinite(determinant)||determinant<1e-14)break;
   const ux=(yy*dx-xy*dy)/determinant,uy=(xx*dy-xy*dx)/determinant;
   const delta=jacobian.map(([x,y])=>Math.max(-.35,Math.min(.35,x*ux+y*uy))),baseline=variables.map(i=>angles[i]);
   let accepted=false;
   for(const factor of [1,.5,.25,.125]){
    variables.forEach((i,j)=>{angles[i]=baseline[j]+factor*delta[j];});const next=evaluate(),point=next.points.get(endpoint),distance=Math.hypot(target.x-point.x,target.y-point.y);
    if(distance<error-1e-9){sample=next;p=point;error=distance;accepted=true;break;}
   }
   if(!accepted){
    variables.forEach((i,j)=>{angles[i]=baseline[j];});
    // A straight limb pulled inward has zero first-order shortening. Explore
    // bounded null-space bends, preserving the endpoint's tangent direction,
    // instead of getting stuck or choosing a random screen-space knee flip.
    if(variables.length>chain.length)for(let j=0;j<variables.length;j++){
     const[x,y]=jacobian[j],vx=(yy*x-xy*y)/determinant,vy=(xx*y-xy*x)/determinant;
     const direction=jacobian.map(([a,b],k)=>(k===j?1:0)-a*vx-b*vy),norm=Math.max(...direction.map(Math.abs));
     if(norm<1e-5)continue;
     for(const sign of [1,-1]){
      variables.forEach((i,k)=>{angles[i]=baseline[k]+direction[k]/norm*.18*sign;});
      const next=evaluate(),point=next.points.get(endpoint),distance=Math.hypot(target.x-point.x,target.y-point.y);
      if(distance<error-1e-7){sample=next;p=point;error=distance;accepted=true;break;}
     }
     if(accepted)break;
    }
    if(!accepted){variables.forEach((i,j)=>{angles[i]=baseline[j];});break;}
   }
  }
  return {sample,error,iterations:used};
 }
 function setOrientation(i,q,sample,descendants=[]){
  const s=figure.segments[i],r=s._stykRig.spatial,source=figure._rigSources?.[i],f=source?.group.figure??figure,o=source?.group.object??object;
  const parentId=source?source.group.figure.segments[source.index]._stykRig.spatial.parent:r.parent;
  const parent=parentId?sample.states[plan.ids.get(source?source.group.ids.get(parentId):parentId)]?.spatial:null,frame=sample.states[i].spatial;
  const angle=animationRotation(f,o),sign=o.image_text_flags?-1:1,turn=plan.ids.get(r.turn),pitch=plan.ids.get(r.pitch);
  const local=quatMultiply(inverseQuaternion(parent?.q??[0,0,0,1]),q),previous={bend:frame.nativeBend-(parent?.nativeBend??0),turn:(angles[turn]-angle)*sign-figure.segments[turn].angle_rad,pitch:(angles[pitch]-angle)*sign-figure.segments[pitch].angle_rad};
  const pose=quaternionPose(local,previous),delta=(pose.bend-previous.bend)*sign;
  angles[i]+=delta;angles[turn]=angle+(pose.turn+figure.segments[turn].angle_rad)*sign;angles[pitch]=angle+(pose.pitch+figure.segments[pitch].angle_rad)*sign;
  for(const child of descendants)angles[child]+=delta;
 }
 function orientWorld(i,q,descendants){
  const source=figure._rigSources?.[i],f=source?.group.figure??figure,o=source?.group.object??object;
  setOrientation(i,spatialWorldQuaternion(q,f,o,true),evaluate(),descendants);
 }
 function solveSpatial(chain,target,settings){
  if(chain.length!==2||!settings||!chain.every(i=>spatialBone(figure.segments[i]))||Math.abs(object.scale)<1e-9)return null;
  // Cross-figure chains retain the projection solver; each source can have a
  // different scale/placement. The analytic solver owns a single spatial rig.
  if(figure._rigSources)return null;
  let sample=evaluate();const [a,b]=chain,sa=figure.segments[a]._stykRig.spatial,sb=figure.segments[b]._stykRig.spatial;
  const base=spatialPoint(sample.states[a].spatial,sa.origin),middle=spatialPoint(sample.states[a].spatial,sa.tip),end=spatialPoint(sample.states[b].spatial,sb.tip);
  const aim=spatialWorldVector([(target.x-root.x)/object.scale,(target.y-root.y)/object.scale,settings.depth/object.scale],figure,object,true);
  const length=(p,q)=>Math.hypot(...p.map((v,i)=>v-q[i])),pole=spatialWorldVector(settings.pole,figure,object,true);
  if(length(base,middle)<1e-8||length(middle,end)<1e-8)return null;
  const solved=spatialKnee(base,aim,pole,settings.swivel??0,length(base,middle),length(middle,end));
  const unit=v=>{const n=Math.hypot(...v);return v.map(x=>x/Math.max(n,1e-9));};
  for(const [j,i,tip] of [[0,a,solved.knee],[1,b,solved.end]]){
   const r=figure.segments[i]._stykRig.spatial,frame=sample.states[i].spatial,start=spatialPoint(frame,r.origin),end=spatialPoint(frame,r.tip);
   const direction=unit(tip.map((v,k)=>v-start[k]));
   const q=settings.normals?spatialIKOrientation(frame.axis,settings.normals[j],direction,solved.normal)
    :quatMultiply(betweenVectors(unit(end.map((v,k)=>v-start[k])),direction),frame.q);
   setOrientation(i,q,sample);sample=evaluate();
  }
  const p=sample.points.get(figure.segments[b].segment_id);return {sample,error:Math.hypot(p.x-target.x,p.y-target.y),iterations:1};
 }
 return {evaluate,refine,solveSpatial,orientWorld,dependencyCount:order.length};
}
