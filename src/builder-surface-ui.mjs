import {presentError} from './error-presentation.mjs';
import {messageTuple, tupleMessages, messageHTML, messageAttributes, localizedMarkup, appendLocalized} from './localization-bindings.mjs';
import {messageError} from './localized-error.mjs';

import {t as interfaceText} from './localization.mjs';

import {icon} from './icons.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function polygonSurfaceView(editor,index) {
  const surface=editor.figure.polyfills[index]._stykSurface,side=surface?.side??(surface?'front':'both');
  return `<div class="fill-facing"><label class="rig-select"><span data-i18n="builderSurfaceUi.visibleSides">${messageHTML("builderSurfaceUi.visibleSides", {})}</span><select class="inline-select" data-polygon-side="${index}" aria-label="Visible sides" data-i18n-aria-label="builderSurfaceUi.visibleSides">${[messageTuple(['both',interfaceText("builderSurfaceUi.both")], {1: {key: "builderSurfaceUi.both", params: {}}}),messageTuple(['front',interfaceText("builderSurfaceUi.front")], {1: {key: "builderSurfaceUi.front", params: {}}}),messageTuple(['back',interfaceText("builderSurfaceUi.back")], {1: {key: "builderSurfaceUi.back", params: {}}})].map(tuple=>{const [v,l]=tuple,message=tupleMessages(tuple)[1];return `<option value="${v}" ${side===v?'selected':''} ${messageAttributes(message.key,message.params)}>${l}</option>`;}).join('')}</select></label><button class="icon-button" data-polygon-flip="${index}" aria-label="Flip facing" title="Flip facing" aria-pressed="${Boolean(surface?.flipped)}" ${surface?'':'disabled'} data-i18n-aria-label="builderSurfaceUi.flipFacing" data-i18n-title="builderSurfaceUi.flipFacing">${icon('flip')}</button></div>${surface?`<button class="button fill-reference" data-polygon-reference="${index}">${icon('origin')}${messageHTML("builderSurfaceUi.referenceJoints", {})}</button>`:''}`;
}

/** A local draft; Apply is one normal figure edit. Search suggestions stay
 * bounded even in a figure with 30,000 joints. */
