/*
  admin/link-scanner.js — escáner de referencias internas del HTML PÚBLICO
  realmente generado (sección 3 de la corrección permanente, 2026-09-13).
  ============================================================================
  Antes de esto, `npm run validate:publish` solo miraba los enlaces escritos
  a mano dentro del campo `body` de cada artículo en articulos.json -- nunca
  el HTML que se sirve de verdad. El rail de "You might also like"
  (pagegen.renderRelatedBlock), el sidebar/footer compartido, las páginas de
  categoría, portada, juegos e institucionales se generan aparte, así que
  podían quedar con referencias muertas sin que ningún control se enterara.
  Así pasaron desapercibidos 112 enlaces rotos hacia 28 artículos borrados,
  incluso con el chequeo del `body` en verde.

  Este módulo es la única implementación del escaneo -- la usan tanto
  admin/validate-publish.js (chequeo de producción) como
  admin/test-related-links-fix.js (prueba A/B de la suite de este proyecto),
  para no duplicar la lógica de resolución de rutas entre los dos.

  Qué revisa en cada archivo .html público (fuera de admin/, que nunca se
  publica -- ver .vercelignore):
    - Todo <a href="...">
    - Todo [src] de <img>/<script>
    - <link rel="canonical">
    - <meta property="og:image"> y <meta property="og:url">
    - Las URLs dentro de cada bloque JSON-LD (image/url/logo, recursivo)
  Resolviendo cada referencia relativa contra la carpeta REAL del archivo
  que la contiene (un artículo vive en categoria/<cat>/, por ejemplo, no en
  la raíz del sitio).

  Qué ignora a propósito (y por qué):
    - Enlaces externos (otro origen): no es responsabilidad de este sitio
      que un link externo seguirá vivo.
    - mailto:/tel:/javascript:/data: -- no son rutas de archivo.
    - Fragmentos puros (#ancla): misma página, no hay nada que resolver.
    - Query strings (?utm=...): se descartan antes de resolver la ruta.
    - Un redirect configurado (pagegen.generateRedirectFile) sigue
      generando un archivo real en la URL vieja del artículo -- una
      referencia hacia esa URL no es un enlace roto porque el archivo
      existe (y hace su propio meta-refresh); solo se reporta si el
      destino no existe en absoluto.
*/
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SITE_ORIGIN = 'https://vexlowhq.com';
const EXCLUDE_TOP = new Set(['admin', 'node_modules', '.git', '_trash', 'data']);

function listPublicHtmlFiles(rootDir) {
  var out = [];
  (function walk(dir, isRoot) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      if (isRoot && EXCLUDE_TOP.has(entry.name)) return;
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, false); return; }
      if (entry.name.toLowerCase().endsWith('.html')) out.push(full);
    });
  })(rootDir, true);
  return out;
}

// Devuelve la ruta a comprobar (sin dominio/query/fragmento) o null si la
// referencia no corresponde revisarla acá (externa, mailto, ancla, etc.).
function classifyRef(raw) {
  if (!raw) return null;
  var v = String(raw).trim();
  if (!v || v === '#') return null;
  if (v.indexOf('#') === 0) return null;
  if (/^(mailto|tel|javascript|data):/i.test(v)) return null;
  if (v.indexOf(SITE_ORIGIN) === 0) {
    v = v.slice(SITE_ORIGIN.length) || '/';
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.indexOf('//') === 0) {
    return null;
  }
  v = v.split('#')[0].split('?')[0];
  return v || null;
}

function resolveRef(fileDir, rootDir, ref) {
  var target = ref.indexOf('/') === 0 ? path.join(rootDir, ref) : path.join(fileDir, ref);
  if (target.endsWith(path.sep)) target = path.join(target, 'index.html');
  return target;
}

function collectJsonLdUrls(node, out) {
  if (!node || typeof node !== 'object') return;
  ['image', 'url', 'logo'].forEach(function (key) {
    var val = node[key];
    if (typeof val === 'string') out.push(['jsonld:' + key, val]);
    else if (val && typeof val === 'object' && typeof val.url === 'string') out.push(['jsonld:' + key + '.url', val.url]);
  });
  Object.keys(node).forEach(function (k) {
    if (node[k] && typeof node[k] === 'object') collectJsonLdUrls(node[k], out);
  });
}

/* Escanea todo el HTML público bajo rootDir. Devuelve:
   { filesScanned, refsChecked, broken: [{ file, kind, raw, resolved }] } */
function scanPublicHtml(rootDir) {
  var htmlFiles = listPublicHtmlFiles(rootDir);
  var broken = [];
  var refsChecked = 0;

  htmlFiles.forEach(function (file) {
    var html;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return;
    }
    var doc;
    try {
      doc = new JSDOM(html).window.document;
    } catch (e) {
      broken.push({ file: path.relative(rootDir, file), kind: 'parse', raw: '', resolved: '', message: 'HTML ilegible para el escáner (' + e.message + ')' });
      return;
    }
    var fileDir = path.dirname(file);
    var refs = [];
    doc.querySelectorAll('a[href]').forEach(function (el) { refs.push(['href', el.getAttribute('href')]); });
    doc.querySelectorAll('img[src], script[src]').forEach(function (el) { refs.push(['src', el.getAttribute('src')]); });
    doc.querySelectorAll('link[rel="canonical"]').forEach(function (el) { refs.push(['canonical', el.getAttribute('href')]); });
    doc.querySelectorAll('meta[property="og:image"]').forEach(function (el) { refs.push(['og:image', el.getAttribute('content')]); });
    doc.querySelectorAll('meta[property="og:url"]').forEach(function (el) { refs.push(['og:url', el.getAttribute('content')]); });
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(function (el) {
      var data;
      try { data = JSON.parse(el.textContent); } catch (e) { return; }
      (Array.isArray(data) ? data : [data]).forEach(function (item) { collectJsonLdUrls(item, refs); });
    });

    refs.forEach(function (pair) {
      var kind = pair[0], raw = pair[1];
      var cleaned = classifyRef(raw);
      if (cleaned === null) return;
      refsChecked++;
      var target = resolveRef(fileDir, rootDir, cleaned);
      if (!fs.existsSync(target)) {
        broken.push({ file: path.relative(rootDir, file), kind: kind, raw: raw, resolved: path.relative(rootDir, target) });
      }
    });
  });

  return { filesScanned: htmlFiles.length, refsChecked: refsChecked, broken: broken };
}

module.exports = { scanPublicHtml: scanPublicHtml };
