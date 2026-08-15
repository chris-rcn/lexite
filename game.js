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
  await loadEndgameLeaves(); // best-effort; endgame falls back to face-value deadwood
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
//   bag == 0 ............... endgame  (reference-style adversarial beam search)
// `static: true` on any stage skips its lookahead and plays the static move
// generator there. The two simulation stages share SIM_BASE and override only
// what differs, so shared knobs stay in one place.
let LOWBAG_AT = 8; // tunable: bag < this (and > 0) is the lowbag stage

const SIM_BASE = {
  static: false,
  // Terminal-playout reply policy temperature: 0 = greedy (best static /
  // endgame-value reply, the long-standing default). > 0 samples each reply
  // from softmax(static values / temp) over the top replies, world-seeded so
  // candidates share continuation randomness (CRN). Models opponent
  // uncertainty inside playouts.
  playoutTemp: 0,
  // Two-ply playout replies (racks are known inside a world, so the defense
  // is exact). 0 = one-ply (default). 1 = out-defense: only the responder's
  // game-ending answers are priced — one pre-scan per ply, per-candidate
  // rescans only when an out threat exists, so blocking moves get caught at
  // near-one-ply cost (replies that CREATE a fresh out are not detected).
  // 2 = full two-ply (every reply priced by the responder's best answer,
  // ~8 scans per ply). 3 = full two-ply ONLY at bag 0 — the
  // information-legal variant: empty-bag racks are public via tile
  // tracking, so the two-ply defense there uses no knowledge a real
  // player lacks, while bag>0 plies stay one-ply greedy on own-rack
  // information. Composes with playoutTemp: temp 0 plays the argmax,
  // temp > 0 samples over the adjusted values.
  playoutDefense: 0,
  candidates: 5,    // max static candidates (top-K) evaluated by simulation
  samples: 30,      // sampled worlds, shared across candidates
  // Challenger-budget allocator. 'halving' (default) = sequential
  // halving: the decision budget (meter units, or worlds when unmetered)
  // splits into ceil(log2(challengers)) equal rounds; all survivors
  // share every world (paired), and at each round boundary the bottom
  // half by paired mean vs the incumbent retires. Parameter-free — it
  // beat tuned successive-rejection retirement in every regime measured
  // (bag1/2/3 and the midgame; that allocator and its minWorlds/
  // pruneEvery/margin-prune knobs are deleted). 0/other = no retirement:
  // every candidate is evaluated on every funded world (referee-style
  // full evaluation). 'ucb' = prior-gated paired UCB (terminal stages
  // only, experimental — loses to halving): posterior-scheduled worlds,
  // free admission for hopeless arms. The incumbent is never retired
  // (the final overrule gate needs it).
  alloc: 'halving',
  // movegenBudget: work meter for a decision (terminal playout plies and
  // horizon reply scans both charge it), counted
  // in generated moves plus a 300-unit surcharge per blank in the mover's
  // rack per ply (blank scans do ~26x the work per generated move);
  // in GENERATED MOVES (plus ~10/ply scan overhead) — the unit tracks
  // actual scan cost, unlike plies, whose cost spans 40x with board
  // openness. Roughly 30-40 units/ms; ~30k = 1s. 0 = unmetered. On
  // exhaustion the world loop stops at a whole-world boundary and the
  // decision is made from the worlds every candidate has completed —
  // pairing preserved, graceful degradation, at least one world always
  // finishes. Lets a quality config ship inside a latency envelope
  // instead of being downsized.
  movegenBudget: 0,
  // egMidBlend: the low-bag leave term is the convex mix
  // egMidBlend*midgame + (1 - egMidBlend)*endgame (total weight 1; the
  // knob only splits the models). -1 = auto: bag/7, the midgame share
  // shrinking as the endgame approaches. The stage owning the CURRENT
  // bag count governs, including inside playouts. Bag1 pins 0 (pure
  // draw-aware endgame model — measured best); other low-bag stages
  // keep auto pending per-stage evidence. With no endgame model loaded,
  // the legacy bag/7-damped midgame-only term applies.
  egMidBlend: -1,
  // Bayesian overrule. Models the true value gap of a challenger vs the
  // incumbent as mu ~ Normal(dStatic, tau^2) — the static move+leave gap is
  // the prior mean, priorSd is the prior SD (in points) — updates with the
  // sampled paired differences, and overrules iff the posterior P(mu > 0)
  // exceeds overruleP. Enabled by the midgame stage; terminal stages keep
  // the paired-mean argmax rule (bayes 0).
  bayes: 0,         // 1 enables the Bayesian decision in place of argmax
  priorSd: 12,      // tau: prior SD (points) of the true gap around dStatic
  overruleP: 0.9,   // posterior P(challenger better) needed to overrule
  varFloor: 1,      // floor on the per-world variance estimate (points^2)
};