export function openSurfaceReference(editor,index,host,{side}={}) {
  const figure=editor.figure,polygon=figure?.polyfills?.[index];if(!polygon)return;
  const token=editor._documentToken,uid=editor.selectedUid,type=figure.figure_type_id,id=polygon.polyfill_id;
  const surface=polygon._stykSurface??figure.polyfills.find(p=>p._stykSurface)?._stykSurface;
  const joints=[{id:0,name:interfaceText('builderSurfaceUi.origin')},...figure.segments.map(s=>({id:s.segment_id,name:s.name||interfaceText('builderSurfaceUi.jointNumber',{id:s.segment_id})}))];
  const labels=new Map(joints.map(j=>[j.id,`${j.id} · ${j.name}`])),basis=surface?.basis??[0,null,null];
  host.showDialog(interfaceText("builderSurfaceUi.referenceJoints"),`<form id="fill-reference-form"><div class="fill-reference-fields">${['builderSurfaceUi.origin','builderSurfaceUi.xJoint','builderSurfaceUi.yJoint'].map((key,i)=>`<label class="rig-select"><span ${messageAttributes(key)}>${interfaceText(key)}</span><input class="inline-select" data-face-axis="${i}" aria-label="${interfaceText(key)}" ${messageAttributes(key,{},'aria-label')} list="face-axis-${i}" autocomplete="off" value="${esc(labels.get(basis[i])??'')}"><datalist id="face-axis-${i}"></datalist></label>`).join('')}</div><p class="property-note" id="fill-reference-error" role="status" hidden></p><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog" data-i18n="common.cancel">${messageHTML("builderSurfaceUi.cancel", {})}</button><button type="submit" class="button primary" data-i18n="common.apply">${messageHTML("builderSurfaceUi.apply", {})}</button></div></form>`, {titleKey: "builderSurfaceUi.referenceJoints"});
  const form=document.getElementById('fill-reference-form'),inputs=[...form.querySelectorAll('[data-face-axis]')];
  const depthField=document.createElement('label');depthField.className='rig-select';
  localizedMarkup(depthField, `<span data-i18n="builderSurfaceUi.depthJointsOptional">${messageHTML("builderSurfaceUi.depthJointsOptional", {})}</span><input class="inline-select" aria-label="Depth joints" placeholder="Joint IDs separated by commas" data-i18n-aria-label="builderSurfaceUi.depthJoints" data-i18n-placeholder="builderSurfaceUi.jointIdsSeparatedByCommas"><small class="property-note" data-i18n="builderSurfaceUi.theirAveragePositionAlongTheReferenceXAxis">${messageHTML("builderSurfaceUi.theirAveragePositionAlongTheReferenceXAxis", {})}</small>`);
  const depthInput=depthField.querySelector('input');depthInput.value=(polygon._stykSurface?.depth??[]).join(', ');
  appendLocalized(form.querySelector('.fill-reference-fields'), depthField);
  const testField=document.createElement('label');testField.className='rig-select';
  localizedMarkup(testField, `<span><input type="checkbox" aria-label="Depth test intersections" data-i18n-aria-label="builderSurfaceUi.depthTestIntersections">${messageHTML("builderSurfaceUi.depthTestIntersections", {})}</span><small class="property-note" data-i18n="builderSurfaceUi.forOpaqueTrianglesEnterOneDepthJointPer">${messageHTML("builderSurfaceUi.forOpaqueTrianglesEnterOneDepthJointPer", {})}</small>`);
  const testInput=testField.querySelector('input');testInput.checked=Boolean(polygon._stykSurface?.depthTest);
  testInput.disabled=polygon.segment_ids.length!==3;
  appendLocalized(form.querySelector('.fill-reference-fields'), testField);
  for(const input of inputs){
    const suggest=()=>{const query=input.value.includes(' · ')?'':input.value.trim().toLowerCase(),found=[];
      for(const joint of joints){if(!query||String(joint.id)===query||joint.name.toLowerCase().includes(query)){found.push(`<option value="${esc(labels.get(joint.id))}"></option>`);if(found.length===60)break;}}
      localizedMarkup(input.list, found.join(''));};
    input.addEventListener('input',suggest);input.addEventListener('focus',()=>input.select());suggest();
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();
    try{
      if(token!==editor._documentToken||uid!==editor.selectedUid||type!==editor.figure?.figure_type_id||editor.figure.polyfills[index]?.polyfill_id!==id)throw messageError(new Error(''), "errors.builderSurfaceUi.theFillChangedCloseThisDialogAndSelect", {});
      const basis=inputs.map(input=>{const match=/^(\d+)(?: · .*)?$/.exec(input.value.trim());return match?Number(match[1]):NaN;});
      const text=depthInput.value.trim(),depth=text?text.split(',').map(value=>/^\d+$/.test(value.trim())?Number(value.trim()):NaN):undefined;
      editor.updatePolygon(index,{surface:{basis,side:side??polygon._stykSurface?.side??'front',flipped:polygon._stykSurface?.flipped??false,...(depth?{depth}:{}),...(testInput.checked?{depthTest:true}:{})}});host.closeDialog();
    }catch(error){const status=form.querySelector('[role="status"]');status.hidden=false;presentError(status, error);}
  });
  inputs[basis[1]===null?1:0].focus();
}

export function changeSurfaceSide(editor,index,side,host) {
  if(side==='both')return editor.updatePolygon(index,{surface:null});
  const own=editor.figure.polyfills[index]._stykSurface,reference=editor.figure.polyfills.find(p=>p._stykSurface)?._stykSurface;
  const surface=own??(reference?{basis:reference.basis,flipped:false}:null);
  if(!surface){openSurfaceReference(editor,index,host,{side});return false;}
  return editor.updatePolygon(index,{surface:{...surface,side}});
}
