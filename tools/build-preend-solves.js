// Assemble a durable benchmark of REFERENCE pre-endgame solves for a given
// bag size. For each position where the mover faces exactly `bagSize` tiles in
// the bag (static self-play, any score differential), compute the reference
// probability-weighted endgame-solver value of every top-K candidate move: the
// unseen pool (opponent rack + bag) is known up to which tiles are in the bag,
// so enumerate every (opponent rack | bag) split, play the candidate, deal the
// drawn bag tiles, and score the resulting empty-bag position with the
// reference endgame search. The split expectation is exact (every split, equal
// weight); the per-split value is NOT — it comes from the width-limited beam
// stamped in META.solver, and is only true minimax when the optimal line for
// both sides stays inside the beam at every ply ("Solver beaten" telemetry in
// the eval counts detected misses). A strategy is later scored by looking up
// the reference value of the move it picks (see eval-preend-strategy.js). Only
// positions whose candidates all reach an empty bag and solve within budget
// are kept. Resumable; appends to a compact JSON file.
//
// A candidate that would not empty the bag (plays too few tiles to draw the
// whole bag down to zero) can't be scored by the bag-0 search directly. At
// bag <= 2 such a position is dropped (the set is biased toward positions
// whose top moves reach the endgame — accepted). At bag >= 3 the arm is
// priced by in-split expectimax recursion (beam-or-pass best replies,
// enumerated deduped draws, reference endgame solve at the empty-bag
// frontier) and marked rec:1 in the stored arms.
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
// Half-width of the per-world aspiration window (points). Not part of the
// referee shape: accepted values equal full-window search values.
const ASPIRATION = 16;
// Non-emptying arms at bag >= 3 (bag <= 2 keeps the drop rule) are priced
// by in-split expectimax recursion: both sides play the best reply from a
// static top-`beam` beam (+ pass), replies valued recursively to the
// empty-bag frontier (reference endgame search there), draws enumerated
// and deduped. Chosen over policy playouts after tools/validate-mc-pricing.js
// measured playout biases of +10.6 (sigma-policy), +6.9 (near-greedy) and
// +3.9 (two-ply defense) points vs this recursion. An arm exceeding
// `leafCap` reference solves marks the position capped.
const REC = { beam: 5, leafCap: 8000 };
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
  const REC_BEAM = ${REC.beam};
  const REC_LEAF_CAP = ${REC.leafCap};
  const REC_CAP = Symbol('recCap');
  // Deduped multisets of n draws out of arr: [{ idx, mult }].
  globalThis.__drawSets = function (arr, n) {
    const subs = indexSubsets(arr.length, n);
    const byKey = new Map();
    for (const sub of subs) {
      const key = sub.map(i => arr[i].isBlank ? '?' : arr[i].letter).sort().join('');
      const e = byKey.get(key);
      if (e) e.mult++; else byKey.set(key, { idx: sub, mult: 1 });
    }
    return { sets: [...byKey.values()], total: subs.length };
  };
  // In-split expectimax from the ROOT MOVER's perspective: racks[0] is the
  // root mover, turn is to move; best beam-or-pass reply by recursive value,
  // enumerated deduped draws, reference endgame solve once the bag empties.
  globalThis.__recValue = async function (bagArr, racks, turn, passes, budget, recState) {
    state.bag = new Array(bagArr.length).fill('?');
    if (bagArr.length === 0) {
      if (++recState.leaves > REC_LEAF_CAP) throw REC_CAP;
      budget.used = 0;
      const v = endgameSearch(racks[turn], racks[1 - turn], passes, 1, -Infinity, Infinity, budget);
      return turn === 0 ? v : -v;
    }
    if (passes >= 2) {
      const v = rackValueOf(racks[1 - turn]) - rackValueOf(racks[turn]);
      return turn === 0 ? v : -v;
    }
    const cs = await collectTopCandidates(racks[turn], { candidates: REC_BEAM, margin: 0 });
    let best = await __recValue(bagArr, racks, 1 - turn, passes + 1, budget, recState);
    for (const c of cs) {
      const nr = rackWithout(racks[turn], c.m.placements);
      const need = Math.min(racks[turn].length - nr.length, bagArr.length);
      applyToBoard(c.m.placements);
      let ev = 0;
      try {
        const { sets, total } = __drawSets(bagArr, need);
        for (const { idx, mult } of sets) {
          const drawn = idx.map(i => bagArr[i]);
          const rest = bagArr.filter((_, i2) => !idx.includes(i2));
          const saveRack = racks[turn];
          racks[turn] = nr.concat(drawn);
          try { ev += mult * await __recValue(rest, racks, 1 - turn, 0, budget, recState); }
          finally { racks[turn] = saveRack; }
        }
        ev /= total;
      } finally { removeFromBoard(c.m.placements); }
      const val = (turn === 0 ? c.m.score : -c.m.score) + ev;
      if (turn === 0 ? val > best : val < best) best = val;
    }
    return best;
  };
  globalThis.__refSolve = async function (boardJson, rackJson) {
    state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
    const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    const pool = deriveOpponentRack(rack);            // opponent rack + bag tiles
    const oppSize = pool.length - BAG;
    if (oppSize < 0 || pool.length < BAG) return JSON.stringify({ skip: 1 });
    const cands = await collectTopCandidates(rack, { candidates: ${K}, margin: 0 });
    if (cands.length < 2) return JSON.stringify({ skip: 1 });
    const subsets = indexSubsets(pool.length, BAG);   // which BAG pool tiles are in the bag
    const wgt = 1 / subsets.length;
    // Multiset dedup: index subsets drawing identical tile multisets are the
    // same world (same drawn tiles, same opponent-rack complement) — solve
    // each distinct multiset once, weighted by multiplicity. Values identical.
    const byDraw = new Map();
    for (const sub of subsets) {
      const key = sub.map(i => pool[i].isBlank ? '?' : pool[i].letter).sort().join('');
      const e = byDraw.get(key);
      if (e) e.mult++; else byDraw.set(key, { sub, mult: 1 });
    }
    const worlds = [...byDraw.values()];
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
        // An emptying move draws the whole bag; its post-move position is a
        // bag-0 endgame the reference search prices per split. A non-emptying
        // move leads to another pre-endgame: at bag <= 2 the position is
        // dropped (unchanged v3 behavior); at bag >= 3 the arm is priced by
        // probability-matched policy playouts to the empty-bag frontier.
        const emptying = !(leave.length > 0 && Math.min(7 - leave.length, BAG) < BAG);
        if (!emptying && BAG <= 2) { allSolved = false; reason = 'noempty'; break; }
        applyToBoard(c.m.placements);
        let ev = 0, ok = true;
        if (!emptying) {
          const recState = { leaves: 0 };
          for (const { sub, mult } of worlds) {
            const inBag = new Array(pool.length).fill(false);
            for (const i of sub) inBag[i] = true;
            const oppRack = pool.filter((_, k) => !inBag[k]);
            const bagTiles = sub.map(i => pool[i]);
            const need = Math.min(rack.length - leave.length, bagTiles.length);
            try {
              const { sets, total } = __drawSets(bagTiles, need);
              let dv = 0;
              for (const { idx, mult: dmult } of sets) {
                const drawn = idx.map(i => bagTiles[i]);
                const rest = bagTiles.filter((_, i2) => !idx.includes(i2));
                const racks = [leave.concat(drawn), oppRack];
                dv += dmult * await __recValue(rest, racks, 1, 0, budget, recState);
              }
              ev += mult * (c.m.score + dv / total);
            } catch (e) {
              if (e !== ENDGAME_ABORT && e !== REC_CAP) throw e;
              state.board = boardSnap; egRecomputeBoardHash(); ok = false; reason = 'capped'; break;
            }
          }
          state.bag = new Array(BAG).fill('?');
          removeFromBoard(c.m.placements);
          if (!ok) { allSolved = false; break; }
          results.push({ k: __moveKey(c.m.placements), w: c.m.word, sc: c.m.score, sv: +c.val.toFixed(1), ex: +(ev * wgt).toFixed(2), rec: 1 });
          continue;
        }
        // Aspiration: adjacent worlds of one candidate correlate strongly, so
        // probe a narrow window around the previous world's search value; a
        // fail-soft result at or beyond a bound is re-searched full-window
        // (fresh budget), so accepted values match full-window search.
        let prevR = null;
        for (const { sub, mult } of worlds) {
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
          try {
            let r = null;
            if (prevR !== null) {
              const lo = prevR - ${ASPIRATION}, hi = prevR + ${ASPIRATION};
              const probe = endgameSearch(oppRack, myRack, 0, 1, lo, hi, budget);
              if (probe > lo && probe < hi) r = probe;
            }
            if (r === null) { budget.used = 0; r = endgameSearch(oppRack, myRack, 0, 1, -Infinity, Infinity, budget); }
            prevR = r;
            v = c.m.score - r;
          }
          catch (e) {
            if (e !== ENDGAME_ABORT) throw e;
            state.board = boardSnap; egRecomputeBoardHash(); ok = false; reason = 'capped'; break;
          }
          ev += mult * v;
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
  v: 5, // v5: bag>=3 non-emptying arms priced by in-split expectimax
        // recursion (rec:1) — policy playouts measured +4..+11 optimistic
        // (v4 mc pricing) and retired. v4: endgameSearch window fix.
  bagSize: BAG, candidates: K, baseSeed: BASE_SEED,
  seedMode: 'stream', // game seeds drawn from mulberry32(baseSeed), stored per entry
  candidateOrder: 'blend',
  solver: { budget: BUDGET, width: WIDTH, depth: 0, order: 1, tt: 1 },
  recursion: REC,
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
  console.log(`${'saved'.padStart(7)} ${'capped'.padStart(7)} ${'drop'.padStart(6)} ${'skip'.padStart(6)} ${'miss'.padStart(6)} ${'avg/pos'.padStart(8)} ${'elapsed'.padStart(9)}`);
  const printRow = () => console.log(
    `${String(saved).padStart(7)} ${String(capped).padStart(7)} ${String(dropped).padStart(6)} ${String(skipped).padStart(6)} ${String(missed).padStart(6)} ${(solveN ? (solveMs / solveN / 1000).toFixed(1) + 's' : '—').padStart(8)} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
  // Game seeds are draws from a stream seeded by --base-seed: different
  // streams collide only at birthday odds, so parallel generators need no
  // range discipline; entries record their seed (s) and merge dedups on it.
  const seedStream = m.mulberry32(BASE_SEED);
  for (let p = 0; p < SEEDS; p++) {
    const seed = Math.floor(seedStream() * 4294967296);
    if (p < coll.scanned) continue; // fast-forward the stream on resume
    const bag = m.buildSeededBag(m.mulberry32(seed));
    let snap = null;
    const onPos = (board, bagArr, f, rack) => { if (bagArr.length === BAG && !snap) snap = { board: board.map(r => r.slice()), rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })) }; };
    await m.playGame([P, P], bag, false, '', (b, g, f, rk) => { onPos(b, g, f, rk); return true; }, null);
    coll.scanned = p + 1;
    if (!snap) { missed++; save(); continue; }
    Q._sandbox.__B = JSON.stringify(snap.board);
    Q._sandbox.__R = JSON.stringify(snap.rack);
    const tSolve = Date.now();
    const r = JSON.parse(await Q.evalInRealm('__refSolve(__B, __R)'));
    if (!r.skip) { solveMs += Date.now() - tSolve; solveN++; }
    if (r.skip) skipped++;
    else if (!r.allSolved) { if (r.reason === 'capped') capped++; else dropped++; }
    else {
      coll.entries.push({ s: seed, b: encodeBoard(snap.board), r: rackStr(snap.rack), p: r.pool, m: r.results });
      saved++;
    }
    save();
    if (saved >= hbAt) {
      printRow();
      hb = Math.min(hb * 1.5, 2000); hbAt = saved + hb;
    }
  }
  printRow();
  console.log(`DONE | ${saved} reference bag=${BAG} solves (capped ${capped}, non-emptying ${dropped}, trivial ${skipped}, no bag=${BAG} moment ${missed}) -> ${OUT}`);
})();
