import {chromium} from './support/playwright.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage();
  await page.route('**/src/app.mjs',route=>route.fulfill({contentType:'text/javascript',body:''}));
  await page.goto(process.env.STYK_URL||'http://127.0.0.1:47831');
  const checks=await page.evaluate(async()=>{
    const {updateInspectorDOM}=await import('/src/inspector-dom.mjs'),{icon}=await import('/src/icons.mjs');
    const root=document.createElement('div');document.body.append(root);const checks=[];
    const check=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
    const markup=(symbol='eye',value='10')=>`${icon(symbol)}<input id="value" value="${value}"><input id="checked" type="checkbox" checked><details data-section="test"><summary>Section</summary></details><div data-inspector-owned="curve"></div>`;
    updateInspectorDOM(root,markup());
    const svg=root.firstElementChild,input=root.querySelector('#value'),checkbox=root.querySelector('#checked'),details=root.querySelector('details'),owned=root.lastElementChild;
    owned.textContent='live curve';input.value='99';checkbox.checked=false;details.open=true;
    updateInspectorDOM(root,markup(),{preserveDisclosure:true});
    check('Identical icon keeps node identity',root.firstElementChild===svg);
    check('Unfocused dirty controls reset even when markup is unchanged',input.value==='10'&&checkbox.checked);
    check('Disclosure and imperative content remain live',details.open&&owned.textContent==='live curve');
    input.focus();input.value='88';updateInspectorDOM(root,markup('eye','20'));
    check('Focused edit survives reconciliation',input.value==='88'&&document.activeElement===input);
    input.blur();updateInspectorDOM(root,markup('eye','20'));
    check('Blurred control receives the current value',input.value==='20');
    const old=svg.outerHTML;updateInspectorDOM(root,markup('eye-off','20'));
    const expected=document.createElement('template');expected.innerHTML=icon('eye-off');
    check('Changed SVG artwork is reconciled',svg.outerHTML!==old&&svg.isEqualNode(expected.content.firstChild));
    const foreign='<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><input xmlns="http://www.w3.org/1999/xhtml" value="correct"></foreignObject></svg>';
    updateInspectorDOM(root,foreign);root.querySelector('input').value='dirty';updateInspectorDOM(root,foreign);
    check('SVG foreign HTML keeps dirty form reconciliation',root.querySelector('input').value==='correct');
    return checks;
  });
  assert.equal(checks.length,7);console.log(checks.map(name=>'PASS '+name).join('\n'));
}finally{await browser.close();}
