/*
  Bot de publicación automática — "el bot que hace todo por vos"
  =================================================================
  Pensado para correr solo, disparado por una tarea programada de
  Windows cada N horas (ver admin/README-automatizacion.md), sin que
  el panel (admin/server.js) tenga que estar abierto. También se
  puede disparar a mano con el botón "Correr ahora" del panel
  (que llama a este mismo script con --force), o directo:

    node admin/auto-publish.js         (respeta el interruptor del panel)
    node admin/auto-publish.js --force (corre aunque esté apagado, para probar)

  Qué hace, en orden — es la versión sin manos del flujo que ya hacía
  el usuario a mano (Buscar temas nuevos -> revisar -> Guardar ->
  Regenerar -> Publicar cambios):
    1. Si el interruptor "autoPublish.enabled" de admin/config.json
       está apagado y no vino --force, no hace NADA (ni un log).
    2. Busca noticias nuevas en los feeds RSS (admin/pipeline.js).
    3. Por cada una, le pide a la IA un artículo original — y ahora
       también le pide que confirme/corrija la CATEGORÍA (no solo el
       tema), porque los feeds generales venían mal categorizando
       algunas notas (admin/draft.js).
    4. Si la IA sugiere un tema que no existe todavía, lo crea
       (pagegen.addTopic) en vez de dejarlo sin tema.
    5. Le pide una imagen destacada a la API de OpenAI (gpt-image-1.5,
       calidad "low" — ver admin/config.json "imageGeneration") y la
       guarda en img/temas/. Si falla (sin crédito, error de red, etc.)
       el artículo se publica igual, sin imagen — no se corta la
       corrida. Solo aplica a artículos nuevos, no reprocesa los viejos.
    5b. Guarda cada artículo en data/articulos.json y genera su página
       HTML.
    6. Una vez por día (admin/trending.js), recalcula qué artículos
       están "trending" combinando reacciones reales (api/react.js)
       con antigüedad — reemplaza cualquier marca manual anterior.
       Una vez por semana, arma el carrusel principal (data/hero.json,
       3 a 5 slides) a partir de los trending que ya tengan imagen,
       reemplazándolo entero (no lo acumula de a poco).
    7. Regenera categorías/temas/sitemap (generate_pages.py) y hace
       git add + commit + push (admin/deploy.js) — así lo publicado
       queda de verdad en vexlowhq.com, no solo en el disco local.
    8. Deja un resumen de la corrida en data/automation-log.json
       (para verlo en la pestaña "Automatización" del panel).
*/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const draft = require('./draft');
const pipeline = require('./pipeline');
const pagegen = require('./pagegen');
const deploy = require('./deploy');
const imageGen = require('./image-gen');
const trending = require('./trending');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');
const AUTOMATION_LOG_FILE = path.join(DATA_DIR, 'automation-log.json');
const MAX_LOG_ENTRIES = 50;

const FORCE = process.argv.indexOf('--force') !== -1;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function generateArticulosJs(data) {
  var header = '/*\n' +
    '  ARTÍCULOS — fuente de "Últimas publicadas" y de las páginas de categoría\n' +
    '  ==========================================================================\n' +
    '  GENERADO AUTOMÁTICAMENTE (panel de administración / bot de\n' +
    '  publicación automática). No lo edites a mano. La fuente real es\n' +
    '  data/articulos.json.\n' +
    '*/\n';
  return header + 'const VEXLOW_ARTICLES = ' + JSON.stringify(data, null, 2) + ';\n';
}
function runPython(scriptPath) {
  return new Promise(function (resolve, reject) {
    var py = spawn('python', [scriptPath], { cwd: ROOT });
    var out = '';
    py.stdout.on('data', function (d) { out += d.toString('utf8'); });
    py.stderr.on('data', function (d) { out += d.toString('utf8'); });
    py.on('error', reject);
    py.on('close', function (code) {
      if (code !== 0) return reject(new Error('generate_pages.py salió con código ' + code + ':\n' + out.slice(-1000)));
      resolve(out);
    });
  });
}

function appendLog(entry) {
  var log = readJSON(AUTOMATION_LOG_FILE, []);
  log.unshift(entry);
  if (log.length > MAX_LOG_ENTRIES) log = log.slice(0, MAX_LOG_ENTRIES);
  writeJSON(AUTOMATION_LOG_FILE, log);
}

