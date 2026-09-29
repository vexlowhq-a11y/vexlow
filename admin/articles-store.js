/*
  articles-store.js — capa segura de lectura/escritura de data/articulos.json
  ============================================================================
  Fase "post-incidente 2026-09-13": el 12/13 de septiembre, un guardado desde
  una pestaña vieja del panel (con una copia en memoria de un estado anterior
  del sitio) pisó por completo data/articulos.json vía POST /api/articles,
  que hacía writeJSON(articulos.json, data) sin comparar contra lo que había
  en disco. Eso borró 28 artículos reales (y sus páginas HTML, porque el
  mismo endpoint borra el HTML de cualquier artículo que estaba en la versión
  previa pero no viene en el array recién enviado). El array enviado por esa
  pestaña era legítimo -- el usuario sí quiso borrar artículos sin imagen --
  pero el mecanismo (reemplazo completo y ciego del conjunto, sin control de
  concurrencia ni de alcance) es el problema: cualquier otra pestaña vieja
  puede repetir el mismo daño sin querer.

  Este módulo aísla toda la lógica de lectura/escritura de articulos.json
  para que:
    1. Cada guardado masivo (POST /api/articles, "Guardar" del panel) lleve
       control de revisión (ETag/If-Match) y NUNCA pueda reducir el total de
       artículos -- reducir el conjunto solo se permite a través del
       endpoint de borrado individual, explícito y confirmado.
    2. Cada edición de UN artículo pueda hacerse sin reenviar los otros 168
       (PUT /api/articles/:category/:slug), así una pestaña desactualizada
       en los demás artículos no pueda arrastrarlos a un guardado.
    3. Borrar sea una acción propia (DELETE /api/articles/:category/:slug),
       con confirmación de título/slug, papelera recuperable (data/trash.json
       + el HTML movido a _trash/, nunca fs.unlinkSync directo) y backup
       automático previo.
    4. Toda escritura de articulos.json sea atómica (archivo temporal +
       rename) para que un crash a mitad de escritura no dañe el archivo.

  Diseñado para poder testearse con datasets sintéticos en un directorio
  temporal aislado (ver test-data-integrity.js) -- todas las funciones acá
  reciben las rutas (dataDir/rootDir) como parámetro, nunca asumen las del
  sitio real.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Validación de category/slug -- se usan para construir rutas de archivo
// (categoria/<category>/<slug>.html, _trash/<category>/<slug>.html), así
// que tienen que quedar restringidos a algo que nunca pueda salirse de esa
// carpeta ("../../etc/passwd", separadores, nulos, etc.). Mismo alfabeto
// que ya usa pagegen.slugify() para generar slugs nuevos (minúsculas,
// dígitos y guiones), así que un slug/categoría legítimo siempre pasa esto.
// ---------------------------------------------------------------------------
// Se permite un guion final (16 de los 141 slugs reales del sitio son un
// título truncado a un largo fijo que a veces corta justo después de un
// guion, ej. "...rich-paul-confirms-"). Lo que nunca se permite son
// puntos, barras, backslashes o cualquier otro caracter -- eso es lo que
// bloquea un "../../etc/passwd" o similar.
var SAFE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]*)*$/;

function assertSafeSegment(value, label) {
  if (typeof value !== 'string' || !value || !SAFE_SEGMENT.test(value)) {
    var err = new Error('"' + label + '" inválido: solo se permiten minúsculas, dígitos y guiones (recibido: ' + JSON.stringify(value) + ').');
    err.code = 'invalid_segment';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Serialización canónica + revisión
// ---------------------------------------------------------------------------

// JSON.stringify con el mismo formato que ya usa server.js (writeJSON), para
// que el rev calculado coincida con lo que efectivamente queda en disco.
function serialize(articles) {
  return JSON.stringify(articles, null, 2) + '\n';
}

function computeRev(articles) {
  return crypto.createHash('sha256').update(serialize(articles)).digest('hex');
}

function articulosPath(dataDir) {
  return path.join(dataDir, 'articulos.json');
}

function readArticlesWithRev(dataDir) {
  var file = articulosPath(dataDir);
  var raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { articles: [], rev: computeRev([]) };
  }
  var articles;
  try {
    articles = JSON.parse(raw);
  } catch (e) {
    throw new Error('articulos.json actual es JSON inválido -- no se puede operar con seguridad: ' + e.message);
  }
  // El rev se calcula sobre el CONTENIDO tal como se leyó (no sobre una
  // re-serialización propia), para detectar hasta un cambio manual del
  // archivo hecho fuera del panel. Si el archivo en disco no está en el
  // formato canónico (indent 2 + \n final), igual funciona: el rev es un
  // hash de bytes reales, no de la forma "esperada".
  var rev = crypto.createHash('sha256').update(raw).digest('hex');
  return { articles: articles, rev: rev };
}

// ---------------------------------------------------------------------------
// Escritura atómica
// ---------------------------------------------------------------------------

function writeFileAtomic(file, contents) {
  var dir = path.dirname(file);
  var tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.writeFileSync(tmp, contents, 'utf8');
  // fsync del archivo temporal antes del rename -- minimiza la ventana en la
  // que un corte de luz podría dejar datos a medio escribir en el tmp (el
  // rename en sí ya es atómico a nivel de sistema de archivos).
  try {
    var fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (e) { /* best-effort */ }
  fs.renameSync(tmp, file);
}

