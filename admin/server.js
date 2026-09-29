/*
  Panel de administración de VexlowHQ — servidor local
  =====================================================
  No requiere instalar nada (usa solo módulos incluidos con Node).
  Se arranca con doble clic en start-admin.bat, o a mano con:
    node admin/server.js

  Qué hace:
  - Sirve el panel en http://localhost:4321
  - Guarda los cambios de Hero y Artículos en data/hero.json y
    data/articulos.json, y regenera data/hero.js / data/articulos.js
    (los archivos que el sitio realmente carga) automáticamente.
  - Sirve el sitio real en http://localhost:4321/site/ para poder
    previsualizar los cambios sin salir del panel.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pagegen = require('./pagegen');
const pipeline = require('./pipeline');
const imageLicenses = require('./image-licenses');
const deploy = require('./deploy');
const gravityEditor = require('./gravity-editor');
const social = require('./social');
const sprint = require('./sprint');
const carouselGen = require('./carousel-gen');
const articlesStore = require('./articles-store');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const IMG_DIR = path.join(ROOT, 'img');
const ADMIN_DIR = __dirname;
const CONFIG_FILE = path.join(ADMIN_DIR, 'config.json');
const PORT = 4321;

// Recargadas del disco en cada uso (pagegen.loadCategories), no una
// constante fija -- así un alta/baja de categoría hecha desde el panel
// se ve al toque, sin reiniciar el servidor.
function reservedSlugs() {
  return new Set(pagegen.loadCategories().map(function (c) { return c.slug; }).concat(['index']));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif']);

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function generateHeroJs(data) {
  var header = '/*\n' +
    '  HERO — diapositivas del carrusel principal de la Home\n' +
    '  =======================================================\n' +
    '  GENERADO AUTOMÁTICAMENTE por el panel de administración\n' +
    '  (admin/index.html). No lo edites a mano: los cambios se van a\n' +
    '  perder la próxima vez que guardes algo desde el panel.\n' +
    '  La fuente real es data/hero.json.\n' +
    '*/\n';
  return header + 'const VEXLOW_HERO = ' + JSON.stringify(data, null, 2) + ';\n';
}

// Incidente 2026-09-13 ("146 con Moonshot repetido"): mientras se
// investigaba se encontró que este archivo se generaba con el array
// COMPLETO de articulos.json -- incluyendo artículos en estado
// draft/review/approved, que nunca deberían ser públicos. js/script.js
// (el JS real del sitio) carga este archivo en TODAS las páginas y solo
// filtra por `noindex` (publiclyListable()), sin mirar el status
// editorial -- así que cualquier borrador/revisión/aprobado guardado
// desde el panel aparecía en Últimas/Trending/categorías/buscador del
// sitio EN VIVO mientras existiera en articulos.json, aunque nunca
// tuviera página HTML propia ni entrada en el sitemap. Se corrige acá
// (filtrando antes de serializar) Y en js/script.js (publiclyListable
// ahora también mira el status) -- las dos capas, mismo criterio que ya
// usa el resto del panel para no depender de un solo punto de control.
function publiclyExposableArticles(data) {
  return data.filter(function (a) {
    return pipeline.isPublicArticle(a) || pipeline.isRedirectArticle(a);
  });
}

function generateArticulosJs(data) {
  var header = '/*\n' +
    '  ARTÍCULOS — fuente de "Últimas publicadas" y de las páginas de categoría\n' +
    '  ==========================================================================\n' +
    '  GENERADO AUTOMÁTICAMENTE por el panel de administración\n' +
    '  (admin/index.html). No lo edites a mano: los cambios se van a\n' +
    '  perder la próxima vez que guardes algo desde el panel.\n' +
    '  La fuente real es data/articulos.json.\n' +
    '  Incluye solo artículos published/redirected -- draft/review/approved\n' +
    '  quedan afuera a propósito (incidente 2026-09-13): deben existir solo\n' +
    '  en articulos.json (uso interno del panel), nunca en este archivo, que\n' +
    '  es el que carga el sitio público.\n' +
    '*/\n';
  return header + 'const VEXLOW_ARTICLES = ' + JSON.stringify(publiclyExposableArticles(data), null, 2) + ';\n';
}

// ---------------------------------------------------------------------
// Idempotencia por clave de cliente (incidente 2026-09-13, "146 con
// Moonshot repetido ~5 veces"): el panel (admin.js) manda un header
// X-Idempotency-Key distinto por cada intento de guardado. Si la MISMA
// clave llega otra vez (reintento de red, doble entrega, etc.), se
// devuelve la respuesta ya calculada la primera vez, sin volver a tocar
// disco, validar ni regenerar nada -- así ni una entrega duplicada a
// nivel de red puede crear un segundo registro. No reemplaza la
// protección de fondo (articles-store.upsertArticle ya es idempotente
// por categoría+slug), es una capa extra para responder rápido y sin
// efectos secundarios repetidos ante una redundancia detectable.
var IDEMPOTENCY_CACHE_MAX = 500;
var idempotencyCache = new Map(); // key -> { status, body, headers }

function idempotencyRecall(key) {
  if (!key) return null;
  return idempotencyCache.get(key) || null;
}

function idempotencyRemember(key, status, body, headers) {
  if (!key) return;
  idempotencyCache.set(key, { status: status, body: body, headers: headers || {} });
  if (idempotencyCache.size > IDEMPOTENCY_CACHE_MAX) {
    idempotencyCache.delete(idempotencyCache.keys().next().value);
  }
}

// ¿Este artículo tiene (o podría tener) alguna presencia pública --
// página propia, listados, sitemap, elegible como "relacionado" en otra
// página? Solo published/redirected -- ver admin/article-status.js.
function articleIsVisible(a) {
  return !!a && (pipeline.isPublicArticle(a) || pipeline.isRedirectArticle(a));
}

// Auditoría de rendimiento (incidente 2026-09-13, "el panel estaba
// lento"): regenerateArticlePages() de más abajo siempre disparaba
// pagegen.regenerateAllArticlePages() -- una regeneración COMPLETA de
// las ~141 páginas del sitio -- en CADA guardado, incluido guardar un
// borrador que nunca tuvo ni tendrá página propia. Un borrador/revisión/
// aprobado no puede aparecer en ningún listado ni ser elegido como
// "relacionado" en otra página (pagegen.relatedArticlesFor ya filtra su
// pool por isPublicArticle), así que si NINGÚN artículo tocado por esta
// operación es (o era) público/redirect, no hay absolutamente nada que
// regenerar -- se puede saltar la regeneración completa por entero, sin
// perder ninguna corrección de las que motivaron regenerar todo (enlaces
// "you might also like" desactualizados, portada, categorías, sitemap).
function anyVisibleChange(previous, current) {
  var prevByKey = {};
  (previous || []).forEach(function (a) { if (a && a.category && a.slug) prevByKey[a.category + '/' + a.slug] = a; });
  var curByKey = {};
  (current || []).forEach(function (a) { if (a && a.category && a.slug) curByKey[a.category + '/' + a.slug] = a; });
  var keys = new Set(Object.keys(prevByKey).concat(Object.keys(curByKey)));
  var found = false;
  keys.forEach(function (key) {
    if (found) return;
    var before = prevByKey[key];
    var after = curByKey[key];
    if (!articleIsVisible(before) && !articleIsVisible(after)) return; // nunca fue ni es público/redirect -- no puede afectar nada visible
    var beforeStr = before ? JSON.stringify(before) : null;
    var afterStr = after ? JSON.stringify(after) : null;
    if (beforeStr !== afterStr) found = true;
  });
  return found;
}

