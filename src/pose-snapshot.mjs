const poseVectors = new Set(['angles','lengths','bends']);
function poseFields(source, vectors, retainRuntime = false) {
  const object = {};
  for (const key of Object.keys(source)) if ((retainRuntime || key !== 'runtime_segments') && key !== '_movieclipSample') {
    if (vectors && poseVectors.has(key) && Array.isArray(source[key])) {vectors[key] = source[key].slice();object[key] = null;}
    else object[key] = source[key];
  }
  return object;
}

/** Clipboard snapshots omit evaluation caches. Native history opts into runtime
 * segments because imported poses can store authoritative lengths/bends there.
 * Numeric placeholders keep the original property order during the fast copy. */
export function snapshotPoseObject(object, {retainRuntime = false} = {}) {
  const vectors = {}, fields = poseFields(object, vectors, retainRuntime);
  // Validated native poses own plain numeric arrays. Copy their storage directly
  // instead of sending every number through structuredClone's object walker.
  return Object.assign(structuredClone(fields), vectors);
}

/** Compare saved poses by identity, independent of evaluation slots and caches. */
export function poseObjectSignature(object, frame) {
  const fields = poseFields(object);
  delete fields.object_slot;
  if (object.join) {
    const {target_object_slot, target_unique_id, ...join} = object.join;
    fields.join = {...join, target_unique_id: frame.objects[target_object_slot]?.unique_id ?? target_unique_id};
  }
  return JSON.stringify(fields);
}

/** Capture the authoritative pose owned by a gesture. Attachment ancestors are
 * retained for exact world-coordinate reconstruction; unrelated figures do not
 * become history assets. Every retained record remains independently owned. */
export function snapshotPoseFrame(frame, uids) {
  let slots;
  if (uids) {
    const byUid=new Map(frame.objects.map((object,slot)=>[object.unique_id,slot])), wanted=new Set(),queue=[];
    for(const uid of uids){const slot=byUid.get(uid);if(slot!==undefined&&!wanted.has(slot)){wanted.add(slot);queue.push(slot);}}
    for(let i=0;i<queue.length;i++){
      const parent=frame.objects[queue[i]].join?.target_object_slot;
      if(parent!==undefined&&frame.objects[parent]&&!wanted.has(parent)){wanted.add(parent);queue.push(parent);}
    }
    slots=[...wanted].sort((a,b)=>a-b);
  } else slots=frame.objects.map((_,slot)=>slot);
  const remap=new Map(slots.map((slot,index)=>[slot,index]));
  const objects=slots.map((slot,index)=>{
    const object=poseFields(frame.objects[slot]);
    return {...object,object_slot:index,...(object.join?{join:{...object.join,target_object_slot:remap.get(object.join.target_object_slot)}}:{})};
  });
  const order=(frame.object_draw_order??slots).filter(slot=>remap.has(slot)).map(slot=>remap.get(slot));
  const {_cameraMotionTick,_vfxTimelineTick,_vfxTimelineScene,...saved}=frame;
  return structuredClone({...saved,objects,object_count:objects.length,object_draw_order:order,
    object_draw_order_unique_ids:order.map(slot=>objects[slot].unique_id)});
}
