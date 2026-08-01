/*
  API de la tabla de posiciones de Gravity Flip — usado por
  js/gravity.js en play/gravity.html. Una tabla por nivel (Redis
  sorted set con clave `gravity:board:<levelId>`), los nombres de
  visitante se comparten entre niveles.

  GET  /api/gravity?visitorId=v123&level=level_01        -> { top: [{name, score}, ...], you: {rank, score} | null }
  POST /api/gravity { name, score, visitorId, level } -> guarda el puntaje si es
       un nuevo mejor para ese visitorId en ese nivel, devuelve la misma forma que el GET.
*/

const { createClient } = require('redis');

const BOARD_KEY_PREFIX = 'gravity:board:';
const NAMES_KEY = 'gravity:names';
const DEFAULT_LEVEL = 'level_01';
const TOP_N = 10;
const MAX_SCORE = 2000000;

function sanitizeLevel(level) {
  var s = String(level || '').trim();
  return /^[a-z0-9_]{1,40}$/.test(s) ? s : DEFAULT_LEVEL;
}
function boardKeyFor(level) { return BOARD_KEY_PREFIX + sanitizeLevel(level); }

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', function () {});
    clientPromise = client.connect().then(function () { return client; });
  }
  return clientPromise;
}

async function buildPayload(redis, visitorId, level) {
  var boardKey = boardKeyFor(level);
  var topRaw = await redis.zRangeWithScores(boardKey, 0, TOP_N - 1, { REV: true });
  var ids = topRaw.map(function (e) { return e.value; });
  var names = ids.length ? await redis.hmGet(NAMES_KEY, ids) : [];
  var top = topRaw.map(function (e, i) {
    return { name: names[i] || 'Player', score: e.score };
  });

  var you = null;
  if (visitorId) {
    var rank = await redis.zRevRank(boardKey, visitorId);
    if (rank !== null && rank !== undefined) {
      var score = await redis.zScore(boardKey, visitorId);
      you = { rank: rank + 1, score: score || 0 };
    }
  }

  return { top: top, you: you };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') res.setHeader('Access-Control-Allow-Origin', '*');

  var redis;
  try {
    redis = await getClient();
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo conectar a Redis' });
  }

  if (req.method === 'GET') {
    var visitorId = String((req.query && req.query.visitorId) || '').trim().slice(0, 100);
    var getLevel = (req.query && req.query.level) || DEFAULT_LEVEL;
    try {
      return res.status(200).json(await buildPayload(redis, visitorId, getLevel));
    } catch (e) {
      return res.status(500).json({ error: 'Error leyendo la tabla de posiciones' });
    }
  }

  if (req.method === 'POST') {
    var body = req.body || {};
    var postVisitorId = String(body.visitorId || '').trim().slice(0, 100);
    var name = String(body.name || '').trim().slice(0, 14) || 'Player';
    var score = parseInt(body.score, 10);
    var postLevel = body.level || DEFAULT_LEVEL;
    if (!postVisitorId || isNaN(score) || score < 0) {
      return res.status(400).json({ error: 'Falta score o visitorId válidos' });
    }
    score = Math.min(score, MAX_SCORE);
    try {
      var boardKey = boardKeyFor(postLevel);
      var current = await redis.zScore(boardKey, postVisitorId);
      if (!current || score > current) {
        await redis.zAdd(boardKey, [{ score: score, value: postVisitorId }]);
      }
      await redis.hSet(NAMES_KEY, postVisitorId, name);
      return res.status(200).json(await buildPayload(redis, postVisitorId, postLevel));
    } catch (e) {
      return res.status(500).json({ error: 'Error guardando el puntaje' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método no permitido' });
};
