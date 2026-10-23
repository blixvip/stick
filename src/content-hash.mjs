/** 128-bit non-cryptographic content hash for reusable worker artwork.
 *
 * It uses the MurmurHash3 x86_128 block mix, which diffuses every input word
 * across all four 32-bit lanes, and feeds it framed parts (a length word before
 * each string or array) so different part boundaries cannot produce the same
 * word stream. Artwork identities are addressed by content; a worker still
 * compares the complete signature before it reuses local artwork, and the hash
 * only has to keep distinct documents apart across workers. Random collisions
 * are on the order of 2^-128 per pair. It is not a defence against inputs built
 * to collide; those cannot arise from a locally authored animation.
 *
 * SHA-256 through WebCrypto cost about 20 ms per megabyte on the worker thread
 * (the call copies and hashes its input before returning) plus an event-loop
 * hop, which made it the largest single item in dense-scene playback profiles.
 * This hash runs at memory speed in plain JavaScript, needs no secure context
 * and returns synchronously. */
const C1 = 0x239b961b | 0, C2 = 0xab0e9789 | 0, C3 = 0x38b34ae5 | 0, C4 = 0xa1e38b93 | 0;
const rotl = (x, r) => (x << r) | (x >>> (32 - r));
const fmix = h => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
};

export class ContentHasher {
  constructor(seed = 0) {
    this.h1 = this.h2 = this.h3 = this.h4 = seed | 0;
    // Words waiting for a full 16-byte block.
    this.k1 = this.k2 = this.k3 = this.k4 = 0; this.pending = 0; this.length = 0;
  }
  _block(k1, k2, k3, k4) {
    let {h1, h2, h3, h4} = this;
    k1 = Math.imul(k1, C1); k1 = rotl(k1, 15); k1 = Math.imul(k1, C2); h1 ^= k1;
    h1 = rotl(h1, 19); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(k2, C2); k2 = rotl(k2, 16); k2 = Math.imul(k2, C3); h2 ^= k2;
    h2 = rotl(h2, 17); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(k3, C3); k3 = rotl(k3, 17); k3 = Math.imul(k3, C4); h3 ^= k3;
    h3 = rotl(h3, 15); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(k4, C4); k4 = rotl(k4, 18); k4 = Math.imul(k4, C1); h4 ^= k4;
    h4 = rotl(h4, 13); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
    this.h1 = h1; this.h2 = h2; this.h3 = h3; this.h4 = h4;
  }
  /** One 32-bit word. */
  word(w) {
    switch (this.pending) {
      case 0: this.k1 = w; this.pending = 1; break;
      case 1: this.k2 = w; this.pending = 2; break;
      case 2: this.k3 = w; this.pending = 3; break;
      default: this._block(this.k1, this.k2, this.k3, w); this.pending = 0;
    }
    this.length++;
    return this;
  }
  /** Every element of an Int32Array or Uint32Array, framed by its length. */
  words(view) {
    const n = view.length;
    this.word(n);
    let i = 0;
    // Finish a partial block, then mix whole blocks straight from the array.
    while (this.pending && i < n) this.word(view[i++]);
    const start = i, end = i + ((n - i) & ~3);
    // The same block mix as _block(), with the state held in locals: dense
    // artwork signatures hash thousands of blocks per playback frame.
    let h1 = this.h1, h2 = this.h2, h3 = this.h3, h4 = this.h4;
    for (; i < end; i += 4) {
      let k1 = view[i], k2 = view[i + 1], k3 = view[i + 2], k4 = view[i + 3];
      k1 = Math.imul(k1, C1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, C2); h1 ^= k1;
      h1 = (h1 << 19) | (h1 >>> 13); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
      k2 = Math.imul(k2, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C3); h2 ^= k2;
      h2 = (h2 << 17) | (h2 >>> 15); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
      k3 = Math.imul(k3, C3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, C4); h3 ^= k3;
      h3 = (h3 << 15) | (h3 >>> 17); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
      k4 = Math.imul(k4, C4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, C1); h4 ^= k4;
      h4 = (h4 << 13) | (h4 >>> 19); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
    }
    this.h1 = h1; this.h2 = h2; this.h3 = h3; this.h4 = h4;
    this.length += end - start;
    for (; i < n; i++) this.word(view[i]);
    return this;
  }
  /** UTF-16 code units, two per word, framed by their count. */
  string(text) {
    const n = text.length;
    this.word(n);
    let i = 0;
    while (this.pending && i + 1 < n) { this.word(text.charCodeAt(i) | (text.charCodeAt(i + 1) << 16)); i += 2; }
    const start = i, end = i + ((n - i) & ~7);
    let h1 = this.h1, h2 = this.h2, h3 = this.h3, h4 = this.h4;
    for (; i < end; i += 8) {
      let k1 = text.charCodeAt(i) | (text.charCodeAt(i + 1) << 16), k2 = text.charCodeAt(i + 2) | (text.charCodeAt(i + 3) << 16),
        k3 = text.charCodeAt(i + 4) | (text.charCodeAt(i + 5) << 16), k4 = text.charCodeAt(i + 6) | (text.charCodeAt(i + 7) << 16);
      k1 = Math.imul(k1, C1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, C2); h1 ^= k1;
      h1 = (h1 << 19) | (h1 >>> 13); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
      k2 = Math.imul(k2, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C3); h2 ^= k2;
      h2 = (h2 << 17) | (h2 >>> 15); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
      k3 = Math.imul(k3, C3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, C4); h3 ^= k3;
      h3 = (h3 << 15) | (h3 >>> 17); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
      k4 = Math.imul(k4, C4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, C1); h4 ^= k4;
      h4 = (h4 << 13) | (h4 >>> 19); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
    }
    this.h1 = h1; this.h2 = h2; this.h3 = h3; this.h4 = h4;
    this.length += (end - start) >> 1;
    for (; i + 1 < n; i += 2) this.word(text.charCodeAt(i) | (text.charCodeAt(i + 1) << 16));
    if (i < n) this.word(text.charCodeAt(i));
    return this;
  }
  /** Finish and return 32 lowercase hexadecimal digits. */
  digest() {
    let {h1, h2, h3, h4} = this;
    if (this.pending) {
      // Zero-padded tail; the framed lengths already separate it from real zeros.
      let k1 = this.k1, k2 = this.pending > 1 ? this.k2 : 0, k3 = this.pending > 2 ? this.k3 : 0;
      this._block(k1, k2, k3, 0); ({h1, h2, h3, h4} = this);
    }
    const length = this.length | 0;
    h1 ^= length; h2 ^= length; h3 ^= length; h4 ^= length;
    h1 = (h1 + h2 + h3 + h4) | 0; h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
    h1 = fmix(h1); h2 = fmix(h2); h3 = fmix(h3); h4 = fmix(h4);
    h1 = (h1 + h2 + h3 + h4) | 0; h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
    const hex = h => (h >>> 0).toString(16).padStart(8, '0');
    return hex(h1) + hex(h2) + hex(h3) + hex(h4);
  }
}
