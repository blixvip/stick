/** Metadata that changes rendered pixels, excluding layer names/colors/locks. */
export function layerAppearance(state) {
  return JSON.stringify([state?.order,state?.order?.map(id=>[state.byId[id].visible,state.byId[id].parallax]),state?.fixed?.scene?.visible,state?.fixed?.camera?.visible]);
}
export function thumbnailVisualChange(detail, previousLayers, currentLayers) {
  if (!['document','edit','history','frame-draft'].includes(detail.kind)) return false;
  if (detail.kind==='document') return true;
  if (detail.audio && !detail.definition) return false;
  if ((detail.layerMetadata || detail.layers) && !detail.structural && !detail.animation && !detail.definition && previousLayers===currentLayers) return false;
  return true;
}
