#!/usr/bin/env node
// Fit an endgame leave model from the bag0 oracle DB. Each record's arms
// are (move, reference value) pairs on one board; within a record, value
// differences come from the move's score and what it keeps, while
// everything positional is shared. So regress, with per-position
// intercepts absorbed by within-record demeaning:
//   refValue - score  ≈  a_pos + Σ_f c_f · count_f(leave)
// c_f is the fitted margin VALUE of holding feature f at bag 0 (same
// sense as the midgame leave model: higher = better to hold). Go-out
// arms (empty leave) are excluded: their value is exact rule arithmetic,
// not leave estimation. Scores are recomputed from the stored board via
// scorePlacement (blank designations are lost in the sig, but blanks
// score zero regardless).
//
// With leaveMaxBoardCount = 0 (default) a feature is just the tile: 27
// values. With N > 0 a feature is (tile, board playability bucket): the
// number of distinct board locations the tile can occupy in a legal play
// using ONLY the leave tiles, on the post-move board, capped at N —
// 27 x (N+1) values. This splits e.g. the stuck Q (bucket 0) from the
// droppable Q (bucket N), the bimodality a flat per-tile value averages
// away. The engine mirrors the same computation at the root
// (STAGES.bag0.leaveMaxBoardCount).
//
// Prints the fitted table with support counts and fit quality, then a
// ready-to-paste JS literal for game.js. Rerun any time the DB grows.
//
// With 'pairs' as the third argument, unordered tile-pair counts join the
// feature set (378 pair features): the leave-only playability signal
// (Q-with-U is a different hold than Q-alone). Fit pairs WITHOUT board
// buckets for the interior model, and WITH buckets for the root model —
// joint fitting partitions credit so buckets absorb board-realized
// playability and pairs absorb residual partner synergy (no double
// counting when the engine adds both).
//
//   node tools/fit-endgame-leaves.js <oracle.jsonl> [leaveMaxBoardCount] [pairs]
//   node tools/fit-endgame-leaves.js <oracle.jsonl> --out <endgame-leaves.json.gz>
//
// --out runs both production fits (interior: 0+pairs; root: 2+pairs) and
// writes the engine's data file directly — no pasting.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const m = require('./match.js');

const BENCH = process.argv[2];
if (!BENCH) {
  console.error('Usage: node tools/fit-endgame-leaves.js <oracle.jsonl> [leaveMaxBoardCount]');
  process.exit(2);
}
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
let N, B, PAIRS, SINGLES_D, PAIRS_D;
function setMode(n, pairs) {
  N = n; B = n + 1; PAIRS = pairs;
  SINGLES_D = 27 * B;
  PAIRS_D = pairs ? 27 * 28 / 2 : 0;
}
setMode(parseInt(process.argv[3] || '0', 10), process.argv[4] === 'pairs');
const pairIdx = (a, b) => (a <= b ? b * (b + 1) / 2 + a : a * (a + 1) / 2 + b);

function decodeBoard(s) {
  const b = Array.from({ length: 15 }, () => new Array(15).fill(null));
  for (let i = 0; i < 225; i++) {
    const ch = s[i]; if (ch === '.') continue;
    const L = ch.toUpperCase();
    b[Math.floor(i / 15)][i % 15] = { letter: L, isBlank: ch >= 'a' && ch <= 'z', displayLetter: L };
  }
  return b;
}
const code = ch => (ch === '?' ? 26 : ch.charCodeAt(0) - 65);
const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '?'];

// sig "r,c,L|r,c,L|..." -> placements (blank letter placeholder scores 0).
function sigPlacements(sig) {
  return sig.split('|').map(part => {
    const [r, c, L] = part.split(',');
    return { row: +r, col: +c, letter: L === '?' ? 'A' : L, isBlank: L === '?' };
  });
}

const words = m.loadWords();
const E = m.loadEngine(path.join(__dirname, '..', 'game.js'), words, {});
E.evalInRealm(`ensureTrie();
  globalThis.__score = function () {
    state.board = JSON.parse(__B);
    const pl = JSON.parse(__P);
    const rows = new Set(pl.map(p => p.row));
    return scorePlacement(pl, rows.size === 1);
  };
  // Distinct board locations each leave tile can occupy in a legal play
  // using only the leave, on the post-move board — the same computation
  // the engine's root ordering runs (leaveBoardCounts).
  globalThis.__leaveBoardCounts = function () {
    state.board = JSON.parse(__B);
    state.isFirstMove = false;
    state.bag = [];
    const pl = JSON.parse(__P);
    const leave = JSON.parse(__L).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    applyToBoard(pl);
    try {
      return JSON.stringify(leaveBoardCounts(leave, { used: 0 }));
    } finally {
      removeFromBoard(pl);
    }
  };`);

