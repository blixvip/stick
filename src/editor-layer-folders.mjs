import {messageError} from './localized-error.mjs';
import {ensureLayerState} from './layers.mjs';
import {folderLayerOrder} from './layer-folders.mjs';

const nameOf = name => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) throw messageError(new Error(''), 'errors.layerFolders.invalidName');
  return name.trim();
};
function members(state, ids) {
  const selected = [...new Set(ids)];
  if (selected.some(id => !Object.hasOwn(state.byId, id))) throw messageError(new Error(''), 'errors.layerFolders.chooseLayers');
  return selected;
}
export const editorLayerFolderMethods = {
  getLayerFolders() { return Object.entries(this.report._styk.layers.folders?.byId ?? {}).map(([id, folder]) => ({id, kind: 'folder', ...folder})); },
  createLayerFolder(name = 'Folder', ids = []) {
    const state = ensureLayerState(this.report), selected = members(state, ids), folders = state.folders ?? {nextId: 1, byId: {}};
    if (Object.keys(folders.byId).length >= 10000) throw messageError(new Error(''), 'errors.layerFolders.tooManyFolders');
    const id = `folder-${folders.nextId}`, folder = {name: nameOf(name)};
    const updates=state.folders?[[['folders','byId',id],folder],[['folders','nextId'],folders.nextId+1]]:
      [[['folders'],{nextId:folders.nextId+1,byId:{[id]:folder}}]];
    const byId = {...state.byId}; for (const layerId of selected) byId[layerId] = {...byId[layerId], folderId: id};
    this._layerEdit('Create layer folder', [...updates, ...selected.map(layerId => [['byId', layerId, 'folderId'], id]), [['order'], folderLayerOrder({...state, byId})]], {structural: true});
    return {id, kind: 'folder', ...folder};
  },
  renameLayerFolder(id, name) {
    if (!Object.hasOwn(this.report._styk.layers.folders?.byId ?? {}, id)) throw messageError(new Error(''), 'errors.layerFolders.missingFolder');
    return this._layerEdit('Rename layer folder', [[['folders', 'byId', id, 'name'], nameOf(name)]]);
  },
  moveLayersToFolder(ids, folderId = null) {
    const state = ensureLayerState(this.report), selected = members(state, ids);
    if (folderId !== null && !Object.hasOwn(state.folders?.byId ?? {}, folderId)) throw messageError(new Error(''), 'errors.layerFolders.missingFolder');
    const byId = {...state.byId}; for (const id of selected) { byId[id] = {...byId[id]}; if (folderId === null) delete byId[id].folderId; else byId[id].folderId = folderId; }
    let order = state.order;
    if(folderId!==null) {
      const chosen=new Set(selected), remaining=order.filter(id=>!chosen.has(id));
      const last=remaining.findLastIndex(id=>byId[id].folderId===folderId);
      if(last>=0){order=remaining.slice();order.splice(last+1,0,...state.order.filter(id=>chosen.has(id)));}
    }
    return this._layerEdit('Move layers to folder', [...selected.map(id => [['byId', id, 'folderId'], folderId, folderId === null]), [['order'], folderLayerOrder({...state, byId},order)]], {structural: true});
  },
  /** Restacks every layer as `order` (back to front) and, with `folderId` given, moves `ids` into that folder (null:
   * out of every folder), as one undo step. A folder's layers stay together. */
  arrangeLayers(order, ids = [], folderId) {
    const state = ensureLayerState(this.report), selected = members(state, ids), stack = [...order];
    if (stack.length !== state.order.length || new Set(stack).size !== stack.length || stack.some(id => !Object.hasOwn(state.byId, id))) throw messageError(new Error(''), 'errors.editorLayers.includeEveryUserLayerExactlyOnceSceneAnd', {});
    if (folderId != null && !Object.hasOwn(state.folders?.byId ?? {}, folderId)) throw messageError(new Error(''), 'errors.layerFolders.missingFolder');
    const byId = {...state.byId}, moved = folderId === undefined ? [] : selected;
    for (const id of moved) { byId[id] = {...byId[id]}; if (folderId === null) delete byId[id].folderId; else byId[id].folderId = folderId; }
    return this._layerEdit('Move layers', [...moved.map(id => [['byId', id, 'folderId'], folderId, folderId === null]), [['order'], folderLayerOrder({...state, byId}, stack)]], {structural: true});
  },
  deleteLayerFolder(id) {
    const state = ensureLayerState(this.report);
    if (!Object.hasOwn(state.folders?.byId ?? {}, id)) throw messageError(new Error(''), 'errors.layerFolders.missingFolder');
    return this._layerEdit('Ungroup layer folder', [[['folders', 'byId', id], undefined, true], ...state.order.filter(layer => state.byId[layer].folderId === id).map(layer => [['byId', layer, 'folderId'], undefined, true])], {structural: true});
  },
};
