// Lexite — word tile game
// game.js: all game logic, rendering, and computer move engine

'use strict';

// ============================================================
// CONSTANTS
// ============================================================

const TILE_DATA = {
  A:[9,1],  B:[2,3],  C:[2,3],  D:[4,2],  E:[12,1],
  F:[2,4],  G:[3,2],  H:[2,4],  I:[9,1],  J:[1,8],
  K:[1,5],  L:[4,1],  M:[2,3],  N:[6,1],  O:[8,1],
  P:[2,3],  Q:[1,10], R:[6,1],  S:[4,1],  T:[6,1],
  U:[4,1],  V:[2,4],  W:[2,4],  X:[1,8],  Y:[2,4],
  Z:[1,10], '?':[2,0]
};

const LETTER_VALUES = {};
for (const [ch,[,v]] of Object.entries(TILE_DATA)) LETTER_VALUES[ch] = v;

// Letter values indexed by code 0-25 for the move generator's hot path
const LETTER_VAL_BY_CODE = new Int32Array(26);
for (let i = 0; i < 26; i++) {
  LETTER_VAL_BY_CODE[i] = LETTER_VALUES[String.fromCharCode(65 + i)] || 0;
}

// Bonus square map — built once at load
const BONUS_MAP = Array.from({length:15}, () => new Array(15).fill(null));
(function buildBonusMap() {
  const TW = [[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]];
  const DW = [[1,1],[2,2],[3,3],[4,4],[7,7],
              [1,13],[2,12],[3,11],[4,10],
              [10,4],[11,3],[12,2],[13,1],
              [10,10],[11,11],[12,12],[13,13]];
  const TL = [[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],
              [9,1],[9,5],[9,9],[9,13],[13,5],[13,9]];
  const DL = [[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],
              [6,2],[6,6],[6,8],[6,12],[7,3],[7,11],
              [8,2],[8,6],[8,8],[8,12],[11,0],[11,7],[11,14],
              [12,6],[12,8],[14,3],[14,11]];
  for (const [r,c] of TW) BONUS_MAP[r][c] = 'TW';
  for (const [r,c] of DW) BONUS_MAP[r][c] = 'DW';
  for (const [r,c] of TL) BONUS_MAP[r][c] = 'TL';
  for (const [r,c] of DL) BONUS_MAP[r][c] = 'DL';
})();

// ============================================================
// STATE
// ============================================================

const state = {
  // board[r][c] = null | { letter: 'A', isBlank: false }
  board: null,
  bag: [],
  playerRack: [],   // array of { letter, isBlank }
  computerRack: [], // array of { letter, isBlank }
  playerScore: 0,
  computerScore: 0,
  turn: 'player',
  isFirstMove: true,
  // Tiles the player has placed this turn (not yet committed)
  pending: [],  // [{row, col, letter, isBlank, displayLetter}]
  selectedRackIdx: null,
  dragRackIdx: null,
  exchangeMode: false,
  exchangeSelected: new Set(), // rack indices marked for exchange
  wordSet: null,
  trie: null, // typed-array packed dictionary trie (built by ensureTrie)
  gameOver: false,
  consecutivePasses: 0,
  lifelineUsed: false,
  // Incremented on every new game so in-flight async turns can detect
  // that the game they were computing for has been discarded.
  gameId: 0,
  playerTurnActive: false,
  blankCallback: null,
  lastPlay: new Set(),  // set of "row,col" keys for the most recent play
};

// ============================================================
// INIT & LOAD
// ============================================================

async function init() {
  buildBlankLetterGrid();
  document.getElementById('btn-new-game').addEventListener('click', requestNewGame);
  document.getElementById('btn-shuffle').addEventListener('click', shufflePlayerRack);
  document.getElementById('btn-lifeline').addEventListener('click', lifelineTurn);
  document.getElementById('btn-recall').addEventListener('click', recallAllTiles);
  document.getElementById('btn-play').addEventListener('click', submitPlayerMove);
  document.getElementById('blank-cancel').addEventListener('click', cancelBlankDialog);
  document.getElementById('bag-info-unseen').addEventListener('click', showUnseenDialog);
  document.getElementById('unseen-close').addEventListener('click', closeUnseenDialog);
  scoreBubbleEl = document.getElementById('score-bubble');
  // Board size depends on the viewport, so re-anchor the bubble on resize.
  window.addEventListener('resize', () => {
    if (state.pending.length > 0) updateScoreBubble();
  });
  document.getElementById('unseen-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('unseen-overlay')) closeUnseenDialog();
  });
  document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('end-overlay').classList.add('hidden');
    newGame();
  });
  document.getElementById('btn-exchange').addEventListener('click', enterExchangeMode);
  document.getElementById('exchange-confirm').addEventListener('click', confirmExchange);
  document.getElementById('exchange-cancel').addEventListener('click', exitExchangeMode);
  // Pass confirmation dialog (replaces the native confirm())
  const hidePassDialog = () => document.getElementById('pass-overlay').classList.add('hidden');
  document.getElementById('pass-confirm').addEventListener('click', () => {
    hidePassDialog();
    passPlayerTurn();
  });
  document.getElementById('pass-cancel').addEventListener('click', hidePassDialog);
  document.getElementById('pass-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('pass-overlay')) hidePassDialog();
  });
  // New game confirmation dialog
  const hideNewGameDialog = () => document.getElementById('newgame-overlay').classList.add('hidden');
  document.getElementById('newgame-confirm').addEventListener('click', () => {
    hideNewGameDialog();
    newGame();
  });
  document.getElementById('newgame-cancel').addEventListener('click', hideNewGameDialog);
  document.getElementById('newgame-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('newgame-overlay')) hideNewGameDialog();
  });
  // The end dialog can be dismissed to inspect the final board — via the
  // View Board button or a click on the backdrop.
  document.getElementById('end-close').addEventListener('click', () => {
    document.getElementById('end-overlay').classList.add('hidden');
  });
  document.getElementById('end-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('end-overlay')) {
      document.getElementById('end-overlay').classList.add('hidden');
    }
  });

  // Build and paint the board and rack right away — neither depends on the
  // word list, so don't make them wait on the ~1.7 MB download to appear.
  // Player controls stay frozen until the dictionary is ready to validate
  // moves; enablePlayerControls(false) also blocks cell/rack interaction.
  newGame();
  enablePlayerControls(false);

  try {
    await loadWordList();
  } catch (e) {
    showLoadError(e);
    return;
  }
  await loadSuperTable(); // best-effort; leaves the linear model in place on failure
  enablePlayerControls(true);
}

async function loadWordList() {
  const text = await fetchWordListText();
  state.wordSet = new Set(
    text.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => w.length >= 2)
  );
  ensureTrie();
}

// The word list ships only gzipped (~450 KB vs ~1.7 MB uncompressed), so it
// is inflated in the browser with DecompressionStream — supported by every
// current browser (Chrome/Edge 80+, Firefox 113+, Safari 16.4+).
// On file:// fetch() can never read sibling files — attempting it only
// fills the console with CORS errors — so asset loading skips straight
// to the embedded-script fallbacks there.
const IS_FILE_URL = typeof location !== 'undefined' && location.protocol === 'file:';

async function fetchWordListText() {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser is too old (needs gzip DecompressionStream)');
  }
  if (!IS_FILE_URL) {
    try {
      const resp = await fetch('words.txt.gz');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch (fetchErr) {
      try {
        return await (await loadEmbeddedGz('words.data.js', 'WORDS_GZ_B64')).text();
      } catch (embedErr) {
        throw new Error(fetchErr.message + ' (fallback: ' + embedErr.message + ')');
      }
    }
  }
  return await (await loadEmbeddedGz('words.data.js', 'WORDS_GZ_B64')).text();
}

// Fallback transport for file:// — fetch() cannot read sibling files off
// disk, but an injected <script> tag can. tools/build-data-js.js generates
// *.data.js files holding the gzipped assets as base64 globals; this loads
// one, decodes it, and gunzips it. Returns a Response over the inflated
// bytes. Served over HTTP the primary fetch succeeds and none of this runs,
// so the data is never downloaded twice.
async function loadEmbeddedGz(src, globalName) {
  if (typeof document === 'undefined') throw new Error('no document (not a browser)');
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
  const b64 = globalThis[globalName];
  if (typeof b64 !== 'string') throw new Error(globalName + ' missing from ' + src);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream);
}

function showLoadError(err) {
  const container = document.getElementById('board-container');
  container.innerHTML = '';
  const msg = document.createElement('div');
  msg.id = 'load-error';
  msg.textContent =
    'Could not load the word list: ' + err.message + '. ' +
    'Check that words.txt.gz and words.data.js sit next to index.html ' +
    '(regenerate the latter with "node tools/build-data-js.js"), or serve ' +
    'the directory over HTTP: "python3 -m http.server 8080".';
  container.appendChild(msg);
  enablePlayerControls(false);
}

// ============================================================
// NEW GAME
// ============================================================

// New Game button: confirm first if a game is in progress; once the game
// is over there is nothing to lose, so start immediately.
function requestNewGame() {
  if (state.gameOver) {
    newGame();
  } else {
    document.getElementById('newgame-overlay').classList.remove('hidden');
  }
}

function newGame() {
  state.board = Array.from({length:15}, () => new Array(15).fill(null));
  state.bag = buildBag();
  state.playerRack = [];
  state.computerRack = [];
  state.playerScore = 0;
  // Half-point komi to the second player (the computer — the human always
  // opens): a raw tie resolves to the second player as pure margin
  // arithmetic, and every margin-consuming evaluation (including the
  // score-aware P(win) paths) inherits the rule with no seat-parity
  // plumbing. Internal only; displays floor to whole points.
  state.computerScore = 0.5;
  state.turn = 'player';
  state.isFirstMove = true;
  state.pending = [];
  state.selectedRackIdx = null;
  state.dragRackIdx = null;
  state.gameOver = false;
  state.consecutivePasses = 0;
  state.lastPlay = new Set();
  state.lifelineUsed = false;
  state.playerTurnActive = true;
  state.gameId++;
  state.exchangeMode = false;
  state.exchangeSelected = new Set();
  document.getElementById('exchange-bar').classList.add('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');

  drawTiles(state.playerRack, 7);
  drawTiles(state.computerRack, 7);

  buildBoardDOM();
  renderRack();
  renderScores();
  updateBagCount();
  clearLog();
  enablePlayerControls(true);
}

// ============================================================
// TILE BAG
// ============================================================

function buildBag() {
  const bag = [];
  for (const [letter, [count]] of Object.entries(TILE_DATA)) {
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  shuffleArray(bag);
  return bag;
}

function drawTiles(rack, n) {
  while (rack.length < 7 && state.bag.length > 0 && n-- > 0) {
    const raw = state.bag.pop();
    rack.push({ letter: raw, isBlank: raw === '?' });
  }
}

// Execute an exchange for a rack: replacements are drawn first (so the
// discards cannot be immediately redrawn), then the discards return to
// the bag and it is reshuffled. Callers handle logging and turn flow.
function executeExchange(rack, tiles) {
  for (const t of tiles) {
    const idx = rack.findIndex(x =>
      t.isBlank ? x.isBlank : (!x.isBlank && x.letter === t.letter));
    if (idx !== -1) rack.splice(idx, 1);
  }
  drawTiles(rack, tiles.length);
  for (const t of tiles) state.bag.push(t.isBlank ? '?' : t.letter);
  shuffleArray(state.bag);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ============================================================
// BOARD DOM
// ============================================================

function buildBoardDOM() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      const bonus = BONUS_MAP[r][c];
      if (bonus) {
        cell.classList.add(bonus.toLowerCase());
        if (r === 7 && c === 7) {
          cell.classList.remove('dw');
          cell.classList.add('center');
          cell.dataset.label = '★';
        } else {
          const labels = {TW:'TW', DW:'DW', TL:'TL', DL:'DL'};
          cell.dataset.label = labels[bonus] || bonus;
        }
      }

      cell.addEventListener('click', () => onCellClick(r, c));
      cell.addEventListener('dragover', (e) => {
        if (state.dragRackIdx !== null) e.preventDefault();
      });
      cell.addEventListener('dragenter', (e) => {
        if (state.dragRackIdx !== null) { e.preventDefault(); cell.classList.add('drag-over'); }
      });
      cell.addEventListener('dragleave', () => { cell.classList.remove('drag-over'); });
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        cell.classList.remove('drag-over');
        onCellDrop(r, c);
      });
      boardEl.appendChild(cell);
    }
  }
}

function getCellEl(r, c) {
  return document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
}

function renderBoard() {
  const pendingSet = new Map(state.pending.map(p => [`${p.row},${p.col}`, p]));

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = getCellEl(r, c);
      if (!cell) continue;

      // Remove old tile child
      const oldTile = cell.querySelector('.tile');
      if (oldTile) cell.removeChild(oldTile);
      cell.classList.remove('has-tile');

      const key = `${r},${c}`;
      if (pendingSet.has(key)) {
        const p = pendingSet.get(key);
        cell.classList.add('has-tile');
        cell.appendChild(makeTileEl(p.displayLetter || p.letter, p.isBlank, true));
      } else if (state.board[r][c]) {
        const t = state.board[r][c];
        cell.classList.add('has-tile');
        cell.appendChild(makeTileEl(t.displayLetter || t.letter, t.isBlank, false, state.lastPlay.has(key)));
      }
    }
  }
}

function makeTileEl(letter, isBlank, pending, lastPlay = false) {
  const el = document.createElement('div');
  el.className = 'tile' + (isBlank ? ' blank-tile' : '') + (pending ? ' pending' : '') + (lastPlay ? ' last-play' : '');
  el.textContent = letter.toUpperCase();
  const pts = document.createElement('span');
  pts.className = 'tile-points';
  pts.textContent = isBlank ? '' : (LETTER_VALUES[letter.toUpperCase()] || 0);
  el.appendChild(pts);
  return el;
}

// ============================================================
// TOUCH DRAG (iOS Safari fallback)
// ============================================================

const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

let touchGhost        = null;
let touchLastCell     = null;
let touchLastRackTile = null;
let touchSourceEl     = null;
let dragRackPreviewIdx = null;
let scoreBubbleEl  = null; // cached after DOM ready

function onTouchTileStart(e, idx) {
  if (!state.playerTurnActive) return;
  if (state.exchangeMode) { e.preventDefault(); onRackTileClick(idx); return; }
  e.preventDefault();

  state.dragRackIdx = idx;
  state.selectedRackIdx = idx;
  document.querySelectorAll('#rack .rack-tile').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });

  // Clean up any leftover state from an interrupted drag.
  if (touchSourceEl) { touchSourceEl.style.opacity = ''; touchSourceEl.style.pointerEvents = ''; touchSourceEl = null; }
  if (touchGhost)    { touchGhost.remove(); touchGhost = null; }

  // Hide the source tile so only the ghost is visible.
  touchSourceEl = e.currentTarget;
  touchSourceEl.style.opacity = '0';
  touchSourceEl.style.pointerEvents = 'none';

  const touch = e.touches[0];

  // Clone the source tile — guarantees identical rendering without relying on
  // CSS variable resolution for a dynamically-appended element.
  // Reset inline styles that were set on the source so the ghost is visible.
  touchGhost = touchSourceEl.cloneNode(true);
  touchGhost.style.opacity = '';
  touchGhost.style.pointerEvents = '';
  touchGhost.classList.add('touch-drag-ghost');
  positionGhost(touch.clientX, touch.clientY);
  document.body.appendChild(touchGhost);

  document.addEventListener('touchmove', onTouchDragMove, { passive: false });
  document.addEventListener('touchend', onTouchDragEnd, { passive: false });
  document.addEventListener('touchcancel', onTouchDragEnd, { passive: false });
}

