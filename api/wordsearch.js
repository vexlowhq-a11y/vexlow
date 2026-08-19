/*
  API de la tabla de posiciones global de Word Search — usado por
  js/wordsearch.js en play/wordsearch.html. Mismo patrón que
  api/pulse.js (Redis sorted set), con dos diferencias: una tabla
  separada por dificultad (easy/medium/hard/expert/numbers), y orden
  ASCENDENTE porque acá gana el MENOR tiempo (ms), no el mayor
  puntaje.

  GET  /api/wordsearch?difficulty=easy&visitorId=v123
       -> { top: [{name, score}, ...], you: {rank, score} | null }
  POST /api/wordsearch { difficulty, name, score, visitorId }
       -> guarda el tiempo si es un nuevo mejor para ese visitorId,
          devuelve la misma forma que el GET.
*/

const { createClient } = require('redis');

const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert', 'numbers'];
const TOP_N = 10;
const MAX_SCORE = 3600000; // 1 hora en ms -- cualquier cosa por encima es basura/abuso

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', function () {});
    clientPromise = client.connect().then(function () { return client; });
  }
  return clientPromise;
}

function boardKey(difficulty) { return 'wordsearch:' + difficulty + ':board'; }
function namesKey(difficulty) { return 'wordsearch:' + difficulty + ':names'; }

async function buildPayload(redis, difficulty, visitorId) {
  var topRaw = await redis.zRangeWithScores(boardKey(difficulty), 0, TOP_N - 1);
  var ids = topRaw.map(function (e) { return e.value; });
  var names = ids.length ? await redis.hmGet(namesKey(difficulty), ids) : [];
  var top = topRaw.map(function (e, i) {
    return { name: names[i] || 'Player', score: e.score };
  });

  var you = null;
  if (visitorId) {
    var rank = await redis.zRank(boardKey(difficulty), visitorId);
    if (rank !== null && rank !== undefined) {
      var score = await redis.zScore(boardKey(difficulty), visitorId);
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
    var difficulty = String((req.query && req.query.difficulty) || '').trim();
    if (DIFFICULTIES.indexOf(difficulty) === -1) {
      return res.status(400).json({ error: 'Dificultad inválida' });
    }
    var visitorId = String((req.query && req.query.visitorId) || '').trim().slice(0, 100);
    try {
      return res.status(200).json(await buildPayload(redis, difficulty, visitorId));
    } catch (e) {
      return res.status(500).json({ error: 'Error leyendo la tabla de posiciones' });
    }
  }

  if (req.method === 'POST') {
    var body = req.body || {};
    var postDifficulty = String(body.difficulty || '').trim();
    if (DIFFICULTIES.indexOf(postDifficulty) === -1) {
      return res.status(400).json({ error: 'Dificultad inválida' });
    }
    var postVisitorId = String(body.visitorId || '').trim().slice(0, 100);
    var name = String(body.name || '').trim().slice(0, 14) || 'Player';
    var score = parseInt(body.score, 10);
    if (!postVisitorId || isNaN(score) || score <= 0) {
      return res.status(400).json({ error: 'Falta score o visitorId válidos' });
    }
    score = Math.min(score, MAX_SCORE);
    try {
      var current = await redis.zScore(boardKey(postDifficulty), postVisitorId);
      if (!current || score < current) {
        await redis.zAdd(boardKey(postDifficulty), [{ score: score, value: postVisitorId }]);
      }
      await redis.hSet(namesKey(postDifficulty), postVisitorId, name);
      return res.status(200).json(await buildPayload(redis, postDifficulty, postVisitorId));
    } catch (e) {
      return res.status(500).json({ error: 'Error guardando el tiempo' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método no permitido' });
};
