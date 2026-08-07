#!/usr/bin/env node
// Calibrate how much margin randomness remains from each bag size to the
// end of a game — phase 0 of a midgame P(win) objective. Plays static
// self-play games and, for every bag size k, collects the mover-perspective
// standing when the bag first held k tiles together with the (same
// perspective) final margin. The residual final - standing decomposes into:
//   mu(k)    = mean residual — the tempo drift (the player about to move
//              gains this much by game end, on average)
//   sigma(k) = residual sd — the noise a margin -> P(win) transform must
//              divide by: P(win) ~ Phi((margin + mu(k)) / sigma(k))
// Also reports a random-walk fit sigma^2(k) ~ alpha*k + beta and a
// Gaussianity check (fraction of residuals within 1 and 2 sigma).
//
// Usage: node tools/margin-sigma.js [--games N] [--jobs J] [--seed S]
//        [--engine FILE] [--out FILE.json]
// With a superleave table beside the engine (leaves-w.txt.gz), a second
// CONDITIONAL calibration is reported: residuals of final margin against
// the predictor the engine's horizon evaluation actually uses — standing
// plus the bag-damped leave differential of the two known racks — giving
// the sigma a per-world Phi should divide by (the raw sigma includes rack
// uncertainty that a sampled world has already resolved).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const SL = require('./superleave.js');
const td = require('./leave-td.js');
const { mulberry32, buildSeededBag, runPool } = require('./match.js');

// Byte table beside the engine, decoded with engine-identical semantics:
// direct lookup for <=6 tiles, drop-one mean for 7 (mirrors game.js).
function loadTableBeside(engine) {
  const wPath = path.join(path.dirname(engine), 'leaves-w.txt.gz');
  if (!fs.existsSync(wPath)) return null;
  const w = new Float64Array(SL.TABLE_SIZE);
  for (const p of zlib.gunzipSync(fs.readFileSync(wPath)).toString().split(',')) {
    const c = p.indexOf(':');
    w[+p.slice(0, c)] = +p.slice(c + 1);
  }
  return td.buildTable(w);
}
const decodeB = b => (b - 128) * 0.375;
function leaveVal(table, str) {
  const counts = new Int32Array(27);
  for (const ch of str) counts[ch === '?' ? 26 : ch.charCodeAt(0) - 65]++;
  if (str.length <= 6) return decodeB(table[SL.leaveRank(counts)]);
  let sum = 0;
  for (let i = 0; i < 27; i++) {
    const c = counts[i]; if (!c) continue;
    counts[i] = c - 1; sum += c * decodeB(table[SL.leaveRank(counts)]); counts[i] = c;
  }
  return sum / 7;
}

