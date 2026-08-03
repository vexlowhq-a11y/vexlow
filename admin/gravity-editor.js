/*
  Backend del editor visual de niveles de Gravity Flip (admin panel).
  =====================================================================
  Carga los niveles evaluando js/gravity.js dentro de un sandbox jsdom
  (igual que el arnés de pruebas usado para verificar los 10 niveles),
  permite correr el mismo bot reactivo contra una versión editada de un
  nivel (sin tocar el archivo) para chequear que siga siendo pasable, y
  guarda los cambios regenerando el código fuente de esa función
  build...() puntual entre marcadores `@gravity-editor:start/end`.

  No requiere que el nivel elegido para editar tenga los marcadores
  perfectos a mano -- se insertaron una vez (ver scratchpad de esa
  sesión) alrededor de las 10 funciones build... existentes.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const GRAVITY_JS_PATH = path.join(__dirname, '..', 'js', 'gravity.js');

const PLAYER_SCREEN_X = 160;
const PLAYER_SIZE = 32;
const FLOOR_Y = 320, CEIL_Y = 40;

function readSrc() { return fs.readFileSync(GRAVITY_JS_PATH, 'utf8'); }

function makeFakeCtx() {
  return {
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, clip() {},
    fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    arc() {}, fill() {}, stroke() {}, drawImage() {}, fillText() {}, closePath() {},
    createLinearGradient() { return { addColorStop() {} }; },
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, set shadowColor(v) {}, set shadowBlur(v) {},
    set globalAlpha(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    set lineWidth(v) {}, set globalCompositeOperation(v) {}, set imageSmoothingEnabled(v) {}
  };
}

const SANDBOX_HTML = `<!DOCTYPE html><html><body>
<canvas id="gravityCanvas" width="800" height="360"></canvas>
<span id="gravityScore"></span><span id="gravityBest"></span>
<span id="gravityCoins"></span><span id="gravityKey"></span>
<span id="gravityWallet"></span>
<button id="gravityHomeBtn"></button><button id="gravityLevelBtn"></button><button id="gravitySkinBtn"></button>
<button id="gravityMute"></button>
<div id="gravityOverlay" class="hidden"><p id="gravityOverlayText"></p></div>
<div id="gravityHomeMenu" class="hidden">
  <img id="gravityHomeAvatar"><strong id="gravityHomeName"></strong>
  <span id="gravityHomeStars"></span><span id="gravityHomeCoins"></span><span id="gravityHomeDiamonds"></span>
  <div id="gravityHomeProgressFill"></div><span id="gravityHomeLvl"></span>
  <button id="gravityHomeTrophyBtn"></button><button id="gravityHomeMuteBtn"></button>
  <button id="gravityHomeLevelsBtn"></button><button id="gravityHomePlayBtn"></button><button id="gravityHomeSkinsBtn"></button>
</div>
<div id="gravityNameModal" class="hidden"><input id="gravityNameInput"><button id="gravityNameSave"></button><button id="gravityNameSkip"></button></div>
<div id="gravityAdBreak" class="hidden"><button id="gravityAdBreakContinue"></button></div>
<ol id="gravityLeaderboardList"></ol><p id="gravityYouRank"></p>
<div id="gravityLevelSelect" class="hidden"><div id="gravityLevelGrid"></div><span id="gravityLevelStarsChip"></span><button id="gravityLevelSelectClose"></button></div>
<div id="gravitySkinSelect" class="hidden"><p id="gravitySkinWalletLine"></p><div id="gravitySkinGrid"></div><button id="gravitySkinSelectClose"></button>
  <button id="gravitySkinTabCollection"></button><button id="gravitySkinTabShop"></button><div id="gravitySkinRarities"></div>
  <div id="gravitySkinPreviewPanel"><img id="gravitySkinPreviewImg"><strong id="gravitySkinPreviewName"></strong><span id="gravitySkinPreviewRarity"></span><button id="gravitySkinEquipBtn"></button></div>
</div>
</body></html>`;

// Inyecta un export minimo dentro del cierre del IIFE, sin tocar el
// archivo real -- el sandbox recibe una copia parcheada solo en
// memoria para poder leer/forzar el estado interno del juego.
function patchForExport(src) {
  const marker = '})();';
  const lastIdx = src.lastIndexOf(marker);
  if (lastIdx === -1) throw new Error('No se encontró el cierre del módulo en gravity.js');
  const exportLine = '\n  window.__adminExport = {\n' +
    '    LEVELS: LEVELS,\n' +
    '    selectLevel: selectLevel,\n' +
    '    press: press,\n' +
    '    getState: function () { return { state: state, player: player, level: level }; }\n' +
    '  };\n';
  return src.slice(0, lastIdx) + exportLine + src.slice(lastIdx);
}

function loadSandbox(src) {
  const dom = new JSDOM(SANDBOX_HTML, { url: 'http://localhost/play/gravity.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { return makeFakeCtx(); };
  window.__pendingRaf = null;
  window.requestAnimationFrame = function (cb) { window.__pendingRaf = cb; return 1; };
  window.fetch = function () { return Promise.reject(new Error('sin red en el sandbox')); };
  window.Element.prototype.closest = window.Element.prototype.closest || function () { return null; };
  const errors = [];
  window.addEventListener('error', function (e) { errors.push((e.error && e.error.stack) || e.message); });
  dom.window.eval(patchForExport(src));
  if (errors.length) throw new Error('Error cargando gravity.js en el sandbox: ' + errors[0]);
  return { dom, window };
}

function listLevels() {
  const { window } = loadSandbox(readSrc());
  return window.__adminExport.LEVELS.map(function (l) { return { id: l.id, name: l.name, thumb: l.thumb }; });
}

function loadLevel(id) {
  const { window } = loadSandbox(readSrc());
  const LEVELS = window.__adminExport.LEVELS;
  const meta = LEVELS.find(function (l) { return l.id === id; });
  if (!meta) throw new Error('Nivel no encontrado: ' + id);
  const data = meta.build();
  return { id: meta.id, name: meta.name, thumb: meta.thumb, objects: data.objects, length: data.length, speedZones: data.speedZones, floorVariant: data.floorVariant || null, ceilVariant: data.ceilVariant || null, background: data.background || null, backgroundDim: data.backgroundDim != null ? data.backgroundDim : null };
}

/* ---- Sprites / assets del juego -- registro de todos los slots que
   se pueden reemplazar subiendo una imagen propia. Las "variantes"
   (spike_vN, saw_vN, platform_vN, portal_vN, floor_vN, wall_vN) no tienen una
   cantidad fija: se cuentan mirando qué archivos existen de verdad en
   el disco, así que agregar una variante nueva (en vez de solo
   reemplazar una existente) es simplemente guardar el siguiente
   número que falte. ---- */
