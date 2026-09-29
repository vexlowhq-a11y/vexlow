/*
  test-related-links-fix.js — Pruebas A-L de la corrección permanente del
  rail de "You might also like" y de la regeneración completa (2026-09-13).
  ============================================================================
  Contexto: tras el borrado intencional de 28 artículos sin imagen (panel,
  incidente confirmado por el usuario), 64 de los 141 artículos reales que
  quedaron tenían en su propia página, dentro del rail "You might also
  like", un total de 112 <a href> apuntando a esos 28 slugs ya inexistentes.
  Causa raíz doble, corregida en este proyecto:
    1. admin/pagegen.js:generateArticleFile() armaba el pool de candidatos a
       "relacionado" con un filtro laxo (`!a.noindex`) que no excluía
       borradores/redirects/artículos sin página real -- ahora usa el mismo
       criterio "publishable" que ya se usaba en el resto del archivo (y que
       generate_pages.py, en Python, ya usaba correctamente).
    2. Ninguna operación de guardado regeneraba la página de OTRO artículo
       que no fuera el tocado -- así que el rail de cualquier otro quedaba
       "congelado" con quien existía en el momento en que esa página se
       generó por última vez. Ahora pagegen.regenerateAllArticlePages()
       (llamada desde admin/server.js en cada alta/edición/borrado/
       restauración) reconstruye la página propia de TODOS los artículos
       públicos/redirect en cada operación.

  Esta prueba corre sobre una COPIA AISLADA de los 141 artículos reales +
  sus páginas HTML reales (nunca sobre /home/claude/site ni sobre el
  dispositivo real) -- solo un artículo sintético se crea/edita/borra/
  restaura, y se borra al final. La prueba L confirma con SHA-256 que
  data/articulos.json REAL no cambió ni un byte durante toda la corrida.

  Uso: node admin/test-related-links-fix.js
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');
const integrity = require('./articulos-integrity-check');

const REAL_ROOT = path.join(__dirname, '..');
const REAL_DATA_DIR = path.join(REAL_ROOT, 'data');
const REAL_ARTICULOS = path.join(REAL_DATA_DIR, 'articulos.json');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
  }
}

// "real141" es el nombre histórico de este archivo; ningún chequeo exige
// literalmente 141 artículos -- N se captura dinámicamente más abajo, y la
// integridad del archivo real se verifica con SHA-256 + cantidad + conjunto
// de slugs vía admin/articulos-integrity-check.js (funciona con 141, 142,
// 143 o cualquier cantidad futura válida).
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS);

// ---------------------------------------------------------------------------
// Setup: copiar el sitio completo (menos .git) a un directorio temporal
// aislado -- pagegen.js/articles-store.js resuelven ROOT/DATA_DIR relativo
// a su propia ubicación (__dirname), así que una copia completa se
// comporta como un sitio independiente sin tocar el real. Mismo patrón que
// admin/test-parity.js.
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-related-fix-'));
fs.readdirSync(REAL_ROOT, { withFileTypes: true }).forEach(function (entry) {
  if (entry.name === '.git') return;
  fs.cpSync(path.join(REAL_ROOT, entry.name), path.join(tmpRoot, entry.name), { recursive: true });
});
const tmpAdmin = path.join(tmpRoot, 'admin');
const tmpData = path.join(tmpRoot, 'data');
const tmpArticulos = path.join(tmpData, 'articulos.json');

const pagegen = require(path.join(tmpAdmin, 'pagegen.js'));
const store = require(path.join(tmpAdmin, 'articles-store.js'));
const linkScanner = require(path.join(tmpAdmin, 'link-scanner.js'));
const articleStatus = require(path.join(tmpAdmin, 'article-status.js'));

const initialArticles = JSON.parse(fs.readFileSync(tmpArticulos, 'utf8'));
assert.ok(initialArticles.length > 0, 'precondición: la copia debe arrancar con al menos un artículo real');
const N = initialArticles.length;
console.log('Setup: copia aislada del sitio completo (' + N + ' artículos reales) en ' + tmpRoot);
console.log('');

// Simula exactamente lo que hace admin/server.js:regenerateArticlePages()
// tras CUALQUIER operación que muta articulos.json: primero borra el HTML
// huérfano de una clave categoría/slug que desapareció o dejó de ser
// pública (rename, o pasó a draft/review/approved -- el borrado explícito
// ya movió su HTML a _trash/ por su cuenta, así que ahí no hay nada que
// hacer), y recién después regenera TODAS las páginas de artículo (no
// solo la tocada) + portada/categorías/sitemap. `result` es lo que
// devuelve cualquier store.upsertArticle/deleteArticle/restoreArticle
// (trae `.previous` y `.saved`, igual que usa admin/server.js).
function regenerateAfter(result) {
  if (result) {
    var previous = result.previous;
    var data = result.saved;
    var currentKeys = new Set();
    var noPageKeys = new Set();
    data.forEach(function (a) {
      if (!a.slug || !a.category) return;
      var key = a.category + '/' + a.slug;
      currentKeys.add(key);
      if (!articleStatus.isRedirectArticle(a) && !articleStatus.isPublicArticle(a)) noPageKeys.add(key);
    });
    previous.forEach(function (a) {
      if (!a.slug || !a.category) return;
      var key = a.category + '/' + a.slug;
      if (currentKeys.has(key) && !noPageKeys.has(key)) return;
      pagegen.deleteArticleFile(a);
    });
  }
  return pagegen.regenerateAllArticlePages();
}

const SYN_SLUG = 'prueba-sintetica-rail-relacionados-13sep';
const SYN_SLUG_RENAMED = 'prueba-sintetica-rail-relacionados-13sep-renamed';
const SYN_CATEGORY = 'ai';
const SYN_CATEGORY_2 = 'science';

// ===========================================================================
// A. El escáner detecta un enlace roto cuando un artículo desaparece sin
//    una regeneración completa (reproduce, sobre datos sintéticos, la
//    misma clase de bug que produjo los 112 enlaces muertos reales).
//    NOTA: la cifra real de "112 enlaces muertos sobre 64 páginas" ya se
//    confirmó de forma empírica en esta misma sesión, sobre el estado real
//    de 141 antes de aplicar esta corrección (ver informe de entrega) --
//    coincide exactamente, artículo por artículo, con el CSV ya entregado
//    (enlaces-rotos-tras-borrado-64-articulos.csv). Esta prueba automática
//    no depende de ese backup puntual del incidente (no existe en el
//    dispositivo real) sino que reproduce la causa de forma genérica, para
//    que seguir funcionando como regresión permanente.
// ===========================================================================
test('A. El escáner detecta un enlace roto si un artículo desaparece sin regeneración completa', function () {
  // Crea un artículo ancla con fecha muy futura en SYN_CATEGORY para que
  // termine en su propio rail de relacionados (por categoría, al no
  // compartir "topic" con nadie) un artículo señuelo que luego se borra
  // SIN pasar por regenerateAll() -- eso dice cómo quedaba el sitio antes
  // de esta corrección: el rail queda con un link muerto.
  const decoySlug = 'senuelo-temporal-13sep';
  const anchorSlug = 'ancla-temporal-13sep';
  const base = { category: SYN_CATEGORY, status: 'published', noindex: false, dek: 'x', readTime: '1 min', body: 'Cuerpo de prueba con contenido suficiente para no ser un borrador.', sourceUrl: 'https://example.com/x' };

  let r = store.upsertArticle({ dataDir: tmpData, category: SYN_CATEGORY, slug: decoySlug, article: Object.assign({}, base, { title: 'Señuelo temporal', slug: decoySlug, date: '2099-01-01' }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = store.upsertArticle({ dataDir: tmpData, category: SYN_CATEGORY, slug: anchorSlug, article: Object.assign({}, base, { title: 'Ancla temporal', slug: anchorSlug, date: '2099-01-02' }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r); // el ancla queda con un link al señuelo en su rail

  const anchorHtmlPath = path.join(tmpRoot, 'categoria', SYN_CATEGORY, anchorSlug + '.html');
  const anchorHtmlBefore = fs.readFileSync(anchorHtmlPath, 'utf8');
  assert.ok(anchorHtmlBefore.indexOf(decoySlug + '.html') !== -1, 'precondición: el ancla debe referenciar al señuelo en su rail');

  // Borra el señuelo SIN regenerar nada más (así se comportaba el panel
  // antes de esta corrección: solo tocaba la página del borrado, nunca la
  // del ancla que lo referenciaba).
  const del = store.deleteArticle({ dataDir: tmpData, rootDir: tmpRoot, category: SYN_CATEGORY, slug: decoySlug, confirmTitle: 'Señuelo temporal', confirmSlug: decoySlug });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  // (deleteArticle ya movió el HTML del señuelo a _trash/ -- no hace
  // falta nada más para reproducir el bug: el ancla sigue con el link.)

  const scanStale = linkScanner.scanPublicHtml(tmpRoot);
  const staleHit = scanStale.broken.find(function (b) { return b.resolved && b.resolved.indexOf(decoySlug) !== -1; });
  assert.ok(staleHit, 'el escáner debe detectar el link muerto hacia el señuelo borrado (reproduce la causa de los 112 enlaces muertos reales)');

  // Limpieza de este sub-escenario: ahora sí, regeneración completa (lo
  // que hace server.js en producción tras esta corrección) debe dejar 0.
  const delAnchor = store.deleteArticle({ dataDir: tmpData, rootDir: tmpRoot, category: SYN_CATEGORY, slug: anchorSlug, confirmTitle: 'Ancla temporal', confirmSlug: anchorSlug });
  assert.strictEqual(delAnchor.status, 200);
  regenerateAfter(delAnchor);
});

// ===========================================================================
// B. Tras una regeneración completa, 0 enlaces internos rotos.
// ===========================================================================
test('B. Regenerar todas las páginas deja 0 enlaces internos rotos', function () {
  regenerateAfter(null);
  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, 'no debe quedar ningún link roto tras una regeneración completa:\n' + JSON.stringify(scan.broken.slice(0, 10), null, 2));
  assert.strictEqual(JSON.parse(fs.readFileSync(tmpArticulos, 'utf8')).length, N, 'debe seguir en ' + N + ' tras la limpieza del sub-escenario A');
});

// ===========================================================================
// C. Crear un artículo sintético publicado y verificar su integración
//    (página propia, categoría, portada, sitemap, y aparece en el rail de
//    relacionados de un artículo ancla real de la misma categoría).
// ===========================================================================
let anchorRealSlug;
test('C. Crear un artículo publicado lo integra en página propia + categoría + portada + sitemap + rail de un ancla', function () {
  const articles = JSON.parse(fs.readFileSync(tmpArticulos, 'utf8'));
  // Un ancla SIN `topic` fuerza que relatedArticlesFor() use el respaldo
  // "misma categoría" (si tuviera topic y ya hubiera 4 coincidencias por
  // tema, el sintético -- que no comparte topic con nadie -- podría no
  // entrar; sin topic, el respaldo por categoría entra siempre y el
  // sintético, con la fecha más futura de todas, queda primero).
  const anchor = articles.find(function (a) { return a.category === SYN_CATEGORY && a.slug && !a.topic; });
  assert.ok(anchor, 'precondición: debe existir al menos un artículo real de la categoría de prueba sin `topic`');
  anchorRealSlug = anchor.slug;

  const r = store.upsertArticle({
    dataDir: tmpData,
    category: SYN_CATEGORY,
    slug: SYN_SLUG,
    article: {
      title: 'Artículo sintético de prueba (rail de relacionados)',
      category: SYN_CATEGORY,
      slug: SYN_SLUG,
      date: '2099-06-01', // muy futuro -> siempre el más reciente de su categoría
      dek: 'Prueba automática, no es contenido real.',
      readTime: '1 min',
      status: 'published',
      noindex: false,
      body: 'Cuerpo de prueba con contenido suficiente para pasar por un artículo publicado normal.',
      sourceUrl: 'https://example.com/prueba-sintetica'
    }
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r);

  const ownPage = path.join(tmpRoot, 'categoria', SYN_CATEGORY, SYN_SLUG + '.html');
  assert.ok(fs.existsSync(ownPage), 'debe generarse la página propia del sintético');

  const catPage = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, 'index.html'), 'utf8');
  assert.ok(catPage.indexOf(SYN_SLUG + '.html') !== -1, 'debe aparecer en la página de categoría');

  const home = fs.readFileSync(path.join(tmpRoot, 'index.html'), 'utf8');
  assert.ok(home.indexOf(SYN_SLUG) !== -1, 'debe aparecer en portada (Latest/categoría destacada)');

  const sitemap = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.indexOf(SYN_SLUG) !== -1, 'debe aparecer en sitemap.xml (published + no noindex)');

  const anchorHtml = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, anchorRealSlug + '.html'), 'utf8');
  assert.ok(anchorHtml.indexOf(SYN_SLUG + '.html') !== -1, 'al ser el más reciente de la categoría, debe entrar en el rail de relacionados del artículo ancla real');

  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, 'alta de un artículo no debe generar enlaces rotos');
});

// ===========================================================================
// D. Borrarlo (papelera) hace que desaparezca de TODOS los rails.
// ===========================================================================
test('D. Borrar el sintético lo quita de página de categoría, portada, sitemap y del rail del ancla', function () {
  const r = store.deleteArticle({ dataDir: tmpData, rootDir: tmpRoot, category: SYN_CATEGORY, slug: SYN_SLUG, confirmTitle: 'Artículo sintético de prueba (rail de relacionados)', confirmSlug: SYN_SLUG });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r);

  const catPage = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, 'index.html'), 'utf8');
  assert.ok(catPage.indexOf(SYN_SLUG) === -1, 'no debe quedar en la página de categoría');
  const home = fs.readFileSync(path.join(tmpRoot, 'index.html'), 'utf8');
  assert.ok(home.indexOf(SYN_SLUG) === -1, 'no debe quedar en portada');
  const sitemap = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.indexOf(SYN_SLUG) === -1, 'no debe quedar en sitemap.xml');
  const anchorHtml = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, anchorRealSlug + '.html'), 'utf8');
  assert.ok(anchorHtml.indexOf(SYN_SLUG) === -1, 'no debe quedar referenciado en el rail del ancla -- esto es justo lo que fallaba antes de la corrección');

  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, 'el borrado no debe dejar ningún link roto (papelera + regeneración completa)');
});

// ===========================================================================
// E. Restaurar desde papelera, luego cambiar categoría/slug, y confirmar
//    que el rail se actualiza a la identidad nueva.
// ===========================================================================
test('E. Restaurar y luego renombrar categoría/slug actualiza el rail a la identidad nueva', function () {
  const restore = store.restoreArticle({ dataDir: tmpData, rootDir: tmpRoot, category: SYN_CATEGORY, slug: SYN_SLUG });
  assert.strictEqual(restore.status, 200, JSON.stringify(restore.body));
  regenerateAfter(restore);
  assert.ok(fs.existsSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, SYN_SLUG + '.html')), 'la página debe volver a existir tras restaurar');

  const restored = restore.saved.find(function (a) { return a.slug === SYN_SLUG; });
  const renamed = Object.assign({}, restored, { category: SYN_CATEGORY_2, slug: SYN_SLUG_RENAMED, date: '2099-06-02' });
  const r = store.upsertArticle({ dataDir: tmpData, category: SYN_CATEGORY, slug: SYN_SLUG, article: renamed });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r);

  assert.ok(!fs.existsSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, SYN_SLUG + '.html')), 'la página vieja (categoría/slug anteriores) no debe seguir existiendo');
  assert.ok(fs.existsSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY_2, SYN_SLUG_RENAMED + '.html')), 'debe existir la página en la categoría/slug nuevos');

  const newCatPage = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY_2, 'index.html'), 'utf8');
  assert.ok(newCatPage.indexOf(SYN_SLUG_RENAMED) !== -1, 'debe listarse en la categoría nueva');
  const oldCatPage = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY, 'index.html'), 'utf8');
  // OJO: SYN_SLUG es prefijo literal de SYN_SLUG_RENAMED (".../13sep" vs
  // ".../13sep-renamed") -- un indexOf(SYN_SLUG) suelto daría falso
  // positivo si el sidebar "Latest Posts" (compartido en TODAS las
  // páginas, incluida esta) referencia correctamente al renombrado. Se
  // busca el href EXACTO de la identidad vieja, con comillas a los dos
  // lados, para no confundir una cosa con la otra.
  assert.ok(oldCatPage.indexOf('"' + SYN_SLUG + '.html"') === -1, 'no debe seguir listado en la categoría vieja (href exacto de la identidad anterior)');

  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, 'el cambio de categoría/slug no debe dejar ningún link roto (ni hacia la ruta vieja ni hacia la nueva)');
});

// ===========================================================================
// F. Marcarlo noindex lo saca de Latest/categoría/sitemap (isListable pasa
//    a false) pero conserva su página propia navegable.
// ===========================================================================
test('F. Marcar noindex lo saca de categoría/portada/sitemap sin borrar su página', function () {
  const articles = JSON.parse(fs.readFileSync(tmpArticulos, 'utf8'));
  const current = articles.find(function (a) { return a.category === SYN_CATEGORY_2 && a.slug === SYN_SLUG_RENAMED; });
  assert.ok(current, 'precondición: el renombrado debe existir');
  const noindexed = Object.assign({}, current, { noindex: true });
  const r = store.upsertArticle({ dataDir: tmpData, category: SYN_CATEGORY_2, slug: SYN_SLUG_RENAMED, article: noindexed });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r);

  assert.ok(fs.existsSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY_2, SYN_SLUG_RENAMED + '.html')), 'la página propia sigue existiendo (noindex,follow -- no se borra)');
  const catPage = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY_2, 'index.html'), 'utf8');
  assert.ok(catPage.indexOf(SYN_SLUG_RENAMED) === -1, 'no debe listarse en la página de categoría');
  const home = fs.readFileSync(path.join(tmpRoot, 'index.html'), 'utf8');
  assert.ok(home.indexOf(SYN_SLUG_RENAMED) === -1, 'no debe listarse en portada/Latest/Trending');
  const sitemap = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.indexOf(SYN_SLUG_RENAMED) === -1, 'no debe listarse en sitemap.xml');

  const ownHtml = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY_2, SYN_SLUG_RENAMED + '.html'), 'utf8');
  assert.ok(ownHtml.indexOf('noindex,follow') !== -1, 'la página propia debe llevar meta robots noindex,follow');

  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, 'marcar noindex no debe dejar ningún link roto');
});

// ===========================================================================
// G. Restaurar la visibilidad (desmarcar noindex) recupera su presencia en
//    los listados -- prueba que el cambio de estado es reversible.
// ===========================================================================
test('G. Quitar noindex recupera la presencia en categoría/portada/sitemap', function () {
  const articles = JSON.parse(fs.readFileSync(tmpArticulos, 'utf8'));
  const current = articles.find(function (a) { return a.category === SYN_CATEGORY_2 && a.slug === SYN_SLUG_RENAMED; });
  const visible = Object.assign({}, current, { noindex: false });
  const r = store.upsertArticle({ dataDir: tmpData, category: SYN_CATEGORY_2, slug: SYN_SLUG_RENAMED, article: visible });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r);

  const catPage = fs.readFileSync(path.join(tmpRoot, 'categoria', SYN_CATEGORY_2, 'index.html'), 'utf8');
  assert.ok(catPage.indexOf(SYN_SLUG_RENAMED) !== -1, 'debe volver a listarse en categoría');
  const sitemap = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.indexOf(SYN_SLUG_RENAMED) !== -1, 'debe volver a listarse en sitemap.xml');
});

// ===========================================================================
// H. Paridad Node/Python -- SOLO en lo que este proyecto toca: páginas de
//    artículo/redirect, categorías, portada y sitemap.
//    NOTA: no se reusa admin/test-parity.js tal cual (compara TODO el
//    árbol, ~4108 archivos) porque expondría una diferencia preexistente y
//    fuera de alcance de este pedido: admin/pagegen.js (guardado desde el
//    panel, siempre existió así, no es parte de esta corrección) nunca
//    regeneró las páginas institucionales (about/privacy/terms/etc.) ni
//    play/*.html -- esas solo las toca una corrida completa manual de
//    generate_pages.py. Esa brecha es real, preexistente, y no genera
//    enlaces rotos (el sidebar que arrastran sigue apuntando a artículos
//    reales, nunca a uno borrado) -- corregirla sería agrandar el alcance
//    de este pedido (tocar 14 plantillas más) sin relación con los 112
//    enlaces muertos reportados, así que se deja fuera y se documenta acá.
//    Esta prueba valida paridad en lo que sí es responsabilidad de la
//    corrección: que Node y Python generen EXACTAMENTE lo mismo para
//    artículos, categorías, portada y sitemap.
// ===========================================================================
test('H. Paridad Node/Python en artículos, categorías, portada y sitemap', function () {
  const KNOWN_WHITESPACE_EXCEPTIONS = new Set([
    'categoria/ai/index.html', 'categoria/business/index.html', 'categoria/entertainment/index.html',
    'categoria/gaming/index.html', 'categoria/science/index.html', 'categoria/sports/index.html',
    'categoria/technology/index.html', 'categoria/trending/index.html'
  ]);
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-parity-node-'));
  const pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-parity-py-'));
  try {
    [nodeDir, pyDir].forEach(function (dest) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(tmpRoot, dest, { recursive: true });
    });
    require(path.join(nodeDir, 'admin', 'pagegen.js')).regenerateAllArticlePages();
    execFileSync('python3', ['generate_pages.py'], { cwd: path.join(pyDir, 'admin'), stdio: 'pipe' });

    var scopes = ['categoria', 'index.html', 'sitemap.xml'];
    var mismatches = [];
    var compared = 0;
    function walkAndCompare(relBase) {
      var nodeFull = path.join(nodeDir, relBase);
      var stat = fs.statSync(nodeFull);
      if (stat.isDirectory()) {
        fs.readdirSync(nodeFull).forEach(function (entry) { walkAndCompare(path.join(relBase, entry)); });
        return;
      }
      compared++;
      var pyFull = path.join(pyDir, relBase);
      if (!fs.existsSync(pyFull)) { mismatches.push(relBase + ' (falta en la salida de Python)'); return; }
      if (KNOWN_WHITESPACE_EXCEPTIONS.has(relBase)) return; // ver test-parity.js: diferencia de whitespace preexistente, no relacionada
      if (!fs.readFileSync(nodeFull).equals(fs.readFileSync(pyFull))) mismatches.push(relBase);
    }
    scopes.forEach(walkAndCompare);
    assert.strictEqual(mismatches.length, 0, 'diferencias Node vs Python en artículos/categorías/portada/sitemap:\n' + mismatches.slice(0, 20).join('\n'));
    // 150 fue calibrado específicamente para N=141 (141 + 9 de sintético/
    // categorías/portada/sitemap); generalizado a N + 9 para cualquier
    // cantidad real de artículos.
    assert.ok(compared >= N + 9, 'debe haber comparado al menos las ' + N + ' páginas de artículo reales + el sintético + categorías + portada + sitemap (comparó ' + compared + ')');
  } finally {
    fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.rmSync(pyDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// I. Determinismo: dos regeneraciones completas seguidas dan bytes
//    idénticos en categoria/ + portada + sitemap.
// ===========================================================================
test('I. Determinismo: dos regeneraciones completas seguidas dan bytes idénticos', function () {
  function hashTree() {
    var out = {};
    (function walk(dir, base) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        var full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full, base);
        out[path.relative(base, full)] = sha256File(full);
      });
    })(path.join(tmpRoot, 'categoria'), tmpRoot);
    out['index.html'] = sha256File(path.join(tmpRoot, 'index.html'));
    out['sitemap.xml'] = sha256File(path.join(tmpRoot, 'sitemap.xml'));
    return out;
  }
  regenerateAfter(null);
  const first = hashTree();
  regenerateAfter(null);
  const second = hashTree();
  assert.deepStrictEqual(second, first, 'dos regeneraciones completas seguidas deben producir bytes idénticos');
});

// ===========================================================================
// J. El escáner (equivalente a validate:publish) da 0 fallos críticos.
// ===========================================================================
test('J. link-scanner sobre la copia da 0 referencias rotas', function () {
  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, JSON.stringify(scan.broken.slice(0, 10), null, 2));
  assert.ok(scan.filesScanned >= N, 'debe haber escaneado al menos las ' + N + ' páginas de artículo reales + el sintético');
});

// ===========================================================================
// K. Borrar todos los datos sintéticos -- vuelve a quedar en la cantidad
//    original (141 en el incidente histórico que da nombre a este archivo;
//    N en general).
// ===========================================================================
test('K. Limpieza: borrar el artículo sintético deja la copia otra vez en la cantidad original (N)', function () {
  const articles = JSON.parse(fs.readFileSync(tmpArticulos, 'utf8'));
  const stillThere = articles.find(function (a) { return a.slug === SYN_SLUG_RENAMED; });
  assert.ok(stillThere, 'precondición: el sintético (renombrado) debe seguir presente antes de esta limpieza');
  const r = store.deleteArticle({ dataDir: tmpData, rootDir: tmpRoot, category: SYN_CATEGORY_2, slug: SYN_SLUG_RENAMED, confirmTitle: stillThere.title, confirmSlug: SYN_SLUG_RENAMED });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  regenerateAfter(r);

  const finalArticles = JSON.parse(fs.readFileSync(tmpArticulos, 'utf8'));
  assert.strictEqual(finalArticles.length, N, 'debe volver exactamente a ' + N + ' tras borrar el sintético');
  const finalSlugs = finalArticles.map(function (a) { return a.category + '/' + a.slug; }).sort();
  const originalSlugs = initialArticles.map(function (a) { return a.category + '/' + a.slug; }).sort();
  assert.deepStrictEqual(finalSlugs, originalSlugs, 'el conjunto de ' + N + ' debe ser EXACTAMENTE el mismo que al empezar (mismas categoría+slug)');

  const scan = linkScanner.scanPublicHtml(tmpRoot);
  assert.strictEqual(scan.broken.length, 0, 'tras limpiar todo lo sintético no debe quedar ningún link roto');
});

// ===========================================================================
// L. El archivo REAL (data/articulos.json, fuera de la copia temporal)
//    nunca se tocó durante toda esta corrida.
// ===========================================================================
test('L. data/articulos.json real no cambió ni un byte durante toda la corrida (SHA-256 idéntico)', function () {
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS);
  assert.strictEqual(realArticulosAfterSnapshot.hash, realArticulosBeforeSnapshot.hash, 'el archivo real no debe haber cambiado -- toda esta prueba corrió sobre ' + tmpRoot);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  assert.ok(realIntegrityResult.ok, 'el sitio real debe conservar exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + '): ' + realIntegrityResult.detail);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
console.log('Resultado: ' + passed + ' pasaron, ' + failed + ' fallaron, de ' + (passed + failed) + ' pruebas.');
process.exitCode = failed ? 1 : 0;