function positionGhost(x, y, cellEl) {
  const w = touchGhost.offsetWidth  || 48;
  const h = touchGhost.offsetHeight || 52;
  if (cellEl) {
    const rect = cellEl.getBoundingClientRect();
    touchGhost.style.transform = 'scale(1.5)';
    touchGhost.style.left = (rect.left + rect.width  / 2 - w / 2) + 'px';
    touchGhost.style.top  = (rect.top  + rect.height / 2 - h / 2) + 'px';
  } else {
    touchGhost.style.transform = 'scale(1.15)';
    touchGhost.style.left = (x - w / 2) + 'px';
    touchGhost.style.top  = (y - h / 2) + 'px';
  }
}

function onTouchDragMove(e) {
  e.preventDefault();
  const touch = e.touches[0];

  // pointer-events:none is set but some iOS versions still hit the ghost,
  // so temporarily move it off-screen for the hit-test
  const savedLeft = touchGhost.style.left;
  const savedTop  = touchGhost.style.top;
  touchGhost.style.left = '-9999px';
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  touchGhost.style.left = savedLeft;

  const cell = el && el.closest('.cell');
  const targetCell = (cell && !cell.classList.contains('has-tile')) ? cell : null;

  const rackTile = !cell && el && el.closest('.rack-tile');
  const targetRackTile = (rackTile && rackTile !== touchSourceEl) ? rackTile : null;

  if (targetCell !== touchLastCell) {
    if (touchLastCell) touchLastCell.classList.remove('drag-over');
    touchLastCell = targetCell;
    if (targetCell) targetCell.classList.add('drag-over');
  }

  if (targetRackTile !== null && targetRackTile !== touchLastRackTile) {
    touchLastRackTile = targetRackTile;
    const rackTiles = Array.from(document.querySelectorAll('#rack .rack-tile'));
    dragRackPreviewIdx = rackTiles.indexOf(targetRackTile);
    updateRackOrder(state.dragRackIdx, dragRackPreviewIdx);
  }

  positionGhost(touch.clientX, touch.clientY, targetCell);
}

function onTouchDragEnd(e) {
  document.removeEventListener('touchmove', onTouchDragMove);
  document.removeEventListener('touchend', onTouchDragEnd);
  document.removeEventListener('touchcancel', onTouchDragEnd);

  if (touchLastCell) { touchLastCell.classList.remove('drag-over'); touchLastCell = null; }
  touchLastRackTile = null;
  document.querySelectorAll('#rack .rack-tile').forEach(t => t.style.order = '');
  if (touchGhost)    { touchGhost.remove(); touchGhost = null; }
  if (touchSourceEl) { touchSourceEl.style.opacity = ''; touchSourceEl.style.pointerEvents = ''; touchSourceEl = null; }

  const fromIdx = state.dragRackIdx;
  const toIdx   = dragRackPreviewIdx;
  dragRackPreviewIdx = null;

  if (e.type === 'touchend' && e.changedTouches.length) {
    const touch = e.changedTouches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const cell = el && el.closest('.cell');
    if (cell) {
      const r = parseInt(cell.dataset.row);
      const c = parseInt(cell.dataset.col);
      onCellDrop(r, c);
    } else if (fromIdx !== null && toIdx !== null && toIdx !== fromIdx) {
      reorderRack(fromIdx, toIdx);
    }
  }

  state.dragRackIdx = null;
}

// ============================================================
// RACK RENDERING
// ============================================================

function renderRack() {
  const rackEl = document.getElementById('rack');
  rackEl.innerHTML = '';
  state.playerRack.forEach((tile, idx) => {
    const el = document.createElement('div');
    el.className = 'rack-tile' + (tile.isBlank ? ' blank-tile' : '');
    if (idx === state.selectedRackIdx && !state.exchangeMode) el.classList.add('selected');
    if (state.exchangeMode && state.exchangeSelected.has(idx)) el.classList.add('exchange-marked');
    el.textContent = tile.isBlank ? '' : tile.letter;
    const pts = document.createElement('span');
    pts.className = 'tile-points';
    pts.textContent = tile.isBlank ? '' : (LETTER_VALUES[tile.letter] || 0);
    el.appendChild(pts);
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      if (!state.playerTurnActive || state.exchangeMode) { e.preventDefault(); return; }
      state.dragRackIdx = idx;
      state.selectedRackIdx = idx;
      // Firefox refuses to start a drag unless some data is set.
      e.dataTransfer.setData('text/plain', String(idx));
      e.dataTransfer.effectAllowed = 'move';
      // Use a clone as the drag image so the browser renders the full tile
      // instead of a platform-default outline/ghost.
      const dragImg = el.cloneNode(true);
      dragImg.style.position = 'fixed';
      dragImg.style.top = '-9999px';
      dragImg.style.left = '-9999px';
      document.body.appendChild(dragImg);
      e.dataTransfer.setDragImage(dragImg, el.offsetWidth / 2, el.offsetHeight / 2);
      requestAnimationFrame(() => { dragImg.remove(); el.style.opacity = '0'; });
    });
    el.addEventListener('dragend', () => {
      el.style.opacity = '';
      document.querySelectorAll('#rack .rack-tile').forEach(t => t.style.order = '');
      state.dragRackIdx = null;
      dragRackPreviewIdx = null;
    });
    el.addEventListener('dragover', (e) => { if (state.dragRackIdx !== null) e.preventDefault(); });
    el.addEventListener('dragenter', (e) => {
      if (state.dragRackIdx !== null && idx !== state.dragRackIdx) {
        e.preventDefault();
        dragRackPreviewIdx = idx;
        updateRackOrder(state.dragRackIdx, idx);
      }
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = state.dragRackIdx;
      const to = dragRackPreviewIdx;
      state.dragRackIdx = null;
      dragRackPreviewIdx = null;
      if (from !== null && to !== null && from !== to) reorderRack(from, to);
    });
    el.addEventListener('touchstart', (e) => onTouchTileStart(e, idx), { passive: false });
    el.addEventListener('click', () => onRackTileClick(idx));
    rackEl.appendChild(el);
  });
}

function updateRackOrder(fromIdx, toIdx) {
  const tiles = Array.from(document.querySelectorAll('#rack .rack-tile'));
  const n = tiles.length;
  // Compute display positions as if tile at fromIdx is inserted at toIdx
  const dispOrder = Array.from({length: n}, (_, i) => i);
  dispOrder.splice(fromIdx, 1);
  dispOrder.splice(toIdx, 0, fromIdx);
  // dispOrder[displayPos] = origIdx; invert to cssOrder[origIdx] = displayPos
  const cssOrder = new Array(n);
  dispOrder.forEach((origIdx, dispPos) => { cssOrder[origIdx] = dispPos; });
  tiles.forEach((el, i) => { el.style.order = cssOrder[i]; });
}

function reorderRack(fromIdx, toIdx) {
  const [tile] = state.playerRack.splice(fromIdx, 1);
  state.playerRack.splice(toIdx, 0, tile);
  if (state.selectedRackIdx === fromIdx) state.selectedRackIdx = toIdx;
  renderRack();
}

// ============================================================
// SCORES, STATUS, LOG
// ============================================================

function renderScores() {
  // Scores are floats internally (the second player carries a half-point
  // komi implementing ties-to-second-player); the UI shows whole points.
  document.getElementById('player-score').textContent = Math.floor(state.playerScore);
  document.getElementById('computer-score').textContent = Math.floor(state.computerScore);
}

function updateBagCount() {
  const bagLen = state.bag.length;
  const unseen = bagLen + state.computerRack.length;
  document.getElementById('bag-info-unseen').textContent = `${unseen} unseen tiles`;
  document.getElementById('bag-info-bag').textContent = ` (${bagLen} in bag)`;
}

function showUnseenDialog() {
  const counts = {};
  for (const letter of state.bag) {
    const key = letter === '?' ? '?' : letter.toUpperCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const tile of state.computerRack) {
    const key = tile.isBlank ? '?' : tile.letter.toUpperCase();
    counts[key] = (counts[key] || 0) + 1;
  }

  const grid = document.getElementById('unseen-grid');
  grid.innerHTML = '';
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ?') {
    const count = counts[letter] || 0;
    const cell = document.createElement('div');
    cell.className = 'unseen-cell' + (count === 0 ? ' unseen-zero' : '');

    const face = document.createElement('div');
    face.className = 'unseen-tile' + (letter === '?' ? ' blank-tile' : '');
    face.textContent = letter === '?' ? '' : letter;

    const cnt = document.createElement('div');
    cnt.className = 'unseen-count';
    cnt.textContent = count;

    cell.appendChild(face);
    cell.appendChild(cnt);
    grid.appendChild(cell);
  }

  document.getElementById('unseen-overlay').classList.remove('hidden');
}

function closeUnseenDialog() {
  document.getElementById('unseen-overlay').classList.add('hidden');
}


function clearLog() {
  document.getElementById('move-log').innerHTML = '';
}

function logEntry(msg, cls) {
  const log = document.getElementById('move-log');
  const div = document.createElement('div');
  div.className = 'log-entry ' + (cls || 'system');
  div.textContent = msg;
  log.prepend(div);
}

// Sorted letters of the player's exchanged tiles for the move log (a blank
// is shown as ?). Only ever used for the player's own tiles — the
// computer's exchanged tiles stay hidden as a count.
function exchangedLetters(tiles) {
  return tiles.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).sort().join('');
}

let errorToastTimer = null;