const SPRITE_KEYS = ['floor', 'platform', 'spike', 'spike_triple', 'saw', 'portal_gravity', 'portal_shape',
  'pad_cyan', 'pad_yellow', 'pad_pink', 'key', 'door', 'lock'];
const VARIANT_BASES = ['spike', 'saw', 'platform', 'portal', 'floor', 'wall'];
const HOME_DECOR_KEYS = ['home_portal', 'home_gear', 'home_platform'];
const LEVEL_THUMB_KEYS = Array.from({ length: 10 }, function (_, i) { return 'level_' + String(i + 1).padStart(2, '0'); });
const SKIN_KEYS = Array.from({ length: 72 }, function (_, i) { return 'skin_' + String(i + 1).padStart(2, '0'); });

const SLICED_DIR = path.join(__dirname, '..', 'img', 'gravitycover', 'sliced');
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function countVariant(base) {
  var n = 0;
  while (fs.existsSync(path.join(SLICED_DIR, base + '_v' + (n + 1) + '.png'))) n++;
  return n;
}
function getVariantCounts() {
  var counts = {};
  VARIANT_BASES.forEach(function (b) { counts[b] = countVariant(b); });
  return counts;
}
function addVariant(base, dataBase64) {
  if (VARIANT_BASES.indexOf(base) === -1) throw new Error('Tipo de variante desconocido: ' + base);
  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('La imagen pesa más de 8 MB');
  var next = countVariant(base) + 1;
  var key = base + '_v' + next;
  fs.mkdirSync(SLICED_DIR, { recursive: true });
  fs.writeFileSync(path.join(SLICED_DIR, key + '.png'), buffer);
  return { key: key, index: next };
}

/* ---- Fondos de nivel -- a diferencia de las otras variantes, pueden
   ser GIF animado (para que "se mueva"), así que se guardan con la
   extensión real del archivo subido en vez de forzar .png siempre. ---- */
