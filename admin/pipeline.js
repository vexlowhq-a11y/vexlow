/*
  Pipeline de "buscar temas nuevos" — usado por admin/server.js
  =================================================================
  Trae titulares de los feeds RSS (admin/feeds.js), descarta los que
  ya se usaron antes (publicados, ya sugeridos como borrador, o
  descartados a mano), y redacta un borrador original por cada uno
  de los que queden (admin/draft.js) — hasta un máximo por corrida
  para controlar el costo. Los borradores quedan en data/drafts.json,
  nunca se publican solos.
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dns = require('dns');
const net = require('net');
const feeds = require('./feeds');
const googleTrends = require('./google-trends');
const draft = require('./draft');
const pagegen = require('./pagegen');
const imageGen = require('./image-gen');
const imageLicenses = require('./image-licenses');
const { readImageDimensions } = require('./image-dimensions');
const articleStatus = require('./article-status');

const ROOT_DIR = path.join(__dirname, '..');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const DISCARDED_FILE = path.join(DATA_DIR, 'discarded-sources.json');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');
const DRAFT_IMG_DIR = path.join(__dirname, '..', 'img', 'drafts');
const MAX_DRAFT_IMAGE_BYTES = 6 * 1024 * 1024;

const MAX_NEW_DRAFTS = 6;
const MAX_ITEM_AGE_DAYS = 4;
// Ventana para comparar contra artículos YA publicados al buscar
// "misma historia, otra fuente" (ver similarWords()/isSameStoryAsPublished()
// abajo) -- no hace falta comparar contra los ~200 históricos en cada
// corrida, solo contra lo reciente.
const SIMILARITY_LOOKBACK_DAYS = 21;
// Umbral de superposición de palabras significativas (título+resumen)
// para considerar que un ítem de RSS entrante es la MISMA historia que
// un artículo ya publicado, aunque el título/link sean distintos
// (fuentes distintas cubriendo el mismo hecho, o la IA reescribiendo
// el título de nuevo). Conservador a propósito: mejor dejar pasar
// algún duplicado ocasional que rechazar por error una historia
// legítima que solo comparte tema general. Calibrado a mano contra
// los ~200 artículos ya publicados: a 0.4, agarra 7 de 7 pares
// duplicados conocidos (Agility Robotics, Databricks, Apple/OpenAI,
// etc.) con CERO falsos positivos en las 2278 combinaciones posibles
// dentro de la categoría "ai" -- bajarlo a 0.35 agarra 2 pares más
// pero empieza a acercarse a artículos genuinamente distintos que
// solo comparten vocabulario de tema (ej. "chip"/"artificial
// intelligence" entre dos empresas distintas).
// Bloqueo duro para candidatos que tocan explotación/abuso sexual
// infantil (o material derivado, como fotos de menores manipuladas a
// contenido explícito con IA) -- se descartan ANTES de redactar, no
// después. A propósito conservador: mejor perder alguna nota legítima
// de política de seguridad infantil (rara, y sin las palabras "child"
// + término explícito juntas) que arriesgarse a redactar algo de esta
// categoría. No es solo un tema de AdSense -- es la clase de contenido
// que no debería llegar a la cola de revisión ni una vez, encontrado
// después de que un candidato real (menor + imagen manipulada a
// contenido explícito) llegó a redactarse el 2026-08-15.
const CHILD_SAFETY_TERMS = /\b(child|minor|childhood|kid|underage)\b/i;
const EXPLICIT_TERMS = /\b(explicit|nude|nudity|naked|sexual(?:ly)?|pornographic|porn|csam|sexual abuse|sex abuse|molest)/i;
function isChildSafetyRisk(text) {
  var t = String(text || '');
  return CHILD_SAFETY_TERMS.test(t) && EXPLICIT_TERMS.test(t);
}

// Red de seguridad estructural, además de la instrucción explícita
// del prompt (ver SYSTEM_PROMPT en admin/draft.js): si el modelo
// igual cae en uno de estos subtítulos de cierre genéricos —el
// patrón real de "scaled content abuse" que encontramos en 53 de
// 188 artículos ya publicados—, se marca el borrador para revisión
// en vez de dejarlo pasar en silencio.
const GENERIC_HEADINGS = new Set([
  'looking ahead', 'conclusion', 'future considerations', 'the competitive landscape',
  'what lies ahead', 'looking forward', 'the road ahead', 'the broader implications',
  'final thoughts', 'the bigger picture'
]);
function hasGenericHeading(body) {
  var heads = String(body || '').match(/^## (.+)$/gm) || [];
  return heads.some(function (h) { return GENERIC_HEADINGS.has(h.replace('## ', '').trim().toLowerCase()); });
}

// Filtro estructural de contenido promocional / con fecha límite vencida
// (incidente 2026-09-13: un "final, final, final call" de TechCrunch
// Disrupt 2026 -- lenguaje puramente comercial, plazo del 11 de
// septiembre ya vencido cuando se lo usó el 13 -- llegó a redactarse
// como si fuera una noticia, con "Riesgo editorial" y "Estado de
// aprobación" en verde en el checklist). Misma filosofía que el resto de
// estos filtros (ver isChildSafetyRisk/hasGenericHeading arriba):
// heurística de palabras clave, deliberadamente conservadora. Un evento
// real que SÍ es noticia ("Apple lanza X el 10 de septiembre") se
// describe, no le pide al lector que actúe ("Register now", "Book now",
// "Last chance", "Side Events") -- es un vocabulario bien distinto.
// Ampliado 2026-09-23 (hallazgo real de Leonardo: un borrador sobre "Robby
// Stein" hablando en TechCrunch Disrupt, en realidad marketing de entradas
// con urgencia de precio -- "speaker spotlight" + aviso de que el precio de
// las entradas/pases sube pronto, sin ninguna de las frases que ya cubría
// esta lista de arriba, como "get your tickets"/"register now"). Se agrega
// vocabulario específico de venta de entradas/pases de conferencias con
// urgencia de precio (nunca una fecha límite editorial real, ver
// isDeadlinePassed más abajo para ESA otra señal).
var PROMOTIONAL_TERMS = /\b(apply now|book now|last chance|one week left|register now|register by|get your tickets?|buy tickets?|buy your (?:ticket|pass)s?|secure your (?:ticket|pass|spot|seat)s?|exhibit(?:ors?)? (?:at|for)|side events?|limited availability|limited spots?|early[- ]bird|rsvp|sign up now|submit your (?:application|proposal|pitch|abstract)|call for (?:applications|submissions|speakers|proposals)|final(?:,? final)* call|don'?t miss (?:out|your chance)|save your spot|reserve your spot|act now|hurry|the deadline (?:is|to|for)|(?:ticket|pass)s? (?:start(?:ing)? at|price[sd]? (?:go(?:es|ing)? up|increase[sd]?|rises?))|price[sd]? (?:go(?:es|ing)? up|increase[sd]?) (?:soon|tonight|tomorrow|this week)|before prices? (?:go up|increases?)|standard pricing ends|save \$?\d+ on your (?:ticket|pass)|speaker spotlight)\b/i;
var PROMOTIONAL_TERMS_ES = /\b(fecha l[ií]mite|inscribite|inscr[ií]bete|reg[ií]strate ya|[uú]ltima oportunidad|cupo limitado|entradas? disponibles?|convocatoria abierta|no te lo pierdas|[uú]ltimo llamado)\b/i;

function detectPromotionalLanguage(text) {
  var t = String(text || '');
  var terms = [];
  [PROMOTIONAL_TERMS, PROMOTIONAL_TERMS_ES].forEach(function (re) {
    var global = new RegExp(re.source, 'gi');
    var m;
    while ((m = global.exec(t)) !== null) {
      terms.push(m[0]);
      if (m.index === global.lastIndex) global.lastIndex++;
    }
  });
  return { isPromotional: terms.length > 0, matchedTerms: terms.slice(0, 8) };
}

// ============================================================================
// OFERTAS/DESCUENTOS COMERCIALES -- hallazgo real de Leonardo (2026-09-20):
// un borrador de IGN ("...Drops to the Lowest Price Ever at Amazon Resale")
// llegó a la ficha de revisión como usable, siendo una oferta comercial
// temporal de una sola fuente -- exactamente el tipo de contenido que
// VexlowHQ no quiere reescribir (valor editorial nulo/efímero, precio que
// cambia en horas, sin ningún hecho verificable más allá de "está más
// barato ahora").
//
// Diseño (requisito 6 del pedido: nunca bloquear una noticia empresarial
// legítima que solo MENCIONE Amazon/precios/ingresos): en vez de bloquear
// por una sola palabra suelta ("deal", "sale" -- palabras normalísimas en
// el periodismo real, ver "Anthropic's $45 Billion DEAL with Nscale"), se
// exige que el texto combine señales de AL MENOS 3 de estas 4 categorías
// independientes:
//   - compra/disponibilidad de compra ahora mismo (COMMERCIAL_PURCHASE_TERMS)
//   - descuento/reducción de precio (COMMERCIAL_DISCOUNT_TERMS)
//   - urgencia/ventana temporal (COMMERCIAL_TEMPORAL_TERMS)
//   - un producto de consumo/retail reconocible (COMMERCIAL_PRODUCT_TERMS)
// Con esto, "Deal" solo (Nscale) nunca alcanza 3 categorías (0 en compra,
// 0 en temporalidad, 0 en producto) y nunca se marca. Un roundup real de
// ofertas ("Black Friday laptop deals under $500") sí las combina.
var COMMERCIAL_PURCHASE_TERMS = /\b(buy (?:it )?now|shop now|order now|add to cart|grab (?:this|the|a) deal|amazon resale|redeem (?:this|your) coupon|apply (?:this|your) (?:coupon|promo) code)\b/i;
var COMMERCIAL_DISCOUNT_TERMS = /\b(discount(?:ed)?|on sale|price drops?(?:ped)?|lowest price(?: ever)?|clearance|marked down|coupon(?: code)?|promo code|\d{1,3}%\s*off|save (?:up to )?\$?\d+(?:\.\d+)?%?|under \$\d+(?:\.\d+)?|deals?|sales?)\b/i;
var COMMERCIAL_TEMPORAL_TERMS = /\b(limited time|today only|while supplies last|prime day|black friday|cyber monday|flash sale|deal of the day|act fast|before it'?s gone|ends (?:today|tonight|soon))\b/i;
var COMMERCIAL_PRODUCT_TERMS = /\b(headsets?|headphones|earbuds|earphones|laptops?|notebooks?|chromebooks?|smartphones?|tablets?|televisions?|\btvs?\b|monitors?|smartwatch(?:es)?|cameras?|drones?|speakers?|soundbars?|vacuums?|blenders?|air fryers?|routers?|keyboards?|mouse|mice|consoles?|graphics cards?|\bgpus?\b|\bssds?\b|hard drives?|power banks?|chargers?|e-readers?|gaming chairs?|treadmills?)\b/i;

function detectCommercialDeal(text, url) {
  var t = String(text || '') + ' ' + String(url || '');
  var categories = {
    compra: COMMERCIAL_PURCHASE_TERMS.test(t),
    descuento: COMMERCIAL_DISCOUNT_TERMS.test(t),
    temporalidad: COMMERCIAL_TEMPORAL_TERMS.test(t),
    producto: COMMERCIAL_PRODUCT_TERMS.test(t)
  };
  var matchedTerms = [];
  [COMMERCIAL_PURCHASE_TERMS, COMMERCIAL_DISCOUNT_TERMS, COMMERCIAL_TEMPORAL_TERMS, COMMERCIAL_PRODUCT_TERMS].forEach(function (re) {
    var global = new RegExp(re.source, 'gi');
    var m;
    while ((m = global.exec(t)) !== null) {
      matchedTerms.push(m[0]);
      if (m.index === global.lastIndex) global.lastIndex++;
    }
  });
  var categoriesMatched = Object.keys(categories).filter(function (k) { return categories[k]; });
  return {
    isCommercialDeal: categoriesMatched.length >= 3,
    // Señal más suave (requisito 3, "cuando corresponda"): CUALQUIER
    // lenguaje de precio/descuento presente, aunque no alcance el umbral
    // de bloqueo -- avisa que el dato es volátil (puede cambiar en horas)
    // sin llegar a descartar el borrador entero por eso solo.
    priceVolatile: categories.descuento && categoriesMatched.length >= 2,
    categoriesMatched: categoriesMatched,
    matchedTerms: matchedTerms.slice(0, 8)
  };
}

// ============================================================================
// FANTASY / APUESTAS -- consejos individuales de alineación o selección
// (hallazgo real de Leonardo, 2026-09-27: un borrador de Google Trends
// redactado a partir de "Michael Wilson Fantasy Week 3 Start or Sit", una
// nota de fantasy football sobre a quién banquear esta semana -- cero valor
// noticioso real, corroborada solo por otras dos webs de fantasy que dicen
// lo mismo). Se corta ACÁ, antes de gastar ninguna llamada de IA -- mismo
// punto del archivo que detectCommercialDeal/detectPromotionalLanguage.
//
// A propósito NUNCA excluye la categoría Sports entera ni bloquea por
// mencionar la palabra "fantasy" sola (una noticia real y amplia -- ej. una
// empresa de fantasy sports que se vende, una regulación, un escándalo --
// puede mencionarla de pasada): todas las frases de FANTASY_ADVICE_TERMS son
// deliberadamente específicas del género "consejo individual de alineación"
// (start/sit, waiver wire, rankings, sleepers, DFS), nunca la palabra sola.
var FANTASY_ADVICE_TERMS = /\b(start\s*(?:or|\/|-)\s*sit|waiver[\s-]?wire|who should i start|fantasy rankings|fantasy lineups?|fantasy advice|fantasy projections|fantasy sleepers?|dfs picks?|daily fantasy picks?)\b/i;

// Apuestas -- estas frases SÍ bloquean solas (nunca son ambiguas: no existe
// una noticia real y amplia que diga "sportsbook promotion" o "lock of the
// day" sin ser en sí misma contenido de apuestas).
var STRONG_BETTING_ADVICE_TERMS = /\b(best bets?|betting picks?|prop bets?|player props?|parlay picks?|sportsbook (?:promotions?|bonus(?:es)?)|betting tips?|lock of the day)\b/i;

// "odds"/"spread"/"moneyline"/"over-under" son palabras normalísimas del
// periodismo deportivo real (un resultado que menciona las probabilidades
// previas, una nota de regulación de apuestas, una sanción a una casa de
// apuestas) -- NUNCA bloquean solas. Solo cuentan si, en la MISMA oración,
// aparece además una señal real de recomendación/selección personal
// ("bet"/"pick"/"wager"/"tip"). Deliberadamente NO se incluyen acá
// "betting" ni "sportsbook" como señal de intención (aunque Leonardo los
// mencionó en su lista): son sustantivos/adjetivos genéricos del tema que
// aparecen todo el tiempo en una nota real de regulación/negocio/escándalo
// ("nueva regulación de BETTING exige que los SPORTSBOOKS muestren los ODDS
// con transparencia" -- tres palabras del filtro en una oración
// perfectamente legítima) -- combinarlas como intención hubiera producido
// exactamente los falsos positivos que los controles negativos de abajo
// exigen evitar. "betting"/"sportsbook" siguen bloqueando por sí solos
// cuando forman parte de una frase fuerte de arriba (STRONG_BETTING_ADVICE_TERMS).
var WEAK_BETTING_TERMS = /\b(odds|spread|moneyline|over\/under|over-under)\b/i;
var BETTING_INTENT_TERMS = /\b(bet|bets|pick|picks|wager|wagers|tip|tips)\b/i;

// Divide en oraciones SIN filtrar por longitud (a diferencia de
// splitSentences() más abajo, pensada para comparar contra un texto fuente
// externo) -- acá interesa CUALQUIER oración, incluso corta, porque la
// proximidad misma (misma oración) es la señal que evita el falso positivo
// de "sportsbook ... odds" repartidos en dos oraciones distintas de una nota
// de regulación real.
function splitPlainSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function detectFantasyOrBettingAdvice(text) {
  var t = String(text || '');
  var fantasyMatch = t.match(FANTASY_ADVICE_TERMS);
  if (fantasyMatch) {
    return { isFantasyOrBettingAdvice: true, adviceCategory: 'fantasy', matchedTerm: fantasyMatch[0] };
  }
  var strongBettingMatch = t.match(STRONG_BETTING_ADVICE_TERMS);
  if (strongBettingMatch) {
    return { isFantasyOrBettingAdvice: true, adviceCategory: 'betting', matchedTerm: strongBettingMatch[0] };
  }
  var sentences = splitPlainSentences(t);
  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i];
    var weakMatch = s.match(WEAK_BETTING_TERMS);
    var intentMatch = s.match(BETTING_INTENT_TERMS);
    if (weakMatch && intentMatch) {
      return { isFantasyOrBettingAdvice: true, adviceCategory: 'betting', matchedTerm: weakMatch[0] + ' + ' + intentMatch[0] };
    }
  }
  return { isFantasyOrBettingAdvice: false, adviceCategory: null, matchedTerm: null };
}

// Fecha límite mencionada CERCA de una palabra que la presenta como un
// cierre/plazo ("deadline", "scheduled for", "final call", "apply by",
// etc.) -- a propósito NO se dispara con cualquier fecha del cuerpo (un
// artículo real menciona fechas pasadas todo el tiempo -- "el lunes X
// anunció Y" no es un plazo vencido, es una noticia). Solo cuenta si el
// texto la presenta como un límite.
var DEADLINE_TRIGGER = '(?:deadline|final(?:,? final)* call|last day|last chance|closes?|closing|due|apply by|register by|submit(?:ted)? by|scheduled for|ends? on|before|is set for)';
var MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec';
var DEADLINE_DATE_RE = new RegExp('\\b' + DEADLINE_TRIGGER + '\\b[^.\\n]{0,60}?\\b(' + MONTH_NAMES + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b', 'i');
var MONTH_INDEX = { january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11 };

function extractDeadlineInfo(text, referenceDate) {
  var t = String(text || '');
  var ref = referenceDate || new Date();
  var m = DEADLINE_DATE_RE.exec(t);
  if (!m) return { found: false };
  var monthIdx = MONTH_INDEX[m[1].toLowerCase().replace('.', '')];
  var day = parseInt(m[2], 10);
  if (monthIdx === undefined || !day) return { found: false };
  var year = m[3] ? parseInt(m[3], 10) : ref.getFullYear();
  var date = new Date(year, monthIdx, day, 23, 59, 59);
  // Sin año explícito y la fecha construida queda muy lejos en el futuro
  // (>270 días) respecto a la referencia -- probablemente el año real es
  // el anterior (nota de inicio de año hablando de un plazo de diciembre
  // pasado). Ajuste conservador, no afecta el caso principal (plazo
  // reciente del mismo año).
  if (!m[3] && (date.getTime() - ref.getTime()) > 270 * 24 * 60 * 60 * 1000) {
    date = new Date(year - 1, monthIdx, day, 23, 59, 59);
  }
  return { found: true, date: date, raw: m[0].trim() };
}

function isDeadlinePassed(text, referenceDate) {
  var ref = referenceDate || new Date();
  var info = extractDeadlineInfo(text, ref);
  if (!info.found) return { expired: false };
  return { expired: info.date.getTime() < ref.getTime(), date: info.date, raw: info.raw };
}

// Categorías editoriales definitivas (pedido de Leonardo, 2026-09-25,
// "descubrimiento de tendencias de EE.UU. y reorganización de categorías"):
// Entertainment y Sports vuelven a estar activas para NOTICIAS NUEVAS
// (dejaron de estarlo el 2026-09-13, ver el historial de este archivo) --
// Entertainment ahora se muestra como "Movies, TV & Anime" en el menú
// (mismo slug "entertainment" de siempre, ver data/categories.json, para
// no romper ninguna URL existente). Science & Space, en cambio, PASA a
// estar excluida: se integra editorialmente dentro de Technology (no se
// borra la categoría ni sus URLs/artículos viejos, solo se retira del menú
// principal -- ver retiredForNewContent en data/categories.json -- y no se
// le crean noticias nuevas). Igual que antes, esto SOLO afecta qué trae
// "Buscar noticias nuevas" (buildCandidates/fetchNewDrafts, más abajo) --
// no toca feeds.json ni listCategories(), así que el editor manual de
// artículos y el resto del panel siguen permitiendo crear/editar/publicar
// un artículo a mano en Science si alguna vez hiciera falta (hay artículos
// reales vigentes ahí). Para el caso en que la propia IA, sin que se lo
// pidan, decida reclasificar un borrador como "science" en su respuesta
// (listCategories() todavía la lista como slug válido, a propósito, por el
// motivo de arriba) -- ver el remapeo explícito science->technology en
// runFetchNewDrafts(), unas líneas después de la llamada a
// draft.draftArticle(), para que ese caso puntual tampoco cree contenido
// nuevo en Science.
var EXCLUDED_NEW_DRAFT_CATEGORIES = new Set(['science']);

const SAME_STORY_OVERLAP_THRESHOLD = 0.4;
// Umbral para el chequeo de "copia literal de la fuente" (ver
// verbatimOverlapRatio() abajo) -- distinto del de arriba: éste no
// compara temas/palabras clave, compara frases de 6 palabras
// SEGUIDAS. Calibrado a mano con reescrituras sintéticas: una
// reescritura genuina (mismos hechos, otra redacción) da 0.00; un
// parafraseo perezoso que solo cambia un par de palabras por oración
// ya da ~0.39; una copia literal con algo agregado da 1.00. 0.3 deja
// pasar coincidencias de frases genéricas cortas ("according to
// sources familiar with") sin marcar, pero agarra cualquier tramo
// real copiado del resumen de la fuente.
const COPY_WARNING_THRESHOLD = 0.3;
// Umbral del chequeo complementario de "parafraseo perezoso" (ver
// maxSentenceSimilarity() abajo) -- agarra el caso de una oración de
// la fuente que sobrevive casi intacta cambiando solo un par de
// palabras por sinónimos, algo que el chequeo de 6 palabras EXACTAS
// no detecta porque alcanza con romper una sola palabra de la cadena
// para esquivarlo. Calibrado igual con reescrituras sintéticas: una
// reescritura genuina da ~0.10-0.15, un parafraseo de sinónimos da
// 0.8+ -- 0.55 deja margen de sobra para no marcar coincidencias
// casuales de una frase corta y corriente.
const PARAPHRASE_WARNING_THRESHOLD = 0.55;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'into', 'over',
  'after', 'before', 'about', 'than', 'then', 'so', 'not', 'no', 'new', 'says', 'said', 'amid', 'up',
  'out', 'now', 'more', 'first', 'how', 'what', 'why', 'when', 'who'
]);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
// Escritura atómica (pedido de Leonardo, 2026-09-24, verificación previa a
// sincronizar): temporal en el MISMO directorio + rename, nunca
// fs.writeFileSync directo sobre el archivo final. Un rename dentro del
// mismo filesystem es atómico a nivel de sistema operativo -- un lector
// concurrente (o un corte de luz/crash a mitad de escritura) siempre ve el
// archivo viejo completo o el nuevo completo, nunca una mezcla a medio
// escribir. Se usa para TODO lo que este archivo persiste (drafts.json,
// discarded-sources.json, y la caché técnica candidate-cache.json) -- nunca
// para articulos.json, que ni se toca ni se escribe desde acá.
// Escritura atómica (temporal en el MISMO directorio + rename) -- pedido
// de Leonardo, 2026-09-23/24, para drafts.json/discarded-sources.json/
// candidate-cache.json (nunca articulos.json, ver ARTICULOS_FILE arriba,
// que tiene su propio mecanismo de respaldo/papelera aparte). El temporal
// va en el mismo directorio que el destino para que el rename sea una
// operación de un solo sistema de archivos (nunca "copiar entre discos").
//
// Corrección 2026-09-24 (pedido de Leonardo, punto 2 de su verificación
// final, "escritura atómica compatible con Windows"): si fs.renameSync()
// falla -- en Windows esto puede pasar con EPERM/EBUSY si algo más tiene
// el archivo de destino abierto, algo mucho más común ahí que en Linux --
// el archivo temporal ya NO queda huérfano en el directorio: se limpia con
// un unlink defensivo antes de relanzar el error original. El archivo de
// destino, en cualquiera de los dos sistemas operativos, nunca queda a
// medio escribir ni se pierde por este fallo: rename() (POSIX) y
// MoveFileEx con MOVEFILE_REPLACE_EXISTING (Windows, lo que usa Node por
// dentro) son operaciones de "todo o nada" sobre el destino -- si fallan,
// el destino queda EXACTAMENTE como estaba antes de intentar el rename.
function writeJSON(file, data) {
  var tmp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* defensivo -- si ni el unlink funciona, no hay más nada que limpiar acá */ }
    throw e;
  }
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Palabras significativas (sin stopwords ni palabras de 2 letras o
// menos) de un texto -- la base para detectar "misma historia, otra
// redacci\u00f3n" por superposici\u00f3n, ya que normalizeTitle() por s\u00ed sola
// solo detecta coincidencia EXACTA de t\u00edtulo.
function significantWords(text) {
  var words = normalizeTitle(text).split(' ').filter(function (w) {
    return w.length > 2 && !STOPWORDS.has(w);
  });
  return new Set(words);
}

// Superposici\u00f3n entre dos conjuntos de palabras, como fracci\u00f3n del
// m\u00e1s chico (no Jaccard puro) -- as\u00ed un resumen largo que menciona de
// pasada las mismas 4-5 palabras clave de un t\u00edtulo corto igual
// cuenta como coincidencia fuerte.
function wordOverlapScore(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  var smaller = setA.size <= setB.size ? setA : setB;
  var larger = setA.size <= setB.size ? setB : setA;
  var shared = 0;
  smaller.forEach(function (w) { if (larger.has(w)) shared++; });
  return shared / smaller.size;
}

function normalizeForShingles(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Shingles" de N palabras seguidas (n-gramas) de un texto -- la
// unidad que usa verbatimOverlapRatio() para detectar copia literal.
function shingles(text, n) {
  var words = normalizeForShingles(text).split(' ').filter(Boolean);
  var out = new Set();
  for (var i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

// Fracción de los shingles de 6 palabras del texto FUENTE que
// aparecen tal cual, palabra por palabra, en el texto GENERADO. A
// diferencia de wordOverlapScore() (que mide tema/vocabulario
// compartido, esperable en cualquier reescritura legítima), esto
// mide frases enteras copiadas -- una reescritura genuina casi nunca
// repite 6 palabras seguidas de la fuente, así que un valor alto acá
// es señal real de copia, no de "mismo tema".
function verbatimOverlapRatio(sourceText, generatedText, n) {
  n = n || 6;
  var sourceShingles = shingles(sourceText, n);
  if (!sourceShingles.size) return 0;
  var generatedNorm = ' ' + normalizeForShingles(generatedText) + ' ';
  var matched = 0;
  sourceShingles.forEach(function (sh) {
    if (generatedNorm.indexOf(' ' + sh + ' ') !== -1) matched++;
  });
  return matched / sourceShingles.size;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.split(/\s+/).length >= 6; });
}

function bigrams(text) {
  var words = normalizeForShingles(text).split(' ').filter(Boolean);
  var out = new Set();
  for (var i = 0; i + 2 <= words.length; i++) out.add(words.slice(i, i + 2).join(' '));
  return out;
}

function diceCoefficient(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  var shared = 0;
  setA.forEach(function (x) { if (setB.has(x)) shared++; });
  return (2 * shared) / (setA.size + setB.size);
}

// Complementa verbatimOverlapRatio(): agarra un "parafraseo perezoso"
// que cambia una o dos palabras por oración (sinónimos) y por eso se
// escapa del chequeo de 6 palabras EXACTAS seguidas. Compara cada
// oración de la fuente contra cada oración del texto generado por
// superposición de bigramas (coeficiente de Dice) y se queda con el
// par más parecido -- si UNA sola oración de la fuente sobrevive casi
// intacta (solo con sinónimos cambiados) en el artículo, se nota acá
// aunque el resto del artículo sea original. Con reescrituras
// genuinas da ~0.10-0.15 (nada que ver, ni una oración se parece); un
// parafraseo de sinónimos da 0.8+.
function maxSentenceSimilarity(sourceText, generatedText) {
  var sourceSentences = splitSentences(sourceText);
  var generatedSentences = splitSentences(generatedText);
  var best = 0;
  sourceSentences.forEach(function (s) {
    var sBigrams = bigrams(s);
    generatedSentences.forEach(function (g) {
      var d = diceCoefficient(sBigrams, bigrams(g));
      if (d > best) best = d;
    });
  });
  return best;
}

function daysAgo(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function isRecent(pubDate) {
  if (!pubDate) return true; // sin fecha: no lo descartamos por eso
  var t = Date.parse(pubDate);
  if (isNaN(t)) return true;
  var ageMs = Date.now() - t;
  return ageMs <= MAX_ITEM_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// Categorías de contenido reales (excluye "trending", que no es una
// categoría propia — es un agregado de las demás).
function listCategories() {
  return pagegen.loadCategories().filter(function (c) { return c.slug !== 'trending'; })
    .map(function (c) { return { slug: c.slug, label: c.label }; });
}

function uniqueSlug(base, taken) {
  var slug = base || 'articulo';
  var counter = 1;
  while (taken.has(slug)) {
    slug = base + '-' + counter;
    counter++;
  }
  taken.add(slug);
  return slug;
}

function todayISO() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

// ============================================================================
// PIPELINE DE 2 FASES / CONTROL DE COSTOS (pedido de Leonardo, 2026-09-23)
// ============================================================================
// Objetivo explícito del pedido: "la prioridad es no pagar redacción con IA
// para noticias que de antemano no pueden quedar listas". A partir de acá,
// "Buscar noticias nuevas" queda dividido en dos fases ESTRICTAS:
//   FASE 1 (buildCandidates, más abajo) -- sin ninguna llamada a IA: trae
//     titulares, descarta todo lo que ya se sabe que no puede quedar listo
//     (comercial/promocional/vencido/duplicado/categoría/fuente inválida/
//     viejo), y busca activamente una segunda fuente independiente real.
//   FASE 2 (fetchNewDrafts, más abajo) -- SOLO los candidatos que la fase 1
//     aprobó (fuente principal válida + segunda fuente independiente real +
//     misma historia confirmada + categoría activa + actualidad + sin
//     bloqueos) pueden llegar a gastar una llamada de redacción con IA, como
//     mucho 3 por corrida, una sola llamada por candidato, sin reintento.
// Nunca se inventa una fuente ni se baja ningún criterio para "completar
// cupos" -- si la fase 1 no aprueba a nadie, no se llama a la IA (ver el
// mensaje explícito en fetchNewDrafts).
var DEFAULT_PIPELINE_LIMITS = {
  // Requisito 16: valores iniciales pedidos por Leonardo.
  maxHeadlinesExamined: 30, // cuántos titulares RSS se evalúan como mucho por corrida
  maxCorroborationSearches: 10, // cuántas búsquedas activas de 2da fuente (capa 2/Google News) como mucho por corrida
  maxAIDrafts: 3, // cuántas redacciones con IA como mucho por corrida
  preselectionTimeoutMs: 45000 // plazo total de pared para toda la FASE 1 (sin contar la redacción)
};

function positiveIntOr(value, fallback) {
  var n = parseInt(value, 10);
  return (typeof n === 'number' && !isNaN(n) && n > 0) ? n : fallback;
}

// Límites configurables (requisito 16): se leen de admin/config.json bajo la
// clave "pipelineLimits" (ver config.example.json) -- cualquier valor
// ausente o inválido usa el default de arriba, nunca rompe ni desactiva el
// control de costos por una config incompleta.
function getPipelineLimits(cfg) {
  var custom = (cfg && cfg.pipelineLimits) || {};
  return {
    maxHeadlinesExamined: positiveIntOr(custom.maxHeadlinesExamined, DEFAULT_PIPELINE_LIMITS.maxHeadlinesExamined),
    maxCorroborationSearches: positiveIntOr(custom.maxCorroborationSearches, DEFAULT_PIPELINE_LIMITS.maxCorroborationSearches),
    maxAIDrafts: positiveIntOr(custom.maxAIDrafts, DEFAULT_PIPELINE_LIMITS.maxAIDrafts),
    preselectionTimeoutMs: positiveIntOr(custom.preselectionTimeoutMs, DEFAULT_PIPELINE_LIMITS.preselectionTimeoutMs)
  };
}

// ----------------------------------------------------------------------------
// Caché técnica de candidatos (requisito 18) -- SEPARADA de articulos.json y
// también separada de discarded-sources.json (esa sigue siendo la lista
// PERMANENTE de descartes manuales de un humano, ver discardDraft() más
// abajo; esto de acá es solo un ahorro de costo automático con vencimiento).
// Guarda, por URL, el motivo por el que la fase 1 la rechazó o no pudo
// corroborarla, con marca de tiempo -- una URL con una entrada vigente
// (menos de 24hs) se salta de entrada en la próxima corrida, sin gastar ni
// siquiera el análisis de texto, y mucho menos una búsqueda de corroboración
// o una redacción. Pasadas las 24hs la entrada se ignora sola (se poda al
// guardar) y esa URL se vuelve a evaluar de cero -- nunca queda "pegada" un
// resultado viejo para siempre.
const CANDIDATE_CACHE_FILE = path.join(DATA_DIR, 'candidate-cache.json');
const CANDIDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Verificación previa a sincronizar (pedido de Leonardo, 2026-09-24): tope
// duro de entradas para que el archivo nunca crezca sin límite -- la poda
// por vencimiento (24hs) ya lo mantiene chico en uso normal, pero esto es
// una segunda red de seguridad ante una config con maxHeadlinesExamined muy
// alto o muchísimas corridas en un mismo día. Al superar el tope se
// descartan las entradas MÁS VIEJAS primero (por cachedAt) -- nunca corta a
// la mitad de forma arbitraria, así lo más reciente (lo más probable que se
// vuelva a ver mañana) es siempre lo que se conserva.
const CANDIDATE_CACHE_MAX_ENTRIES = 1000;

function loadCandidateCache() {
  var raw = readJSON(CANDIDATE_CACHE_FILE, {});
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}
function pruneCandidateCache(cache, now) {
  now = typeof now === 'number' ? now : Date.now();
  var pruned = {};
  Object.keys(cache).forEach(function (url) {
    var entry = cache[url];
    if (!entry || typeof entry.cachedAt !== 'string') return;
    var age = now - Date.parse(entry.cachedAt);
    if (!isNaN(age) && age >= 0 && age < CANDIDATE_CACHE_TTL_MS) pruned[url] = entry;
  });
  return pruned;
}
// Aplica el tope duro de tamaño (ver CANDIDATE_CACHE_MAX_ENTRIES arriba),
// SIEMPRE después de podar por vencimiento -- si ya con la poda normal
// queda por debajo del tope, esto no hace nada. Nunca cuenta como filtro de
// negocio (no toca filteredCounts): es puro mantenimiento del archivo.
function capCandidateCacheSize(cache) {
  var urls = Object.keys(cache);
  if (urls.length <= CANDIDATE_CACHE_MAX_ENTRIES) return cache;
  urls.sort(function (a, b) {
    var ta = Date.parse((cache[a] && cache[a].cachedAt) || 0) || 0;
    var tb = Date.parse((cache[b] && cache[b].cachedAt) || 0) || 0;
    return tb - ta; // más reciente primero
  });
  var kept = {};
  urls.slice(0, CANDIDATE_CACHE_MAX_ENTRIES).forEach(function (url) { kept[url] = cache[url]; });
  return kept;
}
function saveCandidateCache(cache) { writeJSON(CANDIDATE_CACHE_FILE, capCandidateCacheSize(cache)); }
// Guarda ÚNICAMENTE el motivo del descarte y una marca de tiempo -- nunca
// el cuerpo del ítem, credenciales, ni la respuesta completa de ninguna
// búsqueda (requisito de privacidad de la caché técnica, verificación
// 2026-09-24). Cualquier campo nuevo que se le quiera agregar acá en el
// futuro tiene que seguir esta misma regla.
function cacheCandidateResult(cache, url, reason) {
  if (!url) return;
  cache[url] = { reason: reason, cachedAt: new Date().toISOString() };
}

// ----------------------------------------------------------------------------
// Estado de progreso de la corrida en curso (requisito 19): un objeto en
// memoria de proceso, nunca persistido -- el panel lo consulta por polling
// (GET /api/fetch-drafts/status en server.js) mientras espera la respuesta
// de POST /api/fetch-drafts, para mostrar en el botón exactamente en qué
// parte del proceso está ("Analizando titulares sin IA…", "Buscando
// corroboración…", "Redactando 1 de 3…") en vez de un mensaje genérico fijo.
var currentFetchStatus = { phase: 'idle', detail: '' };
function setFetchStatus(phase, detail) { currentFetchStatus = { phase: phase, detail: detail || '' }; }
function getFetchStatus() { return currentFetchStatus; }

// Orden de los candidatos YA APROBADOS por la fase 1 para decidir a cuáles
// de ellos les toca una de las (como mucho maxAIDrafts) redacciones de esta
// corrida (requisito 8): dos fuentes independientes, mayor actualidad,
// relevancia editorial, menor riesgo, menor similitud con lo ya publicado --
// en ese orden, cada criterio solo desempata al anterior. Esto NUNCA decide
// si un candidato pasa o no a redacción (eso ya lo decidió la fase 1 exigiendo
// corroboration.length > 0) -- solo el orden entre los que ya calificaron,
// para cuando hay más candidatos aprobados que cupos de redacción.
function candidatePriorityKey(item, recentWordSets) {
  var independentSourceCount = 1 + ((item.corroboration && item.corroboration.length) || 0);
  var pubTime = item.pubDateISO ? Date.parse(item.pubDateISO) : NaN;
  var recency = isNaN(pubTime) ? 0 : pubTime;
  var editorialRelevance = item.sourceCount || 1; // cuántos feeds cubren la misma historia ahora mismo
  var riskText = (item.title || '') + ' ' + (item.summary || '');
  var risk = RUMOR_LANGUAGE_TERMS.test(riskText) ? 1 : 0; // 0 = menor riesgo
  var words = significantWords((item.title || '') + ' ' + (item.summary || ''));
  var maxSimilarity = 0;
  (recentWordSets || []).forEach(function (w) { maxSimilarity = Math.max(maxSimilarity, wordOverlapScore(words, w)); });
  return { independentSourceCount: independentSourceCount, recency: recency, editorialRelevance: editorialRelevance, risk: risk, maxSimilarity: maxSimilarity };
}
function compareCandidatesForDrafting(a, b, recentWordSets) {
  var ka = candidatePriorityKey(a, recentWordSets), kb = candidatePriorityKey(b, recentWordSets);
  if (kb.independentSourceCount !== ka.independentSourceCount) return kb.independentSourceCount - ka.independentSourceCount;
  if (kb.recency !== ka.recency) return kb.recency - ka.recency;
  if (kb.editorialRelevance !== ka.editorialRelevance) return kb.editorialRelevance - ka.editorialRelevance;
  if (ka.risk !== kb.risk) return ka.risk - kb.risk;
  return ka.maxSimilarity - kb.maxSimilarity;
}

// Trae feeds, descarta lo ya visto (publicado, en borradores, o
// descartado a mano) y devuelve hasta MAX_NEW_DRAFTS candidatos
// nuevos, priorizados por cuántas fuentes distintas cubren cada
// historia (lo más grande/buscado del momento primero, sin importar
// la categoría). Usado por el flujo manual (fetchNewDrafts, abajo).
// Red de seguridad de última instancia para las dos fases de FASE 1 que
// corren en batch, antes de que buildCandidates() tenga una lista de
// candidatos sobre la que iterar uno por uno (lectura de feeds RSS y
// verificación de enlaces) -- mismo patrón y misma razón de ser que
// raceWithBackstop (más abajo, usado por searchGoogleNewsForCorroboration):
// la cancelación REAL ya viaja por deadlineObj.signal hasta cada petición
// de red de adentro (fetchUrl/attemptFetch la reciben y abortan la
// conexión de verdad al vencer, ver feeds.js y attemptFetch más arriba).
// Esto es solo para que buildCandidates() nunca quede colgada para
// siempre si alguna capa -- un mock de prueba ("una verificación de URL
// que no responde", pedido de Leonardo 2026-09-24), o un bug -- no llega
// a respetar esa señal. Si la promesa original "pierde" la carrera, nunca
// queda nada encadenado a su resultado eventual (ni acá ni en el
// llamador) -- no tiene ningún efecto observable.
function raceAgainstDeadline(promise, deadlineObj) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = null;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    }
    promise.then(function (value) { finish({ timedOut: false, value: value }); },
      function (err) { finish({ timedOut: false, error: err }); });
    var remaining = deadlineObj.remaining();
    if (remaining <= 0) {
      finish({ timedOut: true });
    } else {
      timer = setTimeout(function () { finish({ timedOut: true }); }, remaining);
    }
  });
}

