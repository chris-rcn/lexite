#!/usr/bin/env node
// Engine match harness: plays mirrored pairs of games between two versions
// of game.js and reports wins, score, and speed statistics.
//
// Usage:
//   node tools/match.js [--a <fileA>] [--b <fileB>] [--pairs N] [--seed S]
//                       [--jobs J] [--verbose]
//
// Defaults: --a game.js --b game.js --pairs 3 --seed 1 --jobs (cpus, max 4)
//
// Fairness ("color swap"): each pair uses one seeded bag shuffle and plays
// it twice with the seats swapped, so both engines see the exact same
// starting tiles and draw order from each seat. The engines themselves are
// deterministic — the seeded bag is the only randomness — so an A-vs-A
// match always produces mirrored results.
//
// To compare against an older engine, check out that revision's game.js to
// a separate file, e.g.:
//   git show <rev>:game.js > /tmp/game-old.js
//   node tools/match.js --a game.js --b /tmp/game-old.js --pairs 10
//
// Games run in parallel worker processes (--jobs). Both engines of a game
// run interleaved in the same process, so CPU contention from parallelism
// slows them equally and the ms/move comparison stays fair. --verbose
// forces sequential in-process play and logs every move.
//
// The harness owns the authoritative game state (board, racks, bag,
// scores) and only asks each engine for its best move, so the two loaded
// versions never interact. It works with both the current engine API
// (findBestMove(rack)) and the pre-refactor one (findBestComputerMove()).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFile } = require('child_process');

// Same tile distribution as game.js (kept local so old versions of the
// game file can be loaded without assuming anything about their globals).
const TILE_DATA = {
  A:[9,1],  B:[2,3],  C:[2,3],  D:[4,2],  E:[12,1],
  F:[2,4],  G:[3,2],  H:[2,4],  I:[9,1],  J:[1,8],
  K:[1,5],  L:[4,1],  M:[2,3],  N:[6,1],  O:[8,1],
  P:[2,3],  Q:[1,10], R:[6,1],  S:[4,1],  T:[6,1],
  U:[4,1],  V:[2,4],  W:[2,4],  X:[1,8],  Y:[2,4],
  Z:[1,10], '?':[2,0]
};
const LETTER_VALUES = {};
for (const [ch, [, v]] of Object.entries(TILE_DATA)) LETTER_VALUES[ch] = v;

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    a: 'game.js', b: 'game.js', pairs: 3, seed: 1,
    jobs: Math.max(1, Math.min(4, os.cpus().length - 1)),
    verbose: false, playOne: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--a') opts.a = argv[++i];
    else if (arg === '--b') opts.b = argv[++i];
    else if (arg === '--pairs') opts.pairs = parseInt(argv[++i], 10);
    else if (arg === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (arg === '--jobs') opts.jobs = parseInt(argv[++i], 10);
    else if (arg === '--static') opts.static = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--play-one') opts.playOne = argv[++i]; // internal: worker mode
    else { console.error(`Unknown argument: ${arg}`); process.exit(2); }
  }
  if (!opts.playOne &&
      (!Number.isInteger(opts.pairs) || opts.pairs < 1 ||
       !Number.isInteger(opts.seed) ||
       !Number.isInteger(opts.jobs) || opts.jobs < 1)) {
    console.error('--pairs and --jobs must be positive integers, --seed an integer.');
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------
// Seeded RNG + bag
// ---------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeededBag(rng) {
  const bag = [];
  for (const [letter, [count]] of Object.entries(TILE_DATA)) {
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// ---------------------------------------------------------------
// Engine loading
// ---------------------------------------------------------------

function loadWords() {
  // words.txt.gz is the single source of truth for the list; decompress it
  // in-process (the browser does the same via DecompressionStream).
  const gz = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'words.txt.gz'));
  const text = zlib.gunzipSync(gz).toString('utf8');
  return text.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => w.length >= 2);
}