const BG_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp'];
function listBackgrounds() {
  var files = fs.existsSync(SLICED_DIR) ? fs.readdirSync(SLICED_DIR) : [];
  var found = [];
  files.forEach(function (f) {
    var m = /^bg_v(\d+)\.([a-zA-Z0-9]+)$/.exec(f);
    if (m) found.push({ index: parseInt(m[1], 10), file: f });
  });
  found.sort(function (a, b) { return a.index - b.index; });
  return found.map(function (f) { return f.file; });
}
function addBackground(dataBase64, ext) {
  var cleanExt = (ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (BG_EXTS.indexOf(cleanExt) === -1) throw new Error('Formato de imagen no soportado: ' + ext);
  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('La imagen pesa más de 8 MB');
  var existing = listBackgrounds();
  var maxN = 0;
  existing.forEach(function (f) { var m = /^bg_v(\d+)\./.exec(f); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); });
  var file = 'bg_v' + (maxN + 1) + '.' + cleanExt;
  fs.mkdirSync(SLICED_DIR, { recursive: true });
  fs.writeFileSync(path.join(SLICED_DIR, file), buffer);
  return file;
}

function listAssets() {
  // Los "moldes" (variantes de pincho/sierra/plataforma/pared/portal/
  // piso) ya NO se listan acá -- se suben directo desde la paleta de
  // "Editar niveles" (al lado de cada herramienta), donde tiene
  // sentido usarlos. Esta pestaña quedó solo para lo que no es un
  // molde de obstáculo: sprites base, decoración, miniaturas y skins.
  var groups = [
    { group: 'Sprites del juego', keys: SPRITE_KEYS, ext: 'png' },
    { group: 'Decoración del menú principal', keys: HOME_DECOR_KEYS, ext: 'png' },
    { group: 'Miniaturas de nivel', keys: LEVEL_THUMB_KEYS, ext: 'jpg' },
    { group: 'Skins', keys: SKIN_KEYS, ext: 'png' }
  ];
  return groups.map(function (g) {
    return {
      group: g.group,
      ext: g.ext,
      items: g.keys.map(function (key) {
        var file = path.join(SLICED_DIR, key + '.' + g.ext);
        return { key: key, ext: g.ext, exists: fs.existsSync(file), url: '/site/img/gravitycover/sliced/' + key + '.' + g.ext };
      })
    };
  });
}

function assetExt(key) {
  var variantMatch = /^(spike|saw|platform|portal|floor|wall)_v\d+$/.exec(key);
  if (variantMatch) return 'png';
  if (SPRITE_KEYS.indexOf(key) !== -1 || HOME_DECOR_KEYS.indexOf(key) !== -1 || SKIN_KEYS.indexOf(key) !== -1) return 'png';
  if (LEVEL_THUMB_KEYS.indexOf(key) !== -1) return 'jpg';
  throw new Error('Sprite desconocido: ' + key);
}

function saveAsset(key, dataBase64) {
  var ext = assetExt(key);
  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('La imagen pesa más de 8 MB');
  fs.mkdirSync(SLICED_DIR, { recursive: true });
  fs.writeFileSync(path.join(SLICED_DIR, key + '.' + ext), buffer);
  return '/site/img/gravitycover/sliced/' + key + '.' + ext;
}

/* ---- Crear un nivel nuevo (más allá de los 10 iniciales) ---- */
function slugToFnName(name) {
  var words = String(name || 'Nivel').replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/);
  var camel = words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join('');
  return 'buildCustom' + (camel || 'Nivel');
}

function makePlaceholderThumb(levelId, levelName) {
  var outPath = path.join(SLICED_DIR, levelId + '.jpg');
  var script = 'from PIL import Image, ImageDraw\n' +
    'im = Image.new("RGB", (768, 205), (8, 10, 22))\n' +
    'd = ImageDraw.Draw(im)\n' +
    'd.rectangle([4, 4, 763, 200], outline=(61, 224, 255), width=3)\n' +
    'text = ' + JSON.stringify(levelName) + '\n' +
    'bbox = d.textbbox((0, 0), text)\n' +
    'w = bbox[2] - bbox[0]; h = bbox[3] - bbox[1]\n' +
    'd.text(((768 - w) / 2, (205 - h) / 2), text, fill=(236, 238, 242))\n' +
    'im.save(' + JSON.stringify(outPath) + ', quality=85)\n';
  var tmpPy = path.join(os.tmpdir(), 'gravity-thumb-' + Date.now() + '.py');
  fs.writeFileSync(tmpPy, script, 'utf8');
  try {
    execFileSync('python', [tmpPy]);
  } catch (e) {
    // Si no hay Python/Pillow disponible, seguimos sin miniatura --
    // no es bloqueante, se puede subir una a mano después.
  } finally {
    try { fs.unlinkSync(tmpPy); } catch (e2) {}
  }
}

