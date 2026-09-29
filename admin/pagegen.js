/*
  Generador de páginas de ARTÍCULO — usado por admin/server.js
  ===============================================================
  Esta es la versión en Node de la parte de "artículos" de
  generate_pages.py: arma categoria/{categoria}/{slug}.html a partir
  de un objeto artículo (título, dek, fecha, cuerpo en texto simple).

  Las páginas de categoría y de tema (los "hubs") las sigue generando
  admin/generate_pages.py (botón "Regenerar categorías y temas" del
  panel) — eso cambia poco y ese script ya está probado. Esto de acá
  es lo que se ejecuta cada vez que guardás un artículo desde el panel,
  así no hace falta correr Python para publicar una noticia.

  Formato del texto del cuerpo (campo "body" del artículo):
    - Párrafos separados por una línea en blanco.
    - "## Texto" al principio de una línea = subtítulo (h2).
    - Líneas seguidas que empiezan con "- " = lista.
    - Una línea que diga exactamente "[publicidad]" se ignora al renderizar
      (quedó de cuando había espacios publicitarios en el cuerpo; se sacaron
      hasta tener AdSense aprobado, pero el parser la sigue reconociendo por
      los artículos viejos que todavía la tienen en el texto guardado).
    - "![alt](ruta)" en su propia línea = imagen suelta en medio del cuerpo.
*/

const fs = require('fs');
const path = require('path');
const articleStatus = require('./article-status');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CATEGORIA_DIR = path.join(ROOT, 'categoria');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');

const SITE_URL = 'https://vexlowhq.com';
const SITE_NAME = 'VexlowHQ';
const DEFAULT_AUTHOR = 'Leonardo Beltran';
const LOGO_PATH = 'img/vexlow-logo.png';
// Por debajo de esta cantidad de artículos propios, la página de
// categoría se marca noindex,follow y se saca del sitemap -- mismo
// criterio que MIN_CATEGORY_ARTICLES en admin/generate_pages.py, las
// dos implementaciones tienen que coincidir.
const MIN_CATEGORY_ARTICLES = 5;

// Google Consent Mode v2 + carga de GA4/AdSense -- bloque UNICO,
// centralizado aca (auditoria global, 2026-09-09). Antes este mismo
// bloque estaba pegado a mano en 2 lugares de este archivo (plantilla de
// articulo y CATEGORY_PAGE_TEMPLATE) mas 11 en admin/generate_pages.py --
// 13 puntos independientes donde una futura edicion podia quedar
// inconsistente. CONSENT_BASE_BLOCK y ADSENSE_SCRIPT_TAG tienen que ser
// CARACTER POR CARACTER identicos a las constantes homonimas en
// admin/generate_pages.py (Python); si se edita uno, hay que editar el
// otro exactamente igual -- ver la nota larga alli sobre el resto del
// diseño (un solo dataLayer/gtag, CMP publicada en AdSense con su
// integracion pendiente de verificacion posterior al deploy, funcion de
// "reabrir preferencias", etc.).
//
// AdSense es CONDICIONAL (auditoria 2026-09-11, control de monetizacion):
// consentBlockFor(loadAds) devuelve CONSENT_BASE_BLOCK (GA4 + Consent
// Mode, siempre) + ADSENSE_SCRIPT_TAG solo si loadAds es true. Un articulo
// con noindex=true nunca debe llevar adsbygoogle.js -- sigue siendo
// navegable por URL directa, pero no se monetiza. CONSENT_ADS_BLOCK se
// mantiene como alias de consentBlockFor(true) para los usos que siempre
// llevan anuncios (portada, categorias).
const CONSENT_BASE_BLOCK =
'<script>\n' +
'  /* Google Consent Mode v2 -- unica inicializacion de dataLayer/gtag de toda\n' +
'     la pagina. Consentimiento por defecto: denegado para TODAS las\n' +
'     regiones (postura conservadora mientras no se confirme que la CMP\n' +
'     publicada en AdSense esta integrada y funcionando en produccion),\n' +
'     hasta que el usuario decida vía la CMP.\n' +
'\n' +
'     Modo preview local (auditoria 2026-09-12): en localhost/127.0.0.1 no\n' +
'     se cargan externamente gtag.js, el script de AdSense (adsbygoogle)\n' +
'     ni Funding Choices/googlefc (bloqueo a nivel de solicitud de red -- los <script src>\n' +
'     reales nunca se insertan en el DOM -- no un ocultamiento visual con\n' +
'     CSS) para no ensuciar Analytics ni gastar cuota de anuncios con\n' +
'     trafico de desarrollo. En cualquier otro hostname (produccion,\n' +
'     previews de Vercel, etc.) el comportamiento no cambia: se sigue\n' +
'     cargando todo exactamente igual que antes. */\n' +
'  window.VEXLOW_PREVIEW_LOCAL = (window.location.hostname === \'localhost\' || window.location.hostname === \'127.0.0.1\');\n' +
'  window.dataLayer = window.dataLayer || [];\n' +
'  function gtag(){ dataLayer.push(arguments); }\n' +
'  gtag(\'consent\', \'default\', {\n' +
'    \'ad_storage\': \'denied\',\n' +
'    \'ad_user_data\': \'denied\',\n' +
'    \'ad_personalization\': \'denied\',\n' +
'    \'analytics_storage\': \'denied\',\n' +
'    \'wait_for_update\': 500\n' +
'  });\n' +
'  gtag(\'js\', new Date());\n' +
'  gtag(\'config\', \'G-20Z63KYZ3K\');\n' +
'  window.vexlowReopenConsentPreferences = function () {\n' +
'    if (window.googlefc && typeof window.googlefc.showRevocationMessage === \'function\') {\n' +
'      window.googlefc.showRevocationMessage();\n' +
'    } else {\n' +
'      alert(\'Las preferencias de privacidad no estan disponibles en este momento. Mientras tanto, VexlowHQ no carga cookies de anuncios ni de analitica de personalizacion sin tu consentimiento.\');\n' +
'    }\n' +
'  };\n' +
'  window.vexlowLoadExternalScript = function (src, crossOrigin) {\n' +
'    if (window.VEXLOW_PREVIEW_LOCAL) return;\n' +
'    var s = document.createElement(\'script\');\n' +
'    s.async = true;\n' +
'    s.src = src;\n' +
'    if (crossOrigin) { s.crossOrigin = crossOrigin; }\n' +
'    document.head.appendChild(s);\n' +
'  };\n' +
'  if (window.VEXLOW_PREVIEW_LOCAL) {\n' +
'    console.log(\'[VexlowHQ Preview] Ads, CMP and Analytics disabled on localhost\');\n' +
'  } else {\n' +
'    window.vexlowLoadExternalScript(\'https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K\');\n' +
'  }\n' +
'</script>\n' +
'<!-- Estado (2026-09-11): CMP publicada en AdSense (mensaje "European\n' +
'     regulations message - vexlowhq.com", Estado: Publicado, ingles + 31\n' +
'     idiomas, ultima modificacion 2026-08-15). Pendiente: verificar\n' +
'     posterior al deploy que `window.googlefc` se inyecta correctamente y\n' +
'     que conecta con las llamadas gtag(\'consent\', \'update\', ...) de arriba\n' +
'     (procedimiento completo en verificacion-consentimiento-post-activacion.md).\n' +
'     Hasta confirmar esa prueba, Consent Mode se queda en el valor por\n' +
'     defecto "denied" de arriba para todas las regiones cada vez que\n' +
'     `window.googlefc` no este presente. -->\n';

// Carga de AdSense -- se agrega o se omite segun consentBlockFor(loadAds)
// de abajo. NUNCA se inserta en paginas noindex (auditoria editorial en
// curso o articulos fusionados con redirect) -- auditoria 2026-09-11,
// control de monetizacion en paginas no indexables. Se inserta via
// window.vexlowLoadExternalScript (definida en CONSENT_BASE_BLOCK, que
// siempre precede a este bloque) en vez de un <script src> estatico, para
// que quede sujeto al mismo bloqueo de red en localhost/127.0.0.1
// (auditoria 2026-09-12, modo preview local).
const ADSENSE_SCRIPT_TAG =
'<script>window.vexlowLoadExternalScript(\'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9714873159823978\', \'anonymous\');</script>\n';

function consentBlockFor(loadAds) {
  return CONSENT_BASE_BLOCK + (loadAds ? ADSENSE_SCRIPT_TAG : '');
}

// Alias para los puntos de uso que siempre llevan anuncios (portada,
// categorias) -- no hace falta tocarlos, se comportan igual que antes.
const CONSENT_ADS_BLOCK = consentBlockFor(true);

