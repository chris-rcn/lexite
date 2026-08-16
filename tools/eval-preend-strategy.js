#!/usr/bin/env node
// Score pre-endgame configurations against a reference-solve benchmark
// (any bag size — the bagN-oracle-v3.json family; the bag size is read
// from the collection meta and the config applies to whatever stage that
// bag routes to). Reference values are width-limited beam solves (shape
// in META.solver), not ground truth — regret is relative to that referee.
// For each stored position, run each configured decider, look
// up the reference value of the move it picks, and measure regret =
// (best reference) - (picked reference). Reports mean regret, % optimal, and
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
let DETAIL = false;
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--test') tests.push(process.argv[++i]);
  else if (process.argv[i] === '--detail') DETAIL = true;
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
  if (meta.oracle === 'policy' || meta.oracle === 'dual') return policyValue(meta, bJson, rackStr, poolStr, pick);
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
      const ASPIRATION = 16; // per-world window half-width, as in build-preend-solves
      // Playout policy for mc-priced (non-emptying, bag >= 3) arms — read
      // from the collection meta so files stay self-describing; null for
      // pre-v4 collections, which keep the noempty exclusion.
      const POLICY = ${meta.policy ? JSON.stringify(meta.policy) : 'null'};
      // v5 collections price non-emptying arms by in-split expectimax
      // recursion instead; REC is null for earlier collections.
      const REC = ${meta.recursion ? JSON.stringify(meta.recursion) : 'null'};
      // v6 (bag >= 4) collections price non-emptying arms by deterministic
      // two-ply-defense playouts instead; null for other collections.
      const DEFP = ${meta.defense ? JSON.stringify(meta.defense) : 'null'};
      const REC_CAP = Symbol('recCap');
      globalThis.__detValue = async function (bagArr, racks, turn, passes, budget, recState) {
        state.bag = new Array(bagArr.length).fill('?');
        if (bagArr.length === 0) {
          if (++recState.leaves > DEFP.leafCap) throw REC_CAP;
          budget.used = 0;
          const v = endgameSearch(racks[turn], racks[1 - turn], passes, 1, -Infinity, Infinity, budget);
          return turn === 0 ? v : -v;
        }
        if (passes >= 2) {
          const v = rackValueOf(racks[1 - turn]) - rackValueOf(racks[turn]);
          return turn === 0 ? v : -v;
        }
        const cs = await collectTopCandidates(racks[turn], { candidates: DEFP.beam, margin: 0 });
        if (!cs.length) return await __detValue(bagArr, racks, 1 - turn, passes + 1, budget, recState);
        let pick = cs[0], bv = -Infinity;
        for (const c of cs) {
          applyToBoard(c.m.placements);
          let rv = 0;
          try {
            const resp = await collectTopCandidates(racks[1 - turn], { candidates: 1, margin: 0 });
            rv = resp.length ? resp[0].val : 0;
          } finally { removeFromBoard(c.m.placements); }
          const v2 = c.val - rv;
          if (v2 > bv) { bv = v2; pick = c; }
        }
        const nr = rackWithout(racks[turn], pick.m.placements);
        const need = Math.min(racks[turn].length - nr.length, bagArr.length);
        applyToBoard(pick.m.placements);
        let ev = 0;
        try {
          const { sets, total } = __drawSets(bagArr, need);
          for (const { idx, mult } of sets) {
            const drawn = idx.map(i => bagArr[i]);
            const rest = bagArr.filter((_, i2) => !idx.includes(i2));
            const saveRack = racks[turn];
            racks[turn] = nr.concat(drawn);
            try { ev += mult * await __detValue(rest, racks, 1 - turn, 0, budget, recState); }
            finally { racks[turn] = saveRack; }
          }
          ev /= total;
        } finally { removeFromBoard(pick.m.placements); }
        return (turn === 0 ? pick.m.score : -pick.m.score) + ev;
      };
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
      globalThis.__recValue = async function (bagArr, racks, turn, passes, budget, recState) {
        state.bag = new Array(bagArr.length).fill('?');
        if (bagArr.length === 0) {
          if (++recState.leaves > REC.leafCap) throw REC_CAP;
          budget.used = 0;
          const v = endgameSearch(racks[turn], racks[1 - turn], passes, 1, -Infinity, Infinity, budget);
          return turn === 0 ? v : -v;
        }
        if (passes >= 2) {
          const v = rackValueOf(racks[1 - turn]) - rackValueOf(racks[turn]);
          return turn === 0 ? v : -v;
        }
        const cs = await collectTopCandidates(racks[turn], { candidates: REC.beam, margin: 0 });
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
            const pick = __samplePolicy(rng, cs);
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
      globalThis.__refValue = async function () {
        state.board = JSON.parse(__B); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
        const rack = [...__R].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
        const pool = [...__POOL].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
        const pick = JSON.parse(__P);
        const leave = rackWithout(rack, pick.placements);
        const emptying = !(leave.length > 0 && Math.min(7 - leave.length, BAG) < BAG);
        if (!emptying && (BAG <= 2 || (!POLICY && !REC && !DEFP))) return 'noempty';
        const subsets = indexSubsets(pool.length, BAG);
        // Multiset dedup, mirroring build-preend-solves: identical drawn
        // multisets are the same world — solve once, weight by multiplicity.
        const byDraw = new Map();
        for (const sub of subsets) {
          const key = sub.map(i => pool[i].isBlank ? '?' : pool[i].letter).sort().join('');
          const e = byDraw.get(key);
          if (e) e.mult++; else byDraw.set(key, { sub, mult: 1 });
        }
        const worlds = [...byDraw.values()];
        EG_TT = new Map();
        egRecomputeBoardHash();
        const budget = { used: 0 };
        const boardSnap = state.board.map(r => r.slice());
        applyToBoard(pick.placements);
        try {
          if (!emptying && (REC || DEFP)) {
            // recursion (v5) / deterministic defense-playout (v6) pricing,
            // mirroring build-preend-solves (same split subsample seed).
            const priceFn = DEFP ? __detValue : __recValue;
            let armWorlds = worlds, armN = subsets.length;
            if (DEFP && DEFP.splitCap) {
              const rng = seededRng((positionHash(rack) ^ 0xdef5eed) >>> 0);
              const shuffled = subsets.slice();
              for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
              }
              const take = shuffled.slice(0, Math.min(DEFP.splitCap, shuffled.length));
              const byKey = new Map();
              for (const sub of take) {
                const key = sub.map(i => pool[i].isBlank ? '?' : pool[i].letter).sort().join('');
                const e = byKey.get(key);
                if (e) e.mult++; else byKey.set(key, { sub, mult: 1 });
              }
              armWorlds = [...byKey.values()];
              armN = take.length;
            }
            const recState = { leaves: 0 };
            let rev = 0;
            for (const { sub, mult } of armWorlds) {
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
                  dv += dmult * await priceFn(rest, racks, 1, 0, budget, recState);
                }
                rev += mult * (pick.score + dv / total);
              } catch (e) {
                if (e !== ENDGAME_ABORT && e !== REC_CAP) throw e;
                state.board = boardSnap;
                egRecomputeBoardHash();
                return 'capped';
              }
            }
            state.bag = new Array(BAG).fill('?');
            return rev / armN;
          }
          if (!emptying) {
            // mc pricing mirroring build-preend-solves: CRN seeds per
            // (position, split, path), candidate-independent.
            let mev = 0;
            for (let si = 0; si < worlds.length; si++) {
              const { sub, mult } = worlds[si];
              const inBag = new Array(pool.length).fill(false);
              for (const i of sub) inBag[i] = true;
              const oppRack = pool.filter((_, k) => !inBag[k]);
              for (let pi = 0; pi < POLICY.paths; pi++) {
                const rng = seededRng(((positionHash(rack) ^ (2654435761 * (si + 1))) + pi) >>> 0);
                const bagArr = sub.map(i => pool[i]);
                const myDraw = __drawFrom(rng, bagArr, Math.min(rack.length - leave.length, bagArr.length));
                try {
                  const v = await __playPath(rng, bagArr, leave.concat(myDraw), oppRack, budget);
                  mev += mult * (pick.score + v) / POLICY.paths;
                } catch (e) {
                  if (e !== ENDGAME_ABORT) throw e;
                  state.board = boardSnap;
                  egRecomputeBoardHash();
                  return 'capped';
                }
              }
            }
            return mev / subsets.length;
          }
          let ev = 0;
          // Aspiration mirroring build-preend-solves: narrow window seeded by
          // the previous world's value, full-window re-search on a fail.
          let prevR = null;
          for (const { sub, mult } of worlds) {
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
                let r = null;
                if (prevR !== null) {
                  const lo = prevR - ASPIRATION, hi = prevR + ASPIRATION;
                  const probe = endgameSearch(oppRack, myRack, 0, 1, lo, hi, budget);
                  if (probe > lo && probe < hi) r = probe;
                }
                if (r === null) { budget.used = 0; r = endgameSearch(oppRack, myRack, 0, 1, -Infinity, Infinity, budget); }
                prevR = r;
                v = pick.score - r;
              } catch (e) {
                if (e !== ENDGAME_ABORT) throw e;
                state.board = boardSnap;
                egRecomputeBoardHash();
                return 'capped';
              }
            }
            ev += mult * v;
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

