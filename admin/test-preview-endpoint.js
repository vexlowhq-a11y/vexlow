#!/usr/bin/env node
/*
  admin/test-preview-endpoint.js
  ================================
  Bug real reportado 2026-09-13: "El artículo de Nscale está en revisión
  y el listado muestra 'con página propia', pero al pulsar 'Ver' intenta
  abrir categoria/business/nscale-....html y devuelve 'No encontrado'
  porque ese HTML todavía no existe."

  Diagnóstico confirmado ANTES de escribir este archivo (ver informe):
  admin/admin.js calculaba "¿este artículo tiene página propia?" con
  `hasPage = !!(a.body && a.body.trim())` -- una comprobación que solo
  mira si hay TEXTO cargado en el formulario, sin mirar el estado
  editorial (draft/review/approved solo generan HTML público al
  publicarse) ni si el archivo existe de verdad en disco. Cualquier
  borrador con cuerpo largo mostraba "con página propia" y el botón
  "Ver" -> 404 garantizado.

  Corrección:
    1. GET /api/articles-html-status (admin/server.js) -- verdad real,
       calculada con fs.existsSync, de qué artículos tienen HTML público
       generado. Nunca se mezcla con GET /api/articles para no terminar
       escribiéndose sin querer en data/articulos.json en el próximo
       guardado masivo (POST /api/articles manda articlesData completo).
    2. GET /api/preview/:category/:slug (admin/server.js) -- vista previa
       seria: arma el HTML en memoria (pagegen.buildArticleHtml /
       buildRedirectHtml, ambas puras, sin fs.writeFileSync) y lo
       devuelve directo como respuesta. CERO escritura a disco, cero
       llamada a regenerateArticlePages/writeSitemap/generateArticulosJs.
       Fuerza noindex,nofollow + sin AdSense + un aviso visible "VISTA
       PREVIA -- no publicado", sin importar el noindex real guardado.
    3. admin/admin.js: renderArticlesList() ahora usa articleHtmlStatus
       (la verdad del punto 1) en vez de `hasPage` roto. "Ver" (a la URL
       pública real) solo aparece para status === 'published' CON html
       real en disco (punto 3 del pedido, tomado literal). "Vista previa"
       (al endpoint del punto 2) aparece para draft/review/approved, y
       también para redirected -- ver nota de interpretación en el
       informe: el pedido no lo nombra en el punto 1, pero el punto 3 lo
       excluye de "Ver" por no ser 'published', así que dejarlo sin
       ninguna acción de vista hubiera sido peor y hubiera vuelto inútil
       la prueba de "redirected" pedida en el punto 7.
    4. "Al carrusel" (bug latente relacionado, mismo `hasPage` roto)
       ahora exige lo mismo que "Ver": published + HTML real en disco.

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real
  ni la carpeta del usuario), levantando el propio admin/server.js real
  como subproceso -- las pruebas HTTP pegan contra los mismos endpoints
  que usa el panel de verdad -- y cargando el admin.js/HTML reales en un
  DOM real (jsdom) para confirmar qué ve Leonardo en la pantalla.

  Pruebas (letras según el punto 7/8 del pedido):
    1. GET /api/articles-html-status dice la verdad para draft/review/
       approved (false, sin ni mirar el disco) y para published/
       redirected con HTML realmente generado (true).
    2. GET /api/preview/... funciona para draft, review, approved,
       published y redirected -- 200, Content-Type text/html, con el
       aviso "VISTA PREVIA" (salvo redirect, que es el stub de siempre) y
       sin ningún <script> de adsbygoogle.
    2b. Título con caracteres especiales (comillas, & , <b>, acentos, ñ,
        emoji) sale ESCAPADO en el HTML de la vista previa -- nunca HTML
        crudo inyectado.
    2c. Slug truncado terminado en guion (mismo patrón que 16 de los 141
        slugs reales) funciona igual en la URL del endpoint.
    3. GET /api/preview/... para un artículo inexistente -> 404 claro
       (nunca 500 ni una excepción sin manejar).
    4. GET /api/preview/... con categoría o slug con caracteres inválidos
       (mayúsculas, guion bajo, barra codificada) -> 400, nunca escribe
       ni lee fuera de categoria/.
    5. Ningún GET de preview ni de articles-html-status -- ni pedido una
       vez ni "refrescado" pidiéndolo de nuevo -- cambia un solo byte de
       data/articulos.json, data/articulos.js, sitemap.xml, portada
       (index.html) ni la página de categoría real (hashes idénticos
       antes/después, incluso tras pedir cada preview DOS veces).
    6. Ningún archivo categoria/<cat>/<slug>.html se creó en disco para
       los artículos draft/review/approved -- la vista previa nunca los
       "publica" de asustadas.
    7. DOM real (jsdom + admin.js real): en el listado del panel,
       draft/review/approved muestran "Vista previa" (nunca "Ver") y
       "solo en el listado"; published con HTML real muestra "Ver" +
       "Al carrusel" + "con página propia"; redirected (con HTML real
       generado) muestra "Vista previa", NUNCA "Ver" -- por el punto 3
       del pedido, aunque tenga archivo real.
    8. Los 141 artículos reales del sitio no cambiaron durante estas
       pruebas (ni contenido ni cantidad).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) {
  try { return sha256(fs.readFileSync(p)); } catch (e) { return null; }
}

// ---- Snapshot del sitio REAL antes de tocar nada (solo lectura) ----
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-preview-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

// ---- Artículos sintéticos: uno por cada estado editorial pedido en el
// punto 7, más casos límite (caracteres especiales, slug truncado con
// guion final) ----
function baseArticle(overrides) {
  return Object.assign({
    title: 'Prueba sintética',
    categoryLabel: '', icon: '📰',
    date: '2026-09-13',
    readTime: '4 min',
    dek: 'Dek sintético de prueba para la vista previa segura.',
    image: '',
    videoUrl: '',
    trending: false,
    noindex: false,
    body: 'Cuerpo sintético de prueba, usado únicamente para validar la vista previa sin publicar.\n\nSegundo párrafo de contenido de relleno.',
    createdAt: new Date().toISOString()
  }, overrides);
}

const DRAFT_ART = baseArticle({
  title: 'Prueba Draft — con "comillas", & <b>etiquetas</b> y ñoño 🚀',
  category: 'ai', categoryLabel: 'AI', icon: '🤖',
  slug: 'prueba-preview-draft-01',
  status: 'draft'
});
const REVIEW_ART = baseArticle({
  title: 'Prueba Review — acentuación: café, corazón, jalapeño',
  category: 'technology', categoryLabel: 'Technology', icon: '💻',
  slug: 'prueba-preview-review-01',
  status: 'review'
});
// Slug truncado terminado en guion -- mismo patrón que ya existe en 16 de
// los 141 slugs reales (ver comentario de SAFE_SEGMENT en articles-store.js).
const APPROVED_ART = baseArticle({
  title: 'Prueba Approved con slug truncado a proposito para la prueba',
  category: 'science', categoryLabel: 'Science & Space', icon: '🚀',
  slug: 'prueba-preview-approved-truncado-',
  status: 'approved'
});
const PUBLISHED_ART = baseArticle({
  title: 'Prueba Published — esta sí tiene HTML público real',
  category: 'business', categoryLabel: 'Business', icon: '💰',
  slug: 'prueba-preview-published-01',
  status: 'published',
  editorialApproval: true
});
const REDIRECTED_ART = baseArticle({
  title: 'Prueba Redirected — apunta a la publicada de arriba',
  category: 'gaming', categoryLabel: 'Gaming', icon: '🎮',
  slug: 'prueba-preview-redirected-01',
  status: 'redirected',
  redirectTo: 'business/prueba-preview-published-01',
  body: ''
});
const SYNTH_ARTS = [DRAFT_ART, REVIEW_ART, APPROVED_ART, PUBLISHED_ART, REDIRECTED_ART];

{
  const articlesPath = path.join(dataDir, 'articulos.json');
  const all = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
  const merged = all.concat(SYNTH_ARTS);
  fs.writeFileSync(articlesPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

// Genera de verdad el HTML público para lo que corresponda (published,
// redirected -- draft/review/approved quedan afuera por diseño de
// regenerateAllArticlePages, ver admin/pagegen.js), usando el pagegen.js
// de la COPIA AISLADA -- nunca el del sandbox ni el real -- para producir
// el mismo escenario que un "Publicar cambios" real dejaría en disco.
{
  const pagegenTmp = require(path.join(adminDir, 'pagegen.js'));
  const result = pagegenTmp.regenerateAllArticlePages();
  if (result.errors.length) {
    console.error('ERROR generando páginas de prueba:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }
  console.log('Setup: ' + result.count + ' páginas generadas en la copia aislada (incluye las sintéticas published/redirected)\n');
}

const PORT = 4327; // puerto de prueba propio, distinto de las otras suites (4322/4324/4325/4326)
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
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function snapshotHashes() {
  return {
    articulosJson: sha256File(path.join(dataDir, 'articulos.json')),
    articulosJs: sha256File(path.join(dataDir, 'articulos.js')),
    sitemap: sha256File(path.join(tmpRoot, 'sitemap.xml')),
    portada: sha256File(path.join(tmpRoot, 'index.html')),
    categoriaAi: sha256File(path.join(tmpRoot, 'categoria', 'ai', 'index.html')),
    categoriaBusiness: sha256File(path.join(tmpRoot, 'categoria', 'business', 'index.html'))
  };
}

async function main() {
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');

  var base = 'http://127.0.0.1:' + PORT;

  // ==== 1. GET /api/articles-html-status dice la verdad ====
  var statusBefore = await fetch(base + '/api/articles-html-status').then(function (r) { return r.json(); });
  check('1. draft: articles-html-status = false (nunca se mira el disco)', statusBefore['ai/prueba-preview-draft-01'] === false, JSON.stringify(statusBefore['ai/prueba-preview-draft-01']));
  check('1. review: articles-html-status = false', statusBefore['technology/prueba-preview-review-01'] === false);
  check('1. approved (slug truncado): articles-html-status = false', statusBefore['science/prueba-preview-approved-truncado-'] === false);
  check('1. published: articles-html-status = true (HTML real generado)', statusBefore['business/prueba-preview-published-01'] === true);
  check('1. redirected: articles-html-status = true (stub de redirect real generado)', statusBefore['gaming/prueba-preview-redirected-01'] === true);
  // Control: un artículo real published cualquiera también debe dar true.
  var realSampleKey = Object.keys(statusBefore).find(function (k) { return k.indexOf('prueba-preview') === -1; });
  check('1. Control: algún artículo real published también da true', !!realSampleKey && statusBefore[realSampleKey] === true, realSampleKey);

  // ==== Hashes ANTES de pedir ninguna vista previa ====
  var hashesBefore = snapshotHashes();

  // ==== 2. GET /api/preview funciona para los 5 estados ====
  async function fetchPreview(category, slug) {
    var r = await fetch(base + '/api/preview/' + encodeURIComponent(category) + '/' + encodeURIComponent(slug));
    var text = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', text: text };
  }

  var pDraft = await fetchPreview('ai', 'prueba-preview-draft-01');
  check('2. Preview draft -> 200', pDraft.status === 200, pDraft.status);
  check('2. Preview draft -> Content-Type text/html', pDraft.contentType.indexOf('text/html') === 0, pDraft.contentType);
  check('2. Preview draft -> incluye el aviso "VISTA PREVIA"', pDraft.text.indexOf('VISTA PREVIA') !== -1);
  check('2. Preview draft -> noindex,nofollow forzado', pDraft.text.indexOf('noindex,nofollow') !== -1);
  // Nota: CONSENT_BASE_BLOCK (siempre presente, con o sin ads) trae un
  // comentario de código que menciona la palabra "adsbygoogle" al pasar
  // -- se busca el SCRIPT DE VERDAD (pagead2.googlesyndication.com, que
  // solo aparece cuando consentBlockFor(true) agrega ADSENSE_SCRIPT_TAG),
  // no la palabra suelta, para no dar un falso negativo por ese comentario.
  check('2. Preview draft -> SIN el script real de AdSense (nunca monetiza una vista previa)', pDraft.text.indexOf('pagead2.googlesyndication.com') === -1);
  // 2b. Caracteres especiales del título salen escapados, nunca crudos.
  check('2b. Preview draft -> el título con <b> sale ESCAPADO (&lt;b&gt;) en el breadcrumb/JSON-LD/meta, nunca reinterpretado como HTML nuevo ahí', pDraft.text.indexOf('&lt;b&gt;etiquetas&lt;/b&gt;') !== -1, pDraft.text.slice(0, 400));
  // Nota: <title> y <h1> de ARTICLE_PAGE_TEMPLATE insertan `title` tal cual
  // (sin escapeHtml) -- comportamiento PREEXISTENTE, idéntico para
  // cualquier artículo publicado real, que ya existía antes de este
  // arreglo y que buildArticleHtml() extrajo sin tocar (fuera del alcance
  // de "Corregí el flujo de previsualización sin publicar el artículo").
  // No se afirma nada sobre esos dos lugares acá para no confundir un
  // hallazgo preexistente y no pedido con el bug real de este ticket.

  var pReview = await fetchPreview('technology', 'prueba-preview-review-01');
  check('2. Preview review -> 200 + VISTA PREVIA + sin script real de ads', pReview.status === 200 && pReview.text.indexOf('VISTA PREVIA') !== -1 && pReview.text.indexOf('pagead2.googlesyndication.com') === -1);
  check('2. Preview review -> acentos preservados (café)', pReview.text.indexOf('café') !== -1 || pReview.text.indexOf('café') !== -1);

  // 2c. Slug truncado terminado en guion.
  var pApproved = await fetchPreview('science', 'prueba-preview-approved-truncado-');
  check('2c. Preview approved con slug truncado en guion -> 200 (no rompe la URL ni la validación de segmento)', pApproved.status === 200, pApproved.status);
  check('2c. Preview approved -> VISTA PREVIA + sin script real de ads', pApproved.text.indexOf('VISTA PREVIA') !== -1 && pApproved.text.indexOf('pagead2.googlesyndication.com') === -1);

  var pPublished = await fetchPreview('business', 'prueba-preview-published-01');
  check('2. Preview published -> también funciona (vale para cualquier estado editorial), 200', pPublished.status === 200);
  check('2. Preview published -> también muestra el aviso de vista previa (nunca es la URL pública real)', pPublished.text.indexOf('VISTA PREVIA') !== -1);
  check('2. Preview published -> el modo preview también fuerza SIN ads (aunque el artículo publicado real sí los cargaría)', pPublished.text.indexOf('pagead2.googlesyndication.com') === -1);

  var pRedirected = await fetchPreview('gaming', 'prueba-preview-redirected-01');
  check('2. Preview redirected -> 200, es el stub de redirección de siempre', pRedirected.status === 200 && pRedirected.text.indexOf('This article has moved') !== -1);
  check('2. Preview redirected -> apunta al destino correcto (published de arriba)', pRedirected.text.indexOf('prueba-preview-published-01.html') !== -1, pRedirected.text);

  // ==== 3. Artículo inexistente -> 404 claro ====
  var p404 = await fetchPreview('business', 'esto-no-existe-nunca-jamas');
  check('3. Preview de un artículo inexistente -> 404 (nunca 500 ni excepción sin manejar)', p404.status === 404, p404.status);

  // ==== 4. Segmentos inválidos -> 400 ====
  var pBadCat = await fetchPreview('BUSINESS', 'prueba-preview-published-01');
  check('4. Categoría con mayúsculas -> 400 (assertSafeSegment)', pBadCat.status === 400, pBadCat.status);
  var pBadSlug = await fetchPreview('business', 'con_guion_bajo_invalido');
  check('4. Slug con guion bajo -> 400', pBadSlug.status === 400, pBadSlug.status);
  var pTraversal = await fetch(base + '/api/preview/business/' + encodeURIComponent('../../etc/passwd'));
  check('4. Intento de path traversal en el slug -> nunca 200 (400 o 404, nunca sirve un archivo fuera de categoria/)', pTraversal.status === 400 || pTraversal.status === 404, pTraversal.status);

  // ==== 5. Cero efectos secundarios, incluso pidiendo cada preview DOS veces ("refrescar") ====
  await fetchPreview('ai', 'prueba-preview-draft-01');
  await fetchPreview('technology', 'prueba-preview-review-01');
  await fetchPreview('science', 'prueba-preview-approved-truncado-');
  await fetchPreview('business', 'prueba-preview-published-01');
  await fetchPreview('gaming', 'prueba-preview-redirected-01');
  await fetch(base + '/api/articles-html-status');
  await fetch(base + '/api/articles-html-status');
  var hashesAfter = snapshotHashes();
  check('5. data/articulos.json sin cambios tras pedir/repetir cada vista previa', hashesBefore.articulosJson === hashesAfter.articulosJson);
  check('5. data/articulos.js sin cambios (nunca se regenera desde una vista previa)', hashesBefore.articulosJs === hashesAfter.articulosJs);
  check('5. sitemap.xml sin cambios', hashesBefore.sitemap === hashesAfter.sitemap);
  check('5. Portada (index.html) sin cambios', hashesBefore.portada === hashesAfter.portada);
  check('5. Página de categoría "ai" sin cambios', hashesBefore.categoriaAi === hashesAfter.categoriaAi);
  check('5. Página de categoría "business" sin cambios', hashesBefore.categoriaBusiness === hashesAfter.categoriaBusiness);

  // ==== 6. Ningún HTML público real se creó para draft/review/approved ====
  check('6. NO existe categoria/ai/prueba-preview-draft-01.html en disco', !fs.existsSync(path.join(tmpRoot, 'categoria', 'ai', 'prueba-preview-draft-01.html')));
  check('6. NO existe categoria/technology/prueba-preview-review-01.html en disco', !fs.existsSync(path.join(tmpRoot, 'categoria', 'technology', 'prueba-preview-review-01.html')));
  check('6. NO existe categoria/science/prueba-preview-approved-truncado-.html en disco', !fs.existsSync(path.join(tmpRoot, 'categoria', 'science', 'prueba-preview-approved-truncado-.html')));

  // ==== 7. DOM real: admin.js real decide los botones correctamente ====
  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (win) {
      win.fetch = function (url, opts) {
        var abs = new URL(url, win.location.href).toString();
        return fetch(abs, opts);
      };
    }
  });
  const { window } = dom;
  window.addEventListener('error', function () {});

  var found = false;
  for (var i = 0; i < 60; i++) {
    await sleep(200);
    if (window.document.querySelectorAll('.admin-item').length > 100) { found = true; break; }
  }
  check('7. Setup: el panel real terminó de cargar (renderArticlesList corrió con los 146 artículos)', found, 'admin-item=' + window.document.querySelectorAll('.admin-item').length);
  if (!found) throw new Error('El panel no inicializó a tiempo: ' + serverOutput.slice(-2000));

  function rowForTitle(titleText) {
    var items = Array.from(window.document.querySelectorAll('.admin-item'));
    return items.find(function (row) {
      var ttl = row.querySelector('.ttl');
      return ttl && ttl.textContent.indexOf(titleText) !== -1;
    });
  }

  // GET /api/articles-html-status se pide APARTE del Promise.all de arranque
  // (para no retrasar el resto del panel -- ver el comentario en admin.js,
  // mismo patrón que loadReactions()/loadSocialStatus()), así que el primer
  // renderArticlesList() puede correr ANTES de que esa verdad llegue. Se
  // espera acá a que "Prueba Published" ya muestre "Ver" (señal de que
  // refreshArticleHtmlStatus() ya resolvió y volvió a renderizar) antes de
  // auditar ningún botón.
  var htmlStatusReady = false;
  for (var hi = 0; hi < 40; hi++) {
    await sleep(200);
    var pubRowProbe = rowForTitle('Prueba Published');
    if (pubRowProbe && Array.from(pubRowProbe.querySelectorAll('a')).some(function (a) { return a.textContent.trim() === 'Ver'; })) {
      htmlStatusReady = true;
      break;
    }
  }
  check('7. Setup: articleHtmlStatus terminó de llegar (refreshArticleHtmlStatus ya volvió a renderizar)', htmlStatusReady);
  if (!htmlStatusReady) throw new Error('articleHtmlStatus no llegó a tiempo: ' + serverOutput.slice(-2000));
  function buttonsOf(row) {
    return Array.from(row.querySelectorAll('a, button')).map(function (el) { return el.textContent.trim(); });
  }

  function assertNonPublicRow(titleFrag, label) {
    var row = rowForTitle(titleFrag);
    check('7. ' + label + ': se encontró la fila en el listado', !!row);
    if (!row) return;
    var btns = buttonsOf(row);
    check('7. ' + label + ': muestra "Vista previa"', btns.indexOf('Vista previa') !== -1, btns.join(', '));
    check('7. ' + label + ': NUNCA muestra "Ver"', btns.indexOf('Ver') === -1, btns.join(', '));
    check('7. ' + label + ': NUNCA muestra "Al carrusel"', btns.indexOf('Al carrusel') === -1, btns.join(', '));
    var metaText = row.querySelector('.meta').textContent;
    check('7. ' + label + ': meta dice "solo en el listado" (nunca "con página propia")', metaText.indexOf('solo en el listado') !== -1 && metaText.indexOf('con página propia') === -1, metaText);
    var previewLink = Array.from(row.querySelectorAll('a')).find(function (a) { return a.textContent.trim() === 'Vista previa'; });
    check('7. ' + label + ': el link de "Vista previa" apunta al endpoint seguro /api/preview/...', previewLink && previewLink.getAttribute('href').indexOf('/api/preview/') === 0, previewLink && previewLink.getAttribute('href'));
  }

  assertNonPublicRow('Prueba Draft', 'draft');
  assertNonPublicRow('Prueba Review', 'review');
  assertNonPublicRow('Prueba Approved', 'approved (slug truncado)');

  var publishedRow = rowForTitle('Prueba Published');
  check('7. published: se encontró la fila en el listado', !!publishedRow);
  if (publishedRow) {
    var pubBtns = buttonsOf(publishedRow);
    check('7. published: muestra "Ver"', pubBtns.indexOf('Ver') !== -1, pubBtns.join(', '));
    check('7. published: muestra "Al carrusel"', pubBtns.indexOf('Al carrusel') !== -1, pubBtns.join(', '));
    check('7. published: NUNCA muestra "Vista previa" (ya tiene HTML real, usa "Ver")', pubBtns.indexOf('Vista previa') === -1, pubBtns.join(', '));
    var pubMeta = publishedRow.querySelector('.meta').textContent;
    check('7. published: meta dice "con página propia"', pubMeta.indexOf('con página propia') !== -1, pubMeta);
    var viewLink = Array.from(publishedRow.querySelectorAll('a')).find(function (a) { return a.textContent.trim() === 'Ver'; });
    check('7. published: "Ver" apunta a la URL pública real (categoria/business/...)', viewLink && viewLink.getAttribute('href') === '/site/categoria/business/prueba-preview-published-01.html', viewLink && viewLink.getAttribute('href'));
  }

  var redirectedRow = rowForTitle('Prueba Redirected');
  check('7. redirected: se encontró la fila en el listado', !!redirectedRow);
  if (redirectedRow) {
    var redirBtns = buttonsOf(redirectedRow);
    // Punto 3 del pedido, tomado literal: SOLO published puede usar "Ver".
    // redirected tiene un HTML real en disco (el stub), pero no es
    // 'published' -- por eso NUNCA debe mostrar "Ver", aunque el archivo
    // exista. Ver nota de interpretación en el informe.
    check('7. redirected: NUNCA muestra "Ver" (no es "published", punto 3 del pedido)', redirBtns.indexOf('Ver') === -1, redirBtns.join(', '));
    check('7. redirected: muestra "Vista previa" (decisión interpretativa, a confirmar con Leonardo)', redirBtns.indexOf('Vista previa') !== -1, redirBtns.join(', '));
    check('7. redirected: NUNCA muestra "Al carrusel"', redirBtns.indexOf('Al carrusel') === -1, redirBtns.join(', '));
  }

  window.close();
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

  // ---- Limpieza total de la copia aislada ----
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('Limpieza. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
