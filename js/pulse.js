/*
  Color Pulse (play/pulse.html) — una bola avanza sola por un camino
  lleno de puertas de colores. Cada toque hace avanzar el color de la
  bola un paso en el ciclo (rojo → azul → verde → amarillo → rojo...).
  Solo se puede cruzar una puerta si el color coincide en ese momento.
  La velocidad sube todo el tiempo. Todo dibujado a mano en canvas
  (glow con shadowBlur), sin sprites. Sonido sintetizado con Web Audio
  API. Mismo patrón de tabla de posiciones (api/pulse.js) y pausa
  publicitaria cada 3 partidas que los otros juegos.
*/
(function () {
  var canvas = document.getElementById('pulseCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var CY = H / 2;
  var BALL_RADIUS = 14;
  var BALL_SCREEN_X = 160;
  var GATE_W = 20;

  var COLORS = [
    { name: 'Red', hex: '#FF3D57' },
    { name: 'Blue', hex: '#3D8BFF' },
    { name: 'Green', hex: '#39FF6A' },
    { name: 'Yellow', hex: '#FFC933' }
  ];

  var scoreEl = document.getElementById('pulseScore');
  var bestEl = document.getElementById('pulseBest');
  var muteBtn = document.getElementById('pulseMute');
  var overlay = document.getElementById('pulseOverlay');
  var overlayText = document.getElementById('pulseOverlayText');
  var nameModal = document.getElementById('pulseNameModal');
  var nameInput = document.getElementById('pulseNameInput');
  var nameSaveBtn = document.getElementById('pulseNameSave');
  var nameSkipBtn = document.getElementById('pulseNameSkip');
  var adBreak = document.getElementById('pulseAdBreak');
  var adBreakContinueBtn = document.getElementById('pulseAdBreakContinue');
  var lbList = document.getElementById('pulseLeaderboardList');
  var lbYou = document.getElementById('pulseYouRank');

  var BEST_KEY = 'vexlow_pulse_best';
  var PLAYS_KEY = 'vexlow_pulse_plays';
  var AD_BREAK_INTERVAL = 3;
  var MUTE_KEY = 'vexlow_pulse_muted';
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
    } catch (e) {}
    return id;
  }
  var visitorId = getVisitorId();

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
    fetch('/api/pulse?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        if (data && best > 0 && (!data.you || best > data.you.score)) submitScore(best);
      })
      .catch(function () {});
  }
  function doSubmit(name, finalScore) {
    fetch('/api/pulse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, score: finalScore, visitorId: visitorId })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(renderLeaderboard).catch(function () {});
  }
  function submitScore(finalScore) {
    if (!visitorId || finalScore <= 0) return;
    var name = null;
    try { name = localStorage.getItem(NAME_KEY); } catch (e) {}
    if (!name) openNameModal('', function (chosenName) { doSubmit(chosenName, finalScore); });
    else doSubmit(name, finalScore);
  }
  if (lbYou) {
    lbYou.addEventListener('click', function () {
      var current = null;
      try { current = localStorage.getItem(NAME_KEY); } catch (e) {}
      openNameModal(current || '', function () { loadLeaderboard(); });
    });
  }

  /* ---- Sonido ---- */
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
  function playCycle() { beep(600, 850, 0.06, 'square', 0.08); }
  function playPass() { beep(900, 1300, 0.08, 'sine', 0.1); }
  function playCrash() {
    if (muted) return;
    var ac = getAudioCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    var bufferSize = ac.sampleRate * 0.32;
    var buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    var noise = ac.createBufferSource();
    noise.buffer = buffer;
    var gain = ac.createGain();
    gain.gain.setValueAtTime(0.25, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.32);
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
  var BASE_SPEED = 0.30, MAX_SPEED = 0.7;
  var SPEED_RAMP_PER_SEC = 0.0032;
  var BASE_GATE_GAP = 340, MIN_GATE_GAP = 165;
  var MIN_WARNING_MS = 900; // tiempo mínimo visible antes de llegar a una puerta

  var state, ballColor, worldX, speed, gates, particles, score, elapsedMs, lastTime;
  var distanceSinceSpawn, nextGateGap;

  function resetGame() {
    ballColor = 0;
    worldX = 0;
    speed = BASE_SPEED;
    gates = [];
    particles = [];
    score = 0;
    elapsedMs = 0;
    lastTime = null;
    distanceSinceSpawn = 0;
    nextGateGap = 420;
    state = 'ready';
    scoreEl.textContent = 'Score: 0';
    overlayText.textContent = 'Tap or press Space to start';
    overlay.classList.remove('hidden');
  }

  function toScreenX(wx) { return wx - worldX + BALL_SCREEN_X; }

  function cycleColor() {
    if (state === 'ready') { startGame(); return; }
    if (state === 'gameover') { resetGame(); return; }
    if (state !== 'playing') return;
    ballColor = (ballColor + 1) % COLORS.length;
    playCycle();
    spawnParticles(BALL_SCREEN_X, CY, COLORS[ballColor].hex, 8);
  }

  function startGame() {
    state = 'playing';
    overlay.classList.add('hidden');
  }

  function endGame() {
    if (state !== 'playing') return;
    state = 'gameover';
    playCrash();
    var finalScore = Math.round(score);
    if (finalScore > best) {
      best = finalScore;
      localStorage.setItem(BEST_KEY, String(best));
      bestEl.textContent = 'Best: ' + best;
      overlayText.textContent = 'New best! ' + finalScore + ' — tap to retry';
      submitScore(finalScore);
    } else {
      overlayText.textContent = 'Score: ' + finalScore + ' — tap to retry';
    }
    spawnParticles(BALL_SCREEN_X, CY, '#FFFFFF', 20);

    var plays = parseInt(localStorage.getItem(PLAYS_KEY) || '0', 10) || 0;
    plays++;
    localStorage.setItem(PLAYS_KEY, String(plays));
    if (plays % AD_BREAK_INTERVAL === 0) {
      adBreak.classList.remove('hidden');
    } else {
      overlay.classList.remove('hidden');
    }
  }

  if (adBreakContinueBtn) {
    adBreakContinueBtn.addEventListener('click', function () {
      adBreak.classList.add('hidden');
      overlay.classList.remove('hidden');
    });
  }

  function spawnGate() {
    var colorIndex = Math.floor(Math.random() * COLORS.length);
    gates.push({ x: worldX + W + 40, colorIndex: colorIndex, passed: false });
  }

  /* ---- Partículas ---- */
  var MAX_PARTICLES = 90;
  function spawnParticles(x, y, color, count) {
    for (var i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      var a = Math.random() * Math.PI * 2;
      var s = 0.05 + Math.random() * 0.18;
      particles.push({ x: x, y: y, color: color, born: elapsedMs, life: 300 + Math.random() * 260, vx: Math.cos(a) * s, vy: Math.sin(a) * s });
    }
  }
  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      if (elapsedMs - p.born > p.life) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }
  function drawParticles() {
    particles.forEach(function (p) {
      var t = (elapsedMs - p.born) / p.life;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  /* ---- Update ---- */
  function update(dt) {
    if (state !== 'playing') return;

    speed = Math.min(MAX_SPEED, BASE_SPEED + (elapsedMs / 1000) * SPEED_RAMP_PER_SEC);
    worldX += speed * dt;

    distanceSinceSpawn += speed * dt;
    if (distanceSinceSpawn >= nextGateGap) {
      spawnGate();
      distanceSinceSpawn = 0;
      var minGap = Math.max(MIN_GATE_GAP, speed * MIN_WARNING_MS);
      nextGateGap = Math.max(minGap, BASE_GATE_GAP - elapsedMs / 1000 * 2.4 + Math.random() * 120);
    }

    for (var i = gates.length - 1; i >= 0; i--) {
      var g = gates[i];
      var sx = toScreenX(g.x);
      if (sx < -60) { gates.splice(i, 1); continue; }
      if (!g.passed && sx <= BALL_SCREEN_X + BALL_RADIUS) {
        if (g.colorIndex === ballColor) {
          g.passed = true;
          score += 10;
          playPass();
          spawnParticles(sx, CY, COLORS[g.colorIndex].hex, 10);
        } else {
          endGame();
          return;
        }
      }
    }

    updateParticles(dt);
    score += speed * dt * 0.02;
    scoreEl.textContent = 'Score: ' + Math.round(score);
  }

  /* ---- Draw ---- */
  function draw() {
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, CY);
    ctx.lineTo(W, CY);
    ctx.stroke();

    gates.forEach(function (g) {
      var sx = toScreenX(g.x);
      if (sx < -40 || sx > W + 40) return;
      var color = COLORS[g.colorIndex].hex;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = color;
      ctx.fillRect(sx - GATE_W / 2, CY - 90, GATE_W, 180);
      ctx.restore();
    });

    ctx.save();
    ctx.shadowColor = COLORS[ballColor].hex;
    ctx.shadowBlur = 18;
    ctx.fillStyle = COLORS[ballColor].hex;
    ctx.beginPath();
    ctx.arc(BALL_SCREEN_X, CY, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawParticles();
  }

  function loop(time) {
    if (lastTime === null) lastTime = time;
    var dt = Math.min(time - lastTime, 40);
    lastTime = time;
    if (state === 'playing') elapsedMs += dt;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); cycleColor(); }, { passive: false });
  canvas.addEventListener('mousedown', function (e) { if (e.button === 0) cycleColor(); });
  overlay.addEventListener('touchstart', function (e) { e.preventDefault(); cycleColor(); }, { passive: false });
  overlay.addEventListener('mousedown', function (e) { if (e.button === 0) cycleColor(); });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); cycleColor(); }
  });

  resetGame();
  requestAnimationFrame(loop);
  loadLeaderboard();
})();