function createLevel(name) {
  var cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Falta el nombre del nivel');

  var src = readSrc();
  var { window } = loadSandbox(src);
  var LEVELS = window.__adminExport.LEVELS;

  var maxN = 0;
  LEVELS.forEach(function (l) {
    var m = /^level_(\d+)$/.exec(l.id);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  });
  var newId = 'level_' + String(maxN + 1).padStart(2, '0');

  var fnName = slugToFnName(cleanName);
  var existingNames = LEVELS.map(function (l) { return l.build.name; });
  var uniqueFnName = fnName, suffix = 2;
  while (existingNames.indexOf(uniqueFnName) !== -1) { uniqueFnName = fnName + suffix; suffix++; }

  var emptyLevelData = { objects: [{ type: 'finish', x: 1200 }], length: 1500, speedZones: [{ x: 0, speed: 0.28 }] };
  var fnSrc = generateBuildFunctionSource(uniqueFnName, emptyLevelData);
  var markedFn = '  // @gravity-editor:start ' + newId + '\n' + fnSrc + '  // @gravity-editor:end ' + newId + '\n\n';

  // Inserta la función nueva justo antes de "var LEVELS = [".
  var levelsDeclIdx = src.indexOf('var LEVELS = [');
  if (levelsDeclIdx === -1) throw new Error('No se encontró el array LEVELS en gravity.js');
  var lineStart = src.lastIndexOf('\n', levelsDeclIdx) + 1;
  var afterInsertFn = src.slice(0, lineStart) + markedFn + src.slice(lineStart);

  // Inserta la entrada nueva en el array LEVELS, justo después de la
  // última entrada existente (que puede o no tener coma final).
  var arrEndIdx = afterInsertFn.indexOf('];', afterInsertFn.indexOf('var LEVELS = ['));
  if (arrEndIdx === -1) throw new Error('No se pudo ubicar el cierre del array LEVELS');
  var lastBraceIdx = afterInsertFn.lastIndexOf('}', arrEndIdx);
  if (lastBraceIdx === -1) throw new Error('No se pudo ubicar la última entrada del array LEVELS');
  var newEntry = ",\n    { id: '" + newId + "', name: " + JSON.stringify(cleanName) + ', build: ' + uniqueFnName + ", thumb: '" + newId + "' }";
  var newSrc = afterInsertFn.slice(0, lastBraceIdx + 1) + newEntry + afterInsertFn.slice(lastBraceIdx + 1);

  // Chequeo de sintaxis antes de escribir.
  var tmpFile = path.join(os.tmpdir(), 'gravity-editor-check-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, newSrc, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmpFile]);
  } catch (e) {
    throw new Error('No se pudo crear el nivel: JavaScript inválido (' + (e.stderr ? e.stderr.toString('utf8') : e.message) + ')');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e2) {}
  }

  fs.writeFileSync(GRAVITY_JS_PATH, newSrc, 'utf8');
  makePlaceholderThumb(newId, cleanName);
  return { id: newId, name: cleanName };
}

/* ---- Bot reactivo (misma lógica calibrada usada para verificar los
   10 niveles a mano en esta sesión: ver scratchpad runAllLevels.js) ---- */
function decide(st, botMem) {
  var p = st.player;
  var centerWorldX = p.worldX + PLAYER_SIZE / 2;
  var upcoming = null, upcomingDist = Infinity;
  st.level.objects.forEach(function (o) {
    if (o.dead) return;
    var dist = o.x - centerWorldX;
    if (dist < -60) return;
    if (dist < upcomingDist) { upcomingDist = dist; upcoming = o; }
  });
  if (upcoming !== botMem.lastTappedObj && (!upcoming || upcomingDist > 240)) botMem.lastTappedObj = null;

  if (p.form === 'ship') {
    var targetY = (FLOOR_Y + CEIL_Y) / 2;
    if (upcoming && upcoming.type === 'saw' && upcomingDist < 300) {
      targetY = upcoming.surface === 'floor' ? CEIL_Y + 90 : FLOOR_Y - 90;
    }
    return { hold: p.y > targetY };
  }
  if (!upcoming) return { tap: false };
  var passiveTypes = ['gravityPortal', 'shapePortal', 'pad', 'door', 'coin', 'money', 'key', 'finish', 'diamond'];
  if (passiveTypes.indexOf(upcoming.type) !== -1) return { tap: false };
  var jumpWindow = p.form === 'ball' ? 230 : 60;
  if (upcomingDist < jumpWindow && upcomingDist > -10) {
    if (p.form === 'cube' && p.grounded) return { tap: true };
    var mySurface = p.gravityDir === 1 ? 'floor' : 'ceil';
    var hazardOnMySurface = !upcoming.surface || upcoming.surface === mySurface;
    if (p.form === 'ball' && hazardOnMySurface && upcoming !== botMem.lastTappedObj) { botMem.lastTappedObj = upcoming; return { tap: true }; }
  }
  return { tap: false };
}

