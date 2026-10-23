import {chooseExport} from './export-dialog.mjs';

/** Select an editable format through the visible export flow: Project, its type in the list, then Export. */
export async function exportEditable(page, format) {
  await chooseExport(page, `export-${format}`);
  await page.locator('#export-submit').click();
}
