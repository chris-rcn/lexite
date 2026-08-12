#!/usr/bin/env node
// Assemble a durable benchmark of strong-reference endgame (bag=0) solves.
// Production's endgame search approximates via a movegen budget and
// per-ply width caps over value-ordered beams (terminal depth is the
// default — see STAGES.bag0). This builder values one sampled bag=0
// decision per seeded static self-play game with a much stronger
// reference — all three caps configurable and lifted — storing the top-M
// root moves' values plus the pass value, so any budgeted configuration can
// be graded later by looking up the exact-er value of the move it picks
// (see eval-bag0-strategy.js). The endgame is score-margin arithmetic only,
// so the benchmark is independent of the leave model and survives re-ships.
//
// Positions the reference cannot finish inside its own (huge) budget are
// counted and skipped — they are the pathological open-board tail; report
// their rate alongside results. Resumable: records carry their seed, and a
// restart continues after the last completed seed. One JSONL header pins
// the reference parameters; appending with different parameters refuses.
//
//   node tools/oracle-gen-bag0.js <out.jsonl> [seeds] [baseSeed] [M]
//                                   [budget] [width] [depth]
//                                   [screenDepth] [screenMargin] [order]
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./match.js');

const OUT = process.argv[2];
if (!OUT) {
  console.error('Usage: node tools/oracle-gen-bag0.js <out.jsonl> [seeds] [baseSeed] [M] [budget] [width] [depth] [screenDepth] [screenMargin] [order]');
  process.exit(2);
}
const SEEDS = parseInt(process.argv[3] || '20000', 10);
const BASE_SEED = parseInt(process.argv[4] || '905000', 10);
const M = parseInt(process.argv[5] || '30', 10);
const BUDGET = parseInt(process.argv[6] || '2000000', 10);
const WIDTH = parseInt(process.argv[7] || '24', 10);
const DEPTH = parseInt(process.argv[8] || '100', 10);
const SCREEN_DEPTH = parseInt(process.argv[9] || '4', 10);
const SCREEN_MARGIN = parseFloat(process.argv[10] || '5');
const ORDER = parseInt(process.argv[11] || '1', 10);

const crypto = require('crypto');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
// The reference search's ordering, beam, and rollouts run on the fitted
// endgame leave model — part of the benchmark's identity, so its hash is
// stamped like the midgame oracle stamps the midgame weights.
const EG_PATH = path.join(__dirname, '..', 'endgame-leaves.json.gz');
const egWeightsMd5 = fs.existsSync(EG_PATH)
  ? crypto.createHash('md5').update(fs.readFileSync(EG_PATH)).digest('hex') : 'none';

function encodeBoard(board) {
  let s = '';
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    const cell = board[r][c];
    s += !cell ? '.' : (cell.isBlank ? cell.letter.toLowerCase() : cell.letter.toUpperCase());
  }
  return s;
}
const rackStr = rack => rack.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).join('');

// Driver: fast static self-play everywhere, including the endgame — the
// benchmark grades deciders on harvested positions, not the driver's play.
const P = m.loadEngine(ENGINE, words, { staticOnly: true });
P.evalInRealm('STAGES.bag0.static = true;');

