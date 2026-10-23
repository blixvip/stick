import {messageError} from './localized-error.mjs';
import {figurePalette, attachedFigurePalette, validateRecolor} from './figure-colors.mjs';
import {layerLocked,layerVisible} from './layers.mjs';
import {hexColor,parseColor} from './paint.mjs';
import {projectColors, validateProjectColors, PROJECT_PALETTE_LIMIT} from './color-palette.mjs';

// A palette colour from #rrggbb text or RGB bytes; parseColor explains bad input.
const paletteColor=color=>hexColor(Array.isArray(color)?color:parseColor(color).color);

/** Project colours are document metadata: one small undoable command that
 * never touches frames or figures, so rendering caches stay valid. */
function publishPalette(editor,colors,label){
  const before=projectColors(editor.report);
  if(colors.length===before.length&&colors.every((color,index)=>color===before[index]))return false;
  validateProjectColors(colors);
  if(editor._drag)editor.commitDrag();
  if(editor._animationEdit)editor.commitAnimationEdit();
  const metadata=editor.report._styk??={},beforePresent=Object.hasOwn(metadata,'palette'),previous=metadata.palette;
  if(colors.length)metadata.palette={version:1,colors};else delete metadata.palette;
  editor._record({kind:'palette',label,before:beforePresent?previous:null,after:metadata.palette??null,precomputedBytes:(before.length+colors.length)*16+256});
  editor._emit('edit',{label,palette:true});
  return true;
}
export function applyPaletteCommand(editor,command,direction){
  if(command.kind!=='palette')return false;
  const value=command[direction],metadata=editor.report._styk??={};
  if(value)metadata.palette=value;else delete metadata.palette;
  editor._revision=command[`${direction}Revision`];
  editor._emit('history',{label:command.label,palette:true});
  return true;
}

export const editorColorMethods={
  figurePalette(){return this.figure&&this.object?(this.selectedJoint<0?attachedFigurePalette(this.report,this.selectionFrame,this.selectedUid):figurePalette(this.report,this.figure,this.object)):[];},
  editFigureColors(operation,{indices,...options}={}){
    operation=validateRecolor({...operation,kind:'recolor'});
    const uids=options.uids??[...this.selectedUids];
    if(uids.some(uid=>layerLocked(this.report,uid)||!layerVisible(this.report,uid)))throw messageError(new Error(''), "errors.editorColors.showAndUnlockTheSelectedLayersBeforeRecoloring", {});
    return this.applyFigureRange(operation,{...options,uids,...(indices?{indices}:this.propertyChannels&&!this.report._styk?.layerSheet?{ticks:[this.tick]}:{atPlayhead:true}),label:operation.mode==='replace'?'Replace figure color':operation.mode==='style'?'Edit segment colors':operation.mode==='reset'?'Reset figure colors':'Set figure color'});
  },
  setFigureColor(color,options={}){const {opacity,...range}=options;return this.editFigureColors({mode:'all',color,opacity},range);},
  replaceFigureColor(from,color,{targets,...options}={}){
    const operation=validateRecolor({mode:'replace',from,color,targets});
    if(!targets&&this.selectedJoint<0&&hexColor(operation.from)!==hexColor(operation.color)){
      const entry=this.figurePalette().find(entry=>entry.color===hexColor(operation.from));
      if(entry?.instances)targets=entry;
    }
    return this.editFigureColors({...operation,targets,figureTypeId:this.figure?.figure_type_id},
      {...options,...(targets?.instances?{uids:Object.keys(targets.instances).map(Number)}:{})});
  },
  resetFigureColors(options={}){return this.editFigureColors({mode:'reset'},options);},
  /** Adds a colour to the end of the project palette; false when it is already there. */
  addPaletteColor(color){
    const hex=paletteColor(color),colors=projectColors(this.report);
    if(colors.includes(hex))return false;
    if(colors.length>=PROJECT_PALETTE_LIMIT)throw messageError(new Error(''), "errors.editorColors.theProjectPaletteIsFullRemoveAColor", {value: hex.toUpperCase()});
    return publishPalette(this,[...colors,hex],'Add palette color');
  },
  /** Adds the colours the project lacks, in order, as one undo step; returns how many. */
  addPaletteColors(list){
    const colors=projectColors(this.report),added=[...new Set(list.map(paletteColor))].filter(hex=>!colors.includes(hex));
    if(!added.length)return 0;
    if(colors.length+added.length>PROJECT_PALETTE_LIMIT)throw messageError(new Error(''), "errors.editorColors.theProjectPaletteHoldsUpToColorsRemove", {PROJECT_PALETTE_LIMIT: PROJECT_PALETTE_LIMIT, value: colors.length+added.length-PROJECT_PALETTE_LIMIT});
    publishPalette(this,[...colors,...added],'Add palette colors');
    return added.length;
  },
  removePaletteColor(color){
    const hex=paletteColor(color),colors=projectColors(this.report);
    return colors.includes(hex)&&publishPalette(this,colors.filter(entry=>entry!==hex),'Remove palette color');
  },
  /** Moves a project colour to `index` (its position after the move). */
  movePaletteColor(color,index){
    const hex=paletteColor(color),colors=projectColors(this.report),from=colors.indexOf(hex);
    if(from<0)return false;
    const to=Math.max(0,Math.min(colors.length-1,Math.trunc(index)||0)),next=colors.filter(entry=>entry!==hex);
    next.splice(to,0,hex);
    return publishPalette(this,next,'Reorder palette colors');
  },
};
