#!/usr/bin/env node
// Engine match harness: plays mirrored pairs of games between two versions
// of game.js and reports wins, score, and speed statistics.
//
// Usage:
//   node tools/match.js [--a <fileA>] [--b <fileB>] [--pairs N] [--seed S]
//                       [--jobs J] [--verbose]
//
// Defaults: --a game.js --b game.js --pairs 0 (unlimited) --seed 1 --jobs (cpus, max 4)
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
    a: 'game.js', b: 'game.js', pairs: 0, seed: 1,
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
    // Per-engine static play (playSpec already honours aStatic/bStatic):
    // lets one side play statically while the other simulates.
    else if (arg === '--a-static') opts.aStatic = true;
    else if (arg === '--b-static') opts.bStatic = true;
    // Realm code evaluated in one engine's context after load (e.g.
    // 'STAGES.bag1.scoreAware = 1') — lets a match A/B two stage configs
    // of the same engine build.
    else if (arg === '--a-eval') opts.aEval = argv[++i];
    else if (arg === '--b-eval') opts.bEval = argv[++i];
    // Also tally the subset of games with |margin| <= T when the bag first
    // held <= K tiles (default K=2). Late-stage A/Bs only diverge in close
    // late games, so the unfiltered tally dilutes their signal ~20:1.
    else if (arg === '--close') opts.close = parseInt(argv[++i], 10);
    else if (arg === '--close-bag') opts.closeBag = parseInt(argv[++i], 10);
    else if (arg === '--must-see-bag') opts.mustSeeBag = parseInt(argv[++i], 10);
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--play-one') opts.playOne = argv[++i]; // internal: worker mode
    else { console.error(`Unknown argument: ${arg}`); process.exit(2); }
  }
  if (!opts.playOne &&
      (!Number.isInteger(opts.pairs) || opts.pairs < 0 ||
       !Number.isInteger(opts.seed) ||
       !Number.isInteger(opts.jobs) || opts.jobs < 1)) {
    console.error('--pairs must be a non-negative integer (0 = unlimited), --jobs a positive integer, --seed an integer.');
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
  // Sparse feature weights (leaves-w.txt.gz) take precedence: the engine
  // assembles the table in-realm, byte-identical to a prebuilt one.
  const superWPath = path.join(path.dirname(path.resolve(file)), 'leaves-w.txt.gz');
  const superWStr = fs.existsSync(superWPath) ? zlib.gunzipSync(fs.readFileSync(superWPath)).toString() : null;
  // Endgame leave model travels with the engine dir too (falls back to
  // the repo root, then to face-value deadwood inside the engine).
  const egPath = path.join(path.dirname(path.resolve(file)), 'endgame-leaves.json.gz');
  const egRoot = path.join(path.resolve(__dirname, '..'), 'endgame-leaves.json.gz');
  const egStr = fs.existsSync(egPath) ? zlib.gunzipSync(fs.readFileSync(egPath)).toString()
    : fs.existsSync(egRoot) ? zlib.gunzipSync(fs.readFileSync(egRoot)).toString() : null;
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
  sandbox.__SUPERLEAVE_WSTR = superWStr || '';
  sandbox.__EG_LEAVES_STR = egStr || '';
  vm.runInContext(`
    state.wordSet = new Set(__WORDS);
    state.wordsByLength = Array.from({length: 16}, () => []);
    for (const w of state.wordSet) {
      if (w.length <= 15) state.wordsByLength[w.length].push(w);
    }
    if (__EG_LEAVES_STR && typeof installEndgameLeaves === 'function') {
      installEndgameLeaves(JSON.parse(__EG_LEAVES_STR));
    }
    if (__SUPERLEAVE_WSTR && typeof buildSuperTableFromWeights === 'function') {
      installSuperTable(buildSuperTableFromWeights(__SUPERLEAVE_WSTR));
    } else if (__SUPERLEAVE_STR && typeof installSuperTable === 'function') {
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
  // Half-point komi to seat 1 (the second player): a tied raw score
  // resolves to the second player as pure margin arithmetic, everywhere.
  const scores = [0, 0.5];
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
  // exactly k tiles (all sizes), and moverAtBag[k] = the seat about to move at
  // that moment — so a caller can filter on any late bag size (close-game
  // tallies) or calibrate margin drift/variance by game phase (margin-sigma).
  const marginAtBag = {};
  const moverAtBag = {};
  // rackAtBag[k] = both racks (seat-indexed letter strings, '?' = blank) at
  // the same moment — lets a calibrator condition the final-margin residual
  // on the rack information an engine's horizon evaluation actually has.
  const rackAtBag = {};
  const rackStr = r => r.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).join('');

  for (;;) {
    if (marginAtBag[bag.length] === undefined) {
      marginAtBag[bag.length] = scores[0] - scores[1];
      moverAtBag[bag.length] = seat;
      rackAtBag[bag.length] = [rackStr(racks[0]), rackStr(racks[1])];
    }
    if (marginLowbag === null && bag.length < 8) marginLowbag = scores[0] - scores[1];
    if (marginBag1 === null && bag.length === 1) marginBag1 = scores[0] - scores[1];
    if (marginEndgame === null && bag.length === 0) marginEndgame = scores[0] - scores[1];
    // onPosition may be async and may return false to abort the game before
    // this move is chosen (e.g. online-learn truncates at bag=0 to skip the
    // endgame solver, and runs synthetic probe evaluations per turn).
    if (onPosition && (await onPosition(board, bag, isFirstMove, racks[seat])) === false) { reason = 'truncated'; break; }
    const move = await engines[seat].bestMove(board, racks[seat], isFirstMove, bag.length, scores[seat], scores[1 - seat]);
    moves++;
    if (!move) {
      if (onTurn) onTurn(seat, 'pass', 0, null, bag.length);
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
      const kept = racks[seat].slice();
      draw(seat); // replacements come out before the discards return
      // Discards go to the bottom of the bag (drawn last): deterministic
      // without an RNG, and they cannot be immediately redrawn — the
      // practical effect of a shuffle at these bag depths.
      for (const t of removed) bag.unshift(t.isBlank ? '?' : t.letter);
      if (onTurn) onTurn(seat, 'exchange', 0, kept, bag.length); // bag after draw + returns
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
      // The leave is the rack pre-draw, but the bag count reported with it is
      // post-draw: it is what remains to draw into that leave going forward,
      // which is the horizon a TD consumer should damp its bootstrap by
      // (0 on the move whose draw empties the bag — a grounded chain end).
      const leftover = racks[seat].slice();
      draw(seat);
      if (onTurn) onTurn(seat, 'play', move.score, leftover, bag.length);
      if (verbose) console.log(`  [${label}] seat${seat}: ${move.word.toUpperCase()} +${move.score} (total ${scores[seat]})`);
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

  return { scores, moves, reason, marginLowbag, marginBag1, marginEndgame, marginAtBag, moverAtBag, rackAtBag };
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
  if (spec.aEval) A.evalInRealm(stagesEval(spec.aEval));
  if (spec.bEval) B.evalInRealm(stagesEval(spec.bEval));
  const seatEngines = spec.swap ? [B, A] : [A, B];
  // --must-see-bag N: truncate (and later exclude) games where no mover
  // ever faces exactly N bag tiles — a multi-tile play can jump the bag
  // past N, and such games carry no contested decision worth paying the
  // endgame for. The prefix is identical across the pair, so both games
  // of a pair truncate identically (no selection bias).
  let sawBag = false;
  const onPos = spec.mustSeeBag ? (board, bag) => {
    if (bag.length === spec.mustSeeBag) sawBag = true;
    return !(bag.length < spec.mustSeeBag && !sawBag);
  } : null;
  const g = await playGame(seatEngines, spec.bag, verbose, label, onPos);
  // Score margin at low-bag entry, converted to A-minus-B terms (for close-game
  // filtering regardless of which seat A took this game).
  const mLow = g.marginLowbag == null ? null : (spec.swap ? -g.marginLowbag : g.marginLowbag);
  return {
    swap: spec.swap, // seat order: A moved second (and carried the komi) when swapped
    aScore: spec.swap ? g.scores[1] : g.scores[0],
    bScore: spec.swap ? g.scores[0] : g.scores[1],
    reason: g.reason,
    moves: g.moves,
    aStats: A.stats,
    bStats: B.stats,
    marginLowbag: mLow,
    // Standing at each late bag size, in A-minus-B terms (pre-treatment
    // covariates for close-game filtering: play before the late stages is
    // identical across stage-config A/Bs, so filtering on these is unbiased).
    marginAtBag: Object.fromEntries(Object.entries(g.marginAtBag).map(([k, v]) => [k, spec.swap ? -v : v])),
    // moverAtBag[k] = 1 if engine A was about to move when the bag first
    // held k tiles (mover-perspective calibration needs to know whose turn).
    moverAtBag: Object.fromEntries(Object.entries(g.moverAtBag).map(([k, s]) => [k, (spec.swap ? 1 - s : s) === 0 ? 1 : 0])),
    rackAtBag: g.rackAtBag, // seat-indexed (not swap-normalized); pair with moverAtBag
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

// specs: an array, or a lazy { length, at(i) } source (length may be
// Infinity — results are not retained then; tallies live in onResult).
async function runPool(specs, jobs, onResult) {
  const get = Array.isArray(specs) ? i => specs[i] : i => specs.at(i);
  const results = Number.isFinite(specs.length) ? new Array(specs.length) : null;
  let next = 0;
  async function drain() {
    while (next < specs.length) {
      const i = next++;
      const r = await runWorker(get(i));
      if (results) results[i] = r;
      if (onResult) onResult(r);
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
  console.log(`Pairs: ${opts.pairs === 0 ? 'unlimited' : `${opts.pairs} (${opts.pairs * 2} games)`}, base seed: ${opts.seed}, jobs: ${opts.verbose ? 1 : opts.jobs}\n`);

  // Two games per pair: same seeded bag, seats swapped. Specs materialize
  // lazily so an unlimited run (--pairs 0, the default) holds no upfront
  // array; games arrive until interrupted.
  const nPairs = opts.pairs === 0 ? Infinity : opts.pairs;
  const specs = {
    length: nPairs * 2,
    at(i) {
      const seed = opts.seed + (i >> 1);
      return { a: aFile, b: bFile, swap: (i & 1) === 1, bag: buildSeededBag(mulberry32(seed)), seed, staticOnly: opts.static, aStatic: opts.aStatic, bStatic: opts.bStatic, aEval: opts.aEval, bEval: opts.bEval, mustSeeBag: opts.mustSeeBag };
    },
  };

  const t0 = Date.now();
  // Live cumulative summary table on an exponential schedule (first after
  // 20 games, period ×1.5): long matches show trend and pace mid-run
  // without a line per game. Games finish out of order under --jobs, so
  // the summary counts completions, not pair indices.
  console.log(`${'games'.padStart(8)} ${'A'.padStart(6)} ${'B'.padStart(6)} ${'A%'.padStart(6)} ${'A margin'.padStart(9)} ${'A ms/mv'.padStart(8)} ${'B ms/mv'.padStart(8)}` +
    (opts.close !== undefined ? ` ${'clA'.padStart(6)} ${'clB'.padStart(6)} ${'clN'.padStart(6)}` : '') +
    ` ${'elapsed'.padStart(9)}`);
  let done = 0, liveA = 0, liveB = 0, liveTies = 0, liveMargin = 0;
  let liveAms = 0, liveAmv = 0, liveBms = 0, liveBmv = 0;
  let tickPeriod = 20, tickAt = 20;
  // Close-game sub-tally: games whose standing was within --close points
  // when the bag first held <= closeBag tiles. Bag sizes can be skipped as
  // draws shrink the bag, so "first at <= K" is the largest recorded size
  // <= K. Games that end before the bag gets that low are excluded.
  const closeBag = opts.closeBag ?? 2;
  const closeMargin = mab => {
    if (!mab) return undefined;
    for (let k = closeBag; k >= 0; k--) if (mab[k] !== undefined) return mab[k];
    return undefined;
  };
  let closeN = 0, closeA = 0, closeB = 0, closeSum = 0;
  let skippedTrunc = 0;
  const onResult = r => {
    if (r.reason === 'truncated') { skippedTrunc++; return; }
    done++; liveMargin += r.aScore - r.bScore;
    liveAms += r.aStats.ms; liveAmv += r.aStats.moves;
    liveBms += r.bStats.ms; liveBmv += r.bStats.moves;
    // The komi makes score equality impossible; a half-point gap marks a
    // raw tie that the komi resolved to the second player.
    if (r.aScore > r.bScore) liveA++; else liveB++;
    if (Math.abs(r.aScore - r.bScore) === 0.5) liveTies++;
    if (opts.close !== undefined) {
      const m = closeMargin(r.marginAtBag);
      if (m !== undefined && Math.abs(m) <= opts.close) {
        closeN++; closeSum += r.aScore - r.bScore;
        if (r.aScore > r.bScore) closeA++; else closeB++;
      }
    }
    if (done >= tickAt) {
      const am = liveMargin / done;
      const ratio = liveA + liveB ? (100 * liveA / (liveA + liveB)).toFixed(1) : '—';
      let row = `${String(done).padStart(8)} ${String(liveA).padStart(6)} ${String(liveB).padStart(6)}` +
        ` ${ratio.padStart(6)} ${((am >= 0 ? '+' : '') + am.toFixed(1)).padStart(9)}` +
        ` ${(liveAmv ? (liveAms / liveAmv).toFixed(0) : '—').padStart(8)} ${(liveBmv ? (liveBms / liveBmv).toFixed(0) : '—').padStart(8)}`;
      if (opts.close !== undefined) row += ` ${String(closeA).padStart(6)} ${String(closeB).padStart(6)} ${String(closeN).padStart(6)}`;
      row += ` ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`;
      console.log(row);
      tickPeriod *= 1.5; tickAt = done + tickPeriod;
    }
  };
  let results;
  if (opts.verbose) {
    results = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs.at(i);
      const label = `seed ${spec.seed} ${spec.swap ? 'B-first' : 'A-first'}`;
      const r = await playSpec(spec, true, label);
      results.push(r);
      onResult(r);
    }
  } else {
    results = await runPool(specs, opts.jobs, onResult);
  }

  const totals = {
    A: { wins: 0, points: 0, ms: 0, moves: 0 },
    B: { wins: 0, points: 0, ms: 0, moves: 0 },
    ties: 0, gameMoves: 0,
  };
  let counted = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.reason === 'truncated') continue;
    counted++;
    totals.A.points += r.aScore; totals.B.points += r.bScore;
    totals.A.ms += r.aStats.ms; totals.A.moves += r.aStats.moves;
    totals.B.ms += r.bStats.ms; totals.B.moves += r.bStats.moves;
    totals.gameMoves += r.moves;
    if (r.aScore > r.bScore) totals.A.wins++; else totals.B.wins++;
    if (Math.abs(r.aScore - r.bScore) === 0.5) totals.ties++; // raw tie, komi-decided
  }

  const games = opts.mustSeeBag !== undefined ? counted : specs.length;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const perMove = t => t.moves ? (t.ms / t.moves).toFixed(0) : '—';
  console.log(`\nResult over ${games} games (${secs}s wall):`);
  console.log(`  A: ${totals.A.wins} wins, avg ${(totals.A.points / games).toFixed(1)} pts, ${perMove(totals.A)} ms/move (${totals.A.moves} moves)`);
  console.log(`  B: ${totals.B.wins} wins, avg ${(totals.B.points / games).toFixed(1)} pts, ${perMove(totals.B)} ms/move (${totals.B.moves} moves)`);
  console.log(`  Raw ties (komi-decided for the second player): ${totals.ties}`);
  console.log(`  A win ratio: ${games ? (100 * totals.A.wins / games).toFixed(1) : '—'}%`);
  console.log(`  A margin (avg A − B per game): ${((totals.A.points - totals.B.points) / games).toFixed(1)} pts`);
  console.log(`  Avg moves per game: ${(totals.gameMoves / games).toFixed(1)}`);
  if (opts.mustSeeBag !== undefined) {
    console.log(`  Skipped (never faced bag ${opts.mustSeeBag}): ${skippedTrunc} of ${specs.length}`);
  }
  if (opts.close !== undefined) {
    const ties = closeN - closeA - closeB;
    console.log(`  Close games (|margin at bag<=${closeBag} entry| <= ${opts.close}): ${closeN} of ${games}`);
    console.log(`    A ${closeA} — B ${closeB}${ties ? ` — ${ties} ties` : ''}, A margin ${(closeN ? closeSum / closeN : 0).toFixed(1)} pts`);
  }
}

// User-supplied realm config snippets run inside `with (STAGES)`, so the
// concise form 'bag0.depth = 8' works alongside the fully qualified
// 'STAGES.bag0.depth = 8' (identifiers not on STAGES fall through).
function stagesEval(code) {
  return `with (STAGES) { ${code} }`;
}

module.exports = { TILE_DATA, LETTER_VALUES, mulberry32, buildSeededBag, loadWords, loadEngine, playGame, runPool, stagesEval };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
