import {t as text} from './localization.mjs';
import {showTimelineMenu} from './timeline-menu.mjs';

export const timelineLayerFolderMethods = {
  toggleLayerFolder(id) {
    this._cancelGesture();
    this.collapsedFolders.has(id) ? this.collapsedFolders.delete(id) : this.collapsedFolders.add(id);
    this._reindex(); this.update();
  },
  /** New folder (around the selected layers with `group`): its row comes into view, with its layers when they fit, and
   * opens its name for typing. */
  newLayerFolder(group = false) {
    return this._run(() => {
      const ids = group ? this.ids.filter(id => this.editor.getLayer(id)?.kind === 'layer') : [];
      if (this.layerQuery) this.setLayerFilter('');
      const folder = this.editor.createLayerFolder(text('layerFolders.newFolder'), ids);
      this.collapsedFolders.delete(folder.id);
      const last = this.tracks.findLast(row => row.folderId === folder.id);
      if (last) this.revealRow(last.id);
      this.renameRow(folder.id); return folder;
    });
  },
  layerFolderMenuItems() {
    const ids = this.ids.filter(id => this.editor.getLayer(id)?.kind === 'layer');
    return [
      {label: text('layerFolders.newFolder'), labelKey: 'layerFolders.newFolder', symbol: 'folder', action: () => this.newLayerFolder()},
      ids.length && {label: text('layerFolders.group'), labelKey: 'layerFolders.group', symbol: 'folder', action: () => this.newLayerFolder(true)},
      ids.length && this.editor.getLayerFolders().length && {label: text('layerFolders.move'), labelKey: 'layerFolders.move', symbol: 'folder', submenu: [this.editor.getLayerFolders().map(folder => ({label: folder.name, action: () => this.editor.moveLayersToFolder(ids, folder.id)}))]},
      ids.some(id => this.editor.getLayer(id)?.folderId) && {label: text('layerFolders.remove'), labelKey: 'layerFolders.remove', action: () => this.editor.moveLayersToFolder(ids)},
    ];
  },
  folderMenu(event, id) {
    const folder = this.tracks.find(row => row.id === id), node = this.labels.find(label => !label.hidden && label._id === id);
    if (!folder) return;
    return showTimelineMenu(this, event, [
      [{heading: folder.name}, {label: text('layerFolders.rename'), labelKey: 'layerFolders.rename', symbol: 'text', action: () => this._renameLayer(node)},
        {label: text(folder.collapsed ? 'layerFolders.expand' : 'layerFolders.collapse', {name: folder.name}), labelKey: folder.collapsed ? 'layerFolders.expand' : 'layerFolders.collapse', labelParams: {name: folder.name}, symbol: 'folder', action: () => this.toggleLayerFolder(id)}],
      [{label: text('layerFolders.ungroup'), labelKey: 'layerFolders.ungroup', action: () => this.editor.deleteLayerFolder(id)}],
    ]);
  },
};