function runBotSim(window, maxRealMs) {
  var canvas = window.document.getElementById('gravityCanvas');
  function tapDown() { canvas.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 })); }
  function tapUp() { canvas.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0 })); }

  var attempts = 0, wins = 0, deaths = 0, bestPct = 0, overlayWasVisible = false;
  var botMem = { holding: false, lastActionAt: -9999, lastTappedObj: null };
  var fakeNow = 0;

  function step(frameMs) {
    fakeNow += frameMs;
    var st = window.__adminExport.getState();
    if (st.state === 'ready' || st.state === 'gameover' || st.state === 'win') {
      tapDown(); tapUp();
      botMem.holding = false; botMem.lastActionAt = -9999; botMem.lastTappedObj = null;
    } else if (st.state === 'playing') {
      var action = decide(st, botMem);
      if (action.hold !== undefined) {
        if (action.hold && !botMem.holding) { tapDown(); botMem.holding = true; }
        else if (!action.hold && botMem.holding) { tapUp(); botMem.holding = false; }
      } else if (action.tap && fakeNow - botMem.lastActionAt > 90) {
        tapDown(); tapUp();
        botMem.lastActionAt = fakeNow;
      }
    }
    if (typeof window.__pendingRaf === 'function') {
      var cb = window.__pendingRaf; window.__pendingRaf = null;
      cb(fakeNow);
    } else {
      return false;
    }
    var overlayHidden = window.document.getElementById('gravityOverlay').classList.contains('hidden');
    var adBreak = window.document.getElementById('gravityAdBreak');
    if (adBreak && !adBreak.classList.contains('hidden')) {
      window.document.getElementById('gravityAdBreakContinue').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    } else if (!overlayHidden) {
      var t = window.document.getElementById('gravityOverlayText').textContent;
      var isResult = t.indexOf('retry') !== -1 || t.indexOf('complete') !== -1;
      if (isResult && !overlayWasVisible) {
        attempts++;
        var win = t.indexOf('complete') !== -1;
        if (win) wins++; else deaths++;
        var pctMatch = /Reached (\d+)%/.exec(t);
        var pct = win ? 100 : (pctMatch ? parseInt(pctMatch[1], 10) : 0);
        if (pct > bestPct) bestPct = pct;
      }
      overlayWasVisible = isResult;
    } else {
      overlayWasVisible = false;
    }
    return true;
  }

  var elapsed = 0;
  while (elapsed < maxRealMs) {
    if (!step(16)) break;
    elapsed += 16;
  }
  return { attempts: attempts, wins: wins, deaths: deaths, bestPct: bestPct };
}

// Corre el bot contra una versión CANDIDATA (sin guardar) de un nivel.
function verifyLevel(id, levelData, maxRealMs) {
  var src = readSrc();
  var sandbox = loadSandbox(src);
  var window = sandbox.window;
  var LEVELS = window.__adminExport.LEVELS;
  var idx = LEVELS.findIndex(function (l) { return l.id === id; });
  if (idx === -1) throw new Error('Nivel no encontrado: ' + id);

  var clone = JSON.parse(JSON.stringify(levelData));
  LEVELS[idx].build = function () {
    return {
      objects: JSON.parse(JSON.stringify(clone.objects)),
      length: clone.length,
      speedZones: JSON.parse(JSON.stringify(clone.speedZones)),
      floorVariant: clone.floorVariant || null,
      ceilVariant: clone.ceilVariant || null,
      background: clone.background || null,
      backgroundDim: clone.backgroundDim != null ? clone.backgroundDim : null
    };
  };
  window.__adminExport.selectLevel(idx);
  var result = runBotSim(window, maxRealMs || 3 * 60 * 1000);
  return result;
}

