#!/usr/bin/env node
// Train the rack-leave model (leaves.js) and record its training data.
//
// Usage:
//   node tools/train-leaves.js [--samples N] [--seed S]
//                              [--jobs J] [--out leaves.js] [--data FILE]
//                              [--fit-only | --record-only]
//
// Defaults: --samples 60000 --jobs (cpus, max 4)
//           --data data/leave-samples.jsonl
//           --seed random (logged, and stored in the data file's meta
//           line; pass --seed explicitly only to reproduce a past run)
//
// Every sampled evaluation is appended to the data file as one JSON line
// {"l":"<sorted leave letters>","y":<best next-move score>}, with a
// {"meta":...} line marking each recording run. The engine evaluations
// are the expensive part of training (~3 min per 60k), so retaining the
// rows makes model tweaks cheap:
//   --fit-only     refit weights from the recorded data (< 1 s); use
//                  after changing features or the regression, as long as
//                  features remain a function of the leave alone
//   --record-only  sample and append more data without refitting
// A normal run records new rows and then fits on the ENTIRE data file.
//
// Method: play seeded greedy self-play and draw exactly ONE random 7-tile
// rack per board reached (bag >= 8) — the first 0-6 tiles of the draw are
// the "leave" — then measure the best next-move score a plain greedy
// engine achieves with that rack. One sample per board means boards are
// never oversampled, so each sample is a near-independent observation. A
// ridge regression of score on leave features (per-letter counts and all
// unordered letter-pair counts; same-letter pairs encode duplicates, and
// synergies like QU emerge as pair weights) estimates each kept tile's
// marginal contribution. The pipeline is seeded and deterministic; both
// the self-play and the sampling fan out over workers on disjoint seeds.
//
// The evaluation engine is a copy of game.js placed in a directory with
// no leaves.js, so training always measures the greedy engine, never an
// engine already biased by previous weights.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { mulberry32, buildSeededBag, loadWords, loadEngine, playGame } = require('./match.js');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ?'.split('');
// Features: 27 per-letter counts, 378 unordered letter-pair counts
// (same-letter pairs encode duplicates), and an intercept. Pair keys are
// the two characters in lexicographic order ('?' sorts first) — the same
// keys leaveValue() in game.js looks up.
const LETTER_INDEX = {};
LETTERS.forEach((ch, i) => { LETTER_INDEX[ch] = i; });
const PAIR_KEYS = [];
const PAIR_INDEX = {};
for (let i = 0; i < LETTERS.length; i++) {
  for (let j = i; j < LETTERS.length; j++) {
    const key = [LETTERS[i], LETTERS[j]].sort().join('');
    PAIR_INDEX[key] = 27 + PAIR_KEYS.length;
    PAIR_KEYS.push(key);
  }
}
const DIM = 27 + PAIR_KEYS.length + 1; // + intercept

