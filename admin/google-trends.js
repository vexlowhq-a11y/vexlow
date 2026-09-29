/*
  Descubrimiento por Google Trends "Trending Now" (Estados Unidos)
  =================================================================
  Pedido de Leonardo, 2026-09-25 ("descubrimiento de tendencias de
  Estados Unidos y reorganización de categorías"), punto 1: usar
  Google Trends como PUNTO DE PARTIDA del descubrimiento, no como
  fuente periodística en sí misma -- ver admin/pipeline.js
  (buildCandidatesFromTrends/corroborateTrend) para cómo se exige
  después una cobertura real de dos medios independientes por cada
  tendencia antes de gastar una llamada de IA.

  Endpoint: el feed público "Trending Now" de Google Trends para
  Estados Unidos (geo=US), formato RSS estable, confirmado en vivo
  antes de escribir este módulo (2026-09-25):

    https://trends.google.com/trending/rss?geo=US

  Este es un RSS 2.0 con namespace "ht:" (hot trends). Por cada
  <item> (una tendencia):
    - title                    texto de búsqueda de la tendencia
                                (ej. "georgia vs northern ireland")
    - ht:approx_traffic        volumen aproximado, ej. "1000+"
    - link                     apunta a trends.google.com -- NUNCA es
                                una nota periodística real, jamás se usa
                                como fuente ni se le hace scraping.
    - pubDate                  cuándo empezó a ser tendencia
    - ht:picture/ht:picture_source  miniatura cacheada por Google, de
                                baja resolución y sin licencia clara --
                                a propósito NUNCA se usa como imagen de
                                portada del artículo (ver pipeline.js:
                                los candidatos de Trends siempre salen
                                con image:null, para forzar el mismo
                                flujo de generación por IA con
                                procedencia completa que ya usa el
                                resto del sitio).
    - ht:news_item (hasta 3)   cobertura real ya agrupada por Google:
                                ht:news_item_title, ht:news_item_snippet,
                                ht:news_item_url, ht:news_item_picture,
                                ht:news_item_source -- estos SÍ son
                                artículos reales, con link directo al
                                medio (confirmado a mano: no son un
                                redirect de Google, a diferencia de
                                Google News). Es la base de la
                                corroboración de esta tendencia (ver
                                corroborateTrend en pipeline.js).

  Este módulo SOLO trae y parsea el feed -- no clasifica, no corrobora,
  no decide nada editorial (eso vive en admin/pipeline.js, para que
  toda la lógica de "qué se puede convertir en borrador" quede en un
  solo lugar, junto a la del resto de las fuentes RSS). Reutiliza
  fetchUrl/tagValue/decodeEntities/unescapeEntities de admin/feeds.js
  (ver su module.exports) en vez de mantener un segundo cliente HTTP y
  un segundo parser de XML -- ya son XML con las mismas entidades y el
  mismo formato de tag que cualquier feed RSS del sitio.
*/

const feeds = require('./feeds');

var TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=US';

// "1000+" -> 1000 ; "50+" -> 50 ; vacío/no numérico -> null (nunca 0
// inventado -- null significa "Google no dio este dato", requisito
// explícito de Leonardo de no inventar volumen de búsqueda).
function parseApproxTraffic(raw) {
  if (!raw) return null;
  var digits = String(raw).replace(/[^0-9]/g, '');
  if (!digits) return null;
  var n = parseInt(digits, 10);
  return isNaN(n) ? null : n;
}

