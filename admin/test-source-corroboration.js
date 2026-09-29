#!/usr/bin/env node
/*
  admin/test-source-corroboration.js
  ===================================
  Pedido real de Leonardo (2026-09-20), a raíz de una prueba manual de la
  puntuación de preparación editorial (ver test-editorial-readiness-scoring.js):
  "Descartados" funcionaba bien, pero "Solo listos" quedó vacío y "Requiere
  revisión" estancado en ~55 puntos -- porque additionalSources (el campo
  que hace falta para llegar a "listo") casi nunca se llenaba de verdad.
  Objetivo, tal como lo pidió: "encontrar candidatos suficientemente
  completos para una revisión humana rápida", con una fase automática de
  corroboración PREVIA A LA REDACCIÓN. Pedido de 21 puntos (ver el informe
  entregado a Leonardo para el detalle completo de diseño/archivos).

  Esta prueba cubre el MECANISMO DE BÚSQUEDA en sí (extracción de entidad/
  acción, independencia de dominio/grupo, criterio de "misma noticia",
  búsqueda en 2 capas -- feeds configurados y Google News RSS -- con
  presupuesto acotado, y el botón manual "Buscar segunda fuente") --
  test-editorial-readiness-scoring.js YA cubre la FÓRMULA de puntaje/tier a
  partir de additionalSources puesto A MANO, así que no se repite acá.

  Escenarios mínimos pedidos (requisito 17), cada uno anotado en su prueba:
    1. Misma historia, dos medios independientes -> corrobora.
    2. Dos notas distintas sobre la misma empresa -> NO corrobora.
    3. Dos URLs del mismo dominio -> se rechaza por falta de independencia.
    4. Noticias con fechas incompatibles -> se rechaza (veto de fecha).
    5. Copia sindicada del mismo comunicado -> se rechaza (dominio excluido).
    6. Fuente secundaria inaccesible -> nunca cuenta, nunca se inventa.
    7. Candidato sin ninguna corroboración disponible -> sigue de fuente
       única, nunca se inventa una.
  Más el requisito 18 (al menos un candidato sintético llega a "listo" de
  punta a punta, vía el mecanismo real, y los dudosos siguen en revisión) y
  el requisito 16 (botón manual "Buscar segunda fuente", con su ruta real
  del servidor).

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real
  ni la carpeta del usuario) -- mismo patrón que test-commercial-deal-filter.js
  y test-source-provenance.js. Ni la búsqueda en Google News RSS
  (fetchGoogleNewsRss) ni la resolución de URLs (resolveSourceUrl) tocan la
  red real en ningún momento: este sandbox no tiene salida a internet
  pública (confirmado con un curl a news.google.com), así que ambas se
  reemplazan por versiones de prueba deterministas, vía module.exports
  (mismo patrón que checkUrlReachable en el resto de la batería).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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
function isoDaysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString(); }
function rssItemXml(title, link, summary, pubDateRfc) {
  return '<item><title>' + title + '</title><link>' + link + '</link><description>' + summary + '</description><pubDate>' + pubDateRfc + '</pubDate></item>';
}
function rssXml(items) { return '<rss><channel>' + items.join('') + '</channel></rss>'; }

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-source-corroboration-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');
const draftsPath = path.join(dataDir, 'drafts.json');

async function main() {
  const pipeline = require(path.join(adminDir, 'pipeline.js'));
  const feeds = require(path.join(adminDir, 'feeds.js'));
  const draft = require(path.join(adminDir, 'draft.js'));

  // Se guardan los originales UNA vez acá -- cada PARTE reemplaza lo que
  // necesita y lo restaura antes de pasar a la siguiente, para que un
  // mock de una sección nunca contamine la que sigue.
  const ORIGINAL = {
    fetchAllFeedItems: feeds.fetchAllFeedItems,
    checkUrlReachable: pipeline.checkUrlReachable,
    fetchGoogleNewsRss: pipeline.fetchGoogleNewsRss,
    resolveSourceUrl: pipeline.resolveSourceUrl,
    searchGoogleNewsForCorroboration: pipeline.searchGoogleNewsForCorroboration,
    draftArticle: draft.draftArticle,
    loadConfig: draft.loadConfig
  };
  function restoreAll() {
    feeds.fetchAllFeedItems = ORIGINAL.fetchAllFeedItems;
    pipeline.checkUrlReachable = ORIGINAL.checkUrlReachable;
    pipeline.fetchGoogleNewsRss = ORIGINAL.fetchGoogleNewsRss;
    pipeline.resolveSourceUrl = ORIGINAL.resolveSourceUrl;
    pipeline.searchGoogleNewsForCorroboration = ORIGINAL.searchGoogleNewsForCorroboration;
    draft.draftArticle = ORIGINAL.draftArticle;
    draft.loadConfig = ORIGINAL.loadConfig;
  }

  // ==========================================================================
  // PARTE 1 -- computeCorroborationMatch/extractMainEntities/extractMainAction/
  // isIndependentSource/EXCLUDED_CORROBORATION_DOMAINS (funciones puras)
  // ==========================================================================
  var SOLVEX_A = {
    title: 'Solvex Dynamics Launches New Battery Recycling Platform',
    summary: 'Solvex Dynamics unveiled a new platform Tuesday for recycling electric vehicle batteries at scale.',
    pubDateISO: isoDaysAgo(0)
  };
  // Requisito 17.1: misma historia, dos medios independientes -- distinta
  // redacción, misma entidad ("Solvex Dynamics") y misma acción ("launch").
  var SOLVEX_B_INDEPENDENT = {
    title: 'Solvex Dynamics Unveils Battery Recycling Platform For EVs',
    summary: 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.',
    pubDateISO: isoDaysAgo(0)
  };
  var matchSameEvent = pipeline.computeCorroborationMatch(SOLVEX_A, SOLVEX_B_INDEPENDENT);
  check('1.1 (req 17.1) Misma historia, dos medios independientes: isMatch true, con razones explicables',
    matchSameEvent.isMatch === true && matchSameEvent.reasons.length >= 2, JSON.stringify(matchSameEvent));
  check('1.1 (req 5) El vocabulario compartido solo (40 pts) nunca alcanza por sí solo -- acá suma entidad+acción también',
    matchSameEvent.score > 40 && matchSameEvent.reasons.some(function (r) { return /entidad/.test(r); }));

  // Requisito 17.2: dos notas DISTINTAS sobre la misma empresa (otro
  // acontecimiento, otra acción) -- compartir la entidad NO alcanza sola.
  var SOLVEX_C_DIFFERENT_STORY = {
    title: 'Solvex Dynamics Reports Quarterly Earnings Beat',
    summary: 'Solvex Dynamics posted stronger than expected quarterly earnings on Thursday, beating analyst estimates.',
    pubDateISO: isoDaysAgo(0)
  };
  var matchDifferentStory = pipeline.computeCorroborationMatch(SOLVEX_A, SOLVEX_C_DIFFERENT_STORY);
  check('1.2 (req 17.2, req 5) Dos notas distintas de la misma empresa: isMatch false (compartir entidad no alcanza)',
    matchDifferentStory.isMatch === false && matchDifferentStory.score < CORROBORATION_MATCH_THRESHOLD_FOR_TEST(),
    JSON.stringify(matchDifferentStory));

  // Requisito 17.4: mismo contenido (score alto) pero fechas incompatibles
  // -- el veto de fecha gana SIEMPRE, sin importar el resto del puntaje.
  var SOLVEX_B_OLD_DATE = Object.assign({}, SOLVEX_B_INDEPENDENT, { pubDateISO: isoDaysAgo(10) });
  var matchIncompatibleDates = pipeline.computeCorroborationMatch(SOLVEX_A, SOLVEX_B_OLD_DATE);
  check('1.3 (req 17.4, req 6) Fechas incompatibles (10 días): isMatch false pese a puntaje de contenido alto',
    matchIncompatibleDates.isMatch === false && matchIncompatibleDates.dateCompatible === false && matchIncompatibleDates.score >= 60,
    JSON.stringify(matchIncompatibleDates));

  // Requisitos 3-4: mismo dominio exacto, o mismo grupo editorial (BBC).
  check('1.4 (req 17.3) isIndependentSource: mismo dominio exacto -> false', pipeline.isIndependentSource('techcrunch.com', 'techcrunch.com') === false);
  check('1.4 (req 3-4) isIndependentSource: mismo GRUPO editorial (bbc.co.uk/bbci.co.uk) -> false, aunque el dominio difiera',
    pipeline.isIndependentSource('bbc.co.uk', 'bbci.co.uk') === false);
  check('1.4 isIndependentSource: dos medios de verdad distintos -> true', pipeline.isIndependentSource('techcrunch.com', 'venturebeat.com') === true);
  check('1.4 isIndependentSource: defensivo ante dominio vacío/nulo -> false', pipeline.isIndependentSource(null, 'x.com') === false && pipeline.isIndependentSource('x.com', '') === false);

  // Requisito 13: agregadores/comunicados/redes sociales nunca cuentan.
  check('1.5 (req 17.5, req 13) EXCLUDED_CORROBORATION_DOMAINS incluye distribuidores de comunicados', pipeline.EXCLUDED_CORROBORATION_DOMAINS.has('businesswire.com') && pipeline.EXCLUDED_CORROBORATION_DOMAINS.has('prnewswire.com'));
  check('1.5 EXCLUDED_CORROBORATION_DOMAINS incluye agregadores/redes sociales', pipeline.EXCLUDED_CORROBORATION_DOMAINS.has('news.google.com') && pipeline.EXCLUDED_CORROBORATION_DOMAINS.has('x.com'));
  check('1.5 EXCLUDED_CORROBORATION_DOMAINS NO incluye un medio real cualquiera', !pipeline.EXCLUDED_CORROBORATION_DOMAINS.has('techcrunch.com'));

  // Entidad/acción principal (requisito 1) -- heurística explicable.
  check('1.6 extractMainEntities detecta la entidad principal del titular', pipeline.extractMainEntities(SOLVEX_A.title).join(' ').indexOf('Solvex') !== -1);
  check('1.6 extractMainAction detecta "launch" para "Launches"', pipeline.extractMainAction(SOLVEX_A.title) === 'launch');
  check('1.6 extractMainAction da null cuando no hay ningún verbo de acción reconocido', pipeline.extractMainAction('A Perfectly Neutral Headline With No Verb') === null);

  // ==========================================================================
  // 1.7-1.11 -- corrección del falso positivo de entidades (pedido de
  // Leonardo, 2026-09-20, 12 puntos, a raíz de la prueba manual): palabras
  // genéricas/verbos de acción/términos periodísticos frecuentes NUNCA
  // pueden formar (ni solas ni acompañadas) la entidad principal de un
  // titular, y una entidad compuesta o nombre propio concreto SÍ se
  // prioriza correctamente. Antes de este pedido, "Acme Launches New Cloud
  // Security Platform" vs "Zeta Launches New Cloud Security Suite"
  // registraba una entidad compartida espuria (la SEGUNDA entidad
  // extraída de cada titular, "Cloud Security Platform"/"Cloud Security
  // Suite", coincidía por palabras genéricas del rubro, no por la empresa).
  // ==========================================================================

  // Requisito 2: una palabra genérica sola NUNCA puede ser una entidad --
  // ni siquiera cuando es todo el titular.
  check('1.7 (req 2) extractMainEntities("New") -> ninguna entidad (palabra genérica sola)', pipeline.extractMainEntities('New').length === 0);
  check('1.7 (req 2) extractMainEntities("AI") -> ninguna entidad (palabra genérica sola)', pipeline.extractMainEntities('AI').length === 0);
  check('1.7 (req 1-2) extractMainEntities("Says Plans Could May Will Report") -> ninguna entidad (todo el titular es genérico)', pipeline.extractMainEntities('Says Plans Could May Will Report').length === 0);

  // Requisito 3: entidades compuestas y nombres propios concretos, tal
  // como los pidió Leonardo textualmente (OpenAI, Google DeepMind, Fidji
  // Simo, Nintendo Switch), se extraen correctamente como entidad
  // PRINCIPAL pese a estar rodeadas de palabras genéricas/verbos/números.
  check('1.8 (req 3) extractMainEntities: "OpenAI" sola al arrancar el titular no se pierde (antes se descartaba por la vieja regla de "una sola palabra en posición inicial")',
    pipeline.extractMainEntities('OpenAI Unveils New Model For Coding Tasks')[0] === 'OpenAI');
  check('1.8 (req 3) extractMainEntities: entidad compuesta "Google DeepMind" completa, no cortada por el verbo genérico que sigue',
    pipeline.extractMainEntities('Google DeepMind Launches New AI Model For Coding')[0] === 'Google DeepMind');
  check('1.8 (req 3) extractMainEntities: persona con nombre y apellido ("Fidji Simo") como entidad principal',
    pipeline.extractMainEntities('Fidji Simo Announces New Role At OpenAI')[0] === 'Fidji Simo');
  check('1.8 (req 3) extractMainEntities: producto compuesto ("Nintendo Switch") pese a un número y verbos/términos genéricos alrededor',
    pipeline.extractMainEntities('Nintendo Switch 2 Launches This Week')[0] === 'Nintendo Switch');

  // Requisito 5, escenario a: dos titulares DISTINTOS que arrancan ambos
  // con "New" -- "New" nunca debe registrarse como entidad compartida, y
  // al no compartir entidad real ni acción reconocida, tampoco corrobora.
  var NEW_A = { title: 'New Study Reveals Coffee Health Benefits For Adults', summary: 'A new study found regular coffee drinkers reported measurable health benefits, researchers said.', pubDateISO: isoDaysAgo(0) };
  var NEW_B = { title: 'New Bridge Opens After Years Of Delay', summary: 'A long-delayed bridge finally opened to traffic this week after years of construction setbacks.', pubDateISO: isoDaysAgo(0) };
  check('1.9 (req 5a) "New" nunca es la entidad principal de ninguno de los dos titulares', pipeline.extractMainEntities(NEW_A.title)[0] !== 'New' && pipeline.extractMainEntities(NEW_B.title)[0] !== 'New');
  var matchNewNew = pipeline.computeCorroborationMatch(NEW_A, NEW_B);
  check('1.9 (req 5a) Dos historias distintas que arrancan con "New": isMatch false, sin entidad ni acción compartida',
    matchNewNew.isMatch === false && matchNewNew.sharedEntity === false, JSON.stringify(matchNewNew));

  // Requisito 5, escenario b: dos historias distintas con "Opens".
  var OPENS_A = { title: 'Downtown Diner Opens New Location After Long Renovation', summary: 'A popular downtown diner reopened its doors this week after a long renovation project.', pubDateISO: isoDaysAgo(0) };
  var OPENS_B = { title: 'City Museum Opens New Wing For Modern Art', summary: 'The city museum unveiled a new wing dedicated to modern art this week.', pubDateISO: isoDaysAgo(0) };
  var matchOpensOpens = pipeline.computeCorroborationMatch(OPENS_A, OPENS_B);
  check('1.10 (req 5b) Dos historias distintas con "Opens": isMatch false, sin entidad compartida ("Downtown Diner" vs "City Museum")',
    matchOpensOpens.isMatch === false && matchOpensOpens.sharedEntity === false, JSON.stringify(matchOpensOpens));

  // Requisito 5, escenario c + requisito 4: dos empresas DISTINTAS que
  // "launch" productos DISTINTOS -- comparten la acción genérica pero
  // nunca una entidad real, así que una acción compartida sola (aun con
  // fecha compatible) nunca alcanza el umbral elevado (80).
  var LAUNCH_A = { title: 'Acme Robotics Launches New Delivery Drone For Cities', summary: 'Acme Robotics introduced a new autonomous delivery drone aimed at urban logistics.', pubDateISO: isoDaysAgo(0) };
  var LAUNCH_B = { title: 'Zenith Motors Launches New Electric Truck For Fleets', summary: 'Zenith Motors introduced a new electric truck aimed at commercial delivery fleets.', pubDateISO: isoDaysAgo(0) };
  var matchLaunchLaunch = pipeline.computeCorroborationMatch(LAUNCH_A, LAUNCH_B);
  check('1.11 (req 5c, req 4) Dos empresas distintas lanzando productos distintos: isMatch false pese a compartir la acción "launch"',
    matchLaunchLaunch.isMatch === false && matchLaunchLaunch.sharedEntity === false && matchLaunchLaunch.sameAction === true && matchLaunchLaunch.score < 80,
    JSON.stringify(matchLaunchLaunch));

  // Requisito 5, escenario e: un match REAL con entidad compuesta y misma
  // acción -- "Launches"/"Unveils" caen en el mismo grupo de acción
  // ('launch'), y la entidad compuesta "Google DeepMind" es idéntica en
  // ambos, así que esto SÍ debe corroborar.
  var DEEPMIND_A = { title: 'Google DeepMind Launches New AI Model For Coding', summary: 'Google DeepMind introduced a new AI model this week aimed at helping developers write code faster.', pubDateISO: isoDaysAgo(0) };
  var DEEPMIND_B = { title: 'Google DeepMind Unveils New AI Model For Developers', summary: 'Google DeepMind announced a new AI model this week designed to help developers write code more efficiently.', pubDateISO: isoDaysAgo(0) };
  var matchDeepmind = pipeline.computeCorroborationMatch(DEEPMIND_A, DEEPMIND_B);
  check('1.12 (req 5e) Entidad compuesta real ("Google DeepMind") + misma acción ("launch"/"unveil" -> mismo grupo): isMatch true',
    matchDeepmind.isMatch === true && matchDeepmind.sharedEntity === true && matchDeepmind.sameAction === true, JSON.stringify(matchDeepmind));

  function CORROBORATION_MATCH_THRESHOLD_FOR_TEST() { return 60; } // documental, ver pipeline.js

  // ==========================================================================
  // PARTE 2 -- searchGoogleNewsForCorroboration (capa 2: Google News RSS)
  // Pedido de Leonardo 2026-09-20 (requisito 6): la función SIEMPRE
  // devuelve un objeto {source, failed, reason} -- nunca lanza, nunca
  // devuelve null a secas. `source` es la fuente encontrada o null;
  // `failed` distingue "se buscó bien, de verdad no hay corroboración"
  // (failed:false) de "la búsqueda en sí no se pudo completar" (failed:true,
  // con reason 'timeout'/'network'/'rate-limited'/'parse-error'). En AMBOS
  // casos el resultado para el candidato es el mismo (source:null, sigue
  // en "Requiere revisión", nunca se bloquea el panel, nunca se inventa
  // una fuente) -- la distinción es solo para poder mostrar un mensaje
  // breve y comprensible.
  // ==========================================================================
  var PUB_RFC = new Date().toUTCString();

  await (
  // 2.1: entre varios resultados descartables (mismo dominio, dominio
  // excluido, sin relación, inaccesible), encuentra el ÚNICO válido y
  // corta ahí -- nunca sigue buscando después (requisito 14: como mucho
  // una consulta, cortando en el primer match real).
  (function () {
    var items = [
      rssItemXml('Solvex Dynamics Launches New Battery Recycling Platform - Gridwire', 'https://gridwire.io/same-domain-copy', 'Copia del mismo dominio que la fuente principal', PUB_RFC),
      rssItemXml('Solvex Dynamics Launches New Battery Recycling Platform', 'https://businesswire.com/press-release', 'Comunicado de prensa sindicado', PUB_RFC),
      rssItemXml('Totally Unrelated Sports Score Update', 'https://randomsite.example/sports', 'Nada que ver con la historia', PUB_RFC),
      rssItemXml('Solvex Dynamics Unveils Battery Recycling Platform For EVs', 'https://deadsite.example/story', 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.', PUB_RFC),
      // Requisito 8: título con sufijo de medio ENGAÑOSO que agrega Google
      // News ("- Totally Wrong Outlet Name") -- el nombre de medio mostrado
      // tiene que salir del DOMINIO FINAL resuelto (circuitdaily.com ->
      // "Circuitdaily"), nunca de este texto.
      rssItemXml('Solvex Dynamics Unveils Battery Recycling Platform For EVs - Totally Wrong Outlet Name', 'https://circuitdaily.com/solvex-story', 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.', PUB_RFC),
      rssItemXml('Solvex Dynamics Unveils Battery Recycling Platform For EVs', 'https://laterdomain.example/story-nunca-debe-alcanzarse', 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.', PUB_RFC)
    ];
    pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml(items)); };
    var resolvedCalls = [];
    pipeline.resolveSourceUrl = function (url) {
      resolvedCalls.push(url);
      if (url.indexOf('deadsite.example') !== -1) return Promise.resolve({ reachable: false, blocked: false, reason: 'no-responde', finalUrl: null }); // req 17.6
      return Promise.resolve({ reachable: true, finalUrl: url });
    };
    return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
      var result = outcome.source;
      check('2.1 (req 6) Búsqueda exitosa: failed:false, reason:null', outcome.failed === false && outcome.reason === null, JSON.stringify(outcome));
      check('2.1 (req 3-4) Descarta el resultado del MISMO dominio que la fuente principal', resolvedCalls.indexOf('https://gridwire.io/same-domain-copy') !== -1 && (!result || result.domain !== 'gridwire.io'));
      check('2.1 (req 17.5, req 13) Descarta la copia sindicada en un dominio excluido (businesswire.com)', !result || result.domain !== 'businesswire.com');
      check('2.1 (req 17.6) Nunca cuenta un resultado inaccesible, aunque el contenido coincida', !result || result.url.indexOf('deadsite.example') === -1);
      check('2.1 Encuentra el ÚNICO resultado válido (independiente, accesible, no excluido, misma noticia real)',
        !!result && result.url === 'https://circuitdaily.com/solvex-story', JSON.stringify(result));
      check('2.1 (req 8) El nombre de medio sale del DOMINIO FINAL resuelto ("Circuitdaily"), nunca del sufijo de título engañoso que traía Google News',
        !!result && result.outlet === 'Circuitdaily' && result.outlet !== 'Totally Wrong Outlet Name', JSON.stringify(result));
      check('2.1 (req 8) El titular guardado sí queda limpio (sin el sufijo "- <medio>"), pero eso es solo el titular, no el outlet',
        !!result && result.headline.indexOf('Totally Wrong Outlet Name') === -1, JSON.stringify(result));
      check('2.1 (req 14) Corta en el primer match real -- nunca resuelve el resultado siguiente',
        resolvedCalls.indexOf('https://laterdomain.example/story-nunca-debe-alcanzarse') === -1, JSON.stringify(resolvedCalls));
    });
  })()
    // 2.2 (req 14): tope de MAX_GOOGLE_NEWS_RESULTS_TO_CHECK (6) -- un
    // match real en la posición 7 nunca se llega a evaluar.
    .then(function () {
      var items = [];
      for (var i = 0; i < 6; i++) items.push(rssItemXml('Totally Unrelated Story Number ' + i, 'https://randomsite' + i + '.example/story', 'Nada que ver', PUB_RFC));
      items.push(rssItemXml('Solvex Dynamics Unveils Battery Recycling Platform For EVs', 'https://circuitdaily.com/solvex-story-7th', 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.', PUB_RFC));
      pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml(items)); };
      var calls = 0;
      pipeline.resolveSourceUrl = function (url) { calls++; return Promise.resolve({ reachable: true, finalUrl: url }); };
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        check('2.2 (req 14) Nunca inspecciona más de MAX_GOOGLE_NEWS_RESULTS_TO_CHECK (6) resultados', calls === 6, 'calls=' + calls);
        check('2.2 Un match real en la 7ma posición (fuera del tope) nunca se encuentra', outcome.source === null && outcome.failed === false, JSON.stringify(outcome));
      });
    })
    // 2.3 (req 6, req 12): sin red -- nunca inventa nada, nunca revienta,
    // y lo clasifica correctamente como failed:true/reason:'network'
    // (un Error genérico sin corroborationErrorCode cae en 'network' por
    // default).
    .then(function () {
      pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        check('2.3 (req 12) Sin red: nunca inventa una fuente, devuelve source:null sin lanzar', outcome.source === null);
        check('2.3 (req 6) Sin red: failed:true, reason:"network" (error genérico sin código explícito)', outcome.failed === true && outcome.reason === 'network', JSON.stringify(outcome));
      });
    })
    // 2.4: sin ningún resultado en el XML -- también da un resultado
    // "se buscó bien, no hay nada" limpio (failed:false).
    .then(function () {
      pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml([])); };
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        check('2.4 Sin resultados en Google News: source:null, failed:false (se buscó bien, de verdad no hay nada)', outcome.source === null && outcome.failed === false, JSON.stringify(outcome));
      });
    })
    // 2.5 (req 6): límite de tasa (HTTP 429) -- se clasifica como
    // failed:true/reason:'rate-limited', nunca bloquea ni inventa.
    .then(function () {
      var rateLimitError = new Error('429 Too Many Requests');
      rateLimitError.corroborationErrorCode = 'rate-limited';
      pipeline.fetchGoogleNewsRss = function () { return Promise.reject(rateLimitError); };
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        check('2.5 (req 6) Límite de tasa (429): source:null, failed:true, reason:"rate-limited"', outcome.source === null && outcome.failed === true && outcome.reason === 'rate-limited', JSON.stringify(outcome));
      });
    })
    // 2.6 (req 6): Google News devuelve HTML/XML inesperado -- parseFeedItems
    // revienta, y eso se clasifica como failed:true/reason:'parse-error',
    // nunca revienta hacia arriba ni inventa una fuente.
    .then(function () {
      pipeline.fetchGoogleNewsRss = function () { return Promise.resolve('<html>esto no es el XML esperado</html>'); };
      var originalParseFeedItems = feeds.parseFeedItems;
      feeds.parseFeedItems = function () { throw new Error('XML inesperado/mal formado'); };
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        feeds.parseFeedItems = originalParseFeedItems;
        check('2.6 (req 6) HTML/XML inesperado: source:null, failed:true, reason:"parse-error", nunca revienta', outcome.source === null && outcome.failed === true && outcome.reason === 'parse-error', JSON.stringify(outcome));
      }).catch(function (e) { feeds.parseFeedItems = originalParseFeedItems; throw e; });
    })
    // 2.7 (req 6): la búsqueda tarda demasiado (Google News nunca responde)
    // -- el presupuesto GLOBAL (GOOGLE_NEWS_OVERALL_TIMEOUT_MS) corta la
    // espera y devuelve failed:true/reason:'timeout' en vez de colgar el
    // panel indefinidamente. Se verifica con un límite de tiempo generoso
    // (20s) para no volver la prueba frágil por variación de máquina, pero
    // muy por debajo de "para siempre".
    .then(function () {
      pipeline.fetchGoogleNewsRss = function () { return new Promise(function () { /* nunca resuelve ni rechaza */ }); };
      var startedAt = Date.now();
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        var elapsedMs = Date.now() - startedAt;
        check('2.7 (req 6) Búsqueda que nunca responde: NO bloquea para siempre -- corta dentro de un presupuesto acotado (<20s)', elapsedMs < 20000, 'elapsedMs=' + elapsedMs);
        check('2.7 (req 6) Búsqueda que nunca responde: source:null, failed:true, reason:"timeout"', outcome.source === null && outcome.failed === true && outcome.reason === 'timeout', JSON.stringify(outcome));
      });
    })
    // 2.8 (req 7): aunque resolveSourceUrl NO logre resolver ninguna URL
    // final (finalUrl ausente/falsy) para el único resultado "parecido",
    // ese resultado se descarta enteramente -- nunca se usa r.link (el
    // link de news.google.com) como si fuera la URL final.
    .then(function () {
      var items = [
        rssItemXml('Solvex Dynamics Unveils Battery Recycling Platform For EVs', 'https://news.google.com/rss/articles/sin-resolver', 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.', PUB_RFC)
      ];
      pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml(items)); };
      pipeline.resolveSourceUrl = function () { return Promise.resolve({ reachable: true, finalUrl: null }); }; // no pudo seguir la redirección
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        check('2.8 (req 7) finalUrl ausente: se descarta el resultado, NUNCA se guarda el link de news.google.com como fuente', outcome.source === null && outcome.failed === false, JSON.stringify(outcome));
      });
    })
    // 2.9 (req 7): incluso si resolveSourceUrl devolviera, por algún motivo,
    // una finalUrl que sigue siendo de news.google.com (redirección que no
    // se pudo completar del todo), el chequeo explícito la descarta antes
    // que nada -- nunca llega a evaluarse como corroboración válida.
    .then(function () {
      var items = [
        rssItemXml('Solvex Dynamics Unveils Battery Recycling Platform For EVs', 'https://news.google.com/rss/articles/redireccion-incompleta', 'The company launched a new recycling platform this week aimed at electric vehicle batteries, the firm said Tuesday.', PUB_RFC)
      ];
      pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml(items)); };
      pipeline.resolveSourceUrl = function (url) { return Promise.resolve({ reachable: true, finalUrl: url }); }; // finalUrl sigue siendo news.google.com
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        check('2.9 (req 7) finalUrl todavía en news.google.com: se descarta explícitamente, jamás se guarda como fuente', outcome.source === null, JSON.stringify(outcome));
      });
    })
    // ==========================================================================
    // 2.10-2.13 (pedido de Leonardo, 2026-09-21, a raíz de la prueba manual
    // en Windows donde casi todas las tarjetas mostraban "descartada por
    // mismo dominio"): el diagnóstico de la capa 2 (Google News) tiene que
    // distinguir con precisión las 3 hipótesis que pidió -- (1) resultado
    // del MISMO dominio que la fuente original, (2) resultado que no se
    // pudo resolver hasta un dominio final, (3) ningún resultado -- sin
    // nunca exponer URLs ni texto de terceros, solo conteos y dominios.
    // ==========================================================================
    .then(function () {
      // 2.10 (hipótesis 1): Google News devuelve un resultado del MISMO
      // dominio que la fuente original -- se cuenta en discardedSameDomain,
      // el dominio SÍ aparece en domainsEvaluated (se evaluó, se descartó
      // por falta de independencia, no por no poder resolverlo).
      var items = [rssItemXml('Solvex Dynamics Launches New Battery Recycling Platform', 'https://news.google.com/rss/x1', 'x', PUB_RFC)];
      pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml(items)); };
      pipeline.resolveSourceUrl = function () { return Promise.resolve({ reachable: true, finalUrl: 'https://gridwire.io/same-story-elsewhere' }); };
      return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io').then(function (outcome) {
        var diag = outcome.diagnostic;
        check('2.10 (req diagnóstico, hipótesis 1) Resultado del mismo dominio: googleNewsResults:1, discardedSameDomain:1, resto en 0',
          diag.googleNewsResults === 1 && diag.discardedSameDomain === 1 && diag.discardedExcluded === 0 && diag.discardedUnresolved === 0 && diag.discardedNoMatch === 0,
          JSON.stringify(diag));
        check('2.10 El dominio descartado por ser el mismo SÍ figura en domainsEvaluated (se evaluó, no quedó sin resolver)', diag.domainsEvaluated.indexOf('gridwire.io') !== -1, JSON.stringify(diag));

        // 2.11 (hipótesis 2): Google News devuelve un resultado, pero el
        // resolvedor NUNCA logra llegar a un dominio final (finalUrl
        // ausente) -- se cuenta en discardedUnresolved, y ESE dominio NUNCA
        // puede figurar en domainsEvaluated (nunca se llegó a conocer).
        pipeline.resolveSourceUrl = function () { return Promise.resolve({ reachable: true, finalUrl: null }); };
        return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io');
      }).then(function (outcome) {
        var diag = outcome.diagnostic;
        check('2.11 (req diagnóstico, hipótesis 2) Resultado sin URL final resuelta: googleNewsResults:1, discardedUnresolved:1, resto en 0',
          diag.googleNewsResults === 1 && diag.discardedUnresolved === 1 && diag.discardedSameDomain === 0 && diag.discardedExcluded === 0 && diag.discardedNoMatch === 0,
          JSON.stringify(diag));
        check('2.11 Sin dominio final resuelto, domainsEvaluated queda vacío (nunca se llegó a saber de qué dominio era)', diag.domainsEvaluated.length === 0, JSON.stringify(diag));

        // 2.12 (hipótesis 3): Google News no devuelve ningún resultado --
        // el mensaje "no se encontró nada" es correcto en este caso, y el
        // diagnóstico lo confirma con googleNewsResults:0 (no null: SÍ se
        // pudo consultar y contar, la cuenta real fue cero).
        pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml([])); };
        return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io');
      }).then(function (outcome) {
        var diag = outcome.diagnostic;
        check('2.12 (req diagnóstico, hipótesis 3) Sin resultados de Google News: googleNewsResults:0 (contado, no "no disponible"), todos los descartes en 0',
          diag.googleNewsResults === 0 && diag.discardedSameDomain === 0 && diag.discardedExcluded === 0 && diag.discardedUnresolved === 0 && diag.discardedNoMatch === 0,
          JSON.stringify(diag));

        // 2.13: un resultado de un medio de verdad independiente, pero que
        // NO es la misma noticia (contenido distinto) -- discardedNoMatch,
        // para distinguirlo de "mismo dominio" y de "no se pudo resolver".
        // Además: agregador/comunicado (EXCLUDED_CORROBORATION_DOMAINS) se
        // cuenta aparte en discardedExcluded, nunca mezclado con "mismo
        // dominio" (son motivos distintos aunque ambos sean "no cuenta").
        var itemsMixed = [
          rssItemXml('Totally Unrelated Sports Score Update', 'https://news.google.com/rss/x2', 'Nada que ver con la historia', PUB_RFC),
          rssItemXml('Solvex Dynamics Launches New Battery Recycling Platform', 'https://news.google.com/rss/x3', 'Comunicado de prensa sindicado', PUB_RFC)
        ];
        pipeline.fetchGoogleNewsRss = function () { return Promise.resolve(rssXml(itemsMixed)); };
        pipeline.resolveSourceUrl = function (url) {
          if (url.indexOf('x2') !== -1) return Promise.resolve({ reachable: true, finalUrl: 'https://randomsite.example/sports' });
          return Promise.resolve({ reachable: true, finalUrl: 'https://businesswire.com/press-release' });
        };
        return pipeline.searchGoogleNewsForCorroboration(SOLVEX_A, 'gridwire.io');
      }).then(function (outcome) {
        var diag = outcome.diagnostic;
        check('2.13 (req diagnóstico) Un descarte por contenido distinto (discardedNoMatch:1) y otro por ser un distribuidor de comunicados (discardedExcluded:1), sin mezclarse entre sí ni con discardedSameDomain',
          diag.googleNewsResults === 2 && diag.discardedNoMatch === 1 && diag.discardedExcluded === 1 && diag.discardedSameDomain === 0 && diag.discardedUnresolved === 0,
          JSON.stringify(diag));
        check('2.13 domainsEvaluated incluye ambos dominios alcanzados (independientemente de por qué se descartaron)',
          diag.domainsEvaluated.indexOf('randomsite.example') !== -1 && diag.domainsEvaluated.indexOf('businesswire.com') !== -1, JSON.stringify(diag));
      });
    })
    // ==========================================================================
    // PARTE 3 -- findCorroborationForItem: orquesta las 2 capas
    // ==========================================================================
    .then(function () {
      var TARGET = Object.assign({ link: 'https://gridwire.io/story', domain: 'gridwire.io' }, SOLVEX_A);

      // 3.1 (req 2, req 14): si la capa 1 (feeds ya traídos) alcanza, la
      // capa 2 (Google News) NUNCA se llama -- no derrochar una consulta.
      var layer2Called = false;
      pipeline.searchGoogleNewsForCorroboration = function () { layer2Called = true; return Promise.resolve({ source: null, failed: false, reason: null }); };
      feeds.fetchAllFeedItems = function () {
        return Promise.resolve({ items: [Object.assign({ link: 'https://circuitdaily.com/solvex', domain: 'circuitdaily.com', outlet: 'Circuitdaily' }, SOLVEX_B_INDEPENDENT)], errors: [] });
      };
      return pipeline.findCorroborationForItem(TARGET).then(function (r1) {
        check('3.1 (req 17.1) Capa 1 (otro feed configurado) encuentra la corroboración real',
          !!r1.source && r1.source.url === 'https://circuitdaily.com/solvex' && r1.source.outlet === 'Circuitdaily', JSON.stringify(r1));
        check('3.1 (req 14) Con la capa 1 alcanzando, la capa 2 (Google News) nunca se invoca', layer2Called === false);
        check('3.1 rejectedSameDomain queda false cuando no hubo ningún rechazo por dominio', r1.sameDomainMatchWarning === false);
        check('3.1 (req 6) Sin haber pasado por la capa 2, searchFailed queda false', r1.searchFailed === false);

        // 3.2 (req 15): la capa 1 solo tiene un "casi" del MISMO dominio
        // (contenido parecido mas no independiente) -- debe rechazarse Y
        // dejar constancia (rejectedSameDomain:true), y ahí SÍ correspondre
        // pasar a la capa 2, que en este caso encuentra una fuente real.
        layer2Called = false;
        pipeline.searchGoogleNewsForCorroboration = function () {
          layer2Called = true;
          return Promise.resolve({
            source: { url: 'https://othersite.example/story', domain: 'othersite.example', outlet: 'Othersite', headline: 'x', publishedAt: isoDaysAgo(0), matchScore: 90, matchReasons: ['x'] },
            failed: false, reason: null
          });
        };
        feeds.fetchAllFeedItems = function () {
          return Promise.resolve({ items: [Object.assign({ link: 'https://gridwire.io/otra-nota-mismo-dominio', domain: 'gridwire.io', outlet: 'Gridwire' }, SOLVEX_B_INDEPENDENT)], errors: [] });
        };
        return pipeline.findCorroborationForItem(TARGET);
      }).then(function (r2) {
        check('3.2 (req 17.3, req 15) Capa 1 rechaza por MISMO dominio y lo señala (rejectedSameDomain:true)', r2.sameDomainMatchWarning === true, JSON.stringify(r2));
        check('3.2 (req 14) Al no alcanzar la capa 1, SÍ pasa a la capa 2 y usa lo que encuentra ahí', layer2Called === true && !!r2.source && r2.source.domain === 'othersite.example', JSON.stringify(r2));

        // 3.3 (req 17.7, req 12): nada en ninguna capa, y la búsqueda de la
        // capa 2 en sí falló (timeout) -- nunca se inventa, y el motivo del
        // fallo se propaga (req 6) para que el llamador pueda mostrarlo.
        pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: true, reason: 'timeout' }); };
        feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [], errors: [] }); };
        return pipeline.findCorroborationForItem(TARGET);
      }).then(function (r3) {
        check('3.3 (req 17.7, req 12) Sin corroboración en ninguna capa: source null, rejectedSameDomain false, nunca inventa', r3.source === null && r3.sameDomainMatchWarning === false, JSON.stringify(r3));
        check('3.3 (req 6) El motivo del fallo de la capa 2 se propaga tal cual (searchFailed:true, searchFailedReason:"timeout")', r3.searchFailed === true && r3.searchFailedReason === 'timeout', JSON.stringify(r3));
      });
    })
    // ==========================================================================
    // PARTE 4 -- buildCandidates(): la búsqueda activa (capa 2) integrada en
    // la corrida real, previa a la redacción (requisito 2, ubicación exacta)
    // ==========================================================================
    .then(function () {
      fs.writeFileSync(draftsPath, '[]\n', 'utf8');
      // PARTE 3 (3.2/3.3) dejó pipeline.searchGoogleNewsForCorroboration
      // reemplazada por un stub de prueba -- acá buildCandidates() necesita
      // la función REAL (que a su vez usa fetchGoogleNewsRss/resolveSourceUrl,
      // mockeadas más abajo), así que se restaura primero.
      pipeline.searchGoogleNewsForCorroboration = ORIGINAL.searchGoogleNewsForCorroboration;
      pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
      var PUB = isoDaysAgo(0);

      // Item A: sin corroboración en los demás feeds de esta corrida (capa
      // 1 no alcanza) -- la única forma de corroborar es la capa 2.
      feeds.fetchAllFeedItems = function () {
        return Promise.resolve({
          items: [{
            category: 'business', title: SOLVEX_A.title, summary: SOLVEX_A.summary,
            link: 'https://gridwire.io/2026/09/solvex-single-feed-item', pubDate: PUB, pubDateISO: PUB,
            image: '', author: '', domain: 'gridwire.io', outlet: 'Gridwire'
          }],
          errors: []
        });
      };
      pipeline.fetchGoogleNewsRss = function () {
        return Promise.resolve(rssXml([
          rssItemXml(SOLVEX_B_INDEPENDENT.title, 'https://circuitdaily.com/2026/09/solvex-via-google-news', SOLVEX_B_INDEPENDENT.summary, PUB_RFC)
        ]));
      };
      pipeline.resolveSourceUrl = function (url) { return Promise.resolve({ reachable: true, finalUrl: url }); };

      return pipeline.buildCandidates().then(function (built) {
        var solvexCandidate = built.candidates.find(function (c) { return c.domain === 'gridwire.io'; });
        check('4.1 (req 2, req 14) buildCandidates: sin corroboración en la capa 1, la capa 2 (Google News) SÍ corre y encuentra una fuente real',
          !!solvexCandidate && Array.isArray(solvexCandidate.corroboration) && solvexCandidate.corroboration.length === 1 &&
          solvexCandidate.corroboration[0].url === 'https://circuitdaily.com/2026/09/solvex-via-google-news',
          solvexCandidate && JSON.stringify(solvexCandidate.corroboration));

        // Segunda corrida: la capa 2 tampoco encuentra nada -- el candidato
        // sigue de fuente única, nunca se inventa una (requisito 12).
        fs.writeFileSync(draftsPath, '[]\n', 'utf8');
        pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };
        return pipeline.buildCandidates();
      }).then(function (builtNoCorroboration) {
        var lonelyCandidate = builtNoCorroboration.candidates.find(function (c) { return c.domain === 'gridwire.io'; });
        check('4.2 (req 17.7, req 12) buildCandidates: sin corroboración en ninguna capa, el candidato sigue de fuente única (nunca inventada)',
          !!lonelyCandidate && (!lonelyCandidate.corroboration || lonelyCandidate.corroboration.length === 0),
          lonelyCandidate && JSON.stringify(lonelyCandidate.corroboration));
      });
    })
    // ==========================================================================
    // PARTE 5 -- findAdditionalSourceForDraft(): botón manual "Buscar
    // segunda fuente" (requisito 16), MISMO criterio que la corrida automática
    // ==========================================================================
    .then(function () {
      var KESTREL = {
        title: 'Kestrel Robotics Wins New Manufacturing Contract',
        sourceHeadline: 'Kestrel Robotics Wins New Manufacturing Contract',
        dek: 'Kestrel Robotics announced it secured a multi-year manufacturing contract.',
        sourceUrl: 'https://byteledger.net/2026/09/kestrel-robotics-manufacturing-contract',
        sourceDomain: 'byteledger.net'
      };
      var draftAlreadyHasSource = Object.assign({}, KESTREL, {
        slug: 'draft-already-has-source', title: 'Kestrel Ya Tiene Fuente', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-20',
        additionalSources: [{ url: 'https://existing-source.example/nota', label: 'Existing Source' }], singleSourceWarning: false, createdAt: new Date().toISOString()
      });
      var draftFindable = Object.assign({}, KESTREL, {
        slug: 'draft-findable', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-20',
        additionalSources: [], singleSourceWarning: true, createdAt: new Date().toISOString()
      });
      // Título elegido para NO compartir ninguna palabra genérica capitalizada
      // (ni "New"/"Opens"/"Announces") con el fixture de Meridian de más abajo
      // -- entityWordSet compara PALABRAS de la entidad extraída, así que dos
      // títulos totalmente distintos que por casualidad empiecen ambos con un
      // verbo genérico en mayúscula ("Opens ...") podrían, si no se tiene
      // cuidado, registrar una "entidad compartida" espuria; acá se evita esa
      // coincidencia a propósito para aislar lo que esta prueba quiere medir
      // (que sin ninguna corroboración real disponible, nunca se inventa una).
      var draftNotFindable = {
        title: 'Ionix Labs Files Patent For Quantum Sensor Design', sourceHeadline: 'Ionix Labs Files Patent For Quantum Sensor Design',
        dek: 'Ionix Labs said it filed a patent application for a quantum sensor design.',
        sourceUrl: 'https://onlyoutlet.example/2026/09/ionix-labs-research-facility', sourceDomain: 'onlyoutlet.example',
        slug: 'draft-not-findable', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-20',
        additionalSources: [], singleSourceWarning: true, createdAt: new Date().toISOString()
      };
      // Historia DISTINTA de Kestrel a propósito (Meridian Freight Systems):
      // si usara la misma historia, el ítem independiente que corrobora a
      // "draftFindable" (más abajo) también la corroboraría a ella, y esta
      // sección dejaría de aislar lo que quiere probar (que el rechazo por
      // dominio/grupo ocurre incluso cuando el contenido SÍ es parecido).
      var draftSameDomainRejected = {
        title: 'Meridian Freight Systems Announces New Distribution Center',
        sourceHeadline: 'Meridian Freight Systems Announces New Distribution Center',
        dek: 'Meridian Freight Systems said it opened a new distribution center this week to expand its logistics network.',
        sourceUrl: 'https://byteledger.net/2026/09/meridian-freight-distribution-center',
        sourceDomain: 'byteledger.net',
        slug: 'draft-same-domain-rejected', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-20',
        additionalSources: [], singleSourceWarning: true, createdAt: new Date().toISOString()
      };
      fs.writeFileSync(draftsPath, JSON.stringify([draftAlreadyHasSource, draftFindable, draftNotFindable, draftSameDomainRejected], null, 2) + '\n', 'utf8');
      var draftsBefore = fs.readFileSync(draftsPath, 'utf8');

      // Capa 1: cubre a "draftFindable" (Kestrel) con un medio independiente
      // real; a "draftSameDomainRejected" (Meridian) solo con el MISMO
      // dominio de su propia fuente (byteledger.net); nada para
      // "draftNotFindable".
      feeds.fetchAllFeedItems = function () {
        return Promise.resolve({
          items: [
            { title: 'Kestrel Robotics Secures New Manufacturing Deal With Industrial Partner', summary: 'Kestrel Robotics announced Wednesday it secured a multi-year manufacturing contract with an industrial client.', link: 'https://independentwire.example/kestrel-contract', domain: 'independentwire.example', outlet: 'Independentwire', pubDateISO: isoDaysAgo(0) },
            { title: 'Meridian Freight Systems Opens New Distribution Center', summary: 'Meridian Freight Systems announced it opened a new distribution center this week to expand its logistics network.', link: 'https://byteledger.net/2026/09/meridian-otro-articulo-relacionado', domain: 'byteledger.net', outlet: 'Byteledger', pubDateISO: isoDaysAgo(0) }
          ],
          errors: []
        });
      };
      pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };

      return pipeline.findAdditionalSourceForDraft('draft-already-has-source').then(function (rAlready) {
        check('5.1 (req 16) alreadyHadSource: devuelve found:false/alreadyHadSource:true sin tocar el archivo', rAlready.ok === true && rAlready.found === false && rAlready.alreadyHadSource === true, JSON.stringify(rAlready));
        check('5.1 alreadyHadSource: drafts.json queda BYTE A BYTE igual (nunca se reescribe)', fs.readFileSync(draftsPath, 'utf8') === draftsBefore);

        return pipeline.findAdditionalSourceForDraft('draft-findable');
      }).then(function (rFound) {
        check('5.2 (req 16, req 17.1) Encuentra una fuente real independiente y la agrega', rFound.ok === true && rFound.found === true && rFound.draft.additionalSources.length === 1 && rFound.draft.additionalSources[0].url === 'https://independentwire.example/kestrel-contract', JSON.stringify(rFound));
        check('5.2 singleSourceWarning pasa a false tras encontrar una fuente real', rFound.draft.singleSourceWarning === false);
        var onDisk = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
        var persisted = onDisk.find(function (d) { return d.slug === 'draft-findable'; });
        check('5.2 El resultado quedó persistido en drafts.json', !!persisted && persisted.additionalSources.length === 1);
        // Requisito 3 (pedido de Leonardo, 2026-09-21, "dos medios
        // independientes válidos"): cuando hay una corroboración real, la
        // advertencia de mismo dominio queda en false -- las dos señales
        // (corroboración real vs. advertencia de capa 1) nunca se confunden.
        check('5.2 (req 3) Con dos medios independientes reales, sameDomainMatchWarning queda en false (nunca se confunde con una advertencia)', persisted.sameDomainMatchWarning === false, JSON.stringify(persisted.sameDomainMatchWarning));

        return pipeline.findAdditionalSourceForDraft('draft-same-domain-rejected');
      }).then(function (rRejected) {
        check('5.3 (req 17.3, req 15) Rechaza por mismo dominio y lo señala (corroborationRejectedSameDomain no aplica a este draft directamente, pero el resultado SÍ lo indica)',
          rRejected.ok === true, JSON.stringify(rRejected));
        var onDiskRejected = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
        var persistedRejected = onDiskRejected.find(function (d) { return d.slug === 'draft-same-domain-rejected'; });
        check('5.3 (req 12) NUNCA inventa una fuente del mismo dominio -- additionalSources sigue vacío', !!persistedRejected && persistedRejected.additionalSources.length === 0);
        check('5.3 (req 15) Deja constancia de que hubo un candidato descartado por dominio (corroborationRejectedSameDomain:true)', !!persistedRejected && persistedRejected.sameDomainMatchWarning === true, JSON.stringify(persistedRejected));
        // Requisito 6, de punta a punta a través del botón manual: la capa 2
        // tampoco pudo completarse (fetchGoogleNewsRss rechaza en esta
        // parte), así que el motivo del fallo real ("network") tiene que
        // llegar hasta acá para que admin.js pueda mostrar un mensaje
        // distinto de "no se encontró nada".
        check('5.3 (req 6) El fallo real de la capa 2 (sin red) se propaga hasta el resultado del botón manual', rRejected.searchFailed === true && rRejected.searchFailedReason === 'network', JSON.stringify(rRejected));
        // Pedido de Leonardo, 2026-09-21: cuando la búsqueda falló, el
        // diagnóstico persistido en el borrador tiene que reflejar eso
        // (googleNewsResults:null, "no disponible") y nunca inventar
        // conteos -- nunca debería verse un 0 donde en realidad no se pudo
        // ni consultar.
        check('5.3 (req diagnóstico) El diagnóstico persistido en el borrador refleja el fallo real (googleNewsResults:null, sin conteos inventados)',
          !!persistedRejected.corroborationDiagnostic && persistedRejected.corroborationDiagnostic.googleNewsResults === null &&
          persistedRejected.corroborationSearchFailed === true && persistedRejected.corroborationSearchFailedReason === 'network',
          JSON.stringify(persistedRejected.corroborationDiagnostic));

        return pipeline.findAdditionalSourceForDraft('draft-not-findable');
      }).then(function (rNotFound) {
        check('5.4 (req 17.7, req 12) Sin ninguna corroboración disponible: found:false, nunca inventa', rNotFound.ok === true && rNotFound.found === false, JSON.stringify(rNotFound));
        var onDiskNotFound = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
        var persistedNotFound = onDiskNotFound.find(function (d) { return d.slug === 'draft-not-findable'; });
        check('5.4 additionalSources sigue vacío -- nunca inventa una fuente', !!persistedNotFound && persistedNotFound.additionalSources.length === 0);
        check('5.4 (req 6) También propaga el motivo del fallo real de la capa 2 (sin red -> "network")', rNotFound.searchFailed === true && rNotFound.searchFailedReason === 'network', JSON.stringify(rNotFound));

        // 5.4b (req diagnóstico, de punta a punta con resultados reales):
        // ahora Google News SÍ responde, con un resultado del mismo dominio
        // y otro que no coincide en contenido -- el diagnóstico persistido
        // en el borrador (no solo el valor de retorno de la función) tiene
        // que traer los conteos reales de ESTA corrida.
        pipeline.fetchGoogleNewsRss = function () {
          return Promise.resolve(rssXml([
            rssItemXml('Ionix Labs Files Patent For Quantum Sensor Design', 'https://news.google.com/rss/y1', 'x', PUB_RFC),
            rssItemXml('Totally Different News About Something Else', 'https://news.google.com/rss/y2', 'x', PUB_RFC)
          ]));
        };
        pipeline.resolveSourceUrl = function (url) {
          if (url.indexOf('y1') !== -1) return Promise.resolve({ reachable: true, finalUrl: 'https://onlyoutlet.example/otra-nota' }); // mismo dominio que la fuente de este draft
          return Promise.resolve({ reachable: true, finalUrl: 'https://thirdoutlet.example/nota-sin-relacion' });
        };
        return pipeline.findAdditionalSourceForDraft('draft-not-findable');
      }).then(function (rNotFound2) {
        check('5.4b (req 17.7, req 12) Sigue sin encontrar una fuente real: found:false, additionalSources vacío', rNotFound2.ok === true && rNotFound2.found === false, JSON.stringify(rNotFound2));
        var onDisk = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
        var persisted = onDisk.find(function (d) { return d.slug === 'draft-not-findable'; });
        var diag = persisted && persisted.corroborationDiagnostic;
        check('5.4b (req diagnóstico) El diagnóstico persistido trae los conteos reales de esta corrida: 2 resultados, 1 mismo dominio, 1 sin coincidir',
          !!diag && diag.googleNewsResults === 2 && diag.discardedSameDomain === 1 && diag.discardedNoMatch === 1 && diag.discardedExcluded === 0 && diag.discardedUnresolved === 0,
          JSON.stringify(diag));
        check('5.4b (req diagnóstico) Nunca URLs en domainsEvaluated, solo nombres de dominio', diag.domainsEvaluated.every(function (dom) { return dom.indexOf('/') === -1 && dom.indexOf('https') === -1; }), JSON.stringify(diag.domainsEvaluated));
        check('5.4b El diagnóstico VIEJO (de la corrida anterior, sin red) quedó reemplazado por el de ahora, no acumulado', persisted.corroborationSearchFailed === false && persisted.corroborationSearchFailedReason === null, JSON.stringify(persisted.corroborationSearchFailed));

        return pipeline.findAdditionalSourceForDraft('slug-que-no-existe');
      }).then(function (rMissing) {
        check('5.5 Slug inexistente: ok:false con un error explicable', rMissing.ok === false && !!rMissing.error, JSON.stringify(rMissing));
      });
    })
    // ==========================================================================
    // PARTE 5B -- sameDomainMatchWarning se RECALCULA por completo en cada
    // corrida (pedido de Leonardo, 2026-09-21, tras encontrar que el campo
    // viejo -- corroborationRejectedSameDomain -- solo podía prenderse y
    // nunca apagarse). Un mismo borrador se procesa VARIAS veces con
    // distintas condiciones de la capa 1 cada vez, para probar que el
    // campo sigue SIEMPRE a la corrida más reciente, nunca se acumula.
    // ==========================================================================
    .then(function () {
      var LIFECYCLE = {
        title: 'Vantera Systems Wins New Cloud Contract',
        sourceHeadline: 'Vantera Systems Wins New Cloud Contract',
        dek: 'Vantera Systems announced it secured a multi-year cloud infrastructure contract.',
        sourceUrl: 'https://primawire.example/2026/09/vantera-cloud-contract',
        sourceDomain: 'primawire.example',
        slug: 'draft-samedomain-lifecycle', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-21',
        additionalSources: [], singleSourceWarning: true, createdAt: new Date().toISOString()
      };
      fs.writeFileSync(draftsPath, JSON.stringify([LIFECYCLE], null, 2) + '\n', 'utf8');
      pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); }; // aísla esta prueba de la capa 2 -- lo que se prueba acá es solo la capa 1

      // Corrida 1: la capa 1 SÍ tiene un "casi" del mismo dominio/grupo que
      // la fuente de este borrador (primawire.example) -- el flag arranca
      // en "no seteado" (borrador recién creado) y esta corrida lo deja en
      // true por primera vez ("nueva coincidencia del mismo dominio").
      feeds.fetchAllFeedItems = function () {
        return Promise.resolve({
          items: [{ title: 'Vantera Systems Secures New Cloud Infrastructure Deal', summary: 'Vantera Systems said it secured a multi-year cloud infrastructure contract this week.', link: 'https://primawire.example/2026/09/otra-nota-mismo-dominio', domain: 'primawire.example', outlet: 'Primawire', pubDateISO: isoDaysAgo(0) }],
          errors: []
        });
      };
      return pipeline.findAdditionalSourceForDraft('draft-samedomain-lifecycle').then(function (run1) {
        check('5B.1 (req 6, "nueva coincidencia del mismo dominio") Corrida 1: la capa 1 encuentra un candidato del mismo dominio -- sameDomainMatchWarning pasa a true', run1.draft.sameDomainMatchWarning === true, JSON.stringify(run1.draft.sameDomainMatchWarning));
        check('5B.1 Sigue sin una fuente real -- nunca se inventa una', run1.found === false && run1.draft.additionalSources.length === 0);

        // Corrida 2: la capa 1 YA NO tiene ningún candidato del mismo
        // dominio (el feed pool cambió) -- el flag tiene que RECALCULARSE
        // a false, no quedar pegado en true de la corrida anterior
        // (requisitos 1-2, "flag inicialmente verdadero y luego
        // recalculado a falso").
        feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [], errors: [] }); };
        return pipeline.findAdditionalSourceForDraft('draft-samedomain-lifecycle');
      }).then(function (run2) {
        check('5B.2 (req 1-2, "recalculado a falso") Corrida 2: sin ningún candidato del mismo dominio esta vez -- sameDomainMatchWarning vuelve a false, no queda pegado en true', run2.draft.sameDomainMatchWarning === false, JSON.stringify(run2.draft.sameDomainMatchWarning));
        var onDisk2 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
        var persisted2 = onDisk2.find(function (d) { return d.slug === 'draft-samedomain-lifecycle'; });
        check('5B.2 El valor persistido en disco también quedó en false (no es solo el valor de retorno)', persisted2.sameDomainMatchWarning === false, JSON.stringify(persisted2.sameDomainMatchWarning));

        // Corrida 3 ("borrador procesado varias veces"): vuelve a aparecer
        // un candidato del mismo dominio -- el flag tiene que poder
        // prenderse de nuevo sin ningún problema (no es un interruptor de
        // una sola vez en ningún sentido).
        feeds.fetchAllFeedItems = function () {
          return Promise.resolve({
            items: [{ title: 'Vantera Systems Secures New Cloud Infrastructure Deal', summary: 'Vantera Systems said it secured a multi-year cloud infrastructure contract this week.', link: 'https://primawire.example/2026/09/una-tercera-nota-mismo-dominio', domain: 'primawire.example', outlet: 'Primawire', pubDateISO: isoDaysAgo(0) }],
            errors: []
          });
        };
        return pipeline.findAdditionalSourceForDraft('draft-samedomain-lifecycle');
      }).then(function (run3) {
        check('5B.3 (req 6, "borrador procesado varias veces") Corrida 3: vuelve a aparecer un candidato del mismo dominio -- sameDomainMatchWarning vuelve a true sin problemas', run3.draft.sameDomainMatchWarning === true, JSON.stringify(run3.draft.sameDomainMatchWarning));

        // Requisito 4: en NINGUNA de las 3 corridas el puntaje editorial
        // cambió por causa de esta advertencia -- classifyDraft() nunca la
        // usa en computeEditorialReadiness (solo additionalSources/
        // singleSourceWarning afectan el puntaje).
        var tierRun1 = pipeline.classifyDraft(Object.assign({}, run3.draft, { sameDomainMatchWarning: true }));
        var tierRun2 = pipeline.classifyDraft(Object.assign({}, run3.draft, { sameDomainMatchWarning: false }));
        check('5B.4 (req 4) El puntaje editorial es IDÉNTICO con sameDomainMatchWarning true o false -- nunca suma ni resta puntos',
          tierRun1.editorialReadinessScore === tierRun2.editorialReadinessScore, JSON.stringify({ conTrue: tierRun1.editorialReadinessScore, conFalse: tierRun2.editorialReadinessScore }));
      });
    })
    // ==========================================================================
    // 5C ("una noticia distinta que comparte vocabulario", pedido de
    // Leonardo 2026-09-21): un candidato de un dominio DE VERDAD
    // independiente que comparte vocabulario superficial pero es otra
    // historia -- nunca debe activar sameDomainMatchWarning (ese campo es
    // EXCLUSIVAMENTE para candidatos rechazados por falta de independencia
    // de dominio/grupo, nunca por simple similitud de contenido).
    // ==========================================================================
    .then(function () {
      var VOCAB = {
        title: 'Orbital Freight Reports Quarterly Earnings Beat',
        sourceHeadline: 'Orbital Freight Reports Quarterly Earnings Beat',
        dek: 'Orbital Freight posted stronger than expected quarterly earnings.',
        sourceUrl: 'https://logiwire.example/2026/09/orbital-freight-earnings',
        sourceDomain: 'logiwire.example',
        slug: 'draft-vocab-different-story', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-21',
        additionalSources: [], singleSourceWarning: true, createdAt: new Date().toISOString()
      };
      fs.writeFileSync(draftsPath, JSON.stringify([VOCAB], null, 2) + '\n', 'utf8');
      pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };
      // Mismo vocabulario general ("Orbital Freight", "quarterly") pero
      // otra historia (apertura de depósito, no resultados trimestrales) y
      // de un dominio TOTALMENTE independiente (no del mismo grupo).
      feeds.fetchAllFeedItems = function () {
        return Promise.resolve({
          items: [{ title: 'Orbital Freight Opens New Quarterly Storage Facility', summary: 'Orbital Freight opened a new storage facility this quarter to expand its warehouse network.', link: 'https://distinctoutlet.example/orbital-storage', domain: 'distinctoutlet.example', outlet: 'Distinctoutlet', pubDateISO: isoDaysAgo(0) }],
          errors: []
        });
      };
      return pipeline.findAdditionalSourceForDraft('draft-vocab-different-story').then(function (r) {
        check('5C (req "noticia distinta que comparte vocabulario") No encuentra una fuente real -- es otra historia, no la misma noticia', r.found === false && r.draft.additionalSources.length === 0, JSON.stringify(r));
        check('5C sameDomainMatchWarning queda en false -- el candidato era de un dominio independiente, el rechazo fue por CONTENIDO distinto, no por dominio', r.draft.sameDomainMatchWarning === false, JSON.stringify(r.draft.sameDomainMatchWarning));
      });
    })
    // ==========================================================================
    // PARTE 6 -- fetchNewDrafts() de punta a punta + classifyDraft (requisito
    // 18: al menos un candidato sintético llega a "listo", los dudosos
    // siguen en revisión) -- vía el MECANISMO REAL, no additionalSources
    // puesto a mano (eso ya lo cubre test-editorial-readiness-scoring.js)
    // ==========================================================================
    .then(function () {
      fs.writeFileSync(draftsPath, '[]\n', 'utf8');
      var PUB = isoDaysAgo(0);
      pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
      pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); }; // fuerza a Kestrel a depender solo de la capa 1, que no lo cubre
      feeds.fetchAllFeedItems = function () {
        return Promise.resolve({
          items: [
            { category: 'business', title: SOLVEX_A.title, summary: SOLVEX_A.summary, link: 'https://gridwire.io/2026/09/solvex-dynamics-battery-recycling-platform', pubDate: PUB, pubDateISO: PUB, image: '', author: '', domain: 'gridwire.io', outlet: 'Gridwire' },
            { category: 'business', title: SOLVEX_B_INDEPENDENT.title, summary: SOLVEX_B_INDEPENDENT.summary, link: 'https://circuitdaily.com/2026/09/solvex-dynamics-platform-details', pubDate: PUB, pubDateISO: PUB, image: '', author: '', domain: 'circuitdaily.com', outlet: 'Circuitdaily' },
            { category: 'business', title: 'Kestrel Robotics Wins New Manufacturing Contract', summary: 'Kestrel Robotics announced Wednesday it secured a multi-year manufacturing contract with an industrial client.', link: 'https://byteledger.net/2026/09/kestrel-robotics-manufacturing-contract', pubDate: PUB, pubDateISO: PUB, image: '', author: '', domain: 'byteledger.net', outlet: 'Byteledger' }
          ],
          errors: []
        });
      };
      draft.loadConfig = function () { return { draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }; };
      // Cuerpo/título redactados SIN retomar frases de la fuente (a
      // propósito, para no disparar el chequeo anti-copia -- ver
      // verbatimOverlapRatio/maxSentenceSimilarity en pipeline.js) y con
      // estructura propia (2 subtítulos) para poder alcanzar el puntaje
      // completo cuando de verdad hay 2 fuentes independientes.
      draft.draftArticle = function (item, cfg, categoryOptions, sourcesForPrompt) {
        var isSolvex = item.link.indexOf('gridwire.io') !== -1;
        return Promise.resolve({
          title: isSolvex ? 'Empresa de reciclaje de baterías anuncia expansión de planta' : 'Fabricante de robótica industrial firma contrato plurianual',
          dek: 'Cobertura editorial redactada de forma completamente independiente para esta prueba automatizada, sin retomar frases de la fuente original.',
          // Cuerpo actualizado 2026-09-24 (pedido de aporte editorial
          // verificable, punto 2): además de no retomar frases de la fuente,
          // ahora también necesita >=3 de los 10 elementos de
          // EDITORIAL_VALUE_ELEMENT_DETECTORS (pipeline.js) para que este
          // candidato -- que sí tiene corroboración real de 2 fuentes --
          // pueda seguir llegando a readinessTier "listo" bajo la nueva
          // regla combinada. Las frases en inglés de abajo son deliberadas
          // (los detectores son heurísticos de palabras clave en inglés,
          // igual que el resto del sitio) y genéricas para no coincidir
          // textualmente con SOLVEX_A.summary/SOLVEX_B_INDEPENDENT.summary.
          //
          // Cuerpo ampliado de nuevo 2026-09-27 (pedido de validación de
          // calidad de redacción, punto 5): la nueva validateDraftWritingQuality()
          // exige >=600 palabras, >=3 subtítulos "## " y al menos una
          // atribución ENLAZADA (<a href=...>) en el cuerpo -- el cuerpo
          // corto de 2 subtítulos sin ningún link que tenía esta prueba
          // hasta ahora empezó a caer en insufficientWritingQuality (revisar)
          // aun con las 2 fuentes reales que sí prueba esta sección. Se
          // extiende el relleno (siempre sin retomar frases de las fuentes,
          // sin repetir una misma oración dos veces -- ver
          // detectExcessiveSelfRepetition -- y sin ninguna referencia
          // ambigua tipo "his teammate") a 3 subtítulos y un link de
          // atribución, para que esta sección siga probando lo que le
          // corresponde (corroboración -> "listo") sin quedar bloqueada por
          // un chequeo de redacción que es ortogonal a lo que mide acá.
          body: 'Texto de cuerpo redactado de forma independiente para esta prueba automatizada, con contenido de relleno variado y suficiente extensión para superar cualquier mínimo de palabras exigido por las validaciones del sitio, evitando cualquier coincidencia textual con el resumen original consultado. The recycling division has operated since 2019, according to public filings reviewed for this coverage. Internal planning material referenced by two people familiar with the matter describes a multi-year expansion timeline that predates this specific announcement by several fiscal quarters, though neither document was made public before this report. A separate regulatory filing submitted earlier this year outlined capital expenditure plans broadly consistent with the scale described in this announcement, giving additional context to the scope of the project beyond what either company disclosed directly this week. Company representatives declined to comment further beyond the prepared statement issued alongside the announcement, and no additional financial terms were disclosed in either public filing reviewed for this coverage.\n\n## Contexto del sector\nEsta sección aporta contexto adicional sobre la industria en la que opera la empresa mencionada, sin copiar el texto original de la fuente consultada para esta cobertura. Compared to its previous pilot line, the newly announced facility represents a large jump in processing capacity, and this could affect suppliers across the wider recycling industry. Analysts who track the battery materials sector, as noted in <a href="https://industry-tracker.example/battery-recycling-outlook">a widely cited industry report</a>, have pointed to rising demand for recovered lithium and cobalt as a driver behind similar investments announced by competitors over the past eighteen months. That broader trend offers useful context for evaluating how this specific project fits into the sector\'s overall trajectory, independent of any claims made by the company itself in its own announcement. Similar expansions announced elsewhere in the sector over the same period have followed a comparable pattern, with construction typically beginning within two quarters of an initial announcement and full operational capacity reached roughly eighteen months later, according to the same industry analysis.\n\n## Impacto para la industria\nEsta tercera sección examina las consecuencias probables de la expansión para otros actores del mercado, redactada también de forma independiente. Suppliers of specialized recycling equipment could see increased order volume if the expansion proceeds on the timeline described, while logistics providers serving the surrounding industrial corridor may need to adjust routing to accommodate additional shipments. Smaller regional recyclers, meanwhile, may face pressure to consolidate or specialize further as larger facilities capture a growing share of processing volume, a pattern that has played out in adjacent segments of the materials recovery industry over the past several years. None of these downstream effects were addressed directly in either company statement reviewed for this coverage. Trade groups representing independent recyclers have previously flagged consolidation as an ongoing concern in public comments submitted to regulators, though none have issued a statement specific to this particular announcement as of this writing.\n\n## Próximos pasos\nEsta última sección describe qué se espera que ocurra a continuación, también redactada de forma independiente y con vocabulario distinto al de la nota original. Next steps include a public walkthrough of the finished site later this year, though the exact date remains unclear. Local officials have indicated that permitting reviews tied to the expansion are proceeding on a normal schedule, without any of the delays that have affected comparable projects elsewhere in the region. A formal update on staffing plans and expected completion is anticipated in a subsequent quarterly filing, which would offer the next concrete checkpoint for tracking the project\'s progress. A representative for the surrounding municipality said no additional public hearings are currently scheduled beyond the standard review process already underway, and no objections have been filed to date.',
          category: item.category,
          readTime: '3 min',
          keyClaims: [{ claim: 'Se anunció una novedad relevante para la empresa.', sourceLabel: sourcesForPrompt.primary.outlet }].concat(
            sourcesForPrompt.additional.length ? [{ claim: 'La segunda fuente confirmó el mismo hecho de forma independiente.', sourceLabel: sourcesForPrompt.additional[0].outlet }] : []
          )
        });
      };

      return pipeline.fetchNewDrafts().then(function (fetchResult) {
        // Pedido de Leonardo, 2026-09-23 (pipeline de 2 fases, requisito 5):
        // "una noticia con una sola fuente NO debe enviarse a la IA" -- antes
        // de ese pedido, Kestrel (una sola fuente) SÍ se redactaba igual (ver
        // el comentario/prueba vieja en el historial de este archivo); ahora
        // se queda en singleSourceCandidates y solo Solvex (con corroboración
        // real) gasta una redacción.
        check('6.1 fetchNewDrafts: agregó solo el candidato con corroboración real (Solvex) -- Kestrel (una sola fuente) NUNCA se manda a la IA',
          fetchResult.added === 1 && fetchResult.aiCallsMade === 1 && fetchResult.noApiKey === false, JSON.stringify(fetchResult));
        check('6.1 (req 15) candidatesWithTwoSources cuenta a Solvex, no a Kestrel', fetchResult.candidatesWithTwoSources === 1, JSON.stringify(fetchResult.candidatesWithTwoSources));

        var draftsOnDisk = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
        var solvexDraft = draftsOnDisk.find(function (d) { return d.sourceUrl.indexOf('gridwire.io') !== -1; });
        var kestrelDraft = draftsOnDisk.find(function (d) { return d.sourceUrl.indexOf('byteledger.net') !== -1; });

        check('6.2 (req 17.1, req 9) Solvex: additionalSources trae la fuente REAL encontrada por el mecanismo (no inventada), con motivo/puntaje',
          !!solvexDraft && solvexDraft.additionalSources.length === 1 && solvexDraft.additionalSources[0].url === 'https://circuitdaily.com/2026/09/solvex-dynamics-platform-details' &&
          typeof solvexDraft.additionalSources[0].matchScore === 'number' && Array.isArray(solvexDraft.additionalSources[0].matchReasons) && solvexDraft.additionalSources[0].matchReasons.length > 0,
          solvexDraft && JSON.stringify(solvexDraft.additionalSources));
        check('6.2 Solvex: singleSourceWarning es false', !!solvexDraft && solvexDraft.singleSourceWarning === false);
        check('6.2 (req 5, req 20) Kestrel: NUNCA llega a existir como borrador (una sola fuente no se redacta)', !kestrelDraft, JSON.stringify(kestrelDraft));
        check('6.2 (req 20) Kestrel aparece en singleSourceCandidates con título/resumen/enlace, para revisión manual',
          Array.isArray(fetchResult.singleSourceCandidates) &&
          fetchResult.singleSourceCandidates.some(function (c) { return c.link.indexOf('byteledger.net') !== -1 && c.title.indexOf('Kestrel') !== -1 && !!c.summary; }),
          JSON.stringify(fetchResult.singleSourceCandidates));

        var tierSolvex = pipeline.classifyDraft(solvexDraft);
        check('6.3 (req 18) Con corroboración real de punta a punta, el candidato SÍ llega a readinessTier "listo"',
          tierSolvex.readinessTier === 'listo' && tierSolvex.editorialReadinessScore >= 80, JSON.stringify({ score: tierSolvex.editorialReadinessScore, tier: tierSolvex.readinessTier, reasons: tierSolvex.readinessReasons }));
        check('6.3 (req 11) Esto exige TAMBIÉN cero advertencias, no solo 2 fuentes -- eligibleToUse/recommendation en verde', tierSolvex.eligibleToUse === true && tierSolvex.recommendation === 'crear');
        check('6.4 (req 15) readyCount/needsReviewCount de esta corrida reflejan solo a Solvex (listo), Kestrel nunca cuenta acá (no se redactó)',
          fetchResult.readyCount === 1 && fetchResult.needsReviewCount === 0, JSON.stringify(fetchResult));

        // Requisito 19: honestidad -- esto depende de que existan fuentes
        // independientes reales para la noticia del día, nunca se promete
        // que "Solo listos" tenga siempre contenido. Se deja constancia acá
        // de que ese es justamente el comportamiento verificado (Kestrel, con
        // un texto tan bueno como Solvex, ni siquiera llega a redactarse
        // SOLO porque no había una segunda fuente real disponible -- y nunca
        // se le inventó una para forzarlo a pasar).
        check('6.5 (req 19, documental) Ningún mecanismo automático "inventó" una segunda fuente para que Kestrel pasara a redacción', !kestrelDraft);
      });
    })
    .then(function () {
      restoreAll();
      fs.writeFileSync(draftsPath, '[]\n', 'utf8');
    })
    // ==========================================================================
    // PARTE 7 -- ruta real del servidor: POST /api/drafts/find-source
    // (requisito 16, wiring real de server.js -- sin red real: el único
    // camino determinista de punta a punta contra un subproceso real es el
    // short-circuit alreadyHadSource, que nunca depende de la red; la
    // lógica de búsqueda en sí ya quedó probada en profundidad en las
    // PARTEs 1-5 contra el propio módulo, en el mismo proceso)
    // ==========================================================================
    .then(function () {
      var draftWithSource = {
        title: 'Draft Con Fuente Ya Cargada', slug: 'draft-http-already-has-source', category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-20',
        dek: 'x', body: 'x', sourceUrl: 'https://example.com/x', sourceTitle: 'Example', sourceHeadline: 'x', sourceDomain: 'example.com',
        additionalSources: [{ url: 'https://otra-fuente.example/nota', label: 'Otra Fuente' }], singleSourceWarning: false, createdAt: new Date().toISOString()
      };
      fs.writeFileSync(draftsPath, JSON.stringify([draftWithSource], null, 2) + '\n', 'utf8');

      const PORT = 4332; // puerto propio, distinto del resto de las suites (4321-4331)
      var serverPath = path.join(adminDir, 'server.js');
      var src = fs.readFileSync(serverPath, 'utf8');
      src = src.replace('const PORT = 4321;', 'const PORT = ' + PORT + ';');
      fs.writeFileSync(serverPath, src);

      var child = spawn(process.execPath, [serverPath], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      var serverOutput = '';
      child.stdout.on('data', function (d) { serverOutput += d.toString(); });
      child.stderr.on('data', function (d) { serverOutput += d.toString(); });
      function waitForServer(url, tries) {
        tries = tries || 60;
        return fetch(url).then(function () { return true; }).catch(function (e) {
          if (tries <= 0) throw e;
          return sleep(150).then(function () { return waitForServer(url, tries - 1); });
        });
      }
      var base = 'http://127.0.0.1:' + PORT;
      return waitForServer(base + '/').then(function () {
        return fetch(base + '/api/drafts/find-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      }).then(function (resMissingSlug) {
        check('7.1 POST /api/drafts/find-source sin slug: 400', resMissingSlug.status === 400, 'status=' + resMissingSlug.status);

        return fetch(base + '/api/drafts/find-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'slug-que-no-existe' }) });
      }).then(function (resUnknownSlug) {
        check('7.2 POST /api/drafts/find-source con un slug inexistente: 404', resUnknownSlug.status === 404, 'status=' + resUnknownSlug.status);
        return resUnknownSlug.json();
      }).then(function (bodyUnknown) {
        check('7.2 El cuerpo del 404 trae ok:false con un error explicable', bodyUnknown.ok === false && !!bodyUnknown.error, JSON.stringify(bodyUnknown));

        return fetch(base + '/api/drafts/find-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'draft-http-already-has-source' }) });
      }).then(function (resAlready) {
        check('7.3 POST /api/drafts/find-source sobre un borrador que YA tiene fuente: 200', resAlready.status === 200, 'status=' + resAlready.status);
        return resAlready.json();
      }).then(function (bodyAlready) {
        check('7.3 El cuerpo confirma alreadyHadSource:true (short-circuit real, sin red)', bodyAlready.ok === true && bodyAlready.found === false && bodyAlready.alreadyHadSource === true, JSON.stringify(bodyAlready));
        // Regresión cerrada (pedido de Leonardo, 2026-09-23, "factores
        // vacíos de Ver por qué"): admin.js REEMPLAZA la tarjeta entera por
        // este mismo result.draft (ver draftsData.map en admin.js) -- antes
        // de este fix, result.draft NUNCA traía "risk" (eso antes solo lo
        // calculaba GET /api/drafts), así que la insignia de puntaje y "Ver
        // por qué" desaparecían de la tarjeta hasta el próximo refresco
        // completo. Ahora server.js calcula risk acá mismo, con classifyDraft
        // real -- nunca queda vacío ni ausente.
        check('7.4 (req 21) El borrador que vuelve por HTTP YA trae "risk" calculado (antes faltaba por completo)',
          !!bodyAlready.draft && !!bodyAlready.draft.risk, JSON.stringify(bodyAlready.draft && bodyAlready.draft.risk));
        check('7.4 (req 21) "risk.readinessReasons" no viene vacío -- siempre hay al menos un factor explicado',
          !!bodyAlready.draft && !!bodyAlready.draft.risk && Array.isArray(bodyAlready.draft.risk.readinessReasons) && bodyAlready.draft.risk.readinessReasons.length > 0,
          bodyAlready.draft && JSON.stringify(bodyAlready.draft.risk && bodyAlready.draft.risk.readinessReasons));
        check('7.4 (req 21) "risk.editorialReadinessScore" es un número real, no undefined',
          !!bodyAlready.draft && typeof bodyAlready.draft.risk.editorialReadinessScore === 'number');
        child.kill();
        return sleep(300);
      }).catch(function (e) {
        console.error('Salida del servidor de prueba:\n' + serverOutput.slice(-2000));
        try { child.kill(); } catch (e2) {}
        throw e;
      });
    })
  );

  // ==========================================================================
  // PARTE 8 -- el sitio real (sandbox) nunca se tocó
  // ==========================================================================
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('8. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('8. El sitio real (sandbox) sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos, sin cambios (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('8. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR FATAL durante las pruebas:', e);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e2) {}
  fail++;
  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(1);
});
