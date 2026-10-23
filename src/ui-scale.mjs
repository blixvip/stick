/** Workspace presentation only. Never changes scene zoom or document data. */
export const UI_SCALE = Object.freeze({min: 75, max: 200, step: 5, default: 100});
/** Automatic follows the screen the window is on; Custom keeps the user's own percentage. */
export const UI_SCALE_MODES = Object.freeze(['auto', 'manual']);

export function normalizeUIScale(value) {
  if (!Number.isFinite(value)) return UI_SCALE.default;
  return Math.max(UI_SCALE.min, Math.min(UI_SCALE.max, Math.round(value / UI_SCALE.step) * UI_SCALE.step));
}

/**
 * The scale Automatic picks for a screen, from its size in the system's own points (its scaling already
 * applied): 100% up to about 1080p, 110% from 1920×1050, 125% from 2400×1300 (1440p at 100%), 150% from
 * 3200×1600 (4K at 125%). A big screen gets a bigger interface; a laptop keeps today's size.
 */
export function autoUIScale(screen = globalThis.screen) {
  const width = Number(screen?.width) || 0, height = Number(screen?.height) || 0;
  if (width >= 3200 && height >= 1600) return 150;
  if (width >= 2400 && height >= 1300) return 125;
  if (width >= 1900 && height >= 1050) return 110;
  return 100;
}

/** A stored mode, or for settings saved before modes: Automatic unless the user had chosen a scale. */
export function normalizeUIScaleMode(value, uiScale) {
  if (UI_SCALE_MODES.includes(value)) return value;
  return normalizeUIScale(uiScale) === UI_SCALE.default ? 'auto' : 'manual';
}

/** The percentage the interface shows at: Automatic's for this screen, else the user's own. */
export function effectiveUIScale(settings = {}, screen = globalThis.screen) {
  return normalizeUIScaleMode(settings.uiScaleMode, settings.uiScale) === 'auto' ? autoUIScale(screen) : normalizeUIScale(settings.uiScale);
}

export function applyUIScale(value, desktop = globalThis.window?.stykDesktop) {
  const percent = normalizeUIScale(value);
  desktop?.setUIScale?.(percent);
  return percent;
}