// opts.staticOnly disables the engine's mid-game simulation (used by the
// trainer, whose target is the static best next-move score).
function loadEngine(file, words, opts = {}) {
  const code = fs.readFileSync(file, 'utf8');
  // A leaves.js next to the engine file supplies its leave-model weights
  // (an engine version and its trained weights travel as a pair).
  const leavesPath = path.join(path.dirname(path.resolve(file)), 'leaves.js');
  const leavesCode = fs.existsSync(leavesPath) ? fs.readFileSync(leavesPath, 'utf8') : null;
  // An optional superleave table (leaves.bin.gz) next to the engine file
  // overrides the linear leave model, matching what the browser fetches.
  const superPath = path.join(path.dirname(path.resolve(file)), 'leaves.bin.gz');
  const superBytes = fs.existsSync(superPath) ? zlib.gunzipSync(fs.readFileSync(superPath)) : null;
  // Minimal browser-global stubs so game.js evaluates headlessly. All DOM
  // access lives inside functions the harness never calls.
  const sandbox = {
    window: { addEventListener() {} },
    navigator: { maxTouchPoints: 0 },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  if (leavesCode) vm.runInContext(leavesCode, sandbox, { filename: leavesPath });
  vm.runInContext(code, sandbox, { filename: file });

  // Install the dictionary directly (loadWordList needs fetch), and define
  // a bridge into the script's lexical scope: `const state` is not a
  // property of the sandbox global, so it is only reachable from code
  // evaluated inside the context. The position is passed as JSON and
  // materialized inside the sandbox realm: the search reads state.board
  // millions of times per move, and reads of a host-realm object would
  // cross the vm membrane and slow the search down badly.
  sandbox.__WORDS = words;
  // Pass the table as a latin1 string (one membrane value); the context
  // rebuilds an in-realm Uint8Array so per-lookup reads stay fast.
  sandbox.__SUPERLEAVE_STR = superBytes ? superBytes.toString('latin1') : '';
  vm.runInContext(`
    state.wordSet = new Set(__WORDS);
    state.wordsByLength = Array.from({length: 16}, () => []);
    for (const w of state.wordSet) {
      if (w.length <= 15) state.wordsByLength[w.length].push(w);
    }
    if (__SUPERLEAVE_STR && typeof installSuperTable === 'function') {
      const s = __SUPERLEAVE_STR, t = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) t[i] = s.charCodeAt(i);
      installSuperTable(t);
    }
    // staticOnly: play the simulation stages statically; the empty-bag
    // endgame solver still runs (matching the pre-refactor staticOnly).
    if (${opts.staticOnly ? 'true' : 'false'} && typeof STAGES !== 'undefined') {
      STAGES.bag1.static = true; STAGES.bag2.static = true; STAGES.bag3.static = true; STAGES.bag4.static = true; STAGES.bag5.static = true; STAGES.bag6.static = true; STAGES.bag7.static = true; STAGES.bagGt7.static = true;
    }
    ${opts.bagAware === undefined ? ''
      : `if (typeof installBagAwareLeave === 'function') installBagAwareLeave(${opts.bagAware ? 'true' : 'false'});`}
    globalThis.__bestMove = (positionJson) => {
      const pos = JSON.parse(positionJson);
      state.board = pos.board;
      state.isFirstMove = pos.isFirstMove;
      // Only the bag's length is read (leave-value damping)
      state.bag = new Array(pos.bagCount || 0).fill('?');
      // Current standing for score-aware sim ("me" is always the computer).
      state.computerScore = pos.myScore || 0;
      state.playerScore = pos.oppScore || 0;
      if (typeof findBestMove === 'function') return findBestMove(pos.rack);
      // Pre-refactor engine API
      state.computerRack = pos.rack;
      return findBestComputerMove();
    };
  `, sandbox);

  return {
    file,
    stats: { moves: 0, ms: 0 },
    // Install a live leave-value function into the engine's realm so the
    // move search uses it (online learning). fn(counts) -> value.
    installLeaveHook(fn) {
      sandbox.__leaveHook = fn;
      vm.runInContext('if (typeof installLeaveHook === "function") installLeaveHook(__leaveHook);', sandbox);
    },
    // Run code inside the engine's realm (for injecting an in-realm value
    // function + weights, so online-learning leaf-evals never cross the
    // vm membrane). Returns whatever the code evaluates to.
    evalInRealm(code) { return vm.runInContext(code, sandbox); },
    _sandbox: sandbox,
    async bestMove(board, rack, isFirstMove, bagCount, myScore, oppScore) {
      const positionJson = JSON.stringify({
        board,
        rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })),
        isFirstMove,
        bagCount,
        myScore: myScore || 0,
        oppScore: oppScore || 0,
      });
      const t0 = Date.now();
      const move = await sandbox.__bestMove(positionJson);
      this.stats.ms += Date.now() - t0;
      this.stats.moves++;
      return move;
    },
  };
}

