/** Display-only references; physical shortcut IDs and history metadata stay in hotkeys.mjs. */
const commands = {
  "new": {
    "key": "menu.newAnimation"
  },
  "open": {
    "key": "hotkeyCaptions.command.open"
  },
  "save": {
    "key": "hotkeyCaptions.command.save"
  },
  "save-as": {
    "key": "hotkeyCaptions.command.saveAs"
  },
  "close-project": {
    "key": "commands.closeProject"
  },
  "recent-project": {
    "key": "commands.recentProject"
  },
  "next-project": {
    "key": "commands.nextProject"
  },
  "previous-project": {
    "key": "commands.previousProject"
  },
  "save-all": {
    "key": "commands.saveAll"
  },
  "export": {
    "key": "hotkeyCaptions.command.export"
  },
  "import": {
    "key": "hotkeyCaptions.command.import"
  },
  "settings": {
    "key": "hotkeyCaptions.command.settings"
  },
  "help": {
    "key": "menu.shortcuts"
  },
  "command-palette": {
    "key": "hotkeyCaptions.command.commandPalette"
  },
  "undo": {
    "key": "common.undo"
  },
  "redo": {
    "key": "common.redo"
  },
  "copy": {
    "key": "hotkeyCaptions.command.copy"
  },
  "cut": {
    "key": "hotkeyCaptions.command.cut"
  },
  "paste": {
    "key": "hotkeyCaptions.command.paste"
  },
  "paste-in-place": {
    "key": "commands.pasteInPlace"
  },
  "select-all": {
    "key": "commands.selectAll"
  },
  "duplicate": {
    "key": "hotkeyCaptions.command.duplicate"
  },
  "delete": {
    "key": "hotkeyCaptions.command.delete"
  },
  "cancel": {
    "key": "commands.cancel"
  },
  "tool-select": {
    "key": "hotkeyCaptions.command.toolSelect"
  },
  "tool-pose": {
    "key": "commands.toolPose"
  },
  "tool-line": {
    "key": "hotkeyCaptions.command.toolLine"
  },
  "tool-circle": {
    "key": "hotkeyCaptions.command.toolCircle"
  },
  "tool-hand": {
    "key": "hotkeyCaptions.command.toolHand"
  },
  "tool-rig": {
    "key": "commands.toolRig"
  },
  "tool-polygon": {
    "key": "hotkeyCaptions.command.toolPolygon"
  },
  "add-text": {
    "key": "hotkeyCaptions.command.addText"
  },
  "handle-edit-hold": {
    "key": "commands.handleEditHold"
  },
  "isolate-hold": {
    "key": "commands.isolateHold"
  },
  "depth-hold": {
    "key": "commands.depthHold"
  },
  "toggle-isolate": {
    "key": "hotkeyCaptions.command.toggleIsolate"
  },
  "toggle-selection-origins": {
    "key": "hotkeyCaptions.command.toggleSelectionOrigins"
  },
  "toggle-range-edit": {
    "key": "commands.toggleRangeEdit"
  },
  "join-figure": {
    "key": "hotkeyCaptions.command.joinFigure"
  },
  "insert-copied-key": {
    "key": "hotkeyCaptions.command.insertCopiedKey"
  },
  "insert-blank-key": {
    "key": "hotkeyCaptions.command.insertBlankKey"
  },
  "play-pan": {
    "key": "commands.playPan"
  },
  "play": {
    "key": "hotkeyCaptions.command.play"
  },
  "add-frame": {
    "key": "hotkeyCaptions.command.addFrame"
  },
  "extend-keyframe": {
    "key": "hotkeyCaptions.command.extendKeyframe"
  },
  "delete-frame": {
    "key": "commands.deleteFrame"
  },
  "previous-frame": {
    "key": "commands.previousFrame"
  },
  "next-frame": {
    "key": "commands.nextFrame"
  },
  "previous-keyframe": {
    "key": "hotkeyCaptions.command.previousKeyframe"
  },
  "next-keyframe": {
    "key": "hotkeyCaptions.command.nextKeyframe"
  },
  "first-frame": {
    "key": "commands.firstFrame"
  },
  "last-frame": {
    "key": "commands.lastFrame"
  },
  "toggle-loop": {
    "key": "hotkeyCaptions.command.toggleLoop"
  },
  "toggle-onion": {
    "key": "hotkeyCaptions.command.toggleOnion"
  },
  "toggle-auto-key": {
    "key": "hotkeyCaptions.command.toggleAutoKey"
  },
  "camera-follow": {
    "key": "hotkeyCaptions.command.cameraFollow"
  },
  "remove-frames": {
    "key": "commands.removeFrames"
  },
  "clear-keys": {
    "key": "commands.clearKeys"
  },
  "timeline-layer-up": {
    "key": "commands.timelineLayerUp"
  },
  "timeline-layer-down": {
    "key": "commands.timelineLayerDown"
  },
  "previous-exposure": {
    "key": "commands.previousExposure"
  },
  "next-exposure": {
    "key": "commands.nextExposure"
  },
  "zoom-in": {
    "key": "commands.zoomIn"
  },
  "zoom-out": {
    "key": "commands.zoomOut"
  },
  "zoom-reset": {
    "key": "commands.zoomReset"
  },
  "zoom-selection": {
    "key": "commands.zoomSelection"
  },
  "toggle-handles": {
    "key": "hotkeyCaptions.command.toggleHandles"
  },
  "toggle-motion-paths": {
    "key": "hotkeyCaptions.command.toggleMotionPaths"
  },
  "toggle-grid": {
    "key": "hotkeyCaptions.command.toggleGrid"
  },
  "toggle-unselected-handles": {
    "key": "hotkeyCaptions.command.toggleUnselectedHandles"
  },
  "toggle-camera": {
    "key": "hotkeyCaptions.command.toggleCamera"
  },
  "camera-reset": {
    "key": "commands.cameraReset"
  },
  "camera-center": {
    "key": "commands.cameraCenter"
  },
  "camera-align-view": {
    "key": "hotkeyCaptions.command.cameraAlignView"
  },
  "camera-copy": {
    "key": "commands.cameraCopy"
  },
  "camera-paste": {
    "key": "commands.cameraPaste"
  },
  "mirror": {
    "key": "commands.mirror"
  },
  "mirror-vertical": {
    "key": "commands.mirrorVertical"
  },
  "segment-values": {
    "key": "hotkeyCaptions.command.segmentValues"
  },
  "handle-left": {
    "key": "hotkeyCaptions.command.handleLeft"
  },
  "handle-right": {
    "key": "hotkeyCaptions.command.handleRight"
  },
  "handle-up": {
    "key": "hotkeyCaptions.command.handleUp"
  },
  "handle-down": {
    "key": "hotkeyCaptions.command.handleDown"
  },
  "previous-figure": {
    "key": "commands.previousFigure"
  },
  "next-figure": {
    "key": "commands.nextFigure"
  },
  "move-left": {
    "key": "hotkeyCaptions.command.moveLeft"
  },
  "move-right": {
    "key": "hotkeyCaptions.command.moveRight"
  },
  "move-up": {
    "key": "hotkeyCaptions.command.moveUp"
  },
  "move-down": {
    "key": "hotkeyCaptions.command.moveDown"
  },
  "locate-previous": {
    "key": "hotkeyCaptions.command.locatePrevious"
  },
  "locate-next": {
    "key": "hotkeyCaptions.command.locateNext"
  },
  "split-segment": {
    "key": "hotkeyCaptions.command.splitSegment"
  },
  "toggle-builder-branch": {
    "key": "hotkeyCaptions.command.toggleBuilderBranch"
  },
  "builder-canvas-color": {
    "key": "hotkeyCaptions.command.builderCanvasColor"
  },
  "builder-static-handles": {
    "key": "hotkeyCaptions.command.builderStaticHandles"
  },
  "builder-highlight": {
    "key": "hotkeyCaptions.command.builderHighlight"
  },
  "unsplit-segment": {
    "key": "hotkeyCaptions.command.unsplitSegment"
  },
  "delete-segment": {
    "key": "commands.deleteSegment"
  },
  "finish-polygon": {
    "key": "commands.finishPolygon"
  },
  "drawing-brush": {
    "key": "commands.drawingBrush"
  },
  "drawing-eraser": {
    "key": "commands.drawingEraser"
  },
  "drawing-fill": {
    "key": "commands.drawingFill"
  },
  "drawing-lasso": {
    "key": "commands.drawingLasso"
  },
  "drawing-shape": {
    "key": "commands.drawingShape"
  },
  "drawing-smaller": {
    "key": "commands.drawingSmaller"
  },
  "drawing-larger": {
    "key": "commands.drawingLarger"
  },
  "drawing-softer": {
    "key": "commands.drawingSofter"
  },
  "drawing-harder": {
    "key": "commands.drawingHarder"
  },
  "drawing-opacity-10": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 10
    }
  },
  "drawing-opacity-20": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 20
    }
  },
  "drawing-opacity-30": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 30
    }
  },
  "drawing-opacity-40": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 40
    }
  },
  "drawing-opacity-50": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 50
    }
  },
  "drawing-opacity-60": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 60
    }
  },
  "drawing-opacity-70": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 70
    }
  },
  "drawing-opacity-80": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 80
    }
  },
  "drawing-opacity-90": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 90
    }
  },
  "drawing-opacity-100": {
    "key": "hotkeyCaptions.brushOpacity",
    "params": {
      "percent": 100
    }
  },
  "drawing-apply": {
    "key": "commands.drawingApply"
  },
  "drawing-select-all": {
    "key": "commands.drawingSelectAll"
  },
  "drawing-deselect": {
    "key": "commands.drawingDeselect"
  },
  "drawing-invert-selection": {
    "key": "commands.drawingInvertSelection"
  },
  "drawing-fill-selection": {
    "key": "commands.drawingFillSelection"
  },
  "drawing-mirror": {
    "key": "hotkeyCaptions.command.drawingMirror"
  },
  "drawing-swap-colors": {
    "key": "hotkeyCaptions.command.drawingSwapColors"
  },
  "drawing-flip-view": {
    "key": "hotkeyCaptions.command.drawingFlipView"
  },
  "library-open": {
    "key": "hotkeyCaptions.command.libraryOpen"
  },
  "library-rename": {
    "key": "commands.libraryRename"
  },
  "panel-toggle-properties": {
    "key": "hotkeyCaptions.command.panelToggleProperties"
  },
  "panel-toggle-vfx": {
    "key": "hotkeyCaptions.command.panelToggleVfx"
  },
  "panel-toggle-library": {
    "key": "hotkeyCaptions.command.panelToggleLibrary"
  },
  "panel-toggle-timeline": {
    "key": "hotkeyCaptions.command.panelToggleTimeline"
  },
  "layout-focus": {
    "key": "commands.layoutFocus"
  },
  "layout-arrange": {
    "key": "hotkeyCaptions.command.layoutArrange"
  },
  "layout-menu": {
    "key": "commands.layoutMenu"
  },
  "focus-next-region": {
    "key": "commands.focusNextRegion"
  },
  "focus-previous-region": {
    "key": "commands.focusPreviousRegion"
  }
};
export const hotkeyCategoryMessages = {
  "Project & editing": {
    "key": "hotkeyCaptions.category.projectEditing"
  },
  "Projects": {
    "key": "hotkeyCaptions.category.projects"
  },
  "Tools": {
    "key": "hotkeyCaptions.category.tools"
  },
  "Animation": {
    "key": "hotkeyCaptions.category.animation"
  },
  "Timeline": {
    "key": "hotkeyCaptions.category.timeline"
  },
  "Filmstrip": {
    "key": "hotkeyCaptions.category.filmstrip"
  },
  "View & camera": {
    "key": "hotkeyCaptions.category.viewCamera"
  },
  "Canvas": {
    "key": "hotkeyCaptions.category.canvas"
  },
  "Hovered handle": {
    "key": "hotkeyCaptions.category.hoveredHandle"
  },
  "Figure builder": {
    "key": "hotkeyCaptions.category.figureBuilder"
  },
  "Polygon": {
    "key": "hotkeyCaptions.category.polygon"
  },
  "Drawing": {
    "key": "hotkeyCaptions.category.drawing"
  },
  "Library": {
    "key": "hotkeyCaptions.category.library"
  },
  "Panels & layout": {
    "key": "hotkeyCaptions.category.panelsLayout"
  }
};
export const hotkeyScopeMessages = {
  "global": {
    "key": "hotkeyCaptions.scope.global"
  },
  "canvas": {
    "key": "hotkeyCaptions.scope.canvas"
  },
  "hover": {
    "key": "hotkeyCaptions.scope.hover"
  },
  "builder": {
    "key": "hotkeyCaptions.scope.builder"
  },
  "timeline": {
    "key": "hotkeyCaptions.scope.timeline"
  },
  "simple": {
    "key": "hotkeyCaptions.scope.simple"
  },
  "polygon": {
    "key": "hotkeyCaptions.scope.polygon"
  },
  "library": {
    "key": "hotkeyCaptions.scope.library"
  },
  "drawing": {
    "key": "hotkeyCaptions.scope.drawing"
  }
};
export const hotkeyLabelMessage = id => commands[id] ?? null;
