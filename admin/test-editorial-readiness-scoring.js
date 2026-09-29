#!/usr/bin/env node
/*
  admin/test-editorial-readiness-scoring.js
  ===========================================
  Pedido de Leonardo (2026-09-20, junto con el filtro de ofertas
  comerciales -- ver test-commercial-deal-filter.js): un puntaje de
  preparación editorial (0-100) para los resultados de "Buscar noticias
  nuevas", calculado ANTES de mostrarlos, para poder elegir primero los
  candidatos verdes con puntaje alto -- sin reemplazar nunca la
  aprobación humana obligatoria.

  Fórmula verificada acá tal cual quedó implementada en
  admin/pipeline.js (computeEditorialReadiness/classifyDraft):
    +25 fuente principal real, con URL http(s) válida (+ canónica)
    +20 segunda fuente independiente real que corrobora la historia
    +15 publicado por la fuente en las últimas 24 horas
    +10 categoría entre las categorías activas de VexlowHQ
    +10 afirmaciones principales atribuibles a una fuente (keyClaims)
    +10 sin lenguaje de rumor/especulación en el cuerpo
    +5  imagen con procedencia válida o generable de forma segura
    +5  aporte editorial propio (estructura: explicación/cronología/comparación)
    -40 oferta/descuento/afiliación/CTA de compra
    -35 fecha límite o evento ya vencido
    -30 duplicado de un artículo ya publicado
    -25 fuente principal inaccesible o dudosa
    -20 una sola fuente para afirmaciones importantes
    -20 rumor/afirmación sensible sin corroboración

  Clasificación (readinessTier):
    "descartar" -- oferta comercial, vencido, duplicado, contradicción
                   grave, categoría no habilitada, o fuente inválida
                   (bloqueo mecánico real, igual que antes de esta mejora).
    "listo"     -- puntaje >= 80 Y sin ninguna advertencia (ni una sola
                   fuente, ni rumor sin corroborar, ni similaridad alta,
                   ni subtítulo genérico).
    "revisar"   -- cualquier otro caso (incluida una fuente única
                   legítima, que NUNCA se bloquea mecánicamente por sí
                   sola -- ver eligibleToUse, sin cambios de esta mejora).

  Escenarios EXACTOS pedidos por Leonardo (requisito 12 del pedido de
  puntuación):
    (a) historia completa con 2 fuentes independientes -> puntaje >= 80,
        "listo para revisión rápida".
    (b) historia legítima de una sola fuente -> "Requiere revisión"
        (nunca bloqueada mecánicamente, puntaje en la banda 50-79: puede
        abrirse como borrador con advertencias, regla 5 del pedido).
    (c) oferta comercial estilo IGN/Amazon -> "Descartar".
    (d) noticia con plazo/evento vencido -> "Descartar".
    (e) duplicado de un artículo ya existente (vía el parámetro opt-in
        allArticles) -> bloqueado / "Descartar".
  Más una regresión de diseño: sin pasar allArticles (como ya hacían
  TODOS los llamados existentes de classifyDraft antes de esta mejora),
  isDuplicate/hasGraveContradiction siguen dando siempre false -- cero
  cambio de comportamiento para el código/tests previos.

  Corre en memoria, sin red ni DOM ni servidor -- computeEditorialReadiness
  y classifyDraft son funciones puras sobre los datos que reciben (no
  leen disco por su cuenta salvo listCategories()/feeds.canonicalizeUrl,
  ya cubiertas por el resto de la batería). No toca la carpeta real ni el
  sandbox en ningún momento.
*/
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const pipeline = require(path.join(__dirname, 'pipeline.js'));

function hoursAgoISO(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }

