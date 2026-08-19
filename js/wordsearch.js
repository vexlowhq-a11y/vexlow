/*
  Word Search — usado por play/wordsearch.html
  =================================================================
  Mismo patrón de billetera/visitorId/modal de nombre/pausa
  publicitaria/leaderboard que los otros juegos (ver js/pulse.js),
  invertido a "menor tiempo gana". La grilla es DOM (no canvas):
  celdas div dentro de un grid CSS, selección por arrastre de mouse
  o touch.

  Este archivo es requerible desde Node (sin DOM) para poder testear
  el generador de puzzles de forma aislada -- todo lo que toca
  `document`/`window` está adentro del guard `hasDom` de más abajo,
  las funciones de generación son puras y están exportadas al final.
*/

var hasDom = (typeof document !== 'undefined');

// ---------------------------------------------------------------
// Datos EN/ES (en browser vienen de wordsearch-data.js vía <script>
// previo; en Node se importan con require()).
// ---------------------------------------------------------------
var WS_WORDS_EN, WS_WORDS_ES;
if (typeof window !== 'undefined' && window.WORDSEARCH_WORDS_EN) {
  WS_WORDS_EN = window.WORDSEARCH_WORDS_EN;
  WS_WORDS_ES = window.WORDSEARCH_WORDS_ES;
} else if (typeof WORDSEARCH_WORDS_EN !== 'undefined') {
  WS_WORDS_EN = WORDSEARCH_WORDS_EN;
  WS_WORDS_ES = WORDSEARCH_WORDS_ES;
} else if (typeof require === 'function') {
  var wsData = require('./wordsearch-data.js');
  WS_WORDS_EN = wsData.WORDSEARCH_WORDS_EN;
  WS_WORDS_ES = wsData.WORDSEARCH_WORDS_ES;
}

// ---------------------------------------------------------------
// Generador de puzzles (puro, sin DOM)
// ---------------------------------------------------------------
var DIFFICULTIES = {
  easy:    { size: 10, wordCount: 8,  minLen: 4, maxLen: 6,  mode: 'letters' },
  medium:  { size: 12, wordCount: 10, minLen: 5, maxLen: 8,  mode: 'letters' },
  hard:    { size: 14, wordCount: 12, minLen: 6, maxLen: 9,  mode: 'letters' },
  expert:  { size: 16, wordCount: 14, minLen: 7, maxLen: 10, mode: 'letters' },
  numbers: { size: 12, wordCount: 10, minLen: 3, maxLen: 5,  mode: 'numbers' }
};
var DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'expert', 'numbers'];

var WS_DIRECTIONS = [
  [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]
];

function wsShuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function wsPickWordPool(lang, minLen, maxLen) {
  var words = lang === 'es' ? WS_WORDS_ES : WS_WORDS_EN;
  return words.filter(function (w) { return w.length >= minLen && w.length <= maxLen; });
}

function wsRandomNumberString(minLen, maxLen) {
  var len = minLen + Math.floor(Math.random() * (maxLen - minLen + 1));
  var s = '';
  for (var i = 0; i < len; i++) s += String(Math.floor(Math.random() * 10));
  return s;
}

// Intenta ubicar `word` en `grid` (size x size) en alguna de las 8
// direcciones, reintentando con posiciones/direcciones al azar.
// Devuelve la lista de celdas [[r,c], ...] si lo logra, o null.
function wsTryPlaceWord(grid, size, word) {
  var dirs = wsShuffle(WS_DIRECTIONS);
  var MAX_ATTEMPTS = 80;
  for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    var dir = dirs[attempt % dirs.length];
    var dr = dir[0], dc = dir[1];
    var len = word.length;
    var rMin = dr < 0 ? len - 1 : 0;
    var rMax = dr > 0 ? size - len : size - 1;
    var cMin = dc < 0 ? len - 1 : 0;
    var cMax = dc > 0 ? size - len : size - 1;
    if (rMin > rMax || cMin > cMax) continue;
    var row = rMin + Math.floor(Math.random() * (rMax - rMin + 1));
    var col = cMin + Math.floor(Math.random() * (cMax - cMin + 1));
    var cells = [];
    var ok = true;
    for (var i = 0; i < len; i++) {
      var rr = row + dr * i, cc = col + dc * i;
      var existing = grid[rr][cc];
      if (existing !== null && existing !== word[i]) { ok = false; break; }
      cells.push([rr, cc]);
    }
    if (!ok) continue;
    for (var k = 0; k < len; k++) grid[cells[k][0]][cells[k][1]] = word[k];
    return cells;
  }
  return null;
}

