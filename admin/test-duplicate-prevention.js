#!/usr/bin/env node
/*
  admin/test-duplicate-prevention.js
  ===================================
  Prueba del incidente 2026-09-13 ("el panel ahora muestra 146 artículos
  cuando el estado correcto anterior era 141 -- la noticia de prueba
  'Moonshot AI Sets Ambitious $2 Billion Revenue Goal Amid Declining K3
  Usage' aparece repetida aproximadamente cinco veces. Probablemente
  pulsé Guardar varias veces porque el panel estaba lento").

  Diagnóstico confirmado ANTES de escribir este archivo (ver informe):
  data/articulos.json real nunca llegó a tener 146 -- articles-store.js
  ya era idempotente por categoría+slug (ops-log.jsonl real: 1
  article_create + 4 article_update, mismo prevRev/newRev en los 4
  updates, después 1 article_delete que restauró el hash EXACTO de la
  base de 141) -- lo que sí faltaba era: (1) el panel (admin.js) no
  bloqueaba el botón mientras esperaba la respuesta, así que 5 clics
  reales disparaban 5 persistArticleEdit() superpuestos que SÍ
  duplicaban el artículo en articlesData (memoria del navegador, de ahí
  el "146" visual); y (2) cada guardado -- incluido guardar un borrador
  que nunca fue público -- disparaba una regeneración COMPLETA de las
  ~141 páginas del sitio (la causa real de "el panel estaba lento").
  También se encontró, investigando, que articulos.js (lo que carga
  js/script.js en el sitio EN VIVO) incluía sin filtrar cualquier
  artículo draft/review/approved -- un borrador podía aparecer en
  Últimas/Trending/categorías/buscador del sitio público mientras
  existiera en articulos.json, sin tener página propia ni sitemap.

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox
  real ni la carpeta del usuario), levantando el propio admin/server.js
  real como subproceso -- las pruebas HTTP pegan contra los mismos
  endpoints que usa el panel de verdad. Además carga el admin.js/HTML
  reales en un DOM real (jsdom) para D (doble Enter).

  Pruebas (letras según el pedido del usuario):
    A. Cinco clics rápidos (simulados a nivel HTTP, el peor caso: sin
       ningún candado de cliente, cada uno con su propia clave de
       idempotencia, EN PARALELO) sobre el mismo artículo nuevo ->
       exactamente un registro en articulos.json al final.
    B. Repetir la MISMA petición (misma clave de idempotencia) no
       duplica -- la segunda respuesta es la cacheada, sin volver a
       escribir nada.
    C. Guardar de nuevo (edición real, clave nueva) actualiza el mismo
       registro -- no agrega uno nuevo.
    D. Doble Enter (dos eventos 'submit' disparados sobre el <form> REAL
       en jsdom, sincrónicamente) -> el candado del cliente ignora el
       segundo -- el servidor solo recibe una petición.
    E. Reintento de red con la MISMA clave de idempotencia (2 PUT
       secuenciales, igual que B pero como escenario de "reintento") no
       duplica.
    F. Mismo slug, identidad distinta (un alta que declara category/slug
       ya usados por OTRO artículo existente) -> 409.
    G. Guardar un borrador (status:'draft'): cero HTML público generado
       (no aparece categoria/<cat>/<slug>.html).
    H. Guardar un borrador: cero cambios en sitemap.xml, portada
       (index.html) o la página de categoría -- hashes idénticos antes y
       después.
    H2 (control). Guardar/editar un artículo PUBLICADO real SÍ sigue
       regenerando el sitio -- la optimización no rompe el caso normal.
    I. Dos "pestañas" (guardado masivo con If-Match vencido) -> 409
       revision_conflict, tal como ya garantizaba articles-store.js.
    J. Al terminar, el sitio REAL sigue con exactamente 141 artículos.
    K. Cero referencias a "moonshot" en el sitio REAL (articulos.json,
       articulos.js, drafts.json, sitemap.xml).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { JSDOM } = (() => { try { return require('jsdom'); } catch (e) { return {}; } })();

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

function sha256(buf) { return require('crypto').createHash('sha256').update(buf).digest('hex'); }

// ---- Snapshot del sitio REAL antes de tocar nada (solo lectura) ----
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-dup-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

const PORT = 4325; // puerto de prueba propio, distinto de las otras suites (4322, 4324)
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

function baseArticleTemplate() {
  const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
  const tmpl = all.find(function (a) { return a.slug === 'nasa-prepares-for-launch-of-nancy-grace-roman-space-telescop'; });
  const clone = JSON.parse(JSON.stringify(tmpl));
  clone.noindex = false;
  clone.noindexReason = '';
  delete clone.correctionNote;
  return clone;
}

function put(category, slug, article, idemKey) {
  var headers = { 'Content-Type': 'application/json' };
  if (idemKey) headers['X-Idempotency-Key'] = idemKey;
  return fetch('http://127.0.0.1:' + PORT + '/api/articles/' + category + '/' + slug, {
    method: 'PUT', headers: headers, body: JSON.stringify(article)
  });
}

function countBySlug(articles, slug) {
  return articles.filter(function (a) { return a.slug === slug; }).length;
}

async function main() {
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');

  const countBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8')).length;

  // ---- A. Cinco clics rápidos (peor caso, en paralelo, claves distintas) ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-cinco-clics-13sep';
    article.title = 'Prueba sintética: cinco clics rápidos';
    article.dek = 'Dek sintético usado solo para la prueba A de guardado duplicado.';
    article.date = '2026-09-13';
    article.status = 'draft';
    article.draftIncomplete = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const attempts = [1, 2, 3, 4, 5].map(function (i) {
      return put(article.category, article.slug, article, 'key-A-attempt-' + i);
    });
    const results = await Promise.all(attempts);
    const allOk = results.every(function (r) { return r.status === 200; });
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
    check('A. Las 5 peticiones concurrentes respondieron 200', allOk, JSON.stringify(results.map(function (r) { return r.status; })));
    check('A. Cinco clics rápidos -> exactamente UN registro en articulos.json (no 5)', countBySlug(after, article.slug) === 1, 'apariciones=' + countBySlug(after, article.slug));
    check('A. El total subió en exactamente 1 (no en 5)', after.length === countBefore + 1, 'antes=' + countBefore + ' después=' + after.length);
  }

  // ---- B. Repetir la MISMA petición (misma clave) no duplica ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-misma-clave-13sep';
    article.title = 'Prueba sintética: misma clave de idempotencia';
    article.dek = 'Dek sintético usado solo para la prueba B.';
    article.date = '2026-09-13';
    article.status = 'draft';
    article.draftIncomplete = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const key = 'key-B-fixed';
    const r1 = await put(article.category, article.slug, article, key);
    const b1 = await r1.json();
    const r2 = await put(article.category, article.slug, article, key);
    const b2 = await r2.json();
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
    check('B. Repetir la misma clave devuelve la misma respuesta cacheada', JSON.stringify(b1) === JSON.stringify(b2), JSON.stringify(b1) + ' vs ' + JSON.stringify(b2));
    check('B. Repetir la misma clave -> sigue habiendo exactamente UN registro', countBySlug(after, article.slug) === 1, 'apariciones=' + countBySlug(after, article.slug));
  }

  // ---- C. Guardar de nuevo (clave nueva) actualiza, no duplica ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-guardar-de-nuevo-13sep';
    article.title = 'Prueba sintética: guardar de nuevo';
    article.dek = 'Dek original.';
    article.date = '2026-09-13';
    article.status = 'draft';
    article.draftIncomplete = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    await put(article.category, article.slug, article, 'key-C-1');
    const updated = JSON.parse(JSON.stringify(article));
    updated.dek = 'Dek actualizado en el segundo guardado.';
    await put(article.category, article.slug, updated, 'key-C-2');

    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
    check('C. Guardar de nuevo -> sigue habiendo exactamente UN registro', countBySlug(after, article.slug) === 1, 'apariciones=' + countBySlug(after, article.slug));
    const saved = after.find(function (a) { return a.slug === article.slug; });
    check('C. El registro único quedó con el contenido de la SEGUNDA edición', saved && saved.dek === 'Dek actualizado en el segundo guardado.', JSON.stringify(saved && saved.dek));
  }

  // ---- E. "Reintento de red" con la misma clave (secuencial) no duplica ----
  {
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-reintento-red-13sep';
    article.title = 'Prueba sintética: reintento de red';
    article.dek = 'Dek sintético usado solo para la prueba E.';
    article.date = '2026-09-13';
    article.status = 'draft';
    article.draftIncomplete = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const key = 'key-E-fixed';
    await put(article.category, article.slug, article, key);
    // Simula que la respuesta se perdió y el cliente reintenta la MISMA petición
    await put(article.category, article.slug, article, key);
    await put(article.category, article.slug, article, key);
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
    check('E. Tres reintentos con la misma clave -> exactamente UN registro', countBySlug(after, article.slug) === 1, 'apariciones=' + countBySlug(after, article.slug));
  }

  // ---- F. Mismo slug, identidad distinta -> 409 ----
  {
    const existing = baseArticleTemplate();
    existing.slug = 'prueba-sintetica-slug-ocupado-13sep';
    existing.title = 'Prueba sintética: slug ya ocupado';
    existing.date = '2026-09-13';
    existing.status = 'draft';
    existing.draftIncomplete = true;
    existing.href = 'categoria/' + existing.category + '/' + existing.slug + '.html';
    await put(existing.category, existing.slug, existing, 'key-F-existing');

    // Un alta NUEVA (URL con un slug que todavía no existe) cuyo CUERPO
    // declara la misma categoría/slug que la ya guardada arriba -- mismo
    // caso que "el mismo slug con otra identidad" (articles-store.js lo
    // detecta como colisión al intentar el alta/rename).
    const colliding = JSON.parse(JSON.stringify(existing));
    colliding.title = 'Prueba sintética: intento de colisión de slug';
    const rColl = await put(existing.category, 'prueba-sintetica-slug-nuevo-que-no-existia-13sep', colliding, 'key-F-collide');
    check('F. Mismo slug con otra identidad -> 409', rColl.status === 409, 'status=' + rColl.status);
    const bodyColl = await rColl.json();
    check('F. El 409 identifica la colisión de slug', bodyColl.error === 'ya_existe', JSON.stringify(bodyColl));
  }

  // ---- G/H. Guardar un borrador: cero HTML, cero cambios en sitemap/portada/categoría ----
  {
    const sitemapBefore = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'));
    const portadaBefore = fs.readFileSync(path.join(tmpRoot, 'index.html'));
    const catIndexPath = path.join(tmpRoot, 'categoria', 'science', 'index.html');
    const catIndexBefore = fs.readFileSync(catIndexPath);

    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-borrador-sin-regen-13sep';
    article.title = 'Prueba sintética: borrador sin regeneración';
    article.dek = 'Dek sintético usado solo para las pruebas G/H.';
    article.date = '2026-09-13';
    article.status = 'draft';
    article.draftIncomplete = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const r = await put(article.category, article.slug, article, 'key-GH');
    const body = await r.json();
    check('G/H. La respuesta indica que se saltó la regeneración (nada visible cambió)', body.skippedNoVisibleChange === true, JSON.stringify(body));
    check('G/H. generated:0 -- no se creó ninguna página', body.generated === 0, JSON.stringify(body));

    const htmlPath = path.join(tmpRoot, 'categoria', article.category, article.slug + '.html');
    check('G. Guardar un borrador NO genera su HTML público', !fs.existsSync(htmlPath), htmlPath);

    const sitemapAfter = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'));
    const portadaAfter = fs.readFileSync(path.join(tmpRoot, 'index.html'));
    const catIndexAfter = fs.readFileSync(catIndexPath);
    check('H. sitemap.xml no cambió (hash idéntico)', sha256(sitemapBefore) === sha256(sitemapAfter));
    check('H. La portada (index.html) no cambió (hash idéntico)', sha256(portadaBefore) === sha256(portadaAfter));
    check('H. La página de categoría no cambió (hash idéntico)', sha256(catIndexBefore) === sha256(catIndexAfter));
  }

  // ---- H2 (control). Un artículo PUBLICADO real sigue regenerando el sitio ----
  {
    const sitemapBefore = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'));
    const article = baseArticleTemplate();
    article.slug = 'prueba-sintetica-publicado-si-regenera-13sep';
    article.title = 'Prueba sintética: publicado sí regenera';
    article.dek = 'Dek sintético legítimo, largo y sin lenguaje promocional, para la prueba de control H2.';
    article.date = '2026-09-13';
    article.status = 'published';
    article.editorialApproval = true;
    article.href = 'categoria/' + article.category + '/' + article.slug + '.html';

    const r = await put(article.category, article.slug, article, 'key-H2');
    const body = await r.json();
    check('H2 (control). Guardar un artículo PUBLICADO nuevo SÍ regenera (generated > 0)', typeof body.generated === 'number' && body.generated > 0, JSON.stringify(body));
    const htmlPath = path.join(tmpRoot, 'categoria', article.category, article.slug + '.html');
    check('H2 (control). El artículo publicado SÍ tiene su HTML propio', fs.existsSync(htmlPath));
    const sitemapAfter = fs.readFileSync(path.join(tmpRoot, 'sitemap.xml'));
    check('H2 (control). sitemap.xml SÍ cambió al publicar de verdad', sha256(sitemapBefore) !== sha256(sitemapAfter));
  }

  // ---- I. Dos "pestañas" (guardado masivo con If-Match vencido) -> 409 ----
  {
    // Artículo dedicado y "limpio" para esta prueba (imagen propia
    // marcada como reutilización autorizada, título sin parecido a
    // ningún otro sintético ya creado) -- así el 409 que se busca acá
    // (conflicto de revisión) no se mezcla con las heurísticas de
    // calidad/similaridad, que son un control aparte y ya probado en
    // otras suites.
    const dedicated = baseArticleTemplate();
    dedicated.slug = 'prueba-sintetica-dedicada-prueba-i-13sep';
    dedicated.title = 'Zzz artículo dedicado exclusivamente a la prueba I de conflicto de revisión';
    dedicated.dek = 'Dek sintético dedicado, sin relación con ningún otro artículo de esta suite.';
    dedicated.date = '2026-09-13';
    dedicated.status = 'published';
    dedicated.editorialApproval = true;
    dedicated.imageReuseAuthorized = true;
    dedicated.href = 'categoria/' + dedicated.category + '/' + dedicated.slug + '.html';
    await put(dedicated.category, dedicated.slug, dedicated, 'key-I-setup');

    const getRes = await fetch('http://127.0.0.1:' + PORT + '/api/articles');
    const rev = (getRes.headers.get('ETag') || '').replace(/^"|"$/g, '');
    const current = await getRes.json();

    // "Pestaña 1" guarda primero con éxito, cambiando algo de verdad (si
    // el contenido fuera idéntico al ya guardado, el hash/revisión no
    // cambiaría y la prueba de conflicto de la pestaña 2 no tendría
    // sentido) -- marca "trending" el artículo dedicado de arriba.
    const tab1Data = JSON.parse(JSON.stringify(current));
    const idx = tab1Data.findIndex(function (a) { return a.slug === dedicated.slug; });
    tab1Data[idx].trending = !tab1Data[idx].trending;
    const r1 = await fetch('http://127.0.0.1:' + PORT + '/api/articles', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': rev }, body: JSON.stringify(tab1Data)
    });
    const r1body = await r1.json().catch(function () { return {}; });
    check('I. Guardado masivo de la "pestaña 1" (revisión al día) -> 200', r1.status === 200, 'status=' + r1.status + ' ' + JSON.stringify(r1body));

    // "Pestaña 2" todavía tiene la revisión VIEJA (de antes de que guardara la pestaña 1).
    const tab2Data = current.slice();
    const r2 = await fetch('http://127.0.0.1:' + PORT + '/api/articles', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': rev }, body: JSON.stringify(tab2Data)
    });
    check('I. Guardado masivo de la "pestaña 2" (revisión vieja) -> 409 revision_conflict', r2.status === 409, 'status=' + r2.status);
    const body2 = await r2.json();
    check('I. El 409 es específicamente revision_conflict', body2.error === 'revision_conflict', JSON.stringify(body2));
  }

  // ---- D. Doble Enter sobre el <form> REAL en jsdom ----
  if (!JSDOM) {
    check('D. (jsdom no disponible en este entorno -- prueba de doble Enter omitida)', true);
  } else {
    const putsSeen = [];
    const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', {
      runScripts: 'dangerously',
      resources: 'usable',
      beforeParse: function (win) {
        win.fetch = function (url, opts) {
          var abs = new URL(url, win.location.href).toString();
          if (opts && opts.method === 'PUT' && abs.indexOf('/api/articles/') !== -1) {
            putsSeen.push({ url: abs, key: opts.headers && opts.headers['X-Idempotency-Key'] });
          }
          return fetch(abs, opts);
        };
      }
    });
    await new Promise(function (resolve) {
      dom.window.document.addEventListener('DOMContentLoaded', function () { setTimeout(resolve, 400); });
      if (dom.window.document.readyState === 'complete') setTimeout(resolve, 400);
    });
    const win = dom.window;
    const doc = win.document;
    doc.getElementById('articleTitle').value = 'Prueba sintética: doble Enter';
    doc.getElementById('articleTitle').dispatchEvent(new win.Event('input', { bubbles: true }));
    doc.getElementById('articleDek').value = 'Dek sintético para la prueba D.';
    doc.getElementById('articleBody').value = 'Cuerpo sintético de prueba, suficientemente largo, usado únicamente para la prueba D de doble Enter en el panel real.';
    var form = doc.getElementById('articleForm');
    // Dos 'submit' disparados sincrónicamente, uno detrás del otro -- el
    // candado (articleSaveInFlight) se activa DENTRO del primer handler,
    // antes de cualquier await, así que el segundo debe verlo activo.
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(function (r) { setTimeout(r, 700); });
    check('D. Doble Enter -> el candado del cliente dejó pasar UNA sola petición PUT al servidor', putsSeen.length === 1, 'peticiones vistas=' + putsSeen.length + ' ' + JSON.stringify(putsSeen));
    dom.window.close();
  }

  child.kill();
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas HTTP:', e);
  console.error('Salida del servidor de prueba:\n' + serverOutput);
  fail++;
  child.kill();
}).finally(function () {
  // ---- J. Confirmar que el sitio REAL sigue en exactamente 141 ----
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('J. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('J. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  // ---- K. Cero referencias a "moonshot" en el sitio REAL ----
  const realFilesToCheck = [
    path.join(REAL_ROOT, 'data', 'articulos.json'),
    path.join(REAL_ROOT, 'data', 'articulos.js'),
    path.join(REAL_ROOT, 'data', 'drafts.json'),
    path.join(REAL_ROOT, 'sitemap.xml')
  ];
  var anyMoonshot = false;
  realFilesToCheck.forEach(function (f) {
    try {
      if (/moonshot/i.test(fs.readFileSync(f, 'utf8'))) anyMoonshot = true;
    } catch (e) { /* archivo no encontrado -- no es este el que importa */ }
  });
  check('K. Cero referencias a "moonshot" en articulos.json/articulos.js/drafts.json/sitemap.xml reales', !anyMoonshot);

  // ---- Limpieza total de la copia aislada ----
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('Limpieza. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