function showMoveError(msg) {
  const toast = document.getElementById('error-toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(errorToastTimer);
  errorToastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function enablePlayerControls(on) {
  state.playerTurnActive = on;
  if (!on && state.exchangeMode) exitExchangeMode();
  document.getElementById('btn-play').disabled = !on;
  document.getElementById('btn-lifeline').disabled = !on || state.lifelineUsed;
  document.getElementById('btn-shuffle').disabled = !on;
  document.getElementById('btn-recall').disabled = !on;
  document.getElementById('btn-exchange').disabled = !on || state.bag.length < 7;
}

// ============================================================
// PLAYER INTERACTION
// ============================================================

function onRackTileClick(idx) {
  if (!state.playerTurnActive) return;
  if (state.exchangeMode) {
    if (state.exchangeSelected.has(idx)) state.exchangeSelected.delete(idx);
    else state.exchangeSelected.add(idx);
    updateExchangeConfirm();
    renderRack();
    return;
  }
  state.selectedRackIdx = idx;
  renderRack();
}

function onCellClick(r, c) {
  if (!state.playerTurnActive || state.exchangeMode) return;

  // Click a candidate (this-turn) tile to return just that tile to the
  // rack. Committed board tiles are not in `pending`, so they stay inert.
  const pendingIdx = state.pending.findIndex(p => p.row === r && p.col === c);
  if (pendingIdx !== -1) {
    const p = state.pending.splice(pendingIdx, 1)[0];
    state.playerRack.push({ letter: p.isBlank ? '?' : p.letter, isBlank: p.isBlank });
    // Select the returned tile so it is ready to re-place immediately.
    state.selectedRackIdx = state.playerRack.length - 1;
    renderRack();
    renderBoard();
    updateScoreBubble();
    return;
  }

  const cellEmpty = state.board[r][c] === null &&
                    !state.pending.some(p => p.row === r && p.col === c);

  // If there are pending tiles and no rack tile selected, move the last-placed one to the clicked cell.
  if (state.pending.length > 0 && state.selectedRackIdx === null && cellEmpty) {
    const last = state.pending[state.pending.length - 1];
    last.row = r;
    last.col = c;
    renderBoard();
    updateScoreBubble();
    return;
  }

  // Otherwise place the selected rack tile on the clicked cell.
  if (state.selectedRackIdx === null) return;
  if (!cellEmpty) return;

  const tile = state.playerRack[state.selectedRackIdx];

  if (tile.isBlank) {
    showBlankDialog((letter) => { placeOnBoard(r, c, tile, letter); });
  } else {
    placeOnBoard(r, c, tile, tile.letter);
  }
}

function onCellDrop(r, c) {
  if (!state.playerTurnActive || state.exchangeMode) return;
  if (state.dragRackIdx === null) return;
  if (state.board[r][c] !== null) return;
  if (state.pending.some(p => p.row === r && p.col === c)) return;

  const tile = state.playerRack[state.dragRackIdx];
  if (tile.isBlank) {
    showBlankDialog((letter) => { placeOnBoard(r, c, tile, letter); });
  } else {
    placeOnBoard(r, c, tile, tile.letter);
  }
}

function placeOnBoard(r, c, tile, letter) {
  state.playerRack.splice(state.selectedRackIdx, 1);
  state.selectedRackIdx = null;
  state.pending.push({
    row: r, col: c,
    letter: letter,
    isBlank: tile.isBlank,
    displayLetter: letter
  });
  renderRack();
  renderBoard();
  updateScoreBubble();
}

function recallAllTiles() {
  while (state.pending.length > 0) {
    const p = state.pending.pop();
    state.playerRack.push({ letter: p.isBlank ? '?' : p.letter, isBlank: p.isBlank });
  }
  state.selectedRackIdx = null;
  renderRack();
  renderBoard();
  updateScoreBubble();
}

function shufflePlayerRack() {
  shuffleArray(state.playerRack);
  state.selectedRackIdx = null;
  renderRack();
}

// ============================================================
// EXCHANGE MODE
// ============================================================

function enterExchangeMode() {
  if (!state.playerTurnActive || state.bag.length < 7 || state.exchangeMode) return;
  recallAllTiles();
  state.exchangeMode = true;
  state.exchangeSelected = new Set();
  state.selectedRackIdx = null;
  document.getElementById('action-buttons').classList.add('hidden');
  document.getElementById('exchange-bar').classList.remove('hidden');
  updateExchangeConfirm();
  renderRack();
}

function exitExchangeMode() {
  state.exchangeMode = false;
  state.exchangeSelected = new Set();
  document.getElementById('exchange-bar').classList.add('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');
  renderRack();
}

function updateExchangeConfirm() {
  const n = state.exchangeSelected.size;
  const btn = document.getElementById('exchange-confirm');
  btn.disabled = n === 0;
  btn.textContent = `Swap (${n})`;
}

function confirmExchange() {
  const tiles = [...state.exchangeSelected].map(i => state.playerRack[i]);
  if (tiles.length === 0) return;
  exitExchangeMode();
  executeExchange(state.playerRack, tiles);
  state.consecutivePasses++;
  logEntry(`You: exchanged ${exchangedLetters(tiles)}`, 'player');
  renderRack();
  updateBagCount();
  if (checkGameOver()) return;
  enablePlayerControls(false);
  state.turn = 'computer';
  setTimeout(computerTurn, 300);
}

// ============================================================
// BLANK TILE DIALOG
// ============================================================

function buildBlankLetterGrid() {
  const grid = document.getElementById('blank-letter-grid');
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    const btn = document.createElement('button');
    btn.textContent = ch;
    btn.addEventListener('click', () => {
      const cb = state.blankCallback;
      hideBlankDialog();
      if (cb) cb(ch);
    });
    grid.appendChild(btn);
  }
}

function showBlankDialog(callback) {
  state.blankCallback = callback;
  document.getElementById('blank-overlay').classList.remove('hidden');
}

function hideBlankDialog() {
  document.getElementById('blank-overlay').classList.add('hidden');
  state.blankCallback = null;
}

function cancelBlankDialog() {
  hideBlankDialog();
}

// ============================================================
// PLAYER MOVE VALIDATION
// ============================================================

function validatePlayerMove() {
  const pending = state.pending;
  if (pending.length === 0) return {valid:false, error:'No tiles placed.'};

  const rows = [...new Set(pending.map(p => p.row))];
  const cols = [...new Set(pending.map(p => p.col))];
  const isHoriz = rows.length === 1;
  const isVert  = cols.length === 1;

  if (!isHoriz && !isVert)
    return {valid:false, error:'All tiles must be in the same row or column.'};

  // Single tile: determine direction from adjacency
  let dir;
  if (pending.length === 1) {
    // On the first move there is nothing to connect to — give the
    // first-move errors instead of the nonsensical "must connect" one.
    if (state.isFirstMove) {
      if (!(pending[0].row === 7 && pending[0].col === 7))
        return {valid:false, error:'The first word must cover the center square (★).'};
      return {valid:false, error:'A word must be at least 2 letters.'};
    }
    const {row,col} = pending[0];
    const hWord = getWordAt(row, col, true, pending);
    const vWord = getWordAt(row, col, false, pending);
    if (hWord.length < 2 && vWord.length < 2)
      return {valid:false, error:'A single tile must connect to an existing word.'};
    dir = hWord.length >= vWord.length ? 'H' : 'V';
  } else {
    dir = isHoriz ? 'H' : 'V';
  }

  // Check no gaps in the span
  if (dir === 'H') {
    const row = rows[0];
    const minC = Math.min(...pending.map(p => p.col));
    const maxC = Math.max(...pending.map(p => p.col));
    for (let c = minC; c <= maxC; c++) {
      const inPending = pending.some(p => p.row === row && p.col === c);
      const onBoard   = state.board[row][c] !== null;
      if (!inPending && !onBoard)
        return {valid:false, error:'Tiles must form a continuous word (no gaps).'};
    }
  } else {
    const col = cols[0];
    const minR = Math.min(...pending.map(p => p.row));
    const maxR = Math.max(...pending.map(p => p.row));
    for (let r = minR; r <= maxR; r++) {
      const inPending = pending.some(p => p.row === r && p.col === col);
      const onBoard   = state.board[r][col] !== null;
      if (!inPending && !onBoard)
        return {valid:false, error:'Tiles must form a continuous word (no gaps).'};
    }
  }

  // Connectivity
  if (state.isFirstMove) {
    if (!pending.some(p => p.row === 7 && p.col === 7))
      return {valid:false, error:'The first word must cover the center square (★).'};
    // (single-tile first moves are rejected above, so pending.length >= 2)
  } else {
    const usesExisting = pending.some(p => isAdjacentToExisting(p.row, p.col));
    const spansExisting = (() => {
      if (dir === 'H') {
        const row = rows[0];
        const minC = Math.min(...pending.map(p => p.col));
        const maxC = Math.max(...pending.map(p => p.col));
        for (let c = minC; c <= maxC; c++) {
          if (state.board[row][c] !== null) return true;
        }
      } else {
        const col = cols[0];
        const minR = Math.min(...pending.map(p => p.row));
        const maxR = Math.max(...pending.map(p => p.row));
        for (let r = minR; r <= maxR; r++) {
          if (state.board[r][col] !== null) return true;
        }
      }
      return false;
    })();
    if (!usesExisting && !spansExisting)
      return {valid:false, error:'Word must connect to a tile already on the board.'};
  }

  // Collect all formed words and validate them
  const isHorizMove = (dir === 'H');
  const formedWords = collectFormedWords(pending, isHorizMove);

  for (const {word} of formedWords) {
    if (!state.wordSet.has(word.toLowerCase())) {
      return {valid:false, error:`"${word.toUpperCase()}" is not a valid word.`};
    }
  }

  return {valid:true, dir:isHorizMove, formedWords};
}

// ============================================================
// WORD UTILITIES
// ============================================================

function isAdjacentToExisting(r, c) {
  return (r > 0  && state.board[r-1][c] !== null) ||
         (r < 14 && state.board[r+1][c] !== null) ||
         (c > 0  && state.board[r][c-1] !== null) ||
         (c < 14 && state.board[r][c+1] !== null);
}

// Get the letter at (r,c) considering board + pending placements
function effectiveLetter(r, c, pending) {
  const p = pending ? pending.find(x => x.row === r && x.col === c) : null;
  if (p) return p.displayLetter || p.letter;
  const cell = state.board[r][c];
  return cell ? (cell.displayLetter || cell.letter) : null;
}

// Get word string at (r,c) in a direction (considering pending)
function getWordAt(r, c, isHoriz, pending) {
  let start = isHoriz ? c : r;
  const fixed = isHoriz ? r : c;
  while (start > 0) {
    const prev = isHoriz ? effectiveLetter(fixed, start-1, pending)
                         : effectiveLetter(start-1, fixed, pending);
    if (!prev) break;
    start--;
  }
  let word = '';
  let pos = start;
  while (pos < 15) {
    const ch = isHoriz ? effectiveLetter(fixed, pos, pending)
                       : effectiveLetter(pos, fixed, pending);
    if (!ch) break;
    word += ch;
    pos++;
  }
  return word;
}

// Collect all words formed by the pending placements
function collectFormedWords(pending, isHorizMove) {
  const words = [];

  // Main word
  const row0 = isHorizMove ? pending[0].row : Math.min(...pending.map(p=>p.row));
  const col0 = isHorizMove ? Math.min(...pending.map(p=>p.col)) : pending[0].col;
  const mainStr = getWordAt(row0, col0, isHorizMove, pending);
  if (mainStr.length >= 2) words.push({word: mainStr});

  // Cross-words: for each newly placed tile, check perpendicular word
  for (const p of pending) {
    const crossStr = getWordAt(p.row, p.col, !isHorizMove, pending);
    if (crossStr.length >= 2) words.push({word: crossStr});
  }

  return words;
}

// ============================================================
// SCORING
// ============================================================

function letterVal(letter, isBlank) {
  if (isBlank) return 0;
  return LETTER_VALUES[letter.toUpperCase()] || 0;
}

// Score a word defined by its cells, given a set of new tile positions
function scoreWord(r0, c0, isHoriz, pendingArg) {
  const pendingMap = new Map((pendingArg||[]).map(p => [`${p.row},${p.col}`, p]));

  const getCell = (r, c) => {
    const k = `${r},${c}`;
    if (pendingMap.has(k)) {
      const p = pendingMap.get(k);
      return {letter: p.letter, isBlank: p.isBlank, isNew: true};
    }
    const b = state.board[r][c];
    return b ? {letter: b.letter, isBlank: b.isBlank, isNew: false} : null;
  };

  // Find start
  let start = isHoriz ? c0 : r0;
  const fixed = isHoriz ? r0 : c0;
  while (start > 0) {
    const cell = isHoriz ? getCell(fixed, start-1) : getCell(start-1, fixed);
    if (!cell) break;
    start--;
  }

  let score = 0, wMult = 1;
  let pos = start;
  while (pos < 15) {
    const cell = isHoriz ? getCell(fixed, pos) : getCell(pos, fixed);
    if (!cell) break;
    const [cr, cc] = isHoriz ? [fixed, pos] : [pos, fixed];
    const bonus = cell.isNew ? BONUS_MAP[cr][cc] : null;
    let lv = letterVal(cell.letter, cell.isBlank);
    if (bonus === 'TL') lv *= 3;
    else if (bonus === 'DL') lv *= 2;
    score += lv;
    if (bonus === 'TW') wMult *= 3;
    else if (bonus === 'DW') wMult *= 2;
    pos++;
  }
  return score * wMult;
}

function scorePlacement(pending, isHorizMove) {
  let total = 0;

  // Main word score
  const r0 = isHorizMove ? pending[0].row : Math.min(...pending.map(p=>p.row));
  const c0 = isHorizMove ? Math.min(...pending.map(p=>p.col)) : pending[0].col;
  total += scoreWord(r0, c0, isHorizMove, pending);

  // Cross-words
  for (const p of pending) {
    const crossIsHoriz = !isHorizMove;
    // Does a cross-word exist here?
    const crossWord = getWordAt(p.row, p.col, crossIsHoriz, pending);
    if (crossWord.length >= 2) {
      total += scoreWord(p.row, p.col, crossIsHoriz, pending);
    }
  }

  // Bingo: use all 7 tiles
  if (pending.length === 7) total += 50;

  return total;
}

// ============================================================
// SCORE BUBBLE
// ============================================================

// Return the empty cell that is the best place to float the score bubble.
// Criteria (in order): adjacent to a pending tile, not on top of a tile,
// fewest occupied neighbours.
function bestBubbleCell() {
  const pending = state.pending;
  const pendingSet = new Set(pending.map(p => `${p.row},${p.col}`));
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]];

  function occupied(r, c) {
    if (r < 0 || r >= 15 || c < 0 || c >= 15) return true;
    return state.board[r][c] !== null || pendingSet.has(`${r},${c}`);
  }

  // Centroid of pending tiles — used to break ties in favour of the cell
  // nearest the middle of the word rather than an endpoint.
  const cr = pending.reduce((s, p) => s + p.row, 0) / pending.length;
  const cc = pending.reduce((s, p) => s + p.col, 0) / pending.length;

  let best = null;
  let bestScore = Infinity;

  for (const p of pending) {
    for (const [dr, dc] of dirs) {
      const r = p.row + dr;
      const c = p.col + dc;
      if (occupied(r, c)) continue;           // must be empty (criterion B)
      const n = dirs.filter(([dr2,dc2]) => occupied(r+dr2, c+dc2)).length;
      const dist = Math.abs(r - cr) + Math.abs(c - cc);
      const score = n * 100 + dist;           // fewest neighbours first, then closest to centroid
      if (score < bestScore) {
        bestScore = score;
        best = { row: r, col: c };
      }
    }
  }

  // Fallback: last placed tile (bubble overlaps it, but better than nothing).
  return best ?? pending[pending.length - 1];
}

function updateScoreBubble() {
  const bubble = scoreBubbleEl;
  const pending = state.pending;

  if (!pending.length) {
    bubble.classList.add('hidden');
    return;
  }

  const result = validatePlayerMove();
  if (!result.valid) {
    bubble.classList.add('hidden');
    return;
  }

  const score = scorePlacement(pending, result.dir);

  const target = bestBubbleCell();
  const cellEl = getCellEl(target.row, target.col);
  const rect = cellEl.getBoundingClientRect();
  // Position relative to the board container (the bubble's offset parent)
  // so the bubble tracks the board when the page scrolls.
  const contRect = document.getElementById('board-container').getBoundingClientRect();

  bubble.textContent = `+${score}`;
  bubble.style.left = (rect.left - contRect.left + rect.width  / 2) + 'px';
  bubble.style.top  = (rect.top  - contRect.top  + rect.height / 2) + 'px';

  // Re-trigger pop animation on each update.
  bubble.classList.add('hidden');
  bubble.offsetWidth; // force reflow
  bubble.classList.remove('hidden');
}

// ============================================================
// PLAYER TURN
// ============================================================

function submitPlayerMove() {
  if (!state.playerTurnActive || state.gameOver) return;

  if (state.pending.length === 0) {
    document.getElementById('pass-overlay').classList.remove('hidden');
    return;
  }

  const result = validatePlayerMove();
  if (!result.valid) {
    showMoveError(result.error);
    return;
  }

  const score = scorePlacement(state.pending, result.dir);
  state.playerScore += score;

  // Commit tiles to board
  state.lastPlay = new Set();
  for (const p of state.pending) {
    state.board[p.row][p.col] = { letter: p.letter, isBlank: p.isBlank, displayLetter: p.displayLetter || p.letter };
    state.lastPlay.add(`${p.row},${p.col}`);
  }

  const wordNames = result.formedWords.map(w => w.word.toUpperCase()).join(', ');
  logEntry(`You: ${wordNames} (+${score})`, 'player');
  state.pending = [];
  state.isFirstMove = false;
  state.consecutivePasses = 0;

  drawTiles(state.playerRack, 7 - state.playerRack.length);
  renderBoard();
  renderRack();
  renderScores();
  updateBagCount();
  updateScoreBubble();

  if (checkGameOver()) return;

  enablePlayerControls(false);
  state.turn = 'computer';
  setTimeout(computerTurn, 300);
}

function passPlayerTurn() {
  if (!state.playerTurnActive || state.gameOver) return;
  recallAllTiles();
  state.consecutivePasses++;
  logEntry('You: passed', 'player');
  if (checkGameOver()) return;
  enablePlayerControls(false);
  state.turn = 'computer';
  setTimeout(computerTurn, 300);
}

async function lifelineTurn() {
  if (!state.playerTurnActive || state.gameOver || state.lifelineUsed) return;
  state.lifelineUsed = true;
  document.getElementById('btn-lifeline').disabled = true;
  recallAllTiles();
  enablePlayerControls(false);
  const gameId = state.gameId;

  const t0 = performance.now();
  const move = await findBestMove(state.playerRack);
  const ms = Math.round(performance.now() - t0);

  // A new game may have started while the move search yielded to the UI.
  if (gameId !== state.gameId) return;

  if (!move) {
    state.consecutivePasses++;
    logEntry(`You: passed in ${ms}ms [lifeline]`, 'player');
    if (checkGameOver()) return;
  } else if (move.exchange) {
    executeExchange(state.playerRack, move.tiles);
    state.consecutivePasses++;
    logEntry(`You: exchanged ${exchangedLetters(move.tiles)} in ${ms}ms [lifeline]`, 'player');
    renderRack();
    updateBagCount();
    if (checkGameOver()) return;
  } else {
    state.lastPlay = new Set();
    for (const p of move.placements) {
      state.board[p.row][p.col] = { letter: p.letter, isBlank: p.isBlank, displayLetter: p.letter };
      state.lastPlay.add(`${p.row},${p.col}`);
    }
    state.playerScore += move.score;
    state.consecutivePasses = 0;
    state.isFirstMove = false;
    for (const p of move.placements) {
      const idx = state.playerRack.findIndex(t =>
        p.isBlank ? t.isBlank : (t.letter.toLowerCase() === p.letter.toLowerCase() && !t.isBlank)
      );
      if (idx !== -1) state.playerRack.splice(idx, 1);
    }
    drawTiles(state.playerRack, 7 - state.playerRack.length);
    logEntry(`You: ${move.word.toUpperCase()} (+${move.score}) in ${ms}ms [lifeline]`, 'player');
    renderRack();
    renderBoard();
    renderScores();
    updateBagCount();
    if (checkGameOver()) return;
  }

  state.turn = 'computer';
  setTimeout(computerTurn, 300);
}

// ============================================================
// COMPUTER TURN
// ============================================================

async function computerTurn() {
  // Bail if a new game started before this (scheduled) turn began.
  if (state.turn !== 'computer' || state.gameOver) return;
  const gameId = state.gameId;
  await yieldToUI();

  const t0 = performance.now();
  const move = await findBestMove(state.computerRack);
  const ms = Math.round(performance.now() - t0);

  // The move search yields to the UI, so a new game may have started
  // mid-search — discard the stale move instead of committing it.
  if (gameId !== state.gameId) return;

  if (!move) {
    state.consecutivePasses++;
    logEntry(`Computer: passed in ${ms}ms`, 'computer');
  } else if (move.exchange) {
    executeExchange(state.computerRack, move.tiles);
    state.consecutivePasses++;
    const k = move.tiles.length;
    logEntry(`Computer: exchanged ${k} tile${k > 1 ? 's' : ''} in ${ms}ms`, 'computer');
  } else {
    state.lastPlay = new Set();
    for (const p of move.placements) {
      state.board[p.row][p.col] = {
        letter: p.letter,
        isBlank: p.isBlank,
        displayLetter: p.letter
      };
      state.lastPlay.add(`${p.row},${p.col}`);
    }
    state.computerScore += move.score;
    state.consecutivePasses = 0;
    state.isFirstMove = false;
    // Remove played tiles from the computer's rack before drawing replacements
    for (const p of move.placements) {
      const idx = state.computerRack.findIndex(t =>
        p.isBlank ? t.isBlank : (t.letter.toLowerCase() === p.letter.toLowerCase() && !t.isBlank)
      );
      if (idx !== -1) state.computerRack.splice(idx, 1);
    }
    drawTiles(state.computerRack, 7 - state.computerRack.length);

    const wordStr = move.word.toUpperCase();
    logEntry(`Computer: ${wordStr} (+${move.score}) in ${ms}ms`, 'computer');
  }

  renderBoard();
  renderScores();
  updateBagCount();

  if (!checkGameOver()) {
    state.turn = 'player';
    enablePlayerControls(true);
  }
}

function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ============================================================
// DICTIONARY TRIE
// ============================================================

