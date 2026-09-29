#!/usr/bin/env node
/*
  admin/test-google-trends-discovery.js
  ===================================
  Pedido de Leonardo (2026-09-25): "descubrimiento de tendencias de Estados
  Unidos y reorganización de categorías" -- Google Trends "Trending Now"
  (geo=US) como punto de partida del descubrimiento de "Buscar noticias
  nuevas", con las 6 categorías editoriales definitivas (AI, Technology,
  Gaming, Movies TV & Anime, Sports, Business), clasificación sin IA,
  exigencia de dos fuentes periodísticas independientes antes de gastar una
  redacción, respaldo automático en RSS si Trends falla de verdad, y un
  tope real de 3 llamadas de IA por corrida.

  Ver admin/google-trends.js (cliente HTTP/parser del feed) y
  admin/pipeline.js (classifyTrendCategory/corroborateTrend/
  buildCandidatesFromTrends/pickDiverseTopCandidates/runFetchNewDrafts)
  para la implementación exacta verificada acá.

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real,
  ver la comprobación final). El "cliente de IA" (draft.draftArticle) y el
  feed de Google Trends (googleTrends.fetchTrendingNow) se reemplazan por
  mocks -- este entorno de pruebas no tiene salida a internet pública.

  Pruebas (punto 7 del pedido, una por escenario más algunas unitarias de
  apoyo):
    1. Tendencia estadounidense compatible + dos fuentes -> se redacta.
    2. Tendencia sin relación con las categorías activas -> 0 llamadas de IA.
    3. Tendencia con una sola fuente utilizable (y sin respaldo de Google
       News) -> 0 llamadas de IA.
    4. Google Trends caído (falla de red) -> cae al RSS de respaldo.
    5. Respuesta de Google Trends sin ninguna tendencia analizable (XML
       inválido/vacío) -> cae al RSS de respaldo sin colgar el panel.
    6. Un solo medio no monopoliza los candidatos elegidos
       (pickDiverseTopCandidates).
    7. Una tendencia de ciencia/espacio se clasifica como Technology (nunca
       Science) -- clasificador y remapeo de la propia IA.
    8. Película/serie/streaming/anime se clasifican como Movies, TV & Anime
       (slug interno "entertainment", sin romper URLs viejas).
    9. Gaming nunca se confunde con "Play Games" (no existe ese slug).
    10. Google Trends/Google News nunca quedan guardados como fuente
        periodística de un artículo.
    11. Máximo 3 llamadas de IA por corrida, aunque haya más candidatos
        aprobados.
    12. Un tema sensible detectado en un borrador de Trends queda en
        revisión humana obligatoria (nunca bloquea la corrida completa).
    13. editorialMeta/additionalSources sobreviven al primer guardado
        (drafts.json), con datos reales de Google Trends cuando corresponde.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');

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
function isoHoursAgo(hours) { return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(); }

const REAL_ROOT = path.join(__dirname, '..');
const realArticlesBefore = fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json'), 'utf8');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-trends-'));
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
  return Object.assign({ draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }, extra || {});
}
function mockReachableAlways() { pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); }; }
function mockGoogleNewsNeverFinds() {
  pipeline.searchGoogleNewsForCorroboration = function () {
    return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: { googleNewsResults: 0, domainsEvaluated: [], discardedSameDomain: 0, discardedExcluded: 0, discardedUnresolved: 0, discardedNoMatch: 0 } });
  };
}

// Mock instrumentado del "cliente de IA" (mismo patrón que
// test-two-phase-pipeline.js) -- cuenta sus propias invocaciones de forma
// independiente de cualquier contador interno de pipeline.js.
function makeInstrumentedDraftArticle(responseFn) {
  var calls = 0;
  var fn = function (item, cfg, categoryOptions, sourcesForPrompt) {
    calls++;
    var built = responseFn ? responseFn(item, sourcesForPrompt, calls) : null;
    if (!built) {
      var n = calls;
      built = {
        title: 'Trend note tag' + n + 'x tag' + n + 'y',
        dek: 'tag' + n + 'z tag' + n + 'w filed.',
        body: 'Cuerpo redactado de forma completamente independiente, sin retomar frases de la fuente original, con contenido suficiente para pasar cualquier validación básica de longitud del sitio.\n\n## Contexto adicional\nEsta sección aporta contexto propio sobre el tema, sin copiar el resumen original.\n\n## Qué sigue\nEsta segunda sección describe qué se espera a continuación, con vocabulario propio y distinto al de la fuente.',
        category: item.category,
        readTime: '3 min',
        keyClaims: [{ claim: 'Se confirmó una novedad relevante.', sourceLabel: sourcesForPrompt.primary.outlet }]
      };
    }
    return Promise.resolve(built);
  };
  fn.getCallCount = function () { return calls; };
  return fn;
}

// ----------------------------------------------------------------------
// Fixtures de tendencias -- mismo espíritu que CORROB_TOPICS de
// test-two-phase-pipeline.js: pares que SÍ corroboran entre sí (entidad
// compartida en el título + vocabulario compartido + dominios
// independientes), calibrados a mano contra computeCorroborationMatch.
// ----------------------------------------------------------------------
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
// Par AI: OpenAI/ChatGPT, dos medios independientes.
function aiCorrobPair(tag) {
  return [
    newsItem('OpenAI Launches New ChatGPT Feature For Developers', 'OpenAI unveiled a new ChatGPT feature aimed at developers on Tuesday.', 'techoutlet-a' + tag + '.example', 'launch'),
    newsItem('OpenAI Rolls Out ChatGPT Feature For Developers', 'A new ChatGPT feature aimed at developers began rolling out Tuesday, OpenAI said.', 'techoutlet-b' + tag + '.example', 'launch-details')
  ];
}

async function main() {
  // ==========================================================================
  // 1. Tendencia estadounidense compatible + dos fuentes -> se redacta.
  // ==========================================================================
  resetDrafts(); resetCache();
  var trend1 = mockTrend('openai chatgpt feature', aiCorrobPair('1'));
  googleTrends.fetchTrendingNow = function () { return Promise.resolve([trend1]); };
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock1 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock1;
  var r1 = await pipeline.fetchNewDrafts();
  check('1. Tendencia compatible + dos fuentes de Trends -> 1 borrador redactado', r1.added === 1 && r1.aiCallsMade === 1 && aiMock1.getCallCount() === 1, JSON.stringify(r1));
  check('1. Se clasificó como "ai" sin ninguna llamada de IA para clasificar', pipeline.classifyTrendCategory(pipeline.trendClassificationText(trend1)) === 'ai');
  check('1. trendsMode reporta la integración real de Google Trends', r1.trendsMode === 'google-trends-us', r1.trendsMode);
  check('1. 0 búsquedas de corroboración activas -- el paquete de Trends ya alcanzaba solo', r1.corroborationSearchesPerformed === 0, r1.corroborationSearchesPerformed);
  var draftsAfter1 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
  check('1. El borrador quedó guardado con category="ai"', draftsAfter1.length === 1 && draftsAfter1[0].category === 'ai', JSON.stringify(draftsAfter1[0] && draftsAfter1[0].category));

  // ==========================================================================
  // 2. Tendencia sin relación con las categorías activas -> 0 llamadas de IA.
  // ==========================================================================
  resetDrafts(); resetCache();
  var trend2 = mockTrend('small town parade draws record crowd', [
    newsItem('Small Town Parade Draws Record Crowd This Weekend', 'A local parade drew a record crowd over the weekend, organizers said.', 'localnews-a2.example'),
    newsItem('Record Crowd Attends Small Town Parade', 'Organizers confirmed record attendance at the annual parade this weekend.', 'localnews-b2.example')
  ]);
  googleTrends.fetchTrendingNow = function () { return Promise.resolve([trend2]); };
  var aiMock2 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock2;
  var r2 = await pipeline.fetchNewDrafts();
  check('2. Tendencia fuera de las 6 categorías activas -> 0 llamadas de IA', r2.aiCallsMade === 0 && r2.added === 0 && aiMock2.getCallCount() === 0, JSON.stringify(r2));
  check('2. Se contabilizó como descartada por categoría, nunca llegó a corroborarse', r2.filteredCounts.categoryExcluded === 1 && r2.trendsCategoryMatched === 0, JSON.stringify({ fc: r2.filteredCounts, matched: r2.trendsCategoryMatched }));

  // ==========================================================================
  // 3. Tendencia con una sola fuente utilizable (sin respaldo de Google
  //    News) -> 0 llamadas de IA.
  // ==========================================================================
  resetDrafts(); resetCache();
  var trend3 = mockTrend('new indie game surprise release', [
    newsItem('New Indie Game Surprise Release Tops Charts', 'An indie video game release unexpectedly topped download charts this week.', 'gamesoutlet-3.example')
  ]);
  googleTrends.fetchTrendingNow = function () { return Promise.resolve([trend3]); };
  mockGoogleNewsNeverFinds(); // capa 2 tampoco encuentra nada
  var aiMock3 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock3;
  var r3 = await pipeline.fetchNewDrafts();
  check('3. Una sola fuente utilizable y sin respaldo -> 0 llamadas de IA', r3.aiCallsMade === 0 && r3.added === 0 && aiMock3.getCallCount() === 0, JSON.stringify(r3));
  check('3. Queda listada como candidato de una sola fuente (nunca se redacta sola)', (r3.singleSourceCandidates || []).length === 1, JSON.stringify(r3.singleSourceCandidates));
  check('3. Sí se gastó UNA búsqueda de respaldo (capa 2) para intentar la segunda fuente', r3.corroborationSearchesPerformed === 1, r3.corroborationSearchesPerformed);

  // ==========================================================================
  // 4. Google Trends caído (falla de red) -> cae al RSS de respaldo.
  // ==========================================================================
  resetDrafts(); resetCache();
  googleTrends.fetchTrendingNow = function () {
    var e = new Error('getaddrinfo ENOTFOUND trends.google.com');
    e.trendsErrorCode = 'network';
    return Promise.reject(e);
  };
  var rssPair4 = [
    { category: 'business', title: 'Acme Corp Launches New Cloud Storage Service For Enterprise Clients', summary: 'Acme Corp unveiled a new cloud storage service aimed at enterprise clients on Tuesday.', link: 'https://rssfallback-a4.example/2026/09/launch', pubDate: isoHoursAgo(1), pubDateISO: isoHoursAgo(1), image: '', author: '', domain: 'rssfallback-a4.example', outlet: 'RSS Fallback A4' },
    { category: 'business', title: 'Acme Corp Rolls Out Cloud Storage Service For Enterprise Clients', summary: 'A cloud storage service aimed at enterprise clients from Acme Corp began rolling out on Tuesday, according to the firm.', link: 'https://rssfallback-b4.example/2026/09/launch-details', pubDate: isoHoursAgo(1), pubDateISO: isoHoursAgo(1), image: '', author: '', domain: 'rssfallback-b4.example', outlet: 'RSS Fallback B4' }
  ];
  feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: rssPair4, errors: [] }); };
  var aiMock4 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock4;
  var r4 = await pipeline.fetchNewDrafts();
  check('4. Google Trends caído (red) -> cae al RSS configurado como respaldo', r4.trendsMode === 'rss-fallback' && r4.fallbackReason === 'network', JSON.stringify({ mode: r4.trendsMode, reason: r4.fallbackReason }));
  check('4. El respaldo RSS igual pudo redactar (la corrida no se pierde)', r4.added === 1 && r4.aiCallsMade === 1, JSON.stringify(r4));
  var draftsAfter4 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));

  // ==========================================================================
  // 5. Respuesta de Google Trends sin ninguna tendencia analizable (XML
  //    inválido/vacío) -> cae al RSS de respaldo sin colgar el panel.
  // ==========================================================================
  resetDrafts(); resetCache();
  googleTrends.fetchTrendingNow = function () {
    var e = new Error('Google Trends no devolvió ninguna tendencia analizable');
    e.trendsErrorCode = 'empty-response';
    return Promise.reject(e);
  };
  feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: rssPair4, errors: [] }); };
  var aiMock5 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock5;
  var startedAt5 = Date.now();
  var r5 = await pipeline.fetchNewDrafts();
  var elapsed5 = Date.now() - startedAt5;
  check('5. XML inválido/vacío de Trends -> se trata como fallo técnico, cae al RSS', r5.trendsMode === 'rss-fallback' && r5.fallbackReason === 'empty-response', JSON.stringify({ mode: r5.trendsMode, reason: r5.fallbackReason }));
  check('5. La corrida terminó normalmente (nunca se colgó el panel)', elapsed5 < 10000 && typeof r5.totalTimeMs === 'number', 'elapsed=' + elapsed5 + ' totalTimeMs=' + r5.totalTimeMs);

  // ==========================================================================
  // 6. Un solo medio no monopoliza los candidatos elegidos
  //    (pickDiverseTopCandidates) -- prueba unitaria directa.
  // ==========================================================================
  var divA1 = { title: 'A1', domain: 'a.example' };
  var divA2 = { title: 'A2', domain: 'a.example' };
  var divA3 = { title: 'A3', domain: 'a.example' };
  var divA4 = { title: 'A4', domain: 'a.example' };
  var divB1 = { title: 'B1', domain: 'b.example' };
  var divB2 = { title: 'B2', domain: 'b.example' };
  var picked6 = pipeline.pickDiverseTopCandidates([divA1, divA2, divA3, divA4, divB1, divB2], 3);
  var pickedDomains6 = picked6.map(function (i) { return i.domain; });
  var distinctDomains6 = new Set(pickedDomains6).size;
  check('6. Con cupo de 3 y dos medios disponibles, se eligen los DOS medios (nunca uno solo si hay otro disponible)', distinctDomains6 === 2, JSON.stringify(pickedDomains6));
  check('6. El cupo se llena por completo igual (nunca se deja vacío por diversidad)', picked6.length === 3, picked6.length);
  check('6. Se respeta el orden de prioridad dentro de cada medio (A1 antes que A2, B1 antes que B2)', picked6[0].title === 'A1' && picked6[1].title === 'B1', JSON.stringify(picked6.map(function (i) { return i.title; })));
  var pickedAllSame6 = pipeline.pickDiverseTopCandidates([divA1, divA2, divA3, divA4], 3);
  check('6b. Si de verdad no hay otro medio disponible, el cupo igual se llena completo (nunca se deja sin llenar solo por diversidad)', pickedAllSame6.length === 3, pickedAllSame6.length);

  // ==========================================================================
  // 7. Ciencia/espacio se clasifica como Technology (nunca Science) --
  //    clasificador Y remapeo de la propia IA para un borrador NUEVO.
  // ==========================================================================
  var scienceText = pipeline.trendClassificationText(mockTrend('nasa exoplanet discovery', [
    newsItem('NASA Confirms New Discovery Of Distant Exoplanet', 'NASA scientists confirmed the discovery of a new exoplanet this week.', 'scienceoutlet-a7.example')
  ]));
  check('7. classifyTrendCategory nunca devuelve "science" -- una tendencia de NASA/exoplanetas cae en "technology"', pipeline.classifyTrendCategory(scienceText) === 'technology', pipeline.classifyTrendCategory(scienceText));

  resetDrafts(); resetCache();
  var trend7 = mockTrend('nasa exoplanet discovery', [
    newsItem('NASA Confirms New Discovery Of Distant Exoplanet', 'NASA scientists confirmed the discovery of a new exoplanet this week.', 'scienceoutlet-a7.example'),
    newsItem('NASA Announces Discovery Of Distant Exoplanet', 'A newly discovered distant exoplanet was announced by NASA scientists this week.', 'scienceoutlet-b7.example')
  ]);
  googleTrends.fetchTrendingNow = function () { return Promise.resolve([trend7]); };
  mockGoogleNewsNeverFinds();
  // La propia IA, sin que se lo pidan, decide "science" -- tiene que
  // quedar remapeado a "technology" igual (ver runFetchNewDrafts).
  var aiMock7 = makeInstrumentedDraftArticle(function (item) {
    return { title: 'Exoplanet Discovery Note', dek: 'A summary of the discovery.', body: 'Cuerpo redactado de forma independiente sobre el descubrimiento, con suficiente longitud para pasar cualquier validación básica.\n\n## Contexto\nMás contexto propio.\n\n## Qué sigue\nQué se espera a continuación.', category: 'science', readTime: '3 min', keyClaims: [{ claim: 'Se confirmó el descubrimiento.', sourceLabel: 'NASA' }] };
  });
  draft.draftArticle = aiMock7;
  var r7 = await pipeline.fetchNewDrafts();
  check('7. La tendencia se clasificó como "technology" antes de gastar IA', r7.added === 1 && r7.aiCallsMade === 1, JSON.stringify(r7));
  var draftsAfter7 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
  check('7. Aunque la IA eligió "science" por su cuenta, el borrador quedó guardado con category="technology" (remapeo, nunca se descarta)', draftsAfter7.length === 1 && draftsAfter7[0].category === 'technology', JSON.stringify(draftsAfter7[0] && draftsAfter7[0].category));

  // ==========================================================================
  // 8. Película/serie/streaming/anime se clasifican como Movies, TV & Anime
  //    (slug interno "entertainment", sin romper URLs viejas).
  // ==========================================================================
  var movieText = pipeline.trendClassificationText(mockTrend('new movie trailer', [newsItem('Studio Releases New Movie Trailer Ahead Of Box Office Debut', 'A new movie trailer dropped ahead of its box office debut this weekend.', 'filmoutlet-a8.example')]));
  var tvText = pipeline.trendClassificationText(mockTrend('renewed tv show', [newsItem('Streaming Service Renews Hit TV Show For Another Season', 'A hit TV show was renewed for another season by the streaming platform.', 'tvoutlet-b8.example')]));
  var streamingText = pipeline.trendClassificationText(mockTrend('netflix new series', [newsItem('Netflix Announces New Original Series Premiere Date', 'Netflix confirmed a premiere date for its new original series.', 'streamoutlet-c8.example')]));
  var animeText = pipeline.trendClassificationText(mockTrend('crunchyroll anime season', [newsItem('Crunchyroll Adds New Anime Series For Upcoming Season', 'Crunchyroll confirmed a new anime series will join its lineup next season.', 'animeoutlet-d8.example')]));
  check('8. Trailer de película -> entertainment', pipeline.classifyTrendCategory(movieText) === 'entertainment', pipeline.classifyTrendCategory(movieText));
  check('8. Renovación de serie de TV -> entertainment', pipeline.classifyTrendCategory(tvText) === 'entertainment', pipeline.classifyTrendCategory(tvText));
  check('8. Nueva serie de streaming (Netflix) -> entertainment', pipeline.classifyTrendCategory(streamingText) === 'entertainment', pipeline.classifyTrendCategory(streamingText));
  check('8. Anime (Crunchyroll) -> entertainment', pipeline.classifyTrendCategory(animeText) === 'entertainment', pipeline.classifyTrendCategory(animeText));
  var categoriesJson8 = JSON.parse(fs.readFileSync(path.join(dataDir, 'categories.json'), 'utf8'));
  var entCat8 = categoriesJson8.find(function (c) { return c.slug === 'entertainment'; });
  check('8. El slug interno sigue siendo "entertainment" (nunca se rompen URLs viejas) aunque la etiqueta visible cambió', entCat8 && entCat8.slug === 'entertainment' && /Movies,\s*TV/i.test(entCat8.label), JSON.stringify(entCat8));

  // ==========================================================================
  // 9. Gaming nunca se confunde con "Play Games" (no existe ese slug).
  // ==========================================================================
  var gamingText = pipeline.trendClassificationText(mockTrend('playstation 5 pro restock', [newsItem('PlayStation 5 Pro Restock Hits Major Retailers', 'A new PlayStation 5 Pro restock became available at major retailers this week.', 'gamingoutlet-a9.example')]));
  check('9. Restock de PlayStation 5 Pro -> gaming', pipeline.classifyTrendCategory(gamingText) === 'gaming', pipeline.classifyTrendCategory(gamingText));
  var allRuleSlugs9 = pipeline.TREND_CATEGORY_RULES.map(function (r) { return r[0]; });
  check('9. Ningún slug del clasificador de tendencias es "play-games"/"playgames" -- Play Games nunca participa de la búsqueda de noticias', allRuleSlugs9.indexOf('play-games') === -1 && allRuleSlugs9.indexOf('playgames') === -1, JSON.stringify(allRuleSlugs9));

  // ==========================================================================
  // 10. Google Trends/Google News nunca quedan guardados como fuente
  //     periodística de un artículo.
  // ==========================================================================
  var trendWithOwnDomain10 = mockTrend('some trend', [
    newsItem('Real Coverage Of The Trend From An Outlet', 'A real outlet covered this trend in depth this week.', 'realoutlet-10.example'),
    { title: 'Google Trends Self Link', snippet: 'should never be usable', url: 'https://trends.google.com/trending/rss?geo=US', domain: 'trends.google.com', outlet: 'Google Trends', picture: '' },
    { title: 'Google News Link', snippet: 'should never be usable either', url: 'https://news.google.com/rss/articles/abc', domain: 'news.google.com', outlet: 'Google News', picture: '' }
  ]);
  var usable10 = pipeline.usableTrendNewsItems(trendWithOwnDomain10);
  check('10. usableTrendNewsItems descarta trends.google.com y news.google.com -- solo queda el medio real', usable10.length === 1 && usable10[0].domain === 'realoutlet-10.example', JSON.stringify(usable10.map(function (u) { return u.domain; })));
  // De punta a punta: el borrador redactado en la prueba 1 nunca debería
  // tener a Google como fuente en ningún campo de procedencia.
  var draft1Full = draftsAfter1[0];
  var provenanceBlob10 = JSON.stringify(draft1Full);
  check('10. (de punta a punta) El borrador de la prueba 1 no menciona trends.google.com ni news.google.com en ningún campo', provenanceBlob10.indexOf('trends.google.com') === -1 && provenanceBlob10.indexOf('news.google.com') === -1);

  // ==========================================================================
  // 11. Máximo 3 llamadas de IA por corrida, aunque haya más candidatos
  //     aprobados.
  // ==========================================================================
  resetDrafts(); resetCache();
  // 5 temas genuinamente distintos entre sí (nunca la misma plantilla con
  // una palabra cambiada -- calibrado a mano igual que CORROB_TOPICS de
  // test-two-phase-pipeline.js) para que la deduplicación por
  // superposición de palabras de la MISMA corrida (sameRunDuplicatesDiscarded,
  // pedido 2026-09-24 punto 3 -- correcta y deseada para historias
  // REPETIDAS) nunca los confunda entre sí solo por vocabulario de
  // relleno compartido.
  var manyTrends11 = [
    mockTrend('openai t1', [
      newsItem('OpenAI Launches New ChatGPT Feature For Developers', 'OpenAI unveiled a new ChatGPT feature aimed at developers on Tuesday.', 'multi-a1.example'),
      newsItem('OpenAI Rolls Out ChatGPT Feature For Developers', 'A new ChatGPT feature aimed at developers began rolling out Tuesday, OpenAI said.', 'multi-b1.example')
    ], { approxTraffic: 9000 }),
    mockTrend('nintendo t2', [
      newsItem('Nintendo Announces Surprise Handheld Console Successor', 'Nintendo announced a surprise successor to its handheld console lineup on Wednesday.', 'multi-a2.example'),
      newsItem('Nintendo Confirms New Handheld Console Successor', 'A successor to Nintendo\'s handheld console lineup was confirmed Wednesday, the company said.', 'multi-b2.example')
    ], { approxTraffic: 8000 }),
    mockTrend('netflix t3', [
      newsItem('Netflix Renews Hit Anime Series For Third Season', 'Netflix renewed its hit anime series for a third season on Thursday.', 'multi-a3.example'),
      newsItem('Netflix Confirms Third Season Of Hit Anime Series', 'A third season of the hit anime series was confirmed Thursday by Netflix.', 'multi-b3.example')
    ], { approxTraffic: 7000 }),
    mockTrend('nfl t4', [
      newsItem('NFL Team Fires Head Coach After Losing Streak', 'An NFL team fired its head coach on Friday following a lengthy losing streak.', 'multi-a4.example'),
      newsItem('NFL Head Coach Dismissed Following Losing Streak', 'The head coach was dismissed Friday after a lengthy losing streak, the team confirmed.', 'multi-b4.example')
    ], { approxTraffic: 6000 }),
    mockTrend('bitcoin t5', [
      newsItem('Bitcoin Price Surges After ETF Approval News', 'Bitcoin surged in price on Saturday following news of an ETF approval.', 'multi-a5.example'),
      newsItem('Bitcoin Jumps Following ETF Approval Announcement', 'The cryptocurrency jumped Saturday after an ETF approval was announced, analysts said.', 'multi-b5.example')
    ], { approxTraffic: 5000 })
  ];
  googleTrends.fetchTrendingNow = function () { return Promise.resolve(manyTrends11); };
  mockGoogleNewsNeverFinds();
  // Un mock por tema distinto (a diferencia del genérico de las otras
  // pruebas) -- el genérico repite demasiado vocabulario de relleno
  // ("Trend note tagNx tagNy") entre sí como para distinguirse de la
  // deduplicación por superposición de palabras de la MISMA corrida
  // (sameRunDuplicatesDiscarded, pedido 2026-09-24 punto 3 -- correcto y
  // deseado para historias de verdad repetidas, pero un falso positivo
  // acá si los 5 mocks son casi idénticos entre sí). Cada redacción usa el
  // título real de la fuente para quedar léxicamente distinta de las
  // demás, como haría un texto de IA real sobre 5 temas distintos.
  var aiMock11 = makeInstrumentedDraftArticle(function (item) {
    return {
      title: item.title, dek: 'A detailed look at ' + item.title + ' and what it means.',
      body: 'Cuerpo redactado de forma independiente sobre ' + item.title + ', con contexto propio y suficiente longitud para pasar cualquier validación básica de longitud del sitio.\n\n## Contexto\nMás detalle específico sobre este tema puntual.\n\n## Qué sigue\nQué se espera a continuación sobre este tema puntual.',
      category: item.category, readTime: '3 min',
      keyClaims: [{ claim: 'Se confirmó una novedad relevante sobre ' + item.title + '.', sourceLabel: item.outlet }]
    };
  });
  draft.draftArticle = aiMock11;
  var r11 = await pipeline.fetchNewDrafts();
  check('11. 5 tendencias corroborables, tope real de 3 llamadas de IA', r11.aiCallsMade === 3 && aiMock11.getCallCount() === 3 && r11.added === 3, JSON.stringify(r11));
  check('11. candidatesWithTwoSources refleja los 5 aprobados, aunque solo se redactaron 3', r11.candidatesWithTwoSources === 5, r11.candidatesWithTwoSources);

  // ==========================================================================
  // 12. Un tema sensible detectado en un borrador de Trends queda en
  //     revisión humana obligatoria (nunca bloquea la corrida completa).
  // ==========================================================================
  resetDrafts(); resetCache();
  var trend12 = mockTrend('major tech company data breach', [
    newsItem('Major Tech Company Confirms Data Breach Affecting Millions', 'The company confirmed a data breach affecting millions of users this week.', 'techoutlet-a12.example'),
    newsItem('Major Tech Company Data Breach Exposes User Records', 'A data breach at the company exposed user records, according to a statement Tuesday.', 'techoutlet-b12.example')
  ]);
  googleTrends.fetchTrendingNow = function () { return Promise.resolve([trend12]); };
  mockGoogleNewsNeverFinds();
  var aiMock12 = makeInstrumentedDraftArticle(function (item) {
    return {
      title: 'Major Tech Company Confirms Data Breach Affecting Millions Of Users',
      dek: 'The company said it is notifying affected users after the breach was discovered this week.',
      body: 'Cuerpo redactado de forma independiente sobre la brecha de datos, con contexto propio y suficiente longitud para pasar cualquier validación básica de longitud del sitio.\n\n## Qué se sabe\nLa empresa confirmó que millones de usuarios podrían verse afectados.\n\n## Qué sigue\nSe espera una notificación oficial a los usuarios afectados en los próximos días.',
      category: 'technology', readTime: '3 min',
      keyClaims: [{ claim: 'La empresa confirmó una brecha de datos.', sourceLabel: item.outlet }]
    };
  });
  draft.draftArticle = aiMock12;
  var r12 = await pipeline.fetchNewDrafts();
  check('12. El tema sensible SÍ se redactó (nunca se bloquea la corrida por esto)', r12.added === 1 && r12.aiCallsMade === 1, JSON.stringify(r12));
  var draftsAfter12 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
  var published12 = [];
  var risk12 = pipeline.classifyDraft(draftsAfter12[0], published12);
  check('12. classifyDraft detecta el tema sensible (crime-security: data breach)', risk12.sensitiveTopics.indexOf('crime-security') !== -1, JSON.stringify(risk12.sensitiveTopics));
  check('12. El borrador queda en "revisar" (revisión humana obligatoria), nunca "listo" automáticamente', risk12.readinessTier === 'revisar', JSON.stringify({ tier: risk12.readinessTier, reasons: risk12.sensitiveReasons }));

  // ==========================================================================
  // 13. editorialMeta/additionalSources sobreviven al primer guardado, con
  //     datos reales de Google Trends cuando corresponde (nunca inventados).
  // ==========================================================================
  var savedDraft13 = draftsAfter1[0]; // de la prueba 1 (google-trends real)
  check('13. additionalSources sobrevivió al guardado con al menos una fuente real', Array.isArray(savedDraft13.additionalSources) && savedDraft13.additionalSources.length >= 1, JSON.stringify(savedDraft13.additionalSources));
  check('13. editorialMeta sobrevivió al guardado, con trendDetectionMethod="google-trends-us"', !!savedDraft13.editorialMeta && savedDraft13.editorialMeta.trendDetectionMethod === 'google-trends-us', JSON.stringify(savedDraft13.editorialMeta && savedDraft13.editorialMeta.trendDetectionMethod));
  check('13. trendVolumeApprox es el volumen REAL que trajo Google Trends (5000), nunca inventado ni null cuando sí vino el dato', savedDraft13.editorialMeta.trendVolumeApprox === 5000, savedDraft13.editorialMeta.trendVolumeApprox);
  check('13. (RSS de respaldo, prueba 4) trendDetectionMethod sigue siendo "rss-feed-preselection"', draftsAfter4[0].editorialMeta.trendDetectionMethod === 'rss-feed-preselection', draftsAfter4[0].editorialMeta.trendDetectionMethod);
  check('13. (RSS de respaldo, prueba 4) trendVolumeApprox sigue en null -- RSS nunca tuvo esa métrica, nunca se inventa', draftsAfter4[0].editorialMeta.trendVolumeApprox === null, draftsAfter4[0].editorialMeta.trendVolumeApprox);

  // ==========================================================================
  // Regresión: el sitio real (sandbox) nunca se tocó
  // ==========================================================================
  restoreAll();
  var realArticlesAfter = fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json'), 'utf8');
  check('Final. data/articulos.json del sitio REAL no cambió durante estas pruebas', realArticlesAfter === realArticlesBefore);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('Final. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR FATAL:', e);
  try { restoreAll(); } catch (e2) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
