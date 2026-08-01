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
  var FLOOR_VARIANT_COLORS = {
    v1: '#7a7b7d', v2: '#707384', v3: '#923dab', v4: '#205c95', v5: '#5b9918', v6: '#a14016',
    v7: '#795838', v8: '#888177', v9: '#816d4d', v10: '#33a0d5', v11: '#8c7d64', v12: '#9c3509',
    v13: '#98621b', v14: '#8b6d47', v15: '#978369', v16: '#ac4904', v17: '#279ace', v18: '#aa4103'
  };

  var OBJECT_TYPES = {
    spike: { label: 'Pincho', color: '#FF3D57', icon: '▲', anchor: 'surface', fields: ['surface', 'w', 'variant', 'rotation'], variantBase: 'spike', variantCount: 9 },
    saw: { label: 'Sierra', color: '#B983FF', icon: '⚙', anchor: 'surface', fields: ['surface', 'linkId', 'variant'], variantBase: 'saw', variantCount: 6 },
    platform: { label: 'Plataforma', color: '#3D8BFF', icon: '▬', anchor: 'surface', fields: ['surface', 'w', 'lift', 'lethal', 'moving', 'amp', 'periodMs', 'variant'], variantBase: 'platform', variantCount: 5 },
    gravityPortal: { label: 'Portal gravedad', color: '#B983FF', icon: '◐', anchor: 'full', fields: ['dir', 'variant'], variantBase: 'portal', variantCount: 12 },
    shapePortal: { label: 'Portal forma', color: '#7CF6FF', icon: '◇', anchor: 'full', fields: ['form', 'variant'], variantBase: 'portal', variantCount: 12 },
    orb: { label: 'Orbe', color: '#FFC93D', icon: '●', anchor: 'free', fields: ['color', 'y'] },
    pad: { label: 'Rampa', color: '#7CF6FF', icon: '^', anchor: 'surface', fields: ['surface', 'color'] },
    key: { label: 'Llave', color: '#FFC93D', icon: '🔑', anchor: 'free', fields: ['y'] },
    door: { label: 'Puerta', color: '#FF7A3D', icon: '▯', anchor: 'full', fields: ['x2'] },
    coin: { label: 'Moneda', color: '#FFC93D', icon: '◎', anchor: 'free', fields: ['id', 'y', 'risky'] },
    diamond: { label: 'Diamante', color: '#7CF6FF', icon: '♦', anchor: 'free', fields: ['y'] },
    interruptor: { label: 'Interruptor', color: '#7CF6FF', icon: '⊙', anchor: 'full', fields: ['linkId'] },
    finish: { label: 'Meta', color: '#7CFFB2', icon: '🏁', anchor: 'full', fields: [] }
  };
  var TOOL_ORDER = ['spike', 'saw', 'platform', 'gravityPortal', 'shapePortal', 'orb', 'pad', 'key', 'door', 'coin', 'diamond', 'interruptor', 'finish'];

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
    if (!def || !def.variantCount) { paletteVariantsEl.innerHTML = ''; return; }
    var html = '<span class="gravity-palette-variants-label">Molde de "' + def.label + '" a usar:</span><div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.toolVariant ? ' selected' : '') + '" data-variant="">Por defecto</button>';
    for (var vi = 1; vi <= def.variantCount; vi++) {
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
  var FLOOR_VARIANT_COUNT = 18;
  function renderFloorPicker() {
    if (!floorPickerEl) return;
    var html = '<div class="gravity-variant-swatches">';
    html += '<button type="button" class="gravity-variant-swatch' + (!state.floorVariant ? ' selected' : '') + '" data-floor="">Por defecto</button>';
    for (var vi = 1; vi <= FLOOR_VARIANT_COUNT; vi++) {
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
      state.selectedIndex = -1;
      levelSelect.value = id;
      renderSpeedList();
      renderFloorPicker();
      renderProps();
      render();
      setStatus('Cargado: ' + data.name + ' (' + data.objects.length + ' obstáculos)');
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
    if (state.toolVariant && OBJECT_TYPES[type] && OBJECT_TYPES[type].variantCount) obj.variant = state.toolVariant;
    return obj;
  }
  function countOf(type) { return state.objects.filter(function (o) { return o.type === type; }).length; }

  function objectDrawY(o) {
    var def = OBJECT_TYPES[o.type];
    if (!def) return MID_Y;
    if (o.type === 'platform') {
      var lift = o.lift || 0;
      return o.surface === 'ceil' ? CEIL_Y + lift : FLOOR_Y - lift;
    }
    if (def.anchor === 'surface') return o.surface === 'ceil' ? CEIL_Y + 20 : FLOOR_Y - 20;
    if (def.anchor === 'free') return (o.y != null ? o.y : MID_Y);
    return MID_Y;
  }

  function recomputeLength() {
    var maxX = 0;
    state.objects.forEach(function (o) { maxX = Math.max(maxX, o.x, o.x2 || 0); });
    state.length = Math.round(maxX + 300);
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
    if (state.floorVariant && FLOOR_VARIANT_COLORS[state.floorVariant]) {
      // Los bloques no son una textura sin costura -- se pinta una
      // franja continua con el color representativo del bloque
      // elegido, igual que en el juego real.
      ctx.fillStyle = FLOOR_VARIANT_COLORS[state.floorVariant];
      ctx.fillRect(0, floorCy, canvas.width, canvas.height - floorCy);
      ctx.fillRect(0, 0, canvas.width, ceilCy);
    } else {
      var floorImg = getSpriteImg('floor');
      if (floorImg.complete && floorImg.naturalWidth > 0) {
        var tileW = Math.max(18, 44 * state.zoom);
        for (var tx = 0; tx < canvas.width; tx += tileW) {
          ctx.drawImage(floorImg, tx, floorCy, tileW + 1, canvas.height - floorCy);
          ctx.save();
          ctx.translate(tx + tileW / 2, ceilCy);
          ctx.rotate(Math.PI);
          ctx.drawImage(floorImg, -tileW / 2, -ceilCy, tileW + 1, ceilCy);
          ctx.restore();
        }
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
        var sz = o.type === 'platform' ? 26 : (o.type === 'saw' ? 28 : 24);
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
      drag = { index: idx, freeY: OBJECT_TYPES[state.objects[idx].type].anchor === 'free', liftDraggable: state.objects[idx].type === 'platform' };
    } else {
      var obj = defaultObjectFor(state.tool, w.x, w.y);
      state.objects.push(obj);
      state.selectedIndex = state.objects.length - 1;
      drag = { index: state.selectedIndex, freeY: OBJECT_TYPES[obj.type].anchor === 'free', liftDraggable: obj.type === 'platform' };
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
    x2: 'Hasta x', linkId: 'Vínculo (linkId)', rotation: 'Rotación (°)', lethal: '¿Hace perder?'
  };
  function renderProps() {
    if (state.selectedIndex === -1) { propsEl.innerHTML = ''; return; }
    var o = state.objects[state.selectedIndex];
    var def = OBJECT_TYPES[o.type];
    if (!def) { propsEl.innerHTML = ''; return; }
    var html = '<div class="prop-row"><strong>' + def.icon + ' ' + def.label + '</strong> — x: ' + o.x + '</div>';
    if (def.variantCount) {
      html += '<div class="prop-row gravity-variant-row"><span>Aspecto</span><div class="gravity-variant-swatches">';
      html += '<button type="button" class="gravity-variant-swatch' + (!o.variant ? ' selected' : '') + '" data-variant="">Por defecto</button>';
      for (var vi = 1; vi <= def.variantCount; vi++) {
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
    return { id: state.levelId, objects: state.objects, length: state.length, speedZones: state.speedZones, floorVariant: state.floorVariant };
  }
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
  var assetsLoaded = false;
  function loadAssets() {
    if (assetsLoaded) return;
    assetsLoaded = true;
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
      assetGroupsEl.querySelectorAll('input[type="file"]').forEach(function (input) {
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

  loadLevelList();
})();