// Move-selection policy keyed by bag state — how many tiles remain in the bag —
// rather than by stage names. Each key names the bag counts it governs; stageFor
// maps a bag count to its key. Boundaries: bag7 is 7 (LOWBAG_AT-1) and
// bagGt7 is LOWBAG_AT+ (LOWBAG_AT defaults to 8).
const STAGES = {
  // bag0: adversarial endgame search. Config found by regret-vs-oracle
  // benchmarking (tools/oracle-gen-bag0.js / eval-bag0-strategy.js; v7 DB,
  // 2,390 positions, terminal-depth width-24 oracle under the current
  // leave model): regret 0.45/decision at 92.8% oracle agreement, p99
  // ~1.1s — vs 2.73 / 83.2% / ~1.9s for the pre-campaign config (budget
  // 900, uncapped root, width 8, depth 4, raw-score order). The shape is
  // a tapered width schedule: broad root coverage (width0 70, trained-
  // value order with board-aware pricing), wide replies (width1 25 —
  // ply-1 misses feed root values undamped), a thin counter-move beam
  // (width2 5), then width 1: every deeper line is best-value-move-or-
  // pass to the true end of the game, terminal-scored and nearly free
  // under the transposition table. Root coverage dominates; depth is
  // uncapped by default; movegenBudget is the latency contract (all
  // movegen work, ordering included, draws on one meter; on exhaustion
  // the best fully-searched root or the greedy fallback plays).
  bag0: { static: false, movegenBudget: 500, width0: 70, width1: 25, width2: 5, width: 1, order: 2, tt: 1 },
  // bag1: near-perfect information. The unseen pool splits into only ~8
  // (opponent rack | bag) worlds, so enumerate them all exactly rather
  // than sample; candidates are cut by the draw-aware endgame-model
  // ordering (egMidBlend 0: the midgame model measured no remaining
  // value at bag 1), evaluated by endgame-aware playouts, with the
  // challenger budget allocated by sequential halving funding 10-wide
  // root coverage at narrow cost (halving beat the campaign-tuned
  // minWorlds-3 retirement 1.82 vs 1.93 on the v3 judge). Against that
  // benchmark (width-12 terminal referee): regret 1.82/decision at ~65%
  // optimal, p99 ~0.9s, vs 2.71 / 58% for the pre-campaign stage on the
  // same judge. Prior-shrinkage selection (bayes) measured strictly
  // harmful here: enumerated playout means are exact averages of biased
  // per-world values, and the across-world spread the posterior reads as
  // noise is genuine bag variance.
  bag1: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: true, candidates: 10, alloc: 'halving', scoreAware: 0, egMidBlend: 0 },
  // bag2: the unseen pool splits into C(9,2)=36 worlds — enumerated
  // exactly (samples 100 is only the enumeration-arming ceiling; it must
  // stay >= 36). The world list is seeded-shuffled at build so the
  // movegenBudget meter (generated moves, ~30-80 units/ms by board) can
  // truncate to an unbiased prefix, cutting at candidate boundaries with
  // whole-world rollback. Early pairwise retirement (minWorlds 5) frees
  // meter for survivors' worlds. Bayes off: as at bag1, enumerated
  // across-world spread is genuine bag variance, not noise — shrinkage
  // measured 0.4 worse (sampled worlds are the regime where it helps).
  // Challenger budget allocated by sequential halving (parameter-free;
  // beat the campaign-tuned minWorlds-5 retirement 1.25 vs 1.27 on the
  // v3 benchmark, p99 ~1000ms).
  bag2: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: true, samples: 100, candidates: 9, alloc: 'halving', egMidBlend: 0.18, movegenBudget: 110000, scoreAware: 0 },
  // bag3: the unseen pool splits into C(10,3)=120 worlds — too many to
  // enumerate usefully under the meter (enumeration measured worse than
  // sampling here, with or without bayes). Sampled worlds + weak Bayes
  // shrinkage (the sampled regime is where the prior helps; cf. bag1/2),
  // movegenBudget meter with challenger budget allocated by sequential
  // halving — parameter-free, and it beat the campaign-tuned minWorlds-11
  // retirement (1.25 vs 1.33 on the v5 385-position benchmark; the tuned
  // retirement depth had been the campaign's star knob, which is exactly
  // the tuning surface halving deletes). playoutDefense/playoutTemp
  // measured worse under the meter (reply quality trades against world
  // count and loses). Pre-campaign config 2.27, static 3.51; p99 ~1s.
  bag3: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 100, candidates: 8, alloc: 'halving', bayes: 1, overruleP: 0.62, priorSd: 9, movegenBudget: 95000, scoreAware: 0 },
  // bag4: C(11,4)=330 worlds — sampled under the movegenBudget meter
  // (which carries the per-blank surcharge this stage forced: bag4's
  // blank-heavy pools ran 17s decisions before generated-move charging
  // was made work-proportional). Challenger budget by sequential halving;
  // bayes OFF — the first sampled stage where prior shrinkage measured
  // harmful even at wide priorSd (the bag3 law inverts). egMidBlend 0.6:
  // the first stage where the midgame leave dominates the mix (the
  // endgame is four draws away). Greedy playouts (defense/temp negative
  // under the meter, fourth campaign running). Scored against the v7
  // all-policy oracle (information-legal defense-3 playouts x 300
  // worlds, 333 positions, p99 <= 1100ms required): regret
  // 2.62/decision at 55% optimal, p99 ~1000ms (pre-campaign config
  // 4.62 / 47%; static 7.70 / 38%).
  bag4: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 100, candidates: 7, alloc: 'halving', bayes: 0, egMidBlend: 0.6, movegenBudget: 70000, scoreAware: 0 },
  // bag5: C(12,5)=792 worlds, sampled under the meter. Same campaign
  // shape as bag4 (halving allocation, bayes off, greedy playouts) with
  // the cross-bag trends continuing on schedule: egMidBlend up again
  // (0.6 -> 0.7 — the endgame keeps receding), candidates steady at 7,
  // budget 85k (95k is worth another 0.23 regret whenever the latency
  // contract loosens past ~1200ms). Scored against the v7 all-policy
  // oracle (401 positions, p99 <= 1100ms required): regret 3.03/decision
  // at 54% optimal, p99 ~1060ms (pre-campaign 3.96 / 50%; static 6.75).
  bag5: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 100, candidates: 7, alloc: 'halving', bayes: 0, egMidBlend: 0.7, movegenBudget: 85000, scoreAware: 0 },
  // bag6: C(13,6)=1716 worlds, sampled under the meter. Campaign shape
  // as bag4/5 (halving, bayes off, greedy playouts); the cross-bag trends
  // continue — candidates step down 7 -> 6 (the pre-campaign wisdom that
  // deep bags concentrate best-move mass returns, gently: 5 is too few),
  // egMidBlend up again (0.7 -> 0.8), budget at an interior optimum 95k
  // (98k measured worse, not just slower). Scored against the v7
  // all-policy oracle (416 positions, p99 <= 1100ms required): regret
  // 2.84/decision at 51% optimal, p99 ~1070ms (pre-campaign 4.30 / 46%;
  // static 5.37 — note the static gap narrows as bags deepen).
  bag6: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 100, candidates: 6, alloc: 'halving', bayes: 0, egMidBlend: 0.8, movegenBudget: 95000, scoreAware: 0 },
  // bag7: C(14,7)=3432 worlds, the longest rollouts of any band, and the
  // midgame boundary — where two cross-bag laws invert back: BAYES
  // RETURNS (off measured 0.5 worse; the neighboring bagGt7 stage lives
  // on the same prior machinery) with priorSd 16 right where the
  // priorSd-tracks-world-count law puts its ~20-world regime, and
  // egMidBlend goes fully inert (auto; the knob's arc across bags ends
  // at "doesn't matter"). Candidates step down again to 5. Horizon mode
  // decisively rejected (4.56 vs 2.38 — terminal playouts rule to the
  // border; a 2-ply horizon never reaches the endgame where the value
  // lives). Budget 105k over 108k for tail margin: 108k's p99 band
  // straddles 1100ms for +0.08 regret. Scored against the v7 all-policy
  // oracle (400 positions, p99 <= 1100ms required): regret 2.38/decision
  // at 58% optimal, p99 ~1070ms (pre-campaign 3.39 / 53%; static 4.07).
  bag7: { ...SIM_BASE, static: false, mode: 'terminal', enumerate: false, samples: 100, candidates: 5, alloc: 'halving', bayes: 1, overruleP: 0.62, priorSd: 16, movegenBudget: 105000, scoreAware: 0 },
  // bagGt7 (deep bag): value each world by a 2-ply horizon (score + leave
  // diff), worlds funded by the movegenBudget meter (horizon reply scans
  // charge it, blank surcharge included) with sequential-halving
  // allocation over 6 candidates. The metered-halving campaign's verdict
  // was a LATENCY win, not a regret win: on the full 3,008-position
  // oracle benchmark it ties the old unmetered 40-world config (0.323 vs
  // 0.331 regret, 81% agreement) while halving the tail — p99 1951ms ->
  // 1055ms. Under halving, margin pruning and the bayes gate's
  // parameters measured inert (P 0.62 vs 0.7 and priorSd 12 vs 16 flip
  // nothing; the allocator dominates); the P>0.7 overrule gate itself
  // remains the selection rule. Earlier decision-rule history: Bayesian
  // overrule replaced the z=1.5 gate (0.48 vs 0.69 on the contested
  // bench); the threshold optimum is interior (P<=0.6 worse).
  bagGt7: { ...SIM_BASE, mode: 'horizon', samples: 100, candidates: 6, alloc: 'halving', movegenBudget: 135000, bayes: 1, overruleP: 0.7 },
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
  lastArmEvals: null, // per-arm { sig, mean, alive, staticVal } of the last sim
  lastChosenSig: null,
};

// Canonical arm signature: placements sorted by square, or the sorted
// exchange tileset — stable across engines evaluating the same position,
// so an oracle's arm list can be matched against another config's choice.
function armSig(a) {
  if (!a.move) return 'x:' + a.tiles.map(t => (t.isBlank ? '?' : t.letter.toUpperCase())).sort().join('');
  return a.placements.map(p => p.row + ',' + p.col + ':' + (p.isBlank ? '?' : '') + p.letter.toUpperCase()).sort().join('|');
}

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