// Reference solver realm.
const Q = m.loadEngine(ENGINE, words, {});
Q.evalInRealm(`
  ensureTrie(); ensureLeaveTables();
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
  // Value the top-M roots and the pass with the reference caps. Top-M
  // is selected by the reference ordering (static endgame value under
  // order 1) — the same currency every graded config picks by, so the
  // moves configs actually choose land in the exactly-valued set instead
  // of relying on the screened sweep. Full root windows (no best-so-far
  // pruning): every stored value is the reference value of that move,
  // independent of evaluation order.
  globalThis.__refSolve = async function (boardJson, rackJson) {
    state.board = JSON.parse(boardJson);
    state.isFirstMove = false;
    state.bag = [];
    // Per-position transposition table: the top-M full-window searches
    // and the containment sweep's probes traverse heavily overlapping
    // subtrees on the same board — at reference depth the cache pays
    // where prod's small trees could not.
    EG_TT = new Map();
    egRecomputeBoardHash();
    const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    const oppRack = deriveOpponentRack(rack);
    const saved = { b: STAGES.bag0.movegenBudget, w: STAGES.bag0.width, p: STAGES.bag0.depth, o: STAGES.bag0.order };
    STAGES.bag0.movegenBudget = ${BUDGET};
    STAGES.bag0.width = ${WIDTH};
    STAGES.bag0.depth = ${DEPTH};
    STAGES.bag0.order = ${ORDER};
    const budget = { used: 0 };
    const boardSnap = state.board.map(r => r.slice());
    try {
      const moves = allMovesSorted(rack, budget);
      if (moves.length === 0) return JSON.stringify({ skip: 1 }); // pass is the only action
      // One legal move is still a decision: the move versus the pass.
      const ordered = valueOrdered(moves, rack, oppRack);
      const out = [];
      for (const mv of ordered.slice(0, ${M})) {
        const newRack = rackWithout(rack, mv.placements);
        let val;
        if (newRack.length === 0) {
          val = mv.score + 2 * rackValueOf(oppRack);
        } else {
          applyToBoard(mv.placements);
          try {
            val = mv.score - endgameSearch(oppRack, newRack, 0, 1, -Infinity, Infinity, budget);
          } finally {
            removeFromBoard(mv.placements);
          }
        }
        out.push([__moveKey(mv.placements), +val.toFixed(2)]);
      }
      const pass = +(-endgameSearch(oppRack, rack, 1, 1, -Infinity, Infinity, budget)).toFixed(2);
      // Containment sweep: every root move beyond the stored top-M gets a
      // windowed probe against the running best. Hopeless moves cut off
      // almost immediately (fail-soft: a return >= beta proves the move
      // cannot beat the best); a move that does beat it returns an exact
      // value and joins the stored arms. The record's best is therefore
      // the best over ALL root moves — configs that explore past raw
      // score order are graded against a valid target.
      let best = Math.max(pass, ...out.map(x => x[1]));
      for (const mv of ordered.slice(${M})) {
        const newRack = rackWithout(rack, mv.placements);
        let val;
        if (newRack.length === 0) {
          val = mv.score + 2 * rackValueOf(oppRack);
        } else {
          // Two-stage probe. Stage 1 screens at shallow depth: a
          // refutation proving the move sits more than screenMargin
          // behind the best is accepted from the cheap search (the
          // overwhelmingly common case). Stage 2 gives survivors the
          // full-depth exact probe; only full-depth values are stored.
          applyToBoard(mv.placements);
          try {
            STAGES.bag0.depth = ${SCREEN_DEPTH};
            const sv = mv.score - endgameSearch(oppRack, newRack, 0, 1, -Infinity,
              mv.score - (best - ${SCREEN_MARGIN}), budget);
            if (sv <= best - ${SCREEN_MARGIN}) continue;
            STAGES.bag0.depth = ${DEPTH};
            val = mv.score - endgameSearch(oppRack, newRack, 0, 1, -Infinity, mv.score - best, budget);
          } finally {
            STAGES.bag0.depth = ${DEPTH};
            removeFromBoard(mv.placements);
          }
        }
        if (val > best) { best = val; out.push([__moveKey(mv.placements), +val.toFixed(2)]); }
      }
      return JSON.stringify({ e: out, p: pass, n: moves.length, u: budget.used });
    } catch (e) {
      if (e !== ENDGAME_ABORT) throw e;
      state.board = boardSnap;
      return JSON.stringify({ capped: 1 });
    } finally {
      EG_TT = null;
      STAGES.bag0.movegenBudget = saved.b;
      STAGES.bag0.width = saved.w;
      STAGES.bag0.order = saved.o;
      if (saved.p === undefined) delete STAGES.bag0.depth; else STAGES.bag0.depth = saved.p;
    }
  };
`);

