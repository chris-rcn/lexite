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
//   node tools/leave-td.js online-learn [--ckpt FILE] [--probe-ratio R] ...
//   node tools/leave-td.js export --ckpt FILE [--out FILE.bin.gz]
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
// The rank is accumulated incrementally during the recursion: it visits
// tile types in leaveRank's canonical order, and choosing s copies of type
// t with remaining budget R contributes sum_{v<s} G[t+1][R-v] — the same
// terms leaveRank would add, without a full 27-type rescan per feature
// (the enumeration is the training hot path). Emission order is unchanged.
let MAXORD = 6; // cap on feature order (sub-multiset size); set by train
function setMaxOrder(k) { MAXORD = k; }
function eachSubFeature(counts, cb) {
  const present = [];
  for (let i = 0; i < NT; i++) if (counts[i] > 0) present.push(i);
  (function rec(pi, size, mult, idx, R) {
    if (pi === present.length) {
      if (size >= 1) cb(idx, mult, size);
      return;
    }
    const t = present[pi], c = counts[t], maxS = Math.min(c, MAXORD - size);
    for (let s = 0, add = 0; s <= maxS; s++) {
      rec(pi + 1, size + s, mult * BINOM[c][s], idx + add, R - s);
      add += SL.G[t + 1][R - s];
    }
  })(0, 0, 1, 0, SL.MAX_LEAVE);
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

// ---- export: online-learn checkpoint -> deployable superleave table -------
// The checkpoint's sparse feature weights are exactly the vector buildTable
// consumes, so exporting is: densify, evaluate every leave, quantize, gzip.
// Values outside the 1-byte codec's range clip to its rails (deep-junk
// leaves sit near the floor), so the clip count is reported.
function exportTable(opts) {
  const st = JSON.parse(fs.readFileSync(opts.ckpt, 'utf8'));
  const w = new Float64Array(SIZE);
  for (const part of st.w.split(',')) { const c = part.indexOf(':'); w[+part.slice(0, c)] = +part.slice(c + 1); }
  const lo = SL.decodeValue(0), hi = SL.decodeValue(255);
  const table = new Uint8Array(SIZE);
  let clipLo = 0, clipHi = 0;
  for (let r = 0; r < SIZE; r++) {
    const v = valueFromFeatures(SL.leaveUnrank(r), w);
    if (v < lo) clipLo++; else if (v > hi) clipHi++;
    table[r] = SL.encodeValue(v);
  }
  const gz = zlib.gzipSync(Buffer.from(table.buffer), { level: 9 });
  fs.writeFileSync(opts.out, gz);
  if (opts.weightsOut) {
    const wgz = zlib.gzipSync(Buffer.from(st.w), { level: 9 });
    fs.writeFileSync(opts.weightsOut, wgz);
    console.log(`Wrote ${opts.weightsOut} (${(wgz.length / 1024).toFixed(0)} KB gzip, ${st.w.split(',').length} features) — client assembles the table from these`);
  }
  console.log(`Wrote ${opts.out} (${(gz.length / 1024).toFixed(0)} KB gzip) from ${opts.ckpt} (games ${st.games}, trans ${st.trans})`);
  console.log(`  codec range [${lo.toFixed(1)}, ${hi.toFixed(1)}], clipped ${clipLo} low + ${clipHi} high of ${SIZE}`);
  console.log('  leave    raw     table');
  for (const s of ['S', '?', 'EE', 'QU', 'ER', 'AEINRS', 'UUVWII']) {
    const counts = SL.leaveStringToCounts(s);
    console.log(`  ${s.padEnd(7)}${valueFromFeatures(counts, w).toFixed(2).padStart(7)}${SL.decodeValue(table[SL.leaveRank(counts)]).toFixed(2).padStart(9)}`);
  }
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
      if (type === 'pass') { prev[seat] = undefined; return; } // pass: full rack kept, out of domain
      const r = sortLeave(leftover);                           // play or exchange (points=0): valid leave
      if (prev[seat] !== undefined) rows.push({ l: prev[seat], p: points, r });
      prev[seat] = r;
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
  const rankBuf = new Int32Array(64), multBuf = new Float64Array(64), penBuf = new Float64Array(64), sizeBuf = new Uint8Array(64);
  const collect = (arr, base) => {
    for (let k = 0; k < NT; k++) cnt[k] = arr[base + k];
    let m = 0;
    eachSubFeature(cnt, (rank, mult, size) => { rankBuf[m] = rank; multBuf[m] = mult; penBuf[m] = ORDPEN[size]; sizeBuf[m] = size; m++; });
    return m;
  };
  // per-feature diagnostics: how many times each feature is updated, and its order
  const nSeen = new Int32Array(SIZE), ordOf = new Uint8Array(SIZE);
  const evalCounts = (arr, base, ww) => {
    const m = collect(arr, base);
    let v = 0; for (let j = 0; j < m; j++) v += multBuf[j] * ww[rankBuf[j]];
    return v;
  };

  // liveTarget: compute the bootstrap target V(nextLeave) from the live,
  // currently-updating weights instead of a per-epoch frozen target network.
  // (This is an update-rule choice during replay of recorded data -- NOT
  // online learning; the trajectories were generated by a fixed policy.)
  const liveTarget = opts.liveTarget;
  // Polyak-Ruppert averaging: a live-target pass rattles around the fixed
  // point; averaging the weight iterates over the tail cancels that noise.
  // avgtail = fraction of final epochs to average (0 = disabled, use last w).
  const avgtail = opts.avgtail;
  const avgStart = avgtail > 0 ? Math.floor(opts.epochs * (1 - avgtail)) : opts.epochs;
  const wAvg = new Float64Array(SIZE); let avgN = 0;
  for (let ep = 0; ep < opts.epochs; ep++) {
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const vr = evalCounts(rC, i * NT, liveTarget ? w : wSnap); // value of next leave
      const m = collect(lC, i * NT);                  // l's features -> rankBuf/multBuf
      let v = 0, norm = 0;
      for (let j = 0; j < m; j++) { v += multBuf[j] * w[rankBuf[j]]; norm += multBuf[j] * multBuf[j]; }
      const target = (pArr[i] - baseline) + gamma * vr;
      const err = target - v; sse += err * err;
      const step = lr * err / (norm + 1);             // NLMS: bounded move toward target
      for (let j = 0; j < m; j++) {
        w[rankBuf[j]] += step * multBuf[j] - lr * l2 * penBuf[j] * w[rankBuf[j]];
        if (ep === 0) { nSeen[rankBuf[j]]++; ordOf[rankBuf[j]] = sizeBuf[j]; }
      }
    }
    if (!liveTarget) wSnap = w.slice();               // refresh target network each epoch
    if (ep >= avgStart) { for (let k = 0; k < SIZE; k++) wAvg[k] += w[k]; avgN++; }
    const sp = ['S', '?', 'EE', 'QU', 'ER', 'AEINRS'];
    const spot = sp.map(s => `${s}=${evalCounts(strC(s), 0, w).toFixed(2)}`).join(' ');
    console.log(`  epoch ${ep + 1}: rmse ${Math.sqrt(sse / n).toFixed(2)}  | ${spot}`);
  }

  // final weights: Polyak average over the tail, or the last iterate
  let wFinal = w;
  if (avgN > 0) {
    for (let k = 0; k < SIZE; k++) wAvg[k] /= avgN;
    wFinal = wAvg;
    const sp = ['S', '?', 'EE', 'QU', 'ER', 'AEINRS'];
    const spot = sp.map(s => `${s}=${evalCounts(strC(s), 0, wFinal).toFixed(2)}`).join(' ');
    console.log(`  averaged over last ${avgN} epochs | ${spot}`);
  }
  // optional: dump raw FEATURE weights with order + sample count for diagnostics
  if (opts.dumpw) {
    const out = [];
    for (let r = 0; r < SIZE; r++) if (nSeen[r] > 0) out.push(`${ordOf[r]} ${nSeen[r]} ${wFinal[r].toFixed(5)}`);
    fs.writeFileSync(opts.dumpw, out.join('\n') + '\n');
    console.log(`Dumped ${out.length} feature weights to ${opts.dumpw}`);
  }
  const table = buildTable(wFinal);
  const gz = zlib.gzipSync(Buffer.from(table.buffer), { level: 9 });
  fs.writeFileSync(opts.out, gz);
  console.log(`Wrote ${opts.out} (${(gz.length / 1024).toFixed(0)} KB gzip)`);
}
// small helper: leave string -> a length-27 Uint8Array counts buffer at base 0
function strC(s) { const a = new Uint8Array(NT); for (const ch of s) a[ch === '?' ? 26 : ch.charCodeAt(0) - 65]++; return a; }

