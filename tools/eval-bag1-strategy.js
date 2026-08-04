// Score an approximate bag=1 strategy against the exact-solve benchmark. For
// each stored position, run the strategy, look up the exact value of the move
// it picks, and measure regret = (best exact) - (picked exact). Reports mean
// regret, % optimal, and off-benchmark picks (a move not among the stored
// candidates). Strategy specs:
//   static        static move generator
//   sim:S:C       terminal simulation, S samples, C candidates, margin 0, gate 0
//   simt:S:C:B    truncated terminal sim, node budget B per decision (0=unlimited)
//   solver:C:B    exact solver pre-endgame, C candidates, per-solve budget B
//
//   node tools/eval-bag1-strategy.js [collection.json] [spec]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const COLL = process.argv[2] || path.join(__dirname, 'bag1-exact-solves.json');
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
const E = m.loadEngine(ENGINE, words, {});
let setup = `LOWBAG_AT = 2; STAGES.midgame.static = true; ensureTrie(); ensureLeaveTables();
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');`;
if (SPEC === 'static') setup += `STAGES.lowbag.static = true;`;
else if (SPEC.startsWith('simt:')) { const [, S, C, B] = SPEC.split(':');
  setup += `STAGES.lowbag.static = false; STAGES.lowbag.mode = 'terminal'; STAGES.lowbag.samples = ${+S};
    STAGES.lowbag.candidates = ${+C}; STAGES.lowbag.margin = 0; STAGES.lowbag.confidence = 0;
    STAGES.lowbag.movegenBudget = ${+B};`; }
else if (SPEC.startsWith('sim:')) { const [, S, C] = SPEC.split(':');
  setup += `STAGES.lowbag.static = false; STAGES.lowbag.mode = 'terminal'; STAGES.lowbag.samples = ${+S};
    STAGES.lowbag.candidates = ${+C}; STAGES.lowbag.margin = 0; STAGES.lowbag.confidence = 0;
    STAGES.lowbag.movegenBudget = 0;`; }
else if (SPEC.startsWith('solver:')) { const [, C, B] = SPEC.split(':');
  setup += `STAGES.lowbag.static = false; STAGES.lowbag.mode = 'solver'; STAGES.lowbag.candidates = ${+C};
    STAGES.lowbag.margin = 0; STAGES.lowbag.preendBudget = ${+B};`; }
else throw new Error('unknown spec: ' + SPEC);
E.evalInRealm(setup);
E.evalInRealm(`globalThis.__pick = async function(boardJson, rackJson){
  state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(1).fill('?');
  const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
  const mv = await findBestMove(rack);
  return mv && mv.placements ? __moveKey(mv.placements) : '(none)';
};`);

(async () => {
  let n = 0, sumReg = 0, optimal = 0, off = 0;
  for (const e of coll.entries) {
    const best = Math.max(...e.m.map(r => r.ex));
    const boardJson = JSON.stringify(decodeBoard(e.b));
    const rackJson = JSON.stringify(rackArr(e.r).map(t => ({ letter: t.letter, isBlank: t.isBlank })));
    const key = await E.evalInRealm(`__pick(${JSON.stringify(boardJson)}, ${JSON.stringify(rackJson)})`);
    const hit = e.m.find(r => r.k === key);
    n++;
    if (!hit) { off++; continue; }
    sumReg += best - hit.ex;
    if (best - hit.ex < 1e-6) optimal++;
  }
  const scored = n - off;
  console.log(`strategy ${SPEC} | positions ${n} | scored ${scored} off-benchmark ${off}`);
  console.log(`mean regret ${(sumReg / Math.max(1, scored)).toFixed(2)} pts | optimal ${(100 * optimal / Math.max(1, scored)).toFixed(0)}%`);
})();
