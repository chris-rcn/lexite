#!/usr/bin/env node
// Score endgame (bag=0) configurations against the oracle benchmark
// (oracle-gen-bag0.js). For each stored position, run each configured
// decider, look up the oracle value of the move it picks (pass included),
// and measure regret = (best oracle value) - (picked oracle value).
// Reports mean regret, % optimal, and decision-time p99 per config;
// uncovered picks (a move outside the stored top-M) are footnoted.
//
// Configs are realm-eval snippets, the same convention as
// oracle-regret.js --test (e.g. 'STAGES.bag0.movegenBudget = 3000;
// bag0.width = 16'). '0' is a no-op — untouched production
// caps. With no --test, scores prod and static play.
//
//   node tools/eval-bag0-strategy.js <oracle.jsonl> [--test CODE]...
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');

const BENCH = process.argv[2];
if (!BENCH || BENCH.startsWith('--')) {
  console.error('Usage: node tools/eval-bag0-strategy.js <oracle.jsonl> [--test CODE]...');
  process.exit(2);
}
const tests = [];
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--test') tests.push(process.argv[++i]);
}
if (tests.length === 0) {
  tests.push('0'); // prod: untouched production caps
  tests.push('STAGES.bag0.static = true'); // static play
}

function decodeBoard(s) {
  const b = Array.from({ length: 15 }, () => new Array(15).fill(null));
  for (let i = 0; i < 225; i++) {
    const ch = s[i]; if (ch === '.') continue;
    const L = ch.toUpperCase();
    b[Math.floor(i / 15)][i % 15] = { letter: L, isBlank: ch >= 'a' && ch <= 'z', displayLetter: L };
  }
  return b;
}
const rackArr = s => [...s].map(ch => ({ letter: ch, isBlank: ch === '?' }));

const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const engines = tests.map(code => {
  const E = m.loadEngine(ENGINE, words, {});
  E.evalInRealm(`ensureTrie(); ensureLeaveTables(); ${m.stagesEval(code)};
    globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
    globalThis.__pick = async function () {
      state.board = JSON.parse(__B); state.isFirstMove = false; state.bag = [];
      const rack = JSON.parse(__R).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
      const mv = await findBestMove(rack);
      if (!mv || !mv.placements) return JSON.stringify({ sig: 'pass' });
      return JSON.stringify({ sig: __moveKey(mv.placements), score: mv.score, placements: mv.placements });
    };`);
  return E;
});

// Reference realm for on-demand solves of uncovered picks (a chosen move
// outside the stored arms): value that single move under the oracle's own
// caps, so every pick gets graded and Uncovered stays at zero. Loaded
// lazily — most runs never need it.
let refRealm = null;
function refValue(header, bJson, rJson, pick) {
  if (!refRealm) {
    refRealm = m.loadEngine(ENGINE, words, {});
    refRealm.evalInRealm(`ensureTrie(); ensureLeaveTables();
      STAGES.bag0.movegenBudget = ${header.ref.budget};
      STAGES.bag0.width = ${header.ref.width};
      STAGES.bag0.depth = ${header.ref.depth};
      STAGES.bag0.order = ${header.ref.order || 0};
      globalThis.__refValue = function () {
        state.board = JSON.parse(__B); state.isFirstMove = false; state.bag = [];
        EG_TT = ${header.ref.tt ? 'new Map()' : 'null'};
        if (EG_TT) egRecomputeBoardHash();
        const rack = JSON.parse(__R).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
        const pick = JSON.parse(__P);
        const oppRack = deriveOpponentRack(rack);
        const newRack = rackWithout(rack, pick.placements);
        if (newRack.length === 0) return pick.score + 2 * rackValueOf(oppRack);
        const budget = { used: 0 };
        applyToBoard(pick.placements);
        try {
          return pick.score - endgameSearch(oppRack, newRack, 0, 1, -Infinity, Infinity, budget);
        } finally {
          removeFromBoard(pick.placements);
        }
      };`);
  }
  refRealm._sandbox.__B = bJson;
  refRealm._sandbox.__R = rJson;
  refRealm._sandbox.__P = JSON.stringify(pick);
  return refRealm.evalInRealm('__refValue()');
}

