import {messageTuple} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
/** Build's right-click menus: only the commands that apply to what was clicked, grouped under names, the
 * families (Arrange, Branch, Rig, View) in submenus, and what removes something last. Rows are the app's menu
 * tuples ([command, glyph, label, shortcut, disabled]), group names ({label}) and submenus ({label, icon,
 * submenu}); every command runs through the app's one dispatcher. `page` keeps the old flat pages reachable
 * ('branch', 'arrange', 'view') for a caller that still asks for one. */
export function builderContextItems({kind, page = 'main', hasFigure, state, name = ''}) {
  const branch = state.builderBranch || state.builderShiftHeld || state.builderBranchSelected;
  const arrange = [
    messageTuple(['segment-order-front', 'bring-to-front', interfaceText("builderContextMenu.bringToFront"), ''], {2: {key: "builderContextMenu.bringToFront", params: {}}}),
    messageTuple(['segment-order-up', 'up', interfaceText("builderContextMenu.bringForward"), ''], {2: {key: "builderContextMenu.bringForward", params: {}}}),
    messageTuple(['segment-order-down', 'down', interfaceText("builderContextMenu.sendBackward"), ''], {2: {key: "builderContextMenu.sendBackward", params: {}}}),
    messageTuple(['segment-order-back', 'send-to-back', interfaceText("builderContextMenu.sendToBack"), ''], {2: {key: "builderContextMenu.sendToBack", params: {}}})];
  const branchRows = [
    messageTuple(['builder-context-select-branch', 'builder-branch', interfaceText("builderContextMenu.selectBranch"), ''], {2: {key: "builderContextMenu.selectBranch", params: {}}}),
    messageTuple(['duplicate-branch', 'duplicate', interfaceText("builderContextMenu.duplicateBranch"), ''], {2: {key: "builderContextMenu.duplicateBranch", params: {}}}),
    messageTuple(['builder-context-split-branch', 'builder-split', interfaceText("builderContextMenu.splitBranchParts"), ''], {2: {key: "builderContextMenu.splitBranchParts", params: {}}}), null,
    messageTuple(['mirror-branch', 'flip', interfaceText("builderContextMenu.flipBranchHorizontally"), ''], {2: {key: "builderContextMenu.flipBranchHorizontally", params: {}}}),
    messageTuple(['mirror-branch-vertical', 'flip-vertical', interfaceText("builderContextMenu.flipBranchVertically"), ''], {2: {key: "builderContextMenu.flipBranchVertically", params: {}}}), null,
    messageTuple(['delete-segment', 'trash', interfaceText("builderContextMenu.deleteBranch"), 'Shift Del'], {2: {key: "builderContextMenu.deleteBranch", params: {}}})];
  const view = [
    {command: 'builder-static-handles', icon: 'pin', label: interfaceText("builderContextMenu.staticHandles"), labelKey: "builderContextMenu.staticHandles", shortcut: 'F10', checked: state.settings.builderShowStaticHandles !== false},
    {command: 'builder-highlight', icon: 'highlight', label: interfaceText("builderContextMenu.highlightPart"), labelKey: "builderContextMenu.highlightPart", shortcut: 'F12', checked: Boolean(state.settings.builderHighlightSegment)},
    {command: 'toggle-isolate', icon: 'detach', label: interfaceText("builderContextMenu.isolateJoint"), labelKey: "builderContextMenu.isolateJoint", shortcut: 'Caps Lock', checked: Boolean(state.isolateMode)}, null,
    messageTuple(['builder-canvas-color', 'palette', interfaceText("builderContextMenu.constructionBackground"), interfaceText("builderContextMenu.f9")], {2: {key: "builderContextMenu.constructionBackground", params: {}}, 3: {key: "builderContextMenu.f9", params: {}}})];
  if (page === 'branch') return branchRows;
  if (page === 'arrange') return arrange;
  if (page === 'view') return view;
  if (kind === 'joint') return [
    ...(name ? [{label: name}] : []),
    [branch ? 'builder-context-split-branch' : 'split-segment', 'builder-split', branch ? interfaceText("builderContextMenu.splitBranchParts") : interfaceText("builderContextMenu.split"), ''],
    [branch ? 'duplicate-branch' : 'duplicate-segment', 'duplicate', branch ? interfaceText("builderContextMenu.duplicateBranch") : interfaceText("builderContextMenu.duplicate"), ''],
    messageTuple([branch ? 'mirror-branch' : 'mirror-segment', 'flip', interfaceText("builderContextMenu.flipHorizontally"), ''], {2: {key: "builderContextMenu.flipHorizontally", params: {}}}),
    messageTuple([branch ? 'mirror-branch-vertical' : 'mirror-segment-vertical', 'flip-vertical', interfaceText("builderContextMenu.flipVertically"), ''], {2: {key: "builderContextMenu.flipVertically", params: {}}}),
    messageTuple(['segment-values', 'sliders', interfaceText("builderContextMenu.exactValues"), "I"], {2: {key: "builderContextMenu.exactValues", params: {}}}),
    null,
    messageTuple(['copy-builder-appearance', 'duplicate', interfaceText("builderContextMenu.copyAppearance"), ''], {2: {key: "builderContextMenu.copyAppearance", params: {}}}),
    ['paste-builder-appearance', 'clipboard', branch ? interfaceText("builderContextMenu.pasteAppearanceToBranch") : interfaceText("builderContextMenu.pasteAppearance"), '', !state.builderAppearance],
    null,
    {label: interfaceText("builderContextMenu.arrange"), labelKey: "builderContextMenu.arrange", icon: 'layers', submenu: arrange},
    {label: interfaceText("builderContextMenu.branch"), labelKey: "builderContextMenu.branch", icon: 'builder-branch', submenu: branchRows},
    {label: interfaceText("builderContextMenu.rig"), labelKey: "builderContextMenu.rig", icon: 'link', submenu: [
      messageTuple(['rig-connect', 'link', interfaceText("builderContextMenu.connectToAnotherJoint"), ''], {2: {key: "builderContextMenu.connectToAnotherJoint", params: {}}}),
      messageTuple(['rig-weighted', 'nodes', interfaceText("builderContextMenu.addWeightedJoint"), ''], {2: {key: "builderContextMenu.addWeightedJoint", params: {}}}),
      messageTuple(['rig-test', 'play', interfaceText("builderContextMenu.testRig"), ''], {2: {key: "builderContextMenu.testRig", params: {}}})]},
    messageTuple(['origin-segment', 'origin', interfaceText("builderContextMenu.setAsOrigin"), ''], {2: {key: "builderContextMenu.setAsOrigin", params: {}}}),
    null,
    messageTuple(['unsplit-segment', 'builder-unsplit', interfaceText("builderContextMenu.removeJointKeepEnds"), ''], {2: {key: "builderContextMenu.removeJointKeepEnds", params: {}}}),
    messageTuple(['delete-single-segment', 'trash', interfaceText("builderContextMenu.deletePart"), ''], {2: {key: "builderContextMenu.deletePart", params: {}}})];
  if (kind === 'polygon') return [
    messageTuple(['builder-context-fill-front', 'bring-to-front', interfaceText("builderContextMenu.bringFillToFront"), ''], {2: {key: "builderContextMenu.bringFillToFront", params: {}}}),
    messageTuple(['builder-context-fill-back', 'send-to-back', interfaceText("builderContextMenu.sendFillToBack"), ''], {2: {key: "builderContextMenu.sendFillToBack", params: {}}}), null,
    messageTuple(['builder-context-delete-fill', 'trash', interfaceText("builderContextMenu.deleteFill"), ''], {2: {key: "builderContextMenu.deleteFill", params: {}}})];
  return [
    {label: interfaceText("builderContextMenu.draw"), labelKey: "builderContextMenu.draw"},
    messageTuple(['builder-context-tool-line', 'line', interfaceText("builderContextMenu.line"), "L"], {2: {key: "builderContextMenu.line", params: {}}}),
    messageTuple(['builder-context-tool-chain', 'builder-chain', interfaceText("builderContextMenu.chainOfLines"), ''], {2: {key: "builderContextMenu.chainOfLines", params: {}}}),
    messageTuple(['builder-context-tool-circle', 'circle', interfaceText("builderContextMenu.circle"), "C"], {2: {key: "builderContextMenu.circle", params: {}}}),
    messageTuple(['builder-context-tool-polygon', 'polygon', interfaceText("builderContextMenu.fillShape"), '', !hasFigure], {2: {key: "builderContextMenu.fillShape", params: {}}}),
    ...(kind === 'figure' ? [messageTuple(['add-sprite-segment', 'image', interfaceText("builderContextMenu.attachImage"), ''], {2: {key: "builderContextMenu.attachImage", params: {}}})] : []),
    messageTuple(['builder-context-tool-rig', 'nodes', interfaceText("builderContextMenu.editJoints"), '', !hasFigure], {2: {key: "builderContextMenu.editJoints", params: {}}}),
    null,
    messageTuple(['zoom-selection', 'center', interfaceText("builderContextMenu.fitFigure"), 'Shift 2', !hasFigure], {2: {key: "builderContextMenu.fitFigure", params: {}}}),
    messageTuple(['zoom-reset', 'fit', interfaceText("builderContextMenu.fitCanvas"), 'Shift 1'], {2: {key: "builderContextMenu.fitCanvas", params: {}}}),
    {label: interfaceText("builderContextMenu.view"), labelKey: "builderContextMenu.view", icon: 'eye', submenu: view},
    ['builder-context-timeline', 'panel-bottom', state.builderTimelineVisible ? interfaceText("builderContextMenu.hideTimeline") : interfaceText("builderContextMenu.showTimeline"), '']];
}
