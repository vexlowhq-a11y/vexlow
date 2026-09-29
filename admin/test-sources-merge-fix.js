#!/usr/bin/env node
/*
  admin/test-sources-merge-fix.js
  ================================
  Bug real reportado 2026-09-20 (después de sincronizar el artículo
  editorial corregido de Nscale): data/articulos.json SÍ tiene sourceUrl,
  sourceTitle y additionalSources para Nscale, pero al abrir ese artículo
  en el panel:
    - el checklist en vivo vuelve a mostrar
      "❌ Fuentes -- Falta una URL de fuente real (http/https)";
    - el formulario no muestra NINGÚN campo para sourceUrl/sourceTitle/
      additionalSources.

  Causa raíz confirmada ANTES de escribir este archivo (investigación
  punto por punto pedida por Leonardo):
    1. Una copia fresca de data/articulos.json bajada del dispositivo real
       confirmó que Nscale SÍ conserva los tres campos en disco -- el
       archivo nunca se tocó desde que se sincronizó.
    2. admin/admin.js: buildArticleFromForm() arma el objeto que se manda
       al servidor a partir de una lista FIJA de campos leídos del
       formulario. sourceUrl/sourceTitle solo se copiaban desde
       `pendingDraft` (un borrador de RSS recién traído con "Usar este
       borrador") -- startEditArticle() (abrir un artículo YA GUARDADO
       para editarlo) nunca los leía, porque no había ningún campo del que
       leerlos. additionalSources no tenía NINGÚN camino, ni siquiera por
       pendingDraft.
    3. admin/index.html no tenía ningún control (<input>) para
       sourceUrl/sourceTitle/additionalSources -- de ahí que "el
       formulario no muestra campos visibles".
    4. El payload que arma runLiveValidation() para /api/validate-article
       es exactamente ese mismo objeto incompleto -- por eso el checklist
       se pone en rojo apenas se abre CUALQUIER artículo real para editar,
       incluso sin guardar nada.
    5. El endpoint de guardado individual (PUT /api/articles/:cat/:slug)
       llama a articles-store.upsertArticle(), que hacía
       `next[idx] = article` -- un REEMPLAZO TOTAL del registro guardado,
       sin ningún merge. Si se hubiera guardado esa edición, sourceUrl/
       sourceTitle/additionalSources se habrían borrado DE VERDAD -- el
       mismo problema, sin ningún control visible en absoluto, existe hoy
       para `topic`/`subtopic` (96 y 15 de los artículos reales
       respectivamente): abrir y guardar cualquiera de esos artículos
       también los habría borrado en silencio.

  Corrección (permanente, no un parche puntual para Nscale):
    A. admin/index.html: sección "Fuentes" visible -- URL y nombre de la
       fuente principal, más una lista dinámica de fuentes adicionales
       (agregar/quitar filas de {url, label}).
    B. admin/admin.js: startEditArticle()/useDraft() cargan esos tres
       campos desde el artículo real (o el borrador); buildArticleFromForm()
       los manda SIEMPRE (incluso null/[] si se vaciaron a propósito, para
       que limpiarlos siga funcionando bajo el merge de C).
    C. admin/articles-store.js (upsertArticle): merge seguro --
       `next[idx] = Object.assign({}, current.articles[idx], article)` en
       vez de un reemplazo total. Cualquier campo que el formulario NO
       mande (topic, subtopic, similarityWarning/Score,
       genericHeadingWarning, y cualquier campo futuro que todavía no
       tenga control en el panel) se conserva automáticamente -- ya no
       hace falta que el formulario conozca cada campo posible del
       esquema para no borrarlo.
    D. admin/server.js (PUT /api/articles/:cat/:slug) ahora devuelve el
       registro REALMENTE guardado (post-merge) como `savedArticle`, y
       admin.js lo usa para refrescar articlesData -- para que ni siquiera
       dentro de la misma sesión del panel un campo sin control visible
       aparezca como "perdido" después de guardar.

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real
  ni la carpeta del usuario), levantando el propio admin/server.js real
  como subproceso, y maneja el formulario a través de un DOM real (jsdom
  cargando el admin.js/admin.css/index.html reales, con runScripts
  habilitado) -- el PUT que llega al servidor es el mismo que mandaría un
  navegador real: en ningún momento se llama a buildArticleFromForm() ni a
  articles-store.upsertArticle() directamente desde el test (punto 7 del
  pedido: "probar el payload real enviado por el navegador").

  El artículo de Nscale usado acá es una copia fiel (fixture JSON al lado
  de este archivo, test-sources-merge-fix.fixture-nscale.json) del
  registro REAL tal cual quedó en la carpeta real de Leonardo después de
  la corrección editorial del 2026-09-20 -- este test nunca lee ni
  escribe la carpeta real.

  Pruebas (numeradas según el pedido de Leonardo):
    1. Abrir Nscale en el panel muestra la URL real del comunicado y la
       fuente adicional de TechCrunch en los campos nuevos.
    2. El checklist en vivo muestra "✅ Fuentes".
    3. Abrir y guardar SIN CAMBIOS: el registro de Nscale queda BYTE A
       BYTE idéntico (Nscale ya tenía status/editorialApproval/
       draftIncomplete explícitos desde la corrección editorial, así que
       acá sí aplica una igualdad estricta -- ver nota en el bloque 4/5
       sobre por qué los artículos VIEJOS sin esos campos no pueden dar
       una igualdad byte a byte, y qué se verifica en su lugar).
    4. Se repite sobre varios artículos reales viejos con estructuras de
       fuentes/imagen distintas (uno con additionalSources+topic, uno con
       solo sourceUrl, uno con sourceTitle+2 additionalSources+topic+
       subtopic) -- ninguno pierde un campo que ya tenía.
    5. Un artículo real sin sourceUrl sigue bloqueado (422) al intentar
       guardarlo -- y su registro en disco no cambia ni un byte.
    6. Los demás artículos (los que este test no tocó) no cambian.
    7. Todo lo anterior corre contra el payload real que arma y manda el
       propio admin.js en un DOM real -- nunca una llamada directa a
       funciones internas.
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
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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

// ---- Snapshot del sandbox ANTES de tocar nada (solo lectura) ----
const sandboxArticlesBefore = fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json'), 'utf8');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-sources-merge-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

const NSCALE_REAL_SNAPSHOT = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-sources-merge-fix.fixture-nscale.json'), 'utf8'));

// NOTA (corrección robusta, no exige 141 ni asume que el fixture está
// ausente): el propio artículo real de Nscale/Fidji Simo que da origen a
// este fixture puede o no estar todavía presente en data/articulos.json,
// según el estado real del sitio en el momento de correr esta prueba --
// antes de que Leonardo lo publicara de verdad, no existía (caso
// histórico, N=141); una vez publicado de verdad (caso actual, N=142+) el
// mismo category+slug SÍ existe. Ambos casos deben andar sin tocar 141 a
// mano: si ya existe, se REEMPLAZA ese registro por la copia fiel conocida
// del fixture (mismo category+slug, sin duplicar ni cambiar la cantidad
// total); si no existe todavía, se agrega como antes (+1).
let totalArticlesAtSetup;
let nscaleFixtureReplacedExisting;
{
  const articlesPath = path.join(dataDir, 'articulos.json');
  const all = JSON.parse(fs.readFileSync(articlesPath, 'utf8'));
  const existingIdx = all.findIndex(function (a) { return a.category === NSCALE_REAL_SNAPSHOT.category && a.slug === NSCALE_REAL_SNAPSHOT.slug; });
  let merged;
  if (existingIdx === -1) {
    merged = all.concat([NSCALE_REAL_SNAPSHOT]);
    nscaleFixtureReplacedExisting = false;
  } else {
    merged = all.slice();
    merged[existingIdx] = NSCALE_REAL_SNAPSHOT;
    nscaleFixtureReplacedExisting = true;
  }
  totalArticlesAtSetup = merged.length;
  fs.writeFileSync(articlesPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

// El fixture de Nscale es solo el registro JSON -- la imagen real que le
// corresponde (generada en su momento, sí existe en la carpeta real de
// Leonardo) no viaja con el fixture. Sin un archivo en esa ruta,
// validateImagePublication bloquearía el guardado por "la imagen no
// existe físicamente" -- un problema del FIXTURE de esta prueba, no del
// artículo real ni del bug reportado. Se copia cualquier .jpg real ya
// existente en la copia aislada a la ruta exacta que declara el fixture,
// para que la validación de imagen se comporte igual que con la carpeta
// real (donde el archivo sí está).
{
  const imgDir = path.join(tmpRoot, 'img', 'temas');
  const anyRealJpg = fs.readdirSync(imgDir).find(function (f) { return f.endsWith('.jpg'); });
  if (!anyRealJpg) throw new Error('No se encontró ningún .jpg real en img/temas/ para usar como stub de la imagen de Nscale.');
  fs.copyFileSync(path.join(imgDir, anyRealJpg), path.join(tmpRoot, NSCALE_REAL_SNAPSHOT.image));
}
console.log('Setup: ' + totalArticlesAtSetup + ' artículos en la copia aislada (' + (nscaleFixtureReplacedExisting
  ? totalArticlesAtSetup + ' reales, incluido el propio Nscale real ya publicado -- reemplazado por su copia fiel conocida (mismo category/slug, sin duplicar)'
  : (totalArticlesAtSetup - 1) + ' reales del sandbox + 1 copia fiel del Nscale real, todavía no publicado en este dataset') + ')\n');

const PORT = 4329; // puerto propio, distinto de las otras suites (4322/4324/4325/4326/4327/4328)
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

const base = 'http://127.0.0.1:' + PORT;

function readArticles() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
}
function findArticle(list, category, slug) {
  return list.find(function (a) { return a.category === category && a.slug === slug; });
}
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/api/articles');
      if (r.ok) return true;
    } catch (e) { /* todavía no arrancó */ }
    await sleep(100);
  }
  return false;
}

