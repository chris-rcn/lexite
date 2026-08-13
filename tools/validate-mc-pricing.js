#!/usr/bin/env node
// Validate the mc playout pricing of non-emptying arms against an in-split
// expectimax recursion. For each generated position (static self-play, bag ==
// --bag-size), find non-emptying arms among the top-K candidates and price
// each twice:
//   mc:  probability-matched policy playouts, exactly as build-preend-solves
//        stores them (same CRN seeds, same POLICY constants), and
//   rec: recursion — per split and enumerated draw, each side plays the
//        best reply from a static top-k beam, replies valued recursively to
//        the empty-bag frontier (reference endgame search there), passes
//        included. No sampling anywhere; the recursion's only approximation
//        is the reply beam itself.
// Reports per-arm mc/rec values and a signed-difference summary. A recursion
// that exceeds --rec-leaves reference solves marks the arm capped.
//
//   node tools/validate-mc-pricing.js [--arms N] [--seeds N] [--base-seed S]
//                                     [--bag-size N] [--candidates K]
//                                     [--budget B] [--width W] [--rec-leaves L]
'use strict';
const path = require('path');
const m = require('./match.js');
const words = m.loadWords();
const ENGINE = path.join(__dirname, '..', 'game.js');
const flag = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const ARMS = parseInt(flag('--arms', '10'), 10);
const SEEDS = parseInt(flag('--seeds', '2000'), 10);
const BASE_SEED = parseInt(flag('--base-seed', '555200'), 10);
const BAG = parseInt(flag('--bag-size', '3'), 10);
const K = parseInt(flag('--candidates', '8'), 10);
const BUDGET = parseInt(flag('--budget', '300000'), 10);
const WIDTH = parseInt(flag('--width', '12'), 10);
const REC_LEAVES = parseInt(flag('--rec-leaves', '2500'), 10);
// Validation prices both referees over the SAME first --splits deduped
// splits: the mc-vs-recursion difference is measured on identical worlds,
// so the comparison is exact while cost stays bounded. Recursion decision
// nodes use a --rec-beam static beam (+ pass).
const SPLITS = parseInt(flag('--splits', '12'), 10);
const REC_BEAM = parseInt(flag('--rec-beam', '5'), 10);
// Defaults match build-preend-solves.js POLICY so the mc side reproduces
// stored values; --temp/--floor probe alternative policies.
const POLICY = { sigma: 7.15, temp: parseFloat(flag('--temp', '5.94')), floor: parseFloat(flag('--floor', '0.05')), k: 8, paths: 2, defense: parseInt(flag('--defense', '0'), 10) };

