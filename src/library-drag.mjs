import {messageError} from './localized-error.mjs';
import {localizedText, appendLocalized} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';

export const LIBRARY_DRAG_TYPE = 'application/x-stykanimate-library-asset';
// A card of My library (a path) or of the public library (an id).
const CARD = '[data-library-path], [data-public-id]';

export function canMoveLibraryItem(item, folder) {
  if (typeof folder !== 'string' || !item?.path) return false;
  if (folder === item.path.split('/').slice(0, -1).join('/')) return false;
  return item.kind !== 'folder' || folder !== item.path && !folder.startsWith(`${item.path}/`);
}

export function libraryDragData(item) {
  if (item.kind === 'folder') return null;
  return JSON.stringify({version: 1, path: item.path, name: item.name});
}

export function readLibraryDrag(transfer) {
  const text = transfer?.getData(LIBRARY_DRAG_TYPE);
  if (!text || text.length > 8192) throw messageError(new Error(''), "errors.libraryDrag.invalidLibraryAsset", {});
  let value; try { value = JSON.parse(text); } catch { throw messageError(new Error(''), "errors.libraryDrag.invalidLibraryAsset", {}); }
  if (value.version !== 1 || typeof value.path !== 'string' || !value.path || value.path.split(/[\\/]/).some(part => !part || part === '..' || part === '.') || /[:\x00-\x1f]/.test(value.path) || typeof value.name !== 'string') throw messageError(new Error(''), "errors.libraryDrag.invalidLibraryAsset", {});
  return value;
}

