#!/usr/bin/env node
/*
  admin/test-editorial-value-writing-quality.js
  ==============================================
  Pedido de Leonardo (2026-09-27): la primera corrida real de Google Trends
  redactó dos artículos (Fortnite, Portugal-Wales) con puntaje TÉCNICO
  100/100 pero solo 2/10 y 1/10 elementos de aporte editorial real -- ambos
  quedaron en revisión, correctamente. Leonardo pidió explícitamente NO bajar
  el mínimo (sigue en 3, ver computeEditorialValue), no eliminar la
  advertencia, y no fabricar el resultado -- solo mejorar la REDACCIÓN de la
  única llamada de IA para que produzca valor editorial real, corregir
  ÚNICAMENTE falsos negativos demostrables del detector, y aclarar la
  interfaz sin tocar la fórmula.

  IMPORTANTE -- evidencia real no disponible: los dos borradores reales
  (Fortnite, Portugal-Wales) ya no existen en data/drafts.json del
  dispositivo real -- Leonardo confirmó que los descartó él mismo desde el
  panel y no conserva otra copia del cuerpo. discardDraft() (ver
  pipeline.js) borra el borrador de drafts.json y mueve su sourceUrl a
  discarded-sources.json en la misma operación -- exactamente el patrón que
  se encontró en los archivos reales (mismos dos timestamps, a 3ms de
  diferencia). No hay backup de drafts.json en ningún lado (data/backups/
  solo guarda snapshots de articulos.json). Por lo tanto este archivo NO
  puede probar contra el cuerpo real de esos dos borradores -- todas las
  pruebas de abajo usan fixtures sintéticos que reproducen los patrones
  descriptos por Leonardo (artículo superficial con muchos subtítulos,
  artículo bien desarrollado, 100/100 técnico con aporte editorial
  insuficiente), más pruebas dirigidas a los cambios concretos de código
  (prompt de admin/draft.js, detectores de pipeline.js, UI de admin.js).

  RONDA 2 (2026-09-27, mismo día): Leonardo revisó la ronda 1 y pidió dos
  correcciones más antes de sincronizar:
  (a) "confirmed-vs-reported" no debe activarse por una atribución aislada
      ("the organizers announced" / "officials confirmed" / "the company
      said" solos) -- exige un contraste real: algo confirmado Y algo
      reportado/no confirmado/preliminar/incierto, o una frase que
      diferencie ambos estados explícitamente. La ampliación de verbos de
      atribución de la ronda 1 se conserva para
      CONFIRMED_ATTRIBUTION_MARKER_TERMS (atribución/transparencia/
      keyClaims), pero DEJA de ser, por sí sola, el detector de este
      elemento editorial.
  (b) "timeline" no puede exigir ÚNICAMENTE 2 años distintos -- eso evitaba
      el subtítulo vacío pero producía falsos negativos reales (una
      cronología puede tener varios hechos del mismo año, o del mismo
      día). Ahora acepta 2+ años distintos (sigue siendo válido, ya no es
      obligatorio), 2+ fechas completas distintas, 2+ horas/momentos
      distintos, o 2+ marcadores secuenciales ("first"/"then"/"later"/
      "afterward") cada uno con una cláusula real de al menos 4 palabras
      con contenido -- nunca un marcador suelto sin ningún hecho.

  Índice:
    1. El prompt de la única llamada de IA (admin/draft.js) reclama lo
       pedido: 700-1000 palabras, 3-5 subtítulos específicos, AL MENOS 4
       elementos cuando las fuentes alcancen, piso explícito de "no forzar
       si no hay para 3, quedate corto y en revisión", más las dos
       instrucciones reforzadas de la ronda 2 (contraste real, cronología
       anclada a >=2 puntos concretos).
    2. Corrección del detector: SOLO falsos negativos demostrables.
       2a. Bug real corregido (ronda 1): un subtítulo "## Timeline" solo
           (sin ningún año real) YA NO cuenta.
       2b. Sin regresión: 2+ años reales SÍ siguen contando (una vía más,
           ya no la única).
       2c. "compared with" (antes solo "compared to") ahora sí cuenta.
       2d. (ronda 2) Controles negativos: una atribución AISLADA
           ("the organizers announced" / "officials confirmed" / "the
           company said", cada una sola) NUNCA cuenta para
           confirmed-vs-reported.
       2e. (ronda 2) Control positivo: un contraste real (confirmado +
           reportado/incierto en el mismo párrafo) SÍ cuenta.
       2f. Sin regresión: el detector de riesgo de transparencia (que
           reutiliza CONFIRMED_ATTRIBUTION_MARKER_TERMS, no el detector de
           aporte editorial) sigue sin falsos positivos.
       2g. (ronda 2) Las 5 vías de "timeline": encabezado vacío, una sola
           fecha, 2 fechas distintas del mismo año, 2 hechos ordenados del
           mismo día, marcadores sueltos sin hechos.
    3. Los 9 escenarios de prueba obligatorios pedidos por Leonardo,
       incluidos los dos casos centrales re-verificados (ronda 2, punto 3):
       100 técnico + 2 elementos reales -> revisión; 100 técnico + 3+
       elementos reales + 2 fuentes + cero advertencias -> listo.
    4. Integridad: los dos borradores reales (ya inexistentes, confirmado
       por Leonardo) y todos los archivos operativos del sandbox no
       cambiaron ni un byte durante esta corrida.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pipeline = require('./pipeline.js');
const draft = require('./draft.js');
const feeds = require('./feeds.js');
const integrity = require('./articulos-integrity-check');

const REAL_ROOT = path.join(__dirname, '..');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

function sha256File(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
// Archivos operativos del sandbox que este archivo NUNCA debe tocar --
// snapshot ANTES de correr nada (sección 4 los vuelve a leer al final).
const OPERATIONAL_FILES = ['drafts.json', 'discarded-sources.json', 'candidate-cache.json', 'trash.json'].map(function (f) {
  return path.join(REAL_ROOT, 'data', f);
});
const operationalHashesBefore = OPERATIONAL_FILES.map(sha256File);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}

// ============================================================================
// 1. EL PROMPT (admin/draft.js) RECLAMA LO PEDIDO
// ============================================================================
(function promptContentTests() {
  const draftSrc = fs.readFileSync(path.join(__dirname, 'draft.js'), 'utf8');
  check('1a. El prompt pide 700-1000 palabras (antes 600-900)', draftSrc.indexOf('700-1000 words') !== -1, 'no se encontró "700-1000 words"');
  check('1a. Ya no pide el rango viejo de 600-900 como objetivo', draftSrc.indexOf('600-900 words') === -1);
  check('1b. El prompt pide 3-5 subtítulos (antes 2-4)', draftSrc.indexOf('use 3-5 of these') !== -1);
  check('1c. El prompt exige explícitamente AL MENOS 4 elementos cuando las fuentes alcancen', /AT LEAST 4/.test(draftSrc), 'no se encontró "AT LEAST 4"');
  check('1d. El prompt prohíbe explícitamente "Overview", "Conclusion" y "Future Outlook" como subtítulos genéricos (ejemplos exactos pedidos por Leonardo)',
    draftSrc.indexOf('"Overview"') !== -1 && draftSrc.indexOf('"Conclusion"') !== -1 && draftSrc.indexOf('"Future Outlook"') !== -1);
  check('1e. Piso explícito: si las fuentes no alcanzan para 3 elementos reales, NO forzar -- puede quedar corto y en revisión',
    /too thin to honestly develop at least 3/.test(draftSrc) && /stay in human review/.test(draftSrc));
  check('1f. El prompt sigue prohibiendo inventar contexto/hechos no dados', /never invent a new specific fact/.test(draftSrc) || /Never invent quotes, statistics/.test(draftSrc));
  check('1g. El prompt sigue distinguiendo confirmado vs. reportado (nunca convertir rumor en hecho)', /CRITICAL distinction — official statement vs\. unconfirmed report/.test(draftSrc));
  check('1h. El self-reporte de la IA (editorialValueClaims) sigue explícitamente sin usarse para decidir nada', /VexlowHQ independently re-checks the body for real evidence of each element/.test(draftSrc));
  check('1i. La respuesta sigue siendo UN solo objeto JSON (nunca se pide más de una llamada en el propio prompt)', /Respond with ONLY a single JSON object/.test(draftSrc));
})();

// ============================================================================
// 2. CORRECCIÓN DEL DETECTOR -- SOLO FALSOS NEGATIVOS DEMOSTRABLES
// ============================================================================
(function detectorFixTests() {
  // (a) Bug real corregido: un subtítulo "## Timeline" solo, sin ningún año
  // real debajo, contaba como "cronología" -- un encabezado vacío pasando
  // como si fuera contenido real. Ver punto 3 de las pruebas obligatorias
  // ("palabras o encabezados aislados no cuentan").
  var bareHeadingBody = 'The event took place this week.\n\n## Timeline\nThings happened in a certain order, as usual for this kind of event.\n\n## What To Watch\nMore updates are expected soon.';
  var bareHeadingValue = pipeline.computeEditorialValue({ body: bareHeadingBody }, null);
  check('2a. (bug corregido) Un subtítulo "## Timeline" SOLO, sin años reales, YA NO cuenta como cronología',
    bareHeadingValue.elements.indexOf('timeline') === -1, JSON.stringify(bareHeadingValue));

  // (b) Sin regresión: 2+ años reales distintos SÍ siguen contando, con o
  // sin subtítulo dedicado.
  var realTimelineBody = 'The competition first launched in 2019 with a small regional field. By 2024, it had grown into one of the largest events of its kind.';
  var realTimelineValue = pipeline.computeEditorialValue({ body: realTimelineBody }, null);
  check('2b. (sin regresión) 2 años reales distintos (2019, 2024) SÍ cuentan como cronología',
    realTimelineValue.elements.indexOf('timeline') !== -1, JSON.stringify(realTimelineValue));

  // (c) "compared with" (antes solo se reconocía "compared to") -- mismo
  // significado, misma construcción, no una palabra clave nueva y fácil de
  // engañar.
  var comparedWithBody = 'Compared with last year\'s edition, this year\'s field is nearly twice the size.';
  var comparedWithValue = pipeline.computeEditorialValue({ body: comparedWithBody }, null);
  check('2c. "compared with" ahora cuenta como comparación (antes solo "compared to")',
    comparedWithValue.elements.indexOf('comparison') !== -1, JSON.stringify(comparedWithValue));

  // (d) RONDA 2 -- controles negativos pedidos explícitamente por Leonardo:
  // una atribución AISLADA no demuestra ningún contraste real entre lo
  // confirmado y lo reportado, así que NINGUNA de estas tres, sola, debe
  // contar para confirmed-vs-reported (aunque sí sirvan como atribución
  // real en otras partes del artículo/keyClaims).
  var organizersAloneBody = 'The organizers announced Tuesday that this year\'s championship drew a record audience.';
  var organizersAloneValue = pipeline.computeEditorialValue({ body: organizersAloneBody }, null);
  check('2d. (control negativo) Solo "the organizers announced", sin contraste: NO cuenta para confirmed-vs-reported',
    organizersAloneValue.elements.indexOf('confirmed-vs-reported') === -1, JSON.stringify(organizersAloneValue));

  var officialsAloneBody = 'Match officials confirmed the final score after a lengthy video review.';
  var officialsAloneValue = pipeline.computeEditorialValue({ body: officialsAloneBody }, null);
  check('2d. (control negativo) Solo "officials confirmed", sin contraste: NO cuenta para confirmed-vs-reported',
    officialsAloneValue.elements.indexOf('confirmed-vs-reported') === -1, JSON.stringify(officialsAloneValue));

  var companySaidAloneBody = 'The company said Tuesday that it would expand its operations next year.';
  var companySaidAloneValue = pipeline.computeEditorialValue({ body: companySaidAloneBody }, null);
  check('2d. (control negativo) Solo "the company said", sin contraste: NO cuenta para confirmed-vs-reported',
    companySaidAloneValue.elements.indexOf('confirmed-vs-reported') === -1, JSON.stringify(companySaidAloneValue));

  // (e) RONDA 2 -- control positivo pedido explícitamente por Leonardo: un
  // contraste real (algo confirmado oficialmente + algo identificado como
  // reportado/no confirmado/preliminar/incierto) en el mismo párrafo SÍ
  // cuenta.
  var realContrastBody = 'The organizers confirmed X, while Y remains unconfirmed and was only reported by local outlets.';
  var realContrastValue = pipeline.computeEditorialValue({ body: realContrastBody }, null);
  check('2e. (control positivo) "confirmed X, while Y remains unconfirmed and was only reported by..." SÍ cuenta',
    realContrastValue.elements.indexOf('confirmed-vs-reported') !== -1, JSON.stringify(realContrastValue));

  // (f) Sin regresión: el detector de riesgo de transparencia (que reutiliza
  // CONFIRMED_ATTRIBUTION_MARKER_TERMS -- un patrón DISTINTO del detector de
  // aporte editorial desde la ronda 2 -- sigue conservando los verbos
  // ampliados de la ronda 1, y sigue sin generar falsos positivos.
  var stillRiskyText = 'Rumor has it the company is reportedly considering a merger. The company has confirmed the deal, and everyone is celebrating this huge milestone in absolute silence.';
  var stillRisky = pipeline.detectTransparencyRisk(stillRiskyText);
  check('2f. (sin regresión) "confirmado" + rumor SIN atribución cercana sigue marcando riesgo real, incluso con los verbos nuevos ya agregados',
    stillRisky.hasRisk === true, JSON.stringify(stillRisky));
  var legitWithNewVerbText = 'Sources say the company is reportedly considering a merger. The organizers announced Tuesday that the deal has been finalized internally, though no public statement has been made yet.';
  var legitWithNewVerb = pipeline.detectTransparencyRisk(legitWithNewVerbText);
  check('2f. (sin regresión) Una atribución legítima con uno de los verbos NUEVOS ("the organizers announced") tampoco genera un falso positivo',
    legitWithNewVerb.hasRisk === false, JSON.stringify(legitWithNewVerb));

  // (g) RONDA 2 -- las 5 vías de "timeline" pedidas explícitamente por
  // Leonardo.
  var emptyTimelineHeadingBody = 'The event happened this week.\n\n## Timeline\nThings happened in a certain order, as usual for this kind of event.';
  check('2g. "## Timeline" vacío (sin fechas/horas/secuencia real): NO cuenta',
    pipeline.computeEditorialValue({ body: emptyTimelineHeadingBody }, null).elements.indexOf('timeline') === -1);

  var singleDateBody = 'The event happened on September 27.';
  check('2g. Una sola fecha (sin una segunda fecha/hora/secuencia): NO cuenta',
    pipeline.computeEditorialValue({ body: singleDateBody }, null).elements.indexOf('timeline') === -1);

  var twoDates2026Body = 'The qualifying round concluded on September 12, drawing a modest crowd. The championship final followed on September 26, filling the arena to capacity.';
  check('2g. Dos fechas distintas del mismo año (2026), cada una con un hecho concreto: SÍ cuenta',
    pipeline.computeEditorialValue({ body: twoDates2026Body }, null).elements.indexOf('timeline') !== -1);

  var sameDaySequenceBody = 'The opening ceremony took place first, with thousands of fans filling the stadium before noon. The championship match then began, drawing millions of live viewers around the world.';
  check('2g. Dos acontecimientos ordenados y sustanciales del mismo día (marcadores + hechos reales): SÍ cuenta',
    pipeline.computeEditorialValue({ body: sameDaySequenceBody }, null).elements.indexOf('timeline') !== -1);

  var bareSequenceWordsBody = 'It happened. Then. Later, everyone left.';
  check('2g. Marcadores sueltos ("Then." / "Later, everyone left.") sin hechos reales detrás: NO cuenta',
    pipeline.computeEditorialValue({ body: bareSequenceWordsBody }, null).elements.indexOf('timeline') === -1);
})();

// ============================================================================
// 3. LOS 9 ESCENARIOS OBLIGATORIOS PEDIDOS POR LEONARDO
// ============================================================================

// Fixture (a): artículo superficial con MUCHOS subtítulos, pero sin ningún
// elemento editorial real desarrollado debajo -- reproduce el patrón
// reportado (100/100 técnico posible, aporte editorial casi nulo).
var thinManyHeadingsBody = [
  'The event took place on Tuesday as scheduled.',
  '',
  '## What Happened',
  'The event happened as planned, with the usual format.',
  '',
  '## Details',
  'More details were shared during the event itself.',
  '',
  '## Reactions',
  'People online reacted to the news in various ways.',
  '',
  '## What\'s Next',
  'The organizers said more information would be shared soon.'
].join('\n');

// Fixture (b): artículo con contexto previo, cronología real, comparación
// explícita y consecuencias realmente desarrolladas -- alcanza el mínimo
// (>=3) y de sobra el objetivo nuevo del prompt (>=4).
var richDevelopedBody = [
  'The championship has run since 2019, growing from a small regional event into one of the most-watched competitions of its kind. A second wave of growth followed in 2022, when the prize pool tripled.',
  '',
  '## How This Compares To Recent Years',
  'Compared with the 2022 edition, this year\'s field is nearly twice the size, and total prize money has grown accordingly, according to the tournament\'s official broadcast partner.',
  '',
  '## What Organizers Confirmed — And What Is Still Unconfirmed',
  'The organizers confirmed Tuesday that this year\'s championship drew a record audience, while final regional qualifier numbers remain unconfirmed and were only reported by local outlets.',
  '',
  '## What It Means For Competitive Players',
  'This means for competitive players that qualification will likely get harder next season, and it could affect how smaller regional leagues structure their own events going forward.',
  '',
  '## What Remains Unclear',
  'However, it remains unclear how prize pools will be split among regional qualifiers, and organizers have not disclosed a date for the next announcement.'
].join('\n');

(function scenario1ThinManySubheadings() {
  // 1. Artículo superficial con MUCHOS subtítulos -> NO alcanza el mínimo.
  var value = pipeline.computeEditorialValue({ body: thinManyHeadingsBody }, null);
  var headingCount = (thinManyHeadingsBody.match(/^##\s+\S/gm) || []).length;
  check('3.1 Fixture tiene 4 subtítulos (para confirmar que "muchos subtítulos" no es el problema)', headingCount === 4, headingCount);
  check('3.1 Artículo superficial con muchos subtítulos: meetsMinimum:false', value.meetsMinimum === false, JSON.stringify(value));
  check('3.1 elementCount queda muy por debajo de 3', value.elementCount < 3, JSON.stringify(value.elementCount));
})();

(function scenario2RichDeveloped() {
  // 2. Artículo con contexto+cronología+comparación+consecuencias realmente
  // desarrolladas -> alcanza el mínimo (y el nuevo objetivo de 4 del prompt).
  var value = pipeline.computeEditorialValue({ body: richDevelopedBody }, null);
  check('3.2 Artículo bien desarrollado: meetsMinimum:true', value.meetsMinimum === true, JSON.stringify(value));
  check('3.2 Alcanza el nuevo objetivo del prompt (>=4 elementos reales)', value.elementCount >= 4, JSON.stringify(value));
  check('3.2 Incluye explícitamente historical-context, timeline, comparison, consequences, confirmed-vs-reported y limitations',
    ['historical-context', 'timeline', 'comparison', 'consequences', 'confirmed-vs-reported', 'limitations'].every(function (k) { return value.elements.indexOf(k) !== -1; }),
    JSON.stringify(value.elements));
})();

(function scenario3IsolatedHeadersDontCount() {
  // 3. Palabras o encabezados aislados no cuentan -- ver también sección 2a
  // (el bug del subtítulo "## Timeline" solo, ya corregido). Acá se agrega
  // el caso de una palabra clave suelta, fuera de cualquier construcción
  // real reconocida por el detector.
  var isolatedWordBody = 'Timeline. Comparison. Consequences. However. The event happened.';
  var value = pipeline.computeEditorialValue({ body: isolatedWordBody }, null);
  check('3.3 Palabras sueltas sin construcción real ("Timeline. Comparison. Consequences. However.") no cuentan como ningún elemento',
    value.elementCount === 0, JSON.stringify(value));
  var bareHeadingOnlyValue = pipeline.computeEditorialValue({ body: 'The event happened.\n\n## Timeline\n\n## Comparison\n\n## Consequences' }, null);
  check('3.3 Subtítulos vacíos (sin ningún desarrollo real debajo) no cuentan como ningún elemento',
    bareHeadingOnlyValue.elementCount === 0, JSON.stringify(bareHeadingOnlyValue));
})();

(function scenario4FabricatedClaimsDontCount() {
  // 4. Afirmaciones inventadas en editorialValueClaims (incluido
  // "elementsUsed" declarando los 10) no cuentan para nada -- el conteo
  // real ignora por completo la autodeclaración de la IA.
  var fabricatedClaims = {
    whatHappened: 'Something happened.',
    whyItMatters: 'It matters a lot.',
    confirmed: ['fact A', 'fact B', 'fact C'],
    uncertain: ['thing D'],
    whatToWatch: ['thing E', 'thing F'],
    elementsUsed: ['historical-context', 'timeline', 'comparison', 'consequences', 'limitations', 'confirmed-vs-reported', 'technical-explanation', 'us-availability', 'what-to-watch', 'comparative-list']
  };
  var value = pipeline.computeEditorialValue({ body: thinManyHeadingsBody }, fabricatedClaims);
  check('3.4 La IA "declaró" los 10 elementos en elementsUsed, pero el cuerpo es superficial: meetsMinimum sigue false',
    value.meetsMinimum === false, JSON.stringify(value));
  check('3.4 elementCount real ignora por completo la declaración fabricada (sigue midiendo solo el cuerpo)',
    value.elementCount < 3, JSON.stringify(value.elementCount));
})();

(function scenario5CompleteCanBeListo() {
  // 5. Redacción completa y respaldada -> puede quedar en "Solo listos"
  // (readinessTier "listo"), con todo lo demás también en regla.
  var completeDraft = {
    title: 'Regional Esports Championship Draws Record Audience After Years Of Growth',
    dek: 'The championship drew a record audience this year, organizers announced Tuesday.',
    body: richDevelopedBody,
    category: 'gaming',
    sourceUrl: 'https://example.com/esports-championship-record-audience',
    sourcePublishedAt: new Date().toISOString(),
    additionalSources: [{ url: 'https://otra-fuente.example/championship', label: 'Otra Fuente' }],
    keyClaims: [{ claim: 'El torneo atrajo una audiencia récord.', sourceLabel: 'Fuente Principal' }],
    editorialValue: pipeline.computeEditorialValue({ body: richDevelopedBody }, null)
  };
  var tier = pipeline.classifyDraft(completeDraft);
  // Caso central re-verificado explícitamente (pedido de Leonardo, ronda 2,
  // punto 3, segundo caso): puntaje técnico 100, 3+ elementos reales, dos
  // fuentes independientes, cero advertencias -> "listo".
  check('3.5 (caso central) Puntaje técnico 100/100', tier.editorialReadinessScore === 100, tier.editorialReadinessScore);
  check('3.5 (caso central) 3 o más elementos editoriales reales', tier.editorialValue.elementCount >= 3, tier.editorialValue.elementCount);
  check('3.5 (caso central) Dos fuentes independientes (additionalSources.length > 0, singleSource:false)', completeDraft.additionalSources.length > 0 && tier.singleSource === false);
  check('3.5 (caso central) Cero advertencias (similarityWarning/genericHeadingWarning/sensible/transparencia/aporte insuficiente, todas false)',
    !tier.promotional && !tier.isDuplicate && !tier.singleSource && !tier.sensitiveTopics.length && !tier.transparencyRisk && !tier.insufficientEditorialValue,
    JSON.stringify({ promotional: tier.promotional, isDuplicate: tier.isDuplicate, singleSource: tier.singleSource, sensitiveTopics: tier.sensitiveTopics, transparencyRisk: tier.transparencyRisk, insufficientEditorialValue: tier.insufficientEditorialValue }));
  check('3.5 (caso central) readinessTier: "listo"', tier.readinessTier === 'listo', JSON.stringify({ tier: tier.readinessTier, score: tier.editorialReadinessScore, ev: tier.editorialValue.elementCount }));
  check('3.5 insufficientEditorialValue:false (alcanzó el mínimo real)', tier.insufficientEditorialValue === false);
})();

(function scenario6ThinWith100TechnicalStaysRevision() {
  // 6. Redacción superficial con puntaje TÉCNICO 100/100 -> sigue en
  // revisión. Reproduce EXACTAMENTE el patrón que reportó Leonardo (Fortnite
  // 100/100 con 2/10; Portugal-Wales 100/100 con 1/10): todas las señales
  // técnicas en regla (fuente canónica, segunda fuente, publicado hace
  // poco, categoría válida, keyClaims atribuidos, sin rumor, imagen sin
  // problema, >=2 subtítulos propios) pero el cuerpo real es superficial.
  var canonicalUrl = feeds.canonicalizeUrl('https://example.com/thin-tournament-recap');
  var thinButTechnicallyPerfectDraft = {
    title: 'Local Tournament Wraps Up After Weekend Event',
    dek: 'The tournament wrapped up this weekend, organizers said.',
    body: thinManyHeadingsBody,
    category: 'gaming',
    sourceUrl: canonicalUrl,
    sourcePublishedAt: new Date().toISOString(),
    additionalSources: [{ url: 'https://otra-fuente.example/tournament', label: 'Otra Fuente' }],
    keyClaims: [{ claim: 'El torneo terminó el fin de semana.', sourceLabel: 'Fuente Principal' }],
    editorialValue: pipeline.computeEditorialValue({ body: thinManyHeadingsBody }, null)
  };
  var tier = pipeline.classifyDraft(thinButTechnicallyPerfectDraft);
  check('3.6 Puntaje técnico llega exactamente a 100/100 (todas las señales técnicas en regla)', tier.editorialReadinessScore === 100, JSON.stringify({ score: tier.editorialReadinessScore, reasons: tier.readinessReasons }));
  check('3.6 (patrón real reportado) A pesar del 100/100 técnico, readinessTier sigue "revisar" -- NUNCA "listo"', tier.readinessTier === 'revisar', JSON.stringify({ tier: tier.readinessTier, score: tier.editorialReadinessScore }));
  check('3.6 El motivo real es insufficientEditorialValue:true (no se fabricó ni se bajó el mínimo)', tier.insufficientEditorialValue === true, JSON.stringify(tier.editorialValue));
  // OJO: "Aporte editorial insuficiente..." vive en tier.reasons (el motivo
  // de recomendación/bloqueo), NUNCA en tier.readinessReasons (esa es la
  // lista de factores +/- del puntaje técnico de computeEditorialReadiness
  // -- por diseño, el puntaje técnico nunca resta puntos por esto, ver
  // comentario de computeEditorialReadiness más arriba en pipeline.js).
  check('3.6 tier.reasons explica el motivo exacto con el conteo real (nunca en readinessReasons, que es solo el puntaje técnico)',
    tier.reasons.some(function (r) { return /Aporte editorial insuficiente/.test(r) && r.indexOf(String(tier.editorialValue.elementCount) + '/10') !== -1; }), JSON.stringify(tier.reasons));
})();

async function scenario7and8SingleAICallNoRetry() {
  // 7 y 8. Exactamente UNA llamada de IA por candidato, y NUNCA un
  // reintento automático -- ni siquiera cuando la llamada falla.
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-single-ai-call-'));
  function copyDirSync(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (var entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      var s = path.join(src, entry.name), d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDirSync(s, d); else fs.copyFileSync(s, d);
    }
  }
  copyDirSync(REAL_ROOT, tmpRoot);
  try { fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction'); } catch (e) {}
  fs.writeFileSync(path.join(tmpRoot, 'data', 'drafts.json'), '[]\n');
  fs.writeFileSync(path.join(tmpRoot, 'data', 'discarded-sources.json'), '[]\n');
  fs.writeFileSync(path.join(tmpRoot, 'data', 'candidate-cache.json'), '{}\n');

  var pipeline3 = require(path.join(tmpRoot, 'admin', 'pipeline.js'));
  var feeds3 = require(path.join(tmpRoot, 'admin', 'feeds.js'));
  var draft3 = require(path.join(tmpRoot, 'admin', 'draft.js'));

  function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
  // Un único cluster (2 fuentes reales e independientes del mismo hecho)
  // para que exactamente UN candidato llegue a redactarse.
  var singleCluster = [
    { category: 'gaming', title: 'Solstice Arena Finals Wrap Up This Weekend In Front Of A Packed Crowd', summary: 'The Solstice Arena finals wrapped up this weekend in front of a packed crowd.', link: 'https://singleai1.example/2026/09/finals', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'singleai1.example', outlet: 'SingleAI1' },
    { category: 'gaming', title: 'Solstice Arena Championship Concludes With A Packed Crowd In Attendance', summary: 'The Solstice Arena championship concluded this weekend with a packed crowd in attendance, organizers said.', link: 'https://singleai2.example/2026/09/finals-recap', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0), image: '', author: '', domain: 'singleai2.example', outlet: 'SingleAI2' }
  ];
  feeds3.fetchAllFeedItems = function () { return Promise.resolve({ items: singleCluster, errors: [] }); };
  pipeline3.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
  pipeline3.searchGoogleNewsForCorroboration = function () { return Promise.resolve({ source: null, failed: false, reason: null, diagnostic: null }); };
  draft3.loadConfig = function () { return { draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }; };

  // --- 7. Exactamente una llamada de IA para el único candidato ---
  var callCount7 = 0;
  draft3.draftArticle = function (item, cfg, categoryOptions, sourcesForPrompt) {
    callCount7++;
    return Promise.resolve({
      title: 'Solstice Arena Championship Concludes This Weekend',
      dek: 'The championship concluded this weekend, organizers confirmed.',
      body: richDevelopedBody,
      category: item.category, readTime: '4 min',
      keyClaims: [{ claim: 'El campeonato terminó el fin de semana.', sourceLabel: sourcesForPrompt.primary.outlet }]
    });
  };
  var result7 = await pipeline3.fetchNewDrafts();
  check('3.7 Un único candidato corroborado -> exactamente UNA llamada de IA (aiCallsMade === 1)', result7.aiCallsMade === 1, JSON.stringify({ aiCallsMade: result7.aiCallsMade }));
  check('3.7 El propio mock también contó exactamente una invocación real (doble verificación, independiente de aiCallsMade)', callCount7 === 1, callCount7);
  check('3.7 El candidato se redactó y quedó guardado', result7.added === 1, JSON.stringify(result7.added));

  // --- 8. Sin reintento automático: si la única llamada falla, NUNCA se
  // vuelve a intentar -- el candidato queda en errors, con 0 borradores
  // nuevos, y la corrida sigue contando UNA sola invocación real. ---
  fs.writeFileSync(path.join(tmpRoot, 'data', 'drafts.json'), '[]\n');
  fs.writeFileSync(path.join(tmpRoot, 'data', 'discarded-sources.json'), '[]\n');
  fs.writeFileSync(path.join(tmpRoot, 'data', 'candidate-cache.json'), '{}\n');
  var callCount8 = 0;
  draft3.draftArticle = function () {
    callCount8++;
    return Promise.reject(new Error('Fallo simulado de la API de IA'));
  };
  var result8 = await pipeline3.fetchNewDrafts();
  check('3.8 La única llamada falló, pero NUNCA se reintentó (el mock se invocó exactamente 1 vez, no 2 ni 3)', callCount8 === 1, callCount8);
  check('3.8 aiCallsMade también registra exactamente 1 (se cuenta el intento, no reintentos)', result8.aiCallsMade === 1, JSON.stringify(result8.aiCallsMade));
  check('3.8 El candidato fallido queda en errors, nunca como borrador guardado', Array.isArray(result8.errors) && result8.errors.length === 1 && result8.added === 0, JSON.stringify({ errors: result8.errors, added: result8.added }));
  var draftsOnDisk8 = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'drafts.json'), 'utf8'));
  check('3.8 drafts.json queda vacío (el fallo no dejó ningún borrador a medio escribir)', Array.isArray(draftsOnDisk8) && draftsOnDisk8.length === 0, JSON.stringify(draftsOnDisk8));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('3.7/3.8 Copia aislada temporal eliminada por completo', !fs.existsSync(tmpRoot));
}

// ============================================================================
// 4. INTEGRIDAD -- nada real se tocó durante esta corrida
// ============================================================================
function integrityTests() {
  // 9. Los dos borradores reales (ya inexistentes -- confirmado por
  // Leonardo, sin otra copia) y todos los archivos operativos del sandbox
  // no cambiaron ni un byte durante esta corrida: todas las pruebas de
  // arriba corrieron contra funciones puras o copias aisladas en tmpdir,
  // nunca contra data/drafts.json, discarded-sources.json o
  // candidate-cache.json reales de este sandbox.
  var operationalHashesAfter = OPERATIONAL_FILES.map(sha256File);
  OPERATIONAL_FILES.forEach(function (file, i) {
    check('4. ' + path.basename(file) + ' del sandbox no cambió ni un byte durante esta corrida',
      operationalHashesAfter[i] === operationalHashesBefore[i],
      'antes=' + operationalHashesBefore[i] + ' despues=' + operationalHashesAfter[i]);
  });

  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('4. data/articulos.json del sitio real (sandbox) no cambió durante esta corrida (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('4. El sitio real conserva exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);
}

// Las secciones 1-3 (salvo 7/8) son síncronas y ya corrieron arriba al
// cargar el archivo. La sección 7/8 es async (fetchNewDrafts real contra
// una copia aislada) -- se espera su resolución antes de correr la
// integridad final y el resumen, para que el conteo de pass/fail sea
// siempre completo y determinístico (nunca una condición de carrera).
scenario7and8SingleAICallNoRetry().then(function () {
  integrityTests();
  console.log('');
  console.log(pass + ' PASS, ' + fail + ' FAIL');
  process.exitCode = fail ? 1 : 0;
}).catch(function (e) {
  console.error('Error inesperado durante las pruebas 7/8 (llamada única de IA / sin reintento):', e && e.stack || e);
  process.exitCode = 1;
});
