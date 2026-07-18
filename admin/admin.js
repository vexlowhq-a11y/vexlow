(function () {
  var categories = [];
  var topicsByCategory = {};
  var topicGroupsRaw = {};
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
  var articleTopic = document.getElementById('articleTopic');
  var topicHint = document.getElementById('topicHint');
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
  var articleCurrentImage = '';
  var newTopicRow = document.getElementById('newTopicRow');
  var newTopicGroup = document.getElementById('newTopicGroup');
  var newTopicGroupName = document.getElementById('newTopicGroupName');
  var newTopicLabel = document.getElementById('newTopicLabel');
  var newTopicCreateBtn = document.getElementById('newTopicCreateBtn');
  var topicManager = document.getElementById('topicManager');
  var articleCancelBtn = document.getElementById('articleCancelBtn');
  var regenerateBtn = document.getElementById('regenerateBtn');
  var filterCategory = document.getElementById('filterCategory');
  var filterTopic = document.getElementById('filterTopic');
  var filterTrendingOnly = document.getElementById('filterTrendingOnly');
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
    if (a.topic) return 'categoria/' + a.category + '/' + a.topic + '.html';
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

  function refreshTopicOptions(selectSlug) {
    var topics = topicsByCategory[articleCategory.value] || [];
    articleTopic.innerHTML = '';
    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Sin tema específico';
    articleTopic.appendChild(noneOpt);
    topics.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.slug;
      opt.textContent = t.label;
      articleTopic.appendChild(opt);
    });
    var newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ Crear tema nuevo…';
    articleTopic.appendChild(newOpt);
    if (selectSlug) articleTopic.value = selectSlug;
    topicHint.textContent = topics.length
      ? 'Temas de ' + categoryMeta(articleCategory.value).label + ': ' + topics.map(function (t) { return t.label; }).join(', ') + '.'
      : 'Esta categoría todavía no tiene temas en data/topics.json. Elegí "+ Crear tema nuevo…" para agregar el primero.';
  }
  function refreshGroupsAndTopics() {
    return getJSON('/api/topic-groups').then(function (groups) {
      topicGroupsRaw = groups;
    }).then(function () {
      return getJSON('/api/topics').then(function (topics) { topicsByCategory = topics; });
    });
  }

  function populateNewTopicGroupSelect() {
    var groupNames = topicGroupsRaw[articleCategory.value] ? topicGroupsRaw[articleCategory.value].map(function (g) { return g[0]; }) : [];
    newTopicGroup.innerHTML = '';
    groupNames.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      newTopicGroup.appendChild(opt);
    });
    var newGroupOpt = document.createElement('option');
    newGroupOpt.value = '__newgroup__';
    newGroupOpt.textContent = '+ Crear sección nueva…';
    newTopicGroup.appendChild(newGroupOpt);
  }
  newTopicGroup.addEventListener('change', function () {
    newTopicGroupName.hidden = newTopicGroup.value !== '__newgroup__';
    if (!newTopicGroupName.hidden) newTopicGroupName.focus();
  });

  function renderTopicManager() {
    var groups = topicGroupsRaw[articleCategory.value] || [];
    topicManager.innerHTML = '';
    if (!groups.length) return;
    groups.forEach(function (group) {
      var row = document.createElement('div');
      row.className = 'topic-manager-group';
      var name = document.createElement('span');
      name.className = 'group-name';
      name.textContent = group[0];
      row.appendChild(name);
      group[1].forEach(function (pair) {
        var slug = pair[0], label = pair[1];
        var category = articleCategory.value;
        var topicMeta = (topicsByCategory[category] || []).find(function (t) { return t.slug === slug; });
        var hasThumb = !!(topicMeta && topicMeta.thumb);

        var chip = document.createElement('span');
        chip.className = 'topic-chip' + (hasThumb ? ' has-thumb' : '');
        var text = document.createElement('span');
        text.textContent = label;
        var renameBtn = document.createElement('button');
        renameBtn.type = 'button'; renameBtn.title = 'Renombrar'; renameBtn.textContent = '✎';
        renameBtn.addEventListener('click', function () { renameTopicPrompt(slug, label); });

        var imgInput = document.createElement('input');
        imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.hidden = true;
        imgInput.addEventListener('change', function () {
          var file = imgInput.files[0];
          if (!file) return;
          uploadTopicImage(category, slug, file);
        });
        var imgBtn = document.createElement('button');
        imgBtn.type = 'button';
        imgBtn.title = hasThumb ? 'Cambiar imagen del tema' : 'Subir imagen para este tema';
        imgBtn.textContent = '🖼️';
        imgBtn.addEventListener('click', function () { imgInput.click(); });

        var delBtn = document.createElement('button');
        delBtn.type = 'button'; delBtn.title = 'Eliminar tema'; delBtn.textContent = '×'; delBtn.className = 'danger';
        delBtn.addEventListener('click', function () { deleteTopicConfirm(slug, label); });

        chip.appendChild(text);
        chip.appendChild(renameBtn);
        chip.appendChild(imgInput);
        chip.appendChild(imgBtn);
        if (hasThumb) {
          var removeImgBtn = document.createElement('button');
          removeImgBtn.type = 'button'; removeImgBtn.title = 'Quitar imagen del tema'; removeImgBtn.textContent = '🗑'; removeImgBtn.className = 'danger';
          removeImgBtn.addEventListener('click', function () { removeTopicImageConfirm(category, slug, label); });
          chip.appendChild(removeImgBtn);
        }
        chip.appendChild(delBtn);
        row.appendChild(chip);
      });
      topicManager.appendChild(row);
    });
  }

  function uploadTopicImage(category, slug, file) {
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      toast('Subiendo imagen del tema…');
      postJSON('/api/upload-topic-image', {
        category: category, topicSlug: slug, filename: file.name, dataBase64: base64
      }).then(function () {
        toast('Imagen del tema guardada');
        return refreshGroupsAndTopics();
      }).then(function () {
        renderTopicManager();
        return postJSON('/api/regenerate', {});
      }).catch(function (err) {
        toast(err.message || 'No se pudo subir la imagen del tema', true);
      });
    };
    reader.readAsDataURL(file);
  }

  function removeTopicImageConfirm(category, slug, label) {
    if (!window.confirm('¿Quitar la imagen del tema "' + label + '"? Va a volver a mostrar el ícono de la categoría.')) return;
    deleteJSON('/api/upload-topic-image', { category: category, topicSlug: slug }).then(function () {
      toast('Imagen del tema eliminada');
      return refreshGroupsAndTopics();
    }).then(function () {
      renderTopicManager();
      return postJSON('/api/regenerate', {});
    }).catch(function (err) {
      toast(err.message || 'No se pudo quitar la imagen del tema', true);
    });
  }

  function renameTopicPrompt(slug, currentLabel) {
    var newLabel = window.prompt('Nuevo nombre para "' + currentLabel + '":', currentLabel);
    if (newLabel === null) return;
    newLabel = newLabel.trim();
    if (!newLabel || newLabel === currentLabel) return;
    apiRequest('PATCH', '/api/topics', { category: articleCategory.value, slug: slug, label: newLabel }).then(function () {
      toast('Tema renombrado a "' + newLabel + '"');
      return refreshGroupsAndTopics();
    }).then(function () {
      renderTopicManager();
      refreshTopicOptions(articleTopic.value === slug ? slug : undefined);
      return postJSON('/api/regenerate', {});
    }).catch(function (err) {
      toast(err.message || 'No se pudo renombrar el tema', true);
    });
  }

  function deleteTopicConfirm(slug, label) {
    if (!window.confirm('¿Eliminar el tema "' + label + '"? Se borra también su página, si tiene una.')) return;
    apiRequest('DELETE', '/api/topics', { category: articleCategory.value, slug: slug }).then(function () {
      toast('Tema "' + label + '" eliminado');
      return refreshGroupsAndTopics();
    }).then(function () {
      renderTopicManager();
      refreshTopicOptions();
      return postJSON('/api/regenerate', {});
    }).catch(function (err) {
      if (err.message && err.message.indexOf('todavía usan este tema') !== -1) {
        toast(err.message, true);
      } else {
        toast(err.message || 'No se pudo eliminar el tema', true);
      }
    });
  }

  articleCategory.addEventListener('change', function () {
    refreshTopicOptions();
    newTopicRow.hidden = true;
    populateNewTopicGroupSelect();
    renderTopicManager();
  });

  articleTopic.addEventListener('change', function () {
    newTopicRow.hidden = articleTopic.value !== '__new__';
    if (!newTopicRow.hidden) {
      populateNewTopicGroupSelect();
      newTopicGroupName.hidden = true;
      newTopicLabel.focus();
    }
  });

  newTopicCreateBtn.addEventListener('click', function () {
    var label = newTopicLabel.value.trim();
    if (!label) { toast('Escribí un nombre para el tema', true); return; }
    if (!articleCategory.value) { toast('Elegí primero una categoría', true); return; }
    var group = newTopicGroup.value === '__newgroup__' ? newTopicGroupName.value.trim() : newTopicGroup.value;
    if (newTopicGroup.value === '__newgroup__' && !group) { toast('Escribí un nombre para la sección nueva', true); return; }
    newTopicCreateBtn.disabled = true;
    newTopicCreateBtn.textContent = 'Creando…';
    postJSON('/api/topics', { category: articleCategory.value, label: label, group: group || undefined }).then(function (result) {
      return refreshGroupsAndTopics().then(function () {
        refreshTopicOptions(result.topic.slug);
        renderTopicManager();
        newTopicRow.hidden = true;
        newTopicLabel.value = '';
        newTopicGroupName.value = '';
        toast('Tema creado: ' + result.topic.label + '. Regenerando sus páginas…');
        return postJSON('/api/regenerate', {});
      });
    }).then(function () {
      toast('Tema "' + label + '" listo — ya tiene su página en la categoría');
    }).catch(function (err) {
      toast(err.message || 'No se pudo crear el tema', true);
    }).finally(function () {
      newTopicCreateBtn.disabled = false;
      newTopicCreateBtn.textContent = 'Crear tema';
    });
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
      regenerateBtn.textContent = 'Regenerar categorías y temas';
    });
  });

  function refreshFilterTopicOptions() {
    var topics = topicsByCategory[filterCategory.value] || [];
    var current = filterTopic.value;
    filterTopic.innerHTML = '';
    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'Todos los temas';
    filterTopic.appendChild(noneOpt);
    topics.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.slug;
      opt.textContent = t.label;
      filterTopic.appendChild(opt);
    });
    filterTopic.disabled = !filterCategory.value;
    if (topics.some(function (t) { return t.slug === current; })) filterTopic.value = current;
  }

  function prefillFormFromFilter() {
    if (articleEditIndex !== null) return; // no tocar un artículo que se está editando
    if (filterCategory.value) {
      articleCategory.value = filterCategory.value;
      refreshTopicOptions();
      populateNewTopicGroupSelect();
      renderTopicManager();
      if (filterTopic.value) articleTopic.value = filterTopic.value;
    }
  }

  filterCategory.addEventListener('change', function () {
    refreshFilterTopicOptions();
    renderArticlesList();
    prefillFormFromFilter();
  });
  filterTopic.addEventListener('change', function () {
    renderArticlesList();
    prefillFormFromFilter();
  });
  filterTrendingOnly.addEventListener('change', renderArticlesList);

  function sortedArticlesWithIndex() {
    return articlesData
      .map(function (a, i) { return { a: a, i: i }; })
      .filter(function (entry) {
        if (filterCategory.value && entry.a.category !== filterCategory.value) return false;
        if (filterTopic.value && entry.a.topic !== filterTopic.value) return false;
        if (filterTrendingOnly.checked && !entry.a.trending) return false;
        return true;
      })
      .sort(function (x, y) { return new Date(y.a.date) - new Date(x.a.date); });
  }

  function toggleTrending(i) {
    articlesData[i].trending = !articlesData[i].trending;
    saveArticles(articlesData[i].trending ? 'Marcado como Trending' : 'Quitado de Trending');
  }

  function renderArticlesList() {
    var entries = sortedArticlesWithIndex();
    filterCount.textContent = articlesData.length
      ? entries.length + (entries.length === 1 ? ' artículo' : ' artículos')
      : '';
    articlesList.innerHTML = '';
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
      var topicLabel = a.topic ? (topicsByCategory[a.category] || []).find(function (t) { return t.slug === a.topic; }) : null;
      var hasPage = !!(a.body && a.body.trim());
      info.querySelector('.meta').textContent = (a.categoryLabel || meta.label) + (topicLabel ? ' · ' + topicLabel.label : '') + ' · ' + a.date + ' · ' + (a.readTime || '') + (hasPage ? ' · con página propia' : ' · solo en el listado');

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      if (hasPage) {
        var viewBtn = document.createElement('a');
        viewBtn.href = '/site/' + (a.href || articleHrefFor(a));
        viewBtn.target = '_blank';
        viewBtn.rel = 'noopener';
        viewBtn.textContent = 'Ver';
        actions.appendChild(viewBtn);
      }
      var editBtn = document.createElement('button');
      editBtn.type = 'button'; editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', function () { startEditArticle(i); });
      var delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.textContent = 'Eliminar'; delBtn.className = 'danger';
      delBtn.addEventListener('click', function () { deleteArticle(i); });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

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
    refreshTopicOptions();
    populateNewTopicGroupSelect();
    renderTopicManager();
    newTopicRow.hidden = true;
    articleTopic.value = a.topic || '';
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
    articleCancelBtn.hidden = false;
    articleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetArticleForm() {
    articleEditIndex = null;
    pendingDraft = null;
    articleForm.reset();
    refreshTopicOptions();
    articleDate.value = todayISO();
    articleSlug.dataset.auto = 'true';
    articleCurrentImage = '';
    updateArticleImageStatus();
    articleFormTitle.textContent = 'Agregar artículo';
    articleCancelBtn.hidden = true;
    prefillFormFromFilter();
  }
  articleCancelBtn.addEventListener('click', resetArticleForm);

  function deleteArticle(i) {
    if (!confirm('¿Eliminar este artículo? Si tenía página propia, también se borra el archivo .html.')) return;
    articlesData.splice(i, 1);
    saveArticles('Artículo eliminado');
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
    var topicValue = articleTopic.value === '__new__' ? '' : articleTopic.value;
    var article = {
      title: articleTitle.value.trim(),
      category: articleCategory.value,
      categoryLabel: meta.label,
      icon: meta.icon,
      date: articleDate.value,
      readTime: articleReadTime.value.trim(),
      topic: topicValue,
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
      draftsList.innerHTML = '<div class="admin-empty">No hay borradores pendientes. Tocá "Buscar temas nuevos" para revisar los feeds configurados.</div>';
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
      var topicLabel = d.topic ? (topicsByCategory[d.category] || []).find(function (t) { return t.slug === d.topic; }) : null;
      info.innerHTML = '<div class="ttl"></div><div class="meta"></div>';
      info.querySelector('.ttl').textContent = d.title;
      var metaText = (d.categoryLabel || meta.label) + (topicLabel ? ' · ' + topicLabel.label : '') + ' · ' + (d.dek || '');
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
    refreshTopicOptions();
    populateNewTopicGroupSelect();
    renderTopicManager();
    newTopicRow.hidden = true;
    articleTopic.value = d.topic || '';
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
        toast('Falta configurar la API key de Anthropic en admin/config.json para poder redactar borradores.', true);
        return;
      }
      draftsFetchStatus.textContent = '';
      var msg = result.added + ' borrador(es) nuevo(s)';
      if (result.errors && result.errors.length) msg += ' — ' + result.errors.length + ' error(es)';
      toast(msg, result.added === 0 && result.errors.length > 0);
      return getJSON('/api/drafts').then(function (list) {
        draftsData = list;
        renderDraftsList();
      });
    }).catch(function () {
      fetchDraftsBtn.disabled = false;
      draftsFetchStatus.textContent = '';
      toast('No se pudo buscar temas nuevos', true);
    });
  });

  /* ---- Init ---- */
  Promise.all([
    getJSON('/api/categories'),
    getJSON('/api/topics'),
    getJSON('/api/topic-groups'),
    getJSON('/api/hero'),
    getJSON('/api/articles'),
    getJSON('/api/drafts')
  ]).then(function (results) {
    categories = results[0];
    topicsByCategory = results[1];
    topicGroupsRaw = results[2];
    heroData = results[3];
    articlesData = results[4];
    draftsData = results[5];

    fillSelect(heroCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });
    fillSelect(articleCategory, contentCategories(), 'slug', function (c) { return c.icon + ' ' + c.label; });
    refreshTopicOptions();
    populateNewTopicGroupSelect();
    renderTopicManager();

    contentCategories().forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.slug;
      opt.textContent = c.icon + ' ' + c.label;
      filterCategory.appendChild(opt);
    });
    refreshFilterTopicOptions();

    articleDate.value = todayISO();
    renderHeroList();
    renderArticlesList();
    renderDraftsList();
  }).catch(function () {
    toast('No se pudo conectar con el panel. Fijate que server.js esté corriendo.', true);
  });
})();
