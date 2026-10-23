/** Display metadata for canonical camera motion IDs; saved values remain in camera-motion.mjs. */
export const motionTypeMessages=Object.freeze({
 follow:'cameraMotionUi.presetFollow',shake:'cameraMotionUi.presetShake',handheld:'cameraMotionUi.presetHandheld',
 wobble:'cameraMotionUi.presetWobble',impact:'cameraMotionUi.presetImpact',pulse:'cameraMotionUi.presetPulse',
});
export const motionParameterMessages=Object.freeze({
 strength:'cameraMotionUi.amount',moveX:'cameraMotionUi.moveX',moveY:'cameraMotionUi.moveY',roll:'cameraMotionGraph.roll',
 zoom:'cameraMotionUi.zoom',frequency:'cameraMotionUi.speed',roughness:'cameraMotionUi.roughness',direction:'cameraMotionUi.direction',
 recovery:'cameraMotionUi.recovery',phase:'cameraMotionUi.phase',fadeIn:'cameraMotionUi.easeIn',fadeOut:'cameraMotionUi.easeOut',
 seed:'vfxCatalog.parameter.particles.seed.label',followX:'cameraMotionUi.horizontal',followY:'cameraMotionUi.vertical',
 offsetX:'cameraMotionUi.offsetX',offsetY:'cameraMotionUi.offsetY',lag:'cameraMotionUi.smoothness',deadZone:'cameraMotionUi.deadZone',
 lookAhead:'cameraMotionUi.lookAhead',zoomFit:'cameraMotionUi.autoZoom',padding:'cameraMotionUi.margin',maxZoom:'cameraMotionUi.zoomLimit',
});
export const motionDescriptionMessages=Object.freeze({
 follow:'cameraMotionUi.keepsTheSelectedFiguresInFrame',shake:'cameraMotionUi.aSuddenJitteryRattle',
 handheld:'cameraMotionUi.aGentleLivingDrift',wobble:'cameraMotionUi.aSteadyRhythmicSway',
 impact:'cameraMotionUi.oneHardHitThatSettles',pulse:'cameraMotionUi.aQuickPunchInAndOut',
});
