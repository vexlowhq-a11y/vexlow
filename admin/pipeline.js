/*
  Pipeline de "buscar temas nuevos" — usado por admin/server.js
  =================================================================
  Trae titulares de los feeds RSS (admin/feeds.js), descarta los que
  ya se usaron antes (publicados, ya sugeridos como borrador, o
  descartados a mano), y redacta un borrador original por cada uno
  de los que queden (admin/draft.js) — hasta un máximo por corrida
  para controlar el costo. Los borradores quedan en data/drafts.json,
  nunca se publican solos.
*/

const fs = require('fs');
const path = require('path');
const feeds = require('./feeds');
const draft = require('./draft');
const pagegen = require('./pagegen');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const DISCARDED_FILE = path.join(DATA_DIR, 'discarded-sources.json');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');

const MAX_NEW_DRAFTS = 6;
const MAX_ITEM_AGE_DAYS = 4;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isRecent(pubDate) {
  if (!pubDate) return true; // sin fecha: no lo descartamos por eso
  var t = Date.parse(pubDate);
  if (isNaN(t)) return true;
  var ageMs = Date.now() - t;
  return ageMs <= MAX_ITEM_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function listTopicsFor(category) {
  var topicGroups = pagegen.loadTopicGroups();
  var seen = new Set();
  var topics = [];
  (topicGroups[category] || []).forEach(function (group) {
    group[1].forEach(function (pair) {
      var slug = pair[0], label = pair[1];
      if (seen.has(slug)) return;
      seen.add(slug);
      topics.push({ slug: slug, label: label });
    });
  });
  return topics;
}

function uniqueSlug(base, taken) {
  var slug = base || 'articulo';
  var counter = 1;
  while (taken.has(slug)) {
    slug = base + '-' + counter;
    counter++;
  }
  taken.add(slug);
  return slug;
}

function todayISO() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

// Corre el pipeline completo. Devuelve { added, skipped, errors, noApiKey }.
// Si no hay API key configurada, no intenta nada y avisa una sola vez
// (en vez de fallar ítem por ítem).
async function fetchNewDrafts() {
  var cfg = draft.loadConfig();
  var apiKey = cfg.draftProvider === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!apiKey) {
    return { added: 0, skipped: 0, errors: [], noApiKey: true };
  }

  var drafts = readJSON(DRAFTS_FILE, []);
  var discarded = readJSON(DISCARDED_FILE, []);
  var published = readJSON(ARTICULOS_FILE, []);

  var knownLinks = new Set(discarded);
  drafts.forEach(function (d) { if (d.sourceUrl) knownLinks.add(d.sourceUrl); });
  published.forEach(function (a) { if (a.sourceUrl) knownLinks.add(a.sourceUrl); });

  var knownTitles = new Set();
  drafts.forEach(function (d) { knownTitles.add(normalizeTitle(d.sourceTitle || d.title)); });
  published.forEach(function (a) { knownTitles.add(normalizeTitle(a.title)); });

  var takenSlugs = new Set();
  drafts.forEach(function (d) { takenSlugs.add(d.slug); });
  published.forEach(function (a) { takenSlugs.add(a.slug); });

  var fetched = await feeds.fetchAllFeedItems();
  var candidates = fetched.items.filter(function (item) {
    if (knownLinks.has(item.link)) return false;
    if (knownTitles.has(normalizeTitle(item.title))) return false;
    if (!isRecent(item.pubDate)) return false;
    return true;
  });

  // No repetir la misma historia dos veces dentro de esta misma corrida
  // (varios feeds suelen cubrir la misma noticia el mismo día).
  var seenThisRun = new Set();
  candidates = candidates.filter(function (item) {
    var key = normalizeTitle(item.title);
    if (seenThisRun.has(key)) return false;
    seenThisRun.add(key);
    return true;
  });

  candidates = candidates.slice(0, MAX_NEW_DRAFTS);

  var added = 0;
  var errors = fetched.errors.slice();
  var topicsCache = {};

  for (var i = 0; i < candidates.length; i++) {
    var item = candidates[i];
    var cat = pagegen.CATEGORY_BY_SLUG[item.category];
    if (!cat) continue;
    if (!topicsCache[item.category]) topicsCache[item.category] = listTopicsFor(item.category);

    try {
      var result = await draft.draftArticle(item, topicsCache[item.category], cfg);
      var slug = uniqueSlug(pagegen.slugify(result.title), takenSlugs);
      drafts.push({
        title: result.title,
        category: item.category,
        categoryLabel: cat.label,
        icon: cat.icon,
        date: todayISO(),
        readTime: result.readTime || '',
        topic: result.topic || '',
        slug: slug,
        dek: result.dek,
        image: '',
        videoUrl: '',
        trending: false,
        body: result.body,
        sourceUrl: item.link,
        sourceTitle: item.title,
        createdAt: new Date().toISOString()
      });
      added++;
    } catch (e) {
      errors.push({ url: item.link, error: e.message === 'NO_API_KEY' ? 'Sin API key' : e.message });
    }
  }

  writeJSON(DRAFTS_FILE, drafts);

  return { added: added, skipped: fetched.items.length - candidates.length, errors: errors, noApiKey: false };
}

function discardDraft(slug) {
  var drafts = readJSON(DRAFTS_FILE, []);
  var discarded = readJSON(DISCARDED_FILE, []);
  var target = drafts.find(function (d) { return d.slug === slug; });
  var remaining = drafts.filter(function (d) { return d.slug !== slug; });
  writeJSON(DRAFTS_FILE, remaining);
  if (target && target.sourceUrl) {
    discarded.push(target.sourceUrl);
    writeJSON(DISCARDED_FILE, discarded);
  }
  return !!target;
}

// Cuando un borrador se "usa" (se carga en el formulario y se guarda como
// artículo real), lo sacamos de la lista de borradores.
function removeDraft(slug) {
  var drafts = readJSON(DRAFTS_FILE, []);
  var remaining = drafts.filter(function (d) { return d.slug !== slug; });
  var changed = remaining.length !== drafts.length;
  if (changed) writeJSON(DRAFTS_FILE, remaining);
  return changed;
}

module.exports = {
  fetchNewDrafts: fetchNewDrafts,
  discardDraft: discardDraft,
  removeDraft: removeDraft
};
