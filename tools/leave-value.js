#!/usr/bin/env node
// Value a leave under a raw TD weight set — the query the training logs only
// answer for their seven hardcoded spot leaves.
//
// Accepts either format of sparse weights ("idx:val,..."): an online-learn
// checkpoint (td-leaves-*.ckpt.json, weights in .w) or a shipped weights file
// (leaves-w.txt.gz). value(L) = sum over every non-empty sub-multiset S of L
// of mult(S,L) * w[S], evaluated with the same walk the trainer uses
// (leave-td.js eachSubFeature), so numbers match the training log exactly.
// Feature order above a checkpoint's --maxorder is simply absent from it, so
// no order needs to be declared here.
//
// With no --leave, reports the training log's spot set, so a checkpoint can
// be read against its own running window at a glance.
//
//   node tools/leave-value.js <weights.ckpt.json|leaves-w.txt.gz>
//        [--leave L]... [--compare FILE]... [--breakdown]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const td = require('./leave-td.js');

const SPOT = ['S', '?', 'EE', 'QU', 'ER', 'AEINRS', 'UUVWII'];
const argv = process.argv;
const FILE = argv[2];
if (!FILE || FILE.startsWith('--')) {
  console.error('Usage: node tools/leave-value.js <weights.ckpt.json|leaves-w.txt.gz> [--leave L]... [--compare FILE]... [--breakdown]');
  process.exit(2);
}
const multi = (flag) => argv.reduce((acc, a, i) => (a === flag ? acc.concat(argv[i + 1]) : acc), []);
const leaves = multi('--leave').length ? multi('--leave') : SPOT;
const files = [FILE, ...multi('--compare')];
const BREAKDOWN = argv.includes('--breakdown');

// Both formats carry the same sparse "idx:val,..." payload.
function loadWeights(f) {
  const raw = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString()
    : fs.readFileSync(f, 'utf8');
  const sparse = f.endsWith('.json') ? JSON.parse(raw).w : raw.trim();
  const w = new Float64Array(td.SIZE);
  if (sparse) {
    for (const part of sparse.split(',')) {
      const c = part.indexOf(':');
      if (c > 0) w[+part.slice(0, c)] = +part.slice(c + 1);
    }
  }
  return w;
}

const countsOf = s => {
  const a = new Int32Array(td.NT);
  for (const ch of s.toUpperCase()) a[ch === '?' ? 26 : ch.charCodeAt(0) - 65]++;
  return a;
};
const strOf = counts => {
  let s = '';
  for (let i = 0; i < td.NT; i++) for (let k = 0; k < counts[i]; k++) s += i === 26 ? '?' : String.fromCharCode(65 + i);
  return s;
};
// A sub-multiset's own feature rank: it is the one sub-feature of itself
// whose size equals its tile count (reuses the trainer's canonical walk
// rather than reimplementing the indexing).
function rankOf(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  let rank = -1;
  td.eachSubFeature(counts, (r, _m, size) => { if (size === total) rank = r; });
  return rank;
}

const sets = new Map(); // label -> weights
for (const f of files) sets.set(path.basename(f).replace(/\.(ckpt\.json|txt\.gz|json|gz)$/, ''), loadWeights(f));

// With --compare, every comparison column is followed by its difference
// from the primary file (compare minus primary), signed.
const labels = [...sets.keys()];
const width = Math.max(10, ...labels.map(k => k.length + 2));
const DW = 9;
const signed = v => (v >= 0 ? '+' : '') + v.toFixed(2);
const header = labels.map((k, i) => k.padStart(width) + (i > 0 ? 'diff'.padStart(DW) : '')).join('');
console.log(`${'leave'.padEnd(10)}${header}`);
for (const L of leaves) {
  const c = countsOf(L);
  const vals = [...sets.values()].map(w => td.valueFromFeatures(c, w));
  const row = vals.map((v, i) => v.toFixed(2).padStart(width) + (i > 0 ? signed(v - vals[0]).padStart(DW) : '')).join('');
  console.log(`${L.padEnd(10)}${row}`);
}

if (BREAKDOWN) {
  for (const L of leaves) {
    const lc = countsOf(L);
    const present = [];
    for (let i = 0; i < td.NT; i++) if (lc[i] > 0) present.push(i);
    // Every non-empty sub-multiset of L, with its multiplicity in L.
    const subs = [];
    (function rec(pi, sub, mult, size) {
      if (pi === present.length) { if (size >= 1) subs.push({ sub: Int32Array.from(sub), mult }); return; }
      const t = present[pi], c = lc[t];
      for (let s = 0; s <= c; s++) {
        sub[t] = s;
        rec(pi + 1, sub, mult * td.BINOM[c][s], size + s);
      }
      sub[t] = 0;
    })(0, new Int32Array(td.NT), 1, 0);
    console.log(`\n${L} — feature breakdown (contribution = mult x weight)`);
    console.log(`${'sub'.padEnd(10)} ${'ord'.padStart(3)} ${'mult'.padStart(5)}${labels.map((k, i) => (k + ' w').padStart(width) + 'contrib'.padStart(9) + (i > 0 ? 'diff'.padStart(DW) : '')).join('')}`);
    const rows = subs.map(({ sub, mult }) => {
      const rank = rankOf(sub);
      const per = [...sets.values()].map(w => ({ w: w[rank], contrib: mult * w[rank] }));
      return { s: strOf(sub), ord: sub.reduce((a, b) => a + b, 0), mult, per };
    }).filter(r => r.per.some(p => p.contrib !== 0))
      .sort((a, b) => Math.abs(b.per[0].contrib) - Math.abs(a.per[0].contrib));
    for (const r of rows) {
      console.log(`${r.s.padEnd(10)} ${String(r.ord).padStart(3)} ${String(r.mult).padStart(5)}` +
        r.per.map((p, i) => p.w.toFixed(3).padStart(width) + p.contrib.toFixed(2).padStart(9) +
          (i > 0 ? signed(p.contrib - r.per[0].contrib).padStart(DW) : '')).join(''));
    }
  }
}