function parseArgs(argv) {
  const opts = {
    // seed defaults to a random value so repeated recording runs can never
    // silently append duplicate rows; pass --seed only to reproduce a run
    // (the seed used is logged and stored in the data file's meta line).
    samples: 60000, games: 16, seed: crypto.randomInt(1, 2 ** 31),
    jobs: null, // resolved after parsing: 1 for --record-only, else cpus (max 4)
    out: path.resolve(__dirname, '..', 'leaves.js'),
    data: path.resolve(__dirname, '..', 'data', 'leave-samples.jsonl'),
    fitOnly: false, recordOnly: false,
    worker: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--samples') opts.samples = parseInt(argv[++i], 10);
    else if (arg === '--games') opts.games = parseInt(argv[++i], 10);
    else if (arg === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (arg === '--jobs') opts.jobs = parseInt(argv[++i], 10);
    else if (arg === '--out') opts.out = path.resolve(process.cwd(), argv[++i]);
    else if (arg === '--data') opts.data = path.resolve(process.cwd(), argv[++i]);
    else if (arg === '--fit-only') opts.fitOnly = true;
    else if (arg === '--record-only') opts.recordOnly = true;
    else if (arg === '--worker') opts.worker = argv[++i]; // internal
    else { console.error(`Unknown argument: ${arg}`); process.exit(2); }
  }
  if (opts.fitOnly && opts.recordOnly) {
    console.error('--fit-only and --record-only are mutually exclusive.');
    process.exit(2);
  }
  if (opts.jobs === null) {
    // Recording chunks run in the background alongside other work
    // (matches, refits), so by default they take a single core.
    opts.jobs = opts.recordOnly ? 1 : Math.max(1, Math.min(4, os.cpus().length - 1));
  }
  return opts;
}

// leave: string of 'A'-'Z' / '?' chars — must mirror leaveValue() in game.js
function leaveFeatures(leave) {
  const x = new Float64Array(DIM);
  const counts = {};
  for (const ch of leave) counts[ch] = (counts[ch] || 0) + 1;
  const present = Object.keys(counts);
  for (const ch of present) {
    const n = counts[ch];
    x[LETTER_INDEX[ch]] = n;
    if (n >= 2) x[PAIR_INDEX[ch + ch]] = n * (n - 1) / 2;
  }
  for (let a = 0; a < present.length; a++) {
    for (let b = a + 1; b < present.length; b++) {
      const key = [present[a], present[b]].sort().join('');
      x[PAIR_INDEX[key]] = counts[present[a]] * counts[present[b]];
    }
  }
  x[DIM - 1] = 1; // intercept (dropped from the emitted weights)
  return x;
}

// ---------------------------------------------------------------
// Worker: evaluate its share of samples, return raw rows
// ---------------------------------------------------------------

async function runWorkerJob(spec) {
  const engine = loadEngine(spec.engineFile, loadWords(), { staticOnly: true });
  const rng = mulberry32(spec.seed);

  // No oversampling: play seeded greedy self-play and draw exactly ONE rack
  // per harvested board, so a board is never reused across samples. Keep
  // playing fresh games until this worker has produced its share of rows.
  const rows = [];
  let g = 0;
  while (rows.length < spec.count) {
    const positions = [];
    const bag = buildSeededBag(mulberry32(spec.gameSeed + g));
    g++;
    await playGame([engine, engine], bag, false, '', (board, bagNow, isFirstMove) => {
      // Need >= 8 unseen tiles: 7 to draw a rack and >= 1 left so the eval
      // stays on the static path (bagCount >= 1), never the endgame search.
      if (bagNow.length >= 8) {
        positions.push({ board: JSON.parse(JSON.stringify(board)), bag: bagNow.slice(), isFirstMove });
      }
    });
    for (const pos of positions) {
      if (rows.length >= spec.count) break;
      const pool = pos.bag.slice();
      // Draw 7 random tiles (partial Fisher-Yates); the first `l` are the leave
      for (let k = 0; k < 7; k++) {
        const j = k + Math.floor(rng() * (pool.length - k));
        [pool[k], pool[j]] = [pool[j], pool[k]];
      }
      const l = Math.floor(rng() * 7); // leave size 0..6
      const leave = pool.slice(0, l).map(ch => ch.toUpperCase()).sort().join('');
      const rack = pool.slice(0, 7).map(ch => ({ letter: ch, isBlank: ch === '?' }));
      const move = await engine.bestMove(pos.board, rack, pos.isFirstMove, pos.bag.length - 7);
      rows.push({ l: leave, y: move ? move.score : 0 });
    }
  }
  process.stdout.write(JSON.stringify({ rows: rows.slice(0, spec.count) }));
}

// ---------------------------------------------------------------
// Fit: ridge regression over rows (normal equations)
// ---------------------------------------------------------------

function solveRidge(xtx, xty, dim, lambda) {
  const A = new Float64Array(dim * dim);
  const b = Float64Array.from(xty);
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      A[i * dim + j] = i <= j ? xtx[i * dim + j] : xtx[j * dim + i]; // symmetrize
    }
    A[i * dim + i] += lambda;
  }
  for (let col = 0; col < dim; col++) {
    let pivot = col;
    for (let r = col + 1; r < dim; r++) {
      if (Math.abs(A[r * dim + col]) > Math.abs(A[pivot * dim + col])) pivot = r;
    }
    if (pivot !== col) {
      for (let j = 0; j < dim; j++) {
        [A[col * dim + j], A[pivot * dim + j]] = [A[pivot * dim + j], A[col * dim + j]];
      }
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const d = A[col * dim + col];
    for (let r = 0; r < dim; r++) {
      if (r === col || A[r * dim + col] === 0) continue;
      const f = A[r * dim + col] / d;
      for (let j = col; j < dim; j++) A[r * dim + j] -= f * A[col * dim + j];
      b[r] -= f * b[col];
    }
  }
  const w = new Float64Array(dim);
  for (let i = 0; i < dim; i++) w[i] = b[i] / A[i * dim + i];
  return w;
}