// The dictionary is packed into typed arrays: node n's children are the
// edges childStart[n] .. childStart[n]+childCount[n]-1, each edge holding
// a letter code (0-25) and a target node. This keeps ~400k nodes in a few
// MB and makes traversal allocation-free.
function ensureTrie() {
  if (state.trie && state.trie.wordCount === state.wordSet.size) return;

  const words = [];
  for (const w of state.wordSet) {
    if (w.length <= 15 && /^[a-z]+$/.test(w)) words.push(w);
  }
  words.sort();

  // Sorted insertion reaches nodes in depth-first order, so each node's
  // children are complete — and can be copied to the edge arrays — the
  // moment the insertion path leaves it. No intermediate object trie.
  const terminal = [0], childStart = [0], childCount = [0];
  const edgeChar = [], edgeNode = [];
  const stack = [{ node: 0, kids: [] }]; // kids: flat [code, node, ...]
  const finalize = f => {
    childStart[f.node] = edgeChar.length;
    childCount[f.node] = f.kids.length / 2;
    for (let k = 0; k < f.kids.length; k += 2) {
      edgeChar.push(f.kids[k]);
      edgeNode.push(f.kids[k + 1]);
    }
  };
  let prev = '';
  for (const w of words) {
    let common = 0;
    while (common < prev.length && common < w.length &&
           w.charCodeAt(common) === prev.charCodeAt(common)) common++;
    while (stack.length - 1 > common) finalize(stack.pop());
    for (let i = common; i < w.length; i++) {
      terminal.push(0); childStart.push(0); childCount.push(0);
      const n = terminal.length - 1;
      stack[stack.length - 1].kids.push(w.charCodeAt(i) - 97, n);
      stack.push({ node: n, kids: [] });
    }
    terminal[stack[stack.length - 1].node] = 1;
    prev = w;
  }
  while (stack.length > 0) finalize(stack.pop());

  state.trie = {
    terminal: Uint8Array.from(terminal),
    childStart: Int32Array.from(childStart),
    childCount: Uint8Array.from(childCount),
    edgeChar: Uint8Array.from(edgeChar),
    edgeNode: Int32Array.from(edgeNode),
    wordCount: state.wordSet.size,
  };
}

function trieChild(trie, node, code) {
  let i = trie.childStart[node];
  const end = i + trie.childCount[node];
  for (; i < end; i++) {
    if (trie.edgeChar[i] === code) return trie.edgeNode[i];
  }
  return -1;
}

const ALL_LETTERS_MASK = (1 << 26) - 1;

// Cross-check data for empty cell (r, c) at line position i: a bitmask of
// letters forming a valid perpendicular word, the value sum of the
// perpendicular tiles (for incremental scoring), and whether any
// perpendicular neighbor exists at all. Letter validity is resolved by
// walking the trie instead of building candidate strings.
function computeCrossData(r, c, moveIsHoriz, i, maskArr, sumArr, hasArr) {
  const pre = [], suf = [];
  let sum = 0;
  const take = (cell, arr) => {
    arr.push(cell.letter.toLowerCase().charCodeAt(0) - 97);
    sum += cell.isBlank ? 0 : (LETTER_VALUES[cell.letter.toUpperCase()] || 0);
  };
  if (moveIsHoriz) {
    let k = r;
    while (k > 0 && state.board[k - 1][c]) k--;
    for (; k < r; k++) take(state.board[k][c], pre);
    for (k = r + 1; k < 15 && state.board[k][c]; k++) take(state.board[k][c], suf);
  } else {
    let k = c;
    while (k > 0 && state.board[r][k - 1]) k--;
    for (; k < c; k++) take(state.board[r][k], pre);
    for (k = c + 1; k < 15 && state.board[r][k]; k++) take(state.board[r][k], suf);
  }
  if (pre.length === 0 && suf.length === 0) return; // defaults: ALL mask, no cross

  hasArr[i] = 1;
  sumArr[i] = sum;
  const trie = state.trie;
  let node = 0;
  for (const code of pre) {
    node = trieChild(trie, node, code);
    if (node === -1) { maskArr[i] = 0; return; }
  }
  let mask = 0;
  const s = trie.childStart[node], e = s + trie.childCount[node];
  outer: for (let k = s; k < e; k++) {
    let n = trie.edgeNode[k];
    for (const code of suf) {
      n = trieChild(trie, n, code);
      if (n === -1) continue outer;
    }
    if (trie.terminal[n] === 1) mask |= 1 << trie.edgeChar[k];
  }
  maskArr[i] = mask;
}

// ============================================================
// LEAVE EVALUATION
// ============================================================

// The leave model is linear in per-letter counts plus all unordered
// letter-pair counts — same-letter pairs encode duplicates, and synergies
// like QU are ordinary pair weights (weights trained by
// tools/train-leaves.js, loaded from leaves.js). For the hot path the
// weights are compiled once into typed arrays indexed by letter code
// (0-25 = A-Z, 26 = blank).
// ---- Superleave table (per-leave equity, 1 byte each) ----------------------
// When a table is loaded it supplies the value for leaves of up to 6 tiles;
// larger count vectors (the sim horizon evaluates full 7-tile racks) and the
// no-table case fall back to the linear model in leaveValueFromCounts. The
// index and codec mirror tools/superleave.js exactly.
const SL_SUPPLY = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1, 2];
const SL_CAP = SL_SUPPLY.map(s => Math.min(6, s));
const SL_G = (() => {
  const g = Array.from({ length: 28 }, () => new Int32Array(7));
  for (let r = 0; r <= 6; r++) g[27][r] = 1;
  for (let i = 26; i >= 0; i--) {
    for (let r = 0; r <= 6; r++) { let s = 0; for (let v = 0; v <= SL_CAP[i] && v <= r; v++) s += g[i + 1][r - v]; g[i][r] = s; }
  }
  return g;
})();
const SL_SCALE = 0.375, SL_ZERO = 128;
// counts (by tile code, blank=26) -> table index, or -1 if the leave holds
// more than 6 tiles (outside the table's domain).
function leaveRank(counts) {
  let idx = 0, R = 6;
  for (let i = 0; i < 27; i++) {
    const c = counts[i];
    if (c > R) return -1;
    for (let v = 0; v < c; v++) idx += SL_G[i + 1][R - v];
    R -= c;
  }
  return idx;
}
let superTable = null; // Uint8Array of one equity byte per leave, or null
function installSuperTable(t) { superTable = t; }

// ---- Table assembly from sparse feature weights ---------------------------
// The weights asset (rank:value pairs for every trained feature, ~20-130 KB
// gzipped depending on model order) is far smaller than the prebuilt table
// (~790 KB), so the client downloads weights and assembles the table
// locally. The assembly mirrors tools/leave-td.js export exactly — same
// feature evaluation, same 1-byte codec — so a locally built table is
// byte-identical to an exported one.
const SL_BINOM = (() => {
  const B = [];
  for (let n = 0; n <= 7; n++) { B[n] = []; for (let k = 0; k <= 7; k++) B[n][k] = k > n ? 0 : (k === 0 ? 1 : B[n - 1][k - 1] + B[n - 1][k]); }
  return B;
})();
let SL_WBUF = null;                    // dense weights during a build
// Value every leave in [from, to) and write its codec byte. The feature
// recursion visits tile types in leaveRank's canonical order and
// accumulates the feature rank incrementally (choosing s copies of type t
// with budget fR adds sum_{v<s} SL_G[t+1][fR-v]). Leaves hold <= 6 tiles,
// so every sub-multiset is within the feature domain; the empty sub-leaf
// contributes w[0], which no trainer ever writes, so it adds 0. The
// accumulator adds features linearly in emission order — the same float
// addition order as the exporter's valueFromFeatures — so the assembled
// table is byte-identical to an exported one.
function fillSuperTableRange(table, from, to) {
  const w = SL_WBUF, G = SL_G, B = SL_BINOM, cap = SL_CAP;
  const counts = new Int32Array(27), present = new Int32Array(7);
  let val = 0;
  function visit(pi, np, mult, fidx, fR) {
    if (pi === np) { val += mult * w[fidx]; return; }
    const t = present[pi], c = counts[t];
    for (let s = 0, add = 0; s <= c; s++) {
      visit(pi + 1, np, mult * B[c][s], fidx + add, fR - s);
      add += G[t + 1][fR - s];
    }
  }
  for (let rank = from; rank < to; rank++) {
    let idx = rank, R = 6, np = 0;   // unrank into counts
    for (let i = 0; i < 27; i++) {
      let v = 0;
      while (v <= cap[i] && v <= R && idx >= G[i + 1][R - v]) { idx -= G[i + 1][R - v]; v++; }
      counts[i] = v; if (v > 0) present[np++] = i;
      R -= v;
    }
    val = 0;
    visit(0, np, 1, 0, 6);
    const b = Math.round(val / SL_SCALE) + SL_ZERO;
    table[rank] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}
function parseSuperWeights(str) {
  const w = new Float64Array(SL_G[0][6]);
  for (const part of str.split(',')) {
    const c = part.indexOf(':');
    w[+part.slice(0, c)] = +part.slice(c + 1);
  }
  return w;
}
// Synchronous build (match harness, tests).
function buildSuperTableFromWeights(str) {
  SL_WBUF = parseSuperWeights(str);
  const table = new Uint8Array(SL_G[0][6]);
  fillSuperTableRange(table, 0, table.length);
  SL_WBUF = null;
  return table;
}
// Browser build: same bytes, produced in chunks that yield to the event
// loop so the UI stays responsive during the ~1-2s assembly.
async function installSuperWeights(str) {
  SL_WBUF = parseSuperWeights(str);
  const size = SL_G[0][6];
  const table = new Uint8Array(size);
  for (let from = 0; from < size; from += 65536) {
    fillSuperTableRange(table, from, Math.min(size, from + 65536));
    await new Promise(r => setTimeout(r, 0));
  }
  SL_WBUF = null;
  installSuperTable(table);
}

// Headless-only override: an online-learning driver can install a live
// leave-value function so the move-search policy uses the weights it is
// currently learning. null in the browser/production build (no effect).
let leaveHook = null;
function installLeaveHook(f) { leaveHook = f; }

// Headless-only: uniform +/- exploration noise added to each candidate's
// evaluation, so a greedy policy occasionally takes a near-tie alternative
// and visits a wider set of leaves. 0 in production (deterministic play).
// The noise is drawn per decision from seededRng(positionHash ^ seed) —
// the same scheme the simulation uses for its sample worlds — so runs are
// reproducible from their seed and stay so under any change to candidate
// enumeration order (no advancing global stream to knock out of sync).
let evalDither = 0;
let evalDitherSeed = 0;
function installEvalDither(d, seed) {
  evalDither = d;
  evalDitherSeed = seed === undefined ? 1 : seed >>> 0;
}

// Bag-aware leave: value a leave by the expectation of leaveValue over the
// next tile drawn from the unseen pool, rather than the bag-blind table
// value. Treats the leave evaluator as a black box, so it works with the
// linear model or a superleave table. On by default: over 1000 mirrored
// static-play games it won 525-474 (52.6% of decided games) at +1.2 pts/game
// versus the bag-blind table, with no measured downside. Uses only public
// info (the unseen pool inferred from the board and our rack, not the real
// bag), so it is legal to run in production.
let bagAwareLeave = true;
function installBagAwareLeave(on) { bagAwareLeave = !!on; }

// Full tile distribution by letter code, built lazily (TILE_DATA counts).
let FULL_DIST = null;
function ensureFullDist() {
  if (FULL_DIST) return;
  FULL_DIST = new Int32Array(27);
  for (const [ch, [count]] of Object.entries(TILE_DATA)) {
    FULL_DIST[ch === '?' ? 26 : ch.charCodeAt(0) - 65] = count;
  }
}

// Fetch and inflate the gzipped superleave table (browser). Best-effort:
// on any failure the engine simply keeps using the linear model.
async function loadSuperTable() {
  if (typeof DecompressionStream !== 'function' || typeof fetch !== 'function') return;
  if (!IS_FILE_URL) {
    try {
      // Sparse feature weights (~21 KB); the table is assembled locally,
      // byte-identical to a tools/leave-td.js export.
      const wr = await fetch('leaves-w.txt.gz');
      if (wr.ok) {
        const stream = wr.body.pipeThrough(new DecompressionStream('gzip'));
        await installSuperWeights(await new Response(stream).text());
        return;
      }
    } catch (e) { /* fall through to the embedded copy */ }
  }
  // file:// (or the fetch failed) — embedded-script fallback. On any
  // failure: greedy, leave-blind play.
  try {
    const resp = await loadEmbeddedGz('leaves.data.js', 'LEAVES_W_B64');
    await installSuperWeights(await resp.text());
  } catch (e) { /* no weights: greedy, leave-blind play */ }
}

let leaveTables = null;

// True when any leave evaluator is available: the online-learning hook, a
// superleave table, or the linear model. Gates that enable leave-aware
// behavior (static scan, exchanges, sim horizon) check this rather than
// the linear tables specifically, so a table-only build plays leave-aware
// without leaves.js — leaveValueFromCounts routes to whatever is loaded.
function leaveModelReady() {
  return leaveHook !== null || superTable !== null || leaveTables !== null;
}

function ensureLeaveTables() {
  const W = (typeof LEAVE_WEIGHTS !== 'undefined' && LEAVE_WEIGHTS) ? LEAVE_WEIGHTS : null;
  if (!W) { leaveTables = null; return; }
  if (leaveTables && leaveTables.src === W) return;
  const codeOf = ch => ch === '?' ? 26 : ch.charCodeAt(0) - 65;
  const letterW = new Float64Array(27);
  for (const [ch, v] of Object.entries(W.letter || {})) letterW[codeOf(ch)] = v;
  const pairW = new Float64Array(27 * 27);
  for (const [key, v] of Object.entries(W.pair || {})) {
    const a = codeOf(key[0]), b = codeOf(key[1]);
    pairW[Math.min(a, b) * 27 + Math.max(a, b)] = v;
  }
  leaveTables = { src: W, letterW, pairW };
}

// Letter codes in the iteration order of the previous implementation
// (kept letters sorted as characters, where '?' sorts before 'A') — the
// float additions must happen in the same order to stay bit-identical.
const LEAVE_CHAR_ORDER = Int32Array.from([26].concat(Array.from({ length: 26 }, (_, i) => i)));

// Scratch for the present-letter codes: leaveValueFromCounts is on the
// hot path (thousands of calls per decision), so it must not allocate.
const LEAVE_PRESENT_SCRATCH = new Int32Array(27);

// Value of the kept tiles given their counts by letter code.
function leaveValueFromCounts(counts) {
  if (leaveHook) return leaveHook(counts);
  if (superTable) {
    const r = leaveRank(counts); // -1 for >6 tiles
    if (r >= 0) return (superTable[r] - SL_ZERO) * SL_SCALE;
    // 7-tile vectors (sim-horizon racks; 6-tile leaves completed by a
    // projected draw): drop-one mean over the table. Exact identity: the
    // mean of the 7 leave-one-out 6-subsets equals the feature value with
    // order-s terms scaled by (1 - s/7) — every order the table learned,
    // mildly damped, in the table's own currency. Richer than the linear
    // fallback, which keeps only orders 1-2 at leaves.js quality.
    let total = 0;
    for (let i = 0; i < 27; i++) total += counts[i];
    if (total === 7) {
      let sum = 0;
      for (let i = 0; i < 27; i++) {
        const c = counts[i];
        if (c === 0) continue;
        counts[i] = c - 1;
        sum += c * (superTable[leaveRank(counts)] - SL_ZERO) * SL_SCALE;
        counts[i] = c;
      }
      return sum / 7;
    }
  }
  const t = leaveTables;
  if (!t) return 0;
  const present = LEAVE_PRESENT_SCRATCH;
  let np = 0;
  for (let k = 0; k < 27; k++) {
    const code = LEAVE_CHAR_ORDER[k];
    if (counts[code] > 0) present[np++] = code;
  }
  let val = 0;
  for (let a = 0; a < np; a++) {
    const c1 = present[a], n1 = counts[c1];
    val += t.letterW[c1] * n1;
    if (n1 >= 2) val += t.pairW[c1 * 27 + c1] * (n1 * (n1 - 1) / 2);
    for (let b = a + 1; b < np; b++) {
      const c2 = present[b];
      val += t.pairW[(c1 < c2 ? c1 : c2) * 27 + (c1 < c2 ? c2 : c1)] * n1 * counts[c2];
    }
  }
  return val;
}

// Bag-aware leave value: E[ leaveValue(leave + one drawn tile) ] over the
// unseen pool. `counts` is the leave (mutated in place and restored); the
// pool is fixed for the turn. Model-agnostic — leaveValueFromCounts routes
// to whichever evaluator is installed. For a 6-tile leave the drawn
// completion is 7 tiles: with a superleave table loaded those use the
// drop-one mean over the table (see leaveValueFromCounts); without one
// they fall back to the linear model.
function bagAwareLeaveValue(counts, unseen, total) {
  let ev = 0;
  for (let t = 0; t < 27; t++) {
    const u = unseen[t];
    if (u <= 0) continue;
    counts[t]++;
    ev += u * leaveValueFromCounts(counts);
    counts[t]--;
  }
  return ev / total;
}

// ============================================================
// ENDGAME SEARCH (empty bag)
// ============================================================

// With the bag empty the endgame is perfect-information: the opponent's
// rack is exactly the unseen tiles, so it can be derived from the full
// tile distribution minus the board and our own rack.
function deriveOpponentRack(ownRack) {
  const remaining = {};
  for (const [letter, [count]] of Object.entries(TILE_DATA)) remaining[letter] = count;
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = state.board[r][c];
      if (cell) remaining[cell.isBlank ? '?' : cell.letter.toUpperCase()]--;
    }
  }
  for (const t of ownRack) remaining[t.isBlank ? '?' : t.letter.toUpperCase()]--;
  const opp = [];
  for (const [k, n] of Object.entries(remaining)) {
    for (let i = 0; i < n; i++) opp.push({ letter: k, isBlank: k === '?' });
  }
  return opp;
}

