// Which browser a browser test runs in: STYK_BROWSER=chrome (the default), firefox or webkit. Chrome is the
// installed Google Chrome; Firefox and WebKit are the builds `npx playwright install firefox webkit` downloads.
import { chromium, firefox, webkit } from './playwright.mjs';

export const BROWSER = (process.env.STYK_BROWSER || 'chrome').toLowerCase();

export async function launchBrowser() {
  if (BROWSER === 'chrome') return chromium.launch({ channel: 'chrome', headless: true });
  if (BROWSER === 'firefox') return firefox.launch({ headless: true });
  if (BROWSER === 'webkit') return webkit.launch({ headless: true });
  throw new Error(`Unknown STYK_BROWSER "${BROWSER}". Use chrome, firefox or webkit.`);
}
