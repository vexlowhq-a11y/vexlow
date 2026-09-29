/*
  Lectura de feeds RSS — usado por admin/server.js
  =================================================================
  Trae los últimos titulares de los feeds configurados en
  admin/feeds.json (uno o varios por categoría) para usarlos como
  base de artículos nuevos. Solo lee título + resumen + link + fecha
  de cada feed — el texto del artículo en sí se redacta de cero en
  admin/draft.js, nunca se copia el contenido original.

  Procedencia de fuente (2026-09-20, "mejora global" post-Nscale):
  además de título/resumen/link/fecha/imagen, ahora también se
  extraen -- cuando el feed los trae -- autor y se derivan URL
  canónica, dominio y nombre del medio a partir del link. El
  objetivo es que un borrador de RSS llegue con toda la procedencia
  ya cargada (ver admin/pipeline.js fetchNewDrafts()) y nadie tenga
  que volver a pegar a mano una fuente que el sistema ya tenía.
*/

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pagegen = require('./pagegen');

const FEEDS_FILE = path.join(__dirname, 'feeds.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; VexlowHQBot/1.0; +https://vexlowhq.com)';
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12000;

// ============================================================================
// Deadline compartido para toda la FASE 1 de "Buscar noticias nuevas"
// (pedido de Leonardo, 2026-09-24, tras revisión del informe: el plazo de
// 45s de preselectionTimeoutMs no cubría de verdad checkUrlReachable ni la
// búsqueda de Google News, que podían seguir corriendo varios segundos más
// allá del plazo). Vive en feeds.js -- no en pipeline.js -- porque este
// módulo no depende de pipeline.js, así ambos pueden compartir el mismo
// helper sin crear una dependencia circular (pipeline.js sí depende de
// feeds.js, nunca al revés).
//
// Un "deadline" es un AbortController + un plazo de pared: expone
// `signal` (para pasarlo directo a https.request/http.request/https.get y
// que Node cancele de verdad la conexión en curso, no solo deje de
// esperarla), `remaining()` (ms que quedan, nunca negativo, para que cada
// función de red pueda capar su propio timeout interno a
// Math.min(timeoutPropio, remaining())), `expired()` (ya se cumplió,
// por el timer o porque el reloj ya pasó el plazo) y `clear()` (limpia el
// timer interno -- SIEMPRE hay que llamarla al terminar de usar un
// deadline, típicamente en un finally, aunque el timer ya vaya con
// .unref() y nunca mantenga vivo el proceso por sí solo).
function makeChildDeadline(parent, ms) {
  var ownMs = Math.max(0, parent ? Math.min(ms, parent.remaining()) : ms);
  var controller = new AbortController();
  var expiresAt = Date.now() + ownMs;
  var timer = setTimeout(function () {
    try { controller.abort(); } catch (e) {}
  }, ownMs);
  if (timer.unref) timer.unref();
  var onParentAbort = function () { try { controller.abort(); } catch (e) {} };
  if (parent && parent.signal) {
    if (parent.signal.aborted) onParentAbort();
    else parent.signal.addEventListener('abort', onParentAbort);
  }
  return {
    signal: controller.signal,
    remaining: function () {
      var ownRemaining = Math.max(0, expiresAt - Date.now());
      return parent ? Math.min(ownRemaining, parent.remaining()) : ownRemaining;
    },
    expired: function () {
      return controller.signal.aborted || Date.now() >= expiresAt || (parent ? parent.expired() : false);
    },
    clear: function () {
      clearTimeout(timer);
      if (parent && parent.signal) parent.signal.removeEventListener('abort', onParentAbort);
    }
  };
}

// Deadline "raíz" de toda una corrida (ej. preselectionTimeoutMs) -- un
// caso particular de makeChildDeadline sin padre.
function makeDeadline(ms) {
  return makeChildDeadline(null, ms);
}

// Nombres de medio conocidos por dominio -- cubre los feeds configurados
// hoy en feeds.json más algunos medios frecuentes en fuentes adicionales/
// artículos ya publicados (ver sourceTitle de los 141 reales), para que
// "nombre del medio" no dependa de adivinar a partir del dominio salvo
// que de verdad sea un medio nuevo. No hace falta que esté completa: lo
// que no está acá cae al formateo genérico de outletNameFromDomain().
const KNOWN_OUTLETS = {
  'techcrunch.com': 'TechCrunch',
  'venturebeat.com': 'VentureBeat',
  'theverge.com': 'The Verge',
  'space.com': 'Space.com',
  'nasa.gov': 'NASA',
  'ign.com': 'IGN',
  'kotaku.com': 'Kotaku',
  'variety.com': 'Variety',
  'espn.com': 'ESPN',
  'bbc.co.uk': 'BBC',
  'bbci.co.uk': 'BBC',
  'feeds.bbci.co.uk': 'BBC',
  'cnbc.com': 'CNBC',
  'reuters.com': 'Reuters',
  'bloomberg.com': 'Bloomberg',
  'wsj.com': 'The Wall Street Journal',
  'nytimes.com': 'The New York Times',
  'apnews.com': 'The Associated Press',
  'engadget.com': 'Engadget',
  'arstechnica.com': 'Ars Technica',
  'wired.com': 'Wired',
  'gizmodo.com': 'Gizmodo',
  'polygon.com': 'Polygon',
  'pcgamer.com': 'PC Gamer',
  'eurogamer.net': 'Eurogamer',
  'gamesindustry.biz': 'GamesIndustry.biz',
  'investing.com': 'Investing.com',
  'xinhuanet.com': 'Xinhua',
  'nvidia.com': 'NVIDIA Newsroom',
  // Hallazgo real de Leonardo (2026-09-27): "sports.yahoo.com" no estaba
  // acá, así que caía al formateo genérico (domain.split('.')[0] ->
  // "sports" -> "Sports") -- un borrador real de Yahoo Sports quedó con
  // sourceTitle "Sports" en vez de "Yahoo Sports". Se agrega también
  // "news.yahoo.com" (mismo bug potencial, mismo dominio raíz) aunque
  // todavía no se haya visto un caso real con ese subdominio.
  'sports.yahoo.com': 'Yahoo Sports',
  'news.yahoo.com': 'Yahoo News'
};

// Parámetros de tracking que no cambian a qué recurso apunta la URL
// (analítica de campaña, redes sociales, etc.) -- se sacan para que dos
// links a la MISMA nota con distinto "?utm_source=..." se reconozcan
// como la misma fuente (deduplicación real, no solo de apariencia).
//
// REVISIÓN DE SEGURIDAD 2026-09-20 (pedido de Leonardo, requisito 10):
// esta lista tiene que quedarse SOLO con parámetros que son casi
// universalmente de rastreo puro y nunca cambian qué recurso se pide --
// "ref"/"ref_src" se sacaron a propósito de una versión anterior de esta
// lista: son genéricos de sobra como para ser, en algunos sitios,
// parámetros FUNCIONALES de verdad (ej. GitHub usa "?ref=<rama>" en URLs
// de contenido crudo para elegir la rama/commit -- sacarlo cambiaría a
// qué versión del archivo apunta la URL). Los que quedan (utm_*, fbclid,
// gclid, msclkid, igshid, mc_cid/mc_eid) son identificadores de campaña de
// plataformas específicas (Google Ads, Facebook, Microsoft Ads,
// Instagram, Mailchimp) sin ningún uso funcional conocido.
var TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid'];

function canonicalizeUrl(url) {
  if (!url) return url;
  try {
    var u = new URL(url);
    u.hash = '';
    TRACKING_PARAMS.forEach(function (p) { u.searchParams.delete(p); });
    // Ordenar los parámetros restantes para que el mismo link con el
    // mismo query en distinto orden también dedupe igual.
    var params = Array.from(u.searchParams.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); });
    u.search = '';
    params.forEach(function (p) { u.searchParams.append(p[0], p[1]); });
    u.hostname = u.hostname.toLowerCase();
    var pathname = u.pathname.replace(/\/+$/, '');
    u.pathname = pathname || '/';
    return u.toString();
  } catch (e) {
    return url; // URL rara/no absoluta: se deja como vino, mejor eso que romper el borrador
  }
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function titleCaseWord(w) {
  return w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

// Nombre de medio a partir del dominio -- primero la lista conocida
// (KNOWN_OUTLETS), y si no está, un formateo genérico razonable a partir
// del primer componente del dominio (ej. "example-news.co.uk" ->
// "Example News"). Nunca inventa un nombre de medio distinto del
// dominio real -- es solo una versión legible del mismo dato.
function outletNameFromDomain(domain) {
  if (!domain) return '';
  if (KNOWN_OUTLETS[domain]) return KNOWN_OUTLETS[domain];
  var first = domain.split('.')[0];
  if (!first) return domain;
  return first.split(/[-_]/).map(titleCaseWord).join(' ');
}

function loadFeedsConfig() {
  try {
    return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

// `deadline` (opcional, ver makeDeadline/makeChildDeadline arriba): cuando
// viene uno, esta función SIEMPRE respeta lo que quede de tiempo -- capa su
// propio timeout de socket a Math.min(TIMEOUT_MS, deadline.remaining()),
// pasa deadline.signal a la petición (así Node cancela la conexión real de
// verdad si el deadline se cumple mientras la petición está en curso, no
// solo dejamos de esperarla), y si el deadline YA se cumplió ni siquiera
// llega a abrir la conexión. Sin `deadline` el comportamiento es idéntico
// al de siempre (compatible con todo el código/tests existentes que la
// llaman sin ese tercer argumento).
function fetchUrl(url, redirectsLeft, deadline) {
  redirectsLeft = redirectsLeft == null ? MAX_REDIRECTS : redirectsLeft;
  return new Promise(function (resolve, reject) {
    if (deadline && deadline.expired()) {
      var eExpired = new Error('timeout');
      eExpired.code = 'DEADLINE_EXCEEDED';
      return reject(eExpired);
    }
    var lib = url.indexOf('https:') === 0 ? https : http;
    var socketTimeout = deadline ? Math.max(1, Math.min(TIMEOUT_MS, deadline.remaining())) : TIMEOUT_MS;
    var reqOpts = { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }, timeout: socketTimeout };
    if (deadline) reqOpts.signal = deadline.signal;
    var req = lib.get(url, reqOpts, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, redirectsLeft - 1, deadline));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) {
      if (e && (e.code === 'ABORT_ERR' || e.name === 'AbortError')) {
        var eAbort = new Error('timeout');
        eAbort.code = 'DEADLINE_EXCEEDED';
        return reject(eAbort);
      }
      reject(e);
    });
  });
}

