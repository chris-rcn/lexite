#!/usr/bin/env node
// Train the rack-leave model (leaves.js) and record its training data.
//
// Usage:
//   node tools/train-leaves.js [--samples N] [--games G] [--seed S]
//                              [--jobs J] [--out leaves.js] [--data FILE]
//                              [--fit-only | --record-only]
//
// Defaults: --samples 60000 --games 16 --jobs (cpus, max 4)
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
// Method: harvest board positions from seeded self-play, then for each
// sample pick a random position, draw a random 7-tile rack from its
// unseen pool — the first 0-6 tiles of the draw are the "leave" — and
// measure the best next-move score a plain greedy engine achieves with
// that rack. A ridge regression of score on leave features (per-letter
// counts, duplicate counts, leave size, vowel/consonant imbalance,
// Q-without-U) estimates each kept tile's marginal contribution. The
// pipeline is seeded and deterministic; sampling fans out over workers.
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
// Features: 27 per-letter counts, 27 per-letter duplicate counts,
// leave size, |vowels - consonants|, Q-without-U, intercept.
const DIM = 27 + 27 + 3 + 1;

function parseArgs(argv) {
  const opts = {
    // seed defaults to a random value so repeated recording runs can never
    // silently append duplicate rows; pass --seed only to reproduce a run
    // (the seed used is logged and stored in the data file's meta line).
    samples: 60000, games: 16, seed: crypto.randomInt(1, 2 ** 31),
    jobs: Math.max(1, Math.min(4, os.cpus().length - 1)),
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
  return opts;
}

// leave: string of 'A'-'Z' / '?' chars — must mirror leaveValue() in game.js
function leaveFeatures(leave) {
  const x = new Float64Array(DIM);
  const counts = {};
  for (const ch of leave) counts[ch] = (counts[ch] || 0) + 1;
  let vowels = 0, consonants = 0, hasQ = false, hasU = false, size = 0;
  LETTERS.forEach((ch, i) => {
    const n = counts[ch] || 0;
    if (n === 0) return;
    x[i] = n;
    x[27 + i] = n - 1;
    size += n;
    if (ch === 'Q') hasQ = true;
    if (ch === 'U') hasU = true;
    if (ch !== '?') {
      if ('AEIOU'.includes(ch)) vowels += n; else consonants += n;
    }
  });
  x[54] = size;
  x[55] = Math.abs(vowels - consonants);
  x[56] = hasQ && !hasU ? 1 : 0;
  x[57] = 1; // intercept (dropped from the emitted weights)
  return x;
}

// ---------------------------------------------------------------
// Worker: evaluate its share of samples, return raw rows
// ---------------------------------------------------------------

async function runWorkerJob(spec) {
  const positions = JSON.parse(fs.readFileSync(spec.positionsFile, 'utf8'));
  const engine = loadEngine(spec.engineFile, loadWords());
  const rng = mulberry32(spec.seed);

  const rows = [];
  for (let s = 0; s < spec.count; s++) {
    const pos = positions[Math.floor(rng() * positions.length)];
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
  process.stdout.write(JSON.stringify({ rows }));
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

function fitRows(rows) {
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
  const w = solveRidge(xtx, xty, DIM, 1.0);
  const round = v => Math.round(v * 1000) / 1000;
  const letter = {}, duplicate = {};
  LETTERS.forEach((ch, i) => {
    letter[ch] = round(w[i]);
    duplicate[ch] = round(w[27 + i]);
  });
  return {
    weights: {
      letter, duplicate,
      size: round(w[54]),
      imbalance: round(w[55]),
      qNoU: round(w[56]),
    },
    n: rows.length,
    meanY: sumY / rows.length,
  };
}

function readRows(dataFile) {
  if (!fs.existsSync(dataFile)) return [];
  const rows = [];
  for (const line of fs.readFileSync(dataFile, 'utf8').split('\n')) {
    if (!line) continue;
    const obj = JSON.parse(line);
    if (obj.meta) continue; // provenance marker, not a sample
    rows.push(obj);
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
    ` E: ${w.letter.E}, V: ${w.letter.V}, dup E: ${w.duplicate.E},` +
    ` imbalance: ${w.imbalance}, Q-no-U: ${w.qNoU}`);
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

  // 1. Harvest positions from seeded greedy self-play
  console.log(`Harvesting positions from ${opts.games} self-play games (seed ${opts.seed})...`);
  const words = loadWords();
  const engine = loadEngine(engineFile, words);
  const positions = [];
  for (let g = 0; g < opts.games; g++) {
    const bag = buildSeededBag(mulberry32(opts.seed + g));
    await playGame([engine, engine], bag, false, '', (board, bagNow, isFirstMove) => {
      // Need >= 7 unseen tiles to sample a rack; skip thin-bag endgames
      if (bagNow.length >= 7) {
        positions.push({
          board: JSON.parse(JSON.stringify(board)),
          bag: bagNow.slice(),
          isFirstMove,
        });
      }
    });
  }
  const positionsFile = path.join(tmpDir, 'positions.json');
  fs.writeFileSync(positionsFile, JSON.stringify(positions));
  console.log(`  ${positions.length} positions harvested (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 2. Fan sampling out over workers
  console.log(`Sampling ${opts.samples} leaves over ${opts.jobs} workers...`);
  const specs = [];
  const per = Math.ceil(opts.samples / opts.jobs);
  for (let j = 0; j < opts.jobs; j++) {
    const count = Math.min(per, opts.samples - j * per);
    if (count <= 0) break;
    specs.push({ positionsFile, engineFile, count, seed: opts.seed * 1000003 + j });
  }
  const partials = await Promise.all(specs.map(spec => new Promise((resolve, reject) => {
    execFile(process.execPath, [__filename, '--worker', JSON.stringify(spec)],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(JSON.parse(stdout));
      });
  })));
  const newRows = partials.flatMap(p => p.rows);

  // 3. Record: append a provenance marker plus the raw rows
  fs.mkdirSync(path.dirname(opts.data), { recursive: true });
  const runMeta = { meta: { seed: opts.seed, samples: newRows.length, games: opts.games } };
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

main().catch(e => { console.error(e); process.exit(1); });
