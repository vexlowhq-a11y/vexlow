#!/usr/bin/env node
/*
  admin/test-global-deadline.js
  ==============================
  Pedido de Leonardo (2026-09-27, "timeout verdaderamente global"): el
  informe anterior decía que Google Trends y el respaldo RSS reciben CADA
  UNO su plazo completo de preselectionTimeoutMs (45s) -- eso podía
  duplicar el límite real declarado. La corrección (ver admin/pipeline.js:
  runFetchNewDrafts()/runFetchNewDraftsWithDeadline()/buildCandidates()/
  buildCandidatesFromTrends()) crea UN SOLO deadline compartido para toda
  la corrida y se lo pasa explícitamente a ambas fases -- si Trends
  consume parte del plazo, el respaldo RSS arranca con lo que queda, nunca
  con un plazo nuevo.

  Estas pruebas usan un "reloj controlado": un deadline de prueba
  (makeFakeDeadline) con la misma interfaz que feeds.makeDeadline()
  (signal/remaining()/expired()/clear()) pero cuyo paso del tiempo se
  simula a mano con .advance(ms) desde los propios mocks -- determinístico
  y sin esperas reales de red ni de reloj.

  Se prueba, tal como pide el punto 2 de la ronda de correcciones:
    A. Trends consume parte del plazo -> el respaldo RSS solo recibe el
       resto (nunca un plazo nuevo de preselectionTimeoutMs completo).
    B. Trends agota el plazo por completo -> el respaldo RSS NI SIQUIERA
       ARRANCA.
    C. Ninguna tarea sigue procesando candidatos después de que el
       deadline compartido vence a mitad de camino.
    D. 0 llamadas de IA si el plazo vence antes de llegar a corroborar.
    E. drafts.json no recibe ninguna escritura tardía cuando la corrida
       entera vence por timeout.
    F. Un deadline EXTERNO (compartido) nunca se cierra (.clear()) dentro
       de buildCandidates()/buildCandidatesFromTrends() -- solo lo cierra
       quien lo creó (runFetchNewDrafts(), en producción).

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real,
  ver la comprobación final). El "cliente de IA" (draft.draftArticle), el
  feed de Google Trends, los feeds RSS y la verificación de reachability
  se reemplazan por mocks -- este entorno de pruebas no tiene salida a
  internet pública.

  Uso: node admin/test-global-deadline.js
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function isoHoursAgo(hours) { return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(); }

const REAL_ROOT = path.join(__dirname, '..');
const REAL_ARTICULOS = path.join(REAL_ROOT, 'data', 'articulos.json');
const hashRealArticulosBefore = sha256File(REAL_ARTICULOS);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-global-deadline-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');
const draftsPath = path.join(dataDir, 'drafts.json');
const cachePath = path.join(dataDir, 'candidate-cache.json');

const pipeline = require(path.join(adminDir, 'pipeline.js'));
const draft = require(path.join(adminDir, 'draft.js'));
const feeds = require(path.join(adminDir, 'feeds.js'));
const googleTrends = require(path.join(adminDir, 'google-trends.js'));

const originalFetchTrendingNow = googleTrends.fetchTrendingNow;
const originalFetchAllFeedItems = feeds.fetchAllFeedItems;
const originalCheckUrlReachable = pipeline.checkUrlReachable;
const originalSearchGoogleNews = pipeline.searchGoogleNewsForCorroboration;
const originalDraftArticle = draft.draftArticle;
const originalLoadConfig = draft.loadConfig;

function restoreAll() {
  googleTrends.fetchTrendingNow = originalFetchTrendingNow;
  feeds.fetchAllFeedItems = originalFetchAllFeedItems;
  pipeline.checkUrlReachable = originalCheckUrlReachable;
  pipeline.searchGoogleNewsForCorroboration = originalSearchGoogleNews;
  draft.draftArticle = originalDraftArticle;
  draft.loadConfig = originalLoadConfig;
}
function resetDrafts() { fs.writeFileSync(draftsPath, '[]\n', 'utf8'); }
function resetCache() { fs.writeFileSync(cachePath, '{}\n', 'utf8'); }

function baseCfg(extra) {
  return Object.assign({ draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba', pipelineLimits: {} }, extra || {});
}

// ----------------------------------------------------------------------
// Reloj controlado: misma interfaz que feeds.makeDeadline() (signal/
// remaining()/expired()/clear()), pero el paso del tiempo se simula a
// mano con .advance(ms) desde los propios mocks de red -- determinístico,
// sin esperar milisegundos reales ni pisar el Date global.
// ----------------------------------------------------------------------
function makeFakeDeadline(totalMs) {
  var elapsed = 0;
  var controller = new AbortController();
  var cleared = false;
  return {
    signal: controller.signal,
    remaining: function () { return Math.max(0, totalMs - elapsed); },
    expired: function () { return controller.signal.aborted || elapsed >= totalMs; },
    clear: function () { cleared = true; },
    advance: function (ms) {
      elapsed += ms;
      if (elapsed >= totalMs) { try { controller.abort(); } catch (e) {} }
    },
    wasCleared: function () { return cleared; }
  };
}

function newsItem(title, snippet, domain, path_) {
  return { title: title, snippet: snippet, url: 'https://' + domain + '/2026/09/' + (path_ || 'story'), domain: domain, outlet: domain, picture: '' };
}
function mockTrend(query, newsItems, opts) {
  opts = opts || {};
  return {
    query: query,
    approxTrafficRaw: opts.approxTrafficRaw || '5000+',
    approxTraffic: opts.approxTraffic !== undefined ? opts.approxTraffic : 5000,
    pubDateISO: opts.pubDateISO || isoHoursAgo(2),
    newsItems: newsItems || []
  };
}
function aiCorrobPair(tag) {
  return [
    newsItem('OpenAI Launches New ChatGPT Feature For Developers ' + tag, 'OpenAI unveiled a new ChatGPT feature aimed at developers on Tuesday.', 'techoutlet-a' + tag + '.example', 'launch'),
    newsItem('OpenAI Rolls Out ChatGPT Feature For Developers ' + tag, 'A new ChatGPT feature aimed at developers began rolling out Tuesday, OpenAI said.', 'techoutlet-b' + tag + '.example', 'launch-details')
  ];
}

async function main() {
  draft.loadConfig = baseCfg;

  // =========================================================================
  // A. Trends consume parte del plazo -> el respaldo RSS solo recibe el
  //    resto, nunca un plazo nuevo de preselectionTimeoutMs completo.
  // =========================================================================
  resetDrafts(); resetCache();
  {
    var fakeA = makeFakeDeadline(45000);
    googleTrends.fetchTrendingNow = function (deadline) {
      deadline.advance(40000); // Trends "tarda" 40 de los 45s antes de fallar
      var e = new Error('network down');
      e.trendsErrorCode = 'network';
      return Promise.reject(e);
    };
    var capturedRemainingA = null;
    var rssStartedA = false;
    feeds.fetchAllFeedItems = function (deadline) {
      rssStartedA = true;
      capturedRemainingA = deadline.remaining();
      return Promise.resolve({ items: [], errors: [] });
    };
    var rA = await pipeline.runFetchNewDraftsWithDeadline(baseCfg(), fakeA, Date.now());
    check('A1. El respaldo RSS SÍ arranca (a Trends le quedaba presupuesto)', rssStartedA === true);
    check('A2. El respaldo RSS recibe SOLO el resto del plazo (~5s), no 45000ms nuevos',
      capturedRemainingA !== null && capturedRemainingA > 0 && capturedRemainingA <= 5500,
      'remaining capturado en feeds.fetchAllFeedItems = ' + capturedRemainingA + 'ms (esperado: >0 y <=5500)');
    check('A3. trendsMode queda en rss-fallback con el motivo real (network)',
      rA.trendsMode === 'rss-fallback' && rA.fallbackReason === 'network',
      JSON.stringify({ trendsMode: rA.trendsMode, fallbackReason: rA.fallbackReason }));
  }

  // =========================================================================
  // B. Trends agota el plazo por completo -> el respaldo RSS NI SIQUIERA
  //    ARRANCA (requisito explícito de Leonardo).
  // =========================================================================
  resetDrafts(); resetCache();
  {
    var fakeB = makeFakeDeadline(45000);
    googleTrends.fetchTrendingNow = function (deadline) {
      deadline.advance(45000); // Trends consume el plazo entero
      var e = new Error('timed out');
      e.trendsErrorCode = 'timeout';
      return Promise.reject(e);
    };
    var rssStartedB = false;
    feeds.fetchAllFeedItems = function () { rssStartedB = true; return Promise.resolve({ items: [], errors: [] }); };
    var aiCallsB = 0;
    draft.draftArticle = function () { aiCallsB++; return Promise.resolve({}); };
    var rB = await pipeline.runFetchNewDraftsWithDeadline(baseCfg(), fakeB, Date.now());
    check('B1. El respaldo RSS NUNCA arranca (el deadline ya estaba agotado)', rssStartedB === false);
    check('B2. La corrida se reporta como timedOut', rB.timedOut === true, JSON.stringify(rB));
    check('B3. 0 llamadas de IA', aiCallsB === 0 && rB.aiCallsMade === 0);
    check('B4. 0 borradores agregados', rB.added === 0);
  }

  // =========================================================================
  // C. Ninguna tarea sigue procesando candidatos después de que el
  //    deadline compartido vence a mitad de camino (no solo al principio).
  // =========================================================================
  resetDrafts(); resetCache();
  {
    var fakeC = makeFakeDeadline(45000);
    var trendsC = [
      mockTrend('openai chatgpt feature uno', aiCorrobPair('c1')),
      mockTrend('openai chatgpt feature dos', aiCorrobPair('c2')),
      mockTrend('openai chatgpt feature tres', aiCorrobPair('c3'))
    ];
    googleTrends.fetchTrendingNow = function () { return Promise.resolve(trendsC); };
    var reachableCallsC = 0;
    pipeline.checkUrlReachable = function (url, x, deadline) {
      reachableCallsC++;
      // La verificación del PRIMER candidato "consume" todo el resto del
      // plazo compartido -- ninguno de los siguientes debería ni siquiera
      // llegar a esta misma función.
      deadline.advance(45000);
      return Promise.resolve({ reachable: true });
    };
    var searchCallsC = 0;
    pipeline.searchGoogleNewsForCorroboration = function () { searchCallsC++; return Promise.resolve({ source: null, failed: true, reason: 'x', diagnostic: {} }); };
    var aiCallsC = 0;
    draft.draftArticle = function () { aiCallsC++; return Promise.resolve({}); };
    var rC = await pipeline.runFetchNewDraftsWithDeadline(baseCfg(), fakeC, Date.now());
    check('C1. Solo se llega a verificar el PRIMER candidato -- nunca el segundo ni el tercero',
      reachableCallsC === 1, 'checkUrlReachable se llamó ' + reachableCallsC + ' veces (esperado: 1)');
    check('C2. La corrida corta por timeout apenas vence el plazo compartido', rC.timedOut === true);
    check('C3. 0 llamadas de IA (nunca se llegó ni a corroborar el resto)', aiCallsC === 0 && rC.aiCallsMade === 0);
  }

  // =========================================================================
  // D. 0 llamadas de IA si el plazo vence antes de llegar a corroborar
  //    (ya cubierto arriba en B/C, se repite en un escenario propio y
  //    explícito porque es uno de los puntos exigidos por separado).
  // =========================================================================
  resetDrafts(); resetCache();
  {
    var fakeD = makeFakeDeadline(45000);
    var trendD = mockTrend('openai chatgpt feature d', aiCorrobPair('d'));
    googleTrends.fetchTrendingNow = function () { return Promise.resolve([trendD]); };
    pipeline.checkUrlReachable = function (url, x, deadline) {
      deadline.advance(45000); // vence antes de llegar a corroborar
      return Promise.resolve({ reachable: true });
    };
    var searchCallsD = 0;
    pipeline.searchGoogleNewsForCorroboration = function () { searchCallsD++; return Promise.resolve({ source: null, failed: true, reason: 'x', diagnostic: {} }); };
    var aiCallsD = 0;
    draft.draftArticle = function () { aiCallsD++; return Promise.resolve({}); };
    var rD = await pipeline.runFetchNewDraftsWithDeadline(baseCfg(), fakeD, Date.now());
    check('D1. 0 llamadas de corroboración activa (nunca se llegó a esa etapa)', searchCallsD === 0);
    check('D2. 0 llamadas de IA', aiCallsD === 0 && rD.aiCallsMade === 0);
    check('D3. La corrida se reporta como timedOut', rD.timedOut === true);
  }

  // =========================================================================
  // E. drafts.json no recibe ninguna escritura tardía cuando la corrida
  //    entera vence por timeout.
  // =========================================================================
  resetDrafts(); resetCache();
  {
    var draftsBeforeE = fs.readFileSync(draftsPath, 'utf8');
    var fakeE = makeFakeDeadline(45000);
    googleTrends.fetchTrendingNow = function (deadline) {
      deadline.advance(45000);
      var e = new Error('timed out'); e.trendsErrorCode = 'timeout';
      return Promise.reject(e);
    };
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [], errors: [] }); };
    var aiCallsE = 0;
    draft.draftArticle = function () { aiCallsE++; return Promise.resolve({}); };
    await pipeline.runFetchNewDraftsWithDeadline(baseCfg(), fakeE, Date.now());
    var draftsAfterE = fs.readFileSync(draftsPath, 'utf8');
    check('E1. drafts.json no cambió ni un byte tras una corrida que venció por completo', draftsAfterE === draftsBeforeE);
    check('E2. 0 llamadas de IA en esa corrida', aiCallsE === 0);
  }

  // =========================================================================
  // F. Un deadline EXTERNO (compartido) nunca se cierra dentro de
  //    buildCandidates()/buildCandidatesFromTrends() -- solo lo cierra quien
  //    lo creó (runFetchNewDrafts(), en producción, en su finally).
  // =========================================================================
  resetDrafts(); resetCache();
  {
    var fakeF1 = makeFakeDeadline(45000);
    googleTrends.fetchTrendingNow = function () { return Promise.resolve([]); }; // sin tendencias -- no es un fallo técnico
    await pipeline.buildCandidatesFromTrends(baseCfg(), fakeF1);
    check('F1. buildCandidatesFromTrends() NO cierra un deadline externo', fakeF1.wasCleared() === false);
  }
  {
    var fakeF2 = makeFakeDeadline(45000);
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [], errors: [] }); };
    await pipeline.buildCandidates(baseCfg(), fakeF2);
    check('F2. buildCandidates() NO cierra un deadline externo', fakeF2.wasCleared() === false);
  }
  // Contraprueba: SIN deadline externo, cada función sigue creando y
  // cerrando el suyo propio -- comportamiento idéntico al de antes de esta
  // corrección para cualquier llamador que no comparta un deadline (ej.
  // otras pruebas ya existentes que llaman a buildCandidates(cfg) solo).
  {
    googleTrends.fetchTrendingNow = function () { return Promise.resolve([]); };
    var resultNoExternal = await pipeline.buildCandidatesFromTrends(baseCfg());
    check('F3. Sin deadline externo, buildCandidatesFromTrends() sigue funcionando (crea y cierra el suyo propio)', resultNoExternal.technicalFailure === false);
  }

  restoreAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  var hashRealArticulosAfter = sha256File(REAL_ARTICULOS);
  check('Final. data/articulos.json del sitio REAL no cambió durante estas pruebas', hashRealArticulosAfter === hashRealArticulosBefore);
  check('Final. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('');
  console.log(pass + ' PASS, ' + fail + ' FAIL');
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.error(e);
  restoreAll();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
