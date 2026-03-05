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
  wordSet: null,
  gameOver: false,
  consecutivePasses: 0,
  playerTurnActive: false,
  blankCallback: null,
  lastPlay: new Set(),  // set of "row,col" keys for the most recent play
};

// ============================================================
// INIT & LOAD
// ============================================================

async function init() {
  buildBlankLetterGrid();
  document.getElementById('btn-new-game').addEventListener('click', newGame);
  document.getElementById('btn-shuffle').addEventListener('click', shufflePlayerRack);
  document.getElementById('btn-lifeline').addEventListener('click', lifelineTurn);
  document.getElementById('btn-recall').addEventListener('click', recallAllTiles);
  document.getElementById('btn-play').addEventListener('click', submitPlayerMove);
  document.getElementById('blank-cancel').addEventListener('click', cancelBlankDialog);
  document.getElementById('bag-info-unseen').addEventListener('click', showUnseenDialog);
  document.getElementById('unseen-close').addEventListener('click', closeUnseenDialog);
  scoreBubbleEl = document.getElementById('score-bubble');
  document.getElementById('unseen-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('unseen-overlay')) closeUnseenDialog();
  });
  document.getElementById('btn-play-again').addEventListener('click', () => {
    document.getElementById('end-overlay').classList.add('hidden');
    newGame();
  });

  await loadWordList();
  newGame();
}

async function loadWordList() {
  try {
    const resp = await fetch('words.txt');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    state.wordSet = new Set(
      text.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => w.length >= 2)
    );
  } catch (e) {
    throw e;
  }
}

// ============================================================
// NEW GAME
// ============================================================

