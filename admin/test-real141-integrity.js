/*
  test-real141-integrity.js — pruebas A-K sobre una COPIA AISLADA del estado
  real de artículos + control mínimo de integridad + control negativo del
  módulo compartido de integridad.
  ============================================================================
  NOTA SOBRE EL NOMBRE (legado histórico, 2026-09-27): este archivo se llamó
  así porque el conteo real confirmado tras el incidente del 2026-09-13 era
  141. Se conserva el nombre por compatibilidad (otros informes y scripts ya
  lo referencian), pero desde el 2026-09-27 NINGUNA de sus verificaciones
  exige literalmente 141: todo se calcula contra "N", la cantidad real leída
  al empezar esta misma corrida. Funciona igual con 141, 142, 143 o
  cualquier cantidad real futura -- lo que se prueba es que las operaciones
  se comporten bien relativas a lo que había, no un número fijo.

  A diferencia de test-data-integrity.js (que usa artículos 100% sintéticos
  desde cero), esta corrida parte de una copia real de data/articulos.json
  (N artículos reales) + copia de sus páginas HTML, en un directorio
  temporal aislado. Los únicos datos "sintéticos" son UN artículo de prueba
  que se agrega, edita, borra y restaura sobre esa copia -- nunca se toca
  ninguno de los N reales salvo el que las pruebas A y C editan a propósito
  (sobre la COPIA, jamás sobre /home/claude/site/data ni sobre el
  dispositivo real). El test J limpia ese artículo de prueba al final y
  usa admin/articulos-integrity-check.js (SHA-256 + cantidad + conjunto de
  category/slug) para confirmar que data/articulos.json REAL del sandbox no
  cambió ni un byte durante toda la corrida.

  El test K es un CONTROL NEGATIVO: modifica deliberadamente COPIAS
  temporales de un articulos.json de juguete (nunca el real ni el de este
  mismo test) para demostrar que admin/articulos-integrity-check.js
  efectivamente DETECTA una alta, una baja, y una modificación sin cambio
  de cantidad -- si el control de integridad no detectara estos 3 casos,
  todas las demás pruebas de este archivo (y de los otros 16 que usan el
  mismo módulo) podrían estar dando "PASS" sin que el archivo real esté
  realmente protegido.

  Uso: node admin/test-real141-integrity.js
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const store = require('./articles-store');
const pipeline = require('./pipeline');
const articleStatus = require('./article-status');
const imageLicenses = require('./image-licenses');
const integrity = require('./articulos-integrity-check');

const REAL_DATA_DIR = path.join(__dirname, '..', 'data');
const REAL_ROOT_DIR = path.join(__dirname, '..');
const REAL_ARTICULOS = path.join(REAL_DATA_DIR, 'articulos.json');
const REAL_CATEGORIES = path.join(REAL_DATA_DIR, 'categories.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name);
    console.log('      ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Precondición mínima: el archivo real es válido y usable como punto de
// partida. A propósito NO exige ningún número fijo -- solo que sea un JSON
// válido, un array, con al menos 1 artículo, y que pase los mismos
// controles de calidad mínimos que npm run validate:publish exige antes de
// sincronizar. "N" es la cantidad real en este momento; todo lo demás en
// este archivo se calcula a partir de N, nunca de un literal.
// ---------------------------------------------------------------------------
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS);
const realArticles = JSON.parse(fs.readFileSync(REAL_ARTICULOS, 'utf8'));

test('Precondición. data/articulos.json real es JSON válido y es un array', function () {
  assert.ok(Array.isArray(realArticles), 'debe ser un array');
});

const N = realArticles.length;
test('Precondición. Cantidad inicial de artículos reales es mayor que cero', function () {
  assert.ok(N > 0, 'N=' + N);
});

test('Precondición. Esquema mínimo (slug/categoría/título/fecha) en todos los artículos reales', function () {
  const categories = JSON.parse(fs.readFileSync(REAL_CATEGORIES, 'utf8'));
  const categorySlugs = new Set(categories.map(function (c) { return c.slug; }));
  const issues = [];
  realArticles.forEach(function (a, i) {
    if (!a.slug) issues.push('#' + i + ': falta slug');
    if (!a.category || !categorySlugs.has(a.category)) issues.push('#' + i + ' (' + (a.slug || '?') + '): categoría inválida (' + a.category + ')');
    if (!a.title) issues.push('#' + i + ' (' + (a.slug || '?') + '): falta title');
    if (!a.date) issues.push('#' + i + ' (' + (a.slug || '?') + '): falta date');
  });
  assert.strictEqual(issues.length, 0, issues.slice(0, 15).join('\n'));
});

test('Precondición. Toda fuente declarada es una URL http(s) válida', function () {
  const bad = [];
  realArticles.forEach(function (a) {
    const sources = [];
    if (a.sourceUrl) sources.push(a.sourceUrl);
    (a.additionalSources || []).forEach(function (s) { if (s && s.url) sources.push(s.url); });
    sources.forEach(function (url) {
      if (!/^https?:\/\//i.test(url)) bad.push(a.slug + ': "' + url + '"');
    });
  });
  assert.strictEqual(bad.length, 0, bad.slice(0, 15).join('\n'));
});

test('Precondición. Toda licencia de imagen declarada está reconocida (admin/image-licenses.js)', function () {
  const bad = [];
  realArticles.forEach(function (a) {
    if (a.image && a.imageLicense && !imageLicenses.isKnownLicense(a.imageLicense)) {
      bad.push(a.slug + ': licencia "' + a.imageLicense + '" no reconocida');
    }
  });
  assert.strictEqual(bad.length, 0, bad.slice(0, 15).join('\n'));
});

test('Precondición. Cero slugs duplicados (misma categoría + slug)', function () {
  const seen = {};
  const dupes = [];
  realArticles.forEach(function (a) {
    if (!a.slug || !a.category) return;
    const key = a.category + '/' + a.slug;
    if (seen[key]) dupes.push(key);
    seen[key] = true;
  });
  assert.strictEqual(dupes.length, 0, dupes.join('\n'));
});

test('Precondición. Todo artículo "redirected" tiene un redirectTo válido', function () {
  const issues = [];
  realArticles.forEach(function (a) {
    if (articleStatus.effectiveStatus(a) !== 'redirected') return;
    const problems = pipeline.validateRedirectArticle(a, realArticles);
    if (problems.length) issues.push(a.slug + ': ' + problems.map(function (p) { return p.message; }).join(' | '));
  });
  assert.strictEqual(issues.length, 0, issues.join('\n'));
});

test('Precondición. Sin artículos de prueba residuales (test-/qa-/synthetic-/prueba-) en el archivo real', function () {
  const TEST_SLUG_PATTERN = /^(test-|qa-|synthetic-|prueba-)/i;
  const leftovers = realArticles.filter(function (a) { return a.slug && TEST_SLUG_PATTERN.test(a.slug); }).map(function (a) { return a.slug; });
  assert.strictEqual(leftovers.length, 0, leftovers.join(', '));
});

// ---------------------------------------------------------------------------
// Setup: copiar los N artículos reales + sus páginas HTML a un tmp dir.
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-real141-'));
const tmpData = path.join(tmpRoot, 'data');
fs.mkdirSync(tmpData, { recursive: true });

fs.writeFileSync(path.join(tmpData, 'articulos.json'), JSON.stringify(realArticles, null, 2) + '\n', 'utf8');

// Copia las páginas HTML reales (todas -- son ~N archivos livianos) para que
// borrar/restaurar en la copia también mueva/traiga HTML real.
let copiedHtml = 0;
realArticles.forEach(function (a) {
  const src = path.join(REAL_ROOT_DIR, 'categoria', a.category, a.slug + '.html');
  if (fs.existsSync(src)) {
    const dest = path.join(tmpRoot, 'categoria', a.category, a.slug + '.html');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copiedHtml++;
  }
});
console.log('Setup: copiados ' + N + ' artículos reales + ' + copiedHtml + ' páginas HTML a ' + tmpRoot + ' (aislado, no es el sandbox real)');
console.log('');

const TEST_SLUG = 'prueba-sintetica-post-incidente-13sep';
const TEST_CATEGORY = 'ai';

// ===========================================================================
// A. Editar un artículo existente (real, de los N) -- modifica solo ese.
// ===========================================================================
let pickedSlug, pickedCategory, revBeforeA;
test('A. Editar un artículo existente modifica solamente ese artículo', function () {
  const state = store.readArticlesWithRev(tmpData);
  const target = state.articles[0];
  pickedSlug = target.slug;
  pickedCategory = target.category;
  revBeforeA = state.rev;

  const edited = state.articles.map(function (a) {
    return (a.slug === pickedSlug && a.category === pickedCategory) ? Object.assign({}, a, { title: a.title + ' [editado en prueba]' }) : a;
  });
  const r = store.saveBulkArticles({ dataDir: tmpData, articles: edited, ifMatchRev: state.rev });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = store.readArticlesWithRev(tmpData).articles;
  assert.strictEqual(after.length, N, 'el total debe seguir en ' + N);
  assert.ok(after.find(function (a) { return a.slug === pickedSlug; }).title.endsWith('[editado en prueba]'));
  // Ningún otro artículo debe haber cambiado.
  let otrosIguales = true;
  state.articles.forEach(function (a) {
    if (a.slug === pickedSlug && a.category === pickedCategory) return;
    const match = after.find(function (b) { return b.slug === a.slug && b.category === a.category; });
    if (JSON.stringify(match) !== JSON.stringify(a)) otrosIguales = false;
  });
  assert.ok(otrosIguales, 'ningún artículo ajeno al editado debe cambiar');
});

// ===========================================================================
// B. Guardar un borrador nuevo -- no reemplaza el array completo.
// ===========================================================================
test('B. Guardar un borrador nuevo no reemplaza el array completo', function () {
  const before = store.readArticlesWithRev(tmpData);
  const draft = {
    title: 'Artículo de prueba (borrador)',
    slug: TEST_SLUG,
    category: TEST_CATEGORY,
    status: 'draft',
    draftIncomplete: true,
    noindex: true,
    sourceUrl: 'https://example.com/prueba',
    body: ''
  };
  const r = store.upsertArticle({ dataDir: tmpData, category: TEST_CATEGORY, slug: TEST_SLUG, article: draft });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = store.readArticlesWithRev(tmpData).articles;
  assert.strictEqual(after.length, N + 1, 'debe sumar 1 (' + N + ' reales + el borrador de prueba)');
  // Los N reales originales deben seguir todos ahí (salvo el editado en A).
  before.articles.forEach(function (a) {
    assert.ok(after.some(function (b) { return b.slug === a.slug && b.category === a.category; }), 'no debe faltar ' + a.category + '/' + a.slug);
  });
});

// ===========================================================================
// C. Dos pestañas con revisiones diferentes.
// ===========================================================================
let tabOld, tabNew;
test('C. Dos pestañas con revisiones diferentes', function () {
  tabOld = store.readArticlesWithRev(tmpData); // ya incluye el borrador de B
  // Otra pestaña edita algo y guarda primero.
  const editedByOther = tabOld.articles.map(function (a) {
    return (a.slug === TEST_SLUG) ? Object.assign({}, a, { title: 'Editado por otra pestaña' }) : a;
  });
  const r = store.saveBulkArticles({ dataDir: tmpData, articles: editedByOther, ifMatchRev: tabOld.rev });
  assert.strictEqual(r.status, 200);
  tabNew = store.readArticlesWithRev(tmpData);
  assert.notStrictEqual(tabOld.rev, tabNew.rev, 'las revisiones deben diferir después del guardado ajeno');
});

// ===========================================================================
// D. Intento de guardado desde pestaña antigua (tabOld.rev, ya superada).
// ===========================================================================
test('D. Guardado desde pestaña antigua -> 409', function () {
  const r = store.saveBulkArticles({ dataDir: tmpData, articles: tabOld.articles, ifMatchRev: tabOld.rev });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'revision_conflict');
  const now = store.readArticlesWithRev(tmpData);
  assert.strictEqual(now.rev, tabNew.rev, 'el rechazo no debe haber tocado el archivo');
});

// ===========================================================================
// E. Eliminar el artículo de prueba: pasa a papelera (no se borra el HTML).
// ===========================================================================
test('E. Eliminar el artículo de prueba lo mueve a papelera', function () {
  // Le damos un HTML real (de mentira) para poder probar el movimiento.
  const htmlPath = store.articleHtmlPath(tmpRoot, TEST_CATEGORY, TEST_SLUG);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, '<html>prueba</html>', 'utf8');

  const current = store.readArticlesWithRev(tmpData);
  const target = current.articles.find(function (a) { return a.slug === TEST_SLUG; });
  const r = store.deleteArticle({
    dataDir: tmpData,
    rootDir: tmpRoot,
    category: TEST_CATEGORY,
    slug: TEST_SLUG,
    confirmTitle: target.title,
    confirmSlug: TEST_SLUG
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = store.readArticlesWithRev(tmpData).articles;
  assert.strictEqual(after.length, N, 'debe volver a ' + N + ' (se fue el de prueba)');
  assert.ok(!fs.existsSync(htmlPath), 'el HTML ya no debe estar en su ruta pública');
  assert.ok(fs.existsSync(store.trashHtmlPath(tmpRoot, TEST_CATEGORY, TEST_SLUG)), 'el HTML debe estar en _trash/');
  assert.strictEqual(store.readTrash(tmpData).length, 1);
});

// ===========================================================================
// F. Restaurar el artículo de prueba.
// ===========================================================================
test('F. Restaurar el artículo de prueba desde papelera', function () {
  const r = store.restoreArticle({ dataDir: tmpData, rootDir: tmpRoot, category: TEST_CATEGORY, slug: TEST_SLUG });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = store.readArticlesWithRev(tmpData).articles;
  assert.strictEqual(after.length, N + 1, 'debe volver a ' + (N + 1) + ' (' + N + ' reales + el de prueba restaurado)');
  assert.ok(fs.existsSync(store.articleHtmlPath(tmpRoot, TEST_CATEGORY, TEST_SLUG)), 'el HTML debe estar de vuelta');
  assert.strictEqual(store.readTrash(tmpData).length, 0);
});

// ===========================================================================
// G. Petición masiva con MENOS artículos que el estado actual de la copia --
//    bloqueada.
// ===========================================================================
test('G. Petición masiva con menos artículos que el estado actual -> bloqueada', function () {
  const current = store.readArticlesWithRev(tmpData);
  const faltante = Math.max(1, Math.floor(current.articles.length * 0.3));
  const incomplete = current.articles.slice(0, current.articles.length - faltante);
  const r = store.saveBulkArticles({ dataDir: tmpData, articles: incomplete, ifMatchRev: current.rev });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'reduccion_no_permitida');
  assert.strictEqual(store.readArticlesWithRev(tmpData).articles.length, current.articles.length, 'no debe haberse escrito nada');
});

// ===========================================================================
// H. Petición directa SIN revisión válida (ni siquiera manda If-Match) que
//    además reduce el conjunto -- bloqueada igual (defensa en profundidad).
// ===========================================================================
test('H. Petición directa sin revisión válida -> bloqueada', function () {
  const current = store.readArticlesWithRev(tmpData);
  const incomplete = current.articles.slice(0, Math.floor(current.articles.length / 2));
  const r = store.saveBulkArticles({ dataDir: tmpData, articles: incomplete }); // sin ifMatchRev
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'reduccion_no_permitida');
  assert.strictEqual(store.readArticlesWithRev(tmpData).articles.length, current.articles.length);
});

// ===========================================================================
// I. Cerrar y volver a abrir el panel (= volver a leer desde disco) debe
//    conservar los N reales + el de prueba restaurado.
// ===========================================================================
test('I. "Reabrir el panel" (releer del disco) conserva el estado', function () {
  const reopened = store.readArticlesWithRev(tmpData);
  assert.strictEqual(reopened.articles.length, N + 1);
  realArticles.forEach(function (a) {
    const match = reopened.articles.find(function (b) { return b.slug === a.slug && b.category === a.category; });
    assert.ok(match, 'sigue estando ' + a.category + '/' + a.slug);
  });
});

// ===========================================================================
// J. Eliminar completamente los datos sintéticos -- vuelve a N exactos, Y el
//    articulos.json REAL del sandbox no cambió ni un byte en toda la
//    corrida (SHA-256 + cantidad + conjunto de slugs, ver
//    admin/articulos-integrity-check.js).
// ===========================================================================
test('J. Limpieza de datos sintéticos + el archivo real no se tocó', function () {
  const current = store.readArticlesWithRev(tmpData);
  const cleaned = current.articles.filter(function (a) { return a.slug !== TEST_SLUG; });
  const r = store.saveBulkArticles({ dataDir: tmpData, articles: cleaned, ifMatchRev: current.rev });
  // Nota: esto SÍ reduce el conteo (N+1 -> N), a propósito, para probar que
  // la limpieza de la prueba funciona -- se hace con deleteArticle, que es
  // el camino correcto para reducir, no con saveBulkArticles. Se corrige
  // abajo usando el endpoint real de borrado.
  assert.strictEqual(r.status, 409, 'saveBulkArticles no debe permitir esta reducción ni para limpiar -- confirma que la regla no tiene excepciones');

  const del = store.deleteArticle({
    dataDir: tmpData,
    rootDir: tmpRoot,
    category: TEST_CATEGORY,
    slug: TEST_SLUG,
    confirmTitle: current.articles.find(function (a) { return a.slug === TEST_SLUG; }).title,
    confirmSlug: TEST_SLUG
  });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));

  const final = store.readArticlesWithRev(tmpData).articles;
  assert.strictEqual(final.length, N, 'debe volver exactamente a ' + N);

  // Verificación final: el archivo REAL del sandbox no se tocó en ningún
  // momento de esta corrida (todo pasó en tmpRoot/tmpData).
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS);
  const result = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  assert.ok(result.ok, 'data/articulos.json real del sandbox no debe haber cambiado: ' + result.detail);

  // Limpieza del directorio temporal.
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ===========================================================================
// K (extra, no pedido explícitamente pero cubre la validación de
//    path-traversal agregada a raíz de este mismo pedido).
// ===========================================================================
test('K (extra). category/slug con intento de path-traversal se rechazan', function () {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-traversal-'));
  const tmp2Data = path.join(tmp2, 'data');
  fs.mkdirSync(tmp2Data, { recursive: true });
  fs.writeFileSync(path.join(tmp2Data, 'articulos.json'), '[]\n', 'utf8');

  const attempts = [
    { category: '../../etc', slug: 'passwd' },
    { category: 'ai', slug: '../../../etc/passwd' },
    { category: 'ai', slug: 'algo/con/barras' },
    { category: 'ai', slug: 'algo.con.puntos' }
  ];
  attempts.forEach(function (a) {
    const r = store.deleteArticle({ dataDir: tmp2Data, rootDir: tmp2, category: a.category, slug: a.slug, confirmTitle: 'x', confirmSlug: a.slug });
    assert.strictEqual(r.status, 400, 'debe rechazar ' + JSON.stringify(a));
    assert.strictEqual(r.body.error, 'segmento_invalido');
  });
  fs.rmSync(tmp2, { recursive: true, force: true });
});

// ===========================================================================
// L (CONTROL NEGATIVO, 2026-09-27) -- demuestra que
//    admin/articulos-integrity-check.js efectivamente DETECTA los 3 tipos de
//    cambio que le importan a este archivo y a los otros 16 que lo usan.
//    Todo esto corre sobre un articulos.json de JUGUETE en un directorio
//    temporal propio -- nunca sobre el archivo real ni sobre tmpData/tmpRoot
//    de las pruebas A-K (que ya se borró arriba, en J).
// ===========================================================================
test('L1. Control negativo: integrity.unchanged() detecta un artículo AGREGADO', function () {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-integrity-negativo-'));
  const toy = path.join(tmp3, 'articulos.json');
  const base = [
    { category: 'ai', slug: 'juguete-uno', title: 'Uno' },
    { category: 'tech', slug: 'juguete-dos', title: 'Dos' }
  ];
  fs.writeFileSync(toy, JSON.stringify(base, null, 2) + '\n');
  const before = integrity.snapshot(toy);

  fs.writeFileSync(toy, JSON.stringify(base.concat([{ category: 'business', slug: 'juguete-tres', title: 'Tres' }]), null, 2) + '\n');
  const after = integrity.snapshot(toy);
  const result = integrity.unchanged(before, after);

  assert.strictEqual(result.ok, false, 'debe detectar la alta -- no puede dar ok:true');
  assert.ok(/agregad/i.test(result.detail), 'el detalle debe mencionar el alta: ' + result.detail);
  assert.ok(result.detail.indexOf('business/juguete-tres') !== -1, 'el detalle debe nombrar el slug agregado: ' + result.detail);

  fs.rmSync(tmp3, { recursive: true, force: true });
});

test('L2. Control negativo: integrity.unchanged() detecta un artículo ELIMINADO', function () {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-integrity-negativo-'));
  const toy = path.join(tmp3, 'articulos.json');
  const base = [
    { category: 'ai', slug: 'juguete-uno', title: 'Uno' },
    { category: 'tech', slug: 'juguete-dos', title: 'Dos' },
    { category: 'gaming', slug: 'juguete-tres', title: 'Tres' }
  ];
  fs.writeFileSync(toy, JSON.stringify(base, null, 2) + '\n');
  const before = integrity.snapshot(toy);

  fs.writeFileSync(toy, JSON.stringify(base.slice(0, 2), null, 2) + '\n');
  const after = integrity.snapshot(toy);
  const result = integrity.unchanged(before, after);

  assert.strictEqual(result.ok, false, 'debe detectar la baja -- no puede dar ok:true');
  assert.ok(/eliminad/i.test(result.detail), 'el detalle debe mencionar la baja: ' + result.detail);
  assert.ok(result.detail.indexOf('gaming/juguete-tres') !== -1, 'el detalle debe nombrar el slug eliminado: ' + result.detail);

  fs.rmSync(tmp3, { recursive: true, force: true });
});

test('L3. Control negativo: integrity.unchanged() detecta un artículo MODIFICADO sin cambiar la cantidad', function () {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-integrity-negativo-'));
  const toy = path.join(tmp3, 'articulos.json');
  const base = [
    { category: 'ai', slug: 'juguete-uno', title: 'Uno' },
    { category: 'tech', slug: 'juguete-dos', title: 'Dos' }
  ];
  fs.writeFileSync(toy, JSON.stringify(base, null, 2) + '\n');
  const before = integrity.snapshot(toy);

  const modified = JSON.parse(JSON.stringify(base));
  modified[1].title = 'Dos, pero con el título cambiado';
  fs.writeFileSync(toy, JSON.stringify(modified, null, 2) + '\n');
  const after = integrity.snapshot(toy);
  const result = integrity.unchanged(before, after);

  assert.strictEqual(result.ok, false, 'debe detectar la modificación -- no puede dar ok:true');
  assert.strictEqual(before.count, after.count, 'precondición del control: la cantidad debe seguir igual');
  assert.ok(/misma cantidad/i.test(result.detail) && /contenido/i.test(result.detail), 'el detalle debe indicar modificación sin cambio de cantidad: ' + result.detail);

  fs.rmSync(tmp3, { recursive: true, force: true });
});

test('L4. Control negativo (contraprueba): sin cambios, integrity.unchanged() da ok:true', function () {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-integrity-negativo-'));
  const toy = path.join(tmp3, 'articulos.json');
  const base = [{ category: 'ai', slug: 'juguete-uno', title: 'Uno' }];
  fs.writeFileSync(toy, JSON.stringify(base, null, 2) + '\n');
  const before = integrity.snapshot(toy);
  const after = integrity.snapshot(toy);
  const result = integrity.unchanged(before, after);
  assert.strictEqual(result.ok, true, 'sin cambios reales, debe dar ok:true: ' + result.detail);
  fs.rmSync(tmp3, { recursive: true, force: true });
});

console.log('');
console.log('Resultado: ' + passed + ' pasaron, ' + failed + ' fallaron, de ' + (passed + failed) + ' pruebas.');
process.exitCode = failed ? 1 : 0;