function fitRows(rows, lambda = 1.0) {
  const xtx = new Float64Array(DIM * DIM);
  const xty = new Float64Array(DIM);
  let sumY = 0;
  for (const row of rows) {
    const x = leaveFeatures(row.l);
    for (let i = 0; i < DIM; i++) {
      if (x[i] === 0) continue;
      xty[i] += x[i] * row.y;
      for (let j = i; j < DIM; j++) xtx[i * DIM + j] += x[i] * x[j];
    }
    sumY += row.y;
  }
  const w = solveRidge(xtx, xty, DIM, lambda);
  const round = v => Math.round(v * 1000) / 1000;
  const letter = {}, pair = {};
  LETTERS.forEach((ch, i) => { letter[ch] = round(w[i]); });
  PAIR_KEYS.forEach((key, i) => {
    const v = round(w[27 + i]);
    if (v !== 0) pair[key] = v; // omit pairs that round to zero
  });
  return {
    weights: { letter, pair },
    n: rows.length,
    meanY: sumY / rows.length,
  };
}

function readRows(dataFile) {
  if (!fs.existsSync(dataFile)) return [];
  const rows = [];
  for (const line of fs.readFileSync(dataFile, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.meta) continue; // provenance marker, not a sample
      rows.push(obj);
    } catch {
      // torn line from a concurrent recording run's append — skip
    }
  }
  return rows;
}

function emitWeights(outFile, fit, dataFile) {
  const banner =
`// Generated by tools/train-leaves.js — do not edit by hand.
// Rack-leave weights: expected next-move score contribution of kept tiles.
// Fit on ${fit.n} samples from ${path.basename(dataFile)} (mean next-move score ${fit.meanY.toFixed(1)}).
const LEAVE_WEIGHTS = `;
  fs.writeFileSync(outFile, banner + JSON.stringify(fit.weights, null, 2) + ';\n');
  const w = fit.weights;
  console.log(`Wrote ${outFile}`);
  console.log(`Spot checks — blank: ${w.letter['?']}, S: ${w.letter.S}, Q: ${w.letter.Q},` +
    ` QU pair: ${w.pair.QU ?? 0}, EE pair: ${w.pair.EE ?? 0}, ER pair: ${w.pair.ER ?? 0},` +
    ` II pair: ${w.pair.II ?? 0}, ?S pair: ${w.pair['?S'] ?? 0}`);
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.worker) return runWorkerJob(JSON.parse(opts.worker));
  const t0 = Date.now();

  if (opts.fitOnly) {
    const rows = readRows(opts.data);
    if (rows.length === 0) {
      console.error(`No samples in ${opts.data} — run without --fit-only first.`);
      process.exit(1);
    }
    console.log(`Refitting on ${rows.length} recorded samples...`);
    emitWeights(opts.out, fitRows(rows), opts.data);
    console.log(`Total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexite-train-'));
  // Evaluation engine: game.js copied where no leaves.js can sit beside it
  const engineFile = path.join(tmpDir, 'game.js');
  fs.copyFileSync(path.resolve(__dirname, '..', 'game.js'), engineFile);

  // Fan generation out over workers. Each worker plays its own seeded
  // greedy self-play and draws ONE rack per harvested board, so the number
  // of samples never exceeds the number of distinct boards seen — no board
  // is oversampled. Distinct per-worker game seeds keep their games (and
  // thus boards) disjoint.
  console.log(`Sampling ${opts.samples} leaves over ${opts.jobs} workers ` +
    `(one per board, no oversampling; seed ${opts.seed})...`);
  const specs = [];
  const per = Math.ceil(opts.samples / opts.jobs);
  for (let j = 0; j < opts.jobs; j++) {
    const count = Math.min(per, opts.samples - j * per);
    if (count <= 0) break;
    specs.push({
      engineFile, count,
      seed: opts.seed * 1000003 + j,
      gameSeed: opts.seed * 7919 + j * 100003 + 1,
    });
  }
  const partials = await Promise.all(specs.map(spec => new Promise((resolve, reject) => {
    execFile(process.execPath, [__filename, '--worker', JSON.stringify(spec)],
      { maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(JSON.parse(stdout));
      });
  })));
  const newRows = partials.flatMap(p => p.rows);

  // 3. Record: append a provenance marker plus the raw rows
  fs.mkdirSync(path.dirname(opts.data), { recursive: true });
  const runMeta = { meta: { seed: opts.seed, samples: newRows.length } };
  fs.appendFileSync(opts.data,
    JSON.stringify(runMeta) + '\n' + newRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`  Recorded ${newRows.length} samples to ${opts.data} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 4. Fit on the entire recorded dataset (unless only recording)
  if (!opts.recordOnly) {
    const rows = readRows(opts.data);
    console.log(`Fitting on all ${rows.length} recorded samples...`);
    emitWeights(opts.out, fitRows(rows), opts.data);
  }
  console.log(`Total ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = { LETTERS, PAIR_KEYS, DIM, leaveFeatures, fitRows, readRows };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