// Zobrist hashing for the endgame transposition table: one random pair
// per (square, letter code, blankness), from a fixed seed so the engine
// stays deterministic. The running hash is XOR-updated by the board
// mutators (self-inverse, so apply/remove pairs cancel exactly) and
// recomputed from scratch at each endgame decision entry — game-flow
// code mutates state.board directly, so the incremental value is only
// trusted within one search.
const EG_Z = (() => {
  const rng = seededRng(0xe9dbe11);
  const lo = new Int32Array(225 * 54);
  const hi = new Int32Array(225 * 54);
  for (let i = 0; i < lo.length; i++) {
    lo[i] = (rng() * 0x100000000) | 0;
    hi[i] = (rng() * 0x100000000) | 0;
  }
  return { lo, hi };
})();
let egHashLo = 0, egHashHi = 0;
function egCellIndex(r, c, cell) {
  const code = cell.isBlank ? 26 : cell.letter.toUpperCase().charCodeAt(0) - 65;
  return (r * 15 + c) * 54 + code * 2 + (cell.isBlank ? 1 : 0);
}
function egRecomputeBoardHash() {
  egHashLo = 0; egHashHi = 0;
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = state.board[r][c];
      if (cell) {
        const i = egCellIndex(r, c, cell);
        egHashLo ^= EG_Z.lo[i];
        egHashHi ^= EG_Z.hi[i];
      }
    }
  }
}

function applyToBoard(placements) {
  for (const p of placements) {
    const cell = { letter: p.letter, isBlank: p.isBlank, displayLetter: p.letter };
    state.board[p.row][p.col] = cell;
    const i = egCellIndex(p.row, p.col, cell);
    egHashLo ^= EG_Z.lo[i];
    egHashHi ^= EG_Z.hi[i];
  }
}

