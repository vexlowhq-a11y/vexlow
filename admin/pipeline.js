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
const https = require('https');
const http = require('http');
const feeds = require('./feeds');
const draft = require('./draft');
const pagegen = require('./pagegen');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const DISCARDED_FILE = path.join(DATA_DIR, 'discarded-sources.json');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');
const DRAFT_IMG_DIR = path.join(__dirname, '..', 'img', 'drafts');
const MAX_DRAFT_IMAGE_BYTES = 6 * 1024 * 1024;

const MAX_NEW_DRAFTS = 6;
const MAX_ITEM_AGE_DAYS = 4;
// Ventana para comparar contra artículos YA publicados al buscar
// "misma historia, otra fuente" (ver similarWords()/isSameStoryAsPublished()
// abajo) -- no hace falta comparar contra los ~200 históricos en cada
// corrida, solo contra lo reciente.
const SIMILARITY_LOOKBACK_DAYS = 21;
// Umbral de superposición de palabras significativas (título+resumen)
// para considerar que un ítem de RSS entrante es la MISMA historia que
// un artículo ya publicado, aunque el título/link sean distintos
// (fuentes distintas cubriendo el mismo hecho, o la IA reescribiendo
// el título de nuevo). Conservador a propósito: mejor dejar pasar
// algún duplicado ocasional que rechazar por error una historia
// legítima que solo comparte tema general. Calibrado a mano contra
// los ~200 artículos ya publicados: a 0.4, agarra 7 de 7 pares
// duplicados conocidos (Agility Robotics, Databricks, Apple/OpenAI,
// etc.) con CERO falsos positivos en las 2278 combinaciones posibles
// dentro de la categoría "ai" -- bajarlo a 0.35 agarra 2 pares más
// pero empieza a acercarse a artículos genuinamente distintos que
// solo comparten vocabulario de tema (ej. "chip"/"artificial
// intelligence" entre dos empresas distintas).
// Bloqueo duro para candidatos que tocan explotación/abuso sexual
// infantil (o material derivado, como fotos de menores manipuladas a
// contenido explícito con IA) -- se descartan ANTES de redactar, no
// después. A propósito conservador: mejor perder alguna nota legítima
// de política de seguridad infantil (rara, y sin las palabras "child"
// + término explícito juntas) que arriesgarse a redactar algo de esta
// categoría. No es solo un tema de AdSense -- es la clase de contenido
// que no debería llegar a la cola de revisión ni una vez, encontrado
// después de que un candidato real (menor + imagen manipulada a
// contenido explícito) llegó a redactarse el 2026-08-15.
const CHILD_SAFETY_TERMS = /\b(child|minor|childhood|kid|underage)\b/i;
const EXPLICIT_TERMS = /\b(explicit|nude|nudity|naked|sexual(?:ly)?|pornographic|porn|csam|sexual abuse|sex abuse|molest)/i;
function isChildSafetyRisk(text) {
  var t = String(text || '');
  return CHILD_SAFETY_TERMS.test(t) && EXPLICIT_TERMS.test(t);
}

const SAME_STORY_OVERLAP_THRESHOLD = 0.4;
// Umbral para el chequeo de "copia literal de la fuente" (ver
// verbatimOverlapRatio() abajo) -- distinto del de arriba: éste no
// compara temas/palabras clave, compara frases de 6 palabras
// SEGUIDAS. Calibrado a mano con reescrituras sintéticas: una
// reescritura genuina (mismos hechos, otra redacción) da 0.00; un
// parafraseo perezoso que solo cambia un par de palabras por oración
// ya da ~0.39; una copia literal con algo agregado da 1.00. 0.3 deja
// pasar coincidencias de frases genéricas cortas ("according to
// sources familiar with") sin marcar, pero agarra cualquier tramo
// real copiado del resumen de la fuente.
const COPY_WARNING_THRESHOLD = 0.3;
// Umbral del chequeo complementario de "parafraseo perezoso" (ver
// maxSentenceSimilarity() abajo) -- agarra el caso de una oración de
// la fuente que sobrevive casi intacta cambiando solo un par de
// palabras por sinónimos, algo que el chequeo de 6 palabras EXACTAS
// no detecta porque alcanza con romper una sola palabra de la cadena
// para esquivarlo. Calibrado igual con reescrituras sintéticas: una
// reescritura genuina da ~0.10-0.15, un parafraseo de sinónimos da
// 0.8+ -- 0.55 deja margen de sobra para no marcar coincidencias
// casuales de una frase corta y corriente.
const PARAPHRASE_WARNING_THRESHOLD = 0.55;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'into', 'over',
  'after', 'before', 'about', 'than', 'then', 'so', 'not', 'no', 'new', 'says', 'said', 'amid', 'up',
  'out', 'now', 'more', 'first', 'how', 'what', 'why', 'when', 'who'
]);

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

