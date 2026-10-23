/** Executable version of docs/ROTATING-CUBE.md. Every change is a public Builder
 * command: no preset, raw document writes, meshes or special control metadata. */
export function buildRotatingCube(editor,{faces=true}={}) {
  const select=id=>editor.select(editor.selectedUid,id===0?-1:editor.figure.segments.findIndex(s=>s.segment_id===id));
  const add=(parent,length,degrees,name)=>{
    const s=editor.addSegment({parentId:parent,length,angle:degrees*Math.PI/180,thickness:0});
    editor.updateSegment({name});return s.segment_id;
  };
  const turn=add(0,180,0,'Turn'),depth=add(0,100,90,'Depth');
  editor.enableSmartStretch(true);editor.setRigBehavior({stretch:{max:1}});
  const x=add(0,40,0,'Facing X'),y=add(0,40,90,'Facing Y');
  const frame=editor.addConnector(0,turn,{position:0,thickness:0}).segment_id;editor.updateSegment({name:'Rotation frame'});
  const top=[],bottom=[],radials=[];
  for(const [i,angle] of [45,135,225,315].entries()){
    const radius=add(frame,Math.SQRT2*80,angle,`Radius ${i+1}`);radials.push(radius);
    // Draw offsets before binding, while the projection is uncompressed.
    top.push(add(radius,80,-90,`T${i+1}`));editor.setRigBehavior({orientation:'world'});
    bottom.push(add(radius,80,90,`B${i+1}`));editor.setRigBehavior({orientation:'world'});
    select(radius);editor.bindStretchParts(depth);
  }
  const cycles=[top.slice(),bottom.slice().reverse(),...top.map((id,i)=>[bottom[i],bottom[(i+1)%4],top[(i+1)%4],id])];
  const colors=['#b4dafa','#426b98','#518dbf','#73b2df','#487ead','#80bce6'];
  select(depth);editor.updateSegment({length:40});select(turn);editor.updateSegment({angle_rad:30*Math.PI/180});
  if(faces)cycles.forEach((ids,i)=>{editor.addPolygon(ids,{color:colors[i]});editor.updatePolygon(i,{surface:{basis:[0,x,y],side:'front'}});});
  // Every physical edge is an ordinary connector with a usable sliding joint.
  const edges=[];for(let i=0;i<4;i++)for(const [a,b] of [[top[i],top[(i+1)%4]],[bottom[i],bottom[(i+1)%4]],[top[i],bottom[i]]]){
    edges.push(editor.addConnector(a,b,{thickness:0}).segment_id);
  }
  for(const s of editor.figure.segments)if(![turn,depth].includes(s.segment_id)){select(s.segment_id);editor.updateSegment({is_static:true});}
  select(turn);
  editor.updateFigureStyle({name:'Rotating cube'});
  return {turn,depth,frame,basis:[0,x,y],top,bottom,radials,cycles,colors,edges};
}
