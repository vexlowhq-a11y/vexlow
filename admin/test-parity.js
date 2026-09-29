#!/usr/bin/env node
/*
  Prueba de paridad Node/Python -- admin/pagegen.js vs admin/generate_pages.py
  =============================================================================
  Formaliza en un script reusable la metodología que se usó a mano para
  encontrar y confirmar el arreglo del bug de paridad del 2026-09-12 (falta
  de html.escape() en el label de una fuente en Python): copia el sitio
  completo a dos carpetas temporales, corre la regeneración COMPLETA con
  cada generador por separado, y compara el árbol de salida byte a byte.

  No toca /home/claude/site (ni ningún otro sitio real): todo el trabajo
  pasa en os.tmpdir(), y las dos copias se borran al final pase lo que
  pase (incluso si un generador tira una excepción).

  Uso:
    node admin/test-parity.js            -- corre la comparación completa
    node admin/test-parity.js --keep     -- no borra las carpetas temporales
                                             al final (para inspeccionar a
                                             mano una diferencia inesperada)

  Sale con código 0 si el único diff es el conocido y documentado (blancos
  de más en los 8 index.html de categoría, ver EXCEPCIONES_CONOCIDAS más
  abajo -- previo a este proyecto, no afecta contenido). Sale con código
  1 si aparece cualquier OTRA diferencia -- eso es justo lo que esta
  prueba existe para atrapar antes de que llegue a producción.

  admin/validate-publish.js (npm run validate:publish) llama a este mismo
  script como uno de sus checks.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

// Diferencias pre-existentes, documentadas y fuera de alcance de este
// proyecto (auditoría 2026-09, confirmado también en el backup previo a
// cualquier cambio de este proyecto): CATEGORY_PAGE_TEMPLATE en Python
// deja 2-3 líneas en blanco de más cuando algunos bloques opcionales
// quedan vacíos. No afecta contenido, SEO, ni HTML renderizado -- son
// bytes de whitespace entre tags. Tocar la plantilla compartida para
// sacarlas arriesga una regresión no relacionada, así que se dejan como
// excepción conocida en vez de "arreglarlas" acá.
const KNOWN_EXCEPTIONS = new Set([
  'categoria/ai/index.html',
  'categoria/business/index.html',
  'categoria/entertainment/index.html',
  'categoria/gaming/index.html',
  'categoria/science/index.html',
  'categoria/sports/index.html',
  'categoria/technology/index.html',
  'categoria/trending/index.html'
]);

// Carpetas/archivos que no tiene sentido comparar (son la herramienta en
// sí, no la salida generada -- admin/config.json además puede no existir
// en este entorno de pruebas y no es parte de lo que generan los dos
// scripts).
const IGNORE_TOP_LEVEL = new Set(['admin', '.git']);

function copyProjectTo(dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(PROJECT_ROOT).forEach(function (entry) {
    fs.cpSync(path.join(PROJECT_ROOT, entry), path.join(dest, entry), { recursive: true });
  });
}

function runNodeGeneration(siteDir) {
  var adminDir = path.join(siteDir, 'admin');
  // require() cachea módulos por path absoluto -- como cada copia vive en
  // su propia carpeta temporal, pagegen.js de CADA copia es un módulo
  // distinto para Node, así que no hay pisado de caché entre la corrida de
  // tempA y la de tempB.
  var pagegen = require(path.join(adminDir, 'pagegen.js'));
  // Usa la misma función que admin/server.js llama en cada guardado real
  // (regenerateAllArticlePages, agregada 2026-09-13 junto con la
  // corrección del rail de relacionados) en vez de duplicar el loop acá --
  // así la prueba de paridad Node/Python ejercita exactamente el mismo
  // camino de generación que usa el panel en producción.
  var result = pagegen.regenerateAllArticlePages();
  return result.errors.map(function (e) { return e.slug + ': ' + e.error; });
}

function runPythonGeneration(siteDir) {
  var adminDir = path.join(siteDir, 'admin');
  execFileSync('python3', ['generate_pages.py'], { cwd: adminDir, stdio: 'pipe' });
}

function walkFiles(dir, base, out) {
  base = base || dir;
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    var full = path.join(dir, entry.name);
    // path.relative() usa el separador nativo del SO (backslash en
    // Windows). KNOWN_EXCEPTIONS y toda la lógica de comparación de este
    // archivo asumen forward slash -- normalizar acá es el único punto
    // de conversión que hace falta para que la comparación funcione
    // igual en Windows que en Linux/Mac (bug real encontrado el
    // 2026-09-29 corriendo esta prueba en el dispositivo real de
    // Windows: las 8 excepciones conocidas de category pages se
    // reportaban como diferencias inesperadas porque 'categoria\ai\...'
    // nunca matcheaba 'categoria/ai/...' en el Set).
    var rel = path.relative(base, full).split(path.sep).join('/');
    if (dir === base && IGNORE_TOP_LEVEL.has(entry.name)) return;
    if (entry.isDirectory()) {
      walkFiles(full, base, out);
    } else {
      out.push(rel);
    }
  });
  return out;
}

function compareTrees(dirA, dirB) {
  var filesA = new Set(walkFiles(dirA));
  var filesB = new Set(walkFiles(dirB));
  var onlyInA = [...filesA].filter(function (f) { return !filesB.has(f); });
  var onlyInB = [...filesB].filter(function (f) { return !filesA.has(f); });
  var differing = [];
  [...filesA].filter(function (f) { return filesB.has(f); }).forEach(function (rel) {
    var bufA = fs.readFileSync(path.join(dirA, rel));
    var bufB = fs.readFileSync(path.join(dirB, rel));
    if (!bufA.equals(bufB)) differing.push(rel);
  });
  return { onlyInA: onlyInA, onlyInB: onlyInB, differing: differing };
}

function main() {
  var keep = process.argv.indexOf('--keep') !== -1;
  var tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-parity-'));
  var dirNode = path.join(tmpBase, 'node-output');
  var dirPython = path.join(tmpBase, 'python-output');

  console.log('Copiando el sitio a dos carpetas temporales para comparar Node vs Python...');
  console.log('  Node:   ' + dirNode);
  console.log('  Python: ' + dirPython);
  copyProjectTo(dirNode);
  copyProjectTo(dirPython);

  var exitCode = 0;
  try {
    console.log('\nCorriendo la regeneración completa con Node (pagegen.js)...');
    var nodeErrors = runNodeGeneration(dirNode);
    if (nodeErrors.length) {
      console.log('  ERRORES durante la generación Node:');
      nodeErrors.forEach(function (e) { console.log('   - ' + e); });
      exitCode = 1;
    } else {
      console.log('  OK, sin errores.');
    }

    console.log('\nCorriendo la regeneración completa con Python (generate_pages.py)...');
    runPythonGeneration(dirPython);
    console.log('  OK, sin errores.');

    console.log('\nComparando los dos árboles de salida...');
    var result = compareTrees(dirNode, dirPython);

    if (result.onlyInA.length) {
      console.log('\nArchivos que Node generó y Python NO:');
      result.onlyInA.forEach(function (f) { console.log('  - ' + f); });
      exitCode = 1;
    }
    if (result.onlyInB.length) {
      console.log('\nArchivos que Python generó y Node NO:');
      result.onlyInB.forEach(function (f) { console.log('  - ' + f); });
      exitCode = 1;
    }

    var unexpectedDiffs = result.differing.filter(function (f) { return !KNOWN_EXCEPTIONS.has(f); });
    var knownDiffs = result.differing.filter(function (f) { return KNOWN_EXCEPTIONS.has(f); });

    if (knownDiffs.length) {
      console.log('\nDiferencias conocidas y documentadas (whitespace en index.html de categoría, previas a este proyecto -- no bloquean):');
      knownDiffs.forEach(function (f) { console.log('  - ' + f); });
    }
    if (unexpectedDiffs.length) {
      console.log('\n❌ DIFERENCIAS INESPERADAS (esto es justo lo que esta prueba busca atrapar):');
      unexpectedDiffs.forEach(function (f) { console.log('  - ' + f); });
      exitCode = 1;
    }

    if (exitCode === 0) {
      console.log('\n✅ Paridad Node/Python OK (' + (walkFiles(dirNode).length) + ' archivos comparados, 0 diferencias inesperadas).');
    }
  } catch (e) {
    console.error('\n❌ La prueba de paridad no pudo completarse: ' + e.message);
    exitCode = 1;
  } finally {
    if (!keep) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } else {
      console.log('\n(--keep: carpetas temporales conservadas en ' + tmpBase + ')');
    }
  }
  process.exit(exitCode);
}

main();
