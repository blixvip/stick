/** Editable orthographic constructions. Every visible edge is a connector.
 * A zero-position connector transfers yaw to its children; Smart Stretch
 * compresses their world-space depth axis. Vertical offsets stay world-aligned.
 * No mesh, baked poses, expression runtime or special renderer is involved. */
const TAU=Math.PI*2;
const C={ink:[40,66,85],blue:[30,143,202],cyan:[55,185,205],orange:[235,143,55],violet:[138,107,202],pale:[153,181,194]};
export function construction(){
  const segments=[],polyfills=[];
  const add=(parent,length,angle,name,{width=0,color=C.ink,rig,control=false,opacity=1}={})=>{
    const id=segments.length+1;
    segments.push({segment_id:id,parent_id:parent,length,angle_rad:angle,thickness:width,bend_rad:0,
      primitive_code:0,aux_code:control?0:1,flags:control?0:256,segment_type:'line',segment_kind:'line',
      color_rgb:color.slice(),transparency:Math.round((1-opacity)*255),visible:width>0,z_order:id,name,...(rig?{_stykRig:rig}:{})});
    return id;
  };
  const edge=(a,b,{color=C.ink,width=2,name='Edge',position=.5,control=false,opacity=1}={})=>
    add(a,position,0,name,{color,width,control,opacity,rig:{connector:{start:a,end:b,restLength:100}}});
  const face=(ids,color,opacity=.1)=>polyfills.push({segment_ids:ids,color_rgb:color.slice(),color_alpha:opacity,z_order:-1});
  const basis=({yaw=-.35,tilt=.42,axis=Math.PI/2,prefix=''}={})=>{
    const turn=add(0,165,yaw,`${prefix}Turn · drag to rotate`,{control:true});
    const depth=add(0,tilt*100,axis,`${prefix}Depth · Ctrl-drag`,{control:true,rig:{stretch:{restLength:100,min:0,max:1,width:'keep'}}});
    const frame=edge(0,turn,{width:0,position:0,name:`${prefix}Rotation frame`});
    return {turn,depth,frame};
  };
  const vertex=(b,r,angle,height=0,name='Vertex')=>{
    const radial=add(b.frame,r,angle,`${name} · projected radius`,{rig:{follow:{driver:b.depth,mode:'stretch',influence:1}}});
    return height?add(radial,Math.abs(height),height<0?-Math.PI/2:Math.PI/2,name,{rig:{orientation:'world'}}):radial;
  };
  const ring=(b,r,height,n=16,phase=0)=>Array.from({length:n},(_,i)=>vertex(b,r,phase+i*TAU/n,height));
  const loop=(ids,style)=>ids.forEach((id,i)=>edge(id,ids[(i+1)%ids.length],style));
  return {segments,polyfills,add,edge,face,basis,vertex,ring,loop};
}

