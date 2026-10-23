import {animationRotation} from '../animation-origin.mjs';

// Derived data belongs to its published geometry. A successor shares unchanged
// records and numeric dependencies, never the previous geometry or its caches.
const poses = new WeakMap();
export const geometryPlans = geometry => poses.get(geometry);

// poseSlots is the editor's guarantee that the definition did not change.
export function geometryPosePlan(figure, object, previous, allowed) {
  return allowed && previous?.fig === figure && previous.obj === object ? poses.get(previous)?.plan : undefined;
}

export function geometryPose(figure, object, root, rig, previous, allowed, version, definition) {
  if (!rig?.plan.signature.some(s => s.spatial) || object.runtime_segments ||
      object.color_transition || object._sticknodesSprite) return null;
  const globals = [version, root.x, root.y, Number(object.scale ?? 1),
    object.color_override_raw, object.field28 ?? object.transparency ?? 0,
    object.image_text_flags, animationRotation(figure, object),
    object._stykSpatial?.camera?.strength??0,object._stykSpatial?.camera?.distance??600,object._stykSpatial?.camera?.centerX,object._stykSpatial?.camera?.centerY];
  const old = allowed && poses.get(previous);
  const prior = old && previous.fig === figure && previous.obj === object &&
    old.plan === rig.plan && globals.every((v, i) => Object.is(v, old.globals[i])) ? old : null;
  const inputs = new Float64Array(figure.segments.length * 5), changed = new Uint8Array(figure.segments.length);
  let polygons = prior?.polygons;
  return {
    reuse(index, angle, length, bend) {
      const at = index * 5,shape=object._stykSpatial?.shape?.[figure.segments[index].segment_id],width=shape?.width??1,taper=shape?.taper??0;
      inputs[at+3]=width;inputs[at+4]=taper;
      inputs[at] = angle; inputs[at + 1] = length; inputs[at + 2] = bend;
      if (prior && angle === prior.inputs[at] && length === prior.inputs[at + 1] &&
          bend === prior.inputs[at + 2] && width === prior.inputs[at+3] && taper === prior.inputs[at+4] && !rig.plan.dependencies[index].some(i => changed[i])) {
        rig.states[index] = prior.states[index];
        return true;
      }
      changed[index] = 1;
      return false;
    },
    reusePolygon(index) {
      if (!prior) return false;
      // Compile only when a live edit actually requests reuse. Ordinary worker
      // playback does not build an otherwise unused polygon dependency table.
      polygons ??= (figure.polyfills ?? []).map(p => [...new Set([
        ...p.segment_ids, ...(p._stykSurface?.basis ?? []), ...(p._stykSurface?.depth ?? []),
      ])].filter(id => id !== 0).map(id => rig.plan.ids.get(id)));
      return !polygons[index].some(i => changed[i]);
    },
    publish(geometry) {
      poses.set(geometry, {plan: rig.plan, definition, globals, inputs, states: rig.states, polygons});
    },
  };
}