// Genera un puzzle completo. opts: { difficulty, lang }.
// Devuelve { size, grid (array de arrays de letras), words (array de
// strings colocadas), placements ([{word, cells}]) }. El conteo de
// palabras objetivo siempre se cumple (se descartan y reemplazan las
// que no logran ubicarse) salvo que el banco de palabras filtrado
// por largo tenga menos entradas que wordCount, algo que no debería
// pasar con los bancos actuales (se verifica aparte con un harness).
function generateWordSearchPuzzle(opts) {
  var cfg = DIFFICULTIES[opts.difficulty];
  if (!cfg) throw new Error('Dificultad desconocida: ' + opts.difficulty);
  var size = cfg.size;
  var grid = [];
  for (var r = 0; r < size; r++) grid.push(new Array(size).fill(null));

  var placed = [];
  var alphabet, pool;

  if (cfg.mode === 'numbers') {
    alphabet = '0123456789'.split('');
    var seen = {};
    var candidates = [];
    var guard = 0;
    while (candidates.length < cfg.wordCount * 5 && guard < 5000) {
      guard++;
      var s = wsRandomNumberString(cfg.minLen, cfg.maxLen);
      if (!seen[s]) { seen[s] = true; candidates.push(s); }
    }
    pool = candidates;
  } else {
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    pool = wsPickWordPool(opts.lang, cfg.minLen, cfg.maxLen);
  }

  pool = wsShuffle(pool).sort(function (a, b) { return b.length - a.length; });

  var idx = 0;
  while (placed.length < cfg.wordCount && idx < pool.length) {
    var word = pool[idx++];
    var already = false;
    for (var p = 0; p < placed.length; p++) { if (placed[p].word === word) { already = true; break; } }
    if (already) continue;
    var cells = wsTryPlaceWord(grid, size, word);
    if (cells) placed.push({ word: word, cells: cells });
  }

  for (var rr2 = 0; rr2 < size; rr2++) {
    for (var cc2 = 0; cc2 < size; cc2++) {
      if (grid[rr2][cc2] === null) {
        grid[rr2][cc2] = alphabet[Math.floor(Math.random() * alphabet.length)];
      }
    }
  }

  return {
    size: size,
    grid: grid,
    words: placed.map(function (p) { return p.word; }),
    placements: placed
  };
}

// Re-verifica de forma independiente (sin confiar en el propio
// generador) que cada palabra en `placements` efectivamente se lee,
// letra por letra, en las celdas que dice haber usado.
function verifyPuzzlePlacements(puzzle) {
  for (var i = 0; i < puzzle.placements.length; i++) {
    var p = puzzle.placements[i];
    var read = '';
    for (var c = 0; c < p.cells.length; c++) {
      read += puzzle.grid[p.cells[c][0]][p.cells[c][1]];
    }
    if (read !== p.word) return false;
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DIFFICULTIES: DIFFICULTIES,
    generateWordSearchPuzzle: generateWordSearchPuzzle,
    verifyPuzzlePlacements: verifyPuzzlePlacements
  };
}

