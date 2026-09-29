#!/usr/bin/env node
/*
  admin/test-source-provenance.js
  ================================
  Pedido real de Leonardo (2026-09-20, "mejora global" post-Nscale): que
  una noticia traída por RSS llegue con casi todo lo necesario para una
  revisión rápida, en vez de tener que completar fuentes a mano cada vez
  (eso fue justo el bug de Nscale que motivó este trabajo).

  Qué se agregó (ver el informe entregado a Leonardo para el detalle
  completo de causa/diseño/archivos):
    1. admin/feeds.js ahora extrae, además de título/resumen/link/fecha/
       imagen: autor (si el feed lo trae), dominio, nombre del medio
       ("outlet") y una versión CANÓNICA del link (sin parámetros de
       tracking) -- así dos links a la misma nota con distinto
       "?utm_source=..." se reconocen como la misma fuente.
    2. admin/pipeline.js buildCandidates() ya NO tira el link/medio de un
       duplicado real (misma historia, otro feed) -- antes solo se
       incrementaba un contador (sourceCount); ahora queda una
       corroboración real (URL+medio+fecha) en item.corroboration, que es
       lo que llena additionalSources SOLO con fuentes reales (nunca
       inventadas -- requisito 6 del pedido).
    3. admin/pipeline.js checkUrlReachable() confirma que la fuente
       primaria todavía responde ANTES de redactar nada -- un link roto
       (404/410/dominio caído) nunca llega a convertirse en borrador
       (requisito 10). Se expone también /api/check-source para
       verificar a mano una fuente cargada/editada manualmente.
    4. admin/draft.js le pide a la IA que embeba atribución real
       (<a href="URL">Medio</a>) para cifras/fechas/citas/cargos/planes, y
       que no presente un comunicado propio como si confirmara un rumor
       externo reportado por otro medio (requisito 5) -- y devuelve hasta
       5 "keyClaims" (afirmación + de qué fuente salió) para la ficha de
       revisión rápida del panel (requisito 7).
    5. admin/pipeline.js fetchNewDrafts() ahora guarda sourceTitle como el
       NOMBRE DEL MEDIO (antes guardaba el título original por error --
       ver sourceHeadline, que es donde ahora vive el título original),
       más sourceDomain/sourceAuthor/sourcePublishedAt/sourceRetrievedAt/
       additionalSources/singleSourceWarning/keyClaims (requisitos 1-2).
    6. classifyDraft()/validateSourcesAndQuality() avisan (advertencia,
       NUNCA bloqueo) cuando solo hay una fuente, y cuando el texto usa
       lenguaje de reporte no confirmado con una sola fuente registrada
       (requisitos 5-6).
    7. admin/index.html + admin/admin.js: ficha de revisión rápida
       (fuente principal + adicionales con fecha/autor, keyClaims, imagen/
       licencia, resumen de riesgo/controles) y botón "Verificar fuente"
       bajo demanda (requisito 7 y parte manual del 10). Los campos sin
       control propio (sourceHeadline/sourceDomain/sourceAuthor/
       sourcePublishedAt/sourceRetrievedAt/keyClaims) viajan por
       buildArticleFromForm() para sobrevivir todos los guardados
       (requisito 3) -- SOLO cuando hay algo real que guardar, para no
       agregarle claves vacías a artículos viejos (ej. Nscale) que nunca
       tuvieron esta procedencia con solo abrirlos y re-guardarlos.

  Todo corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox
  real ni la carpeta del usuario) y sobre servidores HTTP locales de
  prueba (nunca contra internet real) -- ni las llamadas de red
  (checkUrlReachable) ni la redacción con IA (draft.draftArticle) tocan
  nada externo: la segunda se reemplaza por una función de prueba
  (monkeypatch sobre el mismo objeto module.exports que ya tiene
  cacheado admin/pipeline.js -- ver notas en el propio código de
  pipeline.js sobre por qué se llama a través de module.exports).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { try { return sha256(fs.readFileSync(p)); } catch (e) { return null; } }
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

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-source-provenance-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

async function main() {
  // ==========================================================================
  // PARTE 1 -- feeds.js: helpers puros (sin red)
  // ==========================================================================
  const feeds = require(path.join(adminDir, 'feeds.js'));

  check('1. canonicalizeUrl saca parámetros de tracking',
    feeds.canonicalizeUrl('https://Example.com/nota/?utm_source=rss&utm_medium=feed&id=42') === 'https://example.com/nota?id=42',
    feeds.canonicalizeUrl('https://Example.com/nota/?utm_source=rss&utm_medium=feed&id=42'));
  check('1. canonicalizeUrl da el MISMO resultado sin importar el orden de los params restantes',
    feeds.canonicalizeUrl('https://x.com/a?b=2&a=1') === feeds.canonicalizeUrl('https://x.com/a?a=1&b=2'));
  check('1. canonicalizeUrl saca el fragment (#...)',
    feeds.canonicalizeUrl('https://x.com/a#section') === 'https://x.com/a');
  check('1. canonicalizeUrl no rompe con una URL rara/no absoluta (devuelve tal cual)',
    feeds.canonicalizeUrl('no-es-una-url') === 'no-es-una-url');

  check('1. domainFromUrl saca "www." y pasa a minúsculas',
    feeds.domainFromUrl('https://WWW.TechCrunch.com/2026/x') === 'techcrunch.com');

  check('1. outletNameFromDomain usa el nombre conocido cuando existe',
    feeds.outletNameFromDomain('techcrunch.com') === 'TechCrunch');
  check('1. outletNameFromDomain arma un nombre razonable para un dominio nuevo (sin inventar otra cosa)',
    feeds.outletNameFromDomain('example-news.com') === 'Example News');

  const sampleRss = [
    '<rss><channel>',
    '<item>',
    '<title>Empresa X anuncia una ronda de <![CDATA[inversión]]></title>',
    '<link>https://techcrunch.com/2026/09/18/empresa-x-ronda/?utm_source=rss&utm_medium=feed</link>',
    '<dc:creator>Jane Reporter</dc:creator>',
    '<description>Resumen de la noticia de ejemplo.</description>',
    '<pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate>',
    '</item>',
    '</channel></rss>'
  ].join('');
  const parsedItems = feeds.parseFeedItems(sampleRss);
  check('1. parseFeedItems extrae domain/outlet/author/pubDateISO además de lo de siempre',
    parsedItems.length === 1 &&
    parsedItems[0].domain === 'techcrunch.com' &&
    parsedItems[0].outlet === 'TechCrunch' &&
    parsedItems[0].author === 'Jane Reporter' &&
    parsedItems[0].pubDateISO === new Date('Fri, 18 Sep 2026 12:00:00 GMT').toISOString(),
    JSON.stringify(parsedItems[0]));
  check('1. parseFeedItems ya devuelve el link CANÓNICO (sin utm_*)',
    parsedItems[0] && parsedItems[0].link === 'https://techcrunch.com/2026/09/18/empresa-x-ronda',
    parsedItems[0] && parsedItems[0].link);

  const atomSample = [
    '<feed>',
    '<entry>',
    '<title>Nota en formato Atom</title>',
    '<link href="https://www.theverge.com/2026/nota-atom"/>',
    '<author><name>John Doe</name></author>',
    '<summary>Resumen atom.</summary>',
    '<updated>2026-09-19T10:00:00Z</updated>',
    '</entry>',
    '</feed>'
  ].join('');
  const atomItems = feeds.parseFeedItems(atomSample);
  check('1. parseFeedItems soporta Atom (<author><name>) y outlet correcto',
    atomItems.length === 1 && atomItems[0].author === 'John Doe' && atomItems[0].outlet === 'The Verge',
    JSON.stringify(atomItems[0]));

  // ==========================================================================
  // PARTE 2 -- pipeline.checkUrlReachable: red real, pero solo a un
  // servidor HTTP local de prueba (nunca a internet)
  // ==========================================================================
  const pipeline = require(path.join(adminDir, 'pipeline.js'));

  const probeServer = http.createServer(function (req, res) {
    if (req.url === '/ok') { res.writeHead(200); return res.end('ok'); }
    if (req.url === '/not-found') { res.writeHead(404); return res.end('nope'); }
    if (req.url === '/gone') { res.writeHead(410); return res.end('gone'); }
    if (req.url === '/redirect-to-ok') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
    if (req.url === '/head-not-allowed') {
      if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
      res.writeHead(200); return res.end('ok via get');
    }
    res.writeHead(200); res.end('default');
  });
  await new Promise(function (resolve) { probeServer.listen(0, '127.0.0.1', resolve); });
  const probePort = probeServer.address().port;
  const probeBase = 'http://127.0.0.1:' + probePort;

  // Revisión de seguridad 2026-09-20 (SSRF, pedido de Leonardo): ahora
  // checkUrlReachable() bloquea 127.0.0.1 DE VERDAD por ser una dirección
  // privada/loopback (ver test-check-url-security.js para la batería
  // completa de esa protección). Como este entorno de pruebas no tiene
  // acceso a red pública real, estas pruebas de comportamiento de
  // checkUrlReachable() (200/404/410/redirect/HEAD->GET) necesitan un
  // servidor real igual, así que acá se trata 127.0.0.1 puntualmente como
  // si fuera pública -- SOLO en esta sección y restaurando el clasificador
  // real apenas termina -- para poder seguir probando la lógica de
  // reachability sin tocar la protección SSRF en sí (esa se prueba aparte,
  // sin este bypass, en test-check-url-security.js).
  const originalIsPrivateOrReservedIPForProbe = pipeline.isPrivateOrReservedIP;
  pipeline.isPrivateOrReservedIP = function (ip) {
    if (ip === '127.0.0.1') return false;
    return originalIsPrivateOrReservedIPForProbe(ip);
  };

  const rOk = await pipeline.checkUrlReachable(probeBase + '/ok');
  check('2. checkUrlReachable: 200 -> reachable:true', rOk.reachable === true, JSON.stringify(rOk));

  const r404 = await pipeline.checkUrlReachable(probeBase + '/not-found');
  check('2. checkUrlReachable: 404 -> reachable:false (fuente muerta de verdad)', r404.reachable === false, JSON.stringify(r404));

  const r410 = await pipeline.checkUrlReachable(probeBase + '/gone');
  check('2. checkUrlReachable: 410 -> reachable:false', r410.reachable === false, JSON.stringify(r410));

  const rRedirect = await pipeline.checkUrlReachable(probeBase + '/redirect-to-ok');
  check('2. checkUrlReachable: sigue un redirect hasta el 200 final', rRedirect.reachable === true, JSON.stringify(rRedirect));

  const rHeadFallback = await pipeline.checkUrlReachable(probeBase + '/head-not-allowed');
  check('2. checkUrlReachable: si HEAD da 405, reintenta con GET antes de concluir nada', rHeadFallback.reachable === true, JSON.stringify(rHeadFallback));

  const rRefused = await pipeline.checkUrlReachable('http://127.0.0.1:1/nadie-escucha-aca');
  check('2. checkUrlReachable: conexión rechazada (dominio/puerto que no responde) -> reachable:false', rRefused.reachable === false, JSON.stringify(rRefused));

  pipeline.isPrivateOrReservedIP = originalIsPrivateOrReservedIPForProbe;
  await new Promise(function (resolve) { probeServer.close(resolve); });

  // ==========================================================================
  // PARTE 3 -- buildCandidates(): corroboración real (no solo un contador)
  // ==========================================================================
  const originalFetchAllFeedItems = feeds.fetchAllFeedItems;
  const originalCheckUrlReachable = pipeline.checkUrlReachable;
  // Se reemplaza por module.exports (mismo objeto que ya tiene cacheado
  // pipeline.js vía require) -- así buildCandidates() usa esta versión sin
  // red real, determinística, sin tener que levantar un feed RSS de mentira.
  pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
  // Corroboración previa a la redacción (2026-09-20): buildCandidates()
  // ahora intenta Google News RSS para el candidato de Beta (sin corroborar
  // por los feeds de este fixture) -- se simula "sin red" para no depender
  // de la red pública real (este sandbox no tiene salida a internet) ni
  // volver este test lento/flaky.
  const originalFetchGoogleNewsRss = pipeline.fetchGoogleNewsRss;
  pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };

  const NOW = new Date();
  function isoDaysAgo(days) { return new Date(NOW.getTime() - days * 86400000).toISOString(); }

  feeds.fetchAllFeedItems = function () {
    return Promise.resolve({
      items: [
        {
          category: 'ai', title: 'Empresa Acme lanza su nuevo chip de IA',
          summary: 'Acme anunció su nuevo chip especializado en inferencia.',
          link: 'https://techcrunch.com/2026/acme-chip', pubDate: isoDaysAgo(1), pubDateISO: isoDaysAgo(1),
          image: '', author: 'Jane Reporter', domain: 'techcrunch.com', outlet: 'TechCrunch'
        },
        // Misma historia, otro medio -- esto es lo que antes se perdía
        // (solo quedaba como sourceCount++), ahora debe quedar como
        // corroboración real con su URL/medio propios.
        {
          category: 'ai', title: 'Acme presenta un chip de inteligencia artificial nuevo',
          summary: 'La empresa Acme presentó hoy su chip especializado en inferencia de IA.',
          link: 'https://venturebeat.com/2026/acme-chip-details', pubDate: isoDaysAgo(1), pubDateISO: isoDaysAgo(1),
          image: '', author: '', domain: 'venturebeat.com', outlet: 'VentureBeat'
        },
        // Historia sin ninguna corroboración -- debe quedar single-source.
        {
          category: 'technology', title: 'Startup Beta cierra una ronda semilla',
          summary: 'Beta anunció que cerró una ronda semilla de financiamiento.',
          link: 'https://theverge.com/2026/beta-ronda', pubDate: isoDaysAgo(1), pubDateISO: isoDaysAgo(1),
          image: '', author: '', domain: 'theverge.com', outlet: 'The Verge'
        }
      ],
      errors: []
    });
  };

  const built = await pipeline.buildCandidates();
  const acmeCandidate = built.candidates.find(function (c) { return c.link === 'https://techcrunch.com/2026/acme-chip'; });
  const betaCandidate = built.candidates.find(function (c) { return c.link === 'https://theverge.com/2026/beta-ronda'; });
  check('3. buildCandidates: la historia cubierta por 2 feeds queda con sourceCount 2', !!acmeCandidate && acmeCandidate.sourceCount === 2, acmeCandidate && acmeCandidate.sourceCount);
  check('3. buildCandidates: la corroboración es REAL (URL/medio de VentureBeat), no solo un número',
    !!acmeCandidate && Array.isArray(acmeCandidate.corroboration) && acmeCandidate.corroboration.length === 1 &&
    acmeCandidate.corroboration[0].url === 'https://venturebeat.com/2026/acme-chip-details' &&
    acmeCandidate.corroboration[0].outlet === 'VentureBeat',
    acmeCandidate && JSON.stringify(acmeCandidate.corroboration));
  check('3. buildCandidates: la historia de una sola fuente NO tiene corroboración inventada',
    !!betaCandidate && (!betaCandidate.corroboration || betaCandidate.corroboration.length === 0),
    betaCandidate && JSON.stringify(betaCandidate.corroboration));

  // Fuente muerta: nunca debe convertirse en candidato.
  // Caché técnica de 24hs (pedido de Leonardo, 2026-09-23, ver
  // pipeline.CANDIDATE_CACHE_FILE): la corrida de buildCandidates() de
  // arriba ya dejó a beta-ronda cacheado (sin corroboración) -- se limpia
  // acá para que ESTA corrida evalúe theverge.com de cero, como si fuera un
  // día distinto, en vez de saltárselo por la caché de la corrida anterior.
  fs.writeFileSync(path.join(dataDir, 'candidate-cache.json'), '{}\n', 'utf8');
  pipeline.checkUrlReachable = function (url) {
    if (url.indexOf('theverge.com') !== -1) return Promise.resolve({ reachable: false, status: 404 });
    return Promise.resolve({ reachable: true });
  };
  const builtWithDeadLink = await pipeline.buildCandidates();
  check('3. buildCandidates: un link que no responde NUNCA llega a ser candidato (nunca se redacta)',
    !builtWithDeadLink.candidates.some(function (c) { return c.domain === 'theverge.com'; }));
  check('3. buildCandidates: cuenta el descarte en filteredCounts.unreachable',
    builtWithDeadLink.filteredCounts.unreachable === 1, JSON.stringify(builtWithDeadLink.filteredCounts));

  pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
  // Misma razón que arriba: se limpia la caché técnica para que PARTE 4
  // evalúe ambas URLs de cero (nunca saltear por lo que quedó cacheado de
  // las corridas de PARTE 3).
  fs.writeFileSync(path.join(dataDir, 'candidate-cache.json'), '{}\n', 'utf8');

  // ==========================================================================
  // PARTE 4 -- fetchNewDrafts(): de punta a punta (sin red real para la IA)
  // ==========================================================================
  const draft = require(path.join(adminDir, 'draft.js'));
  const originalDraftArticle = draft.draftArticle;
  const originalLoadConfig = draft.loadConfig;
  draft.loadConfig = function () { return { draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }; };
  var capturedSourcesForPromptByLink = {};
  draft.draftArticle = function (item, cfg, categoryOptions, sourcesForPrompt) {
    capturedSourcesForPromptByLink[item.link] = sourcesForPrompt;
    return Promise.resolve({
      title: 'Título redactado de prueba para ' + item.title,
      dek: 'Dek redactado de prueba.',
      body: 'Cuerpo de prueba con contenido suficiente para pasar validaciones básicas de longitud, repetido varias veces para sumar palabras reales y variadas sobre el tema tratado en este artículo de ejemplo generado automáticamente por la prueba automatizada del pipeline de redacción.',
      category: item.category,
      readTime: '3 min',
      keyClaims: [{ claim: 'Acme lanzó un chip nuevo.', sourceLabel: 'TechCrunch' }, { claim: 'El chip está especializado en inferencia.', sourceLabel: 'VentureBeat' }]
    });
  };

  const fetchResult = await pipeline.fetchNewDrafts();
  check('4. fetchNewDrafts: no reporta noApiKey (la config de prueba tiene una key)', fetchResult.noApiKey === false, JSON.stringify(fetchResult));
  // Pedido de Leonardo, 2026-09-23 (requisito 5 del pipeline de 2 fases):
  // "una noticia con una sola fuente NO debe enviarse a la IA" -- antes de
  // ese pedido, Beta (una sola fuente) SÍ se redactaba igual; ahora se
  // queda en singleSourceCandidates y solo Acme (con corroboración real)
  // gasta una redacción.
  check('4. fetchNewDrafts: agregó solo el borrador con corroboración real (Acme) -- Beta (una sola fuente) NUNCA se manda a la IA',
    fetchResult.added === 1 && fetchResult.aiCallsMade === 1, JSON.stringify(fetchResult));
  check('4. Beta (una sola fuente) aparece en singleSourceCandidates, nunca como borrador',
    Array.isArray(fetchResult.singleSourceCandidates) &&
    fetchResult.singleSourceCandidates.some(function (c) { return c.link === 'https://theverge.com/2026/beta-ronda'; }),
    JSON.stringify(fetchResult.singleSourceCandidates));

  const draftsOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'drafts.json'), 'utf8'));
  const acmeDraft = draftsOnDisk.find(function (d) { return d.sourceUrl === 'https://techcrunch.com/2026/acme-chip'; });
  const betaDraft = draftsOnDisk.find(function (d) { return d.sourceUrl === 'https://theverge.com/2026/beta-ronda'; });
  check('4. Beta (una sola fuente) NUNCA llega a existir como borrador en disco', !betaDraft, JSON.stringify(betaDraft));

  check('4. sourceTitle pasa a ser el NOMBRE DEL MEDIO (no el título original -- ese es sourceHeadline)',
    !!acmeDraft && acmeDraft.sourceTitle === 'TechCrunch', acmeDraft && acmeDraft.sourceTitle);
  check('4. sourceHeadline conserva el título ORIGINAL de la fuente',
    !!acmeDraft && acmeDraft.sourceHeadline === 'Empresa Acme lanza su nuevo chip de IA', acmeDraft && acmeDraft.sourceHeadline);
  check('4. sourceDomain quedó registrado', !!acmeDraft && acmeDraft.sourceDomain === 'techcrunch.com');
  check('4. sourceAuthor quedó registrado cuando el feed lo traía', !!acmeDraft && acmeDraft.sourceAuthor === 'Jane Reporter');
  check('4. sourcePublishedAt quedó registrado', !!acmeDraft && !!acmeDraft.sourcePublishedAt);
  check('4. sourceRetrievedAt (fecha de consulta) es un timestamp reciente de esta corrida',
    !!acmeDraft && Math.abs(new Date(acmeDraft.sourceRetrievedAt).getTime() - Date.now()) < 60000, acmeDraft && acmeDraft.sourceRetrievedAt);
  check('4. additionalSources trae la fuente REAL que corroboró (VentureBeat), no una inventada',
    !!acmeDraft && acmeDraft.additionalSources.length === 1 &&
    acmeDraft.additionalSources[0].url === 'https://venturebeat.com/2026/acme-chip-details' &&
    acmeDraft.additionalSources[0].label === 'VentureBeat',
    acmeDraft && JSON.stringify(acmeDraft.additionalSources));
  check('4. singleSourceWarning es false cuando hay corroboración real', acmeDraft && acmeDraft.singleSourceWarning === false);
  check('4. keyClaims de la IA se guardan tal cual (hasta 5, con su fuente)',
    !!acmeDraft && acmeDraft.keyClaims.length === 2 && acmeDraft.keyClaims[0].sourceLabel === 'TechCrunch');
  var capturedForAcme = capturedSourcesForPromptByLink['https://techcrunch.com/2026/acme-chip'];
  check('4. draft.draftArticle recibió la lista de fuentes reales para poder atribuir en el cuerpo',
    !!capturedForAcme && capturedForAcme.primary.url === 'https://techcrunch.com/2026/acme-chip' &&
    capturedForAcme.additional.length === 1 && capturedForAcme.additional[0].url === 'https://venturebeat.com/2026/acme-chip-details',
    JSON.stringify(capturedForAcme));

  draft.draftArticle = originalDraftArticle;
  draft.loadConfig = originalLoadConfig;
  feeds.fetchAllFeedItems = originalFetchAllFeedItems;
  pipeline.checkUrlReachable = originalCheckUrlReachable;
  pipeline.fetchGoogleNewsRss = originalFetchGoogleNewsRss;
  // Limpiar los borradores sintéticos para no interferir con lo que sigue.
  fs.writeFileSync(path.join(dataDir, 'drafts.json'), '[]\n', 'utf8');

  // ==========================================================================
  // PARTE 5 -- classifyDraft() / validateSourcesAndQuality(): advertencias,
  // nunca bloqueos
  // ==========================================================================
  const singleSourceDraft = { title: 'x', dek: 'y', body: 'Texto normal sin lenguaje de rumor.', category: 'ai', additionalSources: [], singleSourceWarning: true };
  const corroboratedDraft = { title: 'x', dek: 'y', body: 'Texto normal sin lenguaje de rumor.', category: 'ai', additionalSources: [{ url: 'https://x.com', label: 'X' }], singleSourceWarning: false };
  const rumorSingleSourceDraft = { title: 'x', dek: 'y', body: 'The company is reportedly planning an IPO soon.', category: 'ai', additionalSources: [], singleSourceWarning: true };

  const clsSingle = pipeline.classifyDraft(singleSourceDraft);
  check('5. classifyDraft: fuente única -> recomendación "revisar" (nunca "descartar")', clsSingle.recommendation === 'revisar', JSON.stringify(clsSingle));
  check('5. classifyDraft: fuente única sigue siendo eligibleToUse:true (advertencia, no bloqueo)', clsSingle.eligibleToUse === true);
  check('5. classifyDraft: fuente única aparece explícita en reasons', clsSingle.reasons.some(function (r) { return /una sola fuente/i.test(r); }), JSON.stringify(clsSingle.reasons));

  const clsCorroborated = pipeline.classifyDraft(corroboratedDraft);
  check('5. classifyDraft: con corroboración real, recomendación "crear" (sin advertencia de fuente única)', clsCorroborated.recommendation === 'crear', JSON.stringify(clsCorroborated));

  const clsRumor = pipeline.classifyDraft(rumorSingleSourceDraft);
  check('5. classifyDraft: lenguaje de rumor + una sola fuente -> aviso específico de comunicado-vs-rumor',
    clsRumor.reasons.some(function (r) { return /reporte no confirmado/i.test(r); }), JSON.stringify(clsRumor.reasons));
  check('5. classifyDraft: ese aviso NUNCA bloquea el uso', clsRumor.eligibleToUse === true);

  const svArticleSingle = { title: 'x', dek: 'y', body: 'Texto normal.', category: 'ai', sourceUrl: 'https://x.com', additionalSources: [] };
  const svResultSingle = pipeline.validateSourcesAndQuality(svArticleSingle, []);
  check('6. validateSourcesAndQuality: fuente única -> warning (no issue) en additionalSources',
    svResultSingle.issues.length === 0 && svResultSingle.warnings.some(function (w) { return w.field === 'additionalSources'; }),
    JSON.stringify(svResultSingle));

  const svArticleMulti = { title: 'x', dek: 'y', body: 'Texto normal.', category: 'ai', sourceUrl: 'https://x.com', additionalSources: [{ url: 'https://y.com', label: 'Y' }] };
  const svResultMulti = pipeline.validateSourcesAndQuality(svArticleMulti, []);
  check('6. validateSourcesAndQuality: con fuente adicional real, SIN warning de fuente única',
    !svResultMulti.warnings.some(function (w) { return w.field === 'additionalSources'; }), JSON.stringify(svResultMulti));

  // Caso Nscale real (fixture del segmento anterior, ver
  // test-sources-merge-fix.fixture-nscale.json -- el artículo real
  // corregido, con sourceUrl + TechCrunch como fuente adicional; el
  // sandbox local nunca tuvo este registro en su propio articulos.json,
  // solo el dispositivo real lo tiene desde esa sincronización) -- debe
  // seguir sin ninguna advertencia de fuente única/rumor, sin inventar
  // nada nuevo.
  const realArticles = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
  const nscaleReal = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-sources-merge-fix.fixture-nscale.json'), 'utf8'));
  check('6. Setup: el fixture de Nscale tiene sus fuentes reales intactas (sourceUrl + TechCrunch)',
    !!nscaleReal.sourceUrl && nscaleReal.additionalSources && nscaleReal.additionalSources.length === 1);
  const svNscale = pipeline.validateSourcesAndQuality(nscaleReal, realArticles.concat([nscaleReal]));
  check('6. validateSourcesAndQuality sobre Nscale real: SIN warning de fuente única (ya tiene TechCrunch)',
    !svNscale.warnings.some(function (w) { return w.field === 'additionalSources'; }), JSON.stringify(svNscale.warnings));
  check('6. validateSourcesAndQuality sobre Nscale real: sigue sin ningún issue bloqueante', svNscale.issues.length === 0, JSON.stringify(svNscale.issues));

  // ==========================================================================
  // PARTE 6 -- draft.js: formatSourcesBlock / sanitizeKeyClaims (puras)
  // ==========================================================================
  const block = draft.formatSourcesBlock({ link: 'https://a.com', category: 'ai' }, { primary: { url: 'https://a.com', outlet: 'A' }, additional: [{ url: 'https://b.com', outlet: 'B' }] });
  check('7. formatSourcesBlock incluye la fuente primaria con su url exacta', block.indexOf('https://a.com') !== -1 && block.indexOf('"A"') !== -1);
  check('7. formatSourcesBlock incluye la fuente adicional', block.indexOf('https://b.com') !== -1 && block.indexOf('"B"') !== -1);
  const blockNoAdditional = draft.formatSourcesBlock({ link: 'https://a.com' }, { primary: { url: 'https://a.com', outlet: 'A' }, additional: [] });
  check('7. formatSourcesBlock avisa explícitamente cuando no hay corroboración (para que la IA no la invente)',
    /no invente/i.test(blockNoAdditional) || /not invent/i.test(blockNoAdditional) || /No additional corroborating/.test(blockNoAdditional));

  check('7. sanitizeKeyClaims descarta entradas sin "claim"', draft.sanitizeKeyClaims([{ sourceLabel: 'x' }, { claim: 'ok', sourceLabel: 'y' }]).length === 1);
  check('7. sanitizeKeyClaims corta a un máximo de 5', draft.sanitizeKeyClaims([1, 2, 3, 4, 5, 6, 7].map(function (n) { return { claim: 'c' + n }; })).length === 5);
  check('7. sanitizeKeyClaims usa "context" cuando no viene sourceLabel', draft.sanitizeKeyClaims([{ claim: 'algo' }])[0].sourceLabel === 'context');
  check('7. sanitizeKeyClaims con entrada no-array devuelve []', Array.isArray(draft.sanitizeKeyClaims('no soy un array')) && draft.sanitizeKeyClaims(null).length === 0);

  // ==========================================================================
  // PARTE 7 -- integración real de panel (servidor real + DOM real):
  // ficha de revisión rápida + botón "Verificar fuente"
  // ==========================================================================
  const PORT = 4329; // puerto propio, distinto de las demás suites (4322/4324/4325/4326/4327)
  {
    const serverPath = path.join(adminDir, 'server.js');
    let src = fs.readFileSync(serverPath, 'utf8');
    src = src.replace('const PORT = 4321;', 'const PORT = ' + PORT + ';');
    fs.writeFileSync(serverPath, src);
  }
  // El botón "Verificar fuente" de esta sección llama a /api/check-source
  // DENTRO del proceso hijo (servidor real spawneado abajo), contra un
  // servidor de prueba en 127.0.0.1 -- con la protección SSRF real eso
  // ahora se bloquearía (127.0.0.1 es una dirección privada de verdad, y
  // es justo lo correcto en producción). Como el proceso hijo es un
  // proceso Node aparte, no se lo puede monkeypatchear desde acá con una
  // asignación directa -- se usa "-r" para precargar un script chiquito,
  // solo dentro de esta copia aislada de prueba, que trata 127.0.0.1 (y
  // solo esa dirección puntual) como pública ANTES de que server.js
  // requiera pipeline.js (mismo objeto module.exports cacheado por
  // require, así que el parche queda visible para todo el proceso). El
  // archivo real admin/pipeline.js del sitio real NO se toca ni se
  // debilita -- esto es puramente para poder correr esta prueba de UI
  // contra un servidor local real en vez de contra internet.
  const allowLoopbackPreloadPath = path.join(tmpRoot, 'test-allow-loopback-preload.js');
  fs.writeFileSync(allowLoopbackPreloadPath, [
    "const pipeline = require(" + JSON.stringify(path.join(adminDir, 'pipeline.js')) + ");",
    "const original = pipeline.isPrivateOrReservedIP;",
    "pipeline.isPrivateOrReservedIP = function (ip) { if (ip === '127.0.0.1') return false; return original(ip); };"
  ].join('\n'));
  const child = spawn(process.execPath, ['-r', allowLoopbackPreloadPath, path.join(adminDir, 'server.js')], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  child.stdout.on('data', function (d) { serverOutput += d.toString(); });
  child.stderr.on('data', function (d) { serverOutput += d.toString(); });
  function waitForServer(url, tries) {
    tries = tries || 40;
    return fetch(url).then(function () { return true; }).catch(function (e) {
      if (tries <= 0) throw e;
      return sleep(150).then(function () { return waitForServer(url, tries - 1); });
    });
  }
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  var base = 'http://127.0.0.1:' + PORT;

  // Servidor de prueba local para el botón "Verificar fuente" (nunca
  // internet real): una URL que responde, otra que no.
  const uiProbe = http.createServer(function (req, res) {
    if (req.url === '/viva') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(404); res.end('no');
  });
  await new Promise(function (resolve) { uiProbe.listen(0, '127.0.0.1', resolve); });
  const uiProbePort = uiProbe.address().port;

  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse: function (win) {
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = function (url, opts) { return fetch(new URL(url, win.location.href).toString(), opts); };
    }
  });
  const { window } = dom;
  window.addEventListener('error', function () {});
  const doc = window.document;

  var loaded = false;
  for (var i = 0; i < 60; i++) {
    await sleep(200);
    if (doc.querySelectorAll('.admin-item').length > 100) { loaded = true; break; }
  }
  check('8. Setup: el panel real (DOM real) terminó de cargar', loaded, 'admin-item=' + doc.querySelectorAll('.admin-item').length);

  // Lo que hace falta probar es que renderQuickReviewCard() reacciona a
  // datos reales cargados en el formulario (mismo resultado final que si
  // vinieran de "Usar este borrador", que puebla estos mismos campos) --
  // se completan a mano, igual que lo haría una persona escribiendo, y se
  // disparan los eventos reales que ya escucha admin.js.
  await window.eval('document.querySelector(\'.admin-tab[data-tab="articles"]\').click();');
  await window.eval([
    'document.getElementById("articleSourceUrl").value = "https://techcrunch.com/prueba";',
    'document.getElementById("articleSourceUrl").dispatchEvent(new Event("input", {bubbles:true}));',
    'document.getElementById("articleSourceTitle").value = "TechCrunch";',
    'document.getElementById("articleSourceTitle").dispatchEvent(new Event("input", {bubbles:true}));'
  ].join('\n'));
  for (var w = 0; w < 20; w++) {
    await sleep(150);
    var cardHidden = await window.eval('document.getElementById("articleQuickReviewCard").hidden');
    if (!cardHidden) break;
  }
  var cardHiddenFinal = await window.eval('document.getElementById("articleQuickReviewCard").hidden');
  check('8. La ficha de revisión rápida aparece (deja de estar hidden) al cargar una fuente principal', cardHiddenFinal === false);
  var cardHtml = await window.eval('document.getElementById("articleQuickReviewBody").innerHTML');
  check('8. La ficha muestra la URL de la fuente principal cargada', cardHtml.indexOf('techcrunch.com/prueba') !== -1, cardHtml.slice(0, 300));
  check('8. La ficha muestra el nombre del medio', cardHtml.indexOf('TechCrunch') !== -1);
  check('8. La ficha avisa de fuente única cuando no hay adicionales cargadas todavía', /una sola fuente/i.test(cardHtml), cardHtml.slice(0, 400));

  // Agregar una fuente adicional real desde el propio botón "+ Agregar
  // fuente adicional" (flujo real de clic, no solo estado interno) y
  // confirmar que la advertencia de fuente única desaparece.
  await window.eval('document.getElementById("articleAddSourceBtn").click();');
  await window.eval([
    'var rows = document.querySelectorAll("#articleAdditionalSourcesList .additional-source-row");',
    'var last = rows[rows.length - 1];',
    'last.querySelector(".additional-source-url").value = "https://venturebeat.com/prueba";',
    'last.querySelector(".additional-source-url").dispatchEvent(new Event("input", {bubbles:true}));',
    'last.querySelector(".additional-source-label").value = "VentureBeat";',
    'last.querySelector(".additional-source-label").dispatchEvent(new Event("input", {bubbles:true}));'
  ].join('\n'));
  var cardHtmlAfterSource = '';
  for (var w2 = 0; w2 < 20; w2++) {
    await sleep(150);
    cardHtmlAfterSource = await window.eval('document.getElementById("articleQuickReviewBody").innerHTML');
    if (cardHtmlAfterSource.indexOf('venturebeat.com/prueba') !== -1) break;
  }
  check('8. Al agregar una fuente adicional real, la ficha la muestra y saca el aviso de fuente única',
    cardHtmlAfterSource.indexOf('venturebeat.com/prueba') !== -1 && !/una sola fuente/i.test(cardHtmlAfterSource),
    cardHtmlAfterSource.slice(0, 500));

  // Botón "Verificar fuente" contra el servidor de prueba local.
  await window.eval('document.getElementById("articleSourceUrl").value = "http://127.0.0.1:' + uiProbePort + '/viva";');
  await window.eval('document.getElementById("articleCheckSourceBtn").click();');
  var checkStatusOk = '';
  for (var k = 0; k < 30; k++) {
    await sleep(150);
    checkStatusOk = await window.eval('document.getElementById("articleCheckSourceStatus").textContent');
    if (checkStatusOk && checkStatusOk.indexOf('Verificando') === -1) break;
  }
  check('8. "Verificar fuente" contra una URL que responde -> estado OK', /Responde/.test(checkStatusOk), checkStatusOk);

  await window.eval('document.getElementById("articleSourceUrl").value = "http://127.0.0.1:' + uiProbePort + '/no-existe";');
  await window.eval('document.getElementById("articleCheckSourceBtn").click();');
  var checkStatusBad = '';
  for (var k2 = 0; k2 < 30; k2++) {
    await sleep(150);
    checkStatusBad = await window.eval('document.getElementById("articleCheckSourceStatus").textContent');
    if (checkStatusBad && checkStatusBad.indexOf('Verificando') === -1) break;
  }
  check('8. "Verificar fuente" contra una URL que da 404 -> estado "No responde"', /No responde/.test(checkStatusBad), checkStatusBad);

  await new Promise(function (resolve) { uiProbe.close(resolve); });

  child.kill();
  await sleep(300);

  // ==========================================================================
  // PARTE 8 -- regresión: nada de esto tocó el sitio REAL
  // ==========================================================================
  var realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('9. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  // El sandbox local nunca tuvo el registro real de Nscale con fuentes en
  // SU PROPIO articulos.json (eso solo se sincronizó al dispositivo real
  // en el segmento anterior, por un canal totalmente aparte) -- el control
  // de abajo ya no depende de ningún número escrito a mano: compara contra
  // la cantidad y el conjunto de slugs que el sandbox YA tenía al empezar
  // esta misma corrida (ver admin/articulos-integrity-check.js).
  var realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('9. El sitio real (sandbox) conserva exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('9. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR FATAL:', e);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
