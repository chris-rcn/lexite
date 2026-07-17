#!/usr/bin/env node
// Train the rack-leave model and write it to leaves.js.
//
// Usage:
//   node tools/train-leaves.js [--samples N] [--games G] [--seed S]
//                              [--jobs J] [--out leaves.js]
//
// Defaults: --samples 60000 --games 16 --seed 1 --jobs (cpus, max 4)
//
// Method: harvest board positions from seeded self-play, then for each
// training sample pick a random position, draw a random 7-tile rack from
// its unseen pool — the first 0-6 tiles of the draw are labeled the
// "leave" — and measure the best next-move score a plain greedy engine
// achieves with that rack. A ridge regression of score on leave features
// (per-letter counts, duplicate counts, leave size, vowel/consonant
// imbalance, Q-without-U) then estimates each kept tile's marginal
// contribution to next-turn score. The whole pipeline is seeded and
// deterministic; sampling fans out over worker processes.
//
// The evaluation engine is a copy of game.js placed in a directory with
// no leaves.js, so training always measures the greedy engine, never an
// engine already biased by previous weights.

'use strict';

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
    samples: 60000, games: 16, seed: 1,
    jobs: Math.max(1, Math.min(4, os.cpus().length - 1)),
    out: path.resolve(__dirname, '..', 'leaves.js'),
    worker: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--samples') opts.samples = parseInt(argv[++i], 10);
    else if (arg === '--games') opts.games = parseInt(argv[++i], 10);
    else if (arg === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (arg === '--jobs') opts.jobs = parseInt(argv[++i], 10);
    else if (arg === '--out') opts.out = path.resolve(process.cwd(), argv[++i]);
    else if (arg === '--worker') opts.worker = argv[++i]; // internal
    else { console.error(`Unknown argument: ${arg}`); process.exit(2); }
  }
  return opts;
}

// leaveChars: array of 'A'-'Z' / '?' — must mirror leaveValue() in game.js
function leaveFeatures(leaveChars) {
  const x = new Float64Array(DIM);
  const counts = {};
  for (const ch of leaveChars) counts[ch] = (counts[ch] || 0) + 1;
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
// Worker: accumulate partial normal-equation sums over its samples
// ---------------------------------------------------------------

async function runWorkerJob(spec) {
  const positions = JSON.parse(fs.readFileSync(spec.positionsFile, 'utf8'));
  const engine = loadEngine(spec.engineFile, loadWords());
  const rng = mulberry32(spec.seed);

  const xtx = new Float64Array(DIM * DIM);
  const xty = new Float64Array(DIM);
  let sumY = 0;

  for (let s = 0; s < spec.count; s++) {
    const pos = positions[Math.floor(rng() * positions.length)];
    const pool = pos.bag.slice();
    // Draw 7 random tiles (partial Fisher-Yates); the first `l` are the leave
    for (let k = 0; k < 7; k++) {
      const j = k + Math.floor(rng() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    const l = Math.floor(rng() * 7); // leave size 0..6
    const leave = pool.slice(0, l).map(ch => ch === '?' ? '?' : ch.toUpperCase());
    const rack = pool.slice(0, 7).map(ch => ({ letter: ch, isBlank: ch === '?' }));

    const move = await engine.bestMove(pos.board, rack, pos.isFirstMove, pos.bag.length - 7);
    const y = move ? move.score : 0;

    const x = leaveFeatures(leave);
    for (let i = 0; i < DIM; i++) {
      if (x[i] === 0) continue;
      xty[i] += x[i] * y;
      for (let j = i; j < DIM; j++) xtx[i * DIM + j] += x[i] * x[j];
    }
    sumY += y;
  }

  process.stdout.write(JSON.stringify({
    n: spec.count, sumY,
    xtx: Array.from(xtx), xty: Array.from(xty),
  }));
}

// ---------------------------------------------------------------
// Ridge solve (normal equations, Gaussian elimination w/ pivoting)
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

// ---------------------------------------------------------------
// Main: harvest positions, fan out sampling, fit, emit leaves.js
// ---------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.worker) return runWorkerJob(JSON.parse(opts.worker));

  const t0 = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexite-train-'));
  // Evaluation engine: game.js copied where no leaves.js can sit beside it
  const engineFile = path.join(tmpDir, 'game.js');
  fs.copyFileSync(path.resolve(__dirname, '..', 'game.js'), engineFile);

  // 1. Harvest positions from seeded greedy self-play
  console.log(`Harvesting positions from ${opts.games} self-play games...`);
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
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(JSON.parse(stdout));
      });
  })));

  const xtx = new Float64Array(DIM * DIM);
  const xty = new Float64Array(DIM);
  let n = 0, sumY = 0;
  for (const p of partials) {
    n += p.n; sumY += p.sumY;
    for (let i = 0; i < xtx.length; i++) xtx[i] += p.xtx[i];
    for (let i = 0; i < xty.length; i++) xty[i] += p.xty[i];
  }
  console.log(`  ${n} samples, mean next-move score ${(sumY / n).toFixed(1)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 3. Fit
  const w = solveRidge(xtx, xty, DIM, 1.0);
  const round = v => Math.round(v * 1000) / 1000;
  const letter = {}, duplicate = {};
  LETTERS.forEach((ch, i) => {
    letter[ch] = round(w[i]);
    duplicate[ch] = round(w[27 + i]);
  });
  const weights = {
    letter, duplicate,
    size: round(w[54]),
    imbalance: round(w[55]),
    qNoU: round(w[56]),
  };

  // 4. Emit
  const banner =
`// Generated by tools/train-leaves.js — do not edit by hand.
// Rack-leave weights: expected next-move score contribution of kept tiles.
// Trained on ${n} samples from ${opts.games} self-play games, base seed ${opts.seed}.
const LEAVE_WEIGHTS = `;
  fs.writeFileSync(opts.out, banner + JSON.stringify(weights, null, 2) + ';\n');
  console.log(`\nWrote ${opts.out}`);
  console.log(`Spot checks — blank: ${letter['?']}, S: ${letter.S}, Q: ${letter.Q},` +
    ` E: ${letter.E}, V: ${letter.V}, dup E: ${duplicate.E}, dup V: ${duplicate.V},` +
    ` imbalance: ${weights.imbalance}, Q-no-U: ${weights.qNoU}`);
  console.log(`Total ${(((Date.now() - t0)) / 1000).toFixed(1)}s`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });
