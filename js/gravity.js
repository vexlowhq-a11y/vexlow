/*
  Gravity Flip (play/gravity.html) — corredor automático tipo Geometry
  Dash / Gravity Guy. Un solo toque invierte la gravedad al instante
  (el personaje empieza a acelerar hacia el techo en vez del piso, o
  viceversa), esquivando pinchos, huecos, sierras y láseres en el piso
  o el techo. Todo dibujado a mano en canvas (glow con shadowBlur),
  sin sprites. Sonido sintetizado con Web Audio API. Mismo patrón de
  tabla de posiciones (api/gravity.js) y pausa publicitaria cada 3
  partidas que los otros juegos.
*/
(function () {
  var canvas = document.getElementById('gravityCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var FLOOR_Y = H - 50;
  var CEIL_Y = 50;
  var PLAYER_SIZE = 28;
  var PLAYER_SCREEN_X = 160;

  var scoreEl = document.getElementById('gravityScore');
  var bestEl = document.getElementById('gravityBest');
  var muteBtn = document.getElementById('gravityMute');
  var overlay = document.getElementById('gravityOverlay');
  var overlayText = document.getElementById('gravityOverlayText');
  var nameModal = document.getElementById('gravityNameModal');
  var nameInput = document.getElementById('gravityNameInput');
  var nameSaveBtn = document.getElementById('gravityNameSave');
  var nameSkipBtn = document.getElementById('gravityNameSkip');
  var adBreak = document.getElementById('gravityAdBreak');
  var adBreakContinueBtn = document.getElementById('gravityAdBreakContinue');
  var lbList = document.getElementById('gravityLeaderboardList');
  var lbYou = document.getElementById('gravityYouRank');

  var BEST_KEY = 'vexlow_gravity_best';
  var PLAYS_KEY = 'vexlow_gravity_plays';
  var AD_BREAK_INTERVAL = 3;
  var MUTE_KEY = 'vexlow_gravity_muted';
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
    fetch('/api/gravity?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        if (data && best > 0 && (!data.you || best > data.you.score)) submitScore(best);
      })
      .catch(function () {});
  }
  function doSubmit(name, finalScore) {
    fetch('/api/gravity', {
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
  function playFlip() { beep(420, 760, 0.09, 'square', 0.1); }
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

  /* ---- Física y dificultad ---- */
  var GRAVITY = 0.0028;
  var FLIP_KICK = 0.34;
  var MAX_VY = 1.0;
  var BASE_SPEED = 0.32, MAX_SPEED = 0.72;
  var SPEED_STEP_MS = 16000, SPEED_STEP = 0.025;
  var MIN_WARNING_MS = 620; // tiempo mínimo visible antes de que un obstáculo te alcance

  var state, player, obstacles, particles, speed, score, elapsedMs, lastTime;
  var distanceSinceSpawn, nextSpawnGap;

  function resetGame() {
    player = { y: FLOOR_Y - PLAYER_SIZE, vy: 0, gravityDir: 1, worldX: 0 };
    obstacles = [];
    particles = [];
    speed = BASE_SPEED;
    score = 0;
    elapsedMs = 0;
    lastTime = null;
    distanceSinceSpawn = 0;
    nextSpawnGap = 320;
    state = 'ready';
    scoreEl.textContent = 'Score: 0';
    overlayText.textContent = 'Tap or press Space to start';
    overlay.classList.remove('hidden');
  }

  function toScreenX(worldX) { return worldX - player.worldX + PLAYER_SCREEN_X; }

  function flip() {
    if (state === 'ready') { startGame(); return; }
    if (state === 'gameover') { resetGame(); return; }
    if (state !== 'playing') return;
    player.gravityDir *= -1;
    player.vy = FLIP_KICK * player.gravityDir;
    playFlip();
    spawnParticles(PLAYER_SCREEN_X + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#FFFFFF', 10);
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
    spawnParticles(PLAYER_SCREEN_X + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#FF3D57', 20);

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

  /* ---- Obstáculos ----
     Cada uno declara en qué superficie vive ('floor' | 'ceil' | 'mid')
     y su tipo ('spike' | 'gap' | 'saw' | 'laser'). Los huecos (gap)
     quitan lo sólido de esa franja: si la gravedad te empuja hacia
     esa superficie mientras estás en ese rango, seguís cayendo/
     subiendo de largo en vez de "pararte" ahí, y morís si te alejás
     demasiado — nunca hay que esperar (el personaje no se detiene),
     así que el hueco siempre es franqueable con el flip a tiempo. */
  function minTravelWidth() { return speed * MIN_WARNING_MS; }

  function spawnObstacle() {
    var elapsedS = elapsedMs / 1000;
    var pool = ['spike-floor', 'spike-ceil'];
    if (elapsedS > 5) pool.push('gap-floor', 'gap-ceil');
    if (elapsedS > 12) pool.push('saw');
    if (elapsedS > 20) pool.push('laser');
    if (elapsedS > 26) pool.push('pinch');
    var type = pool[Math.floor(Math.random() * pool.length)];
    var x = nextSegmentX();

    if (type === 'spike-floor') {
      obstacles.push({ type: 'spike', surface: 'floor', x: x, w: 26 });
    } else if (type === 'spike-ceil') {
      obstacles.push({ type: 'spike', surface: 'ceil', x: x, w: 26 });
    } else if (type === 'gap-floor') {
      obstacles.push({ type: 'gap', surface: 'floor', x: x, w: 150 + Math.random() * 60 });
    } else if (type === 'gap-ceil') {
      obstacles.push({ type: 'gap', surface: 'ceil', x: x, w: 150 + Math.random() * 60 });
    } else if (type === 'saw') {
      var surf = Math.random() < 0.5 ? 'floor' : 'ceil';
      obstacles.push({ type: 'saw', surface: surf, x: x, r: 20, rot: 0 });
    } else if (type === 'laser') {
      obstacles.push({ type: 'laser', x: x, w: 14, active: true, blinkMs: 1100 });
    } else if (type === 'pinch') {
      // Pincho en el piso Y en el techo a la vez: hay que estar en el
      // aire (a mitad de flip) justo al cruzarlo, ni parado ni pegado
      // a ninguna de las dos superficies.
      obstacles.push({ type: 'pinch', x: x, w: 30 });
    }
  }
  function nextSegmentX() { return player.worldX + W + 40; }

  /* Probabilidad de encadenar un segundo obstáculo muy cerca del
     anterior (zona de "poco margen para saltar"): crece con el tiempo
     hasta un tope, y nunca reduce el hueco por debajo de lo que ya
     garantiza minTravelWidth(). */
  function comboChance(elapsedS) {
    return Math.min(0.38, Math.max(0, (elapsedS - 14) / 55));
  }

  function isSurfaceSolid(surface, worldX) {
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.type === 'gap' && o.surface === surface && worldX > o.x && worldX < o.x + o.w) return false;
    }
    return true;
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

    speed = Math.min(MAX_SPEED, BASE_SPEED + Math.floor(elapsedMs / SPEED_STEP_MS) * SPEED_STEP);

    player.vy += GRAVITY * player.gravityDir * dt;
    if (player.vy > MAX_VY) player.vy = MAX_VY;
    if (player.vy < -MAX_VY) player.vy = -MAX_VY;
    player.y += player.vy * dt;

    var centerWorldX = player.worldX + PLAYER_SIZE / 2;
    var floorSolid = isSurfaceSolid('floor', centerWorldX);
    var ceilSolid = isSurfaceSolid('ceil', centerWorldX);

    if (floorSolid && player.y >= FLOOR_Y - PLAYER_SIZE) {
      player.y = FLOOR_Y - PLAYER_SIZE;
      if (player.gravityDir === 1) player.vy = 0;
    }
    if (ceilSolid && player.y <= CEIL_Y) {
      player.y = CEIL_Y;
      if (player.gravityDir === -1) player.vy = 0;
    }
    if (player.y > FLOOR_Y + 90 || player.y < CEIL_Y - 90) { endGame(); return; }

    player.worldX += speed * dt;

    distanceSinceSpawn += speed * dt;
    if (distanceSinceSpawn >= nextSpawnGap) {
      spawnObstacle();
      distanceSinceSpawn = 0;
      var minGap = minTravelWidth();
      if (Math.random() < comboChance(elapsedMs / 1000)) {
        // Encadenar de cerca: obliga a dos flips seguidos sin respiro.
        nextSpawnGap = minGap + Math.random() * 40;
      } else {
        nextSpawnGap = Math.max(minGap, 280 - elapsedMs / 1000 * 3 + Math.random() * 140);
      }
    }

    var px = PLAYER_SCREEN_X;
    for (var i = obstacles.length - 1; i >= 0; i--) {
      var o = obstacles[i];
      var sx = toScreenX(o.x);
      if (sx < -260) { obstacles.splice(i, 1); continue; }

      if (o.type === 'spike') {
        var spikeSurfaceY = o.surface === 'floor' ? FLOOR_Y : CEIL_Y;
        var playerNearThatSurface = o.surface === 'floor' ? player.y + PLAYER_SIZE > spikeSurfaceY - 20 : player.y < spikeSurfaceY + 20;
        var overlapsX = px + PLAYER_SIZE - 6 > sx && px + 6 < sx + o.w;
        if (overlapsX && playerNearThatSurface) { endGame(); return; }
      } else if (o.type === 'saw') {
        o.rot += dt * 0.01;
        var sawY = o.surface === 'floor' ? FLOOR_Y - o.r : CEIL_Y + o.r;
        var dx = (px + PLAYER_SIZE / 2) - (sx + o.r);
        var dy = (player.y + PLAYER_SIZE / 2) - sawY;
        if (Math.sqrt(dx * dx + dy * dy) < o.r + PLAYER_SIZE * 0.32) { endGame(); return; }
      } else if (o.type === 'laser') {
        o.active = Math.floor((elapsedMs + o.x) / o.blinkMs) % 2 === 0;
        if (o.active) {
          var overlapsLaser = px + PLAYER_SIZE - 4 > sx && px + 4 < sx + o.w;
          if (overlapsLaser) { endGame(); return; }
        }
      } else if (o.type === 'pinch') {
        var overlapsPinch = px + PLAYER_SIZE - 6 > sx && px + 6 < sx + o.w;
        if (overlapsPinch) {
          var nearFloor = player.y + PLAYER_SIZE > FLOOR_Y - 20;
          var nearCeil = player.y < CEIL_Y + 20;
          if (nearFloor || nearCeil) { endGame(); return; }
        }
      }
    }

    updateParticles(dt);
    score += speed * dt * 0.05;
    scoreEl.textContent = 'Score: ' + Math.round(score);
  }

  /* ---- Draw ---- */
  function draw() {
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#1b2029';
    ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
    ctx.fillRect(0, 0, W, CEIL_Y);
    ctx.fillStyle = '#3a4152';
    ctx.fillRect(0, FLOOR_Y, W, 2);
    ctx.fillRect(0, CEIL_Y - 2, W, 2);

    obstacles.forEach(function (o) {
      var sx = toScreenX(o.x);
      if (sx < -80 || sx > W + 80) return;

      if (o.type === 'gap') {
        var y = o.surface === 'floor' ? FLOOR_Y : 0;
        var h = o.surface === 'floor' ? H - FLOOR_Y : CEIL_Y;
        ctx.fillStyle = '#05060a';
        ctx.fillRect(sx, y, o.w, h);
      } else if (o.type === 'spike') {
        var baseY = o.surface === 'floor' ? FLOOR_Y : CEIL_Y;
        var dir = o.surface === 'floor' ? -1 : 1;
        ctx.save();
        ctx.shadowColor = '#FF3D57';
        ctx.shadowBlur = 10;
        ctx.fillStyle = '#FF3D57';
        ctx.beginPath();
        ctx.moveTo(sx, baseY);
        ctx.lineTo(sx + o.w / 2, baseY + 22 * dir);
        ctx.lineTo(sx + o.w, baseY);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (o.type === 'saw') {
        var sawCY = o.surface === 'floor' ? FLOOR_Y - o.r : CEIL_Y + o.r;
        ctx.save();
        ctx.translate(sx + o.r, sawCY);
        ctx.rotate(o.rot);
        ctx.shadowColor = '#B983FF';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#B983FF';
        var teeth = 8;
        ctx.beginPath();
        for (var t = 0; t < teeth; t++) {
          var a1 = (t / teeth) * Math.PI * 2;
          var a2 = a1 + Math.PI / teeth;
          ctx.lineTo(Math.cos(a1) * o.r, Math.sin(a1) * o.r);
          ctx.lineTo(Math.cos(a2) * (o.r + 8), Math.sin(a2) * (o.r + 8));
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (o.type === 'laser') {
        if (!o.active) return;
        ctx.save();
        ctx.shadowColor = '#FF3D57';
        ctx.shadowBlur = 14;
        ctx.fillStyle = 'rgba(255,61,87,.8)';
        ctx.fillRect(sx, CEIL_Y, o.w, FLOOR_Y - CEIL_Y);
        ctx.restore();
      } else if (o.type === 'pinch') {
        ctx.save();
        ctx.shadowColor = '#FFC93D';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#FFC93D';
        ctx.beginPath();
        ctx.moveTo(sx, FLOOR_Y);
        ctx.lineTo(sx + o.w / 2, FLOOR_Y - 34);
        ctx.lineTo(sx + o.w, FLOOR_Y);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(sx, CEIL_Y);
        ctx.lineTo(sx + o.w / 2, CEIL_Y + 34);
        ctx.lineTo(sx + o.w, CEIL_Y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    });

    var pulse = player.gravityDir === 1 ? '#3D8BFF' : '#FF3DAE';
    ctx.save();
    ctx.shadowColor = pulse;
    ctx.shadowBlur = 16;
    ctx.fillStyle = pulse;
    ctx.fillRect(PLAYER_SCREEN_X, player.y, PLAYER_SIZE, PLAYER_SIZE);
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
