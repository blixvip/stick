/** Insertion and translation share the existing compound-command history.
 * Only the inserted poses/definitions are held while the pointer is down;
 * cancellation leaves the undo and redo stacks untouched.
 */
function rollback(editor, duplicate) {
  for (const command of [...duplicate.commands].reverse()) editor._applyCommand(command, 'before');
  editor._revision = duplicate.revision;
  editor._restoreSelection(duplicate.selection);
  editor._pruneFrameSources();
  editor._invalidate({timing: true});
  editor._emit('edit', {label: 'Cancel duplicate', structural: true});
}

export const editorDuplicateDragMethods = {
  beginDuplicateDrag({pasteMode = 'instance'} = {}) {
    if (this._drag) this.commitDrag();
    if (this._animationEdit) this.commitAnimationEdit();
    if (!this.object) return false;
    const duplicate = {commands: [], revision: this.revision, selection: this._selectionState()};
    // Use the same sparse insertion collector as compound movieclip edits.
    this._movieclipBatch = duplicate.commands;
    try {
      this.selectMany(this.resolveTranslationSelection().affectedUids);
      const copies = this.duplicateSelection({pasteMode, offset: 0, wholeFigures: true});
      if (!copies.length || !this.beginTranslationDrag('Duplicate figures')) {
        rollback(this, duplicate); return false;
      }
      this._drag.duplicate = duplicate;
      this._drag.changed = true;
      return true;
    } catch (error) {
      this.cancelDrag(); rollback(this, duplicate); throw error;
    } finally { this._movieclipBatch = null; }
  },
  finishDuplicateDrag(commit) {
    const duplicate = this._drag?.duplicate;
    if (!duplicate) return false;
    delete this._drag.duplicate;
    if (!commit) {
      this.cancelDrag(); rollback(this, duplicate); return true;
    }
    // Publish a single undo step only after the translation has validated.
    this._revision = duplicate.revision;
    try {
      this.movieclipBatch('Duplicate figures', () => {
        this._movieclipBatch.push(...duplicate.commands);
        this.commitDrag();
      }, {beforeSelection: duplicate.selection});
      return true;
    } catch (error) {
      this.cancelDrag();
      this._restoreSelection(duplicate.selection);
      this._pruneFrameSources(); this._invalidate({timing: true});
      this._emit('edit', {label: 'Cancel duplicate', structural: true});
      throw error;
    }
  },
};
