/**
 * The export dialog (src/export-sheet.mjs) for browser and desktop tests:
 * choose a type the way a person does (its Format, then its Type: the select,
 * or a Project's list) and wait for the dialog to close after an export.
 */
import {EXPORT_FORMATS} from '../../src/export-request.mjs';

/**
 * Chooses the type of an export command ('export-mp4', 'export-video', 'export-piv', …) in the open export
 * dialog, once it is available (the capability check enables the video types).
 */
export async function chooseExport(page, action, {timeout = 30000} = {}) {
  const format = EXPORT_FORMATS.find(entry => entry.action === action);
  if (!format) throw new Error(`Unknown export command: ${action}`);
  await page.locator(`#export-dialog [data-category="${format.category}"]`).click();
  if (format.category !== 'editable') {
    await page.waitForFunction(action => {
      const option = document.querySelector(`#output-format option[value="${action}"]`);
      return option && !option.disabled;
    }, action, {timeout});
    return page.locator('#output-format').selectOption(action);
  }
  const type = page.locator(`#export-project-type [data-format="${format.id}"]`);
  await type.click();
  if (await type.getAttribute('aria-checked') !== 'true') throw new Error(`${action} is unavailable: ${await type.getAttribute('data-tooltip')}`);
}

/** Opens Encoding (a titled section that remembers being open) unless it is open already. */
export async function openEncoding(page) {
  const toggle = page.locator('#export-encoding-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

/** Resolves once the export dialog has closed (the export finished, was cancelled or the dialog was dismissed). */
export const exportDialogClosed = (page, timeout = 30000) => page.waitForFunction(() => !document.querySelector('#export-dialog'), undefined, {timeout});