// ============================================================
// PER-STAGE MOVE SELECTION
// ============================================================
// The game splits into three stages by bag count, and each stage's config
// decides how its moves are chosen:
//   bag >= LOWBAG_AT ...... midgame  (deep-bag simulation, 2-ply horizon)
//   0 < bag < LOWBAG_AT ... lowbag   (simulation, worlds played to terminal)
//   bag == 0 ............... endgame  (exact adversarial search)
// `static: true` on any stage skips its lookahead and plays the static move
// generator there. The two simulation stages share SIM_BASE and override only
// what differs, so shared knobs stay in one place.
let LOWBAG_AT = 8; // tunable: bag < this (and > 0) is the lowbag stage

const SIM_BASE = {
  static: false,
  candidates: 5,    // max static candidates (top-K) evaluated by simulation
  // margin prunes that top-K set: a move more than this many static move+leave
  // points behind the best is dropped (it can't be genuinely overruled into,
  // so simulating it only wastes reply searches and risks a noise overrule).
  // 0 = no pruning. Measured: across ~3800 midgame positions the deepest move
  // a simulation could genuinely overrule the static best into sat 10 back.
  margin: 10,
  samples: 30,      // sampled worlds, shared across candidates
  confidence: 1.5,  // paired z threshold to overrule the static choice
  minWorlds: 6,     // worlds evaluated before pruning may trigger
  pruneEvery: 2,    // prune check cadence (in worlds) after the minimum
  // Bayesian overrule (alternative to the confidence gate). Models the true
  // value gap of a challenger vs the incumbent as mu ~ Normal(dStatic, tau^2)
  // — the static move+leave gap is the prior mean, priorSd is the prior SD (in
  // points) — updates with the sampled paired differences, and overrules iff
  // the posterior P(mu > 0) exceeds overruleP. Off by default.
  bayes: 0,         // 1 enables the Bayesian decision in place of the gate
  priorSd: 12,      // tau: prior SD (points) of the true gap around dStatic
  overruleP: 0.9,   // posterior P(challenger better) needed to overrule
  varFloor: 1,      // floor on the per-world variance estimate (points^2)
};

// Move-selection policy keyed by bag state — how many tiles remain in the bag —
// rather than by stage names. Each key names the bag counts it governs; stageFor
// maps a bag count to its key. Boundaries: bag7 is 7 (LOWBAG_AT-1) and
// bagGt7 is LOWBAG_AT+ (LOWBAG_AT defaults to 8).
const STAGES = {
  // bag0: exact adversarial endgame search over perfect information. The solver
  // reads this directly. movegenBudget is move generations per decision; root
  // moves are evaluated best-first and the search keeps the best fully-evaluated
  // move when it is hit, bounding worst-case time without a hard gate. Sized to
  // a ~1s p99 endgame move time (p99 992ms at 900 vs 685ms at 600); crowded
  // opening endgames need far more and stay capped. nodeMoves = moves per node.
  bag0: { static: false, movegenBudget: 900, nodeMoves: 8 },
  // bag1: near-perfect information. The unseen pool splits into only ~8
  // (opponent rack | bag) worlds, so enumerate them all exactly (enumerate:true)
  // rather than sample — each candidate's mean over the 8 equally-likely worlds
  // is its exact expected value under the rollout, with no sampling variance and
  // no confidence gate needed (confidence 0 = pick the argmax). Over 518 exact
  // bag=1 solves: mean regret vs the endgame solver 1.82 pts (static 4.65), 64%
  // optimal (static 48%), p99 ~1.1s — the quality ceiling reachable under ~1s
  // with a greedy rollout (the last ~1.8 pts needs the exact solver at
  // 15-43s/move).
  bag1: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: true, candidates: 8, margin: 0, confidence: 0, scoreAware: 0 },
  // bag2: still near-perfect info, but the unseen pool now splits into C(9,2)=36
  // worlds — too many to enumerate all of within ~1s (full enumeration p99 ~3s).
  // Instead sample 10 of the 36 worlds and pick the argmax expected value under
  // the greedy rollout (confidence 0). A few crowded-board positions have
  // intrinsically slow rollouts, so the tail is bounded by the world count, not
  // a node cap (truncation doesn't help when per-node cost is high). Over 105
  // exact bag=2 solves: mean regret vs the endgame solver 1.43 pts (static 4.20),
  // 66% optimal (static 54%), p99 ~850ms. More worlds cut regret (24 -> 0.91)
  // but push p99 past 1s; 10 is the most that fits the budget.
  bag2: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 10, candidates: 6, margin: 0, confidence: 0, scoreAware: 0 },
  // bag3: the unseen pool splits into C(10,3)=120 worlds — far too many to
  // enumerate within ~1s (full enumeration runs p99 ~7s). Sample 10 of them over
  // 5 candidates and pick the argmax under the greedy rollout (confidence 0).
  // This holds the ~10-world budget shared with bag2/bag4 while candidates step
  // down 6->5->4 across bag2->3->4 as the best-move mass concentrates. Scored
  // against an approximate oracle (greedy rollout over all 120 worlds — bag=3 is
  // too deep to solve exactly): over 205 positions mean regret 2.30 pts (static
  // 7.41), 61% optimal (static 40%), p99 ~990ms. (C=6/S=6 was 2.55; C=4 is worse
  // here — unlike bag4 — because bag3's best move often sits at rank 5.)
  bag3: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 10, candidates: 5, margin: 0, confidence: 0, scoreAware: 0 },
  // bag4: C(11,4)=330 worlds. With the ~1s budget stretched this thin, world
  // coverage — not candidate count — is the bottleneck, so the budget-optimal
  // split is FEWER candidates and MORE worlds: sample 10 worlds over only 4
  // candidates (the best move almost always sits in the top 4 here). Scored
  // against a 60-world greedy-sample oracle (bag=4 is too deep to enumerate all
  // 330) over 202 positions: the noisy absolute regret is 3.63 (static 5.52),
  // but the trustworthy paired gap is +1.89 pts of picked-move value vs static
  // at p99 ~900ms. C=6/S=6 recovers only +1.13 at the same budget; C=4/S=10 is
  // the frontier optimum (C=3 starts missing rank-4 best moves).
  bag4: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 10, candidates: 4, margin: 0, confidence: 0, scoreAware: 0 },
  // bag5: C(12,5)=792 worlds. Same starved-budget regime as bag4 — reuse the
  // 10-world / 4-candidate split (regret 4.30 vs a 100-world greedy-sample
  // oracle over 224 positions, paired gap +1.16 pts vs static, p99 ~830ms). The
  // frontier nominal best was C=3/S=16 (+1.24) but within noise of this; holding
  // the shared 10-world budget keeps the band consistent with bag4. NOTE: the
  // naive C=6/S=6 is actually WORSE than static here (winner's curse on 6 noisy
  // worlds), and the gap-vs-static is against a greedy oracle — treat as tuning,
  // not a strength verdict, pending a win-rate A/B.
  bag5: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 10, candidates: 4, margin: 0, confidence: 0, scoreAware: 0 },
  // bag6: C(13,6)=1716 worlds. The board is wide open, so the best move is almost
  // always one of the top 2 — the budget-optimal split drops to just 2
  // candidates over 10 worlds. Against a sim:50:8 (50-world) greedy oracle over
  // 223 positions: paired gap +1.77 pts of picked-move value vs static, p99
  // ~650ms (well under budget). C=2 beats C=3/4 here (+1.4-1.6); the naive
  // C=6/S=6 recovers only +0.56. As with bag4/5 this is a greedy-oracle tuning
  // result, not a strength verdict — pending a win-rate A/B.
  bag6: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 10, candidates: 2, margin: 0, confidence: 0, scoreAware: 0 },
  // bag7: C(14,7)=3432 worlds and the longest rollouts of any pre-endgame band
  // (a move that doesn't empty the bag plays out through bag 7->0). Sample 8
  // worlds over 2 candidates. Against a sim:50:6 (50-world) greedy oracle over
  // 211 positions: paired gap +0.60 pts vs static, p99 ~1010ms (at the budget
  // line). This is the smallest edge of any band and the greedy oracle is
  // thinnest here (1.5% world coverage) — treat as tuning, not a strength
  // verdict. A 2-ply horizon eval (unlike terminal rollout) does NOT beat static
  // here: it never reaches the endgame where the value lives.
  bag7: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 8, candidates: 2, margin: 0, confidence: 0, scoreAware: 0 },
  // bagGt7 (deep bag): value each world by a 2-ply horizon (score + leave diff).
  bagGt7: { ...SIM_BASE, mode: 'horizon' },
};

// bag length -> stage key.
function stageFor(bagLen) {
  return bagLen === 0 ? 'bag0'
    : bagLen === 1 ? 'bag1'
    : bagLen === 2 ? 'bag2'
    : bagLen === 3 ? 'bag3'
    : bagLen === 4 ? 'bag4'
    : bagLen === 5 ? 'bag5'
    : bagLen === 6 ? 'bag6'
    : bagLen < LOWBAG_AT ? 'bag7'
    : 'bagGt7';
}

// Headless diagnostic: when TRACE.on, findBestSimMove records override stats.
const TRACE = {
  on: 0,
  gaps: [],         // static gap (best - chosen) on each override decision
  overrides: 0,     // count of decisions where simulation overruled arm 0
  maxGap: -1,       // largest override gap seen
  maxPos: null,     // { gap, board, rack, bagCount, ... } for that override
  // Most recent simulated decision (for a driver that escalates sample count
  // until an override is statistically resolved).
  lastOverride: null,
  lastGap: 0,
  lastRank: 0,      // chosen arm index (0 = static best)
  lastZ: 0,         // paired z (mean/se) of chosen vs arm 0: override strength
  lastNArms: 0,     // number of candidate arms considered (margin/count binding)
};

// Thrown by endgameSearch when the movegen budget is exhausted; caught by
// findBestEndgameMove, which then plays the greedy move.
const ENDGAME_ABORT = {};

function rackValueOf(tiles) {
  return tiles.reduce((s, t) => s + letterVal(t.letter, t.isBlank), 0);
}

// All legal moves for a rack on the current board, best score first.
// Ties keep the canonical per-line generation order, so the search stays
// deterministic and mirrored matches stay exact.
function allMovesSorted(rack, budget) {
  budget.used++;
  const moves = [];
  for (let i = 0; i < 15; i++) {
    for (const isHoriz of [true, false]) {
      for (const m of findMovesInLine(i, isHoriz, rack)) moves.push(m);
    }
  }
  return moves
    .map((m, idx) => ({ m, idx }))
    .sort((a, b) => (b.m.score - a.m.score) || (a.idx - b.idx))
    .map(x => x.m);
}

function applyToBoard(placements) {
  for (const p of placements) {
    state.board[p.row][p.col] = { letter: p.letter, isBlank: p.isBlank, displayLetter: p.letter };
  }
}

function removeFromBoard(placements) {
  for (const p of placements) state.board[p.row][p.col] = null;
}

function rackWithout(rack, placements) {
  const out = rack.slice();
  for (const p of placements) {
    const idx = out.findIndex(t =>
      p.isBlank ? t.isBlank : (!t.isBlank && t.letter.toLowerCase() === p.letter.toLowerCase())
    );
    out.splice(idx, 1);
  }
  return out;
}

// Frontier evaluation: play both sides greedily (highest score, the old
// endgame behavior) to the end and return the resulting margin for the
// side holding myRack. This anchors the search to greedy play — it only
// deviates where the searched tree finds something provably better —
// unlike a static both-stuck estimate, which undervalues every line in
// which scoring continues. Mutates the board during the playout and
// restores it before returning.
function greedyRolloutMargin(myRack, oppRack, passes, budget) {
  const racks = [myRack.slice(), oppRack.slice()];
  const applied = [];
  let side = 0, margin = 0, passCount = passes;

  for (;;) {
    const moves = allMovesSorted(racks[side], budget);
    const m = moves.length > 0 && moves[0].score > 0 ? moves[0] : null;
    if (!m) {
      passCount++;
      if (passCount >= 2) {
        margin += rackValueOf(racks[1]) - rackValueOf(racks[0]);
        break;
      }
    } else {
      passCount = 0;
      applyToBoard(m.placements);
      applied.push(m.placements);
      racks[side] = rackWithout(racks[side], m.placements);
      margin += side === 0 ? m.score : -m.score;
      if (racks[side].length === 0) {
        const bonus = 2 * rackValueOf(racks[1 - side]);
        margin += side === 0 ? bonus : -bonus;
        break;
      }
    }
    side = 1 - side;
  }

  for (let i = applied.length - 1; i >= 0; i--) removeFromBoard(applied[i]);
  return margin;
}

// Negamax with alpha-beta over the remaining playout. Returns the best
// achievable margin (side-to-move future points minus opponent future
// points) using the game's real terminal rules: going out banks the
// opponent's rack value twice (endGame credits it to the finisher and
// deducts it from the opponent); two consecutive passes strand both
// racks. Depth and width are budgeted; frontier nodes are valued by
// greedy rollout (budget exhaustion falls back to the both-stuck value).
function endgameSearch(myRack, oppRack, passes, ply, alpha, beta, budget) {
  if (passes >= 2) return rackValueOf(oppRack) - rackValueOf(myRack);
  // Out of budget before this node could be evaluated: abandon the whole
  // search rather than return a distorted value. Returning the pessimistic
  // both-stuck estimate here would systematically overvalue moves whose
  // reply subtree got truncated, and could pick worse than greedy — so we
  // unwind to findBestEndgameMove, which falls back to the greedy move.
  if (budget.used >= STAGES.bag0.movegenBudget) throw ENDGAME_ABORT;
  const plyCap = myRack.length + oppRack.length <= 8 ? 8 : 4;
  if (ply >= plyCap) {
    // Rollouts complete even if they overshoot the budget slightly — a
    // partial rollout would be meaningless — but their true cost counts.
    return greedyRolloutMargin(myRack, oppRack, passes, budget);
  }

  const moves = allMovesSorted(myRack, budget).slice(0, STAGES.bag0.nodeMoves);
  let best = -Infinity;
  for (const m of moves) {
    const newRack = rackWithout(myRack, m.placements);
    let val;
    if (newRack.length === 0) {
      val = m.score + 2 * rackValueOf(oppRack); // going out ends the game
    } else {
      applyToBoard(m.placements);
      val = m.score - endgameSearch(oppRack, newRack, 0, ply + 1, -beta, -Math.max(alpha, best), budget);
      removeFromBoard(m.placements);
    }
    if (val > best) best = val;
    if (best >= beta) return best;
  }

  // Passing is always legal (and occasionally best, e.g. to avoid
  // opening the only out-spot for the opponent).
  const passVal = -endgameSearch(oppRack, myRack, passes + 1, ply + 1, -beta, -Math.max(alpha, best), budget);
  return Math.max(best, passVal);
}

