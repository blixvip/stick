/** Usability regression for the actual Simple timeline and native PIV thumbnail worker. */
import { chromium } from "./support/playwright.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {corpusPath} from './support/corpus.mjs';
const source =
  process.argv[2] || process.env.STYK_AKANE_SOURCE ||
  corpusPath("Downloads/16 Akane vs Akato Segundo round (3).piv");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
const checks = [],
  errors = [],
  layouts = [];
let imported, finalStats;
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
  console.log("PASS", label);
};
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("artifacts", { recursive: true });
try {
  await page.goto(process.env.STYK_URL || "http://127.0.0.1:47831");
  await page.waitForFunction(() => window.styk?.ready && styk.thumbnails);
  await page.evaluate(() => styk.settingsUI.open("interface"));
  await page
    .locator(".styk-settings[open] [data-setting=timelineMode][value=simple]")
    .check();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.waitForFunction(
    () => styk.timeline.root.classList.contains("sheet-filmstrip"),
  );
  check(
    "Settings card switches actual app into Simple mode",
    (await page.locator("#timeline .sheet-filmstrip").count()) === 1,
  );
  await page.evaluate(() => styk.editor.markSaved());
  await page.locator("#file-input").setInputFiles(source);
  await page.waitForFunction(
    (name) => !styk.state.importing && styk.editor.name === name,
    path.basename(source, ".piv"),
    { timeout: 180000 },
  );
  await page.waitForFunction(
    () =>
      styk.timeline.stats.cachedPreviews >= 4 &&
      document.querySelectorAll("#timeline canvas").length >= 4,
    null,
    { timeout: 90000 },
  );
  imported = await page.evaluate(() => ({
    definitions: styk.editor.report.figure_types.length,
    keys: styk.editor.report.keyframes.length,
    renderer: { ...styk.thumbnails.stats },
    filmstrip: { ...styk.timeline.stats },
  }));
  check(
    "Actual filmstrip loads at least 500 definitions and 800 native keys",
    imported.definitions >= 500 && imported.keys >= 800,
  );
  check(
    "Native worker paints real scene thumbnails into the filmstrip",
    await page
      .locator("#timeline canvas")
      .first()
      .evaluate((canvas) => {
        const pixels = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let dark = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          if (
            pixels[i] < 160 &&
            pixels[i + 1] < 160 &&
            pixels[i + 2] < 160 &&
            pixels[i + 3] > 200
          )
            dark++;
          colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
        }
        return dark > 20 && colors.size > 20;
      }),
  );
  await page.locator(".sheet-filmstrip-scroll").press("Home");
  await page.locator('#timeline [data-frame="1"] .sheet-preview').click();
  await page.waitForFunction(() => styk.editor.frameIndex === 1);
  await page.waitForFunction(() => document.querySelector('#timeline [data-frame="1"] .sheet-preview')?.getAttribute('aria-selected') === 'true');
  check(
    "Clicking a thumbnail seeks the corresponding native key",
    (await page
      .locator('#timeline [data-frame="1"] .sheet-preview')
      .getAttribute("aria-selected")) === "true",
  );
  await page.screenshot({
    path: "artifacts/thumbnail-akane-integrated-start.png",
  });
  const snapshotCount = await page.evaluate(
    () => styk.thumbnails.stats.snapshots,
  );

  for (const viewport of [
    { width: 1560, height: 1000 },
    { width: 1100, height: 740 },
  ]) {
    await page.setViewportSize(viewport);
    const splitter = page.getByRole('separator', {name: 'Resize timeline'});
    await splitter.focus();
    await splitter.press("ArrowDown");
    await page.waitForFunction(
      () =>
        Math.abs(
          document.querySelector(".timeline-panel").getBoundingClientRect().height - styk.workspace.sizes.timeline,
        ) < 1,
    );
    const strip = page.locator("#timeline .sheet-filmstrip-scroll");
    await strip.focus();
    await strip.press("End");
    await page.waitForFunction(
      () => styk.editor.frameIndex === styk.editor.report.keyframes.length - 1,
    );
    await page.waitForFunction(
      () => document.querySelector(`#timeline [data-frame="${styk.editor.report.keyframes.length-1}"] canvas`),
      null,
      { timeout: 90000 },
    );
    check(
      `${viewport.width}px keyboard End reaches and selects the final native key`,
      (await page
        .locator(`#timeline [data-frame="${imported.keys-1}"] .sheet-preview`)
        .getAttribute("aria-selected")) === "true",
    );
    await page.screenshot({
      path: `artifacts/thumbnail-akane-integrated-${viewport.width}.png`,
    });
    const layout = await page.evaluate(() => {
      const bounds = (element) => {
        const { x, y, width, height, bottom, right } =
          element.getBoundingClientRect();
        return { x, y, width, height, bottom, right };
      };
      const panel = bounds(document.querySelector(".timeline-panel")),
        body = bounds(document.querySelector("#timeline"));
      const controls = [
        ...document.querySelectorAll(
          "#timeline .sheet-filmstrip-controls button,#timeline .sheet-filmstrip-controls input,#timeline .sheet-filmstrip-counter",
        ),
      ].map((element) => ({
        name: element.getAttribute("aria-label") || element.textContent.trim(),
        ...bounds(element),
      }));
      const current = document.querySelector(`#timeline [data-frame="${styk.editor.report.keyframes.length-1}"]`);
      const card = [
        ...current.querySelectorAll(
          ".sheet-frame-number,.sheet-preview,.sheet-inbetweens",
        ),
      ].map((element) => ({
        className: element.className,
        ...bounds(element),
      }));
      return {
        viewport: { width: innerWidth, height: innerHeight },
        panel,
        body,
        controls,
        card,
        cards: document.querySelectorAll("#timeline .sheet-filmstrip-card").length,
        stats: { ...styk.timeline.stats },
        workspace: styk.workspace.sizes,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    layouts.push(layout);
    check(
      `${viewport.width}px filmstrip stays virtual with bounded cards and cached previews`,
      layout.cards < 15 && layout.stats.cachedPreviews <= 72,
    );
    check(
      `${viewport.width}px timeline matches the constrained workspace height`,
      Math.abs(layout.panel.height - layout.workspace.timeline) < 1,
    );
    check(
      `${viewport.width}px Simple controls stay visible inside the timeline`,
      layout.controls.every(
        (control) =>
          control.y >= layout.body.y - 1 &&
          control.bottom <= layout.body.bottom + 1 &&
          control.height >= 10,
      ),
    );
    check(
      `${viewport.width}px primary frame button preserves a usable hit target`,
      layout.controls.find((control) =>
        /^Add Frame$/i.test(control.name),
      )?.height >= 24,
    );
    check(
      `${viewport.width}px frame number, artwork and green slider are not clipped`,
      layout.card.every(
        (control) =>
          control.y >= layout.body.y - 1 &&
          control.bottom <= layout.body.bottom + 1,
      ),
    );
    check(
      `${viewport.width}px workspace has no page overflow`,
      !layout.horizontalOverflow,
    );
    await strip.focus();
    await strip.press("ArrowLeft");
    await page.waitForFunction(() => styk.editor.frameIndex === styk.editor.report.keyframes.length-2);
    check(
      `${viewport.width}px keyboard Previous seeks exactly one native key`,
      (await page
        .locator("#timeline .sheet-filmstrip-counter")
        .textContent()) === `Frame ${imported.keys-1} / ${imported.keys}`,
    );
  }
  finalStats = await page.evaluate(() => ({
    thumbnails: { ...styk.thumbnails.stats },
    timeline: { ...styk.timeline.stats },
  }));
  check(
    "Native key seeking reuses the imported worker snapshot",
    finalStats.thumbnails.snapshots === snapshotCount,
  );
  check(
    "Actual Simple timeline reports no browser errors",
    errors.length === 0,
  );
} finally {
  await writeFile(
    "artifacts/thumbnail-akane-integrated-verification.json",
    JSON.stringify(
      {
        source,
        checks,
        imported,
        layouts,
        finalStats,
        errors,
        limitation:
          "Functional and visual verification in headless Chrome. This run does not benchmark playback or input latency.",
      },
      null,
      2,
    ),
  );
  await browser.close();
}
