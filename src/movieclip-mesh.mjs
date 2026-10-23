import {messageError} from './localized-error.mjs';
/** Immutable, indexed meshes share the movieclip form/timing contract. Only
 * controls belong to the rig graph; vertices never become editable joints. */
import {animationRotation} from './animation-origin.mjs';
import {spatialPoint,spatialViewInterpolation} from './rig-spatial.mjs';
import {projection} from './spatial-projection.mjs';
import {spatialMeshDrawables} from './spatial-mesh.mjs';

const NEAR=.05,ROOT_INDICES=Object.freeze({x:[8,11,15],y:[9,12,16]});

export function validateMovieclipMeshes(asset) {
  const meshes=asset.spatialMeshes;if(meshes===undefined)return;
  if(asset.drawingRotation||!Array.isArray(meshes)||meshes.length!==asset.duration||meshes.length>128)
    throw messageError(new Error(''), "errors.movieclipMesh.spatialFormsNeedOneMeshPerClipFrame", {});
  let total=0;
  for(const m of meshes){
    if(!m||!Array.isArray(m.positions)||m.positions.length<9||m.positions.length%3||m.positions.length>300000||m.positions.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6)||
      !Array.isArray(m.indices)||!m.indices.length||m.indices.length%3||m.indices.length>600000||m.indices.some(i=>!Number.isInteger(i)||i<0||i>=m.positions.length/3)||
      !Array.isArray(m.colors)||!m.colors.length||m.colors.length>256||m.colors.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255))||
      !Array.isArray(m.materials)||m.materials.length!==m.indices.length/3||m.materials.some(i=>!Number.isInteger(i)||i<0||i>=m.colors.length))
      throw messageError(new Error(''), "errors.movieclipMesh.invalidIndexedSpatialMesh", {});
    const views=m.viewPositions;
    if(views!==undefined&&(!Array.isArray(views)||![4,8].includes(views.length)||views.some(v=>!Array.isArray(v)||v.length!==m.positions.length||v.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6))))
      throw messageError(new Error(''), "errors.movieclipMesh.viewCorrectedMeshesNeedFourOrEightComplete", {});
    if(m.viewTurns!==undefined&&(!views||!Array.isArray(m.viewTurns)||m.viewTurns.length!==views.length||m.viewTurns.some(t=>!Number.isFinite(t)||Math.abs(t)>Math.PI)||
      !Array.isArray(m.viewPivot)||m.viewPivot.length!==3||m.viewPivot.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6)))
      throw messageError(new Error(''), "errors.movieclipMesh.viewTurnsNeedOneAnglePerViewSet", {});
    if(m.viewTurnWeights!==undefined&&(!m.viewTurns||!Array.isArray(m.viewTurnWeights)||m.viewTurnWeights.length!==m.positions.length/3||m.viewTurnWeights.some(w=>!Number.isFinite(w)||w<0||w>1)))
      throw messageError(new Error(''), "errors.movieclipMesh.viewTurnWeightsNeedOneValueFrom0", {});
    total+=m.positions.length*(1+(views?.length??0))+m.indices.length;if(total>6000000)throw messageError(new Error(''), "errors.movieclipMesh.spatialMeshAssetExceedsItsGeometryBudget", {});
  }
}

/** Same triangle/depth contract as native surfaces, including near clipping.
 * Immutable points may be shared with an unchanged incremental pose; no
 * previous geometry or independent pose cache is retained. */
