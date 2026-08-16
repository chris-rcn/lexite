#!/usr/bin/env node
// Check the TD gamma fade against realized outcomes in a prod-game corpus.
//
// leave-td damps each transition's bootstrap by gamma = min(1, bagAfterDraw/7):
// a leave held with a nearly empty bag is claimed to be worth proportionally
// less, because there is less future to draw into — and a tile hoarded into
// the fade "pays its stranding cost instead of inflating through
// never-reconciled hold transitions". That linear fade is a modeling choice,
// never measured. This tool measures it.
//
// Method: for every play in the corpus, take the leave (rack minus the tiles
// placed) and its UNDAMPED model value, and the mover's realized future —
// their final score minus their score through that move, which includes the
// end-of-game deadwood adjustment, so stranding is counted. Within each
// bagAfterDraw bucket, regress realized future on undamped leave value. The
// fitted slope is the empirical damping the game actually applied; the model
// claims min(1, bag/7).
//
//   slope ~ model fade  -> the fade is calibrated at that depth
//   slope > model fade  -> the model under-values leaves there (fades too hard)
//   slope < model fade  -> the model over-values leaves there (fades too little)
//
// CAVEAT — the confound here is MEASURED, not hypothetical. This is
// observational: the engine chose every move in the corpus, and leave value
// correlates with simply being in a good position (good tiles come with good
// boards and favorable scores), which independently predicts both a strong
// own future and a weak opponent future. Run on the 5.8k-game corpus this
// tool reported margin slopes of ~1.0-1.28 at every depth vs an own-points
// ~0.4-0.64, implying leaves were under-weighted against move score by ~2x.
// A static A/B refuted it outright: leaveWeight 1.5 lost 4.5 pts/game over
// 2,269 games and 0.85 lost 1.9 +- 1.9 — the response is peaked at the
// trained scale. Treat every slope below as descriptive only; any causal
// reading needs an A/B before it is believed.
//
//   node tools/validate-leave-fade.js <prod-games.jsonl> [...] [--margin]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MARGIN = process.argv.includes('--margin'); // regress on future MARGIN, not own points
if (!files.length) {
  console.error('Usage: node tools/validate-leave-fade.js <prod-games.jsonl> [...] [--margin]');
  process.exit(2);
}

const words = m.loadWords();
const E = m.loadEngine(path.join(__dirname, '..', 'game.js'), words, {});
E.evalInRealm(`ensureTrie(); ensureLeaveTables();
  // Undamped leave value: exactly what the fade multiplies in play.
  globalThis.__leaveVal = (s) => {
    const tiles = [...s].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
    return leaveValueFromCounts(tileCounts(tiles));
  };`);

// leave = rack minus placed tiles (blanks match blanks).
function leaveOf(rack, plStr) {
  const kept = [...rack];
  for (const p of plStr.split('|')) {
    const spec = p.split(',')[2];
    const ch = spec.startsWith('?') ? '?' : spec;
    const i = kept.indexOf(ch);
    if (i === -1) return null; // shouldn't happen; skip rather than lie
    kept.splice(i, 1);
  }
  return kept.sort().join('');
}

const rows = [];
let games = 0, skipped = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim());
  for (const line of lines.slice(1)) { // slice(1): skip the header envelope
    const g = JSON.parse(line);
    games++;
    // Cumulative score by seat, so the realized future of a move is
    // final[seat] - (score through that move).
    const cum = [0, 0];
    const totals = [0, 0];
    for (const mv of g.mv) totals[mv.seat] += mv.sc || 0;
    for (const mv of g.mv) {
      cum[mv.seat] += mv.sc || 0;
      if (mv.kind !== 'play' || !mv.pl) { skipped++; continue; }
      const leave = leaveOf(mv.rack, mv.pl);
      if (leave === null) { skipped++; continue; }
      const drawn = Math.min(7 - leave.length, mv.bag);
      const bagAfter = mv.bag - drawn;
      const mine = g.final[mv.seat] - cum[mv.seat];
      const theirs = g.final[1 - mv.seat] - cum[1 - mv.seat];
      rows.push({ bagAfter, leave, future: MARGIN ? mine - theirs : mine });
    }
  }
}

// Value every distinct leave once.
const uniq = [...new Set(rows.map(r => r.leave))];
const lv = new Map();
for (const s of uniq) {
  E._sandbox.__S = s;
  lv.set(s, s === '' ? 0 : E.evalInRealm('__leaveVal(__S)'));
}

const BUCKETS = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 10], [11, 15], [16, 30], [31, 90]];
console.log(`${games} games, ${rows.length} plays (${skipped} non-play/unparsed skipped), ${uniq.length} distinct leaves`);
console.log(`regressing realized future ${MARGIN ? 'MARGIN' : 'OWN POINTS'} on undamped leave value\n`);
console.log(`${'bagAfter'.padStart(9)} ${'n'.padStart(6)} ${'meanLV'.padStart(7)} ${'sdLV'.padStart(6)} ${'slope'.padStart(7)} ${'+-SE'.padStart(6)} ${'modelFade'.padStart(10)} ${'verdict'.padStart(14)}`);
for (const [lo, hi] of BUCKETS) {
  const sel = rows.filter(r => r.bagAfter >= lo && r.bagAfter <= hi);
  if (sel.length < 30) continue;
  const xs = sel.map(r => lv.get(r.leave));
  const ys = sel.map(r => r.future);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0) continue;
  const slope = sxy / sxx;
  const resid = (syy - slope * sxy) / Math.max(1, n - 2);
  const se = Math.sqrt(resid / sxx);
  // Model fade uses the bucket's mean depth (the fade is linear inside it).
  const meanBag = sel.reduce((a, r) => a + r.bagAfter, 0) / n;
  const fade = Math.min(1, meanBag / 7);
  const z = (slope - fade) / se;
  const verdict = Math.abs(z) < 2 ? 'calibrated' : (z > 0 ? `fades too hard` : `fades too little`);
  const label = lo === hi ? String(lo) : `${lo}-${hi}`;
  console.log(`${label.padStart(9)} ${String(n).padStart(6)} ${mx.toFixed(1).padStart(7)} ${Math.sqrt(sxx / n).toFixed(1).padStart(6)} ${slope.toFixed(3).padStart(7)} ${se.toFixed(3).padStart(6)} ${fade.toFixed(3).padStart(10)} ${verdict.padStart(14)}`);
}
