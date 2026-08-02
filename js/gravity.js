/*
  Gravity Flip (play/gravity.html) — ahora un plataformas rítmico de
  nivel fijo estilo Geometry Dash ("Neon Pulse", nivel 1 de varios).
  Tres formas de personaje (cubo/nave/bola), portales de forma y de
  gravedad, orbes (tap para activar), jump pads (automáticos), pinchos,
  sierras, plataformas, llave+puerta, 3 monedas secretas y meta final.
  Usa las sprites de img/gravitycover/sliced/ (recortadas de la hoja
  del usuario). Sonido sintetizado con Web Audio API, mismo patrón de
  tabla de posiciones (api/gravity.js, score = % del nivel completado)
  y pausa publicitaria cada 3 intentos que los otros juegos.
*/
(function () {
  var canvas = document.getElementById('gravityCanvas');
  if (!canvas) return;
  var dashWrap = canvas.closest('.dash-wrap');

  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var FLOOR_Y = H - 40;
  var CEIL_Y = 40;
  var MID_Y = (FLOOR_Y + CEIL_Y) / 2;
  var PLAYER_SIZE = 32;
  var PLAYER_SCREEN_X = 160;
  var PORTAL_W = 48, PORTAL_H = 64;

  var scoreEl = document.getElementById('gravityScore');
  var bestEl = document.getElementById('gravityBest');
  var coinsEl = document.getElementById('gravityCoins');
  var keyEl = document.getElementById('gravityKey');
  var walletEl = document.getElementById('gravityWallet');
  var muteBtn = document.getElementById('gravityMute');
  var overlay = document.getElementById('gravityOverlay');
  var overlayText = document.getElementById('gravityOverlayText');
  var levelBtn = document.getElementById('gravityLevelBtn');
  var skinBtn = document.getElementById('gravitySkinBtn');
  var nameModal = document.getElementById('gravityNameModal');
  var nameInput = document.getElementById('gravityNameInput');
  var nameSaveBtn = document.getElementById('gravityNameSave');
  var nameSkipBtn = document.getElementById('gravityNameSkip');
  var adBreak = document.getElementById('gravityAdBreak');
  var adBreakContinueBtn = document.getElementById('gravityAdBreakContinue');
  var lbList = document.getElementById('gravityLeaderboardList');
  var lbYou = document.getElementById('gravityYouRank');
  var levelSelect = document.getElementById('gravityLevelSelect');
  var levelGrid = document.getElementById('gravityLevelGrid');
  var levelSelectClose = document.getElementById('gravityLevelSelectClose');
  var skinSelect = document.getElementById('gravitySkinSelect');
  var skinGrid = document.getElementById('gravitySkinGrid');
  var skinSelectClose = document.getElementById('gravitySkinSelectClose');
  var skinWalletLine = document.getElementById('gravitySkinWalletLine');
  var homeBtn = document.getElementById('gravityHomeBtn');
  var homeMenu = document.getElementById('gravityHomeMenu');
  var homeAvatar = document.getElementById('gravityHomeAvatar');
  var homeName = document.getElementById('gravityHomeName');
  var homeStarsEl = document.getElementById('gravityHomeStars');
  var homeCoinsEl = document.getElementById('gravityHomeCoins');
  var homeDiamondsEl = document.getElementById('gravityHomeDiamonds');
  var homeLevelsBtn = document.getElementById('gravityHomeLevelsBtn');
  var homePlayBtn = document.getElementById('gravityHomePlayBtn');
  var homeSkinsBtn = document.getElementById('gravityHomeSkinsBtn');
  var homeProgressFill = document.getElementById('gravityHomeProgressFill');
  var homeLvlEl = document.getElementById('gravityHomeLvl');
  var homeTrophyBtn = document.getElementById('gravityHomeTrophyBtn');
  var homeMuteBtn = document.getElementById('gravityHomeMuteBtn');
  var levelStarsChip = document.getElementById('gravityLevelStarsChip');
  var skinTabCollection = document.getElementById('gravitySkinTabCollection');
  var skinTabShop = document.getElementById('gravitySkinTabShop');
  var skinRarities = document.getElementById('gravitySkinRarities');
  var skinPreviewPanel = document.getElementById('gravitySkinPreviewPanel');
  var skinPreviewImg = document.getElementById('gravitySkinPreviewImg');
  var skinPreviewName = document.getElementById('gravitySkinPreviewName');
  var skinPreviewRarity = document.getElementById('gravitySkinPreviewRarity');
  var skinEquipBtn = document.getElementById('gravitySkinEquipBtn');

  var PLAYS_KEY = 'vexlow_gravity_plays';
  var AD_BREAK_INTERVAL = 3;
  var MUTE_KEY = 'vexlow_gravity_muted';
  var NAME_KEY = 'vexlow_dash_name';
  var VID_KEY = 'vexlow_vid';
  var COINS_WALLET_KEY = 'vexlow_gravity_coins'; // billetera acumulada (ya existía como "mejor cantidad de una corrida" -- se reusa como billetera)
  var DIAMONDS_WALLET_KEY = 'vexlow_gravity_diamonds';
  var PROGRESS_KEY = 'vexlow_gravity_progress'; // JSON: ids de nivel desbloqueados
  var SKIN_KEY = 'vexlow_gravity_skin';
  var UNLOCKED_SKINS_KEY = 'vexlow_gravity_unlocked_skins'; // JSON: ids de skin desbloqueados
  function bestKeyFor(levelId) { return 'vexlow_gravity_best_' + levelId; }
  function diamondClaimedKeyFor(levelId) { return 'vexlow_gravity_diamond_' + levelId; }
  function starsKeyFor(levelId) { return 'vexlow_gravity_stars_' + levelId; }
  function starsFor(levelId) { return parseInt(localStorage.getItem(starsKeyFor(levelId)) || '0', 10) || 0; }
  function totalStars() {
    var total = 0;
    for (var i = 0; i < LEVELS.length; i++) total += starsFor(LEVELS[i].id);
    return total;
  }

  function readJSON(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var coinsWallet = parseInt(localStorage.getItem(COINS_WALLET_KEY) || '0', 10) || 0;
  var diamondsWallet = parseInt(localStorage.getItem(DIAMONDS_WALLET_KEY) || '0', 10) || 0;
  var unlockedLevels = readJSON(PROGRESS_KEY, ['level_01']);
  var unlockedSkins = readJSON(UNLOCKED_SKINS_KEY, ['skin_01']);
  var currentSkin = localStorage.getItem(SKIN_KEY) || 'skin_01';
  var muted = localStorage.getItem(MUTE_KEY) === '1';
  var best = 0; // se actualiza por nivel en selectLevel()
  muteBtn.textContent = muted ? '🔇' : '🔊';

  function updateWalletHud() {
    if (walletEl) walletEl.textContent = '🪙 ' + coinsWallet + '  💎 ' + diamondsWallet;
  }
  updateWalletHud();

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
          '<span class="dash-lb-score">' + row.score + '%</span></li>';
      }).join('');
    }
    if (lbYou) {
      if (data.you && data.you.rank > 10) {
        lbYou.hidden = false;
        lbYou.textContent = 'Your rank: #' + data.you.rank + ' (' + data.you.score + '%)';
      } else {
        lbYou.hidden = true;
      }
    }
  }
  function loadLeaderboard() {
    fetch('/api/gravity?visitorId=' + encodeURIComponent(visitorId) + '&level=' + encodeURIComponent(currentLevelId()))
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
      body: JSON.stringify({ name: name, score: finalScore, visitorId: visitorId, level: currentLevelId() })
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
  function playJump() { beep(420, 760, 0.08, 'square', 0.09); }
  function playPortal() { beep(300, 900, 0.18, 'sine', 0.1); }
  function playPickup() { beep(700, 1200, 0.12, 'triangle', 0.11); }
  function playPad() { beep(500, 1000, 0.1, 'sawtooth', 0.09); }
  function playWin() { beep(500, 1400, 0.4, 'sine', 0.13); }
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
    if (homeMuteBtn) homeMuteBtn.textContent = muted ? '🔇' : '🔊';
  });

  /* ---- Sprites ----
     El personaje se dibuja siempre con la skin activa (incluida la
     "skin_01" por defecto) — los skins no tienen variantes de salto/
     muerte propias, así que se usa la misma imagen para cubo/nave/
     bola en cualquier estado; el "feedback" de salto/muerte queda a
     cargo de partículas y sonido en vez de cambiar de cara. */
  // Los sprites (incluidas las variantes cosméticas opcionales
  // spike_vN/saw_vN/platform_vN/portal_vN que un nivel puede pedir
  // vía `variant: 'v3'`) se cargan de forma perezosa la primera vez
  // que se piden -- así no hace falta saber de antemano cuántas
  // variantes existen ni tocar este archivo cada vez que se sube una
  // nueva desde el panel de admin.
  var sprites = {};
  function getSprite(name) {
    var img = sprites[name];
    if (!img) {
      img = new Image();
      img.src = '../img/gravitycover/sliced/' + name + '.png';
      sprites[name] = img;
    }
    return img;
  }
  var skinImg = new Image();
  function setActiveSkin(skinId) {
    currentSkin = skinId;
    skinImg.src = '../img/gravitycover/sliced/' + skinId + '.png';
    try { localStorage.setItem(SKIN_KEY, skinId); } catch (e) {}
  }
  setActiveSkin(currentSkin);
  function drawSprite(name, x, y, w, h) {
    var img = getSprite(name);
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x, y, w, h);
    }
  }
  function drawSkin(x, y, w, h) {
    if (skinImg.complete && skinImg.naturalWidth > 0) ctx.drawImage(skinImg, x, y, w, h);
  }

  // Color representativo de cada bloque de piso subido por el
  // usuario, calculado en el momento (una sola vez por variante, con
  // un canvas auxiliar) en vez de tener una tabla fija -- así
  // funciona automáticamente con cualquier bloque nuevo que se suba,
  // sin tener que tocar este archivo.
  var floorColorCache = {};
  function floorVariantColor(variant) {
    if (floorColorCache[variant]) return floorColorCache[variant];
    var img = getSprite('floor_' + variant);
    if (!img.complete || img.naturalWidth === 0) return null;
    try {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var cctx = c.getContext('2d');
      cctx.drawImage(img, 0, 0);
      var data = cctx.getImageData(0, 0, c.width, c.height).data;
      var r = 0, g = 0, b = 0, wsum = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue; // pixel transparente
        var bright = Math.max(data[i], data[i + 1], data[i + 2]);
        var w = Math.max(0.05, Math.min(1, (bright - 40) / 180));
        r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; wsum += w;
      }
      var color = wsum > 0 ? 'rgb(' + Math.round(r / wsum) + ',' + Math.round(g / wsum) + ',' + Math.round(b / wsum) + ')' : '#3D3040';
      floorColorCache[variant] = color;
      return color;
    } catch (e) {
      return null; // ej. lienzo no disponible en el sandbox de pruebas
    }
  }

  /* ---- Física (por forma) ----
     Cubo: gravedad + salto al tocar mientras está apoyado.
     Nave: mantener presionado = empuje hacia arriba, soltar = cae.
     Bola: tap invierte la dirección de gravedad al instante (con
     impulso), se pega a la superficie donde cae — es la misma
     mecánica que tenía el Gravity Flip original. */
  var CUBE_GRAVITY = 0.0032, CUBE_JUMP_V = 0.85, CUBE_MAX_VY = 1.3;
  var SHIP_THRUST = 0.0021, SHIP_FALL = 0.0021, SHIP_MAX_VY = 0.46;
  var BALL_GRAVITY = 0.0028, BALL_FLIP_KICK = 0.34, BALL_MAX_VY = 1.0;
  var ORB_YELLOW_V = 0.85, ORB_PINK_V = 0.46;

  /* ---- Construcción del nivel ----
     Cursor-based: cada helper agrega un objeto en la posición actual
     del cursor y lo hace avanzar una distancia "cómoda" ya verificada
     contra la física de arriba (mucho más que la mínima necesaria),
     así el espaciado es seguro por construcción en vez de a mano.
     Más niveles se agregan sumando más entradas a LEVELS. */
  var GAP_CUBE = 230;      // espacio cómodo entre obstáculos en modo cubo/1x
  var GAP_CUBE_FAST = 300; // ídem a 1.5x/2x (recorre más mundo por segundo)
  var GAP_SHIP = 260;

  // @gravity-editor:start level_01
  function buildNeonPulse() {
    var objs = [];
    var cursor = 500;
    var speedZone = []; // { from, speed }
    function setSpeed(x, speed) { speedZone.push({ x: x, speed: speed }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }

    setSpeed(0, 0.28);

    // -- Sección 1 (cubo, 1x): salto básico --------------------------
    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE + 30;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE;
    add({ type: 'gravityPortal', dir: -1 });
    cursor += 40;

    // -- Sección 2 (cubo, 1x): orbes + gravedad -----------------------
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    add({ type: 'spike', surface: 'ceil', w: 28, xOff: 26 });
    cursor += 130;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 150;
    add({ type: 'platform', surface: 'ceil', w: 90, lift: 46 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    cursor += 130;
    add({ type: 'orb', color: 'pink', y: CEIL_Y + 150 });
    cursor += 40;
    add({ type: 'gravityPortal', dir: 1 });
    cursor += 260;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;

    // -- Sección 3 (nave, 1.5x): túnel con sierras --------------------
    add({ type: 'shapePortal', form: 'ship' });
    setSpeed(cursor + 20, 0.4);
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'ceil' });
    cursor += 90;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 60 });
    cursor += GAP_SHIP;
    add({ type: 'diamond', y: (FLOOR_Y + CEIL_Y) / 2 });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    add({ type: 'saw', surface: 'ceil', xOff: 170 });
    cursor += GAP_SHIP + 170;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;

    // -- Sección 4 (cubo, 1.5x): triple pincho + orbes ----------------
    setSpeed(cursor, 0.4);
    cursor += GAP_CUBE_FAST;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 52 });
    cursor += 140;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 150;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE_FAST;
    add({ type: 'orb', color: 'green', y: FLOOR_Y - 130 });
    cursor += 40;
    add({ type: 'gravityPortal', dir: -1 });
    cursor += 260;
    add({ type: 'key', y: FLOOR_Y - 170 });
    cursor += GAP_CUBE_FAST;
    add({ type: 'gravityPortal', dir: 1 });
    cursor += 40;
    add({ type: 'shapePortal', form: 'ball' });
    cursor += 40;

    // -- Sección 5 (bola, 2x): flips encadenados ----------------------
    setSpeed(cursor, 0.52);
    cursor += 260;
    add({ type: 'saw', surface: 'floor' });
    cursor += 260;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    add({ type: 'spike', surface: 'ceil', w: 28, xOff: 26 });
    cursor += 260;
    add({ type: 'pad', color: 'cyan', surface: 'floor' });
    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    cursor += 260;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;

    // -- Sección 6 (cubo, 2x -> 1x): combinado + puerta + final -------
    setSpeed(cursor, 0.52);
    cursor += GAP_CUBE_FAST;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += 150;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 150;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE_FAST;
    add({ type: 'gravityPortal', dir: -1 });
    cursor += 40;
    add({ type: 'pad', color: 'yellow', surface: 'ceil' });
    cursor += 300;
    add({ type: 'coin', id: 2, y: CEIL_Y + 170, risky: true });
    cursor += 40;
    add({ type: 'gravityPortal', dir: 1 });
    cursor += 40;

    var doorX = cursor + 40;
    add({ type: 'door', x2: doorX });
    setSpeed(cursor, 0.34);
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'floor', w: 28 });
    cursor += GAP_CUBE;
    add({ type: 'pad', color: 'pink', surface: 'floor' });
    cursor += 260;
    setSpeed(cursor, 0.28);
    add({ type: 'finish' });
    cursor += 300;

    // resolver xOff / posiciones relativas
    objs.forEach(function (o) {
      if (o.xOff) { o.x += o.xOff; delete o.xOff; }
    });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_01

  // Helper genérico para el cierre de cualquier nivel: llave -> puerta
  // (nunca letal, ver comentario en el manejo de 'door') -> tramo final
  // -> meta. Reduce repetición entre los 10 niveles.
  function addKeyDoorFinish(add, getCursor, setCursor, keyY, finalSpeed) {
    add({ type: 'key', y: keyY });
    setCursor(getCursor() + GAP_CUBE);
    var doorX = getCursor() + 40;
    add({ type: 'door', x2: doorX });
    setCursor(doorX + 260);
    add({ type: 'finish' });
    setCursor(getCursor() + 300);
  }

  // @gravity-editor:start level_02
  function buildGreenCircuit() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'floor', w: 28 });
    cursor += 140;
    add({ type: 'orb', color: 'pink', y: FLOOR_Y - 140 });
    cursor += GAP_CUBE;
    add({ type: 'diamond', y: FLOOR_Y - 160 });
    cursor += 40;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    add({ type: 'orb', color: 'green', y: FLOOR_Y - 130 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE + 40;
    add({ type: 'platform', surface: 'floor', w: 220, lift: 46 }); // puente largo
    cursor += 260;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 2, y: FLOOR_Y - 120, risky: true });
    cursor += 40;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_02

  // @gravity-editor:start level_03
  function buildGravityGarden() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'gravityPortal', dir: -1 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    cursor += GAP_CUBE;
    add({ type: 'platform', surface: 'ceil', w: 90, lift: 46 });
    add({ type: 'coin', id: 0, y: CEIL_Y + 120 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'green', y: CEIL_Y + 130 }); // vuelve a piso normal
    cursor += 40;
    add({ type: 'diamond', y: CEIL_Y + 160 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    add({ type: 'spike', surface: 'ceil', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'yellow', y: CEIL_Y + 150 });
    cursor += GAP_CUBE;
    add({ type: 'gravityPortal', dir: 1 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'floor', w: 28 });
    cursor += 140;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 2, y: FLOOR_Y - 120, risky: true });
    cursor += 40;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_03

  // @gravity-editor:start level_04
  function buildSkyRider() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 150;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'shapePortal', form: 'ship' });
    setSpeed(cursor + 20, 0.28);
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'ceil' });
    cursor += 100;
    add({ type: 'diamond', y: (FLOOR_Y + CEIL_Y) / 2 });
    cursor += GAP_SHIP;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 80 });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    add({ type: 'saw', surface: 'ceil', xOff: 180 });
    cursor += GAP_SHIP + 180;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.28);
    add({ type: 'coin', id: 2, y: FLOOR_Y - 120, risky: true });
    cursor += GAP_CUBE;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_04

  // @gravity-editor:start level_05
  function buildRollingLight() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'shapePortal', form: 'ball' });
    cursor += 40;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 260;
    add({ type: 'saw', surface: 'floor' });
    cursor += 260;
    add({ type: 'diamond', y: (FLOOR_Y + CEIL_Y) / 2 });
    cursor += 260;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += 260;
    add({ type: 'gravityPortal', dir: -1 });
    cursor += 260;
    add({ type: 'saw', surface: 'ceil' });
    cursor += 260;
    add({ type: 'coin', id: 1, y: CEIL_Y + 120 });
    cursor += 260;
    setSpeed(cursor, 0.35);
    add({ type: 'gravityPortal', dir: 1 });
    cursor += 300;
    add({ type: 'saw', surface: 'floor' });
    cursor += 300;
    add({ type: 'coin', id: 2, y: FLOOR_Y - 120, risky: true });
    cursor += 40;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.28);

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_05

  // @gravity-editor:start level_06
  function buildFireFactory() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += GAP_CUBE;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_CUBE;
    // Plataforma móvil: oscila en Y, alcance moderado, período largo
    // para que esté "abajo" (fácil de alcanzar) buena parte del ciclo.
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46, moving: true, amp: 30, periodMs: 2600 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'shapePortal', form: 'ship' });
    setSpeed(cursor + 20, 0.35);
    cursor += GAP_SHIP;
    add({ type: 'diamond', y: (FLOOR_Y + CEIL_Y) / 2 });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_SHIP;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 80 });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'ceil' });
    cursor += GAP_SHIP;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.28);
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 150;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE;
    add({ type: 'pad', color: 'yellow', surface: 'floor' });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 2, y: FLOOR_Y - 150, risky: true });
    cursor += GAP_CUBE;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_06

  // @gravity-editor:start level_07
  function buildAquaBounce() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'shapePortal', form: 'ball' });
    cursor += 40;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_CUBE;
    add({ type: 'diamond', y: (FLOOR_Y + CEIL_Y) / 2 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'pad', color: 'cyan', surface: 'floor' });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'pink', y: FLOOR_Y - 130 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    add({ type: 'coin', id: 2, y: FLOOR_Y - 150, risky: true });
    cursor += GAP_CUBE;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_07

  // @gravity-editor:start level_08
  function buildPixelCastle() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'shapePortal', form: 'ship' });
    setSpeed(cursor + 20, 0.28);
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_SHIP;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 80 });
    cursor += GAP_SHIP;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.28);
    add({ type: 'gravityPortal', dir: -1 });
    cursor += GAP_CUBE;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    cursor += 140;
    add({ type: 'orb', color: 'yellow', y: CEIL_Y + 150 });
    cursor += GAP_CUBE;
    add({ type: 'diamond', y: CEIL_Y + 160 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'green', y: CEIL_Y + 130 });
    cursor += 40;
    add({ type: 'shapePortal', form: 'ball' });
    cursor += GAP_CUBE;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    add({ type: 'coin', id: 2, y: FLOOR_Y - 150, risky: true });
    cursor += GAP_CUBE;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_08

  // @gravity-editor:start level_09
  function buildCyberSwitch() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    cursor += GAP_CUBE;
    // Interruptor: opcional -- si se toca, desactiva la sierra que
    // sigue (linkId compartido). Si no se toca, la sierra sigue activa
    // y hay que esquivarla saltando como cualquier otro obstáculo, así
    // que nunca es obligatorio ni puede dejar el nivel imposible.
    add({ type: 'interruptor', linkId: 'sw1' });
    cursor += GAP_CUBE;
    add({ type: 'saw', surface: 'floor', linkId: 'sw1' });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += GAP_CUBE;
    add({ type: 'diamond', y: FLOOR_Y - 160 });
    cursor += GAP_CUBE;
    add({ type: 'shapePortal', form: 'ship' });
    setSpeed(cursor + 20, 0.28);
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'ceil' });
    cursor += GAP_SHIP;
    add({ type: 'coin', id: 1, y: FLOOR_Y - 80 });
    cursor += GAP_SHIP;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.28);
    add({ type: 'coin', id: 2, y: FLOOR_Y - 150, risky: true });
    cursor += GAP_CUBE;

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_09

  // @gravity-editor:start level_10
  function buildNeonFinale() {
    var objs = [], cursor = 500, speedZone = [];
    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }
    function add(o) { o.x = cursor; objs.push(o); return o; }
    setSpeed(0, 0.28);

    // Cubo
    cursor += 260;
    add({ type: 'spike', surface: 'floor', w: 28 });
    add({ type: 'spike', surface: 'floor', w: 28, xOff: 26 });
    cursor += GAP_CUBE;
    add({ type: 'orb', color: 'yellow', y: FLOOR_Y - 150 });
    cursor += 150;
    add({ type: 'platform', surface: 'floor', w: 90, lift: 46 });
    cursor += GAP_CUBE;
    add({ type: 'coin', id: 0, y: FLOOR_Y - 120 });
    cursor += GAP_CUBE;
    // Nave
    add({ type: 'shapePortal', form: 'ship' });
    setSpeed(cursor + 20, 0.35);
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'floor' });
    cursor += GAP_SHIP;
    add({ type: 'diamond', y: (FLOOR_Y + CEIL_Y) / 2 });
    cursor += GAP_SHIP;
    add({ type: 'saw', surface: 'ceil' });
    cursor += GAP_SHIP;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.35);
    // Gravedad
    add({ type: 'gravityPortal', dir: -1 });
    cursor += GAP_CUBE_FAST;
    add({ type: 'spike', surface: 'ceil', w: 28 });
    cursor += 150;
    add({ type: 'orb', color: 'green', y: CEIL_Y + 130 });
    cursor += 40;
    add({ type: 'coin', id: 1, y: CEIL_Y + 120 });
    cursor += GAP_CUBE_FAST;
    // Bola
    add({ type: 'shapePortal', form: 'ball' });
    setSpeed(cursor + 20, 0.45);
    cursor += 280;
    add({ type: 'saw', surface: 'floor' });
    cursor += 280;
    add({ type: 'pad', color: 'yellow', surface: 'floor' });
    cursor += 280;
    add({ type: 'shapePortal', form: 'cube' });
    cursor += 40;
    setSpeed(cursor, 0.35);
    add({ type: 'coin', id: 2, y: FLOOR_Y - 150, risky: true });
    cursor += GAP_CUBE_FAST;
    setSpeed(cursor, 0.28);

    addKeyDoorFinish(add, function () { return cursor; }, function (v) { cursor = v; }, FLOOR_Y - 170, 0.28);

    objs.forEach(function (o) { if (o.xOff) { o.x += o.xOff; delete o.xOff; } });
    return { objects: objs, length: cursor, speedZones: speedZone };
  }
  // @gravity-editor:end level_10

  var LEVELS = [
    { id: 'level_01', name: 'First Pulse', build: buildNeonPulse, thumb: 'level_01' },
    { id: 'level_02', name: 'Green Circuit', build: buildGreenCircuit, thumb: 'level_02' },
    { id: 'level_03', name: 'Gravity Garden', build: buildGravityGarden, thumb: 'level_03' },
    { id: 'level_04', name: 'Sky Rider', build: buildSkyRider, thumb: 'level_04' },
    { id: 'level_05', name: 'Rolling Light', build: buildRollingLight, thumb: 'level_05' },
    { id: 'level_06', name: 'Fire Factory', build: buildFireFactory, thumb: 'level_06' },
    { id: 'level_07', name: 'Aqua Bounce', build: buildAquaBounce, thumb: 'level_07' },
    { id: 'level_08', name: 'Pixel Castle', build: buildPixelCastle, thumb: 'level_08' },
    { id: 'level_09', name: 'Cyber Switch', build: buildCyberSwitch, thumb: 'level_09' },
    { id: 'level_10', name: 'Neon Finale', build: buildNeonFinale, thumb: 'level_10' }
  ];
  var currentLevelIndex = 0;
  function currentLevelId() { return LEVELS[currentLevelIndex].id; }
  var level; // { objects, length, speedZones }

  function speedAt(worldX) {
    var s = level.speedZones[0].speed;
    for (var i = 0; i < level.speedZones.length; i++) {
      if (level.speedZones[i].x <= worldX) s = level.speedZones[i].speed;
    }
    return s;
  }

  var state, player, particles, speed, elapsedMs, lastTime;
  var coinsCollected, hasKey, hasDiamond, deaths;

  function selectLevel(index) {
    currentLevelIndex = index;
    var levelId = currentLevelId();
    best = parseInt(localStorage.getItem(bestKeyFor(levelId)) || '0', 10) || 0;
    resetGame();
    loadLeaderboard();
  }

  function resetGame() {
    var levelId = currentLevelId();
    level = LEVELS[currentLevelIndex].build();
    var diamondClaimed = localStorage.getItem(diamondClaimedKeyFor(levelId)) === '1';
    if (diamondClaimed) {
      level.objects = level.objects.filter(function (o) { return o.type !== 'diamond'; });
    }
    level.switches = {};
    best = parseInt(localStorage.getItem(bestKeyFor(levelId)) || '0', 10) || 0;
    if (bestEl) bestEl.textContent = 'Best: ' + best + '%';
    player = {
      x: PLAYER_SCREEN_X, y: FLOOR_Y - PLAYER_SIZE, vy: 0,
      gravityDir: 1, worldX: 0, form: LEVELS[currentLevelIndex].startForm || 'cube', grounded: true,
      holding: false
    };
    particles = [];
    speed = speedAt(0);
    elapsedMs = 0;
    lastTime = null;
    coinsCollected = [];
    hasKey = false;
    hasDiamond = false;
    state = 'ready';
    scoreEl.textContent = 'Progress: 0%';
    coinsEl.textContent = '🪙 0/3';
    keyEl.textContent = '';
    overlayText.textContent = LEVELS[currentLevelIndex].name + ' — Tap or press Space to start';
    if (!homeMenuActive) overlay.classList.remove('hidden'); else overlay.classList.add('hidden');
  }

  function toScreenX(worldX) { return worldX - player.worldX + PLAYER_SCREEN_X; }

  function startGame() {
    state = 'playing';
    overlay.classList.add('hidden');
  }

  function press() {
    if (state === 'ready') { startGame(); return; }
    if (state === 'gameover' || state === 'win') { resetGame(); return; }
    if (state !== 'playing') return;
    player.holding = true;

    if (player.form === 'cube') {
      if (player.grounded) {
        player.vy = -CUBE_JUMP_V * player.gravityDir;
        player.grounded = false;
        playJump();
        spawnParticles(player.x + PLAYER_SIZE / 2, player.y + (player.gravityDir === 1 ? PLAYER_SIZE : 0), '#3D8BFF', 8);
      }
    } else if (player.form === 'ball') {
      player.gravityDir *= -1;
      player.vy = BALL_FLIP_KICK * player.gravityDir;
      playJump();
      spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#FF3DAE', 8);
    }
    // Nave: el empuje se maneja continuo en update() mientras holding=true.
  }
  function release() { player.holding = false; }

  function endGame() {
    if (state !== 'playing') return;
    state = 'gameover';
    playCrash();
    finishRun(Math.round((player.worldX / level.length) * 100));
    spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#FF3D57', 22);
  }

  function winGame() {
    if (state !== 'playing') return;
    state = 'win';
    playWin();
    spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#FFC93D', 30);
    finishRun(100);
  }

  function finishRun(pct) {
    pct = Math.max(0, Math.min(100, pct));
    var levelId = currentLevelId();
    var won = state === 'win';
    var coinCount = coinsCollected.length;

    if (won) {
      // Las monedas de la corrida se acreditan siempre que se complete
      // el nivel (se pueden volver a ganar repitiendo). El diamante,
      // en cambio, solo se acredita la primera vez que se lo trae
      // hasta la meta -- después queda marcado y no vuelve a aparecer.
      coinsWallet += coinCount;
      localStorage.setItem(COINS_WALLET_KEY, String(coinsWallet));
      // Las estrellas del nivel reflejan la MEJOR corrida (0-3 monedas
      // secretas encontradas esa vez que se completó), no se pueden bajar.
      if (coinCount > starsFor(levelId)) localStorage.setItem(starsKeyFor(levelId), String(coinCount));
      if (hasDiamond && localStorage.getItem(diamondClaimedKeyFor(levelId)) !== '1') {
        diamondsWallet += 1;
        localStorage.setItem(DIAMONDS_WALLET_KEY, String(diamondsWallet));
        localStorage.setItem(diamondClaimedKeyFor(levelId), '1');
      }
      updateWalletHud();
      if (typeof renderHomeMenu === 'function') renderHomeMenu();

      var idx = -1;
      for (var li = 0; li < LEVELS.length; li++) { if (LEVELS[li].id === levelId) { idx = li; break; } }
      var nextLevel = LEVELS[idx + 1];
      if (nextLevel && unlockedLevels.indexOf(nextLevel.id) === -1) {
        unlockedLevels.push(nextLevel.id);
        writeJSON(PROGRESS_KEY, unlockedLevels);
      }
    }

    coinsEl.textContent = '🪙 ' + coinCount + '/3';
    if (pct > best) {
      best = pct;
      localStorage.setItem(bestKeyFor(levelId), String(best));
      if (bestEl) bestEl.textContent = 'Best: ' + best + '%';
      submitScore(best);
    }
    var label = won ? 'Level complete! 100%' : ('Reached ' + pct + '% — tap to retry');
    overlayText.textContent = label + (hasKey ? ' 🔑' : '') + ' — 🪙 ' + coinCount + '/3';

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

  /* ---- Colisión con superficies (piso/techo), con huecos de
     plataformas flotantes tratadas aparte ---- */
  function movingOffset(o) {
    // Desplazamiento sinusoidal calculado siempre a partir de elapsedMs
    // (nunca de Math.random) para que sea determinístico y previsible,
    // tanto para un jugador real como para el bot de verificación.
    if (!o.moving) return 0;
    return Math.sin((elapsedMs + (o.phase || 0)) / o.periodMs * Math.PI * 2) * o.amp;
  }
  function surfaceYFor(o) {
    var lift = (o.lift || 0) + movingOffset(o);
    if (o.surface === 'floor') return FLOOR_Y - lift;
    return CEIL_Y + lift;
  }

  function overlapsX(o, w, playerCenterWorldX) {
    // El margen de tolerancia se limita a un máximo fijo -- si escalara
    // con el ancho del objeto, un grupo de varios pinchos pegados (o una
    // puerta ancha) infla su "zona de peligro" mucho más allá de lo
    // visual y puede volver imposible la ventana de salto válida.
    var half = Math.min((w || 28) / 2, 8);
    return playerCenterWorldX > o.x - half && playerCenterWorldX < o.x + (w || 28) + half;
  }

  /* ---- Update ---- */
  function update(dt) {
    if (state !== 'playing') { updateParticles(dt); return; }

    speed = speedAt(player.worldX);

    if (player.form === 'cube' || player.form === 'ball') {
      var g = player.form === 'cube' ? CUBE_GRAVITY : BALL_GRAVITY;
      var maxVy = player.form === 'cube' ? CUBE_MAX_VY : BALL_MAX_VY;
      player.vy += g * player.gravityDir * dt;
      if (player.vy > maxVy) player.vy = maxVy;
      if (player.vy < -maxVy) player.vy = -maxVy;
      player.y += player.vy * dt;
    } else if (player.form === 'ship') {
      player.vy += (player.holding ? -SHIP_THRUST : SHIP_FALL) * dt;
      if (player.vy > SHIP_MAX_VY) player.vy = SHIP_MAX_VY;
      if (player.vy < -SHIP_MAX_VY) player.vy = -SHIP_MAX_VY;
      player.y += player.vy * dt;
    }

    // Piso/techo del nivel (sólidos salvo que una plataforma decida lo
    // contrario más abajo) — solo aplica a cubo/bola, la nave vuela libre.
    if (player.form !== 'ship') {
      if (player.y >= FLOOR_Y - PLAYER_SIZE) {
        player.y = FLOOR_Y - PLAYER_SIZE;
        player.vy = 0;
        player.grounded = player.gravityDir === 1;
      }
      if (player.y <= CEIL_Y) {
        player.y = CEIL_Y;
        player.vy = 0;
        player.grounded = player.gravityDir === -1;
      }
    } else if (player.y > FLOOR_Y - PLAYER_SIZE || player.y < CEIL_Y) {
      endGame(); return; // la nave muere si toca piso/techo
    }

    player.worldX += speed * dt;
    player.x = PLAYER_SCREEN_X;
    // Se calcula DESPUÉS de avanzar worldX este frame — si no, todas las
    // colisiones de más abajo comparan contra la posición del frame
    // anterior (un desfase de unos pixeles que alcanza para arruinar un
    // salto justo en el límite).
    var centerWorldX = player.worldX + PLAYER_SIZE / 2;

    // Plataformas flotantes: sólidas por arriba (aterrizar) y por abajo
    // (cabezazo) solo para cubo/bola.
    if (player.form !== 'ship') {
      level.objects.forEach(function (o) {
        if (o.type !== 'platform') return;
        if (!overlapsX(o, o.w, centerWorldX)) return;
        var platformH = 14 * (o.scale || 1);
        var topY = surfaceYFor(o) - (o.surface === 'floor' ? 0 : 0);
        var platformTop = o.surface === 'floor' ? topY - platformH : topY;
        var platformBottom = o.surface === 'floor' ? topY : topY + platformH;
        if (o.surface === 'floor' && player.gravityDir === 1) {
          if (player.y + PLAYER_SIZE >= platformTop && player.y + PLAYER_SIZE <= platformTop + 26 && player.vy >= 0) {
            if (o.lethal) { endGame(); return; }
            player.y = platformTop - PLAYER_SIZE; player.vy = 0; player.grounded = true;
          }
        } else if (o.surface === 'ceil' && player.gravityDir === -1) {
          if (player.y <= platformBottom && player.y >= platformBottom - 26 && player.vy <= 0) {
            if (o.lethal) { endGame(); return; }
            player.y = platformBottom; player.vy = 0; player.grounded = true;
          }
        }
      });
    }

    // Puerta abierta con llave: se vuelve atravesable.
    level.objects.forEach(function (o) {
      if (o.type === 'door' && hasKey) o.open = true;
    });

    if (player.y > FLOOR_Y + 120 || player.y < CEIL_Y - 120) { endGame(); return; }

    // Interacciones con entidades del nivel.
    for (var i = 0; i < level.objects.length; i++) {
      var o = level.objects[i];
      if (o.dead) continue;

      if (o.type === 'spike') {
        var spikeLift = o.lift || 0;
        var spikeScale = o.scale || 1;
        var spikeHalf = 18 * spikeScale;
        var spikeY = o.surface === 'floor' ? FLOOR_Y - spikeLift : CEIL_Y + spikeLift;
        var near = o.surface === 'floor' ? player.y + PLAYER_SIZE > spikeY - spikeHalf && player.y + PLAYER_SIZE < spikeY + spikeHalf : player.y < spikeY + spikeHalf && player.y > spikeY - spikeHalf;
        if (near && overlapsX(o, o.w, centerWorldX)) { endGame(); return; }
      } else if (o.type === 'saw') {
        if (o.linkId && level.switches[o.linkId]) continue; // desactivada por interruptor
        var sawLift = o.lift || 0;
        var sawR = 22 * (o.scale || 1);
        var sawCY = o.surface === 'floor' ? FLOOR_Y - sawR - sawLift : CEIL_Y + sawR + sawLift;
        var dx = centerWorldX - o.x;
        var dy = (player.y + PLAYER_SIZE / 2) - sawCY;
        if (Math.sqrt(dx * dx + dy * dy) < sawR + PLAYER_SIZE * 0.3) { endGame(); return; }
      } else if (o.type === 'interruptor') {
        // Se activa automático al tocarlo, como un jump pad -- nunca es
        // obligatorio: si no se toca, el obstáculo enlazado sigue activo
        // y se esquiva saltando como cualquier otro, así que jamás puede
        // dejar el nivel imposible (misma regla que la puerta).
        if (!o.used && overlapsX(o, 30, centerWorldX)) {
          o.used = true;
          level.switches[o.linkId] = true;
          playPad();
          spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#7CF6FF', 12);
        }
      } else if (o.type === 'diamond') {
        var diamondScale = o.scale || 1;
        if (!hasDiamond && overlapsX(o, 24 * diamondScale, centerWorldX) && Math.abs((player.y + PLAYER_SIZE / 2) - o.y) < 26 * diamondScale) {
          hasDiamond = true;
          o.dead = true;
          playPickup();
          spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#7CF6FF', 14);
        }
      } else if (o.type === 'gravityPortal') {
        var gpTrigger = 30 * (o.scale || 1);
        if (!o.used && overlapsX(o, gpTrigger, centerWorldX)) {
          o.used = true;
          player.gravityDir = o.dir;
          player.vy = 0;
          playPortal();
        } else if (o.used && !overlapsX(o, gpTrigger, centerWorldX)) {
          o.used = false; // re-armar cuando el jugador ya pasó, por si reinicia y vuelve a cruzar (no aplica en un nivel lineal, pero evita dobles disparos raros)
        }
      } else if (o.type === 'shapePortal') {
        if (!o.used && overlapsX(o, 30 * (o.scale || 1), centerWorldX)) {
          o.used = true;
          player.form = o.form;
          if (o.form !== 'ship') {
            player.grounded = false;
          } else {
            // Si se entra a modo nave estando apoyado justo en el piso
            // (o el techo), el chequeo de límites de la nave puede
            // matar en el frame siguiente antes de que el jugador
            // llegue a reaccionar -- se separa un margen mínimo de
            // los bordes al entrar para darle un instante de aire.
            player.y = Math.max(CEIL_Y + 10, Math.min(FLOOR_Y - PLAYER_SIZE - 10, player.y));
          }
          playPortal();
        }
      } else if (o.type === 'orb') {
        var orbScale = o.scale || 1;
        var orbNear = Math.abs(centerWorldX - o.x) < 26 * orbScale && Math.abs((player.y + PLAYER_SIZE / 2) - o.y) < 30 * orbScale;
        o.playerNear = orbNear;
      } else if (o.type === 'pad') {
        if (!o.used && overlapsX(o, 40, centerWorldX)) {
          var padLift = o.lift || 0;
          var padHalf = 24 * (o.scale || 1);
          var padSurfaceY = o.surface === 'floor' ? FLOOR_Y - padLift : CEIL_Y + padLift;
          var padNear = o.surface === 'floor' ? player.y + PLAYER_SIZE > padSurfaceY - padHalf && player.y + PLAYER_SIZE < padSurfaceY + padHalf : player.y < padSurfaceY + padHalf && player.y > padSurfaceY - padHalf;
          if (padNear) {
            o.used = true;
            var padV = o.color === 'yellow' ? ORB_YELLOW_V : o.color === 'pink' ? ORB_PINK_V : 0.62;
            player.vy = -padV * player.gravityDir;
            player.grounded = false;
            playPad();
            spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#7CF6FF', 10);
          }
        }
      } else if (o.type === 'key') {
        var keyScale = o.scale || 1;
        if (!hasKey && overlapsX(o, 26 * keyScale, centerWorldX) && Math.abs((player.y + PLAYER_SIZE / 2) - o.y) < 28 * keyScale) {
          hasKey = true;
          o.dead = true;
          keyEl.textContent = '🔑';
          playPickup();
        }
      } else if (o.type === 'door') {
        // El mundo se desplaza en una sola dirección (no se puede
        // esperar ni retroceder), así que una puerta que realmente
        // bloquee el paso solo es justa si la llave es imposible de
        // perderse — y si lo es, bloquear no suma nada. Por eso la
        // puerta es un premio visual/narrativo (se ve abierta con
        // llave) y nunca mata, evitando una muerte injusta garantizada
        // si alguien llega sin la llave.
      } else if (o.type === 'coin') {
        var coinScale = o.scale || 1;
        if (coinsCollected.indexOf(o.id) === -1 && overlapsX(o, 24 * coinScale, centerWorldX) && Math.abs((player.y + PLAYER_SIZE / 2) - o.y) < 26 * coinScale) {
          coinsCollected.push(o.id);
          o.dead = true;
          coinsEl.textContent = '🪙 ' + coinsCollected.length + '/3';
          playPickup();
          spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#FFC93D', 12);
        }
      } else if (o.type === 'finish') {
        if (overlapsX(o, 20, centerWorldX)) { winGame(); return; }
      }
    }

    updateParticles(dt);
    var pct = Math.min(100, Math.round((player.worldX / level.length) * 100));
    scoreEl.textContent = 'Progress: ' + pct + '%';
  }

  function activeOrbTap() {
    for (var i = 0; i < level.objects.length; i++) {
      var o = level.objects[i];
      if (o.type === 'orb' && o.playerNear && !o.dead) {
        if (o.color === 'yellow') player.vy = -ORB_YELLOW_V * player.gravityDir;
        else if (o.color === 'pink') player.vy = -ORB_PINK_V * player.gravityDir;
        else if (o.color === 'green') player.gravityDir *= -1;
        player.grounded = false;
        playPad();
        spawnParticles(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2, '#7CFFB2', 10);
        return true;
      }
    }
    return false;
  }

  /* ---- Draw ---- */
  function drawBackground() {
    ctx.fillStyle = '#05060f';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.strokeStyle = 'rgba(120,90,255,.14)';
    ctx.lineWidth = 1;
    var off = (player.worldX * 0.3) % 40;
    for (var gx = -off; gx < W; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (var gy = 0; gy < H; gy += 40) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#120a24';
    ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
    ctx.fillRect(0, 0, W, CEIL_Y);
    ctx.save();
    ctx.shadowColor = '#B983FF'; ctx.shadowBlur = 8;
    ctx.fillStyle = '#B983FF';
    ctx.fillRect(0, FLOOR_Y, W, 2);
    ctx.fillRect(0, CEIL_Y - 2, W, 2);
    ctx.restore();

    // Piso y techo se eligen por separado (mismo pool de bloques,
    // cada uno con su propia variante opcional) -- si no se eligió
    // ninguno para un lado, ese lado sigue tileando el sprite 'floor'
    // por defecto como siempre.
    var floorColor = level && level.floorVariant ? floorVariantColor(level.floorVariant) : null;
    if (floorColor) {
      // Los "bloques" que subió el usuario son íconos individuales, no
      // una textura pensada para repetirse sin costura -- en vez de
      // tilearlos (que se ve con separaciones), se pinta una franja
      // continua del color representativo de ese bloque.
      ctx.fillStyle = floorColor;
      ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
    } else {
      var tileW = 110, floorOff = player.worldX % tileW;
      for (var fx = -floorOff; fx < W; fx += tileW) drawSprite('floor', fx, FLOOR_Y, tileW, H - FLOOR_Y);
    }
    var ceilColor = level && level.ceilVariant ? floorVariantColor(level.ceilVariant) : null;
    if (ceilColor) {
      ctx.fillStyle = ceilColor;
      ctx.fillRect(0, 0, W, CEIL_Y);
    } else {
      var tileW2 = 110, ceilOff = player.worldX % tileW2;
      for (var cx = -ceilOff; cx < W; cx += tileW2) {
        ctx.save();
        ctx.translate(cx + tileW2 / 2, CEIL_Y);
        ctx.rotate(Math.PI);
        drawSprite('floor', -tileW2 / 2, -CEIL_Y, tileW2, CEIL_Y);
        ctx.restore();
      }
    }
  }

  function draw() {
    drawBackground();

    level.objects.forEach(function (o) {
      var sx = toScreenX(o.x);
      if (sx < -160 || sx > W + 160) return;

      if (o.type === 'spike') {
        // Se voltea 180° automático al estar en el techo (para que
        // apunte hacia el jugador en vez de "flotar" con la base para
        // arriba), y encima se le puede sumar una rotación manual
        // (o.rotation, en grados) para acomodar sprites propios que no
        // vengan ya orientados "para arriba" por defecto.
        var spikeSprite = o.variant ? 'spike_' + o.variant : 'spike';
        var spikeBaseRot = o.surface === 'ceil' ? Math.PI : 0;
        var spikeExtraRot = (o.rotation || 0) * Math.PI / 180;
        var spikeLiftDraw = o.lift || 0;
        var spikeDrawScale = o.scale || 1;
        var spikeCY = o.surface === 'ceil' ? CEIL_Y + 15 + spikeLiftDraw : FLOOR_Y - 15 - spikeLiftDraw;
        ctx.save();
        ctx.translate(sx + 14, spikeCY);
        ctx.rotate(spikeBaseRot + spikeExtraRot);
        drawSprite(spikeSprite, -20 * spikeDrawScale, -15 * spikeDrawScale, 40 * spikeDrawScale, 30 * spikeDrawScale);
        ctx.restore();
      } else if (o.type === 'saw') {
        var sawSprite = o.variant ? 'saw_' + o.variant : 'saw';
        var sawDisabled = o.linkId && level.switches && level.switches[o.linkId];
        var sawLiftDraw = o.lift || 0;
        var sawR2 = 22 * (o.scale || 1);
        var sawCY = o.surface === 'floor' ? FLOOR_Y - sawR2 - sawLiftDraw : CEIL_Y + sawR2 + sawLiftDraw;
        ctx.save();
        ctx.translate(sx, sawCY);
        if (sawDisabled) ctx.globalAlpha = 0.3; else ctx.rotate(elapsedMs * 0.006);
        drawSprite(sawSprite, -sawR2, -sawR2, sawR2 * 2, sawR2 * 2);
        ctx.restore();
      } else if (o.type === 'interruptor') {
        var swScale = o.scale || 1;
        ctx.save();
        ctx.translate(sx, (FLOOR_Y + CEIL_Y) / 2);
        var swOn = level.switches && level.switches[o.linkId];
        ctx.fillStyle = swOn ? '#7CFFB2' : '#7CF6FF';
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(0, 0, 14 * swScale, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#05060f';
        ctx.beginPath(); ctx.arc(0, 0, 6 * swScale, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else if (o.type === 'diamond' && !o.dead) {
        var diamondDrawScale = o.scale || 1;
        ctx.save();
        ctx.translate(sx, o.y);
        ctx.rotate(Math.sin(elapsedMs * 0.003) * 0.15);
        ctx.scale(diamondDrawScale, diamondDrawScale);
        ctx.fillStyle = '#7CF6FF';
        ctx.shadowColor = '#7CF6FF'; ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(0, -14); ctx.lineTo(11, -2); ctx.lineTo(0, 16); ctx.lineTo(-11, -2);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (o.type === 'platform') {
        var platformDrawH = 14 * (o.scale || 1);
        var py = surfaceYFor(o) - (o.surface === 'floor' ? platformDrawH : 0);
        ctx.save();
        // Las plataformas "letales" se ven con un tinte rojo -- es un
        // peligro real (mata al tocarla), así que tiene que ser visible
        // en vez de una trampa invisible.
        if (o.lethal) { ctx.filter = 'sepia(1) saturate(6) hue-rotate(-40deg) brightness(.9)'; }
        drawSprite(o.variant ? 'platform_' + o.variant : 'platform', sx, py, o.w, platformDrawH);
        ctx.restore();
      } else if (o.type === 'gravityPortal') {
        // Tamaño fijo y centrado en la pantalla -- antes se estiraba
        // para llenar todo el alto entre piso y techo, deformando el
        // sprite. El área donde el portal REALMENTE activa sigue
        // siendo la franja completa (overlapsX de abajo), esto es
        // solo el dibujo.
        var gpDrawScale = o.scale || 1;
        drawSprite(o.variant ? 'portal_' + o.variant : 'portal_gravity', sx - PORTAL_W * gpDrawScale / 2, MID_Y - PORTAL_H * gpDrawScale / 2, PORTAL_W * gpDrawScale, PORTAL_H * gpDrawScale);
      } else if (o.type === 'shapePortal') {
        var spDrawScale = o.scale || 1;
        drawSprite(o.variant ? 'portal_' + o.variant : 'portal_shape', sx - PORTAL_W * spDrawScale / 2, MID_Y - PORTAL_H * spDrawScale / 2, PORTAL_W * spDrawScale, PORTAL_H * spDrawScale);
      } else if (o.type === 'orb') {
        var sy = o.y;
        var orbDrawScale = o.scale || 1;
        var orbSz = 32 * orbDrawScale;
        ctx.save();
        if (o.playerNear) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 14; }
        drawSprite('orb_' + o.color, sx - orbSz / 2, sy - orbSz / 2, orbSz, orbSz);
        ctx.restore();
      } else if (o.type === 'pad') {
        var padLiftDraw = o.lift || 0;
        var padDrawScale = o.scale || 1;
        var padW = 40 * padDrawScale, padH = 16 * padDrawScale;
        var padY = o.surface === 'floor' ? FLOOR_Y - padH - padLiftDraw : CEIL_Y + padLiftDraw;
        ctx.save();
        if (o.surface === 'ceil') { ctx.translate(sx, padY + padH); ctx.rotate(Math.PI); drawSprite('pad_' + o.color, -padW / 2, -padH, padW, padH); }
        else { drawSprite('pad_' + o.color, sx - padW / 2, padY, padW, padH); }
        ctx.restore();
      } else if (o.type === 'key' && !o.dead) {
        var keyDrawScale = o.scale || 1;
        var keySz = 30 * keyDrawScale;
        drawSprite('key', sx - keySz / 2, o.y - keySz / 2, keySz, keySz);
      } else if (o.type === 'door') {
        ctx.save();
        var doorW = o.x2 - o.x;
        if (o.open) ctx.globalAlpha = Math.max(0.15, 1 - (elapsedMs % 1) );
        if (!o.open) drawSprite('door', sx, CEIL_Y, doorW, FLOOR_Y - CEIL_Y);
        ctx.restore();
      } else if (o.type === 'coin' && !o.dead) {
        var coinDrawScale = o.scale || 1;
        ctx.save();
        ctx.translate(sx, o.y);
        ctx.scale(Math.abs(Math.cos(elapsedMs * 0.004)) * coinDrawScale, coinDrawScale);
        ctx.fillStyle = '#FFC93D';
        ctx.shadowColor = '#FFC93D'; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else if (o.type === 'finish') {
        ctx.save();
        ctx.shadowColor = '#7CFFB2'; ctx.shadowBlur = 18;
        ctx.fillStyle = 'rgba(124,255,178,.35)';
        ctx.fillRect(sx - 4, CEIL_Y, 8, FLOOR_Y - CEIL_Y);
        ctx.restore();
      }
    });

    ctx.save();
    if (player.form === 'ship') {
      ctx.translate(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2);
      ctx.rotate(Math.max(-0.4, Math.min(0.4, player.vy * 0.5)));
      ctx.shadowColor = '#3DE0FF'; ctx.shadowBlur = 14;
      drawSkin(-PLAYER_SIZE * 0.7, -PLAYER_SIZE * 0.42, PLAYER_SIZE * 1.4, PLAYER_SIZE * 0.84);
    } else if (player.form === 'ball') {
      ctx.translate(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2);
      ctx.rotate(elapsedMs * 0.006);
      ctx.shadowColor = '#FF3DAE'; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, 0, PLAYER_SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      drawSkin(-PLAYER_SIZE / 2, -PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE);
    } else {
      ctx.translate(player.x, player.y);
      ctx.shadowColor = '#3D8BFF'; ctx.shadowBlur = 14;
      drawSkin(0, 0, PLAYER_SIZE, PLAYER_SIZE);
    }
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

  function handlePressStart(e) {
    if (e) e.preventDefault();
    if (state === 'playing' && player.form !== 'ship') {
      if (!activeOrbTap()) press();
    } else {
      press();
    }
  }
  function handlePressEnd(e) { if (e) e.preventDefault(); release(); }

  canvas.addEventListener('touchstart', handlePressStart, { passive: false });
  canvas.addEventListener('touchend', handlePressEnd, { passive: false });
  canvas.addEventListener('mousedown', function (e) { if (e.button === 0) handlePressStart(e); });
  canvas.addEventListener('mouseup', function (e) { if (e.button === 0) handlePressEnd(e); });
  canvas.addEventListener('mouseleave', function () { release(); });
  overlay.addEventListener('touchstart', handlePressStart, { passive: false });
  overlay.addEventListener('mousedown', function (e) { if (e.button === 0) handlePressStart(e); });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); handlePressStart(e); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); handlePressEnd(e); }
  });

  /* ---- Selección de nivel / skin / menú principal ---- */
  var SKIN_COUNT = 72;
  var LEVEL_ACCENTS = ['#3DE0FF', '#7CFFB2', '#B983FF', '#3D8BFF', '#FFC93D', '#FF7A3D', '#3DE0FF', '#FF3DAE', '#7CFFB2', '#B983FF'];
  var SKIN_NAMES = [
    'Neon Classic', 'Lava Gold', 'Ice Block', 'Toxic Slime', 'Devil', 'Iron Knight', 'Steel Knight', 'Galaxy Core',
    'Galaxy Nova', 'Violet', 'Witch', 'Skull', 'Pirate', 'Pumpkin', 'Creeper', 'Dark Bot',
    'Pink Pop', 'Blob Pink', 'Grassy', 'Ghost', 'Mummy', 'Duck', 'Dark Bot X', 'Crown King',
    'Rainbow', 'Corgi', 'Purple Demon', 'Angel', 'Dark Tech', 'Headphone Bot', 'Panda Mask', 'Ice Crystal',
    'Rainbow Trail', 'Void Fang', 'Shadow Horn', 'Glitch', 'Matrix', 'Panda Prime', 'Pink Crystal', 'Frost King',
    // Pack 2 (subido por el usuario, todo.png)
    'Cobalt', 'Silver Ghost', 'Ember Horn', 'Golden Horn', 'Amethyst', 'Storm Horn', 'Royal Horn', 'Teal Wave',
    'Twilight Horn', 'Frost White', 'Sunfire Horn', 'Sky Horn', 'Jade', 'Inferno Devil', 'Azure Horn', 'Orchid',
    'Lagoon', 'Plum Horn', 'Tangerine', 'Cobalt Deep', 'Emerald', 'Nightshade', 'Amber', 'Grape',
    'Fuchsia Devil', 'Honey', 'Sapphire', 'Lavender', 'Mint', 'Magenta Storm', 'Citrine Devil', 'Indigo'
  ];
  var SKIN_RARITIES = ['basico', 'raro', 'epico', 'legendario', 'especial'];
  var SKIN_RARITY_LABEL = { basico: 'BÁSICO', raro: 'RARO', epico: 'ÉPICO', legendario: 'LEGENDARIO', especial: 'ESPECIAL' };
  function skinRarity(index) { return SKIN_RARITIES[Math.min(4, Math.floor(index / 8))]; }
  function skinPrice(index) {
    // index 0-based; skin_01 (index 0) siempre viene desbloqueado.
    // Las primeras ~29 skins cuestan monedas en escala creciente, las
    // últimas 10 ("premium") cuestan diamantes (1 a 3).
    if (index === 0) return null;
    if (index < 30) return { currency: 'coins', amount: 50 + index * 25 };
    return { currency: 'diamonds', amount: 1 + Math.floor((index - 30) / 4) };
  }
  function skinIdAt(index) { return 'skin_' + (index + 1 < 10 ? '0' + (index + 1) : (index + 1)); }

  function openOverlay(el) { if (el) el.classList.remove('hidden'); }
  function closeOverlay(el) { if (el) el.classList.add('hidden'); }

  var homeMenuActive = true;
  var activeSkinTab = 'collection';
  var activeRarityFilter = 'all';
  var previewedSkinIndex = parseInt(currentSkin.replace('skin_', ''), 10) - 1;

  function renderHomeMenu() {
    if (homeAvatar) homeAvatar.src = '../img/gravitycover/sliced/' + currentSkin + '.png';
    if (homeName) { var n = null; try { n = localStorage.getItem(NAME_KEY); } catch (e) {} homeName.textContent = (n || 'PLAYER').toUpperCase(); }
    var maxStars = LEVELS.length * 3;
    var stars = totalStars();
    if (homeStarsEl) homeStarsEl.textContent = stars + '/' + maxStars;
    if (homeCoinsEl) homeCoinsEl.textContent = String(coinsWallet);
    if (homeDiamondsEl) homeDiamondsEl.textContent = String(diamondsWallet);
    if (homeProgressFill) homeProgressFill.style.width = Math.round((stars / maxStars) * 100) + '%';
    if (homeLvlEl) {
      var levelsStarted = 0;
      for (var i = 0; i < LEVELS.length; i++) { if (starsFor(LEVELS[i].id) > 0) levelsStarted++; }
      homeLvlEl.textContent = 'LVL ' + levelsStarted;
    }
  }

  function goHome() {
    homeMenuActive = true;
    renderHomeMenu();
    closeOverlay(overlay);
    openOverlay(homeMenu);
    if (dashWrap) dashWrap.classList.add('gravity-home-active');
  }

  function renderLevelGrid() {
    if (!levelGrid) return;
    if (levelStarsChip) levelStarsChip.textContent = '⭐ ' + totalStars() + '/' + (LEVELS.length * 3);
    levelGrid.innerHTML = LEVELS.map(function (lvl, i) {
      var unlocked = unlockedLevels.indexOf(lvl.id) !== -1;
      var current = i === currentLevelIndex;
      var stars = starsFor(lvl.id);
      var starsRow = '';
      for (var s = 0; s < 3; s++) starsRow += '<span class="' + (s < stars ? 'on' : 'off') + '">★</span>';
      var accent = LEVEL_ACCENTS[i % LEVEL_ACCENTS.length];
      return '<div class="gravity-card' + (current ? ' selected' : '') + (unlocked ? '' : ' locked') +
        '" data-index="' + i + '" data-unlocked="' + (unlocked ? '1' : '0') + '" style="border-color:' + (unlocked ? accent : '') + '">' +
        '<div class="gravity-level-num">' + (i + 1) + '</div>' +
        '<img src="../img/gravitycover/sliced/' + lvl.thumb + '.jpg" alt="' + escapeHtml(lvl.name) + '" loading="lazy">' +
        (unlocked ? '' : '<div class="gravity-card-lock">🔒</div>') +
        '<div class="gravity-card-label">' + escapeHtml(lvl.name) + '</div>' +
        '<div class="gravity-level-stars">' + starsRow + '</div>' +
        '<div class="gravity-level-meta"><span>🪙 ' + stars + '/3</span><span class="has-key">🔑</span></div>' +
        '</div>';
    }).join('');
  }

  function updateSkinPreview() {
    if (!skinPreviewImg) return;
    var id = skinIdAt(previewedSkinIndex);
    var owned = unlockedSkins.indexOf(id) !== -1;
    var isActive = id === currentSkin;
    skinPreviewImg.src = '../img/gravitycover/sliced/' + id + '.png';
    if (skinPreviewName) skinPreviewName.textContent = (SKIN_NAMES[previewedSkinIndex] || id).toUpperCase();
    if (skinPreviewRarity) skinPreviewRarity.textContent = SKIN_RARITY_LABEL[skinRarity(previewedSkinIndex)];
    if (skinEquipBtn) {
      if (isActive) { skinEquipBtn.textContent = '✔ EQUIPADO'; skinEquipBtn.className = 'gravity-equip-btn equipped'; }
      else if (owned) { skinEquipBtn.textContent = 'EQUIPAR'; skinEquipBtn.className = 'gravity-equip-btn'; }
      else { skinEquipBtn.textContent = '🔒 BLOQUEADO'; skinEquipBtn.className = 'gravity-equip-btn locked'; }
    }
  }

  function renderSkinGrid() {
    if (!skinGrid) return;
    if (skinWalletLine) skinWalletLine.textContent = '🪙 ' + coinsWallet + ' 💎 ' + diamondsWallet;
    if (skinTabCollection) skinTabCollection.classList.toggle('active', activeSkinTab === 'collection');
    if (skinTabShop) skinTabShop.classList.toggle('active', activeSkinTab === 'shop');
    var rows = [];
    for (var i = 0; i < SKIN_COUNT; i++) {
      var rarity = skinRarity(i);
      if (activeRarityFilter !== 'all' && rarity !== activeRarityFilter) continue;
      var id = skinIdAt(i);
      var owned = unlockedSkins.indexOf(id) !== -1;
      if (activeSkinTab === 'shop' && owned) continue; // la tienda solo muestra lo que falta comprar
      var current = id === currentSkin;
      var price = skinPrice(i);
      var priceLabel = !price ? '' : (price.currency === 'coins' ? '🪙 ' + price.amount : '💎 ' + price.amount);
      rows.push('<div class="gravity-card' + (current ? ' selected' : '') + (owned ? '' : ' locked') +
        '" data-index="' + i + '">' +
        '<img src="../img/gravitycover/sliced/' + id + '.png" alt="' + id + '" loading="lazy">' +
        (owned ? '' : '<div class="gravity-card-lock">🔒<span class="gravity-card-price">' + priceLabel + '</span></div>') +
        '</div>');
    }
    skinGrid.innerHTML = rows.length ? rows.join('') :
      '<p style="grid-column:1/-1;text-align:center;color:var(--gv-muted);font-size:12.5px;padding:20px 0;">Nada por acá — probá otra categoría.</p>';
  }

  function openSkinScreen(tab) {
    activeSkinTab = tab || 'collection';
    activeRarityFilter = 'all';
    previewedSkinIndex = parseInt(currentSkin.replace('skin_', ''), 10) - 1;
    if (skinRarities) skinRarities.querySelectorAll('.gravity-rarity-tab').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-rarity') === 'all'); });
    updateSkinPreview();
    renderSkinGrid();
    openOverlay(skinSelect);
  }

  /* -- Menú principal -- */
  function leaveHomeVisual() { closeOverlay(homeMenu); if (dashWrap) dashWrap.classList.remove('gravity-home-active'); }

  if (homeBtn) homeBtn.addEventListener('click', goHome);
  if (homeLevelsBtn) homeLevelsBtn.addEventListener('click', function () { leaveHomeVisual(); renderLevelGrid(); openOverlay(levelSelect); });
  if (homeSkinsBtn) homeSkinsBtn.addEventListener('click', function () { leaveHomeVisual(); openSkinScreen('collection'); });
  if (homePlayBtn) homePlayBtn.addEventListener('click', function () {
    homeMenuActive = false;
    leaveHomeVisual();
    if (state === 'ready') overlay.classList.remove('hidden');
  });

  if (dashWrap) dashWrap.classList.add('gravity-home-active'); // visible por defecto al cargar

  if (homeTrophyBtn) {
    homeTrophyBtn.addEventListener('click', function () {
      var lb = document.querySelector('.dash-leaderboard');
      if (lb && lb.scrollIntoView) lb.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  if (homeMuteBtn) {
    homeMuteBtn.addEventListener('click', function () {
      muted = !muted;
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      var icon = muted ? '🔇' : '🔊';
      muteBtn.textContent = icon;
      homeMuteBtn.textContent = icon;
    });
    homeMuteBtn.textContent = muted ? '🔇' : '🔊';
  }

  /* -- Seleccionar nivel -- */
  if (levelBtn) levelBtn.addEventListener('click', function () { renderLevelGrid(); openOverlay(levelSelect); });
  if (levelSelectClose) levelSelectClose.addEventListener('click', function () { closeOverlay(levelSelect); if (homeMenuActive) goHome(); });
  if (levelGrid) {
    levelGrid.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.gravity-card') : null;
      if (!card || card.getAttribute('data-unlocked') !== '1') return;
      var idx = parseInt(card.getAttribute('data-index'), 10);
      if (isNaN(idx)) return;
      selectLevel(idx);
      homeMenuActive = false;
      if (dashWrap) dashWrap.classList.remove('gravity-home-active');
      closeOverlay(levelSelect);
      overlay.classList.remove('hidden');
    });
  }

  /* -- Seleccionar skin / Tienda -- */
  if (skinBtn) skinBtn.addEventListener('click', function () { openSkinScreen('collection'); });
  if (skinSelectClose) skinSelectClose.addEventListener('click', function () { closeOverlay(skinSelect); if (homeMenuActive) goHome(); });
  if (skinTabCollection) skinTabCollection.addEventListener('click', function () { activeSkinTab = 'collection'; renderSkinGrid(); });
  if (skinTabShop) skinTabShop.addEventListener('click', function () { activeSkinTab = 'shop'; renderSkinGrid(); });
  if (skinRarities) {
    skinRarities.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.gravity-rarity-tab') : null;
      if (!btn) return;
      activeRarityFilter = btn.getAttribute('data-rarity');
      skinRarities.querySelectorAll('.gravity-rarity-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
      renderSkinGrid();
    });
  }
  function buySkin(idx) {
    var id = skinIdAt(idx);
    var price = skinPrice(idx);
    if (!price) return false;
    var wallet = price.currency === 'coins' ? coinsWallet : diamondsWallet;
    if (wallet < price.amount) return false; // no alcanza, no se compra
    if (price.currency === 'coins') {
      coinsWallet -= price.amount;
      localStorage.setItem(COINS_WALLET_KEY, String(coinsWallet));
    } else {
      diamondsWallet -= price.amount;
      localStorage.setItem(DIAMONDS_WALLET_KEY, String(diamondsWallet));
    }
    updateWalletHud();
    unlockedSkins.push(id);
    writeJSON(UNLOCKED_SKINS_KEY, unlockedSkins);
    return true;
  }
  if (skinGrid) {
    skinGrid.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.gravity-card') : null;
      if (!card) return;
      var idx = parseInt(card.getAttribute('data-index'), 10);
      if (isNaN(idx)) return;
      var id = skinIdAt(idx);
      var owned = unlockedSkins.indexOf(id) !== -1;
      if (activeSkinTab === 'shop') {
        if (owned) return;
        if (!buySkin(idx)) return;
        setActiveSkin(id);
      } else if (owned) {
        setActiveSkin(id);
      }
      previewedSkinIndex = idx;
      updateSkinPreview();
      renderSkinGrid();
      renderHomeMenu();
    });
  }
  if (skinEquipBtn) {
    skinEquipBtn.addEventListener('click', function () {
      var id = skinIdAt(previewedSkinIndex);
      if (unlockedSkins.indexOf(id) === -1) return;
      setActiveSkin(id);
      updateSkinPreview();
      renderSkinGrid();
      renderHomeMenu();
    });
  }

  /* ---- Modo vista previa (solo para el editor de niveles del admin) ----
     Con ?preview=level_XX en la URL, en vez de jugar el nivel guardado
     de verdad, pide el borrador sin guardar (/api/gravity-level/draft)
     y arranca directo ahí -- así el editor puede mostrar el juego REAL
     renderizando los cambios en el momento, sin tener que reimplementar
     el dibujo del juego dos veces. */
  var previewLevelId = null;
  try { previewLevelId = new URLSearchParams(window.location.search).get('preview'); } catch (e) {}

  function startGameLoop() {
    requestAnimationFrame(loop);
    loadLeaderboard();
  }

  if (previewLevelId) {
    fetch('/api/gravity-level/draft?id=' + encodeURIComponent(previewLevelId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (draft) {
        if (draft) {
          var idx = -1;
          for (var i = 0; i < LEVELS.length; i++) { if (LEVELS[i].id === previewLevelId) { idx = i; break; } }
          var patchedBuild = function () {
            return { objects: draft.objects, length: draft.length, speedZones: draft.speedZones, floorVariant: draft.floorVariant, ceilVariant: draft.ceilVariant };
          };
          if (idx !== -1) { LEVELS[idx].build = patchedBuild; currentLevelIndex = idx; }
          else { LEVELS.push({ id: previewLevelId, name: 'Vista previa', build: patchedBuild, thumb: previewLevelId }); currentLevelIndex = LEVELS.length - 1; }
        }
        homeMenuActive = false;
        if (dashWrap) dashWrap.classList.remove('gravity-home-active');
        closeOverlay(homeMenu);
        resetGame();
        overlay.classList.remove('hidden');
        startGameLoop();
      })
      .catch(function () { resetGame(); renderHomeMenu(); startGameLoop(); });
  } else {
    resetGame();
    renderHomeMenu();
    startGameLoop();
  }
})();
