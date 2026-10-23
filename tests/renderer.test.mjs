import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileVectorObject, compileVectorObjectSteps, adoptPreparedVectors, shapeRecord, SHAPE_FLOATS, SHAPE, worldToScreen, screenToWorld, requiresCompatibilityTexture, objectBounds } from '../src/renderer-geometry.mjs';
import { compilePlaybackPacket } from '../src/playback-worker.mjs';
import { isolationStroke, isolationStrokeFits,nativeOutlineVectorItems } from '../src/renderer-vector-raster.mjs';
import { buildGeometry } from '../src/pivot/geometry.mjs';
import { defaultFigure, createObject, createFrame } from '../src/demo.mjs';

const figure = defaultFigure(), object = createObject(figure, 42, 200, 240), frame = createFrame([object]);
const report = { version: 5, canvas_width: 960, canvas_height: 540, figure_types: [figure], keyframes: [frame] };

test('native outline isolation preserves painter order and rejects features requiring Canvas',()=>{
  const f=structuredClone(figure);f.segment_decode={global_style:{u28:new Uint32Array(new Float32Array([2]).buffer)[0],rgb:[220,40,20],u30:0}};
  const pose=createFrame([createObject(f,1,20,30)]),scene=buildGeometry({...report,figure_types:[f]},pose),items=scene.drawables;
  const original=structuredClone(items),vectors=nativeOutlineVectorItems(items,32);
  assert.ok(vectors);assert.deepEqual(vectors.slice(items.length),items,'Original painter order follows the complete silhouette pass.');
  assert.deepEqual(items,original,'Preparing outline vectors cannot mutate editable geometry.');
  assert.equal(vectors.find(item=>item.type==='circle').seg.segment_kind,'circleFill','The opaque outline covers the white-backed ring before its original disc.');
  for(const change of [item=>item.alpha=.5,item=>item.opacity=.5,item=>item.points.push({x:0,y:0}),
    item=>item.seg={...item.seg,secondary:{rgb:[0,0,0],a:0}},item=>item._movieclipOwner={},item=>item.thickness=.001]){
    const changed=items.map(item=>({...item,points:[...item.points]}));change(changed[0]);
    assert.equal(nativeOutlineVectorItems(changed,32),null);
  }
  const hollow=items.map(item=>item.type==='circle'?{...item,seg:{...item.seg,segment_kind:'circleNoFill'}}:item);
  assert.equal(nativeOutlineVectorItems(hollow,32),null,'A hollow ring must retain its hole.');
  f.segment_decode.global_style.u30=128;assert.equal(nativeOutlineVectorItems(items,32),null);
});

test('editing adopts exact worker vector records without retaining packet buffers', async () => {
  const packet = await compilePlaybackPacket(report, 0), geometry = buildGeometry(report, frame);
  const vectors = new WeakMap(), compatibility = new WeakMap(), original = packet.shapes.slice();
  const adopted = adoptPreparedVectors(packet, geometry, vectors, compatibility), g = geometry.objects.get(0);
  assert.equal(adopted.objects, 1); assert.equal(adopted.bytes, packet.shapes.byteLength);
  assert.deepEqual(vectors.get(g), compileVectorObject(g.drawables, g.root));
  assert.equal(compatibility.get(g), false); assert.notEqual(vectors.get(g).buffer, packet.shapes.buffer);
  assert.deepEqual(packet.shapes, original, 'Adoption must preserve cached playback transform indices.');
  assert.equal(adoptPreparedVectors(packet, geometry, vectors, compatibility).objects, 0);
});

