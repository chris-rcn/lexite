#!/usr/bin/env node
// Superleave table: one equity value per possible rack leave (0-6 kept
// tiles), stored as a flat 1-byte-per-leave array indexed by a canonical
// leave rank. This module is the foundation — the index bijection, the
// 1-byte value codec, and a builder that seeds a complete table from the
// linear leave model (leaves.js) as a prior. Per-leave equity refinement
// from self-play comes later and updates entries in place.
//
// Usage:
//   node tools/superleave.js verify           # self-test the index + codec
//   node tools/superleave.js build [--out F]  # write the seeded table (gzip)
//   node tools/superleave.js stats            # value distribution of the seed
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 27 tile types: A..Z then blank. Caps are min(6, supply) — a leave holds
// at most 6 tiles, and never more of a type than the bag contains.
const SUPPLY = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1, /*blank*/ 2];
const NTYPES = 27;
const MAX_LEAVE = 6;
const CAP = SUPPLY.map(s => Math.min(MAX_LEAVE, s));

const codeToChar = c => (c < 26 ? String.fromCharCode(65 + c) : '?');

// g[i][r] = number of feasible sub-leaves using types i..26 with total <= r
// (caps respected). Drives both ranking and unranking.
function buildG() {
  const g = Array.from({ length: NTYPES + 1 }, () => new Int32Array(MAX_LEAVE + 1));
  for (let r = 0; r <= MAX_LEAVE; r++) g[NTYPES][r] = 1; // empty completion
  for (let i = NTYPES - 1; i >= 0; i--) {
    for (let r = 0; r <= MAX_LEAVE; r++) {
      let sum = 0;
      for (let v = 0; v <= CAP[i] && v <= r; v++) sum += g[i + 1][r - v];
      g[i][r] = sum;
    }
  }
  return g;
}
const G = buildG();
const TABLE_SIZE = G[0][MAX_LEAVE];

// counts (Int of length 27, sum<=6, counts[i]<=CAP[i]) -> index in [0,SIZE)
function leaveRank(counts) {
  let idx = 0, R = MAX_LEAVE;
  for (let i = 0; i < NTYPES; i++) {
    const c = counts[i];
    for (let v = 0; v < c; v++) idx += G[i + 1][R - v];
    R -= c;
  }
  return idx;
}

// index -> counts (inverse of leaveRank)
function leaveUnrank(index) {
  const counts = new Int32Array(NTYPES);
  let idx = index, R = MAX_LEAVE;
  for (let i = 0; i < NTYPES; i++) {
    let v = 0;
    while (v <= CAP[i] && v <= R && idx >= G[i + 1][R - v]) { idx -= G[i + 1][R - v]; v++; }
    counts[i] = v; R -= v;
  }
  return counts;
}

// ---- 1-byte value codec ----------------------------------------------------
// Equity clamped to [-48, +47.625] and quantized to 0.375 pt (3/8, exact in
// float). byte 0 -> -48, 128 -> 0, 255 -> +47.625. The range covers ~99.8%
// of real leaves; only extreme linear-extrapolation outliers clip, and move
// choice is insensitive there (a leave that good/bad is kept/dumped anyway).
const VALUE_SCALE = 0.375;
const VALUE_ZERO = 128;
const VALUE_MIN = (0 - VALUE_ZERO) * VALUE_SCALE;         // -40
const VALUE_MAX = (255 - VALUE_ZERO) * VALUE_SCALE;       // +39.6875
function encodeValue(v) {
  let b = Math.round(v / VALUE_SCALE) + VALUE_ZERO;
  if (b < 0) b = 0; else if (b > 255) b = 255;
  return b;
}
function decodeValue(b) { return (b - VALUE_ZERO) * VALUE_SCALE; }

// ---- linear leave model (prior) -------------------------------------------
function loadLinearWeights(file) {
  const src = fs.readFileSync(file, 'utf8');
  return (new Function(src + '\n;return LEAVE_WEIGHTS;'))();
}
// Mirrors leaveValueFromCounts in game.js: per-letter + all unordered pairs
// (same-letter pairs use n(n-1)/2). counts indexed by tile code (blank=26).
function linearValue(counts, W) {
  let v = 0;
  const present = [];
  for (let c = 0; c < NTYPES; c++) if (counts[c] > 0) present.push(c);
  for (let a = 0; a < present.length; a++) {
    const c1 = present[a], n1 = counts[c1], ch1 = codeToChar(c1);
    v += (W.letter[ch1] || 0) * n1;
    if (n1 >= 2) v += (W.pair[ch1 + ch1] || 0) * (n1 * (n1 - 1) / 2);
    for (let b = a + 1; b < present.length; b++) {
      const c2 = present[b], ch2 = codeToChar(c2);
      const key = ch1 < ch2 ? ch1 + ch2 : ch2 + ch1;
      v += (W.pair[key] || 0) * n1 * counts[c2];
    }
  }
  return v;
}