async function main() {
  // v2: records carry a containment sweep — e holds the top-M root moves
  // plus any beyond-M move that beat them, so max(e, pass) is the best
  // over all root moves.
  // v3: one endgame position per game, picked with a seed-derived rng —
  // successive turns of one endgame are highly correlated, so sampling
  // them all overstated the effective sample size.
  // v4: the containment sweep screens at screenDepth first and escalates
  // to full depth only within screenMargin of the best — a move whose
  // merit appears only past screenDepth AND screens further behind than
  // screenMargin can be missed; stored values are always full-depth.
  // v5: the reference search runs bag0.order (default 1: trained
  // endgame-leave-value ordering for beam and rollouts) — the fitted
  // EG_LEAVE_VALUES feed back into generation, so fit and oracle iterate
  // toward a fixed point across regenerations.
  // v6: top-M roots are selected by the reference ordering (static
  // endgame value), not raw score — the currency graded configs pick by,
  // so their choices land in the exactly-valued set instead of leaning
  // on the screened sweep.
  // v7: the reference search runs a per-position transposition table —
  // values may differ marginally from an uncached run (cache hits serve
  // deeper-or-equal-remaining entries), so the stamp records it.
  const header = { v: 7, ref: { budget: BUDGET, width: WIDTH, depth: DEPTH, topM: M, screenDepth: SCREEN_DEPTH, screenMargin: SCREEN_MARGIN, order: ORDER, tt: 1 }, egWeightsMd5, baseSeed: BASE_SEED };
  let startSeed = BASE_SEED;
  let saved = 0;
  if (fs.existsSync(OUT)) {
    const lines = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean);
    const h = JSON.parse(lines[0]);
    if (JSON.stringify(h) !== JSON.stringify(header)) {
      console.error('Existing benchmark has different reference parameters; refusing to append.');
      process.exit(2);
    }
    saved = lines.length - 1;
    for (let i = 1; i < lines.length; i++) startSeed = Math.max(startSeed, JSON.parse(lines[i]).s + 1);
    console.log(`Resuming ${OUT}: ${saved} positions, continuing at seed ${startSeed}`);
  } else {
    fs.writeFileSync(OUT, JSON.stringify(header) + '\n');
  }
  const out = fs.openSync(OUT, 'a');

  console.log(`Reference: budget ${BUDGET}, width ${WIDTH}, depth ${DEPTH}, top-${M} root moves`);
  console.log(`${'seed'.padStart(8)} ${'saved'.padStart(7)} ${'capped'.padStart(7)} ${'skip'.padStart(6)} ${'cap%'.padStart(8)} ${'elapsed'.padStart(9)}`);

  let capped = 0, skipped = 0;
  // Heartbeats keyed to saved positions: first after 1 new record, then
  // on an exponentially growing period.
  let hb = 1, hbAt = saved + 1;
  const t0 = Date.now();
  for (let seed = startSeed; seed < BASE_SEED + SEEDS; seed++) {
    const bag = m.buildSeededBag(m.mulberry32(seed));
    // Harvest every bag=0 decision (both seats) from this game. Snapshot
    // at harvest time — the game keeps mutating the board afterwards.
    const positions = [];
    const onPosition = async (board, b, isFirstMove, rack) => {
      if (b.length === 0 && rack.length > 0) {
        positions.push({
          enc: encodeBoard(board),
          cells: JSON.stringify(board),
          rack: JSON.stringify(rack),
          r: rackStr(rack),
        });
      }
      return true;
    };
    await m.playGame([P, P], bag, false, '', onPosition, null);
    // One position per game, picked with a seed-derived rng (deterministic,
    // resume-safe): successive turns of the same endgame are highly
    // correlated, so one game contributes one independent example.
    if (positions.length > 1) {
      const rng = m.mulberry32(seed ^ 0x9e3779b9);
      positions.splice(0, positions.length, positions[Math.floor(rng() * positions.length)]);
    }
    // Solve after the game finishes so records append whole-seed at a time
    // (resume alignment is by seed).
    for (const pos of positions) {
      Q._sandbox.__B = pos.cells;
      Q._sandbox.__R = pos.rack;
      const res = JSON.parse(await Q.evalInRealm('__refSolve(__B, __R)'));
      if (res.skip) { skipped++; continue; }
      if (res.capped) { capped++; continue; }
      fs.writeSync(out, JSON.stringify({ s: seed, b: pos.enc, r: pos.r, n: res.n, u: res.u, e: res.e, p: res.p }) + '\n');
      saved++;
    }
    if (saved >= hbAt) {
      console.log(`${String(seed).padStart(8)} ${String(saved).padStart(7)} ${String(capped).padStart(7)} ${String(skipped).padStart(6)} ${((100 * capped / Math.max(1, saved + capped)).toFixed(1) + '%').padStart(8)} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
      hb = Math.min(hb * 1.5, 2000); hbAt = saved + hb;
    }
  }
  fs.closeSync(out);
  console.log(`\nSaved ${saved} positions (${capped} capped, ${skipped} trivial) to ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