const P = m.loadEngine(ENGINE, words, { staticOnly: true });
P.evalInRealm('STAGES.bag0.static = true;');
const Q = m.loadEngine(ENGINE, words, {});
Q.evalInRealm(`
  ensureTrie(); ensureLeaveTables();
  STAGES.bag0.width = ${WIDTH};
  STAGES.bag0.width1 = 0;
  STAGES.bag0.width2 = 0;
  STAGES.bag0.depth = 0;
  STAGES.bag0.order = 1;
  const BAG = ${BAG};
  const POLICY = { temp: ${POLICY.temp}, floor: ${POLICY.floor}, k: ${POLICY.k}, paths: ${POLICY.paths}, defense: ${POLICY.defense} };
  const REC_LEAVES = ${REC_LEAVES};
  const REC_BEAM = ${REC_BEAM};
  const REC_CAP = Symbol('recCap');
  globalThis.__drawFrom = function (rng, bagArr, n) {
    const out = [];
    for (let j = 0; j < n && bagArr.length; j++) out.push(bagArr.splice(Math.floor(rng() * bagArr.length), 1)[0]);
    return out;
  };
  globalThis.__samplePolicy = function (rng, cands) {
    const vmax = Math.max(...cands.map(c => c.val));
    const ws = cands.map(c => Math.exp((c.val - vmax) / POLICY.temp));
    const sum = ws.reduce((a, b) => a + b, 0);
    const u = rng();
    let acc = 0;
    for (let i = 0; i < cands.length; i++) {
      acc += (1 - POLICY.floor) * ws[i] / sum + POLICY.floor / cands.length;
      if (u <= acc) return cands[i];
    }
    return cands[cands.length - 1];
  };
  globalThis.__playPath = async function (rng, bagArr, rootRack, oppRack, budget) {
    const racks = [rootRack, oppRack];
    let turn = 1, sign = -1, passes = 0, acc = 0;
    const applied = [];
    try {
      while (true) {
        state.bag = new Array(bagArr.length).fill('?');
        if (bagArr.length === 0) {
          budget.used = 0;
          const v = endgameSearch(racks[turn], racks[1 - turn], passes, 1, -Infinity, Infinity, budget);
          return acc + sign * v;
        }
        if (passes >= 2) return acc + sign * (rackValueOf(racks[1 - turn]) - rackValueOf(racks[turn]));
        const cs = await collectTopCandidates(racks[turn], { candidates: POLICY.k, margin: 0 });
        if (!cs.length) { passes++; sign = -sign; turn = 1 - turn; continue; }
        let pick;
        if (POLICY.defense) {
          // Two-ply greedy: value each reply as its static value minus the
          // responder's best static value on the resulting board (responder's
          // rack is known in-split). Deterministic; draws stay sampled.
          let bv = -Infinity; pick = cs[0];
          for (const c of cs) {
            applyToBoard(c.m.placements);
            let rv = 0;
            try {
              const resp = await collectTopCandidates(racks[1 - turn], { candidates: 1, margin: 0 });
              rv = resp.length ? resp[0].val : 0;
            } finally { removeFromBoard(c.m.placements); }
            const v = c.val - rv;
            if (v > bv) { bv = v; pick = c; }
          }
        } else {
          pick = __samplePolicy(rng, cs);
        }
        applyToBoard(pick.m.placements); applied.push(pick.m.placements);
        acc += sign * pick.m.score;
        const nr = rackWithout(racks[turn], pick.m.placements);
        racks[turn] = nr.concat(__drawFrom(rng, bagArr, Math.min(racks[turn].length - nr.length, bagArr.length)));
        passes = 0; sign = -sign; turn = 1 - turn;
      }
    } finally {
      for (let i = applied.length - 1; i >= 0; i--) removeFromBoard(applied[i]);
      state.bag = new Array(BAG).fill('?');
    }
  };
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
  // Expectimax value from the ROOT MOVER's perspective. racks[0] is the root
  // mover; turn is whose move it is; recState.leaves caps total reference
  // solves per arm.
  globalThis.__recValue = async function (bagArr, racks, turn, passes, budget, recState) {
    state.bag = new Array(bagArr.length).fill('?');
    if (bagArr.length === 0) {
      if (++recState.leaves > REC_LEAVES) throw REC_CAP;
      budget.used = 0;
      const v = endgameSearch(racks[turn], racks[1 - turn], passes, 1, -Infinity, Infinity, budget);
      return turn === 0 ? v : -v;
    }
    if (passes >= 2) {
      const v = rackValueOf(racks[1 - turn]) - rackValueOf(racks[turn]);
      return turn === 0 ? v : -v;
    }
    const cs = await collectTopCandidates(racks[turn], { candidates: REC_BEAM, margin: 0 });
    // Pass is always available.
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
  globalThis.__moveKey = (pl) => pl.map(p => p.row + ',' + p.col + ',' + (p.isBlank ? '?' : p.letter.toUpperCase())).sort().join('|');
  globalThis.__validate = async function (boardJson, rackJson) {
    state.board = JSON.parse(boardJson); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
    const rack = JSON.parse(rackJson).map(t => ({ letter: t.letter, isBlank: t.isBlank }));
    const pool = deriveOpponentRack(rack);
    if (pool.length - BAG < 0 || pool.length < BAG) return JSON.stringify({ skip: 1 });
    const cands = await collectTopCandidates(rack, { candidates: ${K}, margin: 0 });
    if (cands.length < 2) return JSON.stringify({ skip: 1 });
    const nonEmptying = cands.filter(c => {
      const leave = rackWithout(rack, c.m.placements);
      return leave.length > 0 && Math.min(7 - leave.length, BAG) < BAG;
    });
    if (!nonEmptying.length) return JSON.stringify({ skip: 1 });
    const subsets = indexSubsets(pool.length, BAG);
    const byDraw = new Map();
    for (const sub of subsets) {
      const key = sub.map(i => pool[i].isBlank ? '?' : pool[i].letter).sort().join('');
      const e = byDraw.get(key);
      if (e) e.mult++; else byDraw.set(key, { sub, mult: 1 });
    }
    const worlds = [...byDraw.values()].slice(0, ${SPLITS});
    const wsum = worlds.reduce((s, w) => s + w.mult, 0);
    const savedB = STAGES.bag0.movegenBudget; STAGES.bag0.movegenBudget = ${BUDGET};
    EG_TT = new Map();
    egRecomputeBoardHash();
    const budget = { used: 0 };
    const out = [];
    try {
      for (const c of nonEmptying) {
        const leave = rackWithout(rack, c.m.placements);
        applyToBoard(c.m.placements);
        let mc = 0, rec = 0, recLeaves = 0, capped = false;
        const t0 = Date.now();
        try {
          // mc pricing — identical code and CRN seeds to build-preend-solves.
          for (let si = 0; si < worlds.length; si++) {
            const { sub, mult } = worlds[si];
            for (let pi = 0; pi < POLICY.paths; pi++) {
              const rng = seededRng(((positionHash(rack) ^ (2654435761 * (si + 1))) + pi) >>> 0);
              const bagArr = sub.map(i => pool[i]);
              const inBag = new Array(pool.length).fill(false);
              for (const i of sub) inBag[i] = true;
              const oppRack = pool.filter((_, k) => !inBag[k]);
              const myDraw = __drawFrom(rng, bagArr, Math.min(rack.length - leave.length, bagArr.length));
              const v = await __playPath(rng, bagArr, leave.concat(myDraw), oppRack, budget);
              mc += mult * (c.m.score + v) / POLICY.paths;
            }
          }
          // recursion pricing over the same splits.
          const recState = { leaves: 0 };
          for (const { sub, mult } of worlds) {
            const inBag = new Array(pool.length).fill(false);
            for (const i of sub) inBag[i] = true;
            const oppRack = pool.filter((_, k) => !inBag[k]);
            const bagTiles = sub.map(i => pool[i]);
            const need = Math.min(rack.length - leave.length, bagTiles.length);
            const { sets, total } = __drawSets(bagTiles, need);
            let ev = 0;
            for (const { idx, mult: dmult } of sets) {
              const drawn = idx.map(i => bagTiles[i]);
              const rest = bagTiles.filter((_, i2) => !idx.includes(i2));
              const racks = [leave.concat(drawn), oppRack];
              ev += dmult * await __recValue(rest, racks, 1, 0, budget, recState);
            }
            rec += mult * (c.m.score + ev / total);
          }
          recLeaves = recState.leaves;
        } catch (e) {
          if (e !== ENDGAME_ABORT && e !== REC_CAP) throw e;
          capped = true;
        } finally {
          state.bag = new Array(BAG).fill('?');
          removeFromBoard(c.m.placements);
        }
        out.push(capped
          ? { w: c.m.word, sv: +c.val.toFixed(1), capped: 1 }
          : { w: c.m.word, sv: +c.val.toFixed(1), mc: +(mc / wsum).toFixed(2), rec: +(rec / wsum).toFixed(2), leaves: recLeaves, ms: Date.now() - t0 });
      }
    } finally { STAGES.bag0.movegenBudget = savedB; }
    return JSON.stringify({ arms: out });
  };
`);