// Solo des-escapa entidades (&amp; -> &, etc.) sin tocar tags ni
// espacios -- para valores como URLs, donde un "&amp;q=30" en un
// atributo XML tiene que volver a ser "&q=30" antes de pedirlo, pero
// no queremos que le pasen por encima el resto de la limpieza de texto.
function unescapeEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) { return String.fromCodePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (m, dec) { return String.fromCodePoint(parseInt(dec, 10)); })
    .replace(/&amp;/g, '&');
}

function decodeEntities(str) {
  return unescapeEntities(String(str || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  var m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function linkValue(block) {
  // RSS: <link>https://...</link> ; Atom: <link href="https://..."/>
  var m = block.match(/<link[^>]*href="([^"]+)"/i);
  if (m) return m[1];
  m = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return m ? decodeEntities(m[1]) : '';
}

// Autor -- RSS usa <dc:creator> o <author>texto plano</author>; Atom usa
// <author><name>...</name></author>. Si el feed no trae nada de esto
// (la mayoría no trae), devuelve '' -- nunca se inventa un autor.
function authorValue(block) {
  var m = block.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  if (m) return decodeEntities(m[1]);
  m = block.match(/<author[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i);
  if (m) return decodeEntities(m[1]);
  m = block.match(/<author[^>]*>([\s\S]*?)<\/author>/i);
  if (m) {
    var raw = decodeEntities(m[1]);
    // Algunos feeds meten "email (Nombre)" en <author> -- si viene así,
    // nos quedamos con el nombre entre paréntesis.
    var paren = raw.match(/\(([^)]+)\)/);
    return paren ? paren[1].trim() : raw;
  }
  m = block.match(/<itunes:author[^>]*>([\s\S]*?)<\/itunes:author>/i);
  if (m) return decodeEntities(m[1]);
  return '';
}

// Imagen de portada que ya trae la fuente RSS (no se genera nada con
// IA acá) -- primero los formatos estándar que traen la URL en un
// atributo (media:content/media:thumbnail/enclosure), y si el feed no
// trae nada de eso, como último recurso se busca el primer <img> del
// HTML de la descripción/resumen.
function imageValue(block) {
  var m = block.match(/<media:content[^>]+url="([^"]+)"[^>]*medium="image"/i)
    || block.match(/<media:content[^>]+medium="image"[^>]*url="([^"]+)"/i)
    || block.match(/<media:thumbnail[^>]+url="([^"]+)"/i)
    || block.match(/<enclosure[^>]+url="([^"]+)"[^>]*type="image[^"]*"/i)
    || block.match(/<enclosure[^>]+type="image[^"]*"[^>]*url="([^"]+)"/i);
  if (m) return unescapeEntities(m[1]);
  var descBlock = block.match(/<(?:description|content:encoded|content)[^>]*>([\s\S]*?)<\/(?:description|content:encoded|content)>/i);
  if (descBlock) {
    // Puede venir como CDATA/HTML crudo (<img ...>) o con las
    // entidades escapadas (&lt;img ...&gt;) -- se prueban ambas.
    var raw = descBlock[1];
    var imgMatch = raw.match(/<img[^>]+src="([^"]+)"/i);
    if (!imgMatch) {
      imgMatch = unescapeEntities(raw).match(/<img[^>]+src="([^"]+)"/i);
    }
    if (imgMatch) return unescapeEntities(imgMatch[1]);
  }
  return '';
}

