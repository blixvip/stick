/** Interpret structured import metadata without parsing or rewriting diagnostic strings. */
const staticKeys = Object.freeze({
  "SOURCE_TIMING": "importNotes.sourceTiming",
  "CONSTRAINTS": "importNotes.constraints",
  "LEGACY_BACKGROUND_FIT": "importNotes.legacyBackgroundFit",
  "TEXT_GLYPHS": "importNotes.textGlyphs",
  "TEXT_FONT": "importNotes.textFont",
  "SPRITE_DISTORTION": "importNotes.spriteDistortion",
  "EFFECTS": "importNotes.effects",
  "JOIN_OFFSETS": "importNotes.joinOffsets",
  "CAMERA_DYNAMICS": "importNotes.cameraDynamics",
  "REPEATS": "importNotes.repeats"
});
export function importWarningMessage(warning, report) {
  if (warning?.messageKey) return warning;
  const key = staticKeys[warning?.code];
  if (key) return {messageKey:key};
  const source = report?._styk?.sticknodes;
  if (warning?.code === 'EXTERNAL_AUDIO' && source?.sounds) return {messageKey:'importNotes.externalAudio',messageParams:{count:source.sounds.length}};
  if (warning?.code === 'UNVERIFIED_LAYOUT' && source?.layoutGuesses) {
    const profiles = source.layoutGuesses.map(item=>item.format+':'+item.profile);
    return {messageKey:'importNotes.unverifiedLayouts',messageParams:{profiles:profiles.slice(0,8).join(', '),more:profiles.length>8?{messageKey:'importNotes.additionalLayouts',messageParams:{count:profiles.length-8}}:''}};
  }
  if (warning?.code === 'piv_duplicate_object_ids' && report?.piv_identity_recovery?.objects) {
    const repairs = report.piv_identity_recovery.objects, frames = [...new Set(repairs.map(item=>item.keyframe_index+1))].sort((a,b)=>a-b);
    return {messageKey:'importNotes.recoveredIdentities',messageParams:{count:repairs.length,frames:{messageKey:'importNotes.frameList',messageParams:{list:frames.slice(0,8).join(', '),more:frames.length>8?{messageKey:'importNotes.additionalFrames'}:''}}}};
  }
  if (warning?.code === 'piv_missing_image_data' && report?.piv_missing_images) return {messageKey:'importNotes.missingImages',messageParams:{count:report.piv_missing_images.length,names:[...new Set(report.piv_missing_images.map(item=>item.figure_name))].join(', ')}};
  return warning;
}
