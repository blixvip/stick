import {replaceLocalized, localizedMarkup, messageHTML, appendLocalized, localizedAttribute, localizedText, clearTranslation, messageAttributes} from './localization-bindings.mjs';
import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';

import { icon } from "./icons.mjs";
import { createObject, createFrame } from "./demo.mjs";
import { buildGeometry, drawGeometry } from "./pivot/geometry.mjs";
import { objectBounds } from "./renderer-geometry.mjs";
import {movieclipAssetFigures} from './movieclips.mjs';
import {drawingMetadata} from './drawing-model.mjs';

const ROW_HEIGHT = 74;
const THUMB_SIZE = 54;
const MAX_SEGMENTS = 256;
const MAX_POLYGONS = 128;
const MAX_IMAGE_PIXELS = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_PATH_CHARS = 160000;
const nameMessage=figure=>figure.name||{messageKey:'assetLibrary.figureNumber',messageParams:{id:String(figure.figure_type_id)}};
const nameOf=figure=>String(figure.name||interfaceText('assetLibrary.figureNumber',{id:String(figure.figure_type_id)}));
// Canonical preview kinds never depend on the interface language.
const kindOf=figure=>figure._styk?.movieclip?'Movieclip':figure.text_assets?.length?'Text':figure.image_assets?.length?'Image':'Figure';
const kindMessage=kind=>({messageKey:{Movieclip:'assetLibrary.movieclip',Text:'inspectorView.text',Image:'assetLibrary.image',Figure:'assetLibrary.figure'}[kind]});
const defaultUrl = (asset) =>
  asset?.asset_url ||
  asset?.data_url ||
  asset?.url ||
  (asset?.base64
    ? `data:${asset.mime_type || "image/png"};base64,${asset.base64}`
    : null) ||
  asset?.asset_path_relative ||
  asset?.asset_path ||
  asset?.path;
const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const abortError = () => messageError(new DOMException('', "AbortError"), "errors.assetLibrary.previewCancelled", {});