async function main() {
  const up = await waitForServer();
  check('Setup: el servidor real (copia aislada, puerto ' + PORT + ') arrancó', up, serverOutput.slice(-1000));
  if (!up) { child.kill(); cleanup(); process.exit(1); }

  const beforeSnapshot = readArticles(); // referencia completa para el punto 6

  // Se intercepta win.fetch para (a) redirigir URLs relativas al servidor
  // real de la copia aislada -- mismo patrón que test-preview-endpoint.js
  // -- y (b) grabar el payload EXACTO de cada PUT /api/articles/... que
  // mande admin.js, para el punto 7 (probar el payload real, no una
  // llamada directa a una función aislada).
  const capturedPuts = [];
  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (win) {
      win.HTMLElement.prototype.scrollIntoView = function () {}; // jsdom no lo implementa -- no es un bug real, solo una llamada cosmética (desplazar la vista) que en jsdom no tiene sentido
      win.fetch = function (url, opts) {
        var abs = new URL(url, win.location.href).toString();
        if (opts && opts.method === 'PUT' && /\/api\/articles\//.test(abs)) {
          try { capturedPuts.push({ url: abs, body: JSON.parse(opts.body) }); } catch (e) { console.error('captura PUT falló:', e); }
        }
        return fetch(abs, opts);
      };
    }
  });
  const { window } = dom;
  window.addEventListener('error', function () {}); // errores del DOM (ej. APIs de jsdom sin implementar, como scrollIntoView, ya parchada arriba) no deben tirar abajo la prueba
  const doc = window.document;

  var loaded = false;
  for (var i = 0; i < 60; i++) {
    await sleep(200);
    if (doc.querySelectorAll('.admin-item').length > 100) { loaded = true; break; }
  }
  check('Setup: el panel real (DOM real, admin.js real) terminó de cargar', loaded, 'admin-item=' + doc.querySelectorAll('.admin-item').length);
  if (!loaded) throw new Error('El panel no inicializó a tiempo: ' + serverOutput.slice(-2000));

  function rowForTitle(titleFrag) {
    var items = Array.from(doc.querySelectorAll('.admin-item'));
    return items.find(function (row) {
      var ttl = row.querySelector('.ttl');
      return ttl && ttl.textContent.indexOf(titleFrag) !== -1;
    });
  }
  function clickEditar(titleFrag) {
    var row = rowForTitle(titleFrag);
    if (!row) return null;
    var editBtn = Array.from(row.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === 'Editar'; });
    if (!editBtn) return null;
    editBtn.click();
    return row;
  }
  function checklistLineFor(labelText) {
    var items = Array.from(doc.querySelectorAll('#articleChecklistList li'));
    return items.find(function (li) { return li.textContent.indexOf(labelText) !== -1; });
  }
  function additionalSourceRows() {
    return Array.from(doc.querySelectorAll('#articleAdditionalSourcesList .additional-source-row'));
  }

  // ==== 1. Abrir Nscale y comprobar que aparecen Nscale y TechCrunch ====
  var nscaleRow = clickEditar('Fidji Simo');
  check('1. Se encontró la fila de Nscale en el listado del panel', !!nscaleRow);
  await sleep(50);
  var srcUrlInput = doc.getElementById('articleSourceUrl');
  var srcTitleInput = doc.getElementById('articleSourceTitle');
  check('1. El campo "Fuente principal — URL" se cargó solo con la URL real del comunicado de Nscale',
    srcUrlInput.value === NSCALE_REAL_SNAPSHOT.sourceUrl, srcUrlInput.value);
  check('1. El campo "Fuente principal — nombre" se cargó con "Nscale"', srcTitleInput.value === 'Nscale', srcTitleInput.value);
  var addlRows = additionalSourceRows();
  check('1. Aparece exactamente una fuente adicional', addlRows.length === 1, 'filas=' + addlRows.length);
  if (addlRows.length) {
    var tcUrl = addlRows[0].querySelector('.additional-source-url').value;
    var tcLabel = addlRows[0].querySelector('.additional-source-label').value;
    check('1. La fuente adicional es la URL real de TechCrunch', tcUrl === NSCALE_REAL_SNAPSHOT.additionalSources[0].url, tcUrl);
    check('1. La fuente adicional dice "TechCrunch"', tcLabel === 'TechCrunch', tcLabel);
  }

  // ==== 2. Confirmar que el checklist muestra ✅ Fuentes ====
  await sleep(900); // debounce de 500ms + ida y vuelta a /api/validate-article
  var sourcesLine = checklistLineFor('Fuentes');
  check('2. El checklist en vivo muestra "Fuentes" en verde (✅), no "falta una URL de fuente"',
    !!sourcesLine && sourcesLine.textContent.trim().indexOf('✅') === 0, sourcesLine && sourcesLine.textContent);

  // ==== 3. Abrir y guardar SIN CAMBIOS: byte a byte, nada desaparece ====
  // Nscale ya tenía status/editorialApproval/draftIncomplete explícitos
  // (se los puso la corrección editorial del 2026-09-20), así que acá SÍ
  // corresponde una igualdad estricta -- a diferencia de los artículos
  // viejos del punto 4, que nunca tuvieron esos tres campos y por lo tanto
  // buildArticleFromForm() se los agrega recién ahora (algo aditivo e
  // intencional -- ver nota grande más abajo, no es el bug reportado).
  var nscaleBeforeSave = findArticle(beforeSnapshot, NSCALE_REAL_SNAPSHOT.category, NSCALE_REAL_SNAPSHOT.slug);
  // Corrección 2026-09-20 (test flaky detectado en depuración): esta espera
  // comparaba el estado guardado contra `nscaleBeforeSave` tal cual -- pero
  // ese snapshot nunca tiene la clave `redirectTo`, mientras que CUALQUIER
  // guardado exitoso bajo el fix de este archivo agrega `redirectTo: null`
  // a propósito (ver nota grande más abajo). Esa condición de éxito nunca
  // podía cumplirse, así que el loop siempre agotaba las 50 iteraciones
  // (7.5s) sin detectar que el guardado ya había terminado -- normalmente
  // inofensivo (7.5s de espera desperdiciada pero el guardado ya estaba
  // listo mucho antes), pero en una corrida con I/O de disco más lento de
  // lo normal (writeFileAtomic hace fsyncSync antes del rename) alcanzó a
  // pasar que el guardado real TODAVÍA no había terminado cuando se agotó
  // la espera fija, y el test leyó un estado previo al guardado -- un
  // falso "redirectTo sigue sin normalizar", no un bug real del fix.
  // Se corrige comparando contra el estado ESPERADO después del guardado
  // (mismo objeto + redirectTo:null), para que el loop de veras detecte
  // cuándo terminó en vez de solo esperar un tiempo fijo -- y de paso
  // queda resiliente a un guardado ocasionalmente más lento.
  var nscaleExpectedAfterSave = Object.assign({}, nscaleBeforeSave, { redirectTo: null });
  doc.getElementById('articleSubmitBtn').click();
  for (var s1 = 0; s1 < 50; s1++) {
    await sleep(150);
    var errBox = doc.getElementById('articleValidationErrors');
    if (errBox && !errBox.hidden) break;
    var a3 = findArticle(readArticles(), NSCALE_REAL_SNAPSHOT.category, NSCALE_REAL_SNAPSHOT.slug);
    if (a3 && JSON.stringify(a3) === JSON.stringify(nscaleExpectedAfterSave)) break;
  }
  var nscalePut = capturedPuts.find(function (p) { return p.url.indexOf('/nscale-welcomes-former-openai-executive-fidji-simo-to-its-bo') !== -1; });
  check('3. (payload real) El PUT que mandó el navegador para Nscale incluye sourceUrl', !!nscalePut && nscalePut.body.sourceUrl === NSCALE_REAL_SNAPSHOT.sourceUrl);
  check('3. (payload real) El PUT que mandó el navegador para Nscale incluye additionalSources con TechCrunch',
    !!nscalePut && JSON.stringify(nscalePut.body.additionalSources) === JSON.stringify(NSCALE_REAL_SNAPSHOT.additionalSources));
  var nscaleAfterSave = findArticle(readArticles(), NSCALE_REAL_SNAPSHOT.category, NSCALE_REAL_SNAPSHOT.slug);
  // Nota sobre la única diferencia esperada: `redirectTo` pasa de "ausente"
  // a `null` explícito. Es un efecto colateral INTENCIONAL del propio fix
  // (ver el comentario en buildArticleFromForm(), admin/admin.js): antes,
  // un artículo no-redirected simplemente nunca tenía esta clave, lo cual
  // no importaba porque el guardado reemplazaba el registro entero. Ahora
  // que articles-store.upsertArticle hace un MERGE con lo que ya había en
  // disco, si un artículo alguna vez fue 'redirected' y dejó de serlo, un
  // `redirectTo` viejo quedaría pegado para siempre si el formulario no lo
  // limpia de forma explícita al salir de ese estado -- por eso ahora
  // siempre manda `redirectTo: null` cuando el status no es 'redirected'.
  // Ningún campo real desapareció ni cambió de VALOR -- ver el chequeo de
  // más abajo, que sí exige igualdad estricta en todo lo demás.
  var nscaleKeysToCompare = new Set(Object.keys(nscaleBeforeSave).concat(Object.keys(nscaleAfterSave || {})));
  nscaleKeysToCompare.delete('redirectTo');
  var nscaleDiffs = [];
  nscaleKeysToCompare.forEach(function (k) {
    if (JSON.stringify(nscaleBeforeSave[k]) !== JSON.stringify((nscaleAfterSave || {})[k])) nscaleDiffs.push(k);
  });
  check('3. Nscale: guardar sin tocar nada da un registro idéntico al original en TODO campo real (la única diferencia tolerada es la normalización explícita de redirectTo: ausente -> null, documentada en admin.js)',
    !!nscaleAfterSave && nscaleDiffs.length === 0, 'campos distintos: ' + nscaleDiffs.join(', '));
  check('3. Nscale: redirectTo queda explícitamente en null (nunca "colgado" con un valor viejo bajo el nuevo merge)', nscaleAfterSave && nscaleAfterSave.redirectTo === null, nscaleAfterSave && nscaleAfterSave.redirectTo);
  check('3. Nscale: sourceUrl sigue presente después de guardar sin cambios', !!nscaleAfterSave && nscaleAfterSave.sourceUrl === NSCALE_REAL_SNAPSHOT.sourceUrl);
  check('3. Nscale: sourceTitle sigue presente', !!nscaleAfterSave && nscaleAfterSave.sourceTitle === 'Nscale');
  check('3. Nscale: additionalSources (TechCrunch) sigue presente', !!nscaleAfterSave && JSON.stringify(nscaleAfterSave.additionalSources) === JSON.stringify(NSCALE_REAL_SNAPSHOT.additionalSources));
  // Ver nota de timing más abajo (punto 4): se espera a que el propio
  // formulario confirme que terminó su reset antes de abrir el siguiente
  // artículo, para no pisarle los campos recién cargados por detrás.
  for (var rN = 0; rN < 30 && doc.getElementById('articleFormTitle').textContent !== 'Agregar artículo'; rN++) await sleep(100);

  // ==== 4. Lo mismo sobre varios artículos REALES viejos con estructuras
  // de fuentes/imagen distintas ====
  // Nota importante sobre qué se puede exigir acá: estos artículos reales
  // NUNCA tuvieron los campos status/editorialApproval/draftIncomplete
  // (son artículos publicados de antes de que existieran esos tres
  // campos) -- buildArticleFromForm() los agrega SIEMPRE, para cualquier
  // artículo, sea o no el que reportó el bug. Eso es un comportamiento
  // aditivo preexistente (normalizar el estado editorial la primera vez
  // que se toca un artículo viejo desde el panel), documentado en el
  // propio admin.js, y NO tiene nada que ver con el bug de fuentes -- por
  // eso la comparación acá no es "el JSON completo es idéntico" sino "todo
  // campo que el artículo YA tenía sigue presente con el mismo valor", que
  // es exactamente lo que Leonardo pidió ("no desaparece ningún campo").
  // Como su status inferido pasa a ser 'published', hace falta tildar la
  // casilla de aprobación editorial para que el propio formulario deje
  // mandar el guardado (si no, ni siquiera llega a pedirle nada al
  // servidor) -- es una acción editorial real y esperada, no un cambio de
  // datos que el fix deba evitar.
  var OLD_ARTICLES_TO_CHECK = [
    { title: 'DeepSeek Develops', category: 'ai', slug: 'deepseek-develops-own-ai-chip' },
    { title: "Cursor Launches", category: 'ai', slug: 'cursor-targets-growth-in-india-with-local-pricing-amid-space' },
    { title: 'Ariana Grande Takes Legal Action', category: 'entertainment', slug: 'ariana-grande-takes-legal-action-against-hackers-over-leaked' }
  ];
  for (const spec of OLD_ARTICLES_TO_CHECK) {
    var before4 = findArticle(beforeSnapshot, spec.category, spec.slug);
    check('4. Setup: "' + spec.slug + '" existe en los datos reales del sandbox antes de tocar nada', !!before4);
    if (!before4) continue;
    var row4 = clickEditar(spec.title);
    check('4. "' + spec.slug + '": se encontró y se pudo abrir para editar', !!row4);
    if (!row4) continue;
    await sleep(50);
    // Confirma que el formulario cargó fielmente lo que ya tenía ANTES de
    // guardar nada -- así el PUT de abajo no "arregla" nada por accidente.
    check('4. "' + spec.slug + '": el campo de fuente principal se precargó con el valor real',
      doc.getElementById('articleSourceUrl').value === (before4.sourceUrl || ''));
    check('4. "' + spec.slug + '": las fuentes adicionales reales se precargaron (' + ((before4.additionalSources || []).length) + ')',
      additionalSourceRows().length === (before4.additionalSources || []).length);
    doc.getElementById('articleEditorialApproval').checked = true;
    // El botón "Guardar" queda deshabilitado hasta que vuelve la
    // validación en vivo (debounce de 500ms + ida y vuelta al servidor) --
    // clickear un <button disabled> no dispara el submit (ni en un
    // navegador real ni en jsdom), así que hay que esperar a que se
    // habilite antes de clickear, o el click no hace nada.
    for (var w4 = 0; w4 < 20 && doc.getElementById('articleSubmitBtn').disabled; w4++) await sleep(150);
    doc.getElementById('articleSubmitBtn').click();
    var settled4 = false;
    for (var s4 = 0; s4 < 60; s4++) {
      await sleep(150);
      var errBox4 = doc.getElementById('articleValidationErrors');
      var blocked4 = errBox4 && !errBox4.hidden;
      var afterNow = findArticle(readArticles(), spec.category, spec.slug);
      if (blocked4 || (afterNow && afterNow.editorialApproval === true)) { settled4 = true; break; }
    }
    check('4. "' + spec.slug + '": el guardado se resolvió (no quedó colgado)', settled4);
    // Un guardado exitoso dispara, del lado del cliente, resetArticleForm()
    // -- que hace articleForm.reset() -- DESPUÉS de que el archivo en disco
    // ya quedó escrito (server responde -> .then() del cliente recién ahí
    // corre). Si se pasa a editar el SIGUIENTE artículo antes de que ese
    // reset termine, el reset le vacía por atrás los campos que el
    // siguiente "Editar" acababa de cargar (incluido articleSlug) -- un
    // problema de TIMING de esta prueba, no del panel real (un humano
    // nunca hace dos clics así de pegados). Se espera a que el formulario
    // realmente vuelva a "Agregar artículo" antes de tocar el siguiente.
    if (!blocked4) {
      for (var r4 = 0; r4 < 30 && doc.getElementById('articleFormTitle').textContent !== 'Agregar artículo'; r4++) await sleep(100);
    }
    var after4 = findArticle(readArticles(), spec.category, spec.slug);
    check('4. "' + spec.slug + '": el guardado se aceptó (200, nunca 422 -- ya tenía fuente real)', !!after4 && after4.editorialApproval === true);
    if (after4) {
      var keysBefore4 = Object.keys(before4);
      var missing4 = keysBefore4.filter(function (k) { return !Object.prototype.hasOwnProperty.call(after4, k); });
      check('4. "' + spec.slug + '": ningún campo que ya tenía desapareció (claves: ' + keysBefore4.length + ')', missing4.length === 0, 'faltantes: ' + missing4.join(', '));
      check('4. "' + spec.slug + '": sourceUrl conserva el mismo valor', after4.sourceUrl === before4.sourceUrl);
      if (before4.sourceTitle !== undefined) check('4. "' + spec.slug + '": sourceTitle conserva el mismo valor', after4.sourceTitle === before4.sourceTitle);
      if (before4.additionalSources !== undefined) check('4. "' + spec.slug + '": additionalSources conserva el mismo valor', JSON.stringify(after4.additionalSources) === JSON.stringify(before4.additionalSources));
      if (before4.topic !== undefined) check('4. "' + spec.slug + '": topic (sin control en el formulario) se conservó gracias al merge seguro', after4.topic === before4.topic);
      if (before4.subtopic !== undefined) check('4. "' + spec.slug + '": subtopic (sin control en el formulario) se conservó gracias al merge seguro', after4.subtopic === before4.subtopic);
      check('4. "' + spec.slug + '": título, dek y cuerpo no cambiaron de valor (solo se guardó, no se editó nada)',
        after4.title === before4.title && after4.dek === before4.dek && after4.body === before4.body);
    }
  }

  // ==== 5. Un artículo real sin sourceUrl sigue bloqueado ====
  var SPIDERMAN = { title: 'Spider-Man: Brand New Day', category: 'entertainment', slug: 'spider-man-brand-new-day-poised-for-record-setting-box-offic' };
  var spidermanBefore = findArticle(beforeSnapshot, SPIDERMAN.category, SPIDERMAN.slug);
  check('5. Setup: el artículo de prueba realmente no tiene sourceUrl en los datos reales', !!spidermanBefore && !spidermanBefore.sourceUrl);
  var row5 = clickEditar(SPIDERMAN.title);
  check('5. Se encontró y se pudo abrir "Spider-Man: Brand New Day" para editar', !!row5);
  if (row5) {
    await sleep(50);
    check('5. El campo de fuente principal queda vacío (el artículo real no tiene sourceUrl)', doc.getElementById('articleSourceUrl').value === '');
    doc.getElementById('articleEditorialApproval').checked = true;
    await sleep(900); // deja terminar la validación en vivo -- confirma que el propio checklist ya lo marca mal
    var checklistText5 = doc.getElementById('articleChecklistList').textContent;
    check('5. El checklist en vivo YA marca "Fuentes" en rojo antes de intentar guardar', /❌ Fuentes/.test(checklistText5), checklistText5);
    // El botón "Guardar" queda deshabilitado por el checklist (una
    // VISTA PREVIA, según el propio comentario de admin.js) -- clickearlo
    // no dispara nada. Para probar el gate DE VERDAD (el servidor, no la
    // comodidad del cliente -- "el checklist nunca puede ser la única
    // defensa"), se dispara el submit del formulario directamente, tal
    // como lo haría un botón habilitado, y se deja que sea el 422 real de
    // POST/PUT el que bloquee.
    doc.getElementById('articleForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    var blocked5 = false;
    for (var s5 = 0; s5 < 50; s5++) {
      await sleep(150);
      var errBox5 = doc.getElementById('articleValidationErrors');
      if (errBox5 && !errBox5.hidden) { blocked5 = true; break; }
    }
    check('5. El guardado quedó bloqueado (422 real del servidor, no un chequeo solo del cliente)', blocked5);
    if (blocked5) {
      var errText5 = doc.getElementById('articleValidationErrors').textContent;
      check('5. El motivo mostrado menciona la falta de una URL de fuente real', /fuente/i.test(errText5) && /(http|url)/i.test(errText5), errText5);
    }
    var spidermanAfter = findArticle(readArticles(), SPIDERMAN.category, SPIDERMAN.slug);
    check('5. El registro de "Spider-Man: Brand New Day" en disco no cambió NI UN BYTE (el 422 nunca llega a escribir)',
      JSON.stringify(spidermanAfter) === JSON.stringify(spidermanBefore));
  }

  // ==== 6. Los demás artículos (no tocados por este test) no cambian ====
  var TOUCHED = new Set([
    NSCALE_REAL_SNAPSHOT.category + '/' + NSCALE_REAL_SNAPSHOT.slug,
    'ai/deepseek-develops-own-ai-chip',
    'ai/cursor-targets-growth-in-india-with-local-pricing-amid-space',
    'entertainment/ariana-grande-takes-legal-action-against-hackers-over-leaked',
    'entertainment/spider-man-brand-new-day-poised-for-record-setting-box-offic'
  ]);
  var finalArticles = readArticles();
  check('6. La cantidad total de artículos no cambió (' + totalArticlesAtSetup + ')', finalArticles.length === totalArticlesAtSetup, 'ahora: ' + finalArticles.length);
  var untouchedDiffs = [];
  beforeSnapshot.forEach(function (a) {
    var key = a.category + '/' + a.slug;
    if (TOUCHED.has(key)) return;
    var now = findArticle(finalArticles, a.category, a.slug);
    if (!now || JSON.stringify(now) !== JSON.stringify(a)) untouchedDiffs.push(key);
  });
  check('6. Ningún otro artículo (de los ' + (totalArticlesAtSetup - TOUCHED.size) + ' no tocados por este test) cambió', untouchedDiffs.length === 0, untouchedDiffs.join(', '));

  // ==== 7. Confirmación explícita de metodología: todo lo de arriba pasó
  // por el payload real armado y mandado por admin.js en un DOM real ====
  check('7. Se capturaron PUT reales (armados por admin.js, no por el test) hacia /api/articles/...', capturedPuts.length >= 4, 'capturados: ' + capturedPuts.length);
  check('7. El PUT real de Nscale llevaba sourceUrl/sourceTitle/additionalSources en el cuerpo (no una llamada directa a buildArticleFromForm)',
    !!nscalePut && nscalePut.body.sourceUrl && nscalePut.body.sourceTitle && Array.isArray(nscalePut.body.additionalSources));

  // ==== Limpieza: el sandbox real de este entorno nunca se tocó ====
  var sandboxArticlesAfter = fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json'), 'utf8');
  check('Limpieza. data/articulos.json del SANDBOX (no la copia aislada) no cambió durante estas pruebas', sandboxArticlesAfter === sandboxArticlesBefore);

  child.kill();
  cleanup();

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* no crítico */ }
}

main().catch(function (err) {
  console.error('ERROR en la suite:', err && err.stack || err);
  try { child.kill(); } catch (e) {}
  cleanup();
  process.exit(1);
});
