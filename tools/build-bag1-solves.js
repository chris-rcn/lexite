// Assemble a durable benchmark of EXACT bag=1 solves. For each bag=1 position
// (static self-play, any score differential), compute the exact
// probability-weighted endgame-solver value of every top-K candidate move (all
// bag splits enumerated); store the position plus each candidate's exact value.
// An approximate strategy is later scored by looking up the exact value of the
// move it picks (see eval-bag1-strategy.js). Only positions whose candidates all
// solve within budget are kept. Resumable; appends to a compact JSON file.
//
//   node tools/build-bag1-solves.js [out.json] [seeds] [baseSeed] [K] [budget]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const OUT = process.argv[2] || path.join(__dirname, 'bag1-exact-solves.json');
const SEEDS = parseInt(process.argv[3] || '20000', 10);
const BASE_SEED = parseInt(process.argv[4] || '862000', 10);
const K = parseInt(process.argv[5] || '8', 10);
const BUDGET = parseInt(process.argv[6] || '300000', 10);

// Compact board <-> 225-char string ('.' empty, UPPER normal tile, lower blank).
function encodeBoard(board) {
  let s = '';
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const cell = board[r][c];
    s += !cell ? '.' : (cell.isBlank ? cell.letter.toLowerCase() : cell.letter.toUpperCase());
  }
  return s;
}
const rackStr = rack => rack.map(t => t.isBlank ? '?' : t.letter.toUpperCase()).join('');

const P = m.loadEngine(ENGINE, words, { staticOnly: true });
P.evalInRealm('STAGES.endgame.static = true;'); // fast position generation
const Q = m.loadEngine(ENGINE, words, {});
Q.evalInRealm(`
  ensureTrie(); ensureLeaveTables();
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
  globalThis.__exact = async function (boardJson, rackJson) {
    state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(1).fill('?');
    const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    const pool = deriveOpponentRack(rack);
    const oppSize = pool.length - 1;
    if (oppSize < 0 || pool.length < 1) return JSON.stringify({ skip: 1 });
    const cands = await collectTopCandidates(rack, { candidates: ${K}, margin: 0 });
    if (cands.length < 2) return JSON.stringify({ skip: 1 });
    const subsets = indexSubsets(pool.length, 1);
    const wgt = 1 / subsets.length;
    const savedB = STAGES.endgame.movegenBudget; STAGES.endgame.movegenBudget = ${BUDGET};
    const budget = { used: 0 }; const boardSnap = state.board.map(r => r.slice());
    const results = []; let allSolved = true;
    try {
      for (const c of cands) {
        const leave = rackWithout(rack, c.m.placements);
        if (leave.length > 0 && Math.min(7 - leave.length, 1) < 1) { allSolved = false; break; }
        applyToBoard(c.m.placements);
        let ev = 0, ok = true;
        for (const sub of subsets) {
          const oppRack = pool.filter((_, k) => k !== sub[0]);
          let v;
          if (leave.length === 0) v = c.m.score + 2 * rackValueOf(oppRack);
          else {
            const myRack = leave.concat([pool[sub[0]]]); budget.used = 0;
            try { v = c.m.score - endgameSearch(oppRack, myRack, 0, 1, -Infinity, Infinity, budget); }
            catch (e) { if (e !== ENDGAME_ABORT) throw e; state.board = boardSnap; ok = false; break; }
          }
          ev += v;
        }
        removeFromBoard(c.m.placements);
        if (!ok) { allSolved = false; break; }
        results.push({ k: __moveKey(c.m.placements), w: c.m.word, sc: c.m.score, sv: +c.val.toFixed(1), ex: +(ev * wgt).toFixed(2) });
      }
    } finally { STAGES.endgame.movegenBudget = savedB; }
    return JSON.stringify({ pool: pool.map(t => t.isBlank ? '?' : t.letter.toUpperCase()).join(''), results, allSolved });
  };
`);

let coll = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8'))
  : { meta: { bagSize: 1, candidates: K, budget: BUDGET, baseSeed: BASE_SEED }, scanned: 0, entries: [] };
function save() { fs.writeFileSync(OUT + '.tmp', JSON.stringify(coll)); fs.renameSync(OUT + '.tmp', OUT); }

(async () => {
  for (let p = coll.scanned; p < SEEDS; p++) {
    let snap = null;
    const onPos = (board, bag, f, rack) => { if (bag.length === 1 && !snap) snap = { board: board.map(r => r.slice()), rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })) }; };
    await m.playGame([P, P], m.buildSeededBag(m.mulberry32(BASE_SEED + p)), false, '', onPos);
    coll.scanned = p + 1;
    if (snap) {
      const r = JSON.parse(await Q.evalInRealm(`__exact(${JSON.stringify(JSON.stringify(snap.board))}, ${JSON.stringify(JSON.stringify(snap.rack))})`));
      if (!r.skip && r.allSolved) coll.entries.push({ b: encodeBoard(snap.board), r: rackStr(snap.rack), p: r.pool, m: r.results });
    }
    save();
    if (coll.scanned % 20 === 0) console.log(`scanned ${coll.scanned}/${SEEDS} | ${coll.entries.length} exact bag=1 solves`);
  }
  console.log(`DONE | scanned ${coll.scanned} | ${coll.entries.length} exact bag=1 solves -> ${OUT}`);
})();
