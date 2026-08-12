#!/usr/bin/env node
// Per-decision regret of midgame configurations against a heavyweight
// oracle, with the oracle's work persisted as a benchmark DB (the same
// pattern as the bag1/bag2 solve benchmarks): generate once, then score
// any config against the cached positions in minutes.
//
// A seeded static self-play driver emits bag>7 positions. At each sampled
// position the oracle — a superset candidate list (moves + the exchange,
// jointly ranked) evaluated over many worlds, no gate, no pruning —
// records every arm's mean value. Because every config chooses from the
// static top-K and the oracle's arm list is a superset, any config's
// choice is one of the oracle's arms: its regret is the oracle's best
// mean minus the mean of the chosen arm, in the oracle's currency
// (margin at the sim horizon).
//
// Modes:
//   --save FILE   generate the benchmark: run driver + oracle, append
//                 records to FILE (JSONL; resumes deterministically if
//                 FILE already has records with matching parameters).
//                 The header stamps the weights-file hash — a re-shipped
//                 model invalidates the benchmark by design.
//   --bench FILE  score --test configs against a saved benchmark: no
//                 driver, no oracle — each config just chooses moves at
//                 the cached positions (fast).
//   (neither)     online mode: driver + oracle + tests in one pass.
//
// Usage: node tools/oracle-regret.js [--save FILE | --bench FILE]
//        [--positions N] [--seed S] [--every K]
//        [--oracle-worlds W] [--oracle-candidates C] [--oracle-margin M]
//        [--engine FILE]
//        [--test CODE]...   realm eval per test config (repeatable);
//                           default tests: static, prod
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mulberry32, buildSeededBag, loadWords, loadEngine, playGame, stagesEval } = require('./match.js');

function moveSig(mv) {
  if (!mv) return 'pass';
  if (mv.exchange) return 'x:' + mv.tiles.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).sort().join('');
  return mv.placements.map(p => p.row + ',' + p.col + ':' + (p.isBlank ? '?' : '') + p.letter.toUpperCase()).sort().join('|');
}
const encBoard = board => board.map(row => row.map(c => (c ? [c.letter, c.isBlank ? 1 : 0] : 0)));
const decBoard = enc => enc.map(row => row.map(c =>
  (c ? { letter: c[0], isBlank: !!c[1], displayLetter: c[0] } : null)));
const decRack = s => [...s].map(ch => ({ letter: ch, isBlank: ch === '?' }));

// Wrap an engine's bestMove with an integer-ms histogram; returns a p99
// getter (same accounting as worlds-score.js).
function timed(eng) {
  const counts = [];
  let total = 0;
  const raw = eng.bestMove.bind(eng);
  eng.bestMove = async (...a) => {
    const t = Date.now();
    const r = await raw(...a);
    const ms = Date.now() - t;
    counts[ms] = (counts[ms] || 0) + 1;
    total++;
    return r;
  };
  return () => {
    let need = Math.ceil(0.99 * total), acc = 0;
    for (let ms = 0; ms < counts.length; ms++) { acc += counts[ms] || 0; if (acc >= need) return ms; }
    return 0;
  };
}

