#!/usr/bin/env node
/*
  admin/test-two-phase-pipeline.js
  ===================================
  Pedido de Leonardo (2026-09-23): "Buscar noticias nuevas" pasa a un
  pipeline de DOS FASES ESTRICTAS para no pagar redacción con IA para
  noticias que de antemano no pueden quedar listas.

    FASE 1 (sin IA): trae titulares, descarta todo lo que ya se sabe que no
    puede quedar listo (comercial/promocional/vencido/duplicado/categoría/
    fuente inválida/vieja), y busca activamente una segunda fuente
    independiente real. Solo esos candidatos pasan a la FASE 2.

    FASE 2 (redacción limitada): ordena los aprobados, redacta como mucho
    maxAIDrafts (3) por corrida, UNA sola llamada por candidato sin
    reintento, corre el checklist/puntaje ya existente, y separa "listo" de
    "revisar" -- nunca "listo" con una advertencia encima.

  Ver admin/pipeline.js (buildCandidates/fetchNewDrafts/getPipelineLimits/
  candidate-cache.json) para la implementación exacta verificada acá.

  Corre sobre COPIAS AISLADAS del sitio completo (nunca el sandbox real).
  El "cliente de IA" (draft.draftArticle) se reemplaza por un mock
  INSTRUMENTADO que cuenta sus propias invocaciones (requisito 26) -- cada
  prueba compara ese conteo real contra fetchResult.aiCallsMade, nunca
  infiere las llamadas por otra vía.

  Pruebas (requisito 25, una por escenario pedido):
    1. 30 titulares, ninguno corroborado -> 0 llamadas de IA.
    2. 30 titulares, 2 corroborados -> exactamente 2 llamadas.
    3. Más de 3 corroborados -> máximo 3 llamadas (maxAIDrafts).
    4. Oferta comercial/promocional -> 0 llamadas.
    5. Una sola fuente -> 0 llamadas.
    6. Fallo de Google News -> 0 llamadas para ese candidato.
    7. Redacción con advertencia -> queda en revisión, sin reintento.
    8. Noticia completa -> aparece en "Solo listos".
    9. Factores visibles y la suma da el puntaje real.
    10. Caché de 24hs evitando repetir gastos (y sin quedar pegada para
        siempre -- se vence sola).
  Más: límites configurables (requisito 16), regresión del hallazgo real de
  Leonardo (Robby Stein / TechCrunch Disrupt, requisito 23), y el requisito
  24 (nunca "listo" solo por buen puntaje si queda una advertencia).
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
function isoDaysAgo(days) { return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(); }
function isoHoursAgo(hours) { return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(); }

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-two-phase-'));
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

const originalFetchAllFeedItems = feeds.fetchAllFeedItems;
const originalCheckUrlReachable = pipeline.checkUrlReachable;
const originalSearchGoogleNews = pipeline.searchGoogleNewsForCorroboration;
const originalDraftArticle = draft.draftArticle;
const originalLoadConfig = draft.loadConfig;

function restoreAll() {
  feeds.fetchAllFeedItems = originalFetchAllFeedItems;
  pipeline.checkUrlReachable = originalCheckUrlReachable;
  pipeline.searchGoogleNewsForCorroboration = originalSearchGoogleNews;
  draft.draftArticle = originalDraftArticle;
  draft.loadConfig = originalLoadConfig;
}
function resetDrafts() { fs.writeFileSync(draftsPath, '[]\n', 'utf8'); }
function resetCache() { fs.writeFileSync(cachePath, '{}\n', 'utf8'); }

// Config de prueba estándar: key falsa (nunca sale a la red real, el
// "cliente de IA" siempre está mockeado), proveedor Anthropic.
function baseCfg(extra) {
  return Object.assign({ draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }, extra || {});
}

// Mock instrumentado del "cliente de IA" (requisito 26): cuenta sus propias
// invocaciones de forma independiente de cualquier contador interno de
// pipeline.js, para poder comparar los dos y confirmar que coinciden.
function makeInstrumentedDraftArticle(responseFn) {
  var calls = 0;
  var fn = function (item, cfg, categoryOptions, sourcesForPrompt) {
    calls++;
    var built = responseFn ? responseFn(item, sourcesForPrompt) : null;
    if (!built) {
      // Título/dek con un token "tagN" garantizado único por invocación
      // (pedido de originalidad entre borradores de la misma corrida,
      // 2026-09-24, punto 3): el texto viejo ("Cobertura redactada de
      // forma independiente sobre " + item.title / dek 100% idéntico entre
      // TODOS los ítems) compartía tanto vocabulario significativo de
      // relleno entre cualquier par de borradores que wordOverlapScore()
      // los confundía con "la misma historia" pase lo que pase el
      // item.title real -- un falso positivo de la propia mecánica de
      // prueba, no del pipeline real (un texto de verdad redactado por IA
      // para dos historias distintas nunca comparte tanto relleno
      // idéntico). "calls" es un contador estrictamente creciente y único
      // por invocación de ESTE mock, así que tagNx/tagNy/tagNz/tagNw nunca
      // se repiten entre dos borradores de la misma corrida -- a
      // diferencia de un hash, no depende de que el pool de palabras sea
      // lo bastante grande, así que no hay ninguna chance de colisión.
      var n = calls;
      built = {
        title: 'Note tag' + n + 'x tag' + n + 'y',
        dek: 'tag' + n + 'z tag' + n + 'w filed.',
        body: 'Cuerpo redactado de forma completamente independiente, sin retomar frases de la fuente original, con contenido suficiente para pasar cualquier validación básica de longitud del sitio.\n\n## Contexto adicional\nEsta sección aporta contexto propio sobre el sector, sin copiar el resumen original.\n\n## Qué sigue\nEsta segunda sección describe qué se espera a continuación, con vocabulario propio y distinto al de la fuente.',
        category: item.category,
        readTime: '3 min',
        keyClaims: [{ claim: 'Se anunció una novedad relevante.', sourceLabel: sourcesForPrompt.primary.outlet }]
      };
    }
    return Promise.resolve(built);
  };
  fn.getCallCount = function () { return calls; };
  return fn;
}

// Un ítem de RSS de una sola historia genérica, distinta de todas las
// demás -- para poblar el pool de "titulares examinados" sin que ninguna
// se corrobore entre sí ni comparta vocabulario con las otras (mantiene
// wordOverlapScore bajo entre pares, ver SAME_STORY_OVERLAP_THRESHOLD en
// pipeline.js). A propósito: nombres de una sola palabra, todos distintos
// entre sí y sin sufijos repetidos (nada de "X Robotics"/"Y Robotics"),
// para que extractMainEntities() nunca detecte una palabra compartida
// entre dos empresas de prueba distintas; y 30 historias con vocabulario
// de verdad distinto entre sí (no la misma plantilla con un nombre
// cambiado), para que wordOverlapScore() tampoco las confunda por pura
// coincidencia de redacción repetida. Calibrado y verificado a mano
// (todas las combinaciones por pares quedan bajo el umbral 0.4).
var NOISE_COMPANIES = [
  'Zolvex', 'Kestrion', 'Novantis', 'Bramlow', 'Ironvale', 'Vertexol', 'Lumence', 'Cobaltix',
  'Driftmore', 'Palisado', 'Anchorix', 'Thornbeck', 'Cascadeon', 'Halcyra', 'Rivergale',
  'Sablewyn', 'Wraithor', 'Glimmerix', 'Fernwick', 'Granitel', 'Tundrix', 'Opaleon', 'Redmark',
  'Silvantra', 'Marrowick', 'Quartzion', 'Windrell', 'Pinevale', 'Larkstone', 'Emberdyne'
];
var NOISE_STORIES = [
  ['opened a new distribution center in Ohio', 'opened a distribution center in Ohio this week, the company confirmed Thursday.'],
  ['hired a former airline executive as its operations chief', 'named a former airline executive to lead its operations division starting next month.'],
  ['expanded its loyalty program to include grocery partners', 'added several grocery chains to its loyalty rewards partnership this quarter.'],
  ['began offering same-day delivery in select markets', 'started same-day delivery service in a handful of metropolitan markets this week.'],
  ['renovated its flagship store ahead of the holiday season', 'completed renovations at its flagship location ahead of the busy holiday shopping period.'],
  ['signed a sponsorship deal with a regional soccer club', 'agreed to sponsor a regional soccer club for the upcoming three seasons.'],
  ['introduced a redesigned packaging line for its snack products', 'rolled out redesigned packaging for its snack product lineup this month.'],
  ['opened applications for its annual small business grant', 'began accepting applications for its yearly small business grant program.'],
  ['relocated its customer support team to a larger campus', 'moved its customer support staff into a larger campus facility this quarter.'],
  ['published a new accessibility guide for its website', 'released an accessibility guide covering updates to its consumer website.'],
  ['began piloting a four-day work week for warehouse staff', 'started a pilot four-day work week program for warehouse employees.'],
  ['donated surplus inventory to a regional food bank', 'contributed surplus inventory to a regional food bank ahead of the holidays.'],
  ['upgraded its point-of-sale systems across all locations', 'completed a rollout of upgraded point-of-sale terminals nationwide.'],
  ['launched an internal mentorship program for new hires', 'introduced a mentorship program pairing veteran staff with recent hires.'],
  ['extended store hours during the back-to-school season', 'will keep stores open later during the back-to-school shopping period.'],
  ['completed a routine safety audit at its main facility', 'finished a scheduled safety audit at its primary manufacturing facility.'],
  ['unveiled a refreshed loyalty card design for members', 'presented a redesigned loyalty card to members starting next quarter.'],
  ['started construction on an employee training center', 'broke ground on a dedicated employee training center this week.'],
  ['rolled out a recycling initiative across its retail stores', 'began a recycling initiative in all of its retail store locations.'],
  ['hosted a career fair for local college graduates', 'held a campus career fair aimed at local college graduates.'],
  ['introduced a uniform policy for frontline staff', 'adopted a standardized uniform policy for customer-facing employees.'],
  ['opened a pop-up kiosk inside a regional shopping mall', 'set up a temporary kiosk inside a regional shopping mall this month.'],
  ['began a pilot composting program at select cafeterias', 'launched a composting pilot program at several employee cafeterias.'],
  ['refreshed its employee wellness benefits for the year ahead', 'updated its wellness benefits package heading into the next fiscal year.'],
  ['added bilingual signage across its store locations', 'installed bilingual signage throughout its network of store locations.'],
  ['completed an internal audit of its supply chain vendors', 'finished reviewing its roster of supply chain vendors this quarter.'],
  ['introduced a rewards tier for frequent customers', 'created an additional rewards tier aimed at frequent repeat customers.'],
  ['opened a scholarship fund for employees children', 'established a scholarship fund benefiting the children of its employees.'],
  ['began offering curbside pickup at additional locations', 'expanded curbside pickup availability to a wider set of locations.'],
  ['updated its product return policy ahead of peak shopping days', 'revised its product return policy ahead of an expected surge in shopping activity.']
];
function noiseItem(i, scenarioTag) {
  var c = NOISE_COMPANIES[i % NOISE_COMPANIES.length];
  var story = NOISE_STORIES[i % NOISE_STORIES.length];
  return {
    category: 'business',
    title: c + ' ' + story[0].charAt(0).toUpperCase() + story[0].slice(1),
    summary: c + ' ' + story[1],
    link: 'https://outlet' + scenarioTag + i + '.example/2026/09/report-' + i,
    pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '',
    domain: 'outlet' + scenarioTag + i + '.example', outlet: 'Outlet ' + scenarioTag + i
  };
}
// Par de ítems que SÍ corroboran entre sí (misma entidad, texto distinto,
// dos dominios independientes) -- mismo patrón calibrado que ya usan
// test-source-corroboration.js/test-source-provenance.js (SOLVEX_A/
// SOLVEX_B_INDEPENDENT, Acme/VentureBeat): entidad compartida (siempre en
// el título, ver extractMainEntities -- solo mira el título) + vocabulario
// compartido dentro del PAR, fechas compatibles. Cada "tema" (idx) usa
// vocabulario propio y distinto de los demás temas -- a propósito, para
// que dos pares USADOS EN LA MISMA CORRIDA (ej. escenario 2 con dos pares,
// escenario 3 con cinco) nunca se confundan entre sí por la deduplicación
// genérica por superposición de palabras (candidates.forEach ~línea 700 de
// pipeline.js, que compara título+resumen SIN mirar entidad) -- verificado
// a mano: overlap dentro de cada par siempre >= 0.4, entre pares distintos
// siempre < 0.4.
var CORROB_TOPICS = [
  { a: 'Launches New Cloud Storage Service For Enterprise Clients', sa: 'unveiled a new cloud storage service aimed at enterprise clients on Tuesday.',
    b: 'Rolls Out Cloud Storage Service For Enterprise Clients', sb: 'A cloud storage service aimed at enterprise clients began rolling out on Tuesday, according to the firm.' },
  { a: 'Opens New Regional Distribution Hub In The Midwest', sa: 'opened a new regional distribution hub in the Midwest on Tuesday.',
    b: 'Debuts Distribution Hub Serving The Midwest Region', sb: 'A newly built distribution hub began serving the Midwest region starting Tuesday, the firm confirmed.' },
  { a: 'Unveils Redesigned Mobile App For Small Business Banking', sa: 'unveiled a redesigned mobile app for small business banking on Tuesday.',
    b: 'Rolls Out Mobile Banking App For Small Businesses', sb: 'A redesigned mobile banking app aimed at small businesses became available Tuesday, the firm said.' },
  { a: 'Announces New Manufacturing Partnership With Auto Parts Supplier', sa: 'announced a new manufacturing partnership with an auto parts supplier on Tuesday.',
    b: 'Confirms Manufacturing Deal With Auto Parts Supplier', sb: 'A manufacturing partnership with an auto parts supplier was confirmed Tuesday by company representatives.' },
  { a: 'Introduces Subscription Pricing Plan For Its Analytics Platform', sa: 'introduced a new subscription pricing plan for its analytics platform on Tuesday.',
    b: 'Rolls Out Pricing Plan For Analytics Platform Users', sb: 'A subscription pricing plan for analytics platform users went into effect Tuesday, the firm noted.' },
  { a: 'Debuts Flagship Wearable Device For Outdoor Fitness Tracking', sa: 'debuted a flagship wearable device for outdoor fitness tracking on Tuesday.',
    b: 'Releases Wearable Device Aimed At Outdoor Fitness Fans', sb: 'A wearable device aimed at outdoor fitness fans became available for purchase Tuesday, the company said.' }
];
function corroboratedPair(entity, scenarioTag, idx) {
  var t = CORROB_TOPICS[idx % CORROB_TOPICS.length];
  var linkBase = 'https://corrob' + scenarioTag + idx;
  return [
    {
      category: 'business', title: entity + ' ' + t.a,
      summary: entity + ' ' + t.sa,
      link: linkBase + 'a.example/2026/09/launch', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: linkBase.replace('https://', '') + 'a.example', outlet: 'CorrobA ' + scenarioTag + idx
    },
    {
      category: 'business', title: entity + ' ' + t.b,
      summary: t.sb,
      link: linkBase + 'b.example/2026/09/launch-details', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
      image: '', author: '', domain: linkBase.replace('https://', '') + 'b.example', outlet: 'CorrobB ' + scenarioTag + idx
    }
  ];
}

function mockFeeds(items) {
  feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: items, errors: [] }); };
}
function mockReachableAlways() {
  pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
}
function mockGoogleNewsNeverFinds() {
  pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
}

async function main() {
  // ==========================================================================
  // 1 -- 30 titulares, ninguno corroborado -> 0 llamadas de IA
  // ==========================================================================
  resetDrafts(); resetCache();
  var items1 = [];
  for (var i = 0; i < 30; i++) items1.push(noiseItem(i, 's1n'));
  mockFeeds(items1);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock1 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock1;

  var r1 = await pipeline.fetchNewDrafts();
  check('1. headlinesExamined es exactamente 30 (los 30 titulares del feed)', r1.headlinesExamined === 30, r1.headlinesExamined);
  check('1. Ningún candidato quedó corroborado (candidatesWithTwoSources 0)', r1.candidatesWithTwoSources === 0, r1.candidatesWithTwoSources);
  check('1. 0 llamadas de IA (ni una) -- ni added ni el contador interno', r1.added === 0 && r1.aiCallsMade === 0, JSON.stringify({ added: r1.added, aiCallsMade: r1.aiCallsMade }));
  check('1. (req 26) El mock instrumentado del cliente de IA confirma 0 invocaciones reales', aiMock1.getCallCount() === 0, aiMock1.getCallCount());
  check('1. (req 14) Mensaje exacto pedido cuando nadie supera la fase 1', r1.message === 'No se encontraron noticias suficientemente corroboradas para redactar. No se realizaron llamadas de IA.', r1.message);
  check('1. Los 30 quedan disponibles como candidatos de una sola fuente (requisito 20)', Array.isArray(r1.singleSourceCandidates) && r1.singleSourceCandidates.length === 30, r1.singleSourceCandidates && r1.singleSourceCandidates.length);
  check('1. drafts.json sigue vacío -- nada se redactó', JSON.parse(fs.readFileSync(draftsPath, 'utf8')).length === 0);

  // ==========================================================================
  // 2 -- 30 titulares, 2 corroborados -> exactamente 2 llamadas de IA
  // ==========================================================================
  resetDrafts(); resetCache();
  var pairA = corroboratedPair('Meridian Aerotech', 's2', 1);
  var pairB = corroboratedPair('Falkirk Biosystems', 's2', 2);
  var items2 = pairA.concat(pairB);
  for (var j = items2.length; j < 30; j++) items2.push(noiseItem(j, 's2n'));
  mockFeeds(items2);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock2 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock2;

  var r2 = await pipeline.fetchNewDrafts();
  check('2. headlinesExamined sigue siendo 30', r2.headlinesExamined === 30, r2.headlinesExamined);
  check('2. candidatesWithTwoSources es exactamente 2', r2.candidatesWithTwoSources === 2, r2.candidatesWithTwoSources);
  check('2. Exactamente 2 llamadas de IA (added 2, aiCallsMade 2)', r2.added === 2 && r2.aiCallsMade === 2, JSON.stringify({ added: r2.added, aiCallsMade: r2.aiCallsMade }));
  check('2. (req 26) El mock instrumentado confirma exactamente 2 invocaciones reales', aiMock2.getCallCount() === 2, aiMock2.getCallCount());
  check('2. Los otros 26 titulares sin corroboración NUNCA se redactaron', r2.singleSourceCandidates.length === 26, r2.singleSourceCandidates.length);

  // ==========================================================================
  // 3 -- Más de 3 corroborados (5) -> máximo 3 llamadas de IA (maxAIDrafts)
  // ==========================================================================
  resetDrafts(); resetCache();
  var items3 = [];
  ['Amber Robotics', 'Cascadia Freight', 'Northline Biotech', 'Thistle Cloud', 'Bramwell Energy'].forEach(function (entity, idx) {
    items3 = items3.concat(corroboratedPair(entity, 's3', idx));
  });
  mockFeeds(items3);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock3 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock3;

  var r3 = await pipeline.fetchNewDrafts();
  check('3. candidatesWithTwoSources es 5 (los 5 pares corroborados)', r3.candidatesWithTwoSources === 5, r3.candidatesWithTwoSources);
  check('3. Máximo 3 llamadas de IA aunque hubo 5 candidatos aprobados (maxAIDrafts default)', r3.added === 3 && r3.aiCallsMade === 3, JSON.stringify({ added: r3.added, aiCallsMade: r3.aiCallsMade, candidatesWithTwoSources: r3.candidatesWithTwoSources }));
  check('3. (req 26) El mock instrumentado confirma exactamente 3 invocaciones reales, nunca 5', aiMock3.getCallCount() === 3, aiMock3.getCallCount());

  // Límites configurables (requisito 16): con maxAIDrafts=2 en la config,
  // de los mismos 5 aprobados solo se redactan 2.
  resetDrafts(); resetCache();
  mockFeeds(items3);
  draft.loadConfig = function () { return baseCfg({ pipelineLimits: { maxAIDrafts: 2 } }); };
  var aiMock3b = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock3b;
  var r3b = await pipeline.fetchNewDrafts();
  check('3. (req 16) maxAIDrafts configurable a 2 -> exactamente 2 llamadas con los mismos 5 candidatos', r3b.added === 2 && r3b.aiCallsMade === 2 && aiMock3b.getCallCount() === 2, JSON.stringify(r3b));

  // ==========================================================================
  // 4 -- Oferta comercial/promocional -> 0 llamadas de IA
  // ==========================================================================
  resetDrafts(); resetCache();
  var commercialItem = {
    category: 'gaming', title: 'The Aurora Gaming Headset Drops to the Lowest Price Ever at Amazon Resale',
    summary: 'Grab this deal now: the Aurora headset is on sale, marked down for a limited time only.',
    link: 'https://dealsite-s4.example/2026/09/aurora-headset-deal', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'dealsite-s4.example', outlet: 'Dealsite'
  };
  mockFeeds([commercialItem]);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock4 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock4;
  var r4 = await pipeline.fetchNewDrafts();
  check('4. La oferta comercial se descarta ANTES de usar IA (filteredCounts.commercialDeal)', r4.filteredCounts.commercialDeal === 1, JSON.stringify(r4.filteredCounts));
  check('4. discardedBeforeAI cuenta este descarte', r4.discardedBeforeAI >= 1, r4.discardedBeforeAI);
  check('4. 0 llamadas de IA para una oferta comercial', r4.added === 0 && r4.aiCallsMade === 0 && aiMock4.getCallCount() === 0, JSON.stringify(r4));
  check('4. Nunca aparece como candidato de una sola fuente tampoco (se descartó antes, no es "sin corroborar")', r4.singleSourceCandidates.length === 0, r4.singleSourceCandidates.length);

  // ==========================================================================
  // 5 -- Una sola fuente -> 0 llamadas de IA
  // ==========================================================================
  resetDrafts(); resetCache();
  var singleItem = {
    category: 'technology', title: 'Thornbury Systems Announces New Data Center in the Midwest',
    summary: 'Thornbury Systems said Thursday it will open a new data center facility in the Midwest next year.',
    link: 'https://onlyoutlet-s5.example/2026/09/thornbury-datacenter', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'onlyoutlet-s5.example', outlet: 'Only Outlet'
  };
  mockFeeds([singleItem]);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock5 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock5;
  var r5 = await pipeline.fetchNewDrafts();
  check('5. Una sola fuente real -> 0 llamadas de IA (added 0, aiCallsMade 0)', r5.added === 0 && r5.aiCallsMade === 0 && aiMock5.getCallCount() === 0, JSON.stringify(r5));
  check('5. Aparece en singleSourceCandidates con título/resumen/enlace', r5.singleSourceCandidates.length === 1 &&
    r5.singleSourceCandidates[0].link === singleItem.link && r5.singleSourceCandidates[0].title === singleItem.title && !!r5.singleSourceCandidates[0].summary,
    JSON.stringify(r5.singleSourceCandidates));
  check('5. drafts.json sigue vacío', JSON.parse(fs.readFileSync(draftsPath, 'utf8')).length === 0);

  // ==========================================================================
  // 6 -- Fallo de Google News -> 0 llamadas de IA para ese candidato
  // ==========================================================================
  resetDrafts(); resetCache();
  // Categoría (pedido de Leonardo, 2026-09-25: reorganización de
  // categorías) -- "science" pasó a ser la categoría excluida de noticias
  // nuevas (se integra editorialmente en Technology, ver
  // data/categories.json y EXCLUDED_NEW_DRAFT_CATEGORIES en
  // admin/pipeline.js), así que este candidato tiene que usar una
  // categoría de verdad ACTIVA para llegar a la fase de corroboración que
  // este escenario quiere probar.
  var failItem = {
    category: 'technology', title: 'Halden Observatory Reports New Findings From Deep Sky Survey',
    summary: 'Researchers at Halden Observatory said Thursday they recorded new findings from an ongoing deep sky survey.',
    link: 'https://halden-s6.example/2026/09/deep-sky-survey', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'halden-s6.example', outlet: 'Halden Wire'
  };
  mockFeeds([failItem]);
  mockReachableAlways();
  var gNewsSearchCalls = 0;
  pipeline.searchGoogleNewsForCorroboration = function () {
    gNewsSearchCalls++;
    return Promise.resolve({ source: null, failed: true, reason: 'network', diagnostic: null });
  };
  draft.loadConfig = function () { return baseCfg(); };
  var aiMock6 = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMock6;
  var r6 = await pipeline.fetchNewDrafts();
  check('6. La búsqueda de corroboración SÍ se intentó (corroborationSearchesPerformed 1)', r6.corroborationSearchesPerformed === 1 && gNewsSearchCalls === 1, JSON.stringify({ performed: r6.corroborationSearchesPerformed, mockCalls: gNewsSearchCalls }));
  check('6. El fallo de Google News nunca inventa una fuente -- 0 llamadas de IA para este candidato', r6.added === 0 && r6.aiCallsMade === 0 && aiMock6.getCallCount() === 0, JSON.stringify(r6));
  check('6. Queda como candidato de una sola fuente, no como error bloqueante', r6.singleSourceCandidates.length === 1, r6.singleSourceCandidates.length);

  // ==========================================================================
  // 7 -- Redacción con advertencia -> queda en "revisar", sin reintento
  // ==========================================================================
  resetDrafts(); resetCache();
  var warnPair = corroboratedPair('Ashgrove Materials', 's7', 1);
  mockFeeds(warnPair);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  // La IA devuelve un cuerpo con un subtítulo genérico de cierre (dispara
  // genericHeadingWarning) -- justo el tipo de advertencia post-redacción
  // que NUNCA debería disparar un reintento automático.
  var aiMock7 = makeInstrumentedDraftArticle(function (item) {
    return {
      title: 'Cobertura sobre ' + item.title,
      dek: 'Dek redactado de forma independiente.',
      body: 'Cuerpo redactado de forma independiente, con contenido suficiente para pasar validaciones básicas de longitud del sitio y evitar coincidencias textuales con el resumen original.\n\n## Looking Ahead\nEsta sección de cierre usa a propósito un subtítulo genérico de los que ya detecta hasGenericHeading().',
      category: item.category, readTime: '3 min', keyClaims: []
    };
  });
  draft.draftArticle = aiMock7;
  var r7 = await pipeline.fetchNewDrafts();
  check('7. Una sola llamada de IA para este candidato (sin reintento automático)', r7.aiCallsMade === 1 && aiMock7.getCallCount() === 1, JSON.stringify({ aiCallsMade: r7.aiCallsMade, mockCalls: aiMock7.getCallCount() }));
  check('7. Se agregó el borrador (la redacción no falló, solo trae una advertencia)', r7.added === 1, r7.added);
  check('7. (req 13) Queda en "requiere revisión", nunca en "listo", por la advertencia de subtítulo genérico', r7.readyCount === 0 && r7.needsReviewCount === 1, JSON.stringify(r7));
  var draftsAfter7 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
  check('7. El borrador en disco trae genericHeadingWarning:true', draftsAfter7.length === 1 && draftsAfter7[0].genericHeadingWarning === true, JSON.stringify(draftsAfter7[0] && draftsAfter7[0].genericHeadingWarning));
  check('7. classifyDraft confirma readinessTier "revisar" para este borrador', pipeline.classifyDraft(draftsAfter7[0]).readinessTier === 'revisar', pipeline.classifyDraft(draftsAfter7[0]).readinessTier);

  // ==========================================================================
  // 8 -- Noticia completa -> aparece en "Solo listos"
  // ==========================================================================
  resetDrafts(); resetCache();
  var completePair = corroboratedPair('Windham Cloud', 's8', 1);
  mockFeeds(completePair);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  // Cuerpo actualizado 2026-09-24 (pedido de aporte editorial verificable,
  // punto 2): igual que en test-source-corroboration.js, este candidato
  // necesita >=3 de los 10 elementos de EDITORIAL_VALUE_ELEMENT_DETECTORS
  // (pipeline.js) para poder seguir llegando a "listo" -- de lo contrario
  // insufficientEditorialValue lo manda a "revisar" aunque el puntaje sea
  // 100 y haya corroboración real. Frases en inglés agregadas a propósito
  // (detectores en inglés) sin coincidir textualmente con el resumen de la
  // fuente original de esta prueba.
  //
  // Cuerpo ampliado de nuevo 2026-09-27 (pedido de validación de calidad de
  // redacción, punto 5): validateDraftWritingQuality() exige >=600 palabras,
  // >=3 subtítulos "## " y al menos una atribución ENLAZADA (<a href=...>)
  // -- igual que en test-source-corroboration.js, se extiende el relleno
  // (sin retomar frases de la fuente, sin repetir una misma oración, sin
  // referencias ambiguas) para que esta prueba siga verificando lo que le
  // corresponde ("listo" con 2 fuentes reales) sin quedar bloqueada por un
  // chequeo de redacción ortogonal a lo que mide acá.
  var aiMock8 = makeInstrumentedDraftArticle(function (item, sourcesForPrompt) {
    return {
      title: 'Empresa de nube anuncia expansión de infraestructura',
      dek: 'Cobertura editorial redactada de forma completamente independiente para esta prueba, sin retomar frases de la fuente original.',
      body: 'Texto de cuerpo redactado de forma independiente para esta prueba automatizada, con contenido de relleno variado y suficiente extensión para superar cualquier mínimo de palabras exigido por las validaciones del sitio, evitando cualquier coincidencia textual con el resumen original consultado en esta corrida. The provider has offered cloud infrastructure since 2018, according to public materials reviewed for this coverage. Internal planning material referenced by two people familiar with the matter describes a multi-year rollout timeline that predates this specific announcement by several fiscal quarters, though neither document was made public before this report. A separate regulatory filing submitted earlier this year outlined capital expenditure plans broadly consistent with the scale described in this announcement, giving additional context to the scope of the project beyond what the company disclosed directly this week. Company representatives declined to comment further beyond the prepared statement issued alongside the announcement, and no additional financial terms were disclosed in any public filing reviewed for this coverage.\n\n## Contexto del sector\nEsta sección aporta contexto adicional sobre la industria, redactado sin copiar el texto original de la fuente consultada. Compared to its previous regional footprint, the expansion could affect capacity planning across the wider cloud industry. Analysts who track enterprise infrastructure spending, as noted in <a href="https://industry-tracker.example/cloud-capacity-outlook">a widely cited industry report</a>, have pointed to rising enterprise demand as a driver behind similar investments announced by competitors over the past year. That broader trend offers useful context for evaluating how this specific expansion fits into the sector\'s overall trajectory, independent of any claims made by the company itself in its own announcement. Similar expansions announced elsewhere in the sector over the same period have followed a comparable pattern, with construction typically beginning within two quarters of an initial announcement and full operational capacity reached roughly eighteen months later, according to the same industry analysis.\n\n## Impacto para la industria\nEsta tercera sección examina las consecuencias probables de la expansión para otros actores del mercado, redactada también de forma independiente. Suppliers of networking and data center hardware could see increased order volume if the expansion proceeds on the timeline described, while regional utilities serving the affected sites may need to plan for additional power demand. Smaller regional providers, meanwhile, may face pressure to differentiate further as larger platforms capture a growing share of enterprise workloads. None of these downstream effects were addressed directly in the company statement reviewed for this coverage, and trade groups representing independent providers have previously flagged consolidation as an ongoing concern in public comments submitted to regulators.\n\n## Próximos pasos\nEsta segunda sección describe qué se espera a continuación, también con vocabulario distinto al de la nota original. Next steps include additional regional rollouts, though the exact timeline remains unclear. Local officials have indicated that permitting reviews tied to the expansion are proceeding on a normal schedule, without any of the delays that have affected comparable projects elsewhere in the region. A formal update on staffing plans and expected completion is anticipated in a subsequent quarterly filing, which would offer the next concrete checkpoint for tracking the project\'s progress. A representative for the surrounding municipality said no additional public hearings are currently scheduled beyond the standard review process already underway, and no objections have been filed to date. A separate briefing prepared for regional workforce planners, reviewed independently for this coverage, described the expansion as consistent with broader hiring trends already under way across the sector, without offering a specific figure for new positions expected at the site, and cautioned that final headcount would likely depend on demand once the new capacity fully came online later next year.',
      category: item.category, readTime: '3 min',
      keyClaims: [{ claim: 'Se anunció una expansión relevante.', sourceLabel: sourcesForPrompt.primary.outlet }, { claim: 'La segunda fuente confirmó el mismo hecho.', sourceLabel: sourcesForPrompt.additional[0].outlet }]
    };
  });
  draft.draftArticle = aiMock8;
  var r8 = await pipeline.fetchNewDrafts();
  check('8. Se redactó y quedó "lista" (readyCount 1, needsReviewCount 0)', r8.readyCount === 1 && r8.needsReviewCount === 0, JSON.stringify(r8));
  var draftsAfter8 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
  var tier8 = pipeline.classifyDraft(draftsAfter8[0]);
  check('8. readinessTier real es "listo", puntaje >= 80', tier8.readinessTier === 'listo' && tier8.editorialReadinessScore >= 80, JSON.stringify({ tier: tier8.readinessTier, score: tier8.editorialReadinessScore }));
  check('8. eligibleToUse/recommendation en verde -- esto es justo lo que alimenta el filtro "Solo listos" del panel', tier8.eligibleToUse === true && tier8.recommendation === 'crear');

  // ==========================================================================
  // 9 -- Factores visibles y la suma da el puntaje real
  // ==========================================================================
  var tier9 = tier8; // reusa el borrador completo de arriba, con 2 fuentes reales
  var summed9 = 0;
  var everyReasonHasNumber = tier9.readinessReasons.every(function (r) {
    var m = /^([+-]\d+):/.exec(r);
    if (!m) return false;
    summed9 += parseInt(m[1], 10);
    return true;
  });
  check('9. readinessReasons nunca viene vacío (factores visibles)', tier9.readinessReasons.length > 0, tier9.readinessReasons.length);
  check('9. Cada factor trae su +/- explícito, ninguno "vacío"', everyReasonHasNumber, JSON.stringify(tier9.readinessReasons));
  check('9. La suma de los factores (clampeada 0-100) coincide EXACTO con editorialReadinessScore',
    Math.max(0, Math.min(100, summed9)) === tier9.editorialReadinessScore,
    JSON.stringify({ summed: summed9, score: tier9.editorialReadinessScore, reasons: tier9.readinessReasons }));

  // ==========================================================================
  // 10 -- Caché de 24hs evitando repetir gastos (y sin quedar pegada para
  // siempre -- requisito 18)
  // ==========================================================================
  resetDrafts(); resetCache();
  var cacheUrl = 'https://cachetest-s10.example/2026/09/aurora-deal-cache';
  var cacheItemCommercial = {
    category: 'gaming', title: 'The Nimbus Gaming Headset Drops to the Lowest Price Ever at Amazon Resale',
    summary: 'Grab this deal now: on sale, marked down for a limited time only.',
    link: cacheUrl, pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'cachetest-s10.example', outlet: 'Cachetest'
  };
  mockFeeds([cacheItemCommercial]);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  draft.draftArticle = makeInstrumentedDraftArticle();

  var r10a = await pipeline.fetchNewDrafts();
  check('10. Primera corrida: se descarta y se cachea (commercialDeal 1)', r10a.filteredCounts.commercialDeal === 1 && r10a.filteredCounts.cachedSkip === 0, JSON.stringify(r10a.filteredCounts));
  var cacheOnDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  check('10. (ubicación de la caché técnica) data/candidate-cache.json quedó con la URL cacheada, SEPARADO de articulos.json/drafts.json', !!cacheOnDisk[cacheUrl], JSON.stringify(cacheOnDisk));

  // Segunda corrida DENTRO de las 24hs: aunque el feed ahora describe la
  // MISMA url con un texto que YA NO dispara el filtro comercial (para
  // demostrar que lo que la salta es la CACHÉ, no una nueva evaluación que
  // coincida por casualidad), se sigue saltando sin gastar nada.
  var cacheItemNowClean = {
    category: 'gaming', title: 'Nimbus Studio Announces New Headset Product Line',
    summary: 'Nimbus Studio said Thursday it will begin shipping a new headset product line next quarter.',
    link: cacheUrl, pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'cachetest-s10.example', outlet: 'Cachetest'
  };
  mockFeeds([cacheItemNowClean]);
  var r10b = await pipeline.fetchNewDrafts();
  check('10. Segunda corrida (misma URL, <24hs): se saltea por CACHÉ, no se re-evalúa (cachedSkip 1, commercialDeal 0 esta vez)',
    r10b.filteredCounts.cachedSkip === 1 && r10b.filteredCounts.commercialDeal === 0, JSON.stringify(r10b.filteredCounts));
  check('10. discardedBeforeAI sigue contando el ahorro (nunca se pierde del reporte de costos)', r10b.discardedBeforeAI === 1, r10b.discardedBeforeAI);

  // Simula que pasaron más de 24hs (reescribe el timestamp cacheado) --
  // ahora SÍ tiene que evaluarse de cero, y como el titular de esta corrida
  // ya no es comercial, debería pasar el filtro (nunca queda "pegado" para
  // siempre, requisito 18).
  var expiredCache = {};
  expiredCache[cacheUrl] = { reason: 'commercial-deal', cachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
  fs.writeFileSync(cachePath, JSON.stringify(expiredCache) + '\n', 'utf8');
  var r10c = await pipeline.fetchNewDrafts();
  check('10. (req 18) Pasadas las 24hs, la URL se vuelve a evaluar de cero -- ya no se saltea por caché', r10c.filteredCounts.cachedSkip === 0, JSON.stringify(r10c.filteredCounts));
  check('10. Y como ya no es comercial, ahora SÍ puede convertirse en candidato de una sola fuente (nunca queda descartada para siempre)',
    r10c.singleSourceCandidates.some(function (c) { return c.link === cacheUrl; }), JSON.stringify(r10c.singleSourceCandidates));

  // ==========================================================================
  // Límites configurables (requisito 16): defaults documentados + override
  // ==========================================================================
  var defaults = pipeline.getPipelineLimits({});
  check('16. Defaults documentados: 30 titulares / 10 búsquedas / 3 redacciones / 45000ms',
    defaults.maxHeadlinesExamined === 30 && defaults.maxCorroborationSearches === 10 && defaults.maxAIDrafts === 3 && defaults.preselectionTimeoutMs === 45000,
    JSON.stringify(defaults));
  var overridden = pipeline.getPipelineLimits({ pipelineLimits: { maxHeadlinesExamined: 5, maxAIDrafts: 1 } });
  check('16. Un override parcial respeta lo indicado y completa el resto con el default', overridden.maxHeadlinesExamined === 5 && overridden.maxAIDrafts === 1 && overridden.maxCorroborationSearches === 10, JSON.stringify(overridden));
  var invalidOverride = pipeline.getPipelineLimits({ pipelineLimits: { maxAIDrafts: -5, maxAIDrafts2: 'texto' } });
  check('16. Un valor inválido/negativo nunca rompe ni desactiva el control de costos -- cae al default', invalidOverride.maxAIDrafts === 3, JSON.stringify(invalidOverride));

  // ==========================================================================
  // Regresión cerrada (req 22): sameDomainMatchWarning NUNCA acumulado ni
  // "pegado" a través de corridas nuevas del pipeline completo (ya probado
  // a fondo en test-source-corroboration.js contra findAdditionalSourceForDraft
  // directo -- acá se confirma también de punta a punda vía fetchNewDrafts,
  // y que un candidato de una sola fuente por mismo-dominio NUNCA llega a
  // redactarse solo por eso).
  // ==========================================================================
  resetDrafts(); resetCache();
  var sameDomainA = {
    category: 'business', title: 'Praxis Robotics Announces New Warehouse Automation Platform',
    summary: 'Praxis Robotics unveiled a new warehouse automation platform Tuesday for large retailers.',
    link: 'https://praxiswire-s22.example/2026/09/praxis-platform', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'praxiswire-s22.example', outlet: 'PraxisWire'
  };
  // Mismo dominio/grupo que la fuente principal (outletNameFromDomain va a
  // dar el mismo nombre para "praxiswire-s22.example" y
  // "praxiswire-s22-blog.example" si comparten el mismo "nombre base" --
  // para no depender de esa heurística puntual, se fuerza directamente con
  // isIndependentSource ya sabido: acá se usa EXACTAMENTE el mismo dominio,
  // el caso más simple e inequívoco de "no independiente".
  var sameDomainB = {
    category: 'business', title: 'Praxis Robotics Unveils Automation Platform For Retailers',
    summary: 'The company launched a new automation platform this week, the firm said Tuesday.',
    link: 'https://praxiswire-s22.example/2026/09/praxis-platform-details', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'praxiswire-s22.example', outlet: 'PraxisWire'
  };
  mockFeeds([sameDomainA, sameDomainB]);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMockSameDomain = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMockSameDomain;
  var rSameDomain = await pipeline.fetchNewDrafts();
  check('22. Una coincidencia del MISMO dominio nunca cuenta como segunda fuente real -- 0 llamadas de IA', rSameDomain.added === 0 && rSameDomain.aiCallsMade === 0 && aiMockSameDomain.getCallCount() === 0, JSON.stringify(rSameDomain));
  check('22. Queda como candidato de una sola fuente con el aviso de mismo dominio (nunca oculto, nunca bloqueante)',
    rSameDomain.singleSourceCandidates.length === 1 && rSameDomain.singleSourceCandidates[0].sameDomainMatchWarning === true,
    JSON.stringify(rSameDomain.singleSourceCandidates));
  check('22. (estructural) Ya no "aparece masivamente" en el panel de borradores -- nunca llegó a EXISTIR un borrador para este candidato', JSON.parse(fs.readFileSync(draftsPath, 'utf8')).length === 0);

  // ==========================================================================
  // Regresión cerrada (req 23): hallazgo real de Leonardo -- "Robby Stein"
  // hablando en TechCrunch Disrupt resultó ser marketing de entradas con
  // urgencia de precio, no una noticia real -- tiene que descartarse ANTES
  // de usar IA, sin bloquear la cobertura legítima de la misma persona.
  // ==========================================================================
  var promoA = pipeline.detectPromotionalLanguage('Speaker Spotlight: OpenAI\'s Robby Stein Joins TechCrunch Disrupt 2026 — Buy Your Pass Before Prices Increase');
  check('23. "Speaker Spotlight ... Buy Your Pass Before Prices Increase" (TechCrunch Disrupt) se detecta como promocional', promoA.isPromotional === true, JSON.stringify(promoA));
  var promoB = pipeline.detectPromotionalLanguage('TechCrunch Disrupt 2026: Robby Stein to Speak — Ticket Prices Increase Soon, Secure Your Pass Today');
  check('23. Variante con "Ticket Prices Increase Soon" / "Secure Your Pass" también se detecta', promoB.isPromotional === true, JSON.stringify(promoB));
  var legitCoverage = pipeline.detectPromotionalLanguage('OpenAI product lead Robby Stein discusses ChatGPT roadmap at TechCrunch Disrupt 2026');
  check('23. Cobertura legítima que solo MENCIONA a Robby Stein/TechCrunch Disrupt (sin CTA de entradas) NUNCA se bloquea', legitCoverage.isPromotional === false, JSON.stringify(legitCoverage));

  resetDrafts(); resetCache();
  var robbySteinPromoItem = {
    category: 'ai', title: 'Speaker Spotlight: OpenAI\'s Robby Stein Joins TechCrunch Disrupt 2026',
    summary: 'Buy your pass before prices increase -- TechCrunch Disrupt 2026 features OpenAI\'s Robby Stein as a featured speaker.',
    link: 'https://tcdisrupt-s23.example/2026/09/robby-stein-spotlight', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
    image: '', author: '', domain: 'tcdisrupt-s23.example', outlet: 'TC Disrupt Wire'
  };
  mockFeeds([robbySteinPromoItem]);
  mockReachableAlways();
  mockGoogleNewsNeverFinds();
  draft.loadConfig = function () { return baseCfg(); };
  var aiMockRobby = makeInstrumentedDraftArticle();
  draft.draftArticle = aiMockRobby;
  var rRobby = await pipeline.fetchNewDrafts();
  check('23. (de punta a punta) La nota de marketing de entradas se descarta ANTES de usar IA -- 0 llamadas', rRobby.filteredCounts.promotional === 1 && rRobby.added === 0 && rRobby.aiCallsMade === 0 && aiMockRobby.getCallCount() === 0, JSON.stringify(rRobby));

  // ==========================================================================
  // Regresión cerrada (req 24): nunca "listo" solo por buen puntaje si
  // queda una advertencia encima -- caso límite EXPLÍCITO con puntaje >= 80
  // Y una advertencia que no es "una sola fuente" (similarityWarning), para
  // demostrar que la regla es general y no un efecto secundario de otra
  // cosa.
  // ==========================================================================
  var highScoreWithWarning = {
    title: 'Regulator Approves Merger of Two Major Cloud Providers',
    sourceHeadline: 'Regulator Approves Merger of Two Major Cloud Providers After Months of Review',
    sourceTitle: 'Reuters', sourceDomain: 'reuters.com', sourceUrl: 'https://www.reuters.com/business/regulator-approves-cloud-merger-2026',
    dek: 'The decision clears the way for the companies to combine operations by year end.',
    body: 'Regulators on Thursday approved the merger of two major cloud computing providers, according to a filing reviewed by Reuters.\n\n## Background\nThe deal was first announced earlier this year.\n\n## What happens next\nThe companies said the merger should close within 90 days.',
    category: 'technology',
    additionalSources: [{ url: 'https://www.bloomberg.com/news/cloud-merger-approved', label: 'Bloomberg' }],
    sourcePublishedAt: isoHoursAgo(3),
    keyClaims: [{ claim: 'Regulators approved the merger.', sourceLabel: 'Reuters' }, { claim: 'The deal should close within 90 days.', sourceLabel: 'Bloomberg' }],
    // La ÚNICA diferencia respecto al fixture "listo" de
    // test-editorial-readiness-scoring.js: similarityWarning:true. Esto NO
    // participa de computeEditorialReadiness (no resta puntos), así que el
    // puntaje sigue >= 80 -- pero classifyDraft tiene que igual mandarlo a
    // "revisar", nunca a "listo".
    similarityWarning: true, similarityScore: 42
  };
  var tier24 = pipeline.classifyDraft(highScoreWithWarning);
  check('24. El puntaje sigue siendo alto (>= 80) -- similarityWarning no resta puntos', tier24.editorialReadinessScore >= 80, tier24.editorialReadinessScore);
  check('24. Pero readinessTier NUNCA es "listo" mientras quede una advertencia encima (similarityWarning)', tier24.readinessTier === 'revisar', JSON.stringify({ score: tier24.editorialReadinessScore, tier: tier24.readinessTier }));
  var highScoreGeneric = Object.assign({}, highScoreWithWarning, { similarityWarning: false, genericHeadingWarning: true });
  var tier24b = pipeline.classifyDraft(highScoreGeneric);
  check('24. Mismo caso con genericHeadingWarning en vez de similarityWarning -- tampoco "listo"', tier24b.editorialReadinessScore >= 80 && tier24b.readinessTier === 'revisar', JSON.stringify({ score: tier24b.editorialReadinessScore, tier: tier24b.readinessTier }));
  var highScoreClean = Object.assign({}, highScoreWithWarning, { similarityWarning: false });
  var tier24c = pipeline.classifyDraft(highScoreClean);
  check('24. Contraejemplo: sin ninguna advertencia, el mismo puntaje alto SÍ llega a "listo" (la regla no es punitiva de más)', tier24c.readinessTier === 'listo', JSON.stringify({ score: tier24c.editorialReadinessScore, tier: tier24c.readinessTier }));

  // ==========================================================================
  // Regresión: el sitio real (sandbox) nunca se tocó
  // ==========================================================================
  restoreAll();
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('Final. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('Final. El sitio real (sandbox) sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos, sin cambios (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

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