// ---------------------------------------------------------------
// Game loop (authoritative state lives here, not in the engines)
// ---------------------------------------------------------------

function rackValue(rack) {
  return rack.reduce((s, t) => s + (t.isBlank ? 0 : (LETTER_VALUES[t.letter.toUpperCase()] || 0)), 0);
}

// engines: [engine for seat 0 (moves first), engine for seat 1]
// onPosition, if given, is called with (board, bag, isFirstMove) before
// every engine move — used by tools/train-leaves.js to harvest positions.
// Returns { scores: [seat0, seat1], moves, reason }
async function playGame(engines, initialBag, verbose, label, onPosition, onTurn) {
  const bag = initialBag.slice();
  const board = Array.from({ length: 15 }, () => new Array(15).fill(null));
  const racks = [[], []];
  const scores = [0, 0];
  const draw = seat => {
    while (racks[seat].length < 7 && bag.length > 0) {
      const raw = bag.pop();
      racks[seat].push({ letter: raw, isBlank: raw === '?' });
    }
  };
  draw(0); draw(1);

  let isFirstMove = true;
  let scoreless = 0; // consecutive scoreless turns (passes and exchanges)
  let seat = 0;
  let moves = 0;
  let reason;
  // Score margin (seat0 - seat1) at the moment each late phase begins, so a
  // caller can condition on how close the game was entering that phase.
  let marginLowbag = null, marginBag1 = null, marginEndgame = null;
  // marginAtBag[k] = score margin (seat0 - seat1) the first time the bag holds
  // exactly k tiles (k <= 8), so a caller can isolate/filter on any late bag size.
  const marginAtBag = {};

  for (;;) {
    if (bag.length <= 8 && marginAtBag[bag.length] === undefined) marginAtBag[bag.length] = scores[0] - scores[1];
    if (marginLowbag === null && bag.length < 8) marginLowbag = scores[0] - scores[1];
    if (marginBag1 === null && bag.length === 1) marginBag1 = scores[0] - scores[1];
    if (marginEndgame === null && bag.length === 0) marginEndgame = scores[0] - scores[1];
    if (onPosition) onPosition(board, bag, isFirstMove, racks[seat]);
    const move = await engines[seat].bestMove(board, racks[seat], isFirstMove, bag.length, scores[seat], scores[1 - seat]);
    moves++;
    if (!move) {
      if (onTurn) onTurn(seat, 'pass', 0, null);
      if (verbose) console.log(`  [${label}] seat${seat}: pass`);
      if (++scoreless >= 6) { reason = 'passes'; break; }
    } else if (move.exchange) {
      if (bag.length < 7) throw new Error('engine exchanged with fewer than 7 bag tiles');
      const removed = [];
      for (const t of move.tiles) {
        const idx = racks[seat].findIndex(x =>
          t.isBlank ? x.isBlank : (!x.isBlank && x.letter.toLowerCase() === t.letter.toLowerCase()));
        if (idx === -1) throw new Error(`engine exchanged a tile not in its rack: ${JSON.stringify(t)}`);
        removed.push(...racks[seat].splice(idx, 1));
      }
      // The kept tiles (rack minus discards, pre-draw) are a valid leave, so
      // an exchange is a real 0-reward transition, just like a play.
      if (onTurn) onTurn(seat, 'exchange', 0, racks[seat].slice());
      draw(seat); // replacements come out before the discards return
      // Discards go to the bottom of the bag (drawn last): deterministic
      // without an RNG, and they cannot be immediately redrawn — the
      // practical effect of a shuffle at these bag depths.
      for (const t of removed) bag.unshift(t.isBlank ? '?' : t.letter);
      if (verbose) console.log(`  [${label}] seat${seat}: exchanged ${removed.length}`);
      if (++scoreless >= 6) { reason = 'passes'; break; }
    } else {
      scoreless = 0;
      for (const p of move.placements) {
        board[p.row][p.col] = { letter: p.letter, isBlank: p.isBlank, displayLetter: p.letter };
        const idx = racks[seat].findIndex(t =>
          p.isBlank ? t.isBlank : (!t.isBlank && t.letter.toLowerCase() === p.letter.toLowerCase())
        );
        if (idx === -1) throw new Error(`engine played a tile not in its rack: ${JSON.stringify(p)}`);
        racks[seat].splice(idx, 1);
      }
      scores[seat] += move.score;
      isFirstMove = false;
      if (onTurn) onTurn(seat, 'play', move.score, racks[seat].slice()); // leftover leave, pre-draw
      if (verbose) console.log(`  [${label}] seat${seat}: ${move.word.toUpperCase()} +${move.score} (total ${scores[seat]})`);
      draw(seat);
      if (bag.length === 0 && racks[seat].length === 0) { reason = 'out'; break; }
    }
    if (moves > 200) { reason = 'move-limit'; break; } // safety net
    seat = 1 - seat;
  }

  // Endgame adjustments, mirroring endGame() in game.js.
  if (racks[0].length === 0) {
    scores[0] += rackValue(racks[1]);
    scores[1] -= rackValue(racks[1]);
  } else if (racks[1].length === 0) {
    scores[1] += rackValue(racks[0]);
    scores[0] -= rackValue(racks[0]);
  } else {
    scores[0] -= rackValue(racks[0]);
    scores[1] -= rackValue(racks[1]);
  }

  return { scores, moves, reason, marginLowbag, marginBag1, marginEndgame, marginAtBag };
}

