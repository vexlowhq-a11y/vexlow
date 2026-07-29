/*
  Le pone tema a los artículos YA PUBLICADOS que quedaron sin uno
  (de antes de que el bot supiera crear temas automáticamente). No
  toca título/cuerpo/categoría — solo clasifica y asigna "topic",
  creando el tema en data/topics.json si hace falta (pagegen.addTopic).

  Uso:
    node admin/backfill-topics.js            (aplica los cambios)
    node admin/backfill-topics.js --dry-run  (solo muestra qué haría)

  Después de correrlo: regenerar (python admin/generate_pages.py) y
  revisar/publicar como cualquier otro cambio de contenido — este
  script NO hace commit ni deploy solo.
*/

const fs = require('fs');
const path = require('path');
const draft = require('./draft');
const pipeline = require('./pipeline');
const pagegen = require('./pagegen');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');
const DRY_RUN = process.argv.indexOf('--dry-run') !== -1;

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
    '  GENERADO AUTOMÁTICAMENTE. No lo edites a mano. La fuente real es\n' +
    '  data/articulos.json.\n' +
    '*/\n';
  return header + 'const VEXLOW_ARTICLES = ' + JSON.stringify(data, null, 2) + ';\n';
}

async function main() {
  var draftCfg = draft.loadConfig();
  var apiKey = draftCfg.draftProvider === 'openai' ? draftCfg.openaiApiKey : draftCfg.anthropicApiKey;
  if (!apiKey) { console.error('Sin API key configurada (admin/config.json) — nada para hacer.'); return; }

  var articles = readJSON(ARTICULOS_FILE, []);
  var topicsMap = pipeline.allTopicsByCategory();
  var pending = articles.filter(function (a) { return a.category && !a.topic; });

  console.log(pending.length + ' artículo(s) sin tema de ' + articles.length + ' totales.' + (DRY_RUN ? ' (dry-run, no se guarda nada)' : ''));

  var assigned = 0, created = 0, leftBlank = 0, errors = 0;

  for (var i = 0; i < pending.length; i++) {
    var a = pending[i];
    try {
      var result = await draft.classifyTopic(a, topicsMap[a.category] || [], draftCfg);
      var topicSlug = result.topic || '';
      if (!topicSlug && result.newTopicLabel) {
        if (DRY_RUN) {
          topicSlug = '(nuevo: ' + result.newTopicLabel + ')';
        } else {
          try {
            var newTopic = pagegen.addTopic(a.category, result.newTopicLabel);
            topicSlug = newTopic.slug;
            topicsMap[a.category] = (topicsMap[a.category] || []).concat([{ slug: newTopic.slug, label: newTopic.label }]);
            created++;
          } catch (e) {
            topicSlug = '';
          }
        }
      }
      if (topicSlug && !DRY_RUN) { a.topic = topicSlug; assigned++; }
      else if (topicSlug && DRY_RUN) { assigned++; }
      else { leftBlank++; }
      console.log('- [' + a.category + '] ' + a.title.slice(0, 60) + '  ->  ' + (topicSlug || '(sin tema, roundup)'));
    } catch (e) {
      errors++;
      console.log('- ERROR "' + a.title.slice(0, 50) + '": ' + e.message);
    }
  }

  if (!DRY_RUN && assigned > 0) {
    writeJSON(ARTICULOS_FILE, articles);
    fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(articles), 'utf8');
  }

  console.log('\nResumen: ' + assigned + ' con tema asignado (' + created + ' temas nuevos creados), ' + leftBlank + ' sin tema (roundup genuino), ' + errors + ' error(es).');
  if (!DRY_RUN && assigned > 0) console.log('Guardado. Falta: regenerar (python admin/generate_pages.py) y publicar.');
}

main().catch(function (e) { console.error('Falló el backfill:', e); process.exitCode = 1; });
