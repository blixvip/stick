import {construction} from './rig-examples-3d.mjs';
const TAU=Math.PI*2;
const shadeColor=(color,shade)=>color.map(v=>Math.round(v*shade));
/** Convex editable solids, projected entirely by native connector / stretch
 * constraints. Surface visibility is the only extra rendering property. */
function solid(points, faces, colors) {
  const q=construction(),b=q.basis({yaw:.55,tilt:.4});
  q.segments[b.turn-1].name='Turn';q.segments[b.depth-1].name='Depth';
  const height=q.add(0,100,-Math.PI/2,'Height',{control:true,rig:{stretch:{restLength:100,min:.2,max:3,width:'keep'}}});
  const basis=[0,q.add(0,40,0,'Facing X'),q.add(0,40,Math.PI/2,'Facing Y')];
  const ids=points.map(([x,y,z])=>{
    const id=q.vertex(b,Math.hypot(x,z),Math.atan2(z,x),y);
    if(y)q.segments[id-1]._stykRig.follow={driver:height,mode:'stretch',influence:1};
    return id;
  });
  const center=points.reduce((c,p)=>c.map((n,i)=>n+p[i]/points.length),[0,0,0]);
  faces.forEach(({vertices,paint='body'},i)=>{
    let cycle=vertices.slice();const [a,c,d]=cycle.slice(0,3).map(j=>points[j]),u=c.map((v,j)=>v-a[j]),v=d.map((n,j)=>n-a[j]);
    let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(n.reduce((sum,v,j)=>sum+v*(a[j]-center[j]),0)<0){cycle.reverse();n=n.map(v=>-v);}
    const length=Math.hypot(...n),shade=.76+.18*(-n[1]/length)+.06*(n[0]/length);
    q.polyfills.push({polyfill_id:i+1,segment_ids:cycle.map(j=>ids[j]),color_rgb:shadeColor(colors[paint],shade),color_alpha:1,z_order:0,
      _stykSurface:{basis:basis.slice(),side:'front',flipped:false}});
  });
  // Invisible connectors close every physical edge. They remain available for
  // attaching new parts at any slide position in Build Figure.
  const edges=new Set();
  for(const {vertices} of faces)vertices.forEach((a,i)=>{const c=vertices[(i+1)%vertices.length],key=[a,c].sort((a,b)=>a-b).join(':');if(!edges.has(key)){edges.add(key);q.edge(ids[a],ids[c],{width:0,name:'Surface edge'});}});
  return q;
}
const face=(vertices,paint='body')=>({vertices,paint});
const prism=(ring,halfHeight)=>{
  const n=ring.length,points=[-halfHeight,halfHeight].flatMap(y=>ring.map(([x,z])=>[x,y,z]));
  return {points,faces:[face(Array.from({length:n},(_,i)=>i),'accent'),face(Array.from({length:n},(_,i)=>i+n),'accent'),...ring.map((_,i)=>face([i,(i+1)%n,(i+1)%n+n,i+n]))]};
};
export const SOLID_RIG_EXAMPLES=[
  {id:'solid-box-3d',name:'Box',control:1,build(){const p=prism([[-85,-65],[85,-65],[85,65],[-85,65]],90);return solid(p.points,p.faces,{body:[75,153,204],accent:[173,211,230]});}},
  {id:'solid-cylinder-3d',name:'Cylinder',control:1,build(){const p=prism(Array.from({length:16},(_,i)=>[82*Math.cos(i*TAU/16),82*Math.sin(i*TAU/16)]),108);p.faces[4].paint='accent';p.faces[5].paint='accent';return solid(p.points,p.faces,{body:[221,122,71],accent:[250,211,149]});}},
  {id:'solid-wedge-3d',name:'Wedge',control:1,build(){return solid([[-105,70,-65],[105,70,-65],[105,-85,-65],[-105,70,65],[105,70,65],[105,-85,65]],
    [face([0,1,2]),face([3,4,5]),face([0,1,4,3]),face([1,2,5,4]),face([2,0,3,5],'accent')],{body:[75,164,135],accent:[172,221,179]});}},
  {id:'solid-pyramid-3d',name:'Pyramid',control:1,build(){return solid([[-110,85,-90],[110,85,-90],[110,85,90],[-110,85,90],[0,-145,0]],
    [face([0,1,2,3]),face([0,1,4]),face([1,2,4],'accent'),face([2,3,4]),face([3,0,4],'accent')],{body:[211,161,72],accent:[246,210,139]});}},
  {id:'solid-gem-3d',name:'Gem',control:1,build(){const ring=Array.from({length:8},(_,i)=>[107*Math.cos(i*TAU/8),0,107*Math.sin(i*TAU/8)]),points=[...ring,[0,-135,0],[0,135,0]];
    return solid(points,ring.flatMap((_,i)=>[face([i,(i+1)%8,8],i%2?'accent':'body'),face([i,(i+1)%8,9])]),{body:[153,119,203],accent:[211,179,240]});}},
];
