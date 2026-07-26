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
  ctx.imageSmoothingEnabled = false;
  var W = canvas.width, H = canvas.height;
  var GROUND_Y = H - 50;

  /* ---- Sprites: personaje y picos (CraftPix.net, freebie license — uso
     comercial permitido, sin atribución obligatoria) ---- */
  var scriptEl = document.currentScript || document.querySelector('script[src$="js/dash.js"]');
  var imgPrefix = ((scriptEl && scriptEl.getAttribute('src')) || 'js/dash.js').replace(/js\/dash\.js(\?.*)?$/, '') + 'img/dash/';
  function loadSheet(name, frameW, frameH, frames) {
    var img = new Image();
    img.src = imgPrefix + name;
    return { img: img, frameW: frameW, frameH: frameH, frames: frames };
  }
  var SPRITES = {
    idle: loadSheet('player-idle.png', 32, 32, 11),
    run: loadSheet('player-run.png', 32, 32, 12),
    jump: loadSheet('player-jump.png', 32, 32, 1),
    fall: loadSheet('player-fall.png', 32, 32, 1),
    hit: loadSheet('player-hit.png', 32, 32, 7)
  };
  var spikeImg = new Image();
  spikeImg.src = imgPrefix + 'spike.png';
  var SPIKE_NATIVE_W = 15, SPIKE_NATIVE_H = 11;
  var enemyImg = new Image();
  enemyImg.src = imgPrefix + 'enemy.png';
  var ENEMY_NATIVE_W = 22, ENEMY_NATIVE_H = 27;

  /* ---- Zonas de fondo: cada ZONE_LENGTH puntos cambia el paisaje
     (bosque de día, bosque al atardecer, ciudad, playa...) para que
     se sienta que el personaje avanza de verdad. Las zonas con arte
     real (CraftPix.net, freebie license) tiledan capas en paralaje;
     las que todavía no tienen arte usan figuras dibujadas a mano
     mientras tanto. El piso (ver draw()) es un color sólido fijo que
     NO depende de la zona, así nunca cambia ni se mezcla con el fondo. */
  var NATIVE_W = 576, NATIVE_H = 324;
  function makeLayer(src, factor) {
    var img = new Image();
    img.src = imgPrefix + src;
    return { img: img, factor: factor, offset: 0 };
  }
  var ZONE_LENGTH = 400;
  var ZONES = [
    { name: 'forest', mode: 'layers', layers: [
      makeLayer('forest/bg-sky.png', 0.05),
      makeLayer('forest/bg-far.png', 0.22),
      makeLayer('forest/bg-mid.png', 0.45)
    ] },
    { name: 'forest-dark', mode: 'layers', layers: [
      makeLayer('forest-dark/bg-sky.png', 0.05),
      makeLayer('forest-dark/bg-far.png', 0.3)
    ] },
    { name: 'city', mode: 'shapes', sky: ['#141b2e', '#3a4966'], shape: 'building', shapeColor: 'rgba(15,20,32,.6)' },
    { name: 'beach', mode: 'shapes', sky: ['#2a7fb0', '#8fd6e8'], shape: 'palm', shapeColor: 'rgba(20,70,45,.55)' }
  ];
  var zoneIndex = 0;
  var scenery = [];

  function makeSceneryPiece(zone, x) {
    if (zone.shape === 'building') return { x: x, w: 32 + Math.random() * 26, h: 55 + Math.random() * 110 };
    if (zone.shape === 'palm') return { x: x, w: 16 + Math.random() * 8, h: 55 + Math.random() * 35 };
    return { x: x, w: 26 + Math.random() * 30, h: 20 + Math.random() * 30 };
  }
  function reseedScenery(zone) {
    scenery = [];
    var x = 0;
    while (x < W + 220) {
      scenery.push(makeSceneryPiece(zone, x));
      x += 90 + Math.random() * 90;
    }
  }
  function drawSceneryPiece(zone, s) {
    ctx.fillStyle = zone.shapeColor;
    var baseY = GROUND_Y;
    if (zone.shape === 'palm') {
      ctx.fillRect(s.x + s.w / 2 - 3, baseY - s.h, 6, s.h);
      ctx.beginPath();
      ctx.ellipse(s.x + s.w / 2, baseY - s.h, s.w, s.w * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(s.x, baseY - s.h, s.w, s.h);
    }
  }

  function enterZone(idx) {
    zoneIndex = idx;
    if (ZONES[idx].mode !== 'layers') reseedScenery(ZONES[idx]);
  }

  function drawZoneBackground(zone) {
    if (zone.mode === 'layers') {
      var scale = H / NATIVE_H;
      var tileW = NATIVE_W * scale;
      for (var li = 0; li < zone.layers.length; li++) {
        var layer = zone.layers[li];
        if (!layer.img.complete || !layer.img.naturalWidth) continue;
        var off = layer.offset % tileW;
        for (var x = -off - tileW; x < W + tileW; x += tileW) {
          ctx.drawImage(layer.img, 0, 0, NATIVE_W, NATIVE_H, x, 0, tileW, H);
        }
      }
    } else {
      var grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, zone.sky[0]);
      grad.addColorStop(1, zone.sky[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      for (var s = 0; s < scenery.length; s++) drawSceneryPiece(zone, scenery[s]);
    }
  }

  var scoreEl = document.getElementById('dashScore');
  var bestEl = document.getElementById('dashBest');
  var muteBtn = document.getElementById('dashMute');
  var overlay = document.getElementById('dashOverlay');
  var overlayText = document.getElementById('dashOverlayText');
  var lbList = document.getElementById('dashLeaderboardList');
  var lbYou = document.getElementById('dashYouRank');
  var nameModal = document.getElementById('dashNameModal');
  var nameInput = document.getElementById('dashNameInput');
  var nameSaveBtn = document.getElementById('dashNameSave');
  var nameSkipBtn = document.getElementById('dashNameSkip');
  var adBreak = document.getElementById('dashAdBreak');
  var adBreakContinueBtn = document.getElementById('dashAdBreakContinue');

  var BEST_KEY = 'vexlow_dash_best';
  var PLAYS_KEY = 'vexlow_dash_plays';
  var AD_BREAK_INTERVAL = 3;
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

  /* ---- Ventana propia para pedir el nombre (reemplaza window.prompt) ---- */
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
    fetch('/api/dash?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        /* Si el mejor puntaje local (localStorage) es de antes de que
           existiera esta tabla de posiciones — o quedó afuera por algún
           fallo de red puntual — nunca llegó a guardarse en el servidor.
           Lo sincronizamos acá para que no quede "perdido". */
        if (data && best > 0 && (!data.you || best > data.you.score)) {
          submitScore(best);
        }
      })
      .catch(function () {});
  }

  function doSubmit(name, finalScore) {
    fetch('/api/dash', {
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
  var animFrame = 0, animTimer = 0, hitFrame = 0;

  function resetGame() {
    player = { x: 90, y: GROUND_Y - PLAYER_SIZE, vy: 0, onGround: true };
    obstacles = [];
    speed = BASE_SPEED;
    score = 0;
    scoreMilestone = 0;
    distanceSinceSpawn = 0;
    nextSpawnGap = 260 + Math.random() * 140;
    state = 'ready';
    lastTime = null;
    animFrame = 0;
    animTimer = 0;
    hitFrame = 0;
    enterZone(0);
    scoreEl.textContent = 'Score: 0';
    overlayText.textContent = 'Tap or press Space to start';
    overlay.classList.remove('hidden');
  }

  function jump() {
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

    /* Cada AD_BREAK_INTERVAL partidas, en vez del cartel normal de
       "tap to retry" mostramos una pausa con espacio para anuncio.
       Por ahora es el mismo placeholder .ad-slot que el resto del
       sitio (todavía no está aprobado AdSense) — cuando lo aprueben,
       ese div se reemplaza por el <ins class="adsbygoogle"> real. */
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

  /* Cuanto más puntaje, más chance de que salga un grupo de 2-3 picos
     seguidos en vez de uno solo — obliga a saltar antes y calcular mejor,
     sin depender solo de subir la velocidad hasta hacerlo injugable. */
  function spawnObstacle() {
    /* El robot es un obstáculo solo (nunca en grupo) para que siga
       siendo justo — los grupos de picos ya suben la dificultad. */
    if (score > 200 && Math.random() < 0.22) {
      var eScale = 1.05 + Math.random() * 0.35;
      obstacles.push({ x: W + 20, w: ENEMY_NATIVE_W * eScale, h: ENEMY_NATIVE_H * eScale, type: 'enemy' });
      return;
    }

    var clusterChance = score > 1200 ? 0.55 : score > 500 ? 0.32 : score > 150 ? 0.12 : 0;
    var clusterSize = 1;
    var r = Math.random();
    if (r < clusterChance * 0.35) clusterSize = 3;
    else if (r < clusterChance) clusterSize = 2;
    var scale = 2.6 + Math.random() * 0.8;
    var w = SPIKE_NATIVE_W * scale, h = SPIKE_NATIVE_H * scale;
    for (var i = 0; i < clusterSize; i++) {
      obstacles.push({ x: W + 20 + i * (w + 6), w: w, h: h, type: 'spike' });
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

    var newZoneIndex = Math.floor(score / ZONE_LENGTH) % ZONES.length;
    if (newZoneIndex !== zoneIndex) enterZone(newZoneIndex);
    var currentZone = ZONES[zoneIndex];
    if (currentZone.mode === 'layers') {
      for (var li = 0; li < currentZone.layers.length; li++) {
        currentZone.layers[li].offset += currentZone.layers[li].factor * speed * dt;
      }
    } else {
      var parallax = speed * 0.45;
      for (var s = scenery.length - 1; s >= 0; s--) {
        scenery[s].x -= parallax * dt;
        if (scenery[s].x < -140) scenery.splice(s, 1);
      }
      var rightmost = scenery.length ? scenery[scenery.length - 1].x : -999;
      if (rightmost < W + 60) {
        scenery.push(makeSceneryPiece(currentZone, rightmost + 90 + Math.random() * 90));
      }
    }

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

  var ANIM_FRAME_MS = 70;

  function currentSheet() {
    if (state === 'gameover') return SPRITES.hit;
    if (state === 'ready') return SPRITES.idle;
    if (!player.onGround) return player.vy < 0 ? SPRITES.jump : SPRITES.fall;
    return SPRITES.run;
  }

  function advanceAnim(dt) {
    var sheet = currentSheet();
    if (sheet.frames <= 1) { animFrame = 0; return; }
    animTimer += dt;
    if (animTimer >= ANIM_FRAME_MS) {
      animTimer = 0;
      if (state === 'gameover') {
        if (hitFrame < sheet.frames - 1) hitFrame++;
        animFrame = hitFrame;
      } else {
        animFrame = (animFrame + 1) % sheet.frames;
      }
    } else if (state === 'gameover') {
      animFrame = hitFrame;
    }
  }

  function drawSprite(sheet) {
    if (!sheet.img.complete || !sheet.img.naturalWidth) return;
    var frame = Math.min(animFrame, sheet.frames - 1);
    ctx.drawImage(
      sheet.img, frame * sheet.frameW, 0, sheet.frameW, sheet.frameH,
      player.x, player.y, PLAYER_SIZE, PLAYER_SIZE
    );
  }

  function draw() {
    drawZoneBackground(ZONES[zoneIndex]);

    /* El piso es un color sólido y fijo — no depende de la zona ni
       del fondo, así que nunca cambia ni se mezcla con el paisaje,
       sea cual sea la zona que esté de fondo en cada momento. */
    ctx.fillStyle = '#1b2029';
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = '#3a4152';
    ctx.fillRect(0, GROUND_Y, W, 2);

    for (var j = 0; j < obstacles.length; j++) {
      var o = obstacles[j];
      if (o.type === 'enemy') {
        if (enemyImg.complete && enemyImg.naturalWidth) {
          ctx.drawImage(enemyImg, 0, 0, ENEMY_NATIVE_W, ENEMY_NATIVE_H, o.x, GROUND_Y - o.h, o.w, o.h);
        }
      } else if (spikeImg.complete && spikeImg.naturalWidth) {
        ctx.drawImage(spikeImg, 0, 0, SPIKE_NATIVE_W, SPIKE_NATIVE_H, o.x, GROUND_Y - o.h, o.w, o.h);
      }
    }

    drawSprite(currentSheet());
  }

  function loop(time) {
    if (lastTime === null) lastTime = time;
    var dt = Math.min(time - lastTime, 40);
    lastTime = time;
    update(dt);
    advanceAnim(dt);
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