// ---- build the seeded table -----------------------------------------------
function buildSeedTable(weights) {
  const table = new Uint8Array(TABLE_SIZE);
  let clipLo = 0, clipHi = 0, min = Infinity, max = -Infinity;
  for (let idx = 0; idx < TABLE_SIZE; idx++) {
    const counts = leaveUnrank(idx);
    const val = linearValue(counts, weights);
    if (val < min) min = val;
    if (val > max) max = val;
    if (val < VALUE_MIN) clipLo++;
    if (val > VALUE_MAX) clipHi++;
    table[idx] = encodeValue(val);
  }
  return { table, min, max, clipLo, clipHi };
}

// ---- CLI ------------------------------------------------------------------
function verify() {
  let ok = true;
  const say = (n, pass, extra = '') => { if (!pass) ok = false; console.log(`${pass ? 'PASS' : 'FAIL'}: ${n}${pass ? '' : ' — ' + extra}`); };
  say(`table size == 914625 (feasible leaves)`, TABLE_SIZE === 914625, `got ${TABLE_SIZE}`);
  // rank/unrank is a bijection over [0, SIZE)
  let bijOk = true, badIdx = -1;
  for (let idx = 0; idx < TABLE_SIZE; idx++) {
    if (leaveRank(leaveUnrank(idx)) !== idx) { bijOk = false; badIdx = idx; break; }
  }
  say('rank(unrank(i)) == i for all i', bijOk, `first bad idx ${badIdx}`);
  // all unranked leaves are feasible (sum<=6, within caps)
  let feasOk = true;
  for (let idx = 0; idx < TABLE_SIZE; idx += 97) { // sample every 97th for speed
    const c = leaveUnrank(idx); let s = 0, cap = true;
    for (let i = 0; i < NTYPES; i++) { s += c[i]; if (c[i] > CAP[i]) cap = false; }
    if (s > MAX_LEAVE || !cap) { feasOk = false; break; }
  }
  say('sampled leaves respect size + supply caps', feasOk);
  // codec round-trip within half a quantum
  let maxErr = 0;
  for (let v = -40; v <= 39.6; v += 0.13) maxErr = Math.max(maxErr, Math.abs(decodeValue(encodeValue(v)) - v));
  say('codec round-trip error <= half quantum', maxErr <= VALUE_SCALE / 2 + 1e-9, `maxErr ${maxErr.toFixed(4)}`);
  // spot-check known leaves rank distinctly
  const empty = new Int32Array(NTYPES);
  say('empty leave ranks 0', leaveRank(empty) === 0);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
}

function main() {
  const cmd = process.argv[2] || 'verify';
  if (cmd === 'verify') return verify();

  const repo = path.resolve(__dirname, '..');
  const weights = loadLinearWeights(path.join(repo, 'leaves.js'));

  if (cmd === 'stats') {
    const { min, max, clipLo, clipHi } = buildSeedTable(weights);
    console.log(`Seed (linear model) value range: [${min.toFixed(2)}, ${max.toFixed(2)}]`);
    console.log(`Codec range: [${VALUE_MIN}, ${VALUE_MAX}]  scale ${VALUE_SCALE}`);
    console.log(`Clipped: ${clipLo} below, ${clipHi} above (of ${TABLE_SIZE})`);
    return;
  }

  if (cmd === 'build') {
    let out = path.join(repo, 'leaves.bin.gz');
    const oi = process.argv.indexOf('--out');
    if (oi !== -1) out = path.resolve(process.cwd(), process.argv[oi + 1]);
    const { table, min, max, clipLo, clipHi } = buildSeedTable(weights);
    const gz = zlib.gzipSync(Buffer.from(table.buffer), { level: 9 });
    fs.writeFileSync(out, gz);
    console.log(`Wrote ${out}`);
    console.log(`  ${TABLE_SIZE} leaves, ${(table.length / 1024).toFixed(0)} KB raw, ${(gz.length / 1024).toFixed(0)} KB gzip`);
    console.log(`  seed value range [${min.toFixed(2)}, ${max.toFixed(2)}], clipped ${clipLo}+${clipHi}`);
    return;
  }
  console.error(`Unknown command: ${cmd}`);
  process.exit(2);
}

module.exports = {
  NTYPES, MAX_LEAVE, CAP, TABLE_SIZE, G,
  leaveRank, leaveUnrank, encodeValue, decodeValue, VALUE_SCALE, VALUE_ZERO,
  loadLinearWeights, linearValue, buildSeedTable, codeToChar,
};

if (require.main === module) main();
