/*
  Editor visual de niveles de Gravity Flip (pestaña "Gravity Flip" del
  panel de administración). Habla con las rutas /api/gravity-level*
  (admin/gravity-editor.js + admin/server.js).
*/
(function () {
  var panel = document.getElementById('panel-gravity');
  if (!panel) return;

  var FLOOR_Y = 320, CEIL_Y = 40, WORLD_H = 360;
  var PORTAL_W = 48, PORTAL_H = 64; // igual que en js/gravity.js
  var MID_Y = (FLOOR_Y + CEIL_Y) / 2;
  // El canvas del editor usa UN SOLO factor de escala (el zoom) para
  // ancho y alto -- así lo que se ve acá son las proporciones reales
  // del juego (nada de íconos-boceto a tamaño fijo), solo una copia
  // más chica o más grande según el zoom elegido.

  // Las cantidades de variantes (cuántos spike_vN, saw_vN, etc. existen)
  // NO están fijas acá -- se piden al servidor (que las cuenta mirando
  // el disco) al cargar la pestaña, así una variante nueva subida desde
  // "Sprites" aparece sola en los selectores sin tocar este archivo.
  var variantCounts = { spike: 0, saw: 0, platform: 0, portal: 0, floor: 0, wall: 0 };
  var KEY_COLORS = { '1': '#FF7A3D', '2': '#3DDBFF', '3': '#C63DFF', 'default': '#FF7A3D' };

  var OBJECT_TYPES = {
    spike: { label: 'Pincho', color: '#FF3D57', icon: '▲', anchor: 'surface', fields: ['surface', 'lift', 'w', 'scale', 'hitboxScale', 'variant', 'rotation'], variantBase: 'spike' },
    saw: { label: 'Sierra', color: '#B983FF', icon: '⚙', anchor: 'surface', fields: ['surface', 'lift', 'scale', 'hitboxScale', 'variant'], variantBase: 'saw' },
    platform: { label: 'Plataforma', color: '#3D8BFF', icon: '▬', anchor: 'surface', fields: ['surface', 'w', 'scale', 'lift', 'lethal', 'moving', 'amp', 'periodMs', 'variant'], variantBase: 'platform' },
    wall: { label: 'Pared', color: '#FF7A3D', icon: '🧱', anchor: 'surface', fields: ['surface', 'w', 'height', 'scale', 'hitboxScale', 'lift', 'variant'], variantBase: 'wall' },
    gravityPortal: { label: 'Portal gravedad', color: '#B983FF', icon: '◐', anchor: 'free', fields: ['dir', 'y', 'scale', 'variant'], variantBase: 'portal' },
    shapePortal: { label: 'Portal forma', color: '#7CF6FF', icon: '◇', anchor: 'free', fields: ['form', 'y', 'scale', 'variant'], variantBase: 'portal' },
    pad: { label: 'Rampa', color: '#7CF6FF', icon: '^', anchor: 'surface', fields: ['surface', 'lift', 'scale', 'color', 'power', 'dir'] },
    key: { label: 'Llave', color: '#FFC93D', icon: '🔑', anchor: 'free', fields: ['y', 'scale', 'keyId'] },
    door: { label: 'Puerta', color: '#FF7A3D', icon: '▯', anchor: 'free', fields: ['x2', 'y', 'scale', 'keyId'] },
    coin: { label: 'Estrella', color: '#FFC93D', icon: '⭐', anchor: 'free', fields: ['id', 'y', 'risky', 'scale'] },
    money: { label: 'Moneda', color: '#FFC93D', icon: '🪙', anchor: 'free', fields: ['y', 'scale'] },
    diamond: { label: 'Diamante', color: '#7CF6FF', icon: '♦', anchor: 'free', fields: ['id', 'y', 'scale'] },
    finish: { label: 'Meta', color: '#7CFFB2', icon: '🏁', anchor: 'full', fields: [] }
  };
  var TOOL_ORDER = ['spike', 'saw', 'platform', 'wall', 'gravityPortal', 'shapePortal', 'pad', 'key', 'door', 'coin', 'money', 'diamond', 'finish'];
  function variantCountFor(type) {
    var def = OBJECT_TYPES[type];
    return def && def.variantBase ? (variantCounts[def.variantBase] || 0) : 0;
  }

  var state = { levelId: null, levelName: '', objects: [], speedZones: [], length: 4000, selectedIndex: -1, tool: 'spike', toolVariant: null, zoom: 0.4 };
  var drag = null; // { index, offsetWorldX, movedY }
  var resizeDrag = null; // { index, centerX, centerY, startDist, startScale } -- en píxeles de canvas
  var hitboxDrag = null; // { index, anchorX, anchorY, startDist, startHb } -- en píxeles de canvas

  var levelSelect = document.getElementById('gravityEditorLevelSelect');
  var zoomInput = document.getElementById('gravityEditorZoom');
  var statusEl = document.getElementById('gravityEditorStatus');
  var paletteEl = document.getElementById('gravityEditorPalette');
  var paletteVariantsEl = document.getElementById('gravityEditorPaletteVariants');
  var canvasWrap = document.getElementById('gravityEditorCanvasWrap');
  var canvas = document.getElementById('gravityEditorCanvas');
  var ctx = canvas.getContext('2d');
  var propsEl = document.getElementById('gravityEditorProps');
  var floorPickerEl = document.getElementById('gravityEditorFloorPicker');
  var ceilPickerEl = document.getElementById('gravityEditorCeilPicker');
  var bgPickerEl = document.getElementById('gravityEditorBgPicker');
  var bgDimInput = document.getElementById('gravityEditorBgDim');
  var bgDimValueEl = document.getElementById('gravityEditorBgDimValue');
  var speedListEl = document.getElementById('gravityEditorSpeedList');
  var verifyBtn = document.getElementById('gravityEditorVerifyBtn');
  var saveBtn = document.getElementById('gravityEditorSaveBtn');
  var addSpeedBtn = document.getElementById('gravityEditorAddSpeedBtn');
  var testXInput = document.getElementById('gravityEditorTestX');
  var useSelectedXBtn = document.getElementById('gravityEditorUseSelectedX');
  var playFromBtn = document.getElementById('gravityEditorPlayFromBtn');
  var objectListFiltersEl = document.getElementById('gravityObjectListFilters');
  var objectListRowsEl = document.getElementById('gravityObjectListRows');
  var objectListSelectAllEl = document.getElementById('gravityObjectListSelectAll');
  var objectListDeleteBtn = document.getElementById('gravityObjectListDeleteBtn');
  var objectListFilter = null;
  var objectListSelected = new Set();

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.style.color = isError ? '#E5484D' : '';
  }

  /* ---- Paleta ---- */
  // "Mano": no es un tipo de objeto, es un modo -- con ella activa,
  // tocar la pista NUNCA agrega algo nuevo, solo permite seleccionar
  // y arrastrar lo que ya está puesto (evita crear un objeto de más
  // por error al fallar un clic cerca de uno existente).
  var MOVE_TOOL_HTML = '<button type="button" class="gravity-tool-btn gravity-tool-move' + (state.tool === 'move' ? ' active' : '') + '" data-tool="move">✋ Mover</button>';
  paletteEl.innerHTML = MOVE_TOOL_HTML + TOOL_ORDER.map(function (t) {
    return '<button type="button" class="gravity-tool-btn' + (t === state.tool ? ' active' : '') + '" data-tool="' + t + '">' +
      OBJECT_TYPES[t].icon + ' ' + OBJECT_TYPES[t].label + '</button>';
  }).join('');
  paletteEl.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.gravity-tool-btn') : null;
    if (!btn) return;
    state.tool = btn.getAttribute('data-tool');
    state.toolVariant = null;
    paletteEl.querySelectorAll('.gravity-tool-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
    renderPaletteVariants();
  });

  // Tile "+" para subir un molde nuevo sin salir de donde se está
  // trabajando -- reemplaza tener que ir a buscarlo a la pestaña
  // "Sprites" aparte (confusa, mezclaba todo). El asterisco de cache
  // (?t=) en los <img> de acá abajo es a propósito: sin eso, después
  // de reemplazar una imagen el navegador puede seguir mostrando la
  // vieja porque la URL no cambió.
  function addSwatchTileHtml(title) {
    return '<label class="gravity-variant-swatch gravity-variant-swatch-add" title="' + (title || 'Agregar nuevo') + '">+' +
      '<input type="file" accept="image/*" hidden></label>';
  }
  function wireAddVariantTile(container, base) {
    var tile = container.querySelector('.gravity-variant-swatch-add');
    if (!tile) return;
    var input = tile.querySelector('input[type="file"]');
    input.addEventListener('change', function () {
      var file = input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var base64 = reader.result.slice(reader.result.indexOf(',') + 1);
        fetch('/api/gravity-asset/add-variant', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: base, dataBase64: base64 })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.ok) { window.alert('Error al agregar el molde: ' + res.error); return; }
          loadVariantCounts();
        }).catch(function (e) { window.alert('Error al agregar el molde: ' + e.message); }).finally(function () { input.value = ''; });
      };
      reader.readAsDataURL(file);
    });
  }
  // Sprites de un solo slot fijo (no son "moldes" numerados, son la
  // única imagen de ese objeto) -- reemplazar sube directo, sin swatch.
  function wireReplaceSpriteTile(container, key) {
    var tile = container.querySelector('[data-replace-key="' + key + '"] input');
    if (!tile) return;
    tile.addEventListener('change', function () {
      var file = tile.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var base64 = reader.result.slice(reader.result.indexOf(',') + 1);
        fetch('/api/gravity-asset', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, dataBase64: base64 })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.ok) { window.alert('Error al reemplazar ' + key + ': ' + res.error); return; }
          spriteImgVersion[key] = (spriteImgVersion[key] || 0) + 1;
          delete spriteImgCache[key];
          renderPaletteVariants();
          render();
        }).catch(function (e) { window.alert('Error al reemplazar ' + key + ': ' + e.message); }).finally(function () { tile.value = ''; });
      };
      reader.readAsDataURL(file);
    });
  }
  // Slots fijos con sprite propio por tipo de herramienta (no son
  // "moldes" -- key/door tienen una sola imagen, orb/pad tienen una
  // por color). Se muestran para poder reemplazarlas sin ir a buscar
  // otra pestaña.
  // La puerta no tiene sprite -- se dibuja como láser (ver render()),
  // así que no aparece acá con las demás.
  var FIXED_SPRITE_SLOTS = {
    key: [{ key: 'key', label: 'Llave' }],
    pad: [{ key: 'pad_cyan', label: 'Cian' }, { key: 'pad_yellow', label: 'Amarilla' }, { key: 'pad_pink', label: 'Rosa' }]
  };
  function renderPaletteVariants() {
    var def = OBJECT_TYPES[state.tool];
    if (!def) { paletteVariantsEl.innerHTML = ''; return; }
    var vc = variantCountFor(state.tool);
    var html = '';
    if (def.variantBase) {
      html += '<span class="gravity-palette-variants-label">Molde de "' + def.label + '" a usar:</span><div class="gravity-variant-swatches">';
      html += '<button type="button" class="gravity-variant-swatch' + (!state.toolVariant ? ' selected' : '') + '" data-variant="">Por defecto</button>';
      for (var vi = 1; vi <= vc; vi++) {
        var vid = 'v' + vi;
        html += '<button type="button" class="gravity-variant-swatch' + (state.toolVariant === vid ? ' selected' : '') +
          '" data-variant="' + vid + '"><img src="/site/img/gravitycover/sliced/' + def.variantBase + '_' + vid + '.png" alt="' + vid + '"></button>';
      }
      html += addSwatchTileHtml('Subir un molde nuevo de ' + def.label.toLowerCase());
      html += '</div>';
    } else if (FIXED_SPRITE_SLOTS[state.tool]) {
      html += '<span class="gravity-palette-variants-label">Sprite de "' + def.label + '":</span><div class="gravity-variant-swatches">';
      FIXED_SPRITE_SLOTS[state.tool].forEach(function (slot) {
        html += '<label class="gravity-variant-swatch" data-replace-key="' + slot.key + '" title="Reemplazar ' + slot.label + '">' +
          '<img src="/site/img/gravitycover/sliced/' + slot.key + '.png?t=' + Date.now() + '" alt="' + slot.label + '">' +
          '<input type="file" accept="image/*" hidden></label>';
      });
      html += '</div>';
    }
    paletteVariantsEl.innerHTML = html;
    if (!html) return;
    paletteVariantsEl.querySelectorAll('.gravity-variant-swatch[data-variant]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.toolVariant = btn.getAttribute('data-variant') || null;
        paletteVariantsEl.querySelectorAll('.gravity-variant-swatch[data-variant]').forEach(function (b) { b.classList.toggle('selected', b === btn); });
      });
    });
    if (def.variantBase) wireAddVariantTile(paletteVariantsEl, def.variantBase);
    if (FIXED_SPRITE_SLOTS[state.tool]) {
      FIXED_SPRITE_SLOTS[state.tool].forEach(function (slot) { wireReplaceSpriteTile(paletteVariantsEl, slot.key); });
    }
  }
  renderPaletteVariants();

  /* ---- Piso del nivel (propiedad de todo el nivel, no un objeto) ---- */
  function renderFloorPicker() {
    if (!floorPickerEl) return;
    var html = '<div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.floorVariant ? ' selected' : '') + '" data-floor="">Por defecto</button>';
    for (var vi = 1; vi <= (variantCounts.floor || 0); vi++) {
      var vid = 'v' + vi;
      html += '<button type="button" class="gravity-variant-swatch' + (state.floorVariant === vid ? ' selected' : '') +
        '" data-floor="' + vid + '"><img src="/site/img/gravitycover/sliced/floor_' + vid + '.png" alt="' + vid + '"></button>';
    }
    html += addSwatchTileHtml('Subir un piso nuevo');
    html += '</div>';
    floorPickerEl.innerHTML = html;
    floorPickerEl.querySelectorAll('.gravity-variant-swatch[data-floor]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.floorVariant = btn.getAttribute('data-floor') || null;
        renderFloorPicker();
        render();
      });
    });
    wireAddVariantTile(floorPickerEl, 'floor');
  }

  /* ---- Techo / paredes del nivel (pool de bloques propio, aparte del piso) ---- */
  function renderCeilPicker() {
    if (!ceilPickerEl) return;
    var html = '<div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.ceilVariant ? ' selected' : '') + '" data-ceil="">Igual al piso</button>';
    for (var vi = 1; vi <= (variantCounts.wall || 0); vi++) {
      var vid = 'v' + vi;
      html += '<button type="button" class="gravity-variant-swatch' + (state.ceilVariant === vid ? ' selected' : '') +
        '" data-ceil="' + vid + '"><img src="/site/img/gravitycover/sliced/wall_' + vid + '.png" alt="' + vid + '"></button>';
    }
    html += addSwatchTileHtml('Subir una pared/techo nuevo');
    html += '</div>';
    ceilPickerEl.innerHTML = html;
    ceilPickerEl.querySelectorAll('.gravity-variant-swatch[data-ceil]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.ceilVariant = btn.getAttribute('data-ceil') || null;
        renderCeilPicker();
        render();
      });
    });
    wireAddVariantTile(ceilPickerEl, 'wall');
  }

  /* ---- Fondo del nivel (imagen o GIF animado, aparte de piso/techo) ---- */
  var backgroundFiles = [];
  function renderBgPicker() {
    if (!bgPickerEl) return;
    var html = '<div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.background ? ' selected' : '') + '" data-bg="">Ninguno</button>';
    backgroundFiles.forEach(function (file) {
      html += '<button type="button" class="gravity-variant-swatch' + (state.background === file ? ' selected' : '') +
        '" data-bg="' + file + '"><img src="/site/img/gravitycover/sliced/' + file + '" alt="' + file + '"></button>';
    });
    html += '<label class="gravity-variant-swatch gravity-variant-swatch-add" title="Subir un fondo nuevo (imagen o GIF)">+' +
      '<input type="file" accept="image/*,.gif" hidden></label>';
    html += '</div>';
    bgPickerEl.innerHTML = html;
    bgPickerEl.querySelectorAll('.gravity-variant-swatch[data-bg]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.background = btn.getAttribute('data-bg') || null;
        renderBgPicker();
        render();
      });
    });
    var addInput = bgPickerEl.querySelector('.gravity-variant-swatch-add input');
    addInput.addEventListener('change', function () {
      var file = addInput.files[0];
      if (!file) return;
      var ext = (file.name.split('.').pop() || 'png').toLowerCase();
      var reader = new FileReader();
      reader.onload = function () {
        var base64 = reader.result.slice(reader.result.indexOf(',') + 1);
        fetch('/api/gravity-background', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataBase64: base64, ext: ext })
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (!res.ok) { window.alert('Error al subir el fondo: ' + res.error); return; }
          state.background = res.file;
          loadBackgrounds();
        }).catch(function (e) { window.alert('Error al subir el fondo: ' + e.message); }).finally(function () { addInput.value = ''; });
      };
      reader.readAsDataURL(file);
    });
  }
  function loadBackgrounds() {
    fetch('/api/gravity-backgrounds').then(function (r) { return r.json(); }).then(function (files) {
      backgroundFiles = files;
      renderBgPicker();
      render();
    }).catch(function () {});
  }

  /* ---- Nivel seleccionado ---- */
  function loadLevelList() {
    fetch('/api/gravity-levels').then(function (r) { return r.json(); }).then(function (levels) {
      levelSelect.innerHTML = levels.map(function (l) { return '<option value="' + l.id + '">' + l.name + '</option>'; }).join('');
      renderLevelOrderList(levels);
      loadLevel(levels[0].id);
    }).catch(function (e) { setStatus('No se pudo cargar la lista de niveles: ' + e.message, true); });
  }

  /* ---- Orden de los niveles (▲/▼, mismo patrón que el carrusel de
     Home) -- el número que ve el jugador y los umbrales de
     desbloqueo por estrellas salen de esta posición, no del id/nombre. ---- */
  var levelOrderList = document.getElementById('gravityLevelOrderList');
  function renderLevelOrderList(levels) {
    if (!levelOrderList) return;
    levelOrderList.innerHTML = '';
    levels.forEach(function (lvl, i) {
      var row = document.createElement('div');
      row.className = 'admin-item';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = String(i + 1);
      thumb.style.background = 'var(--surface-2)';
      thumb.style.display = 'flex';
      thumb.style.alignItems = 'center';
      thumb.style.justifyContent = 'center';
      thumb.style.fontWeight = '700';

      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="ttl"></div><div class="meta"></div>';
      info.querySelector('.ttl').textContent = lvl.name;
      info.querySelector('.meta').textContent = 'Nivel ' + (i + 1) + ' · ' + lvl.id;

      var order = document.createElement('div');
      order.className = 'order-controls';
      var up = document.createElement('button');
      up.type = 'button'; up.textContent = '▲'; up.title = 'Subir';
      up.disabled = i === 0;
      up.addEventListener('click', function () { moveLevel(levels, i, -1); });
      var down = document.createElement('button');
      down.type = 'button'; down.textContent = '▼'; down.title = 'Bajar';
      down.disabled = i === levels.length - 1;
      down.addEventListener('click', function () { moveLevel(levels, i, 1); });
      order.appendChild(up);
      order.appendChild(down);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(order);
      levelOrderList.appendChild(row);
    });
  }
  function moveLevel(levels, index, dir) {
    var target = index + dir;
    if (target < 0 || target >= levels.length) return;
    var order = levels.map(function (l) { return l.id; });
    var tmp = order[index]; order[index] = order[target]; order[target] = tmp;
    fetch('/api/gravity-levels/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: order })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) { setStatus('No se pudo reordenar: ' + res.error, true); return; }
      loadLevelList();
    }).catch(function (e) { setStatus('No se pudo reordenar: ' + e.message, true); });
  }
  function loadLevel(id) {
    setStatus('Cargando...');
    fetch('/api/gravity-level?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) { setStatus(data.error, true); return; }
      state.levelId = data.id;
      state.levelName = data.name;
      state.objects = data.objects;
      state.speedZones = data.speedZones;
      state.length = data.length;
      state.floorVariant = data.floorVariant || null;
      state.ceilVariant = data.ceilVariant || null;
      state.background = data.background || null;
      state.backgroundDim = data.backgroundDim != null ? data.backgroundDim : 0.45;
      state.selectedIndex = -1;
      objectListSelected.clear();
      objectListFilter = null;
      levelSelect.value = id;
      if (bgDimInput) { bgDimInput.value = state.backgroundDim; bgDimValueEl.textContent = Math.round(state.backgroundDim * 100) + '%'; }
      renderSpeedList();
      renderFloorPicker();
      renderCeilPicker();
      renderBgPicker();
      renderProps();
      renderObjectList();
      render();
      setStatus('Cargado: ' + data.name + ' (' + data.objects.length + ' obstáculos)');
    }).catch(function (e) { setStatus('Error cargando el nivel: ' + e.message, true); });
  }
  levelSelect.addEventListener('change', function () { loadLevel(levelSelect.value); });
  zoomInput.addEventListener('input', function () { state.zoom = parseFloat(zoomInput.value); render(); });
  if (bgDimInput) {
    bgDimInput.addEventListener('input', function () {
      state.backgroundDim = parseFloat(bgDimInput.value);
      bgDimValueEl.textContent = Math.round(state.backgroundDim * 100) + '%';
      render();
    });
  }

  /* ---- Objetos por defecto al colocar ---- */
  function defaultObjectFor(type, x, y) {
    var surface = y > MID_Y ? 'floor' : 'ceil';
    var obj;
    switch (type) {
      case 'spike': obj = { type: 'spike', surface: surface, w: 28, x: x }; break;
      case 'saw': obj = { type: 'saw', surface: surface, x: x }; break;
      case 'platform': obj = { type: 'platform', surface: surface, w: 90, lift: 46, x: x }; break;
      case 'wall': obj = { type: 'wall', surface: surface, w: 40, height: 80, lift: 0, x: x }; break;
      case 'gravityPortal': obj = { type: 'gravityPortal', dir: -1, y: y, x: x }; break;
      case 'shapePortal': obj = { type: 'shapePortal', form: 'ship', y: y, x: x }; break;
      case 'pad': obj = { type: 'pad', color: 'cyan', surface: surface, x: x }; break;
      case 'key': obj = { type: 'key', y: y, x: x }; break;
      case 'door': obj = { type: 'door', x2: x + 130, y: y, x: x }; break;
      case 'coin': obj = { type: 'coin', id: countOf('coin'), y: y, x: x }; break;
      case 'money': obj = { type: 'money', y: y, x: x }; break;
      case 'diamond': obj = { type: 'diamond', id: countOf('diamond'), y: y, x: x }; break;
      case 'finish': obj = { type: 'finish', x: x }; break;
      default: obj = { type: type, x: x };
    }
    if (state.toolVariant && variantCountFor(type)) obj.variant = state.toolVariant;
    return obj;
  }
  function countOf(type) { return state.objects.filter(function (o) { return o.type === type; }).length; }

  // Centro real en coordenadas de mundo -- las mismas cuentas que usa
  // js/gravity.js para dibujar/colisionar cada tipo, así lo que se ve
  // en el editor cae exactamente donde va a cargar en el juego real.
  function objectDrawY(o) {
    var def = OBJECT_TYPES[o.type];
    if (!def) return MID_Y;
    var lift = o.lift || 0;
    var scale = o.scale || 1;
    if (o.type === 'spike') {
      var half = 15 * scale;
      return o.surface === 'ceil' ? CEIL_Y + half + lift : FLOOR_Y - half - lift;
    }
    if (o.type === 'saw') {
      var sawR = 22 * scale;
      return o.surface === 'ceil' ? CEIL_Y + sawR + lift : FLOOR_Y - sawR - lift;
    }
    if (o.type === 'platform') {
      var pH = 14 * scale;
      return o.surface === 'ceil' ? CEIL_Y + lift + pH / 2 : FLOOR_Y - lift - pH / 2;
    }
    if (o.type === 'pad') {
      var padH = 16 * scale;
      return o.surface === 'ceil' ? CEIL_Y + lift + padH / 2 : FLOOR_Y - lift - padH / 2;
    }
    if (o.type === 'wall') {
      var wallH = (o.height || 80) * scale;
      return o.surface === 'ceil' ? CEIL_Y + lift + wallH / 2 : FLOOR_Y - lift - wallH / 2;
    }
    if (def.anchor === 'free') return (o.y != null ? o.y : MID_Y);
    return MID_Y;
  }

  function recomputeLength() {
    var maxX = 0;
    state.objects.forEach(function (o) { maxX = Math.max(maxX, o.x, o.x2 || 0); });
    state.length = Math.round(maxX + 300);
    renderObjectList();
  }

  /* ---- Lista de objetos puestos -- para encontrar y borrar algo que
     quedó gigante, mal puesto o imposible de tocar en la pista (clic
     directo), en vez de tener que cazarlo a mano en el canvas. ---- */
  function renderObjectList() {
    if (!objectListFiltersEl) return;
    var counts = {};
    state.objects.forEach(function (o) { counts[o.type] = (counts[o.type] || 0) + 1; });
    var filterHtml = '<button type="button" class="gravity-objtype-filter' + (!objectListFilter ? ' active' : '') + '" data-filter="">Todos (' + state.objects.length + ')</button>';
    Object.keys(counts).sort().forEach(function (t) {
      var def = OBJECT_TYPES[t];
      filterHtml += '<button type="button" class="gravity-objtype-filter' + (objectListFilter === t ? ' active' : '') + '" data-filter="' + t + '">' +
        (def ? def.icon : '?') + ' ' + (def ? def.label : t) + ' (' + counts[t] + ')</button>';
    });
    objectListFiltersEl.innerHTML = filterHtml;
    objectListFiltersEl.querySelectorAll('.gravity-objtype-filter').forEach(function (btn) {
      btn.addEventListener('click', function () {
        objectListFilter = btn.getAttribute('data-filter') || null;
        renderObjectList();
      });
    });

    var rowsHtml = '';
    state.objects.forEach(function (o, i) {
      if (objectListFilter && o.type !== objectListFilter) return;
      var def = OBJECT_TYPES[o.type] || { icon: '?', label: o.type };
      var isSel = objectListSelected.has(o);
      rowsHtml += '<div class="gravity-objectlist-row' + (i === state.selectedIndex ? ' selected' : '') + '">' +
        '<input type="checkbox" class="oli-check" data-idx="' + i + '"' + (isSel ? ' checked' : '') + '>' +
        '<span class="oli-label" data-idx="' + i + '">' + def.icon + ' ' + def.label + '</span>' +
        '<span class="oli-x">x:' + Math.round(o.x) + '</span>' +
        '<button type="button" class="oli-del" data-idx="' + i + '" title="Eliminar">✕</button>' +
        '</div>';
    });
    objectListRowsEl.innerHTML = rowsHtml;

    objectListRowsEl.querySelectorAll('.oli-label').forEach(function (el) {
      el.addEventListener('click', function () {
        state.selectedIndex = parseInt(el.getAttribute('data-idx'), 10);
        renderProps();
        render();
        renderObjectList();
      });
    });
    objectListRowsEl.querySelectorAll('.oli-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var o = state.objects[parseInt(cb.getAttribute('data-idx'), 10)];
        if (cb.checked) objectListSelected.add(o); else objectListSelected.delete(o);
      });
    });
    objectListRowsEl.querySelectorAll('.oli-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        objectListSelected.delete(state.objects[idx]);
        state.objects.splice(idx, 1);
        if (state.selectedIndex === idx) state.selectedIndex = -1;
        else if (state.selectedIndex > idx) state.selectedIndex--;
        recomputeLength();
        renderProps();
        render();
      });
    });
    if (objectListSelectAllEl) objectListSelectAllEl.checked = false;
  }
  if (objectListSelectAllEl) {
    objectListSelectAllEl.addEventListener('change', function () {
      state.objects.forEach(function (o) {
        if (!objectListFilter || o.type === objectListFilter) {
          if (objectListSelectAllEl.checked) objectListSelected.add(o); else objectListSelected.delete(o);
        }
      });
      renderObjectList();
    });
  }
  if (objectListDeleteBtn) {
    objectListDeleteBtn.addEventListener('click', function () {
      if (objectListSelected.size === 0) { window.alert('No hay nada seleccionado.'); return; }
      if (!window.confirm('¿Eliminar ' + objectListSelected.size + ' objeto(s)? No se puede deshacer.')) return;
      state.objects = state.objects.filter(function (o) { return !objectListSelected.has(o); });
      objectListSelected.clear();
      state.selectedIndex = -1;
      recomputeLength();
      renderProps();
      render();
    });
  }

  /* ---- Sprites reales para la vista previa (en vez de círculos) ---- */
  var spriteImgCache = {};
  // spriteImgVersion se pisa cada vez que se reemplaza un sprite fijo
  // (wireReplaceSpriteTile) -- sin esto, el navegador puede seguir
  // sirviendo la imagen vieja desde su caché HTTP aunque el archivo en
  // el server ya haya cambiado, porque la URL queda igual.
  var spriteImgVersion = {};
  function getSpriteImg(name) {
    if (!spriteImgCache[name]) {
      var img = new Image();
      var v = spriteImgVersion[name];
      img.src = '/site/img/gravitycover/sliced/' + name + '.png' + (v ? ('?v=' + v) : '');
      img.onload = render;
      spriteImgCache[name] = img;
    }
    return spriteImgCache[name];
  }
  // Los fondos ya vienen con su propia extensión en el nombre (pueden
  // ser .gif) -- no hay que agregarles ".png" como al resto de sprites.
  function getBgImg(fileName) {
    if (!spriteImgCache[fileName]) {
      var img = new Image();
      img.src = '/site/img/gravitycover/sliced/' + fileName;
      img.onload = render;
      spriteImgCache[fileName] = img;
    }
    return spriteImgCache[fileName];
  }
  function spriteNameFor(o) {
    switch (o.type) {
      case 'spike': return o.variant ? 'spike_' + o.variant : 'spike';
      case 'saw': return o.variant ? 'saw_' + o.variant : 'saw';
      case 'platform': return o.variant ? 'platform_' + o.variant : 'platform';
      case 'wall': return o.variant ? 'wall_' + o.variant : 'platform';
      case 'gravityPortal': return o.variant ? 'portal_' + o.variant : 'portal_gravity';
      case 'shapePortal': return o.variant ? 'portal_' + o.variant : 'portal_shape';
      case 'pad': return 'pad_' + (o.color || 'cyan');
      case 'key': return 'key';
      default: return null; // coin/diamond/finish/door: se dibujan a mano (no tienen sprite)
    }
  }

  // Tamaño real (mundo) de cada sprite dibujado, MISMAS cuentas que
  // js/gravity.js draw() -- se multiplican por el zoom (un solo factor
  // para ancho y alto) para que el editor muestre proporciones 100%
  // reales, no íconos de tamaño fijo.
  function spriteWorldSize(o) {
    var scale = o.scale || 1;
    switch (o.type) {
      case 'spike': return { w: 40 * scale, h: 30 * scale };
      case 'saw': var sawR = 22 * scale; return { w: sawR * 2, h: sawR * 2 };
      case 'platform': return { w: o.w || 90, h: 14 * scale };
      case 'wall': return { w: o.w || 40, h: (o.height || 80) * scale };
      case 'gravityPortal': case 'shapePortal': return { w: PORTAL_W * scale, h: PORTAL_H * scale };
      case 'pad': return { w: 40 * scale, h: 16 * scale };
      case 'key': return { w: 30 * scale, h: 30 * scale };
      case 'door': return { w: (o.x2 != null ? o.x2 - o.x : 130), h: (o.height != null ? o.height : (FLOOR_Y - CEIL_Y)) * scale };
      default: return { w: 24 * scale, h: 24 * scale };
    }
  }

  /* ---- Canvas ---- */
  function render() {
    var worldW = Math.max(state.length + 500, 2500);
    canvas.width = Math.round(worldW * state.zoom);
    canvas.height = Math.round(WORLD_H * state.zoom);
    ctx.fillStyle = '#05060f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (state.background) {
      var bgImg = getBgImg(state.background);
      if (bgImg.complete && bgImg.naturalWidth > 0) {
        var bgTileW = Math.max(20, bgImg.naturalWidth * (canvas.height / bgImg.naturalHeight));
        for (var bx = 0; bx < canvas.width; bx += bgTileW) ctx.drawImage(bgImg, bx, 0, bgTileW, canvas.height);
        var dim = state.backgroundDim != null ? state.backgroundDim : 0.45;
        if (dim > 0) {
          ctx.fillStyle = 'rgba(5,6,15,' + Math.min(1, dim) + ')';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
    }

    // grilla de referencia cada 230px de mundo (distancia "cómoda" GAP_CUBE)
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx < worldW; gx += 230) {
      var cgx = gx * state.zoom;
      ctx.beginPath(); ctx.moveTo(cgx, 0); ctx.lineTo(cgx, canvas.height); ctx.stroke();
    }

    var floorCy = FLOOR_Y * state.zoom, ceilCy = CEIL_Y * state.zoom;
    var tileW = 110 * state.zoom; // igual que js/gravity.js
    var floorSpriteKey = state.floorVariant ? 'floor_' + state.floorVariant : 'floor';
    var floorImg = getSpriteImg(floorSpriteKey);
    if (floorImg.complete && floorImg.naturalWidth > 0) {
      for (var tx = 0; tx < canvas.width; tx += tileW) {
        ctx.drawImage(floorImg, tx, floorCy, tileW + 1, canvas.height - floorCy);
      }
    }
    // Sin techo propio elegido, usa el mismo bloque que el piso por
    // defecto (en vez del sprite genérico) -- ver nota en js/gravity.js.
    var ceilImg = getSpriteImg(state.ceilVariant ? 'wall_' + state.ceilVariant : floorSpriteKey);
    if (ceilImg.complete && ceilImg.naturalWidth > 0) {
      for (var tx2 = 0; tx2 < canvas.width; tx2 += tileW) {
        ctx.save();
        ctx.translate(tx2 + tileW / 2, ceilCy);
        ctx.rotate(Math.PI);
        ctx.drawImage(ceilImg, -tileW / 2, -ceilCy, tileW + 1, ceilCy);
        ctx.restore();
      }
    }
    ctx.strokeStyle = 'rgba(185,131,255,.55)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, floorCy); ctx.lineTo(canvas.width, floorCy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, ceilCy); ctx.lineTo(canvas.width, ceilCy); ctx.stroke();

    // zonas de velocidad
    state.speedZones.forEach(function (sz) {
      var cx = sz.x * state.zoom;
      ctx.strokeStyle = 'rgba(124,255,178,.6)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#7CFFB2'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
      ctx.fillText(sz.speed + 'x', cx + 3, 12);
    });

    // fin del nivel
    var endCx = state.length * state.zoom;
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(endCx, 0); ctx.lineTo(endCx, canvas.height); ctx.stroke(); ctx.setLineDash([]);

    // marca de "probar desde acá"
    if (testXInput) {
      var testCx = Math.max(0, parseInt(testXInput.value, 10) || 0) * state.zoom;
      ctx.strokeStyle = '#7CFFB2'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(testCx, 0); ctx.lineTo(testCx, canvas.height); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#7CFFB2';
      ctx.beginPath(); ctx.moveTo(testCx, 0); ctx.lineTo(testCx + 10, 6); ctx.lineTo(testCx, 12); ctx.closePath(); ctx.fill();
    }

    // puertas (banda, igual que el juego real: de o.x a o.x2, alto y
    // posición vertical ajustables -- ya no siempre todo el alto)
    state.objects.forEach(function (o) {
      if (o.type !== 'door') return;
      var doorHBand = ((o.height != null ? o.height : (FLOOR_Y - CEIL_Y)) * (o.scale || 1)) * state.zoom;
      var doorTopBand = objectDrawY(o) * state.zoom - doorHBand / 2;
      ctx.fillStyle = 'rgba(255,122,61,.18)';
      ctx.fillRect(o.x * state.zoom, doorTopBand, (o.x2 - o.x) * state.zoom, doorHBand);
    });

    // objetos -- mismas posiciones/tamaños/anclajes que js/gravity.js draw(),
    // escalados por el mismo factor de zoom que ya se usó para todo lo demás
    state.objects.forEach(function (o, i) {
      var def = OBJECT_TYPES[o.type] || { color: '#fff', icon: '?' };
      var cx = o.x * state.zoom;
      var cy = objectDrawY(o) * state.zoom;
      var selected = i === state.selectedIndex;
      var spriteName = spriteNameFor(o);
      var img = spriteName ? getSpriteImg(spriteName) : null;
      var sizeW = spriteWorldSize(o), drawW = sizeW.w * state.zoom, drawH = sizeW.h * state.zoom;
      var drawnAsSprite = false;
      if (img && img.complete && img.naturalWidth > 0) {
        var rot = (o.surface === 'ceil' && (o.type === 'spike' || o.type === 'saw')) ? Math.PI : 0;
        if (o.type === 'spike') rot += (o.rotation || 0) * Math.PI / 180;
        ctx.save();
        if (o.type === 'platform' || o.type === 'wall') {
          // Ancla en la esquina superior izquierda (o.x), no centrado --
          // igual que drawSprite(sprite, sx, py, o.w, h) en el juego real.
          if (o.lethal) ctx.filter = 'sepia(1) saturate(6) hue-rotate(-40deg) brightness(.9)';
          ctx.drawImage(img, cx, cy - drawH / 2, drawW, drawH);
        } else {
          ctx.translate(cx, cy);
          if (rot) ctx.rotate(rot);
          if (o.surface === 'ceil' && o.type === 'pad') ctx.rotate(Math.PI);
          ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        }
        ctx.restore();
        drawnAsSprite = true;
      } else if (o.type === 'door') {
        // Sin sprite -- se dibuja como el láser/franja del juego real,
        // no como una puerta 2D.
        var doorLineW = Math.max(3, 6 * (o.scale || 1) * state.zoom);
        var doorColor = KEY_COLORS[o.keyId != null ? String(o.keyId) : 'default'] || KEY_COLORS.default;
        ctx.save();
        ctx.shadowColor = doorColor; ctx.shadowBlur = 10;
        ctx.strokeStyle = doorColor; ctx.lineWidth = doorLineW; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx, cy - drawH / 2); ctx.lineTo(cx, cy + drawH / 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = Math.max(1, doorLineW * 0.3);
        ctx.beginPath(); ctx.moveTo(cx, cy - drawH / 2); ctx.lineTo(cx, cy + drawH / 2); ctx.stroke();
        ctx.restore();
        drawnAsSprite = true;
      }
      if (o.type === 'key') {
        var keyRingColor = KEY_COLORS[o.keyId != null ? String(o.keyId) : 'default'] || KEY_COLORS.default;
        ctx.save();
        ctx.shadowColor = keyRingColor; ctx.shadowBlur = 8;
        ctx.strokeStyle = keyRingColor; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(drawW, drawH) / 2 + 5, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (!drawnAsSprite) {
        var r = Math.max(6, Math.max(drawW, drawH) / 2) * (selected ? 1.15 : 1);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = def.color;
        ctx.fill();
        ctx.fillStyle = '#05060f'; ctx.font = Math.max(8, r) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(def.icon, cx, cy);
      }
      if (selected && o.type !== 'door') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(drawW, drawH) / 2 + 4, 0, Math.PI * 2); ctx.stroke();
      } else if (selected && o.type === 'door') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(cx, cy - drawH / 2, drawW, drawH);
      }
    });

    // agarradera de tamaño -- solo en el objeto seleccionado, solo si
    // su tipo tiene "Tamaño" (scale). Arrastrarla cambia o.scale en
    // vivo, sin tener que ir al campo numérico del panel.
    if (state.selectedIndex !== -1) {
      var selObj = state.objects[state.selectedIndex];
      if (selObj && hasScale(selObj)) {
        var h = handleScreenPos(selObj);
        ctx.fillStyle = '#7CFFB2';
        ctx.strokeStyle = '#05060f'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(h.x, h.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (selObj && hasHitbox(selObj)) {
        var hb = hitboxShape(selObj);
        ctx.save();
        ctx.strokeStyle = '#FF3D57'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
        if (hb.kind === 'circle') {
          ctx.beginPath(); ctx.arc(hb.cx, hb.cy, hb.r, 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.strokeRect(hb.left, hb.top, hb.right - hb.left, hb.bottom - hb.top);
        }
        ctx.restore();
        ctx.fillStyle = '#FF3D57';
        ctx.strokeStyle = '#05060f'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(hb.handleX, hb.handleY, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  function hasScale(o) {
    var def = OBJECT_TYPES[o.type];
    return !!(def && def.fields && def.fields.indexOf('scale') !== -1);
  }
  // Caja del objeto en píxeles de canvas -- mismas anclas que el
  // dibujo real (plataforma/pared ancladas arriba-izquierda, el
  // resto centrado en cx,cy). Se usa tanto para dibujar la agarradera
  // de tamaño como para saber si un clic le pegó.
  function objectScreenBox(o) {
    var cx = o.x * state.zoom;
    var cy = objectDrawY(o) * state.zoom;
    var sizeW = spriteWorldSize(o);
    var drawW = sizeW.w * state.zoom, drawH = sizeW.h * state.zoom;
    if (o.type === 'platform' || o.type === 'wall' || o.type === 'door') {
      return { left: cx, top: cy - drawH / 2, right: cx + drawW, bottom: cy + drawH / 2 };
    }
    return { left: cx - drawW / 2, top: cy - drawH / 2, right: cx + drawW / 2, bottom: cy + drawH / 2 };
  }
  function handleScreenPos(o) {
    var box = objectScreenBox(o);
    return { x: box.right, y: box.bottom };
  }

  // Pincho/sierra/pared son los únicos tipos que matan al chocar --
  // acá se puede ver Y arrastrar exactamente hasta dónde llega esa
  // zona de choque, aparte de lo grande que se vea el sprite (mismas
  // cuentas que hbScale()/spikeHalf/sawHitR/wallHitH en js/gravity.js).
  function hasHitbox(o) {
    var def = OBJECT_TYPES[o.type];
    return !!(def && def.fields && def.fields.indexOf('hitboxScale') !== -1);
  }
  function hitboxShape(o) {
    var scale = o.scale || 1, hb = o.hitboxScale != null ? o.hitboxScale : 1;
    var lift = o.lift || 0;
    var cx = o.x * state.zoom;
    if (o.type === 'saw') {
      var cy = objectDrawY(o) * state.zoom;
      var r = 22 * scale * hb * state.zoom;
      return { kind: 'circle', cx: cx, cy: cy, r: r, handleX: cx + r * 0.7071, handleY: cy + r * 0.7071 };
    }
    if (o.type === 'spike') {
      var half = 18 * scale * hb;
      var spikeYWorld = o.surface === 'ceil' ? CEIL_Y + lift : FLOOR_Y - lift;
      var topW = spikeYWorld - half, bottomW = spikeYWorld + half;
      var wpx = (o.w || 28) * state.zoom;
      return { kind: 'rect', left: cx - wpx / 2, right: cx + wpx / 2, top: topW * state.zoom, bottom: bottomW * state.zoom, handleX: cx + wpx / 2, handleY: bottomW * state.zoom };
    }
    // wall -- el borde pisable (wallTop) queda fijo; la zona que mata
    // se estira desde ahí hacia la base según hitboxScale.
    var wallBase = o.surface === 'floor' ? FLOOR_Y - lift : CEIL_Y + lift;
    var visH = (o.height || 80) * scale;
    var wallTop = o.surface === 'floor' ? wallBase - visH : wallBase + visH;
    var hitH = visH * hb;
    var hitEdge = o.surface === 'floor' ? wallTop + hitH : wallTop - hitH;
    var topW2 = Math.min(wallTop, hitEdge), bottomW2 = Math.max(wallTop, hitEdge);
    var wpx2 = (o.w || 40) * state.zoom;
    return { kind: 'rect', left: cx, right: cx + wpx2, top: topW2 * state.zoom, bottom: bottomW2 * state.zoom, handleX: cx + wpx2, handleY: bottomW2 * state.zoom };
  }
  // Punto fijo desde el que se mide el arrastre de la agarradera de
  // colisión -- el centro de la banda para pincho/sierra, el borde
  // pisable (que no se mueve) para pared.
  function hitboxAnchor(o) {
    var lift = o.lift || 0;
    var cx = o.x * state.zoom;
    if (o.type === 'saw') return { x: cx, y: objectDrawY(o) * state.zoom };
    if (o.type === 'spike') {
      var spikeYWorld = o.surface === 'ceil' ? CEIL_Y + lift : FLOOR_Y - lift;
      return { x: cx, y: spikeYWorld * state.zoom };
    }
    var wallBase = o.surface === 'floor' ? FLOOR_Y - lift : CEIL_Y + lift;
    var visH = (o.height || 80) * (o.scale || 1);
    var wallTop = o.surface === 'floor' ? wallBase - visH : wallBase + visH;
    return { x: cx, y: wallTop * state.zoom };
  }

  function worldFromEvent(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;
    return { x: Math.max(0, Math.round(cx / state.zoom)), y: Math.max(0, Math.min(WORLD_H, cy / state.zoom)) };
  }

  function findObjectNear(worldX, worldY, thresholdWorld) {
    var best = -1, bestDist = Infinity;
    state.objects.forEach(function (o, i) {
      // La puerta se dibuja como una franja ancha de o.x a o.x2, no un
      // punto -- si solo se mide contra o.x, una puerta ensanchada se
      // vuelve imposible de tocar más allá de su borde izquierdo. Acá
      // cualquier clic dentro de la franja (con margen) cuenta.
      if (o.type === 'door' && o.x2 != null) {
        if (worldX >= o.x - thresholdWorld && worldX <= o.x2 + thresholdWorld) {
          var doorDist = thresholdWorld * 0.9; // cede el paso a algo más puntual en el mismo lugar
          if (doorDist < bestDist) { bestDist = doorDist; best = i; }
        }
        return;
      }
      var oy = objectDrawY(o);
      var dx = o.x - worldX, dy = oy - worldY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < thresholdWorld && dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  function eventCanvasPos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('mousedown', function (e) {
    // Si ya hay un objeto seleccionado con agarraderas y el clic pegó
    // en una de ellas, arrastrar cambia tamaño/colisión en vez de
    // mover el objeto. Se chequea la de colisión primero porque
    // suele quedar más afuera que la de tamaño.
    if (state.selectedIndex !== -1) {
      var selObj = state.objects[state.selectedIndex];
      var cp = eventCanvasPos(e);
      if (selObj && hasHitbox(selObj)) {
        var hbShape = hitboxShape(selObj);
        if (Math.hypot(cp.x - hbShape.handleX, cp.y - hbShape.handleY) < 9) {
          var anchor = hitboxAnchor(selObj);
          hitboxDrag = {
            index: state.selectedIndex,
            anchorX: anchor.x, anchorY: anchor.y,
            startDist: Math.max(6, Math.hypot(hbShape.handleX - anchor.x, hbShape.handleY - anchor.y)),
            startHb: selObj.hitboxScale != null ? selObj.hitboxScale : 1
          };
          return;
        }
      }
      if (selObj && hasScale(selObj)) {
        var h = handleScreenPos(selObj);
        if (Math.hypot(cp.x - h.x, cp.y - h.y) < 10) {
          var box = objectScreenBox(selObj);
          var cxCanvas = (box.left + box.right) / 2, cyCanvas = (box.top + box.bottom) / 2;
          resizeDrag = {
            index: state.selectedIndex,
            centerX: cxCanvas, centerY: cyCanvas,
            startDist: Math.max(6, Math.hypot(h.x - cxCanvas, h.y - cyCanvas)),
            startScale: selObj.scale || 1
          };
          return;
        }
      }
    }
    var w = worldFromEvent(e);
    var isMoveMode = state.tool === 'move';
    var hitThreshold = (isMoveMode ? 26 : 14) / state.zoom;
    var idx = findObjectNear(w.x, w.y, hitThreshold);
    if (idx !== -1) {
      state.selectedIndex = idx;
      drag = { index: idx, freeY: OBJECT_TYPES[state.objects[idx].type].anchor === 'free', liftDraggable: OBJECT_TYPES[state.objects[idx].type].anchor === 'surface' };
    } else if (!isMoveMode) {
      var obj = defaultObjectFor(state.tool, w.x, w.y);
      state.objects.push(obj);
      state.selectedIndex = state.objects.length - 1;
      drag = { index: state.selectedIndex, freeY: OBJECT_TYPES[obj.type].anchor === 'free', liftDraggable: OBJECT_TYPES[obj.type].anchor === 'surface' };
      recomputeLength();
    } else {
      // Modo "Mover" y no se tocó nada existente: no se crea nada.
      state.selectedIndex = -1;
    }
    renderProps();
    render();
  });
  window.addEventListener('mousemove', function (e) {
    if (hitboxDrag) {
      var o3 = state.objects[hitboxDrag.index];
      if (!o3) { hitboxDrag = null; return; }
      var cp3 = eventCanvasPos(e);
      var dist3 = Math.hypot(cp3.x - hitboxDrag.anchorX, cp3.y - hitboxDrag.anchorY);
      var newHb = hitboxDrag.startHb * (dist3 / hitboxDrag.startDist);
      o3.hitboxScale = Math.round(Math.max(0.05, newHb) * 100) / 100;
      renderProps();
      render();
      return;
    }
    if (resizeDrag) {
      var o2 = state.objects[resizeDrag.index];
      if (!o2) { resizeDrag = null; return; }
      var cp = eventCanvasPos(e);
      var dist = Math.hypot(cp.x - resizeDrag.centerX, cp.y - resizeDrag.centerY);
      var newScale = resizeDrag.startScale * (dist / resizeDrag.startDist);
      o2.scale = Math.round(Math.max(0.05, newScale) * 100) / 100;
      renderProps();
      render();
      return;
    }
    if (!drag) return;
    var w = worldFromEvent(e);
    var o = state.objects[drag.index];
    if (!o) return;
    var dx = o.x2 != null ? (o.x2 - o.x) : null;
    o.x = Math.max(0, Math.round(w.x));
    if (dx != null) o.x2 = o.x + dx;
    if (drag.freeY) o.y = Math.round(Math.max(CEIL_Y, Math.min(FLOOR_Y, w.y)));
    if (drag.liftDraggable) {
      var lift = o.surface === 'ceil' ? (w.y - CEIL_Y) : (FLOOR_Y - w.y);
      o.lift = Math.round(Math.max(-500, lift));
      renderProps();
    }
    recomputeLength();
    render();
  });
  window.addEventListener('mouseup', function () {
    if (hitboxDrag) { hitboxDrag = null; renderProps(); }
    if (resizeDrag) { resizeDrag = null; renderProps(); }
    if (drag) { drag = null; renderProps(); }
  });
  var objectClipboard = null;
  window.addEventListener('keydown', function (e) {
    var typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT');
    if (typing || !panel.classList.contains('active')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIndex !== -1) {
      e.preventDefault();
      objectListSelected.delete(state.objects[state.selectedIndex]);
      state.objects.splice(state.selectedIndex, 1);
      state.selectedIndex = -1;
      recomputeLength();
      renderProps();
      render();
      return;
    }
    var ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'c' && state.selectedIndex !== -1) {
      e.preventDefault();
      objectClipboard = JSON.parse(JSON.stringify(state.objects[state.selectedIndex]));
      setStatus('Copiado (' + (OBJECT_TYPES[objectClipboard.type] || { label: objectClipboard.type }).label + ') -- Ctrl+V para pegar');
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'v' && objectClipboard) {
      e.preventDefault();
      var copy = JSON.parse(JSON.stringify(objectClipboard));
      copy.x = Math.round((copy.x || 0) + 40);
      if (copy.x2 != null) copy.x2 = copy.x + (objectClipboard.x2 - objectClipboard.x);
      state.objects.push(copy);
      state.selectedIndex = state.objects.length - 1;
      recomputeLength();
      renderProps();
      render();
      setStatus('Pegado en x:' + copy.x);
    }
  });

  /* ---- Panel de propiedades ---- */
  var FIELD_LABEL = {
    surface: 'Superficie', w: 'Ancho', lift: 'Altura', moving: 'Móvil', amp: 'Amplitud', periodMs: 'Período (ms)',
    dir: 'Dirección', form: 'Forma', color: 'Color', y: 'Altura (y)', id: 'Número (0/1/2)', risky: 'Riesgosa',
    x2: 'Hasta x', rotation: 'Rotación (°)', lethal: '¿Hace perder?', scale: 'Tamaño',
    height: 'Altura de la pared', hitboxScale: 'Colisión (qué tan justo choca)', power: 'Fuerza del salto',
    keyId: 'Llave que le corresponde'
  };
  function renderProps() {
    if (state.selectedIndex === -1) { propsEl.innerHTML = ''; return; }
    var o = state.objects[state.selectedIndex];
    var def = OBJECT_TYPES[o.type];
    if (!def) { propsEl.innerHTML = ''; return; }
    var html = '<div class="prop-row"><strong>' + def.icon + ' ' + def.label + '</strong> — x: ' + o.x + '</div>';
    var vc = variantCountFor(o.type);
    if (vc) {
      html += '<div class="prop-row gravity-variant-row"><span>Aspecto</span><div class="gravity-variant-swatches">';
      html += '<button type="button" class="gravity-variant-swatch' + (!o.variant ? ' selected' : '') + '" data-variant="">Por defecto</button>';
      for (var vi = 1; vi <= vc; vi++) {
        var vid = 'v' + vi;
        html += '<button type="button" class="gravity-variant-swatch' + (o.variant === vid ? ' selected' : '') +
          '" data-variant="' + vid + '"><img src="/site/img/gravitycover/sliced/' + def.variantBase + '_' + vid + '.png" alt="' + vid + '"></button>';
      }
      html += '</div></div>';
    }
    html += '<div class="prop-row">';
    def.fields.forEach(function (f) {
      if (f === 'variant') return; // se maneja arriba como swatches
      if (f === 'surface') {
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="surface"><option value="floor"' + (o.surface === 'floor' ? ' selected' : '') + '>Piso</option><option value="ceil"' + (o.surface === 'ceil' ? ' selected' : '') + '>Techo</option></select></label>';
      } else if (f === 'dir') {
        var dirAutoOpt = o.type === 'pad' ? '<option value=""' + (o.dir == null ? ' selected' : '') + '>Automática (según la superficie)</option>' : '';
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="dir">' + dirAutoOpt + '<option value="-1"' + (o.dir === -1 ? ' selected' : '') + '>Hacia arriba</option><option value="1"' + (o.dir === 1 ? ' selected' : '') + '>Hacia abajo</option></select></label>';
      } else if (f === 'form') {
        ['cube', 'ship', 'ball'].forEach(function () {});
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="form">' + ['cube', 'ship', 'ball'].map(function (v) { return '<option value="' + v + '"' + (o.form === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></label>';
      } else if (f === 'color') {
        var opts = o.type === 'pad' ? ['cyan', 'yellow', 'pink'] : ['yellow', 'pink', 'green'];
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="color">' + opts.map(function (v) { return '<option value="' + v + '"' + (o.color === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></label>';
      } else if (f === 'id') {
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="id">' + [0, 1, 2].map(function (v) { return '<option value="' + v + '"' + (o.id === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></label>';
      } else if (f === 'moving' || f === 'risky' || f === 'lethal') {
        html += '<label><input type="checkbox" data-field="' + f + '"' + (o[f] ? ' checked' : '') + '> ' + FIELD_LABEL[f] + '</label>';
      } else if (f === 'scale') {
        html += '<label>' + FIELD_LABEL[f] + ' <input type="number" min="0.05" step="0.1" data-field="scale" value="' + (o.scale != null ? o.scale : 1) + '"></label>';
      } else if (f === 'hitboxScale') {
        html += '<label>' + FIELD_LABEL[f] + ' <input type="number" min="0.05" step="0.1" data-field="hitboxScale" value="' + (o.hitboxScale != null ? o.hitboxScale : 1) + '"></label>';
      } else if (f === 'power') {
        html += '<label>' + FIELD_LABEL[f] + ' <input type="number" min="0.05" step="0.1" data-field="power" value="' + (o.power != null ? o.power : 1) + '"></label>';
      } else if (f === 'keyId') {
        var keyIdCur = o.keyId != null ? String(o.keyId) : '';
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="keyId"><option value=""' + (keyIdCur === '' ? ' selected' : '') + '>Ninguna en particular' + (o.type === 'door' ? ' (no bloquea)' : '') + '</option>' +
          ['1', '2', '3'].map(function (v) { return '<option value="' + v + '"' + (keyIdCur === v ? ' selected' : '') + '>Llave ' + v + '</option>'; }).join('') + '</select></label>';
      } else {
        html += '<label>' + FIELD_LABEL[f] + ' <input type="' + (f === 'linkId' ? 'text' : 'number') + '" data-field="' + f + '" value="' + (o[f] != null ? o[f] : '') + '"></label>';
      }
    });
    html += '</div><div class="prop-row"><button type="button" class="btn-secondary danger" id="gravityEditorDeleteBtn">Eliminar</button></div>';
    propsEl.innerHTML = html;

    propsEl.querySelectorAll('[data-field]').forEach(function (input) {
      input.addEventListener('change', function () {
        var field = input.getAttribute('data-field');
        var val;
        if (input.type === 'checkbox') val = input.checked;
        else if (input.type === 'number') val = input.value === '' ? undefined : Number(input.value);
        else if (field === 'dir') val = input.value === '' ? undefined : Number(input.value);
        else if (field === 'keyId') val = input.value === '' ? undefined : input.value;
        else if (field === 'id') val = Number(input.value);
        else val = input.value;
        o[field] = val;
        recomputeLength();
        render();
      });
    });
    propsEl.querySelectorAll('.gravity-variant-swatch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        o.variant = btn.getAttribute('data-variant') || undefined;
        renderProps();
        render();
      });
    });
    var delBtn = document.getElementById('gravityEditorDeleteBtn');
    if (delBtn) delBtn.addEventListener('click', function () {
      state.objects.splice(state.selectedIndex, 1);
      state.selectedIndex = -1;
      recomputeLength();
      renderProps();
      render();
    });
  }

  /* ---- Zonas de velocidad ---- */
  function renderSpeedList() {
    speedListEl.innerHTML = state.speedZones.map(function (sz, i) {
      return '<div class="gravity-speed-row">' +
        '<label>x <input type="number" data-sz="' + i + '" data-field="x" value="' + sz.x + '"></label>' +
        '<label>velocidad <input type="number" step="0.01" data-sz="' + i + '" data-field="speed" value="' + sz.speed + '"></label>' +
        '<button type="button" data-remove="' + i + '">✕</button></div>';
    }).join('');
    speedListEl.querySelectorAll('input').forEach(function (input) {
      input.addEventListener('change', function () {
        var i = parseInt(input.getAttribute('data-sz'), 10);
        var field = input.getAttribute('data-field');
        state.speedZones[i][field] = Number(input.value);
        render();
      });
    });
    speedListEl.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.speedZones.splice(parseInt(btn.getAttribute('data-remove'), 10), 1);
        renderSpeedList();
        render();
      });
    });
  }
  addSpeedBtn.addEventListener('click', function () {
    state.speedZones.push({ x: 0, speed: 0.28 });
    renderSpeedList();
    render();
  });

  /* ---- Verificar / Guardar ---- */
  function currentPayload() {
    return { id: state.levelId, objects: state.objects, length: state.length, speedZones: state.speedZones, floorVariant: state.floorVariant, ceilVariant: state.ceilVariant, background: state.background, backgroundDim: state.backgroundDim };
  }

  /* ---- Probar desde una posición -- abre el nivel GUARDADO de
     verdad (no el borrador sin guardar) en una pestaña nueva,
     arrancando justo ahí en vez de en x:0, para poder ir probando el
     nivel en partes sin rejugarlo entero cada vez. ---- */
  if (useSelectedXBtn) {
    useSelectedXBtn.addEventListener('click', function () {
      if (state.selectedIndex === -1) { window.alert('Primero seleccioná un obstáculo puesto.'); return; }
      testXInput.value = Math.round(state.objects[state.selectedIndex].x);
      render();
    });
  }
  if (playFromBtn) {
    playFromBtn.addEventListener('click', function () {
      if (!state.levelId) return;
      var x = Math.max(0, parseInt(testXInput.value, 10) || 0);
      window.open('/site/play/gravity.html?level=' + encodeURIComponent(state.levelId) + '&startX=' + x, '_blank');
    });
  }
  if (testXInput) testXInput.addEventListener('input', render);

  verifyBtn.addEventListener('click', function () {
    verifyBtn.disabled = true;
    setStatus('Verificando con el bot (unos segundos)...');
    fetch('/api/gravity-level/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload())
    }).then(function (r) { return r.json(); }).then(function (res) {
      verifyBtn.disabled = false;
      if (!res.ok) { setStatus('Error al verificar: ' + res.error, true); return; }
      var r = res.result;
      var winPct = r.attempts ? Math.round((r.wins / r.attempts) * 100) : 0;
      var msg = 'Bot: ' + r.wins + '/' + r.attempts + ' completados (' + winPct + '%) — mejor alcance ' + r.bestPct + '%';
      setStatus(msg, r.wins === 0);
    }).catch(function (e) {
      verifyBtn.disabled = false;
      setStatus('Error al verificar: ' + e.message, true);
    });
  });
  saveBtn.addEventListener('click', function () {
    if (!window.confirm('¿Guardar los cambios de "' + state.levelName + '" en js/gravity.js?')) return;
    saveBtn.disabled = true;
    setStatus('Guardando...');
    fetch('/api/gravity-level/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload())
    }).then(function (r) { return r.json(); }).then(function (res) {
      saveBtn.disabled = false;
      if (!res.ok) { setStatus('Error al guardar: ' + res.error, true); return; }
      setStatus('Guardado ✔ — probalo en /site/play/gravity.html (puede necesitar recargar sin caché)');
    }).catch(function (e) {
      saveBtn.disabled = false;
      setStatus('Error al guardar: ' + e.message, true);
    });
  });

  /* ---- Sub-pestañas (Editar niveles / Agregar nivel / Sprites) ---- */
  document.querySelectorAll('.gravity-subtab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.gravity-subtab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.gravity-subpanel').forEach(function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('gravitySub-' + tab.getAttribute('data-subtab')).classList.add('active');
      if (tab.getAttribute('data-subtab') === 'sprites') loadAssets();
    });
  });

  /* ---- Agregar nivel ---- */
  var addLevelForm = document.getElementById('gravityAddLevelForm');
  var addLevelStatus = document.getElementById('gravityAddLevelStatus');
  addLevelForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var nameInput = document.getElementById('gravityNewLevelName');
    var name = nameInput.value.trim();
    if (!name) return;
    addLevelStatus.textContent = 'Creando...';
    fetch('/api/gravity-level/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) { addLevelStatus.textContent = 'Error: ' + res.error; return; }
      addLevelStatus.textContent = '¡Creado! "' + res.level.name + '" (' + res.level.id + ') — ya está en "Editar niveles".';
      nameInput.value = '';
      loadLevelList();
    }).catch(function (e) { addLevelStatus.textContent = 'Error: ' + e.message; });
  });

  /* ---- Sprites (galería de assets reemplazables que no son un molde
     de obstáculo -- esos se suben desde la paleta de "Editar
     niveles", al lado de cada herramienta) ---- */
  var assetGroupsEl = document.getElementById('gravityAssetGroups');
  function loadAssets() {
    fetch('/api/gravity-assets').then(function (r) { return r.json(); }).then(function (groups) {
      assetGroupsEl.innerHTML = groups.map(function (g) {
        return '<div class="gravity-asset-group"><h3>' + g.group + '</h3><div class="gravity-asset-grid">' +
          g.items.map(function (item) {
            return '<div class="gravity-asset-card" data-key="' + item.key + '">' +
              (item.exists ? '<img src="' + item.url + '?t=' + Date.now() + '" alt="' + item.key + '">' : '<div class="missing">sin imagen</div>') +
              '<span class="key">' + item.key + '</span>' +
              '<input type="file" accept="image/*" data-key="' + item.key + '"></div>';
          }).join('') + '</div></div>';
      }).join('');
      assetGroupsEl.querySelectorAll('input[data-key]').forEach(function (input) {
        input.addEventListener('change', function () { uploadAsset(input); });
      });
    }).catch(function (e) { assetGroupsEl.textContent = 'Error al cargar los sprites: ' + e.message; });
  }
  function uploadAsset(input) {
    var file = input.files[0];
    if (!file) return;
    var key = input.getAttribute('data-key');
    var card = input.closest('.gravity-asset-card');
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      fetch('/api/gravity-asset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, dataBase64: base64 })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok) { window.alert('Error al subir ' + key + ': ' + res.error); return; }
        var img = card.querySelector('img') || document.createElement('img');
        img.src = res.url + '?t=' + Date.now();
        var missing = card.querySelector('.missing');
        if (missing) missing.replaceWith(img);
      }).catch(function (e) { window.alert('Error al subir ' + key + ': ' + e.message); }).finally(function () {
        input.value = '';
      });
    };
    reader.readAsDataURL(file);
  }

  function loadVariantCounts() {
    fetch('/api/gravity-variant-counts').then(function (r) { return r.json(); }).then(function (counts) {
      variantCounts = counts;
      renderPaletteVariants();
      renderProps();
      renderFloorPicker();
      renderCeilPicker();
      render();
    }).catch(function () {});
  }
  loadVariantCounts();
  loadBackgrounds();
  loadLevelList();
})();
