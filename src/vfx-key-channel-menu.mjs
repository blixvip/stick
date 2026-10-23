import {localizedAttribute, appendLocalized, descriptorAttributes, messageAttributes} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';
import {vfxChannelGroups,vfxVisibleKeys,setVfxVisibleChannels} from './vfx-key-channels.mjs';
import {icon} from './icons.mjs';
import {vfxIcon} from './vfx-icons.mjs';

const menus=new WeakMap();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** One light-dismiss picker shared by inspector and timeline; no document edits. */
export function openVfxChannelMenu(editor,clip,anchor,{signal}={}){
 menus.get(editor)?.();
 const menu=document.createElement('div'),events=new AbortController(),on=(node,type,fn)=>node.addEventListener(type,fn,{signal:events.signal});
 menu.className='vfx-channel-menu';menu.popover='auto';menu.setAttribute('role','dialog');localizedAttribute(menu, 'aria-label', 'vfxKeyChannelMenu.visibleEffectKeys', {});
 const groups=vfxChannelGroups(clip),count=groups.reduce((n,g)=>n+g.channels.length,0),rows=[];
 menu.innerHTML=`<div class="vfx-channel-menu-tools"><span>${icon('sliders')}</span><button type="button" data-channel-all data-i18n="vfxKeyChannelMenu.all">All</button><button type="button" data-channel-none data-i18n="vfxKeyChannelMenu.none">None</button><button type="button" data-channel-close aria-label="Close key filter" data-i18n-aria-label="vfxKeyChannelMenu.close">${icon('close')}</button></div>${count>8?`<label class="vfx-channel-search">${icon('search')}<input type="search" aria-label="Find key values" data-i18n-aria-label="vfxKeyChannelMenu.findValues" placeholder="Find values" data-i18n-placeholder="vfxKeyChannelMenu.findValuesPlaceholder"></label>`:''}<div class="vfx-channel-options"></div>`;
 const options=menu.querySelector('.vfx-channel-options');
 for(const group of groups){
  const section=document.createElement('section');section.className='vfx-channel-group';section.innerHTML=`${groups.length>1?`<label class="vfx-channel-group-name"><input type="checkbox" data-channel-group="${esc(group.id)}">${vfxIcon(group.type)}<span${descriptorAttributes(group,"name")}>${esc(group.name)}</span></label>`:''}${group.channels.map(c=>`<label class="vfx-channel-option"><input type="checkbox" data-channel-property="${esc(c.property)}"><span${descriptorAttributes(c, "label")}>${esc(c.label)}</span><button type="button" data-channel-only="${esc(c.property)}" aria-label="Only ${esc(group.name+' '+c.label)}" title="Show only this value" data-i18n-title="vfxKeyChannelMenu.onlyValue" ${messageAttributes("vfxChannels.onlyParameter",{name:{messageKey:group.nameKey,messageParams:group.nameParams},parameter:{messageKey:c.labelKey}},"aria-label")}>${icon('eye')}</button></label>`).join('')}`;
  appendLocalized(options, section);rows.push({section,group});
 }
 const refresh=()=>{
  const selected=new Set(Object.keys(vfxVisibleKeys(editor,clip)));
  for(const input of menu.querySelectorAll('[data-channel-property]'))input.checked=selected.has(input.dataset.channelProperty);
  for(const input of menu.querySelectorAll('[data-channel-group]')){const group=groups.find(g=>g.id===input.dataset.channelGroup),n=group.channels.filter(c=>selected.has(c.property)).length;input.checked=n===group.channels.length;input.indeterminate=n>0&&n<group.channels.length;}
 };
 const position=()=>{const a=anchor.getBoundingClientRect(),r=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(innerWidth-r.width-8,a.right-r.width))}px`;menu.style.top=`${Math.max(8,Math.min(innerHeight-r.height-8,a.bottom+6+r.height>innerHeight?a.top-r.height-6:a.bottom+6))}px`;};
 const close=(focus=false)=>{if(menus.get(editor)!==close)return;menus.delete(editor);events.abort();signal?.removeEventListener('abort',close);menu.remove();anchor.setAttribute('aria-expanded','false');if(focus&&anchor.isConnected)anchor.focus({preventScroll:true});};
 menus.set(editor,close);signal?.addEventListener('abort',close,{once:true});
 const choose=properties=>{setVfxVisibleChannels(editor,clip,properties);refresh();};
 on(menu,'change',event=>{const input=event.target,property=input.dataset.channelProperty,group=groups.find(g=>g.id===input.dataset.channelGroup),keys=property?[property]:group?.channels.map(c=>c.property);if(!keys)return;const selected=new Set(Object.keys(vfxVisibleKeys(editor,clip)));for(const key of keys)input.checked?selected.add(key):selected.delete(key);choose([...selected]);});
 on(menu,'click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-channel-all'))choose(null);if(button.hasAttribute('data-channel-none'))choose([]);if(button.dataset.channelOnly){choose([button.dataset.channelOnly]);close(true);}if(button.hasAttribute('data-channel-close'))close(true);});
 on(menu,'input',event=>{if(event.target.type!=='search')return;const query=event.target.value.toLowerCase();for(const {section,group} of rows){let shown=0;for(const label of section.querySelectorAll('.vfx-channel-option')){label.hidden=!((section.querySelector('.vfx-channel-group-name span')?.textContent||interfaceText(group.nameKey,group.nameParams))+' '+label.textContent).toLowerCase().includes(query);if(!label.hidden)shown++;}section.hidden=!shown;}});
 on(menu,'keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();close(true);}if(["ArrowDown","ArrowUp"].includes(event.key)&&event.target.type!=='search'){event.preventDefault();const inputs=[...menu.querySelectorAll('input[type=checkbox]')].filter(n=>!n.closest('[hidden]')),index=inputs.indexOf(document.activeElement);inputs[(index+(event.key==='ArrowDown'?1:-1)+inputs.length)%inputs.length]?.focus();}});
 on(menu,'toggle',event=>{if(event.newState==='closed')close();});
 on(editor,'change',event=>{if(!['vfx-channels','seek'].includes(event.detail?.kind))close();});
 on(window,'resize',()=>close());document.addEventListener('scroll',event=>{if(!menu.contains(event.target)){if(anchor.isConnected)position();else close();}},{capture:true,signal:events.signal});
 appendLocalized(document.body, menu);refresh();anchor.setAttribute('aria-expanded','true');menu.showPopover();position();menu.querySelector('input')?.focus({preventScroll:true});
 return close;
}
