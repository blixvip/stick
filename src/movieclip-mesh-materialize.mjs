/** Explicit flatten/export only. Live meshes never allocate native skin joints. */
import {createObject} from './demo.mjs';
export function materializeMeshGeometry(geometry,point,typeId,uid,opacity=1) {
  const segments=[],polyfills=[],points=new Map();
  const add=(x,y)=>{const id=segments.length+1;segments.push({segment_id:id,parent_id:0,length:Math.hypot(x,y),angle_rad:Math.atan2(y,x),thickness:0,bend_rad:0,primitive_code:0,aux_code:1,flags:256,visible:false,color_rgb:[0,0,0],z_order:0});return id;};
  const x=add(1,0),y=add(0,1),basis=[0,x,y];
  const vertex=(p,z)=>{const key=p.x+':'+p.y+':'+z;if(!points.has(key))points.set(key,[add(p.x,p.y),add(z,0)]);return points.get(key);};
  const mesh=geometry.spatialMesh,P=mesh?.positions,D=mesh?.depth;
  for(const item of geometry.drawables){
    for(let t=0;t<item.count;t++){
      const corners=[0,1,2].map(k=>{const v=item.triangles[t*3+k];return {p:point({x:P[v*2],y:P[v*2+1]}),z:D[v]};});
      const ids=corners.map(c=>vertex(c.p,c.z)),[a,b,c]=corners.map(c=>c.p);
      const flipped=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)<0;
      polyfills.push({polyfill_id:polyfills.length+1,segment_ids:ids.map(p=>p[0]),color_rgb:mesh.colors[item.materials[t]].slice(),color_alpha:1,z_order:0,
        _stykSurface:{basis,depth:ids.map(p=>p[1]),depthTest:true,flipped}});
    }
  }
  const figure={figure_type_id:typeId,name:geometry.fig.name,segments,segment_count:segments.length,polyfills,image_assets:[],text_assets:[]};
  return {figure,object:createObject(figure,uid,0,0,{field28:Math.round(255*(1-opacity*(1-(geometry.obj.field28??0)/255)))})};
}
