/** Working examples of the native rig evaluator. These builders only author
 * ordinary segments, fills and constraints; there is no example-only solver. */
import {construction} from './rig-examples-3d.mjs';
const TAU=Math.PI*2,rad=n=>n*Math.PI/180;
const C={ink:[38,57,75],blue:[29,143,204],cyan:[62,190,191],orange:[236,155,61],pale:[220,235,240],paper:[245,248,250],wood:[166,110,62]};
const stretch=(restLength=100,source)=>({restLength,min:0,max:4,width:'keep',branch:true,...(source?{source,restPosition:.5}:{})});
const lock=(reference,multiplier,angle=0,restAngle=0)=>({mode:'parent',reference,multiplier,angle,restAngle,figureRestAngle:0});
const fixed=angle=>({angleLock:{mode:'figure',angle,restAngle:0,multiplier:1},response:{mode:'stop'}});
const control=(key,label,handle,channel,min,max,unit,{scale=1,offset=0,demo=[min,max,min],hint=''}={})=>({key,label,handle,channel,min,max,unit,scale,offset,demo,hint});
function frameAt(q,anchor,driver,name){
  const id=q.edge(anchor,driver,{width:0,position:0,name});q.segments[id-1].parent_id=driver;return id;
}
function disc(q,parent,r,color,name='Hub'){
  const ids=Array.from({length:24},(_,i)=>q.add(parent,r,i*TAU/24,name));q.face(ids,color,1);return ids;
}
function dot(q,parent,color=C.orange,size=8){return q.add(parent,0,0,'Rivet',{width:size,color,rig:{response:{mode:'stop'}}});}
function polygon(q,ids,color,{width=2,opacity=1,outline=C.ink}={}){q.face(ids,color,opacity);q.loop(ids,{color:outline,width});}

