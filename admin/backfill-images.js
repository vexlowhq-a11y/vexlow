/*
  Le genera imagen destacada a los artículos YA PUBLICADOS que no
  tienen (con la misma lógica de admin/image-gen.js — OpenAI
  gpt-image-1.5, sin retratos de personas reales). No toca título/
  cuerpo/categoría/tema.

  Uso:
    node admin/backfill-images.js              (todos los que falten)
    node admin/backfill-images.js --limit 5    (solo los primeros 5, para probar)

  Después de correrlo: regenerar (python admin/generate_pages.py) y
  revisar/publicar como cualquier otro cambio de contenido — este
  script NO hace commit ni deploy solo.
*/

const fs = require('fs');
const path = require('path');
const draft = require('./draft');
const imageGen = require('./image-gen');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARTICULOS_FILE = path.join(DATA_DIR, 'articulos.json');

var limitArg = process.argv.indexOf('--limit');
var LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

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
  if (!draftCfg.openaiApiKey) { console.error('Sin openaiApiKey configurada — nada para hacer.'); return; }

  var articles = readJSON(ARTICULOS_FILE, []);
  var pending = articles.filter(function (a) { return a.category && a.slug && !a.image; }).slice(0, LIMIT);

  console.log(pending.length + ' artículo(s) sin imagen a procesar (de ' + articles.filter(function (a) { return !a.image; }).length + ' totales sin imagen).');

  var done = 0, errors = 0;
  for (var i = 0; i < pending.length; i++) {
    var a = pending[i];
    try {
      var imagePath = await imageGen.generateCoverImage(a, draftCfg, null);
      if (imagePath) {
        a.image = imagePath;
        done++;
        console.log('- [' + a.category + '] ' + a.title.slice(0, 55) + '  ->  ' + imagePath);
        // Guardar después de CADA imagen (no solo al final): si el
        // proceso se corta a mitad de camino (timeout, Ctrl+C, etc.)
        // no se pierde el gasto ya hecho en las que sí terminaron.
        writeJSON(ARTICULOS_FILE, articles);
        fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(articles), 'utf8');
      } else {
        console.log('- [' + a.category + '] ' + a.title.slice(0, 55) + '  ->  (generación de imagen deshabilitada)');
      }
    } catch (e) {
      errors++;
      console.log('- ERROR "' + a.title.slice(0, 45) + '": ' + e.message);
    }
  }

  if (done > 0) {
    writeJSON(ARTICULOS_FILE, articles);
    fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(articles), 'utf8');
  }

  console.log('\nResumen: ' + done + ' imagen(es) generada(s), ' + errors + ' error(es).');
  if (done > 0) console.log('Guardado. Falta: regenerar (python admin/generate_pages.py) y publicar.');
}

main().catch(function (e) { console.error('Falló el backfill de imágenes:', e); process.exitCode = 1; });
