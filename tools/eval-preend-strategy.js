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
      if (!mv || !mv.placements) return JSON.stringify({ sig: 'pass' });
      return JSON.stringify({ sig: __moveKey(mv.placements), score: mv.score, placements: mv.placements });
    };`);
  return E;
});

// On-demand reference solve of an uncovered pick: replicate the
// builder's construction for a single candidate — enumerate every
// (opponent rack | bag) split, solve each post-move empty-bag position
// at the collection's stamped solver shape, average. Returns the value,
// or 'noempty' (the move cannot empty the bag: unpriceable in this
// collection's currency) or 'capped' (a split overran the budget).
let refRealm = null;
function refValue(meta, bJson, rackStr, poolStr, pick) {
  if (!meta.solver || !meta.solver.width) return 'legacy';
  if (!refRealm) {
    refRealm = m.loadEngine(ENGINE, words, {});
    refRealm.evalInRealm(`ensureTrie(); ensureLeaveTables();
      STAGES.bag0.movegenBudget = ${meta.solver.budget};
      STAGES.bag0.width = ${meta.solver.width};
      STAGES.bag0.width1 = 0;
      STAGES.bag0.width2 = 0;
      STAGES.bag0.depth = ${meta.solver.depth || 0};
      STAGES.bag0.order = ${meta.solver.order};
      const BAG = ${meta.bagSize};
      globalThis.__refValue = function () {
        state.board = JSON.parse(__B); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
        const rack = [...__R].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
        const pool = [...__POOL].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
        const pick = JSON.parse(__P);
        const leave = rackWithout(rack, pick.placements);
        if (leave.length > 0 && Math.min(7 - leave.length, BAG) < BAG) return 'noempty';
        const subsets = indexSubsets(pool.length, BAG);
        EG_TT = new Map();
        egRecomputeBoardHash();
        const budget = { used: 0 };
        const boardSnap = state.board.map(r => r.slice());
        applyToBoard(pick.placements);
        try {
          let ev = 0;
          for (const sub of subsets) {
            const inBag = new Array(pool.length).fill(false);
            for (const i of sub) inBag[i] = true;
            const oppRack = pool.filter((_, k) => !inBag[k]);
            let v;
            if (leave.length === 0) {
              v = pick.score + 2 * rackValueOf(oppRack);
            } else {
              const myRack = leave.concat(sub.map(i => pool[i]));
              budget.used = 0;
              try {
                v = pick.score - endgameSearch(oppRack, myRack, 0, 1, -Infinity, Infinity, budget);
              } catch (e) {
                if (e !== ENDGAME_ABORT) throw e;
                state.board = boardSnap;
                egRecomputeBoardHash();
                return 'capped';
              }
            }
            ev += v;
          }
          return ev / subsets.length;
        } finally {
          removeFromBoard(pick.placements);
          EG_TT = null;
        }
      };`);
  }
  refRealm._sandbox.__B = bJson;
  refRealm._sandbox.__R = rackStr;
  refRealm._sandbox.__POOL = poolStr;
  refRealm._sandbox.__P = JSON.stringify(pick);
  return refRealm.evalInRealm('__refValue()');
}

async function main() {
  const solver = coll.meta.solver || { budget: coll.meta.budget };
  console.log(`Benchmark: ${COLL} (${coll.entries.length} positions, bag ${BAG} -> stage ${STG}, solver budget ${solver.budget}${solver.width ? `, width ${solver.width}, terminal` : ' (legacy reference)'}, top-${coll.meta.candidates})`);
  if (coll.meta.egWeightsMd5) {
    const crypto = require('crypto');
    const egPath = path.join(__dirname, '..', 'endgame-leaves.json.gz');
    const cur = fs.existsSync(egPath) ? crypto.createHash('md5').update(fs.readFileSync(egPath)).digest('hex') : 'none';
    if (cur !== coll.meta.egWeightsMd5) {
      console.log(`NOTE: endgame leave model differs from the one this collection was solved under (${coll.meta.egWeightsMd5.slice(0, 8)} vs ${cur.slice(0, 8)}).`);
    }
  }
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
  const unsolved = tests.map(() => 0); // legacy meta / noempty / capped: excluded
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

  for (const e of coll.entries) {
    const bJson = JSON.stringify(decodeBoard(e.b));
    const rJson = JSON.stringify(rackArr(e.r));
    const bySig = new Map(e.m.map(r => [r.k, r.ex]));
    const best = Math.max(...e.m.map(r => r.ex));
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
        const rv = pick.placements ? refValue(coll.meta, bJson, e.r, e.p, pick) : 'pass';
        if (typeof rv !== 'number') { unsolved[i]++; continue; }
        v = rv;
        uncovered[i]++;
        if (v - best > 1e-6) { beaten[i]++; beatenMax[i] = Math.max(beatenMax[i], v - best); }
      }
      regrets[i].push(best - v);
      if (best - v < 1e-6) optimal[i]++;
    }
    done++;
    if (done >= hbAt) { printRow(); hb = Math.min(hb * 1.5, 2000); hbAt = done + hb; }
  }
  printRow();
  console.log(`\nUncovered picks ref-solved: ${uncovered.map((u, i) => `T${i}:${u}`).join(' ')}  (unsolved, excluded: ${unsolved.map((u, i) => `T${i}:${u}`).join(' ')})`);
  console.log(`Solver beaten (pick > stored best): ${beaten.map((b, i) => `T${i}:${b}${b ? ` (max +${beatenMax[i].toFixed(1)})` : ''}`).join(' ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
