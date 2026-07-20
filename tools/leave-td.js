#!/usr/bin/env node
// Hierarchical leave-value training (TD, feature-based).
//
// Model: value(L) = sum over every non-empty sub-multiset S of L (size 1..6)
// of mult(S,L) * w[S], where mult(S,L) = prod_i C(L_i, S_i) — the same
// count-weighting the linear model uses for duplicate pairs, extended to all
// orders. Order 1+2 features ARE the current linear model; orders 3..6 are
// the higher interactions it can't express. Features share statistical
// strength across leaves, so rare leaves back off to their well-sampled
// low-order sub-features (adaptive regularization).
//
// Target (equity / TD): value(L_prev) = (movePoints - baseline) +
// value_snapshot(L_next). Trained by SGD against a frozen snapshot of the
// weights (a target network) refreshed each epoch, so the bootstrap is
// stable. L2 keeps unsupported high-order weights at ~0.
//
// When training converges, the 914,625-entry superleave table is built by
// evaluating value(L) for every leave (a zeta transform) and quantizing to
// one byte — features are the training basis, the table is deployment.
//
// Usage:
//   node tools/leave-td.js selftest
//   node tools/leave-td.js record --samples N [--out FILE] [--jobs J]
//   node tools/leave-td.js train  --data FILE [--epochs E] [--lr r] [--l2 x]
//                                  [--out leaves.bin.gz]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const SL = require('./superleave.js');
const { mulberry32, buildSeededBag, loadWords, loadEngine, playGame } = require('./match.js');

const NT = SL.NTYPES;           // 27
const SIZE = SL.TABLE_SIZE;     // 914625

// C(n,k) for n,k in 0..6
const BINOM = [];
for (let n = 0; n <= 6; n++) {
  BINOM[n] = [];
  for (let k = 0; k <= 6; k++) BINOM[n][k] = k > n ? 0 : (k === 0 ? 1 : BINOM[n - 1][k - 1] + BINOM[n - 1][k]);
}

// Enumerate every non-empty sub-multiset S of `counts` (|S| in 1..6),
// calling cb(rankS, multS) where multS = prod_i C(counts_i, S_i).
let MAXORD = 6; // cap on feature order (sub-multiset size); set by train
function setMaxOrder(k) { MAXORD = k; }
const _sub = new Int32Array(NT);
function eachSubFeature(counts, cb) {
  const present = [];
  for (let i = 0; i < NT; i++) if (counts[i] > 0) { present.push(i); _sub[i] = 0; }
  (function rec(pi, size, mult) {
    if (pi === present.length) {
      if (size >= 1) cb(SL.leaveRank(_sub), mult, size);
      return;
    }
    const t = present[pi], c = counts[t], maxS = Math.min(c, MAXORD - size);
    for (let s = 0; s <= maxS; s++) {
      _sub[t] = s;
      rec(pi + 1, size + s, mult * BINOM[c][s]);
    }
    _sub[t] = 0;
  })(0, 0, 1);
}

function valueFromFeatures(counts, w) {
  let v = 0;
  eachSubFeature(counts, (rank, mult) => { v += mult * w[rank]; });
  return v;
}

// Build the 1-byte superleave table by evaluating value(L) for every leave.
function buildTable(w) {
  const table = new Uint8Array(SIZE);
  for (let r = 0; r < SIZE; r++) table[r] = SL.encodeValue(valueFromFeatures(SL.leaveUnrank(r), w));
  return table;
}

// Seed a feature vector from the linear model: order-1 features = letter
// weights, order-2 = pair weights, higher = 0. valueFromFeatures then equals
// the linear model exactly (verified by selftest).
function seedFromLinear(weights) {
  const w = new Float64Array(SIZE);
  const code = ch => (ch === '?' ? 26 : ch.charCodeAt(0) - 65);
  const c1 = new Int32Array(NT);
  for (const [ch, v] of Object.entries(weights.letter || {})) {
    c1.fill(0); c1[code(ch)] = 1; w[SL.leaveRank(c1)] = v;
  }
  for (const [key, v] of Object.entries(weights.pair || {})) {
    c1.fill(0); c1[code(key[0])]++; c1[code(key[1])]++; w[SL.leaveRank(c1)] = v;
  }
  return w;
}