// Palabras significativas (sin stopwords ni palabras de 2 letras o
// menos) de un texto -- la base para detectar "misma historia, otra
// redacci\u00f3n" por superposici\u00f3n, ya que normalizeTitle() por s\u00ed sola
// solo detecta coincidencia EXACTA de t\u00edtulo.
function significantWords(text) {
  var words = normalizeTitle(text).split(' ').filter(function (w) {
    return w.length > 2 && !STOPWORDS.has(w);
  });
  return new Set(words);
}

// Superposici\u00f3n entre dos conjuntos de palabras, como fracci\u00f3n del
// m\u00e1s chico (no Jaccard puro) -- as\u00ed un resumen largo que menciona de
// pasada las mismas 4-5 palabras clave de un t\u00edtulo corto igual
// cuenta como coincidencia fuerte.
function wordOverlapScore(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  var smaller = setA.size <= setB.size ? setA : setB;
  var larger = setA.size <= setB.size ? setB : setA;
  var shared = 0;
  smaller.forEach(function (w) { if (larger.has(w)) shared++; });
  return shared / smaller.size;
}

function normalizeForShingles(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Shingles" de N palabras seguidas (n-gramas) de un texto -- la
// unidad que usa verbatimOverlapRatio() para detectar copia literal.
function shingles(text, n) {
  var words = normalizeForShingles(text).split(' ').filter(Boolean);
  var out = new Set();
  for (var i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(' '));
  }
  return out;
}

// Fracción de los shingles de 6 palabras del texto FUENTE que
// aparecen tal cual, palabra por palabra, en el texto GENERADO. A
// diferencia de wordOverlapScore() (que mide tema/vocabulario
// compartido, esperable en cualquier reescritura legítima), esto
// mide frases enteras copiadas -- una reescritura genuina casi nunca
// repite 6 palabras seguidas de la fuente, así que un valor alto acá
// es señal real de copia, no de "mismo tema".
function verbatimOverlapRatio(sourceText, generatedText, n) {
  n = n || 6;
  var sourceShingles = shingles(sourceText, n);
  if (!sourceShingles.size) return 0;
  var generatedNorm = ' ' + normalizeForShingles(generatedText) + ' ';
  var matched = 0;
  sourceShingles.forEach(function (sh) {
    if (generatedNorm.indexOf(' ' + sh + ' ') !== -1) matched++;
  });
  return matched / sourceShingles.size;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.split(/\s+/).length >= 6; });
}

function bigrams(text) {
  var words = normalizeForShingles(text).split(' ').filter(Boolean);
  var out = new Set();
  for (var i = 0; i + 2 <= words.length; i++) out.add(words.slice(i, i + 2).join(' '));
  return out;
}

function diceCoefficient(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  var shared = 0;
  setA.forEach(function (x) { if (setB.has(x)) shared++; });
  return (2 * shared) / (setA.size + setB.size);
}

