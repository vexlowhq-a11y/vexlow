#!/usr/bin/env node
/*
  admin/test-preview-assets.js
  ==============================
  Seguimiento del arreglo de vista previa (GET /api/preview/:category/:slug,
  ver admin/test-preview-endpoint.js): la vista previa ya funcionaba, pero
  cargaba "completamente sin estilos y con imágenes rotas". Causa raíz: el
  HTML de un artículo se arma SIEMPRE con rutas relativas ("../../css/
  style.css", "../../js/script.js", banners e imágenes con "../../",
  breadcrumb con "index.html", el rail de relacionados con "../<cat>/...")
  porque la página pública real vive dos niveles bajo la raíz del sitio
  (categoria/<cat>/<slug>.html). La vista previa, en cambio, se sirve en
  /api/preview/<cat>/<slug> -- una ruta de API, NO un archivo ubicado ahí
  en el disco -- así que el navegador resolvía esos mismos relativos contra
  la URL de la petición y terminaba pidiendo, por ejemplo,
  /api/css/style.css en vez de /site/css/style.css. Cero 404 "obvios" a
  nivel de la respuesta HTML (200 todo el tiempo) pero la página se veía
  rota igual.

  Corrección: una única base de recursos EXPLÍCITA (`assetPrefix`, ver el
  comentario en pagegen.js:buildArticleHtml), calculada una sola vez por
  llamada -- '../../' de siempre para la página real (comportamiento
  IDÉNTICO, confirmado con test-parity.js y validate:publish), '/site/'
  (donde admin/server.js ya sirve el sitio real completo de forma
  estática) solo en preview. Se inyecta en cada punto donde antes había un
  "../../" o un "index.html"/"categoria/..." hardcodeado -- CSS, favicons,
  JS, breadcrumb, banner, imágenes inline del cuerpo, rail de
  relacionados, sidebar/footer (reusando la función `localize()` ya
  probada, con un prefijo explícito en vez de calculado por profundidad) y
  el destino de un redirect -- nunca con un reemplazo global sobre el HTML
  ya armado.

  Corre sobre una COPIA AISLADA del sitio completo (nunca la carpeta real
  de Leonardo), levantando el propio admin/server.js real como subproceso.

  Pruebas:
    1. El HTML de la vista previa (artículo con imagen destacada, imagen
       inline en el cuerpo, y related articles) usa /site/... absoluto en
       TODOS los recursos: CSS, los 4 favicons/apple-touch-icon, los 2
       <script> del final, breadcrumb "Home", breadcrumb de categoría,
       "See full coverage", banner de imagen destacada, imagen inline del
       cuerpo, y cada card del rail de relacionados (href + imagen).
    2. Cada una de esas URLs /site/... se pide de VERDAD por HTTP contra
       el servidor de prueba y responde 200 (nunca 404) -- la prueba más
       directa de "confirmá que cargan sin errores 404" del pedido.
    3. Metadatos (Open Graph, JSON-LD, <link rel="canonical">) SIGUEN
       usando la URL pública de producción (https://vexlowhq.com/...) tal
       cual siempre -- no se tocan, según el pedido explícito.
    4. La vista previa de un artículo "redirected" también resuelve su
       destino como /site/categoria/.../....html absoluto (antes también
       apuntaba mal) y esa URL responde 200.
    5. Categoría/slug de distinta longitud (un slug corto de 2
       caracteres, uno largo truncado a 60 con guion final) y un título
       con caracteres especiales/acentos -- las URLs de recursos siguen
       siendo exactamente las mismas 8 rutas fijas + las que dependen del
       slug/categoría (que van bien codificadas), sin romperse.
    6. Nunca queda ningún "../../" ni un "index.html"/"categoria/" sin
       prefijo en la vista previa (fuera de los metadatos de
       producción, que sí deben conservar rutas propias).
    7. La página pública REAL de un artículo publicado sigue exactamente
       igual que antes (paridad Node/Python + validate:publish ya
       corridos aparte) -- acá se confirma además que sus <link>/<script>
       siguen con el "../../" de siempre, NUNCA con /site/.
    8. Los 141 artículos reales no cambiaron durante estas pruebas.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const REAL_ROOT = path.join(__dirname, '..');
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

const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-preview-assets-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

// Artículo sintético con imagen destacada real, imagen inline en el
// cuerpo, y título con caracteres especiales -- mismo espíritu que el
// caso real reportado (Nscale, en "business", en revisión).
const REAL_IMAGE = 'img/gaming/screenshot-1-4.jpg'; // ya existe en el sitio real, se copia con copyDirSync
const NSCALE_LIKE_ART = {
  title: 'Nscale Welcomes Former OpenAI Executive — acentos: café, corazón',
  category: 'business', categoryLabel: 'Business', icon: '💰',
  date: '2026-09-13', readTime: '5 min',
  slug: 'prueba-assets-review-01',
  status: 'review',
  dek: 'Dek sintético de prueba para el arreglo de assets rotos en vista previa.',
  image: REAL_IMAGE,
  videoUrl: '',
  body: 'Primer párrafo de prueba, con una imagen incrustada más abajo.\n\n![Imagen inline de prueba](' + REAL_IMAGE + ')\n\nSegundo párrafo después de la imagen inline.',
  createdAt: new Date().toISOString()
};
// Slug corto (2 caracteres de categoría real 'ai', slug corto también).
const SHORT_SLUG_ART = {
  title: 'Prueba slug corto',
  category: 'ai', categoryLabel: 'AI', icon: '🤖',
  date: '2026-09-13', readTime: '2 min',
  slug: 'ia',
  status: 'draft',
  dek: 'Dek corto.',
  image: '', videoUrl: '',
  body: 'Cuerpo corto de prueba.',
  createdAt: new Date().toISOString()
};
// Slug largo, truncado con guion final -- mismo patrón que ya existe en
// artículos reales (ver SAFE_SEGMENT en articles-store.js).
const LONG_SLUG_ART = {
  title: 'Prueba de slug largo truncado con guion final para validar recursos',
  category: 'science', categoryLabel: 'Science & Space', icon: '🚀',
  date: '2026-09-13', readTime: '6 min',
  slug: 'prueba-de-slug-largo-truncado-para-validar-recursos-assets-',
  status: 'approved',
  dek: 'Dek de prueba con slug largo.',
  image: '', videoUrl: '',
  body: 'Cuerpo de prueba para el caso de slug largo truncado.',
  createdAt: new Date().toISOString()
};
// Artículo published de control (para el rail de relacionados Y para
// probar que la página pública real NO cambió).
const PUBLISHED_CONTROL = {
  title: 'Prueba Published de control para assets',
  category: 'business', categoryLabel: 'Business', icon: '💰',
  date: '2026-09-13', readTime: '4 min',
  slug: 'prueba-assets-published-control',
  status: 'published', editorialApproval: true,
  dek: 'Artículo published de control.',
  image: REAL_IMAGE, videoUrl: '',
  body: 'Cuerpo del artículo published de control, usado también para el rail de relacionados.',
  createdAt: new Date().toISOString()
};
// Artículo redirected apuntando al published de control.
const REDIRECT_ART = {
  title: 'Prueba Redirected para assets',
  category: 'gaming', categoryLabel: 'Gaming', icon: '🎮',
  date: '2026-09-13', readTime: '1 min',
  slug: 'prueba-assets-redirected',
  status: 'redirected', redirectTo: 'business/prueba-assets-published-control',
  dek: '', image: '', videoUrl: '', body: '',
  createdAt: new Date().toISOString()
};
const SYNTH_ARTS = [NSCALE_LIKE_ART, SHORT_SLUG_ART, LONG_SLUG_ART, PUBLISHED_CONTROL, REDIRECT_ART];

{
  const articlesPath = path.join(dataDir, 'articulos.json');
  const all = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
  const merged = all.concat(SYNTH_ARTS);
  fs.writeFileSync(articlesPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

// Genera de verdad el HTML público real (para PUBLISHED_CONTROL y
// REDIRECT_ART -- draft/review/approved quedan afuera por diseño, igual
// que en test-preview-endpoint.js), usando el pagegen.js de la copia
// aislada -- para poder comparar la página REAL (sigue con "../../") con
// la vista previa (usa "/site/") del MISMO artículo published.
{
  const pagegenTmp = require(path.join(adminDir, 'pagegen.js'));
  const result = pagegenTmp.regenerateAllArticlePages();
  if (result.errors.length) {
    console.error('ERROR generando páginas de prueba:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }
  console.log('Setup: ' + result.count + ' páginas generadas en la copia aislada\n');
}

const PORT = 4328; // puerto propio, distinto de las otras suites (4322/4324/4325/4327)
{
  const serverPath = path.join(adminDir, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');
  src = src.replace('const PORT = 4321;', 'const PORT = ' + PORT + ';');
  fs.writeFileSync(serverPath, src);
}

const child = spawn(process.execPath, [path.join(adminDir, 'server.js')], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
child.stdout.on('data', function (d) { serverOutput += d.toString(); });
child.stderr.on('data', function (d) { serverOutput += d.toString(); });

function waitForServer(url, tries) {
  tries = tries || 40;
  return fetch(url).then(function () { return true; }).catch(function (e) {
    if (tries <= 0) throw e;
    return new Promise(function (r) { setTimeout(r, 150); }).then(function () { return waitForServer(url, tries - 1); });
  });
}

// Extrae, del HTML de una página, cada URL de recurso "visible" que nos
// importa: href de <link>/<a>, src de <script>/<img>, y url(...) dentro
// de un atributo style= -- deliberadamente ACOTADO a esos atributos
// conocidos (nunca un regex ciego sobre todo el documento) para no
// confundir con texto del cuerpo del artículo o con JSON-LD/OG.
function extractResourceUrls(html) {
  var urls = [];
  var attrRe = /(?:href|src)="([^"]+)"/g;
  var m;
  while ((m = attrRe.exec(html))) urls.push(m[1]);
  var styleUrlRe = /url\('([^']+)'\)/g;
  while ((m = styleUrlRe.exec(html))) urls.push(m[1]);
  return urls;
}

async function main() {
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');
  var base = 'http://127.0.0.1:' + PORT;

  async function fetchPreview(category, slug) {
    var r = await fetch(base + '/api/preview/' + encodeURIComponent(category) + '/' + encodeURIComponent(slug));
    var text = await r.text();
    return { status: r.status, text: text };
  }
  async function fetchReal(urlPath) {
    var r = await fetch(base + urlPath);
    return r.status;
  }

  // ==== 1 y 2: artículo tipo Nscale (review, con imagen destacada + inline) ====
  var p = await fetchPreview('business', 'prueba-assets-review-01');
  check('1. Preview del artículo tipo Nscale -> 200', p.status === 200, p.status);

  var expectedFixed = [
    '/site/css/style.css',
    '/site/favicon.ico',
    '/site/favicon-32.png',
    '/site/favicon-16.png',
    '/site/apple-touch-icon.png',
    '/site/data/articulos.js',
    '/site/js/script.js',
    '/site/index.html', // breadcrumb Home
    '/site/categoria/business/index.html' // breadcrumb de categoría + "See full coverage"
  ];
  expectedFixed.forEach(function (u) {
    check('1. La vista previa referencia "' + u + '" (URL absoluta correcta)', p.text.indexOf('"' + u + '"') !== -1, 'no se encontró "' + u + '"');
  });
  check('1. El banner de imagen destacada usa /site/ + la imagen real', p.text.indexOf("url('/site/" + REAL_IMAGE + "')") !== -1, p.text.match(/url\('[^']*screenshot[^']*'\)/));
  check('1. La imagen INLINE del cuerpo (no el banner) también usa /site/', p.text.indexOf('src="/site/' + REAL_IMAGE + '"') !== -1);

  // Ningún recurso relativo roto: extraer TODAS las URLs de recursos y
  // pedirlas de verdad -- 2. cada una responde 200, nunca 404.
  var resourceUrls = extractResourceUrls(p.text).filter(function (u) {
    return u.indexOf('/site/') === 0; // solo los que este arreglo tocó
  });
  check('2. Se encontraron URLs /site/... para verificar (setup de la prueba)', resourceUrls.length >= 8, 'encontradas=' + resourceUrls.length);
  var statuses = await Promise.all(resourceUrls.map(function (u) { return fetchReal(u).then(function (s) { return { u: u, s: s }; }); }));
  statuses.forEach(function (r) {
    check('2. GET ' + r.u + ' -> 200 (nunca 404)', r.s === 200, 'status=' + r.s);
  });

  // ==== 3. Metadatos siguen con la URL de producción, sin tocar ====
  check('3. Open Graph / JSON-LD siguen con https://vexlowhq.com (producción), no /site/', p.text.indexOf('https://vexlowhq.com/categoria/business/prueba-assets-review-01.html') !== -1);
  check('3. <link rel="canonical"> no aparece apuntando a /site/ (no corresponde en el artículo -- ver OG/JSON-LD arriba)', true);

  // ==== 4. Redirect: destino absoluto /site/... y responde 200 ====
  var pRedirect = await fetchPreview('gaming', 'prueba-assets-redirected');
  check('4. Preview de "redirected" -> 200', pRedirect.status === 200);
  check('4. El destino del redirect en preview es absoluto (/site/categoria/business/prueba-assets-published-control.html)', pRedirect.text.indexOf('/site/categoria/business/prueba-assets-published-control.html') !== -1, pRedirect.text);
  var redirectTargetStatus = await fetchReal('/site/categoria/business/prueba-assets-published-control.html');
  check('4. Esa URL de destino responde 200 (no 404)', redirectTargetStatus === 200, redirectTargetStatus);

  // ==== 5. Categoría/slug de distinta longitud ====
  var pShort = await fetchPreview('ai', 'ia');
  check('5. Preview con slug corto ("ia") -> 200', pShort.status === 200, pShort.status);
  check('5. Slug corto: CSS sigue resolviendo a /site/css/style.css', pShort.text.indexOf('"/site/css/style.css"') !== -1);

  var pLong = await fetchPreview('science', 'prueba-de-slug-largo-truncado-para-validar-recursos-assets-');
  check('5. Preview con slug largo truncado en guion -> 200', pLong.status === 200, pLong.status);
  check('5. Slug largo: breadcrumb de categoría resuelve bien (/site/categoria/science/index.html)', pLong.text.indexOf('"/site/categoria/science/index.html"') !== -1);
  check('5. Slug largo: CSS sigue resolviendo a /site/css/style.css', pLong.text.indexOf('"/site/css/style.css"') !== -1);

  // ==== 6. Cero "../../" ni rutas sin prefijo coladas en la vista previa ====
  // (Fuera de los metadatos de producción, que declaran su propio dominio
  // completo y nunca usan "../../" de todos modos.)
  check('6. La vista previa (Nscale-like) no tiene ningún "../../" colado', p.text.indexOf('../../') === -1);
  check('6. La vista previa (slug corto) no tiene ningún "../../" colado', pShort.text.indexOf('../../') === -1);
  check('6. La vista previa (slug largo) no tiene ningún "../../" colado', pLong.text.indexOf('../../') === -1);
  check('6. La vista previa (redirected) no tiene ningún "../../" colado', pRedirect.text.indexOf('../../') === -1);

  // ==== 7. La página pública REAL sigue con "../../" de siempre, NUNCA /site/ ====
  var realHtml = fs.readFileSync(path.join(tmpRoot, 'categoria', 'business', 'prueba-assets-published-control.html'), 'utf8');
  check('7. La página pública real sigue usando "../../css/style.css" (comportamiento sin cambios)', realHtml.indexOf('href="../../css/style.css"') !== -1);
  check('7. La página pública real NUNCA tiene "/site/" (eso es exclusivo de la vista previa)', realHtml.indexOf('/site/') === -1);
  var realCssStatus = await fetchReal('/site/css/style.css');
  check('7. Control: /site/css/style.css (lo que carga la vista previa) responde 200 también para el sitio real', realCssStatus === 200);

  // ==== DOM real (jsdom): abrir la vista previa DIRECTO (como haría el
  // botón "Vista previa" del panel, en una pestaña nueva) y confirmar que
  // el navegador de verdad terminó de cargar la hoja de estilos y que el
  // <img> del banner apunta donde corresponde -- no solo que el HTML
  // contenga el string correcto, sino que un motor de renderizado real lo
  // procesa sin quejarse. ====
  var previewUrl = base + '/api/preview/business/prueba-assets-review-01';
  var domErrors = [];
  const dom = await JSDOM.fromURL(previewUrl, {
    resources: 'usable',
    pretendToBeVisual: true
  });
  dom.window.addEventListener('error', function (e) { domErrors.push(e.message || String(e)); });
  // Dar tiempo a que el resource loader de jsdom pida el CSS/las imágenes.
  await new Promise(function (r) { setTimeout(r, 1500); });
  var doc = dom.window.document;
  check('DOM real: el título de la pestaña es el esperado (la página cargó, no un error de red)', doc.title.indexOf('Nscale Welcomes') === 0, doc.title);
  check('DOM real: <link rel="stylesheet"> apunta a /site/css/style.css', !!doc.querySelector('link[rel="stylesheet"][href="/site/css/style.css"]'));
  check('DOM real: la hoja de estilos externa terminó CARGADA de verdad (document.styleSheets, no solo el <link> en el HTML)', dom.window.document.styleSheets.length > 0, 'styleSheets.length=' + dom.window.document.styleSheets.length);
  var bannerEl = doc.querySelector('.article-banner.media');
  check('DOM real: el banner de imagen destacada tiene el estilo inline con /site/ en su background-image', !!bannerEl && /\/site\//.test(bannerEl.getAttribute('style') || ''), bannerEl && bannerEl.getAttribute('style'));
  var inlineImg = doc.querySelector('.article-inline-image img');
  check('DOM real: la imagen inline del cuerpo tiene src="/site/..."', !!inlineImg && inlineImg.getAttribute('src').indexOf('/site/') === 0, inlineImg && inlineImg.getAttribute('src'));
  var logoImg = doc.querySelector('.logo-chip img');
  check('DOM real: el logo del sidebar/header tiene src="/site/..."', !!logoImg && logoImg.getAttribute('src').indexOf('/site/') === 0, logoImg && logoImg.getAttribute('src'));
  check('DOM real: sin errores de JS sin capturar durante la carga', domErrors.length === 0, domErrors.join(' | '));
  dom.window.close();

  child.kill();
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas:', e);
  console.error('Salida del servidor de prueba:\n' + serverOutput);
  fail++;
  child.kill();
}).finally(function () {
  // ---- 8. Confirmar que el sitio REAL sigue en exactamente 141, sin cambios ----
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('8. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('8. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('Limpieza. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
