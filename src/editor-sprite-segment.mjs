import {messageError} from './localized-error.mjs';
/** Attach a placed embedded sprite to an existing reusable Pivot rig. */
import {portableAsset} from './clipboard-assets.mjs';
import {normalizeBuilderOrder} from './editor-builder-style.mjs';
import {drawingMetadata} from './drawing-model.mjs';

const MAX_SEGMENTS = 30000, MAX_ASSETS = 65535;
const assetId = (asset, index) => asset.asset_index ?? asset.table_index ?? asset.image_index ?? asset.sprite_index ?? index;
const mediaId = segment => segment.extra_u16 ?? segment.extra?.[0] ?? segment.image_asset_index ?? segment.sprite_index ?? 0;
const imageSegment = segment => segment.primitive_code === 2 || segment.segment_type === 'image';
const coordinate = value => {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw messageError(new Error(''), "errors.editorSpriteSegment.spriteAnchorCoordinatesMustBeSigned32Bit", {});
  return value;
};
const point = value => ({x: coordinate(value?.x), y: coordinate(value?.y)});
function setAssetIndex(asset, index) {
  Object.assign(asset, {kind: 'image', asset_index: index, table_index: index});
  for (const alias of ['image_index', 'sprite_index']) if (alias in asset) asset[alias] = index;
}
function setMediaIndex(segment, index) {
  segment.extra_u16 = index;
  segment.extra_u8_a ??= segment.extra?.[1] ?? 0;
  segment.extra_u8_b ??= segment.extra?.[2] ?? 0;
  segment.extra = [index, segment.extra_u8_a, segment.extra_u8_b];
  for (const alias of ['image_asset_index', 'sprite_index']) if (alias in segment) segment[alias] = index;
}
/** Native side tables are contiguous; references are IDs, not array offsets. */
function normalizeImageTable(figure) {
  const assets = figure.image_assets ??= [], remap = new Map();
  for (let index = 0; index < assets.length; index++) {
    const id = assetId(assets[index], index);
    if (!Number.isInteger(id) || id < 0 || id >= MAX_ASSETS || remap.has(id))
      throw messageError(new Error(''), "errors.editorSpriteSegment.theFigureContainsInvalidOrRepeatedSpriteAsset", {});
    remap.set(id, index);
  }
  for (const segment of figure.segments) if (imageSegment(segment)) {
    const next = remap.get(mediaId(segment));
    if (next === undefined) throw messageError(new Error(''), "errors.editorSpriteSegment.anExistingSpriteSegmentIsMissingItsImage", {});
    setMediaIndex(segment, next);
  }
  assets.forEach(setAssetIndex);
  // Canonical tables own the edit; an imported alias must not hide new media.
  delete figure.side_tables;
}
function retainRuntimePose(object, segments) {
  if (!object.runtime_segments) return;
  for (const [flag, vector, field, fallback] of [['len_flag', 'lengths', 'length', 0], ['bend_flag', 'bends', 'bend_rad', 0]]) {
    if (object[flag] || !segments.some((segment, index) => object.runtime_segments[index]?.[field] !== undefined &&
        object.runtime_segments[index][field] !== (segment[field] ?? fallback))) continue;
    object[flag] = 1;
    object[vector] = segments.map((segment, index) => object.runtime_segments[index]?.[field] ?? segment[field] ?? fallback);
  }
}

