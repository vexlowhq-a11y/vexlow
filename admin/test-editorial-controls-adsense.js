#!/usr/bin/env node
/*
  admin/test-editorial-controls-adsense.js
  =========================================
  Pedido de Leonardo (2026-09-24), "AGREGADO OBLIGATORIO -- GOOGLE ADSENSE,
  SEARCH Y CALIDAD EDITORIAL": paquete concentrado de controles editoriales
  para los artículos NUEVOS generados por el pipeline de tendencias. Este
  archivo cubre las pruebas explícitamente pedidas en los puntos 1
  (contenido sensible), 4 (transparencia), 7 (imágenes) y 9 (batería
  general) del documento, que no tenían un archivo dedicado propio hasta
  ahora -- las de originalidad entre borradores y corroboración de dos
  fuentes YA estaban cubiertas en profundidad en test-source-corroboration.js
  y test-two-phase-pipeline.js (este archivo agrega ahí donde faltaba, no
  duplica lo que ya existía).

  La mayoría de las funciones de acá son PURAS (detectSensitiveEditorialTopics,
  detectTransparencyRisk, computeEditorialValue, classifyDraft con
  allArticles pasado a mano, validateImageFields, findGraveContradiction,
  validateSourcesAndQuality) -- no tocan disco ni red, así que estas
  secciones corren directo contra admin/pipeline.js real, sin copia
  aislada. Las dos excepciones (5 y 8, que sí escriben a disco) usan su
  propio tmpdir aparte, nunca la carpeta real del sitio.

  Índice:
    1. Clasificador de contenido sensible (punto 1: hacking, despidos,
       rumor financiero, demanda, tratamiento médico, tecnología normal,
       estreno de película, resultado deportivo normal).
    2. Aporte editorial verificable (punto 2/9: <3 elementos -> revisar,
       >=3 -> puede quedar listo, nunca por autodeclaración de la IA).
    3. Transparencia / falsa afiliación (punto 4/9).
    4. Contradicción grave: bloqueo consistente entre classifyDraft y
       validateSourcesAndQuality (punto 6/9).
    5. Originalidad entre dos borradores de la misma corrida (punto 3/9),
       de punta a punta contra fetchNewDrafts() real.
    6. Imágenes: las 4 pruebas dedicadas del punto 7.
    7. Registro editorial (editorialMeta) sobrevive abrir/guardar; campos
       de actualización/corrección existentes no se duplican ni se
       pierden (punto 5/9), contra articles-store.js real.
    8. maxAIDrafts no aumentó; el sitio real (141) no cambió.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const pipeline = require('./pipeline.js');
const articlesStore = require('./articles-store.js');
const feeds = require('./feeds.js');
const draft = require('./draft.js');
const integrity = require('./articulos-integrity-check');
const REAL_ROOT = path.join(__dirname, '..');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}

// ============================================================================
// 1. CLASIFICADOR DE CONTENIDO SENSIBLE (pedido punto 1)
// ============================================================================
(function sensitiveTopicTests() {
  // (a) Hacking: bloqueo REAL (mecánico), no solo "revisar".
  var hackingText = "Here's how to hack into your ex's email account in five easy steps, according to a viral tutorial.";
  var hacking = pipeline.detectSensitiveEditorialTopics(hackingText);
  check('1a. Instrucciones reales de hacking: hackingInstructions:true (bloqueo mecánico)', hacking.hackingInstructions === true, JSON.stringify(hacking));

  // (a-bis) Noticia normal SOBRE un hackeo (no instructiva) -- sensible,
  // revisión obligatoria, pero NUNCA el bloqueo mecánico de arriba.
  var breachNewsText = 'Bramwell Systems confirmed a data breach affecting customer records after researchers discovered a security vulnerability in its login system.';
  var breachNews = pipeline.detectSensitiveEditorialTopics(breachNewsText);
  check('1a-bis. Noticia de que HUBO un hackeo (no instructiva): isSensitive:true, hackingInstructions:false', breachNews.isSensitive === true && breachNews.hackingInstructions === false, JSON.stringify(breachNews));
  check('1a-bis. Categoría detectada es "crime-security"', breachNews.categories.indexOf('crime-security') !== -1, JSON.stringify(breachNews.categories));

  // (b) Despidos.
  var layoffsText = 'Kestrel Robotics laid off 12% of its staff on Thursday as part of a broader restructuring, the company confirmed.';
  var layoffs = pipeline.detectSensitiveEditorialTopics(layoffsText);
  check('1b. Despidos: isSensitive:true, categoría "layoffs-bankruptcy"', layoffs.isSensitive === true && layoffs.categories.indexOf('layoffs-bankruptcy') !== -1, JSON.stringify(layoffs));

  // (c) Rumor financiero.
  var rumorText = 'Sources say the company is reportedly in talks for a possible acquisition, though nothing has been officially announced.';
  var rumor = pipeline.detectSensitiveEditorialTopics(rumorText);
  check('1c. Rumor financiero: isSensitive:true, categoría "financial-rumor"', rumor.isSensitive === true && rumor.categories.indexOf('financial-rumor') !== -1, JSON.stringify(rumor));

  // (d) Demanda.
  var lawsuitText = 'A federal judge ruled that the lawsuit against the company can proceed, after the plaintiff sued over alleged patent infringement.';
  var lawsuit = pipeline.detectSensitiveEditorialTopics(lawsuitText);
  check('1d. Demanda: isSensitive:true, categoría "legal"', lawsuit.isSensitive === true && lawsuit.categories.indexOf('legal') !== -1, JSON.stringify(lawsuit));

  // (e) Tratamiento médico.
  var medicalText = 'The FDA approved a new treatment for the disease after a successful clinical trial showed reduced side effects in patients.';
  var medical = pipeline.detectSensitiveEditorialTopics(medicalText);
  check('1e. Tratamiento médico: isSensitive:true, categoría "health"', medical.isSensitive === true && medical.categories.indexOf('health') !== -1, JSON.stringify(medical));

  // (f) Noticia tecnológica NORMAL, no sensible.
  var normalTechText = 'The company unveiled its new laptop lineup on Tuesday, featuring a faster processor and a redesigned keyboard for the upcoming school year.';
  var normalTech = pipeline.detectSensitiveEditorialTopics(normalTechText);
  check('1f. Noticia tecnológica normal: isSensitive:false', normalTech.isSensitive === false, JSON.stringify(normalTech));

  // (g) Estreno de película, sin ningún término sensible.
  var moviePremiereText = 'The studio announced that its highly anticipated sequel will premiere in theaters nationwide next spring, with an ensemble cast returning for the third installment.';
  var moviePremiere = pipeline.detectSensitiveEditorialTopics(moviePremiereText);
  check('1g. Estreno de película: isSensitive:false', moviePremiere.isSensitive === false, JSON.stringify(moviePremiere));

  // (h) Resultado deportivo normal.
  var sportsResultText = 'The home team won the match 3-1 on Saturday night, clinching a spot in the regional finals after a strong second-half performance.';
  var sportsResult = pipeline.detectSensitiveEditorialTopics(sportsResultText);
  check('1h. Resultado deportivo normal: isSensitive:false', sportsResult.isSensitive === false, JSON.stringify(sportsResult));

  // (i) classifyDraft: un borrador sensible con puntaje 100 NUNCA llega a
  // "listo" -- ver punto 9 del pedido ("sensible con puntaje 100 -> revisar").
  var sensitiveHighScoreDraft = {
    title: 'Meridian Health Reports Encouraging Results In New Cancer Treatment Trial',
    dek: 'The clinical trial for the new cancer treatment showed promising results, the company said Tuesday.',
    body: 'Meridian Health said Tuesday that its clinical trial for a new cancer treatment showed encouraging results among patients.\n\n## Trial details\nThe treatment, still pending full FDA approval, was tested over an 18-month period across several medical centers.\n\n## What comes next\nResearchers say the next step involves a larger follow-up trial before any wider rollout can be considered.',
    category: 'business', sourceUrl: 'https://example.com/meridian-health-trial', sourcePublishedAt: new Date().toISOString(),
    additionalSources: [{ url: 'https://otra-fuente.example/meridian', label: 'Otra Fuente' }],
    keyClaims: [{ claim: 'El ensayo mostró resultados alentadores.', sourceLabel: 'Meridian Health' }],
    editorialValue: { elementCount: 4, meetsMinimum: true, elements: ['historical-context', 'limitations', 'what-to-watch', 'confirmed-vs-reported'] }
  };
  var sensitiveTier = pipeline.classifyDraft(sensitiveHighScoreDraft);
  check('1i. (req 9) Sensible con puntaje alto: readinessTier "revisar", NUNCA "listo"', sensitiveTier.readinessTier === 'revisar' && sensitiveTier.editorialReadinessScore >= 80, JSON.stringify({ tier: sensitiveTier.readinessTier, score: sensitiveTier.editorialReadinessScore }));
  check('1i. El puntaje NO se redujo artificialmente por ser sensible (sigue >= 80)', sensitiveTier.editorialReadinessScore >= 80);
  check('1i. eligibleToUse sigue true -- "Usar este borrador" para revisión manual sigue habilitado', sensitiveTier.eligibleToUse === true);
  check('1i. recommendation "revisar", nunca "descartar" solo por ser sensible', sensitiveTier.recommendation === 'revisar');
  check('1i. sensitiveTopics incluye "health"', sensitiveTier.sensitiveTopics.indexOf('health') !== -1, JSON.stringify(sensitiveTier.sensitiveTopics));

  // (j) classifyDraft: hacking real SÍ descarta (bloqueo mecánico real).
  var hackingDraft = {
    title: 'Leaked Tutorial Shows How To Hack Into Home Wifi Routers',
    dek: "Here's how to hack into any home wifi router using a downloaded tool, according to the leaked guide.",
    body: 'The guide explains step-by-step how to hack home wifi routers using widely available software.',
    category: 'technology', sourceUrl: 'https://example.com/wifi-hack-guide'
  };
  var hackingTier = pipeline.classifyDraft(hackingDraft);
  check('1j. Hacking real en classifyDraft: readinessTier "descartar", eligibleToUse:false', hackingTier.readinessTier === 'descartar' && hackingTier.eligibleToUse === false, JSON.stringify({ tier: hackingTier.readinessTier, eligible: hackingTier.eligibleToUse }));
  check('1j. sensitiveBlocked:true', hackingTier.sensitiveBlocked === true);
})();

// ============================================================================
// 2. APORTE EDITORIAL VERIFICABLE (pedido punto 2/9)
// ============================================================================
(function editorialValueTests() {
  // (a) Menos de 3 elementos con evidencia real en el cuerpo -> "Requiere
  // revisión", aunque la IA haya "declarado" muchos más (nunca se confía
  // en la autodeclaración).
  var thinBody = 'The company announced a new product on Tuesday. It will be available soon. More details were not shared.';
  var thinValue = pipeline.computeEditorialValue({ body: thinBody }, {
    // Autodeclaración de la IA con 8 elementos -- se ignora por completo
    // para el conteo real (elementCount/meetsMinimum), que mide el cuerpo.
    whatHappened: 'x', whyItMatters: 'x', confirmed: ['a', 'b', 'c'], uncertain: ['d'], whatToWatch: ['e', 'f', 'g']
  });
  check('2a. Cuerpo débil (0-1 elementos reales): meetsMinimum:false pese a que la IA "declaró" mucho más', thinValue.meetsMinimum === false, JSON.stringify(thinValue));
  check('2a. El conteo real ignora por completo la autodeclaración de la IA (no confía ciegamente)', thinValue.elementCount < 3, JSON.stringify(thinValue.elementCount));

  // (b) 3+ elementos con evidencia real -> puede llegar a "listo".
  var richBody = 'The company has offered this service since 2019, according to public filings.\n\n## Context\nCompared to its previous offering, the new version adds several features, and this could affect how competitors respond.\n\n## What to watch\nHowever, it remains unclear how pricing will change. Next steps include a wider regional rollout later this year.';
  var richValue = pipeline.computeEditorialValue({ body: richBody }, null);
  check('2b. Cuerpo con aporte real (>=3 elementos): meetsMinimum:true', richValue.meetsMinimum === true && richValue.elementCount >= 3, JSON.stringify(richValue));

  // (c) classifyDraft: gate SOLO se activa cuando editorialValue viene
  // precalculado por el pipeline real (fail-open para no penalizar
  // retroactivamente un borrador/artículo/fixture viejo que nunca tuvo
  // la chance de declarar sus elementos) -- mismo criterio que
  // similarityScore/similarityWarning.
  var thinDraftNoPrecomputed = { title: 'Some Old Draft Without editorialValue', dek: 'x', body: thinBody, category: 'business', sourceUrl: 'https://example.com/old-draft' };
  var thinNoPrecomputedTier = pipeline.classifyDraft(thinDraftNoPrecomputed);
  check('2c. Sin editorialValue precalculado: insufficientEditorialValue NUNCA se activa solo (fail-open, no penaliza retroactivamente)', thinNoPrecomputedTier.insufficientEditorialValue === false, JSON.stringify(thinNoPrecomputedTier.insufficientEditorialValue));

  var thinDraftPrecomputed = Object.assign({}, thinDraftNoPrecomputed, { editorialValue: thinValue });
  var thinPrecomputedTier = pipeline.classifyDraft(thinDraftPrecomputed);
  check('2c. CON editorialValue precalculado insuficiente: insufficientEditorialValue:true, readinessTier "revisar"', thinPrecomputedTier.insufficientEditorialValue === true && thinPrecomputedTier.readinessTier === 'revisar', JSON.stringify({ insuf: thinPrecomputedTier.insufficientEditorialValue, tier: thinPrecomputedTier.readinessTier }));

  // (d) Un borrador con buen puntaje Y >=3 elementos reales sí puede
  // llegar a "listo" (la regla no es punitiva de más).
  var richDraft = {
    title: 'Cascadia Freight Opens New Regional Hub After Years Of Planning',
    dek: 'Cascadia Freight opened a new regional distribution hub on Tuesday, the company confirmed.',
    body: richBody, category: 'business', sourceUrl: 'https://example.com/cascadia-hub', sourcePublishedAt: new Date().toISOString(),
    additionalSources: [{ url: 'https://otra-fuente.example/cascadia', label: 'Otra Fuente' }],
    keyClaims: [{ claim: 'Se abrió un nuevo centro de distribución.', sourceLabel: 'Cascadia Freight' }],
    editorialValue: richValue
  };
  var richTier = pipeline.classifyDraft(richDraft);
  check('2d. Puntaje alto + >=3 elementos reales: readinessTier "listo"', richTier.readinessTier === 'listo' && richTier.editorialReadinessScore >= 80, JSON.stringify({ tier: richTier.readinessTier, score: richTier.editorialReadinessScore }));

  // (e) El objeto editorialValue nunca se imprime como JSON crudo en la
  // página pública -- pagegen.js/generate_pages.py no lo referencian en
  // absoluto (metadato interno, no de cara al público).
  var pagegenSrc = fs.readFileSync(path.join(__dirname, 'pagegen.js'), 'utf8');
  var genPagesSrc = fs.readFileSync(path.join(__dirname, 'generate_pages.py'), 'utf8');
  check('2e. pagegen.js nunca referencia editorialValue (no se imprime en la página pública)', pagegenSrc.indexOf('editorialValue') === -1);
  check('2e. generate_pages.py nunca referencia editorialValue/editorial_value', genPagesSrc.indexOf('editorialValue') === -1 && genPagesSrc.indexOf('editorial_value') === -1);
})();

// ============================================================================
// 3. TRANSPARENCIA / FALSA AFILIACIÓN (pedido punto 4/9)
// ============================================================================
(function transparencyTests() {
  // (a) Falsa afiliación/presencia directa.
  var affiliationText = 'Our partner Google helped make this coverage possible, and our team was on the scene for the announcement.';
  var affiliation = pipeline.detectTransparencyRisk(affiliationText);
  check('3a. Falsa afiliación/presencia directa: hasRisk:true', affiliation.hasRisk === true, JSON.stringify(affiliation));

  // (b) "Confirmado oficialmente" mezclado con lenguaje de rumor, SIN
  // atribución legítima cerca -> riesgo.
  var upgradeText = 'Sources say the company is reportedly considering a merger. The company has confirmed the deal, according to unnamed insiders close to the matter -- but no official statement has been made.';
  // A propósito, versión SIN atribución cercana a "the company has confirmed the deal":
  var upgradeTextNoAttribution = 'Rumor has it the company is reportedly considering a merger. The company has confirmed the deal, and everyone is celebrating this huge milestone in absolute silence.';
  var upgrade = pipeline.detectTransparencyRisk(upgradeTextNoAttribution);
  check('3b. "Confirmado oficialmente" + lenguaje de rumor, sin atribución cercana: hasRisk:true', upgrade.hasRisk === true, JSON.stringify(upgrade));

  // (c) La MISMA frase de "confirmado", pero dentro de una cita
  // correctamente atribuida (marcador de atribución justo antes) -- NO
  // debe bloquear una frase legítima.
  var legitQuoteText = 'Sources say the company is reportedly considering a merger. According to a person familiar with the matter, the company has confirmed the deal internally, though no public announcement has been made yet.';
  var legitQuote = pipeline.detectTransparencyRisk(legitQuoteText);
  check('3c. (req 4) Cita legítimamente atribuida: NO se bloquea ("according to" cerca de "confirmed")', legitQuote.hasRisk === false, JSON.stringify(legitQuote));

  // (d) Texto perfectamente normal, sin ningún riesgo de transparencia.
  var normalText = 'The company released its quarterly earnings report on Tuesday, showing revenue growth compared to the same period last year.';
  var normal = pipeline.detectTransparencyRisk(normalText);
  check('3d. Texto normal sin riesgo de transparencia: hasRisk:false', normal.hasRisk === false, JSON.stringify(normal));

  // (e) classifyDraft: riesgo de transparencia fuerza "revisar", nunca
  // "listo", y NUNCA descarta por sí solo.
  var transparencyDraft = {
    title: 'Community Group Says It Witnessed Company Event Firsthand',
    dek: 'We witnessed the entire announcement in person, our team says.',
    body: 'We witnessed the entire announcement in person on Tuesday.\n\n## Context\nThe event drew a large crowd of attendees.\n\n## What happened\nOrganizers described the event as a success.',
    category: 'business', sourceUrl: 'https://example.com/community-event', sourcePublishedAt: new Date().toISOString(),
    additionalSources: [{ url: 'https://otra-fuente.example/evento', label: 'Otra Fuente' }],
    keyClaims: [{ claim: 'El evento tuvo lugar el martes.', sourceLabel: 'Fuente Comunitaria' }]
  };
  var transparencyTier = pipeline.classifyDraft(transparencyDraft);
  check('3e. Riesgo de transparencia en classifyDraft: readinessTier "revisar" (nunca "listo")', transparencyTier.readinessTier === 'revisar', JSON.stringify({ tier: transparencyTier.readinessTier, score: transparencyTier.editorialReadinessScore }));
  check('3e. eligibleToUse sigue true (no descarta por sí solo)', transparencyTier.eligibleToUse === true);
  check('3e. recommendation "revisar"', transparencyTier.recommendation === 'revisar');
})();

// ============================================================================
// 4. CONTRADICCIÓN GRAVE: bloqueo consistente (pedido punto 6/9)
// ============================================================================
(function graveContradictionConsistencyTests() {
  var published = [{
    slug: 'bramwell-denies-data-breach', category: 'business',
    title: 'Bramwell Systems Denies Data Breach Allegations',
    dek: 'Bramwell Systems denies data breach allegations made by researchers this week.',
    body: 'Bramwell Systems said Tuesday that it denies the data breach allegations made by outside researchers this week, calling the claims unfounded.'
  }];
  var contradictingDraft = {
    title: 'Bramwell Systems Confirms Data Breach After Internal Investigation',
    dek: 'Bramwell Systems confirms the data breach after an internal investigation this week.',
    body: 'Bramwell Systems confirmed Wednesday that it experienced the data breach after an internal investigation this week found evidence of unauthorized access.',
    category: 'business', sourceUrl: 'https://example.com/bramwell-confirms'
  };

  var overlapCheck = pipeline.classifyDraft(contradictingDraft); // sin allArticles: nunca puede detectar contradicción (opt-in)
  check('4a. Sin allArticles (opt-in): hasGraveContradiction sigue false, sin cambio de comportamiento', overlapCheck.hasGraveContradiction === false);

  var withArticles = pipeline.classifyDraft(contradictingDraft, published);
  check('4b. classifyDraft CON allArticles: detecta la contradicción grave real', withArticles.hasGraveContradiction === true, JSON.stringify({ hasGraveContradiction: withArticles.hasGraveContradiction, duplicateOf: withArticles.duplicateOf }));
  check('4b. readinessTier "descartar", eligibleToUse:false (bloqueo mecánico)', withArticles.readinessTier === 'descartar' && withArticles.eligibleToUse === false);

  // El mismo hallazgo, por el otro camino (guardado manual real) --
  // findGraveContradiction() es la MISMA función que usa classifyDraft
  // arriba, así que el resultado tiene que ser consistente entre los dos
  // caminos (antes de este pedido, validateSourcesAndQuality tenía su
  // propio bucle duplicado que solo generaba una advertencia, nunca un
  // bloqueo real -- ver comentario en el código).
  var manualSaveArticle = Object.assign({}, contradictingDraft, {
    slug: 'bramwell-confirms-data-breach', editorialApproval: true, sourceTitle: 'Example Wire', additionalSources: [{ url: 'https://otra-fuente.example/x', label: 'Otra Fuente' }]
  });
  var manualSaveResult = pipeline.validateSourcesAndQuality(manualSaveArticle, published);
  check('4c. (req 6) Guardado manual: la contradicción grave es un ISSUE que bloquea (422), no solo una advertencia', manualSaveResult.issues.some(function (i) { return /contradice|contradicción/i.test(i.message || i); }), JSON.stringify(manualSaveResult.issues));

  // Contraejemplo: dos artículos sobre temas totalmente distintos nunca
  // se marcan como contradicción (nunca un falso positivo por casualidad).
  var unrelatedDraft = { title: 'Local Bakery Wins Regional Pastry Competition', dek: 'A local bakery took first place in a regional pastry competition this weekend.', body: 'The bakery earned top honors for its pastry entry.', category: 'business', sourceUrl: 'https://example.com/bakery' };
  var unrelatedResult = pipeline.classifyDraft(unrelatedDraft, published);
  check('4d. Contraejemplo: tema no relacionado nunca genera un falso positivo de contradicción', unrelatedResult.hasGraveContradiction === false);
})();

// ============================================================================
// 5. ORIGINALIDAD ENTRE DOS BORRADORES DE LA MISMA CORRIDA (pedido punto 3/9)
// ============================================================================
(async function sameRunDedupTest() {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-samerun-dedup-'));
  var dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'articulos.json'), fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json')));
  fs.writeFileSync(path.join(dataDir, 'drafts.json'), '[]\n');
  fs.writeFileSync(path.join(dataDir, 'discarded-sources.json'), '[]\n');
  fs.writeFileSync(path.join(dataDir, 'candidate-cache.json'), '{}\n');

  // pipeline.js resuelve rutas de datos relativas a __dirname/../data --
  // para que esta prueba use dataDir aislado sin copiar TODO el sitio (a
  // diferencia de test-two-phase-pipeline.js), hace falta ejecutar dentro
  // de una copia completa (pagegen.js/feeds.js necesitan otros archivos
  // reales del sitio, como categorías). Se replica el patrón ya probado:
  // copia aislada completa, nunca el sandbox real.
  function copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (var entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      var s = path.join(src, entry.name), d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDirSync(s, d); else fs.copyFileSync(s, d);
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  copyDirSync(REAL_ROOT, tmpRoot);
  try { fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction'); } catch (e) {}
  var draftsPath2 = path.join(tmpRoot, 'data', 'drafts.json');
  fs.writeFileSync(draftsPath2, '[]\n');
  fs.writeFileSync(path.join(tmpRoot, 'data', 'discarded-sources.json'), '[]\n');
  fs.writeFileSync(path.join(tmpRoot, 'data', 'candidate-cache.json'), '{}\n');

  var pipeline2 = require(path.join(tmpRoot, 'admin', 'pipeline.js'));
  var feeds2 = require(path.join(tmpRoot, 'admin', 'feeds.js'));
  var draft2 = require(path.join(tmpRoot, 'admin', 'draft.js'));

  function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
  // Dos "clusters" reales e independientes (entidades distintas, así el
  // motor de corroboración real de la FASE 1 nunca los confunde entre sí
  // ni con el otro): cada uno con su propia fuente principal + segunda
  // fuente independiente real, para que AMBOS lleguen a redactarse.
  var clusterA = [
    { category: 'business', title: 'Northfall Freight Opens New Regional Hub In The Midwest', summary: 'Northfall Freight opened a new regional distribution hub in the Midwest on Tuesday.', link: 'https://dedupa1.example/2026/09/hub', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'dedupa1.example', outlet: 'DedupA1' },
    { category: 'business', title: 'Northfall Freight Debuts Distribution Hub Serving The Midwest Region', summary: 'A newly built distribution hub for Northfall Freight began serving the Midwest region starting Tuesday, the firm confirmed.', link: 'https://dedupa2.example/2026/09/hub-details', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'dedupa2.example', outlet: 'DedupA2' }
  ];
  var clusterB = [
    { category: 'business', title: 'Verdant Analytics Introduces Subscription Pricing Plan For Its Platform', summary: 'Verdant Analytics introduced a new subscription pricing plan for its platform on Tuesday.', link: 'https://dedupb1.example/2026/09/pricing', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'dedupb1.example', outlet: 'DedupB1' },
    { category: 'business', title: 'Verdant Analytics Rolls Out Pricing Plan For Platform Users', summary: 'A subscription pricing plan for Verdant Analytics platform users went into effect Tuesday, the firm noted.', link: 'https://dedupb2.example/2026/09/pricing-details', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'dedupb2.example', outlet: 'DedupB2' }
  ];
  feeds2.fetchAllFeedItems = function () { return Promise.resolve({ items: clusterA.concat(clusterB), errors: [] }); };
  pipeline2.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
  pipeline2.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
  draft2.loadConfig = function () { return { draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }; };
  // A propósito: la IA (mock) redacta las DOS historias -- de dos
  // empresas distintas -- con título/dek casi idénticos entre sí, para
  // simular el caso real que este control cubre (dos candidatos
  // distintos que, tras la redacción, terminan cubriendo el mismo hecho
  // en la práctica). additionalSources.length decide cuál se conserva
  // cuando hay empate de puntaje -- acá ambos tienen 1, así que se
  // conserva el primero en redactarse (orden de redacción, ver comentario
  // en pipeline.js).
  draft2.draftArticle = function (item, cfg, categoryOptions, sourcesForPrompt) {
    return Promise.resolve({
      title: 'Regional Logistics Firm Expands Operations This Week',
      dek: 'A regional logistics firm confirmed an expansion of its operations this week, the company said.',
      body: 'A regional logistics firm confirmed an expansion of its operations this week.\n\n## Context\nThe expansion follows months of planning.\n\n## Next steps\nThe company said further details would come later.',
      category: item.category, readTime: '3 min',
      keyClaims: [{ claim: 'Se confirmó una expansión.', sourceLabel: sourcesForPrompt.primary.outlet }]
    });
  };

  var result = await pipeline2.fetchNewDrafts();
  check('5a. Dos candidatos corroborados de la misma corrida -> ambos se redactan (2 llamadas de IA)', result.aiCallsMade === 2, JSON.stringify({ aiCallsMade: result.aiCallsMade }));
  check('5b. (req 3, req 9) Pero solo UNO sobrevive -- el otro se descarta por duplicado de la misma corrida', result.added === 1, JSON.stringify({ added: result.added }));
  check('5b. sameRunDuplicatesDiscarded documenta cuál se descartó y por qué', Array.isArray(result.sameRunDuplicatesDiscarded) && result.sameRunDuplicatesDiscarded.length === 1 && !!result.sameRunDuplicatesDiscarded[0].reason, JSON.stringify(result.sameRunDuplicatesDiscarded));

  var draftsOnDisk = JSON.parse(fs.readFileSync(draftsPath2, 'utf8'));
  check('5c. En disco queda exactamente UN borrador (no dos casi iguales)', draftsOnDisk.length === 1, JSON.stringify(draftsOnDisk.length));

  // Corrección de Leonardo (2026-09-25): discarded-sources.json está
  // reservado EXCLUSIVAMENTE para descartes manuales expresos -- la
  // deduplicación automática de la misma corrida NUNCA debe escribir ahí
  // (un heurístico puede tener falsos positivos, y una URL nunca debe
  // quedar excluida para siempre solo por esto).
  var discardedSources = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'discarded-sources.json'), 'utf8'));
  check('5d. (req Leonardo 2026-09-25) La deduplicación automática NUNCA modifica discarded-sources.json', Array.isArray(discardedSources) && discardedSources.length === 0, JSON.stringify(discardedSources));

  // En cambio, queda anotado en candidate-cache.json con motivo
  // 'same-run-duplicate' -- la misma caché técnica de 24hs que ya usa
  // buildCandidates(), así que no se vuelve a redactar de inmediato en la
  // corrida siguiente, pero tampoco queda bloqueada para siempre.
  var candidateCacheOnDisk = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'candidate-cache.json'), 'utf8'));
  var discardedEntry = result.sameRunDuplicatesDiscarded[0];
  var discardedUrl = (discardedEntry.discardedSlug === draftsOnDisk[0].slug) ? null :
    (clusterA[0].link.indexOf(discardedEntry.discardedTitle.replace(/\.\.\.$/, '')) !== -1 ? clusterA[0].link : null);
  var cachedEntries = Object.keys(candidateCacheOnDisk).map(function (u) { return candidateCacheOnDisk[u]; });
  check('5e. En cambio, sí queda anotado en candidate-cache.json con motivo "same-run-duplicate"', cachedEntries.some(function (e) { return e.reason === 'same-run-duplicate'; }), JSON.stringify(candidateCacheOnDisk));
  check('5e. La entrada de la caché trae marca de tiempo (para poder vencer a las 24hs)', cachedEntries.every(function (e) { return typeof e.cachedAt === 'string' && !isNaN(Date.parse(e.cachedAt)); }));

  // (req Leonardo 2026-09-25) Después de 24hs, puede reevaluarse -- se
  // simula reescribiendo la entrada con una marca de tiempo vieja (25hs) y
  // confirmando que pruneCandidateCache() (la misma poda que usa
  // buildCandidates() en cada corrida real) ya no la conserva.
  var oldCache = {};
  Object.keys(candidateCacheOnDisk).forEach(function (u) {
    oldCache[u] = { reason: candidateCacheOnDisk[u].reason, cachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
  });
  var prunedAfter25h = pipeline2.pruneCandidateCache(oldCache);
  check('5f. (req 9) Pasadas las 24hs, la entrada "same-run-duplicate" se poda sola -- la URL se reevalúa de cero', Object.keys(prunedAfter25h).length === 0, JSON.stringify(prunedAfter25h));
  // Contraejemplo: una entrada de hace 1 hora SÍ sigue vigente (no se poda
  // antes de tiempo).
  var freshCache = {};
  Object.keys(candidateCacheOnDisk).forEach(function (u) {
    freshCache[u] = { reason: candidateCacheOnDisk[u].reason, cachedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() };
  });
  var prunedAfter1h = pipeline2.pruneCandidateCache(freshCache);
  check('5f. Contraejemplo: una entrada de 1 hora todavía sigue vigente (no se poda antes de tiempo)', Object.keys(prunedAfter1h).length === Object.keys(freshCache).length);

  // (req Leonardo 2026-09-25) Un descarte MANUAL sigue funcionando como
  // antes -- discardDraft() (el botón real de "Descartar" del panel) SÍ
  // debe seguir escribiendo en discarded-sources.json, a diferencia de la
  // deduplicación automática de arriba. Se prueba contra el borrador que
  // sí sobrevivió esta corrida.
  var survivorSlug = draftsOnDisk[0].slug;
  var manualDiscardOk = pipeline2.discardDraft(survivorSlug);
  check('5g. (req Leonardo 2026-09-25) Un descarte MANUAL (discardDraft) sigue funcionando igual que antes', manualDiscardOk === true);
  var discardedSourcesAfterManual = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'discarded-sources.json'), 'utf8'));
  check('5g. El descarte manual SÍ queda registrado en discarded-sources.json (a diferencia del automático)', discardedSourcesAfterManual.indexOf(draftsOnDisk[0].sourceUrl) !== -1, JSON.stringify(discardedSourcesAfterManual));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('5h. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));
})().then(afterAsyncSections).catch(function (e) { console.error('ERROR en sameRunDedupTest:', e); process.exitCode = 1; });

// ============================================================================
// 6. IMÁGENES (pedido punto 7 -- 4 pruebas dedicadas)
// ============================================================================
function imageLicensingTests() {
  var REAL_IMAGE = 'img/temas/a-historic-first-apollo-15-s-lunar-liftoff-broadcast.jpg';

  // (a) Licencia que exige atribución, sin crédito -> bloqueo.
  var noCreditArticle = { image: REAL_IMAGE, imageLicense: 'cc-by', imageOrigin: 'third-party-licensed' };
  var noCreditIssues = pipeline.validateImageFields(noCreditArticle);
  check('6a. Licencia con atribución obligatoria (cc-by) sin crédito cargado: bloqueo', noCreditIssues.length > 0 && noCreditIssues.some(function (i) { return i.field === 'imageCredit'; }), JSON.stringify(noCreditIssues));

  // (b) "Google Images"/"Internet"/"RSS" como fuente -> bloqueo, aunque
  // haya "crédito" cargado.
  ['Google Images', 'Internet', 'RSS'].forEach(function (badSource) {
    var badSourceArticle = { image: REAL_IMAGE, imageLicense: 'cc-by', imageOrigin: 'third-party-licensed', imageCredit: 'Foto de archivo', imageSource: badSource };
    var badSourceIssues = pipeline.validateImageFields(badSourceArticle);
    check('6b. "' + badSource + '" como fuente de atribución: bloqueo (nunca una fuente válida)', badSourceIssues.some(function (i) { return i.field === 'imageSource'; }), JSON.stringify(badSourceIssues));
  });

  // (c) Imagen IA con procedencia COMPLETA (modelo, fecha, prompt,
  // declaración) -> válida, cero problemas.
  var fullProvenanceArticle = {
    image: REAL_IMAGE, imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
    imageTool: 'vexlow-image-gen', imageModel: 'test-model-v1', imageGeneratedAt: '2026-09-20T12:00:00.000Z',
    imagePrompt: 'A test prompt describing the generated cover image.', imageOwnerAttestation: true, imageHumanEdited: false, imageSourceUrl: null
  };
  var fullProvenanceIssues = pipeline.validateImageFields(fullProvenanceArticle);
  check('6c. Imagen IA con procedencia completa: válida (0 problemas)', fullProvenanceIssues.length === 0, JSON.stringify(fullProvenanceIssues));

  // (d) Imagen IA SIN modelo/fecha/prompt -> revisión o bloqueo (nunca se
  // acepta en silencio una licencia "ai-generated-commercial-use" sin
  // poder demostrarla -- para eso existe la licencia hermana
  // "owner-attested-ai-generated"). Este control se agregó en esta misma
  // sesión (gap real encontrado al escribir esta prueba): antes,
  // validateImageFields() no exigía nada de esto.
  var incompleteProvenanceArticle = {
    image: REAL_IMAGE, imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
    imageTool: null, imageModel: null, imageGeneratedAt: null, imagePrompt: null, imageOwnerAttestation: null
  };
  var incompleteProvenanceIssues = pipeline.validateImageFields(incompleteProvenanceArticle);
  check('6d. Imagen IA SIN modelo/fecha/prompt: bloqueo (procedencia técnica no demostrable)', incompleteProvenanceIssues.length > 0 && incompleteProvenanceIssues.some(function (i) { return i.field === 'imageModel'; }), JSON.stringify(incompleteProvenanceIssues));
  // Contraejemplo: la licencia hermana ("owner-attested-ai-generated",
  // pensada justo para este caso, ver admin/image-licenses.js) SÍ pasa
  // sin exigir modelo/fecha/prompt.
  var ownerAttestedArticle = { image: REAL_IMAGE, imageLicense: 'owner-attested-ai-generated', imageOrigin: 'ai-generated' };
  var ownerAttestedIssues = pipeline.validateImageFields(ownerAttestedArticle);
  check('6d. Contraejemplo: "owner-attested-ai-generated" (sin detalle técnico) sigue siendo válida -- es la licencia pensada para este caso', ownerAttestedIssues.length === 0, JSON.stringify(ownerAttestedIssues));

  // No se descargan imágenes de Google Images (verificación estática: el
  // código de descarga nunca referencia ese dominio como fuente válida).
  var pipelineSrc = fs.readFileSync(path.join(__dirname, 'pipeline.js'), 'utf8');
  check('6e. El código nunca contiene una URL de Google Images como fuente de descarga', !/images\.google\.com|google\.com\/imgres/i.test(pipelineSrc));
}

// ============================================================================
// 7. REGISTRO EDITORIAL: editorialMeta sobrevive guardar; campos de
//    actualización/corrección existentes no se duplican (pedido punto 5/9)
// ============================================================================
function editorialMetaMergeTests() {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-editorialmeta-'));
  var dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  var editorialMetaSample = {
    trendOrigin: { headline: 'Some Headline', outlet: 'Some Outlet', category: 'business', feedUrl: null },
    trendDetectionMethod: 'rss-feed-preselection', trendVolumeApprox: null,
    detectedAt: '2026-09-24T10:00:00.000Z',
    sourcesConsulted: [{ url: 'https://example.com/x', label: 'Some Outlet', retrievedAt: '2026-09-24T10:00:00.000Z', role: 'primary' }],
    keyClaims: [{ claim: 'Algo pasó.', sourceLabel: 'Some Outlet' }],
    readinessReasons: ['+25: fuente principal real'], sensitiveReasons: [],
    editorialValue: { elements: ['historical-context'], elementCount: 1, meetsMinimum: false },
    imageProvenance: { origin: 'ai-generated', license: 'ai-generated-commercial-use', tool: 'vexlow-image-gen', model: 'test-model-v1', generatedAt: '2026-09-24T10:00:00.000Z', sourceUrl: null }
  };
  var originalArticle = {
    category: 'business', slug: 'test-editorial-meta-article', title: 'Test Editorial Meta Article',
    dek: 'x', body: 'x', date: '2026-09-20', dateModified: '2026-09-21', correctionNote: 'Se corrigió una cifra el 21 de septiembre.',
    editorialApproval: true, editorialMeta: editorialMetaSample
  };
  fs.writeFileSync(path.join(dataDir, 'articulos.json'), JSON.stringify([originalArticle], null, 2) + '\n');

  // El formulario real (admin/admin.js -> buildArticleFromForm) NUNCA
  // envía editorialMeta -- no tiene ningún control para eso (pedido
  // explícito: "no debe agregar formularios obligatorios"). Se simula acá
  // exactamente ese payload: solo los campos que el formulario sí conoce,
  // igual que test-sources-merge-fix.js ya prueba para sourceUrl/
  // additionalSources.
  var formPayload = {
    category: 'business', slug: 'test-editorial-meta-article', title: 'Test Editorial Meta Article (Editado)',
    dek: 'x editado', body: 'x editado', date: '2026-09-20', dateModified: '2026-09-22', correctionNote: 'Se corrigió una cifra el 21 de septiembre.',
    editorialApproval: true
    // -- sin editorialMeta, sin editorialValue: el formulario no los conoce.
  };
  var saveResult = articlesStore.upsertArticle({ dataDir: dataDir, category: 'business', slug: 'test-editorial-meta-article', article: formPayload, actor: 'test' });
  check('7a. El guardado (merge seguro) responde 200', saveResult.status === 200, JSON.stringify(saveResult.body));

  var afterSave = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'))[0];
  check('7b. (req 5) editorialMeta SOBREVIVE un guardado cuyo formulario no lo conoce', JSON.stringify(afterSave.editorialMeta) === JSON.stringify(editorialMetaSample), JSON.stringify(afterSave.editorialMeta));
  check('7c. Los campos que el formulario SÍ envió se actualizaron de verdad (el merge no es de solo lectura)', afterSave.title === 'Test Editorial Meta Article (Editado)' && afterSave.dateModified === '2026-09-22');
  check('7d. (obs. A) correctionNote -- el campo real ya existente -- se conserva tal cual, sin duplicarse en otro nombre', afterSave.correctionNote === 'Se corrigió una cifra el 21 de septiembre.' && afterSave.updatedAt === undefined && afterSave.lastModified === undefined);
  check('7e. editorialMeta NUNCA duplica date/dateModified/correctionNote/editorialApproval dentro de sí mismo', !('date' in afterSave.editorialMeta) && !('dateModified' in afterSave.editorialMeta) && !('correctionNote' in afterSave.editorialMeta) && !('editorialApproval' in afterSave.editorialMeta));

  // Reabrir el panel (releer del disco) conserva exactamente lo mismo.
  var reread = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'))[0];
  check('7f. Reabrir (releer del disco) conserva editorialMeta intacto', JSON.stringify(reread.editorialMeta) === JSON.stringify(editorialMetaSample));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('7g. Copia aislada (tmpdir propio) eliminada por completo', !fs.existsSync(tmpRoot));
}

// ============================================================================
// 8. maxAIDrafts sin cambios; el sitio real no cambió
// ============================================================================
function finalRegressionTests() {
  check('8a. maxAIDrafts sigue siendo 3 (no aumentó el gasto de IA por corrida)', pipeline.DEFAULT_PIPELINE_LIMITS.maxAIDrafts === 3, pipeline.DEFAULT_PIPELINE_LIMITS.maxAIDrafts);
  var realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  var realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('8b. El sitio real conserva exactamente la misma cantidad y el mismo conjunto de artículos, sin cambios (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);
}

function afterAsyncSections() {
  imageLicensingTests();
  editorialMetaMergeTests();
  finalRegressionTests();

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exitCode = fail > 0 ? 1 : 0;
}
