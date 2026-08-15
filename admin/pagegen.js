/*
  Generador de páginas de ARTÍCULO — usado por admin/server.js
  ===============================================================
  Esta es la versión en Node de la parte de "artículos" de
  generate_pages.py: arma categoria/{categoria}/{slug}.html a partir
  de un objeto artículo (título, dek, fecha, cuerpo en texto simple).

  Las páginas de categoría y de tema (los "hubs") las sigue generando
  admin/generate_pages.py (botón "Regenerar categorías y temas" del
  panel) — eso cambia poco y ese script ya está probado. Esto de acá
  es lo que se ejecuta cada vez que guardás un artículo desde el panel,
  así no hace falta correr Python para publicar una noticia.

  Formato del texto del cuerpo (campo "body" del artículo):
    - Párrafos separados por una línea en blanco.
    - "## Texto" al principio de una línea = subtítulo (h2).
    - Líneas seguidas que empiezan con "- " = lista.
    - Una línea que diga exactamente "[publicidad]" se ignora al renderizar
      (quedó de cuando había espacios publicitarios en el cuerpo; se sacaron
      hasta tener AdSense aprobado, pero el parser la sigue reconociendo por
      los artículos viejos que todavía la tienen en el texto guardado).
    - "![alt](ruta)" en su propia línea = imagen suelta en medio del cuerpo.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CATEGORIA_DIR = path.join(ROOT, 'categoria');

// Las categorías viven en data/categories.json (fuente única, la misma
// que lee admin/generate_pages.py) para poder agregarlas/editarlas/
// borrarlas desde el panel sin tocar código. Se recargan del disco en
// cada llamada -- mismo patrón que loadTopicGroups() -- para que un
// cambio hecho por el panel se vea sin reiniciar el servidor.
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');

function loadCategories() {
  return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8'));
}
function saveCategories(list) {
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
}
function categoryBySlug(slug) {
  return loadCategories().find(function (c) { return c.slug === slug; });
}
function categorySlugify(label) {
  return String(label)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/* Crea una categoría nueva al final de la lista. No genera HTML acá --
   para eso está "Regenerar categorías y temas" del panel, que corre
   generate_pages.py y arma el nav, el footer, los chips de filtro y la
   página de la categoría. A propósito NO se agrega una sección propia
   en la portada -- eso queda para cuando el sitio ya tenga contenido
   real ahí, así no se repite el problema de "categoría vacía en la
   portada" que motivó sacar el sistema de temas. */
function addCategory(label, icon, description) {
  if (!label || !label.trim()) throw new Error('El nombre de la categoría no puede estar vacío');
  var slug = categorySlugify(label);
  if (!slug) throw new Error('El nombre no generó un slug válido');

  var list = loadCategories();
  if (list.some(function (c) { return c.slug === slug; })) {
    throw new Error('Ya existe una categoría con ese nombre');
  }

  var created = { slug: slug, label: label.trim(), icon: icon || '📄', description: description || '' };
  list.push(created);
  saveCategories(list);
  return created;
}

function renameCategory(slug, newLabel, newIcon, newDescription) {
  var list = loadCategories();
  var cat = list.find(function (c) { return c.slug === slug; });
  if (!cat) throw new Error('No se encontró esa categoría');
  if (newLabel && newLabel.trim()) cat.label = newLabel.trim();
  if (newIcon) cat.icon = newIcon;
  if (typeof newDescription === 'string') cat.description = newDescription;
  saveCategories(list);
  return cat;
}

/* Si la categoría tenía su propia sección destacada en la portada
   (<section class="home-section" id="slug">...), la saca de index.html
   -- si no se hace esto, generate_pages.py la deja intacta (no la toca)
   y queda un riel vacío "0 artículos" en la home, el mismo problema que
   motivó sacar World/Curiosities/Guides. No es un error si no existía
   (la mayoría de las categorías nunca tuvieron una, a propósito --
   ver build_category_nav_html en generate_pages.py). */
