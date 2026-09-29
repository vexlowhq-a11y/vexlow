#!/usr/bin/env node
/*
  admin/test-writing-quality-validation.js
  ===========================================
  Pedido de Leonardo (2026-09-27), a partir del hallazgo real de un
  borrador de Google Trends (Yahoo Sports, "Fantasy Week 3 Start or Sit"
  sobre Michael Wilson) que llegó a "Requiere revisión" con ~359 palabras
  (vs. 700-1000 pedidas), 0 subtítulos (vs. 3-5), 0 atribuciones enlazadas
  pese a la regla obligatoria del prompt, una referencia sin identificar
  ("his teammate"), sourceTitle "Sports" en vez de "Yahoo Sports", y una
  imagen generada con IA gastada pese a que el borrador no pasó validación.

  Ver el diagnóstico entregado (DIAGNOSTICO-CALIDAD-REDACCION-YAHOO-
  FANTASY-20260927.md) y admin/pipeline.js/draft.js/feeds.js para el
  diseño completo verificado acá.

  Pruebas:
    1. validateDraftWritingQuality(): cada condición por separado (palabras,
       subtítulos, atribución, repetición, referencia ambigua, truncamiento)
       -- nunca reintenta, siempre un motivo concreto y medible.
    2. Motivo combinado: formato EXACTO pedido por Leonardo
       ("Redacción incompleta: 359 palabras, 0 subtítulos, sin atribuciones
       enlazadas y referencia ambigua: 'his teammate'.").
    3. Contenido que SÍ cumple las 6 condiciones -> passes:true, sin motivo.
    4. detectAmbiguousReferences(): casos límite documentados (nombre real
       en la misma oración no cuenta; nombre en otra oración sigue sin
       identificar; "The Cardinals" al inicio de oración no cuenta como
       nombre).
    5. detectExcessiveSelfRepetition(): dos oraciones casi idénticas SÍ:
       dos oraciones distintas NO.
    6. classifyDraft(): "opt-in" -- un borrador viejo SIN writingQuality
       precalculado nunca se penaliza retroactivamente; uno nuevo CON
       writingQuality.passes:false SÍ queda en "revisar", con el mismo
       puntaje técnico (editorialReadinessScore) sin tocar -- solo cambia
       el estado final y el motivo. eligibleToUse nunca se bloquea por
       esto (advertencia, no bloqueo mecánico).
    7. Yahoo: sports.yahoo.com -> "Yahoo Sports"; news.yahoo.com ->
       "Yahoo News".
    8. Metadata de IA (finish_reason/tokens): fetchNewDrafts() de punta a
       punta con un mock de draftArticle que devuelve aiCallMeta.truncated
       -- el borrador queda en revisión con un motivo que menciona el
       truncamiento, con UNA sola llamada (nunca reintenta).
    9. Reordenamiento de imagen: "listo" -> imagen se genera (máximo 1
       llamada real); "revisar" -> 0 llamadas de imagen, image:null, y
       classifyDraft NO agrega ninguna advertencia extra por la imagen
       faltante (el puntaje +5 de imagen se mantiene igual).
   10. Botón manual "Generar imagen" (generateDraftImageManually): ya
       tenía imagen -> 0 llamadas; sin imagen y el mock genera bien ->
       exactamente 1 llamada; sin imagen y el mock falla -> aviso legible,
       sin reintento, borrador no se rompe.
   11. Servidor real: POST /api/drafts/generate-image -- 400 sin slug, 404
       con un slug inexistente, 200 con alreadyHadImage:true si ya tenía
       imagen (sin tocar la red/IA para este camino).
   12. Integridad pública: ningún prompt, token o metadata técnica de IA
       (aiCallMeta/writingQuality/finishReason/tokens) aparece en el HTML
       público generado.
   13. data/articulos.json del sitio real no cambia durante estas pruebas.

  Corre sobre COPIAS AISLADAS del sitio completo (nunca el sandbox real).
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
function hoursAgoISO(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-writing-quality-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');
const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');
const draftsPath = path.join(dataDir, 'drafts.json');
const cachePath = path.join(dataDir, 'candidate-cache.json');

// Cuerpo "bueno" reutilizable: >=600 palabras, 3 subtítulos, 1 atribución
// enlazada, sin repetición, sin referencia ambigua -- pasa las 6 condiciones.
function goodBody(topicWord) {
  var p1 = 'This paragraph provides additional independent context about ' + topicWord + ' without repeating the original summary word for word, and it continues for long enough to add real substance rather than padding. The organization has operated in this space since 2019, according to public materials reviewed for this coverage, and first launched a smaller pilot version of this effort back in 2021. Internal materials reviewed for this coverage describe a multi-quarter timeline that predates this specific announcement by several fiscal periods. A separate filing submitted earlier this year outlined plans broadly consistent with the scale described here, giving additional context beyond what was disclosed directly this week. Company representatives declined to comment further beyond the prepared statement issued alongside the announcement itself. People familiar with the planning process, speaking on condition of anonymity because the details were not yet public, said discussions had been under way internally for some time before the public announcement. No specific financial terms were disclosed in any of the materials reviewed for this coverage. The broader timeline described here is consistent with how comparable efforts elsewhere have typically unfolded, based on public reporting on similar past cases across the same general category of activity.';
  var p2 = '## Contexto adicional\nAnalysts who track this sector, as noted in <a href="https://industry-tracker.example/outlook">a widely cited industry report</a>, have pointed to broader trends shaping similar moves recently across the industry. Similar moves announced elsewhere in the sector over the same period have followed a comparable pattern, with execution typically beginning within a couple of quarters of an initial announcement. That broader trend offers useful context for evaluating how this specific move fits into the sector\'s overall trajectory going forward. None of these broader dynamics were addressed directly in the statement reviewed for this coverage. Rival organizations have pursued similar strategies in recent years with mixed results, according to public reporting on comparable moves elsewhere in the same broad category of activity.';
  var p3 = '## Impacto para la industria\nCompared to its previous smaller pilot version, this effort represents a significant jump in scale that could affect suppliers and partners across the wider market. Suppliers and partners across the wider market could see effects if this proceeds on the timeline described by those involved in the effort. Smaller regional players, meanwhile, may face pressure to differentiate further as larger organizations capture a growing share of the available business. Trade groups representing independent operators have previously flagged consolidation as an ongoing concern in public comments submitted to regulators. It remains unclear how quickly those downstream effects would materialize if the plans described move forward as outlined. Workers in adjacent parts of the supply chain could also feel indirect effects depending on how quickly the broader plans move from announcement to execution. Independent analysts said the overall scale described here appeared broadly in line with recent comparable moves across the same general part of the market.';
  var p4 = '## Próximos pasos\nA formal update is expected in a subsequent filing, which would offer the next concrete checkpoint for tracking progress on this story going forward. Local officials have indicated that any required reviews tied to the plans are proceeding on a normal schedule without unusual delay. A representative said final details would likely depend on demand once the initial phase of the effort is complete. No objections have been filed to date according to the materials reviewed for this coverage, and none of the people involved described any particularly unusual obstacles at this stage of the overall process. A separate briefing prepared for workforce planners described the plans as consistent with broader trends already under way elsewhere in the sector, without offering a specific figure for the scope involved. Observers said the coming weeks would likely bring more clarity once additional regulatory or procedural steps, where applicable, have run their course. Additional details are expected to emerge gradually over the following weeks as the parties involved move from initial announcement toward implementation of the plans described above.';
  return [p1, p2, p3, p4].join('\n\n');
}

async function main() {
  const pipeline = require(path.join(adminDir, 'pipeline.js'));
  const draft = require(path.join(adminDir, 'draft.js'));
  const feeds = require(path.join(adminDir, 'feeds.js'));
  const imageGenModule = require(path.join(adminDir, 'image-gen.js'));

  // ==========================================================================
  // 1. validateDraftWritingQuality(): cada condición por separado
  // ==========================================================================
  var GOOD = goodBody('this announcement');
  check('1.0 Cuerpo de control (goodBody) pasa las 6 condiciones', pipeline.validateDraftWritingQuality({ body: GOOD }).passes === true, JSON.stringify(pipeline.validateDraftWritingQuality({ body: GOOD })));

  var shortBody = 'A short update was announced Tuesday. It covers only the bare minimum of what happened, without any further detail added.';
  var r1a = pipeline.validateDraftWritingQuality({ body: shortBody });
  check('1.1 Menos de 600 palabras: passes:false, motivo con el conteo real', r1a.passes === false && r1a.wordCount < 600 && r1a.summary.indexOf(r1a.wordCount + ' palabras') !== -1, JSON.stringify(r1a));

  var noSubheadBody = GOOD.replace(/^## .+$/gm, 'Extra context follows below, still without any actual subheading marker in this version of the text.');
  var r1b = pipeline.validateDraftWritingQuality({ body: noSubheadBody });
  check('1.2 Menos de 3 subtítulos: passes:false, motivo con el conteo real', r1b.passes === false && r1b.subheadingCount < 3 && r1b.summary.indexOf(r1b.subheadingCount + ' subtítulos') !== -1, JSON.stringify(r1b));

  var noLinkBody = GOOD.replace(/<a[^>]*>([^<]*)<\/a>/, '$1');
  var r1c = pipeline.validateDraftWritingQuality({ body: noLinkBody });
  check('1.3 Sin atribución enlazada: passes:false, "sin atribuciones enlazadas"', r1c.passes === false && r1c.hasAttributionLinks === false && r1c.summary.indexOf('sin atribuciones enlazadas') !== -1, JSON.stringify(r1c));

  var repetitiveBody = GOOD + '\n\nThe company announced a major update on Tuesday for its customers worldwide. The company announced a major update on Tuesday for its customers worldwide.';
  var r1d = pipeline.validateDraftWritingQuality({ body: repetitiveBody });
  check('1.4 Repetición excesiva: passes:false, "repetición excesiva"', r1d.passes === false && r1d.excessiveRepetition === true && r1d.summary.indexOf('repetición excesiva') !== -1, JSON.stringify(r1d));

  var ambiguousBody = GOOD + '\n\nHe had a strong outing overall. His teammate struggled to keep pace for most of the game.';
  var r1e = pipeline.validateDraftWritingQuality({ body: ambiguousBody });
  check('1.5 Referencia ambigua: passes:false, cita el fragmento exacto', r1e.passes === false && r1e.ambiguousReferences.length === 1 && r1e.summary.indexOf("referencia ambigua: 'His teammate'") !== -1, JSON.stringify(r1e));

  var r1f = pipeline.validateDraftWritingQuality({ body: GOOD }, { truncated: true });
  check('1.6 Respuesta truncada (aiCallMeta.truncated): passes:false, motivo explícito', r1f.passes === false && r1f.truncated === true && r1f.summary.indexOf('se cortó (truncada)') !== -1, JSON.stringify(r1f));

  // ==========================================================================
  // 2. Motivo combinado: formato EXACTO del ejemplo de Leonardo
  // ==========================================================================
  var combinedBody = 'He carried the offense all night, putting up a career day for the second week in a row. His teammate struggled to get going and finished with modest numbers by comparison to that output.';
  var r2 = pipeline.validateDraftWritingQuality({ body: combinedBody });
  check('2. Motivo combinado sigue el patrón "Redacción incompleta: N palabras, N subtítulos, sin atribuciones enlazadas y referencia ambigua: \'...\'."',
    /^Redacción incompleta: \d+ palabras, \d+ subtítulos, sin atribuciones enlazadas y referencia ambigua: '.+'\.$/.test(r2.summary), r2.summary);

  // ==========================================================================
  // 3. Contenido que cumple las 6 condiciones
  // ==========================================================================
  var r3 = pipeline.validateDraftWritingQuality({ body: GOOD }, { truncated: false });
  check('3. Cuerpo completo: passes:true, summary null', r3.passes === true && r3.summary === null, JSON.stringify(r3));

  // ==========================================================================
  // 4. detectAmbiguousReferences(): casos límite documentados
  // ==========================================================================
  check('4.1 "his teammate" sin identificar en la misma oración -> ambigua',
    pipeline.detectAmbiguousReferences('He had a great game. His teammate struggled all night.').length === 1);
  check('4.2 Nombre real DESPUÉS, en la MISMA oración ("His teammate Marvin Harrison Jr.") -> no ambigua',
    pipeline.detectAmbiguousReferences('His teammate Marvin Harrison Jr. had a great game.').length === 0);
  check('4.3 Nombre real en OTRA oración no ayuda -- sigue sin identificar en la oración de "his teammate"',
    pipeline.detectAmbiguousReferences('Marvin Harrison Jr. had a great game. His teammate struggled all night.').length === 1);
  check('4.4 "The Cardinals" al INICIO de oración no cuenta como nombre real (regla de puntuación, no identificación)',
    pipeline.detectAmbiguousReferences('The Cardinals dominated the game. His teammate struggled all night.').length === 1);

  // ==========================================================================
  // 5. detectExcessiveSelfRepetition()
  // ==========================================================================
  check('5.1 Dos oraciones casi idénticas -> found:true',
    pipeline.detectExcessiveSelfRepetition('The team won the game on Sunday. The team won the game on Sunday.').found === true);
  check('5.2 Dos oraciones genuinamente distintas -> found:false',
    pipeline.detectExcessiveSelfRepetition('The team won the game on Sunday. Traffic downtown was heavy after the event ended.').found === false);

  // ==========================================================================
  // 6. classifyDraft(): "opt-in" -- nunca penaliza retroactivamente
  // ==========================================================================
  var COMPLETE_STORY_BASE = {
    title: 'Regulator Approves Merger of Two Major Cloud Providers',
    sourceHeadline: 'Regulator Approves Merger of Two Major Cloud Providers After Months of Review',
    sourceTitle: 'Reuters', sourceDomain: 'reuters.com',
    sourceUrl: 'https://www.reuters.com/business/regulator-approves-cloud-merger-2026',
    dek: 'The decision clears the way for the companies to combine operations by year end.',
    body: 'Regulators on Thursday approved the merger of two major cloud computing providers, according to a filing reviewed by Reuters.\n\n## Background\nThe deal was first announced earlier this year.\n\n## What happens next\nThe companies said the merger should close within 90 days.',
    category: 'technology',
    additionalSources: [{ url: 'https://www.bloomberg.com/news/cloud-merger-approved', label: 'Bloomberg' }],
    sourcePublishedAt: hoursAgoISO(3),
    keyClaims: [
      { claim: 'Regulators approved the merger.', sourceLabel: 'Reuters' },
      { claim: 'The deal should close within 90 days.', sourceLabel: 'Bloomberg' }
    ]
  };
  var oldDraftNoWritingQuality = Object.assign({}, COMPLETE_STORY_BASE); // sin writingQuality -- "viejo"
  var rOld = pipeline.classifyDraft(oldDraftNoWritingQuality);
  check('6.1 Borrador VIEJO sin writingQuality precalculado: insufficientWritingQuality:false (opt-in, nunca retroactivo)',
    rOld.insufficientWritingQuality === false, JSON.stringify({ insufficientWritingQuality: rOld.insufficientWritingQuality, tier: rOld.readinessTier }));
  check('6.1 Borrador VIEJO: sigue llegando a "listo" (mismo comportamiento de siempre)', rOld.readinessTier === 'listo', rOld.readinessTier);

  var newDraftFailingWritingQuality = Object.assign({}, COMPLETE_STORY_BASE, {
    writingQuality: { wordCount: 40, subheadingCount: 2, hasAttributionLinks: false, excessiveRepetition: false, ambiguousReferences: [], truncated: false, passes: false, summary: 'Redacción incompleta: 40 palabras.' }
  });
  var rNew = pipeline.classifyDraft(newDraftFailingWritingQuality);
  check('6.2 Borrador NUEVO con writingQuality.passes:false: insufficientWritingQuality:true', rNew.insufficientWritingQuality === true);
  check('6.2 Borrador NUEVO: readinessTier "revisar" (nunca "listo" aunque el puntaje sea alto)', rNew.readinessTier === 'revisar', rNew.readinessTier);
  check('6.2 Puntaje técnico (editorialReadinessScore) IDÉNTICO al del borrador viejo -- nunca se toca para ocultar la falla',
    rNew.editorialReadinessScore === rOld.editorialReadinessScore, JSON.stringify({ old: rOld.editorialReadinessScore, new: rNew.editorialReadinessScore }));
  check('6.2 El motivo combinado de writingQuality queda en reasons/recommendation', rNew.recommendation === 'revisar' && rNew.writingQuality.summary === 'Redacción incompleta: 40 palabras.');
  check('6.2 eligibleToUse sigue true -- advertencia, nunca bloqueo mecánico', rNew.eligibleToUse === true, rNew.eligibleToUse);

  // ==========================================================================
  // 7. Yahoo Sports / Yahoo News
  // ==========================================================================
  check('7.1 sports.yahoo.com -> "Yahoo Sports"', feeds.outletNameFromDomain('sports.yahoo.com') === 'Yahoo Sports', feeds.outletNameFromDomain('sports.yahoo.com'));
  check('7.2 news.yahoo.com -> "Yahoo News"', feeds.outletNameFromDomain('news.yahoo.com') === 'Yahoo News', feeds.outletNameFromDomain('news.yahoo.com'));

  // ==========================================================================
  // Setup común para las secciones 8/9: pipeline real de punta a punta
  // ==========================================================================
  var originalFetchAllFeedItems = feeds.fetchAllFeedItems;
  var originalCheckUrlReachable = pipeline.checkUrlReachable;
  var originalSearchGoogleNews = pipeline.searchGoogleNewsForCorroboration;
  var originalDraftArticle = draft.draftArticle;
  var originalLoadConfig = draft.loadConfig;
  var originalGenerateCoverImage = imageGenModule.generateCoverImage;
  function restoreAll() {
    feeds.fetchAllFeedItems = originalFetchAllFeedItems;
    pipeline.checkUrlReachable = originalCheckUrlReachable;
    pipeline.searchGoogleNewsForCorroboration = originalSearchGoogleNews;
    draft.draftArticle = originalDraftArticle;
    draft.loadConfig = originalLoadConfig;
    imageGenModule.generateCoverImage = originalGenerateCoverImage;
  }
  function resetDrafts() { fs.writeFileSync(draftsPath, '[]\n', 'utf8'); }
  function resetCache() { fs.writeFileSync(cachePath, '{}\n', 'utf8'); }
  function baseCfg(extra) { return Object.assign({ draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }, extra || {}); }
  function makeCorroboratedPair(entity, tag) {
    return [
      { category: 'business', title: entity + ' Launches New Platform for Enterprise Clients', summary: entity + ' unveiled a new platform Tuesday for enterprise clients.', link: 'https://' + tag + 'a.example/2026/09/launch', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: tag + 'a.example', outlet: 'Wire A ' + tag },
      { category: 'business', title: entity + ' Unveils New Platform For Enterprise Use', summary: 'The company launched a new platform this week aimed at enterprise customers, the firm said Tuesday.', link: 'https://' + tag + 'b.example/2026/09/launch-details', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: tag + 'b.example', outlet: 'Wire B ' + tag }
    ];
  }
  function mockReachableAlways() { pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); }; }
  function mockGoogleNewsNeverFinds() { pipeline.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); }; }

  // ==========================================================================
  // 8. Metadata de IA / truncamiento -> revisión, sin reintento
  // ==========================================================================
  {
    resetDrafts(); resetCache();
    mockReachableAlways(); mockGoogleNewsNeverFinds();
    draft.loadConfig = function () { return baseCfg(); };
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: makeCorroboratedPair('Meridian Holdings', 'trunc8'), errors: [] }); };
    var calls8 = 0;
    draft.draftArticle = function (item) {
      calls8++;
      return Promise.resolve({
        title: 'Empresa lanza nueva plataforma (respuesta truncada)',
        dek: 'Cobertura de prueba truncada a propósito para esta corrida automatizada.',
        body: goodBody('this platform launch').slice(0, 80), // deliberadamente corto -- simula un corte real
        category: item.category, readTime: '3 min', keyClaims: [],
        aiCallMeta: { provider: 'openai', model: 'gpt-4o-mini-test', finishReason: 'length', truncated: true, inputTokens: 512, outputTokens: 2048 }
      });
    };
    var r8 = await pipeline.fetchNewDrafts();
    check('8.1 Una sola llamada de IA (sin reintento automático pese al truncamiento)', r8.aiCallsMade === 1 && calls8 === 1, JSON.stringify({ aiCallsMade: r8.aiCallsMade, calls8: calls8 }));
    check('8.2 El borrador se agregó igual (revisión humana, no se descarta ni se pierde)', r8.added === 1, r8.added);
    var draftsAfter8 = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
    check('8.3 writingQuality.truncated:true quedó guardado en el borrador', draftsAfter8[0] && draftsAfter8[0].writingQuality && draftsAfter8[0].writingQuality.truncated === true, JSON.stringify(draftsAfter8[0] && draftsAfter8[0].writingQuality));
    var tier8 = pipeline.classifyDraft(draftsAfter8[0]);
    check('8.4 readinessTier "revisar" con motivo que menciona el truncamiento', tier8.readinessTier === 'revisar' && tier8.writingQuality.summary.indexOf('truncó') === -1 && tier8.writingQuality.summary.indexOf('se cortó (truncada)') !== -1, tier8.writingQuality.summary);
    check('8.5 editorialMeta.aiCallMeta guarda SOLO metadata técnica (finishReason/tokens), nunca el prompt ni la respuesta cruda',
      draftsAfter8[0].editorialMeta && draftsAfter8[0].editorialMeta.aiCallMeta &&
      draftsAfter8[0].editorialMeta.aiCallMeta.finishReason === 'length' &&
      typeof draftsAfter8[0].editorialMeta.aiCallMeta.inputTokens === 'number' &&
      Object.keys(draftsAfter8[0].editorialMeta.aiCallMeta).every(function (k) { return ['provider', 'model', 'finishReason', 'truncated', 'inputTokens', 'outputTokens'].indexOf(k) !== -1; }),
      JSON.stringify(draftsAfter8[0].editorialMeta && draftsAfter8[0].editorialMeta.aiCallMeta));
  }

  // ==========================================================================
  // 9. Reordenamiento de imagen: "listo" -> imagen; "revisar" -> 0 imagen
  // ==========================================================================
  {
    // -- 9a: "listo" (contenido completo, corroborado) -> imagen SÍ se genera
    resetDrafts(); resetCache();
    mockReachableAlways(); mockGoogleNewsNeverFinds();
    draft.loadConfig = function () { return baseCfg(); };
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: makeCorroboratedPair('Solari Systems', 'ready9'), errors: [] }); };
    draft.draftArticle = function (item, cfg, categoryOptions, sourcesForPrompt) {
      return Promise.resolve({
        title: 'Empresa de sistemas anuncia expansión de infraestructura',
        dek: 'Cobertura editorial redactada de forma completamente independiente para esta prueba.',
        body: goodBody('this infrastructure expansion'),
        category: item.category, readTime: '3 min',
        keyClaims: [{ claim: 'Se anunció una expansión relevante.', sourceLabel: sourcesForPrompt.primary.outlet }, { claim: 'La segunda fuente confirmó el mismo hecho.', sourceLabel: sourcesForPrompt.additional[0].outlet }]
      });
    };
    var imageCallsReady = 0;
    imageGenModule.generateCoverImage = function () { imageCallsReady++; return Promise.resolve({ path: 'img/temas/fake-ready.jpg', tool: 'test-tool', model: 'test-model', generatedAt: new Date().toISOString(), prompt: 'test prompt' }); };
    var r9a = await pipeline.fetchNewDrafts();
    check('9a. El candidato queda "listo" (readyCount 1)', r9a.readyCount === 1 && r9a.needsReviewCount === 0, JSON.stringify(r9a));
    check('9a. imageCallsMade === 1 (máximo 1 llamada real de imagen para el único "listo")', r9a.imageCallsMade === 1, r9a.imageCallsMade);
    check('9a. El mock instrumentado de generateCoverImage confirma 1 sola invocación real', imageCallsReady === 1, imageCallsReady);
    var draftsAfter9a = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
    check('9a. El borrador quedó con imagen asignada', !!draftsAfter9a[0].image, draftsAfter9a[0].image);

    // -- 9b: "revisar" (misma corroboración, pero redacción insuficiente) -> 0 imagen
    resetDrafts(); resetCache();
    mockReachableAlways(); mockGoogleNewsNeverFinds();
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: makeCorroboratedPair('Vantage Robotics', 'review9'), errors: [] }); };
    draft.draftArticle = function (item) {
      return Promise.resolve({
        title: 'Empresa de robótica anuncia expansión (redacción corta)',
        dek: 'Cobertura de prueba deliberadamente corta para esta corrida automatizada.',
        body: 'A short update was announced Tuesday. It covers only the bare minimum of what happened, without any further detail added.',
        category: item.category, readTime: '3 min', keyClaims: []
      });
    };
    var imageCallsReview = 0;
    imageGenModule.generateCoverImage = function () { imageCallsReview++; return Promise.resolve({ path: 'img/temas/fake-review.jpg', tool: 'test-tool', model: 'test-model', generatedAt: new Date().toISOString(), prompt: 'test prompt' }); };
    var r9b = await pipeline.fetchNewDrafts();
    check('9b. El candidato queda en "revisar" (needsReviewCount 1) por redacción insuficiente', r9b.readyCount === 0 && r9b.needsReviewCount === 1, JSON.stringify(r9b));
    check('9b. imageCallsMade === 0 (0 llamadas automáticas de imagen para un borrador en revisión)', r9b.imageCallsMade === 0, r9b.imageCallsMade);
    check('9b. El mock instrumentado de generateCoverImage confirma 0 invocaciones reales', imageCallsReview === 0, imageCallsReview);
    var draftsAfter9b = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
    check('9b. El borrador quedó con image:null (nunca se inventa ni se descarga nada)', draftsAfter9b[0].image === null, JSON.stringify(draftsAfter9b[0].image));
    var tier9b = pipeline.classifyDraft(draftsAfter9b[0]);
    check('9b. classifyDraft NO agrega ninguna advertencia extra por la imagen faltante (readinessReasons sin ningún motivo negativo de "imagen")',
      !tier9b.readinessReasons.some(function (r) { return /^-\d+.*imagen/i.test(r); }), JSON.stringify(tier9b.readinessReasons));
    check('9b. El factor de imagen sigue sumando +5 igual que si tuviera imagen (nunca penaliza la ausencia en esta etapa)',
      tier9b.readinessReasons.some(function (r) { return r.indexOf('+5') === 0 && r.indexOf('imagen') !== -1; }), JSON.stringify(tier9b.readinessReasons));

    // -- 9c (pedido de Leonardo, 2026-09-28, punto 4 de la orden de cierre):
    // "listo" de verdad (misma redacción completa que 9a), pero la
    // generación AUTOMÁTICA de imagen de IA FALLA (la API rechaza la
    // llamada) -- exactamente UN intento, CERO reintentos automáticos, el
    // borrador se conserva igual (nunca se descarta ni se rompe por esto),
    // el panel sigue funcional (fetchNewDrafts() no revienta ni deja el
    // borrador a medio escribir), y el estado final no contradice la
    // política de imagen/ícono por defecto: con image:null, el resto de los
    // campos de imagen tampoco pueden fingir que sí se generó algo.
    resetDrafts(); resetCache();
    mockReachableAlways(); mockGoogleNewsNeverFinds();
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: makeCorroboratedPair('Corven Analytics', 'imgfail9'), errors: [] }); };
    draft.draftArticle = function (item, cfg, categoryOptions, sourcesForPrompt) {
      return Promise.resolve({
        title: 'Empresa de analítica anuncia expansión de plataforma',
        dek: 'Cobertura editorial redactada de forma completamente independiente para esta prueba (fallo de imagen).',
        body: goodBody('this analytics platform expansion'),
        category: item.category, readTime: '3 min',
        keyClaims: [{ claim: 'Se anunció una expansión relevante.', sourceLabel: sourcesForPrompt.primary.outlet }, { claim: 'La segunda fuente confirmó el mismo hecho.', sourceLabel: sourcesForPrompt.additional[0].outlet }]
      });
    };
    var imageCallsFailed = 0;
    imageGenModule.generateCoverImage = function () { imageCallsFailed++; return Promise.reject(new Error('fallo simulado de la API de imagen (9c)')); };
    var r9c = await pipeline.fetchNewDrafts();
    check('9c. El candidato SIGUE quedando "listo" pese al fallo de imagen (readyCount 1) -- la imagen nunca decide el tier', r9c.readyCount === 1 && r9c.needsReviewCount === 0, JSON.stringify(r9c));
    check('9c. El borrador se agregó igual (conservado, no se pierde ni se descarta por el fallo de imagen)', r9c.added === 1, r9c.added);
    check('9c. imageCallsMade === 1 (exactamente UN intento real, nunca cero ni más de uno)', r9c.imageCallsMade === 1, r9c.imageCallsMade);
    check('9c. El mock instrumentado confirma exactamente 1 invocación real (0 reintentos automáticos tras el fallo)', imageCallsFailed === 1, imageCallsFailed);
    var draftsAfter9c = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
    check('9c. El borrador quedó con image:null (el fallo nunca se disfraza de imagen real)', draftsAfter9c[0].image === null, JSON.stringify(draftsAfter9c[0].image));
    check('9c. Sin image, ningún campo de procedencia finge que sí se generó una imagen de IA (imageTool/imageModel/imageGeneratedAt/imagePrompt en null, imageOrigin/imageLicense sin "ai-generated")',
      draftsAfter9c[0].imageTool === null && draftsAfter9c[0].imageModel === null && draftsAfter9c[0].imageGeneratedAt === null && draftsAfter9c[0].imagePrompt === null &&
      draftsAfter9c[0].imageOrigin !== 'ai-generated' && draftsAfter9c[0].imageLicense !== 'ai-generated-commercial-use',
      JSON.stringify({ imageTool: draftsAfter9c[0].imageTool, imageModel: draftsAfter9c[0].imageModel, imageGeneratedAt: draftsAfter9c[0].imageGeneratedAt, imagePrompt: draftsAfter9c[0].imagePrompt, imageOrigin: draftsAfter9c[0].imageOrigin, imageLicense: draftsAfter9c[0].imageLicense }));
    var tier9c = pipeline.classifyDraft(draftsAfter9c[0]);
    check('9c. classifyDraft() sigue devolviendo "listo" sin romperse ni agregar una advertencia negativa por la imagen faltante', tier9c.readinessTier === 'listo' && !tier9c.readinessReasons.some(function (r) { return /^-\d+.*imagen/i.test(r); }), JSON.stringify(tier9c));
    check('9c. El factor de imagen sigue sumando +5 igual que en 9a/9b (mismo criterio, sin excepción por el fallo)',
      tier9c.readinessReasons.some(function (r) { return r.indexOf('+5') === 0 && r.indexOf('imagen') !== -1; }), JSON.stringify(tier9c.readinessReasons));
    // El panel sigue funcional: una corrida NUEVA inmediatamente después
    // (misma sesión, mismo módulo pipeline en memoria) funciona normal --
    // el fallo de 9c no dejó ningún candado ni estado interno colgado.
    resetDrafts(); resetCache();
    feeds.fetchAllFeedItems = function () { return Promise.resolve({ items: [], errors: [] }); };
    var r9cFollowUp = await pipeline.fetchNewDrafts();
    check('9c. Después del fallo de imagen, una corrida siguiente funciona normal (el panel no queda trabado)', !r9cFollowUp.alreadyRunning && r9cFollowUp.timedOut !== true, JSON.stringify(r9cFollowUp));

    restoreAll();
  }

  // ==========================================================================
  // 10. Botón manual "Generar imagen" (generateDraftImageManually)
  // ==========================================================================
  {
    resetDrafts();
    var manualCfg = baseCfg();
    var draftWithImage = { slug: 'draft-ya-tiene-imagen', title: 'Ya Tiene Imagen', category: 'business', image: 'img/temas/ya-existente.jpg' };
    var draftNoImage = { slug: 'draft-sin-imagen', title: 'Sin Imagen Todavía', category: 'business', image: null };
    fs.writeFileSync(draftsPath, JSON.stringify([draftWithImage, draftNoImage], null, 2));

    var manualCalls = 0;
    imageGenModule.generateCoverImage = function () { manualCalls++; return Promise.resolve({ path: 'img/temas/manual-generada.jpg', tool: 'test-tool', model: 'test-model', generatedAt: new Date().toISOString(), prompt: 'test prompt' }); };
    var resAlready = await pipeline.generateDraftImageManually('draft-ya-tiene-imagen', manualCfg);
    check('10.1 Borrador que YA tenía imagen: alreadyHadImage:true, 0 llamadas', resAlready.ok === true && resAlready.alreadyHadImage === true && manualCalls === 0, JSON.stringify({ res: resAlready, calls: manualCalls }));

    var resGenerated = await pipeline.generateDraftImageManually('draft-sin-imagen', manualCfg);
    check('10.2 Borrador SIN imagen, el mock genera bien: exactamente 1 llamada, generated:true', resGenerated.ok === true && resGenerated.generated === true && manualCalls === 1, JSON.stringify({ res: resGenerated, calls: manualCalls }));
    check('10.2 El borrador queda con la imagen asignada', resGenerated.draft.image === 'img/temas/manual-generada.jpg', resGenerated.draft.image);

    // Reset a sin imagen para probar el camino de fallo, aparte.
    fs.writeFileSync(draftsPath, JSON.stringify([draftWithImage, draftNoImage], null, 2));
    manualCalls = 0;
    imageGenModule.generateCoverImage = function () { manualCalls++; return Promise.reject(new Error('fallo simulado de la API de imagen')); };
    var resFailed = await pipeline.generateDraftImageManually('draft-sin-imagen', manualCfg);
    check('10.3 Borrador SIN imagen, el mock falla: aviso legible, generated:false, exactamente 1 llamada (sin reintento)',
      resFailed.ok === true && resFailed.generated === false && typeof resFailed.error === 'string' && resFailed.error.indexOf('fallo simulado') !== -1 && manualCalls === 1,
      JSON.stringify({ res: resFailed, calls: manualCalls }));
    check('10.3 El borrador NO se rompe (sigue con image:null, sin campos a medio escribir)', resFailed.draft.image === null, JSON.stringify(resFailed.draft));

    imageGenModule.generateCoverImage = originalGenerateCoverImage;
  }

  // ==========================================================================
  // 11. Servidor real: POST /api/drafts/generate-image
  // ==========================================================================
  {
    fs.writeFileSync(draftsPath, JSON.stringify([
      { slug: 'draft-http-ya-tiene-imagen', title: 'HTTP Ya Tiene Imagen', category: 'business', image: 'img/temas/http-ya-existente.jpg' }
    ], null, 2));
    const PORT = 4336; // puerto propio, distinto del resto de la batería
    var serverSrc = fs.readFileSync(path.join(adminDir, 'server.js'), 'utf8');
    serverSrc = serverSrc.replace('const PORT = 4321;', 'const PORT = ' + PORT + ';');
    fs.writeFileSync(path.join(adminDir, 'server.js'), serverSrc);
    var child = spawn(process.execPath, [path.join(adminDir, 'server.js')], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
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
    try {
      await waitForServer('http://127.0.0.1:' + PORT + '/');
      var resNoSlug = await fetch('http://127.0.0.1:' + PORT + '/api/drafts/generate-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      check('11.1 POST sin slug: 400', resNoSlug.status === 400, 'status=' + resNoSlug.status);
      var resUnknown = await fetch('http://127.0.0.1:' + PORT + '/api/drafts/generate-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'slug-que-no-existe' }) });
      var bodyUnknown = await resUnknown.json().catch(function () { return null; });
      check('11.2 POST con un slug inexistente: 404, ok:false', resUnknown.status === 404 && bodyUnknown && bodyUnknown.ok === false, JSON.stringify({ status: resUnknown.status, body: bodyUnknown }));
      var resAlreadyHttp = await fetch('http://127.0.0.1:' + PORT + '/api/drafts/generate-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'draft-http-ya-tiene-imagen' }) });
      var bodyAlreadyHttp = await resAlreadyHttp.json().catch(function () { return null; });
      check('11.3 POST sobre un borrador que YA tiene imagen: 200, alreadyHadImage:true (sin tocar red/IA)',
        resAlreadyHttp.status === 200 && bodyAlreadyHttp && bodyAlreadyHttp.alreadyHadImage === true, JSON.stringify({ status: resAlreadyHttp.status, body: bodyAlreadyHttp }));
    } finally {
      child.kill();
    }
  }

  // ==========================================================================
  // 12. Integridad pública: nunca metadata técnica de IA en el HTML público
  // ==========================================================================
  {
    var publicFiles = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        if (entry.name === 'admin' || entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') return;
        var full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (entry.name.endsWith('.html')) publicFiles.push(full);
      });
    })(tmpRoot);
    var leakPatterns = ['aiCallMeta', 'finishReason', 'finish_reason', 'stop_reason', 'inputTokens', 'outputTokens', 'writingQuality', 'editorialReadinessScore'];
    var leaks = [];
    publicFiles.forEach(function (f) {
      var contents = fs.readFileSync(f, 'utf8');
      leakPatterns.forEach(function (p) {
        if (contents.indexOf(p) !== -1) leaks.push(f + ' contiene "' + p + '"');
      });
    });
    check('12. Ningún archivo HTML público contiene metadata técnica de IA (' + publicFiles.length + ' archivos revisados)', leaks.length === 0, JSON.stringify(leaks));
  }

  restoreAll();
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas:', e);
  fail++;
}).finally(function () {
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('13. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('13. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('13. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