async function main() {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
  const positions = parseInt(arg('--positions', '1000000000'), 10);
  const seed = parseInt(arg('--seed', '1'), 10);
  const every = parseInt(arg('--every', '3'), 10);
  const oracleWorlds = parseInt(arg('--oracle-worlds', '200'), 10);
  // The margin filter is the relevant cut — candidates within M static
  // points of the best are the ones any config could plausibly pick — and
  // the count cap is a backstop against pathological flat positions. Test
  // configs stay contained as long as their own margin/candidates are
  // within the oracle's.
  const oracleCandidates = parseInt(arg('--oracle-candidates', '20'), 10);
  const oracleMargin = parseFloat(arg('--oracle-margin', '12'));
  const engineFile = path.resolve(process.cwd(), arg('--engine', 'game.js'));
  const saveFile = arg('--save', null) && path.resolve(process.cwd(), arg('--save'));
  const benchFile = arg('--bench', null) && path.resolve(process.cwd(), arg('--bench'));
  const tests = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--test') tests.push(process.argv[++i]);
  }
  if (tests.length === 0 && !saveFile) {
    tests.push('STAGES.bagGt7.static = true'); // static
    tests.push('STAGES.bagGt7.samples = 40; STAGES.bagGt7.candidates = 5; STAGES.bagGt7.margin = 10; STAGES.bagGt7.bayes = 1; STAGES.bagGt7.overruleP = 0.7; STAGES.bagGt7.minWorlds = 6'); // prod
  }

  const weightsPath = path.join(path.dirname(engineFile), 'leaves-w.txt.gz');
  const weightsMd5 = fs.existsSync(weightsPath)
    ? crypto.createHash('md5').update(fs.readFileSync(weightsPath)).digest('hex') : 'none';

  const words = loadWords();
  const neutral = `
    STAGES.bagGt7.margin = 0;
    STAGES.bagGt7.bayes = 0;
    STAGES.bagGt7.minWorlds = 1e9;
  `;
  const makeTests = () => tests.map(code => {
    const e = loadEngine(engineFile, words, {});
    e.evalInRealm(neutral + stagesEval(code));
    return e;
  });

  // ---- Bench mode: replay cached positions against the test configs ----
  if (benchFile) {
    const lines = fs.readFileSync(benchFile, 'utf8').split('\n').filter(Boolean);
    const header = JSON.parse(lines[0]);
    if (header.weightsMd5 !== weightsMd5) {
      console.error(`Benchmark is stale: weights hash ${header.weightsMd5} vs current ${weightsMd5}. Regenerate with --save.`);
      process.exit(2);
    }
    const records = lines.slice(1).map(l => JSON.parse(l));
    console.log(`Benchmark: ${benchFile} (${records.length} positions, oracle worlds=${header.oracleWorlds} candidates=${header.oracleCandidates} margin=${header.oracleMargin || 0}, seed ${header.seed}, every ${header.every})`);
    tests.forEach((t, i) => console.log(`  T${i}: ${t}`));
    console.log('');
    console.log(`${'pos'.padStart(7)} ` +
      tests.map((_, i) => `${('T' + i + ' regret').padStart(10)} ${'SE'.padStart(6)} ${'agr%'.padStart(6)} ${'p99ms'.padStart(6)}`).join(' ') +
      ` ${'elapsed'.padStart(9)}`);
    const testEngines = makeTests();
    const testP99 = testEngines.map(timed);
    const regrets = tests.map(() => []);
    const agree = tests.map(() => 0);
    const uncovered = tests.map(() => 0);
    const t0 = Date.now();
    let hb = 25, hbAt = 25, done = 0;
    const printRow = () => {
      const cols = tests.map((_, i) => {
        const r = regrets[i];
        if (!r.length) return `${'—'.padStart(10)} ${'—'.padStart(6)} ${'—'.padStart(6)} ${'—'.padStart(6)}`;
        const mean = r.reduce((a, x) => a + x, 0) / r.length;
        const sd = r.length > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (r.length - 1)) : 0;
        return `${mean.toFixed(3).padStart(10)} ${(sd / Math.sqrt(r.length)).toFixed(3).padStart(6)} ${(100 * agree[i] / r.length).toFixed(1).padStart(6)} ${String(testP99[i]()).padStart(6)}`;
      }).join(' ');
      console.log(`${String(done).padStart(7)} ${cols} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
    };
    for (const rec of records.slice(0, positions)) {
      const board = decBoard(rec.b);
      const rack = decRack(rec.r);
      const bySig = new Map(rec.e.map(([sig, mean]) => [sig, mean]));
      const best = bySig.get(rec.c);
      for (let i = 0; i < tests.length; i++) {
        const mv = await testEngines[i].bestMove(board, rack, !!rec.f, rec.n, 0, 0);
        const m = bySig.get(moveSig(mv));
        if (m === undefined || best === undefined) { uncovered[i]++; continue; }
        regrets[i].push(best - m);
        if (moveSig(mv) === rec.c) agree[i]++;
      }
      done++;
      if (done >= hbAt) { printRow(); hb = Math.min(hb * 1.5, 2000); hbAt = done + hb; }
    }
    printRow();
    console.log(`\nUncovered choices: ${uncovered.map((u, i) => `T${i}:${u}`).join(' ')}`);
    return;
  }

  // ---- Generation / online mode ----------------------------------------
  const oracle = loadEngine(engineFile, words, {});
  oracle.evalInRealm(neutral + `
    STAGES.bagGt7.samples = ${oracleWorlds};
    STAGES.bagGt7.candidates = ${oracleCandidates};
    STAGES.bagGt7.margin = ${oracleMargin};
    TRACE.on = 1;
  `);
  const driver = loadEngine(engineFile, words, {});
  driver.evalInRealm('STAGES.bagGt7.static = true;');
  const testEngines = makeTests();
  const testP99 = testEngines.map(timed);

  let out = null, skip = 0, already = 0;
  if (saveFile) {
    if (fs.existsSync(saveFile)) {
      const lines = fs.readFileSync(saveFile, 'utf8').split('\n').filter(Boolean);
      const header = JSON.parse(lines[0]);
      const same = header.weightsMd5 === weightsMd5 && header.oracleWorlds === oracleWorlds &&
        header.oracleCandidates === oracleCandidates && (header.oracleMargin || 0) === oracleMargin &&
        header.seed === seed && header.every === every;
      if (!same) { console.error('Existing benchmark has different parameters/weights; refusing to append.'); process.exit(2); }
      already = lines.length - 1;
      // Fast-forward by sampled ordinal (records store theirs in `i`);
      // legacy files without it predate trivial-position skipping, where
      // record count and ordinal coincide.
      const last = already > 0 ? JSON.parse(lines[lines.length - 1]) : null;
      skip = last ? (last.i !== undefined ? last.i + 1 : already) : 0;
      console.log(`Resuming ${saveFile}: ${already} positions already saved (ordinal ${skip})`);
    } else {
      fs.writeFileSync(saveFile, JSON.stringify({ v: 1, weightsMd5, oracleWorlds, oracleCandidates, oracleMargin, seed, every, engine: path.basename(engineFile) }) + '\n');
    }
    out = fs.openSync(saveFile, 'a');
  }

  console.log(`Engine: ${engineFile}, oracle worlds=${oracleWorlds} candidates=${oracleCandidates} margin=${oracleMargin}, every ${every}th bag>7 position, base seed ${seed}` +
    (saveFile ? `\nSaving to ${saveFile} (weights ${weightsMd5.slice(0, 8)})` : ''));
  tests.forEach((t, i) => console.log(`  T${i}: ${t}`));
  console.log('');
  console.log(`${'pos'.padStart(7)} ` +
    tests.map((_, i) => `${('T' + i + ' regret').padStart(10)} ${'SE'.padStart(6)} ${'agr%'.padStart(6)} ${'p99ms'.padStart(6)}`).join(' ') +
    (tests.length ? ' ' : '') + `${'orc99'.padStart(7)} ${'elapsed'.padStart(9)}`);

  const p99ms = timed(oracle);

  const regrets = tests.map(() => []);
  const agree = tests.map(() => 0);
  const uncovered = tests.map(() => 0);
  let seen = 0, sampledSeen = 0, sampled = 0, saved = already;
  let hb = 10, hbAt = 10;
  const t0 = Date.now();
  const printRow = () => {
    const cols = tests.map((_, i) => {
      const r = regrets[i];
      if (!r.length) return `${'—'.padStart(10)} ${'—'.padStart(6)} ${'—'.padStart(6)} ${'—'.padStart(6)}`;
      const mean = r.reduce((a, x) => a + x, 0) / r.length;
      const sd = r.length > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (r.length - 1)) : 0;
      return `${mean.toFixed(3).padStart(10)} ${(sd / Math.sqrt(r.length)).toFixed(3).padStart(6)} ${(100 * agree[i] / r.length).toFixed(1).padStart(6)} ${String(testP99[i]()).padStart(6)}`;
    }).join(' ');
    console.log(`${String(sampled).padStart(7)} ${cols}${tests.length ? ' ' : ''}${String(p99ms()).padStart(7)} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);
  };

  // In save mode --positions is the TOTAL in the file (resume generates
  // the remainder); online it is the number scored this run.
  const doneEnough = () => (out !== null ? saved : sampled) >= positions;
  let game = 0;
  while (!doneEnough()) {
    const bag = buildSeededBag(mulberry32(seed + game++));
    const onPosition = async (board, b, isFirstMove, rack) => {
      if (b.length <= 7) return false;
      if (seen++ % every !== 0) return true;
      const si = sampledSeen++; // ordinal among sampled positions (trivial included)
      if (si < skip) return true; // resume fast-forward: no oracle
      // Trivial positions never reach the sim path (no legal move, or a
      // single arm after the margin cut) and never write TRACE — which
      // would otherwise still hold the previous sampled decision's arms.
      // Clear first; when it stays empty the position cannot discriminate
      // between configs (every contained config makes the same choice), so
      // it is skipped entirely. Records carry their sampled ordinal `i`,
      // so resume alignment does not depend on trivial positions.
      oracle.evalInRealm('TRACE.lastArmEvals = null; TRACE.lastChosenSig = null;');
      await oracle.bestMove(board, rack, isFirstMove, b.length, 0, 0);
      const evals = oracle.evalInRealm('TRACE.lastArmEvals') || [];
      if (!evals.length) return true;
      const chosenSig = oracle.evalInRealm('TRACE.lastChosenSig');
      const sigs = [];
      for (const e of testEngines) sigs.push(moveSig(await e.bestMove(board, rack, isFirstMove, b.length, 0, 0)));
      if (out !== null) {
        const rec = {
          i: si,
          b: encBoard(board),
          r: rack.map(t => (t.isBlank ? '?' : t.letter)).join(''),
          n: b.length, f: isFirstMove ? 1 : 0,
          e: evals.filter(a => a.mean !== null).map(a => [a.sig, +a.mean.toFixed(3), +a.staticVal.toFixed(2)]),
          c: chosenSig,
        };
        fs.writeSync(out, JSON.stringify(rec) + '\n');
        saved++;
      }
      const bySig = new Map();
      for (const a of evals) if (a.mean !== null) bySig.set(a.sig, a.mean);
      const best = bySig.get(chosenSig);
      for (let i = 0; i < tests.length; i++) {
        const m = bySig.get(sigs[i]);
        if (m === undefined || best === undefined) { uncovered[i]++; continue; }
        regrets[i].push(best - m);
        if (sigs[i] === chosenSig) agree[i]++;
      }
      sampled++;
      if (sampled >= hbAt) { printRow(); hb = Math.min(hb * 1.5, 2000); hbAt = sampled + hb; }
      return !doneEnough();
    };
    await playGame([driver, driver], bag, false, '', onPosition, null);
  }
  printRow();
  if (out !== null) { fs.closeSync(out); console.log(`\nSaved ${saved} positions total to ${saveFile}`); }
  if (tests.length) console.log(`Uncovered choices: ${uncovered.map((u, i) => `T${i}:${u}`).join(' ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