// Static endgame value of a single play, consistent with the search's own
// terminal rules: going out banks twice the opponent's rack (endGame credits
// it to the finisher and deducts it from the opponent), otherwise the kept
// tiles are dead weight deducted from your score at game end. The opponent's
// rack is constant across the move choice, so its value only matters in the
// go-out branch. Used to choose the greedy fallback move when the budget is
// exhausted before any root move is fully searched — ranking by this rather
// than raw score prices the leftover rack the aborted search never got to.
function endgameStaticValue(move, leave, oppRack) {
  if (leave.length === 0) return move.score + 2 * rackValueOf(oppRack);
  return move.score - rackValueOf(leave);
}

// The greedy fallback: the positive-scoring play with the best static
// endgame value, or null (pass) if there is none. Computed only on budget
// abort, so the per-move rackWithout stays off the common path.
function greedyEndgameMove(rack, moves, oppRack) {
  let best = null, bestVal = -Infinity;
  for (const m of moves) {
    if (m.score <= 0) continue;
    const v = endgameStaticValue(m, rackWithout(rack, m.placements), oppRack);
    if (v > bestVal) { bestVal = v; best = m; }
  }
  return best;
}

// Pick the endgame move by search rather than greedy score. Root moves
// are evaluated best-first (by score), each with a complete bounded reply
// search. When the budget runs out mid-move, the incomplete move is
// discarded and the best of the fully-evaluated moves is returned — since
// the highest-scoring move (what greedy plays) is evaluated first, the
// result is always at least as good as greedy, degrading gracefully
// instead of throwing all the work away. Returning null means passing is
// at least as good as every evaluated move.
async function findBestEndgameMove(rack) {
  const oppRack = deriveOpponentRack(rack);
  const budget = { used: 0 };
  const moves = allMovesSorted(rack, budget);
  if (moves.length === 0) return null;

  // The reply search mutates the board and unwinds un-cleanly if it
  // aborts, so snapshot to restore the discarded move's placements.
  const boardSnapshot = state.board.map(r => r.slice());
  let bestMove = null;
  let bestVal = -Infinity;
  for (const m of moves) {
    await yieldToUI();
    const newRack = rackWithout(rack, m.placements);
    let val;
    if (newRack.length === 0) {
      val = m.score + 2 * rackValueOf(oppRack); // going out ends the game
    } else {
      // Root alpha-beta window: the reply search can cut off as soon as
      // it proves this move cannot beat the best value found so far.
      const beta = bestVal === -Infinity ? Infinity : m.score - bestVal;
      applyToBoard(m.placements);
      try {
        val = m.score - endgameSearch(oppRack, newRack, 0, 1, -Infinity, beta, budget);
      } catch (e) {
        if (e !== ENDGAME_ABORT) throw e;
        // Budget exhausted evaluating this move — discard it, keep the
        // best fully-evaluated move so far (>= greedy, since the top-score
        // move was evaluated first). If even the first move did not
        // finish, fall back to the best static-endgame-value move.
        state.board = boardSnapshot;
        return bestMove !== null ? bestMove : greedyEndgameMove(rack, moves, oppRack);
      }
      removeFromBoard(m.placements);
    }
    if (val > bestVal) { bestVal = val; bestMove = m; }
  }

  // All moves searched within budget — also weigh passing.
  try {
    const passBeta = bestVal === -Infinity ? Infinity : -bestVal;
    const passVal = -endgameSearch(oppRack, rack, 1, 1, -Infinity, passBeta, budget);
    if (passVal > bestVal) return null;
  } catch (e) {
    if (e !== ENDGAME_ABORT) throw e;
    state.board = boardSnapshot;
  }
  return bestMove;
}

// ============================================================
// COMPUTER MOVE ENGINE
// ============================================================

// Scan every legal move, reporting each with its static value (score plus
// damped leave value of the kept tiles) to the sink, in the canonical
// deterministic order.
async function scanStaticMoves(rack, onMove) {
  // The kept rack only has a future while there are tiles to draw into —
  // as the bag runs out, selection fades back to raw score.
  const leaveScale = Math.min(1, state.bag.length / 7);
  const useLeave = leaveScale > 0 && leaveModelReady();
  const ditherRng = evalDither ? seededRng(positionHash(rack) ^ evalDitherSeed) : null;
  const rackCounts = new Int32Array(27);
  for (const t of rack) {
    rackCounts[t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65]++;
  }
  // Bag-aware leave: the unseen pool (full distribution minus the board and
  // our own rack) is what we might draw into; it is fixed for the turn, so
  // build it once. This is inferable public info — no need for the real bag.
  let unseenCounts = null, unseenTotal = 0;
  if (useLeave && bagAwareLeave) {
    ensureFullDist();
    unseenCounts = Int32Array.from(FULL_DIST);
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const cell = state.board[r][c];
        if (cell) unseenCounts[cell.isBlank ? 26 : cell.letter.toUpperCase().charCodeAt(0) - 65]--;
      }
    }
    for (let k = 0; k < 27; k++) {
      unseenCounts[k] -= rackCounts[k];
      if (unseenCounts[k] > 0) unseenTotal += unseenCounts[k]; else unseenCounts[k] = 0;
    }
  }
  // Many candidates play the same tiles in different places and share a
  // leave, so leave values are memoized per turn by the multiset of
  // played tiles (canonical sorted-code key).
  const leaveCache = new Map();
  let lastYield = performance.now();

  for (let i = 0; i < 15; i++) {
    // Yield to the UI only when a while has actually passed — an
    // unconditional yield per few lines costs more than the search on
    // fast turns.
    if (performance.now() - lastYield > 12) {
      await yieldToUI();
      lastYield = performance.now();
    }

    for (const isHoriz of [true, false]) {
      const moves = findMovesInLine(i, isHoriz, rack);
      for (const m of moves) {
        if (m.score <= 0) continue;
        let val = m.score;
        if (useLeave) {
          const codes = [];
          for (const p of m.placements) {
            codes.push(p.isBlank ? 26 : p.letter.charCodeAt(0) - 65);
            let j = codes.length - 1;
            while (j > 0 && codes[j - 1] > codes[j]) {
              const t = codes[j]; codes[j] = codes[j - 1]; codes[j - 1] = t;
              j--;
            }
          }
          let key = 0;
          for (const c of codes) key = key * 27 + c + 1;
          let lv = leaveCache.get(key);
          if (lv === undefined) {
            for (const c of codes) rackCounts[c]--;
            lv = unseenTotal > 0
              ? bagAwareLeaveValue(rackCounts, unseenCounts, unseenTotal)
              : leaveValueFromCounts(rackCounts);
            for (const c of codes) rackCounts[c]++;
            leaveCache.set(key, lv);
          }
          val += leaveScale * lv;
        }
        if (ditherRng) val += evalDither * (ditherRng() * 2 - 1);
        onMove(m, val);
      }
    }
  }
}

// Best move by static evaluation: first strict maximum in scan order.
async function findBestStaticMove(rack) {
  let bestVal = -Infinity;
  let bestMove = null;
  await scanStaticMoves(rack, (m, val) => {
    if (val > bestVal) { bestVal = val; bestMove = m; }
  });
  return bestMove;
}

// Candidate moves for simulation, best static value first (stable sort, so
// element 0 is exactly findBestStaticMove's choice). Returns the top
// cfg.candidates, then (if cfg.margin > 0) prunes the tail of moves more than
// cfg.margin points behind the best — so the arm count adapts down when a move
// is clearly best, but never exceeds the cap. At least the static best is kept.
async function collectTopCandidates(rack, cfg) {
  const all = [];
  await scanStaticMoves(rack, (m, val) => { all.push({ m, val }); });
  all.sort((a, b) => b.val - a.val);
  let n = Math.min(cfg.candidates, all.length);
  if (cfg.margin > 0 && n > 0) {
    const cut = all[0].val - cfg.margin;
    while (n > 1 && all[n - 1].val < cut) n--; // drop moves beyond the margin
  }
  return all.slice(0, n);
}

// ============================================================
// SIMULATION (mid-game lookahead)  — config lives in STAGES, above.
// ============================================================

// Standard normal CDF via a deterministic erf approximation (Abramowitz &
// Stegun 7.1.26, |error| < 1.5e-7) — no Math.random, so mirrored matches
// stay bit-exact. Used by the Bayesian overrule decision.
function erfApprox(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
function normalCdf(z) { return 0.5 * (1 + erfApprox(z / Math.SQRT2)); }

// Margin -> P(win) transform for score-aware ranking away from terminal
// positions, calibrated by tools/margin-sigma.js over 2000 static
// self-play games (data/margin-sigma.json). Mover-perspective residuals
// (final margin minus current standing) show a near-constant tempo drift
// MU ~ +19 — about half an average move, b/2 — and variance close to
// linear in the unseen-tile count: sigma^2(bag) = 89.5*bag + 991. So
// with `margin` the mover-perspective standing at a point where it is
// the mover's turn: P(win) = Phi((margin + MU) / sigma(bag)).
// Tie rule: a tied raw score is a win for the SECOND player, implemented
// as a half-point komi in the second player's starting score. Margins are
// therefore never exactly zero, and every score-aware quantity — the
// standing myScoreMargin, playout finals, the P(win) threshold — inherits
// the rule exactly, with no seat-parity plumbing or continuity correction.
const WINPROB_MU = 19;
// Raw spread: all residual variance from a bag-k standing (opponent rack
// unknown). Used as the smoothing kernel for terminal-playout win credit,
// where the width should reflect the across-world spread.
function sigmaAtBag(bagCount) { return Math.sqrt(89.48 * bagCount + 991.2); }
// Conditional spread: residual net of the damped leave differential of two
// KNOWN racks — the width matched to a sampled world's horizon margin,
// whose predictor already contains that differential. Same per-tile slope
// as the raw fit (future draws are unexplained by current racks); the
// intercept drops from 991 to 605 because rack asymmetry was a large part
// of the "noise".
function sigmaCondAtBag(bagCount) { return Math.sqrt(86.03 * bagCount + 605.0); }
function winProbAtBag(margin, bagCount) {
  return normalCdf((margin + WINPROB_MU) / sigmaCondAtBag(bagCount));
}

// Play a sampled world to the end of the game after the candidate move:
// both sides move statically (our measurements put greedy within a point
// of search at the empty-bag phase, and it is 5x cheaper here), drawing
// from the world's fixed order, under the real terminal rules — going
// out banks the opponent's rack value twice, two consecutive passes
// strand both racks. Returns the exact final margin for the mover.
// Board mutations are unwound before returning.
// Hard ply guard: a single playout cannot run longer than this many plies
// (a pathological board where neither side terminates). The real cost lever
// is the shared node budget below; this is just an infinite-loop backstop.
const PLAYOUT_PLY_GUARD = 24;

// Plays the sampled world to the end of the game (both sides greedy), returning
// the exact final margin for the mover. The only cutoff is a hard ply guard: a
// pathological board where neither side terminates falls back to the damped
// leave differential rather than looping forever.
async function simPlayoutValue(moveScore, myKeptTiles, world, oppSize) {
  let margin = moveScore;
  const applied = [];
  let myRack = myKeptTiles.slice();
  let oppRack = world.slice(0, oppSize);
  const bagArr = world.slice(oppSize);
  const draw = rack => {
    while (rack.length < 7 && bagArr.length > 0) rack.push(bagArr.shift());
  };
  draw(myRack); // refill after the candidate move

  let side = 1; // opponent moves next
  let passes = 0;
  for (let plies = 0; ; plies++) {
    if (plies > PLAYOUT_PLY_GUARD) {
      // Infinite-loop backstop only: fall back to the damped leave differential.
      const scaleH = Math.min(1, bagArr.length / 7);
      margin += scaleH *
        (leaveValueFromCounts(tileCounts(myRack)) - leaveValueFromCounts(tileCounts(oppRack)));
      break;
    }
    state.bag = bagArr; // consumers only read its length
    const mover = side === 1 ? oppRack : myRack;
    const mv = await findBestStaticMove(mover);
    if (!mv) {
      if (++passes >= 2) {
        margin += rackValueOf(oppRack) - rackValueOf(myRack);
        break;
      }
    } else {
      passes = 0;
      applyToBoard(mv.placements);
      applied.push(mv.placements);
      const newRack = rackWithout(mover, mv.placements);
      if (side === 1) { oppRack = newRack; margin -= mv.score; }
      else { myRack = newRack; margin += mv.score; }
      if (newRack.length === 0 && bagArr.length === 0) {
        const bonus = 2 * rackValueOf(side === 1 ? myRack : oppRack);
        margin += side === 1 ? -bonus : bonus;
        break;
      }
      draw(newRack);
    }
    side = 1 - side;
  }

  for (let i = applied.length - 1; i >= 0; i--) removeFromBoard(applied[i]);
  return margin;
}

let inSimulation = false; // opponent replies inside a sim use static play

function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over board, own rack, and bag size: the same position always
// draws the same sample worlds, keeping games fully deterministic.
function positionHash(rack) {
  let h = 0x811c9dc5;
  const mix = v => { h ^= v; h = Math.imul(h, 0x01000193); };
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = state.board[r][c];
      mix(cell ? cell.letter.charCodeAt(0) + (cell.isBlank ? 64 : 0) : 255);
    }
  }
  const codes = rack
    .map(t => t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65)
    .sort((a, b) => a - b);
  for (const c of codes) mix(c + 300);
  mix(state.bag.length + 1000);
  return h >>> 0;
}

function tileCounts(tiles) {
  const counts = new Int32Array(27);
  for (const t of tiles) {
    counts[t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65]++;
  }
  return counts;
}

// The best tiles to keep when exchanging: the proper subset of the rack
// (at least one tile goes back) with the highest pool-aware leave value.
// Each keep is scored by its static leave value plus an EXACT single-tile
// pool correction — sum_t (poolFrac[t] - globalFrac[t]) * leaveValue(keep+t)
// — a closed 27-term sum over one replacement tile, so a depleted or
// enriched pool shifts which keep wins without any Monte Carlo (no
// sampling noise) and staying within the leave model's domain. Unlike a
// move's leave, this keep choice is never re-examined by simulation (the
// sim only evaluates the chosen keep), so the pool-awareness is not
// redundant with it. Returns { keep, tiles } or null with no leave model.
function bestExchangeKeep(rack) {
  if (!leaveModelReady()) return null;
  const n = rack.length;
  if (n === 0) return null;
  const code = t => t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65;
  const rackCodes = rack.map(code);
  // Pool deviation: actual unseen-pool fractions minus the global
  // distribution the leave model was trained on (full dist minus rack).
  const actual = deriveOpponentRack(rack);
  const ac = new Float64Array(27); for (const t of actual) ac[code(t)]++;
  const rem = {}; for (const [L, [c]] of Object.entries(TILE_DATA)) rem[L] = c;
  for (const t of rack) rem[t.isBlank ? '?' : t.letter.toUpperCase()]--;
  const gc = new Float64Array(27); let gt = 0;
  for (const [L, c] of Object.entries(rem)) { gc[L === '?' ? 26 : L.charCodeAt(0) - 65] = c; gt += c; }
  const at = actual.length || 1;
  const dev = new Float64Array(27);
  for (let i = 0; i < 27; i++) dev[i] = ac[i] / at - gc[i] / gt;

  const counts = new Int32Array(27);
  let bestMask = 0;
  let bestVal = -Infinity;
  for (let mask = 0; mask < (1 << n) - 1; mask++) { // masks exclude keep-all
    counts.fill(0);
    for (let i = 0; i < n; i++) if (mask & (1 << i)) counts[rackCodes[i]]++;
    let v = leaveValueFromCounts(counts);
    for (let t = 0; t < 27; t++) {
      if (dev[t] === 0) continue;
      counts[t]++; v += dev[t] * leaveValueFromCounts(counts); counts[t]--;
    }
    if (v > bestVal) { bestVal = v; bestMask = mask; }
  }
  const keep = [], tiles = [];
  for (let i = 0; i < n; i++) {
    (bestMask & (1 << i) ? keep : tiles).push(rack[i]);
  }
  return { keep, tiles, value: bestVal };
}