function listImages() {
  var results = [];
  function walk(dir, relBase) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function (entry) {
      var rel = relBase ? relBase + '/' + entry.name : entry.name;
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        results.push('img/' + rel.split(path.sep).join('/'));
      }
    });
  }
  walk(IMG_DIR, '');
  return results.sort();
}

// PROTECCIÓN PERMANENTE DEL PANEL (auditoría forense de imágenes +
// controles editoriales, 2026-09-11/12): antes de guardar nada, se valida
// imagen (fase 3) y contenido editorial (fase 5) de cada artículo. Se
// aplica el control COMPLETO -- imagen Y contenido -- solo a lo NUEVO o
// MODIFICADO en este guardado (pipeline.isArticleNewOrChanged): el resto
// del sitio, publicado bajo reglas más laxas en su momento, no se
// re-bloquea retroactivamente por una regla que no existía cuando se
// publicó (ver la nota larga en pipeline.js, sección "controles
// editoriales para artículos nuevos"). Esto incluye la imagen a
// propósito: la migración de procedencia del 2026-09-12 dejó a los
// artículos existentes conformes en LOS CAMPOS (licencia/origen/
// atribución), pero hay 4 artículos legítimos y ya publicados de antes de
// esta auditoría cuyo ARCHIVO en sí no cumple una regla nueva (una imagen
// de prensa de 293x142px, por debajo del mínimo nuevo; tres imágenes que
// llegaron a producción físicamente ubicadas en img/drafts/ antes de que
// existiera esa regla) -- revalidarlas en cada guardado futuro, sin
// haberlas tocado, bloquearía CUALQUIER cambio al sitio a partir de
// ahora. Si alguien edita esos artículos puntuales sí van a tener que
// resolver esos problemas.
//
// article.draftIncomplete === true (fase 4, "guardar como borrador
// incompleto sin hacerlo público") salta esta validación para ESE
// artículo puntual -- se guarda tal cual está, pero más abajo
// (generación de páginas) nunca se le genera página propia ni se lo deja
// "publicable" en pagegen.js/generate_pages.py mientras tenga esa marca.
// El panel es el único lugar que debe poder ponerla/sacarla (checkbox
// "Guardar como borrador incompleto").
// Estados editoriales (2026-09-12): un artículo nuevo/modificado declara
// `status` (draft/review/approved/published/redirected, ver
// admin/article-status.js). Según cuál sea, se valida distinto:
//   - draft (o el legado draftIncomplete=true): nada, se guarda tal
//     cual, nunca se publica.
//   - redirected: solo lo mínimo para poder generar el archivo de
//     redirect (título/categoría/slug + que redirectTo exista).
//   - review/approved/published: control COMPLETO -- imagen (fase 3),
//     contenido editorial (fase 5) y flujo editorial (no puede llegar a
//     'published' sin editorialApproval=true). Las advertencias de
//     validateSourcesAndQuality (heurísticas: texto genérico, posible
//     contradicción, cifras sin atribución, etc.) viajan aparte en
//     `warnings` -- informan, no bloquean, para que un falso positivo de
//     una heurística de palabras clave no pueda trabar la publicación de
//     una noticia real.
//
// Extraída a función propia (antes vivía inline en POST /api/articles)
// para que POST /api/validate-article -- el "chequeo en vivo" que usa el
// panel para pintar el checklist de la fase 9 sin guardar nada -- corra
// EXACTAMENTE la misma lógica de bloqueo que el guardado real. Un
// checklist en el HTML que reimplementara estas reglas en JS del lado
// del navegador podría desincronizarse con el servidor con el tiempo (y
// es justo lo que el usuario pidió evitar: "las reglas obligatorias
// deben existir también en server.js/pipeline.js para que no puedan
// saltarse mediante una petición directa" -- acá se cumple en los dos
// sentidos, la regla vive una sola vez y tanto el guardado real como la
// vista previa del panel la consultan).
function runPrePublishValidation(data, previous) {
  var blocked = [];
  var warnings = [];
  data.forEach(function (a) {
    if (a.draftIncomplete) return; // borrador incompleto (legado) -- no se valida ni se publica como nota completa
    if (!pipeline.isArticleNewOrChanged(a, previous)) return; // artículo viejo sin tocar -- no se re-bloquea retroactivamente
    var effective = pipeline.effectiveStatus(a);
    if (effective === 'draft') return; // status:'draft' explícito -- mismo criterio que draftIncomplete

    var issues;
    if (effective === 'redirected') {
      issues = pipeline.validateRedirectArticle(a, data);
    } else {
      var workflowIssues = pipeline.validateEditorialWorkflow(a, data);
      var imageIssues = pipeline.validateImagePublication(a, data);
      var contentIssues = pipeline.validateArticleContent(a, data);
      var qualityResult = pipeline.validateSourcesAndQuality(a, data);
      issues = workflowIssues.concat(imageIssues).concat(contentIssues).concat(qualityResult.issues);
      if (qualityResult.warnings.length) {
        warnings.push({ slug: a.slug, title: a.title, warnings: qualityResult.warnings });
      }
    }
    if (issues.length) {
      blocked.push({ slug: a.slug, title: a.title, issues: issues });
    }
  });
  return { blocked: blocked, warnings: warnings };
}

