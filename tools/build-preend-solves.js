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
//   node tools/build-preend-solves.js <out.json> [--seeds N] [--base-seed S]
//                                      [--candidates K] [--budget B]
//                                      [--bag-size N]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const OUT = process.argv[2];
if (!OUT || OUT.startsWith('--')) {
  console.error('Usage: node tools/build-preend-solves.js <out.json> [--seeds N] [--base-seed S] [--candidates K] [--budget B] [--bag-size N]');
  process.exit(2);
}
const flag = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const SEEDS = parseInt(flag('--seeds', '20000'), 10);
const BASE_SEED = parseInt(flag('--base-seed', '862000'), 10);
const K = parseInt(flag('--candidates', '8'), 10);
const BUDGET = parseInt(flag('--budget', '300000'), 10);
const BAG = parseInt(flag('--bag-size', '2'), 10);
// Reference solver shape (oracle standard): flat width-24 value-ordered
// beams, terminal depth, per-position transposition table. Stamped into
// the meta along with the endgame-leave-model hash; appending refuses on
// any mismatch.
const WIDTH = parseInt(flag('--width', '12'), 10);
const crypto = require('crypto');
const EG_PATH = path.join(__dirname, '..', 'endgame-leaves.json.gz');
const egWeightsMd5 = fs.existsSync(EG_PATH)
  ? crypto.createHash('md5').update(fs.readFileSync(EG_PATH)).digest('hex') : 'none';

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
  STAGES.bag0.width = ${WIDTH};
  STAGES.bag0.width1 = 0;   // fall through to width: flat reference beam
  STAGES.bag0.width2 = 0;
  STAGES.bag0.depth = 0;    // terminal
  STAGES.bag0.order = 1;
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
    // Per-position transposition table (worlds share candidate boards);
    // the hash is recomputed here and again after any abort restore.
    EG_TT = new Map();
    egRecomputeBoardHash();
    const budget = { used: 0 }; const boardSnap = state.board.map(r => r.slice());
    const results = []; let allSolved = true; let reason = null;
    try {
      for (const c of cands) {
        const leave = rackWithout(rack, c.m.placements);
        // The move must draw the whole bag to empty; otherwise the post-move
        // position is itself a pre-endgame the bag-0 solver can't score.
        if (leave.length > 0 && Math.min(7 - leave.length, BAG) < BAG) { allSolved = false; reason = 'noempty'; break; }
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
          catch (e) {
            if (e !== ENDGAME_ABORT) throw e;
            state.board = boardSnap; egRecomputeBoardHash(); ok = false; reason = 'capped'; break;
          }
          ev += v;
        }
        removeFromBoard(c.m.placements);
        if (!ok) { allSolved = false; break; }
        results.push({ k: __moveKey(c.m.placements), w: c.m.word, sc: c.m.score, sv: +c.val.toFixed(1), ex: +(ev * wgt).toFixed(2) });
      }
    } finally { STAGES.bag0.movegenBudget = savedB; }
    return JSON.stringify({ pool: pool.map(t => t.isBlank ? '?' : t.letter.toUpperCase()).join(''), results, allSolved, reason });
  };
`);

const META = {
  v: 3, // v3: candidate selection under the blended low-bag leave ordering
  bagSize: BAG, candidates: K, baseSeed: BASE_SEED,
  candidateOrder: 'blend',
  solver: { budget: BUDGET, width: WIDTH, depth: 0, order: 1, tt: 1 },
  egWeightsMd5,
};
let coll = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8'))
  : { meta: META, scanned: 0, entries: [] };
if (JSON.stringify(coll.meta) !== JSON.stringify(META)) {
  console.error('Existing collection has different solver parameters/weights; refusing to append.');
  process.exit(2);
}
function save() { fs.writeFileSync(OUT + '.tmp', JSON.stringify(coll)); fs.renameSync(OUT + '.tmp', OUT); }

(async () => {
  let saved = coll.entries.length;
  let capped = 0, dropped = 0, skipped = 0, missed = 0;
  let solveMs = 0, solveN = 0; // positions that reached the solver
  let hb = 1, hbAt = saved + 1;
  const t0 = Date.now();
  console.log(`${'seed'.padStart(8)} ${'saved'.padStart(7)} ${'capped'.padStart(7)} ${'drop'.padStart(6)} ${'skip'.padStart(6)} ${'miss'.padStart(6)} ${'avg/pos'.padStart(8)} ${'elapsed'.padStart(9)}`);
  const printRow = seed => console.log(
    `${String(seed).padStart(8)} ${String(saved).padStart(7)} ${String(capped).padStart(7)} ${String(dropped).padStart(6)} ${String(skipped).padStart(6)} ${String(missed).padStart(6)} ${(solveN ? (solveMs / solveN / 1000).toFixed(1) + 's' : '—').padStart(8)} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
  let lastSeed = BASE_SEED;
  for (let p = coll.scanned; p < SEEDS; p++) {
    const seed = BASE_SEED + p;
    lastSeed = seed;
    const bag = m.buildSeededBag(m.mulberry32(seed));
    let snap = null;
    const onPos = (board, bagArr, f, rack) => { if (bagArr.length === BAG && !snap) snap = { board: board.map(r => r.slice()), rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })) }; };
    await m.playGame([P, P], bag, false, '', (b, g, f, rk) => { onPos(b, g, f, rk); return true; }, null);
    coll.scanned = p + 1;
    if (!snap) { missed++; save(); continue; }
    Q._sandbox.__B = JSON.stringify(snap.board);
    Q._sandbox.__R = JSON.stringify(snap.rack);
    const tSolve = Date.now();
    const r = JSON.parse(await Q.evalInRealm('__exact(__B, __R)'));
    if (!r.skip) { solveMs += Date.now() - tSolve; solveN++; }
    if (r.skip) skipped++;
    else if (!r.allSolved) { if (r.reason === 'capped') capped++; else dropped++; }
    else {
      coll.entries.push({ b: encodeBoard(snap.board), r: rackStr(snap.rack), p: r.pool, m: r.results });
      saved++;
    }
    save();
    if (saved >= hbAt) {
      printRow(seed);
      hb = Math.min(hb * 1.5, 2000); hbAt = saved + hb;
    }
  }
  printRow(lastSeed);
  console.log(`DONE | ${saved} exact bag=${BAG} solves (capped ${capped}, non-emptying ${dropped}, trivial ${skipped}, no bag=${BAG} moment ${missed}) -> ${OUT}`);
})();
