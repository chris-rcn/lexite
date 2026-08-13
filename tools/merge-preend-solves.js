#!/usr/bin/env node
// Merge preend reference-solve collections built by parallel generators
// into one eval snapshot. Inputs must share every META field except
// baseSeed (and the scanned counter); entries are deduped by their game
// seed (s), falling back to board+rack for pre-stream entries. The output
// is a snapshot for eval-preend-strategy.js, not an append/resume target —
// keep the per-generator files for that.
//
//   node tools/merge-preend-solves.js <in.json> [<in.json> ...] --out <out.json>
'use strict';
const fs = require('fs');

const OUT = (() => { const i = process.argv.indexOf('--out'); return i === -1 ? null : process.argv[i + 1]; })();
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--out');
if (!OUT || files.length < 1) {
  console.error('Usage: node tools/merge-preend-solves.js <in.json> [<in.json> ...] --out <out.json>');
  process.exit(2);
}

const colls = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const strip = meta => JSON.stringify({ ...meta, baseSeed: 0 });
for (let i = 1; i < colls.length; i++) {
  if (strip(colls[i].meta) !== strip(colls[0].meta)) {
    console.error(`META mismatch: ${files[i]} differs from ${files[0]} beyond baseSeed; refusing to merge.`);
    process.exit(2);
  }
}

const seen = new Set();
const entries = [];
let dups = 0;
for (const c of colls) {
  for (const e of c.entries) {
    const key = e.s !== undefined ? `s:${e.s}` : `br:${e.b}|${e.r}`;
    if (seen.has(key)) { dups++; continue; }
    seen.add(key);
    entries.push(e);
  }
}

fs.writeFileSync(OUT + '.tmp', JSON.stringify({ meta: colls[0].meta, scanned: 0, entries }));
fs.renameSync(OUT + '.tmp', OUT);
console.log(`${entries.length} positions from ${files.length} collections (${dups} duplicates dropped) -> ${OUT}`);
