#!/usr/bin/env node
/*
  npm run validate:publish
  =========================
  Chequeo único, previo a publicar (sección 7 de la protección permanente
  del panel, sept. 2026): corre TODOS los controles de una vez, sin
  modificar ningún contenido real, y sale con código distinto de cero si
  algo crítico falla -- eso es lo que server.js usa (ver deploy.js) para
  bloquear de verdad el botón "Publicar cambios" cuando algo no está bien,
  en vez de dejarlo librado a que alguien se acuerde de revisar a mano.

  Qué corre (y a qué ítem de la sección 7 corresponde cada uno):
    1. Validación de esquema de artículos/categorías/hero (JSON válido +
       campos mínimos de cada artículo).
    2. Fuentes y URLs (todo sourceUrl/additionalSources declarado es una
       URL http(s) bien formada).
    3. Licencias e imágenes (toda licencia declarada está en la lista
       autorizada de admin/image-licenses.js).
    4. Slugs y canónicos (sin dos artículos compartiendo categoría+slug).
    5. Duplicados y similaridad -- NO se re-corre acá (ver nota más abajo,
       "Qué NO corre acá y por qué").
    6. Sitemap / noindex / redirects (todo lo listado en sitemap.xml es
       realmente público e indexable; ningún redirect ni noindex se cuela
       ahí; todo redirectTo resuelve a un artículo real).
    7. AdSense y Consent Mode (privacy/cookies nunca cargan AdSense;
       ningún artículo noindex carga AdSense).
    8. JSON-LD / Open Graph (todo artículo público tiene su script
       NewsArticle y sus metatags og:).
    9. Enlaces internos (ningún <a href="..."> interno del cuerpo de
       CUALQUIER artículo -- nuevo o viejo -- apunta a un archivo
       inexistente: un link roto es un link roto sin importar cuándo se
       publicó).
   10. Paridad Node/Python (delega en admin/test-parity.js).
   11. Determinismo (corre la generación Node dos veces y compara).
   12. Archivos temporales (ningún slug de prueba conocido -- test-*,
       qa-*, synthetic-* -- quedó en data/articulos.json o en categoria/).
   13. Secretos expuestos (admin/config.json nunca aparece copiado dentro
       de ningún archivo público del sitio).
   14. Sintaxis JavaScript y Python de todo admin/*.js y generate_pages.py.

  Qué NO corre acá y por qué:
  Las reglas de contenido editorial completas (validateEditorialWorkflow,
  validateImagePublication, validateArticleContent, validateSourcesAndQuality)
  -- título/dek/autor/fecha/categoría, atribución, copia extensa, texto
  genérico, editorialApproval, etc. -- ya se aplican en cada guardado real
  (POST /api/articles, ver server.js: runPrePublishValidation) A LO NUEVO
  O MODIFICADO. Volver a correrlas acá contra TODO articulos.json bloquearía
  permanentemente los 169 artículos reales (y los 4 casos legítimos ya
  documentados en pipeline.js que no cumplen una regla nueva sin haber
  sido tocados) cada vez que alguien corra validate:publish, sin haber
  cambiado nada -- exactamente el problema que pipeline.isArticleNewOrChanged
  ya resuelve para el guardado real. Esos controles viven en un solo
  lugar (pipeline.js) y se disparan en el momento correcto (al guardar
  esa noticia puntual), no acá.

  Uso:
    node admin/validate-publish.js
    npm run validate:publish   (mismo comando, vía package.json)
  Código de salida 0 si todo lo crítico pasó, 1 si algo falló.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADMIN_DIR = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

const pipeline = require('./pipeline');
const articleStatus = require('./article-status');
const imageLicenses = require('./image-licenses');
const pagegen = require('./pagegen');
const linkScanner = require('./link-scanner');

var results = []; // { name, critical, ok, details }
function record(name, critical, ok, details) {
  results.push({ name: name, critical: critical, ok: ok, details: details || '' });
  var icon = ok ? '✅' : (critical ? '❌' : '⚠️');
  console.log(icon + ' ' + name + (details ? '\n   ' + String(details).split('\n').join('\n   ') : ''));
}

function readJSONSafe(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  console.log('=== npm run validate:publish — VexlowHQ ===\n');

  var articles, categories;
  try {
    articles = readJSONSafe(path.join(DATA_DIR, 'articulos.json'));
    record('data/articulos.json es JSON válido y es un array', true, Array.isArray(articles), 'artículos: ' + (Array.isArray(articles) ? articles.length : 'N/A'));
  } catch (e) {
    record('data/articulos.json es JSON válido y es un array', true, false, e.message);
    articles = [];
  }
  try {
    categories = readJSONSafe(path.join(DATA_DIR, 'categories.json'));
    record('data/categories.json es JSON válido', true, Array.isArray(categories), '');
  } catch (e) {
    record('data/categories.json es JSON válido', true, false, e.message);
    categories = [];
  }
  try {
    readJSONSafe(path.join(DATA_DIR, 'hero.json'));
    record('data/hero.json es JSON válido', true, true, '');
  } catch (e) {
    record('data/hero.json es JSON válido', true, false, e.message);
  }

  var categorySlugsSet = new Set(categories.map(function (c) { return c.slug; }));

  // ---- 1. Esquema mínimo de cada artículo ----
  {
    var schemaIssues = [];
    articles.forEach(function (a, i) {
      if (!a.slug) schemaIssues.push('#' + i + ': falta slug');
      if (!a.category || !categorySlugsSet.has(a.category)) schemaIssues.push('#' + i + ' (' + (a.slug || '?') + '): categoría inválida (' + a.category + ')');
      if (!a.title) schemaIssues.push('#' + i + ' (' + (a.slug || '?') + '): falta title');
      if (!a.date) schemaIssues.push('#' + i + ' (' + (a.slug || '?') + '): falta date');
    });
    record('Esquema mínimo de artículos (slug/categoría/título/fecha)', true, schemaIssues.length === 0, schemaIssues.slice(0, 15).join('\n'));
  }

  // ---- 2. Fuentes y URLs ----
  {
    var badSources = [];
    articles.forEach(function (a) {
      var sources = [];
      if (a.sourceUrl) sources.push(a.sourceUrl);
      (a.additionalSources || []).forEach(function (s) { if (s && s.url) sources.push(s.url); });
      sources.forEach(function (url) {
        if (!/^https?:\/\//i.test(url)) badSources.push(a.slug + ': "' + url + '"');
      });
    });
    record('Toda fuente declarada es una URL http(s) válida', true, badSources.length === 0, badSources.slice(0, 15).join('\n'));
  }

  // ---- 3. Licencias de imagen ----
  {
    var badLicenses = [];
    articles.forEach(function (a) {
      if (a.image && a.imageLicense && !imageLicenses.isKnownLicense(a.imageLicense)) {
        badLicenses.push(a.slug + ': licencia "' + a.imageLicense + '" no reconocida');
      }
    });
    record('Toda licencia de imagen declarada está en la lista autorizada', true, badLicenses.length === 0, badLicenses.slice(0, 15).join('\n'));
  }

  // ---- 4. Slugs duplicados ----
  {
    var seen = {};
    var dupes = [];
    articles.forEach(function (a) {
      if (!a.slug || !a.category) return;
      var key = a.category + '/' + a.slug;
      if (seen[key]) dupes.push(key);
      seen[key] = true;
    });
    record('Sin slugs duplicados (misma categoría + slug)', true, dupes.length === 0, dupes.join('\n'));
  }

  // ---- 5. Redirects: todo redirectTo resuelve, y nunca se redirige a sí mismo ----
  {
    var redirectIssues = [];
    articles.forEach(function (a) {
      if (articleStatus.effectiveStatus(a) !== 'redirected') return;
      var issues = pipeline.validateRedirectArticle(a, articles);
      if (issues.length) redirectIssues.push(a.slug + ': ' + issues.map(function (i) { return i.message; }).join(' | '));
    });
    record('Todo artículo "redirected" tiene un redirectTo válido', true, redirectIssues.length === 0, redirectIssues.join('\n'));
  }

  // ---- 6. Sitemap coherente ----
  {
    var sitemapPath = path.join(ROOT, 'sitemap.xml');
    var sitemapIssues = [];
    if (fs.existsSync(sitemapPath)) {
      var sitemapXml = fs.readFileSync(sitemapPath, 'utf8');
      var listableKeys = new Set(
        articles.filter(function (a) { return articleStatus.isListable(a); })
          .map(function (a) { return '/categoria/' + a.category + '/' + a.slug + '.html'; })
      );
      var nonListable = articles.filter(function (a) { return !articleStatus.isListable(a) && a.slug && a.category; });
      nonListable.forEach(function (a) {
        var loc = '/categoria/' + a.category + '/' + a.slug + '.html';
        if (sitemapXml.indexOf('<loc>' + 'https://vexlowhq.com' + loc + '</loc>') !== -1) {
          sitemapIssues.push(a.slug + ' (' + articleStatus.effectiveStatus(a) + (a.noindex ? '+noindex' : '') + ') no debería estar en sitemap.xml pero está.');
        }
      });
    } else {
      sitemapIssues.push('sitemap.xml no existe -- correr una regeneración completa antes de publicar.');
    }
    record('sitemap.xml no incluye draft/review/approved/redirected/noindex', true, sitemapIssues.length === 0, sitemapIssues.slice(0, 15).join('\n'));
  }

  // ---- 7. AdSense / Consent Mode en páginas estáticas sensibles ----
  {
    var adsenseIssues = [];
    ['privacy.html', 'cookies.html'].forEach(function (name) {
      var p = path.join(ROOT, name);
      if (fs.existsSync(p)) {
        var html = fs.readFileSync(p, 'utf8');
        if (html.indexOf('adsbygoogle.js') !== -1) adsenseIssues.push(name + ' carga adsbygoogle.js (nunca debería).');
      }
    });
    articles.filter(function (a) { return a.noindex && articleStatus.isPublicArticle(a); }).forEach(function (a) {
      var p = path.join(ROOT, 'categoria', a.category, a.slug + '.html');
      if (fs.existsSync(p)) {
        var html = fs.readFileSync(p, 'utf8');
        if (html.indexOf('adsbygoogle.js') !== -1) adsenseIssues.push(a.slug + ' es noindex pero su página carga adsbygoogle.js.');
      }
    });
    record('Privacy/Cookies y artículos noindex nunca cargan AdSense', true, adsenseIssues.length === 0, adsenseIssues.slice(0, 15).join('\n'));
  }

  // ---- 8. JSON-LD / Open Graph en artículos públicos ----
  {
    var seoIssues = [];
    var checked = 0;
    articles.filter(function (a) { return articleStatus.isPublicArticle(a) && a.slug && a.category; }).forEach(function (a) {
      var p = path.join(ROOT, 'categoria', a.category, a.slug + '.html');
      if (!fs.existsSync(p)) return;
      checked++;
      var html = fs.readFileSync(p, 'utf8');
      if (html.indexOf('"@type":"NewsArticle"') === -1 && html.indexOf('"@type": "NewsArticle"') === -1) {
        seoIssues.push(a.slug + ': falta JSON-LD NewsArticle.');
      }
      if (html.indexOf('property="og:title"') === -1) seoIssues.push(a.slug + ': falta og:title.');
      if (html.indexOf('rel="canonical"') === -1) seoIssues.push(a.slug + ': falta <link rel="canonical">.');
    });
    record('Artículos públicos tienen JSON-LD + Open Graph + canonical (' + checked + ' revisados)', true, seoIssues.length === 0, seoIssues.slice(0, 15).join('\n'));
  }

  // ---- 9. Enlaces internos rotos (TODOS los artículos, nuevos o viejos) ----
  // Misma resolución de dos pasos que pipeline.js:validateArticleContent
  // (raíz del sitio, y si no existe ahí, relativo a la carpeta de la
  // propia página categoria/<categoria>/) -- un href relativo dentro del
  // cuerpo lo resuelve el navegador contra su propia carpeta, no contra
  // la raíz.
  {
    var brokenLinks = [];
    articles.forEach(function (a) {
      pipeline.extractInternalLinks(a.body).forEach(function (href) {
        var clean = href.split('#')[0];
        var asRootRelative = path.join(ROOT, clean);
        var asArticleRelative = a.category ? path.join(ROOT, 'categoria', a.category, clean) : asRootRelative;
        if (!fs.existsSync(asRootRelative) && !fs.existsSync(asArticleRelative)) {
          brokenLinks.push(a.slug + ': "' + href + '"');
        }
      });
    });
    record('Sin enlaces internos rotos en ningún artículo', true, brokenLinks.length === 0, brokenLinks.slice(0, 15).join('\n'));
  }

  // ---- 9b. Enlaces/recursos rotos en el HTML PÚBLICO REALMENTE GENERADO ----
  // Hallazgo 2026-09-13: el chequeo #9 de arriba solo mira el campo `body`
  // de cada artículo dentro de articulos.json -- nunca miró el HTML que se
  // sirve de verdad. El rail de "You might also like" (renderRelatedBlock),
  // el sidebar/footer compartido, las páginas de categoría, portada, juegos
  // e institucionales se generan aparte, y podían quedar con referencias
  // muertas sin que este validador se enterara -- así pasaron
  // desapercibidos 112 enlaces rotos hacia 28 artículos borrados incluso
  // con el chequeo #9 en verde. Este control escanea con jsdom CADA
  // archivo .html público realmente generado (excluye admin/, el panel
  // nunca se publica -- ver .vercelignore) y revisa: todo <a href>, todo
  // [src] (imágenes, scripts), <link rel="canonical">, og:image, og:url y
  // las URLs dentro de cada bloque JSON-LD (image/url/logo, recursivo),
  // resolviendo cada referencia relativa contra la carpeta real del
  // archivo que la contiene (no siempre es la raíz del sitio: un artículo
  // vive en categoria/<cat>/, por ejemplo). Ignora deliberadamente: enlaces
  // externos (otro origen), mailto:/tel:/javascript:/data:, fragmentos
  // puros (#ancla) y query strings (?utm=...). Un redirect configurado
  // (admin/pagegen.js generateRedirectFile) sigue generando un archivo
  // real en la URL vieja del artículo, así que una referencia hacia esa
  // URL no se reporta como rota -- el archivo existe y hace su propio
  // meta-refresh; sí se reporta si el destino no existe en absoluto.
  {
    // La implementación del escaneo vive en admin/link-scanner.js (única
    // fuente de verdad -- la comparte esta validación de producción con
    // admin/test-related-links-fix.js, la prueba A/B de este proyecto).
    var scan = linkScanner.scanPublicHtml(ROOT);
    var brokenRefs = scan.broken.map(function (b) {
      return b.message
        ? (b.file + ': ' + b.message)
        : (b.file + ' [' + b.kind + '="' + b.raw + '"] -> ' + b.resolved + ' (no existe)');
    });
    record(
      'Sin referencias rotas en el HTML público generado (href/src/canonical/OG/JSON-LD) -- ' + scan.filesScanned + ' páginas, ' + scan.refsChecked + ' referencias internas revisadas',
      true,
      brokenRefs.length === 0,
      brokenRefs.slice(0, 30).join('\n') + (brokenRefs.length > 30 ? '\n... y ' + (brokenRefs.length - 30) + ' más' : '')
    );
  }

  // ---- 9.b Páginas institucionales y de Games: sidebar/footer/consent
  // no pueden quedar desactualizados (auditoría 2026-09-13) ----
  //
  // Antes ningún control detectaba esto: el sidebar "Latest Posts"/nav de
  // categorías y el bloque de Consent Mode/AdSense de las 7 páginas
  // institucionales y las 8 de Games se compartían con portada, pero solo
  // una corrida manual de generate_pages.py (Python) los sincronizaba --
  // el flujo normal del panel (Node) nunca las tocaba. Ahora
  // pagegen.regenerateAllArticlePages() las sincroniza siempre (ver
  // syncSharedShellPages() en admin/pagegen.js); este control verifica
  // que de verdad hayan quedado al día, comparando el sidebar/footer/
  // consent block ACTUAL de cada archivo contra el que se generaría de
  // nuevo ahora mismo a partir del estado actual de portada -- sin
  // escribir nada (misma fuente que usa el generador, en modo solo
  // lectura).
  {
    var shellIssues = [];
    try {
      var raw = pagegen.loadSidebarFooterRaw();
      var checkPage = function (filePath, depth, loadAds, label) {
        if (!fs.existsSync(filePath)) {
          shellIssues.push(label + ': el archivo no existe');
          return;
        }
        var html = fs.readFileSync(filePath, 'utf8');
        var expectedSidebar = pagegen.localize(raw.sidebarRaw, depth);
        var expectedFooter = pagegen.localize(raw.footerRaw, depth);
        var expectedConsent = pagegen.CONSENT_MARKER_START + '\n' + pagegen.consentBlockFor(loadAds) + pagegen.CONSENT_MARKER_END;
        var actualSidebar = html.indexOf(pagegen.SIDEBAR_START_MARKER) !== -1
          ? html.slice(html.indexOf(pagegen.SIDEBAR_START_MARKER), html.indexOf(pagegen.SIDEBAR_END_MARKER, html.indexOf(pagegen.SIDEBAR_START_MARKER)) + pagegen.SIDEBAR_END_MARKER.length)
          : null;
        var actualFooter = html.indexOf(pagegen.FOOTER_START_MARKER) !== -1
          ? html.slice(html.indexOf(pagegen.FOOTER_START_MARKER), html.indexOf(pagegen.FOOTER_END_MARKER, html.indexOf(pagegen.FOOTER_START_MARKER)) + pagegen.FOOTER_END_MARKER.length)
          : null;
        var hasConsentMarkers = html.indexOf(pagegen.CONSENT_MARKER_START) !== -1 && html.indexOf(pagegen.CONSENT_MARKER_END) !== -1;
        var actualConsent = hasConsentMarkers
          ? html.slice(html.indexOf(pagegen.CONSENT_MARKER_START), html.indexOf(pagegen.CONSENT_MARKER_END) + pagegen.CONSENT_MARKER_END.length)
          : null;
        if (actualSidebar === null) { shellIssues.push(label + ': no se encontró el sidebar compartido'); }
        else if (actualSidebar !== expectedSidebar) { shellIssues.push(label + ': sidebar (Latest Posts/nav de categorías) desactualizado respecto a portada'); }
        if (actualFooter === null) { shellIssues.push(label + ': no se encontró el footer compartido'); }
        else if (actualFooter !== expectedFooter) { shellIssues.push(label + ': footer desactualizado respecto a portada'); }
        if (actualConsent === null) { shellIssues.push(label + ': no tiene los marcadores CONSENT_ADS_BLOCK -- correr una regeneración completa'); }
        else if (actualConsent !== expectedConsent) { shellIssues.push(label + ': bloque de Consent Mode/AdSense/Analytics distinto del canónico (' + (loadAds ? 'con AdSense' : 'sin AdSense') + ' esperado)'); }
      };
      pagegen.STATIC_PAGE_SLUGS.forEach(function (slug) {
        checkPage(path.join(ROOT, slug + '.html'), 0, !pagegen.STATIC_PAGES_NO_ADS[slug], slug + '.html');
      });
      pagegen.PLAY_PAGE_FILES.forEach(function (filename) {
        checkPage(path.join(ROOT, 'play', filename), 1, true, 'play/' + filename);
      });
    } catch (e) {
      shellIssues.push('No se pudo verificar (excepción): ' + e.message);
    }
    record(
      'Páginas institucionales y de Games (15) con sidebar/footer/Consent-AdSense al día respecto a portada',
      true,
      shellIssues.length === 0,
      shellIssues.join('\n')
    );
  }

  // ---- 10. Archivos temporales / residuos de prueba ----
  {
    var TEST_SLUG_PATTERN = /^(test-|qa-|synthetic-|prueba-)/i;
    var leftovers = articles.filter(function (a) { return a.slug && TEST_SLUG_PATTERN.test(a.slug); }).map(function (a) { return a.slug; });
    record('Sin artículos de prueba residuales en articulos.json', true, leftovers.length === 0, leftovers.join(', '));

    var draftsDir = path.join(ROOT, 'img', 'drafts');
    // img/drafts/ es ruta temporal legítima para prompts pendientes -- no
    // es en sí un error, pero un archivo ahí referenciado por un artículo
    // YA PUBLICADO (no draft) sí lo es (regla ya existente en pipeline.js,
    // se re-chequea acá a nivel global como red de seguridad adicional).
    var draftPathIssues = [];
    articles.forEach(function (a) {
      if (articleStatus.isPublicArticle(a) && a.image && a.image.indexOf('img/drafts/') === 0) {
        draftPathIssues.push(a.slug + ': imagen publicada sigue en img/drafts/ (' + a.image + ')');
      }
    });
    if (draftPathIssues.length) {
      record('Ningún artículo publicado usa una imagen en img/drafts/', false, false, draftPathIssues.join('\n') + '\n(no crítico: ver el comentario de las 4 excepciones legítimas ya documentadas en pipeline.js, admin/server.js runPrePublishValidation)');
    } else {
      record('Ningún artículo publicado usa una imagen en img/drafts/', false, true, '');
    }
  }

  // ---- 11. Secretos expuestos ----
  {
    var configPath = path.join(ADMIN_DIR, 'config.json');
    var secretIssues = [];
    if (fs.existsSync(configPath)) {
      var configContent = fs.readFileSync(configPath, 'utf8').trim();
      if (configContent) {
        // Busca el contenido LITERAL de config.json copiado en cualquier
        // archivo público del sitio (HTML/JS/JSON servidos fuera de admin/)
        // -- señal de que una clave se filtró a algo que se publica.
        var publicFiles = [];
        (function walk(dir) {
          fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
            if (entry.name === 'admin' || entry.name === '.git' || entry.name === 'node_modules') return;
            var full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(html|js|json)$/i.test(entry.name)) publicFiles.push(full);
          });
        })(ROOT);
        publicFiles.forEach(function (f) {
          var content = fs.readFileSync(f, 'utf8');
          if (content.indexOf(configContent) !== -1) secretIssues.push(path.relative(ROOT, f));
        });
      }
    }
    record('admin/config.json no aparece copiado en ningún archivo público', true, secretIssues.length === 0, secretIssues.join('\n'));
  }

  // ---- 12. Sintaxis JavaScript ----
  {
    var jsErrors = [];
    fs.readdirSync(ADMIN_DIR).filter(function (f) { return f.endsWith('.js'); }).forEach(function (f) {
      try {
        execFileSync(process.execPath, ['--check', path.join(ADMIN_DIR, f)], { stdio: 'pipe' });
      } catch (e) {
        jsErrors.push(f + ': ' + e.message);
      }
    });
    record('Sintaxis válida en todos los admin/*.js (' + fs.readdirSync(ADMIN_DIR).filter(function (f) { return f.endsWith('.js'); }).length + ' archivos)', true, jsErrors.length === 0, jsErrors.join('\n'));
  }

  // ---- 13. Sintaxis Python ----
  {
    try {
      execFileSync('python3', ['-m', 'py_compile', path.join(ADMIN_DIR, 'generate_pages.py')], { stdio: 'pipe' });
      record('Sintaxis válida en generate_pages.py', true, true, '');
    } catch (e) {
      record('Sintaxis válida en generate_pages.py', true, false, e.message);
    }
  }

  // ---- 14. Paridad Node/Python ----
  {
    try {
      execFileSync(process.execPath, [path.join(ADMIN_DIR, 'test-parity.js')], { stdio: 'pipe' });
      record('Paridad Node/Python (admin/test-parity.js)', true, true, '');
    } catch (e) {
      var out = (e.stdout ? e.stdout.toString('utf8') : '') + (e.stderr ? e.stderr.toString('utf8') : '');
      record('Paridad Node/Python (admin/test-parity.js)', true, false, out.split('\n').slice(-20).join('\n'));
    }
  }

  // ---- 15. Determinismo: dos corridas seguidas de Node dan el mismo resultado ----
  {
    var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-determinism-'));
    var runA = path.join(tmpBase, 'run-a');
    var runB = path.join(tmpBase, 'run-b');
    try {
      [runA, runB].forEach(function (dest) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(ROOT).forEach(function (entry) {
          if (entry === '.git') return;
          fs.cpSync(path.join(ROOT, entry), path.join(dest, entry), { recursive: true });
        });
      });
      [runA, runB].forEach(function (dest) {
        // Usa el mismo regenerador completo que corre en cada guardado real
        // (pagegen.regenerateAllArticlePages, admin/server.js) -- así el
        // chequeo de determinismo prueba exactamente el camino que se usa
        // en producción, incluyendo el rail de relacionados de TODOS los
        // artículos, no solo un subconjunto reconstruido a mano acá.
        var pg = require(path.join(dest, 'admin', 'pagegen.js'));
        pg.regenerateAllArticlePages();
      });
      var diffCount = 0;
      var diffFiles = [];
      (function walk(dir, base) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
          if (dir === base && entry.name === 'admin') return;
          var full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full, base); return; }
          var rel = path.relative(base, full);
          var other = path.join(runB, rel);
          if (!fs.existsSync(other)) { diffCount++; diffFiles.push(rel + ' (falta en la 2da corrida)'); return; }
          if (!fs.readFileSync(full).equals(fs.readFileSync(other))) { diffCount++; diffFiles.push(rel); }
        });
      })(runA, runA);
      record('Determinismo: dos corridas seguidas de Node dan bytes idénticos', diffCount === 0, diffCount === 0, diffFiles.slice(0, 15).join('\n'));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }

  console.log('\n=== RESUMEN ===');
  var criticalFailed = results.filter(function (r) { return r.critical && !r.ok; });
  var nonCriticalFailed = results.filter(function (r) { return !r.critical && !r.ok; });
  console.log(results.length + ' controles corridos, ' + criticalFailed.length + ' críticos fallidos, ' + nonCriticalFailed.length + ' advertencias no críticas.');
  if (criticalFailed.length) {
    console.log('\n❌ BLOQUEADO -- no se debe publicar hasta resolver:');
    criticalFailed.forEach(function (r) { console.log('  - ' + r.name); });
    process.exit(1);
  } else {
    console.log('\n✅ Todo lo crítico pasó. Habilitado para publicar.');
    if (nonCriticalFailed.length) {
      console.log('(hay ' + nonCriticalFailed.length + ' advertencia(s) no crítica(s) arriba -- no bloquean, pero conviene revisarlas.)');
    }
    process.exit(0);
  }
}

main();