// ---- selftest -------------------------------------------------------------
function selftest() {
  let ok = true;
  const say = (n, p, e = '') => { if (!p) ok = false; console.log(`${p ? 'PASS' : 'FAIL'}: ${n}${p ? '' : ' — ' + e}`); };
  const W = SL.loadLinearWeights(path.resolve(__dirname, '..', 'leaves.js'));
  const w = seedFromLinear(W);
  // feature model with linear seed must reproduce the linear value exactly
  let maxErr = 0;
  for (let i = 1; i < SIZE; i += 4099) {
    const counts = SL.leaveUnrank(i);
    const a = valueFromFeatures(counts, w), b = SL.linearValue(counts, W);
    maxErr = Math.max(maxErr, Math.abs(a - b));
  }
  say('feature model with linear seed == linear value', maxErr < 1e-9, `maxErr ${maxErr}`);
  // a known triple: value(AES) = wA+wE+wS + wAE+wAS+wES + wAES; set wAES and check
  const aes = SL.leaveStringToCounts('AES');
  const base = valueFromFeatures(aes, w);
  w[SL.leaveRank(aes)] += 3.0;
  say('adding an order-3 feature shifts only its leaf', Math.abs(valueFromFeatures(aes, w) - (base + 3.0)) < 1e-9);
  const ae = SL.leaveStringToCounts('AE');
  say('order-3 feature does not affect its sub-leaf', Math.abs(valueFromFeatures(ae, w) - valueFromFeatures(ae, seedFromLinear(W))) < 1e-9);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
}

// ---- record: MDP transitions {l_prev, movePoints, l_next} -----------------
// Each worker plays leave-aware self-play, and for harvested boards draws a
// prev-leave + fill to a 7-tile rack, plays the policy's best move, and
// records (prev-leave, points, resulting leave) — one TD transition.
function rackRemainder(rack, placements) {
  const out = rack.slice();
  for (const p of placements) {
    const idx = out.findIndex(t => p.isBlank ? t.isBlank : (!t.isBlank && t.letter.toLowerCase() === p.letter.toLowerCase()));
    if (idx >= 0) out.splice(idx, 1);
  }
  return out;
}
const sortLeave = tiles => tiles.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).sort().join('');