function removeHomepageRail(slug) {
  var indexPath = path.join(ROOT, 'index.html');
  var html = fs.readFileSync(indexPath, 'utf8');
  var re = new RegExp('[ \\t]*<section class="home-section" id="' + slug + '">[\\s\\S]*?</section>\\r?\\n?', '');
  var next = html.replace(re, '');
  if (next !== html) fs.writeFileSync(indexPath, next, 'utf8');

  var scriptPath = path.join(ROOT, 'js', 'script.js');
  var js = fs.readFileSync(scriptPath, 'utf8');
  var nextJs = js.replace(new RegExp("(RAIL_CATEGORIES = \\[[^\\]]*?)'" + slug + "', ?"), '$1');
  nextJs = nextJs.replace(new RegExp("(RAIL_CATEGORIES = \\[[^\\]]*?), ?'" + slug + "'"), '$1');
  if (nextJs !== js) fs.writeFileSync(scriptPath, nextJs, 'utf8');
}

/* Saca una categoría de data/categories.json y borra su carpeta
   categoria/<slug>/ (a esta altura solo tiene el index.html de la
   categoría -- server.js valida antes que no le queden artículos
   asignados, para no dejar contenido huérfano sin avisar). */
function deleteCategory(slug) {
  var list = loadCategories();
  var idx = list.findIndex(function (c) { return c.slug === slug; });
  if (idx === -1) throw new Error('No se encontró esa categoría');

  list.splice(idx, 1);
  saveCategories(list);
  removeHomepageRail(slug);

  var dir = path.join(CATEGORIA_DIR, slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  return { slug: slug };
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function formatDateEn(iso) {
  var parts = iso.split('-');
  var y = parts[0], m = parts[1], d = parts[2];
  return MONTHS_EN[parseInt(m, 10) - 1] + ' ' + String(parseInt(d, 10)) + ', ' + y;
}


function loadSidebarFooter() {
  var indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var sidebarStart = indexHtml.indexOf('<div class="mobile-topbar">');
  var sidebarEnd = indexHtml.indexOf('</aside>') + '</aside>'.length;
  var sidebarBlockRoot = indexHtml.slice(sidebarStart, sidebarEnd);
  var footerStart = indexHtml.indexOf('    <footer class="site-footer">');
  var footerEnd = indexHtml.indexOf('</footer>', footerStart) + '</footer>'.length;
  var footerBlockRoot = indexHtml.slice(footerStart, footerEnd);
  return { sidebar: localize(sidebarBlockRoot), footer: localize(footerBlockRoot) };
}

var STATIC_PAGE_SLUGS = ['about-vexlowhq', 'editorial-policy', 'contact', 'advertise', 'privacy', 'terms', 'cookies'];

function localize(html) {
  html = html.split('href="index.html"').join('href="../../index.html"');
  html = html.split('href="play/index.html"').join('href="../../play/index.html"');
  html = html.split('src="img/').join('src="../../img/');
  html = html.split("url('img/").join("url('../../img/");
  loadCategories().forEach(function (cat) {
    html = html.split('href="categoria/' + cat.slug + '/index.html"')
      .join('href="../../categoria/' + cat.slug + '/index.html"');
  });
  STATIC_PAGE_SLUGS.forEach(function (slug) {
    html = html.split('href="' + slug + '.html"')
      .join('href="../../' + slug + '.html"');
  });
  return html;
}

/* ---- parseo del cuerpo en texto simple -> bloques ---- */
function parseBody(text) {
  var blocks = [];
  var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  var paragraphBuf = [];
  function flushParagraph() {
    if (paragraphBuf.length) {
      blocks.push({ type: 'p', text: paragraphBuf.join(' ').trim() });
      paragraphBuf = [];
    }
  }
  var i = 0;
  while (i < lines.length) {
    var line = lines[i].trim();
    if (line === '') { flushParagraph(); i++; continue; }
    if (/^##\s+/.test(line)) { flushParagraph(); blocks.push({ type: 'h2', text: line.replace(/^##\s+/, '') }); i++; continue; }
    if (/^\[publicidad\]$/i.test(line)) { flushParagraph(); blocks.push({ type: 'ad' }); i++; continue; }
    var imgMatch = /^!\[(.*?)\]\((\S+)\)$/.exec(line);
    if (imgMatch) { flushParagraph(); blocks.push({ type: 'img', alt: imgMatch[1], src: imgMatch[2] }); i++; continue; }
    if (/^-\s+/.test(line)) {
      flushParagraph();
      var items = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^-\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items: items });
      continue;
    }
    paragraphBuf.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

/* "**texto**" -> <strong>texto</strong>, dentro de párrafos, subtítulos,
   ítems de lista y pies de foto (nunca dentro del atributo alt). */
function applyInline(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderBodyHtml(bodyText) {
  var blocks = parseBody(bodyText);
  var html = '';
  blocks.forEach(function (b) {
    if (b.type === 'p') html += '      <p>' + applyInline(b.text) + '</p>\n';
    else if (b.type === 'h2') html += '      <h2>' + applyInline(b.text) + '</h2>\n';
    else if (b.type === 'ul') {
      html += '      <ul>\n';
      b.items.forEach(function (it) { html += '        <li>' + applyInline(it) + '</li>\n'; });
      html += '      </ul>\n';
    } else if (b.type === 'img') {
      var altEsc = (b.alt || '').replace(/"/g, '&quot;');
      html += '      <figure class="article-inline-image"><img src="../../' + b.src + '" alt="' + altEsc + '" loading="lazy">';
      if (b.alt) html += '<figcaption>' + applyInline(b.alt) + '</figcaption>';
      html += '</figure>\n';
    }
  });
  return html;
}

var ARTICLE_PAGE_TEMPLATE = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>{title} — VexlowHQ</title>\n' +
'<meta name="description" content="{dek}">\n' +
'<link rel="stylesheet" href="../../css/style.css">\n' +
'<link rel="icon" type="image/x-icon" href="../../favicon.ico">\n' +
'<link rel="icon" type="image/png" sizes="32x32" href="../../favicon-32.png">\n' +
'<link rel="icon" type="image/png" sizes="16x16" href="../../favicon-16.png">\n' +
'<link rel="apple-touch-icon" sizes="180x180" href="../../apple-touch-icon.png">\n' +
'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1908947394595965" crossorigin="anonymous"></script>\n' +
'<script async src="https://www.googletagmanager.com/gtag/js?id=G-20Z63KYZ3K"></script>\n' +
'<script>\n' +
'  window.dataLayer = window.dataLayer || [];\n' +
'  function gtag(){dataLayer.push(arguments);}\n' +
'  gtag(\'js\', new Date());\n' +
'  gtag(\'config\', \'G-20Z63KYZ3K\');\n' +
'</script>\n' +
'</head>\n' +
'<body data-category="{catSlug}"{subtopicAttr}>\n' +
'\n' +
'{sidebar}\n' +
'\n' +
'  <main>\n' +
'\n' +
'    <nav class="breadcrumb">\n' +
'      <a href="../../index.html">Home</a><span class="sep">/</span><a href="index.html">{catLabel}</a>{topicCrumb}<span class="sep">/</span><span class="current">{titleShort}</span>\n' +
'    </nav>\n' +
'\n' +
'    <article class="article-page">\n' +
'      <span class="chip">{catIcon} {catLabel}</span>\n' +
'      <h1>{title}</h1>\n' +
'      <p class="dek">{dek}</p>\n' +
'      <div class="article-meta">\n' +
'        <span>VexlowHQ Staff</span><span class="dot">·</span><span>{dateLabel}</span><span class="dot">·</span><span>{readTime}</span>\n' +
'      </div>\n' +
'\n' +
'{bannerHtml}\n' +
'      <div class="article-body">\n' +
'{bodyHtml}      </div>\n' +
'\n' +
'      <div class="article-reactions" data-article-slug="{slug}">\n' +
'        <span>React</span>\n' +
'        <button type="button" class="reaction-btn" data-reaction="like" aria-label="Like this article">👍 <span class="reaction-count" data-count="like">0</span></button>\n' +
'        <button type="button" class="reaction-btn" data-reaction="fire" aria-label="Fire reaction">🔥 <span class="reaction-count" data-count="fire">0</span></button>\n' +
'        <button type="button" class="reaction-btn" data-reaction="dislike" aria-label="Dislike this article">👎 <span class="reaction-count" data-count="dislike">0</span></button>\n' +
'      </div>\n' +
'\n' +
'      <div class="article-share">\n' +
'        <span>Share</span>\n' +
'        <a href="#" data-share="x" aria-label="Share on X">X</a>\n' +
'        <a href="#" data-share="whatsapp" aria-label="Share on WhatsApp">W</a>\n' +
'        <a href="#" data-share="facebook" aria-label="Share on Facebook">F</a>\n' +
'        <a href="#" data-share="copy" aria-label="Copy link">🔗</a>\n' +
'      </div>\n' +
'\n' +
'      <div class="article-continue">\n' +
'        <p>Want more news about <strong>{topicLabel}</strong>?</p>\n' +
'        <a class="see-all" href="{topicHref}">See full coverage →</a>\n' +
'      </div>\n' +
'    </article>\n' +
'\n' +
'{footer}\n' +
'\n' +
'  </main>\n' +
'</div>\n' +
'\n' +
'<script src="../../data/articulos.js"></script>\n' +
'<script src="../../js/script.js"></script>\n' +
'</body>\n' +
'</html>\n';

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m;
  });
}

function articleFilePath(article) {
  var cat = categoryBySlug(article.category);
  if (!cat) return null;
  return path.join(CATEGORIA_DIR, cat.slug, article.slug + '.html');
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function youtubeEmbedUrl(url) {
  if (!url) return null;
  var m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? 'https://www.youtube.com/embed/' + m[1] : null;
}

/* Primero prueba si es un link de YouTube (arma la URL de embed canónica).
   Si no, y el link ya es una URL http(s) válida, se usa directo como src
   del iframe — así funcionan links de embed de Vimeo, JWPlayer, etc. */
function videoEmbedUrl(url) {
  if (!url) return null;
  var yt = youtubeEmbedUrl(url);
  if (yt) return yt;
  var trimmed = String(url).trim();
  return /^https?:\/\//.test(trimmed) ? trimmed : null;
}

/* El banner de la nota: video > imagen destacada > ícono de la
   categoría sobre fondo de color, en ese orden de prioridad. */
function bannerHtmlFor(article, cat) {
  var embedUrl = videoEmbedUrl(article.videoUrl);
  if (embedUrl) {
    return '      <div class="article-banner video-wrap">\n' +
      '        <iframe src="' + embedUrl + '" title="' + article.title.replace(/"/g, '&quot;') + '" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>\n' +
      '      </div>\n';
  }
  if (article.image) {
    return '      <div class="article-banner media ' + cat.slug + '" style="background-image:url(\'../../' + article.image + '\');background-size:cover;background-position:center;"></div>\n';
  }
  return '      <div class="article-banner media ' + cat.slug + '">' + cat.icon + '</div>\n';
}

function generateArticleFile(article) {
  var cat = categoryBySlug(article.category);
  if (!cat) throw new Error('Categoría desconocida: ' + article.category);
  var blocks = loadSidebarFooter();

  // Las páginas de tema/subtema se retiraron junto con la navegación por
  // temas -- el breadcrumb y "Want more news about..." de cada artículo
  // apuntan directo a su categoría.
  var topicCrumb = '';
  var topicHref = 'index.html';
  var topicLabel = cat.label;

  var title = article.title;
  var titleShort = title.length <= 40 ? title : title.slice(0, 37) + '...';

  var html = fill(ARTICLE_PAGE_TEMPLATE, {
    title: title,
    titleShort: titleShort,
    slug: article.slug,
    dek: article.dek || '',
    catSlug: cat.slug,
    catLabel: cat.label,
    catIcon: cat.icon,
    dateLabel: formatDateEn(article.date),
    readTime: article.readTime || '',
    bannerHtml: bannerHtmlFor(article, cat),
    bodyHtml: renderBodyHtml(article.body),
    topicCrumb: topicCrumb,
    topicLabel: topicLabel,
    topicHref: topicHref,
    subtopicAttr: '',
    sidebar: blocks.sidebar,
    footer: blocks.footer
  });

  var outPath = articleFilePath(article);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

function deleteArticleFile(article) {
  var filePath = articleFilePath(article);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

module.exports = {
  loadCategories: loadCategories,
  categoryBySlug: categoryBySlug,
  addCategory: addCategory,
  renameCategory: renameCategory,
  deleteCategory: deleteCategory,
  slugify: slugify,
  generateArticleFile: generateArticleFile,
  deleteArticleFile: deleteArticleFile
};
