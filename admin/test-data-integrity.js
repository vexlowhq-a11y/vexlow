/*
  test-data-integrity.js — pruebas del arreglo post-incidente 2026-09-13
  ========================================================================
  Corre los escenarios A-J pedidos para validar articles-store.js. Usa
  EXCLUSIVAMENTE datos sintéticos en un directorio temporal aislado
  (os.tmpdir()) creado y borrado por esta misma corrida -- en ningún
  momento toca data/articulos.json real (ni el estado de 169 "antes" ni
  el de 141 "después" del incidente). El test J lo verifica de forma
  explícita, comparando el hash de los archivos reales antes y después de
  correr todo lo demás.

  Uso: node admin/test-data-integrity.js
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const store = require('./articles-store');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name: name, ok: true });
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    results.push({ name: name, ok: false, error: e.message });
    console.log('FAIL  ' + name);
    console.log('      ' + e.message);
  }
}

function sha256File(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeTempSite(articles) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-test-'));
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'articulos.json'), JSON.stringify(articles, null, 2) + '\n', 'utf8');
  // Crea también las páginas HTML "reales" de cada artículo sintético, para
  // poder probar de verdad el movimiento a papelera (F/G), no solo el JSON.
  articles.forEach(function (a) {
    const htmlPath = store.articleHtmlPath(rootDir, a.category, a.slug);
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, '<html><!-- ' + a.slug + ' --><body>' + a.title + '</body></html>', 'utf8');
  });
  return { rootDir: rootDir, dataDir: dataDir };
}

function synthArticle(n, extra) {
  return Object.assign({
    title: 'Artículo sintético ' + n,
    slug: 'articulo-sintetico-' + n,
    category: 'ai',
    noindex: false,
    sourceUrl: 'https://example.com/fuente-' + n,
    body: 'Cuerpo de prueba ' + n
  }, extra || {});
}

// ---------------------------------------------------------------------------
// Datos reales de referencia -- SOLO para el test J (comprobar que nunca se
// tocan). Se leen, se hashean, y nunca se escriben.
// ---------------------------------------------------------------------------
const REAL_BEFORE_169 = '/home/claude/incident-20260913/before_169/data/articulos.json';
const REAL_AFTER_141 = '/home/claude/incident-20260913/after_141/data/articulos.json';
const REAL_LIVE_SANDBOX = '/home/claude/site/data/articulos.json';

const hashBefore169 = sha256File(REAL_BEFORE_169);
const hashAfter141 = sha256File(REAL_AFTER_141);
const hashLiveSandboxBefore = sha256File(REAL_LIVE_SANDBOX);

// ===========================================================================
// A. Dos pestañas cargan la misma revisión.
// ===========================================================================
let site1, tabA, tabB;
test('A. Dos pestañas cargan la misma revisión', function () {
  site1 = makeTempSite([synthArticle(1), synthArticle(2), synthArticle(3)]);
  tabA = store.readArticlesWithRev(site1.dataDir);
  tabB = store.readArticlesWithRev(site1.dataDir);
  assert.strictEqual(tabA.rev, tabB.rev, 'ambas pestañas deben ver la misma revisión al cargar el mismo estado');
  assert.strictEqual(tabA.articles.length, 3);
});

// ===========================================================================
// B. Pestaña A guarda un artículo (edita el 2, manda el array completo con
//    su revisión base -- así es como debería mandar un cliente actualizado).
// ===========================================================================
let saveA;
test('B. Pestaña A guarda un artículo (con su revisión base)', function () {
  const editedByA = tabA.articles.map(function (a) {
    return a.slug === 'articulo-sintetico-2' ? Object.assign({}, a, { title: 'Editado por A' }) : a;
  });
  saveA = store.saveBulkArticles({ dataDir: site1.dataDir, articles: editedByA, ifMatchRev: tabA.rev, actor: 'tabA' });
  assert.strictEqual(saveA.status, 200, 'el guardado de A debe aceptarse: ' + JSON.stringify(saveA.body));
  const now = store.readArticlesWithRev(site1.dataDir);
  assert.strictEqual(now.articles.find(function (a) { return a.slug === 'articulo-sintetico-2'; }).title, 'Editado por A');
});

// ===========================================================================
// C. Pestaña B, que sigue con la revisión vieja (tabB.rev === tabA.rev,
//    previa al guardado de A), intenta guardar SU copia -- desactualizada
//    respecto de lo que ya escribió A.
// ===========================================================================
let saveB;
test('C. Pestaña B intenta guardar su copia vieja -> debe rechazarse (409)', function () {
  saveB = store.saveBulkArticles({ dataDir: site1.dataDir, articles: tabB.articles, ifMatchRev: tabB.rev, actor: 'tabB' });
  assert.strictEqual(saveB.status, 409, 'debe responder 409 porque la revisión de B ya no es la actual');
  assert.strictEqual(saveB.body.error, 'revision_conflict');
});

// ===========================================================================
// D. El servidor no debe haber perdido ningún artículo tras B y C.
// ===========================================================================
test('D. Ningún artículo se perdió tras el conflicto de B', function () {
  const final = store.readArticlesWithRev(site1.dataDir);
  assert.strictEqual(final.articles.length, 3, 'deben seguir los 3 artículos sintéticos');
  assert.strictEqual(final.articles.find(function (a) { return a.slug === 'articulo-sintetico-2'; }).title, 'Editado por A', 'debe conservarse la edición de A, no la de B');
});

// ===========================================================================
// E. Editar un artículo (vía upsert de UN solo artículo) modifica solamente
//    ese artículo.
// ===========================================================================
let site2;
test('E. Editar un artículo modifica solamente ese artículo', function () {
  site2 = makeTempSite([synthArticle(10), synthArticle(11), synthArticle(12)]);
  const before = store.readArticlesWithRev(site2.dataDir).articles;
  const r = store.upsertArticle({
    dataDir: site2.dataDir,
    category: 'ai',
    slug: 'articulo-sintetico-11',
    article: Object.assign({}, before.find(function (a) { return a.slug === 'articulo-sintetico-11'; }), { title: 'Título corregido' })
  });
  assert.strictEqual(r.status, 200);
  const after = store.readArticlesWithRev(site2.dataDir).articles;
  assert.strictEqual(after.length, 3, 'no debe cambiar el total');
  assert.deepStrictEqual(after.find(function (a) { return a.slug === 'articulo-sintetico-10'; }), before.find(function (a) { return a.slug === 'articulo-sintetico-10'; }), 'el 10 no debe tocarse');
  assert.deepStrictEqual(after.find(function (a) { return a.slug === 'articulo-sintetico-12'; }), before.find(function (a) { return a.slug === 'articulo-sintetico-12'; }), 'el 12 no debe tocarse');
  assert.strictEqual(after.find(function (a) { return a.slug === 'articulo-sintetico-11'; }).title, 'Título corregido');
});

// ===========================================================================
// F. Eliminar uno mueve SOLAMENTE ese artículo a papelera (JSON + HTML).
// ===========================================================================
let site3;
test('F. Eliminar un artículo lo mueve solo a él a papelera (JSON + HTML)', function () {
  site3 = makeTempSite([synthArticle(20), synthArticle(21), synthArticle(22)]);
  const htmlPath21 = store.articleHtmlPath(site3.rootDir, 'ai', 'articulo-sintetico-21');
  assert.ok(fs.existsSync(htmlPath21), 'precondición: el HTML del 21 debe existir antes de borrar');

  const r = store.deleteArticle({
    dataDir: site3.dataDir,
    rootDir: site3.rootDir,
    category: 'ai',
    slug: 'articulo-sintetico-21',
    confirmTitle: 'Artículo sintético 21',
    confirmSlug: 'articulo-sintetico-21'
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = store.readArticlesWithRev(site3.dataDir).articles;
  assert.strictEqual(after.length, 2, 'debe quedar en 2 (era 3)');
  assert.ok(!after.some(function (a) { return a.slug === 'articulo-sintetico-21'; }), 'el 21 ya no debe estar activo');
  assert.ok(after.some(function (a) { return a.slug === 'articulo-sintetico-20'; }), 'el 20 debe seguir activo');
  assert.ok(after.some(function (a) { return a.slug === 'articulo-sintetico-22'; }), 'el 22 debe seguir activo');

  // El HTML NO debe estar borrado -- debe estar movido a _trash/.
  assert.ok(!fs.existsSync(htmlPath21), 'el HTML original ya no debe estar en su ruta pública');
  const trashPath21 = store.trashHtmlPath(site3.rootDir, 'ai', 'articulo-sintetico-21');
  assert.ok(fs.existsSync(trashPath21), 'el HTML debe existir movido dentro de _trash/');

  const trash = store.readTrash(site3.dataDir);
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].slug, 'articulo-sintetico-21');
});

// ===========================================================================
// G. Restaurar desde papelera recupera contenido y HTML.
// ===========================================================================
test('G. Restaurar desde papelera recupera contenido y HTML', function () {
  const r = store.restoreArticle({ dataDir: site3.dataDir, rootDir: site3.rootDir, category: 'ai', slug: 'articulo-sintetico-21' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = store.readArticlesWithRev(site3.dataDir).articles;
  assert.strictEqual(after.length, 3, 'debe volver a 3');
  const restored = after.find(function (a) { return a.slug === 'articulo-sintetico-21'; });
  assert.ok(restored, 'el 21 debe estar de vuelta');
  assert.strictEqual(restored.title, 'Artículo sintético 21');

  const htmlPath21 = store.articleHtmlPath(site3.rootDir, 'ai', 'articulo-sintetico-21');
  assert.ok(fs.existsSync(htmlPath21), 'el HTML debe estar de vuelta en su ruta pública');
  assert.ok(fs.readFileSync(htmlPath21, 'utf8').includes('articulo-sintetico-21'), 'el contenido del HTML restaurado debe ser el original');

  const trash = store.readTrash(site3.dataDir);
  assert.strictEqual(trash.length, 0, 'la papelera debe quedar vacía tras restaurar');
});

// ===========================================================================
// H. Guardar un draft no modifica artículos ajenos.
// ===========================================================================
test('H. Guardar un draft (nuevo, incompleto) no modifica artículos ajenos', function () {
  const site4 = makeTempSite([synthArticle(30), synthArticle(31)]);
  const before = store.readArticlesWithRev(site4.dataDir).articles;
  const draft = synthArticle(99, { status: 'draft', draftIncomplete: true, body: '' });
  const r = store.upsertArticle({ dataDir: site4.dataDir, category: 'ai', slug: 'articulo-sintetico-99', article: draft });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = store.readArticlesWithRev(site4.dataDir).articles;
  assert.strictEqual(after.length, 3);
  assert.deepStrictEqual(after.find(function (a) { return a.slug === 'articulo-sintetico-30'; }), before.find(function (a) { return a.slug === 'articulo-sintetico-30'; }));
  assert.deepStrictEqual(after.find(function (a) { return a.slug === 'articulo-sintetico-31'; }), before.find(function (a) { return a.slug === 'articulo-sintetico-31'; }));
  const savedDraft = after.find(function (a) { return a.slug === 'articulo-sintetico-99'; });
  assert.strictEqual(savedDraft.status, 'draft');
});

// ===========================================================================
// I. Una petición directa con un array incompleto (simula una pestaña vieja
//    o un curl manual) NO puede borrar artículos -- ni con revisión correcta
//    ni sin ella.
// ===========================================================================
test('I. Una petición con array incompleto no puede borrar artículos (con o sin revisión correcta)', function () {
  const site5 = makeTempSite([synthArticle(40), synthArticle(41), synthArticle(42), synthArticle(43)]);
  const state = store.readArticlesWithRev(site5.dataDir);

  // Caso 1: manda la revisión correcta pero un array con menos artículos
  // (como pasó en el incidente real).
  const incomplete = state.articles.filter(function (a) { return a.slug !== 'articulo-sintetico-42'; });
  const r1 = store.saveBulkArticles({ dataDir: site5.dataDir, articles: incomplete, ifMatchRev: state.rev });
  assert.strictEqual(r1.status, 409);
  assert.strictEqual(r1.body.error, 'reduccion_no_permitida');
  assert.strictEqual(store.readArticlesWithRev(site5.dataDir).articles.length, 4, 'no debe haberse escrito nada');

  // Caso 2: ni siquiera manda revisión (cliente legado/curl directo) -- la
  // defensa en profundidad debe frenarlo igual.
  const r2 = store.saveBulkArticles({ dataDir: site5.dataDir, articles: incomplete });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.body.error, 'reduccion_no_permitida');
  assert.strictEqual(store.readArticlesWithRev(site5.dataDir).articles.length, 4, 'sigue sin perder artículos');
});

// ===========================================================================
// J. Ninguna de estas pruebas modificó los 141 ni los 169 artículos reales.
// ===========================================================================
test('J. Las pruebas no tocaron los datos reales (141 actuales ni 169 previos)', function () {
  assert.ok(hashBefore169, 'debe existir la copia protegida de 169 para poder comparar');
  assert.ok(hashAfter141, 'debe existir la copia protegida de 141 para poder comparar');
  const hashBefore169After = sha256File(REAL_BEFORE_169);
  const hashAfter141After = sha256File(REAL_AFTER_141);
  const hashLiveSandboxAfter = sha256File(REAL_LIVE_SANDBOX);
  assert.strictEqual(hashBefore169, hashBefore169After, 'la copia protegida de 169 no debe haber cambiado ni un byte');
  assert.strictEqual(hashAfter141, hashAfter141After, 'la copia protegida de 141 no debe haber cambiado ni un byte');
  assert.strictEqual(hashLiveSandboxBefore, hashLiveSandboxAfter, 'el articulos.json real del sandbox (169) no debe haber cambiado ni un byte');
});

console.log('');
console.log('Resultado: ' + passed + ' pasaron, ' + failed + ' fallaron, de ' + (passed + failed) + ' pruebas.');
process.exitCode = failed ? 1 : 0;
