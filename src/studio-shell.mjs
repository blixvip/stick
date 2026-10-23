import {localizedText, messageTuple} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
import {setAttr, setHidden, setProp, setText} from './ui/dom-write.mjs';
import {syncRail} from './shell/rail.mjs';
const nameKeys = {select: 'studioShell.select', pose: 'studioShell.poseJoints', tweener: 'studioShell.tweener', rig: 'studioShell.editSharedRig', line: 'studioShell.drawALine', chain: 'studioShell.chainPen', circle: 'studioShell.drawACircle', polygon: 'studioShell.drawAPolygon', hand: 'studioShell.panCanvas', attach: 'studioShell.attachFigure'};

/** Presentation only: all editing still uses the existing document commands.
 * `builder` is the bounded builder-session controller from builder-mode.mjs;
 * it owns rig-mode entry, exit confirmation and the figure scope. */
export function initStudioShell({editor, state, setTool, renderAssets, showCommandMenu, builder, drawing, toast}) {
  const dialog = document.getElementById('insert-dialog');
  const workspace = document.querySelector('.workspace');
  const controller = new AbortController();
  const options = {signal: controller.signal};
  const mode = () => drawing?.active ? 'draw' : builder?.active ? 'rig' : 'animate';
  let pendingDraw=false;
  let modeRequest = 0, drawingExit = null;
  async function changeMode(next) {
    const request = ++modeRequest;
    pendingDraw=next==='draw';
    // Pixel operations may still own the drawing selection. Finish Draw before
    // Build binds a figure or sets its tool; only the latest workspace wins.
    if (next !== 'draw' || drawingExit) {
      const wait = drawingExit ?? drawing?.exit();
      if (wait?.then) {
        drawingExit = wait;
        try { await wait; }
        catch { return; } // DrawingController reports the error and keeps Draw active.
        finally { if (drawingExit === wait) drawingExit = null; }
        if (request !== modeRequest) return;
      }
    }
    if(next==='draw'){if(builder?.active){builder.requestExit();if(builder.active)return;}pendingDraw=false;drawing?.enter();sync();return;}
    if (next === 'rig') builder?.enter();
    else builder?.requestExit();
    sync();
  }
  document.querySelectorAll('[data-workspace-mode]').forEach(button => button.addEventListener('click', () => changeMode(button.dataset.workspaceMode), options));
  document.getElementById('leave-rig').addEventListener('click', () => changeMode('animate'), options);
  /** Today's Insert dialog, now the Add menu's "All in this project…": the project's figures with search and previews. */
  function showInsertDialog() {
    if (builder?.active) { toast?.(interfaceText("studioShell.finishTheFigureOrReturnToAnimateTo")); return; }
    state.activeTab = 'assets';
    dialog.showModal();
    renderAssets();
  }
  document.getElementById('close-insert').addEventListener('click', () => dialog.close(), options);
  dialog.addEventListener('close', () => { state.activeTab = 'layers'; renderAssets(); }, options);
  // Close before the existing delegated action opens a native file or authoring dialog.
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-action],[data-sample]')) dialog.close();
  }, options);
  document.getElementById('object-actions').addEventListener('click', event => {
    showCommandMenu(objectMenuItems(), event.currentTarget, {label: interfaceText("studioShell.moreActions"), labelKey: "studioShell.moreActions"});
  }, options);
  /**
   * Properties ⋯ (experience.md §5.1): the selection's less frequent commands, grouped under names, families in
   * submenus, and whatever removes something last. The quick tiles above keep the everyday ones one click away.
   */
  function objectMenuItems() {
    const object = editor.object, none = !object;
    const segment = editor.figure?.segments?.[editor.selectedJoint];
    if (builder?.active && segment) return [
      messageTuple(['segment-values', 'sliders', interfaceText("studioShell.exactValues"), "I"], {2: {key: "studioShell.exactValues", params: {}}}),
      messageTuple(['origin-segment', 'origin', interfaceText("studioShell.setAsOrigin")], {2: {key: "studioShell.setAsOrigin", params: {}}}),
      null,
      {label: interfaceText("studioShell.appearance"), labelKey: "studioShell.appearance"},
      messageTuple(['copy-builder-appearance', 'duplicate', interfaceText("studioShell.copyAppearance")], {2: {key: "studioShell.copyAppearance", params: {}}}),
      messageTuple(['paste-builder-appearance', 'clipboard', interfaceText("studioShell.pasteAppearance"), '', !state.builderAppearance], {2: {key: "studioShell.pasteAppearance", params: {}}}),
      null,
      {label: interfaceText("studioShell.arrange"), labelKey: "studioShell.arrange", icon: 'layers', submenu: [
        messageTuple(['segment-order-front', 'bring-to-front', interfaceText("studioShell.bringToFront")], {2: {key: "studioShell.bringToFront", params: {}}}),
        messageTuple(['segment-order-up', 'up', interfaceText("studioShell.bringForward")], {2: {key: "studioShell.bringForward", params: {}}}),
        messageTuple(['segment-order-down', 'down', interfaceText("studioShell.sendBackward")], {2: {key: "studioShell.sendBackward", params: {}}}),
        messageTuple(['segment-order-back', 'send-to-back', interfaceText("studioShell.sendToBack")], {2: {key: "studioShell.sendToBack", params: {}}}),
      ]},
      {label: interfaceText("studioShell.branch"), labelKey: "studioShell.branch", icon: 'builder-branch', submenu: [
        messageTuple(['duplicate-branch', 'duplicate', interfaceText("studioShell.duplicateBranch")], {2: {key: "studioShell.duplicateBranch", params: {}}}),
        messageTuple(['mirror-branch', 'flip', interfaceText("studioShell.flipBranchHorizontally")], {2: {key: "studioShell.flipBranchHorizontally", params: {}}}),
        messageTuple(['mirror-branch-vertical', 'flip-vertical', interfaceText("studioShell.flipBranchVertically")], {2: {key: "studioShell.flipBranchVertically", params: {}}}),
        null,
        messageTuple(['delete-segment', 'trash', interfaceText("studioShell.deleteBranch"), 'Shift Del'], {2: {key: "studioShell.deleteBranch", params: {}}}),
      ]},
      {label: interfaceText("studioShell.rig"), labelKey: "studioShell.rig", icon: 'link', submenu: [
        messageTuple(['rig-connect', 'link', interfaceText("studioShell.connectJoints")], {2: {key: "studioShell.connectJoints", params: {}}}),
        messageTuple(['rig-weighted', 'nodes', interfaceText("studioShell.addWeightedJoint")], {2: {key: "studioShell.addWeightedJoint", params: {}}}),
        messageTuple(['rig-bind-branch', 'stretch-horizontal', interfaceText("studioShell.bindBranchToStretch")], {2: {key: "studioShell.bindBranchToStretch", params: {}}}),
      ]},
      null,
      messageTuple(['add-sprite-segment', 'image', interfaceText("studioShell.attachImage")], {2: {key: "studioShell.attachImage", params: {}}}),
      ...(segment.primitive_code === 5 ? [messageTuple(['edit-text', 'text', interfaceText("studioShell.editText")], {2: {key: "studioShell.editText", params: {}}})] : []),
      null,
      messageTuple(['unsplit-segment', 'builder-unsplit', interfaceText("studioShell.removeJointKeepEnds"), 'Ctrl Del'], {2: {key: "studioShell.removeJointKeepEnds", params: {}}}),
      messageTuple(['delete-single-segment', 'trash', interfaceText("studioShell.deletePart"), 'Del'], {2: {key: "studioShell.deletePart", params: {}}}),
    ];
    if (builder?.active) return [
      messageTuple(['add-sprite-segment', 'image', interfaceText("studioShell.attachImage"), '', none], {2: {key: "studioShell.attachImage", params: {}}}),
      messageTuple(['rig-connect', 'link', interfaceText("studioShell.connectJoints"), '', none], {2: {key: "studioShell.connectJoints", params: {}}}),
      messageTuple(['rig-examples', 'layers', interfaceText("studioShell.rigExamples")], {2: {key: "studioShell.rigExamples", params: {}}}),
      null,
      messageTuple(['zoom-selection', 'center', interfaceText("studioShell.fitFigure"), 'Shift 2', none], {2: {key: "studioShell.fitFigure", params: {}}}),
      messageTuple(['rig-test', 'play', interfaceText("studioShell.testRig")], {2: {key: "studioShell.testRig", params: {}}}),
    ];
    const clip = Boolean(editor.figure?._styk?.movieclip);
    return [
      {label: interfaceText("studioShell.edit"), labelKey: "studioShell.edit"},
      messageTuple(['duplicate', 'duplicate', interfaceText("common.duplicate"), 'Ctrl D', none], {2: {key: "common.duplicate", params: {}}}),
      messageTuple(['mirror', 'flip', interfaceText("studioShell.flipHorizontally"), '', none], {2: {key: "studioShell.flipHorizontally", params: {}}}),
      messageTuple(['rotate', 'rotate', interfaceText("studioShell.rotate15"), '', none], {2: {key: "studioShell.rotate15", params: {}}}),
      messageTuple(['center', 'center', interfaceText("studioShell.center"), '', none], {2: {key: "studioShell.center", params: {}}}),
      messageTuple(['reset-pose', 'undo', interfaceText("studioShell.resetPose"), '', none], {2: {key: "studioShell.resetPose", params: {}}}),
      messageTuple(['toggle-isolate', 'detach', state.isolateMode ? interfaceText("studioShell.stopIsolatingJoint") : interfaceText("studioShell.isolateJoint"), "Caps Lock", none]),
      null,
      {label: interfaceText("studioShell.arrange"), labelKey: "studioShell.arrange"},
      messageTuple(['selection-up', 'bring-to-front', interfaceText("studioShell.bringForward"), '', none], {2: {key: "studioShell.bringForward", params: {}}}),
      messageTuple(['selection-down', 'send-to-back', interfaceText("studioShell.sendBackward"), '', none], {2: {key: "studioShell.sendBackward", params: {}}}),
      null,
      {label: interfaceText("studioShell.movieclip"), labelKey: "studioShell.movieclip", icon: 'frame', submenu: [
        messageTuple(['movieclip-create', 'frame', interfaceText("studioShell.createMovieclip"), '', none], {2: {key: "studioShell.createMovieclip", params: {}}}),
        messageTuple(['movieclip-edit', 'frame', interfaceText("studioShell.editMovieclip"), '', !clip], {2: {key: "studioShell.editMovieclip", params: {}}}),
        messageTuple(['movieclip-range', 'frame', interfaceText("studioShell.movieclipFromFrames")], {2: {key: "studioShell.movieclipFromFrames", params: {}}}),
      ]},
      messageTuple(['add-to-library', 'plus', interfaceText("studioShell.addToLibrary"), '', none], {2: {key: "studioShell.addToLibrary", params: {}}}),
      ...(object && !clip ? [messageTuple(['edit-in-build-mode', 'nodes', interfaceText("studioShell.editInBuild"), '', editor.selectedUids.size !== 1], {2: {key: "studioShell.editInBuild", params: {}}})] : []),
      null,
      messageTuple(['delete', 'trash', interfaceText('common.delete'), 'Delete', none], {2: {key: 'common.delete'}}),
    ];
  }
  // Every write compares first (ui/dom-write.mjs): sync runs on every chrome pass, so an unchanged
  // shell writes nothing. Values the drawing workspace overrides are decided before they are written.
  function sync() {
    if(pendingDraw&&!builder?.active){pendingDraw=false;drawing?.enter();}
    const current = mode(), drawingActive = Boolean(drawing?.active);
    setAttr(workspace, 'data-mode', drawingActive ? 'draw' : current);
    // The band's switch shows the current workspace; Build's Done (#builder-done) also names a workspace but is no toggle.
    // While Home shows (state.home, src/home/home.mjs), Home is the pressed item and no workspace is.
    document.querySelectorAll('.workspace-switch [data-workspace-mode]').forEach(button => setAttr(button, 'aria-pressed', String(button.dataset.workspaceMode === current && !state.home)));
    // The rail: this workspace's tools, their names and the active one (src/shell/rail.mjs).
    syncRail(document.querySelector('.studio-rail'), {mode: drawingActive ? 'draw' : current, tool: state.tool});
    localizedText(document.getElementById('tool-context'), drawingActive ? 'studioShell.drawTool' : nameKeys[state.tool] || 'studioShell.select', drawingActive ? {tool: {messageKey: ({brush:'drawingView.brush',eraser:'drawingView.eraser',fill:'drawingView.fill',shape:'drawingView.shapes',select:'drawingView.selectPixels',transform:'drawingView.transform',pan:'studioShell.panCanvas'})[drawing.tool] || 'drawingController.drawing'}} : {});
    const context = state.inspectorContext;
    const figureName = editor.figure?.name || builder?.session?.figure?.name || interfaceText("studioShell.figure");
    const count = editor.selectedUids?.size || 0;
    document.querySelectorAll('[data-selection-order]').forEach(button => { setProp(button, 'disabled', !editor.selectedObjects.length); });
    const scope = context === 'camera' ? {messageKey: 'studioShell.camera'} : context === 'scene' ? {messageKey: 'studioShell.scene'} : context === 'layer' ? {messageKey: 'studioShell.layer'} : context === 'frame' ? {messageKey: 'studioShell.timing'} : count > 1 ? {messageKey: 'counts.figures', messageParams: {count}} : editor.object ? figureName : {messageKey: 'studioShell.scene'};
    // The inspector header owns its context and selection-kind; the shell only
    // owns the workspace scope below the stage.
    const scopeKey = state.tool === 'hand' ? 'studioShell.viewOnlyYourAnimationStaysUnchanged' : current === 'rig' ? (editor.object ? 'studioShell.sharedDefinition' : 'studioShell.drawALineOrCircleToCreateA') : state.applyRange && state.rangeIndices?.length > 1 ? 'studioShell.rangeScope' : 'studioShell.frameScope';
    const scopeParams = {scope, name: figureName, count: state.rangeIndices?.length || 0, frame: editor.tick + 1, draft: editor.frameDraft?.dirty ? {messageKey: 'studioShell.workingPose'} : ''};
    if (drawingActive) localizedText(document.getElementById('edit-scope'), drawing.exposureMessage.key, drawing.exposureMessage.params);
    else localizedText(document.getElementById('edit-scope'), scopeKey, scopeParams);
    setHidden(document.getElementById('leave-rig'), current !== 'rig');
    localizedText(document.getElementById('selection-summary'), scopeKey, scopeParams);
    // #viewport-hint stays hidden: a tool's instruction is the stage header's mode message (app.mjs modeMessage).
    builder?.sync();
    if(drawingActive)drawing.sync();
  }
  sync();
  return {sync, changeMode, showInsertDialog, destroy: () => controller.abort()};
}