// Complementa verbatimOverlapRatio(): agarra un "parafraseo perezoso"
// que cambia una o dos palabras por oración (sinónimos) y por eso se
// escapa del chequeo de 6 palabras EXACTAS seguidas. Compara cada
// oración de la fuente contra cada oración del texto generado por
// superposición de bigramas (coeficiente de Dice) y se queda con el
// par más parecido -- si UNA sola oración de la fuente sobrevive casi
// intacta (solo con sinónimos cambiados) en el artículo, se nota acá
// aunque el resto del artículo sea original. Con reescrituras
// genuinas da ~0.10-0.15 (nada que ver, ni una oración se parece); un
// parafraseo de sinónimos da 0.8+.
function maxSentenceSimilarity(sourceText, generatedText) {
  var sourceSentences = splitSentences(sourceText);
  var generatedSentences = splitSentences(generatedText);
  var best = 0;
  sourceSentences.forEach(function (s) {
    var sBigrams = bigrams(s);
    generatedSentences.forEach(function (g) {
      var d = diceCoefficient(sBigrams, bigrams(g));
      if (d > best) best = d;
    });
  });
  return best;
}

function daysAgo(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function isRecent(pubDate) {
  if (!pubDate) return true; // sin fecha: no lo descartamos por eso
  var t = Date.parse(pubDate);
  if (isNaN(t)) return true;
  var ageMs = Date.now() - t;
  return ageMs <= MAX_ITEM_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// Categorías de contenido reales (excluye "trending", que no es una
// categoría propia — es un agregado de las demás).
function listCategories() {
  return pagegen.loadCategories().filter(function (c) { return c.slug !== 'trending'; })
    .map(function (c) { return { slug: c.slug, label: c.label }; });
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

// Trae feeds, descarta lo ya visto (publicado, en borradores, o
// descartado a mano) y devuelve hasta MAX_NEW_DRAFTS candidatos
// nuevos, priorizados por cuántas fuentes distintas cubren cada
// historia (lo más grande/buscado del momento primero, sin importar
// la categoría). Usado por el flujo manual (fetchNewDrafts, abajo).
async function buildCandidates() {
  var drafts = readJSON(DRAFTS_FILE, []);
  var discarded = readJSON(DISCARDED_FILE, []);
  var published = readJSON(ARTICULOS_FILE, []);

  var knownLinks = new Set(discarded);
  drafts.forEach(function (d) { if (d.sourceUrl) knownLinks.add(d.sourceUrl); });
  published.forEach(function (a) { if (a.sourceUrl) knownLinks.add(a.sourceUrl); });

  var knownTitles = new Set();
  drafts.forEach(function (d) { knownTitles.add(normalizeTitle(d.sourceTitle || d.title)); });
  published.forEach(function (a) { knownTitles.add(normalizeTitle(a.title)); });

  // Palabras significativas de lo publicado recientemente + lo que ya
  // está en borradores -- para detectar "misma historia, otra fuente/
  // otro título" además del chequeo de link/título exacto de arriba.
  // Sin esto, dos feeds distintos cubriendo el mismo hecho (o la IA
  // titulando distinto la segunda vez) pasan los filtros exactos sin
  // problema y terminan publicados dos veces.
  var recentCutoff = daysAgo(SIMILARITY_LOOKBACK_DAYS);
  var recentWordSets = [];
  published.forEach(function (a) {
    var t = Date.parse(a.date);
    if (!isNaN(t) && t < recentCutoff) return;
    recentWordSets.push(significantWords((a.title || '') + ' ' + (a.dek || '')));
  });
  drafts.forEach(function (d) {
    recentWordSets.push(significantWords((d.sourceTitle || d.title || '') + ' ' + (d.dek || '')));
  });
  function isSameStoryAsKnown(item) {
    var words = significantWords((item.title || '') + ' ' + (item.summary || ''));
    for (var i = 0; i < recentWordSets.length; i++) {
      if (wordOverlapScore(words, recentWordSets[i]) >= SAME_STORY_OVERLAP_THRESHOLD) return true;
    }
    return false;
  }

  var fetched = await feeds.fetchAllFeedItems();
  var candidates = fetched.items.filter(function (item) {
    if (isChildSafetyRisk((item.title || '') + ' ' + (item.summary || ''))) return false;
    if (knownLinks.has(item.link)) return false;
    if (knownTitles.has(normalizeTitle(item.title))) return false;
    if (!isRecent(item.pubDate)) return false;
    if (isSameStoryAsKnown(item)) return false;
    return true;
  });

  // No repetir la misma historia dos veces dentro de esta misma corrida
  // (varios feeds suelen cubrir la misma noticia el mismo día) -- primero
  // por título exacto, y después por superposición de palabras entre
  // los candidatos que van quedando, para el caso de títulos distintos
  // sobre el mismo hecho. En vez de solo descartar los duplicados, se
  // cuentan (sourceCount) -- esa cuenta es la señal real de "esto es
  // grande ahora mismo" que se usa más abajo para priorizar.
  var seenTitles = new Set();
  var deduped = [];
  candidates.forEach(function (item) {
    var key = normalizeTitle(item.title);
    if (seenTitles.has(key)) {
      var exactMatch = deduped.filter(function (d) { return normalizeTitle(d.title) === key; })[0];
      if (exactMatch) exactMatch.sourceCount++;
      return;
    }
    seenTitles.add(key);

    var words = significantWords((item.title || '') + ' ' + (item.summary || ''));
    for (var i = 0; i < deduped.length; i++) {
      if (wordOverlapScore(words, deduped[i]._words) >= SAME_STORY_OVERLAP_THRESHOLD) {
        deduped[i].sourceCount++;
        return;
      }
    }
    item.sourceCount = 1;
    item._words = words;
    deduped.push(item);
  });
  deduped.forEach(function (item) { delete item._words; });
  candidates = deduped;

  // Priorizar lo que más fuentes distintas están cubriendo ahora mismo
  // (mismo hecho real reportado por 2+ feeds a la vez) en vez de repartir
  // parejo entre categorías -- la intención del sitio es maximizar
  // visitas con lo más buscado del momento, no llenar cada categoría
  // por igual. Empate en sourceCount: se conserva el orden en que
  // aparecieron los feeds (los primeros configurados/más recientes).
  candidates.sort(function (a, b) { return b.sourceCount - a.sourceCount; });
  candidates = candidates.slice(0, MAX_NEW_DRAFTS);

  var takenSlugs = new Set();
  drafts.forEach(function (d) { takenSlugs.add(d.slug); });
  published.forEach(function (a) { takenSlugs.add(a.slug); });

  return { candidates: candidates, errors: fetched.errors.slice(), skipped: fetched.items.length - candidates.length, takenSlugs: takenSlugs };
}

// Nombre de archivo corto para la imagen de portada de un borrador --
// a diferencia del slug completo del artículo, acá conviene que sea
// corto (para identificar de un vistazo a qué borrador pertenece sin
// que el nombre sea kilométrico) y único (sufijo random de 4 hex).
function shortDraftImageName(title) {
  var base = pagegen.slugify(title).slice(0, 40).replace(/-+$/, '');
  var suffix = Math.random().toString(16).slice(2, 6);
  return (base || 'draft') + '-' + suffix;
}

function downloadBinary(url, redirectsLeft) {
  redirectsLeft = redirectsLeft == null ? 4 : redirectsLeft;
  return new Promise(function (resolve, reject) {
    var lib = url.indexOf('https:') === 0 ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VexlowHQBot/1.0; +https://vexlowhq.com)' }, timeout: 12000 }, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        var next = new URL(res.headers.location, url).toString();
        return resolve(downloadBinary(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      var contentType = res.headers['content-type'] || '';
      var chunks = [];
      var total = 0;
      res.on('data', function (c) {
        total += c.length;
        if (total > MAX_DRAFT_IMAGE_BYTES) { req.destroy(new Error('imagen demasiado grande')); return; }
        chunks.push(c);
      });
      res.on('end', function () { resolve({ buffer: Buffer.concat(chunks), contentType: contentType }); });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function extFromUrlOrType(url, contentType) {
  var m = /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.exec(url);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  if (/image\/png/i.test(contentType)) return 'png';
  if (/image\/webp/i.test(contentType)) return 'webp';
  if (/image\/gif/i.test(contentType)) return 'gif';
  return 'jpg';
}

// Descarga localmente la imagen que ya trae la fuente RSS (no genera
// nada con IA) y la guarda con nombre corto en img/drafts/, para poder
// identificar de un vistazo a qué borrador pertenece en el panel. Si
// el feed no traía imagen o la descarga falla, no rompe el borrador --
// simplemente queda sin imagen (como pasaba antes de este cambio).
async function downloadDraftImage(url, title) {
  if (!url) return '';
  try {
    var result = await downloadBinary(url);
    var ext = extFromUrlOrType(url, result.contentType);
    var name = shortDraftImageName(title) + '.' + ext;
    if (!fs.existsSync(DRAFT_IMG_DIR)) fs.mkdirSync(DRAFT_IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DRAFT_IMG_DIR, name), result.buffer);
    return 'img/drafts/' + name;
  } catch (e) {
    return '';
  }
}

// Corre el pipeline completo (flujo manual: deja todo en borradores
// para revisión). Devuelve { added, skipped, errors, noApiKey }.
// Si no hay API key configurada, no intenta nada y avisa una sola vez
// (en vez de fallar ítem por ítem).
async function fetchNewDrafts() {
  var cfg = draft.loadConfig();
  var apiKey = cfg.draftProvider === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!apiKey) {
    return { added: 0, skipped: 0, errors: [], noApiKey: true };
  }

  var drafts = readJSON(DRAFTS_FILE, []);
  var built = await buildCandidates();
  var candidates = built.candidates;
  var takenSlugs = built.takenSlugs;
  var categoryOptions = listCategories();

  var added = 0;
  var flaggedForSimilarity = 0;
  var errors = built.errors;

  for (var i = 0; i < candidates.length; i++) {
    var item = candidates[i];
    var cat = pagegen.categoryBySlug(item.category);
    if (!cat) continue;

    try {
      var result = await draft.draftArticle(item, cfg, categoryOptions);
      var finalCat = pagegen.categoryBySlug(result.category) || cat;
      var slug = uniqueSlug(pagegen.slugify(result.title), takenSlugs);
      var localImage = await downloadDraftImage(item.image, result.title);
      // Chequeo anti-copia: compara el resumen ORIGINAL de la fuente
      // contra el título+dek+cuerpo que redactó la IA. Es una red de
      // seguridad además de la instrucción del prompt (admin/draft.js
      // ya le pide "nunca copiar ni parafrasear de cerca"), por si la
      // IA no la respeta en algún caso puntual -- copiar texto de la
      // fuente casi textual es justo el tipo de "contenido de poco
      // valor"/scraped content que penaliza AdSense.
      var sourceText = (item.title || '') + '. ' + (item.summary || '');
      var generatedText = (result.title || '') + '. ' + (result.dek || '') + ' ' + (result.body || '');
      var copyRatio = verbatimOverlapRatio(sourceText, generatedText, 6);
      var paraphraseRatio = maxSentenceSimilarity(sourceText, generatedText);
      var similarityWarning = copyRatio >= COPY_WARNING_THRESHOLD || paraphraseRatio >= PARAPHRASE_WARNING_THRESHOLD;
      if (similarityWarning) flaggedForSimilarity++;
      drafts.push({
        title: result.title,
        category: finalCat.slug,
        categoryLabel: finalCat.label,
        icon: finalCat.icon,
        date: todayISO(),
        readTime: result.readTime || '',
        slug: slug,
        dek: result.dek,
        image: localImage,
        videoUrl: '',
        trending: false,
        body: result.body,
        sourceUrl: item.link,
        sourceTitle: item.title,
        similarityWarning: similarityWarning,
        similarityScore: Math.round(Math.max(copyRatio, paraphraseRatio) * 100),
        createdAt: new Date().toISOString()
      });
      added++;
    } catch (e) {
      errors.push({ url: item.link, error: e.message === 'NO_API_KEY' ? 'Sin API key' : e.message });
    }
  }

  writeJSON(DRAFTS_FILE, drafts);

  return { added: added, skipped: built.skipped, errors: errors, flaggedForSimilarity: flaggedForSimilarity, noApiKey: false };
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
  removeDraft: removeDraft,
  buildCandidates: buildCandidates,
  listCategories: listCategories,
  uniqueSlug: uniqueSlug,
  todayISO: todayISO
};