function parseFeedItems(xml) {
  var items = [];
  var blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  blocks.forEach(function (block) {
    var title = tagValue(block, 'title');
    var rawLink = linkValue(block);
    var link = canonicalizeUrl(rawLink);
    var summary = tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content');
    var pubDate = tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated');
    var pubDateTs = pubDate ? Date.parse(pubDate) : NaN;
    var pubDateISO = isNaN(pubDateTs) ? null : new Date(pubDateTs).toISOString();
    var image = imageValue(block);
    var author = authorValue(block);
    var domain = domainFromUrl(link);
    var outlet = outletNameFromDomain(domain);
    if (!title || !link) return;
    items.push({
      title: title, link: link, summary: summary.slice(0, 600), pubDate: pubDate, image: image,
      author: author, domain: domain, outlet: outlet, pubDateISO: pubDateISO
    });
  });
  return items;
}

// Trae todos los ítems de todos los feeds configurados, agrupados por
// categoría. Si un feed individual falla (caído, cambió de URL, etc.)
// no rompe a los demás — se reporta aparte en "errors".
//
// Auditoria 2026-09-12: el buscador de noticias nuevas solo debe buscar
// temas de las 7 categorías editoriales vigentes (AI, Technology,
// Gaming, Science & Space, Cybersecurity, Guides, Business) -- Sports y
// Entertainment (retiredForNewContent) y cualquier categoría huérfana
// que quedó en feeds.json de una línea editorial anterior (ej. "world",
// que ya ni existe en data/categories.json) se saltan acá, ANTES de
// hacer ninguna solicitud de red -- no se llega a consultar esos feeds
// en absoluto. feeds.json no se edita/borra: queda intacto como
// configuración histórica, por si se reactiva una categoría más
// adelante; el filtro vive en el código, no en el archivo.
function isFeedCategoryAllowed(category) {
  return pagegen.categoriesAcceptingNewContent().some(function (c) { return c.slug === category; });
}