// Choose among the top static candidates by 2-ply simulation: sample the
// unseen tiles into opponent rack + draw order (the same worlds for every
// candidate — common random numbers), play the candidate, let the sampled
// opponent answer with its static best, and value the outcome as score
// differential plus the damped leave differential at the horizon. The
// candidate with the best mean wins; ties keep static order.
//
// With 7+ tiles in the bag, the best exchange (per bestExchangeKeep) is
// one more arm: it scores zero, touches no board cells, and redraws from
// the sampled world — the playout prices it in the same margin units as
// the moves, and the confidence gate means the engine only exchanges
// when that is confidently better than the best move.
async function findBestSimMove(rack, cfg) {
  const cands = await collectTopCandidates(rack, cfg);
  const exchange = state.bag.length >= 7 ? bestExchangeKeep(rack) : null;
  if (cands.length === 0) {
    // No legal move: exchange beats passing whenever it is allowed.
    return exchange ? { exchange: true, tiles: exchange.tiles } : null;
  }

  // Arms: move candidates in static order (arm 0 is the incumbent),
  // then the exchange as a challenger. staticVal is the move+leave score
  // that ranked the candidate (arm 0 holds the maximum); the Bayesian
  // overrule uses it as the prior mean. The exchange scores 0 on the board,
  // so its static value is just its (pool-aware) leave value, damped by the
  // same bag taper the move leaves carry.
  const leaveScale0 = Math.min(1, state.bag.length / 7);
  const arms = cands.map(c => ({
    move: c.m, placements: c.m.placements, score: c.m.score,
    kept: rackWithout(rack, c.m.placements), staticVal: c.val,
  }));
  if (exchange) {
    arms.push({ move: null, placements: null, score: 0, kept: exchange.keep,
      tiles: exchange.tiles, staticVal: leaveScale0 * exchange.value });
  }
  const armResult = a => a.move ? a.move : { exchange: true, tiles: a.tiles };
  if (arms.length === 1) return armResult(arms[0]);

  const realBag = state.bag;
  const pool = deriveOpponentRack(rack); // unseen tiles: bag + opponent rack
  const oppSize = pool.length - realBag.length;
  if (oppSize <= 0) return armResult(arms[0]);

  // Worlds place oppSize tiles as the opponent rack and the rest as draw
  // order. When cfg.enumerate is set and the bag is small enough, replace
  // Monte-Carlo sampling with an exact enumeration of every way to split the
  // unseen pool into (opponent rack | bag): each distinct split appears once
  // with equal weight, so the per-arm mean is the exact expected value under
  // the rollout policy — no sampling variance, and only C(pool, bag) worlds
  // (8 at bag=1) instead of cfg.samples. Falls back to sampling if the split
  // count would exceed cfg.samples (nothing gained by enumerating then).
  const worlds = [];
  const splitCount = enumChoose(pool.length, realBag.length);
  if (cfg.enumerate && splitCount > 0 && splitCount <= cfg.samples) {
    for (const bagIdx of indexSubsets(pool.length, realBag.length)) {
      const inBag = new Array(pool.length).fill(false);
      for (const k of bagIdx) inBag[k] = true;
      const opp = [], bagTiles = [];
      for (let k = 0; k < pool.length; k++) (inBag[k] ? bagTiles : opp).push(pool[k]);
      worlds.push(opp.concat(bagTiles)); // opponent rack, then bag draw order
    }
  } else {
    const rng = seededRng(positionHash(rack));
    for (let w = 0; w < cfg.samples; w++) {
      const p = pool.slice();
      for (let i = p.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      worlds.push(p); // first oppSize tiles: opponent rack; rest: draw order
    }
  }

  // Paired statistics of candidate ci vs candidate base over the first
  // n shared worlds: [mean, standard error of the mean difference].
  const pairedStats = (vals, ci, base, n) => {
    let mean = 0;
    for (let w = 0; w < n; w++) mean += vals[ci][w] - vals[base][w];
    mean /= n;
    let varSum = 0;
    for (let w = 0; w < n; w++) {
      const d = vals[ci][w] - vals[base][w] - mean;
      varSum += d * d;
    }
    return [mean, n > 1 ? Math.sqrt(varSum / (n - 1) / n) : 0];
  };

  // Bayesian posterior probability that candidate ci is truly better than
  // base, over the first n shared worlds. Prior: mu ~ N(dStatic, PRIOR_SD^2),
  // with dStatic the static move+leave gap (<= 0 when base is the incumbent).
  // Likelihood: the n paired differences have mean mbar and per-world
  // variance s2, so mbar carries precision n/s2 about mu. Conjugate update
  // gives a Normal posterior; return P(mu > 0) = Phi(postMean / postSD).
  const bayesProb = (vals, ci, base, n) => {
    let sum = 0;
    for (let w = 0; w < n; w++) sum += vals[ci][w] - vals[base][w];
    const mbar = sum / n;
    let ss = 0;
    for (let w = 0; w < n; w++) {
      const d = vals[ci][w] - vals[base][w] - mbar;
      ss += d * d;
    }
    const s2 = Math.max(n > 1 ? ss / (n - 1) : cfg.varFloor, cfg.varFloor);
    const priorPrec = 1 / (cfg.priorSd * cfg.priorSd);
    const dataPrec = n / s2;
    const postVar = 1 / (priorPrec + dataPrec);
    const mu0 = arms[ci].staticVal - arms[base].staticVal;
    const postMean = postVar * (mu0 * priorPrec + mbar * dataPrec);
    return normalCdf(postMean / Math.sqrt(postVar));
  };

  inSimulation = true;
  const K = arms.length;
  const M = worlds.length;
  // The stage config already fixes the evaluation mode: lowbag => terminal
  // playout, midgame => 2-ply horizon (the router picks the stage by bag).
  const toTerminal = cfg.mode === 'terminal';
  // Score-aware ranking by P(win) instead of expected margin. Terminal
  // stages score each played-out world as a win indicator against the
  // current standing (sigma -> 0 limit). The 2-ply midgame maps each
  // world's horizon margin through the calibrated transform winProbAtBag:
  // Phi's curvature then prices variance by standing — ahead prefers
  // reply-denying (variance-reducing) moves, behind variance-seeking ones
  // — though only as far as the 2-ply world spread can see. Units become
  // probabilities, so the z-based confidence gates still apply, but the
  // Bayesian overrule's point-calibrated prior (priorSd) does not: use
  // scoreAware with the default confidence gate, not cfg.bayes.
  const scoreAware = !!cfg.scoreAware;
  const myScoreMargin = state.computerScore - state.playerScore;
  const vals = Array.from({ length: K }, () => []); // vals[arm][world]
  const alive = new Array(K).fill(true);
  try {
    // World-major so surviving candidates advance together and pruning
    // can retire hopeless challengers early.
    for (let w = 0; w < M; w++) {
      const world = worlds[w];
      for (let ci = 0; ci < K; ci++) {
        if (!alive[ci]) continue;
        const arm = arms[ci];
        const myKept = arm.kept;
        if (arm.placements) applyToBoard(arm.placements);
        if (toTerminal) {
          // Near the endgame the sampled world is cheap to finish: play
          // it out and score the exact final margin — no horizon
          // heuristic, and the leave taper plays no evaluation role.
          const margin = await simPlayoutValue(arm.score, myKept, world, oppSize);
          if (arm.placements) removeFromBoard(arm.placements);
          // Score-aware: smoothed win credit — the playout's exact final
          // margin through Phi at the calibrated across-world spread for
          // this bag size, instead of a hard win/loss indicator. With only
          // 8-10 worlds, Bernoulli indicators carry more ranking noise than
          // the smoothing bias costs (the indicator variant measured about
          // -4 pts/game in its A/B). No MU term: a completed playout has
          // already realized the mover's tempo.
          if (scoreAware) {
            const final = myScoreMargin + margin;
            vals[ci].push(normalCdf(final / sigmaAtBag(realBag.length)));
          } else {
            vals[ci].push(margin);
          }
          continue;
        }
        const oppRack = world.slice(0, oppSize);
        let cursor = oppSize;
        const myDrawStart = cursor;
        const myDraw = Math.min(7 - myKept.length, world.length - cursor);
        cursor += myDraw;

        // Opponent answers on the post-move board; only the simulated
        // bag's length matters (leave damping / endgame switch). For an
        // exchange arm the discards rejoin the real bag, so its length
        // is unchanged; the sampled draw order simply skips them (they
        // cannot be redrawn immediately anyway).
        state.bag = world.slice(cursor);
        const reply = await findBestMove(oppRack);
        const rScore = reply ? reply.score : 0;
        const oppKept = reply ? rackWithout(oppRack, reply.placements) : oppRack;
        const oppDrawStart = cursor;
        const oppDraw = Math.min(7 - oppKept.length, state.bag.length);

        // Fill the leaf eval rack to 6 tiles while the bag is comfortable
        // (>10) so it stays inside the superleave table's <=6 domain; fill
        // completely (7) near the bag end, where the realized rack matters
        // (7-tile vectors use the table's drop-one mean).
        const target = realBag.length > 10 ? 6 : 7;
        let dMargin, bagH;
        if ((cfg.plies || 2) >= 3 && reply && reply.placements) {
          // 3-ply: apply the reply, refill my rack from the world's draw
          // order, play my best static answer on the twice-updated board,
          // and take the horizon one round later. My two moves against the
          // opponent's one adds a tempo offset, but it is common to every
          // arm, so rankings are unaffected — what changes is that a
          // candidate's leave quality is realized by an actual second move
          // instead of the leave heuristic alone.
          applyToBoard(reply.placements);
          const rack2 = myKept.concat(world.slice(myDrawStart, myDrawStart + myDraw));
          const bagAfterOpp = world.slice(oppDrawStart + oppDraw);
          state.bag = bagAfterOpp;
          const my2 = await findBestMove(rack2); // static: inSimulation is set
          const my2Score = my2 && my2.placements ? my2.score : 0;
          const my2Kept = my2 ? rackWithout(rack2, my2.placements || my2.tiles || []) : rack2;
          const my2DrawStart = oppDrawStart + oppDraw;
          const my2Draw = Math.min(7 - my2Kept.length, bagAfterOpp.length);
          let horizon3 = 0;
          const scale3 = Math.min(1, (bagAfterOpp.length - my2Draw) / 7);
          if (scale3 > 0 && leaveModelReady()) {
            const specMy = Math.min(my2Draw, Math.max(0, target - my2Kept.length));
            const specOpp = Math.min(oppDraw, Math.max(0, target - oppKept.length));
            const myEval = my2Kept.concat(world.slice(my2DrawStart, my2DrawStart + specMy));
            const oppEval = oppKept.concat(world.slice(oppDrawStart, oppDrawStart + specOpp));
            horizon3 = scale3 *
              (leaveValueFromCounts(tileCounts(myEval)) - leaveValueFromCounts(tileCounts(oppEval)));
          }
          removeFromBoard(reply.placements);
          dMargin = arm.score - rScore + my2Score + horizon3;
          bagH = Math.max(0, bagAfterOpp.length - my2Draw);
        } else {
          let horizon = 0;
          const scaleH = Math.min(1, (state.bag.length - oppDraw) / 7);
          if (scaleH > 0 && leaveModelReady()) {
            const specMy = Math.min(myDraw, Math.max(0, target - myKept.length));
            const specOpp = Math.min(oppDraw, Math.max(0, target - oppKept.length));
            const myEval = myKept.concat(world.slice(myDrawStart, myDrawStart + specMy));
            const oppEval = oppKept.concat(world.slice(oppDrawStart, oppDrawStart + specOpp));
            horizon = scaleH *
              (leaveValueFromCounts(tileCounts(myEval)) - leaveValueFromCounts(tileCounts(oppEval)));
          }
          dMargin = arm.score - rScore + horizon;
          bagH = Math.max(0, state.bag.length - oppDraw);
        }
        if (scoreAware) {
          // bagH is the horizon bag size with my turn to move — the
          // calibration's reference frame at either ply depth.
          vals[ci].push(winProbAtBag(myScoreMargin + dMargin, bagH));
        } else {
          vals[ci].push(dMargin);
        }
        if (arm.placements) removeFromBoard(arm.placements);
      }

      // Prune challengers that are confidently worse than the incumbent —
      // they can never win the final overrule gate, so stop paying for
      // their reply searches. The incumbent (candidate 0) is never pruned.
      const n = w + 1;
      if (n >= cfg.minWorlds && n < M && (n - cfg.minWorlds) % cfg.pruneEvery === 0) {
        for (let ci = 1; ci < K; ci++) {
          if (!alive[ci]) continue;
          if (cfg.bayes) {
            // Retire a challenger once it is confidently worse than the
            // incumbent: posterior P(better) below the complement of the
            // overrule threshold — it can no longer clear overruleP.
            if (bayesProb(vals, ci, 0, n) < 1 - cfg.overruleP) alive[ci] = false;
          } else {
            const [mean, se] = pairedStats(vals, ci, 0, n);
            if (mean < 0 && (se === 0 || mean < -cfg.confidence * se)) alive[ci] = false;
          }
        }
      }
    }
  } finally {
    inSimulation = false;
    state.bag = realBag;
  }

  // The static choice (candidate 0) stays unless a surviving challenger
  // beats it with confidence: the candidates share worlds, so their
  // per-world differences form a paired sample, and the challenger must
  // win by more than CONFIDENCE standard errors of that difference.
  // Without the gate, overrules happen at the sampling-noise floor and
  // are wrong about half the time.
  let bestIdx = 0;
  for (let ci = 1; ci < K; ci++) {
    if (!alive[ci]) continue;
    if (cfg.bayes) {
      // Overrule the incumbent only when the posterior says the challenger
      // is better with probability > overruleP. The prior (centered on the
      // static gap) and the sampled uncertainty are already folded in, so no
      // separate significance gate is needed.
      if (bayesProb(vals, ci, bestIdx, M) > cfg.overruleP) bestIdx = ci;
    } else {
      const [mean, se] = pairedStats(vals, ci, bestIdx, M);
      if (mean <= 0) continue;
      if (se === 0 || mean > cfg.confidence * se) bestIdx = ci;
    }
  }
  if (TRACE.on) {
    const override = bestIdx !== 0;
    TRACE.lastOverride = override;
    TRACE.lastRank = bestIdx;
    TRACE.lastNArms = K;
    TRACE.lastGap = override ? arms[0].staticVal - arms[bestIdx].staticVal : 0;
    if (override) {
      const [mean, se] = pairedStats(vals, bestIdx, 0, M);
      TRACE.lastZ = se > 0 ? mean / se : (mean > 0 ? 1e9 : 0);
      TRACE.overrides++;
      TRACE.gaps.push(TRACE.lastGap);
      if (TRACE.lastGap > TRACE.maxGap) {
        TRACE.maxGap = TRACE.lastGap;
        TRACE.maxPos = {
          gap: TRACE.lastGap,
          bestStatic: arms[0].staticVal,
          chosenStatic: arms[bestIdx].staticVal,
          chosenArm: bestIdx,
          nArms: K,
          bagCount: state.bag.length,
          rack: rack.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).join(''),
          board: JSON.parse(JSON.stringify(state.board)),
        };
      }
    } else {
      TRACE.lastZ = 0;
    }
  }
  return armResult(arms[bestIdx]);
}

