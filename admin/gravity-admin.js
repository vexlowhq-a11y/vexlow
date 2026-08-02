/*
  Editor visual de niveles de Gravity Flip (pestaña "Gravity Flip" del
  panel de administración). Habla con las rutas /api/gravity-level*
  (admin/gravity-editor.js + admin/server.js).
*/
(function () {
  var panel = document.getElementById('panel-gravity');
  if (!panel) return;

  var FLOOR_Y = 320, CEIL_Y = 40, WORLD_H = 360;
  var CANVAS_H = 230;
  var scaleY = CANVAS_H / WORLD_H;
  var MID_Y = (FLOOR_Y + CEIL_Y) / 2;

  // Las cantidades de variantes (cuántos spike_vN, saw_vN, etc. existen)
  // NO están fijas acá -- se piden al servidor (que las cuenta mirando
  // el disco) al cargar la pestaña, así una variante nueva subida desde
  // "Sprites" aparece sola en los selectores sin tocar este archivo.
  var variantCounts = { spike: 0, saw: 0, platform: 0, portal: 0, floor: 0 };

  var OBJECT_TYPES = {
    spike: { label: 'Pincho', color: '#FF3D57', icon: '▲', anchor: 'surface', fields: ['surface', 'lift', 'w', 'scale', 'variant', 'rotation'], variantBase: 'spike' },
    saw: { label: 'Sierra', color: '#B983FF', icon: '⚙', anchor: 'surface', fields: ['surface', 'lift', 'scale', 'linkId', 'variant'], variantBase: 'saw' },
    platform: { label: 'Plataforma', color: '#3D8BFF', icon: '▬', anchor: 'surface', fields: ['surface', 'w', 'scale', 'lift', 'lethal', 'moving', 'amp', 'periodMs', 'variant'], variantBase: 'platform' },
    gravityPortal: { label: 'Portal gravedad', color: '#B983FF', icon: '◐', anchor: 'full', fields: ['dir', 'scale', 'variant'], variantBase: 'portal' },
    shapePortal: { label: 'Portal forma', color: '#7CF6FF', icon: '◇', anchor: 'full', fields: ['form', 'scale', 'variant'], variantBase: 'portal' },
    orb: { label: 'Orbe', color: '#FFC93D', icon: '●', anchor: 'free', fields: ['color', 'y', 'scale'] },
    pad: { label: 'Rampa', color: '#7CF6FF', icon: '^', anchor: 'surface', fields: ['surface', 'lift', 'scale', 'color'] },
    key: { label: 'Llave', color: '#FFC93D', icon: '🔑', anchor: 'free', fields: ['y', 'scale'] },
    door: { label: 'Puerta', color: '#FF7A3D', icon: '▯', anchor: 'full', fields: ['x2'] },
    coin: { label: 'Moneda', color: '#FFC93D', icon: '◎', anchor: 'free', fields: ['id', 'y', 'risky', 'scale'] },
    diamond: { label: 'Diamante', color: '#7CF6FF', icon: '♦', anchor: 'free', fields: ['y', 'scale'] },
    interruptor: { label: 'Interruptor', color: '#7CF6FF', icon: '⊙', anchor: 'full', fields: ['linkId', 'scale'] },
    finish: { label: 'Meta', color: '#7CFFB2', icon: '🏁', anchor: 'full', fields: [] }
  };
  var TOOL_ORDER = ['spike', 'saw', 'platform', 'gravityPortal', 'shapePortal', 'orb', 'pad', 'key', 'door', 'coin', 'diamond', 'interruptor', 'finish'];
  function variantCountFor(type) {
    var def = OBJECT_TYPES[type];
    return def && def.variantBase ? (variantCounts[def.variantBase] || 0) : 0;
  }

  var state = { levelId: null, levelName: '', objects: [], speedZones: [], length: 4000, selectedIndex: -1, tool: 'spike', toolVariant: null, zoom: 0.4 };
  var drag = null; // { index, offsetWorldX, movedY }

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
  var previewFrame = document.getElementById('gravityEditorPreviewFrame');
  var previewReloadBtn = document.getElementById('gravityEditorPreviewReload');
  var speedListEl = document.getElementById('gravityEditorSpeedList');
  var verifyBtn = document.getElementById('gravityEditorVerifyBtn');
  var saveBtn = document.getElementById('gravityEditorSaveBtn');
  var addSpeedBtn = document.getElementById('gravityEditorAddSpeedBtn');

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.style.color = isError ? '#E5484D' : '';
  }

  /* ---- Paleta ---- */
  paletteEl.innerHTML = TOOL_ORDER.map(function (t) {
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

  function renderPaletteVariants() {
    var def = OBJECT_TYPES[state.tool];
    var vc = variantCountFor(state.tool);
    if (!def || !vc) { paletteVariantsEl.innerHTML = ''; return; }
    var html = '<span class="gravity-palette-variants-label">Molde de "' + def.label + '" a usar:</span><div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.toolVariant ? ' selected' : '') + '" data-variant="">Por defecto</button>';
    for (var vi = 1; vi <= vc; vi++) {
      var vid = 'v' + vi;
      html += '<button type="button" class="gravity-variant-swatch' + (state.toolVariant === vid ? ' selected' : '') +
        '" data-variant="' + vid + '"><img src="/site/img/gravitycover/sliced/' + def.variantBase + '_' + vid + '.png" alt="' + vid + '"></button>';
    }
    html += '</div>';
    paletteVariantsEl.innerHTML = html;
    paletteVariantsEl.querySelectorAll('.gravity-variant-swatch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.toolVariant = btn.getAttribute('data-variant') || null;
        paletteVariantsEl.querySelectorAll('.gravity-variant-swatch').forEach(function (b) { b.classList.toggle('selected', b === btn); });
      });
    });
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
    html += '</div>';
    floorPickerEl.innerHTML = html;
    floorPickerEl.querySelectorAll('.gravity-variant-swatch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.floorVariant = btn.getAttribute('data-floor') || null;
        renderFloorPicker();
        render();
        schedulePreviewUpdate();
      });
    });
  }

  /* ---- Techo del nivel (mismo pool de bloques que el piso, aparte) ---- */
  function renderCeilPicker() {
    if (!ceilPickerEl) return;
    var html = '<div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.ceilVariant ? ' selected' : '') + '" data-ceil="">Por defecto</button>';
    for (var vi = 1; vi <= (variantCounts.floor || 0); vi++) {
      var vid = 'v' + vi;
      html += '<button type="button" class="gravity-variant-swatch' + (state.ceilVariant === vid ? ' selected' : '') +
        '" data-ceil="' + vid + '"><img src="/site/img/gravitycover/sliced/floor_' + vid + '.png" alt="' + vid + '"></button>';
    }
    html += '</div>';
    ceilPickerEl.innerHTML = html;
    ceilPickerEl.querySelectorAll('.gravity-variant-swatch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.ceilVariant = btn.getAttribute('data-ceil') || null;
        renderCeilPicker();
        render();
        schedulePreviewUpdate();
      });
    });
  }

  /* ---- Nivel seleccionado ---- */
  function loadLevelList() {
    fetch('/api/gravity-levels').then(function (r) { return r.json(); }).then(function (levels) {
      levelSelect.innerHTML = levels.map(function (l) { return '<option value="' + l.id + '">' + l.name + '</option>'; }).join('');
      loadLevel(levels[0].id);
    }).catch(function (e) { setStatus('No se pudo cargar la lista de niveles: ' + e.message, true); });
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
      state.selectedIndex = -1;
      levelSelect.value = id;
      renderSpeedList();
      renderFloorPicker();
      renderCeilPicker();
      renderProps();
      render();
      setStatus('Cargado: ' + data.name + ' (' + data.objects.length + ' obstáculos)');
      schedulePreviewUpdate(true);
    }).catch(function (e) { setStatus('Error cargando el nivel: ' + e.message, true); });
  }
  levelSelect.addEventListener('change', function () { loadLevel(levelSelect.value); });
  zoomInput.addEventListener('input', function () { state.zoom = parseFloat(zoomInput.value); render(); });

  /* ---- Objetos por defecto al colocar ---- */
  function defaultObjectFor(type, x, y) {
    var surface = y > MID_Y ? 'floor' : 'ceil';
    var obj;
    switch (type) {
      case 'spike': obj = { type: 'spike', surface: surface, w: 28, x: x }; break;
      case 'saw': obj = { type: 'saw', surface: surface, x: x }; break;
      case 'platform': obj = { type: 'platform', surface: surface, w: 90, lift: 46, x: x }; break;
      case 'gravityPortal': obj = { type: 'gravityPortal', dir: -1, x: x }; break;
      case 'shapePortal': obj = { type: 'shapePortal', form: 'ship', x: x }; break;
      case 'orb': obj = { type: 'orb', color: 'yellow', y: y, x: x }; break;
      case 'pad': obj = { type: 'pad', color: 'cyan', surface: surface, x: x }; break;
      case 'key': obj = { type: 'key', y: y, x: x }; break;
      case 'door': obj = { type: 'door', x2: x + 130, x: x }; break;
      case 'coin': obj = { type: 'coin', id: countOf('coin'), y: y, x: x }; break;
      case 'diamond': obj = { type: 'diamond', y: y, x: x }; break;
      case 'interruptor': obj = { type: 'interruptor', linkId: 'sw' + Math.round(x), x: x }; break;
      case 'finish': obj = { type: 'finish', x: x }; break;
      default: obj = { type: type, x: x };
    }
    if (state.toolVariant && variantCountFor(type)) obj.variant = state.toolVariant;
    return obj;
  }
  function countOf(type) { return state.objects.filter(function (o) { return o.type === type; }).length; }

  function objectDrawY(o) {
    var def = OBJECT_TYPES[o.type];
    if (!def) return MID_Y;
    if (def.anchor === 'surface') {
      var lift = o.lift || 0;
      var off = 20 * (o.scale || 1);
      return o.surface === 'ceil' ? CEIL_Y + off + lift : FLOOR_Y - off - lift;
    }
    if (def.anchor === 'free') return (o.y != null ? o.y : MID_Y);
    return MID_Y;
  }

  function recomputeLength() {
    var maxX = 0;
    state.objects.forEach(function (o) { maxX = Math.max(maxX, o.x, o.x2 || 0); });
    state.length = Math.round(maxX + 300);
    schedulePreviewUpdate();
  }

  /* ---- Sprites reales para la vista previa (en vez de círculos) ---- */
  var spriteImgCache = {};
  function getSpriteImg(name) {
    if (!spriteImgCache[name]) {
      var img = new Image();
      img.src = '/site/img/gravitycover/sliced/' + name + '.png';
      img.onload = render;
      spriteImgCache[name] = img;
    }
    return spriteImgCache[name];
  }
  var floorColorCache = {};
  function floorVariantColor(variant) {
    if (floorColorCache[variant]) return floorColorCache[variant];
    var img = getSpriteImg('floor_' + variant);
    if (!img.complete || img.naturalWidth === 0) return null;
    try {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var cctx = c.getContext('2d');
      cctx.drawImage(img, 0, 0);
      var data = cctx.getImageData(0, 0, c.width, c.height).data;
      var r = 0, g = 0, b = 0, wsum = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        var bright = Math.max(data[i], data[i + 1], data[i + 2]);
        var w = Math.max(0.05, Math.min(1, (bright - 40) / 180));
        r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; wsum += w;
      }
      var color = wsum > 0 ? 'rgb(' + Math.round(r / wsum) + ',' + Math.round(g / wsum) + ',' + Math.round(b / wsum) + ')' : '#3D3040';
      floorColorCache[variant] = color;
      return color;
    } catch (e) {
      return null;
    }
  }
  function spriteNameFor(o) {
    switch (o.type) {
      case 'spike': return o.variant ? 'spike_' + o.variant : 'spike';
      case 'saw': return o.variant ? 'saw_' + o.variant : 'saw';
      case 'platform': return o.variant ? 'platform_' + o.variant : 'platform';
      case 'gravityPortal': return o.variant ? 'portal_' + o.variant : 'portal_gravity';
      case 'shapePortal': return o.variant ? 'portal_' + o.variant : 'portal_shape';
      case 'orb': return 'orb_' + (o.color || 'yellow');
      case 'pad': return 'pad_' + (o.color || 'cyan');
      case 'key': return 'key';
      case 'door': return 'door';
      default: return null; // coin/diamond/interruptor/finish: se dibujan a mano (no tienen sprite)
    }
  }

  /* ---- Canvas ---- */
  function render() {
    var worldW = Math.max(state.length + 500, 2500);
    canvas.width = Math.round(worldW * state.zoom);
    canvas.height = CANVAS_H;
    ctx.fillStyle = '#05060f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // grilla de referencia cada 230px de mundo (distancia "cómoda" GAP_CUBE)
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx < worldW; gx += 230) {
      var cgx = gx * state.zoom;
      ctx.beginPath(); ctx.moveTo(cgx, 0); ctx.lineTo(cgx, canvas.height); ctx.stroke();
    }

    var floorCy = FLOOR_Y * scaleY, ceilCy = CEIL_Y * scaleY;
    var floorColor = state.floorVariant ? floorVariantColor(state.floorVariant) : null;
    var ceilColor = state.ceilVariant ? floorVariantColor(state.ceilVariant) : null;
    var floorImg = getSpriteImg('floor');
    if (floorColor) {
      // Los bloques no son una textura sin costura -- se pinta una
      // franja continua con el color representativo del bloque
      // elegido, igual que en el juego real.
      ctx.fillStyle = floorColor;
      ctx.fillRect(0, floorCy, canvas.width, canvas.height - floorCy);
    } else if (floorImg.complete && floorImg.naturalWidth > 0) {
      var tileW = Math.max(18, 44 * state.zoom);
      for (var tx = 0; tx < canvas.width; tx += tileW) {
        ctx.drawImage(floorImg, tx, floorCy, tileW + 1, canvas.height - floorCy);
      }
    }
    if (ceilColor) {
      ctx.fillStyle = ceilColor;
      ctx.fillRect(0, 0, canvas.width, ceilCy);
    } else if (floorImg.complete && floorImg.naturalWidth > 0) {
      var tileW2 = Math.max(18, 44 * state.zoom);
      for (var tx2 = 0; tx2 < canvas.width; tx2 += tileW2) {
        ctx.save();
        ctx.translate(tx2 + tileW2 / 2, ceilCy);
        ctx.rotate(Math.PI);
        ctx.drawImage(floorImg, -tileW2 / 2, -ceilCy, tileW2 + 1, ceilCy);
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

    // puertas (banda)
    state.objects.forEach(function (o) {
      if (o.type !== 'door') return;
      ctx.fillStyle = 'rgba(255,122,61,.18)';
      ctx.fillRect(o.x * state.zoom, ceilCy, (o.x2 - o.x) * state.zoom, floorCy - ceilCy);
    });

    // objetos
    state.objects.forEach(function (o, i) {
      var def = OBJECT_TYPES[o.type] || { color: '#fff', icon: '?' };
      var cx = o.x * state.zoom;
      var cy = objectDrawY(o) * scaleY;
      var selected = i === state.selectedIndex;
      var spriteName = spriteNameFor(o);
      var img = spriteName ? getSpriteImg(spriteName) : null;
      var drawnAsSprite = false;
      if (img && img.complete && img.naturalWidth > 0) {
        var sz = (o.type === 'platform' ? 26 : (o.type === 'saw' ? 28 : 24)) * (o.scale || 1);
        var rot = (o.surface === 'ceil' && (o.type === 'spike' || o.type === 'saw')) ? Math.PI : 0;
        ctx.save();
        ctx.translate(cx, cy);
        if (rot) ctx.rotate(rot);
        if (o.type === 'platform' && o.lethal) ctx.filter = 'sepia(1) saturate(6) hue-rotate(-40deg) brightness(.9)';
        ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz);
        ctx.restore();
        drawnAsSprite = true;
      }
      if (!drawnAsSprite) {
        ctx.beginPath();
        ctx.arc(cx, cy, selected ? 10 : 7, 0, Math.PI * 2);
        ctx.fillStyle = def.color;
        ctx.fill();
        ctx.fillStyle = '#05060f'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(def.icon, cx, cy);
      }
      if (selected) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, drawnAsSprite ? 16 : 10, 0, Math.PI * 2); ctx.stroke();
      }
    });
  }

  function worldFromEvent(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = e.clientX - rect.left;
    var cy = e.clientY - rect.top;
    return { x: Math.max(0, Math.round(cx / state.zoom)), y: Math.max(0, Math.min(WORLD_H, cy / scaleY)) };
  }

  function findObjectNear(worldX, worldY, thresholdWorld) {
    var best = -1, bestDist = Infinity;
    state.objects.forEach(function (o, i) {
      var oy = objectDrawY(o);
      var dx = o.x - worldX, dy = oy - worldY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < thresholdWorld && dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  canvas.addEventListener('mousedown', function (e) {
    var w = worldFromEvent(e);
    var hitThreshold = 14 / state.zoom;
    var idx = findObjectNear(w.x, w.y, hitThreshold);
    if (idx !== -1) {
      state.selectedIndex = idx;
      drag = { index: idx, freeY: OBJECT_TYPES[state.objects[idx].type].anchor === 'free', liftDraggable: OBJECT_TYPES[state.objects[idx].type].anchor === 'surface' };
    } else {
      var obj = defaultObjectFor(state.tool, w.x, w.y);
      state.objects.push(obj);
      state.selectedIndex = state.objects.length - 1;
      drag = { index: state.selectedIndex, freeY: OBJECT_TYPES[obj.type].anchor === 'free', liftDraggable: OBJECT_TYPES[obj.type].anchor === 'surface' };
      recomputeLength();
    }
    renderProps();
    render();
  });
  window.addEventListener('mousemove', function (e) {
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
      o.lift = Math.round(Math.max(0, Math.min(200, lift)));
      renderProps();
    }
    recomputeLength();
    render();
  });
  window.addEventListener('mouseup', function () {
    if (drag) { drag = null; renderProps(); }
  });
  window.addEventListener('keydown', function (e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIndex !== -1 &&
      document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT' &&
      panel.classList.contains('active')) {
      e.preventDefault();
      state.objects.splice(state.selectedIndex, 1);
      state.selectedIndex = -1;
      recomputeLength();
      renderProps();
      render();
    }
  });

  /* ---- Panel de propiedades ---- */
  var FIELD_LABEL = {
    surface: 'Superficie', w: 'Ancho', lift: 'Altura', moving: 'Móvil', amp: 'Amplitud', periodMs: 'Período (ms)',
    dir: 'Dirección', form: 'Forma', color: 'Color', y: 'Altura (y)', id: 'ID moneda', risky: 'Riesgosa',
    x2: 'Hasta x', linkId: 'Vínculo (linkId)', rotation: 'Rotación (°)', lethal: '¿Hace perder?', scale: 'Tamaño'
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
        html += '<label>' + FIELD_LABEL[f] + ' <select data-field="dir"><option value="-1"' + (o.dir === -1 ? ' selected' : '') + '>Hacia arriba</option><option value="1"' + (o.dir === 1 ? ' selected' : '') + '>Hacia abajo</option></select></label>';
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
        html += '<label>' + FIELD_LABEL[f] + ' <input type="number" min="0.4" max="3" step="0.1" data-field="scale" value="' + (o.scale != null ? o.scale : 1) + '"></label>';
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
        else if (field === 'dir' || field === 'id') val = Number(input.value);
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
        schedulePreviewUpdate();
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
        schedulePreviewUpdate();
      });
    });
    speedListEl.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.speedZones.splice(parseInt(btn.getAttribute('data-remove'), 10), 1);
        renderSpeedList();
        render();
        schedulePreviewUpdate();
      });
    });
  }
  addSpeedBtn.addEventListener('click', function () {
    state.speedZones.push({ x: 0, speed: 0.28 });
    renderSpeedList();
    render();
    schedulePreviewUpdate();
  });

  /* ---- Verificar / Guardar ---- */
  function currentPayload() {
    return { id: state.levelId, objects: state.objects, length: state.length, speedZones: state.speedZones, floorVariant: state.floorVariant, ceilVariant: state.ceilVariant };
  }

  /* ---- Vista previa en vivo (el juego real, en un iframe) ----
     Cada cambio en el nivel se manda como "borrador" al servidor (sin
     tocar js/gravity.js) y el iframe, que carga el juego de verdad
     con ?preview=<id>, se recarga para reflejarlo -- así el editor
     nunca reimplementa el dibujo del juego por su cuenta. */
  var previewTimer = null;
  var previewReloadCounter = 0;
  function refreshPreview() {
    if (!state.levelId || !previewFrame) return;
    previewReloadCounter++;
    previewFrame.src = '/site/play/gravity.html?preview=' + encodeURIComponent(state.levelId) + '&r=' + previewReloadCounter;
  }
  function schedulePreviewUpdate(immediate) {
    if (!state.levelId) return;
    clearTimeout(previewTimer);
    var run = function () {
      fetch('/api/gravity-level/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentPayload())
      }).then(function () { refreshPreview(); }).catch(function () {});
    };
    if (immediate) run(); else previewTimer = setTimeout(run, 500);
  }
  if (previewReloadBtn) previewReloadBtn.addEventListener('click', function () { schedulePreviewUpdate(true); });
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

  /* ---- Sprites (galería de assets reemplazables) ---- */
  var assetGroupsEl = document.getElementById('gravityAssetGroups');
  var VARIANT_BASE_LABELS = { spike: 'pincho', saw: 'sierra', platform: 'plataforma', portal: 'portal', floor: 'piso' };
  function loadAssets() {
    fetch('/api/gravity-assets').then(function (r) { return r.json(); }).then(function (groups) {
      assetGroupsEl.innerHTML = groups.map(function (g) {
        var isVariantGroup = g.group.indexOf('Variantes') === 0;
        var addButtons = isVariantGroup ? Object.keys(VARIANT_BASE_LABELS).map(function (base) {
          return '<label class="gravity-add-variant-btn">+ Agregar ' + VARIANT_BASE_LABELS[base] + ' nuevo' +
            '<input type="file" accept="image/*" data-add-variant="' + base + '" hidden></label>';
        }).join('') : '';
        return '<div class="gravity-asset-group"><h3>' + g.group + '</h3>' + addButtons + '<div class="gravity-asset-grid">' +
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
      assetGroupsEl.querySelectorAll('input[data-add-variant]').forEach(function (input) {
        input.addEventListener('change', function () { uploadNewVariant(input); });
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
  function uploadNewVariant(input) {
    var file = input.files[0];
    if (!file) return;
    var base = input.getAttribute('data-add-variant');
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      fetch('/api/gravity-asset/add-variant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: base, dataBase64: base64 })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok) { window.alert('Error al agregar la variante: ' + res.error); return; }
        loadAssets(); // re-pinta la galería con la variante nueva ya incluida
        loadVariantCounts(); // y refresca los selectores del editor de niveles
      }).catch(function (e) { window.alert('Error al agregar la variante: ' + e.message); }).finally(function () {
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
    }).catch(function () {});
  }
  loadVariantCounts();
  loadLevelList();
})();
