/*
  test-nav-category-reorg.js — Prueba integral de navegación tras la
  reorganización de categorías (Science & Space retirada del menú,
  Entertainment renombrada a "Movies, TV & Anime") -- pedido explícito de
  Leonardo, 2026-09-27, punto 4 de la ronda de correcciones antes de
  sincronizar.
  ============================================================================
  Corre SIEMPRE sobre copias temporales aisladas (os.tmpdir()), nunca sobre
  /home/claude/site ni sobre el dispositivo real -- mismo patrón que
  admin/test-parity.js y admin/test-related-links-fix.js.

  Verifica, sobre una regeneración COMPLETA real (Node y, por separado,
  Python):
    1. El menú (sidebar) muestra "Movies, TV & Anime" para la categoría
       entertainment.
    2. El menú (sidebar) NO muestra "Science & Space" / data-cat="science".
    3. La página vieja de Science (categoria/science/index.html) sigue
       existiendo y generándose -- no se borró la categoría ni sus
       artículos.
    4. Un artículo real de Science conserva su URL exacta y sigue
       generándose.
    5. /categoria/entertainment/ conserva su URL exacta (el slug interno
       "entertainment" no cambió pese al rename visible).
    6. Play Games (href="play/index.html", data-cat="play") sigue presente
       en el menú, distinto de Gaming (data-cat="gaming") -- no se
       confunden.
    7. Node y Python generan EXACTAMENTE los mismos bloques de nav
       (sidebar/footer/chips) -- comparación byte a byte de cada bloque,
       no del archivo completo (evita el ruido de la excepción de
       whitespace ya documentada en test-parity.js, que es previa a este
       proyecto y no tiene que ver con el nav).
    8. 0 enlaces internos rotos, en la salida de Node y en la de Python,
       por separado.

  Uso: node admin/test-nav-category-reorg.js
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');

const REAL_ROOT = path.join(__dirname, '..');
const REAL_ARTICULOS = path.join(REAL_ROOT, 'data', 'articulos.json');

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

const hashRealArticulosBefore = sha256File(REAL_ARTICULOS);

function copyProjectTo(dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(REAL_ROOT, { withFileTypes: true }).forEach(function (entry) {
    if (entry.name === '.git') return;
    fs.cpSync(path.join(REAL_ROOT, entry.name), path.join(dest, entry.name), { recursive: true });
  });
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-nav-reorg-'));
const nodeDir = path.join(tmpBase, 'node-output');
const pyDir = path.join(tmpBase, 'python-output');
console.log('Copiando el sitio a dos carpetas temporales aisladas...');
console.log('  Node:   ' + nodeDir);
console.log('  Python: ' + pyDir);
copyProjectTo(nodeDir);
copyProjectTo(pyDir);

const pagegen = require(path.join(nodeDir, 'admin', 'pagegen.js'));
const linkScanner = require(path.join(nodeDir, 'admin', 'link-scanner.js'));

console.log('\nCorriendo la regeneración completa con Node (pagegen.js)...');
const nodeResult = pagegen.regenerateAllArticlePages();
assert.strictEqual(nodeResult.errors.length, 0, 'la regeneración Node no debe tirar errores:\n' + JSON.stringify(nodeResult.errors, null, 2));
console.log('  OK, sin errores.');

console.log('\nCorriendo la regeneración completa con Python (generate_pages.py)...');
execFileSync('python3', ['generate_pages.py'], { cwd: path.join(pyDir, 'admin'), stdio: 'pipe' });
console.log('  OK, sin errores.');
console.log('');

const nodeIndex = fs.readFileSync(path.join(nodeDir, 'index.html'), 'utf8');
const pyIndex = fs.readFileSync(path.join(pyDir, 'index.html'), 'utf8');

function extractBlock(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, 'marcador de inicio no encontrado: ' + startMarker);
  const endIdx = html.indexOf(endMarker, start);
  assert.ok(endIdx !== -1, 'marcador de fin no encontrado: ' + endMarker);
  return html.slice(start, endIdx + endMarker.length);
}

const nodeNavBlock = extractBlock(nodeIndex, '<span class="side-label">Categories</span>', '</nav>');
const pyNavBlock = extractBlock(pyIndex, '<span class="side-label">Categories</span>', '</nav>');
const nodeFooterBlock = extractBlock(nodeIndex, '<div class="footer-col">\n          <h4>Categories</h4>', '<div class="footer-col">\n          <h4>Trust</h4>');
const pyFooterBlock = extractBlock(pyIndex, '<div class="footer-col">\n          <h4>Categories</h4>', '<div class="footer-col">\n          <h4>Trust</h4>');
const nodeChipsBlock = extractBlock(nodeIndex, '<div class="filter-row" id="filterRow">', '</div>');
const pyChipsBlock = extractBlock(pyIndex, '<div class="filter-row" id="filterRow">', '</div>');

// ===========================================================================
// 1-2. El menú muestra "Movies, TV & Anime" y NO muestra Science & Space.
// ===========================================================================
test('1. El menú (sidebar) muestra "Movies, TV & Anime" para entertainment', function () {
  assert.ok(nodeNavBlock.indexOf('data-cat="entertainment"') !== -1, 'debe existir el ítem de nav de entertainment');
  assert.ok(nodeNavBlock.indexOf('Movies, TV &amp; Anime') !== -1, 'el nav de Node debe mostrar "Movies, TV & Anime"');
  assert.ok(nodeNavBlock.indexOf('>Entertainment<') === -1, 'el nav de Node NO debe seguir diciendo "Entertainment" a secas');
});

test('2. El menú (sidebar) NO muestra Science & Space / data-cat="science"', function () {
  assert.ok(nodeNavBlock.indexOf('data-cat="science"') === -1, 'no debe existir un ítem de nav para science');
  assert.ok(nodeNavBlock.indexOf('Science') === -1, 'la palabra "Science" no debe aparecer en el nav principal');
  assert.ok(nodeFooterBlock.indexOf('categoria/science/') === -1, 'el footer de categorías no debe enlazar a science');
  assert.ok(nodeChipsBlock.indexOf('data-filter="science"') === -1, 'los chips de filtro no deben incluir a science');
});

// ===========================================================================
// 3-4. La página vieja de Science sigue existiendo, con sus artículos y URL.
// ===========================================================================
test('3. categoria/science/index.html se sigue generando (no se borró la categoría)', function () {
  const sciIndexPath = path.join(nodeDir, 'categoria', 'science', 'index.html');
  assert.ok(fs.existsSync(sciIndexPath), 'la página de índice de la categoría science debe seguir existiendo');
  const sciIndexHtml = fs.readFileSync(sciIndexPath, 'utf8');
  assert.ok(sciIndexHtml.indexOf('Science') !== -1, 'la página de categoría science debe seguir mostrando su propio nombre');
});

test('4. Un artículo real de Science conserva su URL exacta y sigue generándose', function () {
  const articles = JSON.parse(fs.readFileSync(REAL_ARTICULOS, 'utf8'));
  const sciArticle = articles.find(function (a) { return a.category === 'science' && a.slug; });
  assert.ok(sciArticle, 'precondición: debe existir al menos un artículo real de la categoría science');
  const articlePath = path.join(nodeDir, 'categoria', 'science', sciArticle.slug + '.html');
  assert.ok(fs.existsSync(articlePath), 'la página del artículo de Science debe seguir existiendo en su URL de siempre: categoria/science/' + sciArticle.slug + '.html');
  const articleHtml = fs.readFileSync(articlePath, 'utf8');
  assert.ok(articleHtml.indexOf(sciArticle.title.replace(/&/g, '&amp;')) !== -1 || articleHtml.indexOf(sciArticle.title) !== -1, 'la página del artículo debe seguir mostrando su propio título');
});

// ===========================================================================
// 5. /categoria/entertainment/ conserva su URL exacta (slug intacto).
// ===========================================================================
test('5. /categoria/entertainment/ conserva su URL exacta pese al rename visible', function () {
  const entIndexPath = path.join(nodeDir, 'categoria', 'entertainment', 'index.html');
  assert.ok(fs.existsSync(entIndexPath), 'categoria/entertainment/index.html debe seguir existiendo con ese slug exacto');
  const entHtml = fs.readFileSync(entIndexPath, 'utf8');
  assert.ok(entHtml.indexOf('Movies, TV &amp; Anime') !== -1, 'el <h1> de la página debe mostrar el nombre visible nuevo');
});

// ===========================================================================
// 6. Play Games sigue presente y no se confunde con Gaming.
// ===========================================================================
test('6. Play Games sigue presente en el menú, distinto de Gaming', function () {
  assert.ok(nodeNavBlock.indexOf('href="play/index.html" data-cat="play"') !== -1, 'debe existir el ítem "Games" -> play/index.html');
  assert.ok(nodeNavBlock.indexOf('>Games<') !== -1, 'el ítem de Play Games debe decir "Games"');
  assert.ok(nodeNavBlock.indexOf('data-cat="gaming"') !== -1, 'la categoría Gaming (noticias) debe seguir presente por separado');
  assert.ok(nodeNavBlock.indexOf('href="categoria/gaming/index.html" data-cat="gaming"') !== -1, 'Gaming debe apuntar a su categoría de noticias, no a Play Games');
  assert.ok(fs.existsSync(path.join(nodeDir, 'play', 'index.html')), 'play/index.html (el hub de juegos) debe seguir existiendo como página propia');
});

// ===========================================================================
// 7. Node y Python generan EXACTAMENTE los mismos bloques de nav.
// ===========================================================================
test('7a. El bloque de sidebar (nav de categorías) es idéntico en Node y Python', function () {
  assert.strictEqual(nodeNavBlock, pyNavBlock, 'el bloque de sidebar debe ser byte a byte idéntico entre Node y Python');
});
test('7b. El bloque de footer (categorías) es idéntico en Node y Python', function () {
  assert.strictEqual(nodeFooterBlock, pyFooterBlock, 'el bloque de footer de categorías debe ser byte a byte idéntico entre Node y Python');
});
test('7c. El bloque de chips de filtro es idéntico en Node y Python', function () {
  assert.strictEqual(nodeChipsBlock, pyChipsBlock, 'el bloque de chips de filtro debe ser byte a byte idéntico entre Node y Python');
});

// ===========================================================================
// 8. 0 enlaces internos rotos, en Node y en Python por separado.
// ===========================================================================
test('8a. 0 enlaces internos rotos en la salida de Node', function () {
  const scan = linkScanner.scanPublicHtml(nodeDir);
  assert.strictEqual(scan.broken.length, 0, JSON.stringify(scan.broken.slice(0, 10), null, 2));
  assert.ok(scan.filesScanned >= 141, 'debe haber escaneado al menos las 141 páginas de artículo reales (escaneó ' + scan.filesScanned + ')');
});
test('8b. 0 enlaces internos rotos en la salida de Python', function () {
  const linkScannerForPy = require(path.join(pyDir, 'admin', 'link-scanner.js'));
  const scan = linkScannerForPy.scanPublicHtml(pyDir);
  assert.strictEqual(scan.broken.length, 0, JSON.stringify(scan.broken.slice(0, 10), null, 2));
});

// ===========================================================================
// 9. El archivo REAL nunca se tocó durante toda esta corrida.
// ===========================================================================
test('9. data/articulos.json real no cambió ni un byte durante toda la corrida', function () {
  const hashAfter = sha256File(REAL_ARTICULOS);
  assert.strictEqual(hashAfter, hashRealArticulosBefore, 'el archivo real no debe haber cambiado -- toda esta prueba corrió sobre ' + tmpBase);
});

fs.rmSync(tmpBase, { recursive: true, force: true });

console.log('');
console.log('Resultado: ' + passed + ' pasaron, ' + failed + ' fallaron, de ' + (passed + failed) + ' pruebas.');
process.exitCode = failed ? 1 : 0;