async function main() {
  var startedAt = new Date().toISOString();
  var cfg = {};
  try { cfg = readJSON(CONFIG_FILE, {}); } catch (e) { cfg = {}; }
  var autoCfg = cfg.autoPublish || { enabled: false };

  if (!autoCfg.enabled && !FORCE) {
    console.log('Publicación automática apagada (config.json autoPublish.enabled=false) — no se hace nada.');
    return;
  }

  var draftCfg = draft.loadConfig();
  var apiKey = draftCfg.draftProvider === 'openai' ? draftCfg.openaiApiKey : draftCfg.anthropicApiKey;
  if (!apiKey) {
    appendLog({ startedAt: startedAt, forced: FORCE, ok: false, error: 'Sin API key configurada (admin/config.json)', published: [], topicsCreated: [], trendingUpdated: false, heroRotated: false, errors: [] });
    console.error('Sin API key configurada — nada para hacer.');
    return;
  }

  var built = await pipeline.buildCandidates();
  var categoryOptions = pipeline.listCategories();
  var topicsMap = pipeline.allTopicsByCategory();
  var errors = built.errors.slice();
  var published = [];
  var topicsCreated = [];
  var imagesGenerated = 0;

  var articles = readJSON(ARTICULOS_FILE, []);
  var takenSlugs = built.takenSlugs;

  for (var i = 0; i < built.candidates.length; i++) {
    var item = built.candidates[i];

    try {
      var result = await draft.draftArticle(item, topicsMap, draftCfg, categoryOptions);
      var finalCat = pagegen.CATEGORY_BY_SLUG[result.category] || pagegen.CATEGORY_BY_SLUG[item.category];

      var topicSlug = result.topic || '';
      if (!topicSlug && result.newTopicLabel) {
        try {
          var newTopic = pagegen.addTopic(finalCat.slug, result.newTopicLabel);
          topicSlug = newTopic.slug;
          topicsCreated.push(finalCat.label + ' / ' + newTopic.label);
          topicsMap[finalCat.slug] = (topicsMap[finalCat.slug] || []).concat([{ slug: newTopic.slug, label: newTopic.label }]);
        } catch (e) {
          // Ya existía o el nombre no dio un slug válido — el artículo
          // sigue publicándose, simplemente sin tema asignado.
        }
      }

      var slug = pipeline.uniqueSlug(pagegen.slugify(result.title), takenSlugs);
      var article = {
        title: result.title,
        category: finalCat.slug,
        categoryLabel: finalCat.label,
        icon: finalCat.icon,
        date: pipeline.todayISO(),
        readTime: result.readTime || '',
        topic: topicSlug,
        slug: slug,
        dek: result.dek,
        trending: false,
        image: '',
        videoUrl: '',
        body: result.body,
        href: 'categoria/' + finalCat.slug + '/' + slug + '.html',
        sourceUrl: item.link,
        sourceTitle: item.title
      };

      try {
        var topicLabel = topicSlug ? pagegen.topicLabelFor(finalCat.slug, topicSlug) : null;
        var imagePath = await imageGen.generateCoverImage(article, draftCfg, topicLabel);
        if (imagePath) { article.image = imagePath; imagesGenerated++; }
      } catch (e) {
        errors.push({ error: 'Imagen para "' + article.title.slice(0, 40) + '": ' + e.message });
      }

      articles.push(article);
      pagegen.generateArticleFile(article);
      published.push(article.title + ' (' + finalCat.label + ')');
    } catch (e) {
      errors.push({ url: item.link, error: e.message === 'NO_API_KEY' ? 'Sin API key' : e.message });
    }
  }

  var trendingResult = { updated: false };
  try {
    trendingResult = await trending.maybeUpdateTrending(articles);
  } catch (e) {
    errors.push({ error: 'Trending: ' + e.message });
  }

  if (published.length || trendingResult.updated) {
    writeJSON(ARTICULOS_FILE, articles);
    fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(articles), 'utf8');
  }

  var heroResult = { rotated: false };
  try {
    heroResult = await trending.maybeRotateHero(articles);
  } catch (e) {
    errors.push({ error: 'Carrusel: ' + e.message });
  }

  var deployResult = { ok: true, nothingToCommit: true, output: '' };
  if (published.length || trendingResult.updated || heroResult.rotated || topicsCreated.length) {
    try {
      await runPython(path.join(__dirname, 'generate_pages.py'));
    } catch (e) {
      errors.push({ error: 'generate_pages.py: ' + e.message });
    }
    try {
      // Solo lo que el bot puede haber tocado — nunca "-A" acá, para no
      // arrastrar cambios sueltos sin relación que haya en el repo
      // (ver admin/deploy.js).
      var deployPaths = [
        'data/articulos.json', 'data/articulos.js',
        'data/hero.json', 'data/hero.js',
        'data/topics.json',
        'data/automation-log.json',
        'data/trending-state.json',
        'categoria', 'sitemap.xml', 'img/temas'
      ];
      deployResult = await deploy.deploy('Publicación automática — ' + new Date().toISOString(), deployPaths);
    } catch (e) {
      deployResult = { ok: false, error: e.message };
    }
  }

  var logEntry = {
    startedAt: startedAt,
    finishedAt: new Date().toISOString(),
    forced: FORCE,
    ok: errors.length === 0 && deployResult.ok !== false,
    published: published,
    topicsCreated: topicsCreated,
    imagesGenerated: imagesGenerated,
    trendingUpdated: trendingResult.updated ? trendingResult.count : false,
    heroRotated: heroResult.rotated ? heroResult.titles : false,
    errors: errors,
    deploy: deployResult.nothingToCommit ? 'sin cambios para publicar' : (deployResult.ok ? 'publicado en vexlowhq.com' : ('error: ' + (deployResult.error || 'git falló')))
  };
  appendLog(logEntry);
  console.log(JSON.stringify(logEntry, null, 2));
}

main().catch(function (e) {
  appendLog({ startedAt: new Date().toISOString(), forced: FORCE, ok: false, error: e.message, published: [], topicsCreated: [], trendingUpdated: false, heroRotated: false, errors: [{ error: e.message }] });
  console.error('Falló la corrida del bot:', e);
  process.exitCode = 1;
});