test('editing adoption rejects mismatched object descriptors and keeps complex objects on editor rasterization', async () => {
  const packet = await compilePlaybackPacket(report, 0);
  for (const change of [p => p.groups[0].uid++, p => p.transforms[4]++, p => p.groups[0].instanceCount++, p => p.shapes[21]++]) {
    const copy = structuredClone(packet); change(copy);
    const vectors = new WeakMap(), geometry = buildGeometry(report, frame);
    assert.equal(adoptPreparedVectors(copy, geometry, vectors, new WeakMap()).objects, 0);
    assert.equal(vectors.has(geometry.objects.get(0)), false);
  }
  const complexReport = structuredClone(report); complexReport.figure_types[0].segments[0].bend_rad = .2;
  complexReport.figure_types[0].segments[0].transparency = 128;
  const complex = await compilePlaybackPacket(complexReport, 0), geometry = buildGeometry(complexReport, complexReport.keyframes[0]);
  const vectors = new WeakMap(), compatibility = new WeakMap();
  adoptPreparedVectors(complex, geometry, vectors, compatibility);
  assert.equal(vectors.has(geometry.objects.get(0)), false); assert.equal(compatibility.get(geometry.objects.get(0)), true);
});
test('camera coordinate conversion round trips a rotated, translated, zoomed view', () => {
  const options = { report, frame: { camera: { x: 84, y: -73, scale: .7, angle_rad: .63 } }, view: { x: 124, y: 92, scale: 1.43 } };
  const point = { x: -63.2, y: 498.12 }, screen = worldToScreen(point, options), inverse = screenToWorld(screen, options);
  assert.ok(Math.abs(point.x - inverse.x) < 1e-9); assert.ok(Math.abs(point.y - inverse.y) < 1e-9);
});
test('background clipping occupies the existing record flag without changing packet size', () => {
  const figure = shapeRecord({ mode: SHAPE.RECT }), background = shapeRecord({ mode: SHAPE.RECT, clipToCanvas: true });
  assert.equal(figure.length, SHAPE_FLOATS); assert.equal(background.length, SHAPE_FLOATS);
  assert.deepEqual(figure.slice(0, -1), background.slice(0, -1));
  assert.equal(figure[23], 0); assert.equal(background[23], 1);
});
test('figure geometry compiles to finite, root-local GPU vector instances', () => {
  const geometry = buildGeometry(report, frame), g = geometry.objects.get(0), compiled = compileVectorObject(geometry.drawables, g.root, 7);
  assert.equal(compiled.length % SHAPE_FLOATS, 0);
  assert.ok(compiled.every(Number.isFinite));
  assert.equal(compiled[0], 0); assert.equal(compiled[1], 0);
  assert.equal(compiled[21], 7);
  assert.ok(compiled.length / SHAPE_FLOATS > figure.segments.length, 'hollow circles include a white interior and ring');
  assert.equal(requiresCompatibilityTexture(geometry.drawables), false);
});
test('incremental geometry exposes ordered groups and bounded invalidation metadata', () => {
  const a = structuredClone(frame), initial = buildGeometry(report, a);
  a.objects[0].angles[0] += .1;
  const updated = buildGeometry(report, a, {previous: initial, dirtySlots: [0]});
  assert.equal(updated.previousToken, initial.token); assert.notEqual(updated.token, initial.token);
  assert.deepEqual([...updated.changedSlots], [0]); assert.equal(updated.orderedObjects[0], updated.objects.get(0));
  assert.deepEqual(updated.drawables, buildGeometry(report, a).drawables);
  assert.equal(updated.previous, undefined, 'metadata must not retain an unbounded chain of previous scenes');
});
test('polygon triangulation preserves a concave filled area', () => {
  const s = { type: 'poly', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 4, y: 3 }, { x: 0, y: 8 }], rgb: [0, 0, 0], alpha: 1, opacity: 1, obj: {} };
  const compiled = compileVectorObject([s]); let area = 0;
  for (let offset = 0; offset < compiled.length; offset += SHAPE_FLOATS) {
    const [ax, ay, bx, by, cx, cy] = compiled.slice(offset, offset + 6);
    assert.equal(compiled[offset + 20], SHAPE.TRIANGLE);
    area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  assert.equal(area, 44);
});
test('isolated transparency and media use bounded compatibility textures', () => {
  const geometry = buildGeometry(report, frame), bounds = objectBounds(geometry.drawables);
  assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.width < report.canvas_width);
  assert.equal(requiresCompatibilityTexture(geometry.drawables.map(s => ({ ...s, opacity: .4 }))), true);
  assert.equal(requiresCompatibilityTexture([{ type: 'text' }]), true);
  // Self-crossing fills keep native even-odd fill on the vector path: the
  // bow-tie covers its two wedges (area 32) and leaves its sides empty.
  const bowTie = { type: 'poly', points: [{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }, { x: 8, y: 0 }], rgb: [0, 0, 0], alpha: 1, opacity: 1 };
  assert.equal(requiresCompatibilityTexture([bowTie]), false, 'self-crossing polygons draw as vectors');
  const records = compileVectorObject([bowTie]), triangles = [];
  for (let i = 0; i < records.length; i += SHAPE_FLOATS) { assert.equal(records[i + 20], SHAPE.TRIANGLE); triangles.push([...records.slice(i, i + 6)]); }
  const area = t => Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])) / 2;
  const covers = (x, y) => triangles.some(t => { const s = [[0, 1, 2, 3], [2, 3, 4, 5], [4, 5, 0, 1]].map(([a, b, c, d]) => (t[c] - t[a]) * (y - t[b]) - (t[d] - t[b]) * (x - t[a])); return s.every(v => v >= 0) || s.every(v => v <= 0); });
  assert.equal(triangles.reduce((sum, t) => sum + area(t), 0), 32);
  assert.deepEqual([covers(4, 1), covers(4, 7), covers(1, 4), covers(7, 4)], [true, true, false, false], 'even-odd wedges only');
  // Outlines beyond the vector budget keep the raster fallback.
  const zigzag = Array.from({ length: 260 }, (_, i) => ({ x: i % 2 ? 24 : 0, y: i / 10 }));
  assert.equal(requiresCompatibilityTexture([{ ...bowTie, points: zigzag }]), true);
});