function writeArticlesAtomic(dataDir, articles) {
  writeFileAtomic(articulosPath(dataDir), serialize(articles));
  return computeRev(articles);
}

// ---------------------------------------------------------------------------
// Backups automáticos (antes de CUALQUIER escritura real a articulos.json)
// ---------------------------------------------------------------------------

function backupArticles(dataDir) {
  var src = articulosPath(dataDir);
  if (!fs.existsSync(src)) return null;
  var backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  var stamp = new Date().toISOString().replace(/[:.]/g, '-');
  var dest = path.join(backupDir, 'articulos.' + stamp + '.json');
  fs.copyFileSync(src, dest);
  pruneBackups(backupDir, 20);
  return dest;
}

function pruneBackups(backupDir, keep) {
  var files = fs.readdirSync(backupDir)
    .filter(function (f) { return /^articulos\..*\.json$/.test(f); })
    .map(function (f) { return { f: f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }; })
    .sort(function (a, b) { return b.t - a.t; });
  files.slice(keep).forEach(function (entry) {
    try { fs.unlinkSync(path.join(backupDir, entry.f)); } catch (e) { /* no crítico */ }
  });
}

// ---------------------------------------------------------------------------
// Log de operaciones (sin secretos: fecha, operación, slug, conteos)
// ---------------------------------------------------------------------------

function appendOpLog(dataDir, entry) {
  var file = path.join(dataDir, 'ops-log.jsonl');
  var line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n';
  fs.appendFileSync(file, line, 'utf8');
}

// ---------------------------------------------------------------------------
// Guardado masivo (POST /api/articles) -- CON control de revisión y SIN
// permitir jamás una reducción del conjunto.
// ---------------------------------------------------------------------------

