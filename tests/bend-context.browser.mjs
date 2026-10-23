/** Run in the app browser: await (await import('/tests/bend-context.browser.mjs')).verifyBendContext(). */
export async function verifyBendContext() {
  const {emptyDocument, createObject, createFrame} = await import('../src/demo.mjs');
  const {editor, state, builder, studio} = window.styk;
  const overlay = document.querySelector('#overlay');
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const menus = () => [...document.querySelectorAll('[role="menu"]')].filter(node => node.getClientRects().length).length;
  // Synthetic platform event ordering cannot acquire native pointer capture.
  const capture = overlay.setPointerCapture;
  overlay.setPointerCapture = () => {};
  const checks = [];
  try {
    for (const tool of ['animate', 'rig', 'select', 'line', 'chain', 'circle', 'polygon']) {
      if (builder.active) builder.keepChangesAndLeave();
      const report = emptyDocument(), figure = report.figure_types[0];
      figure.segments = [{...figure.segments[0], segment_id: 1, parent_id: 0,
        length: 100, angle_rad: 0, bend_rad: 0, primitive_code: 0, aux_code: 0, is_static: false}];
      figure.segment_count = 1;
      report.keyframes = [createFrame([createObject(figure, 1, 300, 250)], 1)];
      editor.load(report); editor.select(1, 0);
      await studio.changeMode(tool === 'animate' ? 'animate' : 'rig');
      document.querySelector(`.tool-dock [data-tool="${tool === 'animate' ? 'select' : tool}"]`).click();
      window.styk.fit(); await settle();
      for (const earlyMenu of [true, false]) {
        const point = editor.geometry.objects.get(editor.selectedSlot).joints.get(1);
        const rect = document.querySelector('#viewport').getBoundingClientRect(), view = state.view;
        const x = rect.left + view.x + point.x * view.scale, y = rect.top + view.y + point.y * view.scale;
        const pointer = (type, dx = 0, dy = 0) => overlay.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          button: type === 'pointermove' ? -1 : 2, buttons: type === 'pointerup' ? 0 : 2, clientX: x + dx, clientY: y + dy}));
        const menu = () => overlay.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y}));
        const before = JSON.stringify(editor.serialize()), history = editor._undo.length;
        pointer('pointerdown');
        assert(state.drag?.kind === 'maybe-bend', `${tool}: right press starts pending bend`);
        if (earlyMenu) { menu(); assert(!menus(), `${tool}: no menu on press`); }
        pointer('pointermove', 0, 30); await settle();
        pointer('pointerup', 0, 30); menu(); await settle();
        assert(!menus(), `${tool}: no menu after bend`);
        assert(editor._undo.length === history + 1, `${tool}: one undo step`);
        assert(Math.abs(editor.object.bend_flag ? editor.object.bends[0] : editor.figure.segments[0].bend_rad) > .01, `${tool}: node bends`);
        assert(tool === 'animate' ? !editor.figure.segments[0].bend_rad : Math.abs(editor.figure.segments[0].bend_rad) > .01,
          `${tool}: correct pose/definition scope`);
        editor.undo(); await settle();
        assert(JSON.stringify(editor.serialize()) === before, `${tool}: undo restores document`);
        pointer('pointerdown'); if (earlyMenu) menu(); pointer('pointerup'); if (!earlyMenu) menu();
        await settle(); assert(menus(), `${tool}: stationary right click opens menu`);
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        await settle();
        checks.push(`${tool}: ${earlyMenu ? 'press' : 'release'} context menu ordering`);
      }
    }
    return checks;
  } finally { overlay.setPointerCapture = capture; }
}
