import {snapshotPoseObject} from './pose-snapshot.mjs';

export function cloneTopologySnapshot(value) {
  const {frames, ...fields} = value;
  return {...structuredClone(fields), frames:frames.map(({objects, ...entry}) => ({
    ...structuredClone(entry), objects:objects.map(object => snapshotPoseObject(object, {retainRuntime:true})),
  }))};
}

/** Topology commands retain independent native pose snapshots. Charge numeric
 * storage in constant time per vector instead of formatting millions of numbers
 * just to measure history. 64 bytes per element conservatively covers even the
 * longest JSON double plus its separator in the existing UTF-16 byte budget. */
export function topologyHistoryBytes(command) {
  let vectors = 0;
  const snapshot = value => ({...value, frames:value.frames.map(entry => ({...entry,
    objects:entry.objects.map(object => {
      const fields = {};
      for (const key of Object.keys(object)) {
        if ((key === 'angles' || key === 'lengths' || key === 'bends') && Array.isArray(object[key]))
          vectors += 64 * object[key].length + 32;
        else fields[key] = object[key];
      }
      return fields;
    }),
  }))});
  const metadata = {...command, before:snapshot(command.before), after:snapshot(command.after)};
  return JSON.stringify(metadata).length * 2 + vectors + (command.sourceBytes ?? 0);
}
