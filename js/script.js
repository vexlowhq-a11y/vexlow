(function () {
  var root = document.documentElement;

  var T = {
    noPostsInCategory: 'No posts in this category yet.',
    noArticlesInTopic: 'No articles about this topic yet. Add one from the admin panel and pick this topic.',
    noArticlesInCategory: 'No articles published in this category yet.',
    noArticlesInCategoryRail: 'No articles in this category yet.',
    noResultsFor: 'No results for',
    articleSingular: ' article', articlePlural: ' articles',
    topicSingular: ' topic', topicPlural: ' topics',
  };

  var themeBtns = document.querySelectorAll('[data-theme-btn]');

  function setTheme(mode) {
    if (mode === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', mode);
    }
    themeBtns.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme-btn') === mode);
    });
    try { localStorage.setItem('vexlow-theme', mode); } catch (e) {}
  }

  themeBtns.forEach(function (b) {
    b.addEventListener('click', function () { setTheme(b.getAttribute('data-theme-btn')); });
  });

  var savedTheme = null;
  try { savedTheme = localStorage.getItem('vexlow-theme'); } catch (e) {}
  setTheme(savedTheme || 'auto');

  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  var menuToggle = document.getElementById('menuToggle');

  function closeSidebar() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
  }
  function openSidebar() {
    sidebar.classList.add('open');
    backdrop.classList.add('open');
    menuToggle.setAttribute('aria-expanded', 'true');
  }

  if (menuToggle) {
    menuToggle.addEventListener('click', function () {
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
  }
  if (backdrop) backdrop.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', closeSidebar);
  });

  /* ---- Categorías: la flecha despliega subtemas sin navegar ---- */
  sidebar.querySelectorAll('.cat-expand').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var sub = document.getElementById(btn.getAttribute('data-target'));
      if (!sub) return;
      var isOpen = sub.classList.toggle('open');
      btn.classList.toggle('open', isOpen);
    });
  });

  /* Marca como activa la categoría de la página actual.
     Las páginas de categoría/tema viven dentro de una carpeta (ej. gaming/index.html
     o gaming/gtavi.html), así que la categoría es el nombre de esa carpeta; en la
     home (index.html suelto, sin carpeta) la categoría es "index". */
  var pathParts = location.pathname.split('/').filter(Boolean);
  var currentCategory = pathParts.length > 1
    ? pathParts[pathParts.length - 2]
    : (pathParts[0] || 'index.html').replace('.html', '');
  sidebar.querySelectorAll('.cat-link').forEach(function (link) {
    if (link.getAttribute('data-cat') === currentCategory) link.classList.add('active');
  });

  /* Los links de artículos en data/articulos.js están guardados "desde la raíz"
     (ej. "categoria/sports/mundial-final.html"), porque así es como funcionan
     bien en la Home. Pero esta misma tarjeta también se dibuja en páginas que
     YA están adentro de categoria/algo/ — ahí ese link relativo se rompe
     (se duplicaba "categoria/sports/categoria/sports/..."). resolveHref()
     le agrega los "../" que hagan falta según en qué carpeta estemos parados.

     Para calcular cuántos "../" hacen falta NO podemos contar los pedazos de
     location.pathname: cuando abrís el archivo con doble clic (file://), esa
     ruta incluye toda la carpeta de tu computadora (C:/Users/.../vexlowhq/...)
     y el cálculo se rompía. En cambio, leemos el propio <script src="..."> que
     cargó este archivo — el generador ya puso ahí el "../" correcto, así que
     copiamos exactamente eso. Funciona igual con file:// que con un servidor. */
  var scriptEl = document.currentScript || document.querySelector('script[src$="js/script.js"]');
  var scriptSrc = (scriptEl && scriptEl.getAttribute('src')) || 'js/script.js';
  var pathPrefix = scriptSrc.replace(/js\/script\.js(\?.*)?$/, '');
  function resolveHref(href) {
    if (!href) return '#';
    if (href.indexOf('categoria/') === 0 || href.indexOf('img/') === 0) return pathPrefix + href;
    return href;
  }

  /* ---- Hero: carrusel de destacados con puntos ---- */
  var heroMain = document.getElementById('heroMain');
  var heroDots = document.getElementById('heroDots');

  if (heroMain && heroDots && typeof VEXLOW_HERO !== 'undefined' && VEXLOW_HERO.length) {
    var HERO_SLIDES = VEXLOW_HERO;
    var heroChip = document.getElementById('heroChip');
    var heroTitle = document.getElementById('heroTitle');
    var heroDek = document.getElementById('heroDek');

    heroDots.innerHTML = '';
    HERO_SLIDES.forEach(function (s, idx) {
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'hero-dot' + (idx === 0 ? ' active' : '');
      dot.setAttribute('data-slide', idx);
      dot.setAttribute('aria-label', 'Destacado ' + (idx + 1));
      dot.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      heroDots.appendChild(dot);
    });
    var heroDotEls = heroDots.querySelectorAll('.hero-dot');
    var heroIndex = 0;
    var heroTimer = null;
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* Cuando se elige un color de texto a mano desde el panel, un resaltado
       detrás de las letras (oscuro o claro, según qué tan clara sea la letra
       elegida) asegura que se siga leyendo bien sin importar la imagen de
       fondo — en vez de depender de que el color combine por casualidad. */
    function backdropForTextColor(hex) {
      var c = hex.replace('#', '');
      if (c.length === 3) c = c.split('').map(function (ch) { return ch + ch; }).join('');
      var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
      var luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      return luminance > 150 ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.85)';
    }

    /* Mide el brillo de la imagen (franja de abajo, donde va el texto) y
       decide si el título necesita texto oscuro en vez de blanco. */
    var brightnessCache = {};
    function applyImageContrast(imageUrl) {
      if (brightnessCache.hasOwnProperty(imageUrl)) {
        heroMain.classList.toggle('on-light', brightnessCache[imageUrl]);
        return;
      }
      var img = new Image();
      img.onload = function () {
        try {
          var w = 40, h = 40;
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, img.height * 0.4, img.width, img.height * 0.6, 0, 0, w, h);
          var data = ctx.getImageData(0, 0, w, h).data;
          var sum = 0, count = 0;
          for (var i = 0; i < data.length; i += 4) {
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            count++;
          }
          var isLight = (sum / count) > 150;
          brightnessCache[imageUrl] = isLight;
          if (heroMain.style.backgroundImage.indexOf(imageUrl) !== -1) {
            heroMain.classList.toggle('on-light', isLight);
          }
        } catch (e) { /* si el canvas queda "tainted" o falla, se deja el texto claro por defecto */ }
      };
      img.src = imageUrl;
    }

    function showHeroSlide(i) {
      heroIndex = i;
      var slide = HERO_SLIDES[i];
      HERO_SLIDES.forEach(function (s) { heroMain.classList.remove('media-' + s.category); });
      heroMain.className = 'hero-main media ' + slide.category;
      if (slide.image) {
        var heroImageUrl = resolveHref(slide.image);
        heroMain.style.backgroundImage = "url('" + heroImageUrl + "')";
        heroMain.style.backgroundSize = 'cover';
        heroMain.style.backgroundPosition = 'center';
        applyImageContrast(heroImageUrl);
      } else {
        heroMain.style.backgroundImage = '';
        heroMain.style.backgroundSize = '';
        heroMain.style.backgroundPosition = '';
      }
      heroMain.href = slide.href;
      heroChip.textContent = slide.chip;
      heroTitle.textContent = slide.title;
      heroDek.textContent = slide.dek;
      if (slide.textColor && slide.textColor !== 'auto') {
        var backdrop = backdropForTextColor(slide.textColor);
        heroTitle.style.color = slide.textColor;
        heroDek.style.color = slide.textColor;
        heroTitle.style.setProperty('--hero-highlight-bg', backdrop);
        heroDek.style.setProperty('--hero-highlight-bg', backdrop);
        heroTitle.classList.add('hero-highlight');
        heroDek.classList.add('hero-highlight');
      } else {
        heroTitle.style.color = '';
        heroDek.style.color = '';
        heroTitle.classList.remove('hero-highlight');
        heroDek.classList.remove('hero-highlight');
        heroTitle.style.removeProperty('--hero-highlight-bg');
        heroDek.style.removeProperty('--hero-highlight-bg');
      }
      heroDotEls.forEach(function (dot, idx) {
        dot.classList.toggle('active', idx === i);
        dot.setAttribute('aria-selected', idx === i ? 'true' : 'false');
      });
    }

    function nextHeroSlide() {
      showHeroSlide((heroIndex + 1) % HERO_SLIDES.length);
    }

    function startHeroAutoplay() {
      if (reduceMotion) return;
      stopHeroAutoplay();
      heroTimer = setInterval(nextHeroSlide, 6000);
    }
    function stopHeroAutoplay() {
      if (heroTimer) clearInterval(heroTimer);
    }

    heroDotEls.forEach(function (dot) {
      dot.addEventListener('click', function () {
        showHeroSlide(parseInt(dot.getAttribute('data-slide'), 10));
        startHeroAutoplay();
      });
    });

    heroMain.addEventListener('mouseenter', stopHeroAutoplay);
    heroMain.addEventListener('mouseleave', startHeroAutoplay);

    showHeroSlide(0);
    startHeroAutoplay();
  }

  function formatDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  }

  function articlesSortedByDate() {
    return VEXLOW_ARTICLES.slice().sort(function (a, b) {
      return new Date(b.date) - new Date(a.date);
    });
  }

  /* Trending: artículos marcados a mano desde el panel de administración.
     Si todavía no se marcó ninguno, se muestran los más recientes de todas
     las categorías para que la sección no quede vacía. */
  function trendingArticles() {
    var marked = articlesSortedByDate().filter(function (a) { return a.trending; });
    return marked.length ? marked : articlesSortedByDate();
  }

  /* Tarjeta reutilizable (.card) — rieles de la Home y grilla de categoría */
  function buildCard(a, opts) {
    opts = opts || {};
    var card = document.createElement('a');
    card.className = 'card';
    card.href = resolveHref(a.href);

    var media = document.createElement('span');
    media.className = 'media ' + a.category;
    if (a.image) {
      media.style.backgroundImage = "url('" + resolveHref(a.image) + "')";
      media.style.backgroundSize = 'cover';
      media.style.backgroundPosition = 'center';
    } else {
      media.textContent = a.icon || '';
    }

    var body = document.createElement('div');
    body.className = 'body';

    var h3 = document.createElement('h3');
    h3.textContent = a.title;

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (opts.showCategory ? (a.categoryLabel || a.category) + ' · ' : '') + (a.readTime || '') + ' · ' + formatDate(a.date);

    body.appendChild(h3);
    body.appendChild(meta);
    card.appendChild(media);
    card.appendChild(body);
    return card;
  }

  /* ---- Últimas publicadas (barra lateral, en todas las páginas) ---- */
  var latestList = document.getElementById('latestList');
  var filterRow = document.getElementById('filterRow');
  var MAX_SIDEBAR_ITEMS = 8;

  if (latestList && typeof VEXLOW_ARTICLES !== 'undefined') {
    var sorted = articlesSortedByDate();

    function renderLatest(filter) {
      var items = filter === 'all' ? sorted : sorted.filter(function (a) { return a.category === filter; });
      items = items.slice(0, MAX_SIDEBAR_ITEMS);

      latestList.innerHTML = '';
      if (items.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'latest-empty';
        empty.textContent = T.noPostsInCategory;
        latestList.appendChild(empty);
        return;
      }

      items.forEach(function (a) {
        var link = document.createElement('a');
        link.className = 'latest-item';
        link.href = resolveHref(a.href);

        var ic = document.createElement('span');
        ic.className = 'ic';
        ic.textContent = a.icon || '';

        var txt = document.createElement('div');
        txt.className = 'txt';

        var ttl = document.createElement('span');
        ttl.className = 'ttl';
        ttl.textContent = a.title;

        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = (a.categoryLabel || a.category) + ' · ' + formatDate(a.date) + ' · ' + (a.readTime || '');

        txt.appendChild(ttl);
        txt.appendChild(meta);
        link.appendChild(ic);
        link.appendChild(txt);
        link.addEventListener('click', closeSidebar);
        latestList.appendChild(link);
      });
    }

    if (filterRow) {
      filterRow.querySelectorAll('.filter-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          filterRow.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
          chip.classList.add('active');
          renderLatest(chip.getAttribute('data-filter'));
        });
      });
    }

    renderLatest('all');
  }

  /* ---- Grilla de artículos: página de categoría o página de tema ---- */
  var categoryGrid = document.getElementById('categoryGrid');
  var pageCategory = document.body.getAttribute('data-category');
  var pageTopic = document.body.getAttribute('data-topic');
  var pageSubtopic = document.body.getAttribute('data-subtopic');

  if (categoryGrid && pageCategory && typeof VEXLOW_ARTICLES !== 'undefined') {
    var allSorted = articlesSortedByDate();
    var pageItems;
    if (pageTopic && pageSubtopic) {
      pageItems = allSorted.filter(function (a) { return a.category === pageCategory && a.topic === pageTopic && a.subtopic === pageSubtopic; });
    } else if (pageTopic) {
      pageItems = allSorted.filter(function (a) { return a.category === pageCategory && a.topic === pageTopic; });
    } else if (pageCategory === 'trending') {
      pageItems = trendingArticles();
    } else {
      pageItems = allSorted.filter(function (a) { return a.category === pageCategory; });
    }

    var categoryCount = document.getElementById('categoryCount');
    if (categoryCount) {
      categoryCount.textContent = pageItems.length + (pageItems.length === 1 ? T.articleSingular : T.articlePlural);
    }

    if (pageItems.length === 0) {
      var emptyMsg = pageTopic ? T.noArticlesInTopic : T.noArticlesInCategory;
      categoryGrid.innerHTML = '<p class="latest-empty">' + emptyMsg + '</p>';
    } else {
      pageItems.forEach(function (a) {
        categoryGrid.appendChild(buildCard(a, { showCategory: pageCategory === 'trending' }));
      });
    }
  }

  /* ---- Buscador de temas (páginas de categoría con tarjetas de tema, ej. Gaming) ---- */
  var topicSearch = document.getElementById('topicSearch');
  var allGuideCards = document.querySelectorAll('.guides-grid .guide-card');
  var noResultsEl = document.getElementById('topicNoResults');

  // Si la página no tiene grilla de artículos dinámica (categoryGrid), pero sí
  // tiene tarjetas de tema, mostramos la cantidad de temas en vez de "Cargando…".
  var categoryCountEl = document.getElementById('categoryCount');
  if (categoryCountEl && !categoryGrid && allGuideCards.length) {
    categoryCountEl.textContent = allGuideCards.length + (allGuideCards.length === 1 ? T.topicSingular : T.topicPlural);
  }

  if (topicSearch && allGuideCards.length) {
    topicSearch.addEventListener('input', function () {
      var q = topicSearch.value.trim().toLowerCase();
      var totalVisible = 0;
      document.querySelectorAll('.guides-grid').forEach(function (grid) {
        var anyVisible = false;
        grid.querySelectorAll('.guide-card').forEach(function (card) {
          var name = card.querySelector('h3').textContent.toLowerCase();
          var match = !q || name.indexOf(q) !== -1;
          card.style.display = match ? '' : 'none';
          if (match) { anyVisible = true; totalVisible++; }
        });
        var section = grid.closest('.home-section');
        if (section) section.style.display = anyVisible ? '' : 'none';
      });
      if (noResultsEl) noResultsEl.classList.toggle('show', totalVisible === 0);
    });
  }

  /* ---- Home: Top 5 de Trending (todas las categorías) ---- */
  var trendStrip = document.getElementById('trendStrip');
  if (trendStrip && typeof VEXLOW_ARTICLES !== 'undefined') {
    var top5 = trendingArticles().slice(0, 5);
    top5.forEach(function (a, i) {
      var card = document.createElement('a');
      card.className = 'trend-card';
      card.href = resolveHref(a.href);

      var media = document.createElement('span');
      media.className = 'media ' + a.category;
      if (a.image) {
        media.style.backgroundImage = "url('" + resolveHref(a.image) + "')";
        media.style.backgroundSize = 'cover';
        media.style.backgroundPosition = 'center';
      } else {
        media.textContent = a.icon || '';
      }

      var rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = i + 1;
      media.prepend(rank);

      var body = document.createElement('div');
      body.className = 'body';

      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = a.categoryLabel || a.category;

      var h3 = document.createElement('h3');
      h3.textContent = a.title;

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (a.readTime || '') + ' · ' + formatDate(a.date);

      body.appendChild(chip);
      body.appendChild(h3);
      body.appendChild(meta);
      card.appendChild(media);
      card.appendChild(body);
      trendStrip.appendChild(card);
    });
  }

  /* ---- Home: rieles por categoría (últimos 4 de cada una) ---- */
  var RAIL_CATEGORIES = ['ai', 'technology', 'science', 'gaming', 'entertainment', 'sports', 'world', 'guides'];
  if (typeof VEXLOW_ARTICLES !== 'undefined') {
    var sortedForRails = articlesSortedByDate();
    RAIL_CATEGORIES.forEach(function (cat) {
      var railEl = document.getElementById('rail-' + cat);
      if (!railEl) return;
      var items = sortedForRails.filter(function (a) { return a.category === cat; }).slice(0, 4);
      if (items.length === 0) {
        railEl.innerHTML = '<p class="latest-empty">' + T.noArticlesInCategoryRail + '</p>';
        return;
      }
      items.forEach(function (a) { railEl.appendChild(buildCard(a)); });
    });
  }

  /* ---- Buscador del sitio (sidebar): busca en título/resumen/categoría
     de TODOS los artículos, sin importar en qué categoría o página estemos. ---- */
  var siteSearchInput = document.getElementById('siteSearchInput');
  var siteSearchResults = document.getElementById('siteSearchResults');
  if (siteSearchInput && siteSearchResults && typeof VEXLOW_ARTICLES !== 'undefined') {
    function normalizeSearch(s) {
      return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    function runSiteSearch(rawQuery) {
      var q = normalizeSearch(rawQuery);
      if (!q) {
        siteSearchResults.classList.remove('show');
        siteSearchResults.innerHTML = '';
        return;
      }
      var matches = VEXLOW_ARTICLES.filter(function (a) {
        return normalizeSearch(a.title).indexOf(q) !== -1 ||
          normalizeSearch(a.dek).indexOf(q) !== -1 ||
          normalizeSearch(a.categoryLabel || a.category).indexOf(q) !== -1;
      }).sort(function (a, b) { return new Date(b.date) - new Date(a.date); }).slice(0, 8);

      siteSearchResults.innerHTML = '';
      if (matches.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'search-result-empty';
        empty.textContent = T.noResultsFor + ' "' + rawQuery + '"';
        siteSearchResults.appendChild(empty);
      } else {
        matches.forEach(function (a) {
          var item = document.createElement('a');
          item.className = 'search-result-item';
          item.href = resolveHref(a.href);

          var ic = document.createElement('span');
          ic.className = 'ic';
          ic.textContent = a.icon || '📰';

          var body = document.createElement('div');
          body.className = 'body';
          var h4 = document.createElement('h4');
          h4.textContent = a.title;
          var meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = (a.categoryLabel || a.category) + ' · ' + formatDate(a.date);
          body.appendChild(h4);
          body.appendChild(meta);

          item.appendChild(ic);
          item.appendChild(body);
          siteSearchResults.appendChild(item);
        });
      }
      siteSearchResults.classList.add('show');
    }

    siteSearchInput.addEventListener('input', function () { runSiteSearch(siteSearchInput.value.trim()); });
    siteSearchInput.addEventListener('focus', function () {
      if (siteSearchInput.value.trim()) runSiteSearch(siteSearchInput.value.trim());
    });
    siteSearchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        siteSearchInput.value = '';
        siteSearchResults.classList.remove('show');
        siteSearchInput.blur();
      }
    });
    document.addEventListener('click', function (e) {
      if (!siteSearchInput.contains(e.target) && !siteSearchResults.contains(e.target)) {
        siteSearchResults.classList.remove('show');
      }
    });
  }

  /* ---- Botones de compartir (página de artículo) ---- */
  var articleShare = document.querySelector('.article-share');
  if (articleShare) {
    var shareUrl = location.href;
    var shareTitle = document.title.replace(/ — VexlowHQ$/, '');
    articleShare.querySelectorAll('a[data-share]').forEach(function (a) {
      var kind = a.getAttribute('data-share');
      if (kind === 'x') {
        a.href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareTitle) + '&url=' + encodeURIComponent(shareUrl);
        a.target = '_blank';
        a.rel = 'noopener';
      } else if (kind === 'whatsapp') {
        a.href = 'https://wa.me/?text=' + encodeURIComponent(shareTitle + ' ' + shareUrl);
        a.target = '_blank';
        a.rel = 'noopener';
      } else if (kind === 'facebook') {
        a.href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(shareUrl);
        a.target = '_blank';
        a.rel = 'noopener';
      } else if (kind === 'copy') {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var done = function () {
            var original = a.textContent;
            a.textContent = '✓';
            setTimeout(function () { a.textContent = original; }, 1500);
          };
          var fallbackCopy = function () {
            var tmp = document.createElement('textarea');
            tmp.value = shareUrl;
            tmp.style.position = 'fixed';
            tmp.style.opacity = '0';
            document.body.appendChild(tmp);
            tmp.select();
            try { document.execCommand('copy'); done(); } catch (err) {}
            document.body.removeChild(tmp);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl).then(done).catch(fallbackCopy);
          } else {
            fallbackCopy();
          }
        });
      }
    });
  }
})();
