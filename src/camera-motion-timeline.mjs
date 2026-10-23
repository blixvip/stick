import {t as interfaceText} from './localization.mjs';
import {localizedText} from './localization-bindings.mjs';
import {motionTypeMessages} from './camera-motion-localization.mjs';
import {motionLaneBox} from './timeline-rows.mjs';

/** Packs clips into lanes: in start order, each clip takes the first lane that is free at its start, so clips that
 * never play together share a lane and the lane count is the most motions at once, not the number of clips. */
export function packMotionLanes(clips){
  const lanes=[];
  for(const clip of [...clips].sort((a,b)=>a.start-b.start)){
    let lane=lanes.find(l=>l.end<=clip.start);if(!lane){lane={end:0,clips:[]};lanes.push(lane);}
    lane.clips.push(clip);lane.end=clip.start+clip.duration;
  }
  return lanes.map(lane=>lane.clips);
}
/**
 * The one Motion row under Camera (none without motions): every clip as `motions` (an effect lane's `clips` are VFX
 * clips), `lanes` (clip ID → its sub-lane) and `laneCount`, the most motions playing at once, which sets the row's
 * height (timeline-rows.mjs).
 */
export function motionRows(editor){
  const clips=editor.getCameraMotions();if(!clips.length)return [];
  const packed=packMotionLanes(clips),lanes=new Map(packed.flatMap((lane,index)=>lane.map(clip=>[clip.id,index])));
  return [{id:'motion',kind:'motion',name:interfaceText('inspectorView.motion'),nameKey:'inspectorView.motion',motions:clips,lanes,laneCount:packed.length,
    visible:clips.some(c=>c.enabled),locked:editor.getLayer('camera').locked}];
}
/** A motion type's colour (features/timeline.css --sheet-motion-*), read with the sheet's other colours. */
export const MOTION_COLORS=Object.freeze(Object.keys(motionTypeMessages).map(type=>`motion-${type}`));
const tint=(host,clip)=>host.colors[`motion-${clip.type}`]||host.colors.accent;
/** A clip's timing while it is dragged, otherwise its saved timing. */
function timing(host,clip){const g=host.gesture;return g?.kind==='camera-motion'&&g.id===clip.id?{start:g.start,duration:g.duration}:clip;}
/** The clip of the Motion row under a pointer, in the sub-lane under it: the selected clip's trim edge first, then the
 * clip over that frame, then any clip's edge just outside it. */
function motionAt(host,row,hit){
  const y=host.rowY(hit.row),size=host.rowSize(hit.row),lane=row.laneCount<2?0:Math.max(0,Math.min(row.laneCount-1,
    Math.floor((hit.y-motionLaneBox(y,size,0,row.laneCount).top)/(motionLaneBox(y,size,1,row.laneCount).top-motionLaneBox(y,size,0,row.laneCount).top))));
  const clips=row.motions.filter(c=>row.lanes.get(c.id)===lane),x=hit.x+host._offsetX(),edge=c=>Math.abs(x-c.start*host.pxPerTick)<7||Math.abs(x-(c.start+c.duration)*host.pxPerTick)<7;
  // The selected clip's trim edges also reach 3px into the gaps around its sub-lane.
  const selected=row.motions.find(c=>c.id===host.editor._selectedCameraMotion),box=selected&&motionLaneBox(y,size,row.lanes.get(selected.id),row.laneCount);
  if(box&&hit.y>=box.top-3&&hit.y<=box.top+box.height+3&&edge(selected))return selected;
  return clips.find(c=>hit.tick>=c.start&&hit.tick<c.start+c.duration)??clips.find(edge);
}
/**
 * The Motion row (`size` px tall, timeline-rows.mjs): each clip a pill in its sub-lane, tinted with its type's colour
 * (a muted clip faded), its name inside when it fits; the selected one outlined in the accent with its trim edges
 * marked. Overlapping motions stack in sub-lanes, so the row is only as tall as the most motions playing at once.
 */
