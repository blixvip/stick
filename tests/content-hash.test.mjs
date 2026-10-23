import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentHasher} from '../src/content-hash.mjs';

const hashWords = words => new ContentHasher().words(words).digest();
const hashString = text => new ContentHasher().string(text).digest();
// Deterministic pseudo-random words, independent of Math.random.
const words = (count, seed = 1) => {
  const out = new Uint32Array(count); let state = seed >>> 0;
  for (let i = 0; i < count; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; out[i] = state; }
  return out;
};
const popcount = n => { let c = 0; for (n >>>= 0; n; n &= n - 1) c++; return c; };
const distance = (a, b) => { let d = 0; for (let i = 0; i < 32; i += 8) d += popcount(parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)); return d; };

test('digests are 32 hexadecimal digits and repeat exactly', () => {
  const input = words(37);
  assert.match(hashWords(input), /^[0-9a-f]{32}$/);
  assert.equal(hashWords(input), hashWords(Uint32Array.from(input)));
  assert.match(hashString('drawing'), /^[0-9a-f]{32}$/);
  assert.equal(hashString('drawing'), hashString('drawing'));
});

test('every input length from empty to several blocks hashes distinctly', () => {
  const seen = new Map();
  for (let length = 0; length <= 40; length++) {
    for (const fill of length ? [0, 1, 0xffffffff] : [0]) {
      const key = hashWords(new Uint32Array(length).fill(fill));
      assert.equal(seen.has(key), false, `length ${length} fill ${fill} collides with ${seen.get(key)}`);
      seen.set(key, `${length}/${fill}`);
    }
  }
});

test('changing any single bit of any word changes the digest', () => {
  const input = words(23, 7), base = hashWords(input);
  for (let index = 0; index < input.length; index++) for (let bit = 0; bit < 32; bit += 5) {
    const changed = Uint32Array.from(input); changed[index] ^= 1 << bit;
    assert.notEqual(hashWords(changed), base, `word ${index} bit ${bit}`);
  }
});

test('a single flipped bit changes about half of the 128 output bits', () => {
  let total = 0, trials = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const input = words(64, seed), base = hashWords(input);
    for (let bit = 0; bit < 64; bit += 7) {
      const changed = Uint32Array.from(input); changed[(seed * 3 + bit) % 64] ^= 1 << (bit % 32);
      const spread = distance(base, hashWords(changed));
      assert.ok(spread >= 32 && spread <= 96, `only ${spread} bits differ`);
      total += spread; trials++;
    }
  }
  assert.ok(Math.abs(total / trials - 64) < 4, `mean ${total / trials}`);
});

test('part boundaries are framed, so regrouping the same words cannot collide', () => {
  const split = (a, b) => new ContentHasher().string(a).string(b).digest();
  assert.notEqual(split('ab', 'c'), split('a', 'bc'));
  assert.notEqual(split('', 'abc'), split('abc', ''));
  const left = Uint32Array.of(1, 2, 3, 4, 5), right = Uint32Array.of(6, 7);
  assert.notEqual(new ContentHasher().words(left).words(right).digest(),
    new ContentHasher().words(Uint32Array.of(1, 2, 3, 4)).words(Uint32Array.of(5, 6, 7)).digest());
  // Strings of odd and even length differ even when their padded words match.
  assert.notEqual(hashString('a'), hashString('a\u0000'));
});

test('bulk word input equals feeding each word one at a time, at every block alignment', () => {
  for (const prefix of [0, 1, 2, 3, 4, 5]) for (const length of [0, 1, 3, 4, 5, 8, 17, 64]) {
    const input = words(length, prefix * 100 + length + 1);
    const bulk = new ContentHasher(); for (let i = 0; i < prefix; i++) bulk.word(i + 9); bulk.words(input);
    const single = new ContentHasher(); for (let i = 0; i < prefix; i++) single.word(i + 9);
    single.word(length); for (const value of input) single.word(value);
    assert.equal(bulk.digest(), single.digest(), `prefix ${prefix} length ${length}`);
  }
});

test('string input equals feeding its code-unit pairs one word at a time, at every alignment', () => {
  const text = Array.from({length: 61}, (_, i) => String.fromCharCode(0x41 + (i * 37) % 0xd000)).join('');
  for (const prefix of [0, 1, 2, 3]) for (const length of [0, 1, 2, 7, 8, 9, 16, 17, 33, 61]) {
    const part = text.slice(0, length);
    const bulk = new ContentHasher(); for (let i = 0; i < prefix; i++) bulk.word(i + 3); bulk.string(part);
    const single = new ContentHasher(); for (let i = 0; i < prefix; i++) single.word(i + 3);
    single.word(part.length);
    for (let i = 0; i + 1 < part.length; i += 2) single.word(part.charCodeAt(i) | (part.charCodeAt(i + 1) << 16));
    if (part.length % 2) single.word(part.charCodeAt(part.length - 1));
    assert.equal(bulk.digest(), single.digest(), `prefix ${prefix} length ${length}`);
  }
});

test('typed views hash by their elements, not their backing buffer', () => {
  const buffer = words(32, 5), view = buffer.subarray(4, 20);
  assert.equal(hashWords(view), hashWords(Uint32Array.from(view)));
  const doubles = Float64Array.of(1.5, -0, 0, NaN, Infinity);
  const asWords = new Uint32Array(doubles.buffer);
  assert.notEqual(hashWords(asWords), hashWords(new Uint32Array(new Float64Array(Float64Array.of(1.5, 0, 0, NaN, Infinity)).buffer)),
    'negative and positive zero keep distinct bit patterns');
});

test('many unrelated inputs produce no duplicate digests', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 20000; seed++) {
    const key = hashWords(words(1 + (seed % 19), seed));
    assert.equal(seen.has(key), false, `collision at seed ${seed}`);
    seen.add(key);
  }
});

test('digests stay identical to the published block mix across block boundaries', () => {
  // Content keys cross workers and packets, so the unrolled word and string
  // loops must reproduce exactly the digests of the per-word implementation.
  const seeded = n => { const out = new Uint32Array(n); let s = 7; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s; } return out; };
  const text = n => Array.from({length: n}, (_, i) => String.fromCharCode(32 + (i * 7919) % 0xd7ff)).join('');
  const cases = [
    ['words 0', h => h.words(seeded(0)), '0d612e4d49e0ce8637eeeca6c3e9b57e'],
    ['words 3', h => h.words(seeded(3)), '3020b83085cc4bfc60ede0614ad6fecc'],
    ['words 4', h => h.words(seeded(4)), '2115faef378176216413a53c78bf070b'],
    ['words 37', h => h.words(seeded(37)), '610565feae46e0c3f6ed7aa295283cab'],
    ['string 0', h => h.string(''), '0d612e4d49e0ce8637eeeca6c3e9b57e'],
    ['string 9', h => h.string(text(9)), '5f40695a1f592b517d2875e051301bcc'],
    ['string 64', h => h.string(text(64)), 'aba519315bdfc58a7074f3cecd823213'],
  ];
  for (const [name, feed, expected] of cases) assert.equal(feed(new ContentHasher()).digest(), expected, name);
  const mixed = new ContentHasher(0x5a17).word(5).string(text(13)).words(seeded(21)).word(0xffffffff).string(text(3));
  assert.equal(mixed.digest(), '0e9d698031f7d4b6c71b1c1686a032e8', 'partial blocks between parts');
});