async function buildCandidates(cfg, externalDeadline) {
  var limits = getPipelineLimits(cfg);
  // Deadline COMPARTIDO de toda la FASE 1 (pedido de Leonardo, 2026-09-24):
  // antes, preselectionTimeoutMs era apenas un timestamp que solo se
  // consultaba entre una búsqueda de Google News y la siguiente -- la
  // lectura de feeds, la verificación de enlaces, y cada petición de red
  // individual dentro de la corroboración podían seguir corriendo por su
  // cuenta bastante después de este plazo (hasta ~8s extra en
  // checkUrlReachable, según el informe anterior). Ahora deadlineObj se
  // crea UNA sola vez acá, al principio, y se pasa a cada función de red
  // de toda la fase (feeds.fetchAllFeedItems, checkUrlReachable,
  // searchGoogleNewsForCorroboration) -- todas capan su timeout propio a
  // lo que quede y reciben deadlineObj.signal como AbortSignal real, así
  // que al vencer, la conexión en curso se cancela DE VERDAD en cada una,
  // no solo se deja de esperar (ver los comentarios de attemptFetch/
  // fetchGoogleNewsRss/searchGoogleNewsForCorroboration más abajo).
  //
  // externalDeadline (2026-09-27, "timeout verdaderamente global"): cuando
  // runFetchNewDrafts() llama a esta función como RESPALDO de Google
  // Trends, le pasa el MISMO deadlineObj que ya venía corriendo desde el
  // arranque de la corrida (compartido con buildCandidatesFromTrends) --
  // así el respaldo RSS recibe únicamente el tiempo que quede del
  // presupuesto total, nunca un plazo nuevo de preselectionTimeoutMs
  // completo. Si no se pasa nada (llamada directa, ej. pruebas o el
  // camino RSS puro sin Trends), esta función se comporta exactamente
  // igual que antes: crea y cierra su propio deadline.
  var ownsDeadline = !externalDeadline;
  var deadlineObj = externalDeadline || feeds.makeDeadline(limits.preselectionTimeoutMs);
  var timedOut = false;
  var drafts = readJSON(DRAFTS_FILE, []);
  var discarded = readJSON(DISCARDED_FILE, []);
  var published = readJSON(ARTICULOS_FILE, []);
  var candidateCache = pruneCandidateCache(loadCandidateCache());

  var knownLinks = new Set(discarded);
  drafts.forEach(function (d) { if (d.sourceUrl) knownLinks.add(d.sourceUrl); });
  published.forEach(function (a) { if (a.sourceUrl) knownLinks.add(a.sourceUrl); });

  var knownTitles = new Set();
  drafts.forEach(function (d) { knownTitles.add(normalizeTitle(d.sourceTitle || d.title)); });
  published.forEach(function (a) { knownTitles.add(normalizeTitle(a.title)); });

  // Palabras significativas de lo publicado recientemente + lo que ya
  // está en borradores -- para detectar "misma historia, otra fuente/
  // otro título" además del chequeo de link/título exacto de arriba.
  // Sin esto, dos feeds distintos cubriendo el mismo hecho (o la IA
  // titulando distinto la segunda vez) pasan los filtros exactos sin
  // problema y terminan publicados dos veces.
  var recentCutoff = daysAgo(SIMILARITY_LOOKBACK_DAYS);
  var recentWordSets = [];
  published.forEach(function (a) {
    var t = Date.parse(a.date);
    if (!isNaN(t) && t < recentCutoff) return;
    recentWordSets.push(significantWords((a.title || '') + ' ' + (a.dek || '')));
  });
  drafts.forEach(function (d) {
    recentWordSets.push(significantWords((d.sourceTitle || d.title || '') + ' ' + (d.dek || '')));
  });
  function isSameStoryAsKnown(item) {
    var words = significantWords((item.title || '') + ' ' + (item.summary || ''));
    for (var i = 0; i < recentWordSets.length; i++) {
      if (wordOverlapScore(words, recentWordSets[i]) >= SAME_STORY_OVERLAP_THRESHOLD) return true;
    }
    return false;
  }

  // Lectura y filtrado de RSS -- ahora dentro del deadline compartido
  // (pedido de Leonardo, 2026-09-24, explícito en su punto 1: "lectura y
  // filtrado RSS" es una de las cinco operaciones que deben compartir el
  // plazo). feeds.fetchAllFeedItems(deadlineObj) ya corta su propio
  // recorrido de feeds y cancela cada petición en curso al vencer (ver
  // feeds.js) -- raceAgainstDeadline es solo la red de seguridad de último
  // recurso si algo no respeta esa señal.
  var fetchRace = await raceAgainstDeadline(feeds.fetchAllFeedItems(deadlineObj), deadlineObj);
  var fetched;
  if (fetchRace.timedOut) {
    timedOut = true;
    fetched = { items: [], errors: [] };
  } else if (fetchRace.error) {
    fetched = { items: [], errors: [{ url: null, error: fetchRace.error && fetchRace.error.message }] };
  } else {
    fetched = fetchRace.value || { items: [], errors: [] };
  }
  // Requisito 16 -- máximo de titulares RSS EXAMINADOS por corrida: el corte
  // se aplica ACÁ, antes de cualquier filtro, así "titulares examinados"
  // (requisito 15) es siempre min(traídos, maxHeadlinesExamined), nunca más,
  // sin importar cuántos filtros/descartes vengan después.
  var allFetchedItems = fetched.items || [];
  var headlinesExamined = Math.min(allFetchedItems.length, limits.maxHeadlinesExamined);
  var examinedItems = allFetchedItems.slice(0, limits.maxHeadlinesExamined);
  var filteredCounts = {
    categoryExcluded: 0, promotional: 0, expired: 0, unreachable: 0, blocked: 0, commercialDeal: 0,
    // Nuevos contadores (pedido de Leonardo, 2026-09-23) -- antes estos
    // descartes ni se contaban, así que "descartados antes de usar IA"
    // (requisito 15) quedaba incompleto.
    duplicate: 0, stale: 0, cachedSkip: 0, blockedContent: 0,
    // Fantasy/apuestas (pedido 2026-09-27, punto 4/8) -- ver
    // detectFantasyOrBettingAdvice() más arriba.
    fantasyOrBetting: 0
  };
  // Candidatos de fantasy/apuestas de ESTA corrida (pedido 2026-09-27, punto
  // 1): nunca se redactan ni se descartan en silencio -- quedan acá para que
  // fetchNewDrafts() los devuelva al panel como lista manual ("Fantasy/
  // apuestas -- no redactado automáticamente (0 llamadas de IA)"), mismo
  // criterio que singleSourceCandidates más abajo.
  var fantasyBettingCandidates = [];
  var candidates = examinedItems.filter(function (item) {
    // Requisito 18 -- caché técnica de 24hs: si esta URL ya se evaluó
    // recientemente (se descartó, o no se le encontró corroboración), se
    // salta de entrada sin gastar ni el análisis de texto -- pasadas las
    // 24hs la entrada se podó sola arriba (pruneCandidateCache) y se vuelve
    // a evaluar de cero.
    if (candidateCache[item.link]) { filteredCounts.cachedSkip++; return false; }
    if (isChildSafetyRisk((item.title || '') + ' ' + (item.summary || ''))) { filteredCounts.blockedContent++; return false; }
    if (EXCLUDED_NEW_DRAFT_CATEGORIES.has(item.category)) { filteredCounts.categoryExcluded++; return false; }
    if (knownLinks.has(item.link)) { filteredCounts.duplicate++; return false; }
    if (knownTitles.has(normalizeTitle(item.title))) { filteredCounts.duplicate++; return false; }
    if (!isRecent(item.pubDate)) { filteredCounts.stale++; return false; }
    // Requisitos 1/2/7 (hallazgo del borrador de IGN, 2026-09-20): se
    // revisa título+resumen+URL+metadatos del feed (outlet/dominio) ANTES
    // de gastar una redacción con IA -- una oferta comercial nunca llega
    // siquiera a convertirse en borrador. Ver detectCommercialDeal() más
    // arriba para el criterio de combinación de señales.
    var sourceText = (item.title || '') + ' ' + (item.summary || '') + ' ' + (item.outlet || '') + ' ' + (item.domain || '');
    var deal = detectCommercialDeal(sourceText, item.link);
    if (deal.isCommercialDeal) { filteredCounts.commercialDeal++; cacheCandidateResult(candidateCache, item.link, 'commercial-deal'); return false; }
    var promo = detectPromotionalLanguage(sourceText);
    if (promo.isPromotional) { filteredCounts.promotional++; cacheCandidateResult(candidateCache, item.link, 'promotional'); return false; }
    // Fantasy/apuestas (pedido 2026-09-27, punto 1/2): consejos individuales
    // de alineación/selección -- nunca la categoría Sports entera. No se
    // agrega a candidateCache (a diferencia de commercial-deal/promotional):
    // Leonardo puede querer ver el mismo candidato en la lista manual de
    // corridas siguientes, no que desaparezca a las 24hs como un descarte
    // técnico.
    var fantasyOrBetting = detectFantasyOrBettingAdvice(sourceText);
    if (fantasyOrBetting.isFantasyOrBettingAdvice) {
      filteredCounts.fantasyOrBetting++;
      fantasyBettingCandidates.push({
        title: item.title || '', summary: item.summary || '', link: item.link,
        domain: item.domain || null, outlet: item.outlet || null, category: item.category || null,
        adviceCategory: fantasyOrBetting.adviceCategory, matchedTerm: fantasyOrBetting.matchedTerm
      });
      return false;
    }
    var deadlineInfo = isDeadlinePassed(sourceText);
    if (deadlineInfo.expired) { filteredCounts.expired++; cacheCandidateResult(candidateCache, item.link, 'expired'); return false; }
    if (isSameStoryAsKnown(item)) { filteredCounts.duplicate++; cacheCandidateResult(candidateCache, item.link, 'duplicate'); return false; }
    return true;
  });

  // No repetir la misma historia dos veces dentro de esta misma corrida
  // (varios feeds suelen cubrir la misma noticia el mismo día) -- primero
  // por título exacto, y después por superposición de palabras entre
  // los candidatos que van quedando, para el caso de títulos distintos
  // sobre el mismo hecho. En vez de solo descartar los duplicados, se
  // cuentan (sourceCount) -- esa cuenta es la señal real de "esto es
  // grande ahora mismo" que se usa más abajo para priorizar.
  //
  // "Mejora global" 2026-09-20 (post-Nscale): antes, el duplicado se
  // tiraba entero y solo quedaba el número en sourceCount -- la URL/medio
  // de la segunda fuente que confirmaba la misma historia se perdía para
  // siempre, así que additionalSources nunca se podía completar sola.
  // Ahora cada duplicado real (mismo hecho, otro feed) queda registrado en
  // item.corroboration -- eso es lo que fetchNewDrafts() usa más abajo
  // para llenar additionalSources con fuentes REALES, nunca inventadas.
  // Tope de 4 y deduplicado por dominio: si 5 feeds del mismo medio
  // republican la misma nota (agregadores), no tiene sentido llenar
  // additionalSources con el mismo medio repetido.
  var MAX_CORROBORATION = 4;
  // Corroboración previa a la redacción (pedido de Leonardo, 2026-09-20,
  // tras revisión manual: "Solo listos" vacío y "Requiere revisión"
  // estancado en ~55 puntos porque additionalSources casi nunca se
  // llenaba). Antes, "otro feed cubrió la misma historia" alcanzaba con
  // que el dominio fuera distinto -- ahora, además, tiene que ser un
  // dominio/grupo de verdad independiente (nunca dos URLs del mismo
  // dueño, ver isIndependentSource() más abajo), no estar en la lista de
  // agregadores/comunicados/redes sociales excluida (EXCLUDED_CORROBORATION_
  // DOMAINS), y tratarse del MISMO acontecimiento -- no solo el mismo
  // vocabulario general (ver computeCorroborationMatch() más abajo, la
  // MISMA función que usa el botón manual "Buscar segunda fuente" de
  // server.js, para que nunca haya dos criterios distintos de "es la
  // misma noticia").
  function addCorroboration(target, item) {
    if (!target.corroboration) target.corroboration = [];
    if (target.corroboration.length >= MAX_CORROBORATION) return;
    var domain = item.domain || '';
    var alreadyThisDomain = target.corroboration.some(function (c) { return c.domain === domain; });
    if (alreadyThisDomain) return;
    if (EXCLUDED_CORROBORATION_DOMAINS.has(domain) || !isIndependentSource(target.domain, domain)) {
      // Se descarta por dominio/grupo, pero si el contenido de verdad se
      // parecía (no un simple ruido de otro feed sin relación), se deja
      // constancia para que el panel pueda explicar el motivo real en vez
      // de un "solo una fuente" genérico (requisito 15). ADVERTENCIA, no
      // corroboración: nunca suma ni resta puntaje (ver
      // SAME_DOMAIN_MATCH_WARNING_FIELD más abajo para la definición
      // completa del campo).
      var rough = computeCorroborationMatch(target, item);
      if (rough.score >= 40) target._sameDomainMatchWarning = true;
      return;
    }
    var match = computeCorroborationMatch(target, item);
    if (!match.isMatch) return;
    target.corroboration.push({
      url: item.link, domain: domain, outlet: item.outlet || '',
      headline: item.title || '', publishedAt: item.pubDateISO || null,
      retrievedAt: new Date().toISOString(), matchScore: match.score, matchReasons: match.reasons
    });
  }
  var seenTitles = new Set();
  var deduped = [];
  candidates.forEach(function (item) {
    var key = normalizeTitle(item.title);
    if (seenTitles.has(key)) {
      var exactMatch = deduped.filter(function (d) { return normalizeTitle(d.title) === key; })[0];
      if (exactMatch) { exactMatch.sourceCount++; addCorroboration(exactMatch, item); }
      return;
    }
    seenTitles.add(key);

    var words = significantWords((item.title || '') + ' ' + (item.summary || ''));
    for (var i = 0; i < deduped.length; i++) {
      if (wordOverlapScore(words, deduped[i]._words) >= SAME_STORY_OVERLAP_THRESHOLD) {
        deduped[i].sourceCount++;
        addCorroboration(deduped[i], item);
        return;
      }
    }
    item.sourceCount = 1;
    item._words = words;
    deduped.push(item);
  });
  deduped.forEach(function (item) { delete item._words; });
  candidates = deduped;

  // Priorizar lo que más fuentes distintas están cubriendo ahora mismo
  // (mismo hecho real reportado por 2+ feeds a la vez) en vez de repartir
  // parejo entre categorías -- la intención del sitio es maximizar
  // visitas con lo más buscado del momento, no llenar cada categoría
  // por igual. Empate en sourceCount: se conserva el orden en que
  // aparecieron los feeds (los primeros configurados/más recientes).
  candidates.sort(function (a, b) { return b.sourceCount - a.sourceCount; });
  // Nota (pedido de Leonardo, 2026-09-23): antes acá se cortaba a
  // MAX_NEW_DRAFTS (6) -- ese tope ya no aplica en esta etapa, porque ahora
  // "cuántos se van a REDACTAR con IA" es una decisión totalmente separada
  // (maxAIDrafts, requisito 9) que toma fetchNewDrafts() DESPUÉS de que la
  // fase 1 termine de aprobar candidatos. Acá el único tope de entrada ya se
  // aplicó arriba (maxHeadlinesExamined, requisito 16).

  // Fuente viva (2026-09-20, requisito 10 de la mejora global): antes de
  // redactar nada, se confirma que el link de origen todavía responde.
  // Igual que promocional/vencido, un link muerto NUNCA llega a convertirse
  // en borrador -- se cuenta en filteredCounts.unreachable y se explica en
  // el resultado de /api/fetch-drafts (ver admin.js). Se llama a través
  // de module.exports para que los tests puedan reemplazarla por una
  // versión sin red real (ver test-source-provenance.js).
  //
  // Corrección 2026-09-24 (pedido de Leonardo, punto 1 de su verificación
  // final): esta fase ahora recibe deadlineObj (checkUrlReachable capa su
  // timeout propio a lo que quede y cancela la conexión de verdad al
  // vencer, ver attemptFetch) y además corre bajo raceAgainstDeadline --
  // antes NO tenía ninguna noción del plazo compartido, y podía sumar
  // hasta ~8s extra por candidato más allá de los 45s. Si el deadline se
  // cumple antes de que TODAS las verificaciones terminen, no se asume
  // nada sobre las que quedaron sin resolver -- se descartan de esta
  // corrida entera (nunca se afirma "reachable" de un link no confirmado)
  // y la corrida se marca timedOut de inmediato, sin pasar a la
  // corroboración ni, más adelante, a ninguna llamada de IA.
  var reachabilityRace = await raceAgainstDeadline(
    Promise.all(candidates.map(function (item) {
      return module.exports.checkUrlReachable(item.link, undefined, deadlineObj).catch(function () { return { reachable: true, uncertain: true }; });
    })),
    deadlineObj
  );
  if (reachabilityRace.timedOut) {
    timedOut = true;
    candidates = [];
  } else {
    var reachability = reachabilityRace.value || [];
    var stillAlive = [];
    candidates.forEach(function (item, i) {
      var r = reachability[i];
      if (r && r.reachable === false) {
        // "blocked" (revisión de seguridad 2026-09-20: protocolo raro, IP
        // privada/interna, credenciales embebidas) se cuenta aparte de
        // "unreachable" (link genuinamente muerto/caído) -- un feed
        // configurado a mano nunca debería producir un link bloqueado por
        // política, así que si esto llega a pasar es una señal a mirar, no
        // un simple 404.
        if (r.blocked) filteredCounts.blocked = (filteredCounts.blocked || 0) + 1;
        else filteredCounts.unreachable = (filteredCounts.unreachable || 0) + 1;
        return;
      }
      stillAlive.push(item);
    });
    candidates = stillAlive;
  }

  // Búsqueda activa de corroboración -- capa 2 (requisito 2 de la
  // corroboración previa a la redacción, 2026-09-20): solo para los
  // candidatos que la capa 1 (otros feeds de esta misma corrida, ver
  // addCorroboration más arriba) no pudo corroborar. Como mucho UNA
  // consulta a Google News por candidato (requisito 14) -- nunca se
  // reintenta más de una vez acá; el botón manual "Buscar segunda fuente"
  // del panel es para reintentar después. Si la búsqueda falla (sin red,
  // timeout) el candidato sigue su curso como fuente única -- nunca se
  // inventa nada (requisito 12).
  // Requisito 16 (2026-09-23): como mucho maxCorroborationSearches búsquedas
  // ACTIVAS por corrida (no candidatos iterados -- los que la capa 1 ya
  // corroboró no gastan ninguna) -- más allá del cupo, un candidato sin
  // corroboración simplemente queda de fuente única para esta corrida (se
  // reintentará solo, gratis, si sigue apareciendo en una corrida futura
  // dentro del cupo). También respeta el plazo total de la fase 1
  // (preselectionTimeoutMs) -- si se agota, se corta acá sin gastar más
  // búsquedas, nunca a mitad de una llamada a la IA (la IA todavía ni
  // arrancó, ver fetchNewDrafts).
  var corroborationSearchesPerformed = 0;
  setFetchStatus('corroborating', 'Buscando corroboración…');
  for (var gi = 0; gi < candidates.length; gi++) {
    var candidateForSearch = candidates[gi];
    if (candidateForSearch.corroboration && candidateForSearch.corroboration.length) continue;
    if (corroborationSearchesPerformed >= limits.maxCorroborationSearches) break;
    if (deadlineObj.expired()) { timedOut = true; break; }
    corroborationSearchesPerformed++;
    try {
      // searchGoogleNewsForCorroboration nunca lanza y siempre devuelve un
      // objeto (ver su comentario) -- `failed` distingue una búsqueda que
      // no se pudo completar (sin red/timeout/límite de tasa/XML raro) de
      // una que corrió bien y de verdad no encontró nada; para
      // buildCandidates() el resultado es el mismo en ambos casos (el
      // candidato sigue de fuente única, nunca se inventa nada -- requisito
      // 12), así que solo importa `source` acá; `failed`/`reason` quedan
      // disponibles para quien quiera loguear el motivo real.
      var searchOutcome = await module.exports.searchGoogleNewsForCorroboration(candidateForSearch, candidateForSearch.domain, deadlineObj);
      var foundSource = searchOutcome && searchOutcome.source;
      if (foundSource) {
        candidateForSearch.corroboration = [{
          url: foundSource.url, domain: foundSource.domain, outlet: foundSource.outlet,
          headline: foundSource.headline, publishedAt: foundSource.publishedAt,
          retrievedAt: new Date().toISOString(), matchScore: foundSource.matchScore, matchReasons: foundSource.matchReasons
        }];
      } else {
        // Requisito 18: se buscó de verdad y no se encontró nada -- se
        // cachea por 24hs para no volver a gastar otra búsqueda de
        // corroboración en la misma URL mañana a la mañana. Un candidato
        // que NO llegó a buscarse (por el cupo o el timeout de arriba)
        // nunca se cachea -- tiene que poder reintentarse gratis.
        cacheCandidateResult(candidateCache, candidateForSearch.link, 'not-corroborated');
      }
    } catch (e) { /* defensivo -- sigue como fuente única, nunca se inventa una */ }
  }

  // Candidatos que pasaron todos los filtros previos a IA pero se quedaron
  // sin una segunda fuente independiente real (requisito 20): se devuelven
  // aparte para el modo secundario opcional "Mostrar candidatos con una sola
  // fuente" -- SOLO título, resumen del RSS y enlace, nunca se redactan
  // automáticamente (eso lo decide fetchNewDrafts, más abajo, que nunca los
  // manda a la IA).
  var singleSourceCandidates = candidates
    .filter(function (item) { return !(item.corroboration && item.corroboration.length); })
    .map(function (item) {
      return {
        title: item.title || '', summary: item.summary || '', link: item.link,
        domain: item.domain || null, outlet: item.outlet || null, category: item.category || null,
        pubDateISO: item.pubDateISO || null, sourceCount: item.sourceCount || 1,
        sameDomainMatchWarning: !!item._sameDomainMatchWarning
      };
    });

  saveCandidateCache(candidateCache);

  var takenSlugs = new Set();
  drafts.forEach(function (d) { takenSlugs.add(d.slug); });
  published.forEach(function (a) { takenSlugs.add(a.slug); });

  // Red de cierre (pedido de Leonardo, 2026-09-24): si por cualquier motivo
  // el plazo compartido ya se cumplió a esta altura pero ninguna de las
  // ramas de arriba llegó a marcar timedOut explícitamente (ej. el propio
  // guardado de la caché tardó lo último que quedaba de presupuesto), se
  // informa timeout igual -- nunca se reporta una corrida como "completa a
  // tiempo" cuando en los hechos ya se pasó del plazo. No tiene efecto
  // colateral: candidates/singleSourceCandidates ya están calculados con
  // lo que de verdad se llegó a confirmar, esto solo cambia el aviso.
  if (!timedOut && deadlineObj.expired()) timedOut = true;
  // ownsDeadline (2026-09-27): un deadline COMPARTIDO (pasado por
  // runFetchNewDrafts() como respaldo de Trends) nunca se cierra acá --
  // solo lo cierra quien lo creó, o el timer sigue corriendo para nada
  // en el resto de la corrida y una comprobación posterior de remaining()/
  // expired() dejaría de reflejar el plazo real compartido.
  if (ownsDeadline) deadlineObj.clear();

  return {
    candidates: candidates, errors: fetched.errors.slice(), skipped: fetched.items.length - candidates.length,
    takenSlugs: takenSlugs, filteredCounts: filteredCounts,
    headlinesExamined: headlinesExamined,
    corroborationSearchesPerformed: corroborationSearchesPerformed,
    singleSourceCandidates: singleSourceCandidates,
    // Pedido 2026-09-27, punto 1: candidatos de fantasy/apuestas de esta
    // corrida, para la lista manual del panel (ver renderFantasyBettingList
    // en admin.js) -- nunca se redactan, nunca se pierden en silencio.
    fantasyBettingCandidates: fantasyBettingCandidates,
    timedOut: timedOut,
    limits: limits
  };
}

// ============================================================================
// checkUrlReachable() -- confirma que una URL de fuente todavía responde
// (requisito 10 de la mejora global, 2026-09-20). REVISIÓN DE SEGURIDAD
// 2026-09-20 (pedido explícito de Leonardo antes de sincronizar): esta
// función hace una petición HTTP real de servidor a servidor a partir de
// una URL que puede venir de un feed RSS externo O de lo que alguien
// pegue a mano en el panel (GET /api/check-source) -- eso es exactamente
// la forma clásica de SSRF (Server-Side Request Forgery): sin las
// protecciones de abajo, alguien podría usar este "verificador de
// fuentes" para hacer que el SERVIDOR del panel golpee su propia red
// interna (localhost, otros servicios en 127.0.0.1, IPs privadas de la
// VPN/nube donde corre, o el endpoint de metadatos de la nube --
// 169.254.169.254 -- que en AWS/GCP/Azure puede filtrar credenciales).
//
// Protecciones (numeradas según el pedido de revisión):
//  1-2. Solo http/https, sin usuario:contraseña embebido en la URL.
//  3-4. Se resuelve DNS y se valida la IP ANTES de conectar -- usando la
//       opción `lookup` de http.request/https.request (ver safeLookup()
//       más abajo) en vez de resolver aparte y conectar después: así el
//       MISMO IP que se validó es el que se usa para conectar, sin dejar
//       una ventana para DNS rebinding (server DNS que devuelve una IP
//       pública para la validación y una privada milisegundos después
//       para la conexión real).
//  5.   Cada redirección vuelve a pasar por TODA la validación (protocolo,
//       credenciales, hostname bloqueado, DNS/IP) antes de seguirla --
//       nunca se sigue una redirección "a ciegas" con la URL ya validada
//       de antes.
//  6.   Redirecciones limitadas (4 por defecto), timeout de inactividad
//       DE SOCKET (8s) + un plazo total de pared (10s) que corta la
//       conexión pase lo que pase, incluso con un servidor que mande
//       tráfico sin pausas para esquivar el timeout de inactividad.
//  7.   Nunca se lee el cuerpo de la respuesta: se decide todo con los
//       headers/status (que están disponibles enteros en el evento
//       'response' antes de que llegue un solo byte del cuerpo) y se
//       corta la conexión con res.destroy() de inmediato -- ni siquiera
//       con el fallback a GET se descarga el archivo completo.
//  8.   El resultado devuelto nunca incluye headers, cookies ni el cuerpo
//       de la respuesta del sitio de origen -- solo reachable/status/
//       error/uncertain/blocked/reason. Tampoco se reenvía ninguna
//       cookie/credencial propia del panel hacia el sitio de origen (el
//       único header que se manda es un User-Agent fijo).
//  9.   Ver STATUS_BUCKET más abajo para la taxonomía exacta pedida.
var PRIVATE_IPV4_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32'
];
function ipv4ToInt(ip) {
  var parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  var nums = parts.map(Number);
  if (nums.some(function (n) { return isNaN(n) || n < 0 || n > 255; })) return null;
  return ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3];
}
function ipv4InCidr(ip, cidr) {
  var cidrParts = cidr.split('/');
  var base = ipv4ToInt(cidrParts[0]);
  var bits = parseInt(cidrParts[1], 10);
  var ipInt = ipv4ToInt(ip);
  if (base === null || ipInt === null) return false;
  var mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}
function isPrivateIPv4(ip) {
  return PRIVATE_IPV4_CIDRS.some(function (cidr) { return ipv4InCidr(ip, cidr); });
}

// Expande una dirección IPv6 (con "::" comprimido, y con el último grupo
// eventualmente en notación IPv4 embebida) a sus 8 grupos de 16 bits, para
// poder chequear rangos con máscaras de bits en vez de con regex de texto
// (una dirección puede escribirse de más de una forma -- comparar bits es
// la única forma confiable).
function expandIPv6(ip) {
  var clean = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // saca corchetes y zone id (fe80::1%eth0)
  var halves = clean.split('::');
  if (halves.length > 2) return null;
  function groupsOf(s) { return s ? s.split(':').filter(function (x) { return x !== ''; }) : []; }
  function expandEmbeddedV4(list) {
    var last = list[list.length - 1];
    if (last && /^\d+\.\d+\.\d+\.\d+$/.test(last)) {
      var v4 = last.split('.').map(Number);
      if (v4.length === 4 && v4.every(function (n) { return n >= 0 && n <= 255; })) {
        return list.slice(0, -1).concat([
          (((v4[0] << 8) | v4[1]) & 0xffff).toString(16),
          (((v4[2] << 8) | v4[3]) & 0xffff).toString(16)
        ]);
      }
    }
    return list;
  }
  var head = expandEmbeddedV4(groupsOf(halves[0]));
  var tail = halves.length === 2 ? expandEmbeddedV4(groupsOf(halves[1])) : [];
  var full;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    full = head;
  } else {
    var missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    full = head.concat(new Array(missing).fill('0')).concat(tail);
  }
  if (full.length !== 8) return null;
  var nums = full.map(function (g) { return /^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : null; });
  return nums.some(function (n) { return n === null; }) ? null : nums;
}
function isPrivateIPv6(ip) {
  var groups = expandIPv6(String(ip).toLowerCase());
  if (!groups) return true; // no se pudo interpretar como IPv6 válida -> bloquear por las dudas
  if (groups.every(function (n) { return n === 0; })) return true; // :: (sin especificar)
  if (groups.slice(0, 7).every(function (n) { return n === 0; }) && groups[7] === 1) return true; // ::1 (loopback)
  // IPv4-mapped (::ffff:a.b.c.d) -- se valida la IPv4 embebida con las
  // mismas reglas de arriba (incluye 169.254.169.254 vista como
  // ::ffff:169.254.169.254, forma real de acceder a metadatos de nube
  // desde una pila dual-stack).
  if (groups.slice(0, 5).every(function (n) { return n === 0; }) && groups[5] === 0xffff) {
    var v4 = ((groups[6] >> 8) & 0xff) + '.' + (groups[6] & 0xff) + '.' + ((groups[7] >> 8) & 0xff) + '.' + (groups[7] & 0xff);
    return isPrivateIPv4(v4);
  }
  var g0 = groups[0];
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 -- unique local (privada)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 -- link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 -- multicast
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 -- documentación
  if (g0 === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(function (n) { return n === 0; })) return true; // 64:ff9b::/96 -- NAT64
  return false;
}
function isPrivateOrReservedIP(ip) {
  var v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // no es una IP reconocible -> se bloquea, nunca se asume pública
}

// Bloqueo por nombre de host, ADEMÁS del chequeo por IP de abajo (defensa
// en profundidad): "localhost" resuelve a 127.0.0.1 en cualquier sistema
// normal y ya quedaría bloqueado por IP, pero no vale la pena ni pagar el
// costo de una resolución DNS para estos casos conocidos, y cubre el
// hostname de metadatos de GCP (que no es una IP -- 169.254.169.254 es
// AWS/Azure; GCP también acepta ese IP pero además tiene este hostname).
var BLOCKED_HOSTNAME_PATTERNS = [/^localhost$/i, /\.localhost$/i, /^metadata\.google\.internal$/i, /^metadata\.goog$/i];

// dns.lookup() con la MISMA IP usada para validar y para conectar (se pasa
// como opción `lookup` a http.request/https.request) -- ver nota grande de
// más arriba sobre por qué esto es la forma correcta de evitar DNS
// rebinding. Si CUALQUIERA de las direcciones que devuelve el DNS es
// privada/reservada, se bloquea entero (más conservador que "alcanza con
// que una sea pública") -- un host que resuelve a una mezcla de
// direcciones públicas y privadas no es el perfil de un medio de noticias
// real.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, function (err, addresses) {
    if (err) return callback(err);
    if (!addresses || !addresses.length) { var eNone = new Error('ENOTFOUND'); eNone.code = 'ENOTFOUND'; return callback(eNone); }
    for (var i = 0; i < addresses.length; i++) {
      // Se llama vía module.exports (no la referencia local) a propósito:
      // así los tests pueden simular de forma determinística un "primer salto
      // público" en runs sucesivos de checkUrlReachable() sin tocar la red
      // pública real, igual que ya se hace con module.exports.checkUrlReachable
      // dentro de buildCandidates(). Ver test-check-url-security.js.
      if (module.exports.isPrivateOrReservedIP(addresses[i].address)) {
        var eBlocked = new Error('SSRF_BLOCKED: DNS resolvió a una dirección privada/reservada (' + addresses[i].address + ')');
        eBlocked.code = 'SSRF_BLOCKED';
        return callback(eBlocked);
      }
    }
    var wantFamily = options && options.family;
    var chosen = addresses.find(function (a) { return !wantFamily || a.family === wantFamily; }) || addresses[0];
    callback(null, chosen.address, chosen.family);
  });
}