function newGame() {
  state.board = Array.from({length:15}, () => new Array(15).fill(null));
  state.bag = buildBag();
  state.playerRack = [];
  state.computerRack = [];
  state.playerScore = 0;
  state.computerScore = 0;
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
    if (idx === state.selectedRackIdx) el.classList.add('selected');
    el.textContent = tile.isBlank ? '' : tile.letter;
    const pts = document.createElement('span');
    pts.className = 'tile-points';
    pts.textContent = tile.isBlank ? '' : (LETTER_VALUES[tile.letter] || 0);
    el.appendChild(pts);
    if (!isTouchDevice) el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      if (!state.playerTurnActive) { e.preventDefault(); return; }
      state.dragRackIdx = idx;
      state.selectedRackIdx = idx;
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
  document.getElementById('player-score').textContent = state.playerScore;
  document.getElementById('computer-score').textContent = state.computerScore;
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

function enablePlayerControls(on) {
  state.playerTurnActive = on;
  document.getElementById('btn-play').disabled = !on;
  document.getElementById('btn-lifeline').disabled = !on || state.lifelineUsed;
  document.getElementById('btn-shuffle').disabled = !on;
  document.getElementById('btn-recall').disabled = !on;
}

// ============================================================
// PLAYER INTERACTION
// ============================================================

function onRackTileClick(idx) {
  if (!state.playerTurnActive) return;
  state.selectedRackIdx = idx;
  renderRack();
}

function onCellClick(r, c) {
  if (!state.playerTurnActive) return;

  const cellEmpty = state.board[r][c] === null &&
                    !state.pending.some(p => p.row === r && p.col === c);

  // If there are pending tiles, move the last-placed one to the clicked cell.
  if (state.pending.length > 0 && cellEmpty) {
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
  if (!state.playerTurnActive) return;
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
    if (pending.length < 2)
      return {valid:false, error:'The first word must be at least 2 letters.'};
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
  const seen = new Set();

  const addWord = (word, key) => {
    if (word.length >= 2 && !seen.has(key)) {
      seen.add(key);
      words.push({word});
    }
  };

  // Main word
  const first = pending[0];
  const mainWord = getWordAt(
    isHorizMove ? first.row : 0,
    isHorizMove ? 0 : first.col,
    isHorizMove, pending
  );
  // Actually need to get the full main word from the extent of the move
  const mainWordStr = getWordAt(first.row, first.col, isHorizMove, pending);
  addWord(mainWordStr, `${isHorizMove?'H':'V'}-${first.row}-${first.col}`);

  // But the above may not give the full word if first tile is not the start
  // Redo: find the actual main word
  const mainWordFull = getWordAt(
    isHorizMove ? pending[0].row : pending.reduce((mn,p)=>Math.min(mn,p.row),14),
    isHorizMove ? pending.reduce((mn,p)=>Math.min(mn,p.col),14) : pending[0].col,
    isHorizMove, pending
  );

  // Use the coord-anchored approach
  const row0 = isHorizMove ? pending[0].row : Math.min(...pending.map(p=>p.row));
  const col0 = isHorizMove ? Math.min(...pending.map(p=>p.col)) : pending[0].col;
  const mainStr = getWordAt(row0, col0, isHorizMove, pending);
  seen.clear();
  words.length = 0;
  addWord(mainStr, 'main');

  // Cross-words: for each newly placed tile, check perpendicular word
  for (const p of pending) {
    const crossStr = getWordAt(p.row, p.col, !isHorizMove, pending);
    if (crossStr.length >= 2) {
      addWord(crossStr, `cross-${p.row}-${p.col}`);
    }
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
  const pendingSet = new Set(pendingMap.keys());

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

  // Position above (or below if near top) the last placed tile.
  const last = pending[pending.length - 1];
  const cellEl = getCellEl(last.row, last.col);
  const rect = cellEl.getBoundingClientRect();
  const aboveTop = rect.top - 36;

  bubble.textContent = `+${score}`;
  bubble.style.left = (rect.left + rect.width / 2) + 'px';
  bubble.style.top  = (aboveTop > 4 ? aboveTop : rect.bottom + 6) + 'px';

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
    if (confirm('You have no tiles placed. Pass your turn?')) passPlayerTurn();
    return;
  }

  const result = validatePlayerMove();
  if (!result.valid) {
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

async function findBestPlayerMove() {
  let bestScore = -1;
  let bestMove = null;
  for (let i = 0; i < 15; i++) {
    if (i % 3 === 0) await yieldToUI();
    for (const isHoriz of [true, false]) {
      const moves = findMovesInLine(i, isHoriz, state.playerRack);
      for (const m of moves) {
        if (m.score > bestScore) { bestScore = m.score; bestMove = m; }
      }
    }
  }
  return bestScore > 0 ? bestMove : null;
}

async function lifelineTurn() {
  if (!state.playerTurnActive || state.gameOver || state.lifelineUsed) return;
  state.lifelineUsed = true;
  document.getElementById('btn-lifeline').disabled = true;
  recallAllTiles();
  enablePlayerControls(false);

  const t0 = performance.now();
  const move = await findBestPlayerMove();
  const ms = Math.round(performance.now() - t0);

  if (!move) {
    state.consecutivePasses++;
    logEntry(`You: passed in ${ms}ms [lifeline]`, 'player');
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
  await yieldToUI();

  const t0 = performance.now();
  const move = await findBestComputerMove();
  const ms = Math.round(performance.now() - t0);

  if (!move) {
    state.consecutivePasses++;
    logEntry(`Computer: passed in ${ms}ms`, 'computer');
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
// COMPUTER MOVE ENGINE
// ============================================================

async function findBestComputerMove() {
  let bestScore = -1;
  let bestMove = null;

  for (let i = 0; i < 15; i++) {
    // Yield every 3 lines to keep UI alive
    if (i % 3 === 0) await yieldToUI();

    for (const isHoriz of [true, false]) {
      const moves = findMovesInLine(i, isHoriz);
      for (const m of moves) {
        if (m.score > bestScore) {
          bestScore = m.score;
          bestMove = m;
        }
      }
    }
  }

  return bestScore > 0 ? bestMove : null;
}

function findMovesInLine(lineIdx, isHoriz, rack = state.computerRack) {
  const results = [];

  // Build fixed letter array for this line
  const fixed = new Array(15).fill(null);
  for (let i = 0; i < 15; i++) {
    const [r, c] = isHoriz ? [lineIdx, i] : [i, lineIdx];
    if (state.board[r][c]) fixed[i] = state.board[r][c].letter.toLowerCase();
  }

  // Check if this line is worth searching
  const hasAnchor = (() => {
    for (let i = 0; i < 15; i++) {
      if (fixed[i] !== null) continue;
      const [r, c] = isHoriz ? [lineIdx, i] : [i, lineIdx];
      if (state.isFirstMove && r === 7 && c === 7) return true;
      if (!state.isFirstMove && isAdjacentToExisting(r, c)) return true;
    }
    return false;
  })();

  const hasFixed = fixed.some(f => f !== null);

  if (!hasAnchor && !hasFixed) return results;
  if (state.isFirstMove && lineIdx !== 7) return results;

  // Available rack letter counts
  const rackCounts = {};
  let blankCount = 0;
  for (const tile of rack) {
    if (tile.isBlank) { blankCount++; }
    else { const ch = tile.letter.toLowerCase(); rackCounts[ch] = (rackCounts[ch]||0)+1; }
  }

  // Available pool for pre-filter: rack + fixed in line
  const allAvail = {...rackCounts};
  for (const f of fixed) if (f !== null) allAvail[f] = (allAvail[f]||0)+1;

  for (const word of state.wordSet) {
    const wlen = word.length;
    if (wlen > 15 || wlen < 2) continue;

    // Quick letter-count pre-filter
    if (!canSpellFromPool(word, allAvail, blankCount)) continue;

    // Try each start position
    for (let start = 0; start <= 15 - wlen; start++) {
      const end = start + wlen - 1;

      // Word must not abut another word (would extend it illegally)
      if (start > 0 && fixed[start-1] !== null) continue;
      if (end < 14 && fixed[end+1] !== null) continue;

      // Match word against fixed tiles, compute rack tiles needed
      let ok = true;
      let usesFixed = false;
      let hasAnchorTile = false;
      const rackNeeded = []; // {char, pos-in-line}

      for (let i = 0; i < wlen; i++) {
        const pos = start + i;
        const ch = word[i];
        if (fixed[pos] !== null) {
          if (fixed[pos] !== ch) { ok = false; break; }
          usesFixed = true;
        } else {
          rackNeeded.push({char: ch, pos});
          const [r, c] = isHoriz ? [lineIdx, pos] : [pos, lineIdx];
          if (state.isFirstMove && r === 7 && c === 7) hasAnchorTile = true;
          if (!state.isFirstMove && isAdjacentToExisting(r, c)) hasAnchorTile = true;
        }
      }

      if (!ok) continue;
      if (rackNeeded.length === 0) continue; // no new tiles placed
      if (!usesFixed && !hasAnchorTile) continue; // not connected
      if (state.isFirstMove) {
        // Must include the center cell
        let coversCenter = false;
        for (let i = start; i <= end; i++) {
          const [r, c] = isHoriz ? [lineIdx, i] : [i, lineIdx];
          if (r === 7 && c === 7) { coversCenter = true; break; }
        }
        if (!coversCenter) continue;
      }

      // Verify rack can supply the needed letters
      const rAvail = {...rackCounts};
      let blanksLeft = blankCount;
      const placements = [];
      let rackOk = true;

      for (const {char, pos} of rackNeeded) {
        const [r, c] = isHoriz ? [lineIdx, pos] : [pos, lineIdx];
        if (rAvail[char] > 0) {
          rAvail[char]--;
          placements.push({row:r, col:c, letter:char.toUpperCase(), isBlank:false});
        } else if (blanksLeft > 0) {
          blanksLeft--;
          placements.push({row:r, col:c, letter:char.toUpperCase(), isBlank:true});
        } else {
          rackOk = false; break;
        }
      }
      if (!rackOk) continue;

      // Validate cross-words for each newly placed tile
      let crossOk = true;
      for (const p of placements) {
        const cw = getCrossWordStr(p.row, p.col, p.letter.toLowerCase(), !isHoriz);
        if (cw.length >= 2 && !state.wordSet.has(cw)) {
          crossOk = false; break;
        }
      }
      if (!crossOk) continue;

      // Score this move
      const score = scoreComputerMove(placements, isHoriz);
      results.push({placements, word, score});
    }
  }

  return results;
}

// Cross-word string through (row, col) in direction isHoriz,
// treating (row, col) as having letter `newLetter` (not on board yet)
function getCrossWordStr(row, col, newLetter, isHoriz) {
  const getL = (r, c) => {
    if (r === row && c === col) return newLetter;
    const b = state.board[r][c];
    return b ? b.letter.toLowerCase() : null;
  };
  let word = '';
  if (isHoriz) {
    let sc = col;
    while (sc > 0 && getL(row, sc-1) !== null) sc--;
    let cc = sc;
    while (cc < 15 && getL(row, cc) !== null) { word += getL(row, cc); cc++; }
  } else {
    let sr = row;
    while (sr > 0 && getL(sr-1, col) !== null) sr--;
    let rr = sr;
    while (rr < 15 && getL(rr, col) !== null) { word += getL(rr, col); rr++; }
  }
  return word;
}

// Score a computer move placement (placements not yet on board)
function scoreComputerMove(placements, isHoriz) {
  const pendingMap = new Map(placements.map(p => [`${p.row},${p.col}`, p]));
  const pendingSet = new Set(pendingMap.keys());

  const getCell = (r, c) => {
    const k = `${r},${c}`;
    if (pendingMap.has(k)) {
      const p = pendingMap.get(k);
      return {letter:p.letter, isBlank:p.isBlank, isNew:true};
    }
    const b = state.board[r][c];
    return b ? {letter:b.letter, isBlank:b.isBlank, isNew:false} : null;
  };

  const scoreOneWord = (r0, c0, wordIsHoriz) => {
    let start = wordIsHoriz ? c0 : r0;
    const fixed = wordIsHoriz ? r0 : c0;
    while (start > 0) {
      const cell = wordIsHoriz ? getCell(fixed, start-1) : getCell(start-1, fixed);
      if (!cell) break;
      start--;
    }
    let sc = 0, wm = 1, pos = start;
    while (pos < 15) {
      const cell = wordIsHoriz ? getCell(fixed, pos) : getCell(pos, fixed);
      if (!cell) break;
      const [cr, cc] = wordIsHoriz ? [fixed, pos] : [pos, fixed];
      const bonus = cell.isNew ? BONUS_MAP[cr][cc] : null;
      let lv = letterVal(cell.letter, cell.isBlank);
      if (bonus === 'TL') lv *= 3;
      else if (bonus === 'DL') lv *= 2;
      sc += lv;
      if (bonus === 'TW') wm *= 3;
      else if (bonus === 'DW') wm *= 2;
      pos++;
    }
    return sc * wm;
  };

  // Main word
  const r0 = isHoriz ? placements[0].row : Math.min(...placements.map(p=>p.row));
  const c0 = isHoriz ? Math.min(...placements.map(p=>p.col)) : placements[0].col;
  let total = scoreOneWord(r0, c0, isHoriz);

  // Cross-words
  for (const p of placements) {
    // Check if there are tiles above/below (for H move) or left/right (for V move)
    const [pr, pc] = [p.row, p.col];
    const crossIsHoriz = !isHoriz;
    let hasNeighbor = false;
    if (crossIsHoriz) {
      hasNeighbor = (pc > 0 && getCell(pr, pc-1) !== null) || (pc < 14 && getCell(pr, pc+1) !== null);
    } else {
      hasNeighbor = (pr > 0 && getCell(pr-1, pc) !== null) || (pr < 14 && getCell(pr+1, pc) !== null);
    }
    if (hasNeighbor) {
      total += scoreOneWord(pr, pc, crossIsHoriz);
    }
  }

  // Bingo
  if (placements.length === 7) total += 50;

  return total;
}

// Quick pre-filter: can this word be spelled from the available pool?
function canSpellFromPool(word, available, blanks) {
  const need = {};
  for (const ch of word) need[ch] = (need[ch]||0)+1;
  let blanksUsed = 0;
  for (const [ch, n] of Object.entries(need)) {
    const deficit = n - (available[ch]||0);
    if (deficit > 0) {
      blanksUsed += deficit;
      if (blanksUsed > blanks) return false;
    }
  }
  return true;
}

// ============================================================
// GAME OVER
// ============================================================

function checkGameOver() {
  const bagEmpty = state.bag.length === 0;
  const playerEmpty = state.playerRack.length === 0;
  const computerEmpty = state.computerRack.length === 0;

  if (state.consecutivePasses >= 6) {
    endGame('Six consecutive passes. Game over.');
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

  if (state.playerRack.length === 0) {
    state.playerScore += compUnused;
    state.computerScore -= compUnused;
  } else if (state.computerRack.length === 0) {
    state.computerScore += playerUnused;
    state.playerScore -= playerUnused;
  } else {
    state.playerScore -= playerUnused;
    state.computerScore -= compUnused;
  }

  renderScores();

  const pScore = state.playerScore;
  const cScore = state.computerScore;
  let winner;
  if (pScore > cScore) winner = 'You win.';
  else if (cScore > pScore) winner = 'Computer wins.';
  else winner = "It's a tie.";

  logEntry(`Game over. ${winner}`, 'system');
}

// ============================================================
// START
// ============================================================

window.addEventListener('DOMContentLoaded', init);
