/*
  Vex Dash (play/dash.html) — corredor infinito simple tipo Geometry Dash.
  Tap/click/espacio para saltar, esquivar los picos, la velocidad y la
  frecuencia de picos en grupo suben con el puntaje. Todo el audio se
  genera con Web Audio API (osciladores, sin archivos de sonido externos)
  para no depender de licencias de terceros. Mejor puntaje personal en
  localStorage, y una tabla de posiciones global vía Redis (api/dash.js,
  mismo patrón que las reacciones y la trivia).
*/
(function () {
  var canvas = document.getElementById('dashCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var GROUND_Y = H - 50;

  var scoreEl = document.getElementById('dashScore');
  var bestEl = document.getElementById('dashBest');
  var muteBtn = document.getElementById('dashMute');
  var overlay = document.getElementById('dashOverlay');
  var overlayText = document.getElementById('dashOverlayText');
  var lbList = document.getElementById('dashLeaderboardList');
  var lbYou = document.getElementById('dashYouRank');

  var BEST_KEY = 'vexlow_dash_best';
  var MUTE_KEY = 'vexlow_dash_muted';
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
    fetch('/api/dash?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(renderLeaderboard)
      .catch(function () {});
  }

  function submitScore(finalScore) {
    if (!visitorId || finalScore <= 0) return;
    var name = null;
    try { name = localStorage.getItem(NAME_KEY); } catch (e) {}
    if (!name) {
      name = (window.prompt('New best! Enter your name for the leaderboard (max 14 characters):', 'Player') || 'Player').trim().slice(0, 14) || 'Player';
      try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
    }
    fetch('/api/dash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, score: finalScore, visitorId: visitorId })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(renderLeaderboard)
      .catch(function () {});
  }

  if (lbYou) {
    lbYou.addEventListener('click', function () {
      var current = null;
      try { current = localStorage.getItem(NAME_KEY); } catch (e) {}
      var name = (window.prompt('Change your leaderboard name (max 14 characters):', current || 'Player') || '').trim().slice(0, 14);
      if (name) {
        try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
      }
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
  function playJump() { beep(420, 720, 0.12, 'square', 0.12); }
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
  function playPoint() { beep(880, 1046, 0.08, 'sine', 0.08); }

  muteBtn.addEventListener('click', function () {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  /* ---- Estado del juego ---- */
  var PLAYER_SIZE = 30;
  var GRAVITY = 0.0022;
  var JUMP_VELOCITY = -0.85;
  var BASE_SPEED = 0.32;
  var MAX_SPEED_SCORE = 6000;
  var SPEED_RATE = 0.00008;

  var player, obstacles, speed, score, distanceSinceSpawn, nextSpawnGap, state, lastTime, scoreMilestone;

  function resetGame() {
    player = { x: 90, y: GROUND_Y - PLAYER_SIZE, vy: 0, rot: 0, onGround: true };
    obstacles = [];
    speed = BASE_SPEED;
    score = 0;
    scoreMilestone = 0;
    distanceSinceSpawn = 0;
    nextSpawnGap = 260 + Math.random() * 140;
    state = 'ready';
    lastTime = null;
    scoreEl.textContent = 'Score: 0';
    overlayText.textContent = 'Tap or press Space to start';
    overlay.classList.remove('hidden');
  }

  function jump() {
    if (state === 'ready') { startGame(); return; }
    if (state === 'gameover') { resetGame(); return; }
    if (state === 'playing' && player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      playJump();
    }
  }

  function startGame() {
    state = 'playing';
    overlay.classList.add('hidden');
  }

  function endGame() {
    state = 'gameover';
    playCrash();
    var finalScore = Math.floor(score);
    if (finalScore > best) {
      best = finalScore;
      localStorage.setItem(BEST_KEY, String(best));
      bestEl.textContent = 'Best: ' + best;
      overlayText.textContent = 'New best! ' + finalScore + ' — tap to retry';
      submitScore(finalScore);
    } else {
      overlayText.textContent = 'Score: ' + finalScore + ' — tap to retry';
    }
    overlay.classList.remove('hidden');
  }

  /* Cuanto más puntaje, más chance de que salga un grupo de 2-3 picos
     seguidos en vez de uno solo — obliga a saltar antes y calcular mejor,
     sin depender solo de subir la velocidad hasta hacerlo injugable. */
  function spawnObstacle() {
    var clusterChance = score > 1200 ? 0.55 : score > 500 ? 0.32 : score > 150 ? 0.12 : 0;
    var clusterSize = 1;
    var r = Math.random();
    if (r < clusterChance * 0.35) clusterSize = 3;
    else if (r < clusterChance) clusterSize = 2;
    for (var i = 0; i < clusterSize; i++) {
      var h = 26 + Math.random() * 22;
      obstacles.push({ x: W + 20 + i * 32, w: 26, h: h });
    }
  }

  function update(dt) {
    if (state !== 'playing') return;

    speed = BASE_SPEED + Math.min(score, MAX_SPEED_SCORE) * SPEED_RATE;

    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    if (player.y >= GROUND_Y - PLAYER_SIZE) {
      player.y = GROUND_Y - PLAYER_SIZE;
      player.vy = 0;
      player.onGround = true;
    }
    if (!player.onGround) player.rot += 0.012 * dt;
    else player.rot = 0;

    distanceSinceSpawn += speed * dt;
    if (distanceSinceSpawn >= nextSpawnGap) {
      spawnObstacle();
      distanceSinceSpawn = 0;
      nextSpawnGap = 260 + Math.random() * 160 - Math.min(score, 3000) * 0.025;
      if (nextSpawnGap < 150) nextSpawnGap = 150;
    }

    for (var i = obstacles.length - 1; i >= 0; i--) {
      obstacles[i].x -= speed * dt;
      if (obstacles[i].x < -40) obstacles.splice(i, 1);
    }

    var px = player.x, py = player.y, ps = PLAYER_SIZE;
    for (var j = 0; j < obstacles.length; j++) {
      var o = obstacles[j];
      var ox = o.x, oy = GROUND_Y - o.h, ow = o.w, oh = o.h;
      var pad = 6;
      if (px + ps - pad > ox && px + pad < ox + ow && py + ps - pad > oy) {
        endGame();
        return;
      }
    }

    score += speed * dt * 0.05;
    var displayScore = Math.floor(score);
    scoreEl.textContent = 'Score: ' + displayScore;
    if (displayScore > 0 && displayScore % 10 === 0 && displayScore !== scoreMilestone) {
      scoreMilestone = displayScore;
      playPoint();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(120,130,150,.25)';
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = 'rgba(120,130,150,.5)';
    ctx.fillRect(0, GROUND_Y, W, 2);

    ctx.fillStyle = '#E5484D';
    for (var j = 0; j < obstacles.length; j++) {
      var o = obstacles[j];
      var baseY = GROUND_Y;
      ctx.beginPath();
      ctx.moveTo(o.x, baseY);
      ctx.lineTo(o.x + o.w / 2, baseY - o.h);
      ctx.lineTo(o.x + o.w, baseY);
      ctx.closePath();
      ctx.fill();
    }

    ctx.save();
    ctx.translate(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2);
    ctx.rotate(player.rot);
    ctx.fillStyle = '#3D8BFF';
    ctx.fillRect(-PLAYER_SIZE / 2, -PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE);
    ctx.restore();
  }

  function loop(time) {
    if (lastTime === null) lastTime = time;
    var dt = Math.min(time - lastTime, 40);
    lastTime = time;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    jump();
  }, { passive: false });
  canvas.addEventListener('mousedown', jump);
  overlay.addEventListener('touchstart', function (e) { e.preventDefault(); jump(); }, { passive: false });
  overlay.addEventListener('mousedown', jump);
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      jump();
    }
  });

  resetGame();
  requestAnimationFrame(loop);
  loadLeaderboard();
})();