// Find the best legal move for the given rack. With an empty bag this is
// the adversarial endgame search; otherwise simulation picks among the
// top static candidates (static play inside simulated replies).
// Every size-k index subset of [0, n). n is small (unseen pool, <= ~9).
function indexSubsets(n, k) {
  const out = [];
  const rec = (start, chosen) => {
    if (chosen.length === k) { out.push(chosen.slice()); return; }
    for (let i = start; i < n; i++) { chosen.push(i); rec(i + 1, chosen); chosen.pop(); }
  };
  rec(0, []);
  return out;
}

// Binomial C(n, k): the number of ways to split an n-tile pool into a k-tile
// bag and the rest. Used to decide whether exact world enumeration is cheaper
// than Monte-Carlo sampling.
function enumChoose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

// Exact solver-based pre-endgame policy. When the bag holds only a tile or two
// the unseen pool (opponent rack + bag) is small and known up to which tiles
// are in the bag, so we enumerate every such split exactly rather than sample:
// for each candidate move, play it, deal the drawn bag tiles, and score the
// resulting empty-bag position with the exact endgame solver; the move with the
// best probability-weighted final margin wins. Deterministic. Only candidates
// whose refill empties the bag (or that go out) are scored exactly — at bag 2 a
// one-tile play would leave the bag non-empty (a recursive pre-endgame) and is
// skipped. cfg.candidates/margin bound the candidate set; cfg.preendBudget caps
// each endgame solve (a candidate whose solve overruns is skipped).
async function findBestPreEndgameMove(rack, cfg) {
  const bagSize = state.bag.length;
  const pool = deriveOpponentRack(rack); // unseen: opponent rack + bag tiles
  const oppSize = pool.length - bagSize;
  if (bagSize < 1 || oppSize < 0) return findBestStaticMove(rack);
  const cands = await collectTopCandidates(rack, cfg);
  if (cands.length === 0) return null;
  const subsets = indexSubsets(pool.length, bagSize); // which pool tiles are the bag
  const wgt = 1 / subsets.length;
  const boardSnap = state.board.map(r => r.slice());
  const savedBudget = STAGES.bag0.movegenBudget;
  STAGES.bag0.movegenBudget = cfg.preendBudget;
  const budget = { used: 0 };
  let best = null, bestEv = -Infinity;
  try {
    for (const c of cands) {
      const leave = rackWithout(rack, c.m.placements);
      const draw = Math.min(7 - leave.length, bagSize);
      if (leave.length > 0 && draw < bagSize) continue; // refill leaves bag non-empty
      await yieldToUI();
      applyToBoard(c.m.placements);
      let ev = 0, ok = true;
      for (const sub of subsets) {
        const inBag = new Array(pool.length).fill(false);
        for (const i of sub) inBag[i] = true;
        const oppRack = pool.filter((_, k) => !inBag[k]);
        let v;
        if (leave.length === 0) {
          v = c.m.score + 2 * rackValueOf(oppRack); // went out on the move itself
        } else {
          const myRack = leave.concat(sub.map(i => pool[i])); // drew the bag tiles
          budget.used = 0;
          try {
            v = c.m.score - endgameSearch(oppRack, myRack, 0, 1, -Infinity, Infinity, budget);
          } catch (e) {
            if (e !== ENDGAME_ABORT) throw e;
            state.board = boardSnap; ok = false; break; // solve overran the cap
          }
        }
        ev += v;
      }
      removeFromBoard(c.m.placements);
      if (!ok) continue;
      ev *= wgt;
      if (ev > bestEv) { bestEv = ev; best = c.m; }
    }
  } finally {
    STAGES.bag0.movegenBudget = savedBudget;
  }
  return best !== null ? best : findBestStaticMove(rack);
}

async function findBestMove(rack) {
  ensureTrie();
  ensureLeaveTables();
  // Opponent replies inside a simulation always use fast static play,
  // regardless of the stage config.
  if (inSimulation) return findBestStaticMove(rack);
  const cfg = STAGES[stageFor(state.bag.length)];
  if (cfg.static) return findBestStaticMove(rack);
  if (state.bag.length === 0) return findBestEndgameMove(rack);
  if (cfg.mode === 'solver') return findBestPreEndgameMove(rack, cfg);
  return findBestSimMove(rack, cfg);
}

// Generate all legal moves in one line via the trie (Appel–Jacobson):
// depth-first walks outward from each anchor square consume rack tiles and
// prune the instant the dictionary cannot extend the prefix, so only
// viable words are ever visited. Scores accumulate incrementally during
// the walk from per-line bonus and cross-sum tables (integer arithmetic,
// so results are exactly scorePlacement's). Blanks are assigned greedily
// (real tile first), matching the previous engine, and results are sorted
// by (length, word, start) — the previous engine's scan order — so
// findBestMove's first-strict-max selection picks the identical move.
function findMovesInLine(lineIdx, isHoriz, rack) {
  const results = [];
  if (state.isFirstMove && lineIdx !== 7) return results;
  const trie = state.trie;

  // Per-line tables: fixed letters/values (blank tiles are worth 0) and
  // bonus multipliers (which only ever apply to newly placed tiles).
  const fixed = new Int8Array(15).fill(-1);
  const fixedVal = new Int8Array(15);
  const letterMult = new Uint8Array(15);
  const wordMult = new Uint8Array(15);
  for (let i = 0; i < 15; i++) {
    const r = isHoriz ? lineIdx : i;
    const c = isHoriz ? i : lineIdx;
    const cell = state.board[r][c];
    if (cell) {
      fixed[i] = cell.letter.toLowerCase().charCodeAt(0) - 97;
      fixedVal[i] = cell.isBlank ? 0 : (LETTER_VALUES[cell.letter.toUpperCase()] || 0);
    }
    const bonus = BONUS_MAP[r][c];
    letterMult[i] = bonus === 'TL' ? 3 : bonus === 'DL' ? 2 : 1;
    wordMult[i] = bonus === 'TW' ? 3 : bonus === 'DW' ? 2 : 1;
  }

  // Anchors: empty cells a move may build from. Every legal move places a
  // new tile on at least one anchor, and is generated exactly once, from
  // the leftmost anchor its new tiles cover.
  const anchor = new Uint8Array(15);
  const crossMask = new Int32Array(15).fill(ALL_LETTERS_MASK);
  const crossSum = new Int32Array(15);
  const hasCross = new Uint8Array(15);
  let anyAnchor = false;
  for (let i = 0; i < 15; i++) {
    if (fixed[i] !== -1) continue;
    const r = isHoriz ? lineIdx : i;
    const c = isHoriz ? i : lineIdx;
    if (state.isFirstMove ? (r === 7 && c === 7) : isAdjacentToExisting(r, c)) {
      anchor[i] = 1;
      anyAnchor = true;
      computeCrossData(r, c, isHoriz, i, crossMask, crossSum, hasCross);
    }
  }
  if (!anyAnchor) return results;

  const counts = new Int32Array(26);
  let blanks = 0;
  for (const t of rack) {
    if (t.isBlank) blanks++;
    else counts[t.letter.toLowerCase().charCodeAt(0) - 97]++;
  }

  // New-tile letters along the current DFS path, by line position
  const placedChar = new Int8Array(15);
  const placedBlank = new Uint8Array(15);

  const record = (start, end, score) => {
    let word = '';
    const placements = [];
    for (let i = start; i <= end; i++) {
      const code = fixed[i] !== -1 ? fixed[i] : placedChar[i];
      word += String.fromCharCode(97 + code);
      if (fixed[i] === -1) {
        const r = isHoriz ? lineIdx : i;
        const c = isHoriz ? i : lineIdx;
        placements.push({ row: r, col: c, letter: String.fromCharCode(65 + code), isBlank: placedBlank[i] === 1 });
      }
    }
    results.push({ placements, word, score, start });
  };

  // Extend rightward: letters wordStart..pos-1 are already consumed into
  // `node`, with main-word value `sum`, word multiplier `wMult`,
  // accumulated (already multiplied) cross-word points `crossTot`, and
  // `placed` new tiles so far. A word is recorded when the dictionary
  // marks it terminal, the walk has covered the anchor (guaranteeing
  // >= 1 new tile and board connection), and the next cell is not fixed
  // (no illegal extension).
  function extendRight(pos, node, wordStart, anchorPos, sum, wMult, crossTot, placed) {
    const offBoard = pos >= 15;
    if ((offBoard || fixed[pos] === -1) &&
        pos > anchorPos && trie.terminal[node] === 1 && pos - wordStart >= 2) {
      record(wordStart, pos - 1, sum * wMult + crossTot + (placed === 7 ? 50 : 0));
    }
    if (offBoard) return;

    if (fixed[pos] !== -1) {
      const next = trieChild(trie, node, fixed[pos]);
      if (next !== -1) {
        extendRight(pos + 1, next, wordStart, anchorPos, sum + fixedVal[pos], wMult, crossTot, placed);
      }
      return;
    }
    // Empty cell: try each rack-playable child the cross-check allows
    const s = trie.childStart[node], e = s + trie.childCount[node];
    for (let k = s; k < e; k++) {
      const code = trie.edgeChar[k];
      if ((crossMask[pos] & (1 << code)) === 0) continue;
      let usedBlank;
      if (counts[code] > 0) { counts[code]--; usedBlank = false; }
      else if (blanks > 0) { blanks--; usedBlank = true; }
      else continue;
      placedChar[pos] = code;
      placedBlank[pos] = usedBlank ? 1 : 0;
      const add = (usedBlank ? 0 : LETTER_VAL_BY_CODE[code]) * letterMult[pos];
      const ct = hasCross[pos] === 1 ? crossTot + (crossSum[pos] + add) * wordMult[pos] : crossTot;
      extendRight(pos + 1, trie.edgeNode[k], wordStart, anchorPos,
        sum + add, wMult * wordMult[pos], ct, placed + 1);
      if (usedBlank) blanks++; else counts[code]++;
    }
  }

  // Left parts built from the rack (cells left of the anchor are always
  // non-anchor empties, so they carry no cross-word constraints). The
  // partial word lives in leftBuf as flat (code, isBlank) pairs; cell
  // positions — and therefore bonus multipliers — are assigned when the
  // rightward extension starts.
  const leftBuf = [];
  function startExtend(node, anchorPos) {
    const len = leftBuf.length / 2;
    const wordStart = anchorPos - len;
    let sum = 0, wMult = 1;
    for (let j = 0; j < len; j++) {
      const pos = wordStart + j;
      placedChar[pos] = leftBuf[2 * j];
      placedBlank[pos] = leftBuf[2 * j + 1];
      sum += (leftBuf[2 * j + 1] === 1 ? 0 : LETTER_VAL_BY_CODE[leftBuf[2 * j]]) * letterMult[pos];
      wMult *= wordMult[pos];
    }
    extendRight(anchorPos, node, wordStart, anchorPos, sum, wMult, 0, len);
  }
  function leftPart(node, anchorPos, maxLeft) {
    startExtend(node, anchorPos);
    if (leftBuf.length / 2 >= maxLeft) return;
    const s = trie.childStart[node], e = s + trie.childCount[node];
    for (let k = s; k < e; k++) {
      const code = trie.edgeChar[k];
      let usedBlank;
      if (counts[code] > 0) { counts[code]--; usedBlank = false; }
      else if (blanks > 0) { blanks--; usedBlank = true; }
      else continue;
      leftBuf.push(code, usedBlank ? 1 : 0);
      leftPart(trie.edgeNode[k], anchorPos, maxLeft);
      leftBuf.length -= 2;
      if (usedBlank) blanks++; else counts[code]++;
    }
  }

  for (let a = 0; a < 15; a++) {
    if (anchor[a] !== 1) continue;
    if (a > 0 && fixed[a - 1] !== -1) {
      // Existing tiles directly left of the anchor are the left part
      let s = a - 1;
      while (s > 0 && fixed[s - 1] !== -1) s--;
      let node = 0, prefixSum = 0;
      for (let i = s; i < a && node !== -1; i++) {
        node = trieChild(trie, node, fixed[i]);
        prefixSum += fixedVal[i];
      }
      if (node !== -1) extendRight(a, node, s, a, prefixSum, 1, 0, 0);
    } else {
      // Rack-built left parts, at most up to the previous anchor or edge
      let maxLeft = 0;
      for (let i = a - 1; i >= 0 && fixed[i] === -1 && anchor[i] !== 1; i--) maxLeft++;
      leftPart(0, a, maxLeft);
    }
  }

  // Ties must resolve identically to the previous engine's scan order:
  // shortest word first, then alphabetical, then leftmost start.
  results.sort((x, y) =>
    (x.word.length - y.word.length) ||
    (x.word < y.word ? -1 : x.word > y.word ? 1 : 0) ||
    (x.start - y.start));
  return results;
}

// ============================================================
// GAME OVER
// ============================================================

function checkGameOver() {
  const bagEmpty = state.bag.length === 0;
  const playerEmpty = state.playerRack.length === 0;
  const computerEmpty = state.computerRack.length === 0;

  if (state.consecutivePasses >= 6) {
    endGame('Six consecutive scoreless turns. Game over.');
    return true;
  }
  if (bagEmpty && (playerEmpty || computerEmpty)) {
    endGame('Tiles exhausted. Game over.');
    return true;
  }
  return false;
}

function endGame(reason) {
  state.gameOver = true;
  enablePlayerControls(false);
  recallAllTiles();

  // Final scoring adjustments
  const playerUnused = state.playerRack.reduce((s,t) => s + letterVal(t.letter, t.isBlank), 0);
  const compUnused   = state.computerRack.reduce((s,t) => s + letterVal(t.letter, t.isBlank), 0);

  // Apply the adjustments and record them in the move history (letters are
  // revealed — the game is over). Going out banks the opponent's unplayed
  // tile value twice: once added, once deducted.
  const letters = r => r.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).sort().join('');
  if (state.playerRack.length === 0) {
    state.playerScore += compUnused;
    state.computerScore -= compUnused;
    logEntry(`Computer: −${compUnused} (unplayed tiles: ${letters(state.computerRack)})`, 'computer');
    logEntry(`You: +${compUnused} (Computer's unplayed tiles)`, 'player');
  } else if (state.computerRack.length === 0) {
    state.computerScore += playerUnused;
    state.playerScore -= playerUnused;
    logEntry(`You: −${playerUnused} (unplayed tiles: ${letters(state.playerRack)})`, 'player');
    logEntry(`Computer: +${playerUnused} (your unplayed tiles)`, 'computer');
  } else {
    state.playerScore -= playerUnused;
    state.computerScore -= compUnused;
    logEntry(`Computer: −${compUnused} (unplayed tiles: ${letters(state.computerRack)})`, 'computer');
    logEntry(`You: −${playerUnused} (unplayed tiles: ${letters(state.playerRack)})`, 'player');
  }

  renderScores();

  const pScore = state.playerScore;
  const cScore = state.computerScore;
  // The komi makes equality impossible; when the whole-point scores are
  // equal the half point decided it, so say so.
  let winner;
  if (pScore > cScore) winner = 'You win!';
  else winner = Math.floor(pScore) === Math.floor(cScore)
    ? 'Computer wins (a tie goes to the second player).'
    : 'Computer wins.';

  logEntry(`${reason} ${winner}`, 'system');

  const scoresEl = document.getElementById('end-scores');
  scoresEl.innerHTML = '';
  const reasonLine = document.createElement('div');
  reasonLine.textContent = reason;
  const scoreLine = document.createElement('div');
  scoreLine.textContent = `You ${Math.floor(pScore)} — Computer ${Math.floor(cScore)}`;
  scoresEl.appendChild(reasonLine);
  scoresEl.appendChild(scoreLine);
  document.getElementById('end-winner').textContent = winner;
  document.getElementById('end-overlay').classList.remove('hidden');
}

// ============================================================
// START
// ============================================================

window.addEventListener('DOMContentLoaded', init);
