/*
  Publicación en redes sociales — usado por admin/server.js
  ===========================================================
  Publica una nota ya existente (de data/articulos.json) directamente
  en Instagram (@vexlowhq) usando la Graph API de Meta, sin salir del
  panel. Requiere haber conectado una vez el ID de cuenta de Instagram
  y un Page Access Token de larga duración (ver "Redes sociales" en el
  panel para la guía de esto).

  La imagen tiene que ser accesible por URL pública -- por eso usamos
  la del sitio en vivo (https://vexlowhq.com/img/...) en vez de subir
  el archivo local: la Graph API la descarga ella misma del lado de
  Meta.

  TikTok no está conectado todavía: su API de publicación solo deja
  subir como borrador privado hasta que Meta... digamos, hasta que
  TikTok apruebe la revisión de la app, así que se deja para más
  adelante.
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, '..', 'data', 'social-log.json');
const SITE_ORIGIN = 'https://vexlowhq.com';
const GRAPH_VERSION = 'v21.0';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConfigPatch(patch) {
  var cfg = loadConfig();
  cfg.instagram = cfg.instagram || {};
  if (patch.igUserId !== undefined && patch.igUserId !== null && patch.igUserId !== '') {
    cfg.instagram.igUserId = String(patch.igUserId).trim();
  }
  if (patch.pageAccessToken !== undefined && patch.pageAccessToken !== null && patch.pageAccessToken !== '') {
    cfg.instagram.pageAccessToken = String(patch.pageAccessToken).trim();
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg.instagram;
}

function getStatus() {
  var cfg = loadConfig();
  var ig = cfg.instagram || {};
  var configured = !!(ig.igUserId && ig.pageAccessToken);
  return {
    configured: configured,
    igUserId: ig.igUserId || '',
    // nunca devolvemos el token completo -- solo si hay uno guardado
    hasToken: !!ig.pageAccessToken
  };
}

function loadLog() {
  try {
    var data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    if (!data.instagram) data.instagram = {};
    return data;
  } catch (e) {
    return { instagram: {} };
  }
}

function saveLog(data) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function logPublish(slug, mediaId) {
  var log = loadLog();
  log.instagram[slug] = { postedAt: new Date().toISOString(), mediaId: mediaId };
  saveLog(log);
  return log.instagram[slug];
}

// POST application/x-www-form-urlencoded a graph.facebook.com -- se
// evita mandar el access_token por query string.
function graphPost(pathSegment, params) {
  return new Promise(function (resolve, reject) {
    var body = new URLSearchParams(params).toString();
    var req = https.request({
      hostname: 'graph.facebook.com',
      path: '/' + GRAPH_VERSION + pathSegment,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body)
      }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (res.statusCode !== 200 || !parsed) {
          var msg = (parsed && parsed.error && parsed.error.message) || raw.slice(0, 300) || ('HTTP ' + res.statusCode);
          return reject(new Error('Instagram (Graph API) respondió con error: ' + msg));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function graphGet(pathSegment, params) {
  return new Promise(function (resolve, reject) {
    var qs = new URLSearchParams(params).toString();
    https.get('https://graph.facebook.com/' + GRAPH_VERSION + pathSegment + '?' + qs, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (res.statusCode !== 200 || !parsed) {
          var msg = (parsed && parsed.error && parsed.error.message) || raw.slice(0, 300) || ('HTTP ' + res.statusCode);
          return reject(new Error('Instagram (Graph API) respondió con error: ' + msg));
        }
        resolve(parsed);
      });
    }).on('error', reject);
  });
}

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Sube la imagen (por URL pública) y espera a que Meta termine de
// procesarla antes de publicarla -- si se publica mientras todavía
// está "IN_PROGRESS" la API tira error.
async function waitUntilReady(creationId, token) {
  for (var i = 0; i < 10; i++) {
    var status = await graphGet('/' + creationId, { fields: 'status_code', access_token: token });
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR') throw new Error('Meta no pudo procesar la imagen (status ERROR).');
    await wait(2000);
  }
  throw new Error('La imagen tardó demasiado en procesarse del lado de Instagram. Probá de nuevo en un rato.');
}

async function publishToInstagram(opts) {
  var cfg = loadConfig();
  var ig = cfg.instagram || {};
  if (!ig.igUserId || !ig.pageAccessToken) {
    throw new Error('Instagram todavía no está conectado (falta el ID de cuenta o el token). Configuralo en la pestaña "Redes sociales".');
  }
  if (!opts || !opts.imageUrl || !opts.caption) {
    throw new Error('Falta la imagen o el texto de la publicación.');
  }

  var created = await graphPost('/' + ig.igUserId + '/media', {
    image_url: opts.imageUrl,
    caption: opts.caption,
    access_token: ig.pageAccessToken
  });
  if (!created.id) throw new Error('Instagram no devolvió un ID de publicación al crear el contenedor.');

  await waitUntilReady(created.id, ig.pageAccessToken);

  var published = await graphPost('/' + ig.igUserId + '/media_publish', {
    creation_id: created.id,
    access_token: ig.pageAccessToken
  });
  if (!published.id) throw new Error('Instagram no confirmó la publicación.');

  return { ok: true, mediaId: published.id };
}

// Publica un carrusel (2 a 10 imágenes). Cada imagen se sube primero
// como "item de carrusel" (is_carousel_item), y recién con todos los
// IDs se crea el contenedor CAROUSEL y se publica -- son 2 pasos más
// que una foto sola, pero el mismo mecanismo de fondo.
async function publishCarouselToInstagram(opts) {
  var cfg = loadConfig();
  var ig = cfg.instagram || {};
  if (!ig.igUserId || !ig.pageAccessToken) {
    throw new Error('Instagram todavía no está conectado (falta el ID de cuenta o el token). Configuralo en la pestaña "Redes sociales".');
  }
  if (!opts || !opts.imageUrls || !opts.imageUrls.length || !opts.caption) {
    throw new Error('Faltan las imágenes o el texto de la publicación.');
  }

  var childIds = [];
  for (var i = 0; i < opts.imageUrls.length; i++) {
    var child = await graphPost('/' + ig.igUserId + '/media', {
      image_url: opts.imageUrls[i],
      is_carousel_item: 'true',
      access_token: ig.pageAccessToken
    });
    if (!child.id) throw new Error('Instagram no devolvió un ID para la imagen ' + (i + 1) + ' del carrusel.');
    await waitUntilReady(child.id, ig.pageAccessToken);
    childIds.push(child.id);
  }

  var created = await graphPost('/' + ig.igUserId + '/media', {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption: opts.caption,
    access_token: ig.pageAccessToken
  });
  if (!created.id) throw new Error('Instagram no devolvió un ID de publicación al crear el carrusel.');

  var published = await graphPost('/' + ig.igUserId + '/media_publish', {
    creation_id: created.id,
    access_token: ig.pageAccessToken
  });
  if (!published.id) throw new Error('Instagram no confirmó la publicación del carrusel.');

  return { ok: true, mediaId: published.id };
}

// URL pública de una imagen del sitio a partir de su ruta relativa
// (ej. "img/temas/foo.jpg" -> "https://vexlowhq.com/img/temas/foo.jpg").
// cacheBust (opcional) agrega "?v=<valor>" -- necesario para imágenes
// recién generadas/regeneradas: el CDN de Vercel puede servir una
// copia en caché del archivo VIEJO en esa misma ruta durante un rato
// después del deploy, y waitUntilPublic() de abajo solo chequea que
// la URL responda 200 (que la caché también responde) -- no que el
// contenido sea el nuevo. Una URL con query string nunca vista antes
// no puede venir de una entrada de caché existente, así que fuerza
// que tanto el chequeo como la descarga real de Meta traigan el
// archivo recién subido. (Bug real: un carrusel se publicó con la
// imagen vieja de una diapositiva pese a que el deploy con la
// corregida ya se había subido.)
function publicImageUrl(relativePath, cacheBust) {
  var clean = String(relativePath || '').replace(/^\/+/, '');
  var url = SITE_ORIGIN + '/' + clean;
  if (cacheBust) url += '?v=' + encodeURIComponent(cacheBust);
  return url;
}

// Espera a que una URL del sitio en vivo responda 200 -- se usa antes
// de publicar un carrusel recién generado, porque Meta descarga la
// imagen de vexlowhq.com y el deploy (Vercel) tarda uno o dos minutos
// en propagarse después del git push.
function waitUntilPublic(url, maxAttempts, intervalMs) {
  return new Promise(function (resolve, reject) {
    var attempt = 0;
    function tryOnce() {
      attempt++;
      var req = https.request(url, { method: 'HEAD', timeout: 10000 }, function (res) {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retryOrFail();
      });
      req.on('timeout', function () { req.destroy(); retryOrFail(); });
      req.on('error', function () { retryOrFail(); });
      req.end();
    }
    function retryOrFail() {
      if (attempt >= maxAttempts) {
        return reject(new Error('La imagen todavía no está disponible en ' + url + ' después de esperar el deploy. Probá de nuevo en un minuto.'));
      }
      setTimeout(tryOnce, intervalMs);
    }
    tryOnce();
  });
}

module.exports = {
  getStatus: getStatus,
  saveConfigPatch: saveConfigPatch,
  loadLog: loadLog,
  logPublish: logPublish,
  publishToInstagram: publishToInstagram,
  publishCarouselToInstagram: publishCarouselToInstagram,
  publicImageUrl: publicImageUrl,
  waitUntilPublic: waitUntilPublic
};
