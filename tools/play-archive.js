#!/usr/bin/env node
// Archive full-strength self-play games: both seats play the untouched
// production config for every stage (sim stages, campaigned low-bag
// stages, bag0 solver). One JSONL record per game — seed, per-move
// details (seat, pre-move bag, rack, move, score, decision ms, sim
// telemetry), final scores and margin — plus a header record stamping
// the engine and model hashes so golden-replay diffs can tell an
// engine change from corruption.
//
// Uses: on-distribution position mining for truth builders, golden-game
// regression replays, deployment-honest latency/telemetry analysis.
//
// Game seeds are draws from a mulberry32(--base-seed) stream (per-entry
// s field), so parallel archivers need no range discipline and reruns
// resume where they stopped (same META rules as build-preend-solves).
//
//   node tools/play-archive.js <out.jsonl> [--games N] [--base-seed S]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const m = require('./match.js');

const OUT = process.argv[2];
if (!OUT || OUT.startsWith('--')) {
  console.error('Usage: node tools/play-archive.js <out.jsonl> [--games N] [--base-seed S]');
  process.exit(2);
}
const flag = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
const GAMES = parseInt(flag('--games', '500'), 10);
// Creation-only: an existing archive's stored baseSeed wins; a differing
// CLI value only warns (engine/model hash mismatches still refuse).
let BASE_SEED = parseInt(flag('--base-seed', '777000'), 10);

const md5 = f => fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex') : 'none';
const ROOT = path.join(__dirname, '..');
const META = {
  v: 1, kind: 'prod-games', baseSeed: BASE_SEED, seedMode: 'stream',
  gameJsMd5: md5(path.join(ROOT, 'game.js')),
  egWeightsMd5: md5(path.join(ROOT, 'endgame-leaves.json.gz')),
  leavesWMd5: md5(path.join(ROOT, 'leaves-w.txt.gz')),
};

let played = 0;
if (fs.existsSync(OUT)) {
  const lines = fs.readFileSync(OUT, 'utf8').split('\n').filter(l => l.trim());
  const head = JSON.parse(lines[0]);
  if (head.baseSeed !== BASE_SEED) {
    console.error(`NOTE: resuming the archive's seed stream (baseSeed ${head.baseSeed}); CLI --base-seed ${BASE_SEED} ignored.`);
    BASE_SEED = head.baseSeed;
    META.baseSeed = head.baseSeed;
  }
  if (JSON.stringify(head) !== JSON.stringify(META)) {
    console.error('Existing archive has a different engine/model stamp; refusing to append.');
    process.exit(2);
  }
  played = lines.length - 1;
} else {
  fs.writeFileSync(OUT, JSON.stringify(META) + '\n');
}

const words = m.loadWords();
const E = m.loadEngine(path.join(ROOT, 'game.js'), words, {});

(async () => {
  const t0 = Date.now();
  let hbAt = 1;
  let sumMoves = 0, sumMs = 0, sumAbsMargin = 0;
  console.log(`${'games'.padStart(7)} ${'avg mv'.padStart(7)} ${'avg ms/mv'.padStart(10)} ${'avg |margin|'.padStart(13)} ${'elapsed'.padStart(9)}`);
  const printRow = () => console.log(
    `${String(played).padStart(7)} ${(sumMoves / Math.max(1, played)).toFixed(1).padStart(7)} ${(sumMs / Math.max(1, sumMoves)).toFixed(0).padStart(10)} ${(sumAbsMargin / Math.max(1, played)).toFixed(1).padStart(13)} ${(((Date.now() - t0) / 1000).toFixed(0) + 's').padStart(9)}`);

  const seedStream = m.mulberry32(BASE_SEED);
  for (let g = 0; g < GAMES; g++) {
    const seed = Math.floor(seedStream() * 4294967296);
    if (g < played) continue; // fast-forward the stream on resume
    const bag = m.buildSeededBag(m.mulberry32(seed));
    const rec = { s: seed, mv: [] };
    const rackStr = r => r.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).join('');
    const wrap = seat => ({
      bestMove: async (board, rack, isFirstMove, bagLen, myScore, oppScore) => {
        const t = Date.now();
        const mvv = await E.bestMove(board, rack, isFirstMove, bagLen, myScore, oppScore);
        const ms = Date.now() - t;
        const tel = JSON.parse(E.evalInRealm(
          'JSON.stringify({ m: TRACE.lastMeterUsed ?? null, w: TRACE.lastWorldsDone ?? null })'));
        rec.mv.push({
          seat, bag: bagLen, rack: rackStr(rack),
          kind: mvv ? (mvv.exchange ? 'exchange' : 'play') : 'pass',
          w: mvv && mvv.word ? mvv.word : undefined,
          sc: mvv && mvv.score ? mvv.score : 0,
          pl: mvv && mvv.placements
            ? mvv.placements.map(p => `${p.row},${p.col},${p.isBlank ? '?' : ''}${p.letter.toUpperCase()}`).join('|')
            : undefined,
          x: mvv && mvv.exchange ? mvv.tiles.length : undefined,
          ms, meter: tel.m, worlds: tel.w,
        });
        return mvv;
      },
    });
    const r = await m.playGame([wrap(0), wrap(1)], bag, false, '');
    rec.final = [+r.scores[0].toFixed(1), +r.scores[1].toFixed(1)];
    rec.margin = +(r.scores[0] - r.scores[1]).toFixed(1);
    rec.reason = r.reason;
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    played++;
    sumMoves += rec.mv.length;
    sumMs += rec.mv.reduce((s, x) => s + x.ms, 0);
    sumAbsMargin += Math.abs(rec.margin);
    if (played >= hbAt) { printRow(); hbAt = Math.ceil(hbAt * 1.5); }
  }
  printRow();
  console.log(`DONE | ${played} prod games -> ${OUT}`);
})();