export const MECHANISM_RIG_EXAMPLES=[
  {id:'counter-rotating-gears',name:'Counter-rotating gears',control:4,
    description:'Turn Drive. The orange wheel counter-rotates through a -1 parent angle lock; the blue and orange pins make the relationship visible.',
    build(){
      const q=construction(),origin=q.add(0,0,0,'Mount'),left=q.add(origin,80,Math.PI,'Left axle'),right=q.add(origin,80,0,'Right axle');
      const drive=q.add(left,58,0,'Drive',{control:true});
      const a=frameAt(q,left,drive,'Drive frame'),mount=frameAt(q,right,drive,'Counter-wheel mount');
      const reverse=q.add(mount,58,rad(15),'Counter rotation · -1',{rig:{angleLock:lock(drive,-1,rad(15))}});
      const b=frameAt(q,right,reverse,'Counter-wheel frame');
      for(const [f,color] of [[a,C.blue],[b,C.orange]]){
        const teeth=Array.from({length:48},(_,i)=>q.add(f,[73,86,86,73][i%4],(i+.5)*TAU/48,'Gear tooth'));
        polygon(q,teeth,color,{width:2.5});disc(q,f,58,C.paper);disc(q,f,17,C.ink);disc(q,f,7,C.pale);
        for(let i=0;i<3;i++){const start=q.add(f,22,i*TAU/3,'Spoke root'),end=q.add(f,51,i*TAU/3,'Spoke tip');q.edge(start,end,{color,width:12});}
        const pin=q.add(f,44,0,'Rotation marker');dot(q,pin,C.ink,12);dot(q,pin,C.paper,5);
      }
      // A stationary mounting rail distinguishes wheel rotation from figure rotation.
      const railA=q.add(origin,135,Math.PI,'Mount left'),railB=q.add(origin,135,0,'Mount right');
      q.edge(railA,railB,{color:C.ink,width:7});q.segments.at(-1).z_order=-3;
      dot(q,left,C.ink,12);dot(q,right,C.ink,12);
      return {...q,controls:[control('drive','Drive',drive,'angle',0,360,'°',{scale:Math.PI/180,demo:[0,360],hint:'The orange wheel follows with a −1 rotation multiplier.'})],proof:{drive,reverse,left,right}};
    }},
  {id:'folding-fan',name:'Folding fan',control:2,
    description:'Open the fan with one control. Nine ribs use fractional parent rotation multipliers; the filled leaves remain connected between them.',
    build(){
      const q=construction(),pivot=q.add(0,95,Math.PI/2,'Fan hinge'),start=rad(-170),drive=q.add(pivot,174,rad(-42),'Open',{control:true}),frame=frameAt(q,pivot,drive,'Shared hinge'),tips=[];
      for(let i=0;i<9;i++){
        const tip=q.add(frame,174,start,`Rib ${i+1} · ${i}/8 rotation`,{rig:{angleLock:lock(drive,i/8,start,start)}});tips.push(tip);
        if(i)polygon(q,[pivot,tips[i-1],tip],i%2?C.blue:C.cyan,{width:1.5,outline:[40,109,143]});
        const inner=q.edge(pivot,tip,{width:0,position:.26,name:'Handle end'});q.edge(pivot,inner,{color:C.wood,width:5});
        const trim=q.edge(pivot,tip,{width:0,position:.9,name:'Trim anchor'});
        if(i){const previous=q.segments.find(s=>s.name===`Trim ${i-1}`);q.edge(previous.segment_id,trim,{color:C.pale,width:2});}
        q.segments[trim-1].name=`Trim ${i}`;
      }
      disc(q,pivot,11,C.wood);disc(q,pivot,4,C.pale);
      return {...q,controls:[control('open','Open',drive,'angle',0,100,'%',{scale:rad(1.6),offset:start,demo:[0,100,0],hint:'All nine ribs follow one angle with different rotation multipliers.'})],proof:{drive,pivot,tips}};
    }},
  {id:'accordion-screen-3d',name:'Accordion screen',control:3,
    description:'Fold four connected panels. Alternating angle locks turn adjacent panels in opposite directions; Smart Stretch projects depth while the vertical rails stay rigid.',
    build(){
      const q=construction(),base=q.add(0,140,Math.PI,'Left foot'),depth=q.add(0,45,Math.PI/2,'Depth',{control:true,rig:{stretch:stretch()}}),drive=q.add(0,130,rad(38),'Fold',{control:true});
      const bottoms=[base],tops=[q.add(base,165,-Math.PI/2,'Top hinge', {rig:fixed(-Math.PI/2)})],directions=[];
      for(let i=0;i<4;i++){
        const mount=frameAt(q,bottoms[i],drive,`Panel ${i+1} hinge`);
        const axis=q.add(mount,0,0,`Panel ${i+1} · ${i%2?'reverse':'forward'} fold`,{rig:{angleLock:lock(drive,i%2?-1:1)}});directions.push(axis);
        const next=q.add(axis,91,0,'Projected panel width',{rig:{follow:{driver:depth,mode:'stretch',influence:1},response:{multiplier:1}}});bottoms.push(next);
        const top=q.add(next,165,-Math.PI/2,'Rigid upright',{rig:fixed(-Math.PI/2)});tops.push(top);
        polygon(q,[bottoms[i],next,top,tops[i]],i%2?C.pale:C.cyan,{width:3});
        const l=q.edge(bottoms[i],tops[i],{width:0,position:.16}),r=q.edge(next,top,{width:0,position:.16});q.edge(l,r,{color:C.ink,width:2});
        const l2=q.edge(bottoms[i],tops[i],{width:0,position:.84}),r2=q.edge(next,top,{width:0,position:.84});q.edge(l2,r2,{color:C.ink,width:2});
        dot(q,top,C.orange,7);
      }
      for(const point of [bottoms[0],bottoms.at(-1)]){const a=q.add(point,10,Math.PI,'Foot left',{rig:fixed(Math.PI)}),b=q.add(point,10,0,'Foot right',{rig:fixed(0)});q.edge(a,b,{color:C.ink,width:6});}
      return {...q,controls:[control('fold','Fold',drive,'angle',0,80,'°',{scale:Math.PI/180,demo:[10,78,10],hint:'Neighboring panels use opposite rotation multipliers.'}),control('depth','Depth',depth,'length',5,100,'%',{demo:[30,65,30],hint:'Smart Stretch compresses the depth axis without shortening the uprights.'})],proof:{drive,depth,bottoms,tops,directions}};
    }},
  {id:'expanding-crate-3d',name:'Expanding crate',control:2,
    description:'Expand the width. Signed stretch retracts the depth in the opposite direction, with an impulse reset along each receding edge. Corner hardware remains rigid.',
    build(){
      const q=construction(),origin=q.add(0,0,0,'Crate origin'),drive=q.add(origin,90,0,'Expand',{control:true,rig:{stretch:stretch(),angleLock:{mode:'figure',angle:0,restAngle:0,multiplier:1}}});
      const frame=frameAt(q,origin,drive,'Expansion frame'),front=[[-105,-68],[105,-68],[105,68],[-105,68]].map(([x,y])=>q.add(frame,Math.hypot(x,y),Math.atan2(y,x),'Front corner',{rig:{response:{multiplier:1}}}));
      const back=front.map(p=>q.add(p,74,rad(-38),'Depth · reset / -1',{rig:{response:{multiplier:-1,reset:true}}}));
      polygon(q,[front[0],front[1],back[1],back[0]],C.cyan,{opacity:.88});
      polygon(q,[front[1],front[2],back[2],back[1]],C.blue,{opacity:.86});
      polygon(q,front,[220,163,83],{width:3});
      for(const t of [.27,.73]){const top=q.edge(front[0],front[1],{width:0,position:t}),bottom=q.edge(front[3],front[2],{width:0,position:t});q.edge(top,bottom,{color:C.wood,width:10});}
      for(const p of front){dot(q,p,C.ink,11);dot(q,p,C.pale,4);}
      const center=q.edge(front[0],front[2],{width:0,position:.5}),plate=q.add(center,0,0,'Rigid latch',{width:22,color:C.ink,rig:{response:{mode:'stop'}}});dot(q,plate,C.orange,6);
      return {...q,controls:[control('expand','Expand',drive,'length',35,165,'%',{demo:[55,145,55],hint:'Width uses +1 stretch; receding edges reset their impulse and use −1.'})],proof:{drive,front,back}};
    }},
  {id:'perspective-conveyor-3d',name:'Perspective conveyor',control:3,
    description:'Move Travel to send the orange frame toward the vanishing point. Its connector slide drives negative stretch; per-corner impulse resets shrink both dimensions.',
    build(){
      const q=construction(),origin=q.add(0,0,0,'Entry'),vanishing=q.add(origin,245,rad(-22),'Direction',{control:true});
      const travel=q.edge(origin,vanishing,{width:0,position:.42,control:true,name:'Travel'});q.segments[travel-1]._stykRig.stretch=stretch(245,'slide');
      const corners=[[-90,-100],[90,-100],[90,100],[-90,100]],entrance=corners.map(([x,y])=>q.add(origin,Math.hypot(x,y),Math.atan2(y,x),'Entry corner'));
      q.loop(entrance,{color:C.ink,width:3});entrance.forEach(p=>q.edge(p,vanishing,{color:C.blue,width:1.5,opacity:.48}));
      const makeFrame=(slider,color,width,fill=false)=>{
        const points=corners.map(([x,y])=>{const angle=Math.atan2(y,x);return q.add(slider,Math.hypot(x,y)/2,angle,'Projected cargo corner',{rig:{orientation:'world',response:{multiplier:-1,reset:true},angleLock:{mode:'figure',angle,restAngle:0,multiplier:1}}});});
        if(fill)q.face(points,color,.12);q.loop(points,{color,width});return points;
      };
      for(const position of [.22,.7,.86]){const s=q.edge(origin,vanishing,{width:0,position,name:'Depth station'});q.segments[s-1]._stykRig.stretch=stretch(245,'slide');makeFrame(s,C.blue,1.5);}
      const cargo=makeFrame(travel,C.orange,6,true);dot(q,travel,C.orange,10);
      const stripA=q.edge(entrance[3],vanishing,{width:0,position:.18}),stripB=q.edge(entrance[2],vanishing,{width:0,position:.18});q.face([entrance[3],entrance[2],stripB,stripA],C.blue,.08);
      return {...q,controls:[control('travel','Travel',travel,'slide',0,95,'%',{scale:.01,demo:[5,93,5],hint:'Slide position drives negative stretch, with an axis reset at every corner.'}),control('direction','Direction',vanishing,'angle',-55,20,'°',{scale:Math.PI/180,demo:[-22,-10,-22]})],proof:{travel,vanishing,cargo,corners}};
    }},
];
