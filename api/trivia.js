/*
  API de la trivia diaria — usado por js/play.js en play/index.html.
  Guarda cuántos lectores acertaron/fallaron la pregunta de cada día,
  para mostrar "el X% acertó" (mismo patrón que api/react.js).

  GET  /api/trivia?day=12345            -> { correct, incorrect }
  POST /api/trivia { day, correct, visitorId } -> registra una vez por
       visitorId+day (no se puede votar dos veces el mismo día) y
       devuelve el total actualizado.
*/

const { createClient } = require('redis');

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
  return {
    correct: parseInt((raw && raw.correct) || '0', 10) || 0,
    incorrect: parseInt((raw && raw.incorrect) || '0', 10) || 0
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') res.setHeader('Access-Control-Allow-Origin', '*');

  var body = req.body || {};
  var daySource = req.method === 'POST' ? body.day : (req.query && req.query.day);
  var day = String(daySource || '').trim().slice(0, 20);
  if (!day || !/^[0-9]+$/.test(day)) {
    return res.status(400).json({ error: 'Falta o es inválido el día' });
  }

  var redis;
  try {
    redis = await getClient();
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo conectar a Redis' });
  }

  var key = 'trivia:' + day;

  if (req.method === 'GET') {
    try {
      var raw = await redis.hGetAll(key);
      return res.status(200).json(normalizeCounts(raw));
    } catch (e) {
      return res.status(500).json({ error: 'Error leyendo la trivia' });
    }
  }

  if (req.method === 'POST') {
    var visitorId = String(body.visitorId || '').trim().slice(0, 100);
    if (!visitorId || typeof body.correct !== 'boolean') {
      return res.status(400).json({ error: 'Falta correct o visitorId válidos' });
    }
    try {
      var dedupeKey = 'trivia_voted:' + day;
      var already = await redis.sIsMember(dedupeKey, visitorId);
      if (!already) {
        await redis.hIncrBy(key, body.correct ? 'correct' : 'incorrect', 1);
        await redis.sAdd(dedupeKey, visitorId);
      }
      var updated = await redis.hGetAll(key);
      return res.status(200).json(normalizeCounts(updated));
    } catch (e) {
      return res.status(500).json({ error: 'Error guardando el resultado' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      var keys = await redis.keys('trivia_voted:' + day);
      if (keys.length) await redis.del(keys);
      await redis.del(key);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Error limpiando la trivia' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método no permitido' });
};
