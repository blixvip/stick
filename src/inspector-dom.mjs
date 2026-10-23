import {localizedMarkup, appendLocalized, connectTranslations} from './localization-bindings.mjs';
/** Keep inspector controls alive across frame and selection updates. Events are
 * delegated by the app; retained nodes also preserve focus and disclosure state. */
export function updateInspectorDOM(root, html, {preserveDisclosure = false} = {}) {
  const template = root.ownerDocument.createElement('template'); localizedMarkup(template, html);
  const identity = node => node.nodeType === 1
    ? ['id','data-property','data-setting','data-section','data-polygon-index','data-inspector-owned'].map(name => node.getAttribute(name) ?? '').join('\0') : '';
  const reconcile = (parent, next) => {
    let current = parent.firstChild;
    for (const desired of [...next.childNodes]) {
      if (!current) { appendLocalized(parent, desired); continue; }
      const following = current.nextSibling;
      if (current.nodeType !== desired.nodeType || current.nodeName !== desired.nodeName || identity(current) !== identity(desired)) {
        current.replaceWith(desired);
      } else if (current.nodeType !== 1) {
        if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
      } else {
        // Imperative widgets reconcile their own content (for example, a live
        // curve). Retain that subtree across ordinary inspector refreshes.
        if(current.hasAttribute('data-inspector-owned')){current=following;continue;}
        // Icons have no dirty form state. Compare unchanged SVG trees natively
        // instead of walking every path/attribute in JavaScript on each edit.
        // Foreign HTML can contain live controls, so it keeps normal reconciliation.
        if(current.localName==='svg'&&!current.querySelector('foreignObject')&&current.isEqualNode(desired)){current=following;continue;}
        const keepOpen = preserveDisclosure && current.nodeName === 'DETAILS';
        const value = desired.value, checked = desired.checked;
        for (const attribute of [...current.attributes]) {
          if (keepOpen && attribute.name === 'open') continue;
          if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        }
        for (const attribute of desired.attributes) {
          if (keepOpen && attribute.name === 'open') continue;
          if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        }
        reconcile(current, desired);
        // Attributes alone do not reset dirty form values after a committed edit.
        if (['INPUT','TEXTAREA','SELECT'].includes(current.nodeName) && root.ownerDocument.activeElement !== current) {
          if (current.value !== value) current.value = value;
          if (current.nodeName === 'INPUT') current.checked = checked;
        }
      }
      current = following;
    }
    while (current) { const following = current.nextSibling; current.remove(); current = following; }
  };
  reconcile(root, template.content);
  connectTranslations(root);
}
