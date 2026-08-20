(function () {
  var categories = [];
  var reactionsBySlug = {}; // { slug: {like, fire, dislike} } — traído del sitio en vivo, solo para mostrar en el listado
  var heroData = [];
  var articlesData = [];
  var draftsData = [];
  var heroEditIndex = null;
  var articleEditIndex = null;
  var pendingDraft = null; // { slug, sourceUrl, sourceTitle } cuando el artículo en el formulario viene de un borrador

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
      toast(err.message || 'No se pudo publicar los cambios', true);
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
  function apiRequest(method, url, data) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || 'Error al guardar');
        return body;
      });
    });
  }
  function postJSON(url, data) {
    return apiRequest('POST', url, data);
  }
  function deleteJSON(url, data) {
    return apiRequest('DELETE', url, data);
  }

  function categoryMeta(slug) {
    return categories.find(function (c) { return c.slug === slug; }) || { slug: slug, label: slug, icon: '📰' };
  }
  function contentCategories() {
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
  var articleCategory = document.getElementById('articleCategory');
  var articlePreviewLink = document.getElementById('articlePreviewLink');
  var articleDate = document.getElementById('articleDate');
  var articleTitle = document.getElementById('articleTitle');
  var articleSlug = document.getElementById('articleSlug');
  var articleDek = document.getElementById('articleDek');
  var articleReadTime = document.getElementById('articleReadTime');
  var articleTrending = document.getElementById('articleTrending');
  var articleImageUpload = document.getElementById('articleImageUpload');
  var articleImageStatus = document.getElementById('articleImageStatus');
  var articleImageRemoveBtn = document.getElementById('articleImageRemoveBtn');
  var articleVideoUrl = document.getElementById('articleVideoUrl');
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

  function updateArticleImageStatus() {
    articleImageStatus.textContent = articleCurrentImage
      ? 'Imagen actual: ' + articleCurrentImage.replace(/^img\//, '')
      : 'Sin imagen (usa el ícono de la categoría).';
    articleImageRemoveBtn.hidden = !articleCurrentImage;
  }
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
    articlesData[i].trending = !articlesData[i].trending;
    saveArticles(articlesData[i].trending ? 'Marcado como Trending' : 'Quitado de Trending');
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

  bulkDeleteBtn.addEventListener('click', function () {
    var count = selectedArticleKeys.size;
    if (!count) return;
    if (!window.confirm('¿Eliminar ' + count + ' artículo(s)? Si tenían página propia, también se borran los archivos .html.')) return;
    articlesData = articlesData.filter(function (a) { return !selectedArticleKeys.has(articleKey(a)); });
    selectedArticleKeys.clear();
    saveArticles(count + ' artículo(s) eliminado(s)');
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
      var hasPage = !!(a.body && a.body.trim());
      var r = reactionsBySlug[a.slug];
      var reactionsText = r ? ' · 👍' + (r.like || 0) + ' 🔥' + (r.fire || 0) + ' 👎' + (r.dislike || 0) : '';
      info.querySelector('.meta').textContent = (a.categoryLabel || meta.label) + ' · ' + a.date + ' · ' + (a.readTime || '') + (hasPage ? ' · con página propia' : ' · solo en el listado') + reactionsText;

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      if (hasPage) {
        var viewBtn = document.createElement('a');
        viewBtn.href = '/site/' + (a.href || articleHrefFor(a));
        viewBtn.target = '_blank';
        viewBtn.rel = 'noopener';
        viewBtn.textContent = 'Ver';
        actions.appendChild(viewBtn);

        var carouselBtn = document.createElement('button');
        carouselBtn.type = 'button'; carouselBtn.textContent = 'Al carrusel';
        carouselBtn.title = 'Agregar como diapositiva nueva en el carrusel de la home';
        carouselBtn.addEventListener('click', function () { addToCarousel(a); });
        actions.appendChild(carouselBtn);
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
    articleEditIndex = i;
    var a = articlesData[i];
    articleFormTitle.textContent = 'Editar artículo';
    articleCategory.value = a.category;
    articleDate.value = a.date;
    articleTitle.value = a.title;
    articleSlug.value = a.slug || '';
    articleSlug.dataset.auto = 'false'; // no re-generar el slug solo por editar el título de una nota ya publicada
    articleDek.value = a.dek || '';
    articleCurrentImage = a.image || '';
    updateArticleImageStatus();
    articleVideoUrl.value = a.videoUrl || '';
    articleReadTime.value = a.readTime || '';
    articleTrending.checked = !!a.trending;
    articleBody.value = a.body || '';
    inlineImageStatus.textContent = '';
    articleCancelBtn.hidden = false;
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
    inlineImageStatus.textContent = '';
    articleFormTitle.textContent = 'Agregar artículo';
    articleCancelBtn.hidden = true;
    prefillFormFromFilter();
  }
  articleCancelBtn.addEventListener('click', resetArticleForm);

  function deleteArticle(i) {
    if (!confirm('¿Eliminar este artículo? Si tenía página propia, también se borra el archivo .html.')) return;
    selectedArticleKeys.delete(articleKey(articlesData[i]));
    articlesData.splice(i, 1);
    saveArticles('Artículo eliminado');
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

  function saveArticles(successMsg) {
    return postJSON('/api/articles', articlesData).then(function (result) {
      renderArticlesList();
      if (result && result.errors && result.errors.length) {
        toast('Guardado, pero falló generar: ' + result.errors.map(function (e) { return e.slug; }).join(', '), true);
      } else {
        toast(successMsg || 'Guardado');
      }
      return result;
    }).catch(function () {
      toast('No se pudo guardar. ¿Está corriendo el panel?', true);
    });
  }

  articleForm.addEventListener('submit', function (e) {
    e.preventDefault();
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
      videoUrl: articleVideoUrl.value.trim(),
      trending: articleTrending.checked,
      body: articleBody.value
    };
    if (pendingDraft) {
      article.sourceUrl = pendingDraft.sourceUrl;
      article.sourceTitle = pendingDraft.sourceTitle;
    }
    article.href = articleHrefFor(article);
    var isNewArticleToday = articleEditIndex === null && article.date === todayISO();
    if (articleEditIndex !== null) {
      articlesData[articleEditIndex] = article;
    } else {
      articlesData.push(article);
    }
    var usedDraft = pendingDraft;
    saveArticles(articleEditIndex !== null ? 'Artículo actualizado' : 'Artículo agregado').then(function () {
      if (article.body && article.body.trim()) {
        articlePreviewLink.innerHTML = 'Página publicada: <a href="/site/' + article.href + '" target="_blank" rel="noopener">' + article.href + ' ↗</a>';
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

  function renderDraftsList() {
    draftsTabCount.textContent = draftsData.length ? '(' + draftsData.length + ')' : '';
    draftsList.innerHTML = '';
    if (!draftsData.length) {
      draftsList.innerHTML = '<div class="admin-empty">No hay borradores pendientes. Tocá "Buscar noticias nuevas" para revisar los feeds configurados.</div>';
      return;
    }
    draftsData.forEach(function (d) {
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
      info.querySelector('.meta').textContent = metaText;

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
      useBtn.addEventListener('click', function () { useDraft(d); });
      var discardBtn = document.createElement('button');
      discardBtn.type = 'button'; discardBtn.textContent = 'Descartar'; discardBtn.className = 'danger';
      discardBtn.addEventListener('click', function () { discardDraft(d); });
      actions.appendChild(useBtn);
      actions.appendChild(discardBtn);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      draftsList.appendChild(row);
    });
  }

  function useDraft(d) {
    document.querySelector('.admin-tab[data-tab="articles"]').click();
    articleEditIndex = null;
    pendingDraft = { slug: d.slug, sourceUrl: d.sourceUrl, sourceTitle: d.sourceTitle };
    articleFormTitle.textContent = 'Revisar borrador';
    articleCategory.value = d.category;
    articleDate.value = d.date || todayISO();
    articleTitle.value = d.title;
    articleSlug.value = d.slug || '';
    articleSlug.dataset.auto = 'false';
    articleDek.value = d.dek || '';
    articleCurrentImage = d.image || '';
    updateArticleImageStatus();
    articleVideoUrl.value = d.videoUrl || '';
    articleReadTime.value = d.readTime || '';
    articleTrending.checked = !!d.trending;
    articleBody.value = d.body || '';
    articleCancelBtn.hidden = false;
    articleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Borrador cargado — revisalo y tocá "Guardar artículo" para publicarlo.');
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
    draftsFetchStatus.textContent = 'Buscando en los feeds y redactando (puede tardar un minuto)...';
    postJSON('/api/fetch-drafts', {}).then(function (result) {
      fetchDraftsBtn.disabled = false;
      if (result.noApiKey) {
        draftsFetchStatus.textContent = '';
        toast('Falta configurar la API key en admin/config.json para poder redactar borradores.', true);
        return;
      }
      draftsFetchStatus.textContent = '';
      var errorList = result.errors || [];
      var msg = (result.added || 0) + ' borrador(es) nuevo(s)';
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
     SPRINT 14 DÍAS
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
      sprintStatusText.textContent = 'Arrancó el ' + sprintStatus.startDate + ' · Día ' + sprintStatus.currentDay + ' de 14 · ' + doneCount + ' días completados';
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
    getJSON('/api/articles'),
    getJSON('/api/drafts')
  ]).then(function (results) {
    categories = results[0];
    heroData = results[1];
    articlesData = results[2];
    draftsData = results[3];

    fillSelect(heroCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });
    fillSelect(articleCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });

    contentCategories().forEach(function (c) {
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
  }).catch(function () {
    toast('No se pudo conectar con el panel. Fijate que server.js esté corriendo.', true);
  });
})();
