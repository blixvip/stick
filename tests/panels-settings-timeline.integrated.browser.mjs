import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const b = await chromium.launch({ channel: "chrome", headless: true }),
  p = await b.newPage({ viewport: { width: 1560, height: 1000 } }),
  checks = [],
  errors = [];
p.on("pageerror", (e) => errors.push(e.message));
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};
await mkdir("artifacts", {recursive:true});
try {
  await p.goto("http://127.0.0.1:47831");
  await p.waitForFunction(
    () => window.styk?.ready && window.styk.settingsUI,
  );
  await p.evaluate(async () => {const {createDemo}=await import('/src/demo.mjs');styk.editor.load(createDemo(), 'Panels fixture');});
  check('Actual app mounts Camera, Scene and user layer rows', (await p.locator('.sheet-layer:not([hidden])').count()) === 3);
  await p.locator('.sheet-layer[data-kind="camera"] .sheet-layer-name').click();
  check('Camera row opens camera inspector', await p.evaluate(() => styk.state.inspectorContext === 'camera'));
  await p.getByRole('button', {name:'New layer',exact:true}).click();
  const layerId=await p.evaluate(() => styk.editor.activeLayerId);
  // A new layer opens its name for typing (rename on create).
  await p.locator(`.sheet-layer[data-layer-id="${layerId}"] .sheet-layer-rename`).waitFor();
  check('A new layer opens its name for typing', await p.evaluate(() => document.activeElement?.classList.contains('sheet-layer-rename')));
  await p.locator('.sheet-layer-rename').fill('Characters');
  await p.locator('.sheet-layer-rename').press('Enter');
  await p.evaluate(()=>styk.editor.select(1));
  await p.locator('#figure-layer').selectOption(layerId);
  await p.waitForFunction(id=>styk.editor.layerForUid(1)===id,layerId);
  check('Inspector assignment moves the figure into its persistent layer', await p.evaluate(id=>styk.editor.getLayer(id).name==='Characters'&&styk.editor.layerForUid(1)===id,layerId));
  await p.screenshot({ path: "artifacts/layers-integrated-app.png" });
  await p.evaluate(() => window.styk.settingsUI.open("interface"));
  await p
    .locator(".styk-settings[open] [data-setting=timelineMode][value=simple]")
    .check();
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  await p.waitForFunction(
    () => window.styk.timeline?.root.classList.contains("sheet-filmstrip"),
  );
  await p.waitForFunction(() => window.styk.timeline.stats.cachedPreviews > 4);
  check(
    "Settings switches actual app to Simple filmstrip",
    (await p.locator("#timeline .sheet-filmstrip-card").count()) > 4,
  );
  check(
    "Actual app filmstrip thumbnails contain scene artwork",
    await p
      .locator("#timeline canvas")
      .first()
      .evaluate((canvas) => {
        const d = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4)
          if (d[i + 3] > 100 && d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120)
            return true;
        return false;
      }),
  );
  const before = await p.evaluate(
    () => window.styk.timeline.frameCount,
  );
  await p.locator('.timeline-toolbar .sheet-add-frame').click();
  check(
    "Actual Simple Add inserts one scene key",
    (await p.evaluate(() => window.styk.timeline.frameCount)) ===
      before + 1,
  );
  await p.screenshot({ path: "artifacts/simple-timeline-integrated-app.png" });
  await p.evaluate(() => window.styk.settingsUI.open("canvas"));
  await p
    .locator(".styk-settings[open] [data-setting=showUnselectedHandles]")
    .uncheck();
  await p.locator(".styk-settings[open] [data-setting=handleSize]").fill("8");
  await p
    .locator(".styk-settings[open] [data-setting=handleSize]")
    .dispatchEvent("change");
  check(
    "Canvas settings update actual app state",
    await p.evaluate(
      () =>
        window.styk.state.settings.handleSize === 8 &&
        !window.styk.state.settings.showUnselectedHandles,
    ),
  );
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  await p.evaluate(() => window.styk.settingsUI.flush());
  await p.evaluate(() => window.styk.editor.markSaved());
  await p.reload();
  await p.waitForFunction(() => window.styk?.ready);
  check(
    "Browser reload restores Simple mode and handle preferences",
    await p.evaluate(
      () =>
        window.styk.timeline.root.classList.contains("sheet-filmstrip") &&
        window.styk.state.settings.handleSize === 8 &&
        !window.styk.state.settings.showUnselectedHandles,
    ),
  );
  await p.evaluate(() => window.styk.settingsUI.open());
  await p
    .locator(".styk-settings[open] [data-setting=timelineMode][value=advanced]")
    .check();
  await p.getByRole("button", { name: "Close settings", exact: true }).click();
  check(
    "Switch back restores advanced user-layer timeline",
    await p.evaluate(
      () => window.styk.timeline.constructor.name === "Timeline",
    ),
  );
  check("No browser errors", errors.length === 0);
  await writeFile(
    "artifacts/panels-settings-timeline-integrated.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
} finally {
  await b.close();
}
