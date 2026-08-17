#!/usr/bin/env node
// Scan every legal N-tile leave and report where two weight sets disagree
// most — the diagnostic leave-value.js can't give you, since it only answers
// for leaves you already suspect.
//
// Both inputs may be either sparse-weight format: an online-learn checkpoint
// (td-leaves-*.ckpt.json) or a shipped weights file (leaves-w.txt.gz). Leaves
// are enumerated by the canonical superleave ranking, so tile supply is
// respected (no JJ, no three blanks) and the scan is exactly the deployable
// table's domain for that size.
//
// Differences are B minus A, matching leave-value.js's diff column.
//
//   node tools/scan-leave-diffs.js <fileA> <fileB> --size N [--top K]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const td = require('./leave-td.js');
const SL = require('./superleave.js');

const argv = process.argv;
const A = argv[2], B = argv[3];
const flag = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(flag('--size', 'NaN'), 10);
const TOP = parseInt(flag('--top', '15'), 10);
if (!A || !B || A.startsWith('--') || B.startsWith('--') || !(N >= 0 && N <= SL.MAX_LEAVE)) {
  console.error(`Usage: node tools/scan-leave-diffs.js <fileA> <fileB> --size N [--top K]   (0 <= N <= ${SL.MAX_LEAVE})`);
  process.exit(2);
}

function loadWeights(f) {
  const raw = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString() : fs.readFileSync(f, 'utf8');
  const sparse = f.endsWith('.json') ? JSON.parse(raw).w : raw.trim();
  const w = new Float64Array(td.SIZE);
  if (sparse) for (const part of sparse.split(',')) {
    const c = part.indexOf(':');
    if (c > 0) w[+part.slice(0, c)] = +part.slice(c + 1);
  }
  return w;
}
const label = f => path.basename(f).replace(/\.(ckpt\.json|txt\.gz|json|gz)$/, '');
const strOf = counts => {
  let s = '';
  for (let i = 0; i < td.NT; i++) for (let k = 0; k < counts[i]; k++) s += SL.codeToChar(i);
  return s;
};

const wA = loadWeights(A), wB = loadWeights(B);
const rows = [];
let sumAbs = 0, sumSq = 0, sumSigned = 0, n = 0;
for (let idx = 0; idx < SL.TABLE_SIZE; idx++) {
  const counts = SL.leaveUnrank(idx);
  let size = 0;
  for (let i = 0; i < td.NT; i++) size += counts[i];
  if (size !== N) continue;
  const a = td.valueFromFeatures(counts, wA);
  const b = td.valueFromFeatures(counts, wB);
  const d = b - a;
  n++; sumAbs += Math.abs(d); sumSq += d * d; sumSigned += d;
  rows.push({ s: strOf(counts), a, b, d });
}

rows.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
const la = label(A), lb = label(B);
const W = Math.max(10, la.length + 2, lb.length + 2);
console.log(`${n} legal ${N}-tile leaves | mean |diff| ${(sumAbs / n).toFixed(2)} | rms ${Math.sqrt(sumSq / n).toFixed(2)} | mean signed ${(sumSigned / n >= 0 ? '+' : '') + (sumSigned / n).toFixed(2)}`);
console.log(`largest ${Math.min(TOP, rows.length)} differences (${lb} minus ${la}):\n`);
console.log(`${'leave'.padEnd(10)}${la.padStart(W)}${lb.padStart(W)}${'diff'.padStart(9)}`);
for (const r of rows.slice(0, TOP)) {
  console.log(`${r.s.padEnd(10)}${r.a.toFixed(2).padStart(W)}${r.b.toFixed(2).padStart(W)}${((r.d >= 0 ? '+' : '') + r.d.toFixed(2)).padStart(9)}`);
}
