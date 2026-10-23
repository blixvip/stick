/** Simulate an acknowledged project writer for authoring/round-trip tests.
 * The native picker cannot be driven headlessly. Its committed bytes are exposed
 * as a download so the existing fixture readers can inspect them. This is a
 * controlled writer acknowledgement; browser download reliability is exercised
 * separately in browser-save-recovery.browser.mjs. Other export formats keep
 * their ordinary download path.
 */
export async function installProjectSavePicker(page) {
  await page.addInitScript(() => {
    const picker = async ({suggestedName}) => {
      return {name:suggestedName, createWritable:async()=>{
        let parts=[];
        return {
          async write(part) { parts.push(part); },
          async close() {
            const url=URL.createObjectURL(new Blob(parts,{type:'application/octet-stream'})),anchor=document.createElement('a');
            anchor.href=url;anchor.download=suggestedName;anchor.click();parts=[];
            setTimeout(()=>URL.revokeObjectURL(url),1000);
          },
          async abort() { parts=[]; },
        };
      }};
    };
    // Only Save gets the controlled writer. All other UI actions retain the
    // picker-free browser download path used by these headless fixtures.
    delete window.showSaveFilePicker;
    document.addEventListener('click', event => {
      const action=event.target.closest?.('[data-action]')?.dataset.action;
      if (action==='save'||action==='save-as'||event.target.closest?.('#save-changes')) window.showSaveFilePicker=picker;
      else delete window.showSaveFilePicker;
    }, {capture:true});
  });
}
