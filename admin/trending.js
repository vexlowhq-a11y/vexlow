/*
  Trending automático + rotación del carrusel principal — usado por
  admin/auto-publish.js.
  =================================================================
  Dos cosas separadas, cada una con su propio ritmo:

  1. Trending (diario): decide qué artículos llevan la marca
     "trending: true" que ya usaba el sitio (js/script.js
     trendingArticles(), página /categoria/trending/, franja "Top 5
     Trending" de la Home) — antes era 100% manual desde el panel,
     ahora lo recalcula el bot una vez por día combinando reacciones
     reales (api/react.js) con qué tan reciente es cada nota (el
     sitio es joven y tiene poco tráfico, no puede depender solo de
     reacciones o nunca habría trending).

  2. Carrusel principal (semanal): arma data/hero.json (3 a 5
     slides) a partir de lo que esté marcado trending Y tenga imagen,
     con variedad de categoría. Reemplaza el carrusel entero cada vez
     que le toca rotar — no lo va acumulando de a poco.

  El ritmo de cada una se guarda en data/trending-state.json para que
  el bot (que corre cada 6 horas) sepa cuándo ya le toca de nuevo.
*/

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'trending-state.json');
const HERO_FILE = path.join(DATA_DIR, 'hero.json');

const TRENDING_UPDATE_DAYS = 1;
const HERO_ROTATION_DAYS = 7;
const TRENDING_WINDOW_DAYS = 14;
const TRENDING_COUNT = 15;
const HERO_MAX = 5;
const HERO_MIN = 3;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function generateHeroJs(data) {
  var header = '/*\n' +
    '  HERO — diapositivas del carrusel principal de la Home\n' +
    '  =======================================================\n' +
    '  GENERADO AUTOMÁTICAMENTE (bot de publicación — rotación\n' +
    '  semanal de trending). No lo edites a mano. La fuente real es\n' +
    '  data/hero.json.\n' +
    '*/\n';
  return header + 'const VEXLOW_HERO = ' + JSON.stringify(data, null, 2) + ';\n';
}

function loadState() { return readJSON(STATE_FILE, {}); }
function saveState(state) { writeJSON(STATE_FILE, state); }

function daysSince(iso) {
  if (!iso) return Infinity;
  var t = Date.parse(iso);
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}
function ageInDays(dateStr) {
  var t = Date.parse(dateStr);
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

// Best-effort: si el sitio no responde (o no hay reacciones todavía),
// seguimos solo con antigüedad — nunca corta la corrida del bot.
function fetchReactions() {
  return new Promise(function (resolve) {
    var req = https.get('https://vexlowhq.com/api/react?all=1', { timeout: 10000 }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { resolve({}); }
      });
    });
    req.on('timeout', function () { req.destroy(); resolve({}); });
    req.on('error', function () { resolve({}); });
  });
}

function computeTrendingSet(articles, reactions) {
  var candidates = articles.filter(function (a) {
    return a.href && ageInDays(a.date) <= TRENDING_WINDOW_DAYS;
  });
  candidates.forEach(function (a) {
    var r = reactions[a.slug] || {};
    var engagement = (r.like || 0) + (r.fire || 0) * 2 - (r.dislike || 0) * 2;
    var recencyBoost = Math.max(0, TRENDING_WINDOW_DAYS - ageInDays(a.date)) * 0.5;
    a.__trendScore = engagement + recencyBoost;
  });
  candidates.sort(function (a, b) { return b.__trendScore - a.__trendScore; });
  var top = candidates.slice(0, TRENDING_COUNT);
  candidates.forEach(function (a) { delete a.__trendScore; });
  return top;
}

// Muta articles in-place (pone/saca la marca trending). Devuelve
// { updated, count, titles }.
async function maybeUpdateTrending(articles) {
  var state = loadState();
  if (daysSince(state.lastTrendingUpdate) < TRENDING_UPDATE_DAYS) {
    return { updated: false };
  }
  var reactions = await fetchReactions();
  var chosen = computeTrendingSet(articles, reactions);
  var chosenSlugs = new Set(chosen.map(function (a) { return a.slug; }));
  articles.forEach(function (a) { a.trending = chosenSlugs.has(a.slug); });

  state.lastTrendingUpdate = new Date().toISOString();
  saveState(state);
  return { updated: true, count: chosen.length, titles: chosen.map(function (a) { return a.title; }) };
}

// Arma hasta 5 slides (mínimo 3) de entre los trending con imagen,
// variedad de categoría, más recientes primero. Reemplaza
// data/hero.json entero si hay candidatos. Devuelve { rotated, titles }.
async function maybeRotateHero(articles) {
  var state = loadState();
  if (daysSince(state.lastHeroRotation) < HERO_ROTATION_DAYS) {
    return { rotated: false };
  }

  var eligible = articles.filter(function (a) { return a.trending && a.image && a.href; })
    .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

  var picked = [];
  var usedCategories = new Set();
  for (var i = 0; i < eligible.length && picked.length < HERO_MAX; i++) {
    if (usedCategories.has(eligible[i].category)) continue;
    picked.push(eligible[i]);
    usedCategories.add(eligible[i].category);
  }
  if (picked.length < HERO_MIN) {
    for (var j = 0; j < eligible.length && picked.length < HERO_MIN; j++) {
      if (picked.indexOf(eligible[j]) !== -1) continue;
      picked.push(eligible[j]);
    }
  }
  if (!picked.length) return { rotated: false }; // nada elegible todavía, no vaciar el carrusel actual

  var categoryBySlug = require('./pagegen').categoryBySlug;
  var slides = picked.map(function (a) {
    var cat = categoryBySlug(a.category);
    return {
      category: a.category,
      chip: (cat ? cat.icon : '') + ' ' + (cat ? cat.label : a.categoryLabel || ''),
      title: a.title,
      dek: a.dek || '',
      image: a.image,
      textColor: 'auto',
      href: 'https://vexlowhq.com/' + a.href
    };
  });

  writeJSON(HERO_FILE, slides);
  fs.writeFileSync(path.join(DATA_DIR, 'hero.js'), generateHeroJs(slides), 'utf8');

  state.lastHeroRotation = new Date().toISOString();
  saveState(state);
  return { rotated: true, titles: slides.map(function (s) { return s.title; }) };
}

module.exports = {
  maybeUpdateTrending: maybeUpdateTrending,
  maybeRotateHero: maybeRotateHero
};
