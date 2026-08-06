# Lexite

A single-player word tile game played against the computer on a 15×15 board.

## Features

- 15×15 board with standard bonus squares (Triple Word, Double Word, Triple Letter, Double Letter)
- Standard tile distribution and letter values (100 tiles)
- Single-player vs. computer — the computer always plays the highest-scoring valid move
- Shuffle button to rearrange your rack
- Open-source, public-domain word list

## How to Play

1. Open `index.html` in your browser — straight from disk works (the word
   list falls back to an embedded copy on `file://`). Serving over HTTP
   works too and downloads slightly less data:

   ```bash
   python3 -m http.server 8080   # or: npx serve .
   ```

2. If you started a server, open `http://localhost:8080` in your browser.

3. Click a tile in your rack to select it, then click an empty board cell to place it —
   or drag tiles from the rack onto the board.
   With no rack tile selected, clicking another empty cell moves your most recently
   placed tile there.

4. Click **Shuffle Rack** to rearrange your rack tiles.
   Click **Recall Tiles** to take back all tiles you placed this turn.
   Click **Play Lifeline** (once per game) to have the computer play your best move for you.
   Click **Swap Tiles** (needs 7+ tiles in the bag) to exchange tiles: select
   the ones to give up, then confirm. An exchange scores nothing and uses your turn.
   Click **Play Word** to submit your move.
   To pass, click **Play Word** with no tiles placed and confirm.
   Six consecutive scoreless turns (passes or exchanges) end the game.

5. The first word must cover the center star (★).
   All words formed — including cross-words — must be valid.

## Scoring

| Bonus | Color | Effect |
|-------|-------|--------|
| Triple Word | Red | Word score × 3 |
| Double Word | Pink/Orange | Word score × 2 |
| Triple Letter | Blue | Letter value × 3 |
| Double Letter | Light blue | Letter value × 2 |
| Bingo | — | +50 points for using all 7 tiles in one move |

## Word List

The game uses an open-source, public-domain word list, plus a small house
patch of common modern words it omits. The additions are our own editorial
selection — not a copy of any copyrighted tournament word list.

The list ships only gzipped (`words.txt.gz`, ~4× smaller than plain text).
The browser inflates it client-side with `DecompressionStream`, and the
Node tools decompress it with `zlib`. To edit the list, unzip it, change
the words, and re-zip:

```bash
gzip -dk words.txt.gz            # -> words.txt
# edit words.txt (keep it sorted: LC_ALL=C sort -u)
gzip -9 -f words.txt && rm -f words.txt   # -> words.txt.gz
node tools/build-data-js.js      # refresh the file:// fallback copies
```

When `index.html` is opened directly from disk (`file://`), `fetch()`
cannot read sibling files, so the gzipped assets also ship base64-embedded
in generated `words.data.js` / `leaves.data.js`, loaded via an injected
`<script>` tag only when the fetch fails. Over HTTP they are never
downloaded. Re-run `node tools/build-data-js.js` whenever `words.txt.gz`
or `leaves.bin.gz` changes.

## Comparing Engine Versions

`tools/match.js` plays two versions of the move engine against each other
headlessly (Node.js, no browser needed) and reports wins, average score,
average time per move for each version, and average moves per game.

```bash
# Current engine against an older revision, 10 mirrored pairs (20 games):
git show <rev>:game.js > /tmp/game-old.js
node tools/match.js --a game.js --b /tmp/game-old.js --pairs 10

# Options: --pairs N (default 3), --seed S (default 1),
#          --jobs J (parallel games, default = CPUs, max 4),
#          --verbose (sequential, logs every move)
```

Matches are fair: each pair plays one seeded bag shuffle twice with the
seats swapped ("color swap"), so both engines get the identical starting
tiles and draw order from each seat, and the same base seed always
reproduces the same match. The engines are deterministic, so an A-vs-A
match produces exactly mirrored scores — a quick way to sanity-check the
harness itself.

If a `leaves.js` sits next to an engine file, the harness loads it as
that engine's leave model — an engine version and its weights travel as
a pair, so put each version being compared in its own directory.

## Rack-Leave Model

The engine picks the move maximizing `score + value(tiles kept)` rather
than raw score, so it stops dumping blanks and S's for marginal points
or keeping unplayable racks. At runtime the values come from the
superleave table: one equity byte for each of the 914,625 possible
leaves of up to 6 tiles. The browser downloads the sparse feature
weights (`leaves-w.txt.gz`, ~21 KB) and assembles the table locally in
about a second. (Prebuilt `leaves.bin.gz` tables remain the match
harness's per-directory format — `tools/leave-td.js export` writes
both.) Seven-tile count vectors (the
sim horizon evaluates full racks; bag-aware evaluation completes a
6-tile leave with a projected draw) are valued as the mean of their
seven drop-one 6-tile leaves from the same table. If no table loads,
the engine falls back to greedy, leave-blind play.

Tables are trained by online TD self-play and exported:

```bash
node tools/leave-td.js online-learn --probe-ratio 0.5 --ckpt run.ckpt.json
# Ctrl-C when converged (the checkpoint saves at every progress tick), then:
node tools/leave-td.js export --ckpt run.ckpt.json \
  --out leaves.bin.gz --weights-out leaves-w.txt.gz
node tools/build-data-js.js      # refresh the file:// fallback copies
```

The policy plays greedily against itself with the live weights; values
are hierarchical sub-multiset features (letters, pairs, on up to
`--maxorder`); the TD bootstrap is damped by `min(1, bagAfterDraw/7)`,
so every chain ends grounded in realized points; and `--probe-ratio`
mixes in chained exploring-starts rollouts so holdings the greedy
policy under-produces (blank co-holds, QU) still get data.

The older linear model (`leaves.js`: per-letter plus per-pair weights)
is retired from the browser runtime but kept as tooling — it seeds
`tools/superleave.js build/refine`, and the match harness still loads
it per-engine so historical engine versions stay comparable. It is
trained by regression on seeded self-play data:

```bash
node tools/train-leaves.js            # records new samples, refits leaves.js
# Options: --samples N --games G --seed S --jobs J --out FILE --data FILE
```

Every sampled evaluation is retained in `data/leave-samples.jsonl`
(one `{"l":"<leave>","y":<score>}` line each, with `{"meta":...}` run
markers), because the engine evaluations are the expensive part of
training. That makes iteration cheap:

```bash
node tools/train-leaves.js --fit-only       # refit from recorded data, < 1 s
node tools/train-leaves.js --record-only    # grow the dataset
```

Use `--fit-only` after changing leave features or the regression; a
normal run appends new samples and refits on the whole file. Each run
seeds itself randomly (so repeated runs never append duplicate rows) and
stores the seed it used in the data file's meta line — pass `--seed`
only to reproduce a past run.

The leave bonus fades out as the bag empties (kept tiles have no future
with nothing left to draw).

## Endgame Search

Once the bag is empty the game is perfect-information — the opponent's
rack is exactly the unseen tiles — so instead of greedy scoring the
engine runs a budgeted alpha-beta search over the remaining playout,
maximizing final margin under the real end rules (going out banks the
opponent's rack value twice; two consecutive passes strand both racks).
Width and depth are capped so a decision stays well under a second.