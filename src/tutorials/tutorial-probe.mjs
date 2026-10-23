/**
 * What a tutorial's steps read about the editor (docs/TUTORIALS.md). Every
 * value is a plain number, string or boolean read on demand, so a step asks
 * only for what it compares and reading costs nothing between pulses. The
 * probe never changes anything.
 *
 * ctx: {editor, state, shell(), timeline(), overlays, mode(), fitted(),
 * touch()}: the app's own objects, through getters for what it creates later.
 */
export function createTutorialProbe(ctx) {
  const {editor, state} = ctx;
  const figure = () => (editor.selectionFrame ?? editor.frame)?.objects?.[0] ?? null;
  const keyCount = () => {
    const sheet = editor.report?._styk?.layerSheet;
    if (!sheet) return editor.report?.keyframes?.length ?? 0;
    let count = 0;
    for (const id of editor.report._styk.layers?.order ?? []) count += sheet.tracks?.[id]?.keys?.length ?? 0;
    return count;
  };
  const visible = id => Boolean(ctx.shell?.()?.registry?.isVisible(id));
  return () => ({
    /** The workspace (animate, draw or rig) and whether Home covers it. */
    get mode() { return ctx.mode(); },
    get home() { return Boolean(state.home); },
    get tool() { return state.tool; },
    /** The canvas view: its zoom (1 is 100%), its offset in the stage, and whether it is the fitted view. */
    get zoom() { return state.view.scale; },
    get viewX() { return state.view.x; },
    get viewY() { return state.view.y; },
    get fitted() { return Boolean(ctx.fitted()); },
    get zoomGesture() { return state.settings.canvasZoomGesture; },
    get touch() { return Boolean(ctx.touch?.()); },
    get grid() { return Boolean(state.settings.canvasGrid); },
    get handles() { return Boolean(state.handles); },
    /** The selected figure's id (null for none) and its selected joint. */
    get selected() { return editor.selectedUid ?? null; },
    get joint() { return editor.selectedJoint ?? -1; },
    /** The first figure: where it stands and how it is posed, as one comparable string. */
    get rootX() { return figure()?.root_x ?? 0; },
    get rootY() { return figure()?.root_y ?? 0; },
    get pose() { return (figure()?.angles ?? []).map(angle => angle.toFixed(3)).join(','); },
    get canUndo() { return Boolean(editor.canUndo); },
    get canRedo() { return Boolean(editor.canRedo); },
    /** Time: the playhead's frame, how many poses the layers hold, and whether the animation is playing. */
    get tick() { return Math.floor(editor.tick); },
    get keys() { return keyCount(); },
    get playing() { return Boolean(state.playing); },
    get onion() { return Boolean(state.onion); },
    get timelineMode() { return state.settings.timelineMode; },
    get timelineZoom() { return ctx.timeline?.()?.pxPerTick ?? 0; },
    /** Which panels show, and whether the command palette is open. */
    get panels() { return {properties: visible('properties'), vfx: visible('vfx'), library: visible('library'), timeline: visible('timeline')}; },
    get palette() { return Boolean(ctx.overlays?.top?.(['palette'])); },
  });
}