// TRUE online learning: play self-play games while updating the leave-value
// weights after every move, with the move-search policy reading those same
// (live) weights via the engine's leave hook. Weights start at ZERO -- no
// linear seed, no loaded table. Each transition is consumed exactly once,
// as it is generated; there is no dataset and no epochs.
async function onlineLearn(opts) {
  const engine = loadEngine(path.resolve(__dirname, '..') + '/game.js', loadWords(), { staticOnly: true });
  // Inject the feature model + a sandbox-resident weight vector INTO the
  // engine's realm, and install an in-realm leave-value function as the hook.
  // The move search then evaluates leaves with the live weights without ever
  // crossing the vm membrane; only the TD update (once per transition) does.
  engine.evalInRealm(`(function(){
    const NT = 27, SIZE = ${SIZE}, MAXORD = ${opts.maxorder};
    // Pascal triangle to n=7: a plain leave is <=6 tiles, but the bag-aware
    // policy values a leave by projecting one drawn tile onto it, so a single
    // letter's count can reach 7 as the BINOM[c][s] multiplicity coefficient.
    // Ranked sub-leaves stay <=MAXORD tiles, so only this coefficient needs it.
    const BINOM = []; for (let n=0;n<=7;n++){BINOM[n]=[];for(let k=0;k<=7;k++)BINOM[n][k]=k>n?0:(k===0?1:BINOM[n-1][k-1]+BINOM[n-1][k]);}
    const __W = new Float64Array(SIZE);
    // Rank accumulated incrementally during the recursion (which visits tile
    // types in leaveRank's canonical order): s copies of type t at budget R
    // contribute sum_{v<s} SL_G[t+1][R-v], exactly leaveRank's terms without
    // a per-feature 27-type rescan. Emission order — and therefore the float
    // accumulation order of every value — is unchanged.
    function each(counts, cb){
      const present=[]; for(let i=0;i<NT;i++) if(counts[i]>0) present.push(i);
      (function rec(pi,size,mult,idx,R){
        if(pi===present.length){ if(size>=1) cb(idx, mult); return; }
        const t=present[pi], c=counts[t], maxS=Math.min(c, MAXORD-size);
        for(let s=0,add=0;s<=maxS;s++){
          rec(pi+1,size+s,mult*BINOM[c][s],idx+add,R-s);
          add += SL_G[t+1][R-s];
        }
      })(0,0,1,0,6);
    }
    const lcBuf=new Int32Array(NT), rcBuf=new Int32Array(NT);
    const fill=(buf,s)=>{ buf.fill(0); for(const ch of s) buf[ch==='?'?26:ch.charCodeAt(0)-65]++; };
    // in-realm leave value used by the move search (no membrane crossing)
    installLeaveHook((counts)=>{ let v=0; each(counts,(rank,mult)=>{v+=mult*__W[rank];}); return v; });
    const rankBuf=new Int32Array(64), multBuf=new Float64Array(64);
    let __wSum=0, __wCnt=0;                         // |w| accumulated per update event since last __wStats
    // one TD update per transition; l,r are leave strings
    globalThis.__tdUpdate=(lStr,points,rStr,b,lr,gamma)=>{
      fill(rcBuf,rStr); let Vr=0; each(rcBuf,(rank,mult)=>{Vr+=mult*__W[rank];});
      fill(lcBuf,lStr); let m=0,V=0,norm=0;
      each(lcBuf,(rank,mult)=>{rankBuf[m]=rank;multBuf[m]=mult;V+=mult*__W[rank];norm+=mult*mult;m++;});
      const err=(points-b)+gamma*Vr-V;
      const step=lr*err/(norm+1);
      for(let j=0;j<m;j++){ const w=__W[rankBuf[j]]+=step*multBuf[j]; __wSum+=w<0?-w:w; __wCnt++; }
      return err;                                   // TD error, for tracking
    };
    globalThis.__spotValue=(s)=>{ fill(lcBuf,s); let v=0; each(lcBuf,(rank,mult)=>{v+=mult*__W[rank];}); return v; };
    // weight-magnitude health: avg |w| per update event since the last call —
    // a weight updated twice contributes twice, so the average is weighted by
    // how often each feature is actually exercised; nz counts all nonzero
    // weights and max is the global divergence canary.
    globalThis.__wStats=()=>{ let nz=0,mx=0; for(let i=0;i<SIZE;i++){ const a=__W[i]<0?-__W[i]:__W[i]; if(a>0){ nz++; if(a>mx)mx=a; } } const avg=__wCnt?__wSum/__wCnt:0; __wSum=0; __wCnt=0; return { avg:avg, nz:nz, max:mx }; };
    // checkpoint: export/import the (sparse) nonzero weights as a compact string
    globalThis.__exportW=()=>{ let out=''; for(let i=0;i<SIZE;i++){ if(__W[i]!==0){ const r=Math.round(__W[i]*1e4)/1e4; if(r!==0) out += (out?',':'') + i + ':' + r; } } return out; };
    globalThis.__importW=(s)=>{ if(!s) return; for(const part of s.split(',')){ const c=part.indexOf(':'); __W[+part.slice(0,c)] = +part.slice(c+1); } };
  })();`);
  const sb = engine._sandbox;
  // exploration: add +/- dither to each candidate move's evaluation so the
  // greedy policy visits a wider variety of leaves.
  if (opts.dither) engine.evalInRealm(`installEvalDither(${opts.dither}, ${opts.seed});`);
  const lr = opts.lr, betaB = opts.betaB;
  // Slow EMAs, all checkpointed so they survive recycles instead of
  // resetting. b (betaB, ~5,000-transition window) tracks the policy's mean
  // move score, which drifts extremely slowly (~3 pts per million
  // transitions measured) — so the window is sized for noise suppression,
  // not responsiveness; a fast window just injects sampling noise into
  // every TD target via (points - b). The error EMAs (~3k window) smooth
  // the noisy TD residuals while staying responsive.
  // The logged signal is mean|TD err| / mean|points-b| — TD error relative to the zero-model
  // residual |points - b|. It starts at 1.0 (zero weights explain nothing)
  // and falls toward the irreducible-noise floor as the leave model learns;
  // it is lr- and order-independent, so runs are directly comparable.
  // b = running average move points (baseline), initialized at the measured
  // greedy self-play baseline (~35) so the slow EMA needs no warm-up ramp;
  // a checkpoint's saved b overrides on resume.
  let b = 35, nTrans = 0, nGames = 0;
  // errRatio is display-only: report the TRUE mean over each log interval
  // (sums reset at every printed line) instead of a short-memory EMA whose
  // spot reading wobbled tick to tick.
  let iAbs = 0, iRef = 0;                            // interval sums of |TD err| and |points - b|
  let nProbes = 0;                                   // probe updates (persisted so the ratio survives resumes)
  // resume from a checkpoint if one exists (survives container restarts)
  const resuming = opts.ckpt && fs.existsSync(opts.ckpt);
  if (resuming) {
    const st = JSON.parse(fs.readFileSync(opts.ckpt, 'utf8'));
    sb.__importW(st.w); b = st.b; nGames = st.games; nTrans = st.trans;
    nProbes = st.probes || 0;                        // older ckpts lack it: count restarts from 0
    console.log(`resumed from ${opts.ckpt}: games ${nGames}, trans ${nTrans}, b=${b.toFixed(1)}`);
    if (process.argv.includes('--init-blank')) console.log('--init-blank ignored: weights come from the checkpoint');
  } else if (opts.initBlank) {
    // --init-blank V: warm-start the blank's order-1 weight at V (the measured
    // equilibrium is ~24). The blank is the one tile whose value bootstraps
    // pathologically slowly from zero — it is rare, near-always playable, so
    // keep-transitions barely exist until its value grows — and a zero start
    // also lets blank-rack outcomes over-credit co-held letters for thousands
    // of games until the blank claims its share back. Fresh starts only.
    const c = new Int32Array(NT); c[26] = 1;
    sb.__importW(SL.leaveRank(c) + ':' + opts.initBlank);
  }
  // Display + checkpoint cadence: first after 10 games, then the period grows
  // ×1.5 per tick — dense feedback early on (and after a resume), cheap later.
  // Capped so long runs still tick (and checkpoint) at least every 50k games,
  // bounding what a mid-interval Ctrl-C can lose.
  const MAX_LOG_PERIOD = 50000;
  let logPeriod = 10, nextLogAt = nGames + logPeriod;
  const saveCkpt = () => {                            // atomic write (tmp + rename)
    if (!opts.ckpt) return;
    fs.writeFileSync(opts.ckpt + '.tmp', JSON.stringify({ games: nGames, trans: nTrans, probes: nProbes, b, w: sb.__exportW() }));
    fs.renameSync(opts.ckpt + '.tmp', opts.ckpt);
  };
  const prev = ['', ''];
  const spot = () => ['S', '?', 'EE', 'QU', 'ER', 'AEINRS', 'UUVWII'].map(s => `${s}=${sb.__spotValue(s).toFixed(2).padStart(6)}`).join(' ');
  const onTurn = (seat, type, points, leftover, bagN) => {
    // play and exchange both end with a valid kept leave (points=0 for an
    // exchange); only a pass keeps the full 7-tile rack (out of domain, no
    // draw), so it breaks the chain.
    if (type === 'pass') { prev[seat] = undefined; return; }
    const r = sortLeave(leftover);
    if (prev[seat] !== undefined) {                 // TD update on l = prev[seat] (leave held at turn start)
      // The bootstrap weight is min(1, bagAfterDraw/7): the kept leave's
      // future consists of drawing from what the bag holds after this turn's
      // refill (the same post-draw horizon the sim damps by via scaleH). On
      // the move whose draw empties the bag the weight is exactly 0, so
      // every chain ends grounded in realized points — a tile hoarded into
      // the fade pays its stranding cost instead of inflating through
      // never-reconciled hold transitions. No other discount: the game is
      // finite and scored by undiscounted final margin, so leave values must
      // share a currency with move points (they are summed in move selection).
      const err = sb.__tdUpdate(prev[seat], points, r, b, lr, Math.min(1, bagN / 7));
      iAbs += Math.abs(err);
      iRef += Math.abs(points - b);
      b += betaB * (points - b);
      nTrans++;
    }
    prev[seat] = r;
  };
  const t0 = Date.now();
  console.log(`lr=${lr} order=${opts.maxorder} dither=${opts.dither} init-blank=${opts.initBlank} probe-ratio=${opts.probeRatio} seed=${opts.seed} ckpt=${opts.ckpt || 'none'}`);
  // Synthetic-probe exploration (exploring starts): with --probe-ratio R,
  // fraction R of all TD updates come from probes — chained greedy rollouts
  // started from a leave that is sampled (from the live pool, supply-
  // weighted) instead of policy-chosen, so features the policy does not yet
  // believe in (rare synergies like QU) get data at a controlled rate
  // instead of waiting on a policy-feedback bootstrap. The __bestMove
  // bridge resets realm state per call, so probe searches leave the real
  // game untouched. Probe errors update weights only — b and the error
  // EMAs stay pure real-policy metrics. Chain mechanics: see PROBE_CHAIN.
  if (!(opts.probeRatio >= 0 && opts.probeRatio < 1)) { console.error('--probe-ratio must be in [0, 1)'); process.exit(2); }
  const probesPerTurn = opts.probeRatio / (1 - opts.probeRatio);
  // Each probe is a PROBE_CHAIN-step greedy rollout, not a single transition.
  // One-step probes pumped the leave-size gauge (uniform +c per tile): their
  // start leave (random, mean size ~3) and bootstrap leave (greedy-kept,
  // mean ~4.5) came from different size distributions, and that asymmetry
  // leaked into the softest direction of the model. In a chain the interior
  // telescopes — each step's bootstrap leave is the next step's grounded
  // start — so only the chain's two boundary leaves remain exposed, cutting
  // the injection by the chain length. Chains run on a private board copy
  // with moves applied (successive steps see realistic spot consumption)
  // and the pool depletes as tiles are played, so late steps get the same
  // fading damp as real late-game transitions; a pass or an exhausted pool
  // ends the chain, mirroring real chain breaks and the bag=0 truncation.
  const PROBE_CHAIN = 3;
  const chainsPerTurn = probesPerTurn / PROBE_CHAIN;  // keeps probe UPDATES at ratio R
  const probeRng = mulberry32((opts.seed ^ 0x9e3779b9) >>> 0);
  const runProbe = async (board, bag, isFirstMove, rack) => {
    const pool = [...bag, ...rack.map(t => (t.isBlank ? '?' : t.letter))];
    const draw = n => { const out = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(probeRng() * pool.length), 1)[0]); return out; };
    const bcopy = board.map(row => row.slice());
    let leave = draw(Math.floor(probeRng() * 7));               // random start leave, size 0..6
    let first = isFirstMove;
    for (let step = 0; step < PROBE_CHAIN; step++) {
      const rackTiles = leave.concat(draw(7 - leave.length)).map(ch => ({ letter: ch, isBlank: ch === '?' }));
      const bagProbe = pool.length;
      const move = await engine.bestMove(bcopy, rackTiles, first, bagProbe, 0, 0);
      if (!move) break;                                         // pass ends the chain
      const kept = rackTiles.slice();
      for (const u of (move.exchange ? move.tiles : move.placements)) {
        const idx = kept.findIndex(t => (u.isBlank ? t.isBlank : (!t.isBlank && t.letter.toLowerCase() === u.letter.toLowerCase())));
        if (idx !== -1) kept.splice(idx, 1);
      }
      let points = 0, drawn = 0;
      if (move.exchange) {
        for (const t of move.tiles) pool.push(t.isBlank ? '?' : t.letter);  // discards return to the pool
      } else {
        points = move.score;
        drawn = Math.min(bagProbe, rackTiles.length - kept.length);
        for (const p of move.placements) bcopy[p.row][p.col] = { letter: p.letter, isBlank: p.isBlank, displayLetter: p.letter };
        first = false;
      }
      sb.__tdUpdate(leave.slice().sort().join(''), points, sortLeave(kept), b, lr, Math.min(1, Math.max(0, bagProbe - drawn) / 7));
      nProbes++;
      if (bagProbe - drawn <= 0) break;                         // pool exhausted: chain fully grounded
      leave = kept.map(t => (t.isBlank ? '?' : t.letter));      // bootstrap leave becomes next grounded start
    }
  };
  // Truncate each game when the bag empties, before the first endgame-search
  // move: the solver dominates wall-clock but its transitions carry no special
  // training signal (rewards are per-move points; end-of-game rack adjustments
  // never reach onTurn), so skipping it buys games/hour at no cost in signal.
  const onPos = async (board, bag, isFirstMove, rack) => {
    if (bag.length === 0) return false;
    let p = chainsPerTurn;
    for (; p >= 1; p--) await runProbe(board, bag, isFirstMove, rack);
    if (p > 0 && probeRng() < p) await runProbe(board, bag, isFirstMove, rack);
    return true;
  };
  while (nGames < opts.games) {
    const bag = buildSeededBag(mulberry32(opts.seed * 7919 + nGames + 1));
    prev[0] = ''; prev[1] = '';
    await playGame([engine, engine], bag, false, '', onPos, onTurn);
    nGames++;
    if (nGames >= nextLogAt) {
      const st = sb.__wStats();
      console.log(`  games ${String(nGames).padStart(6)} | trans ${String(nTrans).padStart(7)}${opts.probeRatio > 0 ? ` | probes ${String(nProbes).padStart(7)}` : ''} | ${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s | b=${b.toFixed(1)} | errRatio=${iRef > 0 ? (iAbs / iRef).toFixed(3) : '  ---'} | avg|w|=${st.avg.toFixed(3)} nz=${String(st.nz).padStart(6)} max=${st.max.toFixed(1).padStart(4)} | ${spot()}`);
      iAbs = 0; iRef = 0;
      saveCkpt();
      logPeriod = Math.min(logPeriod * 1.5, MAX_LOG_PERIOD);
      nextLogAt = nGames + logPeriod;
    }
  }
  saveCkpt();
  console.log(`done: ${nGames} games, ${nTrans} transitions${nProbes ? `, ${nProbes} probes` : ''}`);
}

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
    liveTarget: process.argv.includes('--live-target'),
    avgtail: parseFloat(arg('--avgtail', '0')),
    dumpw: (process.argv.indexOf('--dumpw') !== -1) ? path.resolve(process.cwd(), arg('--dumpw', 'weights.txt')) : null,
    out: path.resolve(process.cwd(), arg('--out', 'leaves.bin.gz')),
  });
  if (cmd === 'export') {
    const ckpt = arg('--ckpt', 'online.ckpt.json');
    return exportTable({
      ckpt: path.resolve(process.cwd(), ckpt),
      out: path.resolve(process.cwd(), arg('--out', path.basename(ckpt).replace(/\.ckpt\.json$/, '') + '.bin.gz')),
      weightsOut: process.argv.includes('--weights-out') ? path.resolve(process.cwd(), arg('--weights-out', 'leaves-w.txt.gz')) : null,
    });
  }
  if (cmd === 'online-learn') return onlineLearn({
    games: process.argv.includes('--games') ? parseInt(arg('--games'), 10) : Infinity, // unlimited unless capped

    lr: parseFloat(arg('--lr', '0.001')),
    maxorder: parseInt(arg('--maxorder', '5'), 10),
    betaB: parseFloat(arg('--betaB', '0.0002')),
    dither: parseFloat(arg('--dither', '0')),
    initBlank: parseFloat(arg('--init-blank', '20')),
    probeRatio: parseFloat(arg('--probe-ratio', '0')),
    // default to a non-deterministic seed (time + pid, so concurrent launches
    // differ); pass --seed explicitly to reproduce or to compare across LRs.
    seed: parseInt(arg('--seed', String(((Date.now() ^ (process.pid * 2654435761)) >>> 0) % 2000000000)), 10),
    ckpt: (process.argv.indexOf('--ckpt') !== -1) ? path.resolve(process.cwd(), arg('--ckpt', 'online.ckpt.json')) : null,
  });
  console.error('usage: selftest | record | train | online-learn | export'); process.exit(2);
}

if (require.main === module) main();

module.exports = { BINOM, eachSubFeature, valueFromFeatures, buildTable, seedFromLinear, NT, SIZE };
