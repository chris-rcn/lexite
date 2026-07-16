# Lexite

A single-player word tile game played against the computer on a 15×15 board.

## Features

- 15×15 board with standard bonus squares (Triple Word, Double Word, Triple Letter, Double Letter)
- Standard tile distribution and letter values (100 tiles)
- Single-player vs. computer — the computer always plays the highest-scoring valid move
- Shuffle button to rearrange your rack
- Open-source word list (ENABLE — public domain, ~173,000 words)

## How to Play

1. Start a local HTTP server in this directory (required for the word list to load):

   ```bash
   python3 -m http.server 8080
   # or: npx serve .
   ```

2. Open `http://localhost:8080` in your browser.

3. Click a tile in your rack to select it, then click an empty board cell to place it —
   or drag tiles from the rack onto the board.
   With no rack tile selected, clicking another empty cell moves your most recently
   placed tile there.

4. Click **Shuffle Rack** to rearrange your rack tiles.
   Click **Recall Tiles** to take back all tiles you placed this turn.
   Click **Play Lifeline** (once per game) to have the computer play your best move for you.
   Click **Play Word** to submit your move.
   To pass, click **Play Word** with no tiles placed and confirm.

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

The game uses the ENABLE word list, which is in the public domain (~173,000 words).

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