// =================================================================
// Todo lo de abajo solo corre en el navegador.
// =================================================================
if (hasDom) {
(function () {
  'use strict';

  var UI_TEXT = {
    en: {
      pickDifficulty: 'Choose a difficulty', easy: 'Easy', medium: 'Medium', hard: 'Hard',
      expert: 'Expert', numbers: 'Numbers', hint: 'Hint', giveUp: 'Give Up', newGame: 'New Game',
      settings: 'Settings', time: 'Time', best: 'Best', youWin: 'You solved it!',
      playAgain: 'Play Again', revealed: 'Puzzle revealed — better luck next time',
      wordsFound: 'Words found', noHintsLeft: 'No hints left', tapToStart: 'Pick a difficulty to start'
    },
    es: {
      pickDifficulty: 'Elegí una dificultad', easy: 'Fácil', medium: 'Medio', hard: 'Difícil',
      expert: 'Experto', numbers: 'Números', hint: 'Pista', giveUp: 'Rendirse', newGame: 'Nuevo juego',
      settings: 'Ajustes', time: 'Tiempo', best: 'Mejor', youWin: '¡Lo resolviste!',
      playAgain: 'Jugar de nuevo', revealed: 'Puzzle revelado — a la próxima',
      wordsFound: 'Palabras encontradas', noHintsLeft: 'Sin pistas', tapToStart: 'Elegí una dificultad para empezar'
    }
  };

  var FOUND_COLORS = ['#3d8bff', '#ff6b6b', '#37c978', '#ffb703', '#a06cff', '#ff8fab', '#20c4d4', '#f2a65a',
    '#6bcb77', '#e56399', '#4d96ff', '#ffa62b', '#9b5de5', '#00bbf9', '#f15bb5'];

  var VID_KEY = 'vexlow_vid';
  var NAME_KEY = 'vexlow_dash_name';
  var LANG_KEY = 'vexlow_wordsearch_lang';
  var PLAYS_KEY = 'vexlow_wordsearch_plays';
  var AD_BREAK_INTERVAL = 3;
  var HINT_LIMIT = 3;

  function bestKey(difficulty) { return 'vexlow_wordsearch_best_' + difficulty; }

  function getVisitorId() {
    var id = null;
    try {
      id = localStorage.getItem(VID_KEY);
      if (!id) {
        id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        localStorage.setItem(VID_KEY, id);
      }
    } catch (e) {}
    return id;
  }
  var visitorId = getVisitorId();

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatTime(ms) {
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- refs de DOM ----
  var gridEl = document.getElementById('wordsearchGrid');
  var wordListEl = document.getElementById('wordsearchWordList');
  var timerEl = document.getElementById('wordsearchTimer');
  var bestEl = document.getElementById('wordsearchBest');
  var hintBtn = document.getElementById('wordsearchHintBtn');
  var giveUpBtn = document.getElementById('wordsearchGiveUpBtn');
  var newGameBtn = document.getElementById('wordsearchNewGameBtn');
  var settingsBtn = document.getElementById('wordsearchSettingsBtn');

  var startModal = document.getElementById('wordsearchStartModal');
  var langEnBtn = document.getElementById('wordsearchLangEn');
  var langEsBtn = document.getElementById('wordsearchLangEs');
  var difficultyButtonsEl = document.getElementById('wordsearchDifficultyButtons');

  var winModal = document.getElementById('wordsearchWinModal');
  var winTimeEl = document.getElementById('wordsearchWinTime');
  var winPlayAgainBtn = document.getElementById('wordsearchWinPlayAgain');

  var revealedModal = document.getElementById('wordsearchRevealedModal');
  var revealedPlayAgainBtn = document.getElementById('wordsearchRevealedPlayAgain');

  var nameModal = document.getElementById('wordsearchNameModal');
  var nameInput = document.getElementById('wordsearchNameInput');
  var nameSaveBtn = document.getElementById('wordsearchNameSave');
  var nameSkipBtn = document.getElementById('wordsearchNameSkip');

  var adBreak = document.getElementById('wordsearchAdBreak');
  var adBreakContinueBtn = document.getElementById('wordsearchAdBreakContinue');

  var lbList = document.getElementById('wordsearchLeaderboardList');
  var lbYou = document.getElementById('wordsearchYouRank');

  // ---- estado ----
  var currentLang = 'en';
  try { currentLang = localStorage.getItem(LANG_KEY) || 'en'; } catch (e) {}
  var currentDifficulty = 'easy';
  var puzzle = null;
  var cellEls = null; // [r][c] -> DOM element
  var foundWords = {}; // word -> { colorIndex }
  var wordChipEls = {}; // word -> DOM li
  var hintsLeft = HINT_LIMIT;
  var timerHandle = null;
  var startedAt = 0;
  var elapsedMsAtStop = 0;
  var running = false;
  var nameModalCallback = null;

  function t(key) { return UI_TEXT[currentLang][key]; }

  // ---- modal de nombre (mismo patrón que pulse.js) ----
  function openNameModal(prefill, onDone) {
    if (!nameModal) { onDone('Player'); return; }
    nameModalCallback = onDone;
    if (nameInput) {
      nameInput.value = prefill || '';
      setTimeout(function () { nameInput.focus(); }, 0);
    }
    nameModal.classList.remove('hidden');
  }
  function commitName(rawValue) {
    var name = String(rawValue || '').trim().slice(0, 14) || 'Player';
    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
    if (nameModal) nameModal.classList.add('hidden');
    var cb = nameModalCallback;
    nameModalCallback = null;
    if (cb) cb(name);
  }
  if (nameSaveBtn) nameSaveBtn.addEventListener('click', function () { commitName(nameInput ? nameInput.value : ''); });
  if (nameSkipBtn) nameSkipBtn.addEventListener('click', function () { commitName('Player'); });
  if (nameInput) nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') commitName(nameInput.value); });

  // ---- leaderboard (invertido: menor tiempo gana) ----
  function renderLeaderboard(data) {
    if (!lbList || !data) return;
    if (!data.top || !data.top.length) {
      lbList.innerHTML = '<li class="dash-lb-empty">' + (currentLang === 'es' ? 'Sin tiempos todavía — sé el primero' : 'No times yet — be the first!') + '</li>';
    } else {
      lbList.innerHTML = data.top.map(function (row, i) {
        var isYou = data.you && (i + 1) === data.you.rank;
        return '<li class="dash-lb-row' + (isYou ? ' dash-lb-you-row' : '') + '">' +
          '<span class="dash-lb-rank">' + (i + 1) + '</span>' +
          '<span class="dash-lb-name">' + escapeHtml(row.name) + '</span>' +
          '<span class="dash-lb-score">' + formatTime(row.score) + '</span></li>';
      }).join('');
    }
    if (lbYou) {
      if (data.you && data.you.rank > 10) {
        lbYou.hidden = false;
        lbYou.textContent = (currentLang === 'es' ? 'Tu puesto: #' : 'Your rank: #') + data.you.rank + ' (' + formatTime(data.you.score) + ')';
      } else {
        lbYou.hidden = true;
      }
    }
  }

  function loadLeaderboard(difficulty) {
    fetch('/api/wordsearch?difficulty=' + encodeURIComponent(difficulty) + '&visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        var localBest = getLocalBest(difficulty);
        if (data && localBest && (!data.you || localBest < data.you.score)) {
          submitScore(difficulty, localBest);
        }
      }).catch(function () {});
  }

  function doSubmit(difficulty, name, timeMs) {
    fetch('/api/wordsearch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty: difficulty, name: name, score: timeMs, visitorId: visitorId })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(renderLeaderboard).catch(function () {});
  }

  function submitScore(difficulty, timeMs) {
    if (!visitorId || timeMs <= 0) return;
    var name = null;
    try { name = localStorage.getItem(NAME_KEY); } catch (e) {}
    if (!name) openNameModal('', function (chosenName) { doSubmit(difficulty, chosenName, timeMs); });
    else doSubmit(difficulty, name, timeMs);
  }

  if (lbYou) {
    lbYou.addEventListener('click', function () {
      openNameModal('', function (chosenName) { loadLeaderboard(currentDifficulty); });
    });
  }

  function getLocalBest(difficulty) {
    try {
      var raw = localStorage.getItem(bestKey(difficulty));
      return raw ? parseInt(raw, 10) : 0;
    } catch (e) { return 0; }
  }
  function setLocalBest(difficulty, timeMs) {
    var current = getLocalBest(difficulty);
    if (!current || timeMs < current) {
      try { localStorage.setItem(bestKey(difficulty), String(timeMs)); } catch (e) {}
      return true;
    }
    return false;
  }
  function renderBest() {
    var best = getLocalBest(currentDifficulty);
    if (bestEl) bestEl.textContent = t('best') + ': ' + (best ? formatTime(best) : '--:--');
  }

  // ---- pausa publicitaria (mismo patrón que pulse.js) ----
  function bumpPlaysAndMaybeShowAdBreak(afterClose) {
    var plays = 0;
    try {
      plays = parseInt(localStorage.getItem(PLAYS_KEY) || '0', 10) + 1;
      localStorage.setItem(PLAYS_KEY, String(plays));
    } catch (e) {}
    if (adBreak && plays % AD_BREAK_INTERVAL === 0) {
      adBreak.classList.remove('hidden');
    } else if (afterClose) {
      afterClose();
    }
  }
  if (adBreakContinueBtn) {
    adBreakContinueBtn.addEventListener('click', function () {
      if (adBreak) adBreak.classList.add('hidden');
    });
  }

  // ---- timer ----
  function tickTimer() {
    if (!running || !timerEl) return;
    timerEl.textContent = t('time') + ': ' + formatTime(Date.now() - startedAt);
  }
  function startTimer() {
    stopTimer();
    startedAt = Date.now();
    running = true;
    timerHandle = setInterval(tickTimer, 250);
    tickTimer();
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (running) elapsedMsAtStop = Date.now() - startedAt;
    running = false;
  }

  // ---- render de grilla + lista de palabras ----
  function colorForIndex(i) { return FOUND_COLORS[i % FOUND_COLORS.length]; }

  function renderWordList() {
    if (!wordListEl) return;
    wordListEl.innerHTML = '';
    wordChipEls = {};
    puzzle.words.forEach(function (word) {
      var li = document.createElement('li');
      li.className = 'ws-word';
      li.textContent = word;
      wordListEl.appendChild(li);
      wordChipEls[word] = li;
    });
  }

  function renderGrid() {
    if (!gridEl) return;
    gridEl.innerHTML = '';
    gridEl.style.setProperty('--ws-size', puzzle.size);
    cellEls = [];
    for (var r = 0; r < puzzle.size; r++) {
      var row = [];
      for (var c = 0; c < puzzle.size; c++) {
        var cell = document.createElement('div');
        cell.className = 'ws-cell';
        cell.textContent = puzzle.grid[r][c];
        cell.dataset.r = r;
        cell.dataset.c = c;
        gridEl.appendChild(cell);
        row.push(cell);
      }
      cellEls.push(row);
    }
  }

  // ---- selección (mouse + touch) ----
  var selecting = false;
  var selStart = null;
  var selPath = [];

  function cellFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.classList || !el.classList.contains('ws-cell')) return null;
    return { r: parseInt(el.dataset.r, 10), c: parseInt(el.dataset.c, 10) };
  }

  function clearSelectingClass() {
    selPath.forEach(function (p) { cellEls[p.r][p.c].classList.remove('selecting'); });
  }

  function computePath(start, cur) {
    var dr = cur.r - start.r, dc = cur.c - start.c;
    if (dr === 0 && dc === 0) return [{ r: start.r, c: start.c }];
    var sdr = dr === 0 ? 0 : (dr > 0 ? 1 : -1);
    var sdc = dc === 0 ? 0 : (dc > 0 ? 1 : -1);
    var len;
    if (sdr !== 0 && sdc !== 0) len = Math.min(Math.abs(dr), Math.abs(dc));
    else len = Math.max(Math.abs(dr), Math.abs(dc));
    var path = [];
    for (var i = 0; i <= len; i++) path.push({ r: start.r + sdr * i, c: start.c + sdc * i });
    return path;
  }

  function beginSelection(cellPos) {
    if (!cellPos || !puzzle) return;
    selecting = true;
    selStart = cellPos;
    selPath = [cellPos];
    cellEls[cellPos.r][cellPos.c].classList.add('selecting');
  }
  function updateSelection(cellPos) {
    if (!selecting || !cellPos) return;
    clearSelectingClass();
    selPath = computePath(selStart, cellPos);
    selPath.forEach(function (p) { cellEls[p.r][p.c].classList.add('selecting'); });
  }
  function endSelection() {
    if (!selecting) return;
    selecting = false;
    var forward = selPath.map(function (p) { return puzzle.grid[p.r][p.c]; }).join('');
    var backward = forward.split('').reverse().join('');
    var matchedWord = null;
    for (var i = 0; i < puzzle.words.length; i++) {
      var w = puzzle.words[i];
      if (foundWords[w]) continue;
      if (w === forward || w === backward) { matchedWord = w; break; }
    }
    if (matchedWord) {
      markWordFound(matchedWord, selPath);
    } else {
      clearSelectingClass();
    }
    selPath = [];
    selStart = null;
  }

  function markWordFound(word, cells) {
    var colorIndex = Object.keys(foundWords).length;
    foundWords[word] = true;
    var color = colorForIndex(colorIndex);
    cells.forEach(function (p) {
      var el = cellEls[p.r][p.c];
      el.classList.remove('selecting');
      el.classList.add('found');
      el.style.setProperty('--ws-found-color', color);
    });
    var chip = wordChipEls[word];
    if (chip) { chip.classList.add('found'); chip.style.color = color; }

    if (Object.keys(foundWords).length === puzzle.words.length) {
      onPuzzleSolved();
    }
  }

  if (gridEl) {
    gridEl.addEventListener('mousedown', function (e) {
      var pos = e.target && e.target.classList && e.target.classList.contains('ws-cell')
        ? { r: parseInt(e.target.dataset.r, 10), c: parseInt(e.target.dataset.c, 10) } : null;
      beginSelection(pos);
    });
    gridEl.addEventListener('mousemove', function (e) {
      if (!selecting) return;
      var pos = e.target && e.target.classList && e.target.classList.contains('ws-cell')
        ? { r: parseInt(e.target.dataset.r, 10), c: parseInt(e.target.dataset.c, 10) } : null;
      updateSelection(pos);
    });
    document.addEventListener('mouseup', function () { endSelection(); });

    gridEl.addEventListener('touchstart', function (e) {
      var t0 = e.touches[0];
      beginSelection(cellFromPoint(t0.clientX, t0.clientY));
    }, { passive: true });
    gridEl.addEventListener('touchmove', function (e) {
      if (!selecting) return;
      e.preventDefault();
      var t0 = e.touches[0];
      updateSelection(cellFromPoint(t0.clientX, t0.clientY));
    }, { passive: false });
    document.addEventListener('touchend', function () { endSelection(); });
    document.addEventListener('touchcancel', function () { endSelection(); });
  }

  // ---- hint / rendirse / nuevo juego ----
  function useHint() {
    if (!puzzle || hintsLeft <= 0) return;
    var remaining = puzzle.words.filter(function (w) { return !foundWords[w]; });
    if (!remaining.length) return;
    var word = remaining[Math.floor(Math.random() * remaining.length)];
    var placement = puzzle.placements.filter(function (p) { return p.word === word; })[0];
    if (!placement) return;
    placement.cells.forEach(function (p) { cellEls[p[0]][p[1]].classList.add('hint'); });
    hintsLeft--;
    updateHintButton();
    setTimeout(function () {
      placement.cells.forEach(function (p) { cellEls[p[0]][p[1]].classList.remove('hint'); });
    }, 1500);
  }
  function updateHintButton() {
    if (!hintBtn) return;
    hintBtn.textContent = t('hint') + ' (' + hintsLeft + ')';
    hintBtn.disabled = hintsLeft <= 0;
  }

  function giveUp() {
    if (!puzzle) return;
    stopTimer();
    puzzle.words.forEach(function (word) {
      if (foundWords[word]) return;
      var placement = puzzle.placements.filter(function (p) { return p.word === word; })[0];
      if (!placement) return;
      placement.cells.forEach(function (p) { cellEls[p[0]][p[1]].classList.add('revealed'); });
      var chip = wordChipEls[word];
      if (chip) chip.classList.add('revealed');
    });
    if (revealedModal) revealedModal.classList.remove('hidden');
  }

  function onPuzzleSolved() {
    stopTimer();
    var timeMs = elapsedMsAtStop;
    if (winTimeEl) winTimeEl.textContent = formatTime(timeMs);
    if (winModal) winModal.classList.remove('hidden');
    var isNewBest = setLocalBest(currentDifficulty, timeMs);
    renderBest();
    submitScore(currentDifficulty, timeMs);
    bumpPlaysAndMaybeShowAdBreak(null);
  }

  function startPuzzle(difficulty) {
    currentDifficulty = difficulty;
    puzzle = generateWordSearchPuzzle({ difficulty: difficulty, lang: currentLang });
    foundWords = {};
    hintsLeft = HINT_LIMIT;
    renderGrid();
    renderWordList();
    renderBest();
    updateHintButton();
    loadLeaderboard(difficulty);
    startTimer();
    if (startModal) startModal.classList.add('hidden');
    if (winModal) winModal.classList.add('hidden');
    if (revealedModal) revealedModal.classList.add('hidden');
  }

  function applyLanguage(lang) {
    currentLang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    if (langEnBtn) langEnBtn.classList.toggle('active', lang === 'en');
    if (langEsBtn) langEsBtn.classList.toggle('active', lang === 'es');
    if (difficultyButtonsEl) {
      DIFFICULTY_ORDER.forEach(function (d) {
        var btn = difficultyButtonsEl.querySelector('[data-difficulty="' + d + '"]');
        if (btn) btn.textContent = t(d);
      });
    }
    if (hintBtn) updateHintButton();
    if (giveUpBtn) giveUpBtn.textContent = t('giveUp');
    if (newGameBtn) newGameBtn.textContent = t('newGame');
    if (settingsBtn) settingsBtn.textContent = t('settings');
    if (winPlayAgainBtn) winPlayAgainBtn.textContent = t('playAgain');
    if (revealedPlayAgainBtn) revealedPlayAgainBtn.textContent = t('playAgain');
  }

  if (langEnBtn) langEnBtn.addEventListener('click', function () { applyLanguage('en'); });
  if (langEsBtn) langEsBtn.addEventListener('click', function () { applyLanguage('es'); });

  if (difficultyButtonsEl) {
    difficultyButtonsEl.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-difficulty]') : null;
      if (!btn) return;
      startPuzzle(btn.dataset.difficulty);
    });
  }

  if (hintBtn) hintBtn.addEventListener('click', useHint);
  if (giveUpBtn) giveUpBtn.addEventListener('click', giveUp);
  if (newGameBtn) newGameBtn.addEventListener('click', function () { startPuzzle(currentDifficulty); });
  if (settingsBtn) settingsBtn.addEventListener('click', function () { if (startModal) startModal.classList.remove('hidden'); });
  if (winPlayAgainBtn) winPlayAgainBtn.addEventListener('click', function () { startPuzzle(currentDifficulty); });
  if (revealedPlayAgainBtn) revealedPlayAgainBtn.addEventListener('click', function () { startPuzzle(currentDifficulty); });

  applyLanguage(currentLang);
})();
}