// On-demand pricing for v7 all-policy collections: the pick's mean
// defense-3 playout margin over the SAME position-seeded worlds the
// builder used — cheap (no solver), so uncovered picks stop being a tax.
let policyRealm = null;
function policyValue(meta, bJson, rackStr, poolStr, pick) {
  if (!policyRealm) {
    policyRealm = m.loadEngine(ENGINE, words, {});
    policyRealm.evalInRealm(`ensureTrie(); ensureLeaveTables();
      ${meta.policyConfig.egMidBlend !== undefined
        ? `for (const st of ['bag1','bag2','bag3','bag4','bag5','bag6','bag7']) STAGES[st].egMidBlend = ${meta.policyConfig.egMidBlend};`
        : '// pre-pin collection: playout blends follow the live engine config'}
      const BAG = ${meta.bagSize};
      const PWORLDS = ${meta.policyConfig.worlds};
      const DUAL = ${meta.oracle === 'dual' ? 'true' : 'false'};
      globalThis.__horizonWorldValue = async function (score, kept, world, oppSize) {
        const oppRack = world.slice(0, oppSize);
        let cursor = oppSize;
        const myDrawStart = cursor;
        const myDraw = Math.min(7 - kept.length, world.length - cursor);
        cursor += myDraw;
        state.bag = world.slice(cursor);
        const reply = await findBestSimReply(oppRack);
        const rScore = reply && reply.placements ? reply.score : 0;
        const oppKept = reply ? rackWithout(oppRack, reply.placements || reply.tiles) : oppRack;
        const oppDrawStart = cursor;
        const oppDraw = Math.min(7 - oppKept.length, state.bag.length);
        const target = 7;
        let horizon = 0;
        const scaleH = Math.min(1, (state.bag.length - oppDraw) / 7);
        if (scaleH > 0 && leaveModelReady()) {
          const specMy = Math.min(myDraw, Math.max(0, target - kept.length));
          const specOpp = Math.min(oppDraw, Math.max(0, target - oppKept.length));
          const myEval = kept.concat(world.slice(myDrawStart, myDrawStart + specMy));
          const oppEval = oppKept.concat(world.slice(oppDrawStart, oppDrawStart + specOpp));
          horizon = scaleH * (leaveValueFromCounts(tileCounts(myEval)) - leaveValueFromCounts(tileCounts(oppEval)));
        }
        return score - rScore + horizon;
      };
      globalThis.__policyValue = async function () {
        state.board = JSON.parse(__B); state.isFirstMove = false; state.bag = new Array(BAG).fill('?');
        const rack = [...__R].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
        const pool = [...__POOL].map(ch => ({ letter: ch === '?' ? '' : ch, isBlank: ch === '?' }));
        const pick = JSON.parse(__P);
        const oppSize = pool.length - BAG;
        if (oppSize < 0) return 'skip';
        const rng = seededRng(positionHash(rack));
        const worlds = [];
        for (let w = 0; w < PWORLDS; w++) {
          const p = pool.slice();
          for (let i = p.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [p[i], p[j]] = [p[j], p[i]];
          }
          worlds.push(p);
        }
        PLAYOUT_TEMP = ${meta.policyConfig.playoutTemp}; PLAYOUT_DEFENSE = ${meta.policyConfig.playoutDefense};
        const kept = rackWithout(rack, pick.placements);
        applyToBoard(pick.placements);
        let ev = 0, evH = 0;
        try {
          for (const world of worlds) ev += await simPlayoutValue(pick.score, kept, world, oppSize, null);
          if (DUAL) {
            PLAYOUT_DEFENSE = 0;
            for (const world of worlds) evH += await __horizonWorldValue(pick.score, kept, world, oppSize);
          }
        } finally {
          removeFromBoard(pick.placements);
          PLAYOUT_DEFENSE = 0; PLAYOUT_TEMP = 0;
          state.bag = new Array(BAG).fill('?');
        }
        return DUAL ? { t: ev / worlds.length, h: evH / worlds.length } : ev / worlds.length;
      };`);
  }
  policyRealm._sandbox.__B = bJson;
  policyRealm._sandbox.__R = rackStr;
  policyRealm._sandbox.__POOL = poolStr;
  policyRealm._sandbox.__P = JSON.stringify(pick);
  return policyRealm.evalInRealm('__policyValue()');
}

