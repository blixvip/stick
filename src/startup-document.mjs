import {emptyDocument, createFrame} from './demo.mjs';
import {createBlueStartupPose} from './startup-blue-data.mjs';
import {ensureLayerState} from './layers.mjs';
import {initializeLayerSheet} from './editor-layer-sheet.mjs';

/** Legacy Bubble fixture retained for existing tutorial/capture authoring. */
export function bubbleFigure(figure_type_id = 1) {
  const blue=[13,153,255], segments=[];
  const add=(parent,length,angle,thickness,extra={})=>{
    const id=segments.length+1;
    segments.push({segment_id:id,parent_id:parent,length,angle_rad:angle,
      thickness,bend_rad:0,primitive_code:0,aux_code:0,flags:0,
      segment_type:'line',segment_kind:'line',color_rgb:[...blue],
      transparency:0,visible:true,z_order:id,...extra});
    return id;
  };
  const circle={primitive_code:3,flags:3,segment_type:'circle',segment_kind:'circleFill'};
  const fixed={aux_code:1,flags:256,is_static:true};
  add(0,78,-Math.PI/2,38);
  add(1,64,-Math.PI/2,0,circle);
  add(1,51,.85,22); add(3,47,1.20,20);
  add(1,51,Math.PI-.85,22); add(5,47,Math.PI-1.20,20);
  add(0,61,1.24,25); add(7,59,Math.PI/2,23);
  add(0,61,Math.PI-1.24,25); add(9,59,Math.PI/2,23);
  const disc=(parent,x,y,r,color=blue)=>{
    const anchor=add(parent,Math.hypot(x,y+r),Math.atan2(y+r,x),0,{...fixed,visible:false});
    add(anchor,r*2,-Math.PI/2,0,{...circle,...fixed,flags:259,color_rgb:[...color]});
  };
  for(const joint of [4,6])disc(joint,0,0,14);
  for(const joint of [8,10])disc(joint,0,0,16);
  disc(2,-11,27,3.5,[16,44,75]);disc(2,11,27,3.5,[16,44,75]);
  const mouth=add(2,Math.hypot(5,40),Math.atan2(40,-5),0,{...fixed,visible:false});
  add(mouth,10,0,3,{...fixed,color_rgb:[16,44,75]});
  disc(1,0,25,8,[159,224,255]);
  return {figure_type_id,name:'Bubble',segment_count:segments.length,segments,
    polyfills:[],image_assets:[],text_assets:[]};
}

/** The canvas shapes Home's Start tiles offer (src/home/): the startup landscape, a vertical one and a square. */
export const STARTUP_CANVASES=Object.freeze({landscape:Object.freeze({width:960,height:540}),portrait:Object.freeze({width:540,height:960}),square:Object.freeze({width:720,height:720})});

/** Shared by application startup and File → New; demo fixtures stay independent. A `canvas` of another
 * size keeps Blue where it stands in the startup landscape: centred, a little above the middle. */
export function createStartupDocument({canvas}={}) {
  const report=emptyDocument(),{figure,object}=createBlueStartupPose();
  if(canvas&&(canvas.width!==report.canvas_width||canvas.height!==report.canvas_height)){
    if(![canvas.width,canvas.height].every(value=>Number.isInteger(value)&&value>=1&&value<=100000))throw new RangeError('Canvas dimensions must be 1-100000 pixels.');
    const x=Math.round(object.root_x/report.canvas_width*canvas.width),y=Math.round(object.root_y/report.canvas_height*canvas.height);
    // The hand and foot controllers keep their targets in scene coordinates: they move with the figure.
    for(const control of Object.values(object._stykIK??{}))if(control.target){control.target.x+=x-object.root_x;control.target.y+=y-object.root_y;}
    object.root_x=x;object.root_y=y;
    report.canvas_width=canvas.width;report.canvas_height=canvas.height;
  }
  report.figure_types=[figure];
  report.keyframes=[{...createFrame([object],10),_styk:{easing:{interpolation:'constant'}}}];
  ensureLayerState(report);
  initializeLayerSheet(report);
  // Native Pivot timing clamps the final key to one tick. The shared sheet
  // owns the ten-frame hold for Camera, Scene and the figure's layer.
  report._styk.layerSheet.duration=10;
  for(const track of Object.values(report._styk.layerSheet.tracks))track.end=10;
  return report;
}
