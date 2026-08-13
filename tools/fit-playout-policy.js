#!/usr/bin/env node
// Fit the reference playout policy's temperature from preend truth files.
// Model: an arm's reference value = its static value + N(0, sigma^2) noise,
// so P(the arm d points behind on statics is actually better) = Phi(-d/(sigma*sqrt(2))).
// Probability-matching playout policy: play each reply with the probability
// that it is truly best given the static gaps — sigma is the one parameter.
// MLE over all within-position arm pairs (gap d >= 0, outcome = does the
// static leader hold on reference values); exact ties are skipped.
//
//   node tools/fit-playout-policy.js <solves.json> [<solves.json> ...]
'use strict';
const fs = require('fs');

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (files.length === 0) {
  console.error('Usage: node tools/fit-playout-policy.js <solves.json> [<solves.json> ...]');
  process.exit(2);
}

const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function pairsOf(file) {
  const coll = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const e of coll.entries) {
    const arms = e.m || e.results || [];
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const [hi, lo] = arms[i].sv >= arms[j].sv ? [arms[i], arms[j]] : [arms[j], arms[i]];
      if (hi.ex === lo.ex) continue;
      out.push({ d: hi.sv - lo.sv, hold: hi.ex > lo.ex ? 1 : 0 });
    }
  }
  return { bag: coll.meta.bagSize, n: coll.entries.length, pairs: out };
}

function fitSigma(pairs) {
  const ll = sigma => {
    let s = 0;
    for (const p of pairs) {
      const q = Phi(p.d / (sigma * Math.SQRT2));
      s += Math.log(Math.max(1e-12, p.hold ? q : 1 - q));
    }
    return s;
  };
  // Golden-section maximize over sigma in [0.5, 60].
  let a = 0.5, b = 60;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = ll(c), fd = ll(d);
  for (let it = 0; it < 80; it++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = ll(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = ll(d); }
  }
  return (a + b) / 2;
}

function binTable(pairs, sigma) {
  const edges = [0, 1, 2, 4, 8, 16, 32, Infinity];
  console.log(`${'gap'.padStart(9)} ${'pairs'.padStart(7)} ${'leader holds'.padStart(13)} ${'fitted'.padStart(7)}`);
  for (let k = 0; k + 1 < edges.length; k++) {
    const sel = pairs.filter(p => p.d >= edges[k] && p.d < edges[k + 1]);
    if (!sel.length) continue;
    const emp = sel.reduce((s, p) => s + p.hold, 0) / sel.length;
    const dbar = sel.reduce((s, p) => s + p.d, 0) / sel.length;
    const fit = Phi(dbar / (sigma * Math.SQRT2));
    const label = edges[k + 1] === Infinity ? `${edges[k]}+` : `${edges[k]}-${edges[k + 1]}`;
    console.log(`${label.padStart(9)} ${String(sel.length).padStart(7)} ${(100 * emp).toFixed(1).padStart(12)}% ${(100 * fit).toFixed(1).padStart(6)}%`);
  }
}

// Probability-matching play distribution over the top-K static replies for
// a given gap vector, by Monte Carlo under the fitted noise model.
function matchProbs(gaps, sigma, trials) {
  const wins = new Array(gaps.length).fill(0);
  let seed = 12345;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  for (let t = 0; t < trials; t++) {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < gaps.length; i++) {
      const v = -gaps[i] + sigma * gauss();
      if (v > bv) { bv = v; bi = i; }
    }
    wins[bi]++;
  }
  return wins.map(w => w / trials);
}

const perFile = files.map(pairsOf);
for (const f of perFile) {
  const sigma = fitSigma(f.pairs);
  console.log(`\nbag=${f.bag}: ${f.n} positions, ${f.pairs.length} arm pairs, sigma = ${sigma.toFixed(2)}`);
  binTable(f.pairs, sigma);
}
// Pooled fit weighs every input file equally: subsample each file's pair
// set down to the smallest file's count (deterministic shuffle).
const minN = Math.min(...perFile.map(f => f.pairs.length));
let seed = 987654321;
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const all = perFile.flatMap(f => {
  const p = f.pairs.slice();
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return p.slice(0, minN);
});
const sigma = fitSigma(all);
console.log(`\npooled (${minN} pairs/file): ${all.length} arm pairs, sigma = ${sigma.toFixed(2)}`);
binTable(all, sigma);

// Mean top-3 static gaps across all positions, and the implied play mix.
const gapSums = [0, 0]; let gapN = 0;
for (const file of files) {
  const coll = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of coll.entries) {
    const arms = (e.m || e.results || []).slice().sort((a, b) => b.sv - a.sv);
    if (arms.length < 3) continue;
    gapSums[0] += arms[0].sv - arms[1].sv; gapSums[1] += arms[0].sv - arms[2].sv; gapN++;
  }
}
if (gapN) {
  const g1 = gapSums[0] / gapN, g2 = gapSums[1] / gapN;
  const probs = matchProbs([0, g1, g2], sigma, 200000);
  console.log(`\nmean top-3 static gaps: 0 / ${g1.toFixed(1)} / ${g2.toFixed(1)}`);
  console.log(`probability-matching play mix: ${probs.map(p => (100 * p).toFixed(0) + '%').join(' / ')}`);
}