export function paintMotionRow(host,ctx,layer,y,size=32){
  const c=host.colors,step=host.pxPerTick,sx=host._offsetX(),w=host.width,selectedId=host.editor._selectedCameraMotion;
  ctx.font=`500 11px ${host.font}`;ctx.textAlign='left';ctx.textBaseline='middle';
  // The selected clip last, over its neighbours.
  for(const clip of [...layer.motions.filter(m=>m.id!==selectedId),...layer.motions.filter(m=>m.id===selectedId)]){
    const {start,duration}=timing(host,clip),left=start*step-sx,width=duration*step;if(left>w+4||left+width<-4)continue;
    const {top,height}=motionLaneBox(y,size,layer.lanes.get(clip.id)??0,layer.laneCount),selected=selectedId===clip.id,color=tint(host,clip);
    const x=left+1,inner=Math.max(2,width-2),radius=Math.min(5,height/2,inner/2);
    ctx.globalAlpha=clip.enabled?1:.45;
    ctx.beginPath();ctx.roundRect(x,top,inner,height,radius);
    ctx.fillStyle=c.surface;ctx.fill();ctx.fillStyle=color;ctx.globalAlpha*=selected?.34:.2;ctx.fill();
    ctx.globalAlpha=clip.enabled?1:.45;ctx.lineWidth=1;ctx.strokeStyle=color;ctx.stroke();
    // A muted clip reads as switched off: a diagonal hatch over its fill.
    if(!clip.enabled){ctx.save();ctx.clip();ctx.strokeStyle=color;ctx.globalAlpha=.35;ctx.beginPath();for(let hx=x-height;hx<x+inner;hx+=6){ctx.moveTo(hx,top+height);ctx.lineTo(hx+height,top);}ctx.stroke();ctx.restore();}
    const name=interfaceText(motionTypeMessages[clip.type]);
    // The name stays in view while the pill's start is scrolled off the left edge.
    const text=ctx.measureText(name).width;
    if(height>=11&&text+14<=inner){ctx.fillStyle=c.ink;ctx.fillText(name,Math.min(Math.max(x,0)+7,x+inner-7-text),top+height/2+.5);}
    ctx.globalAlpha=1;
    if(selected){
      ctx.lineWidth=1.5;ctx.strokeStyle=c['accent-line']??c.accent;ctx.beginPath();ctx.roundRect(x-.5,top-.5,inner+1,height+1,radius+.5);ctx.stroke();
      const grip=Math.min(8,height-4);if(grip>=4&&inner>=12){ctx.fillStyle=c['accent-line']??c.accent;ctx.fillRect(x+2,top+(height-grip)/2,2,grip);ctx.fillRect(x+inner-4,top+(height-grip)/2,2,grip);}
    }
  }
}
/** The ribbon under Camera's keys while its Motion row is collapsed: where the camera moves, in each motion's colour. */
export function paintMotionRibbon(host,ctx,y,size){
  const step=host.pxPerTick,sx=host._offsetX(),w=host.width,top=y+size-5;
  for(const clip of host.editor.getCameraMotions()){
    const left=clip.start*step-sx,width=clip.duration*step;if(left>w||left+width<0)continue;
    ctx.globalAlpha=clip.enabled?.85:.3;ctx.fillStyle=tint(host,clip);ctx.beginPath();ctx.roundRect(left+1,top,Math.max(2,width-2),3,1.5);ctx.fill();
  }
  ctx.globalAlpha=1;
}
export const cameraMotionTimelineMethods={
  /** After a motion edit: the Motion row keeps its place while every clip stays in its sub-lane; a clip that changed
   * sub-lane (moved over another, added, removed) changes the row's height, so the rows are laid out again. */
  _refreshMotionRows(){
    const row=this.tracks.find(t=>t.kind==='motion'),[next]=this.cameraMotionsCollapsed?[]:motionRows(this.editor);
    if(Boolean(row)!==Boolean(next)||row&&(row.laneCount!==next.laneCount||row.motions.length!==next.motions.length||next.motions.some(clip=>row.lanes.get(clip.id)!==next.lanes.get(clip.id))))return this._reindex();
    if(row){const {motions,lanes,visible,locked}=next;Object.assign(row,{motions,lanes,visible,locked});Object.assign(this.trackById.get(row.id),{motions,lanes,visible,locked});}
    this.motionState=this.editor.report._styk.cameraMotion;this.labelSignature=null;
  },
  _setCameraMotionsCollapsed(collapsed){
    if(Boolean(this.cameraMotionsCollapsed)===collapsed)return;
    const index=this.tracks.findIndex(t=>t.kind==='motion'),size=index<0?0:this.layout?.size(index)??0,scroll=this._offsetY();
    this._cancelGesture();this.cameraMotionsCollapsed=collapsed;
    if(collapsed&&this.editor._selectedCameraMotion){this.editor._selectedCameraMotion=null;this.selectedTrackId='camera';this.selectedLayers=new Set(['camera']);}
    this.anchor=null;this.hover=null;this._reindex();
    // Pinned rows do not move the scrolled rows; a system block too tall to pin scrolls with them (timeline-rows.mjs).
    const grown=collapsed?-size:this.layout.size(this.tracks.findIndex(t=>t.kind==='motion'));
    if(!this.layout?.pinned&&scroll>0)this.scroll.scrollTop=Math.max(0,scroll+grown);
    this.update();
  },
  _copyMotion(cut=false){const editor=this.editor,id=editor._selectedCameraMotion,operation=()=>{if(!editor.copyCameraMotion(id))return false;if(cut)editor.deleteCameraMotion(id);return true;};return this._run(()=>this.sharedClipboard?this.sharedClipboard.copy('camera-motion',operation):operation());},
  _selectMotion(id){
    const clip=this.editor.getCameraMotions().find(c=>c.id===id);if(!clip)return;
    if(this.cameraMotionsCollapsed)this._setCameraMotionsCollapsed(false);
    this._selectLayer('camera');this.editor._selectedCameraMotion=id;
    this.editor._cameraInspectorTab='motion';this.onTrackSelect?.(this.trackById.get('camera'));this.update();
  },
  /** The row's name or an empty stretch of it: the clip over `tick` (the playhead from the name, where the first clip
   * stands in when none plays there); an empty stretch of the grid clears the motion selection. */
  _selectMotionRow(row,tick){
    const at=tick??Math.floor(this.editor.tick),clip=row.motions.find(c=>at>=c.start&&at<c.start+c.duration)??(tick===undefined?[...row.motions].sort((a,b)=>a.start-b.start)[0]:null);
    if(clip)return this._selectMotion(clip.id);
    this.editor._selectedCameraMotion=null;this._selectLayer('camera');
  },
  /** The row's eye mutes or enables every motion in one step (a clip's own menu mutes it alone). */
  _toggleMotionLane(row){
    const enabled=!row.visible,clips=row.motions.filter(c=>c.enabled!==enabled);
    if(clips.length===1)return this.editor.setCameraMotion(clips[0].id,{enabled});
    return this.editor.movieclipBatch(interfaceText(enabled?'layerTimeline.enableMotion':'layerTimeline.muteMotion'),()=>{for(const clip of clips)this.editor.setCameraMotion(clip.id,{enabled});});
  },
  /** The clip under the pointer: in the Motion row, or on Camera's ribbon while the row is collapsed. */
  _motionUnder(hit){
    const row=this.tracks[hit?.row];if(!row||hit.row<0)return null;
    if(row.kind==='motion')return motionAt(this,row,hit);
    if(row.kind!=='camera'||!this.cameraMotionsCollapsed)return null;
    const y=this.rowY(hit.row),size=this.rowSize(hit.row);if(hit.y<y+size-9)return null;
    return this.editor.getCameraMotions().filter(c=>hit.tick>=c.start&&hit.tick<c.start+c.duration).sort((a,b)=>a.duration-b.duration)[0]??null;
  },
  /** The name and frames of the motion under the pointer (or being dragged), in a tip above it. Short clips carry no
   * name inside, so this is how they are read. */
  _syncMotionTip(hit){
    const g=this.gesture?.kind==='camera-motion'?this.gesture:null,clip=g?this.editor.getCameraMotions().find(c=>c.id===g.id):this._motionUnder(hit);
    if(!clip||this.layerDrag?.active){if(this.motionTip&&!this.motionTip.hidden)this.motionTip.hidden=true;this._tipClip=null;return;}
    if(!this.motionTip){const tip=this.motionTip=document.createElement('div');tip.className='sheet-motion-tip';tip.setAttribute('aria-hidden','true');tip.hidden=true;this.main.append(tip);}
    const tip=this.motionTip,{start,duration}=timing(this,clip),index=this.tracks.findIndex(t=>t.kind==='motion');
    const key=`${clip.id}:${start}:${duration}`;
    if(this._tipClip!==key){this._tipClip=key;localizedText(tip,'layerTimeline.frameRange',{name:{messageKey:motionTypeMessages[clip.type]},first:start+1,last:start+duration});tip.style.setProperty('--motion',tint(this,clip));}
    const row=index>=0&&!this.cameraMotionsCollapsed?this.tracks[index]:null,y=row?motionLaneBox(this.rowY(index),this.rowSize(index),row.lanes.get(clip.id)??0,row.laneCount).top:this.rowY(0)+this.rowSize(0)-5;
    // Centred over the clip's visible part, kept inside the grid.
    if(tip.hidden)tip.hidden=false;
    const width=tip.offsetWidth,from=Math.max(0,start*this.pxPerTick-this._offsetX()),to=Math.min(this.width,(start+duration)*this.pxPerTick-this._offsetX());
    const left=clamp((from+to)/2-width/2,4,Math.max(4,this.width-width-4));
    tip.style.transform=`translate(${Math.round(this.scroll.offsetLeft+left)}px,calc(${Math.round(Math.max(y,this.layout.header))}px - 100% - 4px))`;
  },
  /** The pointer over a motion: resize at a clip's edge, grab over its body, a pointer over the collapsed ribbon. */
  _motionCursor(hit){
    const clip=this._motionUnder(hit);if(!clip)return null;
    const row=this.tracks[hit.row];if(row.kind!=='motion')return 'pointer';if(row.locked)return 'default';
    const x=hit.x+this._offsetX();return Math.abs(x-clip.start*this.pxPerTick)<7||Math.abs(x-(clip.start+clip.duration)*this.pxPerTick)<7?'ew-resize':'grab';
  },
  _motionDown(event,hit){
    const row=this.tracks[hit.row];
    // The collapsed ribbon: a press on a motion opens the row with that motion selected.
    if(row?.kind==='camera'){const clip=this._motionUnder(hit);if(!clip)return false;event.preventDefault();this._selectMotion(clip.id);return true;}
    if(row?.kind!=='motion')return false;
    const c=motionAt(this,row,hit);event.preventDefault();
    if(!c){this._selectMotionRow(row,hit.tick);return true;}
    this._selectMotion(c.id);
    if(!row.locked){const position=hit.x+this._offsetX(),edge=Math.abs(position-(c.start+c.duration)*this.pxPerTick)<7?'right':Math.abs(position-c.start*this.pxPerTick)<7?'left':'move';
      this.gesture={kind:'camera-motion',id:c.id,edge,original:c,x:event.clientX,start:c.start,duration:c.duration,copy:event.altKey};this._syncMotionTip();}
    return true;
  },
  _motionMove(event){const g=this.gesture;if(g?.kind!=='camera-motion')return false;const delta=Math.round((event.clientX-g.x)/this.pxPerTick),c=g.original,previousStart=g.start,previousDuration=g.duration;
    if(g.edge==='right')g.duration=Math.max(1,c.duration+delta);
    else if(g.edge==='left'){g.start=Math.max(0,Math.min(c.start+c.duration-1,c.start+delta));g.duration=c.start+c.duration-g.start;}
    else g.start=Math.max(0,c.start+delta);
    if(g.start!==previousStart||g.duration!==previousDuration)this.onCameraMotionPreview?.({...c,start:g.start,duration:g.duration});this._syncMotionTip();this.update();return true;
  },
  _motionUp(){const g=this.gesture;if(g?.kind!=='camera-motion')return false;this.gesture=null;this._syncMotionTip();
    if(g.start!==g.original.start||g.duration!==g.original.duration)this._run(()=>g.copy?this.editor.movieclipBatch('Duplicate camera motion',()=>{const id=this.editor.duplicateCameraMotion(g.id,g.start);this.editor.setCameraMotion(id,{duration:g.duration});this.editor._selectedCameraMotion=id;}):this.editor.setCameraMotion(g.id,{start:g.start,duration:g.duration}));
    this.onCameraMotionPreview?.(null);
    this.update();return true;
  },
  _motionKey(event){const id=this.editor._selectedCameraMotion,c=this.editor.getCameraMotions().find(c=>c.id===id);if(!c)return false;
    let action;if(event.key==='Delete'||event.key==='Backspace')action=()=>this.editor.deleteCameraMotion(id);
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d')action=()=>{this.editor._selectedCameraMotion=this.editor.duplicateCameraMotion(id);};
    else if(['ArrowLeft','ArrowRight'].includes(event.key))action=()=>this.editor.setCameraMotion(id,{start:Math.max(0,c.start+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?10:1))});
    else if(event.key==='Escape')action=()=>{this.editor._selectedCameraMotion=null;this._cancelGesture();};
    if(!action)return false;event.preventDefault();event.stopPropagation();this._run(action);return true;
  },
};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