// Hasta 3 <ht:news_item> por tendencia -- cobertura real ya agrupada
// por Google Trends (ver comentario de arriba). Cada uno se resuelve
// con canonicalizeUrl/domainFromUrl/outletNameFromDomain (las MISMAS
// funciones que usa cualquier otro ítem de RSS en feeds.js) para que
// tenga exactamente la misma forma que un ítem de feed normal y el
// resto del pipeline (isIndependentSource, computeCorroborationMatch,
// EXCLUDED_CORROBORATION_DOMAINS) lo trate sin ninguna rama especial.
function extractNewsItems(itemBlock) {
  var blocks = itemBlock.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi) || [];
  var out = [];
  blocks.forEach(function (block) {
    var title = feeds.tagValue(block, 'ht:news_item_title');
    var rawUrl = feeds.tagValue(block, 'ht:news_item_url');
    if (!title || !rawUrl) return;
    var url = feeds.canonicalizeUrl(rawUrl);
    var domain = feeds.domainFromUrl(url);
    if (!domain) return;
    out.push({
      title: title,
      snippet: feeds.tagValue(block, 'ht:news_item_snippet'),
      url: url,
      domain: domain,
      // ht:news_item_source trae el nombre del medio tal como lo
      // publica Google -- se prefiere el mapeo propio de
      // outletNameFromDomain (misma fuente de verdad que el resto del
      // archivo, ver isIndependentSource) y solo se cae al nombre de
      // Google si el dominio no está en la tabla conocida.
      outlet: feeds.outletNameFromDomain(domain) || feeds.tagValue(block, 'ht:news_item_source') || domain,
      picture: feeds.tagValue(block, 'ht:news_item_picture') || ''
    });
  });
  return out;
}

// Parsea el XML completo del feed "Trending Now" en una lista de
// tendencias. Nunca lanza por un XML parcialmente inesperado -- si un
// <item> puntual no trae título, simplemente se lo descarta (igual
// que parseFeedItems() en feeds.js).
function parseTrendsXml(xml) {
  var blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  var trends = [];
  blocks.forEach(function (block) {
    var query = feeds.tagValue(block, 'title');
    if (!query) return;
    var pubDate = feeds.tagValue(block, 'pubDate');
    var pubDateTs = pubDate ? Date.parse(pubDate) : NaN;
    var pubDateISO = isNaN(pubDateTs) ? null : new Date(pubDateTs).toISOString();
    trends.push({
      query: query,
      approxTrafficRaw: feeds.tagValue(block, 'ht:approx_traffic') || '',
      approxTraffic: parseApproxTraffic(feeds.tagValue(block, 'ht:approx_traffic')),
      pubDateISO: pubDateISO,
      newsItems: extractNewsItems(block)
    });
  });
  return trends;
}

// Trae y parsea el feed. `deadline` (opcional, mismo contrato que en
// feeds.js/pipeline.js): se pasa tal cual a fetchUrl para que la
// petición respete el plazo compartido de FASE 1 y se cancele de
// verdad al vencer. Lanza (nunca devuelve un array vacío en silencio
// por un error real) si la petición de red falla o si el XML no se
// pudo interpretar en absoluto -- eso es lo que
// buildCandidatesFromTrends() usa, en pipeline.js, para decidir
// "esto fue un fallo técnico real, hay que caer al RSS de respaldo"
// (requisito: "si Google Trends falla, usar los RSS configurados como
// fallback"). Un feed que respondió 200 OK pero con 0 tendencias
// analizables (XML inválido/vacío/formato inesperado) se trata igual
// que un fallo de red -- un día real siempre trae decenas de
// tendencias, así que 0 nunca es un resultado legítimo.
async function fetchTrendingNow(deadline) {
  var xml = await feeds.fetchUrl(TRENDS_RSS_URL, undefined, deadline);
  var trends;
  try {
    trends = parseTrendsXml(xml);
  } catch (e) {
    var eParse = new Error('No se pudo interpretar el XML de Google Trends');
    eParse.trendsErrorCode = 'parse-error';
    throw eParse;
  }
  if (!trends.length) {
    var eEmpty = new Error('Google Trends no devolvió ninguna tendencia analizable');
    eEmpty.trendsErrorCode = 'empty-response';
    throw eEmpty;
  }
  return trends;
}

module.exports = {
  TRENDS_RSS_URL: TRENDS_RSS_URL,
  parseApproxTraffic: parseApproxTraffic,
  extractNewsItems: extractNewsItems,
  parseTrendsXml: parseTrendsXml,
  fetchTrendingNow: fetchTrendingNow
};