// Devuelve { status, body } listo para responder por HTTP. status 200 es
// éxito; 409 es conflicto (revisión vieja O intento de reducir el conjunto);
// 400 es payload inválido.
function saveBulkArticles(opts) {
  var dataDir = opts.dataDir;
  var articles = opts.articles;
  var ifMatchRev = opts.ifMatchRev; // puede venir undefined (cliente viejo)
  var actor = opts.actor || 'admin-panel';

  if (!Array.isArray(articles)) {
    return { status: 400, body: { error: 'payload_invalido', message: 'Se esperaba un array de artículos.' } };
  }

  var current = readArticlesWithRev(dataDir);

  // 1) Control de concurrencia optimista: si el cliente declaró desde qué
  //    revisión partió y esa revisión ya no es la actual, alguien (u otra
  //    pestaña) guardó primero -- se rechaza y se exige recargar. Esto es lo
  //    que hubiera evitado el incidente si la pestaña vieja hubiera avisado
  //    su revisión base.
  if (ifMatchRev && ifMatchRev !== current.rev) {
    return {
      status: 409,
      body: {
        error: 'revision_conflict',
        message: 'El artículo/listado cambió en el servidor desde que esta pestaña cargó los datos. Recargá el panel antes de guardar para no pisar cambios ajenos.',
        currentRev: current.rev,
        yourRev: ifMatchRev
      }
    };
  }

  // 2) Defensa en profundidad, INDEPENDIENTE de si el cliente manda revisión
  //    o no: un guardado masivo normal jamás debe reducir el conjunto de
  //    artículos. Bajar el total es indicio directo de una pestaña
  //    desactualizada (o de un bug) pisando artículos que ya no conoce.
  //    Borrar de verdad un artículo tiene que pasar por deleteArticle(),
  //    que es explícito, pide confirmación y va a papelera.
  if (articles.length < current.articles.length) {
    var currentSlugs = new Set(current.articles.map(function (a) { return a.category + '/' + a.slug; }));
    var newSlugs = new Set(articles.map(function (a) { return a.category + '/' + a.slug; }));
    var missing = [];
    currentSlugs.forEach(function (key) { if (!newSlugs.has(key)) missing.push(key); });
    return {
      status: 409,
      body: {
        error: 'reduccion_no_permitida',
        message: 'Este guardado eliminaría ' + missing.length + ' artículo(s) del listado (' + current.articles.length + ' → ' + articles.length + '). Un guardado normal nunca borra artículos -- usá "Eliminar artículo" en cada uno, con confirmación, si de verdad querés borrarlos.',
        wouldRemove: missing,
        currentCount: current.articles.length,
        attemptedCount: articles.length
      }
    };
  }

  var backupPath = backupArticles(dataDir);
  var newRev = writeArticlesAtomic(dataDir, articles);
  appendOpLog(dataDir, {
    op: 'bulk_save',
    actor: actor,
    countBefore: current.articles.length,
    countAfter: articles.length,
    prevRev: current.rev,
    newRev: newRev,
    backup: backupPath
  });

  return { status: 200, body: { ok: true, rev: newRev }, previous: current.articles, saved: articles };
}

// ---------------------------------------------------------------------------
// Edición/alta de UN artículo -- nunca reemplaza el array completo.
// ---------------------------------------------------------------------------

function upsertArticle(opts) {
  var dataDir = opts.dataDir;
  var category = opts.category;
  var slug = opts.slug;
  var article = opts.article;
  var actor = opts.actor || 'admin-panel';

  try {
    assertSafeSegment(category, 'category');
    assertSafeSegment(slug, 'slug');
  } catch (e) {
    return { status: 400, body: { error: 'segmento_invalido', message: e.message } };
  }
  if (!article || typeof article !== 'object') {
    return { status: 400, body: { error: 'payload_invalido', message: 'Falta el artículo a guardar.' } };
  }
  // La URL identifica el artículo ORIGINAL (para encontrar cuál reemplazar
  // -- clave estable mientras se edita), el cuerpo puede traer una
  // category/slug NUEVA si el usuario renombró/recategorizó el artículo
  // desde el formulario. Si el cuerpo trae una identidad distinta, se
  // valida por separado que no choque con otro artículo ya existente.
  try {
    assertSafeSegment(article.category, 'category (del cuerpo)');
    assertSafeSegment(article.slug, 'slug (del cuerpo)');
  } catch (e) {
    return { status: 400, body: { error: 'segmento_invalido', message: e.message } };
  }

  var current = readArticlesWithRev(dataDir);
  var idx = current.articles.findIndex(function (a) { return a.category === category && a.slug === slug; });
  var isNew = idx === -1;
  var renamed = !isNew && (article.category !== category || article.slug !== slug);

  if (renamed || isNew) {
    var collisionIdx = current.articles.findIndex(function (a, i) { return i !== idx && a.category === article.category && a.slug === article.slug; });
    if (collisionIdx !== -1) {
      return { status: 409, body: { error: 'ya_existe', message: 'Ya existe otro artículo en ' + article.category + '/' + article.slug + ' -- elegí otro slug/categoría.' } };
    }
  }

  var next = current.articles.slice();
  if (isNew) {
    next.push(article);
  } else {
    // Fase 10 -- corrección real (2026-09-20): esto era `next[idx] = article`,
    // un reemplazo TOTAL del registro guardado. admin/admin.js arma `article`
    // desde un objeto fijo de campos leídos del formulario -- cualquier
    // metadato real que el formulario no conozca (en su momento: sourceUrl,
    // sourceTitle, additionalSources; también topic/subtopic, que ni
    // siquiera tienen control en el panel) simplemente no viaja en el
    // payload, y con un reemplazo total eso significaba borrarlo en
    // silencio de articulos.json con solo abrir y guardar ese artículo sin
    // tocar nada. El merge (base = registro existente, override = lo que
    // mandó el formulario) preserva cualquier campo no incluido en el
    // payload, mientras que un campo si incluido -- aunque sea null o ''
    // a propósito -- sigue pudiendo limpiarse sin problema, porque
    // Object.assign siempre le da prioridad al override sobre la base.
    next[idx] = Object.assign({}, current.articles[idx], article);
  }

  var backupPath = backupArticles(dataDir);
  var newRev = writeArticlesAtomic(dataDir, next);
  appendOpLog(dataDir, {
    op: isNew ? 'article_create' : 'article_update',
    actor: actor,
    category: category,
    slug: slug,
    prevRev: current.rev,
    newRev: newRev,
    backup: backupPath
  });

  return { status: 200, body: { ok: true, rev: newRev, created: isNew }, previous: current.articles, saved: next };
}

