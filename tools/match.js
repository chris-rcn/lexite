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
  const text = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'words.txt'), 'utf8');
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
  vm.runInContext(`
    state.wordSet = new Set(__WORDS);
    state.wordsByLength = Array.from({length: 16}, () => []);
    for (const w of state.wordSet) {
      if (w.length <= 15) state.wordsByLength[w.length].push(w);
    }
    if (${opts.staticOnly ? 'true' : 'false'} && typeof SIM !== 'undefined') SIM.CANDIDATES = 1;
    globalThis.__bestMove = (positionJson) => {
      const pos = JSON.parse(positionJson);
      state.board = pos.board;
      state.isFirstMove = pos.isFirstMove;
      // Only the bag's length is read (leave-value damping)
      state.bag = new Array(pos.bagCount || 0).fill('?');
      if (typeof findBestMove === 'function') return findBestMove(pos.rack);
      // Pre-refactor engine API
      state.computerRack = pos.rack;
      return findBestComputerMove();
    };
  `, sandbox);

  return {
    file,
    stats: { moves: 0, ms: 0 },
    async bestMove(board, rack, isFirstMove, bagCount) {
      const positionJson = JSON.stringify({
        board,
        rack: rack.map(t => ({ letter: t.letter, isBlank: t.isBlank })),
        isFirstMove,
        bagCount,
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
async function playGame(engines, initialBag, verbose, label, onPosition) {
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
  let passes = 0;
  let seat = 0;
  let moves = 0;
  let reason;

  for (;;) {
    if (onPosition) onPosition(board, bag, isFirstMove);
    const move = await engines[seat].bestMove(board, racks[seat], isFirstMove, bag.length);
    moves++;
    if (!move) {
      // No exchanges exist, so once both engines pass the position is
      // stuck for good — two consecutive passes ends the game.
      if (verbose) console.log(`  [${label}] seat${seat}: pass`);
      if (++passes >= 2) { reason = 'passes'; break; }
    } else {
      passes = 0;
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

  return { scores, moves, reason };
}

// Play one game (spec = {a, b, swap, bag}) in this process and return a
// result record in engine-A/B terms rather than seat terms.
async function playSpec(spec, verbose, label) {
  const words = loadWords();
  const A = loadEngine(spec.a, words);
  const B = loadEngine(spec.b, words);
  const seatEngines = spec.swap ? [B, A] : [A, B];
  const g = await playGame(seatEngines, spec.bag, verbose, label);
  return {
    aScore: spec.swap ? g.scores[1] : g.scores[0],
    bScore: spec.swap ? g.scores[0] : g.scores[1],
    reason: g.reason,
    moves: g.moves,
    aStats: A.stats,
    bStats: B.stats,
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
    specs.push({ a: aFile, b: bFile, swap: false, bag, seed });
    specs.push({ a: aFile, b: bFile, swap: true, bag, seed });
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
