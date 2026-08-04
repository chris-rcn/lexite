// Score an approximate pre-endgame strategy against an exact-solve benchmark
// (any bag size). For each stored position, run the strategy, look up the exact
// value of the move it picks, and measure regret = (best exact) - (picked
// exact). Reports mean regret, % optimal, off-benchmark picks (a move not among
// the stored candidates), and per-decision timing. The bag size is read from
// the collection meta; the strategy is applied to whatever stage bag routes to.
// Strategy specs:
//   static        static move generator
//   enum:C        exact world enumeration (no sampling), C candidates
//   sim:S:C       terminal sim, S sampled worlds, C candidates, margin 0, gate 0
//   simp:S:C:M    like sim, but pruning starts after M worlds (M>=S = no pruning)
//   simb:S:C:P    Bayesian sim: static-anchored prior, priorSd P (small=strong)
//   simt:S:C:B    truncated terminal sim, node budget B per decision
//   solver:C:B    exact solver pre-endgame, C candidates, per-solve budget B
//
//   node tools/eval-preend-strategy.js [collection.json] [spec]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const COLL = process.argv[2] || path.join(__dirname, 'bag2-exact-solves.json');
const SPEC = process.argv[3] || 'static';

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

const coll = JSON.parse(fs.readFileSync(COLL, 'utf8'));
const BAG = coll.meta.bagSize;
const E = m.loadEngine(ENGINE, words, {});
// Which stage does a bag of this size route to? Configure that stage.
const STG = E.evalInRealm(`ensureTrie(); ensureLeaveTables(); stageFor(${BAG})`);
// Clean baseline so a stage's production defaults (e.g. preendgame's enumerate)
// don't leak into the sampling specs.
let setup = `STAGES.${STG}.enumerate = false; STAGES.${STG}.bayes = 0; STAGES.${STG}.confidence = 0;
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');`;
if (SPEC === 'static') setup += `STAGES.${STG}.static = true;`;
else if (SPEC.startsWith('simt:')) { const [, S, C, B] = SPEC.split(':');
  setup += `STAGES.${STG}.static = false; STAGES.${STG}.mode = 'terminal'; STAGES.${STG}.samples = ${+S};
    STAGES.${STG}.candidates = ${+C}; STAGES.${STG}.margin = 0; STAGES.${STG}.movegenBudget = ${+B};`; }
else if (SPEC.startsWith('enum:')) { const [, C] = SPEC.split(':');
  setup += `STAGES.${STG}.static = false; STAGES.${STG}.mode = 'terminal'; STAGES.${STG}.enumerate = true;
    STAGES.${STG}.samples = 4096; STAGES.${STG}.candidates = ${+C}; STAGES.${STG}.margin = 0;
    STAGES.${STG}.movegenBudget = 0;`; }
else if (SPEC.startsWith('simb:')) { const [, S, C, P] = SPEC.split(':');
  setup += `STAGES.${STG}.static = false; STAGES.${STG}.mode = 'terminal'; STAGES.${STG}.samples = ${+S};
    STAGES.${STG}.candidates = ${+C}; STAGES.${STG}.margin = 0; STAGES.${STG}.movegenBudget = 0;
    STAGES.${STG}.bayes = 1; STAGES.${STG}.priorSd = ${+P}; STAGES.${STG}.overruleP = 0.5;`; }
else if (SPEC.startsWith('simp:')) { const [, S, C, M] = SPEC.split(':');
  setup += `STAGES.${STG}.static = false; STAGES.${STG}.mode = 'terminal'; STAGES.${STG}.samples = ${+S};
    STAGES.${STG}.candidates = ${+C}; STAGES.${STG}.margin = 0; STAGES.${STG}.movegenBudget = 0;
    STAGES.${STG}.minWorlds = ${+M};`; } // pruning starts after M worlds (M>=S disables it)
else if (SPEC.startsWith('sim:')) { const [, S, C] = SPEC.split(':');
  setup += `STAGES.${STG}.static = false; STAGES.${STG}.mode = 'terminal'; STAGES.${STG}.samples = ${+S};
    STAGES.${STG}.candidates = ${+C}; STAGES.${STG}.margin = 0; STAGES.${STG}.movegenBudget = 0;`; }
else if (SPEC.startsWith('solver:')) { const [, C, B] = SPEC.split(':');
  setup += `STAGES.${STG}.static = false; STAGES.${STG}.mode = 'solver'; STAGES.${STG}.candidates = ${+C};
    STAGES.${STG}.margin = 0; STAGES.${STG}.preendBudget = ${+B};`; }
else throw new Error('unknown spec: ' + SPEC);
E.evalInRealm(setup);
E.evalInRealm(`globalThis.__pick = async function(boardJson, rackJson){
  state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(${BAG}).fill('?');
  const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
  const mv = await findBestMove(rack);
  return mv && mv.placements ? __moveKey(mv.placements) : '(none)';
};`);

(async () => {
  let n = 0, sumReg = 0, optimal = 0, off = 0, sumMs = 0;
  const times = [];
  for (const e of coll.entries) {
    const best = Math.max(...e.m.map(r => r.ex));
    const boardJson = JSON.stringify(decodeBoard(e.b));
    const rackJson = JSON.stringify(rackArr(e.r).map(t => ({ letter: t.letter, isBlank: t.isBlank })));
    const t0 = process.hrtime.bigint();
    const key = await E.evalInRealm(`__pick(${JSON.stringify(boardJson)}, ${JSON.stringify(rackJson)})`);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    sumMs += ms; times.push(ms);
    const hit = e.m.find(r => r.k === key);
    n++;
    if (!hit) { off++; continue; }
    sumReg += best - hit.ex;
    if (best - hit.ex < 1e-6) optimal++;
  }
  const scored = n - off;
  times.sort((a, b) => a - b);
  const q = p => times[Math.floor(p * (times.length - 1))];
  console.log(`strategy ${SPEC} | bag ${BAG} (stage ${STG}) | positions ${n} | scored ${scored} off-benchmark ${off}`);
  console.log(`mean regret ${(sumReg / Math.max(1, scored)).toFixed(2)} pts | optimal ${(100 * optimal / Math.max(1, scored)).toFixed(0)}%`);
  console.log(`decision time: mean ${(sumMs / n).toFixed(1)} ms | p50 ${q(.5).toFixed(1)} | p90 ${q(.9).toFixed(1)} | p99 ${q(.99).toFixed(1)} | max ${q(1).toFixed(1)} | total ${(sumMs / 1000).toFixed(1)} s`);
})();
