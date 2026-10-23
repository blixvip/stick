/** Transient builder appearance values: no document or media clipboard copies. */
import {resolveInstanceFigure} from './animation-style.mjs';
import {displayedColor, displayedSegmentPaint} from './figure-colors.mjs';

export function copyBuilderAppearance(editor) {
  const figure = resolveInstanceFigure(editor.figure, editor.object);
  const segment = figure?.segments[editor.selectedJoint];
  if (!segment) return null;
  return structuredClone({paint:displayedSegmentPaint(editor.report, figure, editor.object, segment), thickness:segment.thickness ?? 0});
}
export function pasteBuilderAppearance(editor, appearance, {branch = false} = {}) {
  if (!appearance || !editor.figure?.segments[editor.selectedJoint]) return false;
  return editor.updateBuilderSegmentStyle(structuredClone(appearance), {branch});
}
/** Snapshot once when drawing starts; widths are in world coordinates. */
export function builderStrokeAppearance(editor, parentId = editor.figure?.segments[editor.selectedJoint]?.segment_id ?? 0) {
  const figure = resolveInstanceFigure(editor.figure, editor.object);
  const source = figure?.segments.find(segment => segment.segment_id === parentId);
  const rgb = source?.color_rgb ?? editor.figure?.segments[0]?.color_rgb ?? (figure ? [48,48,56] : [106,77,234]);
  const color = figure ? displayedColor(editor.report, figure, editor.object, rgb) : rgb;
  return {color:`rgb(${color.join(',')})`, width:(source?.thickness ?? 8) * Math.abs(editor.object?.scale ?? 1)};
}
export function setBuilderStroke(ctx, appearance, scale = 1) {
  ctx.strokeStyle = appearance.width > 0 ? appearance.color : '#0d99ff';
  ctx.lineWidth = appearance.width > 0 ? appearance.width * scale : 1;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash(appearance.width > 0 ? [] : [4,4]);
}
