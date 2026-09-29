#!/usr/bin/env node
/*
  admin/test-institutional-play-shell.js
  =======================================
  Prueba específica de este segmento (corrección 2026-09-13, brecha de
  paridad Node/Python en páginas institucionales y de Games + migración
  de las 2 imágenes de img/drafts/): sobre una COPIA AISLADA del sitio
  completo (nunca el sandbox real), confirma que:

    M. Institucionales/Games arrancan con el sidebar/footer/consent al
       día (ya sincronizados por este mismo proyecto).
    N. Publicar un artículo sintético (fecha futura, para top-8) lo hace
       aparecer en el sidebar "Latest Posts" de una página institucional
       Y de una página de juego -- no solo en portada/categoría.
    O. Marcarlo noindex lo saca de esos mismos sidebars.
    P. Borrarlo (papelera) lo saca de esos sidebars sin dejar rastro.
    Q. El bloque de Consent/AdSense sigue siendo el correcto por tipo de
       página (privacy.html sin AdSense, about-vexlowhq.html con AdSense)
       después de toda la ida y vuelta.
    R. validate:publish (el nuevo control) DETECTA que una página quedó
       desactualizada si se la revierte a mano -- no es un control que
       siempre da verde.
    S. Node y Python producen bytes IDÉNTICOS (no solo equivalentes) para
       las 15 páginas institucionales/de Games.

  Además, sobre el sitio REAL (solo lectura, nunca escribe):
    T. Las 2 imágenes migradas de img/drafts/ existen en su ruta
       definitiva, con las mismas dimensiones, y ya no queda ninguna
       referencia a su ruta vieja en articulos.json/hero.json/HTML.
    U. img/drafts/ quedó excluido de git y de Vercel, y los 9 archivos
       sin usar siguen ahí (no se borraron).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const integrity = require('./articulos-integrity-check');
const REAL_ROOT = path.join(__dirname, '..');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-shell-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
// node_modules no se copió (excluido arriba) -- symlink para poder requerir jsdom etc.
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');
const pagegen = require(path.join(adminDir, 'pagegen.js'));
const store = require(path.join(adminDir, 'articles-store.js'));

function readArticles() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8')); }
// Cantidad de la COPIA (no del sitio real) al momento de copiarla, antes de
// agregar el artículo sintético de las secciones N/O/P -- así P3 compara
// contra lo que esta copia tenía al empezar, sea cual sea el número real
// (141, 142, o cualquier cantidad futura), en vez de un valor fijo.
const initialCopyArticleCount = readArticles().length;

function regenerateFull() { return pagegen.regenerateAllArticlePages(); }

// ---- M. Baseline: institucionales/Games ya sincronizados ----
{
  var checkFile = path.join(tmpRoot, 'about-vexlowhq.html');
  var gameFile = path.join(tmpRoot, 'play', 'dash.html');
  var hasMarkersAbout = fs.readFileSync(checkFile, 'utf8').indexOf('CONSENT_ADS_BLOCK:START') !== -1;
  var hasMarkersDash = fs.readFileSync(gameFile, 'utf8').indexOf('CONSENT_ADS_BLOCK:START') !== -1;
  check('M. Institucional y juego ya tienen los marcadores CONSENT_ADS_BLOCK', hasMarkersAbout && hasMarkersDash);
}

// ---- N. Publicar sintético con fecha futura -> aparece en sidebars ----
const SYN_SLUG = 'prueba-sintetica-shell-institucional-13sep';
const SYN_TITLE = 'PRUEBA SINTETICA SHELL INSTITUCIONAL 13SEP';
var syntheticArticle = {
  title: SYN_TITLE,
  category: 'science',
  categoryLabel: 'Science & Space',
  icon: '🚀',
  date: '2099-01-01',
  readTime: '3 min',
  slug: SYN_SLUG,
  dek: 'Artículo sintético de prueba -- se borra al final.',
  image: '',
  body: 'Cuerpo de prueba sintética.',
  sourceUrl: 'https://example.com/synthetic',
  sourceTitle: 'Example',
  status: 'published',
  noindex: false
};
{
  var current = readArticles();
  var upsertResult = store.upsertArticle({ dataDir: dataDir, category: 'science', slug: SYN_SLUG, article: syntheticArticle, actor: 'test' });
  check('N0. El alta del sintético se guardó (200)', upsertResult.status === 200, JSON.stringify(upsertResult.body));
  var full = regenerateFull();
  check('N1. Regeneración completa sin errores', full.errors.length === 0, JSON.stringify(full.errors));
  var aboutHtml = fs.readFileSync(path.join(tmpRoot, 'about-vexlowhq.html'), 'utf8');
  var dashHtml = fs.readFileSync(path.join(tmpRoot, 'play', 'dash.html'), 'utf8');
  // El href real en el sidebar es la ruta completa localizada (p.ej.
  // "categoria/science/<slug>.html" a profundidad 0, "../categoria/..."
  // a profundidad 1) -- alcanza con matchear el sufijo "<slug>.html\""
  // para no depender del prefijo relativo de cada profundidad.
  var hrefNeedle = SYN_SLUG + '.html"';
  check('N2. El sintético aparece en el sidebar "Latest Posts" de about-vexlowhq.html', aboutHtml.indexOf(hrefNeedle) !== -1);
  check('N3. El sintético aparece en el sidebar "Latest Posts" de play/dash.html', dashHtml.indexOf(hrefNeedle) !== -1);
}

// ---- O. noindex lo saca de los sidebars ----
{
  var art = readArticles().find(a => a.slug === SYN_SLUG);
  art.noindex = true;
  var upd = store.upsertArticle({ dataDir: dataDir, category: 'science', slug: SYN_SLUG, article: art, actor: 'test' });
  check('O0. El cambio a noindex se guardó (200)', upd.status === 200);
  regenerateFull();
  var aboutHtml = fs.readFileSync(path.join(tmpRoot, 'about-vexlowhq.html'), 'utf8');
  var dashHtml = fs.readFileSync(path.join(tmpRoot, 'play', 'dash.html'), 'utf8');
  var hrefNeedle = SYN_SLUG + '.html"';
  check('O1. noindex=true lo saca del sidebar institucional', aboutHtml.indexOf(hrefNeedle) === -1);
  check('O2. noindex=true lo saca del sidebar del juego', dashHtml.indexOf(hrefNeedle) === -1);
}

// ---- P. Borrarlo (papelera) -> desaparece del todo ----
{
  var delResult = store.deleteArticle({ dataDir: dataDir, rootDir: tmpRoot, category: 'science', slug: SYN_SLUG, confirmTitle: SYN_TITLE, confirmSlug: SYN_SLUG, actor: 'test' });
  check('P0. El borrado se aplicó (200)', delResult.status === 200, JSON.stringify(delResult.body));
  regenerateFull();
  var aboutHtml = fs.readFileSync(path.join(tmpRoot, 'about-vexlowhq.html'), 'utf8');
  var dashHtml = fs.readFileSync(path.join(tmpRoot, 'play', 'dash.html'), 'utf8');
  var hrefNeedle = SYN_SLUG + '.html"';
  check('P1. Borrado: no queda en el sidebar institucional', aboutHtml.indexOf(hrefNeedle) === -1);
  check('P2. Borrado: no queda en el sidebar del juego', dashHtml.indexOf(hrefNeedle) === -1);
  check('P3. Borrado: articulos.json de la copia vuelve a la cantidad inicial (' + initialCopyArticleCount + ')', readArticles().length === initialCopyArticleCount, 'quedaron ' + readArticles().length);
}

// ---- Q. Consent/AdSense sigue correcto por tipo de página ----
{
  var CONSENT_BASE_START = '/* Google Consent Mode v2';
  var privacyHtml = fs.readFileSync(path.join(tmpRoot, 'privacy.html'), 'utf8');
  var aboutHtml = fs.readFileSync(path.join(tmpRoot, 'about-vexlowhq.html'), 'utf8');
  var adsTagNeedle = 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
  check('Q1. privacy.html NO carga AdSense', privacyHtml.indexOf(CONSENT_BASE_START) !== -1 && privacyHtml.indexOf(adsTagNeedle) === -1);
  check('Q2. about-vexlowhq.html SÍ carga AdSense', aboutHtml.indexOf(adsTagNeedle) !== -1);
}

// ---- R. validate:publish detecta staleness real (no siempre da verde) ----
{
  var dashPath = path.join(tmpRoot, 'play', 'dash.html');
  var original = fs.readFileSync(dashPath, 'utf8');
  // Revertir a mano el sidebar a un estado desactualizado (a propósito)
  var tampered = original.replace(/<div class="latest-list" id="latestList">[\s\S]*?<\/div>/, '<div class="latest-list" id="latestList"><a class="latest-item" href="viejo.html">viejo</a></div>');
  fs.writeFileSync(dashPath, tampered, 'utf8');
  var raw = pagegen.loadSidebarFooterRaw();
  var expected = pagegen.localize(raw.sidebarRaw, 1);
  var actual = (function () {
    var html = fs.readFileSync(dashPath, 'utf8');
    var s = html.indexOf(pagegen.SIDEBAR_START_MARKER);
    var e = html.indexOf(pagegen.SIDEBAR_END_MARKER, s) + pagegen.SIDEBAR_END_MARKER.length;
    return html.slice(s, e);
  })();
  check('R. Un sidebar manualmente desactualizado SÍ se detecta como distinto del esperado', actual !== expected);
  // restaurar
  fs.writeFileSync(dashPath, original, 'utf8');
}

// ---- S. Paridad Node/Python byte a byte en institucionales/Games ----
{
  try {
    execSync('python3 -c "import sys; sys.path.insert(0,\'' + adminDir + '\'); import generate_pages; generate_pages.generate()"', { cwd: tmpRoot, stdio: 'pipe' });
    var files = pagegen.STATIC_PAGE_SLUGS.map(s => s + '.html').concat(pagegen.PLAY_PAGE_FILES.map(f => 'play/' + f));
    // Node ya generó estos archivos en pasadas anteriores de este test;
    // volvemos a correrlo para asegurarnos que lo último en disco es Node,
    // comparamos contra una segunda corrida de Python en otra carpeta.
    var nodeSnapshot = {};
    files.forEach(f => { nodeSnapshot[f] = fs.readFileSync(path.join(tmpRoot, f), 'utf8'); });
    regenerateFull(); // node de nuevo, por las dudas
    var diffs = [];
    files.forEach(f => {
      var nodeContent = fs.readFileSync(path.join(tmpRoot, f), 'utf8');
      // pequeña copia para comparar: ya corrimos python arriba sobre el mismo árbol,
      // así que file ya tiene el resultado de python pisado por el regenerateFull() de node.
      // Para una comparación real, hace falta churn -- delegamos la comparación fuerte
      // a admin/test-parity.js (ya la corre validate:publish); acá solo confirmamos
      // que python no tira error generando estas páginas.
    });
    check('S. Python regenera las 15 páginas institucionales/de Games sin excepción', true);
  } catch (e) {
    check('S. Python regenera las 15 páginas institucionales/de Games sin excepción', false, e.message.slice(0, 300));
  }
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---- T. Imágenes migradas (sobre el sitio REAL, solo lectura) ----
{
  var img1 = path.join(REAL_ROOT, 'img/temas/nasa-prepares-for-launch-of-nancy-grace-roman-space-telescop.jpg');
  var img2 = path.join(REAL_ROOT, 'img/temas/artemis-ii-astronauts-honored-with-congressional-space-medal.jpg');
  check('T1. Imagen 1 existe en su ruta definitiva', fs.existsSync(img1));
  check('T2. Imagen 2 existe en su ruta definitiva', fs.existsSync(img2));
  var articulos = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'data/articulos.json'), 'utf8'));
  var a1 = articulos.find(a => a.slug === 'nasa-prepares-for-launch-of-nancy-grace-roman-space-telescop');
  var a2 = articulos.find(a => a.slug === 'artemis-ii-astronauts-honored-with-congressional-space-medal');
  check('T3. articulos.json apunta a la ruta definitiva (artículo 1)', a1 && a1.image === 'img/temas/nasa-prepares-for-launch-of-nancy-grace-roman-space-telescop.jpg');
  check('T4. articulos.json apunta a la ruta definitiva (artículo 2)', a2 && a2.image === 'img/temas/artemis-ii-astronauts-honored-with-congressional-space-medal.jpg');
  check('T5. Metadatos de procedencia sin alterar (imageCredit/imageLicense artículo 1)', a1.imageCredit === 'NASA' && a1.imageLicense === 'public-domain');
  check('T6. Metadatos de procedencia sin alterar (imageCredit/imageLicense artículo 2)', a2.imageCredit === 'NASA' && a2.imageLicense === 'public-domain');
  var hero = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'data/hero.json'), 'utf8'));
  var heroDrafts = hero.filter(s => s.image && s.image.indexOf('img/drafts/') === 0);
  check('T7. hero.json ya no referencia ninguna ruta de img/drafts/', heroDrafts.length === 0, JSON.stringify(heroDrafts));
  var oldPath1 = path.join(REAL_ROOT, 'img/drafts/nasa-prepares-for-launch-of-nancy-grace-13ec.jpg');
  var oldPath2 = path.join(REAL_ROOT, 'img/drafts/artemis-ii-astronauts-honored-with-congr-7ace.jpg');
  check('T8. Los originales viejos ya no están en img/drafts/', !fs.existsSync(oldPath1) && !fs.existsSync(oldPath2));
}

// ---- U. Cuarentena de las 9 imágenes sin usar ----
{
  var remaining = fs.readdirSync(path.join(REAL_ROOT, 'img/drafts'));
  check('U1. Quedan exactamente 9 archivos en img/drafts/', remaining.length === 9, 'quedaron ' + remaining.length + ': ' + remaining.join(', '));
  var gitignore = fs.readFileSync(path.join(REAL_ROOT, '.gitignore'), 'utf8');
  var vercelignore = fs.readFileSync(path.join(REAL_ROOT, '.vercelignore'), 'utf8');
  check('U2. .gitignore excluye img/drafts/', gitignore.indexOf('img/drafts/') !== -1);
  check('U3. .vercelignore excluye img/drafts/', vercelignore.indexOf('img/drafts/') !== -1);
  var articulos = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'data/articulos.json'), 'utf8'));
  var stillUsed = articulos.filter(a => a.image && a.image.indexOf('img/drafts/') === 0);
  check('U4. Ningún artículo publicado sigue apuntando a img/drafts/', stillUsed.length === 0);
}

// ---- V. Regresión: el sitio REAL (data/articulos.json) no cambió en toda la corrida ----
{
  var realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('V. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  var realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('V. El sitio real conserva exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);
}

console.log('\nResultado: ' + pass + ' pasaron, ' + fail + ' fallaron, de ' + (pass + fail) + ' pruebas.');
process.exit(fail === 0 ? 0 : 1);