// Se recarga del disco en cada llamada, mismo patrón que loadCategories()
// -- así una nota publicada un segundo antes ya entra como candidata a
// "relacionada" sin reiniciar el servidor.
function loadArticles() {
  try {
    return JSON.parse(fs.readFileSync(ARTICULOS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

// Las categorías viven en data/categories.json (fuente única, la misma
// que lee admin/generate_pages.py) para poder agregarlas/editarlas/
// borrarlas desde el panel sin tocar código. Se recargan del disco en
// cada llamada -- mismo patrón que loadTopicGroups() -- para que un
// cambio hecho por el panel se vea sin reiniciar el servidor.
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');

function loadCategories() {
  return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8'));
}
function saveCategories(list) {
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
}
function categoryBySlug(slug) {
  return loadCategories().find(function (c) { return c.slug === slug; });
}

// Categorías ocultas hasta tener contenido real (Cybersecurity/Guides,
// auditoria 2026-09-12): cat.publicMinArticles en data/categories.json.
// Una categoría SIN ese campo se comporta exactamente igual que siempre
// (siempre visible/generada) -- esto incluye Sports/Entertainment, que
// solo dejan de aceptar notas nuevas (ver CATEGORIES_ACCEPTING_NEW_CONTENT
// más abajo) pero conservan su página y su nav intactas. Mismo criterio,
// mismo nombre en espíritu, que is_category_publicly_visible() en
// admin/generate_pages.py (Python) -- si se edita uno, hay que editar el
// otro igual.
function isCategoryPubliclyVisible(cat, count) {
  var minimum = cat && cat.publicMinArticles;
  if (!minimum) return true;
  return count >= minimum;
}

// Categorías habilitadas para contenido NUEVO (selector del panel al
// crear/editar un artículo) -- auditoria 2026-09-12. Mismo criterio,
// mismo nombre, que CATEGORIES_ACCEPTING_NEW_CONTENT en
// admin/generate_pages.py (Python): tienen que coincidir exactamente.
function categoriesAcceptingNewContent() {
  return loadCategories().filter(function (c) { return c.slug !== 'trending' && !c.retiredForNewContent; });
}

// ============================================================================
// Nav de categorías (sidebar, footer, chips de filtro) -- auditoría
// 2026-09-27, corrección de la causa estructural de la brecha de paridad
// Node/Python. ANTES, pagegen.js nunca reconstruía este bloque: solo lo
// EXTRAÍA tal cual estaba escrito en index.html (ver loadSidebarFooterRaw()
// más abajo) y lo copiaba al resto de páginas -- así que un rename o alta/
// baja de categoría en data/categories.json nunca se veía reflejado en el
// nav real, ni siquiera en index.html mismo, sin correr generate_pages.py
// (Python) a mano. Estas tres funciones son el puerto carácter por carácter
// de build_category_nav_html/build_footer_categories_html/
// build_filter_chips_html en admin/generate_pages.py -- las dos
// implementaciones tienen que devolver bytes IDÉNTICOS para el mismo
// `visibleCats`, o test-parity.js/test-related-links-fix.js (prueba H) lo
// detectan. Se llaman desde generateHomeSections() (más abajo), ANTES de
// que loadSidebarFooterRaw() extraiga el sidebar/footer ya actualizados
// para el resto del sitio -- mismo orden que generate() en Python.
function buildCategoryNavHtml(visibleCats) {
  var cats = visibleCats || loadCategories();
  var items = [
    '      <div class="cat-item">\n' +
    '        <div class="cat-row">\n' +
    '          <a class="cat-link" href="index.html" data-cat="index"><span class="ic">🏠</span>Home</a>\n' +
    '        </div>\n' +
    '      </div>',
    '      <div class="cat-item">\n' +
    '        <div class="cat-row">\n' +
    '          <a class="cat-link" href="play/index.html" data-cat="play"><span class="ic">🎮</span>Games</a>\n' +
    '        </div>\n' +
    '      </div>'
  ];
  cats.forEach(function (cat) {
    items.push(
      '      <div class="cat-item">\n' +
      '        <div class="cat-row">\n' +
      '          <a class="cat-link" href="categoria/' + cat.slug + '/index.html" data-cat="' + cat.slug + '"><span class="ic">' + cat.icon + '</span>' + escapeHtml(cat.label) + '</a>\n' +
      '        </div>\n' +
      '      </div>'
    );
  });
  return items.join('\n\n') + '\n';
}

function buildFooterCategoriesHtml(visibleCats) {
  var cats = visibleCats || loadCategories();
  var mid = Math.ceil(cats.length / 2); // == Python (len(cats)+1)//2
  var firstHalf = cats.slice(0, mid);
  var secondHalf = cats.slice(mid);
  function linksFor(list) {
    return list.map(function (c) {
      return '          <a href="categoria/' + c.slug + '/index.html">' + escapeHtml(c.label) + '</a>';
    }).join('\n');
  }
  return '<div class="footer-col">\n' +
    '          <h4>Categories</h4>\n' +
    linksFor(firstHalf) + '\n' +
    '        </div>\n' +
    '        <div class="footer-col">\n' +
    '          <h4>More categories</h4>\n' +
    linksFor(secondHalf) + '\n' +
    '        </div>\n        ';
}

function buildFilterChipsHtml(visibleCats) {
  var cats = visibleCats || loadCategories();
  var chips = ['        <button type="button" class="filter-chip active" data-filter="all">All</button>'];
  cats.forEach(function (cat) {
    if (cat.slug === 'trending') return;
    chips.push('        <button type="button" class="filter-chip" data-filter="' + cat.slug + '">' + cat.icon + ' ' + escapeHtml(cat.label) + '</button>');
  });
  return chips.join('\n') + '\n      ';
}

// Categorías con página propia generada (isCategoryPubliclyVisible, ej.
// Cybersecurity/Guides con publicMinArticles) -- mismo criterio, mismo
// nombre en espíritu, que `visible_cats` en admin/generate_pages.py
// (Python). NO depende de retiredForNewContent -- Science & Space sigue
// generando categoria/science/index.html normalmente, solo deja de
// aparecer en el menú (ver menuVisibleCategories() más abajo).
function pageVisibleCategories(allArticlesOpt) {
  var allArticles = allArticlesOpt || loadArticles();
  var publishable = allArticles.filter(function (a) {
    return a.slug && categoryBySlug(a.category) && String(a.body || '').trim() && articleStatus.isPublicArticle(a);
  });
  var countBySlug = {};
  publishable.forEach(function (a) {
    if (a.noindex) return;
    countBySlug[a.category] = (countBySlug[a.category] || 0) + 1;
  });
  return loadCategories().filter(function (cat) { return isCategoryPubliclyVisible(cat, countBySlug[cat.slug] || 0); });
}

// Categorías visibles en el MENÚ principal (sidebar/footer/chips) --
// pedido explícito de Leonardo (2026-09-27): retiredForNewContent (hoy
// solo Science & Space) retira a la categoría del menú principal nuevo,
// sin borrar su página, sus artículos ni sus URLs (esas siguen existiendo
// vía pageVisibleCategories() de arriba, que generateCategoryPage() sigue
// usando sin cambios). Antes retiredForNewContent SOLO controlaba
// categoriesAcceptingNewContent() (selector del panel al crear una nota
// nueva) y nunca afectaba el nav -- este es un cambio de comportamiento
// deliberado, no un bug. Mismo criterio, mismo nombre en espíritu, que
// menu_visible_cats en admin/generate_pages.py (Python) -- las dos listas
// tienen que coincidir exactamente para que el nav sea idéntico.
function menuVisibleCategories(allArticlesOpt) {
  return pageVisibleCategories(allArticlesOpt).filter(function (cat) { return !cat.retiredForNewContent; });
}

// Puerto carácter por carácter de _category_labels_list()/
// _category_list_sentence()/_category_list_lowercase_sentence() en
// admin/generate_pages.py (Python) -- usadas SOLO por las dos frases de
// prosa (about-vexlowhq.html/advertise.html) que enumeran las categorías
// fuera del nav. A diferencia del nav, esta lista NO se filtra por
// menuVisibleCategories() -- Science & Space sigue mencionada en esta
// prosa aunque ya no esté en el menú, exactamente igual que en Python
// (_category_labels_list() recorre CATEGORY_SLUGS completo, sin filtrar
// por retired_for_new_content). Ver syncCategoryListSentences() más abajo
// para cómo se parchean estas dos frases en los archivos ya existentes.
var NUMBER_WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };

function categoryLabelsList() {
  return loadCategories().filter(function (c) { return c.slug !== 'trending'; }).map(function (c) { return c.label; });
}

function joinLabelsWithAnd(labels) {
  if (labels.length > 1) return labels.slice(0, -1).join(', ') + ', and ' + labels[labels.length - 1];
  return labels.length ? labels[0] : '';
}

var CATEGORY_LIST_SENTENCE_START = '<!-- CATEGORY_LIST_SENTENCE:START -->';
var CATEGORY_LIST_SENTENCE_END = '<!-- CATEGORY_LIST_SENTENCE:END -->';
var CATEGORY_LIST_LOWERCASE_START = '<!-- CATEGORY_LIST_LOWERCASE:START -->';
var CATEGORY_LIST_LOWERCASE_END = '<!-- CATEGORY_LIST_LOWERCASE:END -->';

function categoryListSentence() {
  var labels = categoryLabelsList();
  var joined = joinLabelsWithAnd(labels);
  var countWord = NUMBER_WORDS[labels.length] || String(labels.length);
  var sentence = 'We publish across ' + countWord + ' categories: ' + joined + '. Every day we add news, guides, and analysis built for readers who want to stay current without hunting across a dozen sites.';
  return CATEGORY_LIST_SENTENCE_START + sentence + CATEGORY_LIST_SENTENCE_END;
}

function categoryListLowercaseSentence() {
  var labels = categoryLabelsList().map(function (l) { return l.toLowerCase(); });
  var joined = joinLabelsWithAnd(labels);
  return CATEGORY_LIST_LOWERCASE_START + joined + CATEGORY_LIST_LOWERCASE_END;
}

// Parchea in-place las dos frases de arriba en una página institucional ya
// generada, SOLO si ya tiene los marcadores (about-vexlowhq.html y
// advertise.html los tienen desde la corrección 2026-09-27; cualquier otra
// página estática -- privacy, terms, etc. -- o de juegos simplemente no los
// tiene y esta función no le toca nada). Mismo patrón que
// patchConsentAdsBlock() de más abajo: reemplaza TODO el tramo entre
// marcadores (marcadores incluidos) por la frase recién calculada.
function syncCategoryListSentences(html) {
  if (html.indexOf(CATEGORY_LIST_SENTENCE_START) !== -1) {
    html = replaceBlock(html, CATEGORY_LIST_SENTENCE_START, CATEGORY_LIST_SENTENCE_END, categoryListSentence());
  }
  if (html.indexOf(CATEGORY_LIST_LOWERCASE_START) !== -1) {
    html = replaceBlock(html, CATEGORY_LIST_LOWERCASE_START, CATEGORY_LIST_LOWERCASE_END, categoryListLowercaseSentence());
  }
  return html;
}

function categorySlugify(label) {
  return String(label)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/* Crea una categoría nueva al final de la lista. No genera HTML acá --
   para eso está "Regenerar categorías y temas" del panel, que corre
   generate_pages.py y arma el nav, el footer, los chips de filtro y la
   página de la categoría. A propósito NO se agrega una sección propia
   en la portada -- eso queda para cuando el sitio ya tenga contenido
   real ahí, así no se repite el problema de "categoría vacía en la
   portada" que motivó sacar el sistema de temas. */
function addCategory(label, icon, description) {
  if (!label || !label.trim()) throw new Error('El nombre de la categoría no puede estar vacío');
  var slug = categorySlugify(label);
  if (!slug) throw new Error('El nombre no generó un slug válido');

  var list = loadCategories();
  if (list.some(function (c) { return c.slug === slug; })) {
    throw new Error('Ya existe una categoría con ese nombre');
  }

  var created = { slug: slug, label: label.trim(), icon: icon || '📄', description: description || '' };
  list.push(created);
  saveCategories(list);
  return created;
}

function renameCategory(slug, newLabel, newIcon, newDescription) {
  var list = loadCategories();
  var cat = list.find(function (c) { return c.slug === slug; });
  if (!cat) throw new Error('No se encontró esa categoría');
  if (newLabel && newLabel.trim()) cat.label = newLabel.trim();
  if (newIcon) cat.icon = newIcon;
  if (typeof newDescription === 'string') cat.description = newDescription;
  saveCategories(list);
  return cat;
}

/* Si la categoría tenía su propia sección destacada en la portada
   (<section class="home-section" id="slug">...), la saca de index.html
   -- si no se hace esto, generate_pages.py la deja intacta (no la toca)
   y queda un riel vacío "0 artículos" en la home, el mismo problema que
   motivó sacar World/Curiosities/Guides. No es un error si no existía
   (la mayoría de las categorías nunca tuvieron una, a propósito --
   ver build_category_nav_html en generate_pages.py). */
function removeHomepageRail(slug) {
  var indexPath = path.join(ROOT, 'index.html');
  var html = fs.readFileSync(indexPath, 'utf8');
  var re = new RegExp('[ \\t]*<section class="home-section" id="' + slug + '">[\\s\\S]*?</section>\\r?\\n?', '');
  var next = html.replace(re, '');
  if (next !== html) fs.writeFileSync(indexPath, next, 'utf8');

  var scriptPath = path.join(ROOT, 'js', 'script.js');
  var js = fs.readFileSync(scriptPath, 'utf8');
  var nextJs = js.replace(new RegExp("(RAIL_CATEGORIES = \\[[^\\]]*?)'" + slug + "', ?"), '$1');
  nextJs = nextJs.replace(new RegExp("(RAIL_CATEGORIES = \\[[^\\]]*?), ?'" + slug + "'"), '$1');
  if (nextJs !== js) fs.writeFileSync(scriptPath, nextJs, 'utf8');
}

/* Saca una categoría de data/categories.json y borra su carpeta
   categoria/<slug>/ (a esta altura solo tiene el index.html de la
   categoría -- server.js valida antes que no le queden artículos
   asignados, para no dejar contenido huérfano sin avisar). */
function deleteCategory(slug) {
  var list = loadCategories();
  var idx = list.findIndex(function (c) { return c.slug === slug; });
  if (idx === -1) throw new Error('No se encontró esa categoría');

  list.splice(idx, 1);
  saveCategories(list);
  removeHomepageRail(slug);

  var dir = path.join(CATEGORIA_DIR, slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  return { slug: slug };
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function formatDateEn(iso) {
  var parts = iso.split('-');
  var y = parts[0], m = parts[1], d = parts[2];
  return MONTHS_EN[parseInt(m, 10) - 1] + ' ' + String(parseInt(d, 10)) + ', ' + y;
}


// Marcadores estructurales del "shell" compartido (sidebar/footer/bloque
// de consentimiento) -- los mismos tres bloques que ya se parcheaban en
// portada/categoría/artículo, ahora factorizados para poder reusarlos
// también en las páginas institucionales y de juegos (ver
// syncSharedShellPages() más abajo, corrección 2026-09-13: antes ningún
// flujo de Node tocaba esas páginas, así que quedaban con Latest/nav
// atrasados en cuanto se guardaba algo desde el panel sin correr
// generate_pages.py a mano).
var SIDEBAR_START_MARKER = '<div class="mobile-topbar">';
var SIDEBAR_END_MARKER = '</aside>';
var FOOTER_START_MARKER = '    <footer class="site-footer">';
var FOOTER_END_MARKER = '</footer>';
var CONSENT_MARKER_START = '<!-- CONSENT_ADS_BLOCK:START -->';
var CONSENT_MARKER_END = '<!-- CONSENT_ADS_BLOCK:END -->';

function extractBlock(html, startMarker, endMarker) {
  var start = html.indexOf(startMarker);
  if (start === -1) return null;
  var endTagIdx = html.indexOf(endMarker, start);
  if (endTagIdx === -1) return null;
  return html.slice(start, endTagIdx + endMarker.length);
}

function replaceBlock(html, startMarker, endMarker, replacement) {
  var start = html.indexOf(startMarker);
  if (start === -1) throw new Error('Marcador de inicio no encontrado: ' + startMarker);
  var endTagIdx = html.indexOf(endMarker, start);
  if (endTagIdx === -1) throw new Error('Marcador de fin no encontrado: ' + endMarker);
  var end = endTagIdx + endMarker.length;
  return html.slice(0, start) + replacement + html.slice(end);
}

// Extrae el sidebar/footer CRUDOS (sin localizar) de la portada ya
// regenerada -- fuente única para todas las páginas del sitio, igual que
// sidebar_raw/footer_raw en admin/generate_pages.py (Python).
function loadSidebarFooterRaw() {
  var indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var sidebarRaw = extractBlock(indexHtml, SIDEBAR_START_MARKER, SIDEBAR_END_MARKER);
  var footerRaw = extractBlock(indexHtml, FOOTER_START_MARKER, FOOTER_END_MARKER);
  if (!sidebarRaw || !footerRaw) throw new Error('No se pudo extraer sidebar/footer de index.html');
  return { sidebarRaw: sidebarRaw, footerRaw: footerRaw };
}

function loadSidebarFooter() {
  var raw = loadSidebarFooterRaw();
  return { sidebar: localize(raw.sidebarRaw, 2), footer: localize(raw.footerRaw, 2) };
}

// Corrección 2026-09-13 (vista previa con estilos/imágenes rotas): mismo
// sidebar/footer de siempre, pero con sus links de navegación e imágenes
// reescritos como URLs absolutas hacia /site/ (reusando localize(), ya
// probado, con un prefijo explícito) en vez del "../../" relativo que
// solo funciona cuando la página vive de verdad dos niveles bajo la raíz
// del sitio -- que no es el caso de /api/preview/:category/:slug.
function loadSidebarFooterPreview() {
  var raw = loadSidebarFooterRaw();
  return { sidebar: localize(raw.sidebarRaw, null, '/site/'), footer: localize(raw.footerRaw, null, '/site/') };
}

var STATIC_PAGE_SLUGS = ['about-vexlowhq', 'editorial-policy', 'contact', 'advertise', 'privacy', 'terms', 'cookies'];
// privacy/cookies nunca llevan AdSense (mismo criterio que Python:
// consent_block_for(slug not in ("privacy", "cookies"))).
var STATIC_PAGES_NO_ADS = { privacy: true, cookies: true };
var PLAY_PAGE_FILES = ['index.html', 'trivia.html', 'dash.html', 'snake.html', 'orbit.html', 'gravity.html', 'pulse.html', 'wordsearch.html'];

// depth: cuántos niveles de carpeta hay entre la página que recibe este
// bloque y la raíz del sitio -- 2 para categoria/<cat>/*.html (artículos
// y categorías), 1 para play/*.html, 0 (no hace falta llamar a esta
// función) para las páginas estáticas en la raíz. Antes el prefijo
// "../../" estaba fijo porque esta función solo se usaba para artículos y
// categorías; ahora que también localiza páginas de juegos hace falta
// parametrizarlo (mismo cambio, mismo motivo, que depth en localize() de
// admin/generate_pages.py).
// prefixOverride (opcional): corrección 2026-09-13 (vista previa con
// estilos/imágenes rotas). Sin este parámetro (todo uso existente, real,
// de esta función) el comportamiento es IDÉNTICO al de antes -- el
// prefijo sigue calculándose de "depth" exactamente igual. Se agrega
// solo para poder reusar esta MISMA función, ya probada, en
// loadSidebarFooterPreview() de más abajo, en vez de escribir una
// segunda implementación paralela (o un reemplazo global frágil sobre
// todo el HTML) para producir el mismo sidebar/footer pero con URLs
// absolutas hacia /site/ en vez de "../../".
function localize(html, depth, prefixOverride) {
  var prefix = prefixOverride != null ? prefixOverride : '../'.repeat(depth == null ? 2 : depth);
  html = html.split('href="index.html"').join('href="' + prefix + 'index.html"');
  html = html.split('href="play/index.html"').join('href="' + prefix + 'play/index.html"');
  html = html.split('src="img/').join('src="' + prefix + 'img/');
  html = html.split("url('img/").join("url('" + prefix + "img/");
  loadCategories().forEach(function (cat) {
    // OJO: no alcanza con matchear solo ".../index.html" -- el bloque
    // compartido (sidebar) ahora también trae, en "Latest Posts", links
    // directos a ARTÍCULOS dentro de cada categoría (no solo al índice
    // de la categoría). Hay que reescribir cualquier href que empiece
    // con "categoria/<slug>/", sea el índice o un artículo puntual, o
    // esos links quedan rotos (404) en toda página que no esté en la
    // raíz del sitio. (Mismo fix aplicado en admin/generate_pages.py.)
    var re = new RegExp('href="categoria/' + cat.slug + '/([^"]*)"', 'g');
    html = html.replace(re, 'href="' + prefix + 'categoria/' + cat.slug + '/$1"');
  });
  STATIC_PAGE_SLUGS.forEach(function (slug) {
    html = html.split('href="' + slug + '.html"')
      .join('href="' + prefix + slug + '.html"');
  });
  return html;
}

// Parchea el bloque de Consent Mode/AdSense/Analytics de una página
// institucional o de juego, insertando los marcadores CONSENT_ADS_BLOCK
// la primera vez que hace falta (estas páginas se generaron originalmente
// desde admin/generate_pages.py sin los marcadores -- portada sí los
// tiene desde la auditoría 2026-09-09) para que de ahora en más queden
// parcheables por contenido igual que portada, en vez de necesitar un
// mecanismo aparte.
function patchConsentAdsBlock(html, loadAds) {
  var canonical = CONSENT_MARKER_START + '\n' + consentBlockFor(loadAds) + CONSENT_MARKER_END + '\n';
  var markerStart = html.indexOf(CONSENT_MARKER_START);
  if (markerStart !== -1 && html.indexOf(CONSENT_MARKER_END, markerStart) !== -1) {
    // Ya tiene los marcadores de una corrida anterior -- a diferencia del
    // replaceBlock() genérico (usado para sidebar/footer, donde el salto
    // de línea que sigue al marcador de cierre nunca formó parte del
    // bloque reemplazado), acá "canonical" SÍ trae su propio '\n' final
    // -- si no se descarta el '\n' que ya estaba después del marcador
    // viejo, cada corrida agrega una línea en blanco más (no idempotente).
    var markerEnd = html.indexOf(CONSENT_MARKER_END, markerStart) + CONSENT_MARKER_END.length;
    if (html[markerEnd] === '\n') markerEnd += 1;
    return html.slice(0, markerStart) + canonical + html.slice(markerEnd);
  }
  var idx = html.indexOf(CONSENT_BASE_BLOCK);
  if (idx === -1) {
    throw new Error('No se encontró el bloque de consentimiento base para insertar los marcadores CONSENT_ADS_BLOCK');
  }
  var afterBase = idx + CONSENT_BASE_BLOCK.length;
  var hasAdsRightAfter = html.slice(afterBase, afterBase + ADSENSE_SCRIPT_TAG.length) === ADSENSE_SCRIPT_TAG;
  var blockEnd = hasAdsRightAfter ? afterBase + ADSENSE_SCRIPT_TAG.length : afterBase;
  return html.slice(0, idx) + canonical + html.slice(blockEnd);
}

// Sincroniza el sidebar/footer/consent block de UNA página institucional o
// de juego con el estado actual de portada -- sin tocar absolutamente
// nada más del archivo (título, meta, cuerpo, canvas del juego, <script
// src> con su cache-bust, etc.). Devuelve si de verdad cambió algo, para
// no reescribir bytes idénticos innecesariamente.
function syncSharedShellPage(filePath, depth, loadAds, sidebarRaw, footerRaw) {
  if (!fs.existsSync(filePath)) return { path: filePath, changed: false, skipped: true };
  var html = fs.readFileSync(filePath, 'utf8');
  var original = html;
  html = replaceBlock(html, SIDEBAR_START_MARKER, SIDEBAR_END_MARKER, localize(sidebarRaw, depth));
  html = replaceBlock(html, FOOTER_START_MARKER, FOOTER_END_MARKER, localize(footerRaw, depth));
  html = patchConsentAdsBlock(html, loadAds);
  // Corrección 2026-09-27 (paridad Node/Python, prosa de about-vexlowhq.html
  // y advertise.html): no-op en cualquier página sin estos marcadores (todas
  // las de juegos, y las institucionales que no enumeran categorías en su
  // texto) -- ver syncCategoryListSentences() más arriba.
  html = syncCategoryListSentences(html);
  if (html !== original) {
    fs.writeFileSync(filePath, html, 'utf8');
    return { path: filePath, changed: true };
  }
  return { path: filePath, changed: false };
}

// Cierra la brecha de paridad Node/Python (auditoría 2026-09-13): antes
// SOLO una corrida manual de generate_pages.py (Python) actualizaba las 7
// páginas institucionales y las 8 de Games -- el flujo normal del panel
// (Node) nunca las tocaba, así que quedaban con el sidebar "Latest Posts"
// y el nav de categorías atrasados en cuanto se publicaba/editaba/borraba
// algo sin correr Python a mano. En vez de portar a JS los templates
// completos de Python (que además tienen el cuerpo de cada página
// institucional y el HTML/canvas propio de cada juego escritos adentro,
// duplicando ese contenido en dos lenguajes), esta función solo
// actualiza in-place los TRES bloques compartidos (sidebar, footer,
// consent/ads) de los archivos .html ya existentes -- el resto de cada
// página (copy institucional, lógica/canvas/JS propio de cada juego)
// nunca se toca. Se llama desde regenerateAllArticlePages(), así que
// corre en los mismos momentos que ya dispara esa función (alta, edición,
// borrado, restauración, cambio de categoría/slug, cambio de estado
// editorial/noindex, redirect, regeneración completa).
function syncSharedShellPages() {
  var raw = loadSidebarFooterRaw();
  var results = [];
  STATIC_PAGE_SLUGS.forEach(function (slug) {
    var loadAds = !STATIC_PAGES_NO_ADS[slug];
    results.push(syncSharedShellPage(path.join(ROOT, slug + '.html'), 0, loadAds, raw.sidebarRaw, raw.footerRaw));
  });
  PLAY_PAGE_FILES.forEach(function (filename) {
    results.push(syncSharedShellPage(path.join(ROOT, 'play', filename), 1, true, raw.sidebarRaw, raw.footerRaw));
  });
  return results;
}

/* ---- parseo del cuerpo en texto simple -> bloques ---- */
function parseBody(text) {
  var blocks = [];
  var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  var paragraphBuf = [];
  function flushParagraph() {
    if (paragraphBuf.length) {
      blocks.push({ type: 'p', text: paragraphBuf.join(' ').trim() });
      paragraphBuf = [];
    }
  }
  var i = 0;
  while (i < lines.length) {
    var line = lines[i].trim();
    if (line === '') { flushParagraph(); i++; continue; }
    if (/^##\s+/.test(line)) { flushParagraph(); blocks.push({ type: 'h2', text: line.replace(/^##\s+/, '') }); i++; continue; }
    if (/^\[publicidad\]$/i.test(line)) { flushParagraph(); blocks.push({ type: 'ad' }); i++; continue; }
    var imgMatch = /^!\[(.*?)\]\((\S+)\)$/.exec(line);
    if (imgMatch) { flushParagraph(); blocks.push({ type: 'img', alt: imgMatch[1], src: imgMatch[2] }); i++; continue; }
    if (/^-\s+/.test(line)) {
      flushParagraph();
      var items = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^-\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items: items });
      continue;
    }
    paragraphBuf.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

/* "**texto**" -> <strong>texto</strong>, dentro de párrafos, subtítulos,
   ítems de lista y pies de foto (nunca dentro del atributo alt). */
function applyInline(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// assetPrefix (opcional, default '../../', igual que bannerHtmlFor arriba
// -- omitirlo deja el comportamiento idéntico al de siempre): corrección
// 2026-09-13, las imágenes insertadas DENTRO del cuerpo del artículo
// (no el banner, un <img> aparte que el editor pega en el texto) también
// usaban el mismo '../../' fijo y quedaban rotas en la vista previa.
function renderBodyHtml(bodyText, assetPrefix) {
  if (assetPrefix == null) assetPrefix = '../../';
  var blocks = parseBody(bodyText);
  var html = '';
  blocks.forEach(function (b) {
    if (b.type === 'p') html += '      <p>' + applyInline(b.text) + '</p>\n';
    else if (b.type === 'h2') html += '      <h2>' + applyInline(b.text) + '</h2>\n';
    else if (b.type === 'ul') {
      html += '      <ul>\n';
      b.items.forEach(function (it) { html += '        <li>' + applyInline(it) + '</li>\n'; });
      html += '      </ul>\n';
    } else if (b.type === 'img') {
      var altEsc = (b.alt || '').replace(/"/g, '&quot;');
      html += '      <figure class="article-inline-image"><img src="' + assetPrefix + b.src + '" alt="' + altEsc + '" loading="lazy">';
      if (b.alt) html += '<figcaption>' + applyInline(b.alt) + '</figcaption>';
      html += '</figure>\n';
    }
  });
  return html;
}

function countLabelFor(n) {
  return n + ' article' + (n === 1 ? '' : 's');
}

// Mismo criterio que trending_articles() en admin/generate_pages.py:
// artículos marcados a mano desde el panel; si todavía no se marcó
// ninguno, los más recientes de todas las categorías. Los artículos con
// "editorialStatus" (ej.: contenido comercial pendiente de prueba
// propia) quedan afuera de este cálculo -- siguen navegables en su
// propia página y en la grilla normal de su categoría, pero no deben
// aparecer como destacados/trending.
function trendingArticles(allArticles) {
  var eligible = allArticles.filter(function (a) { return !a.editorialStatus; });
  var marked = eligible.filter(function (a) { return a.trending; });
  marked.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  if (marked.length) return marked;
  return eligible.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
}

// Tarjeta (.card), mismo markup que buildCard() en js/script.js -- pero
// volcada al HTML crudo en la generación, no solo agregada por JS. Se
// usa en grillas de categoría y en los rieles de la portada.
function buildFeedCardHtml(art, assetPrefix, href, showCategory) {
  var catSlug = art.category || '';
  var titleEsc = escapeHtml(art.title || '');
  var media = art.image
    ? '<span class="media ' + catSlug + '" style="background-image:url(\'' + assetPrefix + art.image + '\');background-size:cover;background-position:center;"></span>'
    : '<span class="media ' + catSlug + '">' + (art.icon || '') + '</span>';
  var metaBits = [];
  if (showCategory) metaBits.push(escapeHtml(art.categoryLabel || ''));
  if (art.readTime) metaBits.push(escapeHtml(art.readTime));
  metaBits.push(formatDateEn(art.date || ''));
  return '          <a class="card" href="' + href + '">' + media + '\n' +
    '            <div class="body"><h3>' + titleEsc + '</h3><div class="meta">' + metaBits.join(' · ') + '</div></div>\n' +
    '          </a>\n';
}

function buildCardsGridHtml(list, assetPrefix, hrefFor, showCategory) {
  return list.map(function (a) { return buildFeedCardHtml(a, assetPrefix, hrefFor(a), showCategory); }).join('');
}

function buildLatestItemHtml(art, href) {
  var titleEsc = escapeHtml(art.title || '');
  var meta = escapeHtml(art.categoryLabel || '') + ' · ' + formatDateEn(art.date || '') + ' · ' + escapeHtml(art.readTime || '');
  return '<a class="latest-item" href="' + href + '"><span class="ic">' + (art.icon || '') + '</span>' +
    '<div class="txt"><span class="ttl">' + titleEsc + '</span><div class="meta">' + meta + '</div></div></a>\n';
}

function ogMetaBlock(url, title, description, imageUrl, pageType) {
  var escTitle = escapeHtml(title || '');
  var escDesc = escapeHtml(description || '');
  var lines = [
    '<link rel="canonical" href="' + url + '">',
    '<meta property="og:type" content="' + (pageType || 'website') + '">',
    '<meta property="og:site_name" content="' + SITE_NAME + '">',
    '<meta property="og:title" content="' + escTitle + '">',
    '<meta property="og:description" content="' + escDesc + '">',
    '<meta property="og:url" content="' + url + '">'
  ];
  if (imageUrl) lines.push('<meta property="og:image" content="' + imageUrl + '">');
  lines.push('<meta name="twitter:card" content="' + (imageUrl ? 'summary_large_image' : 'summary') + '">');
  lines.push('<meta name="twitter:title" content="' + escTitle + '">');
  lines.push('<meta name="twitter:description" content="' + escDesc + '">');
  if (imageUrl) lines.push('<meta name="twitter:image" content="' + imageUrl + '">');
  return lines.join('\n');
}

function jsonLdScript(data) {
  return '<script type="application/ld+json">' + JSON.stringify(data) + '</script>';
}

function breadcrumbJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(function (it, i) {
      return { '@type': 'ListItem', position: i + 1, name: it[0], item: it[1] };
    })
  };
}

function articleJsonLd(art, cat, url, imageUrl) {
  var data = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: art.title,
    description: art.dek || '',
    datePublished: art.date,
    dateModified: art.dateModified || art.date,
    author: { '@type': 'Person', name: DEFAULT_AUTHOR, url: SITE_URL + '/about-vexlowhq.html' },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: SITE_URL + '/' + LOGO_PATH }
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: cat.label
  };
  if (imageUrl) data.image = [imageUrl];
  return data;
}

// Reemplaza el contenido de un <div id="divId">...</div> respetando el
// anidamiento (por si adentro hay otros <div>, como .body en cada
// tarjeta) -- mismo criterio que replace_div_content_by_id() en
// admin/generate_pages.py. Se usa para volcar tarjetas reales en los
// contenedores de la home que antes quedaban vacíos hasta que corría
// js/script.js.
// Puerto de replace_between() en admin/generate_pages.py -- reemplaza todo
// el texto entre dos marcadores literales (p. ej. comentarios HTML) por
// newInner, dejando los marcadores intactos. Usado para mantener
// sincronizado el bloque CONSENT_ADS_BLOCK del <head> de index.html (ver
// generateHomeSections más abajo).
function replaceBetween(html, startMarker, endMarker, newInner) {
  var start = html.indexOf(startMarker);
  if (start === -1) throw new Error('No se encontró el marcador de inicio: ' + startMarker);
  start += startMarker.length;
  var end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error('No se encontró el marcador de fin: ' + endMarker);
  return html.slice(0, start) + '\n' + newInner + html.slice(end);
}

function replaceDivContentById(html, divId, newInner) {
  var openRe = new RegExp('<div[^>]*\\bid="' + divId + '"[^>]*>');
  var m = openRe.exec(html);
  if (!m) throw new Error('No se encontró el contenedor #' + divId);
  var pos = m.index + m[0].length;
  var depth = 1;
  var end = -1;
  while (depth > 0) {
    var nextOpen = html.indexOf('<div', pos);
    var nextClose = html.indexOf('</div>', pos);
    if (nextClose === -1) throw new Error('Contenedor #' + divId + ' sin cierre');
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      pos = nextClose + 6;
      if (depth === 0) end = nextClose;
    }
  }
  return html.slice(0, m.index + m[0].length) + newInner + html.slice(end);
}

var ARTICLE_PAGE_TEMPLATE = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>{title} — VexlowHQ</title>\n' +
'<meta name="description" content="{dek}">\n' +
'{robotsMeta}<link rel="stylesheet" href="{cssHref}">\n' +
'<link rel="icon" type="image/x-icon" href="{faviconIcoHref}">\n' +
'<link rel="icon" type="image/png" sizes="32x32" href="{favicon32Href}">\n' +
'<link rel="icon" type="image/png" sizes="16x16" href="{favicon16Href}">\n' +
'<link rel="apple-touch-icon" sizes="180x180" href="{appleTouchIconHref}">\n' +
'{seoHead}\n' +
'{consentAdsBlock}' +
'</head>\n' +
'<body data-category="{catSlug}"{subtopicAttr}>\n' +
'\n' +
'{sidebar}\n' +
'\n' +
'  <main>\n' +
'\n' +
'    <nav class="breadcrumb">\n' +
'      <a href="{homeHref}">Home</a><span class="sep">/</span><a href="{catIndexHref}">{catLabel}</a>{topicCrumb}<span class="sep">/</span><span class="current">{titleShort}</span>\n' +
'    </nav>\n' +
'\n' +
'    <article class="article-page">\n' +
'      <span class="chip">{catIcon} {catLabel}</span>\n' +
'      <h1>{title}</h1>\n' +
'      <p class="dek">{dek}</p>\n' +
'      <div class="article-meta">\n' +
'        <span>Leonardo Beltran</span><span class="dot">·</span><span>{dateLabel}</span>{updatedHtml}<span class="dot">·</span><span>{readTime}</span>\n' +
'      </div>\n' +
'{correctionHtml}\n' +
'{bannerHtml}\n' +
'      <div class="article-body">\n' +
'{bodyHtml}      </div>\n' +
'{sourceHtml}\n' +
'      <div class="article-reactions" data-article-slug="{slug}">\n' +
'        <span>React</span>\n' +
'        <button type="button" class="reaction-btn" data-reaction="like" aria-label="Like this article">👍 <span class="reaction-count" data-count="like">0</span></button>\n' +
'        <button type="button" class="reaction-btn" data-reaction="fire" aria-label="Fire reaction">🔥 <span class="reaction-count" data-count="fire">0</span></button>\n' +
'        <button type="button" class="reaction-btn" data-reaction="dislike" aria-label="Dislike this article">👎 <span class="reaction-count" data-count="dislike">0</span></button>\n' +
'      </div>\n' +
'\n' +
'      <div class="article-share">\n' +
'        <span>Share</span>\n' +
'        <a href="#" data-share="x" aria-label="Share on X">X</a>\n' +
'        <a href="#" data-share="whatsapp" aria-label="Share on WhatsApp">W</a>\n' +
'        <a href="#" data-share="facebook" aria-label="Share on Facebook">F</a>\n' +
'        <a href="#" data-share="copy" aria-label="Copy link">🔗</a>\n' +
'      </div>\n' +
'\n' +
'      <div class="article-continue">\n' +
'        <p>Want more news about <strong>{topicLabel}</strong>?</p>\n' +
'        <a class="see-all" href="{topicHref}">See full coverage →</a>\n' +
'      </div>\n' +
'\n' +
'{relatedBlock}\n' +
'    </article>\n' +
'\n' +
'{footer}\n' +
'\n' +
'  </main>\n' +
'</div>\n' +
'\n' +
'<script src="{articulosJsHref}"></script>\n' +
'<script src="{scriptJsHref}"></script>\n' +
'</body>\n' +
'</html>\n';

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m;
  });
}

function articleFilePath(article) {
  var cat = categoryBySlug(article.category);
  if (!cat) return null;
  return path.join(CATEGORIA_DIR, cat.slug, article.slug + '.html');
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function youtubeEmbedUrl(url) {
  if (!url) return null;
  var m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? 'https://www.youtube.com/embed/' + m[1] : null;
}

/* Primero prueba si es un link de YouTube (arma la URL de embed canónica).
   Si no, y el link ya es una URL http(s) válida, se usa directo como src
   del iframe — así funcionan links de embed de Vimeo, JWPlayer, etc. */
function videoEmbedUrl(url) {
  if (!url) return null;
  var yt = youtubeEmbedUrl(url);
  if (yt) return yt;
  var trimmed = String(url).trim();
  return /^https?:\/\//.test(trimmed) ? trimmed : null;
}

// Crédito visible bajo la imagen destacada -- mismo criterio que
// admin/generate_pages.py: solo si el artículo trae 'imageCredit'
// cargado, nunca inventado.
function imageCreditHtmlFor(article) {
  if (!article.imageCredit) return '';
  return '      <p class="image-credit" style="font-size:12px;color:var(--text-muted,#777);margin:4px 0 0;">' + escapeHtml(article.imageCredit) + '</p>\n';
}

/* El banner de la nota: video > imagen destacada > ícono de la
   categoría sobre fondo de color, en ese orden de prioridad.
   assetPrefix (opcional, default '../../' -- el mismo prefijo relativo de
   siempre, así que omitirlo deja el comportamiento IDÉNTICO al de antes
   para cualquier llamada existente): corrección 2026-09-13, vista previa
   con imágenes rotas -- en preview este banner se sirve absoluto hacia
   /site/, ver buildArticleHtml(). */
function bannerHtmlFor(article, cat, assetPrefix) {
  if (assetPrefix == null) assetPrefix = '../../';
  var embedUrl = videoEmbedUrl(article.videoUrl);
  if (embedUrl) {
    return '      <div class="article-banner video-wrap">\n' +
      '        <iframe src="' + embedUrl + '" title="' + article.title.replace(/"/g, '&quot;') + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>\n' +
      '      </div>\n';
  }
  if (article.image) {
    // Fondo CSS por decisión de diseño, pero es una imagen informativa --
    // necesita equivalente accesible para lectores de pantalla (sin
    // campo "alt" propio todavía, se usa el título como descripción).
    var altText = (article.imageAlt || article.title).replace(/"/g, '&quot;');
    return '      <div class="article-banner media ' + cat.slug + '" role="img" aria-label="' + altText + '" style="background-image:url(\'' + assetPrefix + article.image + '\');background-size:cover;background-position:center;"></div>\n' + imageCreditHtmlFor(article);
  }
  return '      <div class="article-banner media ' + cat.slug + '">' + cat.icon + '</div>\n';
}

function domainLabel(url) {
  try {
    var host = new URL(url).hostname;
    return host.indexOf('www.') === 0 ? host.slice(4) : host;
  } catch (e) {
    return url;
  }
}

// Sourcing visible en el cuerpo del artículo -- mismo criterio que
// admin/generate_pages.py: fuente primaria (sourceUrl/sourceTitle) más,
// si existen, fuentes de corroboración independiente (additionalSources).
// "Accessed [date]" (pedido de Leonardo, 2026-09-24, punto 6): se muestra
// SOLO cuando el artículo ya trae ese dato guardado (sourceRetrievedAt para
// la fuente principal, retrievedAt por cada fuente adicional) -- nunca se
// inventa ni se completa con la fecha de publicación del artículo. Los
// artículos viejos, sin este campo, simplemente no muestran esta parte,
// exactamente igual que antes de este cambio -- no se migra nada.
function accessedSuffix(retrievedAt) {
  if (!retrievedAt) return '';
  var datePart = String(retrievedAt).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return '';
  try { return ' (accessed ' + formatDateEn(datePart) + ')'; } catch (e) { return ''; }
}

function sourceHtmlFor(article) {
  var links = [];
  if (article.sourceUrl) {
    links.push([article.sourceUrl, article.sourceTitle || domainLabel(article.sourceUrl), accessedSuffix(article.sourceRetrievedAt)]);
  }
  (article.additionalSources || []).forEach(function (extra) {
    if (extra && extra.url) links.push([extra.url, extra.label || domainLabel(extra.url), accessedSuffix(extra.retrievedAt)]);
  });
  if (!links.length) return '';
  var linksHtml = links.map(function (pair) {
    return '<a href="' + pair[0] + '" rel="nofollow noopener" target="_blank">' + escapeHtml(pair[1]) + '</a>' + escapeHtml(pair[2]);
  }).join(', ');
  var labelTxt = links.length > 1 ? 'Sources' : 'Source';
  return '      <p class="article-source" style="font-size:13px;color:var(--text-muted,#666);margin:10px 0 0;">' + labelTxt + ': ' + linksHtml + '</p>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c];
  });
}

// Mismo criterio que related_articles_for() en admin/generate_pages.py
// -- las dos implementaciones tienen que coincidir, porque cuál de las
// dos generó la página de una nota depende de si se guardó desde el
// panel (pagegen.js, esto de acá) o se regeneró en bloque (Python).
function relatedArticlesFor(article, allArticles, limit) {
  limit = limit || 4;
  var slug = article.slug;
  var topic = article.topic || '';
  var category = article.category;

  var sameTopic = allArticles.filter(function (a) { return a.slug !== slug && topic && a.topic === topic; });
  sameTopic.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  var picked = sameTopic.slice(0, limit);

  if (picked.length < limit) {
    var pickedSlugs = {};
    picked.forEach(function (a) { pickedSlugs[a.slug] = true; });
    var sameCat = allArticles.filter(function (a) {
      return a.slug !== slug && !pickedSlugs[a.slug] && a.category === category;
    });
    sameCat.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    picked = picked.concat(sameCat.slice(0, limit - picked.length));
  }

  return picked;
}

// absolutePrefix (opcional): corrección 2026-09-13 (vista previa con
// estilos/imágenes rotas). Sin este parámetro (el uso de siempre, para
// generar la página pública real) el comportamiento es IDÉNTICO al de
// antes -- href relativo (mismo directorio si es la misma categoría, o
// "../<cat>/" si es otra) e imagen con el "../../" fijo de siempre. Solo
// cuando se pasa un string (ej. '/site/', desde buildArticleHtml en modo
// preview) los links y las imágenes del riel "You might also like" se
// arman como URLs absolutas hacia donde admin/server.js sirve el sitio
// real -- necesario porque en preview la página no vive de verdad en
// categoria/<cat>/<slug>.html, así que ningún "../" relativo resuelve bien.
function renderRelatedBlock(related, currentCatSlug, absolutePrefix) {
  if (!related.length) return '';
  var cards = related.map(function (r) {
    var rCat = r.category || '';
    var href = absolutePrefix != null
      ? absolutePrefix + 'categoria/' + rCat + '/' + r.slug + '.html'
      : (rCat === currentCatSlug ? r.slug + '.html' : '../' + rCat + '/' + r.slug + '.html');
    var imgPrefix = absolutePrefix != null ? absolutePrefix : '../../';
    var media = r.image
      ? '<span class="media ' + rCat + '" style="background-image:url(\'' + imgPrefix + r.image + '\');background-size:cover;background-position:center;"></span>'
      : '<span class="media ' + rCat + '">' + (r.icon || '') + '</span>';
    var meta = escapeHtml(r.categoryLabel || '') + ' · ' + escapeHtml(r.readTime || '') + ' · ' + formatDateEn(r.date || '');
    return '          <a class="card" href="' + href + '">' + media + '\n' +
      '            <div class="body"><h3>' + escapeHtml(r.title || '') + '</h3><div class="meta">' + meta + '</div></div>\n' +
      '          </a>\n';
  });
  return (
    '      <div class="related-articles">\n' +
    '        <h2>📌 You might also like</h2>\n' +
    '        <div class="rail-grid">\n' +
    cards.join('') +
    '        </div>\n' +
    '      </div>\n'
  );
}

// Corrección 2026-09-13 (bug "Ver" -> 404 en artículos sin publicar):
// buildArticleHtml() es la parte PURA de generateArticleFile() -- arma el
// HTML completo en memoria y lo devuelve como string, sin tocar el disco
// para nada. generateArticleFile() (más abajo) sigue siendo la única
// función que efectivamente escribe la página pública real; esta función
// nueva existe para que el endpoint de vista previa (GET /api/preview/...
// en admin/server.js) pueda generar el HTML de un artículo draft/review/
// approved usando exactamente el mismo armado visual que la página
// pública, SIN escribir ningún archivo y sin pasar por sitemap/portada/
// categorías/articulos.js -- eso lo sigue haciendo únicamente
// regenerateAllArticlePages() para artículos que ya son públicos.
//
// opts.preview (default false):
//   - Fuerza "noindex,nofollow" en <meta name="robots"> sin importar el
//     valor real de article.noindex, porque una vista previa NUNCA debe
//     poder terminar indexada por accidente.
//   - Fuerza el bloque de anuncios/consentimiento a "sin ads"
//     (consentBlockFor(false)) sin importar article.noindex -- una nota
//     todavía no aprobada no puede monetizar impresiones.
//   - Agrega un aviso visible "VISTA PREVIA — no publicado" arriba del
//     cuerpo, para que quien la mire nunca la confunda con la página
//     pública real (que en muchos casos ni siquiera existe todavía).
function buildArticleHtml(article, opts) {
  opts = opts || {};
  var preview = !!opts.preview;
  var cat = categoryBySlug(article.category);
  if (!cat) throw new Error('Categoría desconocida: ' + article.category);
  var blocks = preview ? loadSidebarFooterPreview() : loadSidebarFooter();

  // Corrección 2026-09-13 (vista previa cargaba sin estilos e imágenes
  // rotas): la página pública real de un artículo vive dos niveles bajo
  // la raíz del sitio (categoria/<cat>/<slug>.html), así que TODOS sus
  // recursos (CSS, favicons, JS, imágenes, links de navegación) son
  // relativos con el prefijo fijo "../../" de siempre -- eso no cambia
  // acá para la página real. La vista previa, en cambio, se sirve en
  // /api/preview/<cat>/<slug> -- una ruta de API, no un archivo ubicado
  // ahí en el disco -- así que esos mismos "../../" relativos resuelven
  // mal (el navegador los resuelve contra la URL de la petición, no
  // contra dónde "debería" estar el archivo). assetPrefix es la ÚNICA
  // base de recursos explícita para todo lo que sigue: en preview, URLs
  // absolutas hacia /site/, que es donde admin/server.js ya sirve el
  // sitio real completo de forma estática; fuera de preview, exactamente
  // el mismo "../../" de siempre (ARTICLE_PAGE_TEMPLATE nunca lo tuvo
  // hardcodeado dos veces -- ahora es un solo valor, calculado acá,
  // inyectado por fill() más abajo).
  var assetPrefix = preview ? '/site/' : '../../';

  // Las páginas de tema/subtema se retiraron junto con la navegación por
  // temas -- el breadcrumb y "Want more news about..." de cada artículo
  // apuntan directo a su categoría. catIndexHref usa un criterio DISTINTO
  // de assetPrefix: en la página real es un link al MISMO directorio
  // (categoria/<cat>/index.html, alcanzable con solo "index.html" porque
  // el artículo ya vive en esa carpeta), mientras que assetPrefix asume
  // "dos niveles arriba de la raíz" -- por eso no se puede reusar
  // assetPrefix acá tal cual, hace falta la ruta completa a la categoría.
  var catIndexHref = preview ? (assetPrefix + 'categoria/' + cat.slug + '/index.html') : 'index.html';
  var homeHref = assetPrefix + 'index.html';
  var topicCrumb = '';
  var topicHref = catIndexHref;
  var topicLabel = cat.label;

  var title = article.title;
  var titleShort = title.length <= 40 ? title : title.slice(0, 37) + '...';

  var allArticles = loadArticles();
  // Corrección 2026-09-13: el rail de "You might also like" solo puede
  // recomendar artículos que de verdad tengan una página pública generada.
  // Antes este filtro solo miraba `!a.noindex`, así que un artículo
  // draft/review/approved/redirected -- o uno que ya no existe porque se
  // borró desde el panel -- podía colarse igual si por algún motivo tenía
  // noindex:false, produciendo un <a href> a una página inexistente. Se
  // unifica con el mismo criterio "publishable" que ya se usa para
  // sitemap/portada/categorías más abajo en este archivo, y que coincide
  // con related_pool de admin/generate_pages.py (Python).
  var publishablePool = allArticles.filter(function (a) {
    return a.slug && categoryBySlug(a.category) && String(a.body || '').trim() && articleStatus.isPublicArticle(a);
  });
  var relatedPool = publishablePool.filter(function (a) { return !a.noindex; });
  var related = relatedArticlesFor(article, relatedPool);
  var relatedBlock = renderRelatedBlock(related, cat.slug, preview ? assetPrefix : null);

  var artUrl = SITE_URL + '/categoria/' + cat.slug + '/' + article.slug + '.html';
  var imageUrl = article.image ? SITE_URL + '/' + article.image : null;
  var seoHead = [
    ogMetaBlock(artUrl, title + ' — VexlowHQ', article.dek || '', imageUrl, 'article'),
    jsonLdScript(articleJsonLd(article, cat, artUrl, imageUrl)),
    jsonLdScript(breadcrumbJsonLd([
      ['Home', SITE_URL + '/'],
      [cat.label, SITE_URL + '/categoria/' + cat.slug + '/'],
      [title, artUrl]
    ]))
  ].join('\n');

  var html = fill(ARTICLE_PAGE_TEMPLATE, {
    title: title,
    titleShort: titleShort,
    slug: article.slug,
    dek: article.dek || '',
    catSlug: cat.slug,
    catLabel: cat.label,
    catIcon: cat.icon,
    dateLabel: formatDateEn(article.date),
    readTime: article.readTime || '',
    bannerHtml: bannerHtmlFor(article, cat, assetPrefix),
    bodyHtml: renderBodyHtml(article.body, assetPrefix),
    topicCrumb: topicCrumb,
    topicLabel: topicLabel,
    topicHref: topicHref,
    relatedBlock: relatedBlock,
    subtopicAttr: '',
    sidebar: blocks.sidebar,
    footer: blocks.footer,
    seoHead: seoHead,
    // Corrección 2026-09-13 (vista previa con estilos/imágenes rotas):
    // única base de recursos explícita para CSS/favicons/JS/navegación --
    // ver el comentario de assetPrefix más arriba. Fuera de preview, estos
    // seis valores son BYTE A BYTE los mismos literales que antes estaban
    // hardcodeados en ARTICLE_PAGE_TEMPLATE (sin cambio de comportamiento
    // para la página pública real -- confirmado con la prueba de paridad
    // Node/Python y validate:publish).
    cssHref: assetPrefix + 'css/style.css',
    faviconIcoHref: assetPrefix + 'favicon.ico',
    favicon32Href: assetPrefix + 'favicon-32.png',
    favicon16Href: assetPrefix + 'favicon-16.png',
    appleTouchIconHref: assetPrefix + 'apple-touch-icon.png',
    articulosJsHref: assetPrefix + 'data/articulos.js',
    scriptJsHref: assetPrefix + 'js/script.js',
    homeHref: homeHref,
    catIndexHref: catIndexHref,
    // Mismo criterio que admin/generate_pages.py: un artículo marcado
    // "noindex" desde el panel sigue generando su página (navegable,
    // follow) pero pide a los buscadores que no lo indexen todavía, y
    // se excluye de sitemap.xml en writeSitemap(). Al destildar el flag
    // en el panel vuelve a la normalidad en la próxima publicación.
    robotsMeta: preview
      ? '<meta name="robots" content="noindex,nofollow">\n'
      : (article.noindex ? '<meta name="robots" content="noindex,follow">\n' : ''),
    // Control de monetizacion (auditoria 2026-09-11): un articulo noindex
    // sigue con GA4/Consent Mode, pero nunca carga adsbygoogle.js -- no
    // debe monetizarse aunque siga siendo navegable por URL directa.
    // En vista previa (preview=true) nunca hay ads, sin importar noindex.
    consentAdsBlock: consentBlockFor(preview ? false : !article.noindex),
    // Idem: fecha de actualización y nota de corrección visibles, sin
    // tocar la fecha de publicación original (mismo criterio que Python).
    updatedHtml: article.dateModified
      ? '<span class="dot">·</span><span>Updated ' + formatDateEn(article.dateModified) + '</span>'
      : '',
    correctionHtml: (preview ? previewBannerHtml() : '') + (article.correctionNote
      ? '      <div class="correction-note" style="background:var(--surface-2,#f4f4f5);border-left:3px solid var(--accent,#666);padding:10px 14px;margin:14px 0;font-size:13px;color:var(--text-muted,#555);border-radius:4px;"><strong>Correction:</strong> ' + article.correctionNote + '</div>'
      : ''),
    sourceHtml: sourceHtmlFor(article)
  });

  return html;
}

// Aviso visible de vista previa -- estilo inline (sin depender de una
// clase CSS del sitio publico que podria no existir) para que sea
// imposible de confundir con la pagina publica real.
function previewBannerHtml() {
  return '      <div class="preview-banner" style="background:#fff3cd;border:2px solid #e0a800;color:#664d03;padding:12px 16px;margin:0 0 14px;border-radius:6px;font-weight:600;font-size:14px;">' +
    '⚠️ VISTA PREVIA — no publicado. Esta pagina no existe todavia en el sitio real y no es visible para el publico ni para buscadores.' +
    '</div>\n';
}

// Escribe en disco la pagina publica real de un articulo -- unico punto
// del sistema (junto con generateRedirectFile) que efectivamente publica
// el HTML de un articulo. El armado del HTML en si vive en
// buildArticleHtml() (arriba), que tambien usa el endpoint de vista
// previa sin escribir nada -- ver el comentario ahi.
function generateArticleFile(article) {
  var html = buildArticleHtml(article);
  var outPath = articleFilePath(article);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

// ============================================================================
// Página de categoría (el "hub" con la grilla de artículos) y las
// secciones dinámicas de la portada (Top 5 Trending, Latest Posts,
// rieles por categoría) -- puerto a Node de la parte correspondiente de
// admin/generate_pages.py, para que se mantengan al día en cada
// publicación desde el panel y no solo cuando se corre el script de
// Python a mano ("Regenerar categorías y temas").
// ============================================================================

var CATEGORY_PAGE_TEMPLATE = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>{label} — VexlowHQ</title>\n' +
'<meta name="description" content="{desc}">\n' +
'{robotsMeta}<link rel="stylesheet" href="../../css/style.css">\n' +
'<link rel="icon" type="image/x-icon" href="../../favicon.ico">\n' +
'<link rel="icon" type="image/png" sizes="32x32" href="../../favicon-32.png">\n' +
'<link rel="icon" type="image/png" sizes="16x16" href="../../favicon-16.png">\n' +
'<link rel="apple-touch-icon" sizes="180x180" href="../../apple-touch-icon.png">\n' +
'{seoHead}\n' +
CONSENT_ADS_BLOCK +
'</head>\n' +
'<body data-category="{slug}">\n' +
'\n' +
'{sidebar}\n' +
'\n' +
'  <main>\n' +
'\n' +
'    <nav class="breadcrumb">\n' +
'      <a href="../../index.html">Home</a><span class="sep">/</span><span class="current">{label}</span>\n' +
'    </nav>\n' +
'\n' +
'    <div class="category-header">\n' +
'      <span class="ic-badge">{icon}</span>\n' +
'      <div>\n' +
'        <h1>{icon} {label}</h1>\n' +
'        <p>{desc}</p>\n' +
'        <span class="count" id="categoryCount">{countLabel}</span>\n' +
'      </div>\n' +
'    </div>\n' +
'{noteBlock}\n' +
'    <div class="home-section" id="noticias">\n' +
'      <div class="section-head"><h2>{feedHeading}</h2></div>\n' +
'      <div class="rail-grid" id="categoryGrid">{grid}</div>\n' +
'    </div>\n' +
'{footer}\n' +
'\n' +
'  </main>\n' +
'</div>\n' +
'\n' +
'<script src="../../data/articulos.js"></script>\n' +
'<script src="../../js/script.js"></script>\n' +
'</body>\n' +
'</html>\n';

/* Regenera categoria/{slug}/index.html con la grilla de artículos ya
   volcada en el HTML (no vacía a la espera de JS). Se llama después de
   guardar/borrar cualquier artículo (server.js), y después de
   renombrar/crear una categoría. */
function generateCategoryPage(slug, allArticlesOpt) {
  var cat = categoryBySlug(slug);
  if (!cat) throw new Error('Categoría desconocida: ' + slug);
  var blocks = loadSidebarFooter();
  var allArticles = allArticlesOpt || loadArticles();
  // Solo status='published' (ver article-status.js: isPublicArticle,
  // que resuelve además la compatibilidad con draftIncomplete y con los
  // 169 artículos reales de antes de este esquema) entra en "publishable"
  // en TODOS los listados derivados (grilla de categoría, portada,
  // sitemap) -- mismo criterio en las 3 apariciones de este filtro acá
  // abajo y en generate_pages.py (Python). 'redirected' nunca es
  // publishable: genera su propia página vía generateRedirectFile, pero
  // no es contenido y no debe listarse en ningún lado.
  var publishable = allArticles.filter(function (a) {
    return a.slug && categoryBySlug(a.category) && String(a.body || '').trim() && articleStatus.isPublicArticle(a);
  });
  // Los "noindex" siguen generando su propia página (navegable, con meta
  // robots noindex,follow) pero no deben quedar enlazados desde ninguna
  // grilla indexada -- ni la de su propia categoría, ni trending. Antes
  // solo se los sacaba del sitemap (ver writeSitemap) y seguían
  // apareciendo acá, contradiciendo el propio noindex (fix 2026-09:
  // auditoría global, punto 5 de validación de redirects). Mismo criterio
  // que generate_pages.py.
  var listable = publishable.filter(function (a) { return !a.noindex; });

  var items = slug === 'trending'
    ? trendingArticles(listable)
    : listable.filter(function (a) { return a.category === slug; })
        .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

  // Cybersecurity/Guides (publicMinArticles, auditoria 2026-09-12):
  // mientras no alcancen el mínimo de artículos publicados e indexables,
  // NO se genera categoria/<slug>/index.html en absoluto -- nunca un hub
  // vacío o casi vacío, ni siquiera al guardar el primer artículo desde
  // el panel (este es el path que corre en cada guardado, no solo en la
  // regeneración completa). Mismo criterio que generate_pages.py.
  if (!isCategoryPubliclyVisible(cat, items.length)) {
    return { path: null, count: items.length, noindex: true, hidden: true };
  }

  var hrefFor = function (a) {
    return a.category === slug ? a.slug + '.html' : '../' + a.category + '/' + a.slug + '.html';
  };
  var grid = buildCardsGridHtml(items, '../../', hrefFor, slug === 'trending');
  var isThin = items.length < MIN_CATEGORY_ARTICLES;

  var catUrl = SITE_URL + '/categoria/' + slug + '/';
  var seoHead = [
    ogMetaBlock(catUrl, cat.label + ' — VexlowHQ', cat.description || '', null, 'website'),
    jsonLdScript({ '@context': 'https://schema.org', '@type': 'CollectionPage', name: cat.label + ' — VexlowHQ', description: cat.description || '', url: catUrl }),
    jsonLdScript(breadcrumbJsonLd([['Home', SITE_URL + '/'], [cat.label, catUrl]]))
  ].join('\n');

  var noteBlock = cat.hasNote
    ? '    <p style="font-size:12.5px;color:var(--text-muted);margin:-14px 0 26px;max-width:60ch;">These are the articles marked as Trending from the admin panel. If none are marked yet, you\'ll see the most recent stories across all categories.</p>\n'
    : '';

  var html = fill(CATEGORY_PAGE_TEMPLATE, {
    label: cat.label,
    slug: slug,
    icon: cat.icon,
    desc: cat.description || '',
    sidebar: blocks.sidebar,
    footer: blocks.footer,
    noteBlock: noteBlock,
    feedHeading: slug === 'trending' ? "📰 What's Trending" : '📰 Latest News',
    grid: grid || '<p class="latest-empty">No articles in this category yet.</p>',
    countLabel: countLabelFor(items.length),
    robotsMeta: isThin ? '<meta name="robots" content="noindex,follow">\n' : '',
    seoHead: seoHead
  });

  var outPath = path.join(CATEGORIA_DIR, slug, 'index.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return { path: outPath, count: items.length, noindex: isThin };
}

var EMPTY_RAIL_HTML = '<p class="latest-empty">Nothing published in this section yet.</p>\n';
var HOME_RAIL_CATEGORIES = ['ai', 'technology', 'science', 'gaming', 'entertainment', 'sports'];

/* Vuelca en index.html (Top 5 Trending, Latest Posts, y los 6 rieles
   por categoría) las mismas tarjetas que antes solo aparecían al correr
   js/script.js -- ver la nota larga en admin/generate_pages.py sobre
   por qué esto importa para AdSense/SEO. Idempotente: reemplaza el
   contenido de cada contenedor por id, no lo va acumulando. */
function generateHomeSections(allArticlesOpt) {
  var indexPath = path.join(ROOT, 'index.html');
  var html = fs.readFileSync(indexPath, 'utf8');
  // La portada no se regenera desde una plantilla como las demás páginas
  // -- se lee/reescribe in-place. Su bloque de Consent Mode v2 + GA4 +
  // AdSense vive entre estos marcadores en el <head>; se sincroniza acá
  // con la MISMA constante CONSENT_ADS_BLOCK que usan las demás plantillas
  // (auditoría global, 2026-09-09 -- mismo criterio que generate() en
  // admin/generate_pages.py). Antes la portada ni tenía este bloque.
  html = replaceBetween(html, '<!-- CONSENT_ADS_BLOCK:START -->', '<!-- CONSENT_ADS_BLOCK:END -->', CONSENT_ADS_BLOCK);
  var allArticles = allArticlesOpt || loadArticles();

  // Reconstruye el nav de categorías (sidebar, footer, chips de filtro)
  // desde data/categories.json y lo escribe de vuelta en index.html --
  // corrección 2026-09-27 de la causa estructural de la brecha de paridad
  // Node/Python (ver buildCategoryNavHtml() arriba): así queda como la
  // fuente real para todas las páginas, exactamente igual que generate()
  // en admin/generate_pages.py -- loadSidebarFooterRaw() (más abajo, y
  // llamada por generateCategoryPage()/syncSharedShellPages() DESPUÉS de
  // esta función en refreshPublicPages()) extrae el sidebar/footer YA
  // actualizados, no una copia vieja.
  var menuCats = menuVisibleCategories(allArticles);
  html = replaceBetween(html, '<span class="side-label">Categories</span>', '</nav>', buildCategoryNavHtml(menuCats));
  html = replaceBetween(
    html,
    '<p>The most interesting stuff on the internet, every day. Discovery, not just news.</p>\n        </div>',
    '<div class="footer-col">\n          <h4>Trust</h4>',
    buildFooterCategoriesHtml(menuCats) + '\n'
  );
  html = replaceBetween(html, '<div class="filter-row" id="filterRow">', '</div>', buildFilterChipsHtml(menuCats));

  var publishable = allArticles.filter(function (a) {
    return a.slug && categoryBySlug(a.category) && String(a.body || '').trim() && articleStatus.isPublicArticle(a);
  });
  // Los "noindex" no deben quedar enlazados desde la portada (trending
  // strip, Latest Posts, rieles por categoría) -- mismo criterio que
  // generateCategoryPage() de acá arriba y generate() en
  // generate_pages.py (fix 2026-09: auditoría global, punto 5).
  var listablePublishable = publishable.filter(function (a) { return !a.noindex; });

  function homeHref(a) { return 'categoria/' + a.category + '/' + a.slug + '.html'; }

  // Igual que en generate() (Python): los artículos con "editorialStatus"
  // quedan afuera de los espacios curados de la portada (trending,
  // Latest Posts, rieles por categoría), aunque sigan navegables en su
  // propia página y en la grilla normal de su categoría.
  var featuredPublishable = listablePublishable.filter(function (a) { return !a.editorialStatus; });

  var top5 = trendingArticles(listablePublishable).slice(0, 5);
  var trendHtml = top5.length ? buildCardsGridHtml(top5, '', homeHref, true) : EMPTY_RAIL_HTML;
  html = replaceDivContentById(html, 'trendStrip', trendHtml);

  var latest8 = featuredPublishable.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); }).slice(0, 8);
  var latestHtml = latest8.length ? latest8.map(function (a) { return buildLatestItemHtml(a, homeHref(a)); }).join('') : EMPTY_RAIL_HTML;
  html = replaceDivContentById(html, 'latestList', latestHtml);

  HOME_RAIL_CATEGORIES.forEach(function (catSlug) {
    var items = featuredPublishable.filter(function (a) { return a.category === catSlug; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
      .slice(0, 4);
    var railHtml = items.length ? buildCardsGridHtml(items, '', homeHref, false) : EMPTY_RAIL_HTML;
    html = replaceDivContentById(html, 'rail-' + catSlug, railHtml);
  });

  fs.writeFileSync(indexPath, html, 'utf8');
}

/* Puerto a Node de write_sitemap()/generate() (fase sitemap) en
   admin/generate_pages.py -- se llama después de cada publicación,
   borrado o cambio de categoría, para que sitemap.xml nunca quede
   desactualizado esperando a que alguien corra el script de Python a
   mano. Mismo criterio de exclusión de categorías "noindex" (pocas
   notas propias). */
function writeSitemap(allArticlesOpt) {
  var allArticles = allArticlesOpt || loadArticles();
  var categories = loadCategories();
  var publishable = allArticles.filter(function (a) {
    return a.slug && categoryBySlug(a.category) && String(a.body || '').trim() && articleStatus.isPublicArticle(a);
  });
  var today = new Date().toISOString().slice(0, 10);
  var urls = [['/', today, 'daily']];

  categories.forEach(function (cat) {
    var items = cat.slug === 'trending'
      ? trendingArticles(publishable)
      : publishable.filter(function (a) { return a.category === cat.slug; });
    if (items.length >= MIN_CATEGORY_ARTICLES) {
      urls.push(['/categoria/' + cat.slug + '/', today, 'daily']);
    }
  });

  publishable.forEach(function (a) {
    if (a.noindex) return; // en revisión editorial -- fuera del sitemap hasta que se corrija
    urls.push(['/categoria/' + a.category + '/' + a.slug + '.html', a.date || today, 'monthly']);
  });

  STATIC_PAGE_SLUGS.forEach(function (slug) {
    urls.push(['/' + slug + '.html', today, 'yearly']);
  });

  var PLAY_PAGES = [['index.html', 'weekly'], ['trivia.html', 'weekly'], ['dash.html', 'monthly'],
    ['snake.html', 'monthly'], ['orbit.html', 'monthly'], ['gravity.html', 'monthly'],
    ['pulse.html', 'monthly'], ['wordsearch.html', 'monthly']];
  PLAY_PAGES.forEach(function (p) { urls.push(['/play/' + p[0], today, p[1]]); });

  var lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  urls.forEach(function (u) {
    lines.push('  <url>');
    lines.push('    <loc>' + SITE_URL + u[0] + '</loc>');
    lines.push('    <lastmod>' + u[1] + '</lastmod>');
    lines.push('    <changefreq>' + u[2] + '</changefreq>');
    lines.push('  </url>');
  });
  lines.push('</urlset>');
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), lines.join('\n') + '\n', 'utf8');
  return urls.length;
}

/* Se llama después de cualquier cambio que afecte contenido publicado
   (guardar/borrar artículos, crear/renombrar categorías): mantiene la(s)
   página(s) de categoría afectada(s), la portada y sitemap.xml al día,
   sin que el usuario tenga que acordarse de correr el regenerador de
   Python. `affectedSlugs` es opcional -- si no se pasa, se regeneran
   todas las categorías (más lento, pero seguro para cambios que pueden
   afectar a más de una, como borrar un artículo). */
function refreshPublicPages(affectedSlugs) {
  var allArticles = loadArticles();
  var categories = loadCategories();
  // Corrección 2026-09-13: portada se regenera PRIMERO, antes que las
  // páginas de categoría. generateCategoryPage() (y generateArticleFile(),
  // ver regenerateAllArticlePages() más abajo) copian el sidebar/footer
  // compartido leyendo el index.html YA ESCRITO en disco en ese momento
  // (loadSidebarFooter()) -- si portada se regenerara al final como antes,
  // cada página de categoría (y cada artículo) quedaría con una copia de
  // "Latest Posts"/trending atrasada un ciclo completo entero respecto al
  // estado real, aunque el resto de la página estuviera al día.
  generateHomeSections(allArticles);

  var slugs = affectedSlugs && affectedSlugs.length ? affectedSlugs : categories.map(function (c) { return c.slug; });
  // "trending" agrega de todas las categorías -- si cambió cualquier
  // artículo, su conteo puede haber cambiado también.
  if (slugs.indexOf('trending') === -1) slugs = slugs.concat(['trending']);
  var seen = {};
  slugs.forEach(function (slug) {
    if (seen[slug]) return;
    seen[slug] = true;
    if (categoryBySlug(slug)) generateCategoryPage(slug, allArticles);
  });
  writeSitemap(allArticles);
}

/* Corrección 2026-09-13 (causa raíz de los 112 enlaces muertos detectados
   tras borrar 28 artículos sin imagen): históricamente, guardar/editar/
   borrar un artículo solo regeneraba SU PROPIA página (generateArticleFile
   de esa nota) más portada/categorías/sitemap (refreshPublicPages) -- pero
   la página de CUALQUIER OTRO artículo que la tuviera en su rail de
   "You might also like" quedaba con ese <a href> "congelado" apuntando a
   una nota que ya no existe, y ninguna operación normal la volvía a tocar.
   Esta función regenera la página propia de TODOS los artículos públicos
   (y de redirect) a partir del estado actual de data/articulos.json, así
   que el rail de relacionados de cada uno queda al día con quién existe
   de verdad en ese momento. Se llama desde server.js en cada operación que
   muta articulos.json (guardado masivo, alta/edición individual, borrado,
   restauración desde papelera) -- no solo cuando se detectan enlaces rotos,
   porque cualquier cambio (crear, editar, borrar, restaurar, cambiar
   categoría/slug, cambiar de estado editorial, marcar/desmarcar noindex,
   crear o modificar un redirect) puede volver desactualizado el rail de
   otras páginas que no fueron las tocadas directamente. */
function regenerateAllArticlePages() {
  var allArticles = loadArticles();
  // Corrección 2026-09-13: refreshPublicPages() (portada -> categorías ->
  // sitemap, en ese orden -- ver el comentario ahí) corre PRIMERO, así
  // index.html ya queda al día en disco ANTES de generar cada página de
  // artículo -- generateArticleFile() también copia el sidebar/footer
  // compartido de index.html (loadSidebarFooter()), y sin este orden
  // quedaría con una copia de "Latest Posts" atrasada un ciclo completo,
  // el mismo síntoma (un componente compartido desactualizado) que el
  // rail de relacionados, solo que en el sidebar en vez del rail.
  refreshPublicPages();
  var errors = [];
  var count = 0;
  allArticles.forEach(function (a) {
    if (!a.slug || !a.category) return;
    try {
      if (articleStatus.isRedirectArticle(a)) {
        generateRedirectFile(a, allArticles);
        count++;
      } else if (articleStatus.isPublicArticle(a) && typeof a.body === 'string' && a.body.trim()) {
        generateArticleFile(a);
        count++;
      }
    } catch (e) {
      errors.push({ slug: a.slug, category: a.category, error: e.message });
    }
  });
  // Corrección 2026-09-13 (brecha de paridad Node/Python): las 7 páginas
  // institucionales y las 8 de Games también comparten sidebar/footer/
  // consent-ads con portada -- si no se sincronizan acá quedan con
  // Latest/nav atrasados en cuanto se publica/edita/borra algo desde el
  // panel sin correr generate_pages.py a mano. Corre siempre DESPUÉS del
  // loop de arriba (no que importe el orden entre ambos, ya que ninguno
  // depende del otro -- solo de refreshPublicPages() -- pero así quedan
  // agrupados los dos efectos de "regenerar todo" en un solo lugar).
  var shellResults;
  try {
    shellResults = syncSharedShellPages();
  } catch (e) {
    errors.push({ slug: '(shell-institucional-juegos)', category: '-', error: e.message });
    shellResults = [];
  }
  return { count: count, errors: errors, shellPagesChanged: shellResults.filter(function (r) { return r.changed; }).length, shellPagesTotal: shellResults.length };
}

// Resuelve redirectTo ("categoria/slug" o solo "slug") al artículo
// destino real. No inventa un destino: si no encuentra ninguno, devuelve
// null y el que llama decide qué hacer (server.js ya bloqueó esto antes
// de guardar vía pipeline.validateEditorialWorkflow -- acá es una
// segunda red de seguridad para cuando se llama directo, ej. desde
// generate_pages.py o un regenerado completo).
function findRedirectTarget(article, allArticles) {
  var target = article && article.redirectTo;
  if (!target) return null;
  return (allArticles || []).find(function (a) {
    if (a === article) return false;
    return (a.category + '/' + a.slug) === target || a.slug === target;
  }) || null;
}

// Genera un archivo de redirección permanente en la URL de ESTE
// artículo (misma ruta de siempre: categoria/<cat>/<slug>.html), que
// manda al lector y a los buscadores hacia el artículo canónico
// indicado en redirectTo -- para cuando dos notas terminan siendo la
// misma historia y hay que consolidar en una sola URL indexada sin
// dejar la vieja compitiendo por ranking ni mostrando contenido
// desactualizado. Nunca se lista en categorías/portada/sitemap (ver
// article-status.js: isRedirectArticle() no es isPublicArticle()).
// Meta-refresh + <link rel=canonical> + un location.replace() de
// respaldo (por si algún navegador ignora el meta-refresh) -- sin
// AdSense ni contenido real, porque no es una página de contenido.
// Parte PURA de generateRedirectFile() (misma razón que buildArticleHtml()
// más arriba): arma el HTML del stub de redirección en memoria y lo
// devuelve, sin tocar el disco. allArticles es obligatorio acá (a
// diferencia del wrapper de abajo, que lo resuelve solo) porque el
// endpoint de vista previa ya tiene la lista cargada y evita releerla dos
// veces por request.
//
// opts.preview (default false, corrección 2026-09-13): igual que en
// buildArticleHtml, el destino del redirect (relativeTarget) es
// "../../categoria/..." porque la página real de ESTE artículo vive dos
// niveles bajo la raíz -- en vista previa (/api/preview/:category/:slug)
// ese relativo resuelve mal, así que se arma absoluto hacia /site/.
function buildRedirectHtml(article, allArticles, opts) {
  opts = opts || {};
  var preview = !!opts.preview;
  var cat = categoryBySlug(article.category);
  if (!cat) throw new Error('Categoría desconocida: ' + article.category);
  var target = findRedirectTarget(article, allArticles);
  if (!target) throw new Error('redirectTo inválido o no encontrado para ' + article.slug + ' (' + article.redirectTo + ')');
  var targetCat = categoryBySlug(target.category);
  if (!targetCat) throw new Error('El destino del redirect tiene una categoría desconocida: ' + target.category);

  var relativeTarget = (preview ? '/site/' : '../../') + 'categoria/' + targetCat.slug + '/' + target.slug + '.html';
  var targetUrl = SITE_URL + '/categoria/' + targetCat.slug + '/' + target.slug + '.html';

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + escapeHtml(target.title || cat.label) + ' — VexlowHQ</title>\n' +
    '<meta http-equiv="refresh" content="0; url=' + relativeTarget + '">\n' +
    '<link rel="canonical" href="' + targetUrl + '">\n' +
    '<meta name="robots" content="noindex,follow">\n' +
    '</head>\n<body>\n' +
    '<p>This article has moved. <a href="' + relativeTarget + '">Continue to the current version →</a></p>\n' +
    '<script>location.replace(' + JSON.stringify(relativeTarget) + ');</script>\n' +
    '</body>\n</html>\n';
}

function generateRedirectFile(article, allArticlesOpt) {
  var allArticles = allArticlesOpt || loadArticles();
  var html = buildRedirectHtml(article, allArticles);

  var outPath = articleFilePath(article);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

function deleteArticleFile(article) {
  var filePath = articleFilePath(article);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

module.exports = {
  loadCategories: loadCategories,
  categoryBySlug: categoryBySlug,
  isCategoryPubliclyVisible: isCategoryPubliclyVisible,
  categoriesAcceptingNewContent: categoriesAcceptingNewContent,
  addCategory: addCategory,
  renameCategory: renameCategory,
  deleteCategory: deleteCategory,
  slugify: slugify,
  generateArticleFile: generateArticleFile,
  buildArticleHtml: buildArticleHtml,
  deleteArticleFile: deleteArticleFile,
  generateCategoryPage: generateCategoryPage,
  generateHomeSections: generateHomeSections,
  writeSitemap: writeSitemap,
  refreshPublicPages: refreshPublicPages,
  regenerateAllArticlePages: regenerateAllArticlePages,
  findRedirectTarget: findRedirectTarget,
  generateRedirectFile: generateRedirectFile,
  buildRedirectHtml: buildRedirectHtml,
  syncSharedShellPages: syncSharedShellPages,
  loadSidebarFooterRaw: loadSidebarFooterRaw,
  localize: localize,
  STATIC_PAGE_SLUGS: STATIC_PAGE_SLUGS,
  STATIC_PAGES_NO_ADS: STATIC_PAGES_NO_ADS,
  PLAY_PAGE_FILES: PLAY_PAGE_FILES,
  CONSENT_MARKER_START: CONSENT_MARKER_START,
  CONSENT_MARKER_END: CONSENT_MARKER_END,
  SIDEBAR_START_MARKER: SIDEBAR_START_MARKER,
  SIDEBAR_END_MARKER: SIDEBAR_END_MARKER,
  FOOTER_START_MARKER: FOOTER_START_MARKER,
  FOOTER_END_MARKER: FOOTER_END_MARKER,
  consentBlockFor: consentBlockFor,
  buildCategoryNavHtml: buildCategoryNavHtml,
  buildFooterCategoriesHtml: buildFooterCategoriesHtml,
  buildFilterChipsHtml: buildFilterChipsHtml,
  pageVisibleCategories: pageVisibleCategories,
  menuVisibleCategories: menuVisibleCategories,
  categoryLabelsList: categoryLabelsList,
  categoryListSentence: categoryListSentence,
  categoryListLowercaseSentence: categoryListLowercaseSentence,
  syncCategoryListSentences: syncCategoryListSentences,
  CATEGORY_LIST_SENTENCE_START: CATEGORY_LIST_SENTENCE_START,
  CATEGORY_LIST_SENTENCE_END: CATEGORY_LIST_SENTENCE_END,
  CATEGORY_LIST_LOWERCASE_START: CATEGORY_LIST_LOWERCASE_START,
  CATEGORY_LIST_LOWERCASE_END: CATEGORY_LIST_LOWERCASE_END
};