// Extraída del handler de POST /api/articles (incidente 2026-09-13) para
// que TAMBIÉN la usen los endpoints nuevos de edición/borrado individual
// (PUT/DELETE /api/articles/:category/:slug) -- así una edición de un solo
// artículo deja las páginas derivadas (HTML propio, categoría, portada,
// sitemap) tan al día como un guardado masivo, sin duplicar la lógica.
function regenerateArticlePages(previous, data) {
  // Atajo de rendimiento (incidente 2026-09-13): si nada de lo que
  // cambió es (o era) público/redirect, no hace falta ni la limpieza de
  // HTML huérfano de abajo ni la regeneración completa -- ver
  // anyVisibleChange() arriba para el razonamiento completo.
  if (!anyVisibleChange(previous, data)) {
    return { generated: 0, errors: [], removed: [], refreshError: null, skippedNoVisibleChange: true };
  }
  var currentKeys = new Set();
  var noPageKeys = new Set(); // draft/review/approved -- nunca deben tener página propia
  data.forEach(function (a) {
    if (!a.slug || !a.category) return;
    var key = a.category + '/' + a.slug;
    currentKeys.add(key);
    if (!pipeline.isRedirectArticle(a) && !pipeline.isPublicArticle(a)) noPageKeys.add(key);
  });

  // Nota post-incidente: esta limpieza ya NO puede dispararse por una
  // reducción accidental del array (articles-store.saveBulkArticles la
  // rechaza con 409 antes de llegar acá). Sigue sirviendo para su caso
  // legítimo: un artículo que cambió de categoría/slug (la key vieja ya no
  // está, pero el artículo sigue presente con la key nueva) o que pasó de
  // publicado a draft/review/approved -- su HTML viejo en esa ruta anterior
  // se borra ANTES de la regeneración completa de abajo.
  var removed = [];
  previous.forEach(function (a) {
    if (!a.slug || !a.category) return;
    var key = a.category + '/' + a.slug;
    if (currentKeys.has(key) && !noPageKeys.has(key)) return;
    if (pagegen.deleteArticleFile(a)) removed.push(key);
  });

  // Corrección 2026-09-13 (112 enlaces muertos en 64 páginas tras el
  // borrado de 28 artículos): no alcanza con regenerar solamente el/los
  // artículo(s) tocados en esta operación -- el rail "You might also like"
  // de cualquier otro de los ~141 artículos puede estar referenciando al
  // que acaba de cambiar. Por eso cada operación que muta articulos.json
  // (guardado masivo, alta/edición individual, borrado, restauración)
  // regenera la página propia de TODOS los artículos públicos/redirect,
  // no solo el/los tocados, además de portada/categorías/sitemap.
  var refreshError = null;
  var full = { count: 0, errors: [] };
  try {
    full = pagegen.regenerateAllArticlePages();
  } catch (e) {
    refreshError = e.message;
  }

  return { generated: full.count, errors: full.errors, removed: removed, refreshError: refreshError };
}

function sendJSON(res, status, data) {
  var body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// Error simple en texto plano para la ruta de vista previa (GET, pensada
// para abrirse directo en una pestaña del navegador) -- mismo criterio de
// no filtrar detalles internos que ya usa serveStaticFile() más abajo.
function sendHtmlError(res, status, message) {
  var body = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Vista previa</title></head>' +
    '<body style="font-family:sans-serif;padding:40px;color:#333;"><p>' + message.replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    }) + '</p></body></html>';
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, function (err, content) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado: ' + filePath);
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    // Auditoría 2026-09-13 ("el navegador está cargando JavaScript
    // antiguo por caché"): este servidor nunca mandó ningún header de
    // caché, así que quedaba a criterio heurístico del navegador -- en la
    // práctica Chrome puede quedarse con una copia vieja de admin.js
    // después de un cambio hasta un refresco forzado. Este servidor
    // SOLO lo usa una persona en su propia máquina para el panel y la
    // previsualización de /site/ -- no hay ningún beneficio de
    // performance real en cachear acá, así que en vez de armar un
    // esquema de versionado (?v=hash), la corrección determinista más
    // simple es no cachear nunca: cada request trae el archivo tal como
    // está en disco en ese momento, sin excepciones.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store, must-revalidate' });
    res.end(content);
  });
}

function readBody(req, cb) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    try {
      var body = Buffer.concat(chunks).toString('utf8');
      cb(null, body ? JSON.parse(body) : null);
    } catch (e) {
      cb(e);
    }
  });
}

function safeJoin(base, rel) {
  var full = path.normalize(path.join(base, rel));
  if (!full.startsWith(path.normalize(base))) return null; // evita salir de la carpeta
  return full;
}

var MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB decodificados

function sanitizeFilename(name) {
  var ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(ext)) ext = '.jpg';
  var base = path.basename(name, path.extname(name))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'imagen';
  return { base: base, ext: ext };
}