async function main() {
  const solver = coll.meta.solver || { budget: coll.meta.budget };
  console.log(coll.meta.oracle === 'dual'
    ? `Benchmark: ${COLL} (${coll.entries.length} positions, bag ${BAG} -> stage ${STG}, DUAL oracle: defense-${coll.meta.policyConfig.playoutDefense} playouts + 2-ply horizon x ${coll.meta.policyConfig.worlds} shared worlds, blended regret, top-${coll.meta.candidates})`
    : coll.meta.oracle === 'policy'
    ? `Benchmark: ${COLL} (${coll.entries.length} positions, bag ${BAG} -> stage ${STG}, all-policy oracle: defense-${coll.meta.policyConfig.playoutDefense} playouts x ${coll.meta.policyConfig.worlds} worlds, top-${coll.meta.candidates})`
    : `Benchmark: ${COLL} (${coll.entries.length} positions, bag ${BAG} -> stage ${STG}, solver budget ${solver.budget}${solver.width ? `, width ${solver.width}, terminal` : ' (legacy reference)'}, top-${coll.meta.candidates})`);
  if (coll.meta.gameJsMd5) {
    const cur = require('crypto').createHash('md5').update(fs.readFileSync(ENGINE)).digest('hex');
    if (cur !== coll.meta.gameJsMd5) {
      console.log(`NOTE: game.js differs from the one this collection was built under (${coll.meta.gameJsMd5.slice(0, 8)} vs ${cur.slice(0, 8)}).`);
    }
  }
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
    tests.map((_, i) => `${('T' + i + ' regret').padStart(10)} ${'SE'.padStart(6)} ${'opt%'.padStart(6)} ${'avgMs'.padStart(6)} ${'p99ms'.padStart(6)}`).join(' ') +
    ` ${'elapsed'.padStart(9)}`);

  const msCounts = tests.map(() => []);
  const msTotals = tests.map(() => 0);
  const avgMs = i => {
    let sum = 0;
    for (let ms = 0; ms < msCounts[i].length; ms++) sum += ms * (msCounts[i][ms] || 0);
    return Math.round(sum / msTotals[i]);
  };
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
  let hbAt = 1; // checkpoint positions grow x1.5: 1, 2, 3, 5, 8, 12, ...
  let lastPrinted = 0;
  const printRow = () => {
    const cols = tests.map((_, i) => {
      const r = regrets[i];
      if (!r.length) return `${'—'.padStart(10)} ${'—'.padStart(6)} ${'—'.padStart(6)} ${'—'.padStart(6)} ${'—'.padStart(6)}`;
      const mean = r.reduce((a, x) => a + x, 0) / r.length;
      const sd = r.length > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (r.length - 1)) : 0;
      return `${mean.toFixed(3).padStart(10)} ${(sd / Math.sqrt(r.length)).toFixed(3).padStart(6)} ${(100 * optimal[i] / r.length).toFixed(1).padStart(6)} ${String(avgMs(i)).padStart(6)} ${String(p99(i)).padStart(6)}`;
    }).join(' ');
    console.log(`${String(done).padStart(7)} ${cols} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
  };

  for (const e of coll.entries) {
    const bJson = JSON.stringify(decodeBoard(e.b));
    const rJson = JSON.stringify(rackArr(e.r));
    const DUAL = coll.meta.oracle === 'dual';
    const bySig = new Map(e.m.map(r => [r.k, r.ex]));
    const bySigH = DUAL ? new Map(e.m.map(r => [r.k, r.exh])) : null;
    const best = Math.max(...e.m.map(r => r.ex));
    const bestH = DUAL ? Math.max(...e.m.map(r => r.exh)) : 0;
    for (let i = 0; i < engines.length; i++) {
      engines[i]._sandbox.__B = bJson;
      engines[i]._sandbox.__R = rJson;
      const t = Date.now();
      const pick = JSON.parse(await engines[i].evalInRealm('__pick()'));
      const ms = Date.now() - t;
      msCounts[i][ms] = (msCounts[i][ms] || 0) + 1;
      msTotals[i]++;
      const coveredPick = e.m.find(a => a.k === pick.sig);
      let v = bySig.get(pick.sig);
      let vH = DUAL ? bySigH.get(pick.sig) : 0;
      if (v === undefined) {
        const rv = pick.placements ? await refValue(coll.meta, bJson, e.r, e.p, pick) : 'pass';
        if (DUAL) {
          if (typeof rv !== 'object' || rv === null) { unsolved[i]++; continue; }
          v = rv.t; vH = rv.h;
        } else {
          if (typeof rv !== 'number') { unsolved[i]++; continue; }
          v = rv;
        }
        uncovered[i]++;
        if (v - best > 1e-6) { beaten[i]++; beatenMax[i] = Math.max(beatenMax[i], v - best); }
      }
      // Dual collections score the mean of the two currencies' regrets:
      // a config must satisfy both judges to score well.
      const regret = DUAL
        ? (Math.max(0, best - v) + Math.max(0, bestH - vH)) / 2
        : Math.max(0, best - v);
      // A ref-solved pick can exceed the stored best (the builder's candidate
      // cut missed it); the baseline was loose, not the play superoptimal —
      // regret floors at 0 (the beaten footer still reports the discovery).
      if (DETAIL) {
        console.log(`  # pos ${String(done + 1).padStart(4)} T${i} s=${String(e.s ?? '-').padStart(10)} regret=${regret.toFixed(2).padStart(7)} ms=${String(ms).padStart(6)} pick=${pick.sig === 'pass' ? 'pass' : (coveredPick && coveredPick.w) || pick.sig}${bySig.get(pick.sig) === undefined ? ' [uncovered]' : ''}`);
      }
      regrets[i].push(regret);
      if (regret < 1e-6) optimal[i]++;
    }
    done++;
    if (done >= hbAt) { printRow(); lastPrinted = done; hbAt = Math.ceil(hbAt * 1.5); }
  }
  if (done !== lastPrinted) printRow(); // skip a final row that would duplicate the last checkpoint
  console.log(`\nUncovered picks ref-solved: ${uncovered.map((u, i) => `T${i}:${u}`).join(' ')}  (unsolved, excluded: ${unsolved.map((u, i) => `T${i}:${u}`).join(' ')})`);
  console.log(`Solver beaten (pick > stored best): ${beaten.map((b, i) => `T${i}:${b}${b ? ` (max +${beatenMax[i].toFixed(1)})` : ''}`).join(' ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