// Play one game (spec = {a, b, swap, bag}) in this process and return a
// result record in engine-A/B terms rather than seat terms.
async function playSpec(spec, verbose, label) {
  const words = loadWords();
  // Per-engine staticOnly (falls back to the shared spec.staticOnly), plus an
  // optional realm-eval override applied after load (e.g. force one stage
  // static). Lets a match pit two different stage configs of the same engine.
  const A = loadEngine(spec.a, words, { staticOnly: spec.aStatic ?? spec.staticOnly });
  const B = loadEngine(spec.b, words, { staticOnly: spec.bStatic ?? spec.staticOnly });
  if (spec.aEval) A.evalInRealm(spec.aEval);
  if (spec.bEval) B.evalInRealm(spec.bEval);
  const seatEngines = spec.swap ? [B, A] : [A, B];
  const g = await playGame(seatEngines, spec.bag, verbose, label);
  // Score margin at low-bag entry, converted to A-minus-B terms (for close-game
  // filtering regardless of which seat A took this game).
  const mLow = g.marginLowbag == null ? null : (spec.swap ? -g.marginLowbag : g.marginLowbag);
  return {
    aScore: spec.swap ? g.scores[1] : g.scores[0],
    bScore: spec.swap ? g.scores[0] : g.scores[1],
    reason: g.reason,
    moves: g.moves,
    aStats: A.stats,
    bStats: B.stats,
    marginLowbag: mLow,
  };
}

// ---------------------------------------------------------------
// Parallel execution: one worker process per game
// ---------------------------------------------------------------

function runWorker(spec) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [__filename, '--play-one', JSON.stringify(spec)],
      { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`bad worker output: ${stdout}`)); }
      });
  });
}