export const CONNECTOR_3D_EXAMPLES=[
  {id:'glass-cube-3d',name:'Glass cube',control:1,
    description:'Drag Turn to rotate the cube in depth. Ctrl-drag Depth to change the viewing angle. The orange bead slides along a diagonal between moving corners.',
    build(){const q=construction(),b=q.basis({yaw:.25,tilt:.42}),top=q.ring(b,115,-80,4,Math.PI/4),bottom=q.ring(b,115,80,4,Math.PI/4);
      q.loop(top,{color:C.blue,width:3});q.loop(bottom,{color:C.ink,width:2});
      top.forEach((v,i)=>{q.edge(v,bottom[i],{color:i%2?C.cyan:C.ink,width:2.5});q.face([v,top[(i+1)%4],bottom[(i+1)%4],bottom[i]],i%2?C.cyan:C.blue,.065);});
      q.face(top,C.blue,.13);q.face(bottom,C.ink,.035);
      const slide=q.edge(top[0],bottom[2],{color:C.orange,width:1.5,position:.38,control:true,name:'Diagonal bead · slide'});
      const bead=q.add(slide,6,-Math.PI/2,'Bead',{width:12,color:C.orange,rig:{orientation:'world'}});
      q.segments[bead-1].primitive_code=1;q.segments[bead-1].segment_type='circle';q.segments[bead-1].segment_kind='circle';
      return {...q,projection:{...b,radius:115,height:-80,phase:Math.PI/4,vertices:top},sliders:[slide]};}},
  {id:'wire-globe-3d',name:'Meridian globe',control:1,
    description:'Turn a connected globe with latitude rings, meridians and a highlighted equator. Ctrl-drag Depth to flatten or deepen the projection.',
    build(){const q=construction(),b=q.basis({yaw:.2,tilt:.42}),radius=135,levels=[-120,-90,-45,0,45,90,120],rings=levels.map(h=>q.ring(b,Math.sqrt(radius**2-h**2),h,16));
      rings.forEach((r,i)=>q.loop(r,{color:i===3?C.orange:C.blue,width:i===3?3:1.25,opacity:i===3?1:.72}));
      for(let i=0;i<16;i++)for(let j=1;j<rings.length;j++)q.edge(rings[j-1][i],rings[j][i],{color:i%4===0?C.ink:C.cyan,width:i%4===0?2:1.15,opacity:.78});
      const north=q.add(0,135,-Math.PI/2,'North pole'),south=q.add(0,135,Math.PI/2,'South pole');
      rings[0].forEach(v=>q.edge(north,v,{color:C.blue,width:1.1,opacity:.6}));rings.at(-1).forEach(v=>q.edge(v,south,{color:C.blue,width:1.1,opacity:.6}));
      return {...q,projection:{...b,radius:135,height:0,phase:0,vertices:rings[3]}};}},
  {id:'double-helix-3d',name:'Double helix',control:1,
    description:'Rotate a DNA-style double helix. Each rung stays connected to both twisting strands; the purple midpoint marker can travel across its rung.',
    build(){const q=construction(),b=q.basis({yaw:-.45,tilt:.48}),a=[],c=[],n=23;
      for(let i=0;i<n;i++){const h=-145+i*290/(n-1),angle=i*TAU/13;a.push(q.vertex(b,76,angle,h));c.push(q.vertex(b,76,angle+Math.PI,h));}
      for(let i=0;i<n;i++){q.edge(a[i],c[i],{color:i%2?C.pale:C.ink,width:3,opacity:.72});if(i){q.edge(a[i-1],a[i],{color:C.blue,width:5});q.edge(c[i-1],c[i],{color:C.orange,width:5});}}
      const slide=q.edge(a[11],c[11],{width:0,control:true,position:.35,name:'Rung marker · slide'});
      q.add(slide,1,0,'Marker',{width:12,color:C.violet,rig:{orientation:'world'}});
      return {...q,sliders:[slide]};}},
  {id:'perspective-tunnel-3d',name:'Perspective tunnel',control:1,
    description:'Move the vanishing-point control to reshape a corridor. Its five cross-sections attach to sliding connector joints. Slide a section to change the depth spacing.',
    build(){const q=construction(),depth=q.add(0,175,-.35,'Vanishing point · drag / Ctrl-stretch',{control:true}),rings=[],slides=[];
      for(let j=0;j<6;j++){const t=j/5,size=122*(1-t)+29*t,slide=q.edge(0,depth,{position:t,width:0,control:j>0&&j<5,name:`Section ${j+1} · slide`});slides.push(slide);
        rings.push(Array.from({length:4},(_,i)=>q.add(slide,size*Math.SQRT2,Math.PI/4+i*Math.PI/2,'Cross-section corner',{rig:{orientation:'world'}})));}
      rings.forEach((r,j)=>{q.loop(r,{color:j===0?C.ink:j===5?C.orange:C.blue,width:j===0?3:1.7});if(j)for(let i=0;i<4;i++)q.edge(rings[j-1][i],r[i],{color:i%2?C.cyan:C.ink,width:2});});
      for(let j=1;j<rings.length;j++){q.face([rings[j-1][0],rings[j-1][1],rings[j][1],rings[j][0]],C.blue,.15);q.face([rings[j-1][1],rings[j-1][2],rings[j][2],rings[j][1]],C.cyan,.055);}
      const mid=q.edge(slides[1],slides[4],{width:0,position:.5,control:true,name:'Nested dolly · slide'});
      q.add(mid,1,0,'Dolly light',{color:C.orange,width:10,rig:{orientation:'world'}});
      return {...q,sliders:[...slides.slice(1,-1),mid]};}},
  {id:'orbital-gyroscope-3d',name:'Orbital gyroscope',control:1,
    description:'Three independent connector hoops orbit one center. Drag each Turn control; Ctrl-drag its Depth control to tilt the ring. The highlighted spokes make each rotation visible.',
    build(){const q=construction();
      [C.blue,C.orange,C.violet].forEach((color,i)=>{const b=q.basis({yaw:.4+i*1.4,tilt:[.38,.5,.4][i],axis:Math.PI/2+i*Math.PI/3,prefix:`Ring ${i+1} · `}),r=q.ring(b,142-i*20,0,32);
        q.loop(r,{color,width:3.5});q.edge(0,r[0],{color,width:3});q.edge(r[0],r[16],{color,width:1,opacity:.28});
        q.face([0,r[0],r[1],r[2],r[3],r[4]],color,.16);
        q.add(r[0],1,0,'Orbit marker',{color,width:11,rig:{orientation:'world'}});});
      q.add(0,1,0,'Central hub',{width:16,color:C.ink});return q;}},
  {id:'turbine-3d',name:'Turbine assembly',control:1,
    description:'Rotate eight connected blades inside a fixed cylindrical housing. Ctrl-drag Depth to change the projection. All blade faces and housing struts remain editable.',
    build(){const q=construction(),b=q.basis({yaw:.18,tilt:.55}),fixed={...b,frame:0},upper=q.ring(fixed,137,-33,32),lower=q.ring(fixed,137,33,32);
      q.loop(upper,{color:C.ink,width:3});q.loop(lower,{color:C.ink,width:2});
      for(let i=0;i<32;i+=4){q.edge(upper[i],lower[i],{color:C.pale,width:2});const j=(i+4)%32;q.face([upper[i],upper[j],lower[j],lower[i]],C.blue,.05);}
      for(let i=0;i<8;i++){const a=i*TAU/8,ids=[q.vertex(b,30,a),q.vertex(b,117,a+.12),q.vertex(b,109,a+.55),q.vertex(b,32,a+.39)];
        q.face(ids,i%2?C.cyan:C.blue,.65);q.loop(ids,{color:i%2?C.cyan:C.blue,width:2.2});}
      const hub=q.ring(fixed,29,0,24);q.loop(hub,{color:C.ink,width:2.5});q.face(hub,C.ink,.92);
      const mark=q.vertex(b,20,0);q.edge(0,mark,{color:C.orange,width:3});
      return q;}},
];
