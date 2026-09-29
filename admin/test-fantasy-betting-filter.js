#!/usr/bin/env node
/*
  admin/test-fantasy-betting-filter.js
  =====================================
  Pedido de Leonardo (2026-09-27, puntos 1/2/7/8), a partir del hallazgo real
  de un borrador de Yahoo Sports ("Fantasy Week 3 Start or Sit") que gastó
  una redacción completa con IA sobre contenido de consejo individual de
  fantasy football, sin ningún valor editorial duradero.

  Pedido: descartar automáticamente, ANTES de redactar con IA, cualquier
  candidato de fantasy sports o de apuestas cuyo propósito principal sea dar
  un consejo individual de alineación/selección -- sin excluir nunca la
  categoría Sports entera ni bloquear por la palabra "fantasy"/"betting"
  sueltas en una noticia real y amplia (regulación, negocio, escándalo,
  resultado deportivo). Los candidatos descartados van a una lista manual
  identificada exactamente como "Fantasy/apuestas — no redactado
  automáticamente (0 llamadas de IA)", nunca se pierden en silencio.

  Ver admin/pipeline.js: FANTASY_ADVICE_TERMS, STRONG_BETTING_ADVICE_TERMS,
  WEAK_BETTING_TERMS, BETTING_INTENT_TERMS, detectFantasyOrBettingAdvice().

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real).

  Pruebas:
    1. Cada frase fuerte de fantasy (10 exactas del pedido) bloquea sola.
    2. La palabra "fantasy" sola, en una noticia real y amplia, NO bloquea.
    3. Cada frase fuerte de apuestas (7 exactas del pedido) bloquea sola.
    4. Las palabras débiles de apuestas (odds/spread/moneyline/over-under)
       NUNCA bloquean solas.
    5. Débil + señal de intención en la MISMA oración SÍ bloquea.
    6. Débil + señal de intención en oraciones DISTINTAS NO bloquea
       (exige proximidad real, no solo co-ocurrencia en el artículo).
    7. Controles negativos explícitos del pedido: regulación de apuestas con
       "odds"; sanción a una casa de apuestas manipulando "odds"; resultado
       deportivo que menciona el "spread" previo; adquisición/resultado
       comercial de una empresa del sector; escándalo periodístico -- NINGUNO
       se filtra.
    8. buildCandidates(): un candidato fantasy y uno de apuestas nunca llegan
       a ser candidatos (0 llamadas de IA), se cuentan en
       filteredCounts.fantasyOrBetting y quedan en fantasyBettingCandidates
       con motivo identificable; un candidato legítimo de la misma corrida
       SÍ pasa.
    9. fetchNewDrafts() de punta a punta: "best bets" y "waiver wire" -> 0
       llamadas de texto y 0 de imagen para esos dos; el candidato legítimo
       corroborado sí se redacta (1 llamada).
   10. admin.js contiene la etiqueta EXACTA pedida para la lista manual.
   11. data/articulos.json del sitio real no cambia durante estas pruebas.
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

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-fantasy-betting-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');
const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

async function main() {
  const pipeline = require(path.join(adminDir, 'pipeline.js'));

  // ==========================================================================
  // 1. Frases fuertes de FANTASY (exactas del pedido) bloquean solas
  // ==========================================================================
  var FANTASY_STRONG_EXAMPLES = [
    'Week 3 Start or Sit: Quarterback rankings for your fantasy lineup',
    'Start-Sit advice for your bench this weekend',
    'This week\'s waiver wire pickups you need to know about',
    'Who should I start this week at flex?',
    'Updated fantasy rankings for running backs entering Week 5',
    'Our fantasy lineup picks for Sunday\'s slate',
    'Weekly fantasy advice column: sleepers and busts',
    'Fantasy projections for every quarterback in Week 4',
    'Fantasy sleepers to grab off waivers this week',
    'Top DFS picks for tonight\'s slate',
    'Best daily fantasy picks for the Sunday main slate'
  ];
  FANTASY_STRONG_EXAMPLES.forEach(function (text) {
    var r = pipeline.detectFantasyOrBettingAdvice(text);
    check('1. Fantasy fuerte bloquea solo: "' + text.slice(0, 50) + '..."',
      r.isFantasyOrBettingAdvice === true && r.adviceCategory === 'fantasy', JSON.stringify(r));
  });

  // ==========================================================================
  // 2. "fantasy" sola en una noticia real y amplia NO bloquea
  // ==========================================================================
  var FANTASY_BARE_NEGATIVE = [
    'DraftKings, the fantasy sports and betting giant, reported quarterly earnings that beat Wall Street estimates.',
    'Regulators are examining fantasy sports operators after several states raised consumer protection concerns.',
    'The fantasy sports company was acquired by a larger media conglomerate in a deal announced Thursday.',
    'A new documentary explores the rise of the fantasy sports industry over the past two decades.'
  ];
  FANTASY_BARE_NEGATIVE.forEach(function (text) {
    var r = pipeline.detectFantasyOrBettingAdvice(text);
    check('2. "fantasy" sola (noticia real y amplia) NO bloquea: "' + text.slice(0, 50) + '..."',
      r.isFantasyOrBettingAdvice === false, JSON.stringify(r));
  });

  // ==========================================================================
  // 3. Frases fuertes de APUESTAS (exactas del pedido) bloquean solas
  // ==========================================================================
  var BETTING_STRONG_EXAMPLES = [
    'Our best bets for Sunday\'s NFL slate',
    'Betting picks for tonight\'s matchup',
    'Prop bet of the day: will he score first?',
    'Player props to target this weekend',
    'Parlay picks for the weekend slate',
    'Claim this sportsbook promotion before kickoff',
    'New sportsbook bonus available for new users',
    'Betting tips from our expert handicappers',
    'Lock of the day: take the favorite to cover'
  ];
  BETTING_STRONG_EXAMPLES.forEach(function (text) {
    var r = pipeline.detectFantasyOrBettingAdvice(text);
    check('3. Apuestas fuerte bloquea sola: "' + text.slice(0, 50) + '..."',
      r.isFantasyOrBettingAdvice === true && r.adviceCategory === 'betting', JSON.stringify(r));
  });

  // ==========================================================================
  // 4. Palabras débiles de apuestas NUNCA bloquean solas
  // ==========================================================================
  var WEAK_ALONE_EXAMPLES = [
    'The odds shifted after the star quarterback was ruled out for Sunday.',
    'The spread moved two points overnight ahead of kickoff.',
    'The moneyline favored the home team heading into the game.',
    'The over/under for the game sits at 47.5 points.'
  ];
  WEAK_ALONE_EXAMPLES.forEach(function (text) {
    var r = pipeline.detectFantasyOrBettingAdvice(text);
    check('4. Palabra débil sola NO bloquea: "' + text.slice(0, 50) + '..."', r.isFantasyOrBettingAdvice === false, JSON.stringify(r));
  });

  // ==========================================================================
  // 5. Débil + intención en la MISMA oración SÍ bloquea
  // ==========================================================================
  var WEAK_PLUS_INTENT_SAME_SENTENCE = [
    'Here is our best bet against the spread for Sunday\'s game.',
    'Our top pick against the moneyline this week is the home team.',
    'This week\'s tip: take the over/under and ride it.',
    'Wager on the spread with confidence using our analysis.'
  ];
  WEAK_PLUS_INTENT_SAME_SENTENCE.forEach(function (text) {
    var r = pipeline.detectFantasyOrBettingAdvice(text);
    check('5. Débil + intención (misma oración) SÍ bloquea: "' + text.slice(0, 50) + '..."',
      r.isFantasyOrBettingAdvice === true && r.adviceCategory === 'betting', JSON.stringify(r));
  });

  // ==========================================================================
  // 6. Débil + intención en oraciones DISTINTAS NO bloquea (exige proximidad)
  // ==========================================================================
  var WEAK_PLUS_INTENT_DIFFERENT_SENTENCES =
    'The spread moved two points overnight ahead of kickoff. Our analysts will pick their favorite storylines to watch heading into the weekend.';
  var r6 = pipeline.detectFantasyOrBettingAdvice(WEAK_PLUS_INTENT_DIFFERENT_SENTENCES);
  check('6. Débil + intención en oraciones DISTINTAS no bloquea (exige la misma oración)', r6.isFantasyOrBettingAdvice === false, JSON.stringify(r6));

  // ==========================================================================
  // 7. Controles negativos explícitos del pedido de Leonardo
  // ==========================================================================
  var NEGATIVE_CONTROLS = [
    {
      label: 'Regulación de apuestas que menciona "odds"',
      text: 'New state regulations require betting operators to display the odds more transparently to consumers, lawmakers said Thursday.'
    },
    {
      label: 'Sanción a una casa de apuestas por manipular "odds"',
      text: 'Regulators fined a major sportsbook this week after an investigation found the company had manipulated in-game odds without disclosure.'
    },
    {
      label: 'Resultado deportivo que solo menciona el "spread" previo',
      text: 'The home team covered the spread comfortably in Sunday\'s 34-10 win, extending its streak against divisional opponents.'
    },
    {
      label: 'Adquisición/resultado comercial de una empresa de apuestas',
      text: 'A leading sportsbook operator reported record quarterly revenue and announced the acquisition of a smaller betting technology startup.'
    },
    {
      label: 'Escándalo periodístico relacionado con apuestas',
      text: 'Federal prosecutors charged several people in a gambling scandal involving athletes and a regional sportsbook, according to court documents unsealed Tuesday.'
    },
    {
      label: 'Empresa de fantasy sports: resultado comercial (control adicional, ver prueba 2)',
      text: 'Fantasy sports operator DraftKings posted stronger-than-expected quarterly revenue, beating analyst estimates for the period.'
    }
  ];
  NEGATIVE_CONTROLS.forEach(function (ex) {
    var r = pipeline.detectFantasyOrBettingAdvice(ex.text);
    check('7. Control negativo (' + ex.label + '): NO se filtra', r.isFantasyOrBettingAdvice === false, JSON.stringify(r));
  });

  // ==========================================================================
  // 8. buildCandidates(): 0 llamadas de IA para fantasy/apuestas, transparencia
  // ==========================================================================
  const feeds = require(path.join(adminDir, 'feeds.js'));
  const originalFetchAllFeedItems = feeds.fetchAllFeedItems;
  const originalCheckUrlReachable = pipeline.checkUrlReachable;
  const originalFetchGoogleNewsRss = pipeline.fetchGoogleNewsRss;
  pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
  pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };
  feeds.fetchAllFeedItems = function () {
    return Promise.resolve({
      items: [
        {
          category: 'sports', title: 'Fantasy Week 3 Start or Sit: Running Backs to Trust and Fade',
          summary: 'Our fantasy football experts break down which running backs to start or sit this week.',
          link: 'https://sports.yahoo.com/fantasy/2026/09/week-3-start-sit-rbs', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
          image: '', author: '', domain: 'sports.yahoo.com', outlet: 'Yahoo Sports'
        },
        {
          category: 'sports', title: 'Best Bets for Sunday\'s Slate: Our Top Picks Against the Spread',
          summary: 'Our betting analysts share their best bets for this weekend\'s full slate of games.',
          link: 'https://oddshub.example/2026/09/best-bets-sunday-slate', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
          image: '', author: '', domain: 'oddshub.example', outlet: 'Oddshub'
        },
        {
          category: 'sports', title: 'Cardinals Rally Past Rivals in Fourth Quarter Comeback Win',
          summary: 'The Cardinals scored two late touchdowns to complete a stunning comeback victory Sunday night.',
          link: 'https://sports.yahoo.com/2026/09/cardinals-comeback-win', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
          image: '', author: '', domain: 'sports.yahoo.com', outlet: 'Yahoo Sports'
        }
      ],
      errors: []
    });
  };
  const built = await pipeline.buildCandidates();
  check('8. El candidato de fantasy (Start or Sit) nunca llega a ser candidato',
    !built.candidates.some(function (c) { return c.link.indexOf('week-3-start-sit-rbs') !== -1; }));
  check('8. El candidato de apuestas (best bets) nunca llega a ser candidato',
    !built.candidates.some(function (c) { return c.link.indexOf('best-bets-sunday-slate') !== -1; }));
  check('8. El candidato legítimo (resultado real de partido) SÍ llega a ser candidato',
    built.candidates.some(function (c) { return c.link.indexOf('cardinals-comeback-win') !== -1; }));
  check('8. filteredCounts.fantasyOrBetting cuenta EXACTAMENTE los 2 descartados', built.filteredCounts.fantasyOrBetting === 2, JSON.stringify(built.filteredCounts));
  check('8. fantasyBettingCandidates trae los 2, con categoría y término detectado identificables',
    built.fantasyBettingCandidates.length === 2 &&
    built.fantasyBettingCandidates.some(function (c) { return c.adviceCategory === 'fantasy' && c.matchedTerm && c.link.indexOf('week-3-start-sit-rbs') !== -1; }) &&
    built.fantasyBettingCandidates.some(function (c) { return c.adviceCategory === 'betting' && c.matchedTerm && c.link.indexOf('best-bets-sunday-slate') !== -1; }),
    JSON.stringify(built.fantasyBettingCandidates));
  feeds.fetchAllFeedItems = originalFetchAllFeedItems;
  pipeline.checkUrlReachable = originalCheckUrlReachable;
  pipeline.fetchGoogleNewsRss = originalFetchGoogleNewsRss;

  // ==========================================================================
  // 9. fetchNewDrafts() de punta a punta: 0 texto / 0 imagen para
  // fantasy/apuestas, 1 texto para el legítimo corroborado
  // ==========================================================================
  {
    fs.writeFileSync(path.join(dataDir, 'drafts.json'), '[]\n', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'candidate-cache.json'), '{}\n', 'utf8');
    const draft = require(path.join(adminDir, 'draft.js'));
    draft.loadConfig = function () { return { draftProvider: 'anthropic', anthropicApiKey: 'fake-key-de-prueba' }; };
    pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
    pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };
    // Segunda fuente REAL para el candidato legítimo (Solvex-style, para que
    // pase el gate de corroboración de 2 fuentes y llegue a redactarse).
    // Instrumentado (pedido de Leonardo, 2026-09-28, punto 5 de la orden de
    // cierre): registra con QUÉ link se llamó cada vez -- así se puede
    // confirmar, no solo inferir, que el filtro inequívoco de
    // fantasy/apuestas corre ANTES de la corroboración y que ninguno de los
    // 2 candidatos filtrados llegó siquiera a esta búsqueda.
    var corroborationCallLinks = [];
    pipeline.searchGoogleNewsForCorroboration = function (item) {
      corroborationCallLinks.push(item.link);
      if (item.link.indexOf('legit-storm-relief-effort') === -1) return Promise.resolve({ failed: true, reason: 'no matching source', source: null, diagnostic: null });
      return Promise.resolve({
        source: {
          url: 'https://independentwire.example/2026/09/storm-relief-corroboration', domain: 'independentwire.example',
          outlet: 'Independent Wire', headline: 'City Announces Storm Relief Effort For Affected Neighborhoods (confirmado)', publishedAt: isoDaysAgo(0),
          matchScore: 90, matchReasons: ['vocabulario compartido', 'comparten una entidad principal']
        },
        failed: false, reason: null, diagnostic: null
      });
    };
    feeds.fetchAllFeedItems = function () {
      return Promise.resolve({
        items: [
          {
            category: 'sports', title: 'Waiver Wire Pickups You Need to Know About Ahead of Week 6',
            summary: 'Our fantasy experts highlight the top waiver wire targets to add to your roster this week.',
            link: 'https://sports.yahoo.com/fantasy/2026/09/waiver-wire-week-6', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
            image: '', author: '', domain: 'sports.yahoo.com', outlet: 'Yahoo Sports'
          },
          {
            category: 'sports', title: 'Best Bets for Sunday\'s Slate: Our Top Picks Against the Spread',
            summary: 'Our betting analysts share their best bets for this weekend\'s full slate of games.',
            link: 'https://oddshub.example/2026/09/best-bets-sunday-slate-2', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
            image: '', author: '', domain: 'oddshub.example', outlet: 'Oddshub'
          },
          {
            category: 'business', title: 'City Announces Storm Relief Effort For Affected Neighborhoods',
            summary: 'City officials unveiled a new storm relief effort Tuesday to assist neighborhoods affected by last week\'s flooding.',
            link: 'https://citywire.example/2026/09/legit-storm-relief-effort', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
            image: '', author: '', domain: 'citywire.example', outlet: 'Citywire'
          }
        ],
        errors: []
      });
    };
    var aiCalls = 0;
    draft.draftArticle = function (item) {
      aiCalls++;
      return Promise.resolve({
        title: 'Ciudad anuncia esfuerzo de ayuda tras la tormenta',
        dek: 'Cobertura redactada de forma independiente para esta prueba automatizada.',
        body: 'Texto de cuerpo redactado de forma independiente para esta prueba automatizada, con suficiente extensión y estructura propia para superar cualquier mínimo del sitio, evitando cualquier coincidencia textual con el resumen original. City officials outlined a multi-week timeline for the relief effort, according to materials reviewed for this coverage. Volunteers from several community groups are expected to take part in the coordinated response over the coming weeks, organizers said.\n\n## Contexto adicional\nEsta sección aporta contexto propio sobre la magnitud del evento, sin copiar el resumen original consultado para esta cobertura. Similar relief efforts in neighboring areas have typically taken several weeks to complete, based on public timelines reviewed for past events of comparable scale in the region.\n\n## Qué sigue\nEsta segunda sección describe qué se espera a continuación, con vocabulario propio y distinto al de la fuente. A follow-up briefing is expected once the initial phase of the <a href="https://citywire.example/2026/09/legit-storm-relief-effort">relief effort</a> concludes, according to the same city materials, though no firm date has been set for that update.',
        category: item.category, readTime: '3 min', keyClaims: []
      });
    };
    pipeline.generateDraftImageManually; // no se usa acá -- solo referencia para dejar constancia de que existe
    const imageGenModule = require(path.join(adminDir, 'image-gen.js'));
    var imageCalls = 0;
    const originalGenerateCoverImage = imageGenModule.generateCoverImage;
    imageGenModule.generateCoverImage = function () { imageCalls++; return Promise.resolve(null); };

    var fetchResult = await pipeline.fetchNewDrafts();
    check('9. aiCallsMade === 1 (solo el candidato legítimo; 0 para fantasy/apuestas)', fetchResult.aiCallsMade === 1, JSON.stringify({ aiCallsMade: fetchResult.aiCallsMade, added: fetchResult.added }));
    check('9. El mock instrumentado de draftArticle confirma 1 sola invocación real', aiCalls === 1, aiCalls);
    check('9. filteredCounts.fantasyOrBetting === 2 en esta corrida', fetchResult.filteredCounts.fantasyOrBetting === 2, JSON.stringify(fetchResult.filteredCounts));
    check('9. fantasyBettingCandidates trae los 2 (waiver wire + best bets)', fetchResult.fantasyBettingCandidates.length === 2, JSON.stringify(fetchResult.fantasyBettingCandidates));
    check('9. Ningún borrador de fantasy/apuestas se escribió en drafts.json', fetchResult.added === 1, fetchResult.added);
    var draftsAfter9 = JSON.parse(fs.readFileSync(path.join(dataDir, 'drafts.json'), 'utf8'));
    check('9. drafts.json trae exactamente el borrador legítimo, ninguno de fantasy/apuestas',
      draftsAfter9.length === 1 && draftsAfter9[0].sourceUrl.indexOf('legit-storm-relief-effort') !== -1, JSON.stringify(draftsAfter9.map(function (d) { return d.sourceUrl; })));
    // Requisito 5 (pedido de Leonardo, 2026-09-28): el filtro inequívoco de
    // fantasy/apuestas debe consumir 0 búsquedas de corroboración -- se
    // confirma con el contador instrumentado de arriba, no solo infiriendo
    // por el resultado final. Exactamente 1 llamada total (la del candidato
    // legítimo), nunca 3 (las 2 de fantasy/apuestas jamás llegan acá).
    check('9. (req 5) searchGoogleNewsForCorroboration se llamó exactamente 1 vez en total (0 para los 2 filtrados por fantasy/apuestas)',
      corroborationCallLinks.length === 1, JSON.stringify(corroborationCallLinks));
    check('9. (req 5) Ninguna de las 2 llamadas de corroboración corresponde a waiver-wire o best-bets (fantasy/apuestas)',
      !corroborationCallLinks.some(function (l) { return l.indexOf('waiver-wire') !== -1 || l.indexOf('best-bets') !== -1; }), JSON.stringify(corroborationCallLinks));
    check('9. (req 5) La única llamada de corroboración que sí ocurrió es la del candidato legítimo (storm relief)',
      corroborationCallLinks.length === 1 && corroborationCallLinks[0].indexOf('legit-storm-relief-effort') !== -1, JSON.stringify(corroborationCallLinks));

    imageGenModule.generateCoverImage = originalGenerateCoverImage;
    feeds.fetchAllFeedItems = originalFetchAllFeedItems;
    pipeline.checkUrlReachable = originalCheckUrlReachable;
    pipeline.fetchGoogleNewsRss = originalFetchGoogleNewsRss;
  }

  // ==========================================================================
  // 10. admin.js contiene la etiqueta EXACTA pedida para la lista manual
  // ==========================================================================
  var adminJsSource = fs.readFileSync(path.join(adminDir, 'admin.js'), 'utf8');
  check('10. admin.js contiene EXACTAMENTE la etiqueta pedida para la lista manual',
    adminJsSource.indexOf('Fantasy/apuestas — no redactado automáticamente (0 llamadas de IA)') !== -1);
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas:', e);
  fail++;
}).finally(function () {
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('11. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('11. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('11. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