async function runPool(specs, jobs) {
  const results = new Array(specs.length);
  let next = 0;
  async function drain() {
    while (next < specs.length) {
      const i = next++;
      results[i] = await runWorker(specs[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, specs.length) }, drain));
  return results;
}

// ---------------------------------------------------------------
// Match
// ---------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.playOne) {
    const result = await playSpec(JSON.parse(opts.playOne), false, '');
    process.stdout.write(JSON.stringify(result));
    return;
  }

  const resolveEngine = f => path.resolve(process.cwd(), f);
  const aFile = resolveEngine(opts.a);
  const bFile = resolveEngine(opts.b);
  for (const f of [aFile, bFile]) fs.accessSync(f); // fail fast on typos

  console.log(`Engine A: ${aFile}`);
  console.log(`Engine B: ${bFile}`);
  console.log(`Pairs: ${opts.pairs} (${opts.pairs * 2} games), base seed: ${opts.seed}, jobs: ${opts.verbose ? 1 : opts.jobs}\n`);

  // Two games per pair: same seeded bag, seats swapped.
  const specs = [];
  for (let p = 0; p < opts.pairs; p++) {
    const seed = opts.seed + p;
    const bag = buildSeededBag(mulberry32(seed));
    specs.push({ a: aFile, b: bFile, swap: false, bag, seed, staticOnly: opts.static });
    specs.push({ a: aFile, b: bFile, swap: true, bag, seed, staticOnly: opts.static });
  }

  const t0 = Date.now();
  let results;
  if (opts.verbose) {
    results = [];
    for (const spec of specs) {
      const label = `seed ${spec.seed} ${spec.swap ? 'B-first' : 'A-first'}`;
      results.push(await playSpec(spec, true, label));
    }
  } else {
    results = await runPool(specs, opts.jobs);
  }

  const totals = {
    A: { wins: 0, points: 0, ms: 0, moves: 0 },
    B: { wins: 0, points: 0, ms: 0, moves: 0 },
    ties: 0, gameMoves: 0,
  };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    totals.A.points += r.aScore; totals.B.points += r.bScore;
    totals.A.ms += r.aStats.ms; totals.A.moves += r.aStats.moves;
    totals.B.ms += r.bStats.ms; totals.B.moves += r.bStats.moves;
    totals.gameMoves += r.moves;
    if (r.aScore > r.bScore) totals.A.wins++;
    else if (r.bScore > r.aScore) totals.B.wins++;
    else totals.ties++;
    if (i % 2 === 1) {
      const g1 = results[i - 1], g2 = r;
      const line = g =>
        `A ${g.aScore} — B ${g.bScore} (${g.aScore > g.bScore ? 'A wins' : g.bScore > g.aScore ? 'B wins' : 'tie'}, ${g.reason})`;
      console.log(`Pair ${(i + 1) / 2} (seed ${specs[i].seed})  A first: ${line(g1)}  |  B first: ${line(g2)}`);
    }
  }

  const games = specs.length;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const perMove = t => t.moves ? (t.ms / t.moves).toFixed(0) : '—';
  console.log(`\nResult over ${games} games (${secs}s wall):`);
  console.log(`  A: ${totals.A.wins} wins, avg ${(totals.A.points / games).toFixed(1)} pts, ${perMove(totals.A)} ms/move (${totals.A.moves} moves)`);
  console.log(`  B: ${totals.B.wins} wins, avg ${(totals.B.points / games).toFixed(1)} pts, ${perMove(totals.B)} ms/move (${totals.B.moves} moves)`);
  console.log(`  Ties: ${totals.ties}`);
  console.log(`  Avg margin (A − B): ${((totals.A.points - totals.B.points) / games).toFixed(1)} pts`);
  console.log(`  Avg moves per game: ${(totals.gameMoves / games).toFixed(1)}`);
}

module.exports = { TILE_DATA, LETTER_VALUES, mulberry32, buildSeededBag, loadWords, loadEngine, playGame };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
