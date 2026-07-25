/*
  API de reacciones por artículo — usado por js/script.js en las
  páginas de artículo. Guarda los contadores en Redis (Vercel Redis).

  GET  /api/react?slug=mi-articulo        -> { like, fire, dislike }
  GET  /api/react?all=1                   -> { "slug-1": {like,fire,dislike}, ... }
       (todos los artículos con al menos una reacción — la usa el panel
       de administración para mostrar qué está gustando más)
  POST /api/react  { slug, reaction, visitorId } -> alterna la reacción
       (si el visitorId ya la había puesto, la saca y resta; si no,
       la suma) y devuelve los contadores actualizados + si quedó
       activa ({ ...counts, active: true|false }).
*/

const { createClient } = require('redis');

const REACTIONS = ['like', 'fire', 'dislike'];

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', function () {});
    clientPromise = client.connect().then(function () { return client; });
  }
  return clientPromise;
}

function normalizeCounts(raw) {
  var counts = {};
  REACTIONS.forEach(function (r) {
    var n = parseInt((raw && raw[r]) || '0', 10) || 0;
    counts[r] = n < 0 ? 0 : n;
  });
  return counts;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') res.setHeader('Access-Control-Allow-Origin', '*');

  var redis;
  try {
    redis = await getClient();
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo conectar a Redis' });
  }

  if (req.method === 'GET' && req.query && req.query.all) {
    try {
      var keys = await redis.keys('reactions:*');
      var result = {};
      for (var i = 0; i < keys.length; i++) {
        var raw = await redis.hGetAll(keys[i]);
        result[keys[i].slice('reactions:'.length)] = normalizeCounts(raw);
      }
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: 'Error leyendo reacciones' });
    }
  }

  var body = req.body || {};
  var slugSource = req.method === 'POST' ? body.slug : (req.query && req.query.slug);
  var slug = String(slugSource || '').trim().slice(0, 200);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Falta o es inválido el slug' });
  }

  var key = 'reactions:' + slug;

  if (req.method === 'GET') {
    try {
      var raw = await redis.hGetAll(key);
      return res.status(200).json(normalizeCounts(raw));
    } catch (e) {
      return res.status(500).json({ error: 'Error leyendo reacciones' });
    }
  }

  if (req.method === 'POST') {
    var reaction = String(body.reaction || '');
    var visitorId = String(body.visitorId || '').trim().slice(0, 100);
    if (REACTIONS.indexOf(reaction) === -1 || !visitorId) {
      return res.status(400).json({ error: 'Falta reaction o visitorId válidos' });
    }
    try {
      var dedupeKey = 'reacted:' + slug + ':' + visitorId;
      var already = await redis.sIsMember(dedupeKey, reaction);
      var active;
      if (already) {
        await redis.hIncrBy(key, reaction, -1);
        await redis.sRem(dedupeKey, reaction);
        active = false;
      } else {
        await redis.hIncrBy(key, reaction, 1);
        await redis.sAdd(dedupeKey, reaction);
        active = true;
      }
      var updated = await redis.hGetAll(key);
      var payload = normalizeCounts(updated);
      payload.active = active;
      return res.status(200).json(payload);
    } catch (e) {
      return res.status(500).json({ error: 'Error guardando la reacción' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método no permitido' });
};