// Valida la URL en sí (protocolo/credenciales/hostname bloqueado) ANTES de
// siquiera intentar resolver DNS o conectar -- devuelve { blocked, reason }
// o null si pasa esta primera capa (la capa de IP/DNS se aplica después,
// vía safeLookup, en el momento de conectar de verdad).
function validateSourceUrlForFetch(rawUrl) {
  var u;
  try { u = new URL(rawUrl); } catch (e) { return { blocked: true, reason: 'invalid-url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { blocked: true, reason: 'protocol-not-allowed' };
  }
  if (u.username || u.password) {
    return { blocked: true, reason: 'credentials-in-url' };
  }
  var hostname = u.hostname;
  if (BLOCKED_HOSTNAME_PATTERNS.some(function (re) { return re.test(hostname); })) {
    return { blocked: true, reason: 'private-address' };
  }
  // Si el hostname YA es una IP literal (http://127.0.0.1/x, http://[::1]/x),
  // se puede validar de una sin gastar una resolución DNS.
  var literalIp = hostname.replace(/^\[|\]$/g, '');
  // Vía module.exports por el mismo motivo que en safeLookup: permite a los
  // tests simular de forma acotada y determinística una dirección "pública"
  // sobre loopback real (necesario porque este entorno de pruebas no tiene
  // acceso a red pública) sin dejar de bloquear de verdad cualquier otra IP
  // privada/reservada real. Ver test-check-url-security.js.
  if (net.isIP(literalIp) && module.exports.isPrivateOrReservedIP(literalIp)) {
    return { blocked: true, reason: 'private-address' };
  }
  return null;
}

var CHECK_URL_SOCKET_IDLE_TIMEOUT_MS = 8000;
var CHECK_URL_HARD_DEADLINE_MS = 10000; // plazo TOTAL de pared -- corta incluso si el servidor manda datos sin pausas para esquivar el timeout de inactividad (requisito 6)

// Un único intento de red sobre una URL YA VALIDADA (protocolo/credenciales/
// hostname -- ver validateSourceUrlForFetch) contra un host cuya IP se
// valida al momento de conectar (ver safeLookup). NO vuelve a validar el
// texto de la URL -- lo usan internamente checkUrlReachable() (primer
// intento) y el reintento HEAD->GET sobre la MISMA url ya validada; una
// redirección a una URL nueva SIEMPRE pasa por checkUrlReachable() de
// nuevo, nunca por acá directo (requisito 5).
// `deadline` (opcional, ver feeds.makeDeadline/makeChildDeadline): cuando
// buildCandidates() pasa uno (deadline compartido de toda la FASE 1,
// pedido de Leonardo 2026-09-24), esta función capa su propio plazo de
// pared y su timeout de socket a lo que quede, y pasa deadline.signal a la
// petición -- así Node cancela de verdad la conexión en curso si el
// deadline global se cumple mientras esta petición está en vuelo, en vez
// de solo dejar de esperarla (el problema que Leonardo señaló en
// searchGoogleNewsForCorroboration). Sin `deadline`, comportamiento
// idéntico al de siempre (checkUrlReachable/resolveSourceUrl sin deadline
// siguen funcionando exactamente igual para el botón manual "Buscar
// segunda fuente" y para todos los tests existentes).
function attemptFetch(urlObj, redirectsLeft, method, deadline) {
  return new Promise(function (resolve) {
    if (deadline && deadline.expired()) {
      return resolve({ reachable: true, uncertain: true, error: 'timeout' });
    }
    var lib = urlObj.protocol === 'https:' ? https : http;
    var settled = false;
    var ownHardDeadlineMs = deadline ? Math.max(1, Math.min(CHECK_URL_HARD_DEADLINE_MS, deadline.remaining())) : CHECK_URL_HARD_DEADLINE_MS;
    var hardDeadline = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) {}
      resolve({ reachable: true, uncertain: true, error: 'timeout' });
    }, ownHardDeadlineMs);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      resolve(result);
    }
    var ownSocketIdleMs = deadline ? Math.max(1, Math.min(CHECK_URL_SOCKET_IDLE_TIMEOUT_MS, deadline.remaining())) : CHECK_URL_SOCKET_IDLE_TIMEOUT_MS;
    var reqOpts = {
      method: method,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VexlowHQBot/1.0; +https://vexlowhq.com)' },
      timeout: ownSocketIdleMs,
      lookup: safeLookup
    };
    if (deadline) reqOpts.signal = deadline.signal;
    var req = lib.request(urlObj, reqOpts, function (res) {
      // Requisito 7/8: nunca se lee ni se guarda el cuerpo -- todo lo que
      // hace falta (status, Location) ya está en el evento 'response'
      // antes de que llegue un solo byte del cuerpo. destroy() corta la
      // conexión de inmediato, así un servidor que intente mandar una
      // respuesta gigante o infinita nunca se llega a descargar.
      res.destroy();
      var status = res.statusCode;
      if ([301, 302, 303, 307, 308].indexOf(status) !== -1 && res.headers.location) {
        if (redirectsLeft <= 0) return finish({ reachable: true, uncertain: true, error: 'too-many-redirects' });
        var next;
        try { next = new URL(res.headers.location, urlObj).toString(); } catch (e) { return finish({ reachable: true, uncertain: true, error: 'invalid-redirect-location' }); }
        // Requisito 5: la redirección se re-valida ENTERA (protocolo,
        // credenciales, hostname, y su propia IP al conectar) -- nunca se
        // sigue "heredando" la confianza de la URL original.
        return finish({ __redirectTo: next, __redirectsLeft: redirectsLeft - 1 });
      }
      if (status === 404 || status === 410) return finish({ reachable: false, status: status });
      if ((status === 405 || status === 401 || status === 403) && method === 'HEAD') {
        // El servidor no acepta HEAD (o lo trata como bot) -- probamos una
        // vez más con GET antes de sacar cualquier conclusión. Misma URL ya
        // validada, no hace falta repetir la validación de texto.
        return finish({ __retryAs: 'GET' });
      }
      if (status === 401 || status === 403 || status === 429) {
        // Requisito 9: acceso denegado/límite de tasa NO significa que la
        // nota no exista -- nunca se afirma reachable:false por esto.
        return finish({ reachable: true, uncertain: true, status: status });
      }
      if (status >= 500) {
        return finish({ reachable: true, uncertain: true, status: status });
      }
      return finish({ reachable: true, status: status });
    });
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} finish({ reachable: true, uncertain: true, error: 'timeout' }); });
    req.on('error', function (e) {
      // El deadline compartido abortó esta conexión de verdad (AbortSignal,
      // ver arriba) -- mismo desenlace que un timeout propio: nunca se
      // afirma "no existe", queda "incierto" (requisito 9).
      if (e && (e.code === 'ABORT_ERR' || e.name === 'AbortError')) {
        return finish({ reachable: true, uncertain: true, error: 'timeout' });
      }
      if (e && e.code === 'SSRF_BLOCKED') {
        return finish({ reachable: false, blocked: true, reason: 'private-address' });
      }
      // ENOTFOUND/ECONNREFUSED: el dominio ya no resuelve o rechaza
      // conexiones -- esto sí es una señal real de fuente muerta.
      if (e && (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED')) {
        return finish({ reachable: false, error: e.code });
      }
      finish({ reachable: true, uncertain: true, error: e && e.message });
    });
    req.end();
  });
}

// `deadline` (opcional, tercer argumento -- ver comentario de attemptFetch):
// se propaga a cada intento y a cada redirección seguida, así el plazo
// compartido de FASE 1 (pedido de Leonardo, 2026-09-24) cubre de verdad
// esta función completa, no solo el primer intento. Sin `deadline`,
// comportamiento idéntico al de siempre.
function checkUrlReachable(url, redirectsLeft, deadline) {
  redirectsLeft = redirectsLeft == null ? 4 : redirectsLeft;
  var blockedEarly = validateSourceUrlForFetch(url);
  if (blockedEarly) return Promise.resolve({ reachable: false, blocked: true, reason: blockedEarly.reason });
  var urlObj;
  try { urlObj = new URL(url); } catch (e) { return Promise.resolve({ reachable: false, blocked: true, reason: 'invalid-url' }); }
  if (deadline && deadline.expired()) return Promise.resolve({ reachable: true, uncertain: true, error: 'timeout' });

  function runAttempt(method) {
    return attemptFetch(urlObj, redirectsLeft, method, deadline).then(function (result) {
      if (result.__retryAs) return runAttempt(result.__retryAs);
      if (result.__redirectTo) return checkUrlReachable(result.__redirectTo, result.__redirectsLeft, deadline);
      return result;
    });
  }
  return runAttempt('HEAD');
}

// ============================================================================
// CORROBORACIÓN INDEPENDIENTE PREVIA A LA REDACCIÓN (pedido de Leonardo,
// 2026-09-20, a raíz de una prueba manual: "Descartados" funcionaba bien,
// pero "Solo listos" quedó vacío y "Requiere revisión" estancado en ~55
// puntos -- porque additionalSources (que ya existía, ver
// computeEditorialReadiness()/fetchNewDrafts() más abajo) casi nunca se
// llenaba de verdad).
//
// Objetivo (tal como lo pidió Leonardo): "encontrar candidatos
// suficientemente completos para una revisión humana rápida" -- SIN
// eliminar la revisión humana ni prometer que siempre va a haber
// candidatos "listos" (eso depende de que existan fuentes independientes
// reales para la noticia del día; ver readinessTier más arriba, que ya
// exige puntaje alto Y cero advertencias, sin cambios acá).
//
// Diseño en 2 capas, en este orden:
//  1. Los demás feeds YA configurados que se trajeron en esta misma
//     corrida (buildCandidates() ya los tiene en `fetched.items`) -- si
//     otro feed real ya cubrió la misma historia, no hace falta salir a
//     buscar nada más.
//  2. Solo si la capa 1 no alcanza: una búsqueda activa en Google News
//     RSS (news.google.com/rss/search), la única fuente pública de
//     noticias que no exige scraping de HTML ni una clave de API
//     inventada -- devuelve RSS estándar, el mismo formato que ya sabe
//     leer admin/feeds.js.
//
// "Es la misma noticia" NUNCA se decide solo por compartir palabras: hace
// falta ADEMÁS que compartan una entidad principal o la misma acción, y
// que las fechas (cuando ambas están disponibles) no sean incompatibles
// -- ver computeCorroborationMatch() más abajo, la ÚNICA función que
// decide esto, para que la corrida automática (buildCandidates) y el
// botón manual "Buscar segunda fuente" (server.js, vía
// findAdditionalSourceForDraft) usen siempre el mismo criterio.
//
// Límite de gasto (requisito de no derrochar llamadas): la búsqueda
// activa de Google News corre como mucho UNA vez por candidato, y sobre
// como mucho MAX_GOOGLE_NEWS_RESULTS_TO_CHECK resultados, cortando en el
// primero que de verdad coincide -- nunca se relanza sola ni se agranda
// esa ventana.

// Entidad principal (empresa/persona/producto/evento, requisito 1) --
// heurística deliberadamente simple (no hay NLP real acá, igual que el
// resto de este archivo prefiere regex explicables a "caja negra"):
// secuencias de palabras que empiezan con mayúscula, permitiendo
// conectores cortos como "of"/"the"/"and" en el medio (para agarrar
// "Bank of America" o "Fidji Simo" enteros, no partidos). Es
// intencionalmente conservadora: mejor perder alguna entidad rara que
// inventar coincidencias falsas.
var ENTITY_CONNECTOR_WORDS = new Set(['of', 'the', 'and', 'for', 'de', 'del', 'la', 'los']);

// Corrección de un falso positivo real (pedido de Leonardo, 2026-09-20,
// encontrado durante la propia batería de pruebas de esta función): un
// titular en "Title Case" tiene casi TODAS sus palabras en mayúscula,
// incluidos verbos/adjetivos genéricos frecuentes ("New", "Opens",
// "Announces") -- sin esta lista, dos titulares totalmente distintos que
// por casualidad arrancan con el mismo verbo genérico en mayúscula podían
// registrar una "entidad compartida" espuria (ver computeCorroborationMatch
// más abajo). Estas palabras NUNCA forman parte de una entidad, sin
// importar mayúscula/minúscula -- requisitos 1-2 del pedido. Lista
// deliberadamente amplia (mejor perder alguna entidad rara que inventar
// una coincidencia falsa, mismo criterio que el resto de este archivo).
var GENERIC_HEADLINE_ENTITY_WORDS = new Set([
  'new', 'latest', 'report', 'reports', 'reported', 'launches', 'unveils',
  'opens', 'announces', 'reveals', 'says', 'plans', 'could', 'may', 'will',
  'company', 'business', 'technology', 'ai',
  // Ampliación conservadora en el mismo espíritu -- otros términos
  // periodísticos genéricos igual de propensos a coincidir por casualidad.
  'would', 'should', 'update', 'updates', 'news', 'today', 'this', 'week',
  'weeks', 'year', 'years', 'debut', 'debuts', 'introduces', 'releases',
  'released', 'confirms', 'confirmed', 'according', 'amid', 'after', 'before',
  'first', 'now', 'more', 'most', 'top', 'big', 'major', 'here', 'still',
  // Días y meses (feeds en inglés) -- ver requisito 1 ("días, meses y
  // palabras comunes del titular").
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  // Interrogativos frecuentes al inicio de un titular ("Why", "How") --
  // antes se filtraba con una regla aparte ("descartar una entidad de una
  // sola palabra en la posición inicial"), pero esa regla también borraba
  // nombres propios reales de una sola palabra en esa misma posición (ej.
  // "Acme"/"OpenAI"/"Zeta" al arrancar el titular) -- se reemplaza por
  // esta lista explícita, mucho más precisa.
  'why', 'how', 'what', 'who', 'when', 'where'
]);
function extractMainEntities(title) {
  var words = String(title || '').split(/\s+/);
  var entities = [];
  var current = [];
  words.forEach(function (w) {
    var clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!clean) { if (current.length) { entities.push(current.join(' ')); current = []; } return; }
    var lower = clean.toLowerCase();
    // Requisitos 1-2: una palabra genérica CORTA la entidad en curso (igual
    // que una palabra en minúscula sin relación) -- nunca queda incluida en
    // ninguna entidad, así que una entidad de una sola palabra genérica
    // (ej. "New" o "AI" solos) nunca puede llegar a formarse.
    if (GENERIC_HEADLINE_ENTITY_WORDS.has(lower)) {
      if (current.length) { entities.push(current.join(' ')); current = []; }
      return;
    }
    var isCap = /^[A-Z][A-Za-z0-9.&'-]*$/.test(clean);
    var isConnector = ENTITY_CONNECTOR_WORDS.has(lower);
    if (isCap) {
      current.push(clean);
    } else if (isConnector && current.length) {
      current.push(lower);
    } else {
      if (current.length) { entities.push(current.join(' ')); current = []; }
    }
  });
  if (current.length) entities.push(current.join(' '));
  // (2026-09-20) Antes había acá una regla que descartaba una entidad de
  // una sola palabra en la posición inicial cuando había más de una
  // candidata -- pensada para interrogativos ("Why", "How"), pero
  // terminaba borrando nombres propios reales de una sola palabra que
  // arrancan el titular (ej. "Acme"/"OpenAI"/"Zeta"), justo la entidad
  // PRINCIPAL que hace falta para requisitos 3-4. Los interrogativos ahora
  // se filtran por nombre explícito en GENERIC_HEADLINE_ENTITY_WORDS, así
  // que esta regla aparte ya no hace falta -- solo queda el filtro de
  // ruido de siempre (una entidad tiene que tener más de un carácter real).
  return entities.filter(function (e) {
    return e.replace(/[^A-Za-z0-9]/g, '').length > 1;
  });
}

// Palabras individuales (normalizadas) de una lista de entidades -- para
// comparar entidades por PALABRA compartida en vez de exigir la frase
// completa idéntica (ver computeCorroborationMatch más abajo).
function entityWordSet(entities) {
  var out = new Set();
  (entities || []).forEach(function (e) {
    String(e).split(/\s+/).forEach(function (w) {
      var nw = normalizeTitle(w);
      if (nw.length > 2) out.add(nw);
    });
  });
  return out;
}

// Acción principal del titular (requisito 1) -- igual de deliberadamente
// simple: una tabla de sinónimos agrupados por tipo de acción periodística
// frecuente. No pretende cubrir todo el idioma, solo lo bastante común
// como para que "Company X acquires Y" y "Y is acquired by Company X" (u
// otra cobertura de la MISMA operación) caigan en el mismo grupo aunque
// las palabras exactas sean distintas.
var CORROBORATION_ACTION_GROUPS = [
  ['acquire', /\b(acquires?|to acquire|acquired|buys?|bought|purchases?|purchased)\b/i],
  ['appoint', /\b(appoints?|names?|hires?|taps?|promotes?)\b/i],
  ['launch', /\b(launches?|unveils?|announces?|debuts?|introduces?|releases?)\b/i],
  ['funding', /\b(raises?|secures? funding|closes? (?:a )?round|lands? funding)\b/i],
  ['partner', /\b(partners? with|signs? (?:a )?deal|teams? up|inks? (?:a )?deal)\b/i],
  ['ipo', /\b(files? for (?:an )?ipo|goes? public|prepares? for (?:an )?ipo|ipo filing)\b/i],
  ['earnings', /\b(reports? earnings|posts? (?:a )?loss|posts? (?:a )?profit|beats? estimates|misses? estimates)\b/i],
  ['legal', /\b(sues?|files? (?:a )?lawsuit|sued|settles? (?:a )?lawsuit|fined|faces? (?:antitrust|regulatory))\b/i],
  ['resign', /\b(resigns?|steps? down|departs?|to depart|ousted)\b/i],
  ['layoffs', /\b(lays? off|layoffs?|cuts? jobs|job cuts)\b/i],
  ['recall', /\b(recalls?|recalled)\b/i],
  ['breach', /\b(hacked|data breach|breached|leaks?ed?)\b/i]
];
function extractMainAction(title) {
  var t = String(title || '');
  for (var i = 0; i < CORROBORATION_ACTION_GROUPS.length; i++) {
    if (CORROBORATION_ACTION_GROUPS[i][1].test(t)) return CORROBORATION_ACTION_GROUPS[i][0];
  }
  return null;
}

// Requisito 13: nunca aceptar como "segunda fuente independiente" un
// agregador (solo republica/enlaza notas ajenas, no reportea de cero),
// un distribuidor de comunicados de prensa (es la propia empresa
// hablando de sí misma, no periodismo independiente que la confirme), ni
// una red social sin confirmar. Lista deliberadamente conservadora y NO
// exhaustiva -- lo que no está acá cae en el chequeo normal de
// independencia de dominio/grupo de abajo.
var EXCLUDED_CORROBORATION_DOMAINS = new Set([
  'news.google.com', 'msn.com', 'news.yahoo.com', 'flipboard.com', 'feedly.com', 'apple.news', 'smartnews.com',
  'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'accesswire.com', 'newswire.com', 'einpresswire.com',
  'x.com', 'twitter.com', 'facebook.com', 'threads.net', 'instagram.com', 'tiktok.com', 'reddit.com'
]);

// Requisitos 3-4: mismo dominio exacto, o mismo "grupo editorial" --
// reutiliza feeds.outletNameFromDomain() (la MISMA tabla que ya identifica
// que bbc.co.uk/bbci.co.uk/feeds.bbci.co.uk son todos "BBC", ver
// KNOWN_OUTLETS en admin/feeds.js) en vez de mantener una segunda lista de
// grupos editoriales por separado -- una sola fuente de verdad. No es
// exhaustivo (no cubre, por ejemplo, una red de diarios locales bajo un
// mismo dueño que no comparte dominio ni nombre de medio reconocible):
// mejor ser conservador acá y a veces perder una fuente válida que aceptar
// dos URLs del mismo dueño como si fueran independientes.
function isIndependentSource(domainA, domainB) {
  if (!domainA || !domainB) return false;
  if (domainA === domainB) return false;
  if (feeds.outletNameFromDomain(domainA) === feeds.outletNameFromDomain(domainB)) return false;
  return true;
}

var CORROBORATION_MAX_DATE_GAP_DAYS = 5;
var CORROBORATION_MATCH_THRESHOLD = 60;
// Requisito 4 (pedido de Leonardo, 2026-09-20): una acción compartida
// (ej. "launch") es una categoría amplia -- dos empresas DISTINTAS
// lanzando productos DISTINTOS caen en el mismo grupo con facilidad. Sin
// una entidad real en común, una acción genérica nunca alcanza sola: si
// no hay sharedEntity, se exige un puntaje mucho más alto (los 4 puntos a
// la vez -- vocabulario+acción+fecha -- casi nunca ocurre entre dos
// historias de verdad distintas). Con sharedEntity, se sigue usando el
// umbral normal (CORROBORATION_MATCH_THRESHOLD).
var CORROBORATION_ACTION_ONLY_MIN_SCORE = 80;

// Única función que decide "¿esto es de verdad la misma noticia?" --
// usada tanto por la corrida automática (buildCandidates/addCorroboration)
// como por el botón manual "Buscar segunda fuente" (findCorroborationForItem/
// findAdditionalSourceForDraft), a propósito, para que nunca haya dos
// varas distintas. Combina 4 señales independientes con puntaje explicable
// (mismo estilo que computeEditorialReadiness() más arriba: cada +/- queda
// en `reasons`, nunca una caja negra):
//   +40 vocabulario compartido (título+resumen) -- el chequeo que YA
//        existía antes de este pedido (SAME_STORY_OVERLAP_THRESHOLD).
//   +30 comparten una entidad principal (empresa/persona/producto).
//   +20 misma acción principal (mismo grupo en CORROBORATION_ACTION_GROUPS).
//   +10 fechas compatibles (cuando ambas están disponibles).
// Requisito 5 (nunca alcanza con compartir palabras solamente): el umbral
// de coincidencia (60) obliga a que, además del vocabulario (+40), haya
// TAMBIÉN una entidad o una acción en común -- 40 solo nunca alcanza.
// Requisito 6 (fechas incompatibles descartan el match pase lo que pase):
// si ambas fechas están disponibles y la diferencia supera
// CORROBORATION_MAX_DATE_GAP_DAYS, isMatch da false sin importar el resto
// del puntaje -- dos notas reales sobre la MISMA empresa pero con semanas
// de diferencia son, casi seguro, dos acontecimientos distintos.
function computeCorroborationMatch(a, b) {
  var reasons = [];
  var score = 0;

  var wordsA = significantWords((a.title || '') + ' ' + (a.summary || ''));
  var wordsB = significantWords((b.title || '') + ' ' + (b.summary || ''));
  var overlap = wordOverlapScore(wordsA, wordsB);
  if (overlap >= SAME_STORY_OVERLAP_THRESHOLD) { score += 40; reasons.push('vocabulario compartido (' + Math.round(overlap * 100) + '%)'); }

  // Comparación por PALABRA dentro de la entidad PRINCIPAL (la primera
  // extraída, requisito 3: priorizar entidades compuestas/nombres propios
  // concretos -- ver extractMainEntities, que ya descarta una sola palabra
  // genérica en la posición inicial) -- "Empresa Acme" (arrastra el
  // "Empresa" de arranque de oración) y "Acme" sola tienen que reconocerse
  // como la misma entidad; exigir la frase entera idéntica perdía
  // coincidencias reales solo por cómo cada medio tituló la oración.
  //
  // A propósito NO se comparan TODAS las entidades del titular (solo la
  // principal): un titular en "Title Case" casi siempre tiene más de una
  // (ej. "Acme Launches New Cloud Security Platform" también extrae
  // "Cloud Security Platform" como entidad candidata) -- comparar esas
  // frases descriptivas genéricas entre sí es exactamente el falso
  // positivo que Leonardo encontró (dos empresas DISTINTAS con productos
  // DISTINTOS pero del mismo rubro general "coinciden" por la categoría
  // del producto, no por la empresa). La entidad principal (la primera,
  // típicamente el sujeto de la oración) es la que de verdad identifica
  // "de quién es la noticia".
  var mainEntityA = extractMainEntities(a.title).slice(0, 1);
  var mainEntityB = extractMainEntities(b.title).slice(0, 1);
  var entityWordsA = entityWordSet(mainEntityA);
  var entityWordsB = entityWordSet(mainEntityB);
  var sharedEntity = false;
  entityWordsA.forEach(function (w) { if (entityWordsB.has(w)) sharedEntity = true; });
  if (sharedEntity) { score += 30; reasons.push('comparten una entidad principal (' + (mainEntityA[0] || '') + ')'); }

  var actionA = extractMainAction(a.title);
  var actionB = extractMainAction(b.title);
  var sameAction = !!(actionA && actionA === actionB);
  if (sameAction) { score += 20; reasons.push('misma acción principal (' + actionA + ')'); }

  var dateCompatible = true;
  if (a.pubDateISO && b.pubDateISO) {
    var ta = Date.parse(a.pubDateISO), tb = Date.parse(b.pubDateISO);
    if (!isNaN(ta) && !isNaN(tb)) {
      var gapDays = Math.abs(ta - tb) / (24 * 60 * 60 * 1000);
      if (gapDays > CORROBORATION_MAX_DATE_GAP_DAYS) {
        dateCompatible = false;
        reasons.push('fechas incompatibles (' + gapDays.toFixed(1) + ' días de diferencia)');
      } else {
        score += 10; reasons.push('fechas compatibles (' + gapDays.toFixed(1) + ' días de diferencia)');
      }
    }
  }

  // Requisito 4: una acción compartida SIN entidad real en común es una
  // señal mucho más débil (ver comentario de CORROBORATION_ACTION_ONLY_MIN_SCORE
  // arriba) -- nunca alcanza con el umbral normal, hace falta casi el
  // puntaje completo.
  var isMatch = dateCompatible && (
    (sharedEntity && score >= CORROBORATION_MATCH_THRESHOLD) ||
    (!sharedEntity && sameAction && score >= CORROBORATION_ACTION_ONLY_MIN_SCORE)
  );
  return { isMatch: isMatch, score: score, reasons: reasons, dateCompatible: dateCompatible, sharedEntity: sharedEntity, sameAction: sameAction };
}

// Sigue el mismo camino de validación SSRF que checkUrlReachable()
// (validateSourceUrlForFetch + safeLookup vía attemptFetch, ver arriba)
// pero además devuelve la URL FINAL después de seguir redirecciones --
// necesario para resolver el link de redirección de Google News
// (news.google.com/rss/articles/...) al artículo real del medio que lo
// publicó; sin esto nunca se podría saber de qué dominio es en realidad
// (requisito 7: "debe... superar la validación SSRF ya implementada").
// Expuesta vía module.exports (mismo patrón que checkUrlReachable) para
// que los tests puedan reemplazarla por una versión sin red real.
// `deadline` (opcional, tercer argumento -- mismo patrón que
// checkUrlReachable arriba): se propaga a cada intento y a cada
// redirección seguida.
function resolveSourceUrl(url, redirectsLeft, deadline) {
  redirectsLeft = redirectsLeft == null ? 4 : redirectsLeft;
  var blockedEarly = validateSourceUrlForFetch(url);
  if (blockedEarly) return Promise.resolve({ reachable: false, blocked: true, reason: blockedEarly.reason, finalUrl: null });
  var urlObj;
  try { urlObj = new URL(url); } catch (e) { return Promise.resolve({ reachable: false, blocked: true, reason: 'invalid-url', finalUrl: null }); }
  if (deadline && deadline.expired()) return Promise.resolve({ reachable: true, uncertain: true, error: 'timeout', finalUrl: null });

  function runAttempt(method) {
    return attemptFetch(urlObj, redirectsLeft, method, deadline).then(function (result) {
      if (result.__retryAs) return runAttempt(result.__retryAs);
      if (result.__redirectTo) return module.exports.resolveSourceUrl(result.__redirectTo, result.__redirectsLeft, deadline);
      var out = {};
      Object.keys(result).forEach(function (k) { out[k] = result[k]; });
      out.finalUrl = urlObj.toString();
      return out;
    });
  }
  return runAttempt('HEAD');
}

var GOOGLE_NEWS_HOST = 'news.google.com';
var GOOGLE_NEWS_TIMEOUT_MS = 8000;
var MAX_GOOGLE_NEWS_RESULTS_TO_CHECK = 6;
// Requisito 6 (pedido de Leonardo, 2026-09-20): tope de PARED para la
// búsqueda de Google News COMPLETA (la consulta + hasta 6 resoluciones de
// URL, cada una con su propio timeout de hasta ~10s -- ver
// checkUrlReachable/resolveSourceUrl más arriba). Sin este tope, un
// candidato con Google News lento/degradado podía tardar hasta ~68s
// (8s + 6×10s) y, como buildCandidates() revisa esto para cada candidato
// de la corrida uno detrás del otro, "Buscar noticias nuevas" podía
// demorarse varios minutos sin avisar nada -- eso es justo el "bloquear
// todo el panel" que pidió evitar.
//
// Corrección 2026-09-24 (pedido de Leonardo, tras revisión del informe
// del deadline global): el comentario que estaba acá antes decía que "no
// hay manera de cancelar un socket ya en curso en Node... y no hace
// falta". Eso ya no es así -- ahora SÍ se cancela de verdad: este tope se
// pasa como AbortSignal real (ver feeds.makeChildDeadline y
// searchGoogleNewsForCorroboration más abajo) a cada petición de red de
// adentro (fetchGoogleNewsRss/resolveSourceUrl/attemptFetch), así que al
// vencer, la conexión en curso se destruye de verdad -- no sigue
// corriendo en segundo plano. La única espera "de respaldo" que queda
// (raceWithBackstop, más abajo) es para el caso patológico de que alguna
// capa no respete esa señal (ej. un mock de prueba), nunca la protección
// principal.
var GOOGLE_NEWS_OVERALL_TIMEOUT_MS = 15000;

// Búsqueda pública sin scraping de HTML ni clave de API inventada
// (requisito 2/3): Google News RSS. El host es SIEMPRE este literal fijo
// (nunca se arma a partir de un link externo ni de nada que venga de un
// feed), así que esta petición en sí no tiene el riesgo de SSRF que sí
// tiene resolveSourceUrl() (que recibe URLs que vienen del resultado, no
// armadas por nosotros) -- esa protección se aplica de todas formas a
// CADA resultado individual antes de aceptarlo como fuente, más abajo.
// Expuesta vía module.exports (mismo patrón que checkUrlReachable) para
// que los tests puedan simular una respuesta sin pegarle a la red real --
// necesario además porque este entorno de pruebas no tiene salida a
// internet pública (ver informe: se confirmó sin acceso a
// news.google.com desde el sandbox de esta sesión).
// `deadline` (opcional, ver comentario largo de attemptFetch): capa el
// timeout propio a lo que quede y pasa deadline.signal a la petición, así
// una búsqueda de Google News en curso se cancela de verdad si el plazo
// compartido de FASE 1 se cumple mientras espera respuesta -- en vez del
// Promise.race de antes, que dejaba la petición viva en segundo plano
// aunque "perdiera" la carrera (el problema exacto que señaló Leonardo,
// 2026-09-24). Sin `deadline`, comportamiento idéntico al de siempre.
function fetchGoogleNewsRss(query, deadline) {
  return new Promise(function (resolve, reject) {
    if (deadline && deadline.expired()) {
      var eExpired = new Error('timeout'); eExpired.corroborationErrorCode = 'timeout';
      return reject(eExpired);
    }
    var url = 'https://' + GOOGLE_NEWS_HOST + '/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en';
    var ownTimeoutMs = deadline ? Math.max(1, Math.min(GOOGLE_NEWS_TIMEOUT_MS, deadline.remaining())) : GOOGLE_NEWS_TIMEOUT_MS;
    var reqOpts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VexlowHQBot/1.0; +https://vexlowhq.com)' },
      timeout: ownTimeoutMs
    };
    if (deadline) reqOpts.signal = deadline.signal;
    var req = https.get(url, reqOpts, function (res) {
      // Requisito 6: un límite de tasa (429) se distingue del resto de
      // errores HTTP -- mismo tratamiento final (nunca inventa, sigue en
      // revisión), pero permite que el motivo mostrado sea más preciso.
      if (res.statusCode === 429) { res.resume(); var errRate = new Error('HTTP 429 (límite de tasa)'); errRate.corroborationErrorCode = 'rate-limited'; return reject(errRate); }
      if (res.statusCode !== 200) { res.resume(); var errHttp = new Error('HTTP ' + res.statusCode); errHttp.corroborationErrorCode = 'network'; return reject(errHttp); }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.on('timeout', function () { var errT = new Error('timeout'); errT.corroborationErrorCode = 'timeout'; req.destroy(errT); });
    req.on('error', function (e) {
      if (e && (e.code === 'ABORT_ERR' || e.name === 'AbortError') && !e.corroborationErrorCode) e.corroborationErrorCode = 'timeout';
      if (!e.corroborationErrorCode) e.corroborationErrorCode = 'network';
      reject(e);
    });
  });
}

// Google News RSS suele traer el título como "Titular real - Medio" --
// se saca ese sufijo SOLO para guardar un titular más legible (nunca
// cambia qué URL se guarda ni el cálculo de coincidencia, que ya tolera
// texto extra). Solo se corta si lo que sigue al último " - " tiene 4
// palabras o menos, para no cortar por error un titular real que
// casualmente contiene un guión largo.
function stripGoogleNewsSourceSuffix(title) {
  var m = String(title || '').match(/^(.*)\s+-\s+([^-]{1,60})$/);
  if (m && m[2].trim().split(/\s+/).length <= 4) return m[1].trim();
  return title;
}

// Capa 2 de la corroboración (requisito 2/14): UNA sola consulta a Google
// News RSS por candidato, sobre como mucho MAX_GOOGLE_NEWS_RESULTS_TO_CHECK
// resultados, cortando en el primero que de verdad pasa TODOS los
// controles (accesible/SSRF-seguro, dominio independiente, no excluido,
// y computeCorroborationMatch real) -- nunca se sigue buscando después de
// encontrar uno válido, y nunca se inventa nada si no aparece ninguno.
//
// Devuelve SIEMPRE un objeto (nunca null, nunca lanza -- requisito 6):
//   { source: {...} | null, failed: boolean, reason: string|null, diagnostic: {...} }
// `source` es la fuente encontrada, o null si no había ninguna válida.
// `failed` distingue "se buscó bien, de verdad no hay corroboración"
// (failed:false) de "la búsqueda en sí no se pudo completar" (failed:true,
// con `reason`: 'timeout'/'network'/'rate-limited'/'parse-error') -- esa
// distinción es la que deja mostrar un mensaje breve y comprensible en vez
// de un genérico "no se encontró nada" cuando en realidad el buscador no
// respondió (requisito 6). En AMBOS casos el resultado para el candidato
// es idéntico (sigue en "Requiere revisión", nunca se bloquea el panel,
// nunca se inventa una fuente) -- la distinción es solo para el mensaje.
//
// `diagnostic` (pedido de Leonardo, 2026-09-21, a raíz de la prueba manual
// en Windows donde casi todas las tarjetas mostraban "descartada por mismo
// dominio"): un resumen breve y NUNCA sensible de qué pasó en esta consulta
// puntual a Google News -- solo conteos y nombres de dominio, nunca URLs ni
// texto de terceros -- para poder diagnosticar sin adivinar si Google News
// devolvió resultados del mismo medio, si el resolvedor no llegó al dominio
// final, o si de verdad no hubo ningún resultado.
function emptyCorroborationDiagnostic() {
  return {
    // null = no se llegó a consultar/contar (falló antes de tener resultados
    // de Google News); 0+ = cantidad de resultados de Google News evaluados.
    googleNewsResults: null,
    domainsEvaluated: [], // nombres de dominio únicos alcanzados, nunca URLs
    discardedSameDomain: 0, // mismo dominio/grupo editorial que la fuente original
    discardedExcluded: 0, // agregador/comunicado/red social (EXCLUDED_CORROBORATION_DOMAINS)
    discardedUnresolved: 0, // inaccesible o sin URL final resuelta (requisito 7)
    discardedNoMatch: 0 // no pasó computeCorroborationMatch (contenido/entidad/fecha)
  };
}
// Red de seguridad de última instancia: además de la cancelación REAL que
// ya recibe cada petición de red de adentro (el AbortSignal del deadline,
// ver más abajo), esto acota el tiempo total de espera aunque alguna capa
// no llegue a respetar esa señal (por ejemplo, un reemplazo de prueba de
// fetchGoogleNewsRss que devuelve una promesa que nunca se resuelve ni se
// rechaza -- ver test-source-corroboration.js 2.7). A diferencia del
// Promise.race de antes (que era la ÚNICA protección y dejaba la petición
// real corriendo en segundo plano si "perdía" la carrera, el problema
// exacto que señaló Leonardo el 2026-09-24), acá la petición real YA se
// cancela de verdad antes de llegar a este backstop -- en operación normal
// jamás es este timer el que "gana", gana la propia promesa apenas su
// petición se aborta. Si de todas formas gana el timer (la promesa de
// adentro sigue sola en segundo plano, caso patológico de mock sin señal),
// no tiene ningún efecto observable: nada queda encadenado a su resultado.
function raceWithBackstop(promise, ms) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve({ source: null, failed: true, reason: 'timeout', diagnostic: emptyCorroborationDiagnostic() });
    }, ms);
    promise.then(function (v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }, function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ source: null, failed: true, reason: 'network', diagnostic: emptyCorroborationDiagnostic() });
    });
  });
}
// `deadline` (opcional -- deadline COMPARTIDO de toda la FASE 1, pasado
// por buildCandidates()): se crea un sub-plazo propio de ESTA búsqueda
// puntual (GOOGLE_NEWS_OVERALL_TIMEOUT_MS, para que un solo candidato lento
// no agote todo el presupuesto de los demás) que además nunca excede lo
// que le queda al deadline compartido (feeds.makeChildDeadline) -- ese
// sub-plazo se pasa como AbortSignal real a CADA petición de red de
// adentro (fetchGoogleNewsRss/resolveSourceUrl), así que al cumplirse la
// conexión en curso se cancela DE VERDAD, nunca sigue corriendo sola en
// segundo plano (el problema que Leonardo pidió corregir el 2026-09-24).
// Sin `deadline`, se comporta igual que antes (mismo tope de 15s, ahora
// con cancelación real en vez de solo dejar de esperar).
async function searchGoogleNewsForCorroboration(item, excludeDomain, deadline) {
  var searchDeadline = feeds.makeChildDeadline(deadline, GOOGLE_NEWS_OVERALL_TIMEOUT_MS);
  var budgetMs = searchDeadline.remaining();
  try {
    if (budgetMs <= 0) {
      return { source: null, failed: true, reason: 'timeout', diagnostic: emptyCorroborationDiagnostic() };
    }
    return await raceWithBackstop(searchGoogleNewsForCorroborationInner(item, excludeDomain, searchDeadline), budgetMs);
  } finally {
    searchDeadline.clear();
  }
}
async function searchGoogleNewsForCorroborationInner(item, excludeDomain, deadline) {
  var diag = emptyCorroborationDiagnostic();
  var entities = extractMainEntities(item.title);
  var query = entities.length ? entities[0] : (item.title || '').split(/\s+/).slice(0, 6).join(' ');
  if (!query) return { source: null, failed: false, reason: null, diagnostic: diag };
  var xml;
  try {
    xml = await module.exports.fetchGoogleNewsRss(query, deadline);
  } catch (e) {
    // Sin red/timeout/límite de tasa/error HTTP -- nunca inventa una
    // fuente, el candidato sigue como "Requiere revisión" (requisito 6).
    return { source: null, failed: true, reason: (e && e.corroborationErrorCode) || 'network', diagnostic: diag };
  }
  var results;
  try { results = feeds.parseFeedItems(xml).slice(0, MAX_GOOGLE_NEWS_RESULTS_TO_CHECK); } catch (e) {
    return { source: null, failed: true, reason: 'parse-error', diagnostic: diag }; // requisito 6: HTML/XML inesperado
  }
  diag.googleNewsResults = results.length;
  var domainsSeen = new Set();
  for (var i = 0; i < results.length; i++) {
    if (deadline && deadline.expired()) break; // no arranca ninguna resolución nueva tras el plazo
    var r = results[i];
    var resolved;
    try { resolved = await module.exports.resolveSourceUrl(r.link, undefined, deadline); } catch (e) { diag.discardedUnresolved++; continue; }
    if (!resolved || resolved.reachable === false) { diag.discardedUnresolved++; continue; } // requisito 7: inaccesible -> nunca cuenta
    if (!resolved.finalUrl) { diag.discardedUnresolved++; continue; } // defensivo: sin URL final resuelta, nunca se usa el link de Google tal cual
    var finalUrl = feeds.canonicalizeUrl(resolved.finalUrl); // requisito 8: SIEMPRE la URL final, nunca r.link
    var domain = feeds.domainFromUrl(finalUrl);
    if (!domain) { diag.discardedUnresolved++; continue; }
    domainsSeen.add(domain);
    // Requisito 7 (explícito, además de la exclusión general de abajo):
    // un enlace de news.google.com jamás se guarda como fuente adicional,
    // ni siquiera si por algún motivo resolveSourceUrl no pudo seguir la
    // redirección hasta el medio real -- se descarta ese resultado entero.
    if (domain === GOOGLE_NEWS_HOST || EXCLUDED_CORROBORATION_DOMAINS.has(domain)) { diag.discardedExcluded++; continue; } // requisito 13
    if (!isIndependentSource(excludeDomain, domain)) { diag.discardedSameDomain++; continue; } // requisitos 3-4
    var cleanTitle = stripGoogleNewsSourceSuffix(r.title);
    var match = computeCorroborationMatch(item, { title: cleanTitle, summary: r.summary, pubDateISO: r.pubDateISO });
    if (!match.isMatch) { diag.discardedNoMatch++; continue; } // requisitos 5-6
    diag.domainsEvaluated = Array.from(domainsSeen);
    return {
      source: {
        // Requisito 8: el nombre de medio mostrado sale del DOMINIO FINAL
        // real (mismo mapeo que ya usa todo el resto del archivo), nunca
        // del texto "<source>"/sufijo de título que trae Google News --
        // cleanTitle solo aporta el titular legible, jamás el nombre del medio.
        url: finalUrl, domain: domain, outlet: feeds.outletNameFromDomain(domain),
        headline: cleanTitle, publishedAt: r.pubDateISO || null,
        matchScore: match.score, matchReasons: match.reasons
      },
      failed: false, reason: null, diagnostic: diag
    };
  }
  diag.domainsEvaluated = Array.from(domainsSeen);
  return { source: null, failed: false, reason: null, diagnostic: diag }; // se buscó bien, de verdad no hay corroboración
}