test('synchronous vector compilation reuses scratch without leaking earlier records', () => {
  const geometry = buildGeometry(report, frame), g = geometry.objects.get(0);
  const fresh = items => { const steps = compileVectorObjectSteps(items, g.root, 3); for (;;) { const step = steps.next(); if (step.done) return step.value; } };
  // A large figure grows the shared buffer; a smaller one compiled next must
  // not inherit its tail fields, and neither result may alias the scratch.
  const large = Array.from({length: 40}, () => g.drawables).flat(), small = g.drawables.slice(0, 2);
  const a = compileVectorObject(large, g.root, 3), b = compileVectorObject(small, g.root, 3);
  assert.deepEqual(a, fresh(large)); assert.deepEqual(b, fresh(small));
  for (let i = 22; i < b.length; i += SHAPE_FLOATS) { assert.equal(b[i], 0); assert.equal(b[i + 1], 0); }
  const copy = a.slice(); compileVectorObject(g.drawables, g.root, 5); assert.deepEqual(a, copy);
  assert.notEqual(a.buffer, b.buffer);
});

test('isolation stroke classification matches the per-primitive rule at every resolution', () => {
  const line = thickness => ({type: 'line', thickness, seg: {segment_kind: 'line'}});
  const circle = (length, thickness, kind = 'circle') => ({type: 'circle', length, thickness, seg: {segment_kind: kind}});
  const sets = [[], [line(0)], [line(-1)], [line(1)], [line(3), line(0.25)], [circle(4, 1)], [circle(-4, 6, 'circleFill')], [circle(0.5, 9, 'circleFill'), line(2)],
    [line(NaN)], [line(undefined)], [circle(NaN, 1)], [{type: 'poly', points: []}, line(2)]];
  for (const items of sets) for (const resolution of [1 / 4096, 0.25, 0.5, 1, 1.9, 2, 3.5, 8, 64]) {
    // The rule supportsVectorIsolation() applied to every primitive.
    const expected = items.every(s => s.type === 'line' ? s.thickness <= 0 || s.thickness * resolution >= 2
      : s.type === 'circle' ? Math.min(Math.abs(s.length), s.seg.segment_kind === 'circleFill' ? Infinity : s.thickness) * resolution >= 2 : true);
    assert.equal(isolationStrokeFits(isolationStroke(items), resolution), expected, JSON.stringify(items) + ' at ' + resolution);
  }
});
