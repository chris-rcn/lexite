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

3. Click a tile in your rack to select it, then click an empty board cell to place it.
   Click a placed tile on the board to return it to your rack.

4. Click **Shuffle** to rearrange your rack tiles.
   Click **Recall** to take back all tiles you placed this turn.
   Click **Play Word** to submit your move.
   Click **Pass** to skip your turn.

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