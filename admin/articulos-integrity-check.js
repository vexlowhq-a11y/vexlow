/*
  articulos-integrity-check.js — utilidad compartida para confirmar que
  data/articulos.json REAL (nunca una copia temporal) no cambió durante una
  prueba, sin depender de ningún conteo escrito a mano.

  Nota de nombre: a propósito NO empieza con "test-" (aunque su único uso es
  desde archivos de prueba) para que el descubrimiento recursivo
  `find admin -type f -iname "test-*.js"` no la cuente como un archivo de
  prueba más -- es una librería de soporte, como pagegen.js o feeds.js, sin
  ningún PASS/FAIL propio que ejecutar.
  ============================================================================
  Historia (2026-09-27): hasta esta fecha, 17 archivos admin/test-*.js
  terminaban con un control como:

      check('El sitio real sigue teniendo exactamente 141 artículos',
        realCount === 141, 'count=' + realCount);

  El "141" era el conteo real confirmado tras el incidente del 2026-09-13.
  Cada vez que se publica un artículo real nuevo y legítimo (como pasó el
  2026-09-13 con el artículo de Nscale/Fidji Simo, que llevó el conteo a
  142), ese número queda desactualizado y esos 17 controles "fallan" sin que
  exista ningún problema real -- el archivo real nunca cambió durante la
  prueba, el número que estaba mal era la expectativa escrita en el test.

  Este módulo reemplaza el número fijo por una comparación real entre un
  "antes" y un "después":
    - SHA-256 del archivo completo (detecta CUALQUIER cambio de contenido).
    - cantidad de artículos.
    - conjunto de identidades "category/slug" (detecta altas/bajas incluso
      si por coincidencia la cantidad total no cambiara).
  Si el hash es idéntico, no hace falta nada más: es la prueba más fuerte de
  que no cambió ni un byte. Si el hash difiere, unchanged() distingue el tipo
  de cambio (alta, baja, o modificación de un artículo existente sin tocar
  la cantidad) para que el mensaje de fallo diga exactamente qué pasó.

  Funciona igual con 141, 142, 143 o cualquier cantidad real futura: nunca
  compara contra un número fijo, siempre contra la foto tomada AL EMPEZAR
  esa misma corrida.

  Uso típico dentro de un archivo de prueba:

      const integrity = require('./articulos-integrity-check');
      const REAL_ARTICULOS = path.join(__dirname, '..', 'data', 'articulos.json');
      const before = integrity.snapshot(REAL_ARTICULOS);
      // ... todas las operaciones de la prueba, SIEMPRE sobre copias
      //     temporales aisladas -- nunca sobre REAL_ARTICULOS ...
      const after = integrity.snapshot(REAL_ARTICULOS);
      const result = integrity.unchanged(before, after);
      check('El sitio real (data/articulos.json) no cambió durante la prueba',
        result.ok, result.detail);

  Nunca escribe nada -- solo lee. Las operaciones que SÍ necesitan modificar
  artículos (agregar/editar/borrar) tienen que hacerlo sobre una copia
  temporal aislada (os.tmpdir()), jamás sobre el archivo que este módulo
  está verificando.
*/

const fs = require('fs');
const crypto = require('crypto');

function categorySlugKey(article) {
  return String(article && article.category) + '/' + String(article && article.slug);
}

// Toma una foto del estado actual de un articulos.json real: hash del
// archivo completo, cantidad de artículos, y el conjunto de identidades
// category/slug. No asume ningún valor de partida -- lee lo que haya.
function snapshot(articulosPath) {
  const raw = fs.readFileSync(articulosPath);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('snapshot: ' + articulosPath + ' no es un array JSON válido');
  }
  return {
    path: articulosPath,
    hash: hash,
    count: parsed.length,
    slugs: new Set(parsed.map(categorySlugKey)),
  };
}

// Compara dos fotos (antes/después) y determina si el archivo real no
// cambió. Nunca compara contra un número fijo -- solo "before" contra
// "after" de la MISMA corrida.
function unchanged(before, after) {
  if (before.hash === after.hash) {
    return {
      ok: true,
      detail: 'sin cambios (hash idéntico, ' + before.count + ' artículos, mismo conjunto de category/slug)',
    };
  }

  // El hash difiere -- diagnosticar exactamente qué cambió para que el
  // mensaje de fallo sea accionable, no solo "algo cambió".
  const added = [...after.slugs].filter(function (s) { return !before.slugs.has(s); });
  const removed = [...before.slugs].filter(function (s) { return !after.slugs.has(s); });

  if (after.count !== before.count || added.length || removed.length) {
    const parts = ['cantidad ' + before.count + ' -> ' + after.count];
    if (added.length) parts.push('agregados: ' + added.join(', '));
    if (removed.length) parts.push('eliminados: ' + removed.join(', '));
    return { ok: false, detail: parts.join(' -- ') };
  }

  // Misma cantidad y mismo conjunto de slugs, pero el hash cambió: algún
  // artículo existente fue modificado en su lugar (mismo category/slug,
  // contenido distinto).
  return {
    ok: false,
    detail: 'misma cantidad (' + before.count + ') y mismos slugs, pero el contenido de al menos un ' +
      'artículo existente cambió (SHA-256 del archivo distinto)',
  };
}

module.exports = { snapshot: snapshot, unchanged: unchanged, categorySlugKey: categorySlugKey };