async function main() {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
  const games = parseInt(arg('--games', '2000'), 10);
  const jobs = parseInt(arg('--jobs', String(Math.max(1, Math.min(6, os.cpus().length - 2)))), 10);
  const seed = parseInt(arg('--seed', '1'), 10);
  const engine = path.resolve(process.cwd(), arg('--engine', path.join(__dirname, '..', 'game.js')));
  const out = arg('--out') ? path.resolve(process.cwd(), arg('--out')) : null;

  console.log(`Engine: ${engine}\nGames: ${games} (static self-play), base seed: ${seed}, jobs: ${jobs}\n`);
  const specs = [];
  for (let g = 0; g < games; g++) {
    specs.push({ a: engine, b: engine, swap: false, bag: buildSeededBag(mulberry32(seed + g)), seed: seed + g, staticOnly: true });
  }

  const table = loadTableBeside(engine);
  console.log(table ? 'Conditional calibration: leaves-w.txt.gz found beside engine\n'
                    : 'No leaves-w.txt.gz beside engine: raw calibration only\n');
  const t0 = Date.now();
  let done = 0, tickPeriod = 20, tickAt = 20;
  const buckets = new Map();     // k -> raw residuals (final - standing)
  const condBuckets = new Map(); // k -> residuals net of the damped leave differential
  const onResult = r => {
    const final = r.aScore - r.bScore;               // A-perspective (a === b engine)
    for (const [k, m] of Object.entries(r.marginAtBag)) {
      const moverIsA = r.moverAtBag[k] === 1;
      const x = moverIsA ? m : -m;                   // standing, mover perspective
      const y = moverIsA ? final : -final;           // final, same perspective
      let b = buckets.get(+k);
      if (!b) buckets.set(+k, b = []);
      b.push(y - x);
      if (table && r.rackAtBag && r.rackAtBag[k]) {
        const [s0, s1] = r.rackAtBag[k];             // seat-indexed; seat0 === A here
        const moverRack = moverIsA ? s0 : s1, oppRack = moverIsA ? s1 : s0;
        const ld = Math.min(1, +k / 7) * (leaveVal(table, moverRack) - leaveVal(table, oppRack));
        let cb = condBuckets.get(+k);
        if (!cb) condBuckets.set(+k, cb = []);
        cb.push(y - x - ld);
      }
    }
    if (++done >= tickAt) {
      console.log(`  [${done}/${games} games] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      tickPeriod *= 1.5; tickAt = done + tickPeriod;
    }
  };
  await runPool(specs, jobs, onResult);

  // Per-size stats + weighted linear fit of sigma^2 against k, for the raw
  // residuals and (table permitting) the leave-conditioned ones.
  const statsOf = bk => {
    const rows = [];
    for (const k of [...bk.keys()].sort((a, b) => a - b)) {
      const r = bk.get(k), n = r.length;
      if (n < 20) continue;
      const mu = r.reduce((s, v) => s + v, 0) / n;
      const sd = Math.sqrt(r.reduce((s, v) => s + (v - mu) * (v - mu), 0) / (n - 1));
      const in1 = r.filter(v => Math.abs(v - mu) <= sd).length / n;
      const in2 = r.filter(v => Math.abs(v - mu) <= 2 * sd).length / n;
      rows.push({ k, n, mu, sd, in1, in2 });
    }
    let sw = 0, sk = 0, sv = 0, skk = 0, skv = 0;
    for (const { k, n, sd } of rows) {
      const v = sd * sd;
      sw += n; sk += n * k; sv += n * v; skk += n * k * k; skv += n * k * v;
    }
    const alpha = (sw * skv - sk * sv) / (sw * skk - sk * sk);
    const beta = (sv - alpha * sk) / sw;
    return { rows, alpha, beta };
  };
  const raw = statsOf(buckets);
  const cond = table ? statsOf(condBuckets) : null;

  console.log('\n   k     n     mu   sigma  fit' + (cond ? ' |   muC  sigC  fitC' : '') + '    |r|<1sd  <2sd');
  for (const { k, n, mu, sd, in1, in2 } of raw.rows) {
    if (k > 20 && k % 4 !== 0) continue; // full detail late-game, sampled early
    const fit = Math.sqrt(Math.max(0, raw.alpha * k + raw.beta));
    let mid = '';
    if (cond) {
      const c = cond.rows.find(x => x.k === k);
      const fitC = Math.sqrt(Math.max(0, cond.alpha * k + cond.beta));
      mid = c ? ` | ${c.mu.toFixed(1).padStart(5)} ${c.sd.toFixed(1).padStart(5)} ${fitC.toFixed(1).padStart(5)}` : ' |                  ';
    }
    console.log(`  ${String(k).padStart(2)} ${String(n).padStart(6)} ${mu.toFixed(1).padStart(6)} ${sd.toFixed(1).padStart(6)} ${fit.toFixed(1).padStart(5)}${mid}    ${in1.toFixed(2)}    ${in2.toFixed(2)}`);
  }
  console.log(`\nRaw fit:  sigma^2(k) = ${raw.alpha.toFixed(2)}*k + ${raw.beta.toFixed(1)}  (sigma(0) = ${Math.sqrt(Math.max(0, raw.beta)).toFixed(1)})`);
  if (cond) console.log(`Cond fit: sigmaC^2(k) = ${cond.alpha.toFixed(2)}*k + ${cond.beta.toFixed(1)}  (sigmaC(0) = ${Math.sqrt(Math.max(0, cond.beta)).toFixed(1)}; residual net of damped leave differential)`);

  if (out) {
    const j = { games, engine: path.basename(engine), raw: { alpha: raw.alpha, beta: raw.beta, mu: {}, sigma: {} } };
    for (const { k, mu, sd } of raw.rows) { j.raw.mu[k] = +mu.toFixed(2); j.raw.sigma[k] = +sd.toFixed(2); }
    if (cond) {
      j.cond = { alpha: cond.alpha, beta: cond.beta, mu: {}, sigma: {} };
      for (const { k, mu, sd } of cond.rows) { j.cond.mu[k] = +mu.toFixed(2); j.cond.sigma[k] = +sd.toFixed(2); }
    }
    fs.writeFileSync(out, JSON.stringify(j, null, 1));
    console.log(`Wrote ${out}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