// ============================================================================
// (a) Historia completa, 2 fuentes independientes -> "listo", puntaje >= 80
// ============================================================================
const COMPLETE_STORY = {
  title: 'Regulator Approves Merger of Two Major Cloud Providers',
  sourceHeadline: 'Regulator Approves Merger of Two Major Cloud Providers After Months of Review',
  sourceTitle: 'Reuters',
  sourceDomain: 'reuters.com',
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
const completeResult = pipeline.classifyDraft(COMPLETE_STORY);
check('(a) Historia completa (2 fuentes): puntaje >= 80', completeResult.editorialReadinessScore >= 80, completeResult.editorialReadinessScore);
check('(a) Historia completa: readinessTier "listo"', completeResult.readinessTier === 'listo', completeResult.readinessTier);
check('(a) Historia completa: sin bloqueos ni advertencias (eligibleToUse:true, recommendation:"crear")',
  completeResult.eligibleToUse === true && completeResult.recommendation === 'crear', JSON.stringify({ eligibleToUse: completeResult.eligibleToUse, recommendation: completeResult.recommendation }));
check('(a) Historia completa: readinessReasons documenta cada +/- (transparencia, requisito de la fórmula)',
  Array.isArray(completeResult.readinessReasons) && completeResult.readinessReasons.length >= 6, JSON.stringify(completeResult.readinessReasons));

// ============================================================================
// (b) Historia legítima de una sola fuente -> "revisar" (nunca bloqueada
// mecánicamente por tener una sola fuente -- eligibleToUse sigue true)
// ============================================================================
const SINGLE_SOURCE_LEGIT = {
  title: 'Local Startup Raises Seed Round to Expand Manufacturing',
  sourceHeadline: 'Local Startup Raises $4M Seed Round to Expand Manufacturing Capacity',
  sourceTitle: 'TechCrunch',
  sourceDomain: 'techcrunch.com',
  sourceUrl: 'https://techcrunch.com/2026/09/startup-seed-round-manufacturing',
  dek: 'The company plans to use the funds to open a second facility.',
  body: 'A local manufacturing startup announced Thursday it raised a $4 million seed round led by a regional venture fund, according to the company.',
  category: 'business',
  additionalSources: [],
  singleSourceWarning: true,
  sourcePublishedAt: hoursAgoISO(5),
  keyClaims: [{ claim: 'The startup raised $4 million.', sourceLabel: 'TechCrunch' }]
};
const singleResult = pipeline.classifyDraft(SINGLE_SOURCE_LEGIT);
check('(b) Fuente única legítima: readinessTier "revisar" (nunca "descartar" solo por tener una fuente)',
  singleResult.readinessTier === 'revisar', singleResult.readinessTier);
check('(b) Fuente única legítima: eligibleToUse sigue true (única fuente NUNCA bloquea mecánicamente, requisito 6)',
  singleResult.eligibleToUse === true, JSON.stringify(singleResult));
check('(b) Fuente única legítima: recommendation "revisar" (advertencia, no bloqueo)', singleResult.recommendation === 'revisar', singleResult.recommendation);
check('(b) Fuente única legítima: puntaje en banda 50-79 (puede abrirse como borrador con advertencias, regla 5)',
  singleResult.editorialReadinessScore >= 50 && singleResult.editorialReadinessScore <= 79, singleResult.editorialReadinessScore);
check('(b) Fuente única legítima: la razón de "-20 una sola fuente" queda explicada en readinessReasons',
  singleResult.readinessReasons.some(function (r) { return r.indexOf('-20') === 0 && r.indexOf('una sola fuente') !== -1; }), JSON.stringify(singleResult.readinessReasons));

// ============================================================================
// (c) Oferta comercial estilo IGN/Amazon -> "descartar"
// ============================================================================
const COMMERCIAL_DEAL_STORY = {
  title: 'SteelSeries Arctis Nova Pro Omni Gaming Headset Hits Its Lowest Price Ever',
  sourceHeadline: 'The SteelSeries Arctis Nova Pro Omni Gaming Headset Drops to the Lowest Price Ever at Amazon Resale',
  sourceTitle: 'IGN',
  sourceDomain: 'ign.com',
  sourceUrl: 'https://www.ign.com/articles/steelseries-arctis-nova-pro-omni-lowest-price-amazon-resale',
  dek: 'The premium wireless gaming headset just hit its lowest price ever at Amazon Resale.',
  body: 'The SteelSeries Arctis Nova Pro Omni is now available at its lowest price ever through Amazon Resale, a limited-time deal on this popular gaming headset.',
  category: 'gaming'
};
const dealResult = pipeline.classifyDraft(COMMERCIAL_DEAL_STORY);
check('(c) Oferta comercial (IGN/Amazon): readinessTier "descartar"', dealResult.readinessTier === 'descartar', dealResult.readinessTier);
check('(c) Oferta comercial: eligibleToUse false (bloqueo mecánico real)', dealResult.eligibleToUse === false);
check('(c) Oferta comercial: la razón de "-40 oferta...compra" queda explicada en readinessReasons',
  dealResult.readinessReasons.some(function (r) { return r.indexOf('-40') === 0; }), JSON.stringify(dealResult.readinessReasons));
// (Ver test-commercial-deal-filter.js para la batería completa de este caso,
// incluida la detección/UI/servidor -- acá solo se confirma el puntaje.)

// ============================================================================
// (d) Noticia con plazo/evento ya vencido -> "descartar"
// ============================================================================
const EXPIRED_STORY = {
  title: 'Conference Announces Final Speaker Lineup',
  sourceHeadline: 'Tech Conference Announces Final Speaker Lineup Ahead of Event',
  sourceTitle: 'The Verge',
  sourceDomain: 'theverge.com',
  sourceUrl: 'https://www.theverge.com/2026/tech-conference-lineup-announced',
  dek: 'Organizers confirmed the schedule for the event.',
  body: 'The registration deadline for the annual technology conference was set for March 3, 2026, organizers said, ahead of the multi-day event.',
  category: 'technology',
  additionalSources: [{ url: 'https://example.com/conference-coverage', label: 'Example News' }]
};
const expiredResult = pipeline.classifyDraft(EXPIRED_STORY);
check('(d) Noticia vencida: readinessTier "descartar"', expiredResult.readinessTier === 'descartar', expiredResult.readinessTier);
check('(d) Noticia vencida: expired:true con la fecha detectada', expiredResult.expired === true && !!expiredResult.expiredDeadline, JSON.stringify({ expired: expiredResult.expired, expiredDeadline: expiredResult.expiredDeadline }));
check('(d) Noticia vencida: eligibleToUse false (bloqueo mecánico real)', expiredResult.eligibleToUse === false);
check('(d) Noticia vencida: la razón de "-35 fecha límite...vencido" queda explicada en readinessReasons',
  expiredResult.readinessReasons.some(function (r) { return r.indexOf('-35') === 0; }), JSON.stringify(expiredResult.readinessReasons));

// ============================================================================
// (e) Duplicado de un artículo YA existente (vía allArticles, opt-in) ->
// bloqueado / "descartar"
// ============================================================================
const PUBLISHED_FOR_DUPLICATE_CHECK = [{
  category: 'business', slug: 'existing-transit-story',
  title: 'City Council Approves New Downtown Transit Line',
  dek: 'The project will add light rail service connecting downtown to the airport.'
}];
const DUPLICATE_STORY = {
  title: 'City Council Approves New Downtown Transit Line Expansion',
  sourceHeadline: 'City Council Approves New Downtown Transit Line Expansion Plan',
  sourceTitle: 'Local News',
  sourceDomain: 'localnews.example',
  sourceUrl: 'https://localnews.example/2026/transit-line-approved',
  dek: 'The city approved a new light rail line connecting downtown to the airport.',
  body: 'The city council approved a new downtown transit line Thursday, adding light rail service between downtown and the airport, officials said.',
  category: 'business',
  additionalSources: [{ url: 'https://example.com/transit-coverage', label: 'Example News' }]
};
const duplicateResult = pipeline.classifyDraft(DUPLICATE_STORY, PUBLISHED_FOR_DUPLICATE_CHECK);
check('(e) Duplicado real (vía allArticles): isDuplicate:true, con el título del artículo existente',
  duplicateResult.isDuplicate === true && duplicateResult.duplicateOf === 'City Council Approves New Downtown Transit Line', JSON.stringify({ isDuplicate: duplicateResult.isDuplicate, duplicateOf: duplicateResult.duplicateOf }));
check('(e) Duplicado real: readinessTier "descartar"', duplicateResult.readinessTier === 'descartar', duplicateResult.readinessTier);
check('(e) Duplicado real: eligibleToUse false (bloqueado)', duplicateResult.eligibleToUse === false);
check('(e) Duplicado real: la razón de "-30 duplicado" queda explicada en readinessReasons',
  duplicateResult.readinessReasons.some(function (r) { return r.indexOf('-30') === 0; }), JSON.stringify(duplicateResult.readinessReasons));

// ---- Regresión de diseño: SIN pasar allArticles, isDuplicate/
// hasGraveContradiction siguen dando siempre false -- mismo texto que (e)
// arriba, pero llamado con un solo argumento, igual que TODO el código y
// los tests existentes antes de esta mejora (opt-in real, cero cambio de
// comportamiento para quien no pasa el segundo parámetro).
const duplicateResultNoAllArticles = pipeline.classifyDraft(DUPLICATE_STORY);
check('(regresión) classifyDraft(d) con un solo argumento: isDuplicate sigue siendo false (opt-in, sin cambio de comportamiento)',
  duplicateResultNoAllArticles.isDuplicate === false && duplicateResultNoAllArticles.duplicateOf === null, JSON.stringify(duplicateResultNoAllArticles));
check('(regresión) classifyDraft(d) con un solo argumento: hasGraveContradiction sigue siendo false',
  duplicateResultNoAllArticles.hasGraveContradiction === false);
check('(regresión) classifyDraft(d) con un solo argumento: sin el bloqueo de duplicado, este mismo texto no se descarta solo por eso',
  duplicateResultNoAllArticles.readinessTier !== 'descartar' || duplicateResultNoAllArticles.eligibleToUse === true,
  'readinessTier=' + duplicateResultNoAllArticles.readinessTier + ' eligibleToUse=' + duplicateResultNoAllArticles.eligibleToUse);

// ============================================================================
// Reglas de presentación (parte 6 y 7 del pedido de puntuación) verificables
// a nivel de datos sin DOM: nunca "listo" si hay CUALQUIER advertencia,
// aunque el puntaje sea alto.
// ============================================================================
const HIGH_SCORE_BUT_SINGLE_SOURCE = Object.assign({}, COMPLETE_STORY, {
  additionalSources: [],
  singleSourceWarning: true
});
const highScoreSingle = pipeline.classifyDraft(HIGH_SCORE_BUT_SINGLE_SOURCE);
check('Regla 6: un puntaje alto con una advertencia (fuente única) NUNCA es "listo", queda en "revisar"',
  highScoreSingle.readinessTier === 'revisar', 'score=' + highScoreSingle.editorialReadinessScore + ' tier=' + highScoreSingle.readinessTier);

const HIGH_SCORE_BUT_SIMILARITY_WARNING = Object.assign({}, COMPLETE_STORY, { similarityWarning: true, similarityScore: 72 });
const highScoreSimilarity = pipeline.classifyDraft(HIGH_SCORE_BUT_SIMILARITY_WARNING);
check('Regla 6: un puntaje alto con advertencia de similaridad alta NUNCA es "listo"',
  highScoreSimilarity.readinessTier === 'revisar', 'score=' + highScoreSimilarity.editorialReadinessScore + ' tier=' + highScoreSimilarity.readinessTier);

// "Listo" nunca implica aprobado/publicado (requisito 7): el campo que de
// verdad manda para publicar (editorialApproval) es completamente
// independiente de readinessTier -- este puntaje es solo de priorización.
check('Requisito 7: classifyDraft nunca agrega ni infiere "editorialApproval" -- la aprobación humana sigue siendo un campo aparte',
  !('editorialApproval' in completeResult), 'campos devueltos: ' + Object.keys(completeResult).join(', '));

// ---- Regresión: los 141 artículos reales no se tocaron en ningún momento
// (este archivo nunca escribe disco, pero se confirma igual por consistencia
// con el resto de la batería). ----
const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
check('data/articulos.json del sitio REAL no cambió durante estas pruebas (este archivo no escribe disco) (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
check('El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