(async () => {
  let armCount = 0, capped = 0;
  const diffs = [];
  console.log(`${'seed'.padStart(8)} ${'word'.padStart(10)} ${'sv'.padStart(7)} ${'mc'.padStart(8)} ${'rec'.padStart(8)} ${'diff'.padStart(7)} ${'leaves'.padStart(7)} ${'ms'.padStart(7)}`);
  for (let p = 0; p < SEEDS && armCount < ARMS; p++) {
    const seed = BASE_SEED + p;
    const bag = m.buildSeededBag(m.mulberry32(seed));
    let snap = null;
    const onPos = (board, bagArr, f, rack) => { if (bagArr.length === BAG && !snap) snap = { board: board.map(r => r.slice()), rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })) }; };
    await m.playGame([P, P], bag, false, '', (b, g, f, rk) => { onPos(b, g, f, rk); return true; }, null);
    if (!snap) continue;
    Q._sandbox.__B = JSON.stringify(snap.board);
    Q._sandbox.__R = JSON.stringify(snap.rack);
    const r = JSON.parse(await Q.evalInRealm('__validate(__B, __R)'));
    if (r.skip) continue;
    for (const a of r.arms) {
      if (a.capped) {
        capped++;
        console.log(`${String(seed).padStart(8)} ${a.w.padStart(10)} ${String(a.sv).padStart(7)} ${'capped'.padStart(8)}`);
        continue;
      }
      armCount++;
      diffs.push(a.mc - a.rec);
      console.log(`${String(seed).padStart(8)} ${a.w.padStart(10)} ${String(a.sv).padStart(7)} ${String(a.mc).padStart(8)} ${String(a.rec).padStart(8)} ${(a.mc - a.rec).toFixed(2).padStart(7)} ${String(a.leaves).padStart(7)} ${String(a.ms).padStart(7)}`);
    }
  }
  if (diffs.length) {
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((s, d) => s + (d - mean) * (d - mean), 0) / (diffs.length - 1)) : 0;
    console.log(`\n${diffs.length} arms (capped ${capped}): mean diff (mc - rec) ${mean.toFixed(2)} +- ${(sd / Math.sqrt(diffs.length)).toFixed(2)}, sd ${sd.toFixed(2)}, mean |diff| ${(diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length).toFixed(2)}`);
  } else {
    console.log(`\nno arms priced (capped ${capped})`);
  }
})();