async function main() {
  const lines = fs.readFileSync(BENCH, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  const records = lines.slice(1).map(l => JSON.parse(l));
  if (header.egWeightsMd5) {
    const crypto = require('crypto');
    const egPath = path.join(__dirname, '..', 'endgame-leaves.json.gz');
    const cur = fs.existsSync(egPath) ? crypto.createHash('md5').update(fs.readFileSync(egPath)).digest('hex') : 'none';
    if (cur !== header.egWeightsMd5) {
      console.log(`NOTE: endgame leave model differs from the one this benchmark was generated under (${header.egWeightsMd5.slice(0, 8)} vs ${cur.slice(0, 8)}) — stored values are a fixed reference, but on-demand solves use the current model.`);
    }
  }
  console.log(`Benchmark: ${BENCH} (${records.length} positions, oracle budget ${header.ref.budget}, width ${header.ref.width}, depth ${header.ref.depth}, top-${header.ref.topM})`);
  tests.forEach((t, i) => console.log(`  T${i}: ${t}`));
  console.log('');
  console.log(`${'pos'.padStart(7)} ` +
    tests.map((_, i) => `${('T' + i + ' regret').padStart(10)} ${'SE'.padStart(6)} ${'opt%'.padStart(6)} ${'p99ms'.padStart(6)}`).join(' ') +
    ` ${'elapsed'.padStart(9)}`);

  const msCounts = tests.map(() => []);
  const msTotals = tests.map(() => 0);
  const p99 = i => {
    let need = Math.ceil(0.99 * msTotals[i]), acc = 0;
    for (let ms = 0; ms < msCounts[i].length; ms++) { acc += msCounts[i][ms] || 0; if (acc >= need) return ms; }
    return 0;
  };
  const regrets = tests.map(() => []);
  const optimal = tests.map(() => 0);
  const uncovered = tests.map(() => 0); // ref-solved on demand
  const unsolved = tests.map(() => 0); // ref solve aborted (excluded)
  // Oracle-beaten telemetry: a pick whose on-demand reference value
  // exceeds the record's stored best is a caught oracle error (negative
  // regret) — the direct measure of reference quality the eval gets for
  // free. Stored-arm picks can never exceed best by construction.
  const beaten = tests.map(() => 0);
  const beatenMax = tests.map(() => 0);
  let done = 0;
  const t0 = Date.now();
  let hb = 25, hbAt = 25;
  const printRow = () => {
    const cols = tests.map((_, i) => {
      const r = regrets[i];
      if (!r.length) return `${'—'.padStart(10)} ${'—'.padStart(6)} ${'—'.padStart(6)} ${'—'.padStart(6)}`;
      const mean = r.reduce((a, x) => a + x, 0) / r.length;
      const sd = r.length > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (r.length - 1)) : 0;
      return `${mean.toFixed(3).padStart(10)} ${(sd / Math.sqrt(r.length)).toFixed(3).padStart(6)} ${(100 * optimal[i] / r.length).toFixed(1).padStart(6)} ${String(p99(i)).padStart(6)}`;
    }).join(' ');
    console.log(`${String(done).padStart(7)} ${cols} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
  };

  for (const rec of records) {
    const bJson = JSON.stringify(decodeBoard(rec.b));
    const rJson = JSON.stringify(rackArr(rec.r));
    const bySig = new Map(rec.e);
    bySig.set('pass', rec.p);
    const best = Math.max(rec.p, ...rec.e.map(x => x[1]));
    for (let i = 0; i < engines.length; i++) {
      engines[i]._sandbox.__B = bJson;
      engines[i]._sandbox.__R = rJson;
      const t = Date.now();
      const pick = JSON.parse(await engines[i].evalInRealm('__pick()'));
      const ms = Date.now() - t;
      msCounts[i][ms] = (msCounts[i][ms] || 0) + 1;
      msTotals[i]++;
      let v = bySig.get(pick.sig);
      if (v === undefined) {
        // Below-the-line pick: solve it under the oracle's caps on demand.
        // Negative regret is possible and meaningful (the pick beat the
        // record's stored best — a containment escape worth noticing).
        try { v = refValue(header, bJson, rJson, pick); uncovered[i]++; }
        catch (e) { unsolved[i]++; continue; }
      }
      if (v - best > 1e-9) { beaten[i]++; beatenMax[i] = Math.max(beatenMax[i], v - best); }
      regrets[i].push(best - v);
      if (best - v < 1e-9) optimal[i]++;
    }
    done++;
    if (done >= hbAt) { printRow(); hb = Math.min(hb * 1.5, 2000); hbAt = done + hb; }
  }
  printRow();
  console.log(`\nUncovered picks ref-solved: ${uncovered.map((u, i) => `T${i}:${u}`).join(" ")}  (unsolved, excluded: ${unsolved.map((u, i) => `T${i}:${u}`).join(" ")})`);
  console.log(`Oracle beaten (pick > stored best): ${beaten.map((b, i) => `T${i}:${b}${b ? ` (max +${beatenMax[i].toFixed(1)})` : ""}`).join(" ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
