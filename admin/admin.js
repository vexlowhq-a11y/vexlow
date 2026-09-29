(function () {
  var categories = [];
  var reactionsBySlug = {}; // { slug: {like, fire, dislike} } — traído del sitio en vivo, solo para mostrar en el listado
  // Corrección 2026-09-13 (bug real: "Ver" en un artículo en revisión abría
  // una página inexistente y devolvía 404). Verdad de si CADA artículo
  // tiene de verdad un HTML público generado en disco -- GET
  // /api/articles-html-status, { "categoria/slug": true|false }, calculado
  // en el servidor con fs.existsSync (nunca inferido de si el artículo
  // tiene texto cargado, que es justamente lo que causaba el bug). Se
  // guarda en un objeto aparte y NUNCA se mezcla dentro de articlesData/
  // los objetos de artículo -- si se pisara ahí, el próximo guardado
  // masivo (saveArticles() más abajo manda articlesData completo por
  // POST /api/articles) escribiría ese campo calculado directo en
  // data/articulos.json.
  var articleHtmlStatus = {};
  function articleHtmlKey(a) { return a.category + '/' + a.slug; }
  function hasRealHtml(a) { return !!articleHtmlStatus[articleHtmlKey(a)]; }
  // Se llama después de cargar el panel y después de cualquier operación
  // que pueda cambiar qué artículos tienen página real (guardar, borrar,
  // guardado masivo) -- nunca bloquea esas operaciones, solo refresca la
  // verdad para el próximo renderArticlesList().
  function refreshArticleHtmlStatus() {
    return getJSON('/api/articles-html-status').then(function (data) {
      articleHtmlStatus = data || {};
      renderArticlesList();
    }).catch(function () { /* si falla, se sigue con lo que ya había en memoria */ });
  }
  var heroData = [];
  var articlesData = [];
  // Revisión actual de data/articulos.json tal como la vio esta pestaña
  // (post-incidente 2026-09-13, ver admin/articles-store.js). Se actualiza
  // al cargar y después de cada guardado exitoso; se manda como header
  // If-Match en cada POST /api/articles -- si el servidor tiene una
  // revisión distinta (otra pestaña guardó primero), responde 409 y el
  // guardado se aborta en vez de pisarlo en silencio.
  var articlesRev = null;
  var draftsData = [];
  var heroEditIndex = null;
  var articleEditIndex = null;
  var pendingDraft = null; // { slug, sourceUrl, sourceTitle, similarityWarning, similarityScore, genericHeadingWarning } cuando el artículo en el formulario viene de un borrador
  // Candado de guardado en curso (incidente 2026-09-13, "146 con Moonshot
  // repetido ~5 veces"): el usuario pulsó "Guardar" varias veces porque el
  // panel estaba lento, y cada clic disparaba un envío independiente y
  // superpuesto (ni el submit del <form> ni "Guardar como borrador
  // incompleto" deshabilitaban el botón antes de esperar la respuesta).
  // Este flag se pone en true de forma SÍNCRONA al primer clic/Enter y
  // bloquea cualquier otro intento hasta que el guardado en curso termine
  // (éxito o error) -- ver setArticleSaveInFlight() más abajo.
  var articleSaveInFlight = false;

  // Genera una clave de idempotencia nueva por cada intento de guardado
  // real (persistArticleEdit) -- viaja como header X-Idempotency-Key en
  // el PUT. Si por lo que sea la misma petición HTTP se entrega dos veces
  // a nivel de red (reintento del navegador, proxy, etc.), la clave llega
  // idéntica las dos veces y admin/server.js devuelve la respuesta que ya
  // había calculado la primera vez, sin duplicar nada.
  function generateIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  var imageLicensesInfo = { authorized: [], requiringAttribution: [] }; // GET /api/image-licenses -- fuente única de verdad (admin/image-licenses.js), no se duplica acá la lista

  // Espejo mínimo, SOLO PARA UI (precargar el <select> al editar), de
  // effectiveStatus() en admin/article-status.js -- el servidor es quien
  // de verdad decide el estado efectivo de un artículo al guardar
  // (server.js / pipeline.js), esto acá nunca bloquea ni valida nada.
  var EDITORIAL_STATUSES = ['draft', 'review', 'approved', 'published', 'redirected'];
  function clientEffectiveStatus(a) {
    if (a && EDITORIAL_STATUSES.indexOf(a.status) !== -1) return a.status;
    if (a && a.draftIncomplete) return 'draft';
    return 'published';
  }

  /* ---- Publicar cambios en internet (git add + commit + push) ---- */
  var deployBtn = document.getElementById('deployBtn');
  deployBtn.addEventListener('click', function () {
    deployBtn.disabled = true;
    var originalText = deployBtn.textContent;
    deployBtn.textContent = 'Publicando… (puede tardar un minuto)';
    postJSON('/api/deploy', {}).then(function (result) {
      deployBtn.disabled = false;
      deployBtn.textContent = originalText;
      if (result.nothingToCommit) {
        toast('No había cambios nuevos para publicar');
      } else {
        toast('¡Listo! Los cambios ya se subieron — el sitio se va a actualizar en unos minutos.');
      }
    }).catch(function (err) {
      deployBtn.disabled = false;
      deployBtn.textContent = originalText;
      // Protección permanente del panel, sección 7: npm run validate:publish
      // corre ANTES de cualquier git add/commit/push (ver admin/deploy.js) --
      // si algo crítico falla, acá llega el detalle completo (blockedByValidation)
      // en vez del genérico "no se pudo publicar".
      var body = err && err.body;
      if (body && body.blockedByValidation) {
        console.error('validate:publish bloqueó la publicación:\n' + body.output);
        toast('🚫 Publicación bloqueada: hay un control crítico de validate:publish sin resolver. Detalle completo en la consola del navegador (F12).', true);
      } else {
        toast((err && err.message) || 'No se pudo publicar los cambios', true);
      }
    });
  });

  /* ---- Tabs ---- */
  document.querySelectorAll('.admin-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.admin-tab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.admin-panel').forEach(function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('panel-' + tab.getAttribute('data-tab')).classList.add('active');
    });
  });

  /* ---- Toast ---- */
  var toastEl = document.getElementById('adminToast');
  var toastTimer = null;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'admin-toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  /* ---- API helpers ---- */
  function getJSON(url) {
    return fetch(url).then(function (r) { return r.json(); });
  }
  // Captura el header ETag de la respuesta además del cuerpo -- lo usa la
  // carga inicial de /api/articles para conocer la revisión de arranque de
  // esta pestaña.
  function getJSONWithRev(url) {
    return fetch(url).then(function (r) {
      var rev = (r.headers.get('ETag') || '').replace(/^"|"$/g, '') || null;
      return r.json().then(function (body) { return { body: body, rev: rev }; });
    });
  }
  function apiRequest(method, url, data, extraHeaders, signal) {
    var headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    var fetchOpts = {
      method: method,
      headers: headers,
      body: JSON.stringify(data)
    };
    if (signal) fetchOpts.signal = signal;
    return fetch(url, fetchOpts).then(function (r) {
      var rev = (r.headers.get('ETag') || '').replace(/^"|"$/g, '') || null;
      return r.json().catch(function () { return null; }).then(function (body) {
        if (!r.ok) {
          // 409: la pestaña quedó desactualizada respecto de lo que hay en
          // el servidor (otra pestaña guardó primero, o -- guardado masivo
          // -- el intento reduciría el conjunto de artículos, algo que ya
          // no se permite por esta vía). Mensaje fijo y claro, tal como se
          // pidió, sin tapar el detalle estructurado (útil para debug).
          var message;
          if (r.status === 409 && body && body.error === 'revision_conflict') {
            message = 'El contenido cambió en otra pestaña. Recarga antes de guardar.';
          } else if (r.status === 409 && body && body.error === 'reduccion_no_permitida') {
            message = 'Este guardado eliminaría ' + ((body.wouldRemove && body.wouldRemove.length) || '?') + ' artículo(s) existentes -- un guardado normal nunca borra artículos. Usá "Eliminar" en cada uno si de verdad querés borrarlos.';
          } else {
            message = (body && body.message) || (body && body.error) || 'Error al guardar';
          }
          var err = new Error(message);
          // Detalle estructurado (fase 3/5, control de publicación, y ahora
          // también conflicto de revisión/reducción): server.js devuelve,
          // además del mensaje, datos propios de cada tipo de rechazo -- se
          // conserva acá para que el formulario lo pueda mostrar con detalle
          // en vez de solo el toast genérico.
          err.body = body;
          err.status = r.status;
          throw err;
        }
        if (rev) articlesRev = rev;
        return body;
      });
    });
  }
  function postJSON(url, data, signal) {
    // Manda siempre la revisión conocida de artículos como If-Match cuando
    // el destino es /api/articles (guardado masivo) -- para cualquier otro
    // endpoint (hero, categorías, drafts) no aplica y no se manda.
    var headers = (url === '/api/articles' && articlesRev) ? { 'If-Match': articlesRev } : {};
    return apiRequest('POST', url, data, headers, signal);
  }
  function deleteJSON(url, data) {
    return apiRequest('DELETE', url, data);
  }
  // Alta/edición de UN solo artículo -- admin/server.js
  // PUT /api/articles/:category/:slug -- nunca reemplaza el array completo,
  // así que una pestaña con articlesData desactualizado en OTROS artículos
  // no puede arrastrarlos al guardar este. idemKey (incidente 2026-09-13):
  // ver generateIdempotencyKey() -- se manda como X-Idempotency-Key para
  // que una entrega de red duplicada de esta misma petición no pueda crear
  // ni actualizar dos veces.
  function putArticle(category, slug, article, idemKey) {
    var headers = idemKey ? { 'X-Idempotency-Key': idemKey } : {};
    return apiRequest('PUT', '/api/articles/' + encodeURIComponent(category) + '/' + encodeURIComponent(slug), article, headers);
  }
  // Borrado explícito y confirmado de UN artículo -- admin/server.js
  // DELETE /api/articles/:category/:slug. Va a papelera (recuperable), el
  // HTML se mueve en vez de borrarse. Exige mandar título+slug exactos --
  // el panel ya los mostró en el confirm() de más abajo.
  function deleteArticleConfirmed(category, slug, title) {
    return apiRequest('DELETE', '/api/articles/' + encodeURIComponent(category) + '/' + encodeURIComponent(slug), { confirmTitle: title, confirmSlug: slug });
  }

  function categoryMeta(slug) {
    return categories.find(function (c) { return c.slug === slug; }) || { slug: slug, label: slug, icon: '📰' };
  }
  // Categorías ofrecidas para escribir contenido NUEVO (auditoria
  // 2026-09-12): Sports y Entertainment (retiredForNewContent en
  // data/categories.json) dejan de aparecer acá -- no se ofrecen para
  // notas nuevas ni en el buscador de temas -- pero conservan sus
  // artículos existentes intactos. Mismo criterio, mismo nombre en
  // espíritu, que CATEGORIES_ACCEPTING_NEW_CONTENT en
  // admin/generate_pages.py y categoriesAcceptingNewContent() en
  // admin/pagegen.js.
  function contentCategories() {
    return categories.filter(function (c) { return c.slug !== 'trending' && !c.retiredForNewContent; });
  }
  // Todas las categorías de contenido (sin filtrar retiredForNewContent),
  // para superficies de solo LECTURA/navegación del panel -- ej. el
  // filtro "ver artículos de esta categoría" -- donde Sports/Entertainment
  // tienen que seguir apareciendo: sus artículos existentes siguen ahí,
  // solo dejaron de ofrecerse para escribir contenido nuevo (ver
  // contentCategories() arriba, que sí las excluye).
  function allNonTrendingCategories() {
    return categories.filter(function (c) { return c.slug !== 'trending'; });
  }

  function fillSelect(select, list, valueKey, labelFn) {
    select.innerHTML = '';
    list.forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = item[valueKey];
      opt.textContent = labelFn(item);
      select.appendChild(opt);
    });
  }

  // Protección contra corrupción silenciosa de categoría (auditoria
  // 2026-09-12): desde que contentCategories() ya no incluye Sports ni
  // Entertainment, un <select> lleno solo con esa lista no tiene ninguna
  // <option> que matchee un artículo/hero YA EXISTENTE en una de esas
  // categorías retiradas -- en varios navegadores, asignar .value a algo
  // que no está entre las opciones deja el <select> mostrando la PRIMERA
  // opción de la lista sin avisar, y si el usuario guarda sin fijarse, la
  // categoría del artículo se pisa silenciosamente por la que quedó
  // seleccionada. Esta función inyecta (una sola vez, si hace falta) una
  // <option> para la categoría real del artículo/hero que se está
  // editando -- marcada "(retired)" para que quede claro en el panel que
  // ya no se ofrece para contenido nuevo -- ANTES de asignar select.value,
  // así editar una nota vieja de Sports/Entertainment siempre conserva su
  // categoría real salvo que el usuario la cambie a propósito.
  function ensureCategoryOption(select, slug) {
    if (!slug) return;
    var already = Array.prototype.some.call(select.options, function (o) { return o.value === slug; });
    if (already) return;
    var meta = categoryMeta(slug);
    var opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = meta.icon + ' ' + meta.label + ' (retired)';
    select.appendChild(opt);
  }

  /* =====================================================
     HERO
     ===================================================== */
  var heroList = document.getElementById('heroList');
  var heroForm = document.getElementById('heroForm');
  var heroFormTitle = document.getElementById('heroFormTitle');
  var heroCategory = document.getElementById('heroCategory');
  var heroTitleInput = document.getElementById('heroTitleInput');
  var heroDekInput = document.getElementById('heroDekInput');
  var heroImageUpload = document.getElementById('heroImageUpload');
  var heroImageStatus = document.getElementById('heroImageStatus');
  var heroImageRemoveBtn = document.getElementById('heroImageRemoveBtn');
  var heroColorPalette = document.getElementById('heroColorPalette');
  var heroHrefInput = document.getElementById('heroHrefInput');
  var heroCancelBtn = document.getElementById('heroCancelBtn');

  var heroCurrentImage = '';
  var heroCurrentColor = 'auto';

  var COLOR_PALETTE = [
    { value: 'auto', label: 'Automático (según el brillo de la imagen)' },
    { value: '#ffffff', label: 'Blanco' },
    { value: '#3D8BFF', label: 'Azul VexlowHQ' },
    { value: '#FFB020', label: 'Naranja VexlowHQ' },
    { value: '#0E1116', label: 'Navy oscuro' }
  ];

  function renderColorPalette() {
    heroColorPalette.innerHTML = '';
    COLOR_PALETTE.forEach(function (c) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch' + (c.value === 'auto' ? ' auto' : '') + (heroCurrentColor === c.value ? ' selected' : '');
      btn.title = c.label;
      if (c.value !== 'auto') btn.style.background = c.value;
      btn.addEventListener('click', function () {
        heroCurrentColor = c.value;
        renderColorPalette();
      });
      heroColorPalette.appendChild(btn);
    });
  }
  renderColorPalette();

  function updateHeroImageStatus() {
    heroImageStatus.textContent = heroCurrentImage
      ? 'Imagen actual: ' + heroCurrentImage.replace(/^img\//, '')
      : 'Sin imagen (usa el color de la categoría).';
    heroImageRemoveBtn.hidden = !heroCurrentImage;
  }
  updateHeroImageStatus();

  heroImageUpload.addEventListener('change', function () {
    var file = heroImageUpload.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      heroImageStatus.textContent = 'Subiendo imagen…';
      postJSON('/api/upload-image', {
        category: heroCategory.value,
        filename: file.name,
        dataBase64: base64
      }).then(function (result) {
        heroCurrentImage = result.path;
        updateHeroImageStatus();
        toast('Imagen subida');
      }).catch(function (err) {
        updateHeroImageStatus();
        toast(err.message || 'No se pudo subir la imagen', true);
      }).finally(function () {
        heroImageUpload.value = '';
      });
    };
    reader.readAsDataURL(file);
  });
  heroImageRemoveBtn.addEventListener('click', function () {
    heroCurrentImage = '';
    updateHeroImageStatus();
  });

  function renderHeroList() {
    heroList.innerHTML = '';
    if (heroData.length === 0) {
      heroList.innerHTML = '<div class="admin-empty">Todavía no hay diapositivas.</div>';
      return;
    }
    heroData.forEach(function (slide, i) {
      var meta = categoryMeta(slide.category);
      var row = document.createElement('div');
      row.className = 'admin-item';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (slide.image) {
        thumb.style.backgroundImage = "url('/site/" + slide.image + "')";
      } else {
        thumb.textContent = meta.icon;
        thumb.style.background = 'var(--surface-2)';
      }

      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="ttl"></div><div class="meta"></div>';
      info.querySelector('.ttl').textContent = slide.title;
      info.querySelector('.meta').textContent = meta.icon + ' ' + meta.label + (slide.image ? ' · con imagen' : ' · color de fondo');

      var order = document.createElement('div');
      order.className = 'order-controls';
      var up = document.createElement('button');
      up.type = 'button'; up.textContent = '▲'; up.title = 'Subir';
      up.disabled = i === 0;
      up.addEventListener('click', function () { moveHero(i, -1); });
      var down = document.createElement('button');
      down.type = 'button'; down.textContent = '▼'; down.title = 'Bajar';
      down.disabled = i === heroData.length - 1;
      down.addEventListener('click', function () { moveHero(i, 1); });
      order.appendChild(up);
      order.appendChild(down);

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      var editBtn = document.createElement('button');
      editBtn.type = 'button'; editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', function () { startEditHero(i); });
      var delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.textContent = 'Eliminar'; delBtn.className = 'danger';
      delBtn.addEventListener('click', function () { deleteHero(i); });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(order);
      row.appendChild(actions);
      heroList.appendChild(row);
    });
  }

  function moveHero(index, dir) {
    var target = index + dir;
    if (target < 0 || target >= heroData.length) return;
    var tmp = heroData[index];
    heroData[index] = heroData[target];
    heroData[target] = tmp;
    saveHero('Orden actualizado');
  }

  function startEditHero(i) {
    heroEditIndex = i;
    var s = heroData[i];
    heroFormTitle.textContent = 'Editar diapositiva';
    ensureCategoryOption(heroCategory, s.category);
    heroCategory.value = s.category;
    heroTitleInput.value = s.title;
    heroDekInput.value = s.dek;
    heroCurrentImage = s.image || '';
    updateHeroImageStatus();
    heroCurrentColor = s.textColor || 'auto';
    renderColorPalette();
    heroHrefInput.value = s.href || '';
    heroCancelBtn.hidden = false;
    heroForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetHeroForm() {
    heroEditIndex = null;
    heroForm.reset();
    heroCurrentImage = '';
    updateHeroImageStatus();
    heroCurrentColor = 'auto';
    renderColorPalette();
    heroFormTitle.textContent = 'Agregar diapositiva';
    heroCancelBtn.hidden = true;
  }
  heroCancelBtn.addEventListener('click', resetHeroForm);

  heroCategory.addEventListener('change', function () {
    if (heroEditIndex !== null) return;
    var meta = categoryMeta(heroCategory.value);
    if (!heroHrefInput.value || heroHrefInput.dataset.auto !== 'false') {
      heroHrefInput.value = meta.slug + '/index.html';
      heroHrefInput.dataset.auto = 'true';
    }
  });
  heroHrefInput.addEventListener('input', function () { heroHrefInput.dataset.auto = 'false'; });

  function deleteHero(i) {
    if (!confirm('¿Eliminar esta diapositiva del carrusel?')) return;
    heroData.splice(i, 1);
    saveHero('Diapositiva eliminada');
  }

  function saveHero(successMsg) {
    return postJSON('/api/hero', heroData).then(function () {
      renderHeroList();
      toast(successMsg || 'Guardado');
    }).catch(function () {
      toast('No se pudo guardar. ¿Está corriendo el panel?', true);
    });
  }

  heroForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var meta = categoryMeta(heroCategory.value);
    var slide = {
      category: heroCategory.value,
      chip: meta.icon + ' ' + meta.label,
      title: heroTitleInput.value.trim(),
      dek: heroDekInput.value.trim(),
      image: heroCurrentImage,
      textColor: heroCurrentColor,
      href: heroHrefInput.value.trim() || (heroCategory.value + '/index.html')
    };
    if (heroEditIndex !== null) {
      heroData[heroEditIndex] = slide;
    } else {
      heroData.push(slide);
    }
    saveHero(heroEditIndex !== null ? 'Diapositiva actualizada' : 'Diapositiva agregada').then(resetHeroForm);
  });

  /* =====================================================
     ARTICLES
     ===================================================== */
  var articlesList = document.getElementById('articlesList');
  var articleForm = document.getElementById('articleForm');
  var articleFormTitle = document.getElementById('articleFormTitle');
  var articleStatus = document.getElementById('articleStatus');
  var articleRedirectToWrap = document.getElementById('articleRedirectToWrap');
  var articleRedirectTo = document.getElementById('articleRedirectTo');
  var articleEditorialApproval = document.getElementById('articleEditorialApproval');
  var articleEditorialApprovalWrap = document.getElementById('articleEditorialApprovalWrap');
  var articleChecklistList = document.getElementById('articleChecklistList');
  var articleWarningsBox = document.getElementById('articleWarningsBox');
  var articleSubmitBtn = document.getElementById('articleSubmitBtn');
  var articleCategory = document.getElementById('articleCategory');
  var articlePreviewLink = document.getElementById('articlePreviewLink');
  var articleDate = document.getElementById('articleDate');
  var articleTitle = document.getElementById('articleTitle');
  var articleSlug = document.getElementById('articleSlug');
  var articleDek = document.getElementById('articleDek');
  var articleReadTime = document.getElementById('articleReadTime');
  var articleTrending = document.getElementById('articleTrending');
  var articleNoindex = document.getElementById('articleNoindex');
  var articleNoindexReason = document.getElementById('articleNoindexReason');
  var articleUpdatedDate = document.getElementById('articleUpdatedDate');
  var articleCorrectionNote = document.getElementById('articleCorrectionNote');
  var articleEditorialStatus = document.getElementById('articleEditorialStatus');
  var articleImageUpload = document.getElementById('articleImageUpload');
  var articleImageStatus = document.getElementById('articleImageStatus');
  var articleImageRemoveBtn = document.getElementById('articleImageRemoveBtn');
  var articleImagePreviewWrap = document.getElementById('articleImagePreviewWrap');
  var articleImagePreviewImg = document.getElementById('articleImagePreviewImg');
  var articleImagePreviewInfo = document.getElementById('articleImagePreviewInfo');
  var articleImageOrigin = document.getElementById('articleImageOrigin');
  var articleImageLicense = document.getElementById('articleImageLicense');
  var articleImageCredit = document.getElementById('articleImageCredit');
  var articleImageAiFields = document.getElementById('articleImageAiFields');
  var articleImageTool = document.getElementById('articleImageTool');
  var articleImageModel = document.getElementById('articleImageModel');
  var articleImageGeneratedAt = document.getElementById('articleImageGeneratedAt');
  var articleImagePrompt = document.getElementById('articleImagePrompt');
  var articleImageHumanEdited = document.getElementById('articleImageHumanEdited');
  var articleImageOwnerAttestation = document.getElementById('articleImageOwnerAttestation');
  var articleImageAttributionFields = document.getElementById('articleImageAttributionFields');
  var articleImageSource = document.getElementById('articleImageSource');
  var articleImageSourceUrlInput = document.getElementById('articleImageSourceUrlInput');
  var articleImageReuseAuthorized = document.getElementById('articleImageReuseAuthorized');
  var articleSaveDraftBtn = document.getElementById('articleSaveDraftBtn');
  var articleValidationErrors = document.getElementById('articleValidationErrors');
  var articleVideoUrl = document.getElementById('articleVideoUrl');
  // Fase 10 -- corrección real (2026-09-20): el formulario no tenía NINGÚN
  // campo para sourceUrl/sourceTitle/additionalSources, así que
  // buildArticleFromForm() nunca los conocía al reabrir un artículo YA
  // guardado (solo se copiaban del `pendingDraft` en el caso puntual de
  // "Usar este borrador" recién traído de RSS). Eso hacía que el checklist
  // en vivo mostrara "falta sourceUrl" apenas se abría CUALQUIER artículo
  // real para editar (aunque el archivo en disco sí lo tuviera), y que
  // guardar esa edición lo borrara de verdad: PUT /api/articles/:cat/:slug
  // reemplaza el registro entero con lo que mande el formulario (ver
  // articles-store.upsertArticle). Ver también el merge seguro agregado en
  // articles-store.js como segunda red para cualquier campo que ni así
  // tenga control visible en el formulario (ej. topic/subtopic).
  var articleSourceUrl = document.getElementById('articleSourceUrl');
  var articleSourceTitle = document.getElementById('articleSourceTitle');
  var articleAdditionalSourcesList = document.getElementById('articleAdditionalSourcesList');
  var articleAddSourceBtn = document.getElementById('articleAddSourceBtn');
  var articleCheckSourceBtn = document.getElementById('articleCheckSourceBtn');
  var articleCheckSourceStatus = document.getElementById('articleCheckSourceStatus');
  var articleQuickReviewCard = document.getElementById('articleQuickReviewCard');
  var articleQuickReviewBody = document.getElementById('articleQuickReviewBody');
  // Procedencia completa (mejora global 2026-09-20, requisito 1) de la
  // fuente actualmente cargada en el formulario -- no tiene control propio
  // (sourceHeadline/sourceAuthor/sourcePublishedAt/sourceRetrievedAt/
  // keyClaims no son campos editables, son metadatos que ya trajo la
  // RSS/IA) así que viaja por acá igual que sourceCount/similarityWarning
  // en pendingDraft, y buildArticleFromForm() los reinyecta tal cual al
  // guardar para que sobrevivan la edición (nunca se pierden ni se
  // regeneran solos).
  var currentSourceProvenance = {};
  var articleBody = document.getElementById('articleBody');
  var inlineImageUpload = document.getElementById('inlineImageUpload');
  var inlineImageBtn = document.getElementById('inlineImageBtn');
  var inlineImageStatus = document.getElementById('inlineImageStatus');
  var articleCurrentImage = '';
  var articleCancelBtn = document.getElementById('articleCancelBtn');
  var regenerateBtn = document.getElementById('regenerateBtn');
  var filterName = document.getElementById('filterName');
  var filterCategory = document.getElementById('filterCategory');
  var filterTrendingOnly = document.getElementById('filterTrendingOnly');
  var filterSort = document.getElementById('filterSort');
  var filterCount = document.getElementById('filterCount');

  function slugify(title) {
    return (title || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }
  articleTitle.addEventListener('input', function () {
    if (articleSlug.dataset.auto === 'false') return;
    articleSlug.value = slugify(articleTitle.value);
    articleSlug.dataset.auto = 'true';
  });
  articleSlug.addEventListener('input', function () { articleSlug.dataset.auto = 'false'; });

  function articleHrefFor(a) {
    if (a.body && a.body.trim()) return 'categoria/' + a.category + '/' + a.slug + '.html';
    return 'categoria/' + a.category + '/index.html';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clearArticleValidationErrors() {
    articleValidationErrors.hidden = true;
    articleValidationErrors.innerHTML = '';
  }

  // Muestra el detalle campo por campo que devuelve el servidor cuando
  // POST /api/articles responde 422 (fase 3/5: control de publicación) --
  // err.body = {ok:false, error, message, blocked:[{slug,title,issues:[{field,message}]}]}.
  function renderArticleValidationErrors(err) {
    var body = err && err.body;
    if (!body || !Array.isArray(body.blocked) || !body.blocked.length) {
      clearArticleValidationErrors();
      return;
    }
    var html = '<strong>' + escapeHtml(body.message || 'No se guardó: hay artículos que no pasan los controles de publicación.') + '</strong>';
    body.blocked.forEach(function (b) {
      html += '<div style="margin-top:8px;"><strong>' + escapeHtml(b.title || b.slug) + '</strong> <span style="opacity:.7;">(' + escapeHtml(b.slug) + ')</span><ul style="margin:4px 0 0 18px;padding:0;">';
      (b.issues || []).forEach(function (issue) {
        html += '<li>' + (issue.field ? '<code>' + escapeHtml(issue.field) + '</code>: ' : '') + escapeHtml(issue.message) + '</li>';
      });
      html += '</ul></div>';
    });
    articleValidationErrors.innerHTML = html;
    articleValidationErrors.hidden = false;
    articleValidationErrors.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* =====================================================
     CHECKLIST EN VIVO (fase 9 -- protección permanente del panel)
     =====================================================
     Corre /api/validate-article -- que del lado del servidor llama a la
     MISMA runPrePublishValidation que usa el guardado real (ver
     server.js) -- cada vez que cambia algo relevante del formulario, y
     pinta un checklist de 7 puntos: Contenido, Fuentes, Imagen/licencia,
     SEO, Indexación, Riesgo editorial, Estado de aprobación. Es una
     VISTA PREVIA, nunca el gate real: si este chequeo no llegó a correr
     (red lenta, panel recién abierto) el botón puede quedar habilitado,
     pero el guardado real (POST /api/articles) igual va a responder 422
     si el artículo no cumple -- el checklist nunca puede ser la única
     defensa, solo ahorra el ida y vuelta de intentar guardar para
     enterarse.
  */
  var CHECKLIST_BUCKETS = [
    { key: 'content', label: 'Contenido' },
    { key: 'sources', label: 'Fuentes' },
    { key: 'image', label: 'Imagen / licencia' },
    { key: 'seo', label: 'SEO' },
    { key: 'indexing', label: 'Indexación' },
    { key: 'risk', label: 'Riesgo editorial' },
    { key: 'approval', label: 'Estado de aprobación' }
  ];

  function checklistBucketForField(field) {
    if (field === 'status' || field === 'editorialApproval') return 'approval';
    if (field === 'redirectTo' || field === 'noindex') return 'indexing';
    if (field === 'slug') return 'seo';
    if (field && field.indexOf('image') === 0) return 'image';
    if (field === 'sourceUrl' || field === 'sourceTitle' || field === 'additionalSources') return 'sources';
    return 'content'; // title, dek, author, date, category, body
  }

  var lastValidation = { issues: [], warnings: [] };
  var validationRequestSeq = 0;

  function renderChecklist() {
    var buckets = {};
    CHECKLIST_BUCKETS.forEach(function (b) { buckets[b.key] = { issues: [], warnings: [] }; });
    (lastValidation.issues || []).forEach(function (issue) {
      buckets[checklistBucketForField(issue.field)].issues.push(issue);
    });
    (lastValidation.warnings || []).forEach(function (w) {
      buckets.risk.warnings.push(w);
    });
    // Auditoría 2026-09-13 (prueba manual real del panel): "Estado de
    // aprobación" aparecía en verde con la casilla de revisión humana
    // desmarcada, solo porque el status elegido (ej. "En revisión") todavía
    // no le exige a validateEditorialWorkflow esa confirmación -- eso es
    // correcto como GATE real (no hace falta tildarla para guardar un
    // borrador en revisión), pero como VISTA PREVIA es engañoso: parece
    // "ya aprobado" cuando nadie confirmó nada todavía. Acá se fuerza a
    // rojo cada vez que la casilla está desmarcada, sea cual sea el status
    // -- esto es SOLO presentación (no toca lastValidation.issues, que es
    // lo único que usa updateSubmitButtonState/el 422 real), así que
    // seguís pudiendo guardar un borrador/revisión sin tildarla; lo único
    // que cambia es que el ícono nunca miente diciendo "aprobado".
    if (!articleEditorialApproval.checked) {
      buckets.approval.issues.push({ field: 'editorialApproval', message: 'Todavía no se tildó "He revisado las fuentes, los derechos de imagen y la exactitud del artículo" -- no está aprobado.' });
    }
    articleChecklistList.innerHTML = '';
    CHECKLIST_BUCKETS.forEach(function (b) {
      var bucket = buckets[b.key];
      var li = document.createElement('li');
      li.style.margin = '2px 0';
      var icon = bucket.issues.length ? '❌' : (bucket.warnings.length ? '⚠️' : '✅');
      var text = escapeHtml(b.label);
      var details = bucket.issues.concat(bucket.warnings).map(function (x) { return escapeHtml(x.message); });
      if (details.length) text += ' — ' + details.join(' · ');
      li.innerHTML = icon + ' ' + text;
      articleChecklistList.appendChild(li);
    });
    var warnItems = lastValidation.warnings || [];
    if (warnItems.length) {
      articleWarningsBox.innerHTML = '<strong>Riesgo editorial (no bloquea el guardado, pero conviene revisar antes de aprobar):</strong><ul style="margin:4px 0 0 18px;padding:0;">' +
        warnItems.map(function (w) { return '<li>' + escapeHtml(w.message) + '</li>'; }).join('') + '</ul>';
      articleWarningsBox.hidden = false;
    } else {
      articleWarningsBox.hidden = true;
    }
    renderQuickReviewCard();
    updateSubmitButtonState();
  }

  function updateSubmitButtonState() {
    var hasBlockingIssues = (lastValidation.issues || []).length > 0;
    // Mientras hay un guardado en curso, el candado de más abajo manda --
    // no reactivar el botón solo porque cambió la validación en vivo.
    if (articleSaveInFlight) return;
    articleSubmitBtn.disabled = hasBlockingIssues;
    articleSubmitBtn.title = hasBlockingIssues
      ? 'Hay errores que bloquean la publicación -- revisá el checklist de arriba.'
      : '';
  }

  // Candado de guardado en curso (incidente 2026-09-13, "146 con Moonshot
  // repetido ~5 veces"): se activa de forma SÍNCRONA en cuanto el usuario
  // pulsa "Guardar"/"Guardar como borrador incompleto" -- ANTES de esperar
  // ninguna respuesta de red -- así un segundo clic, un Enter repetido o
  // un envío del <form> disparado dos veces no puede iniciar un segundo
  // guardado superpuesto mientras el primero sigue en curso. Se libera
  // recién cuando la petición termina (éxito o error), y en ese momento
  // updateSubmitButtonState() vuelve a mandar según la validación real.
  var articleSubmitBtnDefaultText = articleSubmitBtn.textContent;
  var articleSaveDraftBtnDefaultText = articleSaveDraftBtn.textContent;
  function setArticleSaveInFlight(inFlight) {
    articleSaveInFlight = inFlight;
    if (inFlight) {
      articleSubmitBtn.disabled = true;
      articleSubmitBtn.textContent = 'Guardando…';
      articleSubmitBtn.setAttribute('aria-disabled', 'true');
      articleSaveDraftBtn.disabled = true;
      articleSaveDraftBtn.textContent = 'Guardando…';
      articleSaveDraftBtn.setAttribute('aria-disabled', 'true');
    } else {
      articleSubmitBtn.textContent = articleSubmitBtnDefaultText;
      articleSaveDraftBtn.textContent = articleSaveDraftBtnDefaultText;
      articleSaveDraftBtn.disabled = false;
      articleSaveDraftBtn.removeAttribute('aria-disabled');
      articleSubmitBtn.removeAttribute('aria-disabled');
      updateSubmitButtonState(); // restaura el disabled real según lastValidation.issues
    }
  }

  function resetChecklist() {
    lastValidation = { issues: [], warnings: [] };
    renderChecklist();
  }

  var validationDebounceTimer = null;
  // Incidente 2026-09-13 (diagnóstico de lentitud): además del debounce de
  // 500ms que ya existía, se cancela de verdad (AbortController) la
  // petición de validación anterior cuando llega una tecla nueva -- antes
  // solo se ignoraba la RESPUESTA vieja (validationRequestSeq, se
  // conserva como red de seguridad si el navegador no soporta abort), pero
  // la petición vieja seguía viajando y consumiendo el servidor de fondo.
  var validationAbortController = null;
  function scheduleLiveValidation() {
    clearTimeout(validationDebounceTimer);
    if (validationAbortController) {
      try { validationAbortController.abort(); } catch (e) { /* no crítico */ }
      validationAbortController = null;
    }
    validationDebounceTimer = setTimeout(runLiveValidation, 500);
  }

  function runLiveValidation() {
    var article = buildArticleFromForm();
    article.status = articleStatus.value;
    if (article.status === 'redirected') article.redirectTo = articleRedirectTo.value.trim();
    article.editorialApproval = articleEditorialApproval.checked;
    if (!article.slug) { resetChecklist(); return; }

    var nextData = articlesData.slice();
    if (articleEditIndex !== null) {
      nextData[articleEditIndex] = article;
    } else {
      // Artículo nuevo todavía sin guardar -- se agrega a una copia para
      // que isArticleNewOrChanged() del servidor lo detecte como "nuevo"
      // y el chequeo de slug/similaridad duplicados se calcule contra el
      // resto de artículos reales.
      nextData = nextData.concat([article]);
    }
    var seq = ++validationRequestSeq;
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    validationAbortController = controller;
    postJSON('/api/validate-article', { articles: nextData, slug: article.slug }, controller ? controller.signal : undefined).then(function (result) {
      if (seq !== validationRequestSeq) return; // respuesta vieja llegada después de una más nueva -- se descarta
      lastValidation = { issues: (result && result.issues) || [], warnings: (result && result.warnings) || [] };
      renderChecklist();
    }).catch(function () {
      // Si el chequeo en vivo falla (panel recién arrancando, red, cancelado
      // por un abort de arriba, etc.) no hay que bloquear el formulario --
      // POST/PUT /api/articles sigue siendo el gate de verdad y va a
      // responder 422 igual si hace falta.
    });
  }

  function updateStatusFieldsVisibility() {
    articleRedirectToWrap.hidden = articleStatus.value !== 'redirected';
  }
  articleStatus.addEventListener('change', updateStatusFieldsVisibility);
  articleForm.addEventListener('input', scheduleLiveValidation);
  articleForm.addEventListener('change', scheduleLiveValidation);

  function updateArticleImageStatus() {
    articleImageStatus.textContent = articleCurrentImage
      ? 'Imagen actual: ' + articleCurrentImage.replace(/^img\//, '')
      : 'Sin imagen (usa el ícono de la categoría).';
    articleImageRemoveBtn.hidden = !articleCurrentImage;
    updateArticleImagePreview();
  }

  /* Vista previa de la imagen destacada: dimensiones, formato y peso --
     Fase 4 (formulario del panel). Se apoya en el propio navegador (el
     Image() de abajo) para dimensiones/formato y en una petición HEAD
     al mismo archivo servido por el panel para el peso, así que no hace
     falta que el servidor devuelva nada extra en /api/upload-image. */
  function updateArticleImagePreview() {
    if (!articleCurrentImage) {
      articleImagePreviewWrap.hidden = true;
      articleImagePreviewImg.removeAttribute('src');
      articleImagePreviewInfo.textContent = '';
      return;
    }
    var src = '/site/' + articleCurrentImage;
    articleImagePreviewWrap.hidden = false;
    articleImagePreviewInfo.textContent = 'Cargando vista previa…';
    articleImagePreviewImg.onload = function () {
      var w = articleImagePreviewImg.naturalWidth;
      var h = articleImagePreviewImg.naturalHeight;
      var ext = (articleCurrentImage.split('.').pop() || '?').toUpperCase();
      var info = w + '×' + h + 'px · ' + ext;
      if (w < 600 || h < 315) info += ' ⚠️ por debajo del mínimo (600×315px)';
      articleImagePreviewInfo.textContent = info;
      fetch(src, { method: 'HEAD' }).then(function (r) {
        var len = r.headers.get('content-length');
        if (!len) return;
        var kb = Math.round(Number(len) / 1024);
        articleImagePreviewInfo.textContent = info + ' · ' + kb + ' KB' +
          (Number(len) > 5 * 1024 * 1024 ? ' ⚠️ supera el máximo permitido (5 MB)' : '');
      }).catch(function () { /* no crítico -- se queda sin el dato de peso */ });
    };
    articleImagePreviewImg.onerror = function () {
      articleImagePreviewInfo.textContent = '⚠️ No se pudo cargar la imagen desde el servidor (¿existe el archivo?).';
    };
    articleImagePreviewImg.src = src + (src.indexOf('?') === -1 ? '?v=' : '&v=') + Date.now();
  }

  /* Origen -> licencia "canónica" para artículos nuevos (mapeo 1 a 1,
     fase 3/4). Los artículos viejos migrados pueden tener una licencia
     "heredada" (ej. owner-attested-ai-generated) que NO es la canónica
     de su origen -- se conserva tal cual mientras no se toque el origen
     a mano, para no reclasificar en silencio 130 artículos ya publicados. */
  var ORIGIN_TO_LICENSE = {
    'ai-generated': 'ai-generated-commercial-use',
    'own-original': 'own-original',
    'public-domain': 'public-domain',
    'cc0': 'cc0',
    'cc-by': 'cc-by',
    'cc-by-sa': 'cc-by-sa',
    'editorial-permission-verified': 'editorial-permission-verified'
  };
  var LICENSE_LABELS = {
    'ai-generated-commercial-use': 'Generada con IA (uso comercial, con procedencia registrada)',
    'own-original': 'Propia / original de VexlowHQ',
    'public-domain': 'Dominio público',
    'cc0': 'Creative Commons CC0',
    'cc-by': 'Creative Commons CC-BY',
    'cc-by-sa': 'Creative Commons CC-BY-SA',
    'editorial-permission-verified': 'Permiso editorial verificado',
    'owner-attested-ai-generated': 'Generada con IA (declaración del titular -- clasificación heredada, sin herramienta/prompt registrados)'
  };
  function licenseLabel(license) {
    return LICENSE_LABELS[license] || license;
  }

  // Repuebla el <select> de licencia según el origen elegido. Si
  // currentLicense viene cargada (ej. al editar un artículo ya publicado)
  // y no coincide con la canónica del origen, se agrega como segunda
  // opción para no perder/cambiar sola la clasificación existente.
  function populateImageLicenseSelect(currentLicense) {
    var origin = articleImageOrigin.value;
    articleImageLicense.innerHTML = '';
    if (!origin) {
      var opt0 = document.createElement('option');
      opt0.value = currentLicense || '';
      opt0.textContent = currentLicense
        ? licenseLabel(currentLicense) + ' (heredada -- elegí un origen para cambiarla)'
        : '— Elegir un origen primero —';
      articleImageLicense.appendChild(opt0);
      articleImageLicense.value = currentLicense || '';
      return;
    }
    var canonical = ORIGIN_TO_LICENSE[origin];
    var opt = document.createElement('option');
    opt.value = canonical;
    opt.textContent = licenseLabel(canonical);
    articleImageLicense.appendChild(opt);
    if (currentLicense && currentLicense !== canonical) {
      var optLegacy = document.createElement('option');
      optLegacy.value = currentLicense;
      optLegacy.textContent = licenseLabel(currentLicense) + ' (actual -- heredada)';
      articleImageLicense.appendChild(optLegacy);
    }
    articleImageLicense.value = (currentLicense && currentLicense !== canonical) ? currentLicense : canonical;
  }

  // Muestra/oculta los campos de IA (herramienta/modelo/fecha/prompt) y
  // los de atribución (fuente/URL) según la licencia elegida -- fase 4.
  function updateImageProvenanceVisibility() {
    var license = articleImageLicense.value;
    articleImageAiFields.hidden = (license !== 'ai-generated-commercial-use');
    var requiringAttribution = (imageLicensesInfo.requiringAttribution && imageLicensesInfo.requiringAttribution.length)
      ? imageLicensesInfo.requiringAttribution
      : ['cc-by', 'cc-by-sa', 'editorial-permission-verified'];
    articleImageAttributionFields.hidden = (requiringAttribution.indexOf(license) === -1);
  }

  articleImageOrigin.addEventListener('change', function () {
    populateImageLicenseSelect('');
    updateImageProvenanceVisibility();
  });
  articleImageLicense.addEventListener('change', updateImageProvenanceVisibility);

  populateImageLicenseSelect('');
  updateImageProvenanceVisibility();
  updateArticleImageStatus();

  articleImageUpload.addEventListener('change', function () {
    var file = articleImageUpload.files[0];
    if (!file) return;
    if (!articleCategory.value) { toast('Elegí primero una categoría', true); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      articleImageStatus.textContent = 'Subiendo imagen…';
      postJSON('/api/upload-image', {
        category: articleCategory.value,
        filename: file.name,
        dataBase64: base64
      }).then(function (result) {
        articleCurrentImage = result.path;
        updateArticleImageStatus();
        toast('Imagen subida');
      }).catch(function (err) {
        updateArticleImageStatus();
        toast(err.message || 'No se pudo subir la imagen', true);
      }).finally(function () {
        articleImageUpload.value = '';
      });
    };
    reader.readAsDataURL(file);
  });
  articleImageRemoveBtn.addEventListener('click', function () {
    articleCurrentImage = '';
    updateArticleImageStatus();
  });

  /* Imágenes sueltas dentro del cuerpo del artículo (distintas de la
     imagen destacada de arriba): se suben con el mismo endpoint de
     siempre y se insertan como "![alt](ruta)" en el cursor del textarea;
     parseBody/render_article_body (pagegen.js y generate_pages.py) ya
     saben convertir esa línea en un <figure><img>. */
  function insertAtCursor(textarea, text) {
    var start = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart;
    var end = textarea.selectionEnd == null ? textarea.value.length : textarea.selectionEnd;
    var value = textarea.value;
    textarea.value = value.slice(0, start) + text + value.slice(end);
    var pos = start + text.length;
    textarea.selectionStart = textarea.selectionEnd = pos;
    textarea.focus();
  }

  inlineImageBtn.addEventListener('click', function () {
    if (!articleCategory.value) { toast('Elegí primero una categoría', true); return; }
    inlineImageUpload.click();
  });

  inlineImageUpload.addEventListener('change', function () {
    var file = inlineImageUpload.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      inlineImageStatus.textContent = 'Subiendo imagen…';
      postJSON('/api/upload-image', {
        category: articleCategory.value,
        filename: file.name,
        dataBase64: base64
      }).then(function (result) {
        var alt = window.prompt('Descripción de la imagen (opcional, queda como texto alternativo):', '') || '';
        var markdown = '\n![' + alt.replace(/[\[\]]/g, '') + '](' + result.path + ')\n';
        insertAtCursor(articleBody, markdown);
        inlineImageStatus.textContent = 'Imagen insertada: ' + result.path.replace(/^img\//, '');
        toast('Imagen agregada al cuerpo');
      }).catch(function (err) {
        inlineImageStatus.textContent = '';
        toast(err.message || 'No se pudo subir la imagen', true);
      }).finally(function () {
        inlineImageUpload.value = '';
      });
    };
    reader.readAsDataURL(file);
  });

  regenerateBtn.addEventListener('click', function () {
    regenerateBtn.disabled = true;
    regenerateBtn.textContent = 'Regenerando…';
    postJSON('/api/regenerate', {}).then(function () {
      toast('Categorías y temas regenerados');
    }).catch(function () {
      toast('No se pudo regenerar. ¿Está Python instalado y accesible como "python"?', true);
    }).finally(function () {
      regenerateBtn.disabled = false;
      regenerateBtn.textContent = 'Regenerar sitio';
    });
  });

  function prefillFormFromFilter() {
    if (articleEditIndex !== null) return; // no tocar un artículo que se está editando
    if (filterCategory.value) {
      articleCategory.value = filterCategory.value;
    }
  }

  filterCategory.addEventListener('change', function () {
    renderArticlesList();
    prefillFormFromFilter();
  });
  filterTrendingOnly.addEventListener('change', renderArticlesList);
  filterName.addEventListener('input', renderArticlesList);
  if (filterSort) filterSort.addEventListener('change', renderArticlesList);

  function totalReactions(slug) {
    var r = reactionsBySlug[slug];
    if (!r) return 0;
    return (r.like || 0) + (r.fire || 0) - (r.dislike || 0);
  }

  function sortedArticlesWithIndex() {
    var nameQuery = filterName.value.trim().toLowerCase();
    var entries = articlesData
      .map(function (a, i) { return { a: a, i: i }; })
      .filter(function (entry) {
        if (nameQuery && (entry.a.title || '').toLowerCase().indexOf(nameQuery) === -1) return false;
        if (filterCategory.value && entry.a.category !== filterCategory.value) return false;
        if (filterTrendingOnly.checked && !entry.a.trending) return false;
        return true;
      });
    if (filterSort && filterSort.value === 'popular') {
      return entries.sort(function (x, y) { return totalReactions(y.a.slug) - totalReactions(x.a.slug); });
    }
    return entries.sort(function (x, y) { return new Date(y.a.date) - new Date(x.a.date); });
  }

  function toggleTrending(i) {
    var updated = Object.assign({}, articlesData[i], { trending: !articlesData[i].trending });
    var msg = updated.trending ? 'Marcado como Trending' : 'Quitado de Trending';
    // Edición de UN solo campo de UN solo artículo -- va por PUT
    // individual, no por el guardado masivo, para no arrastrar al resto.
    putArticle(updated.category, updated.slug, updated).then(function () {
      articlesData[i] = updated;
      renderArticlesList();
      toast(msg);
    }).catch(function (err) {
      toast((err && err.message) || 'No se pudo guardar', true);
    });
  }

  /* ---- Selección en lote (para borrar varios artículos de una) ---- */
  var selectedArticleKeys = new Set();
  var bulkSelectAll = document.getElementById('bulkSelectAll');
  var bulkSelectedCount = document.getElementById('bulkSelectedCount');
  var bulkDeleteBtn = document.getElementById('bulkDeleteBtn');

  function articleKey(a) { return a.category + '/' + a.slug; }

  function updateBulkBar(visibleEntries) {
    var count = selectedArticleKeys.size;
    bulkSelectedCount.textContent = count ? count + ' seleccionado(s)' : '';
    bulkDeleteBtn.hidden = count === 0;
    var visibleKeys = visibleEntries.map(function (entry) { return articleKey(entry.a); });
    bulkSelectAll.checked = visibleKeys.length > 0 && visibleKeys.every(function (k) { return selectedArticleKeys.has(k); });
  }

  bulkSelectAll.addEventListener('change', function () {
    var entries = sortedArticlesWithIndex();
    if (bulkSelectAll.checked) {
      entries.forEach(function (entry) { selectedArticleKeys.add(articleKey(entry.a)); });
    } else {
      entries.forEach(function (entry) { selectedArticleKeys.delete(articleKey(entry.a)); });
    }
    renderArticlesList();
  });

  // Borrado en lote (post-incidente 2026-09-13): YA NO filtra articlesData
  // en el navegador y manda el array resultante por POST /api/articles --
  // ese es exactamente el mecanismo que el 12/13 de septiembre permitió
  // que se perdieran 28 artículos de un guardado. Ahora cada artículo
  // seleccionado se borra con su propio DELETE explícito y confirmado
  // (uno por uno, en secuencia); el servidor ya rechaza con 409 cualquier
  // intento de sacar artículos por la vía del guardado masivo.
  bulkDeleteBtn.addEventListener('click', function () {
    var targets = articlesData.filter(function (a) { return selectedArticleKeys.has(articleKey(a)); });
    var count = targets.length;
    if (!count) return;
    var preview = targets.slice(0, 8).map(function (a) { return '· ' + a.title + ' (' + a.category + '/' + a.slug + ')'; }).join('\n');
    var extra = count > 8 ? '\n… y ' + (count - 8) + ' más.' : '';
    if (!window.confirm('¿Eliminar estos ' + count + ' artículo(s)? Van a la papelera (recuperables), no se borran físicamente:\n\n' + preview + extra)) return;

    bulkDeleteBtn.disabled = true;
    var errors = [];
    var deleteNext = function (idx) {
      if (idx >= targets.length) {
        bulkDeleteBtn.disabled = false;
        selectedArticleKeys.clear();
        renderArticlesList();
        if (errors.length) {
          toast((count - errors.length) + ' eliminado(s), ' + errors.length + ' fallaron: ' + errors.join(', '), true);
        } else {
          toast(count + ' artículo(s) eliminado(s) (recuperables desde la papelera)');
        }
        return;
      }
      var a = targets[idx];
      deleteArticleConfirmed(a.category, a.slug, a.title).then(function () {
        var i = articlesData.indexOf(a);
        if (i !== -1) articlesData.splice(i, 1);
      }).catch(function (err) {
        errors.push(a.slug + ': ' + ((err && err.message) || 'error'));
      }).then(function () {
        deleteNext(idx + 1);
      });
    };
    deleteNext(0);
  });

  function renderArticlesList() {
    var entries = sortedArticlesWithIndex();
    filterCount.textContent = articlesData.length
      ? entries.length + (entries.length === 1 ? ' artículo' : ' artículos')
      : '';
    articlesList.innerHTML = '';
    updateBulkBar(entries);
    if (entries.length === 0) {
      articlesList.innerHTML = '<div class="admin-empty">' +
        (articlesData.length === 0 ? 'Todavía no hay artículos.' : 'Ningún artículo coincide con este filtro.') +
        '</div>';
      return;
    }
    entries.forEach(function (entry) {
      var a = entry.a, i = entry.i;
      var meta = categoryMeta(a.category);
      var row = document.createElement('div');
      row.className = 'admin-item';

      var selectBox = document.createElement('input');
      selectBox.type = 'checkbox';
      selectBox.className = 'bulk-select';
      selectBox.checked = selectedArticleKeys.has(articleKey(a));
      selectBox.addEventListener('change', function () {
        if (selectBox.checked) selectedArticleKeys.add(articleKey(a));
        else selectedArticleKeys.delete(articleKey(a));
        updateBulkBar(entries);
      });

      var trendBtn = document.createElement('button');
      trendBtn.type = 'button';
      trendBtn.className = 'trend-toggle' + (a.trending ? ' active' : '');
      trendBtn.title = a.trending ? 'Quitar de Trending' : 'Marcar como Trending';
      trendBtn.textContent = a.trending ? '⭐' : '☆';
      trendBtn.addEventListener('click', function () { toggleTrending(i); });

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = a.icon || meta.icon;
      thumb.style.background = 'var(--surface-2)';

      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="ttl"></div><div class="meta"></div>';
      info.querySelector('.ttl').textContent = a.title;
      // Corrección 2026-09-13 (bug real: "Ver" en Nscale -- en revisión --
      // abría categoria/business/....html y devolvía 404). Antes acá se
      // usaba `hasPage = !!(a.body && a.body.trim())`, que solo mira si
      // hay texto cargado en el formulario -- CONFUNDE "tiene contenido
      // escrito" con "existe de verdad un HTML público en el servidor".
      // Ahora la única fuente de verdad es articleHtmlStatus (GET
      // /api/articles-html-status, calculado en el servidor con
      // fs.existsSync), consultada vía hasRealHtml(a). Un draft/review/
      // approved con muchísimo texto sigue mostrando "solo en el listado"
      // hasta que de verdad se publique.
      var effStatus = clientEffectiveStatus(a);
      var hasBody = !!(a.body && a.body.trim());
      var realHtmlExists = hasRealHtml(a);
      var r = reactionsBySlug[a.slug];
      var reactionsText = r ? ' · 👍' + (r.like || 0) + ' 🔥' + (r.fire || 0) + ' 👎' + (r.dislike || 0) : '';
      info.querySelector('.meta').textContent = (a.categoryLabel || meta.label) + ' · ' + a.date + ' · ' + (a.readTime || '') + (realHtmlExists ? ' · con página propia' : ' · solo en el listado') + reactionsText;

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      // "Ver" (hacia la URL pública real) es SOLO para artículos published
      // que además ya tienen su HTML generado en disco -- nunca para
      // draft/review/approved/redirected, y nunca si por algún motivo
      // (ej. un guardado que falló al generar) el HTML todavía no existe,
      // para no repetir el 404 original.
      var canView = effStatus === 'published' && realHtmlExists;
      // "redirected" no es "published" (article-status.js los distingue a
      // propósito), así que por el punto 3 del pedido no puede usar "Ver"
      // -- pero tampoco está en la lista del punto 1 (draft/review/
      // approved). Para no dejarlo sin ninguna forma de revisarlo -- y
      // para que el estado "redirected" pedido en las pruebas (punto 7)
      // tenga algo real que probar -- también usa "Vista previa" acá.
      // Decisión interpretativa: avisada en el informe para que Leonardo
      // la confirme o la corrija.
      var canPreview = !canView && (hasBody || effStatus === 'redirected');
      if (canView) {
        var viewBtn = document.createElement('a');
        viewBtn.href = '/site/' + (a.href || articleHrefFor(a));
        viewBtn.target = '_blank';
        viewBtn.rel = 'noopener';
        viewBtn.textContent = 'Ver';
        actions.appendChild(viewBtn);

        // Corrección 2026-09-13: "Al carrusel" tenía el mismo problema que
        // "Ver" -- se ofrecía con el mismo `hasPage` roto, así que un
        // artículo en revisión con texto cargado podía terminar agregado
        // al carrusel de la portada apuntando a una página que no existe.
        // Ahora exige lo mismo que "Ver": published + HTML real en disco.
        var carouselBtn = document.createElement('button');
        carouselBtn.type = 'button'; carouselBtn.textContent = 'Al carrusel';
        carouselBtn.title = 'Agregar como diapositiva nueva en el carrusel de la home';
        carouselBtn.addEventListener('click', function () { addToCarousel(a); });
        actions.appendChild(carouselBtn);
      } else if (canPreview) {
        // Vista previa segura (punto 2 del pedido): un GET de solo lectura
        // a admin/server.js que arma el HTML en memoria con los datos
        // actuales del artículo y lo devuelve directo, SIN tocar sitemap,
        // portada, categorías, buscador, articulos.js, AdSense ni ningún
        // archivo público -- ver GET /api/preview/:category/:slug. No
        // cambia el estado editorial ni marca aprobación (punto 5): es
        // nada más que una lectura.
        var previewBtn = document.createElement('a');
        previewBtn.href = '/api/preview/' + encodeURIComponent(a.category) + '/' + encodeURIComponent(a.slug);
        previewBtn.target = '_blank';
        previewBtn.rel = 'noopener';
        previewBtn.textContent = 'Vista previa';
        previewBtn.title = 'Vista previa sin publicar -- no queda pública ni se indexa';
        actions.appendChild(previewBtn);
      }
      var editBtn = document.createElement('button');
      editBtn.type = 'button'; editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', function () { startEditArticle(i); });
      var delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.textContent = 'Eliminar'; delBtn.className = 'danger';
      delBtn.addEventListener('click', function () { deleteArticle(i); });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(selectBox);
      row.appendChild(trendBtn);
      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      articlesList.appendChild(row);
    });
  }

  function startEditArticle(i) {
    // Verificación final 2026-09-25: si había un borrador cargado (vía
    // "Usar este borrador") sin guardar ni cancelar todavía, abrir un
    // artículo YA EXISTENTE para editarlo tiene que cortar esa sesión
    // pendiente -- si no, buildArticleFromForm() le pegaría a este artículo,
    // que no tiene nada que ver, el editorialMeta/editorialValue/
    // similarityWarning/etc. de aquel otro borrador abandonado. (Antes de
    // esta corrección, pendingDraft solo se limpiaba en resetArticleForm()
    // -- tras cancelar o guardar con éxito -- nunca acá.)
    pendingDraft = null;
    articleEditIndex = i;
    var a = articlesData[i];
    articleFormTitle.textContent = 'Editar artículo';
    ensureCategoryOption(articleCategory, a.category);
    articleCategory.value = a.category;
    articleDate.value = a.date;
    articleTitle.value = a.title;
    articleSlug.value = a.slug || '';
    articleSlug.dataset.auto = 'false'; // no re-generar el slug solo por editar el título de una nota ya publicada
    articleDek.value = a.dek || '';
    articleCurrentImage = a.image || '';
    updateArticleImageStatus();
    articleImageOrigin.value = a.imageOrigin || '';
    populateImageLicenseSelect(a.imageLicense || '');
    articleImageCredit.value = a.imageCredit || '';
    articleImageTool.value = a.imageTool || '';
    articleImageModel.value = a.imageModel || '';
    articleImageGeneratedAt.value = (a.imageGeneratedAt || '').slice(0, 10);
    articleImagePrompt.value = a.imagePrompt || '';
    articleImageHumanEdited.checked = !!a.imageHumanEdited;
    articleImageOwnerAttestation.checked = !!a.imageOwnerAttestation;
    articleImageSource.value = a.imageSource || '';
    articleImageSourceUrlInput.value = a.imageSourceUrl || '';
    articleImageReuseAuthorized.checked = !!a.imageReuseAuthorized;
    updateImageProvenanceVisibility();
    articleVideoUrl.value = a.videoUrl || '';
    // Fase 10: se cargan los valores YA guardados del artículo -- antes
    // este formulario no tenía estos tres campos, así que reabrir un
    // artículo real para editarlo (fuera del flujo "Usar este borrador")
    // los mostraba como si no existieran, aunque el archivo sí los tuviera.
    articleSourceUrl.value = a.sourceUrl || '';
    articleSourceTitle.value = a.sourceTitle || '';
    renderAdditionalSources(a.additionalSources || []);
    currentSourceProvenance = {
      sourceHeadline: a.sourceHeadline || null, sourceDomain: a.sourceDomain || null,
      sourceAuthor: a.sourceAuthor || null, sourcePublishedAt: a.sourcePublishedAt || null,
      sourceRetrievedAt: a.sourceRetrievedAt || null, keyClaims: a.keyClaims || [],
      singleSourceWarning: !!a.singleSourceWarning
    };
    renderQuickReviewCard();
    articleReadTime.value = a.readTime || '';
    articleTrending.checked = !!a.trending;
    articleNoindex.checked = !!a.noindex;
    articleNoindexReason.value = a.noindexReason || '';
    articleUpdatedDate.value = a.dateModified || '';
    articleCorrectionNote.value = a.correctionNote || '';
    articleEditorialStatus.value = a.editorialStatus || '';
    articleStatus.value = clientEffectiveStatus(a);
    articleRedirectTo.value = a.redirectTo || '';
    articleEditorialApproval.checked = !!a.editorialApproval;
    updateStatusFieldsVisibility();
    articleBody.value = a.body || '';
    inlineImageStatus.textContent = '';
    articleCancelBtn.hidden = false;
    clearArticleValidationErrors();
    resetChecklist();
    scheduleLiveValidation();
    articleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetArticleForm() {
    articleEditIndex = null;
    pendingDraft = null;
    articleForm.reset();
    articleDate.value = todayISO();
    articleSlug.dataset.auto = 'true';
    articleCurrentImage = '';
    updateArticleImageStatus();
    articleImageOrigin.value = '';
    populateImageLicenseSelect('');
    updateImageProvenanceVisibility();
    inlineImageStatus.textContent = '';
    renderAdditionalSources([]);
    currentSourceProvenance = {};
    articleCheckSourceStatus.textContent = '';
    renderQuickReviewCard();
    articleFormTitle.textContent = 'Agregar artículo';
    articleCancelBtn.hidden = true;
    updateStatusFieldsVisibility();
    clearArticleValidationErrors();
    resetChecklist();
    prefillFormFromFilter();
  }
  articleCancelBtn.addEventListener('click', resetArticleForm);

  // Borrado individual (post-incidente 2026-09-13): va por
  // DELETE /api/articles/:category/:slug -- explícito, con el
  // título/slug reales mostrados en el propio confirm(), recuperable desde
  // papelera (GET /api/trash) porque el servidor mueve el HTML en vez de
  // borrarlo. Ya NO se hace vía "sacarlo del array y volver a mandar
  // articlesData completo" -- ese camino es justamente el que permitió
  // que una pestaña desactualizada se llevara puesto a otros artículos.
  function deleteArticle(i) {
    var a = articlesData[i];
    if (!confirm('¿Eliminar "' + a.title + '" (' + a.category + '/' + a.slug + ')? Si tenía página propia, se mueve a la papelera (recuperable), no se borra.')) return;
    deleteArticleConfirmed(a.category, a.slug, a.title).then(function () {
      selectedArticleKeys.delete(articleKey(a));
      articlesData.splice(i, 1);
      renderArticlesList();
      refreshArticleHtmlStatus();
      toast('Artículo eliminado (recuperable desde la papelera)');
    }).catch(function (err) {
      toast((err && err.message) || 'No se pudo eliminar', true);
    });
  }

  // Arma una diapositiva nueva del carrusel a partir de un artículo ya
  // publicado (mismo título, dek, imagen y categoría, apuntando a su
  // página real) -- para no tener que volver a tipear todo a mano en
  // el formulario del Hero.
  function addToCarousel(a) {
    var meta = categoryMeta(a.category);
    heroData.push({
      category: a.category,
      chip: meta.icon + ' ' + meta.label,
      title: a.title,
      dek: a.dek || '',
      image: a.image || '',
      textColor: 'auto',
      href: a.href || articleHrefFor(a)
    });
    saveHero('Agregado al carrusel');
  }

  // Guarda directo articlesData tal cual está (se usa desde eliminar,
  // reordenar, etc. -- casos donde no hay nada nuevo que validar en el
  // formulario, así que un 422 acá sería un bug del servidor, no del
  // usuario). Para altas/ediciones desde el formulario se usa
  // persistArticleEdit(), que arma su propio array y no pisa
  // articlesData hasta que el guardado server-side realmente funcionó.
  function saveArticles(successMsg) {
    return postJSON('/api/articles', articlesData).then(function (result) {
      renderArticlesList();
      refreshArticleHtmlStatus();
      if (result && result.errors && result.errors.length) {
        toast('Guardado, pero falló generar: ' + result.errors.map(function (e) { return e.slug; }).join(', '), true);
      } else {
        toast(successMsg || 'Guardado');
      }
      return result;
    }).catch(function (err) {
      toast((err && err.message) || 'No se pudo guardar. ¿Está corriendo el panel?', true);
    });
  }

  // Arma el objeto artículo a partir de TODOS los campos del formulario
  // (incluida la procedencia de imagen de la fase 2/4). La usan tanto el
  // submit normal como el botón "Guardar como borrador incompleto".
  // Fase 10: sección visible "Fuentes adicionales" -- lista dinámica de
  // filas {url, label}. Una fila con URL vacía se descarta al recolectar
  // (permite dejar una fila "en blanco" recién agregada sin que eso
  // guarde un objeto vacío en additionalSources).
  function addSourceRow(src) {
    src = src || {};
    var row = document.createElement('div');
    row.className = 'additional-source-row';
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;';
    var urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://ejemplo.com/nota-de-contexto';
    urlInput.className = 'additional-source-url';
    urlInput.value = src.url || '';
    urlInput.style.flex = '2';
    urlInput.addEventListener('input', scheduleLiveValidation);
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Nombre del medio (ej. TechCrunch)';
    labelInput.className = 'additional-source-label';
    labelInput.value = src.label || '';
    labelInput.style.flex = '1';
    labelInput.addEventListener('input', scheduleLiveValidation);
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-secondary danger';
    removeBtn.textContent = 'Quitar';
    removeBtn.addEventListener('click', function () {
      row.remove();
      scheduleLiveValidation();
    });
    row.appendChild(urlInput);
    row.appendChild(labelInput);
    row.appendChild(removeBtn);
    articleAdditionalSourcesList.appendChild(row);
  }

  function renderAdditionalSources(list) {
    articleAdditionalSourcesList.innerHTML = '';
    (list || []).forEach(function (src) { addSourceRow(src); });
  }

  function collectAdditionalSourcesFromForm() {
    var rows = Array.prototype.slice.call(articleAdditionalSourcesList.querySelectorAll('.additional-source-row'));
    var out = [];
    rows.forEach(function (row) {
      var url = row.querySelector('.additional-source-url').value.trim();
      var label = row.querySelector('.additional-source-label').value.trim();
      if (!url) return;
      var entry = { url: url };
      if (label) entry.label = label;
      out.push(entry);
    });
    return out;
  }

  articleAddSourceBtn.addEventListener('click', function () {
    addSourceRow({});
    scheduleLiveValidation();
  });

  // Ficha de revisión rápida (mejora global 2026-09-20, requisito 7):
  // resume en un solo lugar lo que antes había que ir a buscar campo por
  // campo -- fuente principal + adicionales con fecha/autor, las 5
  // afirmaciones principales que trajo la IA con su fuente, imagen/
  // licencia, y un resumen de riesgo editorial + estado de controles
  // (que reusa exactamente el mismo cálculo que ya pinta el checklist de
  // abajo, para no tener dos lógicas de "qué está bien/mal" que puedan
  // desincronizarse). Es de solo lectura -- todo lo que se puede editar
  // ya tiene su propio campo más arriba (Fuentes, imagen, checklist).
  function formatSourceDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().slice(0, 10);
  }

  function renderQuickReviewCard() {
    var sourceUrl = articleSourceUrl.value.trim();
    var sourceTitle = articleSourceTitle.value.trim();
    var additional = collectAdditionalSourcesFromForm();
    var prov = currentSourceProvenance || {};
    var hasAnything = !!(sourceUrl || sourceTitle || additional.length || prov.sourceHeadline || (prov.keyClaims && prov.keyClaims.length));
    if (!hasAnything) {
      articleQuickReviewCard.hidden = true;
      return;
    }
    articleQuickReviewCard.hidden = false;
    var html = '';

    html += '<div style="margin-bottom:6px;"><strong>Fuente principal:</strong> ';
    if (sourceUrl) {
      html += escapeHtml(sourceTitle || sourceUrl) + ' — <a href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener">' + escapeHtml(sourceUrl) + '</a>';
    } else {
      html += '<span style="color:var(--danger,#c0392b);">falta</span>';
    }
    if (prov.sourceHeadline) html += '<br>Título original: ' + escapeHtml(prov.sourceHeadline);
    var metaBits = [];
    if (prov.sourceAuthor) metaBits.push('Autor: ' + escapeHtml(prov.sourceAuthor));
    if (prov.sourcePublishedAt) metaBits.push('Publicado: ' + escapeHtml(formatSourceDate(prov.sourcePublishedAt)));
    if (prov.sourceRetrievedAt) metaBits.push('Consultado: ' + escapeHtml(formatSourceDate(prov.sourceRetrievedAt)));
    if (metaBits.length) html += '<br>' + metaBits.join(' · ');
    html += '</div>';

    html += '<div style="margin-bottom:6px;"><strong>Fuentes adicionales:</strong> ';
    if (additional.length) {
      html += '<ul style="margin:2px 0 0 18px;padding:0;">' + additional.map(function (s) {
        return '<li>' + escapeHtml(s.label || s.url) + ' — <a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.url) + '</a></li>';
      }).join('') + '</ul>';
    } else {
      html += '<span style="color:#b8860b;">⚠️ ninguna — una sola fuente confirma esta historia</span>';
    }
    html += '</div>';

    if (prov.keyClaims && prov.keyClaims.length) {
      // Requisito 12 (revisión de seguridad 2026-09-20): esto lo generó la
      // IA a partir del borrador -- son un punto de partida para la
      // revisión humana, NUNCA hechos ya verificados. El rótulo lo dice
      // explícito para que nadie los lea como una verificación hecha.
      html += '<div style="margin-bottom:6px;"><strong>Afirmaciones principales</strong> <span class="admin-hint">(extraídas automáticamente para revisión — no verificadas)</span>:<ul style="margin:2px 0 0 18px;padding:0;">' +
        prov.keyClaims.slice(0, 5).map(function (c) {
          return '<li>' + escapeHtml(c.claim) + ' <em>(' + escapeHtml(c.sourceLabel || 'context') + ')</em></li>';
        }).join('') + '</ul></div>';
    }

    html += '<div style="margin-bottom:6px;"><strong>Imagen y licencia:</strong> origen: ' +
      escapeHtml(articleImageOrigin.value || '(sin decidir)') +
      ', licencia: ' + escapeHtml(articleImageLicense.value || '(sin decidir)') + '</div>';

    // Riesgo editorial + estado de controles: se reusa el mismo cálculo
    // que ya corre para el checklist de abajo (lastValidation), para que
    // esta ficha nunca pueda mostrar algo distinto de lo que de verdad
    // bloquea o no el guardado.
    var issueCount = (lastValidation.issues || []).length;
    var warnCount = (lastValidation.warnings || []).length;
    var riskLine = issueCount ? ('❌ ' + issueCount + ' problema(s) bloqueante(s)') : (warnCount ? ('⚠️ ' + warnCount + ' advertencia(s) de riesgo editorial') : '✅ sin advertencias de riesgo');
    var approvalLine = articleEditorialApproval.checked ? '✅ aprobación humana confirmada' : '❌ falta tildar la aprobación humana';
    html += '<div><strong>Riesgo editorial:</strong> ' + riskLine + '<br><strong>Estado de controles:</strong> ' + approvalLine + ' — ver el detalle de los 7 puntos en el checklist de abajo.</div>';

    articleQuickReviewBody.innerHTML = html;
  }

  // Verificación bajo demanda de que la fuente principal todavía responde
  // (requisito 10) -- separado del guardado real a propósito (ver
  // comentario del endpoint en server.js): no bloquea nada por sí solo,
  // es información para decidir antes de aprobar.
  articleCheckSourceBtn.addEventListener('click', function () {
    var url = articleSourceUrl.value.trim();
    if (!url) { articleCheckSourceStatus.textContent = 'Cargá una URL primero.'; return; }
    articleCheckSourceStatus.textContent = 'Verificando…';
    fetch('/api/check-source?url=' + encodeURIComponent(url)).then(function (r) { return r.json(); }).then(function (result) {
      // Revisión de seguridad 2026-09-20: "blocked" es un resultado
      // DISTINTO de "no responde" -- no es que el link esté muerto, es que
      // esta URL no está permitida por política (protocolo raro, IP
      // privada/interna, credenciales embebidas, etc.). Nunca se debe leer
      // como "la fuente no existe".
      if (result.blocked) {
        var reasonLabel = {
          'protocol-not-allowed': 'protocolo no permitido (solo http/https)',
          'credentials-in-url': 'la URL trae usuario/contraseña embebidos',
          'private-address': 'apunta a una dirección privada/interna',
          'invalid-url': 'no es una URL válida'
        }[result.reason] || result.reason || 'sin detalle';
        articleCheckSourceStatus.textContent = '🚫 URL no permitida por seguridad (' + reasonLabel + ') — no se puede usar como fuente.';
      } else if (result.reachable === false) {
        articleCheckSourceStatus.textContent = '❌ No responde (' + (result.status || result.error || 'sin detalle') + ') — puede ser un link roto o vencido.';
      } else if (result.uncertain) {
        articleCheckSourceStatus.textContent = '⚠️ No se pudo confirmar (' + (result.error || result.status || 'sin detalle') + ') — probá abrirla a mano.';
      } else {
        articleCheckSourceStatus.textContent = '✅ Responde (HTTP ' + (result.status || 200) + ').';
      }
    }).catch(function () {
      articleCheckSourceStatus.textContent = 'No se pudo verificar (error de red del panel).';
    });
  });
  [articleSourceUrl, articleSourceTitle].forEach(function (el) {
    el.addEventListener('input', renderQuickReviewCard);
  });

  function buildArticleFromForm() {
    var meta = categoryMeta(articleCategory.value);
    var slug = articleSlug.value.trim() || slugify(articleTitle.value);
    var article = {
      title: articleTitle.value.trim(),
      category: articleCategory.value,
      categoryLabel: meta.label,
      icon: meta.icon,
      date: articleDate.value,
      readTime: articleReadTime.value.trim(),
      slug: slug,
      dek: articleDek.value.trim(),
      image: articleCurrentImage,
      imageOrigin: articleImageOrigin.value.trim(),
      imageLicense: articleImageLicense.value.trim(),
      imageCredit: articleImageCredit.value.trim(),
      imageTool: articleImageTool.value.trim() || null,
      imageModel: articleImageModel.value.trim() || null,
      imageGeneratedAt: articleImageGeneratedAt.value || null,
      imagePrompt: articleImagePrompt.value.trim() || null,
      imageHumanEdited: articleImageHumanEdited.checked,
      imageOwnerAttestation: articleImageOwnerAttestation.checked,
      imageSource: articleImageSource.value.trim(),
      imageSourceUrl: articleImageSourceUrlInput.value.trim() || null,
      imageReuseAuthorized: articleImageReuseAuthorized.checked,
      videoUrl: articleVideoUrl.value.trim(),
      trending: articleTrending.checked,
      noindex: articleNoindex.checked,
      noindexReason: articleNoindexReason.value.trim(),
      dateModified: articleUpdatedDate.value || '',
      correctionNote: articleCorrectionNote.value.trim(),
      editorialStatus: articleEditorialStatus.value.trim(),
      status: articleStatus.value,
      editorialApproval: articleEditorialApproval.checked,
      // Fase 10: ahora tienen control propio y visible en el formulario --
      // ver la sección "Fuentes" en admin/index.html. Se envían siempre
      // (incluso null/[] si se vaciaron a propósito) para que un merge del
      // lado del servidor (articles-store.upsertArticle) los sobreescriba
      // correctamente en vez de dejarlos "pegados" al valor viejo.
      sourceUrl: articleSourceUrl.value.trim() || null,
      sourceTitle: articleSourceTitle.value.trim() || null,
      additionalSources: collectAdditionalSourcesFromForm(),
      body: articleBody.value
    };
    // Mejora global 2026-09-20 (requisito 3: "estos campos deben sobrevivir
    // todos los guardados"): sourceHeadline/sourceDomain/sourceAuthor/
    // sourcePublishedAt/sourceRetrievedAt/keyClaims no tienen control propio
    // en el formulario (son metadatos que ya trajo la RSS/IA, no algo que se
    // edite a mano) así que viajan tal cual desde currentSourceProvenance --
    // IMPORTANTE que viajen en el objeto (no solo confiar en el merge del
    // servidor), porque un artículo NUEVO (recién creado desde "Usar este
    // borrador") no tiene ningún registro previo con el que mergear (ver
    // articles-store.upsertArticle, rama isNew: push directo, sin merge).
    // Se agregan SOLO si hay algo real que guardar -- un artículo viejo que
    // nunca tuvo esta procedencia (de antes de esta mejora, ej. Nscale) no
    // gana estas claves de la nada con valores vacíos con solo abrirlo y
    // volver a guardarlo sin tocar nada.
    var prov = currentSourceProvenance || {};
    if (prov.sourceHeadline) article.sourceHeadline = prov.sourceHeadline;
    if (prov.sourceDomain) article.sourceDomain = prov.sourceDomain;
    if (prov.sourceAuthor) article.sourceAuthor = prov.sourceAuthor;
    if (prov.sourcePublishedAt) article.sourcePublishedAt = prov.sourcePublishedAt;
    if (prov.sourceRetrievedAt) article.sourceRetrievedAt = prov.sourceRetrievedAt;
    if (prov.keyClaims && prov.keyClaims.length) article.keyClaims = prov.keyClaims;
    if (article.status === 'redirected') {
      article.redirectTo = articleRedirectTo.value.trim();
    } else {
      // Fase 10: antes se dejaba directamente sin definir cuando el status
      // no era 'redirected' -- con el reemplazo completo de antes eso no
      // importaba (se perdía junto con todo lo demás), pero ahora que
      // articles-store.upsertArticle hace un merge seguro con el registro
      // existente, un `redirectTo` viejo quedaría pegado para siempre si
      // no se lo limpia acá explícitamente al salir del estado 'redirected'.
      article.redirectTo = null;
    }
    // El legado draftIncomplete se mantiene en sincronía con el nuevo
    // `status` para quien lea articulos.json directamente sin pasar por
    // effectiveStatus() -- pero quien manda es siempre `status` (ver
    // admin/article-status.js).
    article.draftIncomplete = article.status === 'draft';
    if (pendingDraft) {
      // Fase 5/9: las advertencias de similaridad/subtítulo genérico ya
      // calculadas al descubrir el borrador (fetchNewDrafts en
      // pipeline.js) viajan con el artículo final para que
      // validateSourcesAndQuality las pueda usar -- antes se perdían al
      // pasar de "borrador sugerido" a "artículo" (useDraft no las
      // copiaba a ningún lado y buildArticleFromForm no las conocía). No
      // tienen ningún control en el formulario (son computadas una sola
      // vez al descubrir el borrador, nunca editables a mano), así que acá
      // siguen viajando por pendingDraft en vez de un input.
      if (typeof pendingDraft.similarityWarning === 'boolean') article.similarityWarning = pendingDraft.similarityWarning;
      if (typeof pendingDraft.similarityScore === 'number') article.similarityScore = pendingDraft.similarityScore;
      if (typeof pendingDraft.genericHeadingWarning === 'boolean') article.genericHeadingWarning = pendingDraft.genericHeadingWarning;
      // Verificación final 2026-09-25: mismo mecanismo, para que
      // editorialMeta/editorialValue sobrevivan el primer guardado de un
      // artículo nuevo creado desde "Usar este borrador" (ver el
      // comentario en useDraft()). Se agregan solo si hay algo real que
      // guardar -- nunca una clave vacía de la nada.
      if (pendingDraft.editorialMeta) article.editorialMeta = pendingDraft.editorialMeta;
      if (pendingDraft.editorialValue) article.editorialValue = pendingDraft.editorialValue;
    }
    article.href = articleHrefFor(article);
    return article;
  }

  // Guarda un alta/edición de UN artículo del formulario (post-incidente
  // 2026-09-13): va por PUT /api/articles/:category/:slug -- identificado
  // por la categoría/slug ORIGINALES del artículo que se está editando (si
  // el usuario le cambió la categoría o el slug desde el formulario, el
  // cuerpo lleva la identidad nueva y el servidor hace el rename) -- NUNCA
  // reenvía articlesData completo. Así, si el servidor responde 422 (fase
  // 3/5) o 409 (choque de slug), lo que queda visible y en memoria sigue
  // siendo exactamente lo último guardado con éxito, sin haber arriesgado
  // a ningún otro artículo en el intento.
  function persistArticleEdit(article, successMsg) {
    var isNew = articleEditIndex === null;
    var original = isNew ? article : articlesData[articleEditIndex];
    var idemKey = generateIdempotencyKey();
    return putArticle(original.category, original.slug, article, idemKey).then(function (result) {
      // Fase 10: el servidor devuelve el registro REALMENTE guardado
      // (result.savedArticle, ya pasado por el merge seguro de
      // articles-store.upsertArticle) -- se usa para refrescar la copia en
      // memoria en vez del objeto parcial armado solo con lo que el
      // formulario conoce, para que un metadato sin control visible (ej.
      // topic/subtopic) no aparezca como "perdido" en el panel dentro de
      // esta misma sesión, aunque en disco nunca se haya tocado.
      var savedArticle = (result && result.savedArticle) || article;
      article = savedArticle;
      if (isNew) {
        // Incidente 2026-09-13 ("146 con Moonshot repetido ~5 veces"):
        // antes esto era un articlesData.push(article) incondicional --
        // si por lo que sea ya había un registro en memoria con la misma
        // categoría/slug (el candado de guardado de más arriba ya evita
        // que esto pase por clics repetidos, pero esto queda como defensa
        // adicional, igual que el resto del panel hace en capas), se
        // actualiza ese en vez de agregar uno nuevo -- el servidor
        // (articles-store.upsertArticle) ya es idempotente por
        // categoría+slug, así que articlesData tiene que quedar igual de
        // idempotente para no MOSTRAR duplicados que nunca existieron en
        // disco.
        var existingIdx = articlesData.findIndex(function (a) { return a.category === article.category && a.slug === article.slug; });
        if (existingIdx !== -1) {
          articlesData[existingIdx] = article;
          articleEditIndex = existingIdx;
        } else {
          articlesData.push(article);
          articleEditIndex = articlesData.length - 1;
        }
      } else {
        articlesData[articleEditIndex] = article;
      }
      renderArticlesList();
      clearArticleValidationErrors();
      if (result && result.errors && result.errors.length) {
        toast('Guardado, pero falló generar: ' + result.errors.map(function (e) { return e.slug; }).join(', '), true);
      } else {
        toast(successMsg || 'Guardado');
      }
      // Advertencias de riesgo editorial (heurísticas: similaridad, texto
      // genérico, posibles contradicciones, cifras sin atribución, etc.)
      // -- nunca bloquearon el guardado, pero conviene que no se pierdan
      // silenciosamente solo porque el formulario se resetea después de
      // guardar con éxito.
      if (result && result.warnings && result.warnings.length) {
        var warnMsgs = [];
        result.warnings.forEach(function (w) {
          (w.warnings || []).forEach(function (item) { warnMsgs.push('"' + w.title + '": ' + item.message); });
        });
        if (warnMsgs.length) toast('⚠️ Riesgo editorial a revisar — ' + warnMsgs.join(' | '));
      }
      // Después de cada guardado puede haber cambiado qué artículos tienen
      // HTML real (se publicó uno nuevo, se pasó uno a redirect, etc.) --
      // se refresca la verdad de articleHtmlStatus para que "Ver"/"Vista
      // previa"/"con página propia" queden correctos sin esperar a
      // recargar el panel entero. No bloquea la respuesta de este guardado.
      refreshArticleHtmlStatus();
      return result;
    });
  }

  articleForm.addEventListener('submit', function (e) {
    e.preventDefault();
    // Candado de guardado en curso (incidente 2026-09-13): un segundo
    // submit (doble Enter, doble clic, un envío disparado dos veces por
    // el navegador) mientras el primero todavía no volvió del servidor se
    // ignora por completo -- ni siquiera se reconstruye el artículo del
    // formulario. Se chequea ANTES que nada más en el handler.
    if (articleSaveInFlight) return;
    var article = buildArticleFromForm();
    // Chequeo local rápido, SOLO para ahorrar el ida y vuelta al servidor
    // en los dos casos más comunes -- el gate real sigue siendo el 422 de
    // POST /api/articles (pipeline.validateEditorialWorkflow), esto de
    // acá nunca reemplaza esa validación, solo evita un viaje de red
    // inútil cuando el error ya es obvio en el propio formulario. No
    // activan el candado -- no hay ningún guardado en curso todavía.
    if (article.status === 'published' && !article.editorialApproval) {
      toast('Para publicar hace falta tildar "He revisado las fuentes, los derechos de imagen y la exactitud del artículo".', true);
      articleEditorialApprovalWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (article.status === 'redirected' && !article.redirectTo) {
      toast('Para una redirección hace falta indicar a qué artículo redirige (categoria/slug).', true);
      articleRedirectTo.focus();
      return;
    }
    var isNewArticleToday = articleEditIndex === null && article.date === todayISO();
    var usedDraft = pendingDraft;
    setArticleSaveInFlight(true);
    persistArticleEdit(article, articleEditIndex !== null ? 'Artículo actualizado' : 'Artículo agregado').then(function () {
      // Corrección 2026-09-13: este mensaje tenía el mismo bug que "Ver" en
      // el listado -- mostraba "Página publicada" con un link a la URL
      // pública apenas había texto cargado, sin mirar el estado editorial,
      // así que guardar un artículo en revisión/aprobado ya mostraba un
      // link que devolvía 404. Ahora distingue: published -> link a la
      // página pública real; draft/review/approved/redirected -> link a
      // la vista previa segura (no publica nada, ver GET /api/preview).
      if (article.status === 'published' || (!article.status && article.body && article.body.trim())) {
        articlePreviewLink.innerHTML = 'Página publicada: <a href="/site/' + article.href + '" target="_blank" rel="noopener">' + article.href + ' ↗</a>';
      } else if ((article.body && article.body.trim()) || article.status === 'redirected') {
        var previewHref = '/api/preview/' + encodeURIComponent(article.category) + '/' + encodeURIComponent(article.slug);
        articlePreviewLink.innerHTML = 'Todavía no está publicado: <a href="' + previewHref + '" target="_blank" rel="noopener">ver vista previa ↗</a>';
      } else {
        articlePreviewLink.textContent = '';
      }
      if (isNewArticleToday) {
        var publishedToday = articlesData.filter(function (a) { return a.date === article.date; }).length;
        if (publishedToday > 3) {
          toast('Van ' + publishedToday + ' artículos publicados hoy — para mantener un ritmo parejo, lo ideal es no pasar de 2-3 por día.');
        }
      }
      resetArticleForm();
      if (usedDraft) {
        deleteJSON('/api/drafts', { slug: usedDraft.slug, used: true }).then(function () {
          draftsData = draftsData.filter(function (d) { return d.slug !== usedDraft.slug; });
          renderDraftsList();
        });
      }
    }).catch(function (err) {
      renderArticleValidationErrors(err);
      toast((err && err.message) || 'No se pudo guardar. ¿Está corriendo el panel?', true);
    }).then(function () {
      setArticleSaveInFlight(false);
    });
  });

  // "Guardar como borrador incompleto" -- deliberadamente NO dispara la
  // validación nativa del <form> (es un botón type=button) ni los
  // controles de fase 3/5 del servidor (server.js: draftIncomplete se
  // salta esa validación por completo). Sirve para dejar cargado lo que
  // ya se tiene (ej. un artículo de los 34 sin imagen, con el prompt
  // pendiente de generación manual) sin bloquear el guardado ni
  // publicarlo como nota terminada.
  articleSaveDraftBtn.addEventListener('click', function () {
    // Mismo candado que el submit de arriba (incidente 2026-09-13) --
    // ambos botones comparten articleSaveInFlight porque los dos terminan
    // en persistArticleEdit() sobre el mismo artículo del formulario, así
    // que un guardado en curso por cualquiera de los dos bloquea al otro
    // también.
    if (articleSaveInFlight) return;
    if (!articleTitle.value.trim()) {
      toast('Poné al menos un título antes de guardar el borrador', true);
      return;
    }
    var article = buildArticleFromForm();
    // Este botón siempre fuerza 'draft', sin importar qué haya elegido el
    // <select> de estado -- es justamente el escape hatch para guardar
    // algo a medio terminar (ej. uno de los artículos sin imagen, con el
    // prompt pendiente de generación manual) sin bloquear el guardado.
    article.status = 'draft';
    article.draftIncomplete = true;
    var usedDraft = pendingDraft;
    setArticleSaveInFlight(true);
    persistArticleEdit(article, 'Guardado como borrador incompleto (sin validar ni publicar)').then(function () {
      resetArticleForm();
      if (usedDraft) {
        deleteJSON('/api/drafts', { slug: usedDraft.slug, used: true }).then(function () {
          draftsData = draftsData.filter(function (d) { return d.slug !== usedDraft.slug; });
          renderDraftsList();
        });
      }
    }).catch(function (err) {
      renderArticleValidationErrors(err);
      toast((err && err.message) || 'No se pudo guardar el borrador', true);
    }).then(function () {
      setArticleSaveInFlight(false);
    });
  });

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /* =====================================================
     BORRADORES SUGERIDOS
     ===================================================== */
  var draftsList = document.getElementById('draftsList');
  var draftsTabCount = document.getElementById('draftsTabCount');
  var fetchDraftsBtn = document.getElementById('fetchDraftsBtn');
  var draftsFetchStatus = document.getElementById('draftsFetchStatus');
  var draftsCostSummary = document.getElementById('draftsCostSummary');
  var draftsShowSingleSource = document.getElementById('draftsShowSingleSource');
  var draftsSingleSourceList = document.getElementById('draftsSingleSourceList');
  var draftsShowFantasyBetting = document.getElementById('draftsShowFantasyBetting');
  var draftsFantasyBettingList = document.getElementById('draftsFantasyBettingList');
  // Modo secundario opcional (requisito 20, 2026-09-23): candidatos de una
  // sola fuente de la ÚLTIMA búsqueda -- solo viven en memoria del panel
  // (nunca se persisten como borrador, nunca se redactan solos). Se
  // reinicia con cada "Buscar noticias nuevas" nuevo.
  var singleSourceCandidatesData = [];
  function renderSingleSourceList() {
    if (!draftsShowSingleSource || !draftsShowSingleSource.checked) {
      draftsSingleSourceList.hidden = true;
      return;
    }
    draftsSingleSourceList.hidden = false;
    draftsSingleSourceList.innerHTML = '';
    // Requisito 8 de la verificación previa a sincronizar (pedido de
    // Leonardo, 2026-09-24): esta lista tiene que decir explícitamente que
    // son 0 llamadas de IA -- nunca alcanza con que el resumen de costos de
    // arriba ya lo diga para toda la corrida.
    var header = document.createElement('div');
    header.className = 'admin-hint';
    header.style.marginBottom = '8px';
    header.textContent = '🤖 0 llamadas de IA -- son solo título, resumen del RSS y enlace, para revisar a mano. Ninguno se redactó.';
    draftsSingleSourceList.appendChild(header);
    if (!singleSourceCandidatesData.length) {
      var empty = document.createElement('div');
      empty.className = 'admin-empty';
      empty.textContent = 'Ningún candidato de una sola fuente en la última búsqueda.';
      draftsSingleSourceList.appendChild(empty);
      return;
    }
    singleSourceCandidatesData.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'admin-item';
      var info = document.createElement('div');
      info.className = 'info';
      var ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.textContent = c.title || '(sin título)';
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = c.summary || '(sin resumen del RSS)';
      var linkRow = document.createElement('div');
      linkRow.className = 'meta';
      var a = document.createElement('a');
      a.href = c.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.link;
      linkRow.appendChild(a);
      info.appendChild(ttl); info.appendChild(meta); info.appendChild(linkRow);
      if (c.sameDomainMatchWarning) {
        var warn = document.createElement('div');
        warn.className = 'meta';
        warn.style.color = '#b8860b';
        warn.textContent = '🚫 Se vio contenido parecido, pero de un dominio/grupo no independiente -- no cuenta como segunda fuente';
        info.appendChild(warn);
      }
      row.appendChild(info);
      draftsSingleSourceList.appendChild(row);
    });
  }
  if (draftsShowSingleSource) {
    draftsShowSingleSource.addEventListener('change', renderSingleSourceList);
  }
  // Fantasy/apuestas (pedido de Leonardo, 2026-09-27, punto 1): mismo patrón
  // que la lista de una sola fuente de arriba -- candidatos de la ÚLTIMA
  // búsqueda, solo en memoria del panel, nunca se redactan ni se pierden en
  // silencio. La etiqueta es la que Leonardo pidió textualmente.
  var fantasyBettingCandidatesData = [];
  function renderFantasyBettingList() {
    if (!draftsShowFantasyBetting || !draftsShowFantasyBetting.checked) {
      draftsFantasyBettingList.hidden = true;
      return;
    }
    draftsFantasyBettingList.hidden = false;
    draftsFantasyBettingList.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'admin-hint';
    header.style.marginBottom = '8px';
    header.textContent = '🤖 Fantasy/apuestas — no redactado automáticamente (0 llamadas de IA)';
    draftsFantasyBettingList.appendChild(header);
    if (!fantasyBettingCandidatesData.length) {
      var empty = document.createElement('div');
      empty.className = 'admin-empty';
      empty.textContent = 'Ningún candidato de fantasy/apuestas en la última búsqueda.';
      draftsFantasyBettingList.appendChild(empty);
      return;
    }
    fantasyBettingCandidatesData.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'admin-item';
      var info = document.createElement('div');
      info.className = 'info';
      var ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.textContent = c.title || '(sin título)';
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = c.summary || '(sin resumen del RSS)';
      var matchRow = document.createElement('div');
      matchRow.className = 'meta';
      matchRow.style.color = '#b8860b';
      matchRow.textContent = (c.adviceCategory === 'betting' ? '🎲 Apuestas' : '🏈 Fantasy') + ' -- término detectado: "' + (c.matchedTerm || '') + '"';
      var linkRow = document.createElement('div');
      linkRow.className = 'meta';
      var a = document.createElement('a');
      a.href = c.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.link;
      linkRow.appendChild(a);
      info.appendChild(ttl); info.appendChild(meta); info.appendChild(matchRow); info.appendChild(linkRow);
      row.appendChild(info);
      draftsFantasyBettingList.appendChild(row);
    });
  }
  if (draftsShowFantasyBetting) {
    draftsShowFantasyBetting.addEventListener('change', renderFantasyBettingList);
  }
  // Requisito 19: mientras "Buscar noticias nuevas" está en curso, el panel
  // consulta GET /api/fetch-drafts/status cada tanto para mostrar en qué
  // parte del proceso está -- nunca reemplaza el resultado final (eso sigue
  // viniendo de la respuesta de POST /api/fetch-drafts).
  var fetchStatusPollTimer = null;
  function startFetchStatusPolling() {
    stopFetchStatusPolling();
    fetchStatusPollTimer = setInterval(function () {
      getJSON('/api/fetch-drafts/status').then(function (status) {
        if (status && status.detail) draftsFetchStatus.textContent = status.detail;
      }).catch(function () { /* el resultado final igual llega por la promesa principal */ });
    }, 800);
  }
  function stopFetchStatusPolling() {
    if (fetchStatusPollTimer) { clearInterval(fetchStatusPollTimer); fetchStatusPollTimer = null; }
  }
  // Control de costos (requisito 15; ampliado 2026-09-25 con el
  // descubrimiento por Google Trends -- punto 5 del pedido: "mostrar al
  // finalizar: tendencias de Google examinadas; tendencias compatibles con
  // las categorías; búsquedas de corroboración; candidatos con dos
  // fuentes; llamadas de IA; artículos listos; artículos en revisión;
  // causa del fallback si Google Trends falló; tiempo total"): resumen de
  // la última corrida.
  var FALLBACK_REASON_LABEL = {
    'timeout': 'se agotó el plazo esperando respuesta',
    'network': 'error de red / HTTP',
    'rate-limited': 'límite de tasa (429)',
    'parse-error': 'el XML devuelto no se pudo interpretar',
    'empty-response': 'respondió pero sin ninguna tendencia analizable',
    'unknown': 'motivo no identificado'
  };
  function renderCostSummary(result) {
    if (!draftsCostSummary) return;
    if (typeof result.headlinesExamined !== 'number') { draftsCostSummary.hidden = true; return; }
    var usedTrends = result.trendsMode === 'google-trends-us';
    var lines = [];
    if (usedTrends) {
      lines.push('🌎 Tendencias de Google (EE.UU.) examinadas: ' + (result.trendsExamined || 0));
      lines.push('🗂️ Tendencias compatibles con las categorías activas: ' + (result.trendsCategoryMatched || 0));
    } else {
      // Se cayó al RSS configurado de siempre porque Google Trends falló
      // de verdad en esta corrida (nunca simplemente porque no hubo
      // tendencias compatibles hoy -- eso NO es un fallback, ver
      // admin/pipeline.js buildCandidatesFromTrends). fallbackReason nunca
      // se inventa -- viene tal cual del error real.
      lines.push('⚠️ Google Trends no estuvo disponible en esta corrida' +
        (result.fallbackReason ? ' (' + (FALLBACK_REASON_LABEL[result.fallbackReason] || result.fallbackReason) + ')' : '') +
        ' -- se usó el RSS configurado como respaldo.');
      lines.push('📰 Titulares RSS examinados: ' + result.headlinesExamined);
    }
    lines.push('🚫 Descartados antes de usar IA: ' + (result.discardedBeforeAI || 0));
    // Fantasy/apuestas (pedido 2026-09-27, punto 1/8): cuántos de los
    // "descartados antes de usar IA" de arriba fueron específicamente por
    // este filtro -- nunca oculto dentro del total genérico.
    if (result.filteredCounts && result.filteredCounts.fantasyOrBetting) {
      lines.push('🏈 De los cuales, fantasy/apuestas (consejos de alineación/selección): ' + result.filteredCounts.fantasyOrBetting);
    }
    lines.push('🔎 Búsquedas de corroboración realizadas: ' + (result.corroborationSearchesPerformed || 0));
    lines.push('🔗 Candidatos con dos fuentes: ' + (result.candidatesWithTwoSources || 0));
    lines.push('🤖 Llamadas de IA de redacción realizadas: ' + (result.aiCallsMade || 0));
    // Costo de imágenes (pedido 2026-09-27, punto 3/8): desde el
    // reordenamiento (redactar -> validar -> clasificar -> imagen SOLO si
    // "listo"), esto ya no es automáticamente igual a "Artículos listos" --
    // puede ser MENOR si un "listo" ya traía imagen propia de la fuente RSS
    // (esa descarga es gratis, no es una llamada de IA).
    lines.push('🖼️ Llamadas de IA de imagen realizadas: ' + (result.imageCallsMade || 0));
    lines.push('✅ Artículos listos: ' + (result.readyCount || 0));
    lines.push('⚠️ Artículos que requieren revisión: ' + (result.needsReviewCount || 0));
    lines.push('⛔ Fallos técnicos: ' + (result.technicalFailures || 0));
    if (typeof result.totalTimeMs === 'number') {
      lines.push('⏳ Tiempo total: ' + (result.totalTimeMs / 1000).toFixed(1) + 's');
    }
    if (result.timedOut) lines.push('⏱️ Se alcanzó el plazo máximo de preselección -- esta corrida quedó parcial.');
    draftsCostSummary.innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');
    draftsCostSummary.hidden = false;
  }
  var draftsFilterBtns = {
    listo: document.getElementById('draftsFilterListo'),
    revisar: document.getElementById('draftsFilterRevisar'),
    descartar: document.getElementById('draftsFilterDescartar')
  };
  // Puntuación editorial (pedido de Leonardo, 2026-09-20): filtro activo
  // de la lista de borradores -- null significa "sin filtro, mostrar
  // todo". Un clic sobre el botón ya activo lo apaga (vuelve a "todo").
  var draftsFilterTier = null;
  var TIER_RANK = { listo: 0, revisar: 1, descartar: 2 };
  var TIER_LABEL = { listo: '✅ Listo para revisión rápida', revisar: '⚠️ Requiere revisión', descartar: '⛔ Descartar' };
  Object.keys(draftsFilterBtns).forEach(function (tier) {
    var btn = draftsFilterBtns[tier];
    if (!btn) return;
    btn.addEventListener('click', function () {
      draftsFilterTier = (draftsFilterTier === tier) ? null : tier;
      Object.keys(draftsFilterBtns).forEach(function (t) {
        if (draftsFilterBtns[t]) draftsFilterBtns[t].classList.toggle('active', draftsFilterTier === t);
      });
      renderDraftsList();
    });
  });

  function renderDraftsList() {
    draftsTabCount.textContent = draftsData.length ? '(' + draftsData.length + ')' : '';
    draftsList.innerHTML = '';
    if (!draftsData.length) {
      draftsList.innerHTML = '<div class="admin-empty">No hay borradores pendientes. Tocá "Buscar noticias nuevas" para revisar los feeds configurados.</div>';
      return;
    }
    // Puntuación editorial (2026-09-20, pedido de Leonardo): se ordena
    // PRIMERO por clasificación (listo > revisar > descartar) y DESPUÉS
    // por puntaje descendente dentro de cada grupo -- nunca se reordena
    // draftsData en sí (otras partes del código dependen de su orden/
    // identidad original), se ordena una COPIA solo para pintar la lista.
    var ordered = draftsData.slice().sort(function (a, b) {
      var ra = (a.risk && a.risk.readinessTier) || 'revisar';
      var rb = (b.risk && b.risk.readinessTier) || 'revisar';
      var rankDiff = (TIER_RANK[ra] != null ? TIER_RANK[ra] : 1) - (TIER_RANK[rb] != null ? TIER_RANK[rb] : 1);
      if (rankDiff !== 0) return rankDiff;
      var sa = (a.risk && typeof a.risk.editorialReadinessScore === 'number') ? a.risk.editorialReadinessScore : 0;
      var sb = (b.risk && typeof b.risk.editorialReadinessScore === 'number') ? b.risk.editorialReadinessScore : 0;
      return sb - sa;
    });
    if (draftsFilterTier) {
      ordered = ordered.filter(function (d) { return ((d.risk && d.risk.readinessTier) || 'revisar') === draftsFilterTier; });
    }
    if (!ordered.length) {
      draftsList.innerHTML = '<div class="admin-empty">Ningún borrador coincide con el filtro "' + TIER_LABEL[draftsFilterTier] + '".</div>';
      return;
    }
    ordered.forEach(function (d) {
      var meta = categoryMeta(d.category);
      var row = document.createElement('div');
      row.className = 'admin-item';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = d.icon || meta.icon;
      thumb.style.background = 'var(--surface-2)';

      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="ttl"></div><div class="meta"></div>';
      info.querySelector('.ttl').textContent = d.title;
      var metaText = (d.categoryLabel || meta.label) + ' · ' + (d.dek || '');
      if (d.similarityWarning) {
        metaText = '⚠️ Revisar: se parece mucho al texto original (' + (d.similarityScore || 0) + '%) · ' + metaText;
      }
      if (d.genericHeadingWarning) {
        metaText = '⚠️ Revisar: tiene un subtítulo genérico (ej. "Looking Ahead"/"Conclusion") · ' + metaText;
      }
      // Auditoría 2026-09-13: riesgo real (promocional/vencido/categoría
      // no habilitada) recalculado por el servidor en cada GET /api/drafts
      // (ver pipeline.classifyDraft) -- NUNCA es solo un warning más, si
      // recommendation === 'descartar' se lo muestra bien visible y se
      // deshabilita "Usar este borrador" para que no sea ni siquiera una
      // opción con un clic de distancia.
      var risk = d.risk || null;
      var riskBox = null;
      if (risk && risk.recommendation === 'descartar') {
        riskBox = document.createElement('div');
        riskBox.className = 'meta';
        riskBox.style.color = 'var(--danger, #c0392b)';
        riskBox.style.fontWeight = '600';
        riskBox.textContent = '⛔ Recomendación: descartar — ' + (risk.reasons || []).join(' ');
      }
      info.querySelector('.meta').textContent = metaText;
      if (riskBox) info.appendChild(riskBox);

      // Contenido sensible / transparencia (pedido de Leonardo, 2026-09-24,
      // puntos 1 y 4): nunca oculta "Usar este borrador" -- solo avisa que
      // hace falta revisión humana antes de aprobar. Cuando el motivo real
      // es contenido bloqueado (instrucciones de hacking/fraude/malware,
      // ver risk.sensitiveBlocked) ya se mostró arriba como "Recomendación:
      // descartar", así que acá no se repite.
      var sensitiveMotives = ((risk && risk.sensitiveReasons) || []).concat((risk && risk.transparencyReasons) || []);
      if (sensitiveMotives.length && !(risk && risk.recommendation === 'descartar')) {
        var sensitiveBox = document.createElement('div');
        sensitiveBox.className = 'meta';
        sensitiveBox.style.color = '#b8860b';
        sensitiveBox.style.fontWeight = '600';
        sensitiveBox.textContent = '🔒 Revisión humana obligatoria: ' + sensitiveMotives.join('; ');
        info.appendChild(sensitiveBox);
      }

      var tier = (risk && risk.readinessTier) || 'revisar';

      // Corroboración previa a la redacción (pedido de Leonardo,
      // 2026-09-20, requisito 15): indicación clara de qué encontró (o no
      // encontró) la búsqueda automática de segunda fuente, con los 3
      // textos exactos pedidos -- nunca insinúa una corroboración que no
      // existe.
      // Requisito 3 (pedido de Leonardo, 2026-09-21): estos dos textos
      // tienen que quedar SIEMPRE diferenciados con claridad -- uno es una
      // corroboración real (segunda fuente independiente de verdad
      // encontrada), el otro es solo una advertencia de capa 1 (se vio
      // contenido parecido pero en un dominio/grupo NO independiente, así
      // que nunca cuenta como segunda fuente). `risk.sameDomainMatchWarning`
      // se RECALCULA por completo en cada corrida de "Buscar segunda
      // fuente" (ver pipeline.findAdditionalSourceForDraft) -- ya no queda
      // pegado en true para siempre una vez marcado.
      var hasAdditionalSources = Array.isArray(d.additionalSources) && d.additionalSources.length > 0;
      var corroborationBox = document.createElement('div');
      corroborationBox.className = 'meta';
      corroborationBox.style.fontSize = '.85em';
      if (hasAdditionalSources) {
        corroborationBox.style.color = 'var(--success, #2e7d32)';
        corroborationBox.textContent = '✅ Corroborada por ' + (d.additionalSources.length + 1) + ' medios independientes';
      } else if (risk && risk.sameDomainMatchWarning) {
        corroborationBox.style.color = '#b8860b';
        corroborationBox.textContent = '🚫 Coincidencia descartada por tratarse del mismo dominio';
      } else {
        corroborationBox.style.color = 'var(--text-muted)';
        corroborationBox.textContent = 'ℹ️ Solo una fuente encontrada';
      }
      info.appendChild(corroborationBox);

      // Diagnóstico de la última búsqueda en Google News (pedido de
      // Leonardo, 2026-09-21, a raíz de la prueba manual en Windows donde
      // casi todas las tarjetas mostraban "descartada por mismo dominio").
      // Importante: ese aviso de arriba (sameDomainMatchWarning)
      // viene de la CAPA 1 (los otros feeds configurados del sitio), no de
      // Google News -- puede haber quedado de una corrida anterior (nunca
      // se borra solo). Este bloque de acá abajo es EXCLUSIVAMENTE sobre
      // la capa 2 (Google News) de la última vez que se usó el botón
      // "Buscar segunda fuente" para este borrador -- nunca URLs, nunca
      // texto de terceros, solo conteos y nombres de dominio. Se muestra
      // solo si esa capa 2 llegó a correr, y solo mientras el borrador
      // siga sin una segunda fuente real (nunca es una promoción a "listo").
      if (!hasAdditionalSources && d.corroborationDiagnostic) {
        var diag = d.corroborationDiagnostic;
        var diagDetails = document.createElement('details');
        diagDetails.style.marginTop = '2px';
        var diagSummary = document.createElement('summary');
        diagSummary.className = 'admin-hint';
        diagSummary.style.cursor = 'pointer';
        diagSummary.textContent = '🔬 Diagnóstico de Google News (última búsqueda)';
        diagDetails.appendChild(diagSummary);
        var diagList = document.createElement('ul');
        diagList.style.margin = '4px 0 0 18px';
        diagList.style.padding = '0';
        diagList.style.fontSize = '.85em';
        function diagLi(text) {
          var li = document.createElement('li');
          li.textContent = text;
          diagList.appendChild(li);
        }
        if (d.corroborationSearchFailed) {
          diagLi('⚠️ La búsqueda no se pudo completar (' + (d.corroborationSearchFailedReason || 'error temporal') + ') -- sin datos de diagnóstico de esta corrida.');
        } else {
          diagLi('Resultados de Google News evaluados: ' + (typeof diag.googleNewsResults === 'number' ? diag.googleNewsResults : 'no disponible'));
          diagLi('Dominios evaluados: ' + (diag.domainsEvaluated && diag.domainsEvaluated.length ? diag.domainsEvaluated.join(', ') : 'ninguno'));
          diagLi('Descartados por ser el mismo dominio/grupo que la fuente original: ' + diag.discardedSameDomain);
          diagLi('Descartados por ser agregador/comunicado/red social: ' + diag.discardedExcluded);
          diagLi('Descartados por no poder resolver la URL final: ' + diag.discardedUnresolved);
          diagLi('Descartados por no coincidir con la noticia: ' + diag.discardedNoMatch);
        }
        diagDetails.appendChild(diagList);
        info.appendChild(diagDetails);
      }

      // Puntuación editorial (2026-09-20): tarjeta con clasificación,
      // puntaje y las razones transparentes de cada +/-, siempre visible
      // (no solo cuando hay un bloqueo) para poder priorizar de un
      // vistazo qué revisar primero.
      if (risk && typeof risk.editorialReadinessScore === 'number') {
        var scoreBox = document.createElement('div');
        scoreBox.className = 'meta';
        var tierColor = tier === 'listo' ? 'var(--success, #2e7d32)' : (tier === 'descartar' ? 'var(--danger, #c0392b)' : '#b8860b');
        scoreBox.style.color = tierColor;
        scoreBox.style.fontWeight = '600';
        // Claridad de interfaz (pedido de Leonardo, 2026-09-27, punto 4): un
        // puntaje técnico de 100/100 leía como si el borrador ya estuviera
        // listo, aunque insuficiente aporte editorial lo mandara a
        // "revisar" -- la fórmula NO cambia acá, solo se separa en tres
        // líneas explícitas (puntaje técnico / estado final / motivo) en
        // vez de una sola línea combinada.
        scoreBox.textContent = 'Puntaje técnico: ' + risk.editorialReadinessScore + '/100';
        info.appendChild(scoreBox);

        var statusBox = document.createElement('div');
        statusBox.className = 'meta';
        statusBox.style.color = tierColor;
        statusBox.style.fontWeight = '600';
        statusBox.textContent = 'Estado final: ' + TIER_LABEL[tier];
        info.appendChild(statusBox);

        if (risk.insufficientEditorialValue && risk.editorialValue) {
          var reasonBox = document.createElement('div');
          reasonBox.className = 'meta';
          reasonBox.style.color = '#b8860b';
          reasonBox.style.fontWeight = '600';
          reasonBox.textContent = 'Motivo: aporte editorial insuficiente (' + risk.editorialValue.elementCount + '/10; mínimo requerido: 3)';
          info.appendChild(reasonBox);
        }

        // Calidad de redacción posterior (pedido de Leonardo, 2026-09-27,
        // punto 5): motivo concreto y medible ("Redacción incompleta: 359
        // palabras, 0 subtítulos..."), nunca genérico -- risk.writingQuality.summary
        // ya viene armado con los números reales (ver
        // pipeline.validateDraftWritingQuality). El puntaje técnico de
        // arriba NUNCA se toca por esto.
        if (risk.insufficientWritingQuality && risk.writingQuality) {
          var writingReasonBox = document.createElement('div');
          writingReasonBox.className = 'meta';
          writingReasonBox.style.color = '#b8860b';
          writingReasonBox.style.fontWeight = '600';
          writingReasonBox.textContent = 'Motivo: ' + risk.writingQuality.summary;
          info.appendChild(writingReasonBox);
        }

        var reasonsDetails = document.createElement('details');
        reasonsDetails.style.marginTop = '2px';
        var reasonsSummary = document.createElement('summary');
        reasonsSummary.className = 'admin-hint';
        reasonsSummary.style.cursor = 'pointer';
        reasonsSummary.textContent = 'Ver por qué (' + (risk.readinessReasons || []).length + ' factores)';
        reasonsDetails.appendChild(reasonsSummary);
        var reasonsList = document.createElement('ul');
        reasonsList.style.margin = '4px 0 0 18px';
        reasonsList.style.padding = '0';
        reasonsList.style.fontSize = '.85em';
        (risk.readinessReasons || []).forEach(function (r) {
          var li = document.createElement('li');
          li.textContent = r;
          reasonsList.appendChild(li);
        });
        reasonsDetails.appendChild(reasonsList);
        info.appendChild(reasonsDetails);
      }

      // Aporte editorial verificable (pedido de Leonardo, 2026-09-24, punto
      // 2): cuántos de los 10 elementos del documento tienen evidencia real
      // en el cuerpo (nunca lo que la IA haya declarado por su cuenta, ver
      // pipeline.computeEditorialValue) -- desplegable para ver cuáles.
      if (risk && risk.editorialValue) {
        var ev = risk.editorialValue;
        var valueBox = document.createElement('div');
        valueBox.className = 'meta';
        valueBox.style.color = ev.meetsMinimum ? 'var(--text-muted)' : '#b8860b';
        valueBox.style.fontWeight = ev.meetsMinimum ? 'normal' : '600';
        valueBox.textContent = '📝 Aporte editorial: ' + ev.elementCount + '/10 elementos detectados';
        info.appendChild(valueBox);
        if (ev.elementLabels && ev.elementLabels.length) {
          var evDetails = document.createElement('details');
          evDetails.style.marginTop = '2px';
          var evSummary = document.createElement('summary');
          evSummary.className = 'admin-hint';
          evSummary.style.cursor = 'pointer';
          evSummary.textContent = 'Ver cuáles';
          evDetails.appendChild(evSummary);
          var evList = document.createElement('ul');
          evList.style.margin = '4px 0 0 18px';
          evList.style.padding = '0';
          evList.style.fontSize = '.85em';
          ev.elementLabels.forEach(function (label) {
            var li = document.createElement('li');
            li.textContent = label;
            evList.appendChild(li);
          });
          evDetails.appendChild(evList);
          info.appendChild(evDetails);
        }
      }

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      if (d.sourceUrl) {
        var sourceLink = document.createElement('a');
        sourceLink.href = d.sourceUrl;
        sourceLink.target = '_blank';
        sourceLink.rel = 'noopener';
        sourceLink.textContent = 'Fuente';
        actions.appendChild(sourceLink);
      }
      var useBtn = document.createElement('button');
      useBtn.type = 'button'; useBtn.textContent = 'Usar este borrador';
      // Dos motivos INDEPENDIENTES para deshabilitar "Usar este borrador":
      // 1. risk.eligibleToUse === false -- bloqueo mecánico de verdad
      //    (promocional/vencido/oferta comercial/duplicado/categoría no
      //    habilitada). Comportamiento SIN CAMBIOS respecto a la auditoría
      //    2026-09-13 (mismo campo, mismo texto exacto de title=) -- ver
      //    test-draft-button-disabled-dom.js.
      // 2. Puntuación editorial (2026-09-20, nuevo): puntaje < 50, aunque
      //    no haya ningún bloqueo mecánico -- regla 4 del pedido. Esto es
      //    un gate NUEVO y SEPARADO, con su propio texto de title=, para
      //    no pisar el motivo exacto que ya prueba el archivo de arriba.
      var blockedByRisk = !!(risk && risk.eligibleToUse === false);
      var blockedByScore = !blockedByRisk && !!(risk && typeof risk.editorialReadinessScore === 'number' && risk.editorialReadinessScore < 50);
      var blockedFromUse = blockedByRisk || blockedByScore;
      if (blockedFromUse) {
        // Auditoría 2026-09-13 (seguimiento): tener `disabled = true` en JS
        // no alcanza si el CSS no distingue el estado -- el botón quedaba
        // técnicamente deshabilitado (un clic real no hacía nada) pero SE
        // VEÍA igual que uno habilitado, lo cual es en sí mismo un defecto
        // de UI real. Acá se fuerzan las 4 señales pedidas explícitamente:
        // atributo disabled real (no solo la propiedad) y aria-disabled
        // para lectores de pantalla. NO se le agrega tabindex: un
        // <button disabled> ya queda excluido del foco/tab order en
        // cualquier navegador estándar sin necesidad de nada más --
        // agregar tabindex="-1" a mano puede confundir a algunas
        // implementaciones del algoritmo de foco (lo mínimo indispensable
        // es más seguro que "reforzarlo" con algo que no hace falta). El
        // gris/apagado y el cursor "not-allowed" los provee la regla
        // nueva en admin.css (.admin-item .item-actions button:disabled).
        useBtn.disabled = true;
        useBtn.setAttribute('disabled', 'disabled');
        useBtn.setAttribute('aria-disabled', 'true');
        useBtn.title = blockedByRisk
          ? 'No se puede usar: contenido promocional o vencido'
          : ('No se puede usar: puntaje de preparación editorial insuficiente (' + risk.editorialReadinessScore + '/100, mínimo 50)');
        // No se agrega NINGÚN listener de click/keydown -- ni siquiera hay
        // una función que ejecutar si alguien lo fuerza desde las devtools;
        // el bloqueo de verdad (que nada se pueda publicar así) lo hace el
        // servidor en validateSourcesAndQuality, no este botón.
      } else {
        useBtn.addEventListener('click', function () { useDraft(d); });
      }
      var discardBtn = document.createElement('button');
      discardBtn.type = 'button'; discardBtn.textContent = 'Descartar'; discardBtn.className = 'danger';
      discardBtn.addEventListener('click', function () { discardDraft(d); });
      actions.appendChild(useBtn);
      actions.appendChild(discardBtn);

      // Requisito 16 (corroboración previa a la redacción, 2026-09-20):
      // reintento manual, solo visible cuando todavía no hay segunda
      // fuente Y el borrador no está ya "listo" (si ya está listo no hace
      // falta) -- nunca regenera el borrador ni vuelve a llamar a la IA,
      // solo repite la búsqueda de fuente (mismo criterio que la corrida
      // automática, ver pipeline.findAdditionalSourceForDraft).
      if (!hasAdditionalSources && tier !== 'listo') {
        var findSourceBtn = document.createElement('button');
        findSourceBtn.type = 'button';
        findSourceBtn.textContent = '🔎 Buscar segunda fuente';
        findSourceBtn.addEventListener('click', function () {
          findSourceBtn.disabled = true;
          findSourceBtn.textContent = 'Buscando...';
          postJSON('/api/drafts/find-source', { slug: d.slug }).then(function (result) {
            // El borrador vuelve actualizado (con o sin fuente nueva) en
            // result.draft siempre que el slug existía -- incluido el
            // diagnóstico de Google News de esta corrida (ver pipeline.js),
            // así que se refresca la tarjeta en ambos casos para que se vea
            // sin tener que recargar la página.
            if (result && result.draft) {
              draftsData = draftsData.map(function (x) { return x.slug === d.slug ? result.draft : x; });
              renderDraftsList();
            } else {
              findSourceBtn.disabled = false;
              findSourceBtn.textContent = '🔎 Buscar segunda fuente';
            }
            if (result && result.found) {
              toast('Fuente independiente encontrada y agregada.');
            } else if (result && result.searchFailed) {
              // Requisito 6: si la búsqueda en sí no se pudo completar
              // (timeout/red/límite de tasa/error de parseo), se lo decimos
              // con un mensaje distinto y breve -- nunca se inventa una
              // fuente ni se bloquea el panel, el candidato sigue igual.
              toast('No se pudo completar la búsqueda ahora mismo (' + (result.searchFailedReason || 'error temporal') + '). Probá de nuevo más tarde.', true);
            } else {
              toast('No se encontró todavía ninguna fuente independiente confiable para esta noticia. Mirá el diagnóstico en la tarjeta para más detalle.', true);
            }
          }).catch(function () {
            findSourceBtn.disabled = false;
            findSourceBtn.textContent = '🔎 Buscar segunda fuente';
            toast('No se pudo buscar una segunda fuente', true);
          });
        });
        actions.appendChild(findSourceBtn);
      }

      // Botón manual "Generar imagen" (pedido de Leonardo, 2026-09-27, punto
      // 4): desde que la imagen automática pasó a depender de que el
      // borrador quede "listo" (ver pipeline.runFetchNewDrafts), un
      // borrador sin imagen necesita este botón para completarla a demanda
      // -- UNA sola llamada real de IA por clic, nunca un reintento
      // automático si falla. Advertencia breve y visible ANTES del clic
      // (pedido explícito), no solo en el toast de después.
      if (!d.image) {
        var genImageBtn = document.createElement('button');
        genImageBtn.type = 'button';
        genImageBtn.textContent = '🖼️ Generar imagen (1 llamada de IA)';
        genImageBtn.title = 'Genera una imagen de portada con IA para este borrador -- una sola llamada real, sin reintento automático si falla.';
        genImageBtn.addEventListener('click', function () {
          genImageBtn.disabled = true;
          genImageBtn.textContent = 'Generando...';
          postJSON('/api/drafts/generate-image', { slug: d.slug }).then(function (result) {
            if (result && result.draft) {
              draftsData = draftsData.map(function (x) { return x.slug === d.slug ? result.draft : x; });
              renderDraftsList();
            } else {
              genImageBtn.disabled = false;
              genImageBtn.textContent = '🖼️ Generar imagen (1 llamada de IA)';
            }
            if (result && result.generated) {
              toast('Imagen generada.');
            } else if (result && result.alreadyHadImage) {
              toast('Este borrador ya tenía una imagen -- no se generó una nueva.');
            } else {
              // Pedido 2026-09-27, punto 7: "si la llamada manual falla ->
              // aviso legible, sin reintento y sin romper el borrador" --
              // result.error viene tal cual de imageGen, nunca se inventa
              // un motivo genérico si hay uno real disponible.
              toast('No se pudo generar la imagen' + (result && result.error ? ' (' + result.error + ')' : '') + '.', true);
            }
          }).catch(function () {
            genImageBtn.disabled = false;
            genImageBtn.textContent = '🖼️ Generar imagen (1 llamada de IA)';
            toast('No se pudo generar la imagen', true);
          });
        });
        actions.appendChild(genImageBtn);
      }

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      draftsList.appendChild(row);
    });
  }

  function useDraft(d) {
    document.querySelector('.admin-tab[data-tab="articles"]').click();
    articleEditIndex = null;
    // Fase 10: sourceUrl/sourceTitle ya NO viajan por pendingDraft -- ahora
    // tienen su propio campo visible en el formulario (ver más abajo), así
    // que se cargan ahí directamente, igual que cualquier otro campo del
    // borrador. pendingDraft se sigue usando solo para lo que de verdad no
    // tiene ningún control editable (las advertencias calculadas al
    // descubrir el borrador).
    pendingDraft = {
      slug: d.slug,
      similarityWarning: d.similarityWarning, similarityScore: d.similarityScore,
      genericHeadingWarning: d.genericHeadingWarning,
      // Registro editorial consolidado + aporte editorial verificable
      // (pedido 2026-09-24, verificación final 2026-09-25): tampoco tienen
      // ningún control propio en el formulario -- mismo motivo que las tres
      // señales de arriba, así que viajan por el mismo mecanismo. Sin esto,
      // un artículo NUEVO creado desde "Usar este borrador" los perdía por
      // completo: buildArticleFromForm() arma el payload leyendo solo los
      // inputs del formulario (que no tienen ningún campo para esto), y al
      // ser un artículo nuevo no hay ningún registro previo en el servidor
      // con el que mergear (articles-store.upsertArticle, rama isNew: push
      // directo) -- el merge seguro NUNCA protege el primer guardado.
      editorialMeta: d.editorialMeta || null,
      editorialValue: d.editorialValue || null
    };
    articleFormTitle.textContent = 'Revisar borrador';
    ensureCategoryOption(articleCategory, d.category);
    articleCategory.value = d.category;
    articleDate.value = d.date || todayISO();
    articleTitle.value = d.title;
    articleSlug.value = d.slug || '';
    articleSlug.dataset.auto = 'false';
    articleDek.value = d.dek || '';
    articleCurrentImage = d.image || '';
    updateArticleImageStatus();
    articleImageOrigin.value = d.imageOrigin || '';
    populateImageLicenseSelect(d.imageLicense || '');
    articleImageCredit.value = d.imageCredit || '';
    articleImageTool.value = d.imageTool || '';
    articleImageModel.value = d.imageModel || '';
    articleImageGeneratedAt.value = (d.imageGeneratedAt || '').slice(0, 10);
    articleImagePrompt.value = d.imagePrompt || '';
    articleImageHumanEdited.checked = !!d.imageHumanEdited;
    articleImageOwnerAttestation.checked = !!d.imageOwnerAttestation;
    articleImageSource.value = d.imageSource || '';
    articleImageSourceUrlInput.value = d.imageSourceUrl || '';
    articleImageReuseAuthorized.checked = !!d.imageReuseAuthorized;
    updateImageProvenanceVisibility();
    articleVideoUrl.value = d.videoUrl || '';
    articleSourceUrl.value = d.sourceUrl || '';
    articleSourceTitle.value = d.sourceTitle || '';
    renderAdditionalSources(d.additionalSources || []);
    currentSourceProvenance = {
      sourceHeadline: d.sourceHeadline || null, sourceDomain: d.sourceDomain || null,
      sourceAuthor: d.sourceAuthor || null, sourcePublishedAt: d.sourcePublishedAt || null,
      sourceRetrievedAt: d.sourceRetrievedAt || null, keyClaims: d.keyClaims || [],
      singleSourceWarning: !!d.singleSourceWarning
    };
    articleCheckSourceStatus.textContent = '';
    renderQuickReviewCard();
    articleReadTime.value = d.readTime || '';
    articleTrending.checked = !!d.trending;
    articleBody.value = d.body || '';
    // Un borrador de RSS/IA nunca puede llegar directo a 'published' --
    // arranca en 'review' (completo, esperando revisión humana) y sin la
    // confirmación tildada, así que aunque se toque "Guardar artículo"
    // sin cambiar nada más, queda en revisión y no se publica solo.
    articleStatus.value = 'review';
    articleRedirectTo.value = '';
    articleEditorialApproval.checked = false;
    updateStatusFieldsVisibility();
    articleCancelBtn.hidden = false;
    clearArticleValidationErrors();
    resetChecklist();
    scheduleLiveValidation();
    articleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Borrador cargado en estado "En revisión" — revisalo, tildá la confirmación y cambiá a "Publicado" cuando estés listo (si falta la procedencia de la imagen, completala antes).');
  }

  function discardDraft(d) {
    if (!confirm('¿Descartar este borrador? No se va a volver a sugerir esta misma noticia.')) return;
    deleteJSON('/api/drafts', { slug: d.slug, used: false }).then(function () {
      draftsData = draftsData.filter(function (x) { return x.slug !== d.slug; });
      renderDraftsList();
      toast('Borrador descartado');
    }).catch(function () {
      toast('No se pudo descartar el borrador', true);
    });
  }

  fetchDraftsBtn.addEventListener('click', function () {
    fetchDraftsBtn.disabled = true;
    draftsCostSummary.hidden = true;
    // Requisito 19 (punto 5 del pedido 2026-09-25): texto inicial -- se
    // sobrescribe enseguida por el primer resultado del polling de
    // progreso (ver startFetchStatusPolling). Google Trends es ahora el
    // punto de partida del descubrimiento, así que el primer paso real de
    // cada corrida es consultarlo (ver admin/pipeline.js runFetchNewDrafts).
    draftsFetchStatus.textContent = 'Consultando tendencias de Estados Unidos…';
    startFetchStatusPolling();
    postJSON('/api/fetch-drafts', {}).then(function (result) {
      fetchDraftsBtn.disabled = false;
      stopFetchStatusPolling();
      // Verificación previa a sincronizar (pedido de Leonardo, 2026-09-24):
      // dos búsquedas simultáneas (otra pestaña, u otra corrida que ya
      // estaba en curso) -- el servidor devuelve esto de inmediato, SIN
      // haber tocado nada. Nunca se pisa el resumen/lista de la corrida
      // que sigue en curso con esta respuesta vacía -- se deja todo tal
      // cual estaba y solo se avisa.
      if (result.alreadyRunning) {
        draftsFetchStatus.textContent = result.message || 'Ya hay una búsqueda en curso.';
        toast(result.message || 'Ya hay una búsqueda de noticias en curso -- esperá a que termine.', true);
        return;
      }
      singleSourceCandidatesData = result.singleSourceCandidates || [];
      renderSingleSourceList();
      fantasyBettingCandidatesData = result.fantasyBettingCandidates || [];
      renderFantasyBettingList();
      if (result.noApiKey) {
        draftsFetchStatus.textContent = '';
        toast('Falta configurar la API key en admin/config.json para poder redactar borradores.', true);
        return;
      }
      renderCostSummary(result);
      // Requisito 14: la fase 1 no aprobó ningún candidato -- se muestra el
      // mensaje exacto pedido y se corta acá (ya está garantizado que
      // aiCallsMade === 0 en este caso, ver pipeline.fetchNewDrafts).
      if (result.message) {
        draftsFetchStatus.textContent = result.message;
        toast(result.message, true);
        return getJSON('/api/drafts').then(function (list) {
          draftsData = list;
          renderDraftsList();
        });
      }
      // Honestidad ante todo (auditoría 2026-09-13, vigente tras el pedido
      // 2026-09-25): se dice explícitamente de dónde salió esta corrida --
      // Google Trends (con datos reales de Google, nunca inventados) o el
      // RSS de respaldo (sin métricas de tendencia, igual que siempre) --
      // en vez de simular algo o dejar un texto que ya no es cierto.
      draftsFetchStatus.textContent = (result.trendsMode === 'google-trends-us'
        ? 'Modo Google Trends (Estados Unidos)'
        : 'Modo RSS de respaldo (sin métricas de tendencia)') + ' — última búsqueda: ' + new Date().toLocaleString();
      var errorList = result.errors || [];
      var fc = result.filteredCounts || {};
      var msg = (result.added || 0) + ' borrador(es) nuevo(s)';
      if (fc.promotional) msg += ' — ⛔ ' + fc.promotional + ' descartado(s) por lenguaje promocional/CTA';
      if (fc.expired) msg += ' — ⛔ ' + fc.expired + ' descartado(s) por plazo/fecha ya vencida';
      if (fc.categoryExcluded) msg += ' — 🚫 ' + fc.categoryExcluded + ' fuera de las categorías activas para noticias nuevas (AI, Technology, Gaming, Movies TV & Anime, Sports, Business)';
      if (result.flaggedForSimilarity) msg += ' — ⚠️ ' + result.flaggedForSimilarity + ' marcado(s) por parecerse mucho al texto original, revisalos antes de publicar';
      if (result.flaggedForGenericHeading) msg += ' — ⚠️ ' + result.flaggedForGenericHeading + ' marcado(s) con subtítulo genérico, revisalos antes de publicar';
      if (errorList.length) msg += ' — ' + errorList.length + ' error(es): ' + errorList.map(function (e) { return e.error; }).join(' | ');
      toast(msg, (result.added || 0) === 0 && errorList.length > 0);
      return getJSON('/api/drafts').then(function (list) {
        draftsData = list;
        renderDraftsList();
      });
    }).catch(function (err) {
      fetchDraftsBtn.disabled = false;
      stopFetchStatusPolling();
      draftsFetchStatus.textContent = '';
      toast('No se pudo buscar noticias nuevas: ' + (err && err.message || 'error desconocido'), true);
    });
  });

  /* =====================================================
     CATEGORÍAS — alta/baja/rename de las categorías principales del
     sitio (menú, footer, chips). Mismo patrón que el gestor de temas:
     acción -> POST/PATCH/DELETE a /api/categories -> refrescar la lista
     local -> /api/regenerate para que generate_pages.py reconstruya el
     sidebar/footer/chips/páginas de categoría con los datos nuevos.
     ===================================================== */
  var categoriesList = document.getElementById('categoriesList');
  var categoryForm = document.getElementById('categoryForm');
  var categoryLabelInput = document.getElementById('categoryLabel');
  var categoryIconInput = document.getElementById('categoryIcon');
  var categoryDescriptionInput = document.getElementById('categoryDescription');

  function articleCountFor(slug) {
    return articlesData.filter(function (a) { return a.category === slug; }).length;
  }

  function renderCategoriesManager() {
    categoriesList.innerHTML = '';
    if (!categories.length) {
      categoriesList.innerHTML = '<p class="admin-empty">Todavía no hay categorías.</p>';
      return;
    }
    categories.forEach(function (cat) {
      var count = articleCountFor(cat.slug);
      var item = document.createElement('div');
      item.className = 'admin-item';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = cat.icon || '📄';
      item.appendChild(thumb);

      var info = document.createElement('div');
      info.className = 'info';
      var ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.textContent = cat.label;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<span>/' + cat.slug + '</span><span>' + count + ' artículo(s)</span>';
      info.appendChild(ttl);
      info.appendChild(meta);
      item.appendChild(info);

      var actions = document.createElement('div');
      actions.className = 'item-actions';

      var renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.textContent = 'Renombrar';
      renameBtn.addEventListener('click', function () { renameCategoryPrompt(cat); });
      actions.appendChild(renameBtn);

      if (cat.slug !== 'trending') {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger';
        delBtn.textContent = 'Eliminar';
        delBtn.addEventListener('click', function () { deleteCategoryConfirm(cat, count); });
        actions.appendChild(delBtn);
      }

      item.appendChild(actions);
      categoriesList.appendChild(item);
    });
  }

  function refreshCategories() {
    return getJSON('/api/categories').then(function (list) {
      categories = list;
      renderCategoriesManager();
      fillSelect(heroCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });
      fillSelect(articleCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });
    });
  }

  function renameCategoryPrompt(cat) {
    var newLabel = window.prompt('Nuevo nombre para "' + cat.label + '":', cat.label);
    if (newLabel === null) return;
    newLabel = newLabel.trim();
    if (!newLabel) return;
    var newIcon = window.prompt('Ícono para "' + newLabel + '" (dejar igual si no querés cambiarlo):', cat.icon || '');
    if (newIcon === null) newIcon = cat.icon;
    apiRequest('PATCH', '/api/categories', { slug: cat.slug, label: newLabel, icon: newIcon }).then(function () {
      toast('Categoría renombrada a "' + newLabel + '"');
      return refreshCategories();
    }).then(function () {
      return postJSON('/api/regenerate', {});
    }).catch(function (err) {
      toast(err.message || 'No se pudo renombrar la categoría', true);
    });
  }

  function deleteCategoryConfirm(cat, count) {
    if (count > 0) {
      toast('Esta categoría todavía tiene ' + count + ' artículo(s). Movelos o eliminalos antes de borrar la categoría.', true);
      return;
    }
    if (!window.confirm('¿Eliminar la categoría "' + cat.label + '"? Se borra también su página.')) return;
    apiRequest('DELETE', '/api/categories', { slug: cat.slug }).then(function () {
      toast('Categoría "' + cat.label + '" eliminada');
      return refreshCategories();
    }).then(function () {
      return postJSON('/api/regenerate', {});
    }).catch(function (err) {
      toast(err.message || 'No se pudo eliminar la categoría', true);
    });
  }

  categoryForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var label = categoryLabelInput.value.trim();
    if (!label) return;
    postJSON('/api/categories', {
      label: label,
      icon: categoryIconInput.value.trim(),
      description: categoryDescriptionInput.value.trim()
    }).then(function () {
      toast('Categoría "' + label + '" agregada');
      categoryForm.reset();
      return refreshCategories();
    }).then(function () {
      return postJSON('/api/regenerate', {});
    }).catch(function (err) {
      toast(err.message || 'No se pudo agregar la categoría', true);
    });
  });

  /* =====================================================
     REDES SOCIALES (Instagram)
     ===================================================== */
  var socialStatusText = document.getElementById('socialStatusText');
  var igUserIdInput = document.getElementById('igUserIdInput');
  var igTokenInput = document.getElementById('igTokenInput');
  var saveSocialConfigBtn = document.getElementById('saveSocialConfigBtn');
  var socialArticlesList = document.getElementById('socialArticlesList');

  var socialStatus = { configured: false, igUserId: '' };
  var socialLog = { instagram: {} };
  var socialExpandedSlug = null; // qué fila tiene el editor de caption abierto

  function renderSocialStatus() {
    igUserIdInput.value = socialStatus.igUserId || '';
    if (socialStatus.configured) {
      socialStatusText.textContent = '✅ Conectado (cuenta ' + socialStatus.igUserId + ')';
    } else {
      socialStatusText.textContent = '⚠️ Todavía no está conectado — completá el ID de cuenta y el token de abajo.';
    }
  }

  function loadSocialStatus() {
    return getJSON('/api/social/status').then(function (data) {
      socialStatus = data.instagram;
      renderSocialStatus();
      renderSocialList();
    });
  }

  function loadSocialLog() {
    return getJSON('/api/social/log').then(function (data) {
      socialLog = data;
      renderSocialList();
    });
  }

  saveSocialConfigBtn.addEventListener('click', function () {
    var patch = { igUserId: igUserIdInput.value.trim(), pageAccessToken: igTokenInput.value.trim() };
    if (!patch.igUserId && !patch.pageAccessToken) {
      toast('No hay nada nuevo para guardar', true);
      return;
    }
    saveSocialConfigBtn.disabled = true;
    postJSON('/api/social/config', { instagram: patch }).then(function () {
      igTokenInput.value = '';
      toast('Conexión con Instagram guardada');
      return loadSocialStatus();
    }).catch(function (err) {
      toast(err.message || 'No se pudo guardar la conexión', true);
    }).then(function () {
      saveSocialConfigBtn.disabled = false;
    });
  });

  function buildInstagramCaption(a) {
    var lines = [(a.icon || '📰') + ' ' + a.title];
    if (a.dek) { lines.push(''); lines.push(a.dek); }
    lines.push('');
    lines.push('Full story on vexlowhq.com 🔗');
    lines.push('');
    lines.push('#' + (a.category || 'news') + ' #vexlow');
    return lines.join('\n');
  }

  // Notas publicables: tienen página propia (body) e imagen de portada.
  // Se muestran las más nuevas primero, tope 40 para no volver la
  // pestaña interminable.
  function socialCandidates() {
    return articlesData
      .filter(function (a) { return a.slug && a.image && a.body && a.body.trim(); })
      .slice()
      .sort(function (x, y) { return (y.date || '').localeCompare(x.date || ''); })
      .slice(0, 40);
  }

  function renderSocialList() {
    socialArticlesList.innerHTML = '';
    var entries = socialCandidates();
    if (!entries.length) {
      socialArticlesList.innerHTML = '<div class="admin-empty">Todavía no hay notas con página propia + imagen para publicar.</div>';
      return;
    }
    entries.forEach(function (a) {
      var meta = categoryMeta(a.category);
      var posted = socialLog.instagram && socialLog.instagram[a.slug];
      var isStockPhoto = /^img\/drafts\//.test(a.image || '');

      var row = document.createElement('div');
      row.className = 'admin-item';

      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = a.icon || meta.icon;
      thumb.style.background = 'var(--surface-2)';

      var info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="ttl"></div><div class="meta"></div>';
      info.querySelector('.ttl').textContent = a.title;
      var metaText = (a.categoryLabel || meta.label) + ' · ' + a.date;
      if (posted) metaText = '✅ Publicado en Instagram el ' + new Date(posted.postedAt).toLocaleDateString('es-AR') + ' · ' + metaText;
      if (isStockPhoto) metaText = '⚠️ Foto de prensa original (verificar derechos antes de postear) · ' + metaText;
      info.querySelector('.meta').textContent = metaText;

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      var pubBtn = document.createElement('button');
      pubBtn.type = 'button';
      pubBtn.textContent = posted ? 'Publicar de nuevo' : 'Publicar en Instagram';
      if (!socialStatus.configured) {
        pubBtn.disabled = true;
        pubBtn.title = 'Conectá Instagram arriba primero';
      }
      pubBtn.addEventListener('click', function () {
        socialExpandedSlug = socialExpandedSlug === a.slug ? null : a.slug;
        renderSocialList();
      });
      actions.appendChild(pubBtn);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      socialArticlesList.appendChild(row);

      if (socialExpandedSlug === a.slug) {
        socialArticlesList.appendChild(buildSocialCaptionEditor(a));
      }
    });
  }

  function buildSocialCaptionEditor(a) {
    var box = document.createElement('div');
    box.className = 'admin-form';
    box.style.marginTop = '-8px';
    box.style.marginBottom = '14px';

    var label = document.createElement('label');
    label.textContent = 'Texto de la publicación';
    label.style.display = 'block';
    label.style.fontSize = '12.5px';
    label.style.marginBottom = '8px';

    var textarea = document.createElement('textarea');
    textarea.rows = 8;
    textarea.style.width = '100%';
    textarea.value = buildInstagramCaption(a);

    var actions = document.createElement('div');
    actions.className = 'form-actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-primary';
    confirmBtn.textContent = 'Confirmar y publicar';
    confirmBtn.addEventListener('click', function () {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      confirmBtn.textContent = 'Publicando…';
      postJSON('/api/social/instagram/publish', { slug: a.slug, caption: textarea.value }).then(function () {
        toast('¡Publicado en Instagram!');
        socialExpandedSlug = null;
        return loadSocialLog();
      }).catch(function (err) {
        toast(err.message || 'No se pudo publicar', true);
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        confirmBtn.textContent = 'Confirmar y publicar';
      });
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.addEventListener('click', function () {
      socialExpandedSlug = null;
      renderSocialList();
    });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    box.appendChild(label);
    box.appendChild(textarea);
    box.appendChild(actions);
    return box;
  }

  /* =====================================================
     SPRINT
     ===================================================== */
  var sprintTitle = document.getElementById('sprintTitle');
  var sprintStatusText = document.getElementById('sprintStatusText');
  var sprintStartBtn = document.getElementById('sprintStartBtn');
  var sprintResetBtn = document.getElementById('sprintResetBtn');
  var sprintDaysList = document.getElementById('sprintDaysList');
  var sprintAccountsList = document.getElementById('sprintAccountsList');

  var sprintStatus = null;
  var sprintGenerated = {}; // { [day]: { images, caption, postTitle } } -- carruseles ya generados en esta sesión, pendientes de publicar

  function loadSprintStatus() {
    return getJSON('/api/sprint/status').then(function (data) {
      sprintStatus = data;
      renderSprintHeader();
      renderSprintDays();
      renderSprintAccounts();
    });
  }

  function renderSprintHeader() {
    sprintTitle.textContent = sprintStatus.name || 'Vexlow Reach Sprint';
    if (!sprintStatus.startDate) {
      sprintStatusText.textContent = 'Todavía no arrancó. Tocá "Iniciar sprint hoy" cuando estés listo para publicar el Día 1.';
      sprintStartBtn.hidden = false;
      sprintResetBtn.hidden = true;
    } else {
      var doneCount = sprintStatus.days.filter(function (d) { return d.done; }).length;
      sprintStatusText.textContent = 'Arrancó el ' + sprintStatus.startDate + ' · Día ' + sprintStatus.currentDay + ' de ' + sprintStatus.days.length + ' · ' + doneCount + ' días completados';
      sprintStartBtn.hidden = true;
      sprintResetBtn.hidden = false;
    }
  }

  sprintStartBtn.addEventListener('click', function () {
    postJSON('/api/sprint/start', {}).then(function () {
      toast('Sprint iniciado — hoy es el Día 1');
      return loadSprintStatus();
    }).catch(function (err) { toast(err.message || 'No se pudo iniciar el sprint', true); });
  });
  sprintResetBtn.addEventListener('click', function () {
    if (!window.confirm('¿Reiniciar el sprint? Se borra el progreso (días marcados, KPIs cargados). Las publicaciones que ya salieron en Instagram no se tocan.')) return;
    postJSON('/api/sprint/reset', {}).then(function () {
      toast('Sprint reiniciado');
      return loadSprintStatus();
    }).catch(function (err) { toast(err.message || 'No se pudo reiniciar', true); });
  });

  function renderSprintAccounts() {
    sprintAccountsList.innerHTML = '';
    (sprintStatus.accounts || []).forEach(function (a) {
      var row = document.createElement('div');
      row.style.padding = '8px 0';
      row.style.borderBottom = '1px solid var(--border)';
      row.innerHTML = '<b>' + a.handle + '</b> — <span style="color:var(--text-muted);font-size:13px;">' + a.why + '</span>';
      sprintAccountsList.appendChild(row);
    });
  }

  function fieldBlock(label, contentEl) {
    var wrap = document.createElement('div');
    wrap.style.marginBottom = '10px';
    var lbl = document.createElement('div');
    lbl.className = 'admin-hint';
    lbl.style.marginTop = '0';
    lbl.textContent = label;
    wrap.appendChild(lbl);
    wrap.appendChild(contentEl);
    return wrap;
  }

  function textBox(text) {
    var box = document.createElement('div');
    box.style.background = 'var(--surface-2)';
    box.style.border = '1px solid var(--border)';
    box.style.borderRadius = 'var(--radius-m)';
    box.style.padding = '8px 10px';
    box.style.fontSize = '13px';
    box.style.whiteSpace = 'pre-wrap';
    box.textContent = text;
    return box;
  }

  function buildReelBlock(d) {
    var wrap = document.createElement('div');

    wrap.appendChild(fieldBlock('Gancho (0–2s)', textBox(d.hook || '')));
    if (d.beats && d.beats.length) {
      wrap.appendChild(fieldBlock('Desarrollo', textBox(d.beats.join('\n'))));
    }
    if (d.music) wrap.appendChild(fieldBlock('Música', textBox(d.music)));
    wrap.appendChild(fieldBlock('Título', textBox(d.postTitle || '')));
    wrap.appendChild(fieldBlock('Descripción', textBox(d.caption || '')));

    if (d.done) {
      var doneMsg = document.createElement('div');
      doneMsg.className = 'admin-hint';
      doneMsg.textContent = '✅ Marcado como publicado' + (d.postUrl ? (' — ' + d.postUrl) : '');
      wrap.appendChild(doneMsg);
    } else {
      var urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.placeholder = 'Link del Reel en Instagram (opcional)';
      urlInput.style.width = '100%';
      urlInput.style.marginBottom = '8px';
      var markBtn = document.createElement('button');
      markBtn.type = 'button';
      markBtn.className = 'btn-primary';
      markBtn.textContent = 'Marcar Reel como publicado hoy';
      markBtn.addEventListener('click', function () {
        postJSON('/api/sprint/mark-reel', { day: d.day, postUrl: urlInput.value.trim() || null }).then(function () {
          toast('Día ' + d.day + ' marcado como hecho');
          return loadSprintStatus();
        }).catch(function (err) { toast(err.message || 'No se pudo marcar', true); });
      });
      wrap.appendChild(urlInput);
      wrap.appendChild(markBtn);
    }
    return wrap;
  }

  function buildCarouselBlock(d) {
    var wrap = document.createElement('div');
    var pending = sprintGenerated[d.day];

    var captionArea = document.createElement('textarea');
    captionArea.rows = 4;
    captionArea.style.width = '100%';
    captionArea.value = (pending && pending.caption) || d.caption || '';
    wrap.appendChild(fieldBlock('Descripción (editable)', captionArea));

    var previewRow = document.createElement('div');
    previewRow.style.display = 'flex';
    previewRow.style.gap = '8px';
    previewRow.style.flexWrap = 'wrap';
    previewRow.style.marginBottom = '10px';
    var imagesToShow = pending ? pending.images : null;
    if (imagesToShow) {
      imagesToShow.forEach(function (relPath) {
        var img = document.createElement('img');
        img.src = '/site/' + relPath + '?t=' + Date.now();
        img.style.width = '110px';
        img.style.height = '110px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '8px';
        img.style.border = '1px solid var(--border)';
        previewRow.appendChild(img);
      });
      wrap.appendChild(previewRow);
    }

    if (d.done) {
      var doneMsg = document.createElement('div');
      doneMsg.className = 'admin-hint';
      doneMsg.textContent = '✅ Carrusel publicado (media ' + d.mediaId + ')';
      wrap.appendChild(doneMsg);
      return wrap;
    }

    var actions = document.createElement('div');
    actions.className = 'form-actions';

    var genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.textContent = imagesToShow ? 'Generar de nuevo' : 'Generar carrusel';
    genBtn.addEventListener('click', function () {
      genBtn.disabled = true;
      genBtn.textContent = 'Generando…';
      postJSON('/api/sprint/carousel/generate', { day: d.day }).then(function (result) {
        sprintGenerated[d.day] = { images: result.images, caption: captionArea.value, postTitle: result.postTitle };
        toast('Carrusel generado — revisá las imágenes');
        renderSprintDays();
      }).catch(function (err) {
        toast(err.message || 'No se pudo generar el carrusel', true);
        genBtn.disabled = false;
        genBtn.textContent = 'Generar carrusel';
      });
    });
    actions.appendChild(genBtn);

    if (imagesToShow) {
      var pubBtn = document.createElement('button');
      pubBtn.type = 'button';
      pubBtn.className = 'btn-primary';
      pubBtn.textContent = 'Confirmar y publicar';
      pubBtn.addEventListener('click', function () {
        pubBtn.disabled = true;
        pubBtn.textContent = 'Publicando… (subiendo el sitio y esperando el deploy)';
        postJSON('/api/sprint/carousel/publish', { day: d.day, caption: captionArea.value }).then(function () {
          toast('¡Carrusel publicado en Instagram!');
          delete sprintGenerated[d.day];
          return loadSprintStatus();
        }).catch(function (err) {
          toast(err.message || 'No se pudo publicar', true);
          pubBtn.disabled = false;
          pubBtn.textContent = 'Confirmar y publicar';
        });
      });
      actions.appendChild(pubBtn);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function buildStoriesBlock(d) {
    var wrap = document.createElement('div');
    wrap.style.marginTop = '10px';
    wrap.style.paddingTop = '10px';
    wrap.style.borderTop = '1px dashed var(--border)';
    var lbl = document.createElement('div');
    lbl.className = 'admin-hint';
    lbl.style.marginTop = '0';
    lbl.textContent = 'Historias de hoy';
    wrap.appendChild(lbl);
    (d.stories || []).forEach(function (storyText, i) {
      var line = document.createElement('label');
      line.style.display = 'flex';
      line.style.gap = '8px';
      line.style.alignItems = 'flex-start';
      line.style.fontSize = '13px';
      line.style.margin = '4px 0';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = d.storiesDone.indexOf(i) !== -1;
      cb.addEventListener('change', function () {
        postJSON('/api/sprint/toggle-story', { day: d.day, index: i }).then(function () {
          return loadSprintStatus();
        }).catch(function (err) { toast(err.message || 'No se pudo guardar', true); });
      });
      line.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = storyText;
      line.appendChild(span);
      wrap.appendChild(line);
    });
    return wrap;
  }

  function buildKpiBlock(d) {
    var wrap = document.createElement('div');
    wrap.style.marginTop = '10px';
    wrap.style.paddingTop = '10px';
    wrap.style.borderTop = '1px dashed var(--border)';
    var lbl = document.createElement('div');
    lbl.className = 'admin-hint';
    lbl.style.marginTop = '0';
    lbl.textContent = '% de alcance de no-seguidores (Insights del post)';
    wrap.appendChild(lbl);

    var row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';

    var input = document.createElement('input');
    input.type = 'number';
    input.min = '0'; input.max = '100';
    input.style.width = '80px';
    input.placeholder = '%';
    if (d.nonFollowerReachPct != null) input.value = d.nonFollowerReachPct;

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Guardar';
    saveBtn.addEventListener('click', function () {
      var val = Number(input.value);
      if (isNaN(val)) return;
      postJSON('/api/sprint/kpi', { day: d.day, pct: val }).then(function () {
        return loadSprintStatus();
      }).catch(function (err) { toast(err.message || 'No se pudo guardar', true); });
    });

    row.appendChild(input);
    row.appendChild(saveBtn);

    if (d.kpiVerdict) {
      var badge = document.createElement('span');
      badge.style.fontSize = '13px';
      badge.style.marginLeft = '6px';
      var color = d.kpiVerdict.level === 'good' ? '#30A46C' : (d.kpiVerdict.level === 'mid' ? '#FFB020' : '#E5484D');
      badge.style.color = color;
      badge.textContent = d.kpiVerdict.message;
      row.appendChild(badge);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function renderSprintDays() {
    sprintDaysList.innerHTML = '';
    if (!sprintStatus) return;
    sprintStatus.days.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'admin-item';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      row.style.gap = '4px';
      if (sprintStatus.currentDay === d.day && sprintStatus.startDate) {
        row.style.borderColor = 'var(--blue-fill)';
      }

      var head = document.createElement('div');
      var isToday = sprintStatus.currentDay === d.day && sprintStatus.startDate;
      var badges = (isToday ? ' · <span style="color:var(--blue-fill);font-weight:700;">HOY</span>' : '') + (d.done ? ' · ✅' : '');
      head.innerHTML = '<b>Día ' + d.day + '</b> · ' + (d.format === 'carousel' ? 'Carrusel' : 'Reel') + ' · ' + (d.time === 'winner' ? 'horario ganador de la semana 1' : (d.time === 'checkpoint' ? 'revisar Insights hoy' : d.time + ' hs')) + badges +
        '<div style="font-size:13px;color:var(--text-muted);margin-top:2px;font-weight:400;">' + d.title + '</div>';
      row.appendChild(head);

      if (d.warning) {
        var warn = document.createElement('div');
        warn.className = 'admin-hint';
        warn.textContent = '⚠ ' + d.warning;
        row.appendChild(warn);
      }
      if (d.checkpoint) {
        var chk = document.createElement('div');
        chk.className = 'admin-hint';
        chk.textContent = '📍 ' + d.checkpoint;
        row.appendChild(chk);
      }

      row.appendChild(d.format === 'reel' ? buildReelBlock(d) : buildCarouselBlock(d));
      row.appendChild(buildStoriesBlock(d));
      if (d.done) row.appendChild(buildKpiBlock(d));

      sprintDaysList.appendChild(row);
    });
  }

  /* ---- Reacciones del sitio en vivo (solo para mostrar popularidad acá) ---- */
  function loadReactions() {
    fetch('https://vexlowhq.com/api/react?all=1')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) { reactionsBySlug = data; renderArticlesList(); }
      })
      .catch(function () { /* el sitio en vivo no respondió: seguimos sin datos de popularidad */ });
  }

  /* ---- Init ---- */
  Promise.all([
    getJSON('/api/categories'),
    getJSON('/api/hero'),
    getJSONWithRev('/api/articles'),
    getJSON('/api/drafts'),
    getJSON('/api/image-licenses').catch(function () { return { authorized: [], requiringAttribution: [] }; })
  ]).then(function (results) {
    categories = results[0];
    heroData = results[1];
    articlesData = results[2].body;
    articlesRev = results[2].rev;
    draftsData = results[3];
    imageLicensesInfo = results[4] || { authorized: [], requiringAttribution: [] };
    updateImageProvenanceVisibility();

    fillSelect(heroCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });
    fillSelect(articleCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });

    allNonTrendingCategories().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.slug;
      opt.textContent = c.icon + ' ' + c.label;
      filterCategory.appendChild(opt);
    });

    articleDate.value = todayISO();
    renderHeroList();
    renderArticlesList();
    renderDraftsList();
    renderCategoriesManager();
    loadReactions();
    loadSocialStatus();
    loadSocialLog();
    loadSprintStatus();
    // Corrección 2026-09-13: articleHtmlStatus se pide APARTE del
    // Promise.all de arriba (no bloquea el primer renderArticlesList) --
    // mismo patrón que loadReactions()/loadSocialStatus(): al resolver,
    // vuelve a renderizar con la verdad real de qué artículos tienen HTML
    // público. Meterlo dentro del Promise.all retrasaba el arranque
    // completo del panel (categorías, hero, borradores, redes, sprint)
    // por un viaje de red más -- innecesario, ya que esto solo afecta
    // "Ver"/"Vista previa"/"con página propia" en el listado de artículos.
    refreshArticleHtmlStatus();
  }).catch(function () {
    toast('No se pudo conectar con el panel. Fijate que server.js esté corriendo.', true);
  });
})();