// Campo persistido "sameDomainMatchWarning" (renombrado 2026-09-21, pedido
// de Leonardo -- antes "corroborationRejectedSameDomain", un nombre interno
// poco legible que además quedaba "pegado" para siempre una vez marcado en
// true). Contrato completo, documentado acá una sola vez para que
// addCorroboration/findCorroborationForItem/findAdditionalSourceForDraft/
// classifyDraft y admin.js compartan exactamente el mismo significado:
//
//   true  = en la ÚLTIMA corrida de capa 1 (los otros feeds configurados
//           del sitio) hubo un candidato de contenido parecido (vocabulario
//           compartido >= 40 pts) que hubo que descartar por NO ser de un
//           dominio/grupo editorial independiente de la fuente principal.
//           Es una ADVERTENCIA de que "puede haber" la misma noticia en
//           otro medio del mismo dueño -- nunca una segunda fuente real.
//   false = en la ÚLTIMA corrida no hubo ningún candidato así.
//
// Reglas que hay que respetar en cualquier lugar que toque este campo:
//   1-2. Se RECALCULA POR COMPLETO en cada corrida de capa 1 (automática al
//        crear el borrador, o manual vía "Buscar segunda fuente") y
//        reemplaza el valor anterior -- nunca se acumula ni queda pegado en
//        true para siempre una vez que la corrida actual da false.
//   3. Es una señal DISTINTA de una corroboración real: un borrador con
//      additionalSources.length > 0 nunca debería mostrar este aviso a la
//      vez (admin.js ya prioriza "Corroborada por N medios independientes"
//      cuando hay fuente real, y solo muestra este aviso en el else).
//   4. NUNCA participa de computeEditorialReadiness() -- ni suma ni resta
//      puntaje, a diferencia de additionalSources (+20) o singleSourceWarning
//      (-20). Es pura información para la revisión humana.
function emptySameDomainMatchWarningState() { return false; }

// Orquesta las 2 capas para UN candidato puntual -- la usa el botón
// manual "Buscar segunda fuente" de server.js (findAdditionalSourceForDraft,
// más abajo), SIN pool (trae los feeds de nuevo, porque puede haber
// pasado tiempo desde la corrida original que generó el borrador).
// buildCandidates() no la llama a esta (ya tiene su propio recorrido de
// `fetched.items` en addCorroboration para no pedir los feeds dos veces
// en la misma corrida) pero usa exactamente las mismas funciones de
// abajo (isIndependentSource/computeCorroborationMatch/
// searchGoogleNewsForCorroboration) -- un solo criterio, nunca dos.
async function findCorroborationForItem(item) {
  var pool = [];
  try {
    var fetched = await feeds.fetchAllFeedItems();
    pool = fetched.items;
  } catch (e) {
    pool = [];
  }
  var sameDomainMatchWarning = emptySameDomainMatchWarningState();
  for (var i = 0; i < pool.length; i++) {
    var other = pool[i];
    if (!other || other.link === item.link) continue;
    var otherDomain = other.domain || feeds.domainFromUrl(other.link);
    if (EXCLUDED_CORROBORATION_DOMAINS.has(otherDomain) || !isIndependentSource(item.domain, otherDomain)) {
      var rough = computeCorroborationMatch(item, other);
      if (rough.score >= 40) sameDomainMatchWarning = true;
      continue;
    }
    var match = computeCorroborationMatch(item, other);
    if (match.isMatch) {
      return {
        source: {
          url: other.link, domain: otherDomain, outlet: other.outlet || feeds.outletNameFromDomain(otherDomain),
          headline: other.title || '', publishedAt: other.pubDateISO || null,
          matchScore: match.score, matchReasons: match.reasons
        },
        sameDomainMatchWarning: sameDomainMatchWarning,
        searchFailed: false,
        searchFailedReason: null,
        // La capa 2 (Google News) nunca se llegó a consultar -- la capa 1
        // ya alcanzó, así que no hay diagnóstico de Google News que mostrar.
        searchDiagnostic: null
      };
    }
  }
  // Capa 2: Google News RSS, solo si la capa 1 no encontró nada (requisito 14).
  // searchGoogleNewsForCorroboration ya NUNCA rechaza su promesa (siempre
  // devuelve {source, failed, reason, diagnostic}, incluso ante
  // timeout/red/parseo) -- no hace falta try/catch. `failed`/`reason`/
  // `diagnostic` se propagan tal cual para que el llamador
  // (findAdditionalSourceForDraft) pueda mostrar un mensaje breve y
  // comprensible, y un diagnóstico detallado (pedido de Leonardo,
  // 2026-09-21), sin nunca bloquear el panel ni inventar una fuente
  // (requisito 6): el resultado para el candidato es el mismo en los dos
  // casos (source:null, sigue en "Requiere revisión"), solo cambia el motivo.
  var fallback = await module.exports.searchGoogleNewsForCorroboration(item, item.domain);
  return {
    source: fallback.source,
    sameDomainMatchWarning: sameDomainMatchWarning,
    searchFailed: !!fallback.failed,
    searchFailedReason: fallback.reason || null,
    searchDiagnostic: fallback.diagnostic || emptyCorroborationDiagnostic()
  };
}

// Requisito 16 (botón manual "Buscar segunda fuente"): busca corroboración
// para UN borrador YA guardado, bajo demanda, sin regenerar el borrador
// entero ni volver a redactar con IA. Usa la MISMA lógica que la corrida
// automática (findCorroborationForItem/computeCorroborationMatch) --
// nunca un criterio más laxo por ser manual. Si no encuentra nada, el
// borrador queda EXACTAMENTE igual (requisito 12: nunca inventar una
// fuente) y se devuelve found:false.
async function findAdditionalSourceForDraft(slug) {
  var drafts = readJSON(DRAFTS_FILE, []);
  var idx = drafts.findIndex(function (d) { return d.slug === slug; });
  if (idx === -1) return { ok: false, error: 'No existe ese borrador' };
  var d = drafts[idx];
  if (Array.isArray(d.additionalSources) && d.additionalSources.length > 0) {
    return { ok: true, found: false, alreadyHadSource: true, draft: d };
  }
  var item = {
    title: d.sourceHeadline || d.title, summary: d.dek || '', link: d.sourceUrl,
    domain: d.sourceDomain || feeds.domainFromUrl(d.sourceUrl || ''),
    outlet: d.sourceTitle || '', pubDateISO: d.sourcePublishedAt || null
  };
  var result = await module.exports.findCorroborationForItem(item);
  // Requisitos 1-2 (pedido de Leonardo, 2026-09-21): se RECALCULA por
  // completo en cada corrida y reemplaza el valor anterior -- antes acá
  // decía `if (result.rejectedSameDomain) d.corroborationRejectedSameDomain
  // = true`, que solo podía prender el aviso y nunca apagarlo, así que un
  // borrador marcado una vez lo quedaba mostrando para siempre aunque una
  // búsqueda posterior ya no encontrara ningún candidato del mismo dominio.
  // Ver el contrato completo del campo justo antes de findCorroborationForItem.
  d.sameDomainMatchWarning = !!result.sameDomainMatchWarning;
  // Diagnóstico de la búsqueda en Google News (pedido de Leonardo,
  // 2026-09-21, a raíz de la prueba manual en Windows): se guarda SIEMPRE
  // que la capa 2 haya corrido (searchDiagnostic no es null), tanto si
  // encontró una fuente como si no, para poder ver en la ficha qué pasó en
  // la ÚLTIMA corrida -- nunca URLs, nunca texto de terceros, solo conteos
  // y nombres de dominio (ver emptyCorroborationDiagnostic). Si la capa 1
  // ya alcanzó (searchDiagnostic:null porque Google News nunca se llegó a
  // consultar), se borra cualquier diagnóstico viejo para no mostrar un
  // dato de una corrida anterior como si fuera el de ahora.
  d.corroborationDiagnostic = result.searchDiagnostic || null;
  d.corroborationSearchFailed = !!result.searchFailed;
  d.corroborationSearchFailedReason = result.searchFailedReason || null;
  d.corroborationDiagnosticAt = new Date().toISOString();
  if (!result.source) {
    drafts[idx] = d;
    writeJSON(DRAFTS_FILE, drafts);
    // Requisito 6: si la búsqueda de la capa 2 no se pudo completar
    // (timeout/red/límite de tasa/parseo), lo distinguimos de "se buscó
    // bien y de verdad no hay corroboración" para que server.js/admin.js
    // puedan mostrar un mensaje breve y comprensible en vez de un genérico
    // "no se encontró ninguna fuente" -- el borrador queda igual en ambos
    // casos (nunca se inventa una fuente, nunca se bloquea el panel).
    return {
      ok: true, found: false, draft: d,
      searchFailed: !!result.searchFailed,
      searchFailedReason: result.searchFailedReason || null,
      searchDiagnostic: d.corroborationDiagnostic
    };
  }
  var c = result.source;
  d.additionalSources = (d.additionalSources || []).concat([{
    url: c.url, label: c.outlet || c.domain || null, headline: c.headline || null,
    domain: c.domain || null, publishedAt: c.publishedAt || null,
    retrievedAt: new Date().toISOString(),
    matchScore: typeof c.matchScore === 'number' ? c.matchScore : null,
    matchReasons: Array.isArray(c.matchReasons) ? c.matchReasons : []
  }]);
  d.singleSourceWarning = false;
  drafts[idx] = d;
  writeJSON(DRAFTS_FILE, drafts);
  return { ok: true, found: true, draft: d };
}

// Botón manual "Generar imagen" (pedido de Leonardo, 2026-09-27, punto 4):
// desde que la imagen automática pasó a depender de que el borrador quede
// "listo" (ver el reordenamiento en runFetchNewDrafts más arriba), un
// borrador que se queda en "revisar" -- o que lo estaba y después mejoró
// (ej. se le encontró una segunda fuente) -- nunca vuelve a generar imagen
// sola. Esta función es la ÚNICA forma de completarla desde ahí en
// adelante: UNA sola llamada real a imageGen.generateCoverImage() por clic,
// nunca un reintento automático si falla (igual criterio que
// draft.draftArticle() en runFetchNewDrafts -- un fallo se informa, nunca
// se reintenta solo). Si el borrador ya tenía una imagen, no gasta una
// llamada nueva -- se informa `alreadyHadImage: true` (mismo patrón que
// `alreadyHadSource` en findAdditionalSourceForDraft de arriba).
async function generateDraftImageManually(slug, cfg) {
  var drafts = readJSON(DRAFTS_FILE, []);
  var idx = drafts.findIndex(function (d) { return d.slug === slug; });
  if (idx === -1) return { ok: false, error: 'No existe ese borrador' };
  var d = drafts[idx];
  if (d.image) {
    return { ok: true, generated: false, alreadyHadImage: true, draft: d };
  }
  var cat = pagegen.categoryBySlug(d.category);
  try {
    var generated = await imageGen.generateCoverImage({ title: d.title, categoryLabel: (cat && cat.label) || d.categoryLabel || '', slug: d.slug }, cfg || draft.loadConfig(), null);
    if (!generated) {
      return { ok: true, generated: false, error: 'La generación no devolvió ninguna imagen.', draft: d };
    }
    d.image = generated.path;
    d.imageLicense = 'ai-generated-commercial-use';
    d.imageOrigin = 'ai-generated';
    d.imageTool = generated.tool;
    d.imageModel = generated.model;
    d.imageGeneratedAt = generated.generatedAt;
    d.imagePrompt = generated.prompt;
    d.imageHumanEdited = false;
    d.imageOwnerAttestation = true;
    d.imageSourceUrl = null;
    d.imageSource = '';
    if (d.editorialMeta) {
      d.editorialMeta.imageProvenance = {
        origin: d.imageOrigin, license: d.imageLicense, tool: d.imageTool,
        model: d.imageModel, generatedAt: d.imageGeneratedAt, sourceUrl: d.imageSourceUrl
      };
    }
    drafts[idx] = d;
    writeJSON(DRAFTS_FILE, drafts);
    return { ok: true, generated: true, draft: d };
  } catch (e) {
    // Nunca rompe el borrador ni reintenta solo -- se informa el error tal
    // cual para que el panel muestre un aviso legible (pedido 2026-09-27,
    // punto 7: "si la llamada manual falla -> aviso legible, sin reintento
    // y sin romper el borrador").
    return { ok: true, generated: false, error: e.message, draft: d };
  }
}

// ============================================================================
// Descubrimiento por Google Trends (Estados Unidos) -- pedido de Leonardo,
// 2026-09-25, "descubrimiento de tendencias de Estados Unidos y
// reorganización de categorías". Ver admin/google-trends.js para el
// cliente HTTP/parser del feed en sí -- acá vive TODA la lógica editorial
// (clasificación sin IA, corroboración, selección) para que quede junto a
// la misma lógica ya existente para RSS, con un solo criterio para cada
// paso (nunca dos varas distintas según de dónde salió el candidato).

// Clasificador de tendencias SIN IA (punto 3, paso 1 del pedido): se
// evalúa contra un texto combinado -- la consulta de la tendencia MÁS los
// titulares/resúmenes de la cobertura real que Google Trends ya agrupó
// (ht:news_item, ver trendClassificationText más abajo) -- porque la
// consulta sola ("emmys 2026", "georgia vs northern ireland") casi
// siempre tiene muy poca señal propia para clasificar; la cobertura
// periodística real que la acompaña sí la tiene. Reglas deliberadamente
// simples (palabras clave/entidades, nunca IA) -- mismo espíritu que el
// resto de los filtros previos a la IA de este archivo
// (detectCommercialDeal/detectPromotionalLanguage/etc.).
//
// Orden de evaluación (importa, requisito de pruebas del pedido): "ai"
// antes que "technology" (para que "OpenAI"/"ChatGPT" no caigan en la
// categoría genérica de tecnología), "gaming" antes que "entertainment"
// (para que una noticia de la industria de videojuegos no se confunda con
// cine/streaming/anime), y "technology" al final, como categoría más
// amplia -- ahí se integra editorialmente Science & Space (pedido
// 2026-09-25, ver data/categories.json: la categoría "science" sigue
// existiendo con sus URLs viejas, solo se retira del menú principal y no
// recibe contenido nuevo). "Play Games" (la sección de juegos propios del
// sitio) NUNCA participa acá -- no es una categoría de noticias, así que
// no tiene ninguna regla ni puede confundirse con "gaming" (cobertura de
// la industria de videojuegos). Una tendencia que no coincide con ninguna
// regla se descarta (null) -- nunca se le asigna una categoría "a la
// fuerza", ni "trending" (Trending sigue siendo una selección/etiqueta,
// nunca una categoría que la IA pueda elegir, ver listCategories()).
var TREND_CATEGORY_RULES = [
  ['ai', /\b(ai|chatgpt|open ?ai|gpt-?\d|claude ai|google gemini|microsoft copilot|large language model|generative ai|anthropic|deepmind|midjourney|stable diffusion|perplexity ai|ai model|ai chatbot|ai startup)\b/i],
  ['gaming', /\b(video games?|videogame|playstation|ps5|ps4|xbox|nintendo switch|nintendo|steam deck|esports|e-sports|twitch streamer|game awards|fortnite|minecraft|call of duty|grand theft auto|gta|league of legends|valorant|overwatch|legend of zelda|pokemon|pok[ée]mon|final fantasy|elden ring|game pass|epic games|ubisoft|activision blizzard|rockstar games|square enix|capcom|sega|video game release|gamer)\b/i],
  ['entertainment', /\b(movie|film premiere|box office|movie trailer|netflix|disney\+|disney plus|hbo max|max streaming|prime video|hulu|peacock|paramount\+|apple tv\+|crunchyroll|hidive|anime|manga|tv series|tv show|season finale|renewed for season|red carpet|academy awards|oscars|emmy|golden globes|sequel|film franchise|celebrity|actor|actress)\b/i],
  ['sports', /\b(nfl|nba|mlb|nhl|world cup|soccer|football|super bowl|olympics|formula 1|f1 grand prix|ufc|wwe|tennis open|golf tournament|world series|champions league|premier league|playoffs|head coach|athlete|boxing|olympic)\b/i],
  ['business', /\b(stock market|nasdaq|dow jones|s&p 500|ipo|earnings report|merger|acquisition|ceo|layoffs|startup funding|venture capital|inflation|federal reserve|interest rates?|cryptocurrency|bitcoin|tariffs?|trade deal|bankruptcy|shares surge|shares plunge|quarterly earnings)\b/i],
  ['technology', /\b(smartphone|iphone|android|app update|software update|gadget|nasa|spacex|satellite|rocket launch|astronaut|mars|moon landing|telescope|scientists discover|research study|climate science|physics|medical breakthrough|vaccine|robot|electric vehicle|self-driving|semiconductor|processor|5g|data breach|hacked|cyberattack)\b/i]
];
function trendClassificationText(trend) {
  var parts = [trend.query || ''];
  (trend.newsItems || []).forEach(function (n) {
    parts.push(n.title || '');
    parts.push(n.snippet || '');
  });
  return parts.join(' ');
}
function classifyTrendCategory(text) {
  var t = String(text || '');
  for (var i = 0; i < TREND_CATEGORY_RULES.length; i++) {
    if (TREND_CATEGORY_RULES[i][1].test(t)) return TREND_CATEGORY_RULES[i][0];
  }
  return null;
}

// Nunca se guarda Google Trends/Google News como fuente periodística de un
// artículo (requisito explícito del pedido) -- defensivo, por si algún día
// un ht:news_item viniera apuntando al propio Google (nunca debería, ver
// admin/google-trends.js, pero mejor no confiar solo en eso).
var TRENDS_OWN_DOMAINS = new Set(['trends.google.com', 'google.com']);

// Cobertura real ya agrupada por Google Trends para una tendencia (ver
// admin/google-trends.js: hasta 3 ht:news_item, ya resueltos a su dominio
// final, cada uno un artículo real de un medio real -- nunca un link a
// trends.google.com). Se descartan acá los que caigan en
// TRENDS_OWN_DOMAINS o en la lista de agregadores/comunicados/redes
// sociales que YA excluye TODA corroboración del sitio
// (EXCLUDED_CORROBORATION_DOMAINS, la misma de siempre -- un solo
// criterio) y se deduplica por dominio (si Google agrupó dos veces el
// mismo medio, cuenta una sola vez).
function usableTrendNewsItems(trend) {
  var seenDomains = new Set();
  var out = [];
  (trend.newsItems || []).forEach(function (n) {
    if (!n || !n.domain || !n.url || !n.title) return;
    if (TRENDS_OWN_DOMAINS.has(n.domain) || EXCLUDED_CORROBORATION_DOMAINS.has(n.domain)) return;
    if (seenDomains.has(n.domain)) return;
    seenDomains.add(n.domain);
    out.push(n);
  });
  return out;
}

// Corroboración de una tendencia (punto 1 del pedido: "por cada tendencia
// compatible, buscar cobertura en medios reales... exigir dos fuentes
// periodísticas independientes antes de llamar a la IA"). Reutiliza TODA
// la infraestructura de corroboración que ya existe para RSS
// (isIndependentSource, computeCorroborationMatch,
// searchGoogleNewsForCorroboration) -- un solo criterio de "¿esto es de
// verdad la misma noticia, de un medio de verdad independiente?", nunca
// dos varas distintas según de dónde salió el candidato.
//
// Diseño deliberadamente conservador: en el caso común, los hasta 3
// artículos reales que Google Trends ya agrupó (usable, ver arriba)
// alcanzan solos para las dos fuentes exigidas, sin gastar ninguna
// búsqueda adicional -- se recorren buscando pares mutuamente
// independientes que de verdad hablen del mismo hecho
// (computeCorroborationMatch, mismo umbral que el resto del archivo).
// Solo cuando eso NO alcanza (0 o 1 fuente utilizable en el paquete de
// Google, o ninguna pasó el chequeo de "misma noticia") se gasta, como
// mucho, UNA búsqueda de Google News de respaldo (la MISMA función que
// usa el flujo RSS) para intentar encontrar una segunda fuente real --
// nunca se arma una búsqueda "desde cero" con varias consultas para una
// tendencia (a diferencia de una fuente RSS sin corroboración de capa 1,
// que siempre intenta la capa 2): es intencional, para no duplicar por
// completo la implementación de "juntar 2 fuentes de cero" solo para el
// caso, ya poco común, de que Google Trends no haya agrupado ninguna
// cobertura real utilizable. `canSearch` (booleano): falso cuando ya se
// agotó el cupo de búsquedas activas de esta corrida
// (maxCorroborationSearches) o el plazo compartido -- en ese caso la
// tendencia sigue con lo que ya tenía del paquete de Trends, nunca inventa
// nada ni bloquea el resto de la corrida.
async function corroborateTrend(trend, usable, primary, deadlineObj, canSearch) {
  var corroboration = [];
  var primaryForMatch = { title: primary.title, summary: primary.snippet || '', pubDateISO: trend.pubDateISO || null };
  for (var i = 0; i < usable.length && corroboration.length < 3; i++) {
    var other = usable[i];
    if (other === primary) continue;
    if (!isIndependentSource(primary.domain, other.domain)) continue;
    if (corroboration.some(function (c) { return c.domain === other.domain; })) continue;
    var otherForMatch = { title: other.title, summary: other.snippet || '', pubDateISO: trend.pubDateISO || null };
    var match = computeCorroborationMatch(primaryForMatch, otherForMatch);
    if (!match.isMatch) continue;
    corroboration.push({
      url: other.url, domain: other.domain, outlet: other.outlet || '',
      headline: other.title || '', publishedAt: trend.pubDateISO || null,
      retrievedAt: new Date().toISOString(), matchScore: match.score, matchReasons: match.reasons
    });
  }
  if (corroboration.length > 0 || !canSearch || (deadlineObj && deadlineObj.expired())) {
    return { corroboration: corroboration, usedSearch: false, searchFailed: false, searchFailedReason: null };
  }
  // searchGoogleNewsForCorroboration nunca lanza (ver su comentario) --
  // siempre devuelve {source, failed, reason, diagnostic}.
  var searchOutcome = await module.exports.searchGoogleNewsForCorroboration(primaryForMatch, primary.domain, deadlineObj);
  var found = searchOutcome && searchOutcome.source;
  if (found) {
    corroboration.push({
      url: found.url, domain: found.domain, outlet: found.outlet,
      headline: found.headline, publishedAt: found.publishedAt,
      retrievedAt: new Date().toISOString(), matchScore: found.matchScore, matchReasons: found.matchReasons
    });
  }
  return {
    corroboration: corroboration, usedSearch: true,
    searchFailed: !!(searchOutcome && searchOutcome.failed), searchFailedReason: (searchOutcome && searchOutcome.reason) || null
  };
}

// Orden de los candidatos de Trends antes de elegir a cuáles de ellos les
// toca una de las (como mucho maxAIDrafts) redacciones de esta corrida
// (punto 3, paso 5 del pedido: "puntuar interés estimado utilizando,
// cuando Google Trends lo suministre: volumen o crecimiento de búsqueda;
// actualidad; cantidad de medios que cubren el tema..."). A propósito NO
// reutiliza compareCandidatesForDrafting() (la del flujo RSS, más arriba):
// esa ordena por sourceCount (cuántos FEEDS DISTINTOS del sitio cubren la
// misma historia AHORA MISMO), una señal que no existe para un candidato
// de Trends (cada tendencia produce un único candidato, nunca varios
// feeds del sitio compitiendo por la misma historia); acá, en cambio, sí
// hay una señal de volumen real y propia de Google Trends
// (approxTraffic, ver admin/google-trends.js) que el pedido pide usar
// EXPLÍCITAMENTE "cuando Google Trends lo suministre" -- nunca se inventa
// un número si no vino (ver parseApproxTraffic: null cuando falta, nunca
// 0 a propósito). Ambos flujos (Trends y su respaldo RSS) nunca compiten
// entre sí en la misma corrida -- buildCandidatesFromTrends() y
// buildCandidates() son mutuamente excluyentes por corrida (ver
// runFetchNewDrafts) -- así que no hace falta que las dos fórmulas de
// orden sean compatibles entre sí.
function trendCandidatePriorityKey(item) {
  var independentSourceCount = 1 + ((item.corroboration && item.corroboration.length) || 0);
  var pubTime = item.pubDateISO ? Date.parse(item.pubDateISO) : NaN;
  var recency = isNaN(pubTime) ? 0 : pubTime;
  var approxTraffic = typeof item.approxTraffic === 'number' ? item.approxTraffic : 0;
  var riskText = (item.title || '') + ' ' + (item.summary || '');
  var risk = RUMOR_LANGUAGE_TERMS.test(riskText) ? 1 : 0; // 0 = menor riesgo
  return { independentSourceCount: independentSourceCount, approxTraffic: approxTraffic, recency: recency, risk: risk };
}
function compareTrendCandidatesForDrafting(a, b) {
  var ka = trendCandidatePriorityKey(a), kb = trendCandidatePriorityKey(b);
  if (kb.independentSourceCount !== ka.independentSourceCount) return kb.independentSourceCount - ka.independentSourceCount;
  if (kb.approxTraffic !== ka.approxTraffic) return kb.approxTraffic - ka.approxTraffic;
  if (kb.recency !== ka.recency) return kb.recency - ka.recency;
  return ka.risk - kb.risk;
}

// Diversidad de medios (punto 1 del pedido: "no depender exclusivamente de
// TechCrunch ni permitir que un solo medio monopolice los resultados") --
// se aplica genéricamente a los aprobados de CUALQUIER corrida (Trends o
// su respaldo RSS, "manteniendo... los mismos requisitos" pide el pedido
// para el caso de fallback), ya ordenados por prioridad
// (compareTrendCandidatesForDrafting o compareCandidatesForDrafting según
// corresponda). Recorre esa lista y elige hasta `limit`, pero un
// candidato cuyo dominio primario (item.domain) ya está representado
// entre los elegidos se POSTERGA (nunca se descarta) para una segunda
// pasada -- que solo se usa si de verdad hiciera falta repetir dominio
// para completar el cupo, nunca se deja el cupo sin llenar solo por
// diversidad si no hay más candidatos de otros dominios disponibles.
function pickDiverseTopCandidates(sortedApproved, limit) {
  var picked = [];
  var usedDomains = new Set();
  var deferred = [];
  for (var i = 0; i < sortedApproved.length && picked.length < limit; i++) {
    var item = sortedApproved[i];
    var domain = item.domain || '';
    if (domain && usedDomains.has(domain)) { deferred.push(item); continue; }
    picked.push(item);
    if (domain) usedDomains.add(domain);
  }
  for (var j = 0; j < deferred.length && picked.length < limit; j++) {
    picked.push(deferred[j]);
  }
  return picked;
}

// Descubrimiento por Google Trends propiamente dicho -- devuelve EXACTAMENTE
// la misma forma que buildCandidates() (candidates, errors, skipped,
// takenSlugs, filteredCounts, headlinesExamined,
// corroborationSearchesPerformed, singleSourceCandidates, timedOut,
// limits) más algunos campos propios de Trends (trendsExamined,
// trendsCategoryMatched, source, technicalFailure/failureReason) -- así
// runFetchNewDrafts() necesita el mínimo de ramas nuevas para tratar un
// candidato de Trends exactamente igual que uno de RSS de acá en adelante
// (gate de corroboración, redacción, clasificación de riesgo, todo
// reutilizado sin cambios).
//
// `technicalFailure: true` es la ÚNICA condición bajo la que
// runFetchNewDrafts() cae al RSS de respaldo (requisito: "si Google
// Trends falla, usar los RSS configurados como fallback") -- una corrida
// donde Trends respondió bien pero ninguna tendencia coincidió con las
// categorías activas, o ninguna llegó a corroborarse, NO es un fallo
// técnico (es un resultado válido y esperado: no todos los días hay 3
// temas de EE.UU. virales y corroborables en las 6 categorías del sitio)
// -- en ese caso candidates queda vacío pero technicalFailure es false, y
// NUNCA se cae al RSS solo por eso (evita gastar el doble de tiempo/red
// en cada corrida sin motivo real).
async function buildCandidatesFromTrends(cfg, externalDeadline) {
  var limits = getPipelineLimits(cfg);
  // externalDeadline (2026-09-27, "timeout verdaderamente global"): ver el
  // comentario equivalente en buildCandidates() más arriba -- mismo
  // mecanismo, mismo motivo. runFetchNewDrafts() siempre pasa acá el
  // deadline que crea al arrancar la corrida; sin eso (llamada directa,
  // ej. pruebas), esta función sigue creando y cerrando el suyo propio.
  var ownsDeadline = !externalDeadline;
  var deadlineObj = externalDeadline || feeds.makeDeadline(limits.preselectionTimeoutMs);
  var timedOut = false;

  var trendsRace = await raceAgainstDeadline(googleTrends.fetchTrendingNow(deadlineObj), deadlineObj);
  if (trendsRace.timedOut) {
    if (ownsDeadline) deadlineObj.clear();
    return { technicalFailure: true, failureReason: 'timeout', timedOut: true, limits: limits, source: 'google-trends', trendsExamined: 0, trendsCategoryMatched: 0 };
  }
  if (trendsRace.error) {
    if (ownsDeadline) deadlineObj.clear();
    return {
      technicalFailure: true,
      failureReason: (trendsRace.error && trendsRace.error.trendsErrorCode) || 'network',
      timedOut: false, limits: limits, source: 'google-trends', trendsExamined: 0, trendsCategoryMatched: 0
    };
  }
  var trends = trendsRace.value || [];

  var drafts = readJSON(DRAFTS_FILE, []);
  var discarded = readJSON(DISCARDED_FILE, []);
  var published = readJSON(ARTICULOS_FILE, []);
  var candidateCache = pruneCandidateCache(loadCandidateCache());

  var knownLinks = new Set(discarded);
  drafts.forEach(function (d) { if (d.sourceUrl) knownLinks.add(d.sourceUrl); });
  published.forEach(function (a) { if (a.sourceUrl) knownLinks.add(a.sourceUrl); });

  var knownTitles = new Set();
  drafts.forEach(function (d) { knownTitles.add(normalizeTitle(d.sourceTitle || d.title)); });
  published.forEach(function (a) { knownTitles.add(normalizeTitle(a.title)); });

  var recentCutoff = daysAgo(SIMILARITY_LOOKBACK_DAYS);
  var recentWordSets = [];
  published.forEach(function (a) {
    var t = Date.parse(a.date);
    if (!isNaN(t) && t < recentCutoff) return;
    recentWordSets.push(significantWords((a.title || '') + ' ' + (a.dek || '')));
  });
  drafts.forEach(function (d) {
    recentWordSets.push(significantWords((d.sourceTitle || d.title || '') + ' ' + (d.dek || '')));
  });
  function isSameStoryAsKnown(item) {
    var words = significantWords((item.title || '') + ' ' + (item.summary || ''));
    for (var i = 0; i < recentWordSets.length; i++) {
      if (wordOverlapScore(words, recentWordSets[i]) >= SAME_STORY_OVERLAP_THRESHOLD) return true;
    }
    return false;
  }

  var trendsExamined = Math.min(trends.length, limits.maxHeadlinesExamined);
  var examinedTrends = trends.slice(0, limits.maxHeadlinesExamined);
  var trendsCategoryMatched = 0;
  var filteredCounts = {
    categoryExcluded: 0, promotional: 0, expired: 0, unreachable: 0, blocked: 0, commercialDeal: 0,
    duplicate: 0, stale: 0, cachedSkip: 0, blockedContent: 0,
    fantasyOrBetting: 0
  };
  var candidates = [];
  var corroborationSearchesPerformed = 0;
  // Fantasy/apuestas (pedido 2026-09-27, punto 1/8): caso real que motivó
  // este filtro -- "Michael Wilson Fantasy Week 3 Start or Sit" llegó
  // exactamente por ESTE camino (Google Trends es el modo principal de
  // descubrimiento hoy). Ver el comentario completo en buildCandidates() de
  // más arriba (RSS) -- mismo criterio, misma lista de candidatos manuales.
  var fantasyBettingCandidates = [];

  // Punto 5 del pedido ("durante el proceso mostrar... 'Buscando fuentes
  // independientes…'"): se fija UNA sola vez acá, antes del recorrido
  // completo de tendencias -- la clasificación en sí (sin IA) es
  // prácticamente instantánea, así que el tiempo real de esta fase lo
  // domina por completo la corroboración (chequeo de vida del link +
  // computeCorroborationMatch + como mucho una búsqueda de respaldo por
  // tendencia, ver corroborateTrend más arriba).
  setFetchStatus('corroborating', 'Buscando fuentes independientes…');
  for (var ti = 0; ti < examinedTrends.length; ti++) {
    if (deadlineObj.expired()) { timedOut = true; break; }
    var trend = examinedTrends[ti];

    // Punto 3, paso 1-2 del pedido: clasificar SIN IA y descartar lo que
    // no coincide con ninguna categoría activa -- 0 llamadas de IA para
    // estas, nunca llegan siquiera a evaluarse para corroboración.
    var category = classifyTrendCategory(trendClassificationText(trend));
    if (!category) { filteredCounts.categoryExcluded++; continue; }
    trendsCategoryMatched++;

    // Cobertura real ya agrupada por Google Trends para esta tendencia --
    // sin al menos un artículo utilizable no hay ni fuente primaria, así
    // que la tendencia se descarta acá (no es un "filtro" con motivo
    // editorial, simplemente no hay nada real que redactar).
    var usable = usableTrendNewsItems(trend);
    if (!usable.length) continue;
    var primary = usable[0];

    if (candidateCache[primary.url]) { filteredCounts.cachedSkip++; continue; }
    if (knownLinks.has(primary.url)) { filteredCounts.duplicate++; continue; }
    if (knownTitles.has(normalizeTitle(primary.title))) { filteredCounts.duplicate++; continue; }
    if (isChildSafetyRisk((primary.title || '') + ' ' + (primary.snippet || ''))) { filteredCounts.blockedContent++; continue; }

    var sourceTextForFilters = (primary.title || '') + ' ' + (primary.snippet || '') + ' ' + (primary.outlet || '') + ' ' + (primary.domain || '');
    var deal = detectCommercialDeal(sourceTextForFilters, primary.url);
    if (deal.isCommercialDeal) { filteredCounts.commercialDeal++; cacheCandidateResult(candidateCache, primary.url, 'commercial-deal'); continue; }
    var promo = detectPromotionalLanguage(sourceTextForFilters);
    if (promo.isPromotional) { filteredCounts.promotional++; cacheCandidateResult(candidateCache, primary.url, 'promotional'); continue; }
    var fantasyOrBetting = detectFantasyOrBettingAdvice(sourceTextForFilters);
    if (fantasyOrBetting.isFantasyOrBettingAdvice) {
      filteredCounts.fantasyOrBetting++;
      fantasyBettingCandidates.push({
        title: primary.title || '', summary: primary.snippet || '', link: primary.url,
        domain: primary.domain || null, outlet: primary.outlet || null, category: category || null,
        adviceCategory: fantasyOrBetting.adviceCategory, matchedTerm: fantasyOrBetting.matchedTerm
      });
      continue;
    }
    var deadlineInfo = isDeadlinePassed(sourceTextForFilters);
    if (deadlineInfo.expired) { filteredCounts.expired++; cacheCandidateResult(candidateCache, primary.url, 'expired'); continue; }

    var candidateItem = {
      title: primary.title, summary: primary.snippet || '', link: primary.url,
      image: null, category: category, domain: primary.domain, outlet: primary.outlet,
      pubDateISO: trend.pubDateISO || null, sourceCount: 1,
      trendQuery: trend.query, approxTraffic: trend.approxTraffic
    };
    if (isSameStoryAsKnown(candidateItem)) { filteredCounts.duplicate++; cacheCandidateResult(candidateCache, primary.url, 'duplicate'); continue; }

    // Fuente viva (mismo control que el flujo RSS, requisito 10 de la
    // mejora global 2026-09-20 -- un solo criterio de "¿esto todavía
    // responde?" para cualquier origen del candidato).
    var reach = await module.exports.checkUrlReachable(primary.url, undefined, deadlineObj).catch(function () { return { reachable: true, uncertain: true }; });
    if (reach && reach.reachable === false) {
      if (reach.blocked) filteredCounts.blocked = (filteredCounts.blocked || 0) + 1;
      else filteredCounts.unreachable = (filteredCounts.unreachable || 0) + 1;
      continue;
    }

    // Corroboración -- punto 1 del pedido: dos fuentes periodísticas
    // independientes antes de llamar a la IA (ver corroborateTrend arriba).
    var canSearch = corroborationSearchesPerformed < limits.maxCorroborationSearches && !deadlineObj.expired();
    var corrResult = await corroborateTrend(trend, usable, primary, deadlineObj, canSearch);
    if (corrResult.usedSearch) corroborationSearchesPerformed++;
    candidateItem.corroboration = corrResult.corroboration || [];
    if (!candidateItem.corroboration.length) {
      cacheCandidateResult(candidateCache, primary.url, 'not-corroborated');
    }

    candidates.push(candidateItem);
  }

  var singleSourceCandidates = candidates
    .filter(function (item) { return !(item.corroboration && item.corroboration.length); })
    .map(function (item) {
      return {
        title: item.title || '', summary: item.summary || '', link: item.link,
        domain: item.domain || null, outlet: item.outlet || null, category: item.category || null,
        pubDateISO: item.pubDateISO || null, sourceCount: item.sourceCount || 1,
        sameDomainMatchWarning: false
      };
    });

  saveCandidateCache(candidateCache);

  var takenSlugs = new Set();
  drafts.forEach(function (d) { takenSlugs.add(d.slug); });
  published.forEach(function (a) { takenSlugs.add(a.slug); });

  if (!timedOut && deadlineObj.expired()) timedOut = true;
  if (ownsDeadline) deadlineObj.clear();

  return {
    candidates: candidates, errors: [], skipped: trends.length - candidates.length,
    takenSlugs: takenSlugs, filteredCounts: filteredCounts,
    headlinesExamined: trendsExamined,
    corroborationSearchesPerformed: corroborationSearchesPerformed,
    singleSourceCandidates: singleSourceCandidates,
    fantasyBettingCandidates: fantasyBettingCandidates,
    timedOut: timedOut,
    limits: limits,
    technicalFailure: false,
    trendsExamined: trendsExamined,
    trendsCategoryMatched: trendsCategoryMatched,
    source: 'google-trends'
  };
}

