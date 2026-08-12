#!/usr/bin/env node
// Score pre-endgame configurations against an exact-solve benchmark (any
// bag size — bag1-exact-solves.json, bag2-exact-solves.json, the
// bagN-approx-solves.json family; the bag size is read from the
// collection meta and the config applies to whatever stage that bag
// routes to). For each stored position, run each configured decider, look
// up the exact value of the move it picks, and measure regret =
// (best exact) - (picked exact). Reports mean regret, % optimal, and
// decision-time p99 per config; picks outside the stored candidates are
// footnoted as uncovered.
//
// Configs are realm-eval snippets, the same convention as
// oracle-regret.js / eval-bag0-strategy.js --test. '0' is a no-op —
// the stage's untouched production config. With no --test, scores prod
// and static play. Example (a clean 10-world 6-candidate terminal sim
// on the bag2 stage):
//   --test 'STAGES.bag2.static = false; STAGES.bag2.mode = "terminal";
//           STAGES.bag2.enumerate = false; STAGES.bag2.samples = 10;
//           STAGES.bag2.candidates = 6; STAGES.bag2.margin = 0;
//           STAGES.bag2.bayes = 0'
//
//   node tools/eval-preend-strategy.js <solves.json> [--test CODE]...
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');

const COLL = process.argv[2];
if (!COLL || COLL.startsWith('--')) {
  console.error('Usage: node tools/eval-preend-strategy.js <solves.json> [--test CODE]...');
  process.exit(2);
}
const tests = [];
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--test') tests.push(process.argv[++i]);
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
const rackArr = s => [...s].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));

const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const coll = JSON.parse(fs.readFileSync(COLL, 'utf8'));
const BAG = coll.meta.bagSize;
const probe = m.loadEngine(ENGINE, words, {});
const STG = probe.evalInRealm(`ensureTrie(); stageFor(${BAG})`);
if (tests.length === 0) {
  tests.push('0'); // prod: the stage's untouched production config
  tests.push(`STAGES.${STG}.static = true`); // static play
}

const engines = tests.map(code => {
  const E = m.loadEngine(ENGINE, words, {});
  E.evalInRealm(`ensureTrie(); ensureLeaveTables(); ${m.stagesEval(code)};
    globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
    globalThis.__pick = async function () {
      state.board = JSON.parse(__B); state.isFirstMove = false; state.bag = new Array(${BAG}).fill('?');
      const rack = JSON.parse(__R).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
      const mv = await findBestMove(rack);
      return mv && mv.placements ? __moveKey(mv.placements) : 'pass';
    };`);
  return E;
});

async function main() {
  console.log(`Benchmark: ${COLL} (${coll.entries.length} positions, bag ${BAG} -> stage ${STG}, solve budget ${coll.meta.budget}, top-${coll.meta.candidates})`);
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
  const uncovered = tests.map(() => 0);
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

  for (const e of coll.entries) {
    const bJson = JSON.stringify(decodeBoard(e.b));
    const rJson = JSON.stringify(rackArr(e.r));
    const bySig = new Map(e.m.map(r => [r.k, r.ex]));
    const best = Math.max(...e.m.map(r => r.ex));
    for (let i = 0; i < engines.length; i++) {
      engines[i]._sandbox.__B = bJson;
      engines[i]._sandbox.__R = rJson;
      const t = Date.now();
      const sig = await engines[i].evalInRealm('__pick()');
      const ms = Date.now() - t;
      msCounts[i][ms] = (msCounts[i][ms] || 0) + 1;
      msTotals[i]++;
      const v = bySig.get(sig);
      if (v === undefined) { uncovered[i]++; continue; }
      regrets[i].push(best - v);
      if (best - v < 1e-6) optimal[i]++;
    }
    done++;
    if (done >= hbAt) { printRow(); hb = Math.min(hb * 1.5, 2000); hbAt = done + hb; }
  }
  printRow();
  console.log(`\nUncovered choices: ${uncovered.map((u, i) => `T${i}:${u}`).join(' ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
