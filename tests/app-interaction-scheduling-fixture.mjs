import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {worldToScreen} from '../src/renderer.mjs';

/** Run in an isolated ready app session. Exercises its actual pointer handlers
 * and frame loop without a browser-specific input driver or diagnostic APIs.
 */
export async function verifyAppInteractionScheduling() {
  const {editor, state} = window.styk;
  const overlay = document.getElementById('overlay'), viewport = document.getElementById('viewport');
  const checks = [], check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!state.dirtyRender && !state.dirtyOverlay) return;
    }
    throw new Error('The interaction frame loop did not settle');
  };
  const point = value => {
    const rect = viewport.getBoundingClientRect();
    const screen = worldToScreen(value, {report: editor.report, frame: editor.evaluatedFrame, view: state.view, cameraEnabled: false});
    return {clientX: rect.left + screen.x * rect.width / viewport.clientWidth,
      clientY: rect.top + screen.y * rect.height / viewport.clientHeight};
  };
  const pointer = (type, value, extra = {}) => overlay.dispatchEvent(new PointerEvent(type,
    {...point(value), pointerId: 17, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra}));
  check(!state.playing && !state.previewing, 'The app fixture starts in an idle editor');
  document.querySelector('.studio-rail [data-tool="select"], [data-tool="select"]').click();
  if (state.onion) document.getElementById('onion-button').click();
  if (state.motionPaths) document.getElementById('paths-button').click();
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [{...base, segment_id: 1, parent_id: 0, angle_rad: 0, length: 100},
    {...base, segment_id: 2, parent_id: 1, angle_rad: .5, length: 40}];
  figure.segment_count = 2;
  report.keyframes = [createFrame([createObject(figure, 1, 200, 200)], 3)];
  editor.load(report, 'Interaction scheduling fixture'); editor.select(1, 0); window.styk.fit();
  await settle();
  const render = state.renderer.render, pose = editor.poseJoint;
  let scenePaints = 0, evaluations = 0;
  state.renderer.render = function(...args) { scenePaints++; return render.apply(this, args); };
  editor.poseJoint = function(...args) { evaluations++; return pose.apply(this, args); };
  try {
    state.drag = {kind: 'marquee', start: {x: 400, y: 300}, current: {x: 400, y: 300}, pastSlop: true};
    const before = overlay.toDataURL();
    pointer('pointermove', {x: 500, y: 390}); await settle();
    check(scenePaints === 0, 'Marquee feedback does not repaint scene artwork');
    check(before !== overlay.toDataURL(), 'Marquee feedback updates overlay pixels');
    pointer('pointercancel', {x: 500, y: 390}); await settle();

    const original = editor.serialize();
    const begin = ({moved = true} = {}) => {
      const start = editor.geometry.objects.get(0).segments[0].end;
      editor.beginDrag('Pose joint');
      state.drag = {kind: 'pose', joint: 0, start, moved, pastSlop: true};
    };
    begin(); evaluations = 0;
    for (let i = 1; i <= 40; i++) {
      const angle = i / 200;
      pointer('pointermove', {x: 200 + 100 * Math.cos(angle), y: 200 + 100 * Math.sin(angle)});
    }
    check(evaluations === 0, 'Native pose burst waits for one frame or release');
    const final = {x: 200 + 100 * Math.cos(.25), y: 200 + 100 * Math.sin(.25)};
    pointer('pointerup', final); await settle();
    check(evaluations === 2, 'Release applies the queued pose and exact newer release coordinate');
    const endpoint = editor.geometry.objects.get(0).segments[0].end;
    check(Math.hypot(endpoint.x - final.x, endpoint.y - final.y) < 1e-4, 'Committed pose reaches the release target');
    check(editor._undo.length === 1, 'A coalesced pose creates one history command');
    const committed = editor.serialize();
    editor.undo(); check(JSON.stringify(editor.serialize()) === JSON.stringify(original), 'Undo restores the original pose');
    editor.redo(); check(JSON.stringify(editor.serialize()) === JSON.stringify(committed), 'Redo restores the final pose');
    editor.undo(); await settle();
    begin(); evaluations = 0;
    pointer('pointermove', {x: 280, y: 250}); pointer('pointercancel', {x: 280, y: 250}); await settle();
    check(evaluations === 0, 'Cancel discards the queued pose before evaluation');
    check(JSON.stringify(editor.serialize()) === JSON.stringify(original), 'Cancel retains the original pose');
    begin({moved: false}); evaluations = 0;
    const angularPoint = degrees => ({x: 200 + 100 * Math.cos(degrees * Math.PI / 180),
      y: 200 + 100 * Math.sin(degrees * Math.PI / 180)});
    pointer('pointermove', angularPoint(-100));
    check(evaluations === 1, 'The first slop-crossing pose target applies immediately');
    for (let degrees = -90; degrees <= 89; degrees++) pointer('pointermove', angularPoint(degrees));
    pointer('pointerup', angularPoint(89)); await settle();
    check(Math.abs(editor.object.angles[0] - 89 * Math.PI / 180) < 1e-5,
      'Coalescing after a large direct first target preserves native angle winding');
    check(editor._undo.length === 1, 'A direct-first coalesced pose retains one history command');
    editor.undo(); check(JSON.stringify(editor.serialize()) === JSON.stringify(original), 'Undo restores the direct-first gesture baseline');
    return {checks, backend: state.renderer.stats?.backend};
  } finally {
    state.renderer.render = render; editor.poseJoint = pose;
    state.drag = null;
  }
}