// Nombre de archivo corto para la imagen de portada de un borrador --
// a diferencia del slug completo del artículo, acá conviene que sea
// corto (para identificar de un vistazo a qué borrador pertenece sin
// que el nombre sea kilométrico) y único (sufijo random de 4 hex).
function shortDraftImageName(title) {
  var base = pagegen.slugify(title).slice(0, 40).replace(/-+$/, '');
  var suffix = Math.random().toString(16).slice(2, 6);
  return (base || 'draft') + '-' + suffix;
}

function downloadBinary(url, redirectsLeft) {
  redirectsLeft = redirectsLeft == null ? 4 : redirectsLeft;
  return new Promise(function (resolve, reject) {
    var lib = url.indexOf('https:') === 0 ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VexlowHQBot/1.0; +https://vexlowhq.com)' }, timeout: 12000 }, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var next = new URL(res.headers.location, url).toString();
        return resolve(downloadBinary(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      var contentType = res.headers['content-type'] || '';
      var chunks = [];
      var total = 0;
      res.on('data', function (c) {
        total += c.length;
        if (total > MAX_DRAFT_IMAGE_BYTES) { req.destroy(new Error('imagen demasiado grande')); return; }
        chunks.push(c);
      });
      res.on('end', function () { resolve({ buffer: Buffer.concat(chunks), contentType: contentType }); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function extFromUrlOrType(url, contentType) {
  var m = /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.exec(url);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  if (/image\/png/i.test(contentType)) return 'png';
  if (/image\/webp/i.test(contentType)) return 'webp';
  if (/image\/gif/i.test(contentType)) return 'gif';
  return 'jpg';
}

// Descarga localmente la imagen que ya trae la fuente RSS (no genera
// nada con IA) y la guarda con nombre corto en img/drafts/, para poder
// identificar de un vistazo a qué borrador pertenece en el panel. Si
// el feed no traía imagen o la descarga falla, no rompe el borrador --
// simplemente queda sin imagen (como pasaba antes de este cambio).
//
// AUDITORÍA DE IMÁGENES (sept. 2026): esta función históricamente NO
// dejaba ningún rastro de dónde salió la imagen -- ni la URL de origen,
// ni el autor, ni si el medio permite reutilizarla. Eso es exactamente
// el riesgo de derechos de imagen que se detectó en la auditoría global
// (2 imágenes recomprimidas fueron solo la punta del iceberg: la fuente
// RSS trayendo una imagen NUNCA implica permiso para usarla). Ahora se
// devuelve también la URL de origen para que quede grabada en el
// artículo como 'imageSource', con 'imageLicense' marcada explícitamente
// como pendiente de verificación -- nunca en blanco ni asumida como OK.
//
// CONTROL DE LICENCIAS (2026-09-11): 'pendiente-de-verificar' es
// deliberadamente una licencia NO autorizada (ver
// isAuthorizedImageLicense() más abajo) -- la imagen bajada acá queda
// como referencia privada del borrador (drafts.json nunca se publica ni
// genera páginas propias), y server.js bloquea el guardado en
// articulos.json si esa imagen llega a un artículo real sin que antes
// alguien elija o cargue una imagen autorizada desde el panel.
async function downloadDraftImage(url, title) {
  if (!url) return { path: '', sourceUrl: '' };
  try {
    var result = await downloadBinary(url);
    var ext = extFromUrlOrType(url, result.contentType);
    var name = shortDraftImageName(title) + '.' + ext;
    if (!fs.existsSync(DRAFT_IMG_DIR)) fs.mkdirSync(DRAFT_IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DRAFT_IMG_DIR, name), result.buffer);
    return { path: 'img/drafts/' + name, sourceUrl: url };
  } catch (e) {
    return { path: '', sourceUrl: '' };
  }
}

// Corre el pipeline completo (flujo manual: deja todo en borradores
// para revisión). Devuelve { added, skipped, errors, noApiKey }.
// Si no hay API key configurada, no intenta nada y avisa una sola vez
// (en vez de fallar ítem por ítem).
// Suma de todo lo que la fase 1 descartó ANTES de siquiera considerar la IA
// (requisito 15: "descartados antes de usar IA") -- incluye la caché técnica
// de 24hs (requisito 18), que es justamente un descarte que se evita repetir.
function sumDiscardedBeforeAI(filteredCounts) {
  var fc = filteredCounts || {};
  return (fc.categoryExcluded || 0) + (fc.promotional || 0) + (fc.expired || 0) + (fc.unreachable || 0) +
    (fc.blocked || 0) + (fc.commercialDeal || 0) + (fc.duplicate || 0) + (fc.stale || 0) +
    (fc.cachedSkip || 0) + (fc.blockedContent || 0) + (fc.fantasyOrBetting || 0);
}

// Candado de concurrencia (verificación previa a sincronizar, pedido de
// Leonardo 2026-09-24): dos búsquedas simultáneas (dos pestañas del panel,
// o varios clics que igual llegaran al servidor) NUNCA deben correr
// fetchNewDrafts() en paralelo -- cada corrida lee drafts.json/
// candidate-cache.json al arrancar y los reescribe enteros al final, así
// que dos corridas superpuestas se pisarían entre sí (la segunda en
// terminar borra lo que agregó la primera) y podrían duplicar llamadas de
// IA sobre los mismos candidatos. Con Node de un solo hilo alcanza una
// bandera en memoria de proceso -- nunca se libera hasta que la corrida
// (éxito, error o corte por timeout) termina de verdad, ver el finally más
// abajo.
var fetchInProgress = false;

async function fetchNewDrafts() {
  if (fetchInProgress) {
    // Nunca toca ningún archivo ni el estado de progreso de la corrida en
    // curso -- devuelve de inmediato, sin gastar nada, para que el llamador
    // (server.js/admin.js) pueda avisar "ya hay una búsqueda en curso" en
    // vez de arrancar una segunda corrida real.
    return {
      added: 0, skipped: 0, errors: [], noApiKey: false, alreadyRunning: true,
      message: 'Ya hay una búsqueda de noticias en curso -- esperá a que termine antes de iniciar otra.'
    };
  }
  fetchInProgress = true;
  try {
    return await runFetchNewDrafts();
  } finally {
    fetchInProgress = false;
  }
}

async function runFetchNewDrafts() {
  var cfg = draft.loadConfig();
  var apiKey = cfg.draftProvider === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!apiKey) {
    setFetchStatus('idle', '');
    return { added: 0, skipped: 0, errors: [], noApiKey: true };
  }

  var runStartedAt = Date.now();
  // Deadline ÚNICO y compartido para TODA la fase 1 de esta corrida --
  // corrección 2026-09-27 (pedido explícito de Leonardo, "timeout
  // verdaderamente global"): ANTES, buildCandidatesFromTrends() y
  // buildCandidates() creaban CADA UNA su propio deadline de
  // preselectionTimeoutMs (45s) llamando a feeds.makeDeadline() por su
  // cuenta -- así que si Trends fallaba después de consumir, por ejemplo,
  // 40 de esos 45s, el respaldo RSS arrancaba con el reloj REINICIADO a
  // otros 45s enteros: hasta el doble del plazo real declarado. Ahora se
  // crea UN SOLO deadlineObj acá, dueño de esta función, y se lo pasa
  // explícitamente a buildCandidatesFromTrends()/buildCandidates() (ver
  // sus firmas más arriba: con un deadline externo, ninguna de las dos
  // crea uno propio ni lo cierra -- ownsDeadline queda en false) -- así
  // Trends y, si corresponde, su respaldo RSS comparten el mismo
  // presupuesto de tiempo de punta a punta: si Trends ya gastó 40s, el
  // respaldo RSS arranca con nada más que los ~5s que quedan, nunca con
  // 45s nuevos. deadlineObj.clear() se llama UNA sola vez, en el finally
  // de más abajo, sin importar por cuál de los puntos de salida termine
  // esta función (Trends solo, Trends+respaldo, timeout total, 0
  // candidatos aprobados, o una excepción real).
  var preselectionLimits = getPipelineLimits(cfg);
  var deadlineObj = feeds.makeDeadline(preselectionLimits.preselectionTimeoutMs);
  try {
    return await runFetchNewDraftsWithDeadline(cfg, deadlineObj, runStartedAt);
  } finally {
    deadlineObj.clear();
  }
}

async function runFetchNewDraftsWithDeadline(cfg, deadlineObj, runStartedAt) {
  // Punto 1 del pedido (2026-09-25, "descubrimiento de tendencias de
  // Estados Unidos y reorganización de categorías"): Google Trends
  // "Trending Now" (geo=US) pasa a ser el PUNTO DE PARTIDA del
  // descubrimiento -- ver buildCandidatesFromTrends() más arriba, que hace
  // toda la fase 1 (clasificación sin IA, corroboración de dos fuentes)
  // igual que buildCandidates() hace para RSS, con exactamente la misma
  // forma de resultado. El RSS de siempre (buildCandidates) queda como
  // RESPALDO -- solo se usa si Trends falla de verdad (red/timeout/XML
  // inválido, ver technicalFailure en buildCandidatesFromTrends), nunca
  // simplemente porque hoy no haya tendencias compatibles (eso es un
  // resultado válido, no un fallo).
  setFetchStatus('trends', 'Consultando tendencias de Estados Unidos…');
  var drafts = readJSON(DRAFTS_FILE, []);
  var published = readJSON(ARTICULOS_FILE, []);
  var built;
  var fallbackReason = null;
  try {
    built = await buildCandidatesFromTrends(cfg, deadlineObj);
    if (built.technicalFailure) {
      // "Si Google Trends falla, usar los RSS configurados como fallback,
      // manteniendo diversidad de medios y los mismos requisitos" -- el
      // resultado fallido se descarta por completo y se reconstruye con
      // el camino de RSS de siempre (mismos filtros, misma corroboración,
      // mismo criterio -- ver buildCandidates() más arriba;
      // setFetchStatus('corroborating', ...) se dispara solo desde
      // adentro de esa función cuando arranca esa etapa).
      fallbackReason = built.failureReason || 'unknown';
      // "Trends agota el plazo y RSS no comienza" (requisito explícito de
      // Leonardo, 2026-09-27): si el deadline COMPARTIDO ya se cumplió
      // (Trends ya gastó todo el presupuesto, o lo que quedaba es 0), el
      // respaldo RSS NI SIQUIERA SE LLAMA -- ni una sola conexión de red
      // nueva, ni una lectura de feeds.json. Se informa como el mismo
      // timeout total de la corrida (built.timedOut más abajo hace que 0
      // candidatos lleguen a la IA), en vez de invocar buildCandidates()
      // solo para que reporte lo mismo una vez arrancado.
      if (deadlineObj.expired()) {
        built = {
          candidates: [], errors: [], skipped: 0,
          takenSlugs: built.takenSlugs || new Set(),
          filteredCounts: built.filteredCounts || {
            categoryExcluded: 0, promotional: 0, expired: 0, unreachable: 0, blocked: 0,
            commercialDeal: 0, duplicate: 0, stale: 0, cachedSkip: 0, blockedContent: 0
          },
          headlinesExamined: 0,
          corroborationSearchesPerformed: 0,
          singleSourceCandidates: [],
          timedOut: true,
          limits: built.limits,
          source: 'rss-fallback',
          trendsExamined: built.trendsExamined || 0,
          trendsCategoryMatched: built.trendsCategoryMatched || 0
        };
      } else {
        setFetchStatus('analyzing', 'Google Trends no respondió -- usando RSS de respaldo…');
        built = await buildCandidates(cfg, deadlineObj);
        built.source = 'rss-fallback';
        built.trendsExamined = 0;
        built.trendsCategoryMatched = 0;
      }
    }
  } catch (e) {
    setFetchStatus('idle', '');
    throw e;
  }
  var takenSlugs = built.takenSlugs;
  var categoryOptions = listCategories();

  var discardedBeforeAI = sumDiscardedBeforeAI(built.filteredCounts);

  // ============================================================================
  // GATE de la FASE 1 -> FASE 2 (requisitos 4-7): SOLO los candidatos con al
  // menos una fuente adicional independiente REAL (ver buildCandidates/
  // addCorroboration/computeCorroborationMatch más arriba -- ya exige misma
  // historia por entidad/acción/fecha, dominio/grupo independiente, y nunca
  // inventa nada) pueden llegar a gastar una redacción con IA. Los que no,
  // quedan en built.singleSourceCandidates (requisito 20) -- NUNCA se
  // redactan automáticamente.
  var approved = built.candidates.filter(function (item) { return item.corroboration && item.corroboration.length > 0; });
  var candidatesWithTwoSources = approved.length;

  // Verificación previa a sincronizar (pedido de Leonardo, 2026-09-24): el
  // timeout global de la preselección (preselectionTimeoutMs, requisito 16)
  // tiene que cancelar DE VERDAD el trabajo, no solo cortar la fase 1 a
  // medias y seguir gastando IA con lo que haya quedado aprobado. Si
  // buildCandidates() ya cortó por timeout, la corrida entera se corta ACÁ
  // -- 0 llamadas de IA, nada se redacta, nada se escribe en drafts.json.
  // Los candidatos que sí llegaron a aprobarse antes del corte no quedan
  // "perdidos para siempre": como nunca se cachean con un resultado negativo
  // (solo se cachean los DESCARTES, ver buildCandidates), la próxima corrida
  // los vuelve a evaluar de cero, gratis.
  if (built.timedOut) {
    setFetchStatus('idle', '');
    return {
      added: 0, skipped: built.skipped, errors: built.errors,
      flaggedForSimilarity: 0, flaggedForGenericHeading: 0,
      noApiKey: false,
      filteredCounts: built.filteredCounts,
      trendsMode: built.source === 'google-trends' ? 'google-trends-us' : 'rss-fallback',
      // Panel: panorama de la corrida (punto 5 del pedido) -- ver el
      // comentario largo del return final de esta función para el
      // significado exacto de cada campo nuevo.
      trendsExamined: built.trendsExamined || 0,
      trendsCategoryMatched: built.trendsCategoryMatched || 0,
      fallbackReason: fallbackReason,
      totalTimeMs: Date.now() - runStartedAt,
      headlinesExamined: built.headlinesExamined,
      discardedBeforeAI: discardedBeforeAI,
      corroborationSearchesPerformed: built.corroborationSearchesPerformed,
      candidatesWithTwoSources: candidatesWithTwoSources,
      aiCallsMade: 0,
      readyCount: 0,
      needsReviewCount: 0,
      technicalFailures: built.errors.length,
      singleSourceCandidates: built.singleSourceCandidates,
      fantasyBettingCandidates: built.fantasyBettingCandidates || [],
      timedOut: true,
      message: 'Se alcanzó el plazo máximo de preselección (' + (built.limits ? built.limits.preselectionTimeoutMs : DEFAULT_PIPELINE_LIMITS.preselectionTimeoutMs) + 'ms) antes de terminar de evaluar los candidatos -- no se realizó ninguna llamada de IA en esta corrida. Los candidatos que ya se habían aprobado se vuelven a evaluar gratis en la próxima búsqueda.'
    };
  }

  // Origen de esta corrida, calculado UNA sola vez (nunca por candidato --
  // built.source es siempre el mismo para TODOS los aprobados de una
  // misma corrida, ver buildCandidatesFromTrends/runFetchNewDrafts: Trends
  // y su respaldo RSS son mutuamente excluyentes por corrida). Se usa acá
  // abajo para elegir el criterio de orden correcto (punto 3, paso 5 del
  // pedido) y, más abajo en el loop de redacción, para completar
  // editorialMeta.trendDetectionMethod/trendVolumeApprox de cada borrador.
  var runTrendDetectionMethod = built.source === 'google-trends' ? 'google-trends-us' : 'rss-feed-preselection';

  // Requisito 8 / punto 3 paso 5 del pedido: orden de los aprobados para
  // decidir a cuáles de ellos les toca una de las (como mucho
  // maxAIDrafts) redacciones de esta corrida. Un candidato de Trends usa
  // su propio criterio (compareTrendCandidatesForDrafting, que sí conoce
  // approxTraffic -- ver su comentario más arriba) en vez del de RSS
  // (compareCandidatesForDrafting, que ordena por sourceCount -- una señal
  // que no existe para un candidato de Trends, cada uno sale de una única
  // tendencia, nunca de varios feeds del sitio compitiendo por la misma
  // historia).
  var recentCutoffForOrder = daysAgo(SIMILARITY_LOOKBACK_DAYS);
  var recentWordSetsForOrder = [];
  published.forEach(function (a) {
    var t = Date.parse(a.date);
    if (!isNaN(t) && t < recentCutoffForOrder) return;
    recentWordSetsForOrder.push(significantWords((a.title || '') + ' ' + (a.dek || '')));
  });
  if (built.source === 'google-trends') {
    approved = approved.slice().sort(compareTrendCandidatesForDrafting);
  } else {
    approved = approved.slice().sort(function (a, b) { return compareCandidatesForDrafting(a, b, recentWordSetsForOrder); });
  }

  var limits = built.limits || getPipelineLimits(cfg);
  // Diversidad de medios (punto 1 del pedido: "no depender exclusivamente
  // de TechCrunch ni permitir que un solo medio monopolice los
  // resultados... manteniendo diversidad de medios" también para el
  // respaldo RSS) -- ver pickDiverseTopCandidates más arriba, aplicada acá
  // por igual sin importar el origen de `approved`.
  var toRedact = pickDiverseTopCandidates(approved, limits.maxAIDrafts);

  var added = 0;
  var flaggedForSimilarity = 0;
  var flaggedForGenericHeading = 0;
  var readyCount = 0;
  var needsReviewCount = 0;
  var aiCallsMade = 0;
  // Llamadas reales a generación de imagen (pedido 2026-09-27, punto 3/8) --
  // se incrementa SOLO en el nuevo punto del loop, después de clasificar,
  // nunca antes -- ver el reordenamiento completo más abajo.
  var imageCallsMade = 0;
  var errors = built.errors;

  // Requisito 14: si la fase 1 no aprobó a NADIE, no se llama a la IA ni una
  // sola vez -- se corta acá, antes de cualquier draft.draftArticle().
  if (toRedact.length === 0) {
    setFetchStatus('idle', '');
    return {
      added: 0, skipped: built.skipped, errors: errors,
      flaggedForSimilarity: 0, flaggedForGenericHeading: 0,
      noApiKey: false,
      filteredCounts: built.filteredCounts,
      trendsMode: built.source === 'google-trends' ? 'google-trends-us' : 'rss-fallback',
      trendsExamined: built.trendsExamined || 0,
      trendsCategoryMatched: built.trendsCategoryMatched || 0,
      fallbackReason: fallbackReason,
      totalTimeMs: Date.now() - runStartedAt,
      headlinesExamined: built.headlinesExamined,
      discardedBeforeAI: discardedBeforeAI,
      corroborationSearchesPerformed: built.corroborationSearchesPerformed,
      candidatesWithTwoSources: 0,
      aiCallsMade: 0,
      readyCount: 0,
      needsReviewCount: 0,
      technicalFailures: errors.length,
      singleSourceCandidates: built.singleSourceCandidates,
      fantasyBettingCandidates: built.fantasyBettingCandidates || [],
      timedOut: !!built.timedOut,
      message: 'No se encontraron noticias suficientemente corroboradas para redactar. No se realizaron llamadas de IA.'
    };
  }

  // Originalidad entre los borradores nuevos de ESTA corrida (pedido de
  // Leonardo, 2026-09-24, punto 3) -- thisRunStartIndex marca dónde empiezan
  // los que se van a agregar acá abajo, para poder compararlos entre sí sin
  // tocar los que ya estaban en drafts.json de corridas anteriores.
  // runTierBySlug/runScoreBySlug: se completan dentro del loop, justo
  // después de clasificar cada borrador recién creado -- se reutilizan más
  // abajo para el desempate de originalidad sin volver a llamar a
  // classifyDraft ni a la IA.
  var thisRunStartIndex = drafts.length;
  var runTierBySlug = {};
  var runScoreBySlug = {};

  for (var i = 0; i < toRedact.length; i++) {
    var item = toRedact[i];
    var cat = pagegen.categoryBySlug(item.category);
    if (!cat) continue;

    setFetchStatus('drafting', 'Redactando ' + (i + 1) + ' de ' + toRedact.length + '…');
    try {
      // Procedencia de la fuente (requisitos 1-2 de la mejora global,
      // 2026-09-20): sourceTitle pasa a ser el NOMBRE DEL MEDIO (no el
      // título original -- eso ahora es sourceHeadline, para no perder
      // ninguno de los dos). additionalSources sale de item.corroboration
      // (fuentes reales que confirmaron la misma historia, ver
      // buildCandidates() más arriba) -- nunca se inventa una segunda
      // fuente si no hubo corroboración real (requisito 6).
      // Corroboración previa a la redacción (2026-09-20, requisito 9): se
      // suman fecha de recuperación y motivo/puntaje de coincidencia --
      // antes solo se guardaba url/medio/titular/fecha de publicación.
      var additionalSources = (item.corroboration || []).map(function (c) {
        return {
          url: c.url, label: c.outlet || c.domain || null, headline: c.headline || null,
          domain: c.domain || null, publishedAt: c.publishedAt || null,
          retrievedAt: c.retrievedAt || null,
          matchScore: typeof c.matchScore === 'number' ? c.matchScore : null,
          matchReasons: Array.isArray(c.matchReasons) ? c.matchReasons : []
        };
      });
      var sourcesForPrompt = {
        primary: { url: item.link, outlet: item.outlet || item.domain || '' },
        additional: additionalSources.map(function (s) { return { url: s.url, outlet: s.label || s.domain || '' }; })
      };
      // Requisito 10: UNA sola llamada de redacción por candidato, sin
      // reintento automático -- se cuenta acá, justo antes de la única
      // llamada que este candidato va a recibir en toda la corrida (si
      // falla, cae al catch de abajo y pasa al siguiente candidato, nunca
      // se reintenta el mismo). Requisito 26: contador real de llamadas
      // (no inferido) para que las pruebas puedan verificarlo de dos formas
      // independientes -- este número y lo que el mock de draft.draftArticle
      // contó por su cuenta.
      aiCallsMade++;
      var result = await draft.draftArticle(item, cfg, categoryOptions, sourcesForPrompt);
      // Science se integra editorialmente dentro de Technology (pedido
      // 2026-09-25): result.category viene de la propia IA, que todavía ve
      // "science" como slug válido en categoryOptions (a propósito, ver el
      // comentario de EXCLUDED_NEW_DRAFT_CATEGORIES más arriba -- el editor
      // manual la sigue necesitando). Si la IA elige "science" por su
      // cuenta para un borrador NUEVO, se remapea acá a "technology" antes
      // de seguir -- nunca se descarta el borrador entero por esto, es
      // exactamente el mismo criterio que ya se aplica en el resto del
      // archivo (corregir un campo puntual, no tirar todo el trabajo).
      if (result.category === 'science') result.category = 'technology';
      var finalCat = pagegen.categoryBySlug(result.category) || cat;
      var slug = uniqueSlug(pagegen.slugify(result.title), takenSlugs);
      // Orden nuevo (pedido de Leonardo, 2026-09-27, punto 4): redactar ->
      // validar calidad y aporte editorial -> clasificar -> generar imagen
      // SOLO si queda "listo". Antes, la imagen (real llamada de IA cuando
      // la fuente no traía foto propia) se generaba ACÁ MISMO, antes de
      // saber si el texto siquiera iba a servir -- hallazgo real: un
      // borrador de fantasy football (Yahoo Sports, 2026-09-27) generó una
      // imagen con IA y terminó en "revisar" de todos modos, con la imagen
      // ya pagada y sin usar. Los campos de imagen arrancan en blanco/null
      // acá; se completan más abajo SOLO si corresponde.
      var localImage = '';
      var imageSource = '';
      var imageLicense = '';
      // Campos de procedencia (auditoría forense de imágenes, sept. 2026
      // / registro obligatorio de procedencia, sept. 2026): se completan
      // SOLO cuando hay algo real que registrar -- nunca con un valor
      // inventado. Un artículo sin imagen, o con imagen de RSS todavía
      // sin decisión, se guarda con estos campos en null/vacío; el panel
      // exige completarlos antes de poder publicar (ver
      // validateImagePublication() más abajo).
      var imageOrigin = '';
      var imageTool = null;
      var imageModel = null;
      var imageGeneratedAt = null;
      var imagePrompt = null;
      var imageHumanEdited = null;
      var imageOwnerAttestation = null;
      var imageSourceUrl = null;
      // Chequeo anti-copia: compara el resumen ORIGINAL de la fuente
      // contra el título+dek+cuerpo que redactó la IA. Es una red de
      // seguridad además de la instrucción del prompt (admin/draft.js
      // ya le pide "nunca copiar ni parafrasear de cerca"), por si la
      // IA no la respeta en algún caso puntual -- copiar texto de la
      // fuente casi textual es justo el tipo de "contenido de poco
      // valor"/scraped content que penaliza AdSense.
      var sourceText = (item.title || '') + '. ' + (item.summary || '');
      var generatedText = (result.title || '') + '. ' + (result.dek || '') + ' ' + (result.body || '');
      var copyRatio = verbatimOverlapRatio(sourceText, generatedText, 6);
      var paraphraseRatio = maxSentenceSimilarity(sourceText, generatedText);
      var similarityWarning = copyRatio >= COPY_WARNING_THRESHOLD || paraphraseRatio >= PARAPHRASE_WARNING_THRESHOLD;
      if (similarityWarning) flaggedForSimilarity++;
      var genericHeadingWarning = hasGenericHeading(result.body);
      if (genericHeadingWarning) flaggedForGenericHeading++;
      // Aporte editorial verificable (pedido 2026-09-24, punto 2): se
      // calcula UNA vez acá, con evidencia real del cuerpo ya redactado --
      // result.editorialValueClaims es lo que la propia IA declaró (ver
      // SYSTEM_PROMPT en admin/draft.js), usado solo para los campos de
      // texto libre (whatHappened/whyItMatters/confirmed/uncertain/
      // whatToWatch); el conteo de elementos ignora esa declaración y mide
      // directo sobre result.body (ver computeEditorialValue).
      var editorialValue = computeEditorialValue(result, result.editorialValueClaims);
      // Calidad de redacción posterior (pedido 2026-09-27, punto 5) -- se
      // calcula acá, con el cuerpo real ya redactado y con la metadata
      // técnica de la llamada (aiCallMeta, ver admin/draft.js) para poder
      // detectar un truncamiento real sin gastar otra llamada de IA.
      var writingQuality = validateDraftWritingQuality(result, result.aiCallMeta);
      // Registro editorial consolidado para artículos NUEVOS (pedido
      // 2026-09-24, punto 5) -- deliberadamente NO duplica acá los campos
      // que ya existen y ya se preservan solos (date/dateModified/
      // correctionNote/editorialApproval, ver admin/article-status.js e
      // informe-matriz-cumplimiento-adsense-editorial.md observación A):
      // esos se siguen leyendo en vivo desde el propio artículo, nunca de
      // una copia acá que podría quedar vieja. Este objeto junta lo que
      // hasta ahora vivía disperso o no se guardaba en ningún lado.
      // trendDetectionMethod/trendVolumeApprox (pedido 2026-09-25):
      // "google-trends-us" con el volumen aproximado REAL que trajo el
      // feed de Google Trends (item.approxTraffic, ver
      // admin/google-trends.js -- parseApproxTraffic ya deja esto en null
      // si Google no lo dio, nunca en 0 inventado) cuando este borrador
      // salió del descubrimiento por Trends (runTrendDetectionMethod,
      // calculado una sola vez para toda la corrida a partir de
      // built.source -- ver runFetchNewDrafts, nunca por candidato, porque
      // una misma corrida nunca mezcla candidatos de Trends con
      // candidatos de RSS de respaldo). Para el flujo de RSS (siempre que
      // Trends haya fallado de verdad en esta corrida, ver
      // buildCandidatesFromTrends) sigue siendo "rss-feed-preselection"
      // con trendVolumeApprox null, exactamente como desde la auditoría
      // 2026-09-13 -- nunca se inventa un número que RSS nunca tuvo.
      var editorialMeta = {
        trendOrigin: { headline: item.title || null, outlet: item.outlet || item.domain || null, category: item.category || null, feedUrl: item.feedUrl || null },
        trendDetectionMethod: runTrendDetectionMethod,
        trendVolumeApprox: runTrendDetectionMethod === 'google-trends-us' && typeof item.approxTraffic === 'number' ? item.approxTraffic : null,
        detectedAt: new Date().toISOString(),
        sourcesConsulted: [{ url: item.link, label: item.outlet || item.domain || null, retrievedAt: new Date().toISOString(), role: 'primary' }]
          .concat(additionalSources.map(function (s) { return { url: s.url, label: s.label, retrievedAt: s.retrievedAt, role: 'corroboration' }; })),
        keyClaims: Array.isArray(result.keyClaims) ? result.keyClaims : [],
        // readinessReasons/sensitiveReasons se completan un poco más abajo,
        // justo después de clasificar este borrador recién creado (hacen
        // falta datos que classifyDraft calcula, no se van a duplicar la
        // fórmula acá).
        readinessReasons: [],
        sensitiveReasons: [],
        editorialValue: editorialValue,
        // Metadata técnica de la llamada de redacción (pedido 2026-09-27,
        // punto 6): SOLO lo que devolvió buildAiCallMeta en admin/draft.js
        // (proveedor, modelo, finishReason/truncated, conteo de tokens) --
        // nunca el prompt, nunca la respuesta cruda, nunca una clave. No
        // decide nada por sí sola salvo el caso de truncamiento (ya
        // incorporado a writingQuality de arriba). admin/pagegen.js y
        // generate_pages.py nunca leen editorialMeta -- no tiene ningún
        // camino hacia una página pública (ver
        // test-writing-quality-validation.js, sección de integridad).
        aiCallMeta: result.aiCallMeta || null,
        imageProvenance: { origin: null, license: null, tool: null, model: null, generatedAt: null, sourceUrl: null }
      };
      var draftCandidate = {
        title: result.title,
        category: finalCat.slug,
        categoryLabel: finalCat.label,
        icon: finalCat.icon,
        date: todayISO(),
        readTime: result.readTime || '',
        slug: slug,
        dek: result.dek,
        image: localImage || null,
        imageSource: imageSource,
        imageLicense: imageLicense,
        imageOrigin: imageOrigin,
        imageTool: imageTool,
        imageModel: imageModel,
        imageGeneratedAt: imageGeneratedAt,
        imagePrompt: imagePrompt,
        imageHumanEdited: imageHumanEdited,
        imageOwnerAttestation: imageOwnerAttestation,
        imageSourceUrl: imageSourceUrl,
        videoUrl: '',
        trending: false,
        body: result.body,
        sourceUrl: item.link,
        sourceTitle: item.outlet || item.domain || null,
        sourceHeadline: item.title || null,
        sourceDomain: item.domain || null,
        sourceAuthor: item.author || null,
        sourcePublishedAt: item.pubDateISO || null,
        sourceRetrievedAt: new Date().toISOString(),
        additionalSources: additionalSources,
        singleSourceWarning: additionalSources.length === 0,
        // Corroboración previa a la redacción (2026-09-20, requisito 15;
        // renombrado y con recálculo completo 2026-09-21 -- ver el
        // contrato completo del campo antes de findCorroborationForItem):
        // deja constancia de si la búsqueda encontró un candidato de
        // contenido parecido pero lo tuvo que descartar por ser del mismo
        // dominio/grupo -- para que el panel pueda mostrar el motivo real
        // en vez de un "solo una fuente" genérico. Es una ADVERTENCIA, no
        // una corroboración real -- nunca afecta el puntaje editorial.
        sameDomainMatchWarning: !!item._sameDomainMatchWarning,
        keyClaims: Array.isArray(result.keyClaims) ? result.keyClaims : [],
        sourceCount: item.sourceCount || 1,
        similarityWarning: similarityWarning,
        similarityScore: Math.round(Math.max(copyRatio, paraphraseRatio) * 100),
        genericHeadingWarning: genericHeadingWarning,
        editorialValue: editorialValue,
        writingQuality: writingQuality,
        editorialMeta: editorialMeta,
        createdAt: new Date().toISOString()
      };
      // Requisitos 11-13: el checklist/puntaje completo se recalcula acá
      // mismo, justo después de redactar (y de validar calidad de
      // redacción), con el MISMO classifyDraft() que usa GET /api/drafts --
      // nunca una fórmula paralela distinta. Esto decide "listo" vs.
      // "revisar" para los contadores de esta corrida (requisito 15); nunca
      // dispara una segunda llamada a la IA de TEXTO ni reintenta nada si
      // queda con advertencias -- el borrador se guarda igual, tal cual
      // salió, y queda para revisión humana. Se clasifica ANTES de resolver
      // la imagen a propósito (pedido 2026-09-27, punto 4): la imagen recién
      // se intenta más abajo, y solo si el resultado acá es "listo".
      var tierJustCreated = classifyDraft(draftCandidate, published);
      if (tierJustCreated.readinessTier === 'listo') {
        var downloaded = await downloadDraftImage(item.image, result.title);
        localImage = downloaded.path;
        imageSource = downloaded.sourceUrl;
        if (localImage) {
          // Se descargó una imagen de la fuente RSS -- queda registrada la
          // URL de origen, pero la licencia NUNCA se asume: se marca
          // explícitamente como pendiente hasta que alguien la verifique
          // a mano (ver panel: campo "Licencia de imagen"). Esto NO es una
          // llamada de IA (no suma a imageCallsMade) -- es una descarga
          // directa de la imagen que ya traía la fuente.
          imageLicense = 'pendiente-de-verificar';
          imageOrigin = 'rss-download-unverified';
          imageSourceUrl = imageSource || null;
        } else {
          // La fuente RSS no traía foto — se genera una con IA como
          // respaldo, usando el ÚNICO proceso real de generación de
          // VexlowHQ (prompt blindado contra logos/personajes reales, ver
          // admin/image-gen.js). Si falla por cualquier motivo, el
          // borrador sigue su curso sin imagen, como antes de este cambio.
          // Se guarda el registro completo de generación (herramienta,
          // modelo, fecha, prompt) en el momento mismo en que se genera --
          // así esta imagen SÍ se puede demostrar más adelante si hace
          // falta. imageCallsMade solo cuenta ACÁ (real llamada de IA),
          // nunca la descarga gratis de arriba.
          try {
            imageCallsMade++;
            var generated = await imageGen.generateCoverImage({ title: result.title, categoryLabel: finalCat.label, slug: slug }, cfg, null);
            if (generated) {
              localImage = generated.path;
              imageLicense = 'ai-generated-commercial-use';
              imageOrigin = 'ai-generated';
              imageTool = generated.tool;
              imageModel = generated.model;
              imageGeneratedAt = generated.generatedAt;
              imagePrompt = generated.prompt;
              imageHumanEdited = false; // nadie retocó el archivo que devolvió la API -- se guarda tal cual la conversión a JPEG
              imageOwnerAttestation = true;
              imageSourceUrl = null; // generada, no descargada -- no tiene URL de origen externa
            }
          } catch (e) {}
        }
        draftCandidate.image = localImage || null;
        draftCandidate.imageSource = imageSource;
        draftCandidate.imageLicense = imageLicense;
        draftCandidate.imageOrigin = imageOrigin;
        draftCandidate.imageTool = imageTool;
        draftCandidate.imageModel = imageModel;
        draftCandidate.imageGeneratedAt = imageGeneratedAt;
        draftCandidate.imagePrompt = imagePrompt;
        draftCandidate.imageHumanEdited = imageHumanEdited;
        draftCandidate.imageOwnerAttestation = imageOwnerAttestation;
        draftCandidate.imageSourceUrl = imageSourceUrl;
        draftCandidate.editorialMeta.imageProvenance = { origin: imageOrigin || null, license: imageLicense || null, tool: imageTool, model: imageModel, generatedAt: imageGeneratedAt, sourceUrl: imageSourceUrl };
      }
      // Si NO quedó "listo": image sigue en null (ya lo estaba desde que se
      // armó draftCandidate) -- 0 llamadas de imagen, ninguna advertencia
      // nueva por "sin imagen" (validateImageFields ya trata `!article.image`
      // como categoría válida sin nada que bloquear, ver más abajo en este
      // archivo). El botón manual "Generar imagen" del panel
      // (generateDraftImageManually) es la única forma de completarla desde
      // acá en adelante -- una sola llamada cuando Leonardo la pida, nunca
      // automática.
      drafts.push(draftCandidate);
      added++;
      // Se completan acá los dos campos de editorialMeta que dependían de
      // classifyDraft (pedido 2026-09-24, punto 5) -- nunca se duplica la
      // fórmula, solo se guarda el resultado ya calculado.
      draftCandidate.editorialMeta.readinessReasons = tierJustCreated.readinessReasons;
      draftCandidate.editorialMeta.sensitiveReasons = tierJustCreated.sensitiveReasons;
      runTierBySlug[draftCandidate.slug] = tierJustCreated.readinessTier;
      runScoreBySlug[draftCandidate.slug] = tierJustCreated.editorialReadinessScore;
      if (tierJustCreated.readinessTier === 'listo') readyCount++;
      else needsReviewCount++;
    } catch (e) {
      errors.push({ url: item.link, error: e.message === 'NO_API_KEY' ? 'Sin API key' : e.message });
    }
  }

  // Originalidad entre los borradores nuevos de esta corrida (pedido
  // 2026-09-24, punto 3): compara cada borrador recién redactado contra los
  // OTROS de esta misma corrida (nunca contra drafts.json de corridas
  // anteriores ni contra articulos.json -- eso ya lo cubren
  // knownTitles/knownLinks arriba y findMostSimilarPublished/
  // findGraveContradiction en classifyDraft). Sin llamada de IA adicional:
  // reutiliza wordOverlapScore/significantWords, ya calculados para todo lo
  // demás en este archivo. Si dos cubren el mismo hecho, se conserva el de
  // mayor corroboración (más fuentes independientes) y, en empate, el de
  // mayor puntaje editorial -- documentado en sameRunDuplicatesDiscarded
  // para que el panel/informe pueda mostrar cuál se descartó y por qué.
  var sameRunDuplicatesDiscarded = [];
  var newDraftsThisRun = drafts.slice(thisRunStartIndex);
  if (newDraftsThisRun.length > 1) {
    var removeSlugSet = {};
    for (var ra = 0; ra < newDraftsThisRun.length; ra++) {
      if (removeSlugSet[newDraftsThisRun[ra].slug]) continue;
      var wordsA = significantWords((newDraftsThisRun[ra].title || '') + ' ' + (newDraftsThisRun[ra].dek || ''));
      for (var rb = ra + 1; rb < newDraftsThisRun.length; rb++) {
        if (removeSlugSet[newDraftsThisRun[rb].slug]) continue;
        var wordsB = significantWords((newDraftsThisRun[rb].title || '') + ' ' + (newDraftsThisRun[rb].dek || ''));
        var overlap = wordOverlapScore(wordsA, wordsB);
        if (overlap < SAME_STORY_OVERLAP_THRESHOLD) continue;
        var itemA = newDraftsThisRun[ra], itemB = newDraftsThisRun[rb];
        var sourcesA = (itemA.additionalSources || []).length, sourcesB = (itemB.additionalSources || []).length;
        var scoreA = runScoreBySlug[itemA.slug] || 0, scoreB = runScoreBySlug[itemB.slug] || 0;
        var loser, winner, why;
        if (sourcesA !== sourcesB) {
          loser = sourcesA < sourcesB ? itemA : itemB;
          why = 'mayor corroboración (' + Math.max(sourcesA, sourcesB) + ' vs. ' + Math.min(sourcesA, sourcesB) + ' fuentes adicionales)';
        } else if (scoreA !== scoreB) {
          loser = scoreA < scoreB ? itemA : itemB;
          why = 'mayor puntaje editorial (' + Math.max(scoreA, scoreB) + ' vs. ' + Math.min(scoreA, scoreB) + ')';
        } else {
          loser = itemB; // empate total -- se conserva el redactado primero
          why = 'orden de redacción (empate total en fuentes y puntaje)';
        }
        winner = loser === itemA ? itemB : itemA;
        if (!removeSlugSet[loser.slug]) {
          removeSlugSet[loser.slug] = true;
          sameRunDuplicatesDiscarded.push({
            discardedSlug: loser.slug, discardedTitle: loser.title,
            keptSlug: winner.slug, keptTitle: winner.title,
            overlapScore: Math.round(overlap * 100),
            reason: 'Cubre el mismo hecho que "' + winner.title + '" en esta misma corrida -- se conservó por ' + why + '.'
          });
        }
      }
    }
    var removedSlugs = Object.keys(removeSlugSet);
    if (removedSlugs.length) {
      // Corrección de Leonardo (2026-09-25): discarded-sources.json está
      // reservado para descartes MANUALES expresos del usuario (ver
      // discardDraft() más abajo) -- un detector heurístico como este puede
      // tener falsos positivos, y una deduplicación automática nunca debe
      // excluir una URL de forma permanente. Antes esto escribía la URL del
      // perdedor directo a discarded-sources.json (igual que un descarte
      // manual, sin distinción); ahora el duplicado se saca únicamente del
      // RESULTADO de esta corrida (drafts.json, applied below) y, si hace
      // falta evitar reprocesarlo de inmediato, se anota en
      // candidate-cache.json con motivo 'same-run-duplicate' -- la misma
      // caché técnica que ya usa buildCandidates() más arriba, con el mismo
      // vencimiento de 24hs (CANDIDATE_CACHE_TTL_MS): pasadas las 24hs la
      // entrada se poda sola y esa URL se vuelve a evaluar de cero, así que
      // un falso positivo de esta heurística nunca queda bloqueado para
      // siempre. discarded-sources.json NUNCA se toca acá.
      var discardedUrlsThisRun = [];
      drafts = drafts.filter(function (dft, idx) {
        if (idx < thisRunStartIndex) return true;
        if (removeSlugSet[dft.slug]) { discardedUrlsThisRun.push(dft.sourceUrl); return false; }
        return true;
      });
      if (discardedUrlsThisRun.length) {
        var sameRunCache = pruneCandidateCache(loadCandidateCache());
        discardedUrlsThisRun.forEach(function (u) { if (u) cacheCandidateResult(sameRunCache, u, 'same-run-duplicate'); });
        saveCandidateCache(sameRunCache);
      }
      removedSlugs.forEach(function (slug) {
        added--;
        if (runTierBySlug[slug] === 'listo') readyCount--; else needsReviewCount--;
      });
    }
  }

  writeJSON(DRAFTS_FILE, drafts);
  setFetchStatus('idle', '');

  return {
    added: added, skipped: built.skipped, errors: errors,
    flaggedForSimilarity: flaggedForSimilarity, flaggedForGenericHeading: flaggedForGenericHeading,
    noApiKey: false,
    filteredCounts: built.filteredCounts,
    // Honestidad ante todo (auditoría 2026-09-13, vigente tras el pedido
    // 2026-09-25): "google-trends-us" cuando esta corrida SÍ vino de la
    // integración real con Google Trends "Trending Now" (geo=US, ver
    // admin/google-trends.js -- built.source lo marca así solo cuando
    // buildCandidatesFromTrends() completó sin fallo técnico); "rss-fallback"
    // cuando Trends falló de verdad en esta corrida y se cayó al RSS
    // configurado de siempre (fallbackReason trae el motivo real -- nunca
    // se inventa un volumen/mercado/tendencia que RSS no tiene, ver
    // trendVolumeApprox más arriba). El panel debe mostrar esto
    // explícitamente en vez de insinuar métricas que no existen -- ver
    // admin.js.
    trendsMode: built.source === 'google-trends' ? 'google-trends-us' : 'rss-fallback',
    // Panel: panorama completo de la corrida, de punta a punta (punto 5
    // del pedido 2026-09-25 -- "mostrar al finalizar: tendencias de Google
    // examinadas; tendencias compatibles con las categorías... causa del
    // fallback si Google Trends falló; tiempo total"):
    //   trendsExamined         -- cuántas tendencias del feed se llegaron a
    //                             evaluar (0 si se usó el respaldo RSS,
    //                             porque ahí nunca se consultó Trends).
    //   trendsCategoryMatched  -- de esas, cuántas coincidieron con alguna
    //                             de las 6 categorías activas (antes de
    //                             cualquier corroboración/redacción).
    //   fallbackReason         -- null si Trends funcionó; si no,
    //                             'timeout'/'network'/'parse-error'/
    //                             'empty-response' (ver
    //                             admin/google-trends.js/raceAgainstDeadline)
    //                             -- nunca un texto inventado.
    //   totalTimeMs            -- tiempo real de toda la corrida (punto 6:
    //                             objetivo menos de 5 minutos), medido de
    //                             punta a punta con Date.now(), nunca una
    //                             estimación.
    trendsExamined: built.trendsExamined || 0,
    trendsCategoryMatched: built.trendsCategoryMatched || 0,
    fallbackReason: fallbackReason,
    totalTimeMs: Date.now() - runStartedAt,
    // Control de costos (requisito 15, pedido de Leonardo 2026-09-23):
    // panorama completo de la corrida, de punta a punta.
    headlinesExamined: built.headlinesExamined,
    discardedBeforeAI: discardedBeforeAI,
    corroborationSearchesPerformed: built.corroborationSearchesPerformed,
    candidatesWithTwoSources: candidatesWithTwoSources,
    aiCallsMade: aiCallsMade,
    readyCount: readyCount,
    needsReviewCount: needsReviewCount,
    technicalFailures: errors.length,
    // Originalidad entre borradores de la misma corrida (pedido 2026-09-24,
    // punto 3) -- documenta cuál se descartó y por qué, para que el panel/
    // informe lo pueda mostrar sin tener que adivinar.
    sameRunDuplicatesDiscarded: sameRunDuplicatesDiscarded,
    singleSourceCandidates: built.singleSourceCandidates,
    fantasyBettingCandidates: built.fantasyBettingCandidates || [],
    // Costo de imágenes (pedido 2026-09-27, punto 3/8): cuántas llamadas
    // reales a imageGen.generateCoverImage() se hicieron en esta corrida --
    // desde este cambio, solo para borradores que clasificaron "listo" (ver
    // el nuevo orden en el loop de arriba: redactar -> validar -> clasificar
    // -> imagen). imageCallsMade siempre <= readyCount.
    imageCallsMade: imageCallsMade,
    timedOut: !!built.timedOut,
    message: null
  };
}

// Clasificación de riesgo de un borrador YA guardado en drafts.json --
// se recalcula cada vez que se pide (GET /api/drafts en server.js), NUNCA
// se confía en un valor guardado de una corrida anterior, porque "vencido"
// es relativo a HOY: un borrador que todavía no tenía el plazo vencido
// cuando se lo trajo puede estarlo unos días después sin que nadie haya
// vuelto a tocarlo (auditoría 2026-09-13, prueba B). Devuelve la misma
// forma que se muestra en el panel (ver CHECKLIST_BUCKETS/renderDraftsList
// en admin.js).
// Lenguaje de rumor/reporte no confirmado -- si esto aparece en el texto
// y la única fuente registrada es un comunicado propio de la empresa
// involucrada (dominio de la fuente == la empresa de la que habla la
// nota, o simplemente no hay una segunda fuente periodística), es la
// señal de "comunicado corporativo presentado como si confirmara un
// rumor externo" del requisito 5 -- advertencia, nunca bloqueo (puede
// ser un falso positivo: una empresa perfectamente puede confirmar por
// comunicado propio algo que antes era un rumor).
var RUMOR_LANGUAGE_TERMS = /\b(reportedly|rumor(?:ed)?|said to be|according to (?:sources|people) familiar|is said to|habría|se rumorea|trascendi[oó])\b/i;

// Duplicado real de un artículo ya publicado -- mismo criterio de
// superposición de palabras significativas (título+dek) que ya usa
// buildCandidates()/validateArticleContent() en el resto de este archivo.
// Recibe allArticles como parámetro EXPLÍCITO (nunca lee el disco por su
// cuenta) para que classifyDraft() pueda quedar "opt-in": si no se le
// pasa la lista real, esto siempre da null y ningún llamado existente de
// classifyDraft(d) (con un solo argumento) cambia de comportamiento.
function findMostSimilarPublished(title, dek, allArticles) {
  var words = significantWords((title || '') + ' ' + (dek || ''));
  var best = null;
  (allArticles || []).forEach(function (a) {
    var otherWords = significantWords((a.title || '') + ' ' + (a.dek || ''));
    var score = wordOverlapScore(words, otherWords);
    if (score >= SAME_STORY_OVERLAP_THRESHOLD && (!best || score > best.score)) best = { article: a, score: score };
  });
  return best;
}

// Contradicción grave con un artículo ya publicado sobre el mismo tema --
// mismos pares de términos de sentido opuesto (CONTRADICTION_TERM_PAIRS,
// definidos más abajo en este archivo junto a validateSourcesAndQuality)
// que ya se usan para artículos guardados, reutilizados acá para
// borradores. Mismo diseño opt-in que findMostSimilarPublished() arriba.
function findGraveContradiction(title, dek, body, allArticles) {
  var titleDekWords = significantWords((title || '') + ' ' + (dek || ''));
  var thisText = (title || '') + ' ' + (dek || '') + ' ' + (body || '');
  var found = null;
  (allArticles || []).some(function (other) {
    var otherWords = significantWords((other.title || '') + ' ' + (other.dek || ''));
    if (wordOverlapScore(titleDekWords, otherWords) < SAME_STORY_OVERLAP_THRESHOLD) return false;
    var otherText = (other.title || '') + ' ' + (other.dek || '') + ' ' + (other.body || '');
    return CONTRADICTION_TERM_PAIRS.some(function (pair) {
      var hit = (pair[0].test(thisText) && pair[1].test(otherText)) || (pair[1].test(thisText) && pair[0].test(otherText));
      if (hit) found = other;
      return hit;
    });
  });
  return found;
}

// ============================================================================
// PUNTUACIÓN DE PREPARACIÓN EDITORIAL (pedido de Leonardo, 2026-09-20)
// ============================================================================
// 0-100, con reglas transparentes: cada +/- queda explicado en
// readinessReasons, así "por qué salió este puntaje" nunca es una caja
// negra. Es un heurístico de PRIORIZACIÓN para "Buscar noticias nuevas" --
// nunca reemplaza la aprobación humana obligatoria (editorialApproval
// sigue siendo el único gate real de publicación, ver
// validateEditorialWorkflow más abajo).
function computeEditorialReadiness(d, signals) {
  var score = 0;
  var reasons = [];
  function add(points, label) { score += points; reasons.push((points >= 0 ? '+' : '') + points + ': ' + label); }

  if (!signals.sourceInvalid) {
    var canonicalOk = false;
    try { canonicalOk = feeds.canonicalizeUrl(d.sourceUrl) === d.sourceUrl; } catch (e) { canonicalOk = false; }
    add(25, 'fuente principal real, con URL http(s) válida' + (canonicalOk ? ' y canónica' : ' (no está en forma canónica -- revisar parámetros de la URL)'));
  }

  var hasSecondSource = Array.isArray(d.additionalSources) && d.additionalSources.length > 0;
  if (hasSecondSource) add(20, 'segunda fuente independiente real (' + d.additionalSources.length + ') que corrobora la historia');

  var publishedRecently = false;
  if (d.sourcePublishedAt) {
    var age = Date.now() - Date.parse(d.sourcePublishedAt);
    publishedRecently = !isNaN(age) && age >= 0 && age <= 24 * 60 * 60 * 1000;
  }
  if (publishedRecently) add(15, 'publicado por la fuente en las últimas 24 horas');

  var categoryOk = !signals.categoryNotAllowed && listCategories().some(function (c) { return c.slug === d.category; });
  if (categoryOk) add(10, 'tema en una categoría activa de VexlowHQ');

  var claimsAttributable = Array.isArray(d.keyClaims) && d.keyClaims.length > 0 && d.keyClaims.every(function (c) { return c && c.sourceLabel; });
  if (claimsAttributable) add(10, 'afirmaciones principales atribuidas a una fuente concreta (keyClaims)');

  var hasRumorLanguage = RUMOR_LANGUAGE_TERMS.test(String(d.body || ''));
  if (!hasRumorLanguage) add(10, 'sin lenguaje de rumor/especulación en el cuerpo');

  // Imagen: se da por resuelta salvo un problema concreto ya detectable
  // (hotlink externo, o una licencia declarada que no es ni una
  // autorizada ni la de "pendiente de verificar" de RSS) -- este sitio
  // siempre tiene una salida seria (imagen de RSS a revisar, o
  // generación propia con IA vía admin/image-gen.js), así que la
  // ausencia de imagen en esta etapa no es por sí sola un problema real.
  // Esto NUNCA reemplaza el chequeo bloqueante de
  // validateImageFields/validateImagePublication al publicar -- es solo
  // triage previo para priorizar qué revisar primero.
  var imageProblem = !!(d.image && /^https?:\/\//i.test(d.image)) ||
    !!(d.image && d.imageLicense && d.imageLicense !== 'pendiente-de-verificar' && !isAuthorizedImageLicense(d.imageLicense));
  if (!imageProblem) add(5, 'imagen con procedencia válida o generable de forma segura');

  var editorialValueAdd = (String(d.body || '').match(/^##\s+\S/gm) || []).length >= 2;
  if (editorialValueAdd) add(5, 'el cuerpo aporta estructura propia (explicación/cronología/comparación en subtítulos)');

  if (signals.commercialDeal) add(-40, 'oferta, descuento, afiliación o CTA de compra detectado');
  if (signals.expired) add(-35, 'fecha límite o evento mencionado ya vencido');
  if (signals.isDuplicate) add(-30, 'duplicado de un artículo ya publicado');
  if (signals.sourceInvalid) add(-25, 'fuente principal inaccesible o dudosa');
  if (signals.singleSource) add(-20, 'una sola fuente para afirmaciones importantes');
  if (signals.rumorWithoutCorroboration) add(-20, 'rumor/afirmación sensible sin corroboración');

  return { score: Math.max(0, Math.min(100, score)), reasons: reasons };
}

// ============================================================================
// CONTENIDO SENSIBLE -- revisión humana obligatoria (pedido de Leonardo,
// 2026-09-24, "AGREGADO OBLIGATORIO -- GOOGLE ADSENSE, SEARCH Y CALIDAD
// EDITORIAL", punto 8)
// ============================================================================
// Objetivo explícito: NUNCA descartar automáticamente por esto, NUNCA restar
// puntaje (ver computeEditorialReadiness -- esta función no le toca ni un
// punto), y NUNCA dejar que el tema llegue a "listo" aunque el puntaje sea
// 80-100. Es una heurística de palabras/frases clave, deliberadamente
// conservadora y transparente (cada categoría documenta su propio motivo en
// texto plano) -- igual que el resto de los filtros de este archivo
// (isChildSafetyRisk, detectPromotionalLanguage, etc.), no un análisis
// semántico real. "Solo listos" nunca debe mostrar un tema de esta lista.
var SENSITIVE_TOPIC_GROUPS = [
  ['politics', 'política o elecciones', /\b(elections?|presidential race|ballot measure|voters?|campaign (?:trail|rally|finance)|primary election|senator|congress(?:man|woman)?|parliament|prime minister|political party|referendum|impeach(?:ment|ed)?|candidacy|candidate for (?:president|governor|senate|congress)|gubernatorial|electoral college)\b/i],
  ['health', 'salud, tratamientos o medicamentos', /\b(diagnos(?:is|ed)|treatment for|clinical trial|vaccine|medication|prescription drug|surgery|surgical procedure|cancer (?:diagnosis|treatment)|disease outbreak|fda approv(?:al|es|ed)|side effects?|mental health condition|therapy for|medical condition)\b/i],
  ['personal-finance', 'finanzas personales o recomendaciones de inversión', /\b(invest(?:ing|ment)? advice|should you (?:buy|invest)|personal (?:loan|debt|bankruptcy)|retirement savings|financial advisor|stock (?:tip|pick)s?|buy (?:this|the) stock|401\(k\)|credit score|mortgage rate)\b/i],
  ['crime-security', 'delitos, hacking o brechas de seguridad', /\b(data breach|breached|hack(?:ed|ers?)?|ransomware|cyberattack|security vulnerabilit(?:y|ies)|exploit(?:ed)?|malware|phishing|leaked (?:data|credentials|passwords)|unauthorized access|zero-day)\b/i],
  ['allegations', 'acusaciones o investigaciones', /\b(accused|alleged(?:ly)?|under investigation|probe into|indictment|indicted|subpoena(?:ed)?|whistleblower|misconduct allegations?)\b/i],
  ['violence-minors', 'muertes, violencia o menores', /\b(kill(?:ed|ing)?|dead at|death toll|fatal(?:ity|ities)?|homicide|murder(?:ed)?|shooting|stabbing|assault(?:ed)?|domestic violence|(?:child|minor|teen(?:ager)?)s?\b[^.?!]{0,40}\b(?:injur|harm|victim|kill|abus))\b/i],
  ['legal', 'asuntos legales, demandas o procesos judiciales', /\b(sues?|files? (?:a )?lawsuit|sued|settles? (?:a )?lawsuit|fined|faces? (?:antitrust|regulatory) (?:action|scrutiny)|court ruling|judge ruled|guilty verdict|plea deal|litigation)\b/i],
  ['layoffs-bankruptcy', 'despidos, quiebras o insolvencia', /\b(laid off|lays? off|laying off|layoffs?|cuts? (?:jobs|\d+% of (?:its|staff))|job cuts|files? for bankruptcy|chapter 11|insolven(?:cy|t)|goes? bankrupt|liquidation)\b/i],
  ['financial-rumor', 'rumores financieros', /\b(reportedly (?:in talks|considering|planning|exploring)|sources say[^.?!]{0,60}(?:acquisition|merger|ipo|funding round)|unconfirmed reports? of[^.?!]{0,40}(?:deal|acquisition|sale))\b/i],
  ['public-safety', 'seguridad pública', /\b(evacuat(?:ion|ed)|public health emergency|outbreak of|recall(?:ed|s)? (?:over|due to) (?:safety|contamination|injury)|contamin(?:ated|ation)|toxic (?:exposure|spill))\b/i]
];

// Instrucciones reales de acceso no autorizado/fraude/malware -- esto NO es
// "tema sensible, revisar a mano": es contenido que el sitio nunca debe
// ofrecer ni siquiera para revisión, así que se trata como bloqueo mecánico
// (mismo bucket que contenido promocional/oferta comercial/duplicado, ver
// `blocking` más abajo). Deliberadamente angosto -- instrucción imperativa +
// vocabulario de ataque -- para no confundir una noticia normal sobre
// ciberseguridad DEFENSIVA ("cómo protegerte de un ataque de phishing",
// "Google lanza un parche para una vulnerabilidad") con una guía real de
// cómo atacar. Una noticia que solo informa que algo fue hackeado cae en
// SENSITIVE_TOPIC_GROUPS.crime-security (revisión obligatoria, nunca
// bloqueo); esto de acá es exclusivamente para contenido instructivo.
var HACKING_INSTRUCTION_TERMS = /\b(how to hack|step[- ]by[- ]step[^.?!]{0,30}(?:hack|exploit|bypass)|here'?s how to (?:hack|bypass|crack)|tutorial[^.?!]{0,20}(?:hack|exploit|crack (?:a )?password)|download (?:this|the|a) (?:keylogger|malware|ransomware) (?:tool|kit|for free)|crack (?:someone'?s|any) password|bypass (?:two-factor|2fa|login) (?:security|authentication)|how to commit (?:fraud|identity theft))\b/i;

function detectSensitiveEditorialTopics(text) {
  var t = String(text || '');
  var matched = [];
  SENSITIVE_TOPIC_GROUPS.forEach(function (g) {
    if (g[2].test(t)) matched.push({ key: g[0], label: g[1] });
  });
  return {
    isSensitive: matched.length > 0,
    categories: matched.map(function (m) { return m.key; }),
    reasons: matched.map(function (m) { return m.label; }),
    // Bloqueo mecánico de verdad, separado de "sensible" -- ver comentario
    // arriba de HACKING_INSTRUCTION_TERMS.
    hackingInstructions: HACKING_INSTRUCTION_TERMS.test(t)
  };
}

// ============================================================================
// TRANSPARENCIA -- afiliación/patrocinio/testigo directo falsos (pedido de
// Leonardo, 2026-09-24, punto 7)
// ============================================================================
// Advertencia únicamente (nunca bloqueo, nunca resta puntaje) -- una cita
// correctamente atribuida ("according to X, ...") puede usar vocabulario
// parecido sin ser un problema real; por eso CONFIRMED_ATTRIBUTION_MARKER_TERMS
// cerca (a menos de 60 caracteres) desactiva la coincidencia de "the company
// confirmed" -- ver segundo grupo abajo.
var FALSE_AFFILIATION_TERMS = /\b(our partner\b|officially endorsed by|in partnership with us|sponsored by us|VexlowHQ (?:witnessed|was present|attended)|we witnessed|we can confirm firsthand|our team was (?:there|on (?:the )?scene))\b/i;
// "the company confirmed"/"officially confirmed" cuando lo único que hay
// detrás es lenguaje de reporte no confirmado (RUMOR_LANGUAGE_TERMS, ya
// definido más arriba en este archivo) -- upgrade indebido de rumor a hecho.
var FALSE_CONFIRMATION_UPGRADE_TERMS = /\b(the company (?:has )?confirmed|officially confirmed|confirmed (?:the|this) (?:deal|acquisition|announcement))\b/i;
// Marcador de atribución correcta ("according to a person familiar with the
// matter, the company confirmed...") -- cuando aparece justo antes de un
// FALSE_CONFIRMATION_UPGRADE_TERMS (dentro de 60 caracteres), la frase es una
// cita legítimamente atribuida, no una insinuación de confirmación falsa; ver
// uso con ventana de proximidad más abajo. También reutilizado tal cual como
// detector del elemento "confirmado vs. reportado" de APORTE EDITORIAL, más
// abajo en este archivo -- misma idea: el texto distingue explícitamente lo
// confirmado de lo solamente reportado/atribuido.
// OJO: nombrado "CONFIRMED_..." (no "ATTRIBUTION_MARKER_TERMS" a secas) a
// propósito -- ese nombre YA existe más abajo en este archivo (línea ~3558,
// heurística bilingüe ES/EN usada por validateSourcesAndQuality para
// afirmaciones con número/año sin atribución), con un propósito relacionado
// pero distinto. Antes de esta corrección (2026-09-24) esta constante se
// llamaba igual que esa otra -- dos `var` de módulo con el mismo nombre se
// pisan en silencio (la última asignación en orden de archivo gana para
// TODO el módulo), así que esta detección de transparencia y el detector de
// aporte editorial estaban leyendo, en la práctica, la regex bilingüe de la
// línea ~3558 en vez de esta -- un bug real, encontrado y corregido al
// escribir la batería de pruebas dedicada (admin/test-editorial-controls-adsense.js).
// Corrección de Leonardo (2026-09-27, "mejorá la redacción, no el umbral"):
// la lista de verbos de atribución era demasiado angosta -- "the company
// said" contaba, pero "the company announced"/"organizers confirmed"/
// "officials said" (verbos de atribución igual de legítimos, misma
// categoría exacta) no. Esto es una brecha demostrable por el propio código
// (no depende de ningún cuerpo real): son sinónimos directos de lo que ya
// se aceptaba, nunca una palabra clave nueva y fácil de engañar -- siguen
// exigiendo la MISMA estructura ("la fuente + verbo de atribución"), solo
// se amplió el verbo aceptado. Útil en particular para crónicas deportivas/
// de resultados oficiales (organizadores, autoridades del torneo), donde
// "said" rara vez aparece pero "announced"/"confirmed" sí.
var CONFIRMED_ATTRIBUTION_MARKER_TERMS = /\b(according to|sources (?:said|say|told|close to)|a (?:person|spokesperson|representative) (?:familiar with|for)|the (?:company|firm|team|league|organizers?|tournament) (?:said|announced|confirmed|revealed|stated|noted)|spokesperson (?:said|told)|officials (?:said|announced|confirmed)|in a statement|has (?:not )?confirmed|declined to comment|has not responded to)\b/i;

function detectTransparencyRisk(text) {
  var t = String(text || '');
  var reasons = [];
  if (FALSE_AFFILIATION_TERMS.test(t)) {
    reasons.push('posible insinuación de afiliación, patrocinio o presencia directa de VexlowHQ en el hecho');
  }
  var upgradeMatch = FALSE_CONFIRMATION_UPGRADE_TERMS.exec(t);
  if (upgradeMatch && RUMOR_LANGUAGE_TERMS.test(t)) {
    // No bloquear frases legítimas dentro de una cita correctamente
    // atribuida (pedido de Leonardo, 2026-09-24, punto 4): si hay un
    // marcador de atribución dentro de los 60 caracteres previos a la
    // frase de "confirmado oficialmente", se trata como cita legítima y
    // no se levanta la advertencia.
    var windowStart = Math.max(0, upgradeMatch.index - 60);
    var nearbyText = t.slice(windowStart, upgradeMatch.index);
    if (!CONFIRMED_ATTRIBUTION_MARKER_TERMS.test(nearbyText)) {
      reasons.push('lenguaje de "confirmado oficialmente" junto con lenguaje de reporte no confirmado -- confirmá que no se esté presentando un rumor como un hecho ya confirmado');
    }
  }
  return { hasRisk: reasons.length > 0, reasons: reasons };
}

// ============================================================================
// APORTE EDITORIAL VERIFICABLE (pedido de Leonardo, 2026-09-24, punto 3/2 del
// documento de AdSense/editorial)
// ============================================================================
// Deliberadamente NO confía en que la IA declare sus propios elementos
// (aiDeclared es de referencia únicamente, para completar los campos de
// texto libre) -- el conteo de "elementos con evidencia" que decide si el
// artículo puede llegar a "listo" se calcula SIEMPRE escaneando el cuerpo
// real en busca de un patrón concreto para cada uno de los 10 elementos del
// documento. Igual que el resto de los heurísticos de este archivo: palabras
// clave, no comprensión semántica real -- puede haber falsos negativos
// (un artículo que sí tiene el elemento pero con otra redacción), nunca la
// intención es bloquear con esto, solo enviar a revisión humana cuando no se
// pudo confirmar un mínimo de 3.
var EDITORIAL_VALUE_ELEMENT_DETECTORS = [
  ['historical-context', 'contexto histórico', /\b(since \d{4}|dates back to|has a history of|originally (?:launched|founded|introduced)|first (?:introduced|launched|appeared) in \d{4}|for (?:years|decades)|previously (?:known as|launched|announced))\b/i],
  ['timeline', 'cronología', function (body) {
    // Corrección de Leonardo, ronda 1 (2026-09-27, "encabezados aislados no
    // cuentan"): un subtítulo "## Timeline"/"## A Brief History" solo, sin
    // ningún año real debajo, ya no alcanza por sí solo.
    // Corrección de Leonardo, ronda 2 (2026-09-27): exigir SOLO 2 años
    // distintos era demasiado estricto en la otra dirección -- una
    // cronología real puede tener varios hechos del mismo año, o incluso
    // del mismo día. Ahora cuenta CUALQUIERA de estas vías, cada una
    // atada a un hecho concreto real (nunca un marcador de secuencia
    // solo, sin nada alrededor):
    var text = String(body || '');

    // Vía 1 (la de antes, sigue siendo válida sola): 2+ años distintos.
    var years = text.match(/\b(19|20)\d{2}\b/g) || [];
    if (new Set(years).size >= 2) return true;

    // Vía 2: 2+ fechas completas distintas (mes + día) -- cubre dos
    // hechos concretos del MISMO año ("September 12" / "September 26").
    var fullDates = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi) || [];
    var distinctFullDates = new Set(fullDates.map(function (d) {
      return d.toLowerCase().replace(/\s+/g, ' ').replace(/(st|nd|rd|th)\b/, '').trim();
    }));
    if (distinctFullDates.size >= 2) return true;

    // Vía 3: 2+ horas/momentos del día distintos -- cubre una secuencia
    // real dentro del MISMO día ("9 a.m." ... "3 p.m.").
    var clockTimes = text.match(/\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)\b/gi) || [];
    var distinctClockTimes = new Set(clockTimes.map(function (t) { return t.toLowerCase().replace(/\s+/g, ''); }));
    if (distinctClockTimes.size >= 2) return true;

    // Vía 4: 2+ marcadores secuenciales reales ("first"/"then"/"later"/
    // "afterward"/"subsequently"/"next"), cada uno seguido de una
    // cláusula con contenido real (>=4 palabras con letras) -- así
    // "then." o "later," sueltos, sin ningún hecho, NUNCA cuentan.
    var sequentialMarkerRe = /\b(first|then|later|afterward|afterwards|subsequently|following that|next)\b([^.!?\n]{0,140})/gi;
    var substantiveMarkerHits = 0;
    var m;
    while ((m = sequentialMarkerRe.exec(text)) !== null) {
      var clauseWords = (m[2] || '').trim().split(/\s+/).filter(function (w) { return /[a-zA-Z]{3,}/.test(w); });
      if (clauseWords.length >= 4) substantiveMarkerHits++;
    }
    return substantiveMarkerHits >= 2;
  }],
  ['comparison', 'comparación con productos/hechos/anuncios anteriores', /\b(compared (?:to|with)|unlike (?:its|the)|versus|\bvs\.?\b|similar to (?:its|the)|in contrast to|whereas)\b/i],
  ['consequences', 'consecuencias para usuarios o industria', /\b(this means (?:for|that)|as a result,|could (?:mean|lead to|affect|impact)|likely to (?:affect|impact|change)|implications for|affects? (?:users|customers|the industry|developers|consumers))\b/i],
  ['limitations', 'limitaciones e incertidumbres', /\b(however,|it'?s (?:still )?unclear|remains unclear|has not (?:confirmed|disclosed|specified)|no word on|yet to (?:confirm|disclose|specify))\b/i],
  ['confirmed-vs-reported', 'contraste real entre algo confirmado y algo reportado/incierto (nunca una atribución aislada)', function (body) {
    // Corrección de Leonardo, ronda 2 (2026-09-27): una atribución aislada
    // ("the organizers announced", "officials confirmed", "the company
    // said") es solo procedencia de la afirmación -- por sí sola NO
    // demuestra que el artículo distinga algo confirmado de algo apenas
    // reportado. La ampliación de verbos de atribución (ronda 1) se
    // conserva para CONFIRMED_ATTRIBUTION_MARKER_TERMS (atribución/
    // transparencia/keyClaims), pero este elemento ahora exige evidencia
    // de AMBOS lados del contraste dentro del MISMO párrafo (el mismo
    // bloque de prosa que separa un blanco, ver formato del cuerpo en
    // admin/draft.js): una afirmación confirmada oficialmente Y otra
    // identificada como reportada/no confirmada/preliminar/incierta.
    var confirmedTerm = /\b(confirmed|confirms?|officially confirmed|has (?:now )?confirmed)\b/i;
    var reportedUnconfirmedTerm = /\b(reportedly|reported that|only reported|remains unconfirmed|not (?:yet )?(?:officially )?confirmed|has not (?:yet )?(?:been )?confirmed|has not confirmed|unconfirmed|preliminary|yet to be confirmed|still unclear whether|rumor(?:ed|s)?|understood to be|believed to be|according to unconfirmed)\b/i;
    var paragraphs = String(body || '').split(/\n\s*\n/);
    return paragraphs.some(function (p) { return confirmedTerm.test(p) && reportedUnconfirmedTerm.test(p); });
  }],
  ['technical-explanation', 'explicación técnica en lenguaje sencillo', /\b(in simple terms,|put simply,|essentially,|to put it another way,|works by|is a type of|refers to)\b/i],
  ['us-availability', 'disponibilidad específica para Estados Unidos', /\b(in the (?:us|u\.s\.|united states)|available (?:in|to) (?:the )?(?:us|u\.s\.|united states|american)|u\.s\. (?:pricing|availability|release)|american (?:users|customers))\b/i],
  ['what-to-watch', 'próximos pasos / qué observar', /\b(next steps?|what('?s| is) next|going forward,|expected to (?:launch|arrive|roll out) (?:in|by|next)|will (?:be )?(?:available|announced|released) (?:in|next|later))\b/i],
  ['comparative-list', 'tabla o lista comparativa', function (body) {
    var bulletLines = (body.match(/^- .+$/gm) || []).length;
    return bulletLines >= 3;
  }]
];

// aiDeclared (opcional): lo que la propia IA dijo en editorialValueClaims al
// redactar (ver admin/draft.js) -- SOLO se usa para completar whatHappened/
// whyItMatters/confirmed/uncertain/whatToWatch (texto libre, no verificable
// mecánicamente palabra por palabra); el conteo de elements/meetsMinimum
// ignora por completo lo que la IA haya declarado y mide directo sobre body.
function computeEditorialValue(article, aiDeclared) {
  var body = String((article && article.body) || '');
  var elements = [];
  EDITORIAL_VALUE_ELEMENT_DETECTORS.forEach(function (d) {
    var hasEvidence = typeof d[2] === 'function' ? d[2](body) : d[2].test(body);
    if (hasEvidence) elements.push({ key: d[0], label: d[1] });
  });
  var declared = aiDeclared || {};
  var confirmed = Array.isArray(declared.confirmed) ? declared.confirmed.filter(Boolean).map(String) : [];
  var uncertain = Array.isArray(declared.uncertain) ? declared.uncertain.filter(Boolean).map(String) : [];
  var whatToWatch = Array.isArray(declared.whatToWatch) ? declared.whatToWatch.filter(Boolean).map(String) : [];
  return {
    elements: elements.map(function (e) { return e.key; }),
    elementLabels: elements.map(function (e) { return e.label; }),
    elementCount: elements.length,
    meetsMinimum: elements.length >= 3,
    whatHappened: String(declared.whatHappened || '').trim(),
    whyItMatters: String(declared.whyItMatters || '').trim(),
    confirmed: confirmed,
    uncertain: uncertain,
    whatToWatch: whatToWatch
  };
}

// ============================================================================
// CALIDAD DE REDACCIÓN POSTERIOR -- pedido de Leonardo, 2026-09-27, punto 5
// (hallazgo real: borrador de Yahoo Sports fantasy, 359 palabras, 0
// subtítulos, 0 atribuciones enlazadas, "his teammate" sin identificar).
// Distinta de computeEditorialValue() (que mide CONTENIDO/profundidad):
// esto mide FORMA -- si la IA respetó las reglas estructurales del prompt
// (largo, subtítulos, atribución enlazada, sin repetirse, sin referencias
// colgadas) -- independiente de cuántos elementos editoriales haya logrado
// desarrollar. Nunca reintenta, nunca gasta otra llamada de IA: solo arma
// un motivo legible y medible para que el borrador quede en revisión con
// evidencia concreta, nunca un genérico "mala redacción".
var WRITING_QUALITY_MIN_WORDS = 600;
var WRITING_QUALITY_MIN_SUBHEADINGS = 3;
var SELF_REPETITION_DICE_THRESHOLD = 0.5;
var AMBIGUOUS_UNNAMED_RELATION = /\b(his|her|their)\s+(teammate|co-star|co-founder|colleague|counterpart)s?\b/i;
// Un nombre real (dos palabras Con Mayúscula seguidas) que NO esté al
// principio de la oración -- al principio, la mayúscula es solo la regla de
// puntuación normal ("The Cardinals' passing game...") y no identifica a
// nadie; exigir al menos una palabra antes descarta ese falso positivo sin
// dejar de reconocer un nombre real más adelante en la misma oración (ver
// test-writing-quality-validation.js para los casos límite verificados a
// mano: "Marvin Harrison Jr." sí cuenta, "The Cardinals" no).
var NAME_NOT_AT_SENTENCE_START = /\S+\s+([A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+)/;

// Divide en oraciones SIN el filtro de longitud mínima de splitSentences()
// (esa función, más arriba, está pensada para comparar contra un texto
// FUENTE externo -- acá interesa cualquier oración del propio cuerpo,
// incluso corta, para no perderse un "his teammate." como oración de cierre).
function splitAnySentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// Referencia colgada: "his/her/their teammate/co-star/..." sin que la MISMA
// oración identifique de quién se trata. Deliberadamente estrecho (solo este
// patrón, no "experts"/"reports indicate" genéricos) -- eso ya lo cubre por
// separado hasAttributionLinks: un "experts say" sin link ya se marca como
// "sin atribuciones enlazadas", no hace falta contarlo dos veces acá.
function detectAmbiguousReferences(body) {
  var sentences = splitAnySentences(body);
  var found = [];
  sentences.forEach(function (s) {
    var m = s.match(AMBIGUOUS_UNNAMED_RELATION);
    if (m && !NAME_NOT_AT_SENTENCE_START.test(s)) found.push(m[0]);
  });
  return found;
}

// Repetición excesiva: dos oraciones del propio cuerpo que dicen
// prácticamente lo mismo con casi el mismo orden de palabras (reutiliza
// bigrams()/diceCoefficient(), ya calibrados a mano para maxSentenceSimilarity
// -- 0.10-0.15 en una reescritura genuina, 0.8+ en un parafraseo perezoso).
// A propósito NO detecta la repetición TEMÁTICA (la misma idea general
// reformulada con estructura distinta en cada párrafo) -- eso lo mide
// computeEditorialValue() por separado (pocos elementos editoriales reales),
// nunca hace falta duplicarlo acá con una heurística léxica que además sería
// mucho menos confiable para ese caso.
function detectExcessiveSelfRepetition(body) {
  var sentences = splitSentences(body);
  for (var i = 0; i < sentences.length; i++) {
    for (var j = i + 1; j < sentences.length; j++) {
      var d = diceCoefficient(bigrams(sentences[i]), bigrams(sentences[j]));
      if (d >= SELF_REPETITION_DICE_THRESHOLD) {
        return { found: true, sentenceA: sentences[i], sentenceB: sentences[j], score: d };
      }
    }
  }
  return { found: false };
}

// Une una lista de frases en español de forma natural ("a, b y c") para el
// motivo combinado -- nunca una sola coma final rara ("a, b, y c" tampoco:
// se sigue la convención sin coma de Oxford del resto de los textos en
// español de este archivo).
function joinReasonsNaturally(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' y ' + parts[parts.length - 1];
}

// aiCallMeta (opcional): lo que draft.js pudo leer de la respuesta real de
// la API (ver buildAiCallMeta en admin/draft.js) -- SOLO se usa acá para el
// caso de truncamiento (nunca se publica, nunca decide nada más por sí
// solo). Pedido 2026-09-27, punto 5, último ítem: "respuesta truncada ->
// revisión, sin reintento".
function validateDraftWritingQuality(article, aiCallMeta) {
  var body = String((article && article.body) || '');
  var wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  var subheadingCount = (body.match(/^## (.+)$/gm) || []).length;
  var hasAttributionLinks = /<a\s+href=/i.test(body);
  var repetition = detectExcessiveSelfRepetition(body);
  var ambiguousReferences = detectAmbiguousReferences(body);
  var truncated = !!(aiCallMeta && aiCallMeta.truncated);

  var reasonParts = [];
  if (wordCount < WRITING_QUALITY_MIN_WORDS) reasonParts.push(wordCount + ' palabras');
  if (subheadingCount < WRITING_QUALITY_MIN_SUBHEADINGS) reasonParts.push(subheadingCount + ' subtítulos');
  if (!hasAttributionLinks) reasonParts.push('sin atribuciones enlazadas');
  if (repetition.found) reasonParts.push('repetición excesiva de una misma oración');
  if (ambiguousReferences.length) reasonParts.push('referencia ambigua: \'' + ambiguousReferences[0] + '\'');
  if (truncated) reasonParts.push('la respuesta de la IA se cortó (truncada) antes de terminar');

  var passes = reasonParts.length === 0;
  return {
    wordCount: wordCount,
    subheadingCount: subheadingCount,
    hasAttributionLinks: hasAttributionLinks,
    excessiveRepetition: repetition.found,
    ambiguousReferences: ambiguousReferences,
    truncated: truncated,
    passes: passes,
    summary: passes ? null : ('Redacción incompleta: ' + joinReasonsNaturally(reasonParts) + '.')
  };
}

function classifyDraft(d, allArticles) {
  d = d || {};
  var text = [d.title, d.dek, d.sourceTitle, d.sourceHeadline, d.body, d.sourceUrl, d.sourceDomain].filter(Boolean).join(' . ');
  var promo = detectPromotionalLanguage(text);
  var deadline = isDeadlinePassed(text);
  var categoryNotAllowed = EXCLUDED_NEW_DRAFT_CATEGORIES.has(d.category);
  var sensitive = detectSensitiveEditorialTopics(text);
  var transparencyRisk = detectTransparencyRisk(text);
  // editorialValue: se muestra siempre que se pueda calcular (para que
  // admin.js tenga algo que mostrar en "Aporte editorial: N/10" incluso
  // para un artículo hecho a mano), pero el GATE que puede impedir "listo"
  // (insufficientEditorialValue) solo se activa cuando el propio borrador
  // ya trae `editorialValue` precalculado por fetchNewDrafts -- es decir,
  // pasó por el pipeline nuevo de verdad. Mismo criterio que ya usa este
  // archivo para similarityScore/similarityWarning más abajo (typeof
  // article.similarityScore === 'number' antes de aplicar esa regla):
  // nunca penaliza retroactivamente un artículo viejo, un borrador hecho a
  // mano, o un fixture de test anterior a este cambio, que nunca tuvo la
  // oportunidad de declarar sus propios elementos editoriales.
  var editorialValue = d.editorialValue || computeEditorialValue(d, null);
  var insufficientEditorialValue = !!(d.editorialValue && !d.editorialValue.meetsMinimum);
  // Calidad de redacción posterior (pedido 2026-09-27, punto 5) -- MISMO
  // criterio de "opt-in" que insufficientEditorialValue de arriba: se
  // muestra siempre que se pueda calcular (admin.js puede mostrar el motivo
  // en cualquier borrador), pero el GATE que puede impedir "listo" solo se
  // activa cuando el borrador ya trae `writingQuality` precalculado por
  // fetchNewDrafts() -- nunca penaliza retroactivamente un borrador viejo,
  // uno cargado a mano, o un fixture de test anterior a este cambio.
  var writingQuality = d.writingQuality || validateDraftWritingQuality(d, null);
  var insufficientWritingQuality = !!(d.writingQuality && !d.writingQuality.passes);
  var singleSource = !!d.singleSourceWarning || (Array.isArray(d.additionalSources) && d.additionalSources.length === 0);
  var rumorWithoutCorroboration = singleSource && RUMOR_LANGUAGE_TERMS.test(String(d.body || ''));
  // Hallazgo real de Leonardo (2026-09-20, borrador de IGN "...Lowest
  // Price Ever at Amazon Resale"): título+resumen+cuerpo+URL+medio, todo
  // junto -- ver detectCommercialDeal() más arriba en este archivo.
  var commercialDeal = detectCommercialDeal(text, d.sourceUrl);
  var sourceInvalid = !d.sourceUrl || !/^https?:\/\//i.test(d.sourceUrl);
  // Duplicado/contradicción grave: opt-in vía el segundo parámetro (ver
  // findMostSimilarPublished/findGraveContradiction arriba) -- server.js
  // lo pasa en GET /api/drafts; un llamado con un solo argumento (como ya
  // hacían las pruebas existentes) sigue dando isDuplicate:false /
  // hasGraveContradiction:false, sin cambio de comportamiento.
  var duplicateMatch = allArticles ? findMostSimilarPublished(d.title, d.dek, allArticles) : null;
  var isDuplicate = !!duplicateMatch;
  var contradictionMatch = allArticles ? findGraveContradiction(d.title, d.dek, d.body, allArticles) : null;
  var hasGraveContradiction = !!contradictionMatch;

  var reasons = [];
  // Este va primero a propósito: admin.js arma el texto visible como
  // '⛔ Recomendación: descartar — ' + reasons.join(' '), así que con esto
  // primero el mensaje en pantalla queda literalmente "Recomendación:
  // descartar — oferta comercial o precio temporal (...)" (requisito 4).
  if (commercialDeal.isCommercialDeal) reasons.push('oferta comercial o precio temporal (' + commercialDeal.matchedTerms.slice(0, 4).join(', ') + ') -- no tiene valor editorial duradero, es un precio que puede cambiar en horas.');
  if (promo.isPromotional) reasons.push('Lenguaje promocional/CTA detectado (' + promo.matchedTerms.slice(0, 3).join(', ') + ').');
  if (deadline.expired) reasons.push('El plazo/fecha mencionado en el texto ya pasó (' + deadline.raw + ').');
  if (categoryNotAllowed) reasons.push('Categoría "' + d.category + '" no se ofrece para noticias nuevas (ver auditoría 2026-09-13) -- este borrador es previo a esa regla.');
  if (isDuplicate) reasons.push('Se parece demasiado a un artículo ya publicado ("' + duplicateMatch.article.title + '") -- posible duplicado.');
  if (hasGraveContradiction) reasons.push('Contradice en lenguaje a un artículo ya publicado sobre el mismo tema ("' + contradictionMatch.title + '") -- confirmá cuál versión está vigente.');
  if (d.similarityWarning) reasons.push('Similaridad alta con el resumen de la fuente original (' + (d.similarityScore || 0) + '%) -- revisar antes de aprobar.');
  if (d.genericHeadingWarning) reasons.push('Tiene un subtítulo genérico de cierre -- señal de relleno de bajo valor.');
  if (singleSource) reasons.push('Solo hay una fuente confirmando esta historia -- no se agregó una segunda a propósito, para no inventarla; si conocés una fuente real que la corrobore, agregala a mano.');
  if (rumorWithoutCorroboration) reasons.push('El texto usa lenguaje de reporte no confirmado ("reportedly"/"rumor"/etc.) con una sola fuente -- confirmá que esa fuente no sea el propio comunicado de la empresa presentándolo como un hecho ya confirmado.');
  // Contenido sensible (punto 8 del pedido 2026-09-24): nunca descarta por sí
  // solo -- ver HACKING_INSTRUCTION_TERMS aparte, dos líneas abajo, para el
  // único caso que sí es un bloqueo real.
  if (sensitive.isSensitive) reasons.push('Revisión humana obligatoria: ' + sensitive.reasons.join(', ') + '.');
  if (sensitive.hackingInstructions) reasons.push('Contenido bloqueado: el texto parece instruir acceso no autorizado, fraude o malware -- esto no se ofrece ni para revisión manual, se descarta directamente.');
  if (transparencyRisk.hasRisk) reasons.push('Revisión humana obligatoria: ' + transparencyRisk.reasons.join('; ') + '.');
  if (insufficientEditorialValue) reasons.push('Aporte editorial insuficiente (' + editorialValue.elementCount + '/10 elementos con evidencia identificable en el cuerpo) -- necesita al menos 3 para poder quedar "listo".');
  // Calidad de redacción posterior (pedido 2026-09-27, punto 5): motivo
  // concreto y medible, nunca genérico -- writingQuality.summary ya viene
  // armado con los números reales (ver validateDraftWritingQuality). El
  // puntaje técnico (editorialReadinessScore, más abajo) NUNCA se toca por
  // esto -- Leonardo fue explícito: "no cambies el puntaje técnico para
  // ocultar estas fallas", solo debe afectar el estado final y el motivo.
  if (insufficientWritingQuality) reasons.push(writingQuality.summary);

  var blocking = promo.isPromotional || deadline.expired || commercialDeal.isCommercialDeal || isDuplicate || hasGraveContradiction || sensitive.hackingInstructions;
  var recommendation = (blocking || categoryNotAllowed) ? 'descartar' : ((d.similarityWarning || d.genericHeadingWarning || singleSource || sensitive.isSensitive || transparencyRisk.hasRisk || insufficientEditorialValue || insufficientWritingQuality) ? 'revisar' : 'crear');

  var readiness = computeEditorialReadiness(d, {
    commercialDeal: commercialDeal.isCommercialDeal,
    expired: deadline.expired,
    isDuplicate: isDuplicate,
    sourceInvalid: sourceInvalid,
    singleSource: singleSource,
    rumorWithoutCorroboration: rumorWithoutCorroboration,
    categoryNotAllowed: categoryNotAllowed
    // A propósito NO se le pasa nada de sensible/transparencia/aporte
    // editorial acá: el pedido es explícito ("no reducir el puntaje
    // artificialmente") -- estas tres señales solo pueden mover
    // readinessTier (abajo), nunca editorialReadinessScore.
  });
  // "Listo para revisión rápida" exige puntaje alto Y cero advertencias --
  // un puntaje de 85 con una sola fuente sigue siendo "revisar" (regla 6
  // del pedido original), y lo mismo aplica ahora a un tema sensible, un
  // riesgo de transparencia o un aporte editorial insuficiente: nunca
  // "listo" aunque el puntaje sea 100 (pedido 2026-09-24, punto 1 y 2).
  var hasWarningsOnly = singleSource || rumorWithoutCorroboration || !!d.similarityWarning || !!d.genericHeadingWarning ||
    sensitive.isSensitive || transparencyRisk.hasRisk || insufficientEditorialValue || insufficientWritingQuality;
  var hardBlockedForReadiness = blocking || categoryNotAllowed || sourceInvalid;
  var readinessTier = hardBlockedForReadiness ? 'descartar' : ((readiness.score >= 80 && !hasWarningsOnly) ? 'listo' : 'revisar');

  return {
    promotional: promo.isPromotional || commercialDeal.isCommercialDeal,
    promotionalTerms: promo.matchedTerms,
    commercialDeal: commercialDeal.isCommercialDeal,
    commercialDealTerms: commercialDeal.matchedTerms,
    priceVolatile: commercialDeal.priceVolatile,
    expired: deadline.expired,
    expiredDeadline: deadline.raw || null,
    categoryNotAllowed: categoryNotAllowed,
    isDuplicate: isDuplicate,
    duplicateOf: duplicateMatch ? duplicateMatch.article.title : null,
    hasGraveContradiction: hasGraveContradiction,
    sourceCount: d.sourceCount || 1,
    singleSource: singleSource,
    rumorWithoutCorroboration: rumorWithoutCorroboration,
    // Fase de corroboración previa a la redacción (pedido de Leonardo,
    // 2026-09-20; renombrado + recálculo completo en cada corrida
    // 2026-09-21): se pasa tal cual desde el borrador guardado -- lo pone
    // buildCandidates()/findAdditionalSourceForDraft() cuando la búsqueda
    // de segunda fuente SÍ encontró un candidato de contenido parecido
    // pero lo tuvo que descartar por ser del mismo dominio/grupo que la
    // fuente principal (nunca por no encontrar nada). admin.js lo usa para
    // mostrar el motivo exacto en vez de un "solo una fuente" genérico
    // cuando en realidad SÍ hubo un intento real (requisito 15). Es una
    // ADVERTENCIA de capa 1, siempre distinta de una corroboración real
    // (additionalSources.length > 0) y que NUNCA suma ni resta puntaje en
    // computeEditorialReadiness -- ver el contrato completo del campo
    // antes de findCorroborationForItem, en la sección de corroboración.
    sameDomainMatchWarning: !!d.sameDomainMatchWarning,
    // Contenido sensible / transparencia / aporte editorial (pedido
    // 2026-09-24) -- admin.js los usa para mostrar "Revisión humana
    // obligatoria: [motivo]" y "Aporte editorial: N/10 elementos
    // detectados" en la ficha. Ninguno de los tres resta puntaje ni
    // descarta por sí solo (salvo sensitiveBlocked, ver arriba).
    sensitiveTopics: sensitive.categories,
    sensitiveReasons: sensitive.reasons,
    sensitiveBlocked: sensitive.hackingInstructions,
    transparencyRisk: transparencyRisk.hasRisk,
    transparencyReasons: transparencyRisk.reasons,
    editorialValue: editorialValue,
    insufficientEditorialValue: insufficientEditorialValue,
    // Calidad de redacción posterior (pedido 2026-09-27, punto 5) -- admin.js
    // usa writingQuality.summary para mostrar "Motivo: Redacción incompleta:
    // ..." con los números reales, igual que ya hace con aporte editorial.
    writingQuality: writingQuality,
    insufficientWritingQuality: insufficientWritingQuality,
    recommendation: recommendation,
    // Bloqueante de verdad (impide "Usar este borrador" con la
    // recomendación de crear) vs. solo señal de que esta categoría no
    // debería haber salido de una búsqueda nueva -- ver comentario arriba.
    // Única fuente / lenguaje de rumor NUNCA bloquean el uso -- son
    // advertencias para la revisión humana (requisito 6 de la mejora
    // global), no un mecanismo automático que descarte una noticia real
    // solo por tener una fuente. Esto es INDEPENDIENTE del puntaje de
    // preparación editorial de abajo (ver readinessTier) -- admin.js
    // combina los dos para decidir si "Usar este borrador" queda
    // habilitado (nunca se debilitó este campo para agregar el puntaje).
    eligibleToUse: !blocking,
    reasons: reasons,
    trendsMode: 'rss-no-metrics',
    editorialReadinessScore: readiness.score,
    readinessReasons: readiness.reasons,
    readinessTier: readinessTier
  };
}

function discardDraft(slug) {
  var drafts = readJSON(DRAFTS_FILE, []);
  var discarded = readJSON(DISCARDED_FILE, []);
  var target = drafts.find(function (d) { return d.slug === slug; });
  var remaining = drafts.filter(function (d) { return d.slug !== slug; });
  writeJSON(DRAFTS_FILE, remaining);
  if (target && target.sourceUrl) {
    discarded.push(target.sourceUrl);
    writeJSON(DISCARDED_FILE, discarded);
  }
  return !!target;
}

// Cuando un borrador se "usa" (se carga en el formulario y se guarda como
// artículo real), lo sacamos de la lista de borradores.
function removeDraft(slug) {
  var drafts = readJSON(DRAFTS_FILE, []);
  var remaining = drafts.filter(function (d) { return d.slug !== slug; });
  var changed = remaining.length !== drafts.length;
  if (changed) writeJSON(DRAFTS_FILE, remaining);
  return changed;
}

// ============================================================================
// LICENCIAS Y PROCEDENCIA DE IMAGEN — protección permanente del panel
// (auditoría forense de imágenes, 2026-09-11/12)
// ============================================================================
// isAuthorizedImageLicense() delega en admin/image-licenses.js -- ESA es la
// única lista de valores de 'imageLicense' autorizados (ver ese archivo
// para el detalle e historial). 'pendiente-de-verificar' (la que
// downloadDraftImage() le pone a una imagen bajada tal cual de la fuente
// RSS, más arriba en este archivo) NUNCA está autorizada a propósito --
// una imagen de RSS es solo referencia privada para el borrador hasta que
// alguien la revise a mano y elija/cargue una imagen autorizada antes de
// publicar.
function isAuthorizedImageLicense(license) {
  return imageLicenses.isKnownLicense(license);
}

// Extensión real (magic bytes) de un archivo -- para detectar que la
// extensión del nombre no corresponde al contenido real (ej. un .jpg que
// en realidad es un PNG con la extensión cambiada a mano).
function detectRealImageFormat(buffer) {
  if (buffer.length >= 8 && buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) return 'gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

var EXT_TO_FORMAT = { '.jpg': 'jpg', '.jpeg': 'jpg', '.jfif': 'jpg', '.png': 'png', '.gif': 'gif', '.webp': 'webp' };

var MAX_PUBLISHED_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB -- por debajo del límite de carga del panel (8 MB), a propósito: acá se valida la imagen YA guardada en disco, que después de convertirse/optimizarse debería pesar bastante menos que el límite de subida.
var MIN_IMAGE_WIDTH = 600;
var MIN_IMAGE_HEIGHT = 315; // ~1.91:1, el mínimo recomendado para que una imagen sirva de og:image en tarjetas de redes sociales.

// Valida la imagen destacada de UN artículo contra todas las reglas de la
// auditoría de imágenes (protección permanente del panel, fase 3). No
// recibe la lista completa de artículos -- eso lo maneja
// validateImageReuse() por separado, porque necesita compararse contra
// TODOS los demás. Devuelve un array de { field, message } -- vacío si
// no hay ningún problema. article.image vacío/ausente NUNCA genera un
// problema acá (fallback del sitio explícitamente permitido, ver
// generateArticleFile()/bannerHtmlFor en pagegen.js y generate_pages.py).
function validateImageFields(article) {
  var issues = [];
  if (!article || !article.image) return issues;

  var license = article.imageLicense;
  var normalizedLicense = imageLicenses.normalizeLicense(license);

  // La imagen está ubicada en drafts o en una ruta temporal -- una
  // imagen de img/drafts/ es, por definición, una referencia de
  // borrador todavía no revisada (ver downloadDraftImage() más arriba);
  // no debe llegar a una página pública.
  if (/^img\/drafts\//.test(article.image)) {
    issues.push({ field: 'image', message: 'La imagen está en img/drafts/ (ruta temporal de borrador, nunca autorizada para una página pública).' });
  }

  // Hotlink externo: 'image' siempre debe ser una ruta local del sitio
  // (img/...), nunca una URL http(s) directa a otro servidor.
  if (/^https?:\/\//i.test(article.image)) {
    issues.push({ field: 'image', message: 'La imagen es un link externo (hotlink) -- tiene que estar subida/generada dentro del sitio (ruta img/...), no enlazada directo a otro servidor.' });
  }

  // Procedencia no definida.
  if (!article.imageOrigin) {
    issues.push({ field: 'imageOrigin', message: 'Falta declarar el origen de la imagen (imageOrigin).' });
  }

  // Licencia no autorizada.
  if (!imageLicenses.isKnownLicense(license)) {
    issues.push({ field: 'imageLicense', message: 'La licencia "' + (license || '(vacía)') + '" no está en la lista autorizada.' });
  }

  // Atribución obligatoria para licencias que la requieren -- nunca
  // "Encontrada en Google"/"RSS"/"prensa"/"Internet" como fuente.
  if (imageLicenses.licenseRequiresAttribution(license)) {
    if (!article.imageCredit) {
      issues.push({ field: 'imageCredit', message: 'Esta licencia exige un crédito/atribución visible y no tiene ninguno cargado.' });
    }
    if (!article.imageSourceUrl && !article.imageSource) {
      issues.push({ field: 'imageSourceUrl', message: 'Esta licencia exige URL de la fuente y no tiene ninguna cargada.' });
    }
    var attributionText = article.imageSource || article.imageSourceUrl || '';
    if (attributionText && imageLicenses.INVALID_ATTRIBUTION_SOURCES.test(String(attributionText).trim())) {
      issues.push({ field: 'imageSource', message: '"' + attributionText + '" no es una fuente válida de atribución (encontrado en un buscador o en un feed RSS no cuenta como permiso de uso).' });
    }
  }

  // Archivo físico: existe, extensión/MIME coherente, peso, dimensiones.
  // No aplica a rutas ya marcadas como hotlink (arriba) -- ahí no hay
  // nada que leer en disco.
  if (!/^https?:\/\//i.test(article.image)) {
    var fullPath = path.join(ROOT_DIR, article.image);
    var stat = null;
    try { stat = fs.statSync(fullPath); } catch (e) { stat = null; }
    if (!stat) {
      issues.push({ field: 'image', message: 'El archivo de la imagen no existe físicamente en el sitio (' + article.image + ').' });
    } else {
      if (stat.size > MAX_PUBLISHED_IMAGE_BYTES) {
        issues.push({ field: 'image', message: 'La imagen pesa ' + Math.round(stat.size / 1024) + ' KB, más del máximo permitido (' + Math.round(MAX_PUBLISHED_IMAGE_BYTES / 1024) + ' KB).' });
      }
      var ext = path.extname(article.image).toLowerCase();
      var expectedFormat = EXT_TO_FORMAT[ext];
      if (!expectedFormat) {
        issues.push({ field: 'image', message: 'Extensión de archivo no reconocida (' + ext + ').' });
      } else {
        try {
          var buffer = fs.readFileSync(fullPath);
          var realFormat = detectRealImageFormat(buffer);
          if (realFormat && realFormat !== expectedFormat) {
            issues.push({ field: 'image', message: 'La extensión del archivo (' + ext + ') no corresponde con su contenido real (parece ' + realFormat + ').' });
          }
          var dims = readImageDimensions(buffer);
          if (dims && (dims.width < MIN_IMAGE_WIDTH || dims.height < MIN_IMAGE_HEIGHT)) {
            issues.push({ field: 'image', message: 'La imagen mide ' + dims.width + 'x' + dims.height + 'px, por debajo del mínimo (' + MIN_IMAGE_WIDTH + 'x' + MIN_IMAGE_HEIGHT + 'px).' });
          }
        } catch (e) { /* no se pudo leer/decodificar -- no se bloquea por un falso positivo de esta sección puntual */ }
      }
    }
  }

  // Metadatos contradictorios.
  if (normalizedLicense === 'ai-generated-commercial-use') {
    if (article.imageOrigin && article.imageOrigin !== 'ai-generated') {
      issues.push({ field: 'imageOrigin', message: 'La licencia dice "ai-generated-commercial-use" pero imageOrigin es "' + article.imageOrigin + '" (debería ser "ai-generated").' });
    }
    if (article.imageSourceUrl) {
      issues.push({ field: 'imageSourceUrl', message: 'Una imagen generada con IA no debería tener una URL de fuente externa cargada.' });
    }
    // Procedencia técnica demostrable (pedido de Leonardo, 2026-09-24,
    // punto 7): "ai-generated-commercial-use" es justamente la licencia
    // que SÍ se puede volver a demostrar más adelante (ver el historial al
    // principio de admin/image-licenses.js) -- exige tener registrados
    // modelo, fecha de generación y prompt. Si falta alguno, la licencia
    // reclamada no está respaldada por evidencia real; para ese caso ya
    // existe la licencia hermana "owner-attested-ai-generated" (atestiguada
    // por el dueño, sin el detalle técnico). No aplica a artículos viejos
    // que ya usaban otra licencia -- esto solo bloquea un reclamo nuevo de
    // "ai-generated-commercial-use" sin evidencia, nunca migra nada.
    if (!article.imageModel || !article.imageGeneratedAt || !article.imagePrompt) {
      issues.push({ field: 'imageModel', message: 'La licencia "ai-generated-commercial-use" exige procedencia técnica completa (modelo, fecha de generación y prompt) -- si no se puede demostrar, usar "owner-attested-ai-generated" en su lugar.' });
    }
  }
  if (article.imageGeneratedAt) {
    var genTime = Date.parse(article.imageGeneratedAt);
    if (!isNaN(genTime) && genTime > Date.now()) {
      issues.push({ field: 'imageGeneratedAt', message: 'La fecha de generación está en el futuro.' });
    }
  }
  if (article.imageOwnerAttestation != null && typeof article.imageOwnerAttestation !== 'boolean') {
    issues.push({ field: 'imageOwnerAttestation', message: 'imageOwnerAttestation debe ser true/false, no "' + article.imageOwnerAttestation + '".' });
  }
  if (article.imageHumanEdited != null && typeof article.imageHumanEdited !== 'boolean') {
    issues.push({ field: 'imageHumanEdited', message: 'imageHumanEdited debe ser true/false, no "' + article.imageHumanEdited + '".' });
  }

  return issues;
}

// Reutilización del mismo archivo de imagen en artículos distintos, sin
// autorización expresa (article.imageReuseAuthorized === true) -- ej. una
// imagen institucional propia de VexlowHQ que sí se puede repetir a
// propósito. Necesita la lista completa para comparar contra todos los
// demás artículos, por eso es una función aparte de validateImageFields().
function validateImageReuse(article, allArticles) {
  if (!article || !article.image || article.imageReuseAuthorized === true) return [];
  var usedElsewhere = (allArticles || []).some(function (other) {
    return other !== article && other.image === article.image && other.slug !== article.slug;
  });
  if (usedElsewhere) {
    return [{ field: 'image', message: 'Esta imagen ya se usa en otro artículo (' + article.image + '). Si es intencional (ej. una imagen institucional propia), marcá imageReuseAuthorized: true.' }];
  }
  return [];
}

// Validación completa de imagen de UN artículo (campos + reutilización).
function validateImagePublication(article, allArticles) {
  return validateImageFields(article).concat(validateImageReuse(article, allArticles || []));
}

// Un artículo sin imagen no tiene nada que bloquear (es la categoría
// "sin imagen" del inventario, perfectamente válida -- la excepción de
// fallback documentada de la fase 3 es, estructuralmente, la ausencia
// misma del campo "image": ver isImagePublishBlocked()). Se mantiene esta
// función de compatibilidad (usa solo validateImageFields, sin el chequeo
// de reutilización que necesita la lista completa) para quien ya la
// llamaba con un solo artículo.
function isImagePublishBlocked(article) {
  if (!article || !article.image) return false;
  return validateImageFields(article).length > 0;
}

// ============================================================================
// CONTROLES EDITORIALES PARA ARTÍCULOS NUEVOS (fase 5 de la protección
// permanente del panel, 2026-09-12)
// ============================================================================
// IMPORTANTE -- alcance deliberado: estas reglas son más estrictas que las
// que cumplía el sitio HISTÓRICAMENTE (ej. 6 de los 169 artículos actuales
// no tienen sourceUrl cargado, de antes de que esto se exigiera). Aplicarlas
// contra TODO articulos.json en cada guardado bloquearía cualquier cambio
// futuro por artículos viejos que nadie está tocando -- server.js las
// corre solo sobre artículos NUEVOS o MODIFICADOS en este guardado
// (isArticleNewOrChanged() de acá abajo), nunca contra el resto del sitio
// que ya estaba publicado. Se documenta así, explícitamente, en el informe
// de esta auditoría -- no es un descuido.
var GENERIC_TITLE_PATTERNS = [/^untitled$/i, /^sin t[íi]tulo$/i, /^test$/i, /^lorem ipsum/i, /^placeholder$/i, /^draft$/i, /^borrador$/i, /^article title$/i, /^news article$/i];
var PLACEHOLDER_PATTERNS = /\b(lorem ipsum|placeholder|TODO|TBD|FIXME|texto de ejemplo|contenido de ejemplo)\b/i;

function isValidIsoDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var t = Date.parse(value + 'T00:00:00Z');
  return !isNaN(t);
}

// Enlaces internos (href="algo.html" o similar) presentes en el cuerpo en
// texto simple de un artículo -- el formato de body usa Markdown liviano
// (ver parseBody en pagegen.js), así que los únicos links posibles ahí
// son HTML crudo que alguien pegó a mano ("<a href=...>"). Devuelve las
// rutas relativas encontradas (para chequear que no apunten a un archivo
// que no existe en el sitio).
function extractInternalLinks(body) {
  var links = [];
  var re = /<a\s[^>]*href="([^"]+)"/gi;
  var m;
  while ((m = re.exec(String(body || '')))) {
    var href = m[1];
    if (href && !/^https?:\/\//i.test(href) && !/^mailto:/i.test(href) && !/^#/.test(href)) links.push(href);
  }
  return links;
}

// Validación de contenido editorial de UN artículo nuevo/modificado.
// allArticles: TODOS los artículos ya guardados (para chequear slug
// duplicado, similitud e imagen reutilizada). Devuelve un array de
// { field, message }.
function validateArticleContent(article, allArticles) {
  var issues = [];
  var siteRoot = ROOT_DIR;

  // Título específico (no vacío, no genérico).
  var title = String(article.title || '').trim();
  if (!title) {
    issues.push({ field: 'title', message: 'Falta el título.' });
  } else if (GENERIC_TITLE_PATTERNS.some(function (re) { return re.test(title); })) {
    issues.push({ field: 'title', message: 'El título es un placeholder genérico ("' + title + '").' });
  }

  // Bajada (dek) original -- no vacía, no idéntica al título.
  var dek = String(article.dek || '').trim();
  if (!dek) {
    issues.push({ field: 'dek', message: 'Falta la bajada (dek).' });
  } else if (dek.toLowerCase() === title.toLowerCase()) {
    issues.push({ field: 'dek', message: 'La bajada es idéntica al título -- tiene que resumir algo más.' });
  }

  // Autor: VexlowHQ usa un único autor fijo en todo el sitio
  // (DEFAULT_AUTHOR en pagegen.js/generate_pages.py) -- no es un campo
  // por artículo, así que no puede "faltar" a nivel de datos; se
  // verifica igual que la constante no esté vacía, a modo de red de
  // seguridad si el día de mañana se vuelve un campo real.
  var DEFAULT_AUTHOR = 'Leonardo Beltran';
  if (!DEFAULT_AUTHOR.trim()) {
    issues.push({ field: 'author', message: 'Falta el autor (constante DEFAULT_AUTHOR vacía).' });
  }

  // Fecha válida, no futura.
  if (!isValidIsoDate(article.date)) {
    issues.push({ field: 'date', message: 'La fecha no es válida (formato esperado: AAAA-MM-DD).' });
  } else {
    var todayStr = todayISO();
    if (article.date > todayStr) {
      issues.push({ field: 'date', message: 'La fecha está en el futuro (' + article.date + ').' });
    }
  }

  // Categoría válida.
  var categories = listCategories();
  if (!article.category || !categories.some(function (c) { return c.slug === article.category; })) {
    issues.push({ field: 'category', message: 'La categoría "' + (article.category || '') + '" no existe.' });
  }

  // URL de fuente real.
  if (!article.sourceUrl || !/^https?:\/\//i.test(article.sourceUrl)) {
    issues.push({ field: 'sourceUrl', message: 'Falta una URL de fuente real (http/https).' });
  }

  // Cuerpo con contenido sustancial (no solo un resumen de RSS pegado
  // tal cual, no placeholders).
  var body = String(article.body || '');
  var wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;
  if (wordCount < 120) {
    issues.push({ field: 'body', message: 'El cuerpo tiene muy poco contenido (' + wordCount + ' palabras) para ser una nota sustancial.' });
  }
  if (PLACEHOLDER_PATTERNS.test(body) || PLACEHOLDER_PATTERNS.test(title) || PLACEHOLDER_PATTERNS.test(dek)) {
    issues.push({ field: 'body', message: 'El artículo contiene un placeholder sin completar (ej. "Lorem ipsum", "TODO", "TBD").' });
  }

  // Slug único (canonical único).
  var dupSlug = (allArticles || []).find(function (a) { return a !== article && a.slug === article.slug; });
  if (dupSlug) {
    issues.push({ field: 'slug', message: 'Ya existe otro artículo con el mismo slug ("' + article.slug + '").' });
  }

  // Similar a una publicación existente (mismo criterio de superposición
  // de palabras significativas que ya usa buildCandidates() más arriba
  // en este archivo para no redactar la misma historia dos veces --
  // acá se aplica también a lo escrito/pegado a mano en el panel).
  var words = significantWords(title + ' ' + dek);
  var tooSimilarTo = (allArticles || []).find(function (a) {
    if (a === article || a.slug === article.slug) return false;
    var otherWords = significantWords((a.title || '') + ' ' + (a.dek || ''));
    return wordOverlapScore(words, otherWords) >= SAME_STORY_OVERLAP_THRESHOLD;
  });
  if (tooSimilarTo) {
    issues.push({ field: 'title', message: 'Se parece demasiado a un artículo ya publicado ("' + tooSimilarTo.title + '") -- ¿es la misma historia?' });
  }

  // Decisión explícita de indexación: noindex es booleano (true/false),
  // no queda "sin decidir" (undefined ya se trata como false en el resto
  // del código, pero acá se pide que sea explícito para que no sea un
  // descuido).
  if (typeof article.noindex !== 'boolean') {
    issues.push({ field: 'noindex', message: 'Falta la decisión explícita de indexación (noindex debe ser true o false).' });
  }

  // Enlaces internos rotos dentro del cuerpo. Un href relativo dentro del
  // cuerpo de un artículo lo resuelve el NAVEGADOR relativo a la carpeta
  // de SU PROPIA página (categoria/<categoria>/<slug>.html) -- no
  // relativo a la raíz del sitio. Antes esto solo probaba resolver contra
  // la raíz, así que un link legítimo a otro artículo de la MISMA
  // categoría escrito como "otro-articulo.html" (sin "categoria/<cat>/"
  // adelante) se marcaba como roto aunque el archivo existiera de verdad
  // (bug encontrado el 2026-09-12 corriendo admin/validate-publish.js --
  // ver npm run validate:publish -- sobre los 169 artículos reales: 4 de
  // ellos usan justo ese estilo de link entre sí, y hubieran quedado
  // bloqueados para siempre si alguna vez se los volvía a tocar). Ahora
  // se prueban las dos resoluciones posibles antes de reportarlo como
  // roto -- esto solo puede volver el chequeo MÁS permisivo (menos falsos
  // positivos), nunca menos estricto: un link genuinamente roto sigue
  // fallando las dos.
  extractInternalLinks(body).forEach(function (href) {
    var clean = href.split('#')[0];
    var asRootRelative = path.join(siteRoot, clean);
    var asArticleRelative = article.category ? path.join(siteRoot, 'categoria', article.category, clean) : asRootRelative;
    if (!fs.existsSync(asRootRelative) && !fs.existsSync(asArticleRelative)) {
      issues.push({ field: 'body', message: 'Enlace interno roto en el cuerpo: "' + href + '".' });
    }
  });

  return issues;
}

// ============================================================================
// PROTECCIÓN PERMANENTE DEL PANEL — estados editoriales, fuentes/calidad
// y flujo de imágenes IA (2026-09-12)
// ============================================================================
// El objetivo de este bloque es que ninguna noticia futura pueda llegar
// al sitio público sin pasar por una aprobación humana explícita, y que
// eso no dependa de que el navegador respete las reglas del formulario:
// TODO esto corre también acá, del lado del servidor (admin/server.js lo
// invoca en POST /api/articles), así que una petición directa a la API
// (sin pasar por admin.js) no puede saltearse nada de esto.

// Un artículo nuevo o modificado (ver isArticleNewOrChanged) tiene que
// declarar un `status` reconocido -- no se permite dejarlo "sin decidir"
// de acá en adelante. Los artículos viejos sin este campo (los 169
// reales) nunca pasan por acá, porque isArticleNewOrChanged() los frena
// antes en server.js si no se tocaron.
function validateEditorialWorkflow(article, allArticles) {
  var issues = [];
  var status = article && article.status;

  if (status !== undefined && articleStatus.EDITORIAL_STATUSES.indexOf(status) === -1) {
    issues.push({ field: 'status', message: 'Estado editorial "' + status + '" no reconocido. Valores válidos: ' + articleStatus.EDITORIAL_STATUSES.join(', ') + '.' });
    return issues; // si el valor ni siquiera es válido, no tiene sentido seguir chequeando sus consecuencias
  }
  if (status === undefined && !article.draftIncomplete) {
    issues.push({ field: 'status', message: 'Falta declarar el estado editorial (draft, review, approved, published o redirected). Una noticia nueva nunca puede quedar "sin decidir".' });
    return issues;
  }

  var effective = articleStatus.effectiveStatus(article);

  // Nunca de RSS/IA directo a "published": la única puerta de entrada a
  // 'published' es esta confirmación humana explícita (mismo texto que
  // exige la fase 9 del panel, "He revisado las fuentes, los derechos de
  // imagen y la exactitud del artículo"). Un borrador recién traído de
  // fetchNewDrafts()/RSS jamás trae este campo en true por sí solo.
  if (effective === 'published' && article.editorialApproval !== true) {
    issues.push({ field: 'editorialApproval', message: 'No se puede publicar sin la confirmación humana de revisión editorial ("He revisado las fuentes, los derechos de imagen y la exactitud del artículo").' });
  }

  // 'redirected' necesita un destino real y existente -- si no, es un
  // link roto disfrazado de redirect.
  if (effective === 'redirected') {
    var target = article.redirectTo;
    if (!target) {
      issues.push({ field: 'redirectTo', message: 'Falta indicar a qué artículo redirige (redirectTo, formato "categoria/slug").' });
    } else {
      var found = (allArticles || []).some(function (a) {
        if (a === article) return false;
        var key = a.category + '/' + a.slug;
        return key === target || a.slug === target;
      });
      if (!found) {
        issues.push({ field: 'redirectTo', message: 'redirectTo ("' + target + '") no coincide con ningún otro artículo existente (formato esperado: categoria/slug).' });
      }
      if (target === article.category + '/' + article.slug || target === article.slug) {
        issues.push({ field: 'redirectTo', message: 'Un artículo no puede redirigir a sí mismo.' });
      }
    }
  }

  return issues;
}

// Validación mínima para un artículo 'redirected' -- no necesita cuerpo,
// fuente ni imagen (no es contenido, es un puntero), pero sí título,
// categoría y slug real para poder generar el archivo de redirect en su
// propia URL.
function validateRedirectArticle(article, allArticles) {
  var issues = [];
  if (!String(article.title || '').trim()) issues.push({ field: 'title', message: 'Falta el título (se usa como referencia interna del redirect).' });
  var categories = listCategories();
  if (!article.category || !categories.some(function (c) { return c.slug === article.category; })) {
    issues.push({ field: 'category', message: 'La categoría "' + (article.category || '') + '" no existe.' });
  }
  if (!article.slug) {
    issues.push({ field: 'slug', message: 'Falta el slug.' });
  } else {
    var dupSlug = (allArticles || []).find(function (a) { return a !== article && a.slug === article.slug && a.category === article.category; });
    if (dupSlug) issues.push({ field: 'slug', message: 'Ya existe otro artículo con el mismo slug en esta categoría ("' + article.slug + '").' });
  }
  return issues.concat(validateEditorialWorkflow(article, allArticles));
}

// Patrones de lenguaje de acusación/condena -- heurística deliberadamente
// simple (palabras clave), NO un análisis semántico real. Sirve para
// levantar una bandera de "revisar a mano", nunca para bloquear ni para
// reescribir nada solo -- el sistema no inventa una corrección, pide
// revisión humana (ver ADVERTENCIAS más abajo).
var ACCUSATION_AS_CONVICTION_TERMS = /\b(guilty|convicted|found guilty|culpable|condenad[oa]s?)\b/i;
var ALLEGATION_MARKER_TERMS = /\b(accused|alleged|allegedly|presunt[oa]s?|acusad[oa]s?|denunciad[oa]s?|imputad[oa]s?|charged with)\b/i;
var ATTRIBUTION_MARKER_TERMS = /\b(according to|dijo|declar[oó]|confirm[oó]|report[oó]|señal[oó]|indic[oó]|seg[uú]n|sources? (say|said)|officials? said)\b/i;
var NUMBER_OR_YEAR_PATTERN = /\b\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?%?\b|\b(19|20)\d{2}\b/;
// Pares [afirmación A, afirmación B contraria] -- si un artículo nuevo
// usa el lenguaje de un lado y otro artículo del MISMO tema (ver
// significantWords/wordOverlapScore) usa el del lado opuesto, es una
// contradicción candidata a revisar antes de aprobar. Igual que arriba:
// heurística de palabras clave, no un chequeo de hechos real.
var CONTRADICTION_TERM_PAIRS = [
  [/\bcancell?ed\b|\bcancelad[oa]\b/i, /\bconfirmed\b|\bconfirmad[oa]\b|\bwill (proceed|go ahead)\b|\bse realiz[oó]?\b/i],
  [/\bdenies?\b|\bniega\b|\bdesmiente\b/i, /\badmits?\b|\badmite\b|\bconfirms?\b|\bconfirma\b/i],
  [/\bguilty\b|\bculpable\b/i, /\bnot guilty\b|\binocente\b|\bacquitted\b|\babsuelto\b/i]
];

// Fuentes y calidad editorial (fase 2 de la protección permanente).
// Devuelve { issues, warnings }: `issues` bloquea el guardado (422)
// porque es mecánicamente verificable; `warnings` viaja en la respuesta
// para que el panel lo muestre bajo "Riesgo editorial", pero NO bloquea
// por sí solo -- ver la nota grande en el informe final sobre por qué
// (falsos positivos de una heurística de palabras clave no deberían
// poder trabar la publicación de una noticia real; la aprobación humana
// obligatoria de validateEditorialWorkflow() es la barrera real contra
// que esto llegue a "published" sin que alguien lo haya leído).
function validateSourcesAndQuality(article, allArticles) {
  var issues = [];
  var warnings = [];
  var body = String(article.body || '');

  // Contenido promocional / con fecha límite vencida (auditoría
  // 2026-09-13, ver detectPromotionalLanguage/isDeadlinePassed arriba en
  // este archivo): BLOQUEA -- no es una heurística de "revisar a mano
  // antes de aprobar" como el resto de esta función, es mecánicamente
  // descartable (una nota que le pide al lector que actúe antes de una
  // fecha límite que ya pasó no es una noticia). Se recalcula siempre
  // acá, del lado del servidor, a partir del contenido real del
  // artículo -- nunca se confía en un campo que mande el cliente, para
  // que una edición manual del cuerpo tampoco pueda saltearlo. Corre para
  // cualquier estado que no sea 'draft' (ver runPrePublishValidation en
  // server.js) -- es decir, ya bloquea en 'review', antes de llegar
  // siquiera a pedir aprobación.
  var riskText = (article.title || '') + ' . ' + (article.dek || '') + ' . ' + body + ' . ' + (article.sourceTitle || '') + ' . ' + (article.sourceHeadline || '') + ' . ' + (article.sourceDomain || '');
  var promoCheck = detectPromotionalLanguage(riskText);
  if (promoCheck.isPromotional) {
    issues.push({ field: 'body', message: 'Contenido promocional/CTA detectado (' + promoCheck.matchedTerms.slice(0, 3).join(', ') + ') -- esto es una convocatoria/anuncio comercial, no una noticia. No es publicable; descartá el borrador.' });
  }
  var deadlineCheck = isDeadlinePassed(riskText);
  if (deadlineCheck.expired) {
    issues.push({ field: 'body', message: 'Contenido vencido: el plazo mencionado en el texto (' + deadlineCheck.raw + ') ya pasó respecto a hoy. No se puede aprobar ni publicar así.' });
  }
  // Oferta/descuento comercial (hallazgo real de Leonardo, 2026-09-20, ver
  // detectCommercialDeal() arriba en este archivo): BLOQUEA con el mismo
  // mecanismo de 422 que promocional/vencido -- así un intento directo a
  // la API (sin pasar por el botón deshabilitado del panel) tampoco puede
  // guardar una oferta comercial como si fuera una noticia. Se revisa
  // también la URL de la fuente (requisito 2: título/resumen/cuerpo/URL/
  // metadatos del feed).
  var dealCheck = detectCommercialDeal(riskText, article.sourceUrl);
  if (dealCheck.isCommercialDeal) {
    issues.push({ field: 'body', message: 'Oferta/descuento comercial detectado (' + dealCheck.matchedTerms.slice(0, 4).join(', ') + ') -- esto es una promoción de compra o un precio temporal, no una noticia con valor editorial duradero. No es publicable; descartá el borrador.' });
  } else if (dealCheck.priceVolatile) {
    warnings.push({ field: 'body', message: 'El texto menciona precios/descuentos (' + dealCheck.matchedTerms.slice(0, 3).join(', ') + ') sin llegar a ser una oferta comercial clara -- confirmá que el dato de precio siga vigente antes de aprobar (puede quedar desactualizado en horas).' });
  }

  // Calidad de redacción (pedido de Leonardo, 2026-09-28, punto 3 de la
  // orden de cierre) -- SIEMPRE se recalcula acá, del lado del servidor, a
  // partir del cuerpo real del artículo que se está guardando: nunca se lee
  // ni se confía en un `article.writingQuality` que mande el navegador (ni
  // el que legítimamente traía un borrador sin tocar, ni uno falsificado a
  // mano contra la API directamente) -- la decisión de abajo usa siempre
  // `computedWritingQuality`, calculado acá mismo, así que un valor
  // falsificado en el cuerpo del PUT simplemente nunca se lee ni afecta
  // nada. A propósito NUNCA se escribe `article.writingQuality` de vuelta
  // en el registro que se persiste (a diferencia de otros campos de esta
  // función) -- persistirlo rompería el requisito de Leonardo de que los
  // artículos ya publicados queden byte por byte intactos: un simple
  // re-guardado (abrir en el panel, no tocar nada, guardar) puede disparar
  // isArticleNewOrChanged igual por normalizaciones del propio formulario
  // (ver test-sources-merge-fix.js, caso documentado de redirectTo), y no
  // debe agregarle jamás un campo nuevo a un artículo real por ese motivo.
  //
  // Deliberadamente NUNCA se aplica a 'published' (a diferencia de
  // promoCheck/deadlineCheck arriba, que sí corren para cualquier estado
  // no-draft): los 142 artículos reales de antes de este cambio no tienen
  // `status` y por lo tanto su effectiveStatus() es 'published' por
  // compatibilidad (ver article-status.js) -- munchos de ellos, escritos
  // antes de que este mínimo de 600 palabras/3 subtítulos existiera,
  // jamás lo cumplirían, así que aplicar esto a 'published' bloquearía
  // (o marcaría) retroactivamente contenido real ya vigente por una regla
  // que no existía cuando se escribió -- exactamente lo que Leonardo pidió
  // evitar ("no migrar ni reescribir retroactivamente los 142 artículos
  // existentes"). Solo se aplica mientras el artículo TODAVÍA no llegó a
  // publicarse: 'review' (revisión) y 'approved' (aprobado, el paso previo
  // a publicar).
  //
  // 'review': no bloquea -- viaja como advertencia (igual que fuente
  // única/similaridad arriba) para que el panel muestre el motivo concreto
  // ("Redacción incompleta: 359 palabras, 0 subtítulos...") sin impedir
  // guardar el trabajo en curso. Si el texto se corrige lo suficiente en el
  // próximo guardado, computedWritingQuality.passes vuelve a true y no se
  // agrega ninguna advertencia -- se "limpia" sola, sin necesidad de borrar
  // nada guardado antes (nunca se guardó nada de esto para empezar).
  // 'approved': BLOQUEA (mismo mecanismo de 422 que el resto de esta
  // función) -- un borrador que ya había pasado y se degradó al editarlo no
  // puede quedar aprobado (el paso previo a publicar) con el texto débil;
  // la única salida es corregir el texto o volver a guardarlo como
  // 'review'. Nunca se le baja el estado solo -- eso sería reescribir la
  // decisión editorial del humano sin avisarle; se bloquea y se explica
  // por qué.
  var writingEffective = articleStatus.effectiveStatus(article);
  if (writingEffective === 'review' || writingEffective === 'approved') {
    var computedWritingQuality = validateDraftWritingQuality(article, null);
    if (!computedWritingQuality.passes) {
      if (writingEffective === 'approved') {
        issues.push({ field: 'body', message: computedWritingQuality.summary + ' No se puede aprobar así -- corregí el texto o guardalo como revisión.' });
      } else {
        warnings.push({ field: 'body', message: computedWritingQuality.summary + ' No bloquea el guardado en revisión, pero hay que corregirlo antes de aprobar.' });
      }
    }
  }

  // Una o más fuentes reales, cada una con un dominio/medio resoluble
  // ("nombre del medio" -- ver domainLabel(), ya usado para renderizar
  // el texto del link "Source:" en pagegen.js/generate_pages.py).
  var sources = [];
  if (article.sourceUrl) sources.push({ field: 'sourceUrl', url: article.sourceUrl });
  (article.additionalSources || []).forEach(function (s) {
    if (s) sources.push({ field: 'additionalSources', url: s.url });
  });
  sources.forEach(function (s) {
    if (!s.url || !/^https?:\/\//i.test(s.url)) {
      issues.push({ field: s.field, message: 'La fuente "' + (s.url || '(vacía)') + '" no es una URL http(s) válida.' });
      return;
    }
    var host = null;
    try { host = new URL(s.url).hostname; } catch (e) { host = null; }
    if (!host || host.indexOf('.') === -1) {
      issues.push({ field: s.field, message: 'No se pudo determinar el medio/dominio de la fuente "' + s.url + '" -- URL no consultable.' });
    }
  });

  // Fuente única (requisito 6 de la mejora global, 2026-09-20): advertencia,
  // nunca bloqueo -- una noticia real puede legítimamente tener una sola
  // fuente (un comunicado oficial, una publicación técnica). Lo que este
  // sistema garantiza es que NUNCA se inventa una segunda fuente para
  // maquillar esto (ver additionalSources en fetchNewDrafts()); si de
  // verdad solo hay una, se avisa en vez de ocultarlo.
  if (article.sourceUrl && (!article.additionalSources || !article.additionalSources.length)) {
    warnings.push({ field: 'additionalSources', message: 'Esta nota depende de una sola fuente (' + (article.sourceTitle || article.sourceUrl) + '). No es un error, pero conviene confirmar el dato con una segunda fuente antes de aprobar si el hecho es relevante.' });
  }
  // Comunicado propio presentado como confirmación de un rumor externo
  // (requisito 5): mismo chequeo de lenguaje de reporte-no-confirmado que
  // classifyDraft() usa para borradores RSS, acá aplicado a CUALQUIER
  // guardado (incluido uno escrito/editado a mano), porque el riesgo
  // editorial es el mismo sea cual sea el origen del artículo.
  if ((!article.additionalSources || !article.additionalSources.length) && RUMOR_LANGUAGE_TERMS.test(body)) {
    warnings.push({ field: 'body', message: 'El texto usa lenguaje de reporte no confirmado ("reportedly"/"rumor"/etc.) con una sola fuente registrada -- confirmá que esa fuente no sea el propio comunicado de la empresa presentando un rumor externo como si estuviera confirmado.' });
  }

  // Copia extensa del resumen RSS original -- solo se puede chequear
  // cuando el artículo viene de un borrador que ya trae ese cálculo
  // hecho (similarityScore/similarityWarning, ver fetchNewDrafts() más
  // arriba en este mismo archivo). Un artículo escrito a mano desde cero
  // no tiene con qué compararse acá (no se descarga la fuente en este
  // paso -- sería una llamada de red en cada guardado).
  if (typeof article.similarityScore === 'number') {
    if (article.similarityScore >= 70) {
      issues.push({ field: 'body', message: 'Coincide en un ' + article.similarityScore + '% con el resumen original de la fuente (umbral de copia extensa) -- hay que reescribirlo de verdad, no alcanza con cambiar alguna palabra.' });
    } else if (article.similarityWarning) {
      warnings.push({ field: 'body', message: 'Similaridad con el resumen de la fuente original: ' + article.similarityScore + '%. Por debajo del bloqueo automático, pero conviene revisarlo a mano antes de aprobar.' });
    }
  }
  if (article.genericHeadingWarning) {
    warnings.push({ field: 'body', message: 'Tiene un subtítulo genérico de cierre (ej. "Looking Ahead"/"Conclusion") -- suele ser señal de relleno de bajo valor.' });
  }

  // Texto genérico o repetitivo -- bloqueo cuando es mecánicamente claro
  // (una oración larga repetida varias veces, o vocabulario casi sin
  // variedad en un cuerpo largo).
  var sentences = body.split(/(?<=[.!?])\s+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.split(/\s+/).length > 6; });
  var sentenceCounts = {};
  sentences.forEach(function (s) { var k = s.toLowerCase(); sentenceCounts[k] = (sentenceCounts[k] || 0) + 1; });
  var maxRepeat = Object.keys(sentenceCounts).reduce(function (m, k) { return Math.max(m, sentenceCounts[k]); }, 0);
  if (maxRepeat >= 3) {
    issues.push({ field: 'body', message: 'Hay una oración de más de 6 palabras repetida ' + maxRepeat + ' veces -- revisá que no sea texto repetitivo.' });
  }
  var wordsAll = body.trim() ? body.trim().split(/\s+/) : [];
  if (wordsAll.length > 150) {
    var uniqueRatio = new Set(wordsAll.map(function (w) { return w.toLowerCase(); })).size / wordsAll.length;
    if (uniqueRatio < 0.35) {
      issues.push({ field: 'body', message: 'El cuerpo tiene muy poca variedad de vocabulario (' + Math.round(uniqueRatio * 100) + '% de palabras únicas) -- parece texto genérico o de relleno.' });
    }
  }

  // Secciones vacías: un "## Subtítulo" sin ningún texto real antes del
  // próximo subtítulo o del final del cuerpo.
  var lines = body.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) {
      var j = i + 1;
      var hasContent = false;
      while (j < lines.length && !/^##\s+\S/.test(lines[j])) {
        if (lines[j].trim()) { hasContent = true; break; }
        j++;
      }
      if (!hasContent) {
        issues.push({ field: 'body', message: 'La sección "' + lines[i].replace(/^##\s+/, '') + '" está vacía (encabezado sin contenido debajo).' });
      }
    }
  }

  // Cifras/fechas sin ningún marcador de atribución cercano -- solo
  // advertencia (una nota puede legítimamente citar cifras de su propia
  // fuente principal sin repetir "according to" en cada oración).
  if (NUMBER_OR_YEAR_PATTERN.test(body) && !ATTRIBUTION_MARKER_TERMS.test(body) && !article.sourceTitle) {
    warnings.push({ field: 'body', message: 'El cuerpo menciona cifras o fechas sin un marcador de atribución claro ("according to", "dijo", "según", etc.) -- confirmá la fuente de cada dato antes de aprobar.' });
  }

  // Acusación presentada como condena -- advertencia.
  if (ACCUSATION_AS_CONVICTION_TERMS.test(body) && !ALLEGATION_MARKER_TERMS.test(body)) {
    warnings.push({ field: 'body', message: 'El texto usa lenguaje de condena/culpabilidad ("guilty"/"convicted"/"culpable") -- confirmá que sea un fallo judicial firme y no una acusación todavía no resuelta.' });
  }

  // Contradicción grave con un artículo anterior del mismo tema (pedido de
  // Leonardo, 2026-09-24, punto 6: "si classifyDraft la considera grave, el
  // guardado manual no puede tratarla solamente como advertencia"). Hasta
  // acá esta función tenía su PROPIA copia inline del mismo chequeo de
  // CONTRADICTION_TERM_PAIRS que classifyDraft (findGraveContradiction, ver
  // arriba en este archivo) pero solo agregaba una advertencia, nunca
  // bloqueaba -- dos implementaciones idénticas con dos resultados
  // distintos según qué camino de guardado se usara. Ahora se llama a la
  // MISMA función (fuente única) y, si encuentra una contradicción grave,
  // BLOQUEA (issues, no warnings) -- impide publicar hasta que se resuelva
  // a mano (editando el artículo nuevo, el viejo, o marcando cuál versión
  // está vigente). Sigue siendo la misma heurística de palabras clave de
  // siempre (puede haber falsos positivos), pero ya no depende de por cuál
  // camino se guardó para decidir si bloquea o no.
  var graveContradiction = findGraveContradiction(article.title, article.dek, body, allArticles);
  if (graveContradiction) {
    issues.push({ field: 'body', message: 'Contradicción grave con "' + graveContradiction.title + '" (mismo tema, lenguaje de sentido opuesto detectado) -- no se puede publicar así. Confirmá cuál versión está vigente y corregí el artículo que quedó desactualizado antes de guardar.' });
  }

  return { issues: issues, warnings: warnings };
}

// Compara un artículo contra su versión anterior (por slug+categoría) en
// `previousArticles` -- server.js usa esto para aplicar las reglas nuevas
// (fases 3 y 5) SOLO a lo nuevo o modificado en este guardado, nunca contra
// el resto del sitio ya publicado (ver la nota grande más arriba). Un
// artículo con slug+categoría nuevos (no existía antes) siempre cuenta
// como "nuevo". Comparación por contenido completo (JSON), no solo por
// clave, para detectar ediciones.
function isArticleNewOrChanged(article, previousArticles) {
  var prev = (previousArticles || []).find(function (a) { return a.slug === article.slug && a.category === article.category; });
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(article);
}

module.exports = {
  fetchNewDrafts: fetchNewDrafts,
  // runFetchNewDraftsWithDeadline (2026-09-27): expuesta SOLO para pruebas
  // con reloj controlado (ver test-global-deadline.js) -- permite pasar un
  // deadline propio (no el real feeds.makeDeadline(45000)) y así probar de
  // forma determinística, sin esperas reales, cómo se reparte el plazo
  // compartido entre Google Trends y su respaldo RSS. El camino real de
  // producción sigue siendo fetchNewDrafts() -> runFetchNewDrafts(), que
  // crea el deadline real y SIEMPRE lo cierra en su finally.
  runFetchNewDraftsWithDeadline: runFetchNewDraftsWithDeadline,
  discardDraft: discardDraft,
  removeDraft: removeDraft,
  buildCandidates: buildCandidates,
  listCategories: listCategories,
  uniqueSlug: uniqueSlug,
  todayISO: todayISO,
  isAuthorizedImageLicense: isAuthorizedImageLicense,
  isImagePublishBlocked: isImagePublishBlocked,
  validateImageFields: validateImageFields,
  validateImageReuse: validateImageReuse,
  validateImagePublication: validateImagePublication,
  validateArticleContent: validateArticleContent,
  validateEditorialWorkflow: validateEditorialWorkflow,
  validateRedirectArticle: validateRedirectArticle,
  validateSourcesAndQuality: validateSourcesAndQuality,
  isArticleNewOrChanged: isArticleNewOrChanged,
  // Auditoría 2026-09-13 (contenido promocional/vencido, Entertainment y
  // Sports fuera de "noticias nuevas") -- expuestas para que server.js
  // pueda anotar data/drafts.json al vuelo en GET /api/drafts, y para que
  // admin/test-*.js pueda probarlas de forma aislada.
  detectPromotionalLanguage: detectPromotionalLanguage,
  // Filtro de ofertas comerciales (hallazgo del borrador de IGN,
  // 2026-09-20) -- expuesta para que server.js/admin.js puedan mostrar el
  // motivo exacto si hace falta, y para que test-commercial-deal-filter.js
  // pueda probar el criterio de combinación de señales de forma aislada.
  detectCommercialDeal: detectCommercialDeal,
  // Filtro de fantasy/apuestas (pedido de Leonardo, 2026-09-27, punto 4 --
  // hallazgo real: borrador de Google Trends sobre "Michael Wilson Fantasy
  // Week 3 Start or Sit") -- expuesta para que server.js/admin.js puedan
  // mostrar el motivo exacto y para que test-fantasy-betting-filter.js
  // pueda probar cada término/control de forma aislada.
  detectFantasyOrBettingAdvice: detectFantasyOrBettingAdvice,
  isDeadlinePassed: isDeadlinePassed,
  classifyDraft: classifyDraft,
  // Contenido sensible / transparencia / aporte editorial verificable
  // (pedido de Leonardo, 2026-09-24) -- expuestas para que los tests puedan
  // probar cada heurística de forma aislada, igual que detectPromotionalLanguage/
  // detectCommercialDeal arriba.
  detectSensitiveEditorialTopics: detectSensitiveEditorialTopics,
  detectTransparencyRisk: detectTransparencyRisk,
  computeEditorialValue: computeEditorialValue,
  // Calidad de redacción posterior (pedido 2026-09-27, punto 5) -- expuestas
  // para que test-writing-quality-validation.js pueda probar cada sub-chequeo
  // de forma aislada, igual que computeEditorialValue arriba.
  validateDraftWritingQuality: validateDraftWritingQuality,
  detectAmbiguousReferences: detectAmbiguousReferences,
  detectExcessiveSelfRepetition: detectExcessiveSelfRepetition,
  SENSITIVE_TOPIC_GROUPS: SENSITIVE_TOPIC_GROUPS,
  HACKING_INSTRUCTION_TERMS: HACKING_INSTRUCTION_TERMS,
  EDITORIAL_VALUE_ELEMENT_DETECTORS: EDITORIAL_VALUE_ELEMENT_DETECTORS,
  findGraveContradiction: findGraveContradiction,
  EXCLUDED_NEW_DRAFT_CATEGORIES: EXCLUDED_NEW_DRAFT_CATEGORIES,
  // Descubrimiento por Google Trends (pedido 2026-09-25) -- expuestas para
  // que admin/test-google-trends-discovery.js pueda probar cada paso de
  // forma aislada (clasificación sin IA, corroboración, orden/diversidad,
  // el flujo completo) y para que buildCandidatesFromTrends() llame a
  // checkUrlReachable/searchGoogleNewsForCorroboration a través de
  // module.exports (mismo patrón que buildCandidates arriba -- permite a
  // los tests reemplazarlas por versiones sin red real).
  TREND_CATEGORY_RULES: TREND_CATEGORY_RULES,
  classifyTrendCategory: classifyTrendCategory,
  trendClassificationText: trendClassificationText,
  TRENDS_OWN_DOMAINS: TRENDS_OWN_DOMAINS,
  usableTrendNewsItems: usableTrendNewsItems,
  corroborateTrend: corroborateTrend,
  compareTrendCandidatesForDrafting: compareTrendCandidatesForDrafting,
  pickDiverseTopCandidates: pickDiverseTopCandidates,
  buildCandidatesFromTrends: buildCandidatesFromTrends,
  // Mejora global de procedencia de fuentes (2026-09-20, requisito 10):
  // se exporta para que buildCandidates() la llame a través de
  // module.exports (permite a los tests reemplazarla por una versión sin
  // red real, ver test-source-provenance.js) y para que server.js pueda
  // ofrecer un chequeo manual bajo demanda (GET /api/check-source) para
  // fuentes cargadas o editadas a mano, no solo las de RSS.
  checkUrlReachable: checkUrlReachable,
  // Corroboración independiente previa a la redacción (pedido de
  // Leonardo, 2026-09-20) -- expuestas vía module.exports por el mismo
  // motivo que checkUrlReachable arriba: que los tests puedan reemplazar
  // fetchGoogleNewsRss/resolveSourceUrl/searchGoogleNewsForCorroboration
  // por versiones sin red real (este sandbox no tiene salida a internet
  // pública), y que server.js pueda ofrecer el botón manual "Buscar
  // segunda fuente" vía findAdditionalSourceForDraft.
  resolveSourceUrl: resolveSourceUrl,
  fetchGoogleNewsRss: fetchGoogleNewsRss,
  searchGoogleNewsForCorroboration: searchGoogleNewsForCorroboration,
  computeCorroborationMatch: computeCorroborationMatch,
  isIndependentSource: isIndependentSource,
  extractMainEntities: extractMainEntities,
  extractMainAction: extractMainAction,
  findCorroborationForItem: findCorroborationForItem,
  findAdditionalSourceForDraft: findAdditionalSourceForDraft,
  // Botón manual "Generar imagen" (pedido 2026-09-27, punto 4) -- expuesta
  // para el endpoint de server.js y para test-writing-quality-validation.js.
  generateDraftImageManually: generateDraftImageManually,
  EXCLUDED_CORROBORATION_DOMAINS: EXCLUDED_CORROBORATION_DOMAINS,
  RUMOR_LANGUAGE_TERMS: RUMOR_LANGUAGE_TERMS,
  // Expuestas para probar la capa de seguridad SSRF de checkUrlReachable()
  // de forma unitaria/determinística (sin depender de qué IPs devuelva el
  // DNS real en el entorno donde corra el test) -- ver
  // test-check-url-security.js.
  isPrivateOrReservedIP: isPrivateOrReservedIP,
  isPrivateIPv4: isPrivateIPv4,
  isPrivateIPv6: isPrivateIPv6,
  validateSourceUrlForFetch: validateSourceUrlForFetch,
  // Reusada por admin/validate-publish.js (npm run validate:publish) para
  // el chequeo GLOBAL de enlaces internos rotos -- a diferencia de
  // validateArticleContent, ese chequeo corre sobre TODOS los artículos
  // (no solo los nuevos/modificados), porque un link roto es un problema
  // real independientemente de cuándo se publicó el artículo que lo tiene.
  extractInternalLinks: extractInternalLinks,
  // Re-exportado desde article-status.js para que server.js/admin.js
  // puedan seguir haciendo pipeline.isPublicArticle(...) etc. sin tener
  // que requerir un segundo módulo -- la fuente de verdad sigue siendo
  // article-status.js (también la usa pagegen.js directo).
  EDITORIAL_STATUSES: articleStatus.EDITORIAL_STATUSES,
  effectiveStatus: articleStatus.effectiveStatus,
  isPublicArticle: articleStatus.isPublicArticle,
  isRedirectArticle: articleStatus.isRedirectArticle,
  isListable: articleStatus.isListable,
  loadsAdsense: articleStatus.loadsAdsense,
  // Pipeline de 2 fases / control de costos (pedido de Leonardo,
  // 2026-09-23) -- expuestas para que server.js pueda ofrecer el polling de
  // progreso (GET /api/fetch-drafts/status) y leer los límites configurados,
  // y para que los tests puedan verificar la caché técnica de 24hs y el
  // orden de redacción de forma aislada.
  getFetchStatus: getFetchStatus,
  getPipelineLimits: getPipelineLimits,
  DEFAULT_PIPELINE_LIMITS: DEFAULT_PIPELINE_LIMITS,
  loadCandidateCache: loadCandidateCache,
  pruneCandidateCache: pruneCandidateCache,
  CANDIDATE_CACHE_FILE: CANDIDATE_CACHE_FILE,
  CANDIDATE_CACHE_TTL_MS: CANDIDATE_CACHE_TTL_MS,
  // Verificación previa a sincronizar (pedido de Leonardo, 2026-09-24):
  // expuestas para que los tests puedan verificar el tope de tamaño de la
  // caché técnica y guardarla directamente al armar un fixture con muchas
  // entradas.
  CANDIDATE_CACHE_MAX_ENTRIES: CANDIDATE_CACHE_MAX_ENTRIES,
  saveCandidateCache: saveCandidateCache,
  cacheCandidateResult: cacheCandidateResult,
  compareCandidatesForDrafting: compareCandidatesForDrafting,
  // Escritura atómica (pedido de Leonardo, 2026-09-24, punto 2 de su
  // verificación final): expuesta directamente (no solo indirectamente vía
  // saveCandidateCache) para que los tests puedan probar el mecanismo en
  // sí -- reemplazo de un archivo ya existente, limpieza del temporal
  // cuando el rename falla, dos escrituras seguidas -- sobre una carpeta
  // temporal cualquiera, sin depender de ningún archivo real de data/.
  writeJSON: writeJSON
};