function uploadImage(category, filename, dataBase64) {
  var cat = pagegen.categoryBySlug(category);
  if (!cat) throw new Error('Categoría desconocida: ' + category);

  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('La imagen pesa más de 8 MB');

  var parts = sanitizeFilename(filename);
  var folder = cat.imgFolder || cat.slug;
  var dir = path.join(IMG_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });

  var finalName = parts.base + parts.ext;
  var counter = 1;
  while (fs.existsSync(path.join(dir, finalName))) {
    finalName = parts.base + '-' + counter + parts.ext;
    counter++;
  }

  fs.writeFileSync(path.join(dir, finalName), buffer);
  return 'img/' + folder + '/' + finalName;
}

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);

  // ---- API ----
  if (urlPath === '/api/categories' && req.method === 'GET') {
    return sendJSON(res, 200, pagegen.loadCategories());
  }
  if (urlPath === '/api/categories' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.label) {
        return sendJSON(res, 400, { error: 'Falta el nombre de la categoría' });
      }
      try {
        var created = pagegen.addCategory(data.label, data.icon, data.description);
        try { pagegen.generateCategoryPage(created.slug); pagegen.writeSitemap(); } catch (e2) { /* categoría nueva sin artículos: no es crítico */ }
        return sendJSON(res, 200, { ok: true, category: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/categories' && req.method === 'PATCH') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) {
        return sendJSON(res, 400, { error: 'Falta la categoría a editar' });
      }
      try {
        var renamed = pagegen.renameCategory(data.slug, data.label, data.icon, data.description);
        try { pagegen.generateCategoryPage(renamed.slug); pagegen.writeSitemap(); } catch (e2) { /* no crítico */ }
        return sendJSON(res, 200, { ok: true, category: renamed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/categories' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) {
        return sendJSON(res, 400, { error: 'Falta la categoría a eliminar' });
      }
      var articles = [];
      try { articles = readJSON(path.join(DATA_DIR, 'articulos.json')); } catch (e) { articles = []; }
      var usedBy = articles.filter(function (a) { return a.category === data.slug; });
      var draftUsedBy = [];
      try { draftUsedBy = readJSON(path.join(DATA_DIR, 'drafts.json')).filter(function (a) { return a.category === data.slug; }); } catch (e) { draftUsedBy = []; }
      if (usedBy.length || draftUsedBy.length) {
        return sendJSON(res, 409, {
          error: 'Esta categoría todavía tiene ' + (usedBy.length + draftUsedBy.length) + ' artículo(s)/borrador(es). Movelos o eliminalos antes de borrar la categoría.',
          articles: usedBy.concat(draftUsedBy).map(function (a) { return a.title; })
        });
      }
      try {
        var removed = pagegen.deleteCategory(data.slug);
        try { pagegen.writeSitemap(); } catch (e2) { /* no crítico */ }
        return sendJSON(res, 200, { ok: true, category: removed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/images' && req.method === 'GET') {
    return sendJSON(res, 200, listImages());
  }
  // Fuente única de licencias autorizadas (fase 3, "no duplicada
  // arbitrariamente entre archivos") -- el formulario del panel arma su
  // <select> a partir de esto en vez de tener la lista escrita a mano en
  // admin/index.html o admin/admin.js.
  if (urlPath === '/api/image-licenses' && req.method === 'GET') {
    return sendJSON(res, 200, {
      authorized: imageLicenses.AUTHORIZED_LICENSES,
      requiringAttribution: imageLicenses.LICENSES_REQUIRING_ATTRIBUTION
    });
  }
  if (urlPath === '/api/upload-image' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.filename || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, nombre de archivo o imagen)' });
      }
      try {
        var savedPath = uploadImage(data.category, data.filename, data.dataBase64);
        return sendJSON(res, 200, { ok: true, path: savedPath });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/hero' && req.method === 'GET') {
    return sendJSON(res, 200, readJSON(path.join(DATA_DIR, 'hero.json')));
  }
  if (urlPath === '/api/hero' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !Array.isArray(data)) return sendJSON(res, 400, { error: 'JSON inválido' });
      writeJSON(path.join(DATA_DIR, 'hero.json'), data);
      fs.writeFileSync(path.join(DATA_DIR, 'hero.js'), generateHeroJs(data), 'utf8');
      return sendJSON(res, 200, { ok: true });
    });
  }
  // ---------------------------------------------------------------------
  // Blindaje post-incidente 2026-09-13 (ver admin/articles-store.js para el
  // detalle completo): GET expone la revisión actual (header ETag) y POST
  // (guardado masivo) exige esa revisión como If-Match -- si el archivo
  // cambió desde que esta pestaña lo cargó, responde 409 y exige recargar
  // en vez de pisar lo que haya en disco. Además, un guardado masivo YA NO
  // PUEDE reducir el total de artículos bajo ninguna circunstancia (con o
  // sin If-Match): eso es lo que permitió que una pestaña vieja borrara 28
  // artículos reales de un guardado. Borrar de verdad es ahora una acción
  // aparte, explícita y confirmada: ver DELETE /api/articles/:category/:slug
  // más abajo.
  // ---------------------------------------------------------------------
  if (urlPath === '/api/articles' && req.method === 'GET') {
    var current = articlesStore.readArticlesWithRev(DATA_DIR);
    res.setHeader('ETag', '"' + current.rev + '"');
    return sendJSON(res, 200, current.articles);
  }
  if (urlPath === '/api/articles' && req.method === 'POST') {
    var bulkIdemKey = req.headers['x-idempotency-key'] || null;
    return readBody(req, function (err, data) {
      if (err || !Array.isArray(data)) return sendJSON(res, 400, { error: 'JSON inválido' });

      var bulkCached = idempotencyRecall(bulkIdemKey);
      if (bulkCached) {
        Object.keys(bulkCached.headers).forEach(function (h) { res.setHeader(h, bulkCached.headers[h]); });
        return sendJSON(res, bulkCached.status, bulkCached.body);
      }

      var previousState = articlesStore.readArticlesWithRev(DATA_DIR);
      var validation = runPrePublishValidation(data, previousState.articles);
      if (validation.blocked.length) {
        var blocked422 = {
          ok: false,
          error: 'articulo_no_publicable',
          message: 'No se guardó nada: ' + validation.blocked.length + ' artículo(s) no pasan los controles de publicación. Revisá el detalle de cada uno (campo + motivo) antes de guardar, o guardalos como borrador (status: "draft").',
          blocked: validation.blocked
        };
        idempotencyRemember(bulkIdemKey, 422, blocked422, {});
        return sendJSON(res, 422, blocked422);
      }
      var warnings = validation.warnings;

      var ifMatchHeader = req.headers['if-match'];
      var ifMatchRev = ifMatchHeader ? ifMatchHeader.replace(/^"|"$/g, '') : undefined;

      var result = articlesStore.saveBulkArticles({ dataDir: DATA_DIR, articles: data, ifMatchRev: ifMatchRev, actor: 'panel:' + (req.socket.remoteAddress || '?') });
      if (result.status !== 200) {
        idempotencyRemember(bulkIdemKey, result.status, result.body, {});
        return sendJSON(res, result.status, result.body);
      }

      fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(data), 'utf8');
      var pages = regenerateArticlePages(result.previous, result.saved);

      var bulkEtag = '"' + result.body.rev + '"';
      res.setHeader('ETag', bulkEtag);
      var bulkRespBody = {
        ok: true,
        rev: result.body.rev,
        generated: pages.generated,
        removed: pages.removed,
        errors: pages.errors,
        refreshError: pages.refreshError,
        skippedNoVisibleChange: !!pages.skippedNoVisibleChange,
        warnings: warnings
      };
      idempotencyRemember(bulkIdemKey, 200, bulkRespBody, { ETag: bulkEtag });
      return sendJSON(res, 200, bulkRespBody);
    });
  }
  // Edición o alta de UN solo artículo -- nunca reemplaza el array completo,
  // así una pestaña que solo conoce (o solo tiene actualizado) ese artículo
  // no puede arrastrar consigo al resto. category/slug van en la URL Y en
  // el cuerpo; deben coincidir (chequeo en articles-store.upsertArticle).
  var articleItemMatch = urlPath.match(/^\/api\/articles\/([^\/]+)\/([^\/]+)$/);
  if (articleItemMatch && req.method === 'PUT') {
    var itemCategory = decodeURIComponent(articleItemMatch[1]);
    var itemSlug = decodeURIComponent(articleItemMatch[2]);
    var itemIdemKey = req.headers['x-idempotency-key'] || null;
    return readBody(req, function (err, article) {
      if (err || !article) return sendJSON(res, 400, { error: 'JSON inválido' });

      // Incidente 2026-09-13: si esta clave de idempotencia ya se procesó
      // (doble entrega de red, reintento del navegador, etc.), devolver la
      // respuesta ya calculada -- sin volver a validar, escribir ni
      // regenerar nada. articles-store.upsertArticle ya es idempotente por
      // categoría+slug (esto es una capa extra, más rápida y sin efectos
      // secundarios repetidos).
      var itemCached = idempotencyRecall(itemIdemKey);
      if (itemCached) {
        Object.keys(itemCached.headers).forEach(function (h) { res.setHeader(h, itemCached.headers[h]); });
        return sendJSON(res, itemCached.status, itemCached.body);
      }

      var previousState2 = articlesStore.readArticlesWithRev(DATA_DIR);
      var validation2 = runPrePublishValidation([article], previousState2.articles);
      if (validation2.blocked.length) {
        var itemBlocked422 = { ok: false, error: 'articulo_no_publicable', message: 'El artículo no pasa los controles de publicación.', blocked: validation2.blocked };
        idempotencyRemember(itemIdemKey, 422, itemBlocked422, {});
        return sendJSON(res, 422, itemBlocked422);
      }
      var result2 = articlesStore.upsertArticle({ dataDir: DATA_DIR, category: itemCategory, slug: itemSlug, article: article });
      if (result2.status !== 200) {
        idempotencyRemember(itemIdemKey, result2.status, result2.body, {});
        return sendJSON(res, result2.status, result2.body);
      }
      fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(result2.saved), 'utf8');
      var pages2 = regenerateArticlePages(result2.previous, result2.saved);
      var itemEtag = '"' + result2.body.rev + '"';
      res.setHeader('ETag', itemEtag);
      // Fase 10: se devuelve el registro REALMENTE guardado (después del
      // merge seguro de articles-store.upsertArticle, que puede traer de
      // vuelta campos que el formulario no mandó -- ver ese archivo) para
      // que admin.js pueda refrescar su copia en memoria con el dato
      // completo, en vez de quedarse con el objeto parcial que él mismo
      // armó del formulario.
      var savedArticle2 = result2.saved.find(function (a) { return a.category === article.category && a.slug === article.slug; }) || article;
      var itemRespBody = Object.assign({}, result2.body, { generated: pages2.generated, removed: pages2.removed, errors: pages2.errors, refreshError: pages2.refreshError, skippedNoVisibleChange: !!pages2.skippedNoVisibleChange, savedArticle: savedArticle2 });
      idempotencyRemember(itemIdemKey, 200, itemRespBody, { ETag: itemEtag });
      return sendJSON(res, 200, itemRespBody);
    });
  }
  // Borrado explícito de UN artículo -- exige confirmar título+slug exactos
  // (los tiene que mostrar el panel ANTES de mandar el DELETE), hace backup
  // automático de articulos.json, y mueve el HTML a _trash/ en vez de
  // borrarlo físicamente (recuperable con el restore de abajo).
  if (articleItemMatch && req.method === 'DELETE') {
    var delCategory = decodeURIComponent(articleItemMatch[1]);
    var delSlug = decodeURIComponent(articleItemMatch[2]);
    return readBody(req, function (err, body) {
      if (err) return sendJSON(res, 400, { error: 'JSON inválido' });
      body = body || {};
      var result3 = articlesStore.deleteArticle({
        dataDir: DATA_DIR,
        rootDir: ROOT,
        category: delCategory,
        slug: delSlug,
        confirmTitle: body.confirmTitle,
        confirmSlug: body.confirmSlug
      });
      if (result3.status !== 200) return sendJSON(res, result3.status, result3.body);
      fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(result3.saved), 'utf8');
      var pages3 = regenerateArticlePages(result3.previous, result3.saved);
      return sendJSON(res, 200, Object.assign({}, result3.body, { removed: pages3.removed, refreshError: pages3.refreshError }));
    });
  }
  // Corrección 2026-09-13 (bug real: "Ver" en un artículo en revisión
  // abría categoria/business/....html y devolvía 404, porque esa página
  // pública todavía no existe -- solo se genera al publicar). Este
  // endpoint es la fuente de verdad, consultada por el panel para decidir
  // si de verdad existe el HTML público de cada artículo, en vez de
  // inferirlo (como hacía admin.js antes) de si el artículo tiene body de
  // texto cargado. Se deja AFUERA de GET /api/articles a propósito: ese
  // endpoint devuelve el array tal cual se guarda, y admin.js lo vuelve a
  // mandar completo en cada guardado masivo (POST /api/articles) -- iny
  // ectar acá un campo calculado terminaría escribiéndose sin querer en
  // data/articulos.json en el próximo guardado. Un artículo que no es
  // público ni redirect nunca tiene página real por definición, así que
  // ni se consulta el disco para esos (siempre false, sin fs.existsSync).
  if (urlPath === '/api/articles-html-status' && req.method === 'GET') {
    var statusArticles = articlesStore.readArticlesWithRev(DATA_DIR).articles;
    var htmlStatus = {};
    statusArticles.forEach(function (a) {
      if (!a || !a.category || !a.slug) return;
      var key = a.category + '/' + a.slug;
      if (!pipeline.isPublicArticle(a) && !pipeline.isRedirectArticle(a)) {
        htmlStatus[key] = false;
        return;
      }
      try {
        var htmlPath = articlesStore.articleHtmlPath(ROOT, a.category, a.slug);
        htmlStatus[key] = !!htmlPath && fs.existsSync(htmlPath);
      } catch (e) {
        htmlStatus[key] = false;
      }
    });
    return sendJSON(res, 200, htmlStatus);
  }
  // Vista previa segura de UN artículo sin publicarlo. Requisito explícito
  // del pedido: "sin agregarlo al sitemap, portada, categorías, buscador,
  // articulos.js, AdSense ni archivos públicos" -- por eso esta ruta es un
  // GET de solo lectura que arma el HTML en memoria (pagegen.buildArticleHtml
  // / buildRedirectHtml, ambas puras) y lo manda directo como respuesta,
  // sin escribir NADA en disco ni llamar a regenerateArticlePages/
  // writeSitemap/generateArticulosJs. No cambia article.status ni
  // editorialApproval (no los toca para nada -- ni siquiera los lee para
  // decidir el flujo, salvo para elegir entre plantilla de artículo o de
  // redirect). Funciona para cualquier estado editorial (draft/review/
  // approved/published/redirected): para "published" simplemente muestra
  // el mismo HTML que ya está publicado (con el aviso de vista previa
  // igual, ya que esta ruta nunca es la URL pública real).
  var previewMatch = urlPath.match(/^\/api\/preview\/([^\/]+)\/([^\/]+)$/);
  if (previewMatch && req.method === 'GET') {
    var previewCategory = decodeURIComponent(previewMatch[1]);
    var previewSlug = decodeURIComponent(previewMatch[2]);
    try {
      // Reutiliza articleHtmlPath solo para validar los segmentos de la URL
      // (assertSafeSegment interno) sin duplicar esa regex acá -- el path
      // que devuelve no se usa para nada, la vista previa nunca lee ni
      // escribe el HTML público real.
      articlesStore.articleHtmlPath(ROOT, previewCategory, previewSlug);
    } catch (e) {
      return sendHtmlError(res, 400, 'Categoría o slug inválido.');
    }
    var previewArticles = articlesStore.readArticlesWithRev(DATA_DIR).articles;
    var previewArticle = previewArticles.find(function (a) {
      return a && a.category === previewCategory && a.slug === previewSlug;
    });
    if (!previewArticle) {
      return sendHtmlError(res, 404, 'No se encontró ningún artículo en "' + previewCategory + '/' + previewSlug + '".');
    }
    try {
      var previewHtml;
      if (pipeline.isRedirectArticle(previewArticle)) {
        previewHtml = pagegen.buildRedirectHtml(previewArticle, previewArticles, { preview: true });
      } else if (typeof previewArticle.body === 'string' && previewArticle.body.trim()) {
        previewHtml = pagegen.buildArticleHtml(previewArticle, { preview: true });
      } else {
        return sendHtmlError(res, 404, 'Este artículo todavía no tiene contenido para previsualizar.');
      }
    } catch (e) {
      return sendHtmlError(res, 500, 'No se pudo generar la vista previa: ' + e.message);
    }
    var previewBody = Buffer.from(previewHtml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': previewBody.length,
      // Nunca cachear una vista previa -- el artículo puede cambiar de un
      // guardado al otro y siempre tiene que reflejar el estado actual.
      'Cache-Control': 'no-store'
    });
    return res.end(previewBody);
  }
  if (urlPath === '/api/trash' && req.method === 'GET') {
    return sendJSON(res, 200, articlesStore.readTrash(DATA_DIR));
  }
  var restoreMatch = urlPath.match(/^\/api\/articles\/([^\/]+)\/([^\/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    var resCategory = decodeURIComponent(restoreMatch[1]);
    var resSlug = decodeURIComponent(restoreMatch[2]);
    var result4 = articlesStore.restoreArticle({ dataDir: DATA_DIR, rootDir: ROOT, category: resCategory, slug: resSlug });
    if (result4.status !== 200) return sendJSON(res, result4.status, result4.body);
    fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(result4.saved), 'utf8');
    var pages4 = regenerateArticlePages(result4.previous, result4.saved);
    return sendJSON(res, 200, Object.assign({}, result4.body, { generated: pages4.generated, refreshError: pages4.refreshError }));
  }
  // "Chequeo en vivo" para el checklist del panel (fase 9): corre EXACTAMENTE
  // la misma validación que el guardado real (runPrePublishValidation), pero
  // sin escribir absolutamente nada -- ni articulos.json, ni .js, ni páginas
  // HTML, ni sitemap. Recibe { articles: [...todo el array, como quedaría si
  // se guardara ahora...], slug: '<el que se está editando>' } y devuelve el
  // detalle de ESE artículo puntual (además del array completo, por si hace
  // falta). El panel lo llama mientras se completa el formulario para pintar
  // el checklist ANTES de tocar "Guardar" -- pero el botón "Guardar" sigue
  // yendo por POST /api/articles con su propio 422, así que un checklist
  // desactualizado (ej. por no haber corrido este chequeo) nunca deja pasar
  // un artículo que no cumple: esto es una vista previa, no el gate real.
  if (urlPath === '/api/validate-article' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !Array.isArray(data.articles)) return sendJSON(res, 400, { error: 'JSON inválido' });

      var articlesFile = path.join(DATA_DIR, 'articulos.json');
      var previous = [];
      try { previous = readJSON(articlesFile); } catch (e) { previous = []; }

      var validation = runPrePublishValidation(data.articles, previous);
      var slug = data.slug;
      var blockedForSlug = slug ? validation.blocked.find(function (b) { return b.slug === slug; }) : null;
      var warningsForSlug = slug ? validation.warnings.find(function (w) { return w.slug === slug; }) : null;
      return sendJSON(res, 200, {
        ok: true,
        issues: blockedForSlug ? blockedForSlug.issues : [],
        warnings: warningsForSlug ? warningsForSlug.warnings : []
      });
    });
  }
  if (urlPath === '/api/drafts' && req.method === 'GET') {
    var drafts = [];
    try { drafts = readJSON(path.join(DATA_DIR, 'drafts.json')); } catch (e) { drafts = []; }
    // Auditoría 2026-09-13: el riesgo (promocional/vencido/categoría no
    // habilitada/similaridad) se recalcula acá, en cada lectura, en vez
    // de confiar en un campo guardado en el JSON en el momento de
    // fetchNewDrafts() -- "vencido" es relativo a HOY, así que un
    // borrador que hace unos días todavía era válido puede necesitar
    // mostrarse bloqueado ahora sin que nadie lo haya vuelto a tocar
    // (ver pipeline.classifyDraft y la prueba B del incidente).
    // Puntuación editorial (2026-09-20): classifyDraft ahora también
    // recibe los artículos YA publicados para poder marcar duplicados
    // reales/contradicciones graves (isDuplicate/hasGraveContradiction) --
    // se leen acá, frescos, por el mismo motivo que "vencido": un
    // borrador puede volverse "duplicado" recién después de publicarse
    // otro artículo sobre lo mismo, sin que nadie haya vuelto a tocar
    // este borrador.
    var publishedForRisk = articlesStore.readArticlesWithRev(DATA_DIR).articles;
    var annotated = drafts.map(function (d) {
      var risk;
      try { risk = pipeline.classifyDraft(d, publishedForRisk); } catch (e) { risk = null; }
      var copy = {};
      Object.keys(d).forEach(function (k) { copy[k] = d[k]; });
      copy.risk = risk;
      return copy;
    });
    return sendJSON(res, 200, annotated);
  }
  // Chequeo manual de "¿esta fuente todavía responde?" (requisito 10 de la
  // mejora global, 2026-09-20) -- a diferencia del chequeo automático que
  // ya corre solo para candidatos de RSS antes de redactar un borrador
  // (ver pipeline.buildCandidates), este endpoint es para cuando alguien
  // carga o edita una fuente A MANO en el panel: NO se corre solo en cada
  // guardado (una fuente real puede fallar por una caída momentánea, y no
  // queremos que eso bloquee guardar un borrador legítimo) -- lo dispara
  // el botón "Verificar fuente" del formulario, bajo demanda.
  if (urlPath === '/api/check-source' && req.method === 'GET') {
    var checkUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
    if (!checkUrl || !/^https?:\/\//i.test(checkUrl)) {
      return sendJSON(res, 400, { error: 'Falta una URL http(s) válida en ?url=' });
    }
    pipeline.checkUrlReachable(checkUrl).then(function (result) {
      sendJSON(res, 200, result);
    }).catch(function (e) {
      sendJSON(res, 200, { reachable: true, uncertain: true, error: e.message });
    });
    return;
  }
  if (urlPath === '/api/fetch-drafts' && req.method === 'POST') {
    pipeline.fetchNewDrafts().then(function (result) {
      sendJSON(res, 200, result);
    }).catch(function (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    });
    return;
  }
  // Requisito 16 (corroboración previa a la redacción, 2026-09-20): botón
  // manual "Buscar segunda fuente" en un borrador que quedó en "Requiere
  // revisión" por falta de corroboración -- reintenta SOLO la búsqueda de
  // fuente, sin regenerar el borrador ni volver a llamar a la IA. Usa
  // exactamente la misma lógica que la corrida automática (ver
  // pipeline.findAdditionalSourceForDraft/findCorroborationForItem); si
  // no encuentra nada, el borrador queda igual (nunca inventa una fuente).
  if (urlPath === '/api/drafts/find-source' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) return sendJSON(res, 400, { error: 'Falta el slug del borrador' });
      pipeline.findAdditionalSourceForDraft(data.slug).then(function (result) {
        // Regresión cerrada (pedido de Leonardo, 2026-09-23): admin.js
        // REEMPLAZA el borrador entero en pantalla por result.draft (ver
        // draftsData.map en admin.js) -- sin esto, ese draft.draft nunca
        // traía "risk" (eso antes solo lo calculaba GET /api/drafts), así
        // que la tarjeta se quedaba sin la insignia de puntaje ni "Ver por
        // qué" hasta el próximo refresco completo de la lista. Se calcula
        // acá con los mismos artículos publicados frescos que usa GET
        // /api/drafts, nunca un valor guardado de antes.
        if (result && result.draft) {
          var publishedForRisk = [];
          try { publishedForRisk = articlesStore.readArticlesWithRev(DATA_DIR).articles; } catch (e) { publishedForRisk = []; }
          try { result.draft.risk = pipeline.classifyDraft(result.draft, publishedForRisk); } catch (e) { result.draft.risk = null; }
        }
        sendJSON(res, result.ok ? 200 : 404, result);
      }).catch(function (e) {
        sendJSON(res, 500, { ok: false, error: e.message });
      });
    });
  }
  // Botón manual "Generar imagen" (pedido de Leonardo, 2026-09-27, punto 4):
  // desde que la imagen automática pasó a depender de que el borrador quede
  // "listo" (ver pipeline.runFetchNewDrafts), un borrador en "revisar" se
  // guarda con image:null y necesita este botón para completarla a demanda
  // -- UNA sola llamada real de IA por clic, nunca un reintento automático
  // si falla (mismo criterio que find-source arriba).
  if (urlPath === '/api/drafts/generate-image' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) return sendJSON(res, 400, { error: 'Falta el slug del borrador' });
      var cfg;
      try { cfg = JSON.parse(fs.readFileSync(path.join(ADMIN_DIR, 'config.json'), 'utf8')); } catch (e) { cfg = {}; }
      pipeline.generateDraftImageManually(data.slug, cfg).then(function (result) {
        if (result && result.draft) {
          var publishedForRisk = [];
          try { publishedForRisk = articlesStore.readArticlesWithRev(DATA_DIR).articles; } catch (e) { publishedForRisk = []; }
          try { result.draft.risk = pipeline.classifyDraft(result.draft, publishedForRisk); } catch (e) { result.draft.risk = null; }
        }
        sendJSON(res, result.ok ? 200 : 404, result);
      }).catch(function (e) {
        sendJSON(res, 500, { ok: false, error: e.message });
      });
    });
  }
  // Requisito 19 (pedido de Leonardo, 2026-09-23): polling de progreso para
  // el botón "Buscar noticias nuevas" -- el panel consulta esto cada tanto
  // MIENTRAS espera la respuesta de POST /api/fetch-drafts, para mostrar en
  // qué parte del proceso está en vez de un mensaje fijo genérico. Nunca
  // dispara nada por sí solo -- es de solo lectura sobre un estado en
  // memoria de proceso (pipeline.getFetchStatus()), nunca persistido.
  if (urlPath === '/api/fetch-drafts/status' && req.method === 'GET') {
    return sendJSON(res, 200, pipeline.getFetchStatus());
  }
  if (urlPath === '/api/drafts' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) return sendJSON(res, 400, { error: 'Falta el slug del borrador' });
      // used=true: se publicó el borrador (solo se saca de la lista).
      // used=false (default): se descartó (se saca Y se recuerda la fuente
      // para no volver a sugerirla en la próxima búsqueda).
      var removed = data.used ? pipeline.removeDraft(data.slug) : pipeline.discardDraft(data.slug);
      return sendJSON(res, 200, { ok: true, removed: removed });
    });
  }
  if (urlPath === '/api/deploy' && req.method === 'POST') {
    deploy.deploy('Actualización desde el panel de administración — ' + new Date().toISOString())
      .then(function (result) { sendJSON(res, result.ok ? 200 : 500, result); })
      .catch(function (e) { sendJSON(res, 500, { ok: false, error: e.message }); });
    return;
  }
  if (urlPath === '/api/regenerate' && req.method === 'POST') {
    var py = spawn('python', [path.join(ADMIN_DIR, 'generate_pages.py')], { cwd: ROOT });
    var out = '';
    py.stdout.on('data', function (d) { out += d.toString('utf8'); });
    py.stderr.on('data', function (d) { out += d.toString('utf8'); });
    py.on('error', function (e) {
      sendJSON(res, 500, { ok: false, error: 'No se pudo ejecutar Python: ' + e.message });
    });
    py.on('close', function (code) {
      sendJSON(res, code === 0 ? 200 : 500, { ok: code === 0, output: out });
    });
    return;
  }

  // ---- Redes sociales (Instagram) ----
  if (urlPath === '/api/social/status' && req.method === 'GET') {
    return sendJSON(res, 200, { instagram: social.getStatus() });
  }
  if (urlPath === '/api/social/config' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.instagram) {
        return sendJSON(res, 400, { error: 'Faltan los datos de conexión' });
      }
      try {
        social.saveConfigPatch(data.instagram);
        return sendJSON(res, 200, { ok: true, instagram: social.getStatus() });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/social/log' && req.method === 'GET') {
    return sendJSON(res, 200, social.loadLog());
  }
  if (urlPath === '/api/social/instagram/publish' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug || !data.caption) {
        return sendJSON(res, 400, { error: 'Falta el artículo o el texto de la publicación' });
      }
      var articles = [];
      try { articles = readJSON(path.join(DATA_DIR, 'articulos.json')); } catch (e) { articles = []; }
      var article = articles.find(function (a) { return a.slug === data.slug; });
      if (!article) return sendJSON(res, 404, { error: 'No se encontró ese artículo' });
      if (!article.image) return sendJSON(res, 400, { error: 'Este artículo no tiene imagen de portada' });

      social.publishToInstagram({
        imageUrl: social.publicImageUrl(article.image),
        caption: data.caption
      }).then(function (result) {
        social.logPublish(data.slug, result.mediaId);
        return sendJSON(res, 200, { ok: true, mediaId: result.mediaId });
      }).catch(function (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      });
    });
  }

  // ---- Sprint de 14 días (crecimiento en Instagram) ----
  if (urlPath === '/api/sprint/status' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, sprint.getStatus());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/sprint/start' && req.method === 'POST') {
    return sendJSON(res, 200, { ok: true, log: sprint.startSprint() });
  }
  if (urlPath === '/api/sprint/reset' && req.method === 'POST') {
    return sendJSON(res, 200, { ok: true, log: sprint.resetSprint() });
  }
  if (urlPath === '/api/sprint/mark-reel' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day) return sendJSON(res, 400, { error: 'Falta el día' });
      var entry = sprint.markDayDone(data.day, { type: 'reel', postUrl: data.postUrl || null });
      return sendJSON(res, 200, { ok: true, entry: entry });
    });
  }
  if (urlPath === '/api/sprint/toggle-story' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day || data.index == null) return sendJSON(res, 400, { error: 'Faltan datos' });
      var entry = sprint.toggleStory(data.day, data.index);
      return sendJSON(res, 200, { ok: true, entry: entry });
    });
  }
  if (urlPath === '/api/sprint/kpi' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day || data.pct == null) return sendJSON(res, 400, { error: 'Faltan datos' });
      var result = sprint.saveKpi(data.day, Number(data.pct));
      return sendJSON(res, 200, { ok: true, entry: result.entry, verdict: result.verdict });
    });
  }
  if (urlPath === '/api/sprint/carousel/generate' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day) return sendJSON(res, 400, { error: 'Falta el día' });
      var plan = sprint.loadPlan();
      var dayPlan = plan.days.find(function (d) { return d.day === data.day; });
      if (!dayPlan || dayPlan.format !== 'carousel') return sendJSON(res, 400, { error: 'Ese día no es un carrusel' });
      var cfg = readJSON(CONFIG_FILE);
      carouselGen.generateCarouselImages(dayPlan, cfg).then(function (images) {
        return sendJSON(res, 200, { ok: true, images: images, postTitle: dayPlan.postTitle, caption: dayPlan.caption });
      }).catch(function (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      });
    });
  }
  if (urlPath === '/api/sprint/carousel/publish' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day || !data.caption) return sendJSON(res, 400, { error: 'Faltan datos' });
      var dayDir = path.join(IMG_DIR, 'carousels', 'day-' + data.day);
      var files;
      try {
        files = fs.readdirSync(dayDir).filter(function (f) { return /^slide-\d+\.jpg$/.test(f); })
          .sort(function (a, b) { return parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10); });
      } catch (e) {
        return sendJSON(res, 400, { error: 'No hay imágenes generadas para este día. Generá el carrusel primero.' });
      }
      if (!files.length) return sendJSON(res, 400, { error: 'No hay imágenes generadas para este día. Generá el carrusel primero.' });

      var relPaths = files.map(function (f) { return 'img/carousels/day-' + data.day + '/' + f; });
      var cacheBust = Date.now();
      var publicUrls = relPaths.map(function (p) { return social.publicImageUrl(p, cacheBust); });

      deploy.deploy('Sprint día ' + data.day + ' — carrusel generado desde el panel')
        .then(function (deployResult) {
          if (!deployResult.ok) throw new Error('No se pudo publicar los cambios al sitio: ' + deployResult.output.slice(-300));
          return Promise.all(publicUrls.map(function (u) { return social.waitUntilPublic(u, 30, 4000); }));
        })
        .then(function () {
          return social.publishCarouselToInstagram({ imageUrls: publicUrls, caption: data.caption });
        })
        .then(function (result) {
          sprint.markDayDone(data.day, { type: 'carousel', mediaId: result.mediaId });
          return sendJSON(res, 200, { ok: true, mediaId: result.mediaId });
        })
        .catch(function (e) {
          return sendJSON(res, 500, { ok: false, error: e.message });
        });
    });
  }

  // ---- Editor visual de niveles de Gravity Flip ----
  if (urlPath === '/api/gravity-levels' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.listLevels());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-level' && req.method === 'GET') {
    var levelId = new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!levelId) return sendJSON(res, 400, { error: 'Falta el id del nivel' });
    try {
      return sendJSON(res, 200, gravityEditor.loadLevel(levelId));
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-levels/reorder' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !Array.isArray(data.order) || !data.order.length) {
        return sendJSON(res, 400, { error: 'Falta el nuevo orden de niveles' });
      }
      try {
        gravityEditor.reorderLevels(data.order);
        return sendJSON(res, 200, { ok: true, levels: gravityEditor.listLevels() });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-level/verify' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.id || !Array.isArray(data.objects)) {
        return sendJSON(res, 400, { error: 'Faltan datos del nivel a verificar' });
      }
      try {
        var result = gravityEditor.verifyLevel(data.id, data, 90 * 1000);
        return sendJSON(res, 200, { ok: true, result: result });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-level/save' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.id || !Array.isArray(data.objects)) {
        return sendJSON(res, 400, { error: 'Faltan datos del nivel a guardar' });
      }
      try {
        gravityEditor.saveLevel(data.id, data);
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-level/create' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.name) return sendJSON(res, 400, { error: 'Falta el nombre del nivel' });
      try {
        var created = gravityEditor.createLevel(data.name);
        return sendJSON(res, 200, { ok: true, level: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-assets' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.listAssets());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-asset' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.key || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos del sprite a subir' });
      }
      try {
        var savedUrl = gravityEditor.saveAsset(data.key, data.dataBase64);
        return sendJSON(res, 200, { ok: true, url: savedUrl });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-variant-counts' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.getVariantCounts());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-asset/add-variant' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.base || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos de la variante nueva' });
      }
      try {
        var created = gravityEditor.addVariant(data.base, data.dataBase64);
        return sendJSON(res, 200, { ok: true, variant: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-backgrounds' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.listBackgrounds());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-background' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Falta la imagen del fondo' });
      }
      try {
        var file = gravityEditor.addBackground(data.dataBase64, data.ext);
        return sendJSON(res, 200, { ok: true, file: file });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }

  // ---- Preview del sitio real ----
  if (urlPath === '/site' || urlPath === '/site/') {
    return serveStaticFile(res, path.join(ROOT, 'index.html'));
  }
  if (urlPath.indexOf('/site/') === 0) {
    var sitePath = safeJoin(ROOT, urlPath.slice('/site/'.length));
    if (sitePath) return serveStaticFile(res, sitePath);
  }

  // ---- Panel de administración ----
  if (urlPath === '/' || urlPath === '') {
    return serveStaticFile(res, path.join(ADMIN_DIR, 'index.html'));
  }
  var adminPath = safeJoin(ADMIN_DIR, urlPath.slice(1));
  if (adminPath && fs.existsSync(adminPath)) {
    return serveStaticFile(res, adminPath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

// '127.0.0.1' explícito (auditoría 2026-09-12, pedido del usuario: "el panel
// escucha únicamente en localhost/127.0.0.1, no en 0.0.0.0"): sin un host
// explícito, Node por defecto escucha en TODAS las interfaces de red (el
// equivalente a 0.0.0.0/::), no solo loopback -- esto significa que
// cualquier otra máquina en la misma red Wi-Fi/LAN podía llegar a este
// panel (que puede editar artículos, subir imágenes y disparar
// "Publicar cambios") con solo saber la IP local de esta computadora.
// Nunca fue intencional; se corrige acá restringiendo el bind a loopback.
server.listen(PORT, '127.0.0.1', function () {
  console.log('');
  console.log('  VexlowHQ — Panel de administración');
  console.log('  Abrí esto en tu navegador: http://localhost:' + PORT + ' (o http://127.0.0.1:' + PORT + ' si "localhost" no cargara)');
  console.log('  Vista previa del sitio:    http://localhost:' + PORT + '/site/');
  console.log('  Solo accesible desde esta computadora (no desde la red local).');
  console.log('  (Para cerrar el panel, cerrá esta ventana o presioná Ctrl+C)');
  console.log('');
});