async function recordWorker(spec) {
  const engine = loadEngine(spec.engineFile, loadWords(), { staticOnly: true }); // leave-aware static policy
  const rng = mulberry32(spec.seed);
  const rows = [];
  let g = 0;
  while (rows.length < spec.count) {
    const positions = [];
    const bag = buildSeededBag(mulberry32(spec.gameSeed + g)); g++;
    await playGame([engine, engine], bag, false, '', (board, bagNow, isFirstMove) => {
      if (bagNow.length >= 8) positions.push({ board: JSON.parse(JSON.stringify(board)), bag: bagNow.slice(), isFirstMove });
    });
    for (const pos of positions) {
      for (let rep = 0; rep < spec.reuse && rows.length < spec.count; rep++) {
        const pool = pos.bag.slice();
        for (let k = 0; k < 7; k++) { const j = k + Math.floor(rng() * (pool.length - k)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
        const lSize = Math.floor(rng() * 7);                 // prev-leave size 0..6
        const prevLeave = pool.slice(0, lSize).map(c => c.toUpperCase()).sort().join('');
        const rack = pool.slice(0, 7).map(ch => ({ letter: ch, isBlank: ch === '?' }));
        const move = await engine.bestMove(pos.board, rack, pos.isFirstMove, pos.bag.length - 7);
        if (!move || !move.placements) continue;             // no legal play: skip
        const next = rackRemainder(rack, move.placements);
        if (next.length > 6) continue;                       // out of feature domain (rare)
        rows.push({ l: prevLeave, p: move.score, r: sortLeave(next) });
      }
    }
  }
  process.stdout.write(JSON.stringify({ rows: rows.slice(0, spec.count) }));
}

// Trajectory recorder: chain each seat's leaves across a real self-play game
// (the on-policy stationary distribution) — required for the gamma=1 average-
// reward TD to be well-posed. prev[seat] is last turn's leftover leave ('' at
// game start); an exchange/pass breaks the chain.
async function recordTrajWorker(spec) {
  const engine = loadEngine(spec.engineFile, loadWords(), { staticOnly: true });
  const rows = [];
  let g = 0;
  while (rows.length < spec.count) {
    const bag = buildSeededBag(mulberry32(spec.gameSeed + g)); g++;
    const prev = ['', ''];
    await playGame([engine, engine], bag, false, '', null, (seat, type, points, leftover) => {
      if (type === 'play') {
        const r = sortLeave(leftover);
        if (prev[seat] !== undefined) rows.push({ l: prev[seat], p: points, r });
        prev[seat] = r;
      } else {
        prev[seat] = undefined; // exchange/pass: break the chain
      }
    });
  }
  process.stdout.write(JSON.stringify({ rows: rows.slice(0, spec.count) }));
}

async function record(opts) {
  const repo = path.resolve(__dirname, '..');
  const engineFile = repo + '/game.js'; // leave-aware (leaves.js + leaves.bin.gz beside it)
  const per = Math.ceil(opts.samples / opts.jobs), specs = [];
  for (let j = 0; j < opts.jobs; j++) {
    const count = Math.min(per, opts.samples - j * per); if (count <= 0) break;
    specs.push({ engineFile, count, reuse: 8, traj: opts.traj, seed: opts.seed * 1000003 + j, gameSeed: opts.seed * 7919 + j * 100003 + 1 });
  }
  const t0 = Date.now();
  const parts = await Promise.all(specs.map(spec => new Promise((res, rej) =>
    execFile(process.execPath, [__filename, '--worker', JSON.stringify(spec)], { maxBuffer: 512 * 1024 * 1024 },
      (e, out) => e ? rej(e) : res(JSON.parse(out))))));
  const rows = parts.flatMap(p => p.rows);
  fs.appendFileSync(opts.out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`Recorded ${rows.length} transitions to ${opts.out} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---- train: TD SGD over hierarchical features with a target-network -------
function train(opts) {
  setMaxOrder(opts.maxorder);
  // load transitions into flat count arrays
  const text = fs.readFileSync(opts.data, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const n = lines.length;
  const lC = new Uint8Array(n * NT), rC = new Uint8Array(n * NT), pArr = new Float32Array(n);
  const toCounts = (s, base, arr) => { for (const ch of s) arr[base + (ch === '?' ? 26 : ch.charCodeAt(0) - 65)]++; };
  let sumP = 0;
  for (let i = 0; i < n; i++) {
    const o = JSON.parse(lines[i]);
    toCounts(o.l, i * NT, lC); toCounts(o.r, i * NT, rC); pArr[i] = o.p; sumP += o.p;
  }
  const baseline = sumP / n;
  console.log(`${n} transitions, baseline (mean points) ${baseline.toFixed(2)}`);

  const w = new Float64Array(SIZE);        // features, init 0
  let wSnap = new Float64Array(SIZE);      // target network (frozen), init 0
  const lr = opts.lr, l2 = opts.l2, gamma = opts.gamma;
  // per-order L2 multiplier: penalize high-order features exponentially more
  // so main effects concentrate in low orders (functional-ANOVA prior).
  const ORDPEN = [0, 1, 1, 1, 1, 1, 1].map((_, k) => Math.pow(opts.penexp, Math.max(0, k - 1)));
  const cnt = new Int32Array(NT);
  // collect a leave's active features into reusable buffers; return count
  const rankBuf = new Int32Array(64), multBuf = new Float64Array(64), penBuf = new Float64Array(64);
  const collect = (arr, base) => {
    for (let k = 0; k < NT; k++) cnt[k] = arr[base + k];
    let m = 0;
    eachSubFeature(cnt, (rank, mult, size) => { rankBuf[m] = rank; multBuf[m] = mult; penBuf[m] = ORDPEN[size]; m++; });
    return m;
  };
  const evalCounts = (arr, base, ww) => {
    const m = collect(arr, base);
    let v = 0; for (let j = 0; j < m; j++) v += multBuf[j] * ww[rankBuf[j]];
    return v;
  };

  for (let ep = 0; ep < opts.epochs; ep++) {
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const vr = evalCounts(rC, i * NT, wSnap);       // snapshot value of next leave
      const m = collect(lC, i * NT);                  // l's features -> rankBuf/multBuf
      let v = 0, norm = 0;
      for (let j = 0; j < m; j++) { v += multBuf[j] * w[rankBuf[j]]; norm += multBuf[j] * multBuf[j]; }
      const target = (pArr[i] - baseline) + gamma * vr;
      const err = target - v; sse += err * err;
      const step = lr * err / (norm + 1);             // NLMS: bounded move toward target
      for (let j = 0; j < m; j++) w[rankBuf[j]] += step * multBuf[j] - lr * l2 * penBuf[j] * w[rankBuf[j]];
    }
    wSnap = w.slice();                                // refresh target network each epoch
    const sp = ['S', '?', 'EE', 'QU', 'ER', 'AEINRS'];
    const spot = sp.map(s => `${s}=${evalCounts(strC(s), 0, w).toFixed(2)}`).join(' ');
    console.log(`  epoch ${ep + 1}: rmse ${Math.sqrt(sse / n).toFixed(2)}  | ${spot}`);
  }

  const table = buildTable(w);
  const gz = zlib.gzipSync(Buffer.from(table.buffer), { level: 9 });
  fs.writeFileSync(opts.out, gz);
  console.log(`Wrote ${opts.out} (${(gz.length / 1024).toFixed(0)} KB gzip)`);
}
// small helper: leave string -> a length-27 Uint8Array counts buffer at base 0
function strC(s) { const a = new Uint8Array(NT); for (const ch of s) a[ch === '?' ? 26 : ch.charCodeAt(0) - 65]++; return a; }

function main() {
  const cmd = process.argv[2];
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
  if (cmd === 'selftest') return selftest();
  if (process.argv.includes('--worker')) {
    const spec = JSON.parse(process.argv[process.argv.indexOf('--worker') + 1]);
    return spec.traj ? recordTrajWorker(spec) : recordWorker(spec);
  }
  if (cmd === 'record' || cmd === 'record-traj') return record({
    traj: cmd === 'record-traj',
    samples: parseInt(arg('--samples', '100000'), 10),
    jobs: parseInt(arg('--jobs', String(Math.min(4, os.cpus().length - 1))), 10),
    seed: parseInt(arg('--seed', String(1 + Math.floor(1e6 * (Date.now() % 997) / 997))), 10),
    out: path.resolve(process.cwd(), arg('--out', 'data/leave-td.jsonl')),
  });
  if (cmd === 'train') return train({
    data: path.resolve(process.cwd(), arg('--data', 'data/leave-td.jsonl')),
    epochs: parseInt(arg('--epochs', '20'), 10),
    lr: parseFloat(arg('--lr', '0.5')),
    l2: parseFloat(arg('--l2', '0.002')),
    penexp: parseFloat(arg('--penexp', '1')),
    maxorder: parseInt(arg('--maxorder', '3'), 10),
    gamma: parseFloat(arg('--gamma', '1.0')),
    out: path.resolve(process.cwd(), arg('--out', 'leaves.bin.gz')),
  });
  console.error('usage: selftest | record | train'); process.exit(2);
}

if (require.main === module) main();

module.exports = { BINOM, eachSubFeature, valueFromFeatures, buildTable, seedFromLinear, NT, SIZE };