async function main() {
  const lines = fs.readFileSync(BENCH, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  const records = lines.slice(1).map(l => JSON.parse(l));
  console.log(`Fitting on ${BENCH}: ${records.length} positions (oracle budget ${header.ref.budget}, width ${header.ref.width}, depth ${header.ref.depth}), leaveMaxBoardCount ${N}\n`);

  const D = SINGLES_D + PAIRS_D;
  const XtX = Array.from({ length: D }, () => new Float64Array(D));
  const Xty = new Float64Array(D);
  const support = new Int32Array(D); // examples containing the feature
  let nExamples = 0, nRecords = 0, ssTot = 0;
  const rows = []; // kept per-example for R^2 after solving

  for (const rec of records) {
    const bJson = JSON.stringify(decodeBoard(rec.b));
    const rackCounts = new Int32Array(27);
    for (const ch of rec.r) rackCounts[code(ch)]++;
    const ex = [];
    for (const [sig, val] of rec.e) {
      const pl = sigPlacements(sig);
      const leave = rackCounts.slice();
      let ok = true;
      for (const p of pl) {
        const c = p.isBlank ? 26 : code(p.letter);
        if (leave[c] <= 0) { ok = false; break; }
        leave[c]--;
      }
      if (!ok) continue;
      if (leave.every(v => v === 0)) continue; // go-out: exact rule value
      E._sandbox.__B = bJson;
      E._sandbox.__P = JSON.stringify(pl);
      const score = E.evalInRealm('__score()');
      const feats = new Map();
      if (N === 0) {
        for (let t = 0; t < 27; t++) if (leave[t] > 0) feats.set(t, leave[t]);
      } else {
        const leaveRack = [];
        for (let t = 0; t < 27; t++) {
          for (let k = 0; k < leave[t]; k++) {
            leaveRack.push({ letter: t === 26 ? '?' : String.fromCharCode(65 + t), isBlank: t === 26 });
          }
        }
        E._sandbox.__L = JSON.stringify(leaveRack);
        const counts = JSON.parse(E.evalInRealm('__leaveBoardCounts()'));
        for (let t = 0; t < 27; t++) {
          if (leave[t] > 0) feats.set(t * B + Math.min(counts[t], N), leave[t]);
        }
      }
      if (PAIRS) {
        for (let a = 0; a < 27; a++) {
          if (leave[a] <= 0) continue;
          for (let b = a; b < 27; b++) {
            if (leave[b] <= 0) continue;
            const n = a === b ? leave[a] * (leave[a] - 1) / 2 : leave[a] * leave[b];
            if (n > 0) feats.set(SINGLES_D + pairIdx(a, b), n);
          }
        }
      }
      ex.push({ y: val - score, feats });
    }
    if (ex.length < 2) continue; // demeaning needs contrast
    nRecords++;
    const ybar = ex.reduce((a, e) => a + e.y, 0) / ex.length;
    // Sparse demeaning: only features present somewhere in this record
    // have nonzero within-record mean, so dx is confined to that set.
    const xbar = new Map();
    for (const e of ex) for (const [i, c] of e.feats) xbar.set(i, (xbar.get(i) || 0) + c / ex.length);
    const actIdx = [...xbar.keys()];
    for (const e of ex) {
      const dy = e.y - ybar;
      ssTot += dy * dy;
      nExamples++;
      const idxs = [], vals = [];
      for (const i of actIdx) {
        const raw = e.feats.get(i) || 0;
        if (raw > 0) support[i]++;
        const v = raw - xbar.get(i);
        if (v !== 0) { idxs.push(i); vals.push(v); }
      }
      for (let a = 0; a < idxs.length; a++) {
        Xty[idxs[a]] += vals[a] * dy;
        for (let b = a; b < idxs.length; b++) {
          XtX[idxs[a]][idxs[b]] += vals[a] * vals[b];
          if (idxs[b] !== idxs[a]) XtX[idxs[b]][idxs[a]] += vals[a] * vals[b];
        }
      }
      rows.push({ idxs, vals, dy });
    }
  }

  // Ridge for rarely-seen features, then Gaussian elimination.
  const A = XtX.map((r, i) => { const c2 = Float64Array.from(r); c2[i] += 1.0; return c2; });
  const w = Float64Array.from(Xty);
  for (let i = 0; i < D; i++) {
    let piv = i;
    for (let j = i + 1; j < D; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
    [A[i], A[piv]] = [A[piv], A[i]];
    const wi = w[piv]; w[piv] = w[i]; w[i] = wi;
    for (let j = i + 1; j < D; j++) {
      const f = A[j][i] / A[i][i];
      if (!f) continue;
      for (let k = i; k < D; k++) A[j][k] -= f * A[i][k];
      w[j] -= f * w[i];
    }
  }
  const c = new Float64Array(D);
  for (let i = D - 1; i >= 0; i--) {
    let s = w[i];
    for (let k = i + 1; k < D; k++) s -= A[i][k] * c[k];
    c[i] = s / A[i][i];
  }

  let ssRes = 0;
  for (const r of rows) {
    let pred = 0;
    for (let a = 0; a < r.idxs.length; a++) pred += r.vals[a] * c[r.idxs[a]];
    ssRes += (r.dy - pred) * (r.dy - pred);
  }

  if (!OUT) {
  if (N === 0) {
    console.log(`${'tile'.padStart(5)} ${'value'.padStart(10)} ${'-face'.padStart(6)} ${'support'.padStart(8)}`);
    for (let t = 0; t < 27; t++) {
      const L = LETTERS[t];
      console.log(`${L.padStart(5)} ${c[t].toFixed(2).padStart(10)} ${String(-m.LETTER_VALUES[L]).padStart(6)} ${String(support[t]).padStart(8)}`);
    }
  } else {
    const bucketHdr = Array.from({ length: B }, (_, b) => (b === N ? `${b}+` : String(b)));
    console.log(`${'tile'.padStart(5)} ` + bucketHdr.map(h => `${('v@' + h).padStart(8)} ${('n@' + h).padStart(6)}`).join(' '));
    for (let t = 0; t < 27; t++) {
      const L = LETTERS[t];
      console.log(`${L.padStart(5)} ` + bucketHdr.map((_, b) =>
        `${c[t * B + b].toFixed(2).padStart(8)} ${String(support[t * B + b]).padStart(6)}`).join(' '));
    }
  }
  console.log(`\npositions ${nRecords}, examples ${nExamples}`);
  console.log(`within-position R^2 ${(1 - ssRes / ssTot).toFixed(3)}, residual sd ${Math.sqrt(ssRes / Math.max(1, nExamples - D)).toFixed(2)} pts (total sd ${Math.sqrt(ssTot / nExamples).toFixed(2)})`);

  // Ready-to-paste literal for game.js.
  const fmt = v => +v.toFixed(2);
  if (N === 0) {
    console.log(`\nconst EG_LEAVE_VALUES = [\n  ${Array.from(c.slice(0, SINGLES_D), fmt).join(', ')}\n];`);
  } else {
    const rowsJs = [];
    for (let t = 0; t < 27; t++) {
      rowsJs.push('  [' + Array.from({ length: B }, (_, b) => fmt(c[t * B + b])).join(', ') + '],');
    }
    console.log(`\nconst EG_LEAVE_BOARD_VALUES = [ // [tile][min(locations, ${N})]\n${rowsJs.join('\n')}\n];`);
  }
  if (PAIRS) {
    const prs = [];
    for (let b = 0; b < 27; b++) {
      for (let a = 0; a <= b; a++) {
        const i = SINGLES_D + pairIdx(a, b);
        prs.push({ a, b, v: c[i], s: support[i] });
      }
    }
    prs.sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    console.log(`\ntop pair features (|value| >= 1, support >= 50):`);
    for (const p of prs) {
      if (Math.abs(p.v) < 1 || p.s < 50) continue;
      console.log(`${(LETTERS[p.a] + LETTERS[p.b]).padStart(5)} ${p.v.toFixed(2).padStart(8)} ${String(p.s).padStart(7)}`);
    }
    const arr = [];
    for (let b = 0; b < 27; b++) for (let a = 0; a <= b; a++) arr[pairIdx(a, b)] = fmt(c[SINGLES_D + pairIdx(a, b)]);
    console.log(`\nconst ${N === 0 ? 'EG_LEAVE_PAIRS' : 'EG_LEAVE_BOARD_PAIRS'} = [ // pairIdx(a,b): a<=b -> b*(b+1)/2+a\n  ${arr.join(', ')}\n];`);
  }
  }
  console.log(`fit N=${N}${PAIRS ? '+pairs' : ''}: positions ${nRecords}, examples ${nExamples}, R^2 ${(1 - ssRes / ssTot).toFixed(3)}`);
  return { c, support, nRecords, nExamples };
}

async function runOut() {
  setMode(0, true);
  const A = await main();
  setMode(2, true);
  const Bf = await main();
  const fmt = v => +v.toFixed(2);
  const data = {
    v: 1,
    fit: { db: path.basename(BENCH), positions: Bf.nRecords, examples: Bf.nExamples },
    values: Array.from(A.c.slice(0, 27), fmt),
    pairs: Array.from(A.c.slice(27), fmt),
    boardValues: Array.from({ length: 27 }, (_, t) => Array.from(Bf.c.slice(t * 3, t * 3 + 3), fmt)),
    boardPairs: Array.from(Bf.c.slice(27 * 3), fmt),
  };
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(data), { level: 9 }));
  console.log(`wrote ${OUT}`);
}

(OUT ? runOut() : main()).catch(e => { console.error(e); process.exit(1); });