/** A bounded, idle-rendered figure library. Ordinary pose/selection updates are O(visible rows). */
export class AssetLibrary {
  constructor(
    container,
    { onAdd, onError = () => {}, resources = {}, maxPreviews = 64 } = {},
  ) {
    if (!container) throw messageError(new TypeError(''), "errors.assetLibrary.assetlibraryRequiresAContainer", {});
    this.container = container;
    this.onAdd = onAdd;
    this.onError = onError;
    this.resources = resources;
    this.maxPreviews = Math.max(8, Math.min(128, maxPreviews));
    this.figures = null;
    this.records = [];
    this.filtered = [];
    this.byId = new Map();
    this.rows = new Map();
    this.previews = new Map();
    this.queue = [];
    this.generation = 0;
    this.indexDirty = false;
    this.selectedId = null;
    this.activeIndex = -1;
    this.query = "";
    this.visible = true;
    this.disposed = false;
    this.idle = null;
    this.busy = false;
    this.imageCancels = new Set();
    this.stats = {
      indexBuilds: 0,
      indexMs: 0,
      renders: 0,
      rows: 0,
      previewRenders: 0,
      previewFallbacks: 0,
      cacheHits: 0,
      cachedPreviews: 0,
      thumbnailBytes: 0,
      queuedPreviews: 0,
      maxPreviewMs: 0,
    };
    container.classList.add("styk-asset-library");
    localizedMarkup(container, `<div class="styk-assets-search">${icon("search")}<input type="search" placeholder="Search figures" aria-label="Search figures" spellcheck="false" data-i18n-placeholder="assetLibrary.searchFigures" data-i18n-aria-label="assetLibrary.searchFigures"><button type="button" class="icon-button" aria-label="Clear figure search" hidden data-i18n-aria-label="assetLibrary.clearFigureSearch">${icon("x")}</button></div><div class="styk-assets-viewport" role="listbox" aria-label="Figure library" tabindex="0" data-i18n-aria-label="assetLibrary.figureLibrary"><div class="styk-assets-spacer"></div><div class="styk-assets-empty" hidden>${messageHTML("assetLibrary.noFiguresFound", {})}</div></div><div class="styk-assets-count" aria-live="polite"></div>`);
    this.input = container.querySelector("input");
    this.clearButton = container.querySelector(".styk-assets-search button");
    this.viewport = container.querySelector(".styk-assets-viewport");
    this.spacer = container.querySelector(".styk-assets-spacer");
    this.empty = container.querySelector(".styk-assets-empty");
    this.count = container.querySelector(".styk-assets-count");
    this.events = new AbortController();
    const options = { signal: this.events.signal };
    this.input.addEventListener(
      "input",
      () => this.search(this.input.value),
      options,
    );
    this.clearButton.addEventListener(
      "click",
      (event) => {
        event.stopPropagation();
        this.search("");
        this.input.focus();
      },
      options,
    );
    this.input.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "ArrowDown" && this.filtered.length) {
          event.preventDefault();
          event.stopPropagation();
          this.focusIndex(0);
        } else if (event.key === "Escape" && this.query) {
          event.preventDefault();
          event.stopPropagation();
          this.search("");
        }
      },
      options,
    );
    this.viewport.addEventListener("scroll", () => this.render(), {
      ...options,
      passive: true,
    });
    this.viewport.addEventListener(
      "keydown",
      (event) => this.onKey(event),
      options,
    );
    this.viewport.addEventListener(
      "click",
      (event) => {
        const row = event.target.closest("[data-figure]");
        if (!row || !this.viewport.contains(row)) return;
        event.stopPropagation();
        this.add(row.dataset.figure);
      },
      options,
    );
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.viewport);
  }

  update(figures, { selectedId = null, changedFigureIds } = {}) {
    if (this.disposed) return;
    if (changedFigureIds) this.invalidate(changedFigureIds);
    this.selectedId = selectedId == null ? null : String(selectedId);
    if (
      figures !== this.figures ||
      figures.length !== this.records.length ||
      this.indexDirty
    ) {
      const start = performance.now();
      if (figures !== this.figures) {
        this.generation++;
        this.cancelImages();
        this.previews.clear();
        this.activeIndex = -1;
      }
      this.figures = figures;
      this.records = figures.map((figure) => ({
        figure,
        id: String(figure.figure_type_id),
        name: nameOf(figure),
        kind: kindOf(figure),
        segmentCount: figure.segment_count ?? figure.segments?.length ?? 0,
        search:
          `${nameOf(figure)} ${figure.figure_type_id} ${kindOf(figure)}`.toLocaleLowerCase(),
      }));
      this.byId = new Map(this.records.map((record) => [record.id, record]));
      for (const [id, preview] of this.previews) {
        if (this.byId.get(id)?.figure !== preview.figure)
          this.previews.delete(id);
      }
      this.indexDirty = false;
      this.stats.indexBuilds++;
      this.stats.indexMs = performance.now() - start;
      this.filter();
    } else {
      this.render();
    }
  }

  /** Call for definition edits/renames, not ordinary frame posing. */
  invalidate(ids = null) {
    if (this.disposed) return;
    this.generation++;
    this.cancelImages();
    if (ids == null) this.previews.clear();
    else for (const id of ids) this.previews.delete(String(id));
    this.indexDirty = true;
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (!this.visible) {
      this.queue.length = 0;
      this.cancelIdle();
      this.cancelImages();
    } else this.render();
  }

  search(value) {
    this.query = String(value).trim().toLocaleLowerCase();
    this.input.value = value;
    this.clearButton.hidden = !value;
    this.activeIndex = -1;
    this.viewport.scrollTop = 0;
    this.filter();
  }

  filter() {
    // Keep translated kind searches while preview classification stays canonical.
    const kinds = this.query && new Map(['Movieclip', 'Text', 'Image', 'Figure'].map(kind => [kind, interfaceText(kindMessage(kind).messageKey).toLocaleLowerCase()]));
    this.filtered = this.query
      ? this.records.filter((record) => record.search.includes(this.query) || kinds.get(record.kind).includes(this.query))
      : this.records;
    this.spacer.style.height = `${this.filtered.length * ROW_HEIGHT}px`;
    this.empty.hidden = this.filtered.length > 0;
    localizedText(this.count, this.query ? 'counts.of' : 'counts.figures', {count: this.query ? this.filtered.length : this.records.length, total: this.records.length});
    this.render();
  }

  render() {
    if (this.disposed || !this.visible || !this.viewport.clientHeight) return;
    const first = Math.max(
      0,
      Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - 1,
    );
    const last = Math.min(
      this.filtered.length,
      Math.ceil(
        (this.viewport.scrollTop + this.viewport.clientHeight) / ROW_HEIGHT,
      ) + 1,
    );
    const keep = new Set();
    this.queue = [];
    for (let index = first; index < last; index++) {
      const record = this.filtered[index];
      keep.add(record.id);
      let row = this.rows.get(record.id);
      if (!row) {
        row = document.createElement("button");
        row.type = "button";
        row.className = "styk-asset-row";
        row.dataset.figure = record.id;
        row.setAttribute("role", "option");
        localizedMarkup(row, `<span class="styk-asset-preview" aria-hidden="true"></span><span class="styk-asset-info"><span class="styk-asset-name"></span><span class="styk-asset-detail"></span></span><span class="styk-asset-add" aria-hidden="true">${icon("plus")}</span>`);
        appendLocalized(this.spacer, row);
        this.rows.set(record.id, row);
      }
      row.style.top = `${index * ROW_HEIGHT}px`;
      row.dataset.index = String(index);
      row.setAttribute("aria-posinset", String(index + 1));
      row.setAttribute("aria-setsize", String(this.filtered.length));
      localizedAttribute(row, "aria-label", "assetLibrary.add", {name:nameMessage(record.figure),value:kindMessage(record.kind),id:record.id});
      row.setAttribute("aria-selected", String(record.id === this.selectedId));
      row.tabIndex = index === this.activeIndex ? 0 : -1;
      localizedAttribute(row, "title", "assetLibrary.add2", {name:nameMessage(record.figure),id:record.id});
      const name=row.querySelector(".styk-asset-name");if(record.figure.name){clearTranslation(name);name.textContent=record.name;}else localizedText(name,"assetLibrary.figureNumber",{id:record.id});
      localizedText(row.querySelector('.styk-asset-detail'), 'counts.segments', {count: record.segmentCount});
      const target = row.querySelector(".styk-asset-preview");
      const cached = this.previews.get(record.id);
      if (cached && cached.figure === record.figure) {
        this.touchPreview(record.id, cached);
        if (target.firstChild !== cached.element)
          replaceLocalized(target, cached.element);
      } else {
        if (
          target.dataset.placeholder !== record.kind ||
          target.querySelector("canvas")
        ) {
          localizedMarkup(target, icon(
            record.kind === "Text"
              ? "text"
              : record.kind === "Image"
                ? "image"
                : "person",
          ));
          target.dataset.placeholder = record.kind;
        }
        this.queue.push(record);
      }
    }
    for (const [id, row] of this.rows)
      if (!keep.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    this.stats.rows = this.rows.size;
    this.stats.renders++;
    this.updateStats();
    this.schedule();
  }

  focusIndex(index) {
    if (!this.filtered.length) return;
    this.activeIndex = Math.max(0, Math.min(this.filtered.length - 1, index));
    const top = this.activeIndex * ROW_HEIGHT;
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
    else if (
      top + ROW_HEIGHT >
      this.viewport.scrollTop + this.viewport.clientHeight
    )
      this.viewport.scrollTop = top + ROW_HEIGHT - this.viewport.clientHeight;
    this.render();
    this.rows
      .get(this.filtered[this.activeIndex].id)
      ?.focus({ preventScroll: true });
  }

  onKey(event) {
    const current = Number(
      event.target.closest("[data-index]")?.dataset.index ?? this.activeIndex,
    );
    const page = Math.max(
      1,
      Math.floor(this.viewport.clientHeight / ROW_HEIGHT),
    );
    const next = {
      ArrowDown: current + 1,
      ArrowUp: Math.max(0, current - 1),
      Home: 0,
      End: this.filtered.length - 1,
      PageDown: current + page,
      PageUp: current - page,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      this.focusIndex(next);
    } else if ((event.key === "Enter" || event.key === " ") && current >= 0) {
      event.preventDefault();
      event.stopPropagation();
      this.add(this.filtered[current]?.id);
    }
  }

  add(id) {
    const record = this.byId.get(String(id));
    if (!record) return;
    try {
      Promise.resolve(
        this.onAdd?.(record.figure.figure_type_id, record.name, record.figure),
      ).catch(this.onError);
    } catch (error) {
      this.onError(error);
    }
  }

  touchPreview(id, cached) {
    this.previews.delete(id);
    this.previews.set(id, cached);
    this.stats.cacheHits++;
  }

  updateStats() {
    this.stats.cachedPreviews = this.previews.size;
    this.stats.thumbnailBytes = [...this.previews.values()].reduce(
      (sum, preview) => sum + preview.bytes,
      0,
    );
    this.stats.queuedPreviews = this.queue.length;
  }

  cancelIdle() {
    if (this.idle == null) return;
    if (globalThis.cancelIdleCallback) cancelIdleCallback(this.idle);
    else clearTimeout(this.idle);
    this.idle = null;
  }

  cancelImages() {
    for (const cancel of this.imageCancels) cancel();
    this.imageCancels.clear();
  }

  schedule() {
    if (
      this.idle != null ||
      this.busy ||
      !this.queue.length ||
      !this.visible ||
      this.disposed
    )
      return;
    const run = () => {
      this.idle = null;
      this.renderNext();
    };
    // No timeout: animation/input gets priority over decorative thumbnails.
    this.idle = globalThis.requestIdleCallback
      ? requestIdleCallback(run)
      : setTimeout(run, 32);
  }

  async renderNext() {
    if (
      this.busy ||
      this.disposed ||
      !this.visible ||
      !this.viewport.clientHeight
    )
      return;
    const record = this.queue.shift();
    if (!record) return;
    if (this.previews.has(record.id)) {
      this.schedule();
      return;
    }
    this.busy = true;
    const generation = this.generation,
      start = performance.now();
    try {
      const preview = await this.makePreview(record.figure, generation);
      if (this.disposed || !this.visible || generation !== this.generation)
        return;
      this.previews.set(record.id, { figure: record.figure, ...preview });
      while (this.previews.size > this.maxPreviews)
        this.previews.delete(this.previews.keys().next().value);
      const target = this.rows
        .get(record.id)
        ?.querySelector(".styk-asset-preview");
      if (target) replaceLocalized(target, preview.element);
      this.stats.previewRenders++;
      if (preview.fallback) this.stats.previewFallbacks++;
    } catch (error) {
      if (
        error.name !== "AbortError" &&
        generation === this.generation &&
        !this.disposed
      ) {
        const element = this.fallback(record.figure, interfaceText("assetLibrary.previewUnavailable"));
        this.previews.set(record.id, {
          figure: record.figure,
          element,
          bytes: 0,
          fallback: true,
        });
        while (this.previews.size > this.maxPreviews)
          this.previews.delete(this.previews.keys().next().value);
        this.rows
          .get(record.id)
          ?.querySelector(".styk-asset-preview")
          ?.replaceChildren(element);
        this.stats.previewFallbacks++;
      }
    } finally {
      this.stats.maxPreviewMs = Math.max(
        this.stats.maxPreviewMs,
        performance.now() - start,
      );
      this.busy = false;
      this.updateStats();
      this.schedule();
    }
  }

  fallback(figure, reason) {
    const span = document.createElement("span");
    const kind = kindOf(figure);
    span.className = "styk-asset-fallback";
    span.title = reason;
    localizedMarkup(span, `${icon(kind === "Text" ? "text" : kind === "Image" ? "image" : "nodes")}<small ${messageAttributes(kindMessage(kind).messageKey)}>${escapeHTML(interfaceText(kindMessage(kind).messageKey))}</small>`);
    return span;
  }

  async makePreview(figure, generation) {
    const segments = figure.segments || [],
      polys = figure.polyfills || [];
    let complexity =
      segments.length > MAX_SEGMENTS ||
      polys.length > MAX_POLYGONS ||
      (figure.text_assets?.length || 0) > 32;
    let paths = 0,
      vertices = 0;
    if (!complexity) {
      for (const polygon of polys) {
        vertices += polygon.segment_ids?.length || 0;
        if (vertices > 4096) {
          complexity = true;
          break;
        }
      }
      outer: for (const asset of figure.text_assets || []) {
        if ((asset.placements?.length || 0) > 512) {
          complexity = true;
          break;
        }
        for (const glyph of asset.glyphs || []) {
          paths += glyph.svg_path?.length || 0;
          if (paths > MAX_PATH_CHARS) {
            complexity = true;
            break outer;
          }
        }
      }
    }
    const nested=movieclipAssetFigures(figure);
    if(nested.reduce((n,f)=>n+(f.segments?.length??0),0)>MAX_SEGMENTS)complexity=true;
    const imageAssets = nested.flatMap(f=>f.image_assets??[]);
    if (
      imageAssets.length > 8 ||
      imageAssets.some(
        (asset) =>
          (asset.width || asset.pixel_width || 0) *
            (asset.height || asset.pixel_height || 0) >
          MAX_IMAGE_PIXELS,
      )
    )
      complexity = true;
    if (complexity)
      return {
        element: this.fallback(
          figure,
          interfaceText("assetLibrary.complexFigureAddToCanvasToView"),
        ),
        bytes: 0,
        fallback: true,
      };
    const loaded = new Map();
    let pixels = 0;
    // v2 drawing cels carry a 1×1 carrier; their pixels come from the tile
    // store, so load those stores instead of decoding the placeholder.
    const drawingFigures = nested.filter(f => drawingMetadata(f)?.version === 2);
    if (drawingFigures.length && this.resources.drawingLoad)
      await Promise.all(drawingFigures.map(f => this.resources.drawingLoad(f)));
    for (const asset of imageAssets) {
      if (asset.styk_tiles !== undefined || drawingFigures.some(f => f.image_assets?.includes(asset))) continue;
      const url = this.resources.url?.(asset) || defaultUrl(asset);
      if (!url || loaded.has(url)) continue;
      const image = await this.loadImage(url, generation);
      pixels += image.naturalWidth * image.naturalHeight;
      if (pixels > MAX_TOTAL_IMAGE_PIXELS)
        return {
          element: this.fallback(
            figure,
            interfaceText("assetLibrary.largeImageFigureAddToCanvasToView"),
          ),
          bytes: 0,
          fallback: true,
        };
      loaded.set(url, image);
    }
    if (generation !== this.generation || !this.visible || this.disposed)
      throw abortError();
    const resources = {
      url: (asset) => this.resources.url?.(asset) || defaultUrl(asset),
      image: (url) => loaded.get(url),
      drawing: (fig) => this.resources.drawing?.(fig),
    };
    const object = createObject(figure, 1, 0, 0);
    const geometry = buildGeometry(
      { figure_types: [figure] },
      createFrame([object]),
    );
    if (!geometry.drawables.length)
      return {
        element: this.fallback(figure, interfaceText("assetLibrary.emptyFigure")),
        bytes: 0,
        fallback: true,
      };
    const bounds = objectBounds(geometry.drawables, resources);
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1),
      size = Math.ceil(THUMB_SIZE * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    const zoom = (size - 8 * ratio) / Math.max(bounds.width, bounds.height);
    context.translate(size / 2, size / 2);
    context.scale(zoom, zoom);
    context.translate(
      -bounds.x - bounds.width / 2,
      -bounds.y - bounds.height / 2,
    );
    drawGeometry(context, geometry, resources);
    return { element: canvas, bytes: size * size * 4, fallback: false };
  }

  loadImage(source, generation) {
    const url = new URL(source, document.baseURI);
    if (
      !["data:", "blob:"].includes(url.protocol) &&
      url.origin !== location.origin
    )
      return Promise.reject(messageError(new Error(''), "errors.assetLibrary.previewMediaMustBeLocal", {}));
    return new Promise((resolve, reject) => {
      const image = new Image();
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.imageCancels.delete(cancel);
        image.onload = image.onerror = null;
        if (error) {
          image.src = "";
          reject(error);
        } else resolve(image);
      };
      const cancel = () => finish(abortError());
      const timer = setTimeout(
        () => finish(messageError(new Error(''), "errors.assetLibrary.previewImageTimedOut", {})),
        5000,
      );
      this.imageCancels.add(cancel);
      image.onload = () =>
        finish(
          generation !== this.generation || !this.visible
            ? abortError()
            : image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS
              ? messageError(new Error(''), "errors.assetLibrary.previewImageIsTooLarge", {})
              : null,
        );
      image.onerror = () => finish(messageError(new Error(''), "errors.assetLibrary.previewImageUnavailable", {}));
      image.src = url.href;
    });
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.events.abort();
    this.cancelIdle();
    this.cancelImages();
    this.resizeObserver.disconnect();
    this.queue.length = 0;
    this.previews.clear();
    this.rows.clear();
    this.records = [];
    this.filtered = [];
    this.stats.rows = 0;
    replaceLocalized(this.container);
    this.container.classList.remove("styk-asset-library");
    this.updateStats();
  }
}

export const mountAssetLibrary = (container, options) =>
  new AssetLibrary(container, options);