// `deadline` (opcional): cuando viene uno, se pasa a cada fetchUrl() (así
// cada feed individual capa su timeout y su cancelación al tiempo que
// quede) y, además, el recorrido SECUENCIAL de todos los feeds configurados
// se corta apenas el deadline se cumple -- ANTES de arrancar el próximo
// feed, nunca a mitad de una petición ya en curso (esa la corta fetchUrl
// por su cuenta). Lo ya traído hasta ese punto se conserva tal cual
// (nunca se descarta trabajo útil ya hecho); los feeds que no llegaron a
// consultarse simplemente no aportan candidatos en ESTA corrida, y se
// reintentan gratis en la próxima. Sin `deadline`, comportamiento idéntico
// al de siempre.
async function fetchAllFeedItems(deadline) {
  var config = loadFeedsConfig().filter(function (entry) { return isFeedCategoryAllowed(entry.category); });
  var results = [];
  var errors = [];
  for (var i = 0; i < config.length; i++) {
    if (deadline && deadline.expired()) break;
    var entry = config[i];
    try {
      var xml = await fetchUrl(entry.url, undefined, deadline);
      var items = parseFeedItems(xml);
      items.forEach(function (item) {
        results.push({
          category: entry.category, title: item.title, link: item.link, summary: item.summary,
          pubDate: item.pubDate, image: item.image, author: item.author, domain: item.domain,
          outlet: item.outlet, pubDateISO: item.pubDateISO
        });
      });
    } catch (e) {
      errors.push({ url: entry.url, error: e.message });
    }
  }
  return { items: results, errors: errors };
}

module.exports = {
  loadFeedsConfig: loadFeedsConfig,
  fetchAllFeedItems: fetchAllFeedItems,
  parseFeedItems: parseFeedItems,
  canonicalizeUrl: canonicalizeUrl,
  domainFromUrl: domainFromUrl,
  outletNameFromDomain: outletNameFromDomain,
  // Deadline compartido de FASE 1 (pedido de Leonardo, 2026-09-24) -- ver
  // el comentario largo junto a makeChildDeadline más arriba. Expuestas acá
  // (no solo internas) para que pipeline.js las use sin duplicar la lógica.
  makeDeadline: makeDeadline,
  makeChildDeadline: makeChildDeadline,
  // Descubrimiento por Google Trends (pedido 2026-09-25, admin/google-
  // trends.js) -- expuestas para reutilizar el MISMO cliente HTTP con
  // deadline real (fetchUrl) y el MISMO parseo de tags/entidades XML
  // (tagValue/decodeEntities/unescapeEntities) en vez de mantener una
  // segunda copia: trends.google.com/trending/rss también es XML con
  // pubDate/title, así que no hay ningún motivo real para duplicar esto.
  fetchUrl: fetchUrl,
  tagValue: tagValue,
  decodeEntities: decodeEntities,
  unescapeEntities: unescapeEntities
};