/* ---- Guardado: regenera el código fuente de la función build...()
   de ese nivel a partir de los objetos/zonas de velocidad editados,
   y lo reemplaza entre los marcadores @gravity-editor:start/end. ---- */
function serializeValue(v) {
  return JSON.stringify(v);
}
function serializeObjLiteral(o) {
  var keys = Object.keys(o).filter(function (k) { return o[k] !== undefined; });
  var parts = keys.map(function (k) { return k + ': ' + serializeValue(o[k]); });
  return '{ ' + parts.join(', ') + ' }';
}

function generateBuildFunctionSource(fnName, levelData) {
  var entries = [];
  (levelData.objects || []).forEach(function (o) { entries.push({ x: o.x, kind: 'add', obj: o }); });
  (levelData.speedZones || []).forEach(function (sz) { entries.push({ x: sz.x, kind: 'speed', sz: sz }); });
  entries.sort(function (a, b) { return a.x - b.x; });

  var lines = [];
  lines.push('  function ' + fnName + '() {');
  lines.push('    // Editado con el panel de admin (Gravity Flip -> Niveles).');
  lines.push('    var objs = [], speedZone = [];');
  lines.push('    function setSpeed(x, s) { speedZone.push({ x: x, speed: s }); }');
  lines.push('    function add(o) { objs.push(o); return o; }');
  entries.forEach(function (e) {
    if (e.kind === 'speed') lines.push('    setSpeed(' + e.sz.x + ', ' + e.sz.speed + ');');
    else lines.push('    add(' + serializeObjLiteral(e.obj) + ');');
  });
  var floorVariantSrc = levelData.floorVariant ? ", floorVariant: '" + levelData.floorVariant + "'" : '';
  var ceilVariantSrc = levelData.ceilVariant ? ", ceilVariant: '" + levelData.ceilVariant + "'" : '';
  var backgroundSrc = levelData.background ? ", background: '" + levelData.background + "'" : '';
  var backgroundDimSrc = levelData.backgroundDim != null ? ", backgroundDim: " + levelData.backgroundDim : '';
  lines.push('    return { objects: objs, length: ' + levelData.length + ', speedZones: speedZone' + floorVariantSrc + ceilVariantSrc + backgroundSrc + backgroundDimSrc + ' };');
  lines.push('  }');
  return lines.join('\n') + '\n';
}

function saveLevel(id, levelData) {
  var src = readSrc();
  var sandbox = loadSandbox(src);
  var meta = sandbox.window.__adminExport.LEVELS.find(function (l) { return l.id === id; });
  if (!meta) throw new Error('Nivel desconocido: ' + id);
  var fnName = meta.build.name;
  var startTag = '// @gravity-editor:start ' + id;
  var endTag = '// @gravity-editor:end ' + id;
  var startIdx = src.indexOf(startTag);
  var endIdx = src.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) throw new Error('No se encontraron los marcadores del nivel ' + id + ' en gravity.js');
  var afterStartLine = src.indexOf('\n', startIdx) + 1;
  var endLineStart = src.lastIndexOf('\n', endIdx) + 1; // conserva la indentación del marcador de cierre

  var newFnSrc = generateBuildFunctionSource(fnName, levelData);
  var newSrc = src.slice(0, afterStartLine) + newFnSrc + src.slice(endLineStart);

  // Chequeo de sintaxis real (node --check) antes de tocar el archivo
  // de verdad -- se prueba en un archivo temporal aparte.
  var tmpFile = path.join(os.tmpdir(), 'gravity-editor-check-' + Date.now() + '.js');
  fs.writeFileSync(tmpFile, newSrc, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmpFile]);
  } catch (e) {
    throw new Error('El nivel editado generó JavaScript inválido: ' + (e.stderr ? e.stderr.toString('utf8') : e.message));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e2) {}
  }

  fs.writeFileSync(GRAVITY_JS_PATH, newSrc, 'utf8');
  return true;
}

module.exports = {
  listLevels: listLevels,
  loadLevel: loadLevel,
  verifyLevel: verifyLevel,
  saveLevel: saveLevel,
  createLevel: createLevel,
  listAssets: listAssets,
  saveAsset: saveAsset,
  getVariantCounts: getVariantCounts,
  addVariant: addVariant,
  listBackgrounds: listBackgrounds,
  addBackground: addBackground
};