function removeFromBoard(placements) {
  for (const p of placements) {
    const cell = state.board[p.row][p.col];
    if (!cell) continue; // abort paths restore the board wholesale first
    const i = egCellIndex(p.row, p.col, cell);
    egHashLo ^= EG_Z.lo[i];
    egHashHi ^= EG_Z.hi[i];
    state.board[p.row][p.col] = null;
  }
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
    const moves = valueOrdered(allMovesSorted(racks[side], budget), racks[side], racks[1 - side]);
    const m = moves.find(x => x.score > 0) || null;
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
// Per-decision transposition table (STAGES.bag0.tt = 1): keyed by board
// hash + both rack multisets + pass count, storing fail-soft values with
// their remaining depth and bound flag (0 exact, 1 lower, 2 upper). An
// entry is reusable when it was computed with at least the remaining
// depth the probing node needs. Hits cost no budget — the meter charges
// move generation, and a hit replaces one. Interleaved lines (my A/C
// around the same reply) transpose heavily on exactly the open boards
// where the meter binds, so the table converts revisits into effective
// depth on the p99-hard positions.
let EG_TT = null;
function egRackKey(rack) {
  const codes = rack.map(t => (t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65));
  codes.sort((a, b) => a - b);
  return codes.join('.');
}

function endgameSearch(myRack, oppRack, passes, ply, alpha, beta, budget) {
  if (passes >= 2) return rackValueOf(oppRack) - rackValueOf(myRack);
  // Out of budget before this node could be evaluated: abandon the whole
  // search rather than return a distorted value. Returning the pessimistic
  // both-stuck estimate here would systematically overvalue moves whose
  // reply subtree got truncated, and could pick worse than greedy — so we
  // unwind to findBestEndgameMove, which falls back to the greedy move.
  if (budget.used >= STAGES.bag0.movegenBudget) throw ENDGAME_ABORT;
  // depth 0/unset = uncapped: search to the game's true end (double-pass
  // or going out). A positive cap re-enables the greedy-rollout frontier,
  // kept only as an experiment knob — every measurement since the
  // transposition table landed says terminal search dominates at prod
  // budgets.
  const depth = STAGES.bag0.depth || Infinity;
  const remaining = Math.max(0, depth - ply);
  let ttKey = null;
  if (EG_TT) {
    ttKey = egHashLo + ',' + egHashHi + '|' + egRackKey(myRack) + '|' + egRackKey(oppRack) + '|' + passes;
    const e = EG_TT.get(ttKey);
    if (e && e.r >= remaining) {
      if (e.f === 0) return e.v;
      if (e.f === 1 && e.v >= beta) return e.v;
      if (e.f === 2 && e.v <= alpha) return e.v;
    }
  }
  const ttStore = v => {
    if (EG_TT) {
      const f = v >= beta ? 1 : v <= alpha ? 2 : 0;
      EG_TT.set(ttKey, { v, r: remaining, f });
    }
    return v;
  };
  if (ply >= depth) {
    // Rollouts complete even if they overshoot the budget slightly — a
    // partial rollout would be meaningless — but their true cost counts.
    return ttStore(greedyRolloutMargin(myRack, oppRack, passes, budget));
  }

  // Per-ply beam widths: width1 (ply 1) and width2 (ply 2) default to
  // width. Early-ply misses feed root values nearly undamped, and
  // shallow nodes are the ones the transposition table deduplicates
  // least.
  const w = ply === 1 ? (STAGES.bag0.width1 || STAGES.bag0.width)
    : ply === 2 ? (STAGES.bag0.width2 || STAGES.bag0.width)
    : STAGES.bag0.width;
  const moves = valueOrdered(allMovesSorted(myRack, budget), myRack, oppRack)
    .slice(0, w);
  let best = -Infinity;
  for (const m of moves) {
    const newRack = rackWithout(myRack, m.placements);
    let val;
    if (newRack.length === 0) {
      val = m.score + 2 * rackValueOf(oppRack); // going out ends the game
    } else {
      applyToBoard(m.placements);
      // Child window in the child's frame: val = m.score - child, so
      // val in (max(alpha,best), beta) <=> child in (m.score - beta,
      // m.score - max(alpha,best)). Omitting the m.score shift (plain
      // negamax -beta/-alpha) misaligns every finite window: a child
      // fail-high bound then lands above the parent's alpha and gets
      // maxed in as if exact, inflating values by up to m.score.
      val = m.score - endgameSearch(oppRack, newRack, 0, ply + 1, m.score - beta, m.score - Math.max(alpha, best), budget);
      removeFromBoard(m.placements);
    }
    if (val > best) best = val;
    if (best >= beta) return ttStore(best);
  }

  // Passing is always legal (and occasionally best, e.g. to avoid
  // opening the only out-spot for the opponent).
  const passVal = -endgameSearch(oppRack, myRack, passes + 1, ply + 1, -beta, -Math.max(alpha, best), budget);
  return ttStore(Math.max(best, passVal));
}

// First-order endgame leave model: the fitted margin VALUE of keeping
// each tile (A..Z, blank last) at bag 0 — same sense as the midgame
// leave model: higher = better to hold. Regressed from the bag0 oracle
// DB's per-move reference values with per-position intercepts absorbed
// (tools/fit-endgame-leaves.js). Face-value deadwood is a poor proxy:
// Endgame leave model, loaded from endgame-leaves.json.gz (see
// tools/fit-endgame-leaves.js --out; embedded-script fallback for
// file://). values/pairs: the interior evaluator, fit blind to the
// board; boardValues/boardPairs: the order-2 root evaluator, fit
// jointly with playability buckets so buckets + pairs double-count
// nothing. Until installed, endgameStaticValue falls back to
// face-value deadwood.
let EG_LEAVE_VALUES = null;
let EG_LEAVE_PAIRS = null;
let EG_LEAVE_BOARD_VALUES = null;
let EG_LEAVE_BOARD_PAIRS = null;
const EG_PAIR_IDX = (a, b) => (a <= b ? b * (b + 1) / 2 + a : a * (a + 1) / 2 + b);
function endgameLeavePairSum(leave, table) {
  let s = 0;
  for (let i = 0; i < leave.length; i++) {
    const a = leave[i].isBlank ? 26 : leave[i].letter.toUpperCase().charCodeAt(0) - 65;
    for (let j = i + 1; j < leave.length; j++) {
      const b = leave[j].isBlank ? 26 : leave[j].letter.toUpperCase().charCodeAt(0) - 65;
      s += table[EG_PAIR_IDX(a, b)];
    }
  }
  return s;
}



// Counts-vector form of the interior endgame evaluator (singles + pair
// terms), for callers that hold rack counts rather than tile arrays.
function endgameLeaveValueFromCounts(counts) {
  if (!EG_LEAVE_VALUES) return null;
  let s = 0;
  for (let a = 0; a < 27; a++) {
    const na = counts[a];
    if (na <= 0) continue;
    s += na * EG_LEAVE_VALUES[a];
    if (EG_LEAVE_PAIRS) {
      if (na > 1) s += (na * (na - 1) / 2) * EG_LEAVE_PAIRS[EG_PAIR_IDX(a, a)];
      for (let b = a + 1; b < 27; b++) {
        if (counts[b] > 0) s += na * counts[b] * EG_LEAVE_PAIRS[EG_PAIR_IDX(a, b)];
      }
    }
  }
  return s;
}

// Draw-aware endgame leave: E[ endgameLeave(leave + one drawn tile) ]
// over the unseen pool — the bagAwareLeaveValue construction with the
// endgame model. First-order like its midgame sibling (one draw priced
// even when the real refill is larger); prices partner-completion (the
// pool's last U rescuing a kept Q) that the as-is leave cannot see.
function egBagAwareLeaveValue(counts, unseen, total) {
  let ev = 0;
  for (let t = 0; t < 27; t++) {
    const u = unseen[t];
    if (u <= 0) continue;
    counts[t]++;
    ev += u * endgameLeaveValueFromCounts(counts);
    counts[t]--;
  }
  return ev / total;
}

function endgameLeaveValue(leave) {
  if (!EG_LEAVE_VALUES) return -rackValueOf(leave); // model not loaded: face deadwood
  let s = 0;
  for (const t of leave) s += EG_LEAVE_VALUES[t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65];
  if (EG_LEAVE_PAIRS && leave.length > 1) s += endgameLeavePairSum(leave, EG_LEAVE_PAIRS);
  return s;
}

// Static endgame value of a single play, consistent with the search's own
// terminal rules: going out banks twice the opponent's rack (endGame credits
// it to the finisher and deducts it from the opponent — exact rule
// arithmetic, face values); otherwise the kept tiles are priced by the
// trained keep costs above, not their faces. The opponent's rack is
// constant across the move choice, so it only matters in the go-out
// branch. Ranks the greedy fallback on budget abort, and — under
// order 1 — the root, the interior beam, and the rollout policy.
function endgameStaticValue(move, leave, oppRack) {
  if (leave.length === 0) return move.score + 2 * rackValueOf(oppRack);
  return move.score + endgameLeaveValue(leave);
}

// Installs the fitted endgame leave model (format v1: values, pairs,
// boardValues, boardPairs — see tools/fit-endgame-leaves.js).
function installEndgameLeaves(data) {
  if (!data || data.v !== 1) throw new Error('endgame-leaves: unsupported format');
  EG_LEAVE_VALUES = data.values;
  EG_LEAVE_PAIRS = data.pairs;
  EG_LEAVE_BOARD_VALUES = data.boardValues;
  EG_LEAVE_BOARD_PAIRS = data.boardPairs;
}

// Best-effort load, mirroring the superleave chain: fetch first (skipped
// on file://), embedded data script as fallback.
async function loadEndgameLeaves() {
  try {
    if (!IS_FILE_URL) {
      try {
        const resp = await fetch('endgame-leaves.json.gz');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
        installEndgameLeaves(JSON.parse(await new Response(stream).text()));
        return;
      } catch (fetchErr) {
        installEndgameLeaves(JSON.parse(await (await loadEmbeddedGz('endgame-leaves.data.js', 'EG_LEAVES_B64')).text()));
        return;
      }
    }
    installEndgameLeaves(JSON.parse(await (await loadEmbeddedGz('endgame-leaves.data.js', 'EG_LEAVES_B64')).text()));
  } catch (e) {
    // Endgame plays on face-value deadwood without the model.
  }
}

// Distinct board locations each leave tile can occupy in a legal play
// using only the leave, on the current board. One movegen, budget-counted.
function leaveBoardCounts(leave, budget) {
  const locs = Array.from({ length: 27 }, () => new Set());
  for (const mv of allMovesSorted(leave, budget)) {
    for (const p of mv.placements) {
      locs[p.isBlank ? 26 : p.letter.toUpperCase().charCodeAt(0) - 65].add(p.row * 15 + p.col);
    }
  }
  return locs.map(s => s.size);
}

// Under order 1, re-sort a move list by static endgame value (stable:
// ties keep the incoming score order). Identity under order 0.
function valueOrdered(moves, rack, oppRack) {
  if (STAGES.bag0.order < 1) return moves;
  return moves
    .map(m => ({ m, v: endgameStaticValue(m, rackWithout(rack, m.placements), oppRack) }))
    .sort((a, b) => b.v - a.v)
    .map(x => x.m);
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
  EG_TT = STAGES.bag0.tt ? new Map() : null;
  if (EG_TT) egRecomputeBoardHash();
  const moves = allMovesSorted(rack, budget);
  if (moves.length === 0) return null;
  // order 1: evaluate roots in static-endgame-value order (score minus
  // kept deadwood, going-out credit included) instead of raw score. Prices
  // tile-unloading — the Q-dump scoring 6 outranks a 15-point move that
  // keeps the Q — so the best-first budget (and the width0 cut) spend on
  // plausible endgame moves, not just high scorers. Sort is stable: ties
  // keep score order, and determinism is preserved.
  // Root candidate selection. Each mode produces (move, value) pairs in
  // its own ordering currency: raw score (order 0), static endgame value
  // (order 1), or two-stage board-aware value (order 2 — stage 1 orders
  // by flat static value for free, stage 2 reprices only the top
  // 2*width0 candidates against their post-move boards so the cost is
  // bounded by the cut size, not the legal-move count). width0 caps how
  // many survive. The abort fallback still sees every move.
  let scored;
  if (STAGES.bag0.order === 2 && EG_LEAVE_BOARD_VALUES) {
    const flatScored = moves
      .map(mv => ({ mv, v: endgameStaticValue(mv, rackWithout(rack, mv.placements), oppRack) }))
      .sort((a, b) => b.v - a.v);
    const K = STAGES.bag0.width0 > 0 ? Math.min(flatScored.length, 2 * STAGES.bag0.width0) : flatScored.length;
    const cap = EG_LEAVE_BOARD_VALUES[0].length - 1;
    const repriced = flatScored.slice(0, K).map(({ mv, v: flatV }) => {
      // The meter governs ordering too: once spent, remaining candidates
      // keep their stage-1 flat value — the budget is a latency contract,
      // and pricing is not exempt from it.
      if (budget.used >= STAGES.bag0.movegenBudget) return { mv, v: flatV };
      const leave = rackWithout(rack, mv.placements);
      let v;
      if (leave.length === 0) {
        v = mv.score + 2 * rackValueOf(oppRack);
      } else {
        applyToBoard(mv.placements);
        try {
          const counts = leaveBoardCounts(leave, budget);
          v = mv.score;
          for (const t of leave) {
            const cd = t.isBlank ? 26 : t.letter.toUpperCase().charCodeAt(0) - 65;
            v += EG_LEAVE_BOARD_VALUES[cd][Math.min(counts[cd], cap)];
          }
          if (EG_LEAVE_BOARD_PAIRS && leave.length > 1) v += endgameLeavePairSum(leave, EG_LEAVE_BOARD_PAIRS);
        } finally {
          removeFromBoard(mv.placements);
        }
      }
      return { mv, v };
    }).sort((a, b) => b.v - a.v);
    scored = repriced.concat(flatScored.slice(K));
  } else if (STAGES.bag0.order === 1) {
    scored = moves
      .map(mv => ({ mv, v: endgameStaticValue(mv, rackWithout(rack, mv.placements), oppRack) }))
      .sort((a, b) => b.v - a.v);
  } else {
    scored = moves.map(mv => ({ mv, v: mv.score }));
  }
  if (STAGES.bag0.width0 > 0 && scored.length > STAGES.bag0.width0) {
    scored = scored.slice(0, STAGES.bag0.width0);
  }
  const rootMoves = scored.map(x => x.mv);

  // The reply search mutates the board and unwinds un-cleanly if it
  // aborts, so snapshot to restore the discarded move's placements.
  const boardSnapshot = state.board.map(r => r.slice());
  let bestMove = null;
  let bestVal = -Infinity;
  for (const m of rootMoves) {
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
// Generated-move count of the most recent static scan — the terminal
// meter's cost proxy for playout plies that route through the scanner.
let EG_SCAN_MOVE_COUNT = 0;

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
  let genCount = 0;
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
      genCount += moves.length;
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
            const mid = unseenTotal > 0
              ? bagAwareLeaveValue(rackCounts, unseenCounts, unseenTotal)
              : leaveValueFromCounts(rackCounts);
            // Endgame side of the mix: draw-aware (pool expectation of the
            // post-draw leave) while tiles remain to draw; as-is at bag 0.
            const eg = (leaveScale < 1 && EG_LEAVE_VALUES)
              ? (leaveScale > 0 && unseenTotal > 0
                  ? egBagAwareLeaveValue(rackCounts, unseenCounts, unseenTotal)
                  : endgameLeaveValueFromCounts(rackCounts))
              : null;
            if (eg !== null) {
              // Convex mix, split by the current bag count's stage. The
              // auto split uses the POST-DRAW bag count of this specific
              // move — a 2-tile play at bag 2 leads to a pure endgame and
              // is priced as one, while a 1-tile play at the same rack
              // keeps a tile of midgame future. (Pinned egMidBlend values
              // are move-independent by definition.)
              const postScale = Math.min(1, Math.max(0, state.bag.length - codes.length) / 7);
              const cfgBlend = STAGES[stageFor(state.bag.length)].egMidBlend;
              const mShare = cfgBlend >= 0 ? cfgBlend : postScale;
              lv = mShare * mid + (1 - mShare) * eg;
            } else {
              // Legacy (endgame model absent): damped midgame only, at
              // the same per-move post-draw scale.
              lv = Math.min(1, Math.max(0, state.bag.length - codes.length) / 7) * mid;
            }
            for (const c of codes) rackCounts[c]++;
            leaveCache.set(key, lv);
          }
          val += lv;
        }
        if (ditherRng) val += evalDither * (ditherRng() * 2 - 1);
        onMove(m, val);
      }
    }
  }
  EG_SCAN_MOVE_COUNT = genCount;
}

