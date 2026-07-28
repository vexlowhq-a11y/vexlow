/*
  Neon Orbit (play/orbit.html) — una esfera gira sola alrededor de un
  núcleo brillante; cada toque invierte el sentido de giro (horario
  ↔ antihorario). Bloques aparecen desde el borde y avanzan hacia el
  centro — si uno cruza tu órbita justo donde estás parado, perdés.
  Un solo input, partidas cortas, dificultad que sube sola. Todo
  dibujado a mano en canvas (glow con shadowBlur), sin sprites — el
  estilo minimalista neón no los necesita. Sonido sintetizado con Web
  Audio API. Mismo patrón de tabla de posiciones (api/orbit.js) y
  pausa publicitaria cada 3 partidas que los otros juegos.
*/
(function () {
  var canvas = document.getElementById('orbitCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var CX = W / 2, CY = H / 2;

  var CORE_RADIUS = 24;
  var PLAYER_ORBIT_RADIUS = 95;
  var PLAYER_DOT_RADIUS = 7;
  var SPAWN_RADIUS = 175;

  var scoreEl = document.getElementById('orbitScore');
  var bestEl = document.getElementById('orbitBest');
  var muteBtn = document.getElementById('orbitMute');
  var overlay = document.getElementById('orbitOverlay');
  var overlayText = document.getElementById('orbitOverlayText');
  var nameModal = document.getElementById('orbitNameModal');
  var nameInput = document.getElementById('orbitNameInput');
  var nameSaveBtn = document.getElementById('orbitNameSave');
  var nameSkipBtn = document.getElementById('orbitNameSkip');
  var adBreak = document.getElementById('orbitAdBreak');
  var adBreakContinueBtn = document.getElementById('orbitAdBreakContinue');
  var lbList = document.getElementById('orbitLeaderboardList');
  var lbYou = document.getElementById('orbitYouRank');

  var BEST_KEY = 'vexlow_orbit_best';
  var PLAYS_KEY = 'vexlow_orbit_plays';
  var AD_BREAK_INTERVAL = 3;
  var MUTE_KEY = 'vexlow_orbit_muted';
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

  /* ---- Ventana de nombre (misma clave que los otros juegos) ---- */
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
    fetch('/api/orbit?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        if (data && best > 0 && (!data.you || best > data.you.score)) submitScore(best);
      })
      .catch(function () {});
  }
  function doSubmit(name, finalScore) {
    fetch('/api/orbit', {
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

  /* ---- Sonido: todo sintetizado ---- */
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
  function playFlip() { beep(500, 720, 0.07, 'square', 0.09); }
  function playDodge() { beep(1000, 1200, 0.05, 'sine', 0.04); }
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
  var ANGULAR_SPEED = 0.0032; // rad/ms
  var BASE_INWARD_SPEED = 0.048, MAX_INWARD_SPEED = 0.12;
  var BASE_WAVE_MS = 950, MIN_WAVE_MS = 400;
  var OBSTACLE_HALF_WIDTH = 0.24; // rad (~27.5° de ancho total)
  var PLAYER_ANGULAR_TOL = 0.11;
  var RADIUS_TOL = 11;

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? Math.PI * 2 - d : d;
  }

  var state, player, obstacles, particles, score, best_ignored, elapsedMs, lastTime;
  var waveTimer, dodgeCount;
  var trail;

  function resetGame() {
    player = { angle: -Math.PI / 2, dir: 1 };
    obstacles = [];
    particles = [];
    trail = [];
    score = 0;
    elapsedMs = 0;
    lastTime = null;
    waveTimer = 600;
    dodgeCount = 0;
    state = 'ready';
    scoreEl.textContent = 'Score: 0';
    overlayText.textContent = 'Tap or press Space to start';
    overlay.classList.remove('hidden');
  }

  function currentInwardSpeed() {
    return Math.min(MAX_INWARD_SPEED, BASE_INWARD_SPEED + (elapsedMs / 1000) * 0.0011);
  }
  function currentWaveMs() {
    return Math.max(MIN_WAVE_MS, BASE_WAVE_MS - (elapsedMs / 1000) * 9);
  }
  function twoObstacleChance() {
    return Math.min(0.5, Math.max(0, (elapsedMs / 1000 - 18) * 0.012));
  }
  function driftChance() {
    return Math.min(0.4, Math.max(0, (elapsedMs / 1000 - 35) * 0.01));
  }

  function spawnObstacle(angle) {
    var drift = Math.random() < driftChance() ? (Math.random() < 0.5 ? -1 : 1) * (0.0004 + Math.random() * 0.0007) : 0;
    obstacles.push({
      angle: angle, radius: SPAWN_RADIUS, halfWidth: OBSTACLE_HALF_WIDTH,
      speed: currentInwardSpeed(), drift: drift, scored: false
    });
  }
  function spawnWave() {
    var angle1 = Math.random() * Math.PI * 2;
    spawnObstacle(angle1);
    if (Math.random() < twoObstacleChance()) {
      var angle2 = angle1 + Math.PI + (Math.random() - 0.5) * 1.2;
      spawnObstacle(angle2);
    }
  }

  function flip() {
    if (state === 'ready') { startGame(); return; }
    if (state === 'gameover') { resetGame(); return; }
    if (state !== 'playing') return;
    player.dir *= -1;
    playFlip();
    spawnParticles(CX + Math.cos(player.angle) * PLAYER_ORBIT_RADIUS, CY + Math.sin(player.angle) * PLAYER_ORBIT_RADIUS, '#FFFFFF', 6);
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
    spawnParticles(CX + Math.cos(player.angle) * PLAYER_ORBIT_RADIUS, CY + Math.sin(player.angle) * PLAYER_ORBIT_RADIUS, '#FF3D57', 22);

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

  /* ---- Partículas (pooling simple) ---- */
  var MAX_PARTICLES = 90;
  function spawnParticles(x, y, color, count) {
    for (var i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      var a = Math.random() * Math.PI * 2;
      var s = 0.05 + Math.random() * 0.15;
      particles.push({
        x: x, y: y, color: color, born: elapsedMs, life: 300 + Math.random() * 300,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s
      });
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

    player.angle += player.dir * ANGULAR_SPEED * dt;

    trail.push({ x: CX + Math.cos(player.angle) * PLAYER_ORBIT_RADIUS, y: CY + Math.sin(player.angle) * PLAYER_ORBIT_RADIUS });
    if (trail.length > 14) trail.shift();

    waveTimer -= dt;
    if (waveTimer <= 0) {
      spawnWave();
      waveTimer = currentWaveMs();
    }

    for (var i = obstacles.length - 1; i >= 0; i--) {
      var o = obstacles[i];
      o.radius -= o.speed * dt;
      o.angle += o.drift * dt;

      if (!o.scored && Math.abs(o.radius - PLAYER_ORBIT_RADIUS) < RADIUS_TOL) {
        if (angleDiff(o.angle, player.angle) < o.halfWidth + PLAYER_ANGULAR_TOL) {
          endGame();
          return;
        }
      }
      if (o.radius < CORE_RADIUS - 6) {
        if (!o.scored) { score += 5; dodgeCount++; playDodge(); }
        obstacles.splice(i, 1);
      }
    }

    updateParticles(dt);
    score += dt * 0.012;
    scoreEl.textContent = 'Score: ' + Math.round(score);
  }

  /* ---- Draw ---- */
  function draw(time) {
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);

    // guía de órbita, muy tenue
    ctx.strokeStyle = 'rgba(120,140,200,.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(CX, CY, PLAYER_ORBIT_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    // núcleo pulsante
    var pulse = 1 + Math.sin(time / 260) * 0.06;
    ctx.save();
    ctx.shadowColor = '#7CE8FF';
    ctx.shadowBlur = 26;
    ctx.fillStyle = '#B6F6FF';
    ctx.beginPath();
    ctx.arc(CX, CY, CORE_RADIUS * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // obstáculos: cuñas neón
    obstacles.forEach(function (o) {
      ctx.save();
      ctx.shadowColor = '#FF7A3D';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = '#FF7A3D';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(CX, CY, Math.max(2, o.radius), o.angle - o.halfWidth, o.angle + o.halfWidth);
      ctx.stroke();
      ctx.restore();
    });

    // estela del jugador
    for (var i = 0; i < trail.length; i++) {
      var t = trail[i];
      ctx.save();
      ctx.globalAlpha = (i / trail.length) * 0.35;
      ctx.fillStyle = player.dir > 0 ? '#3D8BFF' : '#FF3DAE';
      ctx.beginPath();
      ctx.arc(t.x, t.y, PLAYER_DOT_RADIUS * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // jugador
    var px = CX + Math.cos(player.angle) * PLAYER_ORBIT_RADIUS;
    var py = CY + Math.sin(player.angle) * PLAYER_ORBIT_RADIUS;
    ctx.save();
    ctx.shadowColor = player.dir > 0 ? '#3D8BFF' : '#FF3DAE';
    ctx.shadowBlur = 16;
    ctx.fillStyle = player.dir > 0 ? '#8FC4FF' : '#FF9CD9';
    ctx.beginPath();
    ctx.arc(px, py, PLAYER_DOT_RADIUS, 0, Math.PI * 2);
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
    draw(time);
    requestAnimationFrame(loop);
  }

  /* ---- Controles: toque, clic izquierdo, barra espaciadora ---- */
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); flip(); }, { passive: false });
  canvas.addEventListener('mousedown', function (e) { if (e.button === 0) flip(); });
  overlay.addEventListener('touchstart', function (e) { e.preventDefault(); flip(); }, { passive: false });
  overlay.addEventListener('mousedown', function (e) { if (e.button === 0) flip(); });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); flip(); }
  });

  resetGame();
  requestAnimationFrame(loop);
  loadLeaderboard();
})();