export function* buildMovieclipMeshSteps(fig,obj,root,slot,parent,objectColor,previous) {
  const asset=fig._styk.movieclip,local=obj._movieclipSample===null?null:obj._movieclipSample??obj._stykMovieclip?.offset??0;
  const joint=parent?.segments.find(s=>s.seg.segment_id===obj.join?.target_handle_id),frame=joint?.spatialFrame;
  // A spatial bone owns the attachment's orientation. Pivot-style joins also
  // rotate joined children when the parent bends, which must not apply twice.
  const localAngle=Number(obj.angles?.[0]??0),
    angle=frame?animationRotation(parent.fig,parent.obj):localAngle,cs=Math.cos(angle),sn=Math.sin(angle),
    scale=Number(obj.scale??1),mirror=(obj.image_text_flags?-1:1)*(frame&&parent.obj.image_text_flags?-1:1),
    camera=frame?projection(parent.obj,parent.root):null;
  if(frame)root={...joint.start};
  const end={x:root.x+40*scale*cs,y:root.y+40*scale*sn},handle={seg:fig.segments[0],obj,fig,slot,index:0,start:root,end,points:[root,end],angle,length:40*scale,bend:0,thickness:0,opacity:1,alpha:1,rgb:[0,0,0]},
    geometry={obj,fig,slot,root,joints:new Map([[0,root],[1,end]]),segments:[handle],polys:[],drawables:[],meshAttachment:true};
  if(local===null)return geometry;
  const mesh=asset.spatialMeshes[Math.max(0,Math.min(asset.spatialMeshes.length-1,Math.floor(local)))];
  const parentScale=Number(parent?.obj.scale??1),ratio=frame&&Math.abs(parentScale)>1e-12?scale/parentScale:0;
  const pose=[frame?0:localAngle,angle,scale,mirror,obj.image_text_flags,parent?.obj.image_text_flags,asset.pivot.x,asset.pivot.y,root.x,root.y,parentScale,parent?.root.x,parent?.root.y,camera?.k,camera?.scale,camera?.root.x,camera?.root.y,
    ...(frame?[...frame.q,...frame.t,...frame.origin,...frame.axis,frame.stretch,frame.choiceScale,frame.shape?.width,frame.shape?.taper,frame.restLength]:[])];
  const colors=mesh.colors.map(c=>objectColor?objectColor(c,obj):c),opacity=1-Number(obj.field28??0)/255,owner={obj,fig,slot,opacity};
  geometry.meshPose={mesh,pose};
  const old=previous?.meshPose;
  if(old?.mesh===mesh&&previous.fig===fig&&old.pose.length===pose.length&&pose.every((v,i)=>v===old.pose[i])&&previous.spatialMesh){
    // Retain only arrays from this pose, never a link to an earlier geometry.
    const prior=previous.spatialMesh,same=prior.colors.every((c,i)=>c.every((v,j)=>v===colors[i][j]));
    geometry.spatialMesh=same?prior:{...prior,colors};
    geometry.drawables=geometry.meshDrawables=spatialMeshDrawables(geometry.spatialMesh,owner,[]);
    return geometry;
  }
  const n=mesh.positions.length/3,flipY=obj.image_text_flags?-1:1,parentFlip=parent?.obj.image_text_flags?-1:1;
  let positions=new Float32Array(n*2),depth=new Float32Array(n),extra=0;
  const raw=new Float64Array(n*3);
  // Most attachments are affine. Evaluate the bone four times instead of
  // allocating quaternion/stretch intermediates for every mesh vertex.
  let affine;
  if(frame&&!frame.shape?.taper){const o=spatialPoint(frame,frame.origin);affine=[o,...[0,1,2].map(i=>{const p=frame.origin.slice();p[i]++;return spatialPoint(frame,p).map((v,j)=>v-o[j]);})];}
  // Art-directed views: blend the two authored shapes around the attachment's
  // heading, like view-corrected skin. Topology and draw order never change.
  const view=frame&&mesh.viewPositions?spatialViewInterpolation(frame):null,span=view&&(mesh.viewPositions.length===8?view.eight:view.four);
  const from=span&&mesh.viewPositions[span.index],to=span&&mesh.viewPositions[span.next];
  // A per-view turn about the pivot's vertical axis is interpolated as an
  // angle; blending two rotated shapes linearly would shrink them in between.
  // Shortest-arc blending lets opposite headings share a half-turn. Weighted
  // vertices (e.g. hair over a turning face) receive a fraction of the turn.
  const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a)),turns=mesh.viewTurns,weights=mesh.viewTurnWeights;
  const turn=span&&turns?(turns[span.index]+wrap(turns[span.next]-turns[span.index])*span.blend)*view.strength:0,pivot=mesh.viewPivot;
  let tc=Math.cos(turn),ts=Math.sin(turn),weight=1;
  const authored=k=>{const base=mesh.positions[k];if(!span)return base;const target=from[k]+(to[k]-from[k])*span.blend;return base+(target-base)*view.strength;};
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,zMin=Infinity,zMax=-Infinity;
  const include=i=>{const px=positions[i*2],py=positions[i*2+1],q=depth[i];if(px<x0)x0=px;if(px>x1)x1=px;if(py<y0)y0=py;if(py>y1)y1=py;if(q<zMin)zMin=q;if(q>zMax)zMax=q;};
  const nearZ=camera?(1-NEAR)/camera.k:Infinity;
  for(let i=0;i<n;i++){
    const at=i*3;let vx=authored(at),vy=authored(at+1),vz=authored(at+2);
    if(turn){
      if(weights&&weights[i]!==weight){weight=weights[i];tc=Math.cos(turn*weight);ts=Math.sin(turn*weight);}
      const x=vx-pivot[0],z=vz-pivot[2];vx=pivot[0]+x*tc+z*ts;vz=pivot[2]-x*ts+z*tc;
    }
    const px=vx-asset.pivot.x,py=(vy-asset.pivot.y)*flipY,pz=vz;
    let X,Y,Z;
    if(frame){
      let bx,by,bz;
      if(affine){bx=affine[0][0]+ratio*(px*affine[1][0]+py*affine[2][0]+pz*affine[3][0]);by=affine[0][1]+ratio*(px*affine[1][1]+py*affine[2][1]+pz*affine[3][1]);bz=affine[0][2]+ratio*(px*affine[1][2]+py*affine[2][2]+pz*affine[3][2]);}
      else [bx,by,bz]=spatialPoint(frame,[frame.origin[0]+px*ratio,frame.origin[1]+py*ratio,frame.origin[2]+pz*ratio]);
      X=parent.root.x+(bx*cs-by*parentFlip*sn)*parentScale;Y=parent.root.y+(bx*sn+by*parentFlip*cs)*parentScale;Z=bz*parentScale;
    }else{X=root.x+(px*cs-py*sn)*scale;Y=root.y+(px*sn+py*cs)*scale;Z=pz*scale;}
    raw[at]=X;raw[at+1]=Y;raw[at+2]=Z;
    if(camera){const d=Math.max(NEAR,1-camera.k*Z);positions[i*2]=camera.root.x+(X-camera.root.x)/d;positions[i*2+1]=camera.root.y+(Y-camera.root.y)/d;depth[i]=Z/(d*camera.scale);}
    else{positions[i*2]=X;positions[i*2+1]=Y;depth[i]=Z/Math.max(1e-12,Math.abs(scale));}
    if((i&8191)===8191)yield {phase:'geometry',stage:'mesh vertices',slot,completed:i+1,total:n};
  }
  const I=mesh.indices,T=mesh.materials.length;
  let triangles=new Uint32Array(T*3),materials=new Uint16Array(T),z=new Float32Array(T),count=0;
  const push=(a,b,c,material,value)=>{
    if(count===materials.length){const size=Math.max(16,count*2);let t=new Uint32Array(size*3);t.set(triangles);triangles=t;t=new Uint16Array(size);t.set(materials);materials=t;t=new Float32Array(size);t.set(z);z=t;}
    triangles[count*3]=a;triangles[count*3+1]=b;triangles[count*3+2]=c;materials[count]=material;z[count]=value;count++;
    // Bounds and depth range follow visible faces, as native surfaces do.
    include(a);include(b);include(c);
  };
  for(let t=0;t<T;t++){
    const a=I[t*3],b=I[t*3+1],c=I[t*3+2];
    if(raw[a*3+2]<=nearZ&&raw[b*3+2]<=nearZ&&raw[c*3+2]<=nearZ){
      // Closed meshes use outward winding. Screen coordinates have Y down.
      const ax=positions[a*2],ay=positions[a*2+1],area=(positions[b*2]-ax)*(positions[c*2+1]-ay)-(positions[b*2+1]-ay)*(positions[c*2]-ax);
      if(area*mirror>1e-10)push(a,b,c,mesh.materials[t],(depth[a]+depth[b]+depth[c])/3);
    }else{
      // Clip against the near plane before projection, as native surfaces do.
      const clipped=[];
      for(const [p,q] of [[a,b],[b,c],[c,a]]){
        const pz=raw[p*3+2],qz=raw[q*3+2],inside=pz<=nearZ,next=qz<=nearZ;
        if(inside)clipped.push([raw[p*3],raw[p*3+1],pz]);
        if(inside!==next){const s=(nearZ-pz)/(qz-pz);clipped.push([raw[p*3]+(raw[q*3]-raw[p*3])*s,raw[p*3+1]+(raw[q*3+1]-raw[p*3+1])*s,nearZ]);}
      }
      if(clipped.length<3)continue;
      const projected=clipped.map(([X,Y,Z])=>{const d=Math.max(NEAR,1-camera.k*Z);return [camera.root.x+(X-camera.root.x)/d,camera.root.y+(Y-camera.root.y)/d,Z/d/camera.scale];});
      const [p0,p1,p2]=projected;
      if(((p1[0]-p0[0])*(p2[1]-p0[1])-(p1[1]-p0[1])*(p2[0]-p0[0]))*mirror<=1e-10)continue;
      const ids=projected.map(([x,y,d])=>{
        const at=n+extra;
        if(at>=depth.length){const size=Math.max(64,depth.length*2);const p=new Float32Array(size*2);p.set(positions);positions=p;const q=new Float32Array(size);q.set(depth);depth=q;}
        positions[at*2]=x;positions[at*2+1]=y;depth[at]=d;extra++;include(at);return at;
      }),value=projected.reduce((s,p)=>s+p[2],0)/projected.length;
      for(let i=1;i+1<ids.length;i++)push(ids[0],ids[i],ids[i+1],mesh.materials[t],value);
    }
    if((t&16383)===16383)yield {phase:'geometry',stage:'mesh faces',slot,completed:t+1,total:T};
  }
  // Root-relative artwork identity: attachment, parent and camera centres.
  geometry.spatialMesh={key:Float64Array.from(pose,v=>v===undefined?NaN:Number(v)),rootIndices:ROOT_INDICES,vertexCount:n+extra,positions,depth,triangles,materials,z,count,colors,
    bounds:count&&x0<=x1?{x0,y0,x1,y1}:null,zMin,zMax};
  geometry.drawables=geometry.meshDrawables=spatialMeshDrawables(geometry.spatialMesh,owner,[]);
  return geometry;
}
