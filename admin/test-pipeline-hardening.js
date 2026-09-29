#!/usr/bin/env node
/*
  admin/test-pipeline-hardening.js
  ===================================
  Verificación previa a sincronizar (pedido de Leonardo, 2026-09-24) sobre
  el pipeline de dos fases de "Buscar noticias nuevas" (ver
  test-two-phase-pipeline.js para las 10 pruebas obligatorias originales).
  Este archivo cubre específicamente los puntos que Leonardo pidió cerrar
  ANTES de autorizar la sincronización:

    1. Caché técnica (data/candidate-cache.json): escritura atómica
       (temporal + rename), comportamiento seguro con JSON corrupto,
       tope máximo de entradas.
    2. El timeout global de preselección cancela DE VERDAD el trabajo --
       0 llamadas de IA cuando buildCandidates() cortó por timeout, incluso
       si ya había candidatos aprobados antes del corte.
    3. Concurrencia: dos corridas de fetchNewDrafts() superpuestas nunca
       corren en paralelo -- una sola ejecución efectiva, sin duplicar
       llamadas de IA, sin corromper candidate-cache.json.
    4. Borradores viejos de una sola fuente (de antes de este pedido, sin
       los campos nuevos) siguen clasificando "revisar", nunca "listo",
       nunca se tocan ni se borran solos con una corrida nueva.
    5. Duplicado/prioridad contra una copia de SOLO LECTURA del
       data/articulos.json REAL de la computadora de Leonardo (142
       artículos) -- nunca se escribe ese archivo, nunca reemplaza el
       sandbox.

  Corre sobre COPIAS AISLADAS del sitio completo (nunca el sandbox real,
  salvo lectura al final para confirmar que no cambió).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

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
function isoDaysAgo(days) { return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
const REAL_DEVICE_SNAPSHOT = '/mnt/user-data/uploads/vexlowhq/data/articulos.json';

function baseCfg(extra) {
  return Object.assign({ draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }, extra || {});
}
function makeInstrumentedDraftArticle(responseFn, delayMs) {
  var calls = 0;
  var fn = function (item, cfg, categoryOptions, sourcesForPrompt) {
    calls++;
    var built = responseFn ? responseFn(item, sourcesForPrompt) : {
      title: 'Cobertura redactada de forma independiente sobre ' + item.title,
      dek: 'Dek redactado de forma independiente para esta prueba automatizada.',
      body: 'Cuerpo redactado de forma completamente independiente, con contenido suficiente para pasar cualquier validación básica de longitud del sitio.\n\n## Contexto adicional\nSección propia sin copiar el resumen original.',
      category: item.category, readTime: '3 min', keyClaims: []
    };
    var p = Promise.resolve(built);
    if (delayMs) p = sleep(delayMs).then(function () { return built; });
    return p;
  };
  fn.getCallCount = function () { return calls; };
  return fn;
}

// ============================================================================
// Setup: una copia aislada por bloque de pruebas (igual patrón que el resto
// de la batería) -- se crea una nueva por sección para que el candado de
// concurrencia y los archivos de caché nunca se pisen entre secciones.
// ============================================================================
function makeIsolatedCopy() {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-hardening-'));
  copyDirSync(REAL_ROOT, tmpRoot);
  fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');
  var adminDir = path.join(tmpRoot, 'admin');
  var dataDir = path.join(tmpRoot, 'data');
  // Cada copia aislada requiere su PROPIA instancia del módulo (nunca
  // reusar el cache de require() entre copias -- si no, todas comparten el
  // mismo `fetchInProgress`/`currentFetchStatus` en memoria y las pruebas
  // de concurrencia de una sección contaminarían a la siguiente).
  delete require.cache[require.resolve(path.join(adminDir, 'pipeline.js'))];
  delete require.cache[require.resolve(path.join(adminDir, 'draft.js'))];
  delete require.cache[require.resolve(path.join(adminDir, 'feeds.js'))];
  delete require.cache[require.resolve(path.join(adminDir, 'google-trends.js'))];
  var pipeline = require(path.join(adminDir, 'pipeline.js'));
  var draft = require(path.join(adminDir, 'draft.js'));
  var feeds = require(path.join(adminDir, 'feeds.js'));

  // Corrección de Leonardo (2026-09-28): CUALQUIER sección de este archivo
  // que termine llamando fetchNewDrafts()/buildCandidatesFromTrends() pasa
  // primero por Google Trends público (ver runFetchNewDraftsWithDeadline en
  // pipeline.js) -- sin mockear, eso es una llamada de red REAL, con
  // latencia variable e impredecible del sandbox, que puede competir contra
  // plazos ajustados de las pruebas y producir resultados no deterministas
  // (confirmado empíricamente: 4 corridas de la Sección 2 sin este mock
  // dieron pass/fail/pass/pass). Se mockea acá, de forma centralizada para
  // TODA copia aislada -- no sólo la sección que expuso el problema --
  // así ninguna sección de este archivo depende jamás de la red pública.
  // fetchTrendingNow() siempre RECHAZA de inmediato (misma forma de fallo
  // real que "sin red"; ver el contrato de la función en google-trends.js:
  // nunca devuelve un array vacío en silencio, siempre lanza), por lo que
  // buildCandidatesFromTrends() cae al respaldo RSS de forma determinista,
  // sin llamada de red y sin variabilidad de tiempos. Cada sección que
  // quiera ejercitar el camino de Trends explícitamente puede reemplazar
  // este mock por el suyo propio sobre `ctx.googleTrends`.
  var googleTrends = require(path.join(adminDir, 'google-trends.js'));
  var originalFetchTrendingNow = googleTrends.fetchTrendingNow;
  googleTrends.fetchTrendingNow = function () {
    return Promise.reject(new Error('Google Trends no disponible (mock determinista de prueba, ver makeIsolatedCopy)'));
  };
  return {
    tmpRoot: tmpRoot, adminDir: adminDir, dataDir: dataDir, pipeline: pipeline, draft: draft, feeds: feeds,
    googleTrends: googleTrends, _originalFetchTrendingNow: originalFetchTrendingNow
  };
}
function cleanup(ctx) {
  // Restaura el mock de Google Trends antes de descartar la copia (pase lo
  // que pase en la sección) -- ver comentario en makeIsolatedCopy().
  if (ctx.googleTrends && ctx._originalFetchTrendingNow) {
    ctx.googleTrends.fetchTrendingNow = ctx._originalFetchTrendingNow;
  }
  fs.rmSync(ctx.tmpRoot, { recursive: true, force: true });
}

async function main() {
  // ==========================================================================
  // SECCIÓN 1 -- caché técnica: escritura atómica, JSON corrupto, tope de
  // tamaño.
  // ==========================================================================
  {
    var ctx = makeIsolatedCopy();
    var cachePath = path.join(ctx.dataDir, 'candidate-cache.json');
    var draftsPath = path.join(ctx.dataDir, 'drafts.json');

    // 1a. Escritura atómica: writeJSON nunca deja un .tmp-* a medio camino
    // después de terminar, y el archivo final siempre es JSON válido.
    ctx.pipeline.saveCandidateCache({ 'https://x.example/a': { reason: 'test', cachedAt: new Date().toISOString() } });
    var leftoverTmp = fs.readdirSync(ctx.dataDir).filter(function (f) { return /^candidate-cache\.json\.tmp-/.test(f); });
    check('1a. writeJSON no deja archivos .tmp-* colgados después de guardar', leftoverTmp.length === 0, JSON.stringify(leftoverTmp));
    var parsedOk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    check('1a. El archivo final es JSON válido después de guardar', !!parsedOk['https://x.example/a']);

    // 1b. JSON corrupto: buildCandidates() nunca se cae, trata la caché como
    // vacía (ningún ítem se saltea por "cachedSkip" con basura en el archivo).
    fs.writeFileSync(cachePath, '{ esto no es JSON valido @@@', 'utf8');
    ctx.feeds.fetchAllFeedItems = function () {
      return Promise.resolve({
        items: [{
          category: 'business', title: 'Corrupt Cache Test Reports New Findings',
          summary: 'Un ítem cualquiera para ver si la caché corrupta rompe algo.',
          link: 'https://corrupt-cache-test.example/2026/09/a', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
          image: '', author: '', domain: 'corrupt-cache-test.example', outlet: 'Corrupt Test'
        }], errors: []
      });
    };
    ctx.pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
    ctx.pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
    var builtAfterCorrupt = null, threwAfterCorrupt = null;
    try { builtAfterCorrupt = await ctx.pipeline.buildCandidates(baseCfg()); } catch (e) { threwAfterCorrupt = e; }
    check('1b. buildCandidates() no lanza con candidate-cache.json corrupto', !threwAfterCorrupt, threwAfterCorrupt && threwAfterCorrupt.message);
    check('1b. Con caché corrupta (tratada como vacía) el ítem se evalúa de cero, no se saltea por caché', builtAfterCorrupt && builtAfterCorrupt.filteredCounts.cachedSkip === 0, builtAfterCorrupt && JSON.stringify(builtAfterCorrupt.filteredCounts));
    var cacheAfterCorruptRun = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    check('1b. Después de esa corrida la caché vuelve a ser JSON válido en disco', typeof cacheAfterCorruptRun === 'object');

    // 1c. Tope de tamaño: sembrar más entradas que CANDIDATE_CACHE_MAX_ENTRIES
    // (todas vigentes, <24hs) y confirmar que saveCandidateCache() nunca deja
    // más del tope, descartando las MÁS VIEJAS primero.
    var MAX = ctx.pipeline.CANDIDATE_CACHE_MAX_ENTRIES;
    var seeded = {};
    var totalSeed = MAX + 50;
    for (var i = 0; i < totalSeed; i++) {
      // cachedAt escalonado: el índice 0 es el MÁS VIEJO (debería ser el
      // primero en desaparecer), el último es el más reciente.
      seeded['https://cache-cap-test.example/' + i] = { reason: 'test-seed', cachedAt: new Date(Date.now() - (totalSeed - i) * 1000).toISOString() };
    }
    fs.writeFileSync(cachePath, JSON.stringify(seeded) + '\n', 'utf8');
    ctx.pipeline.saveCandidateCache(ctx.pipeline.loadCandidateCache()); // fuerza el tope sin cambiar nada más
    var cappedCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    var cappedCount = Object.keys(cappedCache).length;
    check('1c. La caché nunca supera CANDIDATE_CACHE_MAX_ENTRIES (' + MAX + ') entradas', cappedCount === MAX, 'quedaron ' + cappedCount);
    check('1c. Se conservó la entrada MÁS RECIENTE de las sembradas', !!cappedCache['https://cache-cap-test.example/' + (totalSeed - 1)]);
    check('1c. Se descartó la entrada MÁS VIEJA de las sembradas', !cappedCache['https://cache-cap-test.example/0']);

    // 1d. Solo se guarda motivo + fecha -- nunca cuerpo, credenciales ni
    // respuesta completa (chequeo estructural sobre lo que ya quedó en disco
    // en los pasos anteriores).
    var sampleEntry = cappedCache['https://cache-cap-test.example/' + (totalSeed - 1)];
    var entryKeys = Object.keys(sampleEntry).sort();
    check('1d. Cada entrada de la caché tiene EXACTAMENTE {reason, cachedAt} -- nunca más campos', entryKeys.length === 2 && entryKeys[0] === 'cachedAt' && entryKeys[1] === 'reason', JSON.stringify(entryKeys));

    // 1e. Nunca se filtra a articulos.json/drafts.json/articulos.js:
    // confirmamos que escribir la caché no toca ninguno de esos archivos.
    var draftsBefore = fs.readFileSync(draftsPath, 'utf8');
    var articulosBefore = fs.readFileSync(path.join(ctx.dataDir, 'articulos.json'), 'utf8');
    ctx.pipeline.saveCandidateCache({ 'https://otra-url.example/x': { reason: 'test', cachedAt: new Date().toISOString() } });
    check('1e. Guardar la caché nunca toca drafts.json', fs.readFileSync(draftsPath, 'utf8') === draftsBefore);
    check('1e. Guardar la caché nunca toca data/articulos.json (de la copia aislada)', fs.readFileSync(path.join(ctx.dataDir, 'articulos.json'), 'utf8') === articulosBefore);
    var indexHtmlPath = path.join(ctx.tmpRoot, 'index.html');
    var indexMtimeBefore = fs.existsSync(indexHtmlPath) ? fs.statSync(indexHtmlPath).mtimeMs : null;
    ctx.pipeline.saveCandidateCache({ 'https://otra-url-2.example/y': { reason: 'test', cachedAt: new Date().toISOString() } });
    var indexMtimeAfter = fs.existsSync(indexHtmlPath) ? fs.statSync(indexHtmlPath).mtimeMs : null;
    check('1e. Guardar la caché nunca regenera el sitio (index.html de la copia queda con el mismo mtime)', indexMtimeBefore === indexMtimeAfter, JSON.stringify({ before: indexMtimeBefore, after: indexMtimeAfter }));

    cleanup(ctx);
  }

  // ==========================================================================
  // SECCIÓN 2 -- el timeout global de preselección cancela DE VERDAD el
  // trabajo: 0 llamadas de IA, incluso con candidatos ya aprobados antes del
  // corte.
  // ==========================================================================
  {
    var ctx2 = makeIsolatedCopy();
    var draftsPath2 = path.join(ctx2.dataDir, 'drafts.json');
    var cachePath2 = path.join(ctx2.dataDir, 'candidate-cache.json');
    fs.writeFileSync(cachePath2, '{}\n', 'utf8');
    fs.writeFileSync(draftsPath2, '[]\n', 'utf8');

    // Corrección de Leonardo (2026-09-28): esta sección pasaba por
    // fetchNewDrafts(), que SIEMPRE intenta Google Trends primero (ver
    // runFetchNewDraftsWithDeadline en pipeline.js) -- sin mockear, eso era
    // una llamada de red REAL al feed público de Google Trends, con una
    // latencia variable e impredecible del propio sandbox que competía con
    // el plazo compartido de 60ms de esta prueba. Según cuánto tardara esa
    // llamada real, a veces itemA llegaba a corroborarse a tiempo dentro del
    // presupuesto compartido y a veces no -- una carrera de tiempos ajena a
    // lo que esta sección quiere probar (que un candidato YA aprobado antes
    // del corte se descarta igual). Este mock ahora se aplica de forma
    // CENTRALIZADA dentro de makeIsolatedCopy() (ver ese comentario más
    // arriba) para TODAS las secciones de este archivo, no sólo esta --
    // ctx2.googleTrends.fetchTrendingNow ya rechaza de inmediato de forma
    // determinista y se restaura solo en cleanup(ctx2).

    // A propósito, FUNCIONES que devuelven un objeto NUEVO cada vez (nunca
    // el mismo objeto reusado entre la corrida de control 2a y la corrida
    // real 2b) -- buildCandidates() MUTA el ítem en el momento (le agrega
    // `.corroboration` directamente), así que reusar el mismo objeto entre
    // dos corridas haría que la segunda corrida "heredara" el resultado de
    // la primera sin buscar nada de nuevo, invalidando la prueba.
    function makeItemA() {
      return {
        category: 'business', title: 'Timeout Test Corp Launches New Logistics Platform',
        summary: 'Timeout Test Corp unveiled a new logistics platform Tuesday for enterprise clients.',
        link: 'https://timeout-test-a.example/2026/09/launch', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
        image: '', author: '', domain: 'timeout-test-a.example', outlet: 'Timeout Wire A'
      };
    }
    function makeItemB() {
      return {
        category: 'business', title: 'Second Timeout Corp Opens New Regional Office',
        summary: 'Second Timeout Corp opened a new regional office Tuesday in the Southeast.',
        link: 'https://timeout-test-b.example/2026/09/office', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
        image: '', author: '', domain: 'timeout-test-b.example', outlet: 'Timeout Wire B'
      };
    }
    var itemA = makeItemA();
    ctx2.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [makeItemA(), makeItemB()], errors: [] }); };
    ctx2.pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
    // La búsqueda de corroboración de itemA SÍ encuentra una fuente real,
    // pero tarda más que el plazo total de preselección -- para cuando
    // resuelve, el deadline (10ms) ya pasó. El chequeo de deadline ocurre
    // ENTRE candidatos (nunca interrumpe una búsqueda a medio camino, ver
    // comentario de buildCandidates), así que itemA queda corroborado de
    // verdad, pero itemB ni se llega a buscar -- exactamente el escenario
    // que hace falta para probar que un candidato YA aprobado antes del
    // corte igual se descarta en la fase 2.
    ctx2.pipeline.searchGoogleNewsForCorroboration = function (item) {
      return sleep(120).then(function () {
        return {
          source: {
            url: 'https://independent-outlet.example/2026/09/confirms', domain: 'independent-outlet.example',
            outlet: 'Independent Outlet', headline: item.title + ' (confirmado)', publishedAt: isoDaysAgo(0),
            matchScore: 90, matchReasons: ['vocabulario compartido', 'comparten una entidad principal']
          },
          failed: false, reason: null, diagnostic: null
        };
      });
    };
    ctx2.draft.loadConfig = function () { return baseCfg({ pipelineLimits: { preselectionTimeoutMs: 60, maxHeadlinesExamined: 30, maxCorroborationSearches: 10, maxAIDrafts: 3 } }); };
    var aiMockTimeout = makeInstrumentedDraftArticle();
    ctx2.draft.draftArticle = aiMockTimeout;

    var tStart = Date.now();
    var builtDirect = await ctx2.pipeline.buildCandidates(ctx2.draft.loadConfig());
    check('2a. (control) buildCandidates() por sí solo SÍ corrobora itemA antes de detectar el timeout', builtDirect.candidates.some(function (c) { return c.link === itemA.link && c.corroboration && c.corroboration.length; }), JSON.stringify(builtDirect.candidates.map(function (c) { return { link: c.link, corrob: (c.corroboration || []).length }; })));
    check('2a. (control) buildCandidates() SÍ marca timedOut:true (itemB nunca se llegó a buscar)', builtDirect.timedOut === true, JSON.stringify({ timedOut: builtDirect.timedOut, searches: builtDirect.corroborationSearchesPerformed }));

    // Reset para la corrida real vía fetchNewDrafts (que es la que expone el
    // servidor) -- misma config, mismos mocks.
    fs.writeFileSync(cachePath2, '{}\n', 'utf8');
    fs.writeFileSync(draftsPath2, '[]\n', 'utf8');
    var rTimeout = await ctx2.pipeline.fetchNewDrafts();
    check('2b. fetchNewDrafts() con timedOut:true -> 0 llamadas de IA (aunque itemA ya estaba aprobado)', rTimeout.aiCallsMade === 0 && rTimeout.added === 0, JSON.stringify(rTimeout));
    check('2b. (req 26) El mock instrumentado confirma 0 invocaciones reales, no inferidas', aiMockTimeout.getCallCount() === 0, aiMockTimeout.getCallCount());
    check('2b. timedOut:true queda visible en el resultado', rTimeout.timedOut === true);
    check('2b. El resultado trae un mensaje explícito sobre el timeout (distinto del de "0 candidatos")', typeof rTimeout.message === 'string' && /timeout|plazo/i.test(rTimeout.message), rTimeout.message);
    var draftsAfterTimeout = JSON.parse(fs.readFileSync(draftsPath2, 'utf8'));
    check('2b. Ningún borrador tardío se escribió en drafts.json', draftsAfterTimeout.length === 0);
    check('2b. candidatesWithTwoSources sigue informando lo que sí se llegó a corroborar (transparencia de costos, nunca se oculta)', rTimeout.candidatesWithTwoSources === 1, rTimeout.candidatesWithTwoSources);

    cleanup(ctx2);
  }

  // ==========================================================================
  // SECCIÓN 3 -- concurrencia: dos corridas superpuestas nunca corren en
  // paralelo.
  // ==========================================================================
  {
    var ctx3 = makeIsolatedCopy();
    var draftsPath3 = path.join(ctx3.dataDir, 'drafts.json');
    var cachePath3 = path.join(ctx3.dataDir, 'candidate-cache.json');
    fs.writeFileSync(cachePath3, '{}\n', 'utf8');
    fs.writeFileSync(draftsPath3, '[]\n', 'utf8');

    var pairA3 = [
      { category: 'business', title: 'Concurrency Test Corp Launches New Platform', summary: 'Concurrency Test Corp unveiled a new platform Tuesday for large clients.', link: 'https://conc-test-a.example/1', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'conc-test-a.example', outlet: 'Conc A' },
      { category: 'business', title: 'Concurrency Test Corp Unveils Platform For Large Clients', summary: 'The company launched a new platform this week, the firm said Tuesday.', link: 'https://conc-test-b.example/2', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'conc-test-b.example', outlet: 'Conc B' }
    ];
    ctx3.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: pairA3, errors: [] }); };
    ctx3.pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
    ctx3.pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
    ctx3.draft.loadConfig = function () { return baseCfg(); };
    // La redacción tarda 60ms -- tiempo de sobra para que la segunda llamada
    // a fetchNewDrafts() se dispare mientras la primera todavía está
    // "redactando", y así probar el candado de verdad (si no existiera, las
    // dos correrían pisándose los archivos).
    var aiMockConc = makeInstrumentedDraftArticle(null, 60);
    ctx3.draft.draftArticle = aiMockConc;

    var p1 = ctx3.pipeline.fetchNewDrafts();
    // Se dispara la segunda apenas arranca la primera (sin esperarla) --
    // simula dos pestañas o varios clics que sí llegaron al servidor.
    await sleep(5);
    var p2 = ctx3.pipeline.fetchNewDrafts();
    var results3 = await Promise.all([p1, p2]);
    var alreadyRunningCount = results3.filter(function (r) { return r.alreadyRunning; }).length;
    var realRunCount = results3.filter(function (r) { return !r.alreadyRunning; }).length;
    check('3a. De dos corridas superpuestas, exactamente UNA se ejecuta de verdad', realRunCount === 1, JSON.stringify(results3.map(function (r) { return { alreadyRunning: !!r.alreadyRunning, added: r.added }; })));
    check('3a. La otra devuelve alreadyRunning:true de inmediato, sin tocar nada', alreadyRunningCount === 1);
    check('3b. El total de llamadas de IA reales (mock instrumentado) es el de UNA sola corrida, nunca el doble', aiMockConc.getCallCount() === 1, aiMockConc.getCallCount());
    var draftsAfterConc = JSON.parse(fs.readFileSync(draftsPath3, 'utf8'));
    check('3b. drafts.json quedó con exactamente 1 borrador (no se duplicó ni se perdió)', draftsAfterConc.length === 1, draftsAfterConc.length);
    var cacheAfterConc = JSON.parse(fs.readFileSync(cachePath3, 'utf8'));
    check('3c. candidate-cache.json sigue siendo JSON válido después de la carrera', typeof cacheAfterConc === 'object');

    // Una vez terminada la primera corrida, el candado se liberó -- una
    // tercera corrida ahora sí se ejecuta normalmente (nunca queda "trabado"
    // para siempre por un error de contabilidad).
    fs.writeFileSync(cachePath3, '{}\n', 'utf8');
    fs.writeFileSync(draftsPath3, '[]\n', 'utf8');
    ctx3.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [], errors: [] }); };
    var r3c = await ctx3.pipeline.fetchNewDrafts();
    check('3d. Después de liberado, el candado permite una corrida normal (nunca queda trabado)', !r3c.alreadyRunning, JSON.stringify(r3c));

    cleanup(ctx3);
  }

  // ==========================================================================
  // SECCIÓN 4 -- borradores viejos de una sola fuente (de ANTES de este
  // pedido, sin los campos nuevos) siguen "revisar", nunca "listo", nunca se
  // tocan ni se borran solos.
  // ==========================================================================
  {
    var ctx4 = makeIsolatedCopy();
    var draftsPath4 = path.join(ctx4.dataDir, 'drafts.json');
    var cachePath4 = path.join(ctx4.dataDir, 'candidate-cache.json');
    // Forma EXACTA de un borrador creado por el código viejo (antes de este
    // pedido): sin sameDomainMatchWarning, sin singleSourceWarning
    // explícito, additionalSources vacío, sin similarityWarning/
    // genericHeadingWarning -- ninguno de los campos que este segmento
    // agregó o renombró.
    var legacyDraft = {
      title: 'Legacy Single-Source Draft From Before This Request', category: 'business', categoryLabel: 'Negocios', icon: '',
      date: '2026-08-01', readTime: '3 min', slug: 'legacy-single-source-draft-test',
      dek: 'Un borrador viejo, de antes de este pedido, con una sola fuente.',
      image: '', imageSource: '', imageLicense: '', videoUrl: '', trending: false,
      body: 'Cuerpo de un borrador viejo cualquiera, sin ninguno de los campos nuevos de este segmento.',
      sourceUrl: 'https://legacy-outlet.example/2026/08/legacy-story',
      sourceTitle: 'Legacy Outlet', sourceHeadline: 'Legacy Story Original Headline', sourceDomain: 'legacy-outlet.example',
      additionalSources: [],
      keyClaims: [], sourceCount: 1, createdAt: '2026-08-01T00:00:00.000Z'
      // A propósito: sin sameDomainMatchWarning, sin singleSourceWarning,
      // sin similarityWarning, sin genericHeadingWarning.
    };
    fs.writeFileSync(draftsPath4, JSON.stringify([legacyDraft], null, 2) + '\n', 'utf8');
    fs.writeFileSync(cachePath4, '{}\n', 'utf8');

    // 4a. classifyDraft() (lo que usa GET /api/drafts) no se cae con los
    // campos faltantes, y nunca lo clasifica "listo".
    var tierLegacy = null, threwLegacy = null;
    try { tierLegacy = ctx4.pipeline.classifyDraft(legacyDraft, []); } catch (e) { threwLegacy = e; }
    check('4a. classifyDraft() no se cae con un borrador viejo sin los campos nuevos', !threwLegacy, threwLegacy && threwLegacy.message);
    check('4a. Un borrador viejo de una sola fuente NUNCA clasifica "listo"', tierLegacy && tierLegacy.readinessTier !== 'listo', tierLegacy && tierLegacy.readinessTier);
    check('4a. Su recomendación es "revisar" (no bloqueante, pero tampoco listo para usar directo)', tierLegacy && tierLegacy.recommendation === 'revisar', tierLegacy && tierLegacy.recommendation);
    check('4a. sameDomainMatchWarning ausente se lee como false, nunca rompe ni se muestra como true', tierLegacy && tierLegacy.sameDomainMatchWarning === false);
    check('4a. eligibleToUse sigue en true (una sola fuente nunca bloquea el uso manual, solo el filtro "Solo listos")', tierLegacy && tierLegacy.eligibleToUse === true);

    // 4b. Una corrida NUEVA de fetchNewDrafts() (con titulares totalmente
    // ajenos a este borrador) nunca lo toca, nunca lo borra, nunca gasta IA
    // sobre él.
    var newItem4 = {
      category: 'technology', title: 'Totally Unrelated Fresh Headline About Something Else',
      summary: 'Una historia completamente distinta, sin relación con el borrador viejo de arriba.',
      link: 'https://unrelated-fresh.example/2026/09/story', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: 'unrelated-fresh.example', outlet: 'Unrelated Wire'
    };
    ctx4.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [newItem4], errors: [] }); };
    ctx4.pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
    ctx4.pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
    ctx4.draft.loadConfig = function () { return baseCfg(); };
    var aiMock4 = makeInstrumentedDraftArticle();
    ctx4.draft.draftArticle = aiMock4;
    var r4 = await ctx4.pipeline.fetchNewDrafts();
    check('4b. La corrida nueva no gasta ninguna llamada de IA sobre el borrador viejo (single-source, no corrobora)', aiMock4.getCallCount() === 0, aiMock4.getCallCount());
    var draftsAfter4 = JSON.parse(fs.readFileSync(draftsPath4, 'utf8'));
    check('4b. El borrador viejo SIGUE presente en drafts.json, exactamente igual (nunca se borra solo)', draftsAfter4.length === 1 && draftsAfter4[0].slug === 'legacy-single-source-draft-test', JSON.stringify(draftsAfter4.map(function (d) { return d.slug; })));
    check('4b. El borrador viejo no fue modificado por la corrida nueva', JSON.stringify(draftsAfter4[0]) === JSON.stringify(legacyDraft));

    cleanup(ctx4);
  }

  // ==========================================================================
  // SECCIÓN 5 -- duplicado/prioridad contra una copia de SOLO LECTURA del
  // data/articulos.json REAL (142 artículos) de la computadora de Leonardo.
  // Nunca se escribe ese archivo; nunca reemplaza el sandbox.
  // ==========================================================================
  if (fs.existsSync(REAL_DEVICE_SNAPSHOT)) {
    var ctx5 = makeIsolatedCopy();
    var realSnapshotRaw = fs.readFileSync(REAL_DEVICE_SNAPSHOT, 'utf8'); // SOLO LECTURA
    var realSnapshot = JSON.parse(realSnapshotRaw);
    check('5. La copia de solo lectura del dispositivo real tiene 142 artículos', realSnapshot.length === 142, realSnapshot.length);
    var nscaleEntries = realSnapshot.filter(function (a) { return /nscale/i.test(a.title || ''); });
    check('5. Nscale sigue intacto en la copia real (2 artículos)', nscaleEntries.length === 2, nscaleEntries.length);

    // Se copia (nunca se symlinkea) DENTRO de la copia aislada -- el sandbox
    // real y su data/articulos.json de 141 nunca se tocan.
    fs.writeFileSync(path.join(ctx5.dataDir, 'articulos.json'), realSnapshotRaw, 'utf8');
    fs.writeFileSync(path.join(ctx5.dataDir, 'candidate-cache.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(ctx5.dataDir, 'drafts.json'), '[]\n', 'utf8');

    var realTitle = 'TSMC Expands Its Investment in US Chip Plants'; // artículo real #2 de la copia
    var duplicateItem = {
      category: 'ai', title: realTitle,
      summary: 'Un feed distinto reportando exactamente la misma noticia ya publicada.',
      link: 'https://otro-feed-cualquiera.example/2026/09/tsmc-duplicado', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: 'otro-feed-cualquiera.example', outlet: 'Otro Feed'
    };
    var freshItem = {
      category: 'ai', title: 'Genuinely New Headline Never Published Before On This Site',
      summary: 'Una historia realmente nueva, sin relación con nada ya publicado en los 142 artículos reales.',
      link: 'https://genuinely-new-headline.example/2026/09/story', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: 'genuinely-new-headline.example', outlet: 'Fresh Wire'
    };
    ctx5.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [duplicateItem, freshItem], errors: [] }); };
    ctx5.pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
    ctx5.pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
    var built5 = await ctx5.pipeline.buildCandidates(baseCfg());
    check('5. Un titular idéntico a uno de los 142 artículos reales se descarta como duplicado', built5.filteredCounts.duplicate >= 1, JSON.stringify(built5.filteredCounts));
    check('5. El titular genuinamente nuevo SÍ queda como candidato (no lo descarta por error)', built5.candidates.concat(built5.singleSourceCandidates || []).some(function (c) { return c.link === freshItem.link; }) || built5.candidates.some(function (c) { return c.link === freshItem.link; }), JSON.stringify({ candidates: built5.candidates.map(function (c) { return c.link; }) }));

    // Nunca se escribió el snapshot real de vuelta a ningún lado, y el
    // sandbox real (141) sigue exactamente igual.
    check('5. El archivo de solo lectura del dispositivo real no fue modificado por la prueba', fs.readFileSync(REAL_DEVICE_SNAPSHOT, 'utf8') === realSnapshotRaw);
    cleanup(ctx5);
  } else {
    console.log('SKIP  Sección 5 -- no hay copia de solo lectura del dispositivo real en ' + REAL_DEVICE_SNAPSHOT + ' (no bloqueante para el resto de la batería).');
  }

  // ==========================================================================
  // SECCIÓN 6 -- el timeout de preselección debe ser GLOBAL de verdad
  // (pedido de Leonardo, 2026-09-24, punto 1 de su verificación final): la
  // FASE 1 completa (RSS, verificación de enlaces, corroboración) comparte
  // UN SOLO deadline con cancelación real (AbortSignal), no solo un chequeo
  // entre pasos. Se prueba con un servidor real que ACEPTA la conexión y
  // nunca contesta nada -- "una verificación de URL que no responde",
  // pedido explícito -- y se espera DESPUÉS de que buildCandidates() ya
  // retornó para confirmar que no queda ninguna actividad tardía (la
  // conexión al servidor de prueba queda cerrada, no sigue un rato más en
  // segundo plano hasta agotar su propio timeout interno de 10s).
  // ==========================================================================
  {
    var ctx6 = makeIsolatedCopy();
    var draftsPath6 = path.join(ctx6.dataDir, 'drafts.json');
    var cachePath6 = path.join(ctx6.dataDir, 'candidate-cache.json');
    fs.writeFileSync(cachePath6, '{}\n', 'utf8');
    fs.writeFileSync(draftsPath6, '[]\n', 'utf8');

    // 6a. Servidor real que acepta la conexión pero JAMÁS contesta nada
    // (ni siquiera cierra la conexión por su cuenta) -- instrumentado para
    // saber cuántas conexiones recibió y si el socket quedó cerrado del
    // lado del cliente (prueba de que se abortó de verdad, no que
    // simplemente se dejó de esperar).
    var connectionsReceived = 0;
    var socketClosedByClient = false;
    var hangingServer6 = http.createServer(function () { /* nunca responde */ });
    hangingServer6.on('connection', function (socket) {
      connectionsReceived++;
      socket.on('close', function () { socketClosedByClient = true; });
    });
    await new Promise(function (resolve) { hangingServer6.listen(0, '127.0.0.1', resolve); });
    var hangingPort6 = hangingServer6.address().port;

    var neverRespondingItem = {
      category: 'business', title: 'Global Deadline Test Corp Announces New Initiative',
      summary: 'Global Deadline Test Corp unveiled a new initiative Tuesday, a spokesperson said.',
      link: 'http://127.0.0.1:' + hangingPort6 + '/never-responds', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: '127.0.0.1', outlet: 'Global Deadline Wire'
    };
    ctx6.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [neverRespondingItem], errors: [] }); };
    // A propósito: NO se reemplaza checkUrlReachable -- corre la
    // implementación REAL de red (ctx6.pipeline es un módulo recién
    // cargado por makeIsolatedCopy(), sin ningún mock aplicado todavía),
    // contra el servidor real de arriba, para probar la cancelación real
    // de punta a punta (no un mock).
    //
    // Igual que test-source-provenance.js (PARTE 2): checkUrlReachable()
    // bloquea 127.0.0.1 de verdad por SSRF (ver test-check-url-security.js
    // para esa protección en sí, sin este bypass), y este sandbox no tiene
    // salida a red pública real -- así que, SOLO en esta sección, se trata
    // 127.0.0.1 como si fuera pública para poder usar un servidor real.
    var originalIsPrivateOrReservedIP6 = ctx6.pipeline.isPrivateOrReservedIP;
    ctx6.pipeline.isPrivateOrReservedIP = function (ip) {
      if (ip === '127.0.0.1') return false;
      return originalIsPrivateOrReservedIP6(ip);
    };
    ctx6.pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };

    // Deadline de preselección deliberadamente MUY corto (200ms) -- muy por
    // debajo de CHECK_URL_HARD_DEADLINE_MS (10000ms) y de
    // CHECK_URL_SOCKET_IDLE_TIMEOUT_MS (8000ms), los topes internos de
    // checkUrlReachable/attemptFetch que existían ANTES de este pedido. Si
    // el deadline global de verdad manda, la corrida completa debe volver
    // en un tiempo cercano a 200ms, nunca cerca de 8-10s.
    //
    // Se prueba a través de fetchNewDrafts() (no buildCandidates() suelto,
    // como en la Sección 2) a propósito: lo que de verdad importa acá,
    // igual que en el pedido de Leonardo, es la garantía de punta a punta
    // ("no comienza ninguna llamada de IA; no se escribe ningún borrador
    // tardío") -- eso es exactamente lo que fetchNewDrafts()/
    // runFetchNewDrafts() garantiza cuando built.timedOut es true (ver
    // pipeline.js), sin depender de si ESTE candidato puntual, cuya
    // verificación de enlace no llegó a resolver del todo, termina
    // clasificado como candidato de una sola fuente o directamente
    // descartado -- ninguno de los dos casos llega jamás a redactarse.
    ctx6.draft.loadConfig = function () { return baseCfg({ pipelineLimits: { preselectionTimeoutMs: 200, maxHeadlinesExamined: 30, maxCorroborationSearches: 10, maxAIDrafts: 3 } }); };
    var aiMock6 = makeInstrumentedDraftArticle();
    ctx6.draft.draftArticle = aiMock6;

    var tStart6 = Date.now();
    var r6 = await ctx6.pipeline.fetchNewDrafts();
    var elapsedMs6 = Date.now() - tStart6;

    check('6a. La corrida completa vuelve cerca del deadline global (200ms), NO de los 8-10s internos viejos de checkUrlReachable', elapsedMs6 < 3000, elapsedMs6 + 'ms');
    check('6a. La corrida se marca timedOut:true', r6.timedOut === true, JSON.stringify(r6));
    check('6a. 0 llamadas de IA (el candidato nunca llegó a corroborarse dentro del plazo)', r6.aiCallsMade === 0 && aiMock6.getCallCount() === 0, JSON.stringify({ reportado: r6.aiCallsMade, real: aiMock6.getCallCount() }));
    check('6a. El servidor de prueba recibió EXACTAMENTE una conexión (sin reintentos silenciosos)', connectionsReceived === 1, connectionsReceived);

    // 6b. LA PARTE CLAVE del pedido de Leonardo: esperar DESPUÉS de que la
    // corrida ya retornó, y confirmar que no ocurre NINGUNA actividad
    // tardía -- ni la conexión de red sigue abierta en segundo plano, ni
    // se escribe nada más tarde en drafts.json/candidate-cache.json.
    var draftsSnapshotAfterReturn = fs.readFileSync(draftsPath6, 'utf8');
    var cacheSnapshotAfterReturn = fs.readFileSync(cachePath6, 'utf8');
    await sleep(1500); // bastante más que el margen interno de attemptFetch/searchDeadline, bastante menos que los 8-10s viejos
    check('6b. La conexión al servidor de prueba quedó cerrada DE VERDAD (abortada), no sigue viva en segundo plano', socketClosedByClient === true);
    check('6b. El servidor de prueba no recibió NINGUNA conexión adicional durante la espera posterior al retorno', connectionsReceived === 1, connectionsReceived);
    check('6b. 0 llamadas de IA TAMBIÉN después de la espera posterior (ninguna redacción tardía en segundo plano)', aiMock6.getCallCount() === 0, aiMock6.getCallCount());
    check('6b. drafts.json no cambió ni un byte durante la espera posterior al retorno (ningún borrador tardío)', fs.readFileSync(draftsPath6, 'utf8') === draftsSnapshotAfterReturn);
    check('6b. candidate-cache.json no cambió ni un byte durante la espera posterior al retorno', fs.readFileSync(cachePath6, 'utf8') === cacheSnapshotAfterReturn);

    ctx6.pipeline.isPrivateOrReservedIP = originalIsPrivateOrReservedIP6; // fin del bypass de prueba
    await new Promise(function (resolve) { hangingServer6.close(resolve); });
    cleanup(ctx6);
  }

  // ==========================================================================
  // SECCIÓN 6C -- red de seguridad de último recurso: si ALGUNA capa no
  // respeta la señal de cancelación real (ej. un reemplazo de prueba/mock
  // que devuelve una promesa que nunca se resuelve ni se rechaza, sin
  // ningún socket real de por medio), buildCandidates() de todas formas
  // vuelve dentro del plazo -- nunca queda colgada para siempre. En
  // operación normal (Sección 6 arriba) esto nunca es lo que "corta" la
  // espera -- ahí corta la cancelación real del socket.
  // ==========================================================================
  {
    var ctx6c = makeIsolatedCopy();
    fs.writeFileSync(path.join(ctx6c.dataDir, 'candidate-cache.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(ctx6c.dataDir, 'drafts.json'), '[]\n', 'utf8');
    var neverRespondingMockItem = {
      category: 'business', title: 'Mocked Never Responding Reachability Check Corp Reports Update',
      summary: 'A mocked reachability check that never settles at all, with no real socket involved.',
      link: 'https://mocked-never-responds.example/2026/09/story', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: 'mocked-never-responds.example', outlet: 'Mocked Wire'
    };
    ctx6c.feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [neverRespondingMockItem], errors: [] }); };
    // Reemplazo deliberadamente "roto": ignora cualquier deadline que se le
    // pase y nunca resuelve ni rechaza -- el caso patológico que
    // raceAgainstDeadline() tiene que cubrir como red de seguridad.
    ctx6c.pipeline.checkUrlReachable = function () { return new Promise(function () { /* nunca resuelve ni rechaza */ }); };
    var cfg6c = baseCfg({ pipelineLimits: { preselectionTimeoutMs: 150, maxHeadlinesExamined: 30, maxCorroborationSearches: 10, maxAIDrafts: 3 } });
    var tStart6c = Date.now();
    var built6c = await ctx6c.pipeline.buildCandidates(cfg6c);
    var elapsedMs6c = Date.now() - tStart6c;
    check('6c. Con un mock de checkUrlReachable que nunca resuelve, buildCandidates() IGUAL vuelve dentro de un plazo acotado (<3s)', elapsedMs6c < 3000, elapsedMs6c + 'ms');
    check('6c. Esa corrida también se marca timedOut:true', built6c.timedOut === true, JSON.stringify({ timedOut: built6c.timedOut }));
    cleanup(ctx6c);
  }

  // ==========================================================================
  // SECCIÓN 7 -- escritura atómica compatible con Windows (pedido de
  // Leonardo, 2026-09-24, punto 2 de su verificación final): writeJSON()
  // ahora afecta también drafts.json y discarded-sources.json (antes solo
  // candidate-cache.json), así que se prueba el mecanismo en sí, sobre una
  // carpeta temporal propia y aislada -- NUNCA sobre ningún archivo real de
  // data/. fs.renameSync() es la misma llamada de Node en Linux y en
  // Windows (por dentro usa MoveFileEx con MOVEFILE_REPLACE_EXISTING ahí),
  // así que probar su contrato acá (reemplaza un archivo existente, un
  // fallo de rename no destruye el destino ni deja temporales colgados,
  // dos escrituras seguidas dejan JSON válido) cubre el comportamiento real
  // en los dos sistemas operativos -- lo único que de verdad difiere entre
  // plataformas es la frecuencia de fallos de rename por archivos
  // bloqueados (mucho más común en Windows), no la semántica en sí.
  // ==========================================================================
  {
    var ctxW = makeIsolatedCopy();
    var tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-writejson-'));
    var targetFile = path.join(tmpTestDir, 'algun-archivo.json');

    function listTmpLeftovers() {
      return fs.readdirSync(tmpTestDir).filter(function (f) { return /\.tmp-/.test(f); });
    }

    // 7a. Primera escritura: crea el archivo, JSON válido, sin temporales
    // colgados.
    ctxW.pipeline.writeJSON(targetFile, { version: 1, nota: 'primera escritura' });
    check('7a. writeJSON() crea el archivo con JSON válido', JSON.parse(fs.readFileSync(targetFile, 'utf8')).version === 1);
    check('7a. Sin temporales colgados después de la primera escritura', listTmpLeftovers().length === 0, JSON.stringify(listTmpLeftovers()));

    // 7b. Segunda escritura: REEMPLAZA el archivo ya existente (esto es
    // justo lo que en Windows requiere MOVEFILE_REPLACE_EXISTING -- un
    // rename "a secas" sobre un destino que ya existe falla ahí si Node no
    // pasara ese flag, cosa que sí hace).
    ctxW.pipeline.writeJSON(targetFile, { version: 2, nota: 'segunda escritura, reemplaza a la primera' });
    var afterSecond = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    check('7b. writeJSON() reemplaza un archivo YA EXISTENTE (no falla, no lo deja duplicado)', afterSecond.version === 2 && afterSecond.nota === 'segunda escritura, reemplaza a la primera', JSON.stringify(afterSecond));
    check('7b. Dos escrituras seguidas: el archivo final sigue siendo JSON válido', typeof afterSecond === 'object');
    check('7b. Sin temporales colgados después de dos escrituras seguidas', listTmpLeftovers().length === 0, JSON.stringify(listTmpLeftovers()));

    // 7c. Un fallo de rename NO destruye el archivo anterior, y el
    // temporal se limpia solo (nunca queda huérfano) -- se fuerza el fallo
    // reemplazando fs.renameSync() por una versión que revienta, UNA sola
    // vez, y restaurando la real enseguida después.
    var contentBeforeFailedWrite = fs.readFileSync(targetFile, 'utf8');
    var originalRenameSync = fs.renameSync;
    fs.renameSync = function () {
      throw Object.assign(new Error('EPERM: simulado -- archivo de destino bloqueado (caso típico de Windows)'), { code: 'EPERM' });
    };
    var threwOnFailedWrite = null;
    try {
      ctxW.pipeline.writeJSON(targetFile, { version: 3, nota: 'esta escritura nunca debería llegar a verse' });
    } catch (e) {
      threwOnFailedWrite = e;
    } finally {
      fs.renameSync = originalRenameSync; // restaurar SIEMPRE, pase lo que pase
    }
    check('7c. writeJSON() relanza el error real cuando el rename falla (nunca lo traga en silencio)', !!threwOnFailedWrite && threwOnFailedWrite.code === 'EPERM', threwOnFailedWrite && threwOnFailedWrite.message);
    check('7c. El archivo de destino queda EXACTAMENTE igual que antes del fallo (nunca se destruye ni se corrompe)', fs.readFileSync(targetFile, 'utf8') === contentBeforeFailedWrite);
    check('7c. El archivo temporal se limpia solo cuando el rename falla (nunca queda huérfano)', listTmpLeftovers().length === 0, JSON.stringify(listTmpLeftovers()));

    // 7d. Después de un fallo, una escritura normal siguiente funciona sin
    // problemas (el fallo anterior no deja el mecanismo en un estado raro).
    ctxW.pipeline.writeJSON(targetFile, { version: 4, nota: 'escritura normal después del fallo simulado' });
    var afterRecovery = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    check('7d. Después de un fallo simulado, la siguiente escritura normal funciona bien', afterRecovery.version === 4, JSON.stringify(afterRecovery));
    check('7d. Sin temporales colgados después de la recuperación', listTmpLeftovers().length === 0, JSON.stringify(listTmpLeftovers()));

    fs.rmSync(tmpTestDir, { recursive: true, force: true });
    cleanup(ctxW);
  }

  // ==========================================================================
  // Regresión final: el sandbox real nunca se tocó en ninguna sección.
  // ==========================================================================
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('Final. data/articulos.json del sitio REAL (sandbox) no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('Final. El sandbox sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos, sin cambios (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR FATAL:', e);
  process.exit(1);
});
