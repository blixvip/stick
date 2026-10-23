export const THEME_CACHE_KEY = 'stykanimate.theme.v1';

export function normalizeTheme(value) {
  return value === 'dark' || value === 'light' ? value : 'system';
}

let preference = 'system';
let systemTheme;

/** Theme belongs to the workspace chrome, never to the animation document. */
export function applyEditorTheme(value) {
  preference = normalizeTheme(value);
  if (!systemTheme && window.matchMedia) {
    systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    systemTheme.addEventListener('change', () => {
      if (preference === 'system') applyEditorTheme(preference);
    });
  }
  const theme = preference === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : preference;
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0b0f' : '#eceff4');
  // A small, best-effort cache lets the blocking bootstrap restore desktop
  // appearance before the authoritative preferences arrive over IPC.
  try { localStorage.setItem(THEME_CACHE_KEY, preference); } catch { /* Storage can be unavailable. */ }
  if (changed) window.dispatchEvent(new CustomEvent('styk-theme-change', { detail: { theme } }));
  return theme;
}
