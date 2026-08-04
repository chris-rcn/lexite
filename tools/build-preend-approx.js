// Assemble a benchmark of APPROXIMATE-oracle pre-endgame values for a given bag
// size, for bags too deep to solve exactly. At bag=3 the unseen pool splits into
// C(10,3)=120 (opponent rack | bag) worlds; exact endgame solves over all of
// them (120 per candidate) are ~3.3x the already-slow bag=2 exact build. Instead
// use a "bumped-up" version of the production low-bag strategy as the oracle:
// enumerate ALL splits (no sampling) and value each top-K candidate by the
// greedy rollout (simPlayoutValue) averaged over them. This is exact over the
// world distribution but greedy in the rollout — so regret measured against it
// is "loss vs the best affordable greedy policy", not vs true optimal (bag=2
// showed full greedy enumeration sits ~0.6 pts off the exact solver). The
// rollout handles every move correctly, including 7-tile plays that refill from
// the bag rather than going out, so there is no leave===0 / bag-emptying bias
// and no candidate is dropped.
//
//   node tools/build-preend-approx.js [out.json] [seeds] [baseSeed] [K] [bagSize]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const OUT = process.argv[2] || path.join(__dirname, 'preend-approx.json');
const SEEDS = parseInt(process.argv[3] || '20000', 10);
const BASE_SEED = parseInt(process.argv[4] || '1500000', 10);
const K = parseInt(process.argv[5] || '6', 10);
const BAG = parseInt(process.argv[6] || '3', 10);
// Cap on worlds evaluated per candidate. When the full split count C(pool,BAG)
// exceeds this, take a seeded uniform subsample instead of enumerating all —
// trading a low-noise exact-over-worlds oracle for a bounded per-position cost.
// 0 = enumerate all (exact over the world distribution).
const MAXW = parseInt(process.argv[7] || '0', 10);

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
  const BAG = ${BAG}, MAXW = ${MAXW};
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
  // Approximate-oracle value of every top-K candidate: greedy rollout averaged
  // over the full enumeration of (opponent rack | bag) splits.
  globalThis.__oracle = async function (boardJson, rackJson) {
    state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
    const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    const pool = deriveOpponentRack(rack);            // opponent rack + bag tiles
    const oppSize = pool.length - BAG;
    if (oppSize < 0 || pool.length < BAG) return JSON.stringify({ skip: 1 });
    const cands = await collectTopCandidates(rack, { candidates: ${K}, margin: 0 });
    if (cands.length < 2) return JSON.stringify({ skip: 1 });
    let subsets = indexSubsets(pool.length, BAG);     // which BAG pool tiles are the bag
    if (MAXW > 0 && subsets.length > MAXW) {           // seeded uniform subsample to bound effort
      const rng = seededRng(pool.length * 2654435761 + subsets.length);
      for (let i = subsets.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = subsets[i]; subsets[i] = subsets[j]; subsets[j] = t; }
      subsets = subsets.slice(0, MAXW);
    }
    const wgt = 1 / subsets.length;
    // Enumerated worlds: opponent rack, then bag draw order (canonical pool order).
    const worlds = subsets.map(sub => {
      const inBag = new Array(pool.length).fill(false);
      for (const i of sub) inBag[i] = true;
      const opp = [], bagT = [];
      for (let k = 0; k < pool.length; k++) (inBag[k] ? bagT : opp).push(pool[k]);
      return opp.concat(bagT);
    });
    const savedBag = state.bag;
    const results = [];
    inSimulation = true;
    try {
      for (const c of cands) {
        const leave = rackWithout(rack, c.m.placements);
        applyToBoard(c.m.placements);
        let ev = 0;
        for (const world of worlds) ev += await simPlayoutValue(c.m.score, leave, world, oppSize, { used: 0 }, 0);
        removeFromBoard(c.m.placements);
        results.push({ k: __moveKey(c.m.placements), w: c.m.word, sc: c.m.score, sv: +c.val.toFixed(1), ex: +(ev * wgt).toFixed(2) });
      }
    } finally { inSimulation = false; state.bag = savedBag; }
    return JSON.stringify({ pool: pool.map(t => t.isBlank ? '?' : t.letter.toUpperCase()).join(''), results, allSolved: true });
  };
`);

let coll = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8'))
  : { meta: { bagSize: BAG, candidates: K, oracle: MAXW > 0 ? 'greedy-sample' : 'greedy-enum', worldsCap: MAXW, baseSeed: BASE_SEED }, scanned: 0, entries: [] };
function save() { fs.writeFileSync(OUT + '.tmp', JSON.stringify(coll)); fs.renameSync(OUT + '.tmp', OUT); }

(async () => {
  for (let p = coll.scanned; p < SEEDS; p++) {
    let snap = null;
    const onPos = (board, bag, f, rack) => { if (bag.length === BAG && !snap) snap = { board: board.map(r => r.slice()), rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })) }; };
    await m.playGame([P, P], m.buildSeededBag(m.mulberry32(BASE_SEED + p)), false, '', onPos);
    coll.scanned = p + 1;
    if (snap) {
      const r = JSON.parse(await Q.evalInRealm(`__oracle(${JSON.stringify(JSON.stringify(snap.board))}, ${JSON.stringify(JSON.stringify(snap.rack))})`));
      if (!r.skip) coll.entries.push({ b: encodeBoard(snap.board), r: rackStr(snap.rack), p: r.pool, m: r.results });
    }
    save();
    if (coll.scanned % 20 === 0) console.log(`scanned ${coll.scanned}/${SEEDS} | ${coll.entries.length} approx bag=${BAG} oracles`);
  }
  console.log(`DONE | scanned ${coll.scanned} | ${coll.entries.length} approx bag=${BAG} oracles -> ${OUT}`);
})();
