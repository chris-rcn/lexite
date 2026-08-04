// Assemble a durable benchmark of EXACT pre-endgame solves for a given bag
// size. For each position where the mover faces exactly `bagSize` tiles in the
// bag (static self-play, any score differential), compute the exact
// probability-weighted endgame-solver value of every top-K candidate move: the
// unseen pool (opponent rack + bag) is known up to which tiles are in the bag,
// so enumerate every (opponent rack | bag) split, play the candidate, deal the
// drawn bag tiles, and score the resulting empty-bag position with the exact
// endgame solver. An approximate strategy is later scored by looking up the
// exact value of the move it picks (see eval-preend-strategy.js). Only positions
// whose candidates all reach an empty bag and solve within budget are kept
// (clean truth). Resumable; appends to a compact JSON file.
//
// A candidate that would not empty the bag (plays too few tiles to draw the
// whole bag down to zero) can't be scored by the bag-0 solver, so such a
// position is dropped — the set is therefore biased toward positions whose top
// moves all play enough tiles to reach the endgame. bagSize=1 reproduces the
// bag1-exact-solves collection exactly.
//
//   node tools/build-preend-solves.js [out.json] [seeds] [baseSeed] [K] [budget] [bagSize]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const OUT = process.argv[2] || path.join(__dirname, 'preend-solves.json');
const SEEDS = parseInt(process.argv[3] || '20000', 10);
const BASE_SEED = parseInt(process.argv[4] || '862000', 10);
const K = parseInt(process.argv[5] || '8', 10);
const BUDGET = parseInt(process.argv[6] || '300000', 10);
const BAG = parseInt(process.argv[7] || '2', 10);

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
P.evalInRealm('STAGES.bag0.static = true;'); // fast position generation
const Q = m.loadEngine(ENGINE, words, {});
Q.evalInRealm(`
  ensureTrie(); ensureLeaveTables();
  const BAG = ${BAG};
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
  globalThis.__exact = async function (boardJson, rackJson) {
    state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
    const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    const pool = deriveOpponentRack(rack);            // opponent rack + bag tiles
    const oppSize = pool.length - BAG;
    if (oppSize < 0 || pool.length < BAG) return JSON.stringify({ skip: 1 });
    const cands = await collectTopCandidates(rack, { candidates: ${K}, margin: 0 });
    if (cands.length < 2) return JSON.stringify({ skip: 1 });
    const subsets = indexSubsets(pool.length, BAG);   // which BAG pool tiles are in the bag
    const wgt = 1 / subsets.length;
    const savedB = STAGES.bag0.movegenBudget; STAGES.bag0.movegenBudget = ${BUDGET};
    const budget = { used: 0 }; const boardSnap = state.board.map(r => r.slice());
    const results = []; let allSolved = true;
    try {
      for (const c of cands) {
        const leave = rackWithout(rack, c.m.placements);
        // The move must draw the whole bag to empty; otherwise the post-move
        // position is itself a pre-endgame the bag-0 solver can't score.
        if (leave.length > 0 && Math.min(7 - leave.length, BAG) < BAG) { allSolved = false; break; }
        applyToBoard(c.m.placements);
        let ev = 0, ok = true;
        for (const sub of subsets) {
          const inBag = new Array(pool.length).fill(false);
          for (const i of sub) inBag[i] = true;
          const oppRack = pool.filter((_, k) => !inBag[k]);
          // A move that empties the bag refills my rack to leave + the drawn bag
          // tiles (even a 7-tile play does NOT go out at bag>=1 — it draws the
          // last bag tile(s) and keeps playing), and it becomes the opponent's
          // turn at bag 0. So every candidate is scored by the endgame solver on
          // the resulting empty-bag position.
          const myRack = leave.concat(sub.map(i => pool[i])); budget.used = 0;
          let v;
          try { v = c.m.score - endgameSearch(oppRack, myRack, 0, 1, -Infinity, Infinity, budget); }
          catch (e) { if (e !== ENDGAME_ABORT) throw e; state.board = boardSnap; ok = false; break; }
          ev += v;
        }
        removeFromBoard(c.m.placements);
        if (!ok) { allSolved = false; break; }
        results.push({ k: __moveKey(c.m.placements), w: c.m.word, sc: c.m.score, sv: +c.val.toFixed(1), ex: +(ev * wgt).toFixed(2) });
      }
    } finally { STAGES.bag0.movegenBudget = savedB; }
    return JSON.stringify({ pool: pool.map(t => t.isBlank ? '?' : t.letter.toUpperCase()).join(''), results, allSolved });
  };
`);

let coll = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8'))
  : { meta: { bagSize: BAG, candidates: K, budget: BUDGET, baseSeed: BASE_SEED }, scanned: 0, entries: [] };
function save() { fs.writeFileSync(OUT + '.tmp', JSON.stringify(coll)); fs.renameSync(OUT + '.tmp', OUT); }

(async () => {
  for (let p = coll.scanned; p < SEEDS; p++) {
    let snap = null;
    const onPos = (board, bag, f, rack) => { if (bag.length === BAG && !snap) snap = { board: board.map(r => r.slice()), rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })) }; };
    await m.playGame([P, P], m.buildSeededBag(m.mulberry32(BASE_SEED + p)), false, '', onPos);
    coll.scanned = p + 1;
    if (snap) {
      const r = JSON.parse(await Q.evalInRealm(`__exact(${JSON.stringify(JSON.stringify(snap.board))}, ${JSON.stringify(JSON.stringify(snap.rack))})`));
      if (!r.skip && r.allSolved) coll.entries.push({ b: encodeBoard(snap.board), r: rackStr(snap.rack), p: r.pool, m: r.results });
    }
    save();
    if (coll.scanned % 20 === 0) console.log(`scanned ${coll.scanned}/${SEEDS} | ${coll.entries.length} exact bag=${BAG} solves`);
  }
  console.log(`DONE | scanned ${coll.scanned} | ${coll.entries.length} exact bag=${BAG} solves -> ${OUT}`);
})();
