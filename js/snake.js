/*
  Neon Snake Survival (play/snake.html) — snake clásico con estética
  neón. El tablero, la grilla y el cuerpo se dibujan a mano en canvas
  (glow con shadowBlur); la cabeza, la comida y el destello al comer
  usan sprites neón que el usuario generó con ChatGPT (img/snake/).
  Sonido sintetizado con Web Audio API, igual que Vex Dash. Mejor
  puntaje personal en localStorage y tabla de posiciones global vía
  Redis (api/snake.js, mismo patrón que api/dash.js). El nombre para
  la tabla de posiciones usa la MISMA clave que Vex Dash a propósito,
  para que sea un solo nombre de jugador compartido entre los dos
  juegos.
*/
(function () {
  var canvas = document.getElementById('snakeCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var CELL = 20;
  var COLS = W / CELL, ROWS = H / CELL;

  var scriptEl = document.currentScript || document.querySelector('script[src*="js/snake.js"]');
  var imgPrefix = ((scriptEl && scriptEl.getAttribute('src')) || 'js/snake.js').replace(/js\/snake\.js(\?.*)?$/, '') + 'img/snake/';
  function loadImg(name) {
    var img = new Image();
    img.src = imgPrefix + name;
    return img;
  }
  var headImg = loadImg('head.png');
  var foodImg = loadImg('food.png');
  var sparkleImg = loadImg('sparkle.png');

  var scoreEl = document.getElementById('snakeScore');
  var bestEl = document.getElementById('snakeBest');
  var muteBtn = document.getElementById('snakeMute');
  var overlay = document.getElementById('snakeOverlay');
  var overlayText = document.getElementById('snakeOverlayText');
  var lbList = document.getElementById('snakeLeaderboardList');
  var lbYou = document.getElementById('snakeYouRank');
  var nameModal = document.getElementById('snakeNameModal');
  var nameInput = document.getElementById('snakeNameInput');
  var nameSaveBtn = document.getElementById('snakeNameSave');
  var nameSkipBtn = document.getElementById('snakeNameSkip');
  var adBreak = document.getElementById('snakeAdBreak');
  var adBreakContinueBtn = document.getElementById('snakeAdBreakContinue');

  var BEST_KEY = 'vexlow_snake_best';
  var PLAYS_KEY = 'vexlow_snake_plays';
  var AD_BREAK_INTERVAL = 3;
  var MUTE_KEY = 'vexlow_snake_muted';
  var NAME_KEY = 'vexlow_dash_name';
  var VID_KEY = 'vexlow_vid';
  var best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;
  var muted = localStorage.getItem(MUTE_KEY) === '1';
  bestEl.textContent = 'Best: ' + best;
  muteBtn.textContent = muted ? '🔇' : '🔊';

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getVisitorId() {
    var id = null;
    try {
      id = localStorage.getItem(VID_KEY);
      if (!id) {
        id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        localStorage.setItem(VID_KEY, id);
      }
    } catch (e) { /* localStorage no disponible */ }
    return id;
  }
  var visitorId = getVisitorId();

  /* ---- Ventana propia para pedir el nombre (igual que en Vex Dash) ---- */
  var nameModalCallback = null;
  function openNameModal(prefill, onDone) {
    if (!nameModal) { onDone('Player'); return; }
    nameInput.value = prefill || '';
    nameModalCallback = onDone;
    nameModal.classList.remove('hidden');
    setTimeout(function () { nameInput.focus(); }, 0);
  }
  function commitName(rawValue) {
    var name = String(rawValue || '').trim().slice(0, 14) || 'Player';
    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
    nameModal.classList.add('hidden');
    var cb = nameModalCallback;
    nameModalCallback = null;
    if (cb) cb(name);
  }
  if (nameModal) {
    nameSaveBtn.addEventListener('click', function () { commitName(nameInput.value); });
    nameSkipBtn.addEventListener('click', function () { commitName('Player'); });
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitName(nameInput.value); }
    });
  }

  /* ---- Tabla de posiciones global ---- */
  function renderLeaderboard(data) {
    if (!lbList || !data) return;
    if (!data.top || !data.top.length) {
      lbList.innerHTML = '<li class="dash-lb-empty">No scores yet — be the first!</li>';
    } else {
      lbList.innerHTML = data.top.map(function (row, i) {
        var isYou = data.you && (i + 1) === data.you.rank;
        return '<li class="dash-lb-row' + (isYou ? ' dash-lb-you-row' : '') + '">' +
          '<span class="dash-lb-rank">' + (i + 1) + '</span>' +
          '<span class="dash-lb-name">' + escapeHtml(row.name) + '</span>' +
          '<span class="dash-lb-score">' + row.score + '</span></li>';
      }).join('');
    }
    if (lbYou) {
      if (data.you && data.you.rank > 10) {
        lbYou.hidden = false;
        lbYou.textContent = 'Your rank: #' + data.you.rank + ' (' + data.you.score + ' pts)';
      } else {
        lbYou.hidden = true;
      }
    }
  }

  function loadLeaderboard() {
    fetch('/api/snake?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        if (data && best > 0 && (!data.you || best > data.you.score)) {
          submitScore(best);
        }
      })
      .catch(function () {});
  }

  function doSubmit(name, finalScore) {
    fetch('/api/snake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, score: finalScore, visitorId: visitorId })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(renderLeaderboard)
      .catch(function () {});
  }

  function submitScore(finalScore) {
    if (!visitorId || finalScore <= 0) return;
    var name = null;
    try { name = localStorage.getItem(NAME_KEY); } catch (e) {}
    if (!name) {
      openNameModal('', function (chosenName) { doSubmit(chosenName, finalScore); });
    } else {
      doSubmit(name, finalScore);
    }
  }

  if (lbYou) {
    lbYou.addEventListener('click', function () {
      var current = null;
      try { current = localStorage.getItem(NAME_KEY); } catch (e) {}
      openNameModal(current || '', function () { loadLeaderboard(); });
    });
  }

  /* ---- Sonido: todo sintetizado, nada de audio grabado ---- */
  var audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    return audioCtx;
  }
  function beep(freqStart, freqEnd, duration, type, gainValue) {
    if (muted) return;
    var ac = getAudioCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freqStart, ac.currentTime);
    if (freqEnd) osc.frequency.linearRampToValueAtTime(freqEnd, ac.currentTime + duration);
    gain.gain.setValueAtTime(gainValue || 0.15, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + duration);
  }
  function playEat() { beep(700, 1250, 0.09, 'square', 0.12); }
  function playCrash() {
    if (muted) return;
    var ac = getAudioCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    var bufferSize = ac.sampleRate * 0.3;
    var buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    var noise = ac.createBufferSource();
    noise.buffer = buffer;
    var gain = ac.createGain();
    gain.gain.setValueAtTime(0.25, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.3);
    noise.connect(gain);
    gain.connect(ac.destination);
    noise.start();
  }

  muteBtn.addEventListener('click', function () {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  /* ---- Estado del juego ---- */
  var BASE_TICK_MS = 140;
  var MIN_TICK_MS = 70;

  var snake, dir, pendingDir, food, score, tickMs, tickAcc, state, lastTime, particles;

  function randomFoodCell() {
    var cell;
    do {
      cell = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
    } while (snake.some(function (s) { return s.x === cell.x && s.y === cell.y; }));
    return cell;
  }

  function resetGame() {
    var startY = Math.floor(ROWS / 2);
    snake = [{ x: 20, y: startY }, { x: 19, y: startY }, { x: 18, y: startY }];
    dir = { dx: 1, dy: 0 };
    pendingDir = dir;
    score = 0;
    tickMs = BASE_TICK_MS;
    tickAcc = 0;
    food = randomFoodCell();
    particles = [];
    state = 'ready';
    lastTime = null;
    scoreEl.textContent = 'Score: 0';
    overlayText.textContent = 'Tap or press Space to start';
    overlay.classList.remove('hidden');
  }

  function setDirection(dx, dy) {
    /* No dejamos girar 180° sobre la dirección actual en el mismo
       tick — chocarías contra tu propio cuerpo al instante. */
    if (dx === -dir.dx && dy === -dir.dy) return;
    pendingDir = { dx: dx, dy: dy };
  }

  function startGame() {
    state = 'playing';
    overlay.classList.add('hidden');
  }

  function beginOrTurn(dx, dy) {
    if (state === 'ready') {
      var storedName = null;
      try { storedName = localStorage.getItem(NAME_KEY); } catch (e) {}
      if (!storedName) {
        openNameModal('', function () { startGame(); });
      } else {
        startGame();
      }
      return;
    }
    if (state === 'gameover') { resetGame(); return; }
    if (state === 'playing') setDirection(dx, dy);
  }

  function endGame() {
    state = 'gameover';
    playCrash();
    var finalScore = score;
    if (finalScore > best) {
      best = finalScore;
      localStorage.setItem(BEST_KEY, String(best));
      bestEl.textContent = 'Best: ' + best;
      overlayText.textContent = 'New best! ' + finalScore + ' — tap to retry';
      submitScore(finalScore);
    } else {
      overlayText.textContent = 'Score: ' + finalScore + ' — tap to retry';
    }

    var plays = parseInt(localStorage.getItem(PLAYS_KEY) || '0', 10) || 0;
    plays++;
    try { localStorage.setItem(PLAYS_KEY, String(plays)); } catch (e) {}
    if (adBreak && plays % AD_BREAK_INTERVAL === 0) {
      state = 'adbreak';
      adBreak.classList.remove('hidden');
    } else {
      overlay.classList.remove('hidden');
    }
  }

  if (adBreakContinueBtn) {
    adBreakContinueBtn.addEventListener('click', function () {
      adBreak.classList.add('hidden');
      state = 'gameover';
      overlay.classList.remove('hidden');
    });
  }

  function tick() {
    dir = pendingDir;
    var head = snake[0];
    var newHead = { x: head.x + dir.dx, y: head.y + dir.dy };

    if (newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS) {
      endGame();
      return;
    }
    var hitsSelf = snake.some(function (s, i) {
      return i < snake.length - 1 && s.x === newHead.x && s.y === newHead.y;
    });
    if (hitsSelf) {
      endGame();
      return;
    }

    snake.unshift(newHead);
    if (newHead.x === food.x && newHead.y === food.y) {
      score += 10;
      scoreEl.textContent = 'Score: ' + score;
      playEat();
      particles.push({ x: food.x, y: food.y, born: performance.now() });
      food = randomFoodCell();
      tickMs = Math.max(MIN_TICK_MS, BASE_TICK_MS - score * 0.4);
    } else {
      snake.pop();
    }
  }

  function update(dt) {
    if (state !== 'playing') return;
    tickAcc += dt;
    while (tickAcc >= tickMs) {
      tickAcc -= tickMs;
      tick();
      if (state !== 'playing') break;
    }
  }

  function drawGrid() {
    ctx.strokeStyle = 'rgba(0, 255, 242, .05)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= COLS; gx++) {
      ctx.beginPath();
      ctx.moveTo(gx * CELL + 0.5, 0);
      ctx.lineTo(gx * CELL + 0.5, H);
      ctx.stroke();
    }
    for (var gy = 0; gy <= ROWS; gy++) {
      ctx.beginPath();
      ctx.moveTo(0, gy * CELL + 0.5);
      ctx.lineTo(W, gy * CELL + 0.5);
      ctx.stroke();
    }
  }

  function drawGlowRect(x, y, color, blur) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.fillStyle = color;
    var pad = 2;
    ctx.fillRect(x * CELL + pad, y * CELL + pad, CELL - pad * 2, CELL - pad * 2);
    ctx.restore();
  }

  function drawFood(time) {
    var cx = food.x * CELL + CELL / 2, cy = food.y * CELL + CELL / 2;
    if (foodImg.complete && foodImg.naturalWidth) {
      var pulse = 1 + Math.sin(time / 180) * 0.08;
      var size = CELL * 1.5 * pulse;
      ctx.drawImage(foodImg, cx - size / 2, cy - size / 2, size, size);
    } else {
      ctx.save();
      ctx.shadowColor = '#ff2fd0';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#ff2fd0';
      ctx.beginPath();
      ctx.arc(cx, cy, CELL / 2 - 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawHead() {
    var head = snake[0];
    var cx = head.x * CELL + CELL / 2, cy = head.y * CELL + CELL / 2;
    if (!headImg.complete || !headImg.naturalWidth) { drawGlowRect(head.x, head.y, '#B6FFF6', 16); return; }
    var angle = Math.atan2(dir.dy, dir.dx);
    var size = CELL * 1.9;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.drawImage(headImg, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  var PARTICLE_LIFETIME = 380;
  function drawParticles(time) {
    if (!sparkleImg.complete || !sparkleImg.naturalWidth) return;
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      var age = time - p.born;
      if (age > PARTICLE_LIFETIME) { particles.splice(i, 1); continue; }
      var t = age / PARTICLE_LIFETIME;
      var size = CELL * (1.5 + t * 2.2);
      var cx = p.x * CELL + CELL / 2, cy = p.y * CELL + CELL / 2;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.drawImage(sparkleImg, cx - size / 2, cy - size / 2, size, size);
      ctx.restore();
    }
  }

  function draw(time) {
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    drawFood(time);

    for (var i = snake.length - 1; i >= 1; i--) {
      drawGlowRect(snake[i].x, snake[i].y, '#39FF6A', 10);
    }
    drawHead();
    drawParticles(time);
  }

  function loop(time) {
    if (lastTime === null) lastTime = time;
    var dt = Math.min(time - lastTime, 40);
    lastTime = time;
    update(dt);
    draw(time);
    requestAnimationFrame(loop);
  }

  /* ---- Controles: flechas/WASD en escritorio, swipe en celular ---- */
  document.addEventListener('keydown', function (e) {
    var map = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0]
    };
    var v = map[e.key];
    if (!v) return;
    e.preventDefault();
    beginOrTurn(v[0], v[1]);
  });

  var touchStartX = 0, touchStartY = 0, touchActive = false;
  var SWIPE_THRESHOLD = 24;
  function onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    touchActive = true;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
  function onTouchEnd(e) {
    if (!touchActive) return;
    touchActive = false;
    var touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    var dx = touch.clientX - touchStartX;
    var dy = touch.clientY - touchStartY;
    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) {
      beginOrTurn(dir.dx, dir.dy);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) beginOrTurn(dx > 0 ? 1 : -1, 0);
    else beginOrTurn(0, dy > 0 ? 1 : -1);
  }
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); onTouchStart(e); }, { passive: false });
  canvas.addEventListener('touchend', function (e) { e.preventDefault(); onTouchEnd(e); }, { passive: false });
  overlay.addEventListener('touchstart', function (e) { e.preventDefault(); onTouchStart(e); }, { passive: false });
  overlay.addEventListener('touchend', function (e) { e.preventDefault(); onTouchEnd(e); }, { passive: false });
  canvas.addEventListener('mousedown', function () { beginOrTurn(dir.dx, dir.dy); });
  overlay.addEventListener('mousedown', function () { beginOrTurn(dir.dx, dir.dy); });

  /* ---- D-pad en pantalla (sprites del usuario, img/snake/) ---- */
  document.querySelectorAll('.snake-dpad-btn').forEach(function (btn) {
    var dx = parseInt(btn.getAttribute('data-dx'), 10);
    var dy = parseInt(btn.getAttribute('data-dy'), 10);
    btn.addEventListener('touchstart', function (e) { e.preventDefault(); beginOrTurn(dx, dy); }, { passive: false });
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); beginOrTurn(dx, dy); });
  });

  resetGame();
  requestAnimationFrame(loop);
  loadLeaderboard();
})();