// Keep in-app drags out of the native OS drag loop. While held, only move a
// cached thumbnail on the compositor; parsing and scene insertion happen on up.
export function installLibraryDrag(source, target, {getAsset, onStart, position, insert, getDestination, moveItem, onError}) {
  const doc = source.ownerDocument, win = doc.defaultView;
  let drag = null, frame = 0, suppressClick = false;
  const destinationAt = event => {
    const hit = doc.elementFromPoint(event.clientX, event.clientY);
    const folder = getDestination?.(hit, drag.asset);
    if (folder) return {...folder, kind: 'folder'};
    return hit && target.contains(hit) && drag.asset.kind !== 'folder' ? {element: target, kind: 'canvas'} : null;
  };
  const paint = () => {
    frame = 0;
    if (!drag?.ghost) return;
    const destination = destinationAt(drag), over = destination?.element;
    drag.ghost.style.transform = `translate3d(${drag.clientX + 14}px, ${drag.clientY + 14}px, 0)`;
    if (drag.over !== over) {
      drag.over?.classList.remove('library-folder-drop-target');
      drag.over = over;
      target.classList.toggle('library-drop-target', destination?.kind === 'canvas');
      if (destination?.kind === 'folder') over.classList.add('library-folder-drop-target');
      doc.documentElement.classList.toggle('library-pointer-over-target', destination?.kind === 'canvas');
      localizedText(drag.hint, (destination?.kind === 'folder' ? 'libraryDrag.moveToName' : (destination ? "libraryDrag.addToScene" : "libraryDrag.dropOnAFolderOrCanvas")), (destination?.kind === 'folder' ? {name: destination.name} : (destination ? {} : {})));
    }
    const scroll = source.parentElement, rect = scroll.getBoundingClientRect();
    if (drag.clientX >= rect.left && drag.clientX <= rect.right && drag.clientY >= rect.top && drag.clientY <= rect.bottom) {
      const amount = drag.clientY < rect.top + 28 ? -10 : drag.clientY > rect.bottom - 28 ? 10 : 0, before = scroll.scrollTop;
      if (amount) { scroll.scrollTop += amount; if (scroll.scrollTop !== before) frame = win.requestAnimationFrame(paint); }
    }
  };
  const finish = event => {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
    const ended = drag;
    const drop = event?.type === 'pointerup' && event.button === 0 && ended.ghost ? destinationAt(event) : null;
    drag = null;
    win.cancelAnimationFrame(frame); frame = 0;
    ended.ghost?.remove(); ended.card.classList.remove('library-dragging');
    ended.over?.classList.remove('library-folder-drop-target');
    target.classList.remove('library-drop-target');
    doc.documentElement.classList.remove('library-pointer-dragging', 'library-pointer-over-target');
    if (ended.card.hasPointerCapture(ended.pointerId)) ended.card.releasePointerCapture(ended.pointerId);
    if (ended.ghost) {
      suppressClick = true;
      event?.preventDefault(); event?.stopPropagation();
    }
    if (drop) {
      try { Promise.resolve(drop.kind === 'folder' ? moveItem(ended.asset, drop.folder) : insert(ended.asset, position(event))).catch(onError); }
      catch (error) { onError(error); }
    }
  };
  const down = event => {
    if (drag || !event.isPrimary || event.button !== 0) return;
    if (event.target.closest('input, textarea, button, [contenteditable="true"]')) return;
    const card = event.target.closest(CARD);
    if (!card || !source.contains(card)) return;
    const asset = getAsset(card);
    if (!asset || asset.kind === 'folder' && !moveItem) return;
    drag = {card, asset, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY};
    card.setPointerCapture(event.pointerId);
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!(event.buttons & 1)) { finish(); return; }
    if (!drag.ghost) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      onStart?.(drag.asset);
      const ghost = doc.createElement('div'); ghost.className = 'library-drag-ghost'; ghost.setAttribute('aria-hidden', 'true');
      ghost.style.setProperty('--library-matte', win.getComputedStyle(drag.card.querySelector('.library-thumbnail')).backgroundColor);
      const thumbnail = drag.card.querySelector('.library-thumbnail img');
      if (thumbnail) appendLocalized(ghost, thumbnail.cloneNode());
      const name = doc.createElement('span'); name.textContent = drag.asset.name; appendLocalized(ghost, name);
      const hint = doc.createElement('small'); localizedText(hint, (drag.asset.kind === 'folder' ? "libraryDrag.dropOnAFolder" : "libraryDrag.dropOnAFolderOrCanvas"), (drag.asset.kind === 'folder' ? {} : {})); appendLocalized(ghost, hint); drag.hint = hint;
      appendLocalized(doc.body, ghost); drag.ghost = ghost;
      drag.card.classList.add('library-dragging');
      doc.documentElement.classList.add('library-pointer-dragging');
    }
    event.preventDefault(); event.stopPropagation();
    drag.clientX = event.clientX; drag.clientY = event.clientY;
    // Coalesce queued input: the next frame always paints the latest point.
    if (!frame) frame = win.requestAnimationFrame(paint);
  };
  const key = event => {
    if (!drag?.ghost) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') finish();
  };
  const click = event => {
    if (!suppressClick || event.detail === 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  const nativeDrag = event => { if (event.target.closest(CARD)) event.preventDefault(); };
  const nextPress = () => { suppressClick = false; };
  const blur = () => finish();
  source.addEventListener('pointerdown', down);
  source.addEventListener('dragstart', nativeDrag);
  doc.addEventListener('pointerdown', nextPress, true);
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', finish, true);
  doc.addEventListener('pointercancel', finish, true);
  doc.addEventListener('lostpointercapture', finish, true);
  win.addEventListener('keydown', key, true);
  win.addEventListener('blur', blur);
  doc.addEventListener('click', click, true);
  doc.addEventListener('dblclick', click, true);
  return () => {
    finish();
    source.removeEventListener('pointerdown', down);
    source.removeEventListener('dragstart', nativeDrag);
    doc.removeEventListener('pointerdown', nextPress, true);
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', finish, true);
    doc.removeEventListener('pointercancel', finish, true);
    doc.removeEventListener('lostpointercapture', finish, true);
    win.removeEventListener('keydown', key, true);
    win.removeEventListener('blur', blur);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('dblclick', click, true);
  };
}

export function installLibraryDrop(target, {position, insert, onError}) {
  const accepts = event => [...(event.dataTransfer?.types ?? [])].includes(LIBRARY_DRAG_TYPE);
  const clear = () => target.classList.remove('library-drop-target');
  target.addEventListener('dragover', event => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
    target.classList.add('library-drop-target');
  });
  target.addEventListener('dragleave', event => { if (!target.contains(event.relatedTarget)) clear(); });
  document.addEventListener('dragend', clear);
  target.addEventListener('drop', event => {
    clear(); if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    try { const asset = readLibraryDrag(event.dataTransfer); Promise.resolve(insert(asset, position(event))).catch(onError); }
    catch (error) { onError(error); }
  });
}
