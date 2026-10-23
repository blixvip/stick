/**
 * The rig controls' markup before they moved to inspector descriptors (src/rig-controls.mjs at 83e98a5),
 * verbatim, so tests/inspector-descriptors.test.mjs can prove every rig control keeps its identity.
 */
import {icon} from '../../src/icons.mjs';
import {rigConstraintPlan} from '../../src/rig-constraints.mjs';
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field=(id,label,value,min,max,unit='')=>`<label class="field"><span>${label}</span><input id="${id}" type="number" value="${value}" min="${min}" max="${max}" step="any" aria-label="${label}"><small>${unit}</small></label>`;
export function rigControlsView(editor,{builder=false}={}) {
  if(!builder)return '';
  const seg=editor.figure?.segments[editor.selectedJoint];if(!seg)return '';
  const r=seg._stykRig??{},c=r.connector,d=r.stretch,f=r.follow,response=r.response??{},lock=r.angleLock;
  if(r.weighted){
    const fields=(w,prefix)=>field(prefix+'origin','Origin joint',w.origin,0,65535)+w.anchors.map((a,i)=>
      `<div class="rig-field-pair">${field(`${prefix}joint-${i}`,`Anchor ${i+1}`,a.joint,0,65535)}${field(`${prefix}weight-${i}`,'Weight',a.weight,-100,100,'\u00d7')}</div>`).join('')+field(prefix+'count','Number of anchors',w.anchors.length,1,16);
    const w=r.weighted,body=fields(w,'rig-weighted-')+`<label class="check-row rig-toggle"><span>Include surface depth</span><input id="rig-weighted-depth-enabled" type="checkbox" ${w.depth?'checked':''}></label>`+
      (w.depth?`<details class="rig-advanced"><summary>Depth anchors</summary>${fields(w.depth,'rig-weighted-depth-')}</details>`:'');
    return `<section class="inspector-section rig-properties"><div class="inspector-title">Weighted joint</div>${body}<p class="field-hint">Offsets from the origin are multiplied by their weights and added. Pose the anchors to move this joint.</p></section>`;
  }
  if(r.anglePath){
    const path=r.anglePath;
    const body=path.source!==undefined?field('rig-path-source','Depth source joint',path.source,1,65535):
      field('rig-path-driver','Turn joint',path.driver,1,65535)+field('rig-path-pitch','Nod joint (0 = off)',path.pitch??0,0,65535)+
      `<details class="rig-advanced"><summary>Reference positions</summary>${path.keys.map((key,i)=>`<div class="rig-path-sample"><strong>${Math.round(key[0]*180/Math.PI*100)/100}°</strong>${['X','Y','Depth'].map((name,j)=>field(`rig-path-key-${i}-${j+1}`,name,key[j+1],-1e6,1e6,'px')).join('')}</div>`).join('')}</details>`;
    return `<section class="inspector-section rig-properties"><div class="inspector-title">Angle-driven path</div>${body}</section>`;
  }
  const plan=rigConstraintPlan(editor.figure),source=plan.inputs[editor.selectedJoint];
  const option=(v,label,current)=>`<option value="${v}" ${v===current?'selected':''}>${label}</option>`;
  const select=(id,label,items,current)=>`<label class="rig-select"><span>${label}</span><select id="${id}" class="inline-select" aria-label="${label}">${items.map(([v,l])=>option(v,l,current)).join('')}</select></label>`;
  const check=(id,label,checked,glyph,title='')=>`<label class="check-row rig-toggle" title="${esc(title)}"><span>${icon(glyph)}${label}</span><input id="${id}" type="checkbox" ${checked?'checked':''}></label>`;
  const pick=(action,label)=>`<button class="icon-button" data-action="${action}" title="${label}" aria-label="${label}">${icon('origin')}</button>`;
  const name=id=>esc(id===0?'Origin':editor.figure.segments[plan.ids.get(id)]?.name||`Joint ${id}`);
  let body=c?`<div class="rig-anchors">${['start','end'].map((key,i)=>`<div class="rig-anchor"><span class="rig-anchor-letter">${i?'B':'A'}</span><span class="rig-anchor-name" title="${name(c[key])}">${name(c[key])}</span>${pick(`rig-pick-${key}`,`Pick anchor ${i?'B':'A'} on canvas`)}</div>`).join('')}</div>`:
    `<button class="button rig-connect" data-action="rig-connect">${icon('link')}Connect joints</button><button class="button rig-connect" data-action="rig-weighted">${icon('nodes')}Add weighted joint</button>`;
  body+=check('rig-stretch-enabled','Smart Stretch',d,'expand','Hold Ctrl while dragging to stretch. New attached parts follow automatically.');
  if(d) {
    if(c)body+=select('rig-source','Driven by',[['span','Anchor distance'],['slide','Slide position'],['combined','Distance × slide']],d.source??'span');
    body+=`<details class="rig-advanced"><summary>${icon('sliders')}Stretch settings</summary><div class="rig-settings">
      ${field('rig-rest','Rest length',d.restLength,.0001,1e6,'px')}
      ${c&&d.source&&d.source!=='span'?field('rig-rest-position','Rest slide',d.restPosition*100,.01,100,'%'):''}
      <div class="rig-field-pair">${field('rig-min','Minimum',d.min*100,0,10000,'%')}${field('rig-max','Maximum',d.max*100,1,10000,'%')}</div>
      ${select('rig-width','Width response',[['keep','Keep width'],['inverse','Thicken on compression'],['scale','Scale with length']],d.width)}
      ${!d.branch?check('rig-auto-branch','Include new parts',false,'builder-branch'):''}</div></details>`;
  }
  if(source||f||r.response){
    body+=`<div class="rig-response">${select('rig-response','Stretch response',[['stretch','Stretch'],['rigid','Keep rigid · pass through'],['stop','Stop at this joint']],response.mode??f?.mode??'stretch')}`;
    if((response.mode??f?.mode??'stretch')==='stretch')body+=field('rig-multiplier','Multiplier',response.multiplier??1,-10,10,'×');
    if(response.mode!=='stop')body+=check('rig-reset-impulse','Reset impulse here',response.reset,'reset','Restart the stretch axis at this joint and its children.');
    body+='</div>';
  }
  if(!c){
    body+=select('rig-angle-lock','Angle lock',[['off','Off'],['figure','Figure'],['parent','Movable parent'],['world','World']],lock?.mode??'off');
    if(lock)body+=`<div class="rig-field-pair">${field('rig-lock-angle','Locked angle',Math.round(lock.angle*180/Math.PI*100)/100,-36000,36000,'°')}${lock.mode==='parent'?field('rig-lock-multiplier','Rotation',lock.multiplier,-10,10,'×'):''}</div>`;
    if(lock)body+=select('rig-lock-space','Apply angle lock',[['rendered','After stretch'],['authored','Before stretch']],lock.space??'rendered');
    if(lock?.mode==='parent')body+=`<details class="rig-advanced"><summary>Add a second rotation</summary>${field('rig-lock-secondary','Second joint (0 = off)',lock.secondary?.reference??0,0,65535)}${lock.secondary?field('rig-lock-secondary-multiplier','Second rotation',lock.secondary.multiplier,-10,10,'×')+field('rig-lock-secondary-rest','Second rest angle',lock.secondary.restAngle*180/Math.PI,-36000,36000,'°'):''}</details>`;
    body+=`<details class="rig-advanced"><summary>${icon('link')}Attachment settings</summary><div class="rig-settings"><div class="rig-anchor"><span class="rig-anchor-name">${source?name(editor.figure.segments[source.driver].segment_id):'Automatic'}</span>${pick('rig-pick-driver','Pick stretch driver on canvas')}</div>
      ${select('rig-orientation','Attachment orientation',[['inherit','Follow connector'],['world','Keep authored angle']],r.orientation??'inherit')}
      ${f&&!f.automatic&&response.multiplier===undefined?field('rig-influence','Legacy influence',f.influence,-4,4,'×'):''}
      </div></details>`;
  }
  // Test rig is the band's (beside Done) and the figure's ⋯ menu's, so the section's title carries no second play button.
  return `<section class="inspector-section rig-properties"><div class="inspector-title"><span>${icon('nodes')}Rig</span></div>${body}</section>`;
}
export function connectorPositionView(editor) {
  const seg=editor.figure.segments[editor.selectedJoint],t=editor.object.len_flag?editor.object.lengths[editor.selectedJoint]:seg.length;
  return field('rig-position','Slide position',Math.round(t*10000)/100,0,100,'%');
}
