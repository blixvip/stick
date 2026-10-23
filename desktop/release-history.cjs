'use strict';
const { messageError } = require('./localization.cjs');


const ENDPOINT = 'https://stykanimate.com/api/v1/releases';
const LIMIT = 512 * 1024;

// Fixed public endpoint, bounded response and one shared request per process.
function createReleaseHistory({fetcher = fetch, now = Date.now} = {}) {
  let cached, expires = 0, pending;
  return async () => {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetcher(ENDPOINT, {signal: AbortSignal.timeout(8000), redirect: 'error'});
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > LIMIT) throw messageError(new Error(''), 'desktop.releaseHistory.errors.releaseHistoryUnavailable', {});
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let bytes = 0, text = '';
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > LIMIT) throw messageError(new Error(''), 'desktop.releaseHistory.errors.releaseHistoryIsTooLarge', {});
          text += decoder.decode(part.value, {stream: true});
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); }
      const value = JSON.parse(text);
      if (!Array.isArray(value.releases)) throw messageError(new Error(''), 'desktop.releaseHistory.errors.invalidReleaseHistory', {});
      const seen = new Set();
      const releases = value.releases.slice(0, 20).filter(item => {
        if (!item || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(item.version) || item.channel !== 'stable' || typeof item.notes !== 'string' || seen.has(item.version)) return false;
        seen.add(item.version); return true;
      }).map(item => ({version: item.version, markdown: item.notes.slice(0, 16000)}));
      releases.sort((a,b) => { const x=a.version.split('.').map(Number),y=b.version.split('.').map(Number);return y[0]-x[0]||y[1]-x[1]||y[2]-x[2]; });
      if (!releases.length) throw messageError(new Error(''), 'desktop.releaseHistory.errors.noReleaseHistoryAvailable', {});
      cached = releases; expires = now() + 300000;
      return releases;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
module.exports = {createReleaseHistory};
