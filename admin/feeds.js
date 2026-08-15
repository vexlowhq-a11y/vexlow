/*
  Lectura de feeds RSS — usado por admin/server.js
  =================================================================
  Trae los últimos titulares de los feeds configurados en
  admin/feeds.json (uno o varios por categoría) para usarlos como
  base de artículos nuevos. Solo lee título + resumen + link + fecha
  de cada feed — el texto del artículo en sí se redacta de cero en
  admin/draft.js, nunca se copia el contenido original.
*/

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FEEDS_FILE = path.join(__dirname, 'feeds.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; VexlowHQBot/1.0; +https://vexlowhq.com)';
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12000;

function loadFeedsConfig() {
  try {
    return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function fetchUrl(url, redirectsLeft) {
  redirectsLeft = redirectsLeft == null ? MAX_REDIRECTS : redirectsLeft;
  return new Promise(function (resolve, reject) {
    var lib = url.indexOf('https:') === 0 ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }, timeout: TIMEOUT_MS }, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, redirectsLeft - 1));
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
    req.on('error', reject);
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
    var link = linkValue(block);
    var summary = tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content');
    var pubDate = tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated');
    var image = imageValue(block);
    if (!title || !link) return;
    items.push({ title: title, link: link, summary: summary.slice(0, 600), pubDate: pubDate, image: image });
  });
  return items;
}

// Trae todos los ítems de todos los feeds configurados, agrupados por
// categoría. Si un feed individual falla (caído, cambió de URL, etc.)
// no rompe a los demás — se reporta aparte en "errors".
async function fetchAllFeedItems() {
  var config = loadFeedsConfig();
  var results = [];
  var errors = [];
  for (var i = 0; i < config.length; i++) {
    var entry = config[i];
    try {
      var xml = await fetchUrl(entry.url);
      var items = parseFeedItems(xml);
      items.forEach(function (item) {
        results.push({ category: entry.category, title: item.title, link: item.link, summary: item.summary, pubDate: item.pubDate, image: item.image });
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
  parseFeedItems: parseFeedItems
};
