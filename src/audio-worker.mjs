import {errorMessageData, messageError} from './localized-error.mjs';

import {inspectWave, wavePeaks, mixAudio, pcmWave} from './audio-pcm.mjs';
import {AUDIO_CHUNK_BYTES} from './audio-model.mjs';
const sources = new Map(), embedded = new Map();
let clips = [];
let activeImport, cancelledImport;
const encode = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
async function run(data) {
  if (data.operation === 'clear') { sources.clear(); embedded.clear(); clips = []; return true; }
  if (data.operation === 'release') { for (const key of sources.keys()) if (!data.ids.includes(key)) sources.delete(key); return true; }
  if (data.operation === 'source') {
    activeImport=data.key;
    try { const source = await inspectWave(data.blob), peaks=data.peaks?await wavePeaks(source,()=>cancelledImport===data.key):undefined; sources.set(data.key, source); return {duration:source.duration,peaks}; }
    finally {activeImport=null;cancelledImport=null;}
  }
  if (data.operation === 'inspect') { const source = await inspectWave(data.blob); return {duration: source.duration}; }
  if (data.operation === 'wave') return pcmWave(data.channels, data.rate);
  if (data.operation === 'encode') return {data_base64: encode(new Uint8Array(await data.blob.slice(data.offset, data.offset + AUDIO_CHUNK_BYTES).arrayBuffer()))};
  if (data.operation === 'embedded-start') { embedded.set(data.key, []); return true; }
  if (data.operation === 'embedded-clear') { embedded.clear(); return true; }
  if (data.operation === 'embedded-chunk') { embedded.get(data.key).push(new Blob([decode(data.chunk.data_base64)])); return true; }
  if (data.operation === 'embedded-end') { const blob = new Blob(embedded.get(data.key)); embedded.delete(data.key); return blob; }
  if (data.operation === 'clips') { clips = data.clips; return true; }
  if (data.operation === 'mix') return mixAudio(clips, sources, data.start, data.frames);
  throw messageError(new Error(''), "errors.audioWorker.unknownAudioWorkerOperation", {});
}
// Requests are ordered. A source release cannot race an in-flight mix.
let queue = Promise.resolve();
self.addEventListener('message', ({data}) => {
  if(data.operation==='cancel-import'){if(activeImport===data.key)cancelledImport=data.key;return;}
  queue = queue.then(async () => {
    try { const result = await run(data); self.postMessage({id: data.id, result}, result instanceof Float32Array ? [result.buffer] : []); }
    catch (error) { self.postMessage({id: data.id, error: error.message, ...errorMessageData(error)}); }
  });
});