// Static play, exchange included: the best move by static value, unless
// exchanging (score 0 plus the leave of the best keep — undamped, since
// exchanges require bag >= 7) statically outranks it. Ties keep the move,
// matching the joint ranking's stable order. This is findBestSimMove at
// candidates=1 with no simulation. Distinct from findBestStaticMove,
// which is move-only and remains the in-simulation opponent model.
async function findBestStaticPlay(rack) {
  let bestVal = -Infinity;
  let bestMove = null;
  await scanStaticMoves(rack, (m, val) => {
    if (val > bestVal) { bestVal = val; bestMove = m; }
  });
  const exchange = state.bag.length >= 7 ? bestExchangeKeep(rack) : null;
  if (exchange && exchange.value > bestVal) return { exchange: true, tiles: exchange.tiles };
  return bestMove;
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
  return all.slice(0, Math.min(cfg.candidates, all.length));
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
async function simPlayoutValue(moveScore, myKeptTiles, world, oppSize, meter) {
  let margin = moveScore;
  // Stochastic replies: the rng is seeded from the WORLD alone, so every
  // candidate evaluated against this world sees the same reply randomness
  // (common random numbers — paired comparisons stay low-variance).
  let rng = null;
  if (PLAYOUT_TEMP > 0) {
    let h = 0x811c9dc5;
    for (const t of world) { h ^= (t.isBlank ? 26 : t.letter.charCodeAt(0)); h = Math.imul(h, 0x01000193); }
    rng = seededRng((h ^ oppSize) >>> 0);
  }
  const defense = PLAYOUT_DEFENSE > 0;
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
    let mv;
    let gen = 0; // generated moves this ply — the meter's cost unit
    if (bagArr.length === 0) {
      // Endgame-aware playout policy: with the bag empty this playout IS
      // an endgame, so pick by trained endgame value (score + leave +
      // go-out credit) instead of the raw-score greed the midgame leave
      // scaling degenerates to. Same substitution that carried the bag0
      // campaign: trained static values over raw score. Zero/low-score
      // deadwood dumps become choosable; termination is guaranteed by
      // tile consumption and the ply guard.
      const other = side === 1 ? myRack : oppRack;
      let bv = -Infinity;
      mv = null;
      const gens = allMovesSorted(mover, { used: 0 });
      gen = gens.length;
      if ((rng || defense) && gens.length > 1) {
        // Game-ending moves (rack empties, bag empty) have EXACT values —
        // zero estimation noise — so a dominated one has zero probability
        // of being best: keep only the best terminal move, and let it
        // compete with the (noisy) continuing estimates.
        const cand = [], vals = [];
        let bt = null, btv = -Infinity;
        for (const m of gens) {
          const leave = rackWithout(mover, m.placements);
          const v = endgameStaticValue(m, leave, other);
          if (leave.length === 0) { if (v > btv) { btv = v; bt = m; } }
          else { cand.push(m); vals.push(v); }
        }
        if (defense && cand.length && PLAYOUT_DEFENSE >= 2) {
          // Full two-ply: refine the top continuing moves by the responder's
          // best endgame-value answer on the resulting board. Terminal moves
          // are already exact and get no response.
          const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 8);
          for (const [v, i] of order) {
            const m = cand[i];
            applyToBoard(m.placements);
            const myLeave = rackWithout(mover, m.placements);
            let rv = 0, rbest = -Infinity;
            const rgens = allMovesSorted(other, { used: 0 });
            gen += rgens.length;
            for (const rm of rgens) {
              const x = endgameStaticValue(rm, rackWithout(other, rm.placements), myLeave);
              if (x > rbest) rbest = x;
            }
            if (rbest > -Infinity) rv = rbest;
            removeFromBoard(m.placements);
            vals[i] = v - rv;
          }
          const kept = order.map(([, i]) => i);
          const cand2 = kept.map(i => cand[i]), vals2 = kept.map(i => vals[i]);
          if (bt) { cand2.push(bt); vals2.push(btv); }
          mv = cand2.length > 1 && rng ? cand2[softmaxPick(rng, vals2, PLAYOUT_TEMP)]
            : cand2[vals2.indexOf(Math.max(...vals2))];
        } else if (defense && cand.length && other.length <= 4) {
          // Out-defense: price only the responder's game-ending answers,
          // and only once their rack is short enough that an out is a live
          // threat (longer-rack outs are bingo-rare; skipping them keeps
          // the early playout plies at one-ply cost). One pre-scan tells
          // whether any out exists; if none, one-ply values stand.
          let hasOut = false;
          const rgens0 = allMovesSorted(other, { used: 0 });
          gen += rgens0.length;
          for (const rm of rgens0) {
            if (rm.placements.length === other.length) { hasOut = true; break; }
          }
          if (hasOut) {
            const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 8);
            for (const [v, i] of order) {
              const m = cand[i];
              applyToBoard(m.placements);
              const myLeave = rackWithout(mover, m.placements);
              let rbest = 0; // blocked out -> no terminal punishment
              const rgens = allMovesSorted(other, { used: 0 });
              gen += rgens.length;
              for (const rm of rgens) {
                if (rm.placements.length !== other.length) continue;
                const x = endgameStaticValue(rm, rackWithout(other, rm.placements), myLeave);
                if (x > rbest) rbest = x;
              }
              removeFromBoard(m.placements);
              vals[i] = v - rbest;
            }
          }
          if (bt) { cand.push(bt); vals.push(btv); }
          mv = cand.length > 1 && rng ? cand[softmaxPick(rng, vals, PLAYOUT_TEMP)]
            : cand[vals.indexOf(Math.max(...vals))];
        } else {
          if (bt) { cand.push(bt); vals.push(btv); }
          mv = cand.length > 1 && rng ? cand[softmaxPick(rng, vals, PLAYOUT_TEMP)]
            : cand.length ? cand[vals.indexOf(Math.max(...vals))] : null;
        }
      } else {
        for (const m of gens) {
          const v = endgameStaticValue(m, rackWithout(mover, m.placements), other);
          if (v > bv) { bv = v; mv = m; }
        }
      }
    } else {
      if (rng || defense) {
        const cs = await collectTopCandidates(mover, { candidates: 8, margin: 0 });
        gen = EG_SCAN_MOVE_COUNT;
        if (cs.length && PLAYOUT_DEFENSE === 2) {
          const other2 = side === 1 ? myRack : oppRack;
          for (const c of cs) {
            applyToBoard(c.m.placements);
            let rv = 0;
            try {
              const resp = await collectTopCandidates(other2, { candidates: 1, margin: 0 });
              gen += EG_SCAN_MOVE_COUNT;
              rv = resp.length ? resp[0].val : 0;
            } finally { removeFromBoard(c.m.placements); }
            c.val2 = c.val - rv;
          }
        } else {
          for (const c of cs) c.val2 = c.val;
        }
        mv = cs.length ? cs[cs.length > 1 && rng ? softmaxPick(rng, cs.map(c => c.val2), PLAYOUT_TEMP)
            : cs.reduce((bi, c, i, a) => c.val2 > a[bi].val2 ? i : bi, 0)].m
          : (state.bag.length >= 7 ? (k => k ? { exchange: true, tiles: k.tiles } : null)(bestExchangeKeep(mover)) : null);
      } else {
        mv = await findBestSimReply(mover);
        gen = EG_SCAN_MOVE_COUNT;
      }
    }
    if (meter) {
      // 10 ~ fixed per-scan overhead. Blank surcharge: the meter's unit is
      // GENERATED moves, but a blank multiplies scan WORK ~26x per anchor
      // while often generating few extra moves — double-blank racks
      // measured ~5 units/ms against the ~30-80 calibration (a 17s
      // decision under a 95k meter). 300 units per mover blank per ply
      // restores work-proportional charging on exactly those racks.
      let bl = 0;
      for (const t of mover) if (t.isBlank) bl++;
      meter.used += 10 + gen + 300 * bl;
    }
    if (!mv) {
      // True pass: no move and no exchange possible. Board and rack are
      // unchanged, so two in a row is a genuine deadlock (the real game's
      // 6-pass rule exists for players; nothing here can change state).
      if (++passes >= 2) {
        margin += rackValueOf(oppRack) - rackValueOf(myRack);
        break;
      }
    } else if (mv.exchange) {
      // Stuck rack exchanges: refill from the world's fixed draw order,
      // discards rejoin at the end (they cannot be redrawn immediately).
      // Progress is made — racks change — so the deadlock counter resets;
      // the ply guard bounds pathological exchange chains.
      passes = 0;
      const kept = rackWithout(mover, mv.tiles);
      while (kept.length < 7 && bagArr.length > 0) kept.push(bagArr.shift());
      for (const t of mv.tiles) bagArr.push(t);
      if (side === 1) oppRack = kept; else myRack = kept;
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
let PLAYOUT_TEMP = 0;     // active stage's playoutTemp during a sim
let PLAYOUT_DEFENSE = 0;  // active stage's playoutDefense during a sim

// Sample index i with probability softmax(vals[i] / T) over the given
// candidates (vals aligned with items).
function softmaxPick(rng, vals, T) {
  let vmax = -Infinity;
  for (const v of vals) if (v > vmax) vmax = v;
  let sum = 0;
  const ws = vals.map(v => { const w = Math.exp((v - vmax) / T); sum += w; return w; });
  let u = rng() * sum;
  for (let i = 0; i < ws.length; i++) { u -= ws[i]; if (u <= 0) return i; }
  return ws.length - 1;
}

// In-simulation reply policy: fast static play, plus the correction any
// competent player makes — with no legal move and a bag that allows it,
// exchange the worst tiles (bestExchangeKeep) rather than pass. A pass
// with seven tiles and a live bag is not a behavior real opponents
// exhibit, and modeling it distorts exactly the worlds where a candidate
// blocks the opponent out of a move. Voluntary exchanges (a legal move
// exists but the keep is statically better) stay out of the reply policy:
// that is a modeling-fidelity experiment with a per-reply-per-world cost,
// not a correctness fix.
async function findBestSimReply(rack) {
  const mv = await findBestStaticMove(rack);
  if (mv) return mv;
  const exchange = state.bag.length >= 7 ? bestExchangeKeep(rack) : null;
  return exchange ? { exchange: true, tiles: exchange.tiles } : null;
}

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
// a candidate like any move: it scores zero, touches no board cells, and
// redraws from the sampled world. It is ranked jointly with the move
// candidates by static value (0 + the damped pool-aware leave of its
// keep) and competes for a simulation slot under the same top-K and
// margin rules — no guaranteed seat, so the common case (a good move
// exists, the exchange is statically hopeless) costs nothing to dismiss.
async function findBestSimMove(rack, cfg) {
  const cands = await collectTopCandidates(rack, cfg);
  const exchange = state.bag.length >= 7 ? bestExchangeKeep(rack) : null;
  if (cands.length === 0) {
    // No legal move: exchange beats passing whenever it is allowed.
    return exchange ? { exchange: true, tiles: exchange.tiles } : null;
  }

  // Arms in static order; arm 0 (the incumbent the gates protect) is
  // whichever option ranks first, exchange included. staticVal is the
  // static score+leave that ranked the arm; the Bayesian overrule uses it
  // as the prior mean. The exchange joins the ranking at its own static
  // value and must survive the same top-K cut and margin prune as the
  // moves (the earlier move-only prune in collectTopCandidates stays
  // valid: anything it dropped is at least as far behind the merged
  // leader as it was behind the best move).
  const leaveScale0 = Math.min(1, state.bag.length / 7);
  const arms = cands.map(c => ({
    move: c.m, placements: c.m.placements, score: c.m.score,
    kept: rackWithout(rack, c.m.placements), staticVal: c.val,
  }));
  if (exchange) {
    arms.push({ move: null, placements: null, score: 0, kept: exchange.keep,
      tiles: exchange.tiles, staticVal: leaveScale0 * exchange.value });
    arms.sort((a, b) => b.staticVal - a.staticVal);
    if (arms.length > cfg.candidates) arms.length = cfg.candidates;
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
  // A world has TWO chance stages: which pool tiles are in the bag (the
  // split), and the order they come out (the draw). At bag >= 3 each
  // split expands into every permutation of its bag tiles, all equally
  // likely, so the world list is exactly uniform over (split, draw
  // order); repeated permutations of duplicate letters are kept —
  // equal-weight replication is what keeps the uniform average correct
  // without weighting machinery. (One pool-order draw per split is exact
  // over splits but a deterministic, biased sample of draws; sampling
  // beat that form at bag3.) At bag <= 2 the expansion is NOT applied:
  // most plays there consume the whole bag, so order-duplicates would
  // halve the metered prefix's split coverage — measured 1.81 vs 1.27
  // on the bag2 benchmark. Single pool-order worlds, as always.
  const permCount = realBag.length >= 3 ? ([6, 24][realBag.length - 3] || 0) : 1;
  if (cfg.enumerate && splitCount > 0 && permCount > 0 && splitCount * permCount <= cfg.samples) {
    const perms = tiles => {
      if (tiles.length <= 1) return [tiles];
      const out = [];
      for (let i = 0; i < tiles.length; i++) {
        for (const rest of perms(tiles.slice(0, i).concat(tiles.slice(i + 1)))) out.push([tiles[i]].concat(rest));
      }
      return out;
    };
    for (const bagIdx of indexSubsets(pool.length, realBag.length)) {
      const inBag = new Array(pool.length).fill(false);
      for (const k of bagIdx) inBag[k] = true;
      const opp = [], bagTiles = [];
      for (let k = 0; k < pool.length; k++) (inBag[k] ? bagTiles : opp).push(pool[k]);
      if (permCount === 1) worlds.push(opp.concat(bagTiles)); // opponent rack, then bag draw order
      else for (const order of perms(bagTiles)) worlds.push(opp.concat(order));
    }
    // Shuffle: enumeration yields worlds in a deterministic combinatorial
    // order, so a meter or retirement prefix would be a biased subset of
    // worlds. A seeded shuffle makes any prefix exchangeable.
    const rng = seededRng(positionHash(rack));
    for (let i = worlds.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [worlds[i], worlds[j]] = [worlds[j], worlds[i]];
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
  PLAYOUT_TEMP = cfg.playoutTemp || 0;
  PLAYOUT_DEFENSE = cfg.playoutDefense || 0;
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
  // probabilities, so the Bayesian overrule's point-calibrated prior
  // (priorSd) no longer applies: scoreAware is only meaningful with the
  // argmax rule (bayes 0), not cfg.bayes.
  const scoreAware = !!cfg.scoreAware;
  const myScoreMargin = state.computerScore - state.playerScore;
  const vals = Array.from({ length: K }, () => []); // vals[arm][world]
  const alive = new Array(K).fill(true);
  // Sequential halving schedule: cut points across the decision budget.
  const halving = cfg.alloc === 'halving';
  let roundCuts = null, roundIdx = 0;
  if (halving) {
    const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, K - 1))));
    roundCuts = [];
    for (let r = 1; r < rounds; r++) {
      roundCuts.push(cfg.movegenBudget > 0 ? cfg.movegenBudget * r / rounds : M * r / rounds);
    }
  }
  // Terminal-stage meter (see SIM_BASE.movegenBudget).
  const meter = { used: 0 };
  try {
    if (cfg.alloc === 'ucb' && toTerminal) {
      // Prior-gated paired UCB (see SIM_BASE.alloc). Posterior on the true
      // gap of arm ci vs the incumbent: prior N(staticGap, priorSd^2),
      // conjugate-updated with the paired diffs over ci's world prefix.
      const post = ci => {
        const n = vals[ci].length;
        const mu0 = arms[ci].staticVal - arms[0].staticVal;
        if (n === 0) return { p: normalCdf(mu0 / cfg.priorSd), n, mean: mu0, sd: cfg.priorSd };
        const priorPrec = 1 / (cfg.priorSd * cfg.priorSd);
        let sum = 0;
        for (let w = 0; w < n; w++) sum += vals[ci][w] - vals[0][w];
        const mbar = sum / n;
        let ss = 0;
        for (let w = 0; w < n; w++) { const d = vals[ci][w] - vals[0][w] - mbar; ss += d * d; }
        const s2 = Math.max(n > 1 ? ss / (n - 1) : cfg.varFloor, cfg.varFloor);
        const postVar = 1 / (priorPrec + n / s2);
        const postMean = postVar * (mu0 * priorPrec + (n / s2) * mbar);
        return { p: normalCdf(postMean / Math.sqrt(postVar)), n, mean: postMean, sd: Math.sqrt(postVar) };
      };
      const evalArm = async (ci, w) => {
        const arm = arms[ci];
        if (arm.placements) applyToBoard(arm.placements);
        const margin = await simPlayoutValue(arm.score, arm.kept, worlds[w], oppSize, meter);
        if (arm.placements) removeFromBoard(arm.placements);
        vals[ci].push(scoreAware ? normalCdf((myScoreMargin + margin) / sigmaAtBag(realBag.length)) : margin);
      };
      while (true) {
        if (cfg.movegenBudget > 0 && meter.used >= cfg.movegenBudget) break;
        // Schedule by OPTIMISM (posterior upper bound), not by P(better):
        // an arm deep behind on statics has a low prior mean but a wide
        // posterior — its upper bound competes, so it earns worlds. Close
        // an arm only on evidence (>= 2 worlds), never on the prior alone.
        let best = -1, bestIdx = -Infinity;
        for (let ci = 1; ci < K; ci++) {
          if (!alive[ci]) continue;
          const { n, mean, sd } = post(ci);
          const idx = mean + 2 * sd;
          // Close only when the optimistic bound itself is dominated —
          // the same currency the scheduler ranks by. (Closing on the
          // posterior P(better) re-derives prior-closing at small n:
          // low-variance evidence can't move a deep prior in 2 worlds.)
          if (n >= 2 && idx < 0) { alive[ci] = false; continue; }
          if (n >= M) continue; // world stream exhausted for this arm
          if (idx > bestIdx) { bestIdx = idx; best = ci; }
        }
        if (best === -1) break;
        const w = vals[best].length;
        if (vals[0].length <= w) await evalArm(0, w); // incumbent keeps pace lazily
        await evalArm(best, w);
      }
    } else
    // World-major so surviving candidates advance together and pruning
    // can retire hopeless challengers early; the meter cuts at candidate
    // boundaries with whole-world rollback so every candidate is judged
    // on the same worlds.
    for (let w = 0; w < M; w++) {
      const world = worlds[w];
      // Mid-world meter cutoff: checked before each playout, so the
      // overshoot is bounded by one playout, not one world. An aborted
      // world's partial contributions are rolled back below — every
      // candidate is always judged on identical complete worlds.
      const preLens = cfg.movegenBudget > 0 ? vals.map(v => v.length) : null;
      let worldAborted = false;
      for (let ci = 0; ci < K; ci++) {
        if (!alive[ci]) continue;
        if (preLens && meter.used >= cfg.movegenBudget) { worldAborted = true; break; }
        const arm = arms[ci];
        const myKept = arm.kept;
        if (arm.placements) applyToBoard(arm.placements);
        if (toTerminal) {
          // Near the endgame the sampled world is cheap to finish: play
          // it out and score the exact final margin — no horizon
          // heuristic, and the leave taper plays no evaluation role.
          const margin = await simPlayoutValue(arm.score, myKept, world, oppSize, meter);
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
        // cannot be redrawn immediately anyway). A stuck reply rack
        // exchanges rather than passes (findBestSimReply): score 0, no
        // board change, kept = rack minus discards — same accounting.
        state.bag = world.slice(cursor);
        const reply = await findBestMove(oppRack);
        // Horizon-world meter charge: the reply scan is the world's cost
        // (same units and blank surcharge as terminal playout plies).
        {
          let bl = 0;
          for (const t of oppRack) if (t.isBlank) bl++;
          meter.used += 10 + EG_SCAN_MOVE_COUNT + 300 * bl;
        }
        const rScore = reply && reply.placements ? reply.score : 0;
        const oppKept = reply ? rackWithout(oppRack, reply.placements || reply.tiles) : oppRack;
        const oppDrawStart = cursor;
        const oppDraw = Math.min(7 - oppKept.length, state.bag.length);

        // Fill the leaf eval rack to 6 tiles while the bag is comfortable
        // (>10) so it stays inside the superleave table's <=6 domain; fill
        // completely (7) near the bag end, where the realized rack matters
        // (7-tile vectors use the table's drop-one mean).
        const target = realBag.length > 10 ? 6 : 7;
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
        const dMargin = arm.score - rScore + horizon;
        const bagH = Math.max(0, state.bag.length - oppDraw);
        if (scoreAware) {
          // bagH is the horizon bag size with my turn to move — the
          // calibration's reference frame.
          vals[ci].push(winProbAtBag(myScoreMargin + dMargin, bagH));
        } else {
          vals[ci].push(dMargin);
        }
        if (arm.placements) removeFromBoard(arm.placements);
      }

      if (worldAborted) {
        for (let ci = 0; ci < K; ci++) vals[ci].length = preLens[ci];
        break;
      }
      const n = w + 1;
      if (halving) {
        // Cross any round boundaries reached this world (the meter can jump
        // past several) and halve the surviving challengers at each.
        const progress = cfg.movegenBudget > 0 ? meter.used : n;
        while (roundIdx < roundCuts.length && progress >= roundCuts[roundIdx]) {
          roundIdx++;
          const ranked = [];
          for (let ci = 1; ci < K; ci++) {
            if (alive[ci]) ranked.push([pairedStats(vals, ci, 0, n)[0], ci]);
          }
          if (ranked.length <= 1) continue;
          ranked.sort((a, b) => b[0] - a[0]);
          for (let r = Math.ceil(ranked.length / 2); r < ranked.length; r++) alive[ranked[r][1]] = false;
        }
        continue;
      }
    }
  } finally {
    inSimulation = false;
    PLAYOUT_TEMP = 0;
    PLAYOUT_DEFENSE = 0;
    state.bag = realBag;
    TRACE.lastMeterUsed = meter.used; // decision telemetry (cheap, always set)
    TRACE.lastWorldsDone = vals[0].length;
  }

  // The static choice (candidate 0) stays unless a surviving challenger
  // beats it: the candidates share worlds, so their per-world differences
  // form a paired sample. Under cfg.bayes the challenger must clear the
  // posterior threshold — the prior (centered on the static gap) and the
  // sampled uncertainty are already folded in, so no separate significance
  // gate is needed. Otherwise (terminal stages, whose few worlds average full or
  // near-full split enumerations) a positive paired mean suffices: argmax.
  // Meter floor: no world completed inside the budget — the static best
  // plays (the graceful minimum on pathologically expensive boards).
  if (vals[0].length === 0) return armResult(arms[0]);
  // Selection runs over the worlds actually completed — under the meter
  // that can be fewer than the planned M.
  const NW = vals[0].length;
  let bestIdx = 0;
  for (let ci = 1; ci < K; ci++) {
    if (!alive[ci]) continue;
    // Pair over the shared world prefix. Classic allocators evaluate every
    // arm on every completed world (nPair == NW); under 'ucb' challengers
    // hold prefixes of varying length, and an arm the scheduler never
    // funded has no evidence at all — the static prior alone cannot
    // overrule, so it is skipped.
    const nPair = Math.min(vals[ci].length, vals[bestIdx].length);
    if (nPair === 0) continue;
    if (cfg.bayes) {
      if (bayesProb(vals, ci, bestIdx, nPair) > cfg.overruleP) bestIdx = ci;
    } else {
      const [mean] = pairedStats(vals, ci, bestIdx, nPair);
      if (mean > 0) bestIdx = ci;
    }
  }
  if (TRACE.on) {
    TRACE.lastArmEvals = arms.map((a, ci) => ({
      sig: armSig(a),
      mean: vals[ci].length ? vals[ci].reduce((s, v) => s + v, 0) / vals[ci].length : null,
      alive: alive[ci],
      staticVal: a.staticVal,
    }));
    TRACE.lastChosenSig = armSig(arms[bestIdx]);
    const override = bestIdx !== 0;
    TRACE.lastOverride = override;
    TRACE.lastRank = bestIdx;
    TRACE.lastNArms = K;
    TRACE.lastGap = override ? arms[0].staticVal - arms[bestIdx].staticVal : 0;
    if (override) {
      const [mean, se] = pairedStats(vals, bestIdx, 0, Math.min(vals[bestIdx].length, NW));
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

// Solver-based pre-endgame policy. When the bag holds only a tile or two
// the unseen pool (opponent rack + bag) is small and known up to which tiles
// are in the bag, so we enumerate every such split exactly rather than sample:
// for each candidate move, play it, deal the drawn bag tiles, and score the
// resulting empty-bag position with the endgame solver; the move with the
// best probability-weighted final margin wins. Deterministic. Only candidates
// whose refill empties the bag (or that go out) are scored this way — at bag 2 a
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
  // Fresh transposition table for this decision: worlds differ by one
  // drawn tile and candidates share the pre-move board, so the solves
  // overlap heavily — the cross-world sharing that makes per-world
  // endgame valuation affordable. Keys carry the board hash, which must
  // be recomputed at entry (game flow mutates the board directly) and
  // after any abort restore (an aborted search leaves the incremental
  // hash out of sync).
  EG_TT = STAGES.bag0.tt ? new Map() : null;
  if (EG_TT) egRecomputeBoardHash();
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
            state.board = boardSnap; ok = false; // solve overran the cap
            if (EG_TT) egRecomputeBoardHash();
            break;
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
  if (inSimulation) return findBestSimReply(rack);
  const cfg = STAGES[stageFor(state.bag.length)];
  if (cfg.static) return findBestStaticPlay(rack);
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