// ---------------------------------------------------------------------------
// Borrado explícito -- confirmación obligatoria + papelera recuperable.
// Nunca borra el HTML físicamente: lo mueve a rootDir/_trash/<categoria>/.
// ---------------------------------------------------------------------------

function trashJsonPath(dataDir) {
  return path.join(dataDir, 'trash.json');
}

function readTrash(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(trashJsonPath(dataDir), 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeTrash(dataDir, trash) {
  writeFileAtomic(trashJsonPath(dataDir), JSON.stringify(trash, null, 2) + '\n');
}

function articleHtmlPath(rootDir, category, slug) {
  assertSafeSegment(category, 'category');
  assertSafeSegment(slug, 'slug');
  return path.join(rootDir, 'categoria', category, slug + '.html');
}

function trashHtmlPath(rootDir, category, slug) {
  assertSafeSegment(category, 'category');
  assertSafeSegment(slug, 'slug');
  return path.join(rootDir, '_trash', category, slug + '.html');
}

function deleteArticle(opts) {
  var dataDir = opts.dataDir;
  var rootDir = opts.rootDir;
  var category = opts.category;
  var slug = opts.slug;
  var confirmTitle = opts.confirmTitle;
  var confirmSlug = opts.confirmSlug;
  var actor = opts.actor || 'admin-panel';

  try {
    assertSafeSegment(category, 'category');
    assertSafeSegment(slug, 'slug');
  } catch (e) {
    return { status: 400, body: { error: 'segmento_invalido', message: e.message } };
  }

  var current = readArticlesWithRev(dataDir);
  var idx = current.articles.findIndex(function (a) { return a.category === category && a.slug === slug; });
  if (idx === -1) {
    return { status: 404, body: { error: 'no_encontrado', message: 'No existe ' + category + '/' + slug + '.' } };
  }
  var article = current.articles[idx];

  // Confirmación obligatoria: quien borra tiene que "ver" el título/slug real
  // y reenviarlos exactamente -- evita un DELETE disparado por error o por un
  // script sin intervención humana.
  if (confirmSlug !== slug || confirmTitle !== article.title) {
    return {
      status: 400,
      body: {
        error: 'confirmacion_requerida',
        message: 'Para borrar tenés que confirmar el título y el slug exactos del artículo.',
        expected: { title: article.title, slug: slug }
      }
    };
  }

  var next = current.articles.slice(0, idx).concat(current.articles.slice(idx + 1));
  var backupPath = backupArticles(dataDir);
  var newRev = writeArticlesAtomic(dataDir, next);

  // Mover (no borrar) el HTML a _trash/, si existe.
  var htmlSrc = articleHtmlPath(rootDir, category, slug);
  var htmlTrashDest = null;
  if (fs.existsSync(htmlSrc)) {
    htmlTrashDest = trashHtmlPath(rootDir, category, slug);
    fs.mkdirSync(path.dirname(htmlTrashDest), { recursive: true });
    fs.renameSync(htmlSrc, htmlTrashDest);
  }

  var trash = readTrash(dataDir);
  trash.push({
    article: article,
    category: category,
    slug: slug,
    deletedAt: new Date().toISOString(),
    htmlTrashPath: htmlTrashDest ? path.relative(rootDir, htmlTrashDest) : null,
    htmlOriginalPath: path.relative(rootDir, htmlSrc)
  });
  writeTrash(dataDir, trash);

  appendOpLog(dataDir, {
    op: 'article_delete',
    actor: actor,
    category: category,
    slug: slug,
    prevRev: current.rev,
    newRev: newRev,
    backup: backupPath,
    htmlMovedTo: htmlTrashDest ? path.relative(rootDir, htmlTrashDest) : null
  });

  return { status: 200, body: { ok: true, rev: newRev, trashed: true }, previous: current.articles, saved: next };
}

function restoreArticle(opts) {
  var dataDir = opts.dataDir;
  var rootDir = opts.rootDir;
  var category = opts.category;
  var slug = opts.slug;
  var actor = opts.actor || 'admin-panel';

  try {
    assertSafeSegment(category, 'category');
    assertSafeSegment(slug, 'slug');
  } catch (e) {
    return { status: 400, body: { error: 'segmento_invalido', message: e.message } };
  }

  var trash = readTrash(dataDir);
  var idx = trash.findIndex(function (t) { return t.category === category && t.slug === slug; });
  if (idx === -1) {
    return { status: 404, body: { error: 'no_encontrado_en_papelera', message: 'No hay nada en la papelera para ' + category + '/' + slug + '.' } };
  }
  var entry = trash[idx];

  var current = readArticlesWithRev(dataDir);
  if (current.articles.some(function (a) { return a.category === category && a.slug === slug; })) {
    return { status: 409, body: { error: 'ya_existe', message: 'Ya hay un artículo activo con esa categoría/slug -- no se puede restaurar encima.' } };
  }
  var next = current.articles.concat([entry.article]);
  var backupPath = backupArticles(dataDir);
  var newRev = writeArticlesAtomic(dataDir, next);

  if (entry.htmlTrashPath) {
    var trashAbs = path.join(rootDir, entry.htmlTrashPath);
    var origAbs = path.join(rootDir, entry.htmlOriginalPath);
    if (fs.existsSync(trashAbs)) {
      fs.mkdirSync(path.dirname(origAbs), { recursive: true });
      fs.renameSync(trashAbs, origAbs);
    }
  }

  trash.splice(idx, 1);
  writeTrash(dataDir, trash);

  appendOpLog(dataDir, {
    op: 'article_restore',
    actor: actor,
    category: category,
    slug: slug,
    prevRev: current.rev,
    newRev: newRev,
    backup: backupPath
  });

  return { status: 200, body: { ok: true, rev: newRev, restored: true }, previous: current.articles, saved: next };
}

module.exports = {
  computeRev: computeRev,
  readArticlesWithRev: readArticlesWithRev,
  writeArticlesAtomic: writeArticlesAtomic,
  writeFileAtomic: writeFileAtomic,
  backupArticles: backupArticles,
  appendOpLog: appendOpLog,
  saveBulkArticles: saveBulkArticles,
  upsertArticle: upsertArticle,
  deleteArticle: deleteArticle,
  restoreArticle: restoreArticle,
  readTrash: readTrash,
  articleHtmlPath: articleHtmlPath,
  trashHtmlPath: trashHtmlPath
};
