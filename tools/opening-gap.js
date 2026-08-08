#!/usr/bin/env node
// Hunt for the opening rack where the simulation most strongly overrules
// the static point+leave ranking. Each iteration: draw a random 7-tile
// rack (seeded), pick the opening move with the full simulation stage on
// an empty board, and — when the sim overrode the static choice by more
// than the current record — VERIFY the candidate by re-running the same
// position at --verify-mult times the world count. A record hunt is a
// max over noisy estimates, so the biggest raw gaps are disproportionately
// sampling flukes (winner's curse: both original headline records
// evaporated at 10x worlds); only overrules that survive verification are
// accepted, and the verified gap is what the record tracks. Records print
// as table rows with both moves; heartbeats print on an exponential
// schedule. Runs until --iters or Ctrl-C.
//
// Usage: node tools/opening-gap.js [--seed S] [--iters N] [--engine FILE]
//                                  [--verify-mult M]
'use strict';

const path = require('path');
const { mulberry32, buildSeededBag, loadWords, loadEngine } = require('./match.js');

async function main() {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
  const seed = parseInt(arg('--seed', '1'), 10);
  const iters = parseInt(arg('--iters', '1000000000'), 10);
  const engineFile = path.resolve(process.cwd(), arg('--engine', 'game.js'));
  const verifyMult = parseInt(arg('--verify-mult', '10'), 10);
  const eng = loadEngine(engineFile, loadWords(), {}); // full engine: sim stages live
  eng.evalInRealm('TRACE.on = true');
  const baseSamples = eng.evalInRealm('STAGES.bagGt7.samples');
  const baseMinW = eng.evalInRealm('STAGES.bagGt7.minWorlds');
  const setSim = (samples, minW) =>
    eng.evalInRealm(`STAGES.bagGt7.samples = ${samples}; STAGES.bagGt7.minWorlds = ${minW};`);
  const emptyBoard = Array.from({ length: 15 }, () => new Array(15).fill(null));

  console.log(`Engine: ${engineFile}, base seed: ${seed} (opening racks, sim vs static, verify x${verifyMult})\n`);
  console.log(`${'iter'.padStart(8)} ${'rack'.padStart(8)} ${'cand'.padStart(6)} ${'gap'.padStart(6)} ${'z'.padStart(6)}  ${'static best'.padEnd(16)} ${'sim choice'.padEnd(16)}`);

  const fmt = m => !m ? 'pass'
    : m.exchange ? `exch ${m.tiles.length}`
    : `${(m.word || '').toUpperCase()} +${m.score}`;
  let record = 0, overrules = 0, candidates = 0, rejected = 0;
  let hb = 10, hbAt = 10;
  const t0 = Date.now();
  for (let i = 0; i < iters; i++) {
    const bag = buildSeededBag(mulberry32(seed + i));
    const rack = [];
    for (let k = 0; k < 7; k++) { const raw = bag.pop(); rack.push({ letter: raw, isBlank: raw === '?' }); }
    // The opponent's opening rack is drawn too (contents irrelevant — the
    // sim resamples worlds from the unseen pool — but the bag COUNT must
    // reflect it, or the engine deduces a zero-tile opponent and skips
    // simulation entirely).
    for (let k = 0; k < 7; k++) bag.pop();
    // First mover: the opponent carries the half-point komi.
    const move = await eng.bestMove(emptyBoard, rack, true, bag.length, 0, 0.5);
    const t = eng.evalInRealm('({o: TRACE.lastOverride, gap: TRACE.lastGap})');
    if (t.o) {
      overrules++;
      if (t.gap > record) {
        // Candidate record: re-run this position at verify-mult x the
        // worlds. Accept only if the overrule survives, and track the
        // VERIFIED gap (the base-world gap is winner's-curse inflated).
        candidates++;
        setSim(baseSamples * verifyMult, Math.max(baseMinW, 5 * baseMinW));
        eng.evalInRealm('TRACE.lastOverride = false; TRACE.lastGap = 0; TRACE.lastZ = 0;');
        const vMove = await eng.bestMove(emptyBoard, rack, true, bag.length, 0, 0.5);
        const v = eng.evalInRealm('({o: TRACE.lastOverride, gap: TRACE.lastGap, z: TRACE.lastZ})');
        setSim(baseSamples, baseMinW);
        if (v.o && v.gap > record) {
          record = v.gap;
          // State still holds this position (the bridge re-sets it per
          // call), so the static best is one in-realm search away.
          eng._sandbox.__RACK_JSON = JSON.stringify(rack);
          const sb = await eng.evalInRealm('findBestStaticMove(JSON.parse(__RACK_JSON))');
          const rackStr = rack.map(x => (x.isBlank ? '?' : x.letter)).join('');
          console.log(`${String(i).padStart(8)} ${rackStr.padStart(8)} ${t.gap.toFixed(1).padStart(6)} ${v.gap.toFixed(1).padStart(6)} ${(v.z >= 1e9 ? 99 : v.z).toFixed(1).padStart(6)}  ${fmt(sb).padEnd(16)} ${fmt(vMove).padEnd(16)}`);
        } else {
          rejected++;
        }
      }
    }
    if (i + 1 >= hbAt) {
      console.log(`${String(i + 1).padStart(8)} ${'·'.padStart(8)} ${'·'.padStart(6)} ${'·'.padStart(6)} ${'·'.padStart(6)}  overrules ${overrules} (${(100 * overrules / (i + 1)).toFixed(1)}%), candidates ${candidates} (${rejected} rejected), record ${record.toFixed(1)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      hb = Math.min(hb * 1.5, 5000); hbAt = (i + 1) + hb;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