export const editorSpriteSegmentMethods = {
  /** Source is the one-image definition returned by imageFileToFigure(), with
   * anchor_start / anchor_end placed in pixel coordinates before this call. */
  addSpriteSegment(spriteFigure, {parentId, angle} = {}) {
    const figure = this.figure;
    if (!figure || !this.object) throw messageError(new Error(''), "errors.editorSpriteSegment.selectAFigureBeforeAttachingASprite", {});
    if (spriteFigure?.segments?.length !== 1 || !imageSegment(spriteFigure.segments[0]) || spriteFigure.image_assets?.length !== 1)
      throw messageError(new Error(''), "errors.editorSpriteSegment.chooseOneImportedImageToAttachAsA", {});
    if (drawingMetadata(spriteFigure)?.version === 2)
      throw messageError(new Error(''), "errors.editorSpriteSegment.drawingCelsCannotBeAttachedAsSpriteImages", {});
    const sourceSegment = spriteFigure.segments[0], sourceAsset = spriteFigure.image_assets[0];
    if (mediaId(sourceSegment) !== assetId(sourceAsset, 0)) throw messageError(new Error(''), "errors.editorSpriteSegment.theSpriteSegmentDoesNotReferenceItsImage", {});
    const asset = portableAsset(sourceAsset, {image: true});
    if (typeof asset.data_url !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.data_url))
      throw messageError(new Error(''), "errors.editorSpriteSegment.spriteAttachmentRequiresAnEmbeddedPngImage", {});
    asset.anchor_start = point(asset.anchor_start);
    asset.anchor_end = point(asset.anchor_end);
    const dx = asset.anchor_end.x - asset.anchor_start.x, dy = asset.anchor_end.y - asset.anchor_start.y;
    asset.anchor_length = Math.hypot(dx, dy); asset.anchor_angle_rad = Math.atan2(dy, dx);
    if (!asset.anchor_length) throw messageError(new Error(''), "errors.editorSpriteSegment.spriteOriginAndEndpointMustBeDifferentPoints", {});
    // Retain legacy aliases consistently without introducing them on new media.
    if ('pivot' in asset) asset.pivot = {...asset.anchor_start};
    if ('endpoint' in asset) asset.endpoint = {...asset.anchor_end};
    angle ??= asset.anchor_angle_rad;
    if (typeof angle !== 'number' || !Number.isFinite(angle)) throw messageError(new Error(''), "errors.editorSpriteSegment.spriteAngleMustBeFinite", {});
    const parent = parentId ?? figure.segments[this.selectedJoint]?.segment_id ?? 0;
    if (!Number.isInteger(parent) || parent !== 0 && !figure.segments.some(segment => segment.segment_id === parent))
      throw messageError(new Error(''), "errors.editorSpriteSegment.chooseAnExistingParentHandleForTheSprite", {});
    const handleId = Math.max(0, ...figure.segments.map(segment => segment.segment_id)) + 1;
    if (figure.segments.length >= MAX_SEGMENTS || handleId > 65535)
      throw messageError(new Error(''), "errors.editorBuilder.aFigureSupportsAtMost30000Segments", {});
    if ((figure.image_assets?.length ?? 0) >= MAX_ASSETS) throw messageError(new Error(''), "errors.editorSpriteSegment.aFigureSupportsAtMost65535Image", {});
    const segmentIndex = figure.segments.length, assetIndex = figure.image_assets?.length ?? 0;
    this._topologyEdit('Add sprite segment', next => {
      normalizeImageTable(next); setAssetIndex(asset, assetIndex); next.image_assets.push(asset);
      const zOrder = normalizeBuilderOrder(next) + 1;
      const segment = {segment_id: handleId, parent_id: parent, length: asset.anchor_length, angle_rad: angle,
        thickness: 0, bend_rad: 0, primitive_code: 2, aux_code: 0, flags: 2, is_static: false,
        segment_type: 'image', segment_kind: 'image', color_rgb: [0, 0, 0], transparency: 0,
        color_alpha: 1, visible: true, extra_u8_a: 0, extra_u8_b: 0, z_order: zOrder, z_order_runtime_raw: zOrder - 1};
      setMediaIndex(segment, assetIndex);
      for (const frame of this._allSourceFrames()) for (const object of frame.objects) if (object.figure_type_id === next.figure_type_id) {
        retainRuntimePose(object, next.segments);
        object.angles.push(angle);
        if (object.len_flag) object.lengths.push(asset.anchor_length);
        if (object.bend_flag) object.bends.push(0);
        delete object.runtime_segments;
      }
      next.segments.push(segment); this.selectedJoint = segmentIndex;
    });
    return {handleId, segmentIndex, assetIndex};
  },
};
