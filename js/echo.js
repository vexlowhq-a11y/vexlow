/*
  Echo Clone (play/echo.html) — corredor automático donde cada ciclo de
  5 segundos graba tus saltos y los convierte en un "eco" (clon) que
  repite esa secuencia en loop para siempre, corriendo a la velocidad
  que tenía el juego en ese momento. Los ecos no mueren, atraviesan
  pinchos/enemigos por el costado, y sirven para sostener botones,
  juntar monedas especiales y resolver tramos que un solo jugador no
  puede completar solo.

  Todo dibujado en canvas (glow con shadowBlur) usando los sprites que
  el usuario generó con ChatGPT (img/echo/ — arte propio, sin problema
  de licencia). Sonido sintetizado con Web Audio API. Mismo patrón de
  tabla de posiciones (api/echo.js) y pausa publicitaria cada 3
  partidas que Vex Dash y Neon Snake.

  El archivo está organizado en secciones que reflejan las
  responsabilidades del diseño original (InputRecorder, EchoManager,
  SegmentManager, etc.) aunque todo vive en un solo módulo, siguiendo
  la convención del resto del sitio (sin bundler ni build step).
*/
(function () {
  var canvas = document.getElementById('echoCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  var W = canvas.width, H = canvas.height;
  var GROUND_Y = H - 50;
  var PLAYER_SCREEN_X = 170;
  var SIZE = 34;

  /* ---- Sprites (CraftPix-style propio, generado por el usuario) ---- */
  var scriptEl = document.currentScript || document.querySelector('script[src*="js/echo.js"]');
  var imgPrefix = ((scriptEl && scriptEl.getAttribute('src')) || 'js/echo.js').replace(/js\/echo\.js(\?.*)?$/, '') + 'img/echo/';
  function loadImg(name) {
    var img = new Image();
    img.src = imgPrefix + name;
    return img;
  }
  var SPRITES = {
    player: loadImg('player.png'),
    'clone-blue': loadImg('clone-blue.png'),
    'clone-green': loadImg('clone-green.png'),
    'clone-red': loadImg('clone-red.png'),
    'clone-orange': loadImg('clone-orange.png'),
    'clone-yellow': loadImg('clone-yellow.png'),
    'clone-cyan': loadImg('clone-cyan.png'),
    'clone-purple': loadImg('clone-purple.png'),
    button: loadImg('button.png'),
    platform: loadImg('platform.png'),
    coin: loadImg('coin.png'),
    spikes: loadImg('spikes.png'),
    block: loadImg('block.png'),
    enemy: loadImg('enemy.png'),
    explosion: loadImg('explosion.png'),
    particle: loadImg('particle.png')
  };
  function drawSprite(img, x, y, w, h) {
    if (!img.complete || !img.naturalWidth) return false;
    ctx.drawImage(img, x, y, w, h);
    return true;
  }

  /* ---- Skins: reutilizan los sprites de clones como variantes de
     color del jugador — cero assets nuevos. Se desbloquean con
     monedas totales (localStorage), sin pagos reales. ---- */
  var SKINS = [
    { id: 'white', name: 'Classic White', sprite: 'player', cost: 0, swatch: '#F4F6FA' },
    { id: 'blue', name: 'Neon Blue', sprite: 'clone-blue', cost: 50, swatch: '#3D8BFF' },
    { id: 'green', name: 'Toxic Green', sprite: 'clone-green', cost: 100, swatch: '#39FF6A' },
    { id: 'red', name: 'Plasma Red', sprite: 'clone-red', cost: 150, swatch: '#FF3D57' },
    { id: 'gold', name: 'Gold', sprite: 'clone-yellow', cost: 250, swatch: '#FFC933' },
    { id: 'purple', name: 'Purple Void', sprite: 'clone-purple', cost: 400, swatch: '#B25CFF' }
  ];
  var CLONE_COLORS = ['clone-blue', 'clone-green', 'clone-red', 'clone-orange', 'clone-yellow', 'clone-cyan', 'clone-purple'];

  /* ---- DOM ---- */
  var scoreEl = document.getElementById('echoScore');
  var bestEl = document.getElementById('echoBest');
  var coinsEl = document.getElementById('echoCoins');
  var clonesEl = document.getElementById('echoClones');
  var multiEl = document.getElementById('echoMulti');
  var muteBtn = document.getElementById('echoMute');
  var cycleFill = document.getElementById('echoCycleFill');
  var overlay = document.getElementById('echoOverlay');
  var panelMenu = document.getElementById('echoPanelMenu');
  var panelTutorial = document.getElementById('echoPanelTutorial');
  var panelSkins = document.getElementById('echoPanelSkins');
  var panelGameOver = document.getElementById('echoPanelGameOver');
  var menuBestEl = document.getElementById('echoMenuBest');
  var menuCoinsEl = document.getElementById('echoMenuCoins');
  var playBtn = document.getElementById('echoPlayBtn');
  var tutorialBtn = document.getElementById('echoTutorialBtn');
  var skinsBtn = document.getElementById('echoSkinsBtn');
  var tutStepTitle = document.getElementById('echoTutStepTitle');
  var tutStepText = document.getElementById('echoTutStepText');
  var tutNextBtn = document.getElementById('echoTutNextBtn');
  var skinsList = document.getElementById('echoSkinsList');
  var skinsBackBtn = document.getElementById('echoSkinsBackBtn');
  var goTitle = document.getElementById('echoGoTitle');
  var goStats = document.getElementById('echoGoStats');
  var restartBtn = document.getElementById('echoRestartBtn');
  var menuBtn = document.getElementById('echoMenuBtn');
  var nameModal = document.getElementById('echoNameModal');
  var nameInput = document.getElementById('echoNameInput');
  var nameSaveBtn = document.getElementById('echoNameSave');
  var nameSkipBtn = document.getElementById('echoNameSkip');
  var adBreak = document.getElementById('echoAdBreak');
  var adBreakContinueBtn = document.getElementById('echoAdBreakContinue');
  var lbList = document.getElementById('echoLeaderboardList');
  var lbYou = document.getElementById('echoYouRank');

  /* ---- localStorage ---- */
  var BEST_KEY = 'vexlow_echo_best';
  var COINS_KEY = 'vexlow_echo_coins';
  var SKIN_KEY = 'vexlow_echo_skin';
  var UNLOCKED_KEY = 'vexlow_echo_unlocked';
  var BEST_CLONES_KEY = 'vexlow_echo_best_clones';
  var BEST_COMBO_KEY = 'vexlow_echo_best_combo';
  var TUTORIAL_DONE_KEY = 'vexlow_echo_tutorial_done';
  var PLAYS_KEY = 'vexlow_echo_plays';
  var AD_BREAK_INTERVAL = 3;
  var MUTE_KEY = 'vexlow_echo_muted';
  var NAME_KEY = 'vexlow_dash_name';
  var VID_KEY = 'vexlow_vid';

  var best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;
  var totalCoins = parseInt(localStorage.getItem(COINS_KEY) || '0', 10) || 0;
  var selectedSkin = localStorage.getItem(SKIN_KEY) || 'white';
  var unlockedSkins = {};
  try { unlockedSkins = JSON.parse(localStorage.getItem(UNLOCKED_KEY) || '{"white":true}'); } catch (e) { unlockedSkins = { white: true }; }
  var muted = localStorage.getItem(MUTE_KEY) === '1';
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

  /* ---- Ventana de nombre (misma clave que Vex Dash / Neon Snake) ---- */
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
    fetch('/api/echo?visitorId=' + encodeURIComponent(visitorId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        renderLeaderboard(data);
        if (data && best > 0 && (!data.you || best > data.you.score)) submitScore(best);
      })
      .catch(function () {});
  }
  function doSubmit(name, finalScore) {
    fetch('/api/echo', {
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
  function playJump() { beep(420, 700, 0.1, 'square', 0.1); }
  function playLand() { beep(200, 120, 0.06, 'sine', 0.06); }
  function playCloneSpawn() { beep(500, 1000, 0.25, 'sawtooth', 0.09); }
  function playButton() { beep(300, 500, 0.1, 'square', 0.1); }
  function playDoor() { beep(180, 380, 0.3, 'sine', 0.1); }
  function playCoin() { beep(900, 1300, 0.08, 'sine', 0.1); }
  function playEchoCoin() { beep(700, 1500, 0.14, 'square', 0.12); }
  function playEnemyHit() {
    if (muted) return;
    var ac = getAudioCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    var bufferSize = ac.sampleRate * 0.2;
    var buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    var noise = ac.createBufferSource();
    noise.buffer = buffer;
    var gain = ac.createGain();
    gain.gain.setValueAtTime(0.2, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.2);
    noise.connect(gain);
    gain.connect(ac.destination);
    noise.start();
  }
  function playCombo() { beep(700, 1400, 0.2, 'triangle', 0.1); }
  function playGameOver() {
    if (muted) return;
    var ac = getAudioCtx();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    var bufferSize = ac.sampleRate * 0.35;
    var buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    var noise = ac.createBufferSource();
    noise.buffer = buffer;
    var gain = ac.createGain();
    gain.gain.setValueAtTime(0.25, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.35);
    noise.connect(gain);
    gain.connect(ac.destination);
    noise.start();
  }
  function playMenuClick() { beep(500, 650, 0.06, 'square', 0.08); }

  muteBtn.addEventListener('click', function () {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  /* =========================================================
     FÍSICA Y CONSTANTES
     ========================================================= */
  var GRAVITY = 0.0024;
  var JUMP_VELOCITY = -0.92;
  var BOUNCE_VELOCITY = -0.55;
  var BASE_SPEED = 0.34;
  var MAX_SPEED = 0.62;
  var SPEED_STEP_MS = 20000;
  var SPEED_STEP = 0.02;
  var CYCLE_MS = 5000;
  var MAX_CLONES = 8;
  var COMBO_WINDOW_MS = 4000;

  /* =========================================================
     SEGMENTOS: cada uno describe objetos con un offset relativo
     al inicio del segmento. El LevelManager los va soldando uno
     atrás del otro en el eje worldX, validando que la dificultad
     y la cantidad de ecos disponibles alcancen para resolverlos.
     ========================================================= */
  var SEGMENT_DEFS = [
    { id: 'easy', tier: 1, minClones: 0, width: 700, build: function (b) {
      b.rest();
    } },
    { id: 'jump-gap', tier: 1, minClones: 0, width: 650, build: function (b) {
      b.gap(90 + Math.random() * 40);
    } },
    { id: 'double-jump-gap', tier: 2, minClones: 0, width: 800, build: function (b) {
      b.gap(80); b.rest(120); b.gap(90);
    } },
    { id: 'spikes-basic', tier: 2, minClones: 0, width: 700, build: function (b) {
      b.spikes(1); b.rest(150); b.spikes(2);
    } },
    { id: 'coin-row', tier: 2, minClones: 0, width: 700, build: function (b) {
      b.coinRow(5, false);
    } },
    { id: 'echo-coin-row', tier: 2, minClones: 1, width: 750, build: function (b) {
      b.coinRow(4, true);
    } },
    { id: 'switch-door', tier: 3, minClones: 0, width: 900, build: function (b) {
      b.switchDoor(false);
    } },
    { id: 'switch-door-echo', tier: 3, minClones: 1, width: 950, build: function (b) {
      b.switchDoorEcho();
    } },
    { id: 'enemy-basic', tier: 4, minClones: 0, width: 700, build: function (b) {
      b.enemy();
    } },
    { id: 'enemy-gap', tier: 4, minClones: 0, width: 800, build: function (b) {
      b.gap(80); b.rest(80); b.enemy();
    } },
    { id: 'moving-platform', tier: 5, minClones: 0, width: 850, build: function (b) {
      b.movingPlatformGap();
    } },
    { id: 'laser-timed', tier: 6, minClones: 0, width: 750, build: function (b) {
      b.laser(false);
    } },
    { id: 'laser-switch', tier: 6, minClones: 1, width: 950, build: function (b) {
      b.laser(true);
    } },
    { id: 'two-clone-gate', tier: 7, minClones: 2, width: 1050, build: function (b) {
      b.twoSwitchDoor();
    } },
    { id: 'rest', tier: 1, minClones: 0, width: 500, build: function (b) {
      b.rest();
    } }
  ];

  /* =========================================================
     ESTADO DEL MUNDO / NIVEL
     ========================================================= */
  var state; // 'menu' | 'playing' | 'gameover' | 'adbreak'
  var uiPanel; // 'menu' | 'tutorial' | 'skins' | 'gameover'
  var player, speed, cycleStartTime, cycleStartWorldX, recording, lastTime, elapsedMs, distance;
  var clones, particles, floaters;
  var buttons, doors, coins, echoCoins, spikesArr, enemies, lasers, platformsArr, gaps, blocks;
  var nextSegmentX, lastSegmentIds, difficultyTier;
  var score, coinsThisRun, comboMultiplier, lastSpecialActionTime, bestComboName;
  var enemiesKilled, switchesActivated, clonesCreatedThisRun, perfectCycle;
  var cameraShake, zoomPulse;
  var tutorialStep;

  var TUTORIAL_STEPS = [
    'Tap, click, or press Space to jump. You run automatically.',
    'Every 5 seconds your run is recorded — watch the bar under the HUD.',
    'When the cycle ends, a glowing echo of you appears and repeats those exact jumps, forever.',
    'Echoes can hold down switches, collect echo-only coins, and stomp enemies — but they can never die.',
    'Use your own past echoes to open doors and cross gaps you can\'t solve alone. Good luck!'
  ];

  function nextClonePalette() {
    return CLONE_COLORS[clonesCreatedThisRun % CLONE_COLORS.length];
  }

  /* ---- Segment builder: helpers usados por SEGMENT_DEFS[i].build ---- */
  function makeBuilder(segStartX) {
    var cursor = segStartX;
    var buttonIdCounter = 0;
    return {
      end: function () { return cursor; },
      rest: function (len) {
        cursor += (len || 200 + Math.random() * 120);
      },
      gap: function (width) {
        /* Nunca generar un hueco más ancho de lo que se puede saltar
           a la velocidad actual (con margen de seguridad incluido en
           maxJumpDistance) — así ningún segmento resulta imposible
           aunque la dificultad haya subido la velocidad. */
        var safeWidth = Math.min(width, maxJumpDistance());
        gaps.push({ x1: cursor, x2: cursor + safeWidth });
        cursor += safeWidth + 60;
      },
      spikes: function (count) {
        for (var i = 0; i < count; i++) {
          spikesArr.push({ x: cursor, w: 26 });
          cursor += 55;
        }
        cursor += 90;
      },
      coinRow: function (count, echo) {
        for (var i = 0; i < count; i++) {
          var arr = echo ? echoCoins : coins;
          arr.push({ x: cursor, taken: false, echo: !!echo });
          cursor += 55;
        }
        cursor += 100;
      },
      switchDoor: function () {
        var id = 'b' + (buttonIdCounter++) + '-' + segStartX;
        buttons.push({ id: id, x: cursor, pressed: false });
        cursor += 260;
        doors.push({ ids: [id], requireAll: false, minClones: 0, x: cursor, open: false, w: 26, h: 90 });
        cursor += 140;
      },
      switchDoorEcho: function () {
        /* Un eco corre siempre DETRÁS del jugador en el mundo (nace
           donde vos estabas hace un ciclo y nunca te alcanza), así que
           nunca puede "adelantarse" a pisar un botón antes de que
           llegues vos — por eso esta puerta usa la otra condición que
           ya contemplaba el diseño original: se abre al alcanzar
           cierta cantidad de ecos, además de por pisar el botón (por
           si un eco pasa justo por ahí, de yapa). Como el segmento ya
           exige minClones:1 para aparecer, siempre es resoluble. */
        var id = 'b' + (buttonIdCounter++) + '-' + segStartX;
        buttons.push({ id: id, x: cursor, pressed: false });
        cursor += 340;
        doors.push({ ids: [id], requireAll: false, minClones: 1, x: cursor, open: false, w: 26, h: 90 });
        cursor += 160;
      },
      twoSwitchDoor: function () {
        var id1 = 'b' + (buttonIdCounter++) + '-' + segStartX;
        var id2 = 'b' + (buttonIdCounter++) + '-' + segStartX;
        buttons.push({ id: id1, x: cursor, pressed: false });
        cursor += 220;
        buttons.push({ id: id2, x: cursor, pressed: false });
        cursor += 260;
        doors.push({ ids: [id1, id2], requireAll: true, minClones: 2, x: cursor, open: false, w: 26, h: 90 });
        cursor += 160;
      },
      enemy: function () {
        enemies.push({ x: cursor, alive: true, y: GROUND_Y - 30 });
        cursor += 220;
      },
      movingPlatformGap: function () {
        /* La plataforma cubre TODO el hueco (no es un cuadrado chico
           que haya que cazar en el aire) — simplemente aparece y
           desaparece con un ciclo propio, como un puente que sale y
           entra. Como el jugador corre solo y nunca puede pararse a
           esperar, calculamos la fase exacta para que el puente esté
           afuera (cruzable) justo en el instante en que se espera que
           el jugador llegue, a la velocidad actual. */
        var gapW = 190;
        var period = 2000;
        var coverFrac = 0.4; // 40% del ciclo el puente está afuera
        var gapX1 = cursor, gapX2 = cursor + gapW;
        var midWorldX = (gapX1 + gapX2) / 2;
        var etaMs = elapsedMs + (midWorldX - player.worldX) / speed;
        var targetT = 0.5; // centro de la ventana "afuera"
        var phaseMs = (((targetT * period - etaMs) % period) + period) % period;
        gaps.push({ x1: gapX1, x2: gapX2 });
        platformsArr.push({
          x1: gapX1, x2: gapX2, coverFrac: coverFrac,
          phase: phaseMs / 1000, period: period
        });
        cursor += gapW + 60;
      },
      laser: function (useSwitch) {
        if (useSwitch) {
          /* Igual que con las puertas de eco: un eco nunca puede
             adelantarse al jugador en el mundo, así que la condición
             confiable es "ya tenés al menos un eco" (el segmento ya
             lo exige para aparecer), no una coincidencia de posición.
             Si además algún eco pisa el botón de verdad, mejor. */
          var id = 'b' + (buttonIdCounter++) + '-' + segStartX;
          buttons.push({ id: id, x: cursor, pressed: false });
          cursor += 260;
          lasers.push({ x: cursor, linkedButton: id, minClonesToDisable: 1, active: true, blinkMs: 0, w: 16, h: 90 });
          cursor += 160;
        } else {
          lasers.push({ x: cursor, linkedButton: null, minClonesToDisable: 0, active: true, blinkMs: 1400, w: 16, h: 90 });
          cursor += 220;
        }
      }
    };
  }

  /* Reglas de seguridad: cuánta distancia puede saltar el jugador a
     la velocidad actual, para nunca generar un hueco imposible. */
  function maxJumpDistance() {
    var airTime = (2 * Math.abs(JUMP_VELOCITY)) / GRAVITY;
    return speed * airTime * 0.82; // margen de seguridad del 18%
  }

  function eligibleSegments() {
    return SEGMENT_DEFS.filter(function (def) {
      if (def.tier > difficultyTier) return false;
      if (def.minClones > clones.length) return false;
      return true;
    });
  }

  function pickSegmentDef() {
    var pool = eligibleSegments();
    var filtered = pool.filter(function (def) {
      return lastSegmentIds.indexOf(def.id) === -1;
    });
    if (!filtered.length) filtered = pool;
    return filtered[Math.floor(Math.random() * filtered.length)];
  }

  function appendSegment() {
    var def = pickSegmentDef();
    var b = makeBuilder(nextSegmentX);
    def.build(b);
    var end = Math.max(b.end(), nextSegmentX + def.width);
    nextSegmentX = end;
    lastSegmentIds.push(def.id);
    if (lastSegmentIds.length > 3) lastSegmentIds.shift();
  }

  function ensureLevelAhead() {
    while (nextSegmentX < player.worldX + W * 2.2) appendSegment();
  }

  function cleanupBehind() {
    var behindX = player.worldX - 400;
    function keep(arr, getX) { return arr.filter(function (o) { return getX(o) > behindX; }); }
    gaps = keep(gaps, function (o) { return o.x2; });
    spikesArr = keep(spikesArr, function (o) { return o.x; });
    coins = keep(coins, function (o) { return o.x; });
    echoCoins = keep(echoCoins, function (o) { return o.x; });
    buttons = keep(buttons, function (o) { return o.x; });
    doors = keep(doors, function (o) { return o.x; });
    enemies = keep(enemies, function (o) { return o.x; });
    lasers = keep(lasers, function (o) { return o.x; });
    platformsArr = keep(platformsArr, function (o) { return o.x2; });
  }

  /* Suelo sólido en worldX: true si es un hueco y ningún puente móvil
     lo está cubriendo por completo en este instante (te caés). El
     puente cubre TODO el hueco de una vez, no hay que cazarlo en el
     aire — solo hay que cruzar mientras esté afuera. */
  function platformCoversGap(p) {
    var t = (elapsedMs + p.phase * 1000) % p.period / p.period;
    return t > 0.5 - p.coverFrac / 2 && t < 0.5 + p.coverFrac / 2;
  }
  function isPitAt(worldX) {
    for (var i = 0; i < gaps.length; i++) {
      var g = gaps[i];
      if (worldX > g.x1 && worldX < g.x2) {
        for (var j = 0; j < platformsArr.length; j++) {
          var p = platformsArr[j];
          if (p.x1 !== g.x1) continue;
          if (platformCoversGap(p)) return false;
        }
        return true;
      }
    }
    return false;
  }

  function doorOpenNow(door) {
    if (door.minClones && clones.length >= door.minClones) return true;
    if (door.requireAll) return door.ids.every(function (id) { return isButtonPressed(id); });
    return door.ids.some(function (id) { return isButtonPressed(id); });
  }
  function isButtonPressed(id) {
    var b = buttons.filter(function (btn) { return btn.id === id; })[0];
    return b ? b.pressed : false;
  }

  /* =========================================================
     ECHOMANAGER: crea, actualiza y dibuja los clones (ecos)
     ========================================================= */
  function spawnClone(log, cloneSpeed, startWorldX) {
    var clone = {
      color: nextClonePalette(),
      log: log.slice(),
      speed: cloneSpeed,
      spawnWorldX: startWorldX,
      spawnTime: elapsedMs,
      y: GROUND_Y - SIZE,
      vy: 0,
      onGround: true,
      lastLocalTime: 0,
      born: elapsedMs,
      dying: false,
      trail: []
    };
    clones.push(clone);
    clonesCreatedThisRun++;
    playCloneSpawn();
    spawnParticles(toScreenX(startWorldX) , clone.y + SIZE / 2, clone.color, 14);
    pushFloater('Echo #' + clonesCreatedThisRun, toScreenX(startWorldX), clone.y - 10, '#B983FF');
    if (clonesCreatedThisRun === 2) pushCombo('Double Echo');
    if (clonesCreatedThisRun === 3) pushCombo('Triple Echo');
    if (clones.length > MAX_CLONES) {
      var oldest = clones[0];
      oldest.dying = true;
      oldest.dieAt = elapsedMs + 260;
    }
  }

  function updateClones(dt) {
    for (var i = clones.length - 1; i >= 0; i--) {
      var c = clones[i];
      if (c.dying && elapsedMs >= c.dieAt) { clones.splice(i, 1); continue; }

      var worldX = c.spawnWorldX + c.speed * (elapsedMs - c.spawnTime);
      var localTime = (elapsedMs - c.spawnTime) % CYCLE_MS;
      if (localTime < c.lastLocalTime) {
        // volvió a empezar el loop de su propia grabación
      }
      for (var j = 0; j < c.log.length; j++) {
        var t = c.log[j].t;
        var crossed = localTime >= t && (c.lastLocalTime < t || localTime < c.lastLocalTime);
        if (crossed && c.onGround) {
          c.vy = JUMP_VELOCITY;
          c.onGround = false;
        }
      }
      c.lastLocalTime = localTime;

      c.vy += GRAVITY * dt;
      c.y += c.vy * dt;
      if (c.y >= GROUND_Y - SIZE) { c.y = GROUND_Y - SIZE; c.vy = 0; c.onGround = true; }

      c.trail.push({ x: worldX, y: c.y });
      if (c.trail.length > 10) c.trail.shift();
      c.worldX = worldX;

      /* Interacciones: botones, monedas de eco, enemigos (solo si
         los pisa desde arriba) */
      buttons.forEach(function (btn) {
        if (worldX + SIZE > btn.x && worldX < btn.x + 30 && c.y + SIZE >= GROUND_Y - 14) btn.pressed = true;
      });
      echoCoins.forEach(function (ec) {
        if (!ec.taken && worldX + SIZE > ec.x && worldX < ec.x + 26 && c.y + SIZE > GROUND_Y - 40) {
          ec.taken = true;
          addScore(25, true);
          coinsThisRun++; totalCoins++;
          playEchoCoin();
          spawnParticles(toScreenX(ec.x), GROUND_Y - 20, '#00FFF2', 10);
        }
      });
      enemies.forEach(function (en) {
        if (!en.alive) return;
        var overlap = worldX + SIZE > en.x && worldX < en.x + 30;
        if (overlap && c.vy >= 0 && c.y + SIZE - 8 <= en.y + 14) {
          en.alive = false;
          enemiesKilled++;
          addScore(30, true);
          spawnParticles(toScreenX(en.x), en.y, '#FFA23D', 16);
          playEnemyHit();
        }
      });
    }
  }

  function drawClones() {
    clones.forEach(function (c) {
      var sx = toScreenX(c.worldX);
      if (sx < -60 || sx > W + 60) return;
      var alpha = c.dying ? Math.max(0, (c.dieAt - elapsedMs) / 260) : Math.min(1, (elapsedMs - c.born) / 260);
      ctx.save();
      ctx.globalAlpha = alpha * 0.85;
      for (var i = 0; i < c.trail.length; i++) {
        var tp = c.trail[i];
        var tsx = toScreenX(tp.x);
        ctx.globalAlpha = alpha * 0.12 * (i / c.trail.length);
        drawEntitySprite(c.color, tsx, tp.y, SIZE * 0.8);
      }
      ctx.globalAlpha = alpha * 0.85;
      drawEntitySprite(c.color, sx, c.y, SIZE);
      ctx.restore();
    });
  }

  function drawEntitySprite(spriteKey, x, y, size) {
    var img = SPRITES[spriteKey];
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, x, y, size, size);
    } else {
      ctx.fillStyle = '#3D8BFF';
      ctx.fillRect(x, y, size, size);
    }
  }

  /* =========================================================
     CÁMARA, PARTÍCULAS Y TEXTOS FLOTANTES (object pooling simple)
     ========================================================= */
  function toScreenX(worldX) { return worldX - player.worldX + PLAYER_SCREEN_X; }

  var MAX_PARTICLES = 120;
  function spawnParticles(x, y, color, count) {
    for (var i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      particles.push({
        x: x, y: y, color: color,
        vx: (Math.random() - 0.5) * 0.35, vy: -0.15 - Math.random() * 0.35,
        born: elapsedMs, life: 380 + Math.random() * 220
      });
    }
  }
  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      if (elapsedMs - p.born > p.life) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.0009 * dt;
    }
  }
  function drawParticles() {
    var img = SPRITES.particle;
    particles.forEach(function (p) {
      var t = (elapsedMs - p.born) / p.life;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, p.x - 6, p.y - 6, 12, 12);
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      }
      ctx.restore();
    });
  }

  function pushFloater(text, x, y, color) {
    floaters.push({ text: text, x: x, y: y, color: color, born: elapsedMs, life: 900 });
  }
  function pushCombo(name) {
    pushFloater(name + '!', PLAYER_SCREEN_X, GROUND_Y - 90, '#FFC933');
    playCombo();
    if (!bestComboName) bestComboName = name;
  }
  function updateFloaters() {
    for (var i = floaters.length - 1; i >= 0; i--) {
      if (elapsedMs - floaters[i].born > floaters[i].life) floaters.splice(i, 1);
    }
  }
  function drawFloaters() {
    floaters.forEach(function (f) {
      var t = (elapsedMs - f.born) / f.life;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 16px Manrope, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y - t * 30);
      ctx.restore();
    });
  }

  /* =========================================================
     SCORE, MULTIPLICADOR Y COMBOS
     ========================================================= */
  function addScore(base, isSpecialAction) {
    score += Math.round(base * comboMultiplier);
    if (isSpecialAction) {
      lastSpecialActionTime = elapsedMs;
      if (comboMultiplier < 5) comboMultiplier++;
    }
  }
  function updateMultiplier() {
    if (elapsedMs - lastSpecialActionTime > COMBO_WINDOW_MS && comboMultiplier > 1) {
      comboMultiplier--;
      lastSpecialActionTime = elapsedMs - COMBO_WINDOW_MS * 0.4;
    }
  }

  /* =========================================================
     RESET / CICLO DE VIDA DE LA PARTIDA
     ========================================================= */
  function resetGame() {
    player = { worldX: 0, y: GROUND_Y - SIZE, vy: 0, onGround: true, squash: 0 };
    speed = BASE_SPEED;
    elapsedMs = 0;
    lastTime = null;
    distance = 0;
    cycleStartTime = 0;
    cycleStartWorldX = 0;
    recording = [];
    clones = [];
    particles = [];
    floaters = [];
    buttons = []; doors = []; coins = []; echoCoins = []; spikesArr = [];
    enemies = []; lasers = []; platformsArr = []; gaps = []; blocks = [];
    nextSegmentX = 0;
    lastSegmentIds = [];
    difficultyTier = 1;
    score = 0;
    coinsThisRun = 0;
    comboMultiplier = 1;
    lastSpecialActionTime = 0;
    bestComboName = null;
    enemiesKilled = 0;
    switchesActivated = 0;
    clonesCreatedThisRun = 0;
    cameraShake = 0;
    zoomPulse = 0;
    ensureLevelAhead();
  }

  function jump() {
    if (state !== 'playing') return;
    if (player.onGround) {
      player.vy = JUMP_VELOCITY;
      player.onGround = false;
      player.squash = -1;
      recording.push({ t: elapsedMs - cycleStartTime });
      playJump();
      spawnParticles(PLAYER_SCREEN_X + SIZE / 2, player.y + SIZE, '#FFFFFF', 6);
    }
  }

  function finalizeCycle() {
    if (recording.length) spawnClone(recording, speed, cycleStartWorldX);
    recording = [];
    cycleStartTime = elapsedMs;
    cycleStartWorldX = player.worldX;
  }

  function endGame() {
    if (state !== 'playing') return;
    state = 'gameover';
    playGameOver();
    cameraShake = 10;
    var finalScore = Math.round(score);
    var isNewBest = finalScore > best;
    if (isNewBest) best = finalScore;
    localStorage.setItem(BEST_KEY, String(best));
    totalCoins += coinsThisRun;
    localStorage.setItem(COINS_KEY, String(totalCoins));
    var bestClones = parseInt(localStorage.getItem(BEST_CLONES_KEY) || '0', 10) || 0;
    if (clonesCreatedThisRun > bestClones) localStorage.setItem(BEST_CLONES_KEY, String(clonesCreatedThisRun));
    if (bestComboName) localStorage.setItem(BEST_COMBO_KEY, bestComboName);
    if (finalScore > 0) submitScore(finalScore);

    goTitle.textContent = isNewBest ? 'New best! ' + finalScore : 'Score: ' + finalScore;
    goStats.innerHTML =
      '<span>Best</span><span>' + best + '</span>' +
      '<span>Distance</span><span>' + Math.round(distance) + 'm</span>' +
      '<span>Echoes created</span><span>' + clonesCreatedThisRun + '</span>' +
      '<span>Coins</span><span>' + coinsThisRun + '</span>' +
      '<span>Enemies beaten</span><span>' + enemiesKilled + '</span>' +
      '<span>Best combo</span><span>' + (bestComboName || '—') + '</span>';

    var plays = parseInt(localStorage.getItem(PLAYS_KEY) || '0', 10) || 0;
    plays++;
    localStorage.setItem(PLAYS_KEY, String(plays));
    if (plays % AD_BREAK_INTERVAL === 0) {
      state = 'adbreak';
      adBreak.classList.remove('hidden');
    } else {
      showPanel('gameover');
    }
  }

  if (adBreakContinueBtn) {
    adBreakContinueBtn.addEventListener('click', function () {
      adBreak.classList.add('hidden');
      showPanel('gameover');
    });
  }

  /* =========================================================
     ACTUALIZACIÓN PRINCIPAL DEL JUGADOR Y EL MUNDO
     ========================================================= */
  function updateDifficulty() {
    var newTier = 1;
    if (elapsedMs > 180000) newTier = 7;
    else if (elapsedMs > 140000) newTier = 6;
    else if (elapsedMs > 100000) newTier = 5;
    else if (elapsedMs > 70000) newTier = 4;
    else if (elapsedMs > 40000) newTier = 3;
    else if (elapsedMs > 20000) newTier = 2;
    difficultyTier = Math.max(difficultyTier, newTier);
    var steps = Math.floor(elapsedMs / SPEED_STEP_MS);
    speed = Math.min(MAX_SPEED, BASE_SPEED + steps * SPEED_STEP);
  }

  function updatePlayer(dt) {
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    var wasOnGround = player.onGround;
    var pit = isPitAt(player.worldX + SIZE / 2);
    if (!pit && player.y >= GROUND_Y - SIZE) {
      player.y = GROUND_Y - SIZE;
      if (!wasOnGround) { playLand(); spawnParticles(PLAYER_SCREEN_X + SIZE / 2, GROUND_Y, '#FFFFFF', 8); }
      player.vy = 0;
      player.onGround = true;
    } else {
      player.onGround = false;
    }
    if (player.y > H + 80) { endGame(); return; }

    player.worldX += speed * dt;
    distance = player.worldX / 12;

    // Puertas: bloquean si están cerradas y el jugador choca contra el frente
    for (var d = 0; d < doors.length; d++) {
      var door = doors[d];
      var wasOpen = door.open;
      door.open = doorOpenNow(door);
      if (door.open && !wasOpen) { playDoor(); switchesActivated++; addScore(15, true); pushCombo('Perfect Sync'); }
      if (!door.open) {
        var overlapsDoor = player.worldX + SIZE > door.x && player.worldX < door.x + door.w;
        if (overlapsDoor) { endGame(); return; }
      }
    }

    // Botones: se presionan si el jugador o algún eco están parados encima
    buttons.forEach(function (btn) { btn.pressed = false; });
    buttons.forEach(function (btn) {
      if (player.worldX + SIZE > btn.x && player.worldX < btn.x + 30 && player.onGround) {
        btn.pressed = true;
      }
    });
    // (los ecos también marcan pressed=true en updateClones, después de este paso)

    // Pinchos
    for (var s = 0; s < spikesArr.length; s++) {
      var sp = spikesArr[s];
      if (player.worldX + SIZE - 8 > sp.x && player.worldX + 8 < sp.x + sp.w && player.y + SIZE > GROUND_Y - 14) {
        endGame(); return;
      }
    }

    // Monedas normales (solo el jugador las junta)
    coins.forEach(function (c) {
      if (!c.taken && player.worldX + SIZE > c.x && player.worldX < c.x + 26) {
        c.taken = true;
        coinsThisRun++;
        addScore(10, true);
        playCoin();
        spawnParticles(toScreenX(c.x), GROUND_Y - 20, '#FFC933', 8);
      }
    });

    // Enemigos: arriba mata, de costado es Game Over. Los ecos se resuelven en updateClones.
    for (var e = 0; e < enemies.length; e++) {
      var en = enemies[e];
      if (!en.alive) continue;
      var overlap = player.worldX + SIZE > en.x && player.worldX < en.x + 30;
      if (!overlap) continue;
      var landingOnTop = player.vy >= 0 && player.y + SIZE - 10 <= en.y + 14;
      if (landingOnTop) {
        en.alive = false;
        enemiesKilled++;
        addScore(30, true);
        player.vy = BOUNCE_VELOCITY;
        player.onGround = false;
        spawnParticles(toScreenX(en.x), en.y, '#FFA23D', 16);
        playEnemyHit();
      } else {
        endGame(); return;
      }
    }

    // Láseres: los que dependen de un botón se apagan mientras esté presionado
    for (var l = 0; l < lasers.length; l++) {
      var laser = lasers[l];
      if (laser.linkedButton) {
        var disabledByClones = laser.minClonesToDisable && clones.length >= laser.minClonesToDisable;
        laser.active = !disabledByClones && !isButtonPressed(laser.linkedButton);
      } else {
        laser.active = Math.floor((elapsedMs + laser.x) / laser.blinkMs) % 2 === 0;
      }
      if (laser.active) {
        var hitsLaser = player.worldX + SIZE > laser.x && player.worldX < laser.x + laser.w;
        if (hitsLaser) { endGame(); return; }
      }
    }

    // Puntaje continuo por distancia
    score += speed * dt * 0.02;

    if (player.squash < 0) player.squash = Math.min(0, player.squash + dt * 0.01);
  }

  /* =========================================================
     DIBUJO
     ========================================================= */
  var TIER_COLORS = [
    ['#0a0e1c', '#141b33'], // 1: azul oscuro
    ['#160e2c', '#241748'], // 2: violeta
    ['#2c0e14', '#481723'], // 3: rojo oscuro
    ['#0e2416', '#173a22'], // 4: verde oscuro
    ['#2c1608', '#48260c'], // 5: naranja oscuro
    ['#160e2c', '#2c0e2c'], // 6: violeta-magenta
    ['#0a0e1c', '#2c0e2c']  // 7: mezcla final
  ];

  function drawBackground() {
    var colors = TIER_COLORS[Math.min(difficultyTier, TIER_COLORS.length) - 1];
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function drawGround() {
    var startWorld = player.worldX - PLAYER_SCREEN_X - 40;
    var endWorld = startWorld + W + 120;
    var x = startWorld;
    var solidStartScreen = null;
    while (x < endWorld) {
      var solid = !isPitAt(x);
      var sx = toScreenX(x);
      if (solid && solidStartScreen === null) solidStartScreen = sx;
      if (!solid && solidStartScreen !== null) {
        ctx.fillStyle = '#1b2029';
        ctx.fillRect(solidStartScreen, GROUND_Y, sx - solidStartScreen, H - GROUND_Y);
        ctx.fillStyle = '#3a4152';
        ctx.fillRect(solidStartScreen, GROUND_Y, sx - solidStartScreen, 2);
        solidStartScreen = null;
      }
      x += 8;
    }
    if (solidStartScreen !== null) {
      ctx.fillStyle = '#1b2029';
      ctx.fillRect(solidStartScreen, GROUND_Y, toScreenX(endWorld) - solidStartScreen, H - GROUND_Y);
      ctx.fillStyle = '#3a4152';
      ctx.fillRect(solidStartScreen, GROUND_Y, toScreenX(endWorld) - solidStartScreen, 2);
    }
  }

  function drawPlatforms() {
    platformsArr.forEach(function (p) {
      if (!platformCoversGap(p)) return;
      var tileW = 50;
      for (var wx = p.x1; wx < p.x2; wx += tileW - 6) {
        var sx = toScreenX(wx);
        if (sx < -60 || sx > W + 60) continue;
        drawEntitySprite('platform', sx, GROUND_Y - 10, tileW);
      }
    });
  }

  function drawStaticEntities() {
    spikesArr.forEach(function (sp) {
      var sx = toScreenX(sp.x);
      if (sx < -40 || sx > W + 40) return;
      drawSprite(SPRITES.spikes, sx - 4, GROUND_Y - 24, 34, 26) ||
        (function () { ctx.fillStyle = '#E5484D'; ctx.fillRect(sx, GROUND_Y - 18, sp.w, 18); })();
    });
    buttons.forEach(function (btn) {
      var sx = toScreenX(btn.x);
      if (sx < -40 || sx > W + 40) return;
      var h = btn.pressed ? 12 : 18;
      drawSprite(SPRITES.button, sx - 2, GROUND_Y - h, 28, h);
    });
    doors.forEach(function (door) {
      var sx = toScreenX(door.x);
      if (sx < -40 || sx > W + 40) return;
      if (door.open) return;
      ctx.save();
      ctx.shadowColor = door.requireAll ? '#FFC933' : '#3D8BFF';
      ctx.shadowBlur = 12;
      ctx.fillStyle = door.requireAll ? 'rgba(255,201,51,.55)' : 'rgba(61,139,255,.55)';
      ctx.fillRect(sx, GROUND_Y - door.h, door.w, door.h);
      ctx.restore();
    });
    coins.forEach(function (c) {
      if (c.taken) return;
      var sx = toScreenX(c.x);
      if (sx < -40 || sx > W + 40) return;
      drawEntitySprite('coin', sx - 2, GROUND_Y - 34, 26);
    });
    echoCoins.forEach(function (ec) {
      if (ec.taken) return;
      var sx = toScreenX(ec.x);
      if (sx < -40 || sx > W + 40) return;
      ctx.save();
      ctx.shadowColor = '#00FFF2';
      ctx.shadowBlur = 14;
      drawEntitySprite('coin', sx - 2, GROUND_Y - 34, 26);
      ctx.restore();
    });
    enemies.forEach(function (en) {
      if (!en.alive) return;
      var sx = toScreenX(en.x);
      if (sx < -50 || sx > W + 50) return;
      drawEntitySprite('enemy', sx, en.y, 34);
    });
    lasers.forEach(function (laser) {
      if (!laser.active) return;
      var sx = toScreenX(laser.x);
      if (sx < -30 || sx > W + 30) return;
      ctx.save();
      ctx.shadowColor = '#FF3D57';
      ctx.shadowBlur = 14;
      ctx.fillStyle = 'rgba(255,61,87,.75)';
      ctx.fillRect(sx, GROUND_Y - laser.h, laser.w, laser.h);
      ctx.restore();
    });
  }

  function drawPlayer() {
    var sx = PLAYER_SCREEN_X;
    var stretch = player.onGround ? 0 : Math.min(0.3, Math.abs(player.vy) * 0.15);
    var w = SIZE * (1 - stretch * 0.4 - Math.max(0, -player.squash) * 0.3);
    var h = SIZE * (1 + stretch * 0.4 + Math.max(0, -player.squash) * 0.3);
    var skin = SKINS.filter(function (s) { return s.id === selectedSkin; })[0] || SKINS[0];
    var img = SPRITES[skin.sprite];
    ctx.save();
    ctx.shadowColor = skin.swatch;
    ctx.shadowBlur = 16;
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, sx - (w - SIZE) / 2, player.y + SIZE - h, w, h);
    } else {
      ctx.fillStyle = skin.swatch;
      ctx.fillRect(sx, player.y, SIZE, SIZE);
    }
    ctx.restore();
  }

  function draw() {
    ctx.save();
    if (cameraShake > 0.2) {
      ctx.translate((Math.random() - 0.5) * cameraShake, (Math.random() - 0.5) * cameraShake);
    }
    drawBackground();
    drawGround();
    drawPlatforms();
    drawStaticEntities();
    drawClones();
    drawPlayer();
    drawParticles();
    drawFloaters();
    ctx.restore();
  }

  /* =========================================================
     HUD
     ========================================================= */
  function syncHud() {
    scoreEl.textContent = 'Score: ' + Math.round(score);
    bestEl.textContent = 'Best: ' + best;
    coinsEl.textContent = '🪙 ' + coinsThisRun;
    clonesEl.textContent = 'Echoes: ' + clones.length;
    multiEl.textContent = 'x' + comboMultiplier;
    var cyclePct = Math.min(100, ((elapsedMs - cycleStartTime) / CYCLE_MS) * 100);
    cycleFill.style.width = cyclePct + '%';
  }

  /* =========================================================
     BUCLE PRINCIPAL
     ========================================================= */
  function loop(time) {
    if (lastTime === null) lastTime = time;
    var dt = Math.min(time - lastTime, 40);
    lastTime = time;
    if (state === 'playing') {
      elapsedMs += dt;
      updateDifficulty();
      ensureLevelAhead();
      cleanupBehind();
      updatePlayer(dt);
      if (state === 'playing') {
        updateClones(dt);
        updateParticles(dt);
        updateFloaters();
        updateMultiplier();
        if (elapsedMs - cycleStartTime >= CYCLE_MS) finalizeCycle();
        if (cameraShake > 0) cameraShake = Math.max(0, cameraShake - dt * 0.03);
        syncHud();
      }
    }
    draw();
    requestAnimationFrame(loop);
  }

  /* =========================================================
     PANELES DE INTERFAZ (menú / tutorial / skins / game over)
     Todos viven dentro del mismo overlay, como en Vex Dash/Snake,
     pero acá el contenido interno cambia según uiPanel.
     ========================================================= */
  function showPanel(name) {
    uiPanel = name;
    overlay.classList.toggle('hidden', !name);
    panelMenu.classList.toggle('hidden', name !== 'menu');
    panelTutorial.classList.toggle('hidden', name !== 'tutorial');
    panelSkins.classList.toggle('hidden', name !== 'skins');
    panelGameOver.classList.toggle('hidden', name !== 'gameover');
    if (name === 'menu') {
      menuBestEl.textContent = String(best);
      menuCoinsEl.textContent = String(totalCoins);
    }
    if (name === 'skins') renderSkinsList();
  }

  function startGame() {
    resetGame();
    state = 'playing';
    uiPanel = null;
    overlay.classList.add('hidden');
    panelMenu.classList.add('hidden');
    panelTutorial.classList.add('hidden');
    panelSkins.classList.add('hidden');
    panelGameOver.classList.add('hidden');
  }

  playBtn.addEventListener('click', function () {
    playMenuClick();
    var tutorialDone = localStorage.getItem(TUTORIAL_DONE_KEY) === '1';
    if (!tutorialDone) { startTutorial(); return; }
    startGame();
  });

  function startTutorial() {
    tutorialStep = 0;
    showPanel('tutorial');
    renderTutorialStep();
  }
  function renderTutorialStep() {
    tutStepTitle.textContent = (tutorialStep + 1) + ' / ' + TUTORIAL_STEPS.length;
    tutStepText.textContent = TUTORIAL_STEPS[tutorialStep];
    tutNextBtn.textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Play ▶' : 'Next ▶';
  }
  tutorialBtn.addEventListener('click', function () { playMenuClick(); startTutorial(); });
  tutNextBtn.addEventListener('click', function () {
    playMenuClick();
    if (tutorialStep < TUTORIAL_STEPS.length - 1) {
      tutorialStep++;
      renderTutorialStep();
    } else {
      localStorage.setItem(TUTORIAL_DONE_KEY, '1');
      startGame();
    }
  });

  function renderSkinsList() {
    skinsList.innerHTML = SKINS.map(function (s) {
      var unlocked = unlockedSkins[s.id] || s.cost === 0;
      var isSelected = s.id === selectedSkin;
      var label = unlocked ? s.name : s.name + ' 🪙' + s.cost;
      return '<button type="button" class="echo-skin-btn' + (isSelected ? ' selected' : '') + '" data-skin="' + s.id + '">' +
        '<span class="echo-skin-swatch" style="background:' + s.swatch + '"></span>' + escapeHtml(label) + '</button>';
    }).join('');
    Array.prototype.forEach.call(skinsList.querySelectorAll('.echo-skin-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-skin');
        var skin = SKINS.filter(function (s) { return s.id === id; })[0];
        var unlocked = unlockedSkins[id] || skin.cost === 0;
        if (!unlocked) {
          if (totalCoins >= skin.cost) {
            totalCoins -= skin.cost;
            localStorage.setItem(COINS_KEY, String(totalCoins));
            unlockedSkins[id] = true;
            localStorage.setItem(UNLOCKED_KEY, JSON.stringify(unlockedSkins));
          } else {
            playEnemyHit();
            return;
          }
        }
        selectedSkin = id;
        localStorage.setItem(SKIN_KEY, id);
        playMenuClick();
        renderSkinsList();
      });
    });
  }
  skinsBtn.addEventListener('click', function () { playMenuClick(); showPanel('skins'); });
  skinsBackBtn.addEventListener('click', function () { playMenuClick(); showPanel('menu'); });

  restartBtn.addEventListener('click', function () { playMenuClick(); startGame(); });
  menuBtn.addEventListener('click', function () { playMenuClick(); showPanel('menu'); });

  /* =========================================================
     CONTROLES: toque, clic izquierdo, barra espaciadora
     ========================================================= */
  function handleTap() {
    if (state === 'playing') { jump(); return; }
    if (state === 'gameover' && uiPanel === 'gameover') { startGame(); return; }
  }
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); handleTap(); }, { passive: false });
  canvas.addEventListener('mousedown', function (e) { if (e.button === 0) handleTap(); });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); handleTap(); }
  });

  /* ---- Arranque ---- */
  state = 'menu';
  uiPanel = null;
  player = { worldX: 0, y: GROUND_Y - SIZE, vy: 0, onGround: true, squash: 0 };
  clones = []; particles = []; floaters = [];
  buttons = []; doors = []; coins = []; echoCoins = []; spikesArr = [];
  enemies = []; lasers = []; platformsArr = []; gaps = []; blocks = [];
  elapsedMs = 0; cycleStartTime = 0; difficultyTier = 1; speed = BASE_SPEED;
  distance = 0; score = 0; coinsThisRun = 0; comboMultiplier = 1;
  showPanel('menu');
  requestAnimationFrame(loop);
  loadLeaderboard();
})();

