/*
  API de reacciones por artículo — usado por js/script.js en las
  páginas de artículo. Guarda los contadores en Redis (Vercel Redis).

  GET  /api/react?slug=mi-articulo        -> { like, fire, mindblown }
  POST /api/react  { slug, reaction, visitorId } -> incrementa (una vez
       por visitorId+reaction) y devuelve los contadores actualizados.
*/

const { createClient } = require('redis');

const REACTIONS = ['like', 'fire', 'mindblown'];

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
    counts[r] = parseInt((raw && raw[r]) || '0', 10) || 0;
  });
  return counts;
}

module.exports = async function handler(req, res) {
  var slug = String((req.query && req.query.slug) || '').trim().slice(0, 200);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Falta o es inválido el slug' });
  }

  var redis;
  try {
    redis = await getClient();
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo conectar a Redis' });
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
    var body = req.body || {};
    var reaction = String(body.reaction || '');
    var visitorId = String(body.visitorId || '').trim().slice(0, 100);
    if (REACTIONS.indexOf(reaction) === -1 || !visitorId) {
      return res.status(400).json({ error: 'Falta reaction o visitorId válidos' });
    }
    try {
      var dedupeKey = 'reacted:' + slug + ':' + visitorId;
      var already = await redis.sIsMember(dedupeKey, reaction);
      if (!already) {
        await redis.hIncrBy(key, reaction, 1);
        await redis.sAdd(dedupeKey, reaction);
      }
      var updated = await redis.hGetAll(key);
      return res.status(200).json(normalizeCounts(updated));
    } catch (e) {
      return res.status(500).json({ error: 'Error guardando la reacción' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método no permitido' });
};
