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
    - Una línea que diga exactamente "[publicidad]" = espacio publicitario.
    - "![alt](ruta)" en su propia línea = imagen suelta en medio del cuerpo.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CATEGORIA_DIR = path.join(ROOT, 'categoria');

const CATEGORIES = [
  { slug: 'trending', label: 'Trending', icon: '🌍' },
  { slug: 'ai', label: 'AI', icon: '🤖' },
  { slug: 'technology', label: 'Technology', icon: '💻' },
  { slug: 'science', label: 'Science & Space', icon: '🚀', imgFolder: 'science-space' },
  { slug: 'gaming', label: 'Gaming', icon: '🎮' },
  { slug: 'entertainment', label: 'Entertainment', icon: '🎬' },
  { slug: 'sports', label: 'Sports', icon: '⚽' },
  { slug: 'world', label: 'World', icon: '🌎' },
  { slug: 'curiosities', label: 'Curiosities', icon: '💡' },
  { slug: 'guides', label: 'Guides', icon: '📚' },
  { slug: 'social', label: 'Social Media', icon: '📱' },
  { slug: 'business', label: 'Business', icon: '💰' }
];
const CATEGORY_BY_SLUG = {};
CATEGORIES.forEach(function (c) { CATEGORY_BY_SLUG[c.slug] = c; });

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function formatDateEn(iso) {
  var parts = iso.split('-');
  var y = parts[0], m = parts[1], d = parts[2];
  return MONTHS_EN[parseInt(m, 10) - 1] + ' ' + String(parseInt(d, 10)) + ', ' + y;
}

function loadTopicGroups() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'topics.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function topicLabelFor(catSlug, topicSlug) {
  if (!topicSlug) return null;
  var groups = loadTopicGroups()[catSlug] || [];
  for (var g = 0; g < groups.length; g++) {
    var items = groups[g][1];
    for (var i = 0; i < items.length; i++) {
      if (items[i][0] === topicSlug) return items[i][1];
    }
  }
  return null;
}

function topicSlugify(label) {
  return String(label)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
}

/* Crea un tema nuevo en data/topics.json para una categoría, dentro de un
   grupo "🆕 Nuevos" (se crea si no existe). No genera HTML acá — para eso
   está el botón "Regenerar categorías y temas" del panel, que corre
   generate_pages.py y arma la tarjeta + la página del tema. */
function addTopic(categorySlug, label, groupName) {
  var cat = CATEGORY_BY_SLUG[categorySlug];
  if (!cat) throw new Error('Categoría desconocida: ' + categorySlug);

  var slug = topicSlugify(label);
  if (!slug) throw new Error('El nombre del tema no generó un slug válido');

  var topicsPath = path.join(DATA_DIR, 'topics.json');
  var allGroups = loadTopicGroups();
  var groups = allGroups[categorySlug] || [];

  for (var g = 0; g < groups.length; g++) {
    var items = groups[g][1];
    for (var i = 0; i < items.length; i++) {
      if (items[i][0] === slug) throw new Error('Ya existe un tema con ese nombre en esta categoría');
    }
  }

  var targetName = groupName || '🆕 Nuevos';
  var targetGroup = null;
  for (var g2 = 0; g2 < groups.length; g2++) {
    if (groups[g2][0] === targetName) { targetGroup = groups[g2]; break; }
  }
  if (!targetGroup) {
    targetGroup = [targetName, []];
    groups.push(targetGroup);
  }
  targetGroup[1].push([slug, label]);

  allGroups[categorySlug] = groups;
  fs.writeFileSync(topicsPath, JSON.stringify(allGroups, null, 2) + '\n', 'utf8');
  return { slug: slug, label: label, group: targetName };
}

/* Nombres de los grupos/secciones ya existentes para una categoría, en el
   orden en que aparecen en la página (ej. "⭐ Populares", "Nintendo", ...). */
function listGroupNames(categorySlug) {
  var groups = loadTopicGroups()[categorySlug] || [];
  return groups.map(function (g) { return g[0]; });
}

function findTopic(groups, slug) {
  for (var g = 0; g < groups.length; g++) {
    var items = groups[g][1];
    for (var i = 0; i < items.length; i++) {
      if (items[i][0] === slug) return { groupIndex: g, itemIndex: i };
    }
  }
  return null;
}

function renameTopic(categorySlug, slug, newLabel) {
  if (!CATEGORY_BY_SLUG[categorySlug]) throw new Error('Categoría desconocida: ' + categorySlug);
  if (!newLabel || !newLabel.trim()) throw new Error('El nuevo nombre no puede estar vacío');

  var topicsPath = path.join(DATA_DIR, 'topics.json');
  var allGroups = loadTopicGroups();
  var groups = allGroups[categorySlug] || [];
  var found = findTopic(groups, slug);
  if (!found) throw new Error('No se encontró ese tema en esta categoría');

  groups[found.groupIndex][1][found.itemIndex][1] = newLabel.trim();
  allGroups[categorySlug] = groups;
  fs.writeFileSync(topicsPath, JSON.stringify(allGroups, null, 2) + '\n', 'utf8');
  return { slug: slug, label: newLabel.trim() };
}

/* Saca un tema de data/topics.json y borra su página HTML si existe.
   No toca los artículos que lo tengan asignado — eso se valida antes,
   desde server.js, para no dejar links rotos sin avisar. */
function deleteTopic(categorySlug, slug) {
  var cat = CATEGORY_BY_SLUG[categorySlug];
  if (!cat) throw new Error('Categoría desconocida: ' + categorySlug);

  var topicsPath = path.join(DATA_DIR, 'topics.json');
  var allGroups = loadTopicGroups();
  var groups = allGroups[categorySlug] || [];
  var found = findTopic(groups, slug);
  if (!found) throw new Error('No se encontró ese tema en esta categoría');

  groups[found.groupIndex][1].splice(found.itemIndex, 1);
  if (groups[found.groupIndex][1].length === 0) {
    groups.splice(found.groupIndex, 1);
  }
  allGroups[categorySlug] = groups;
  fs.writeFileSync(topicsPath, JSON.stringify(allGroups, null, 2) + '\n', 'utf8');

  var topicPage = path.join(CATEGORIA_DIR, cat.slug, slug + '.html');
  if (fs.existsSync(topicPage)) fs.unlinkSync(topicPage);

  return { slug: slug };
}

/* =====================================================================
   SUBTEMAS — un nivel más adentro de un tema (ej. "Trailers" dentro de
   "GTA VI" dentro de Gaming). Mismo patrón que los temas de arriba, pero
   sin grupos (el tema ya cumple ese rol) y con clave compuesta
   "categoria/temaSlug" en vez de solo la categoría.
   ===================================================================== */

const SUBTOPICS_FILE = path.join(DATA_DIR, 'subtopics.json');

function loadSubtopics() {
  try {
    return JSON.parse(fs.readFileSync(SUBTOPICS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveSubtopics(data) {
  fs.writeFileSync(SUBTOPICS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function subtopicKey(categorySlug, topicSlug) { return categorySlug + '/' + topicSlug; }

function subtopicLabelFor(catSlug, topicSlug, subtopicSlug) {
  if (!subtopicSlug) return null;
  var items = loadSubtopics()[subtopicKey(catSlug, topicSlug)] || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i][0] === subtopicSlug) return items[i][1];
  }
  return null;
}

function addSubtopic(categorySlug, topicSlug, label) {
  if (!CATEGORY_BY_SLUG[categorySlug]) throw new Error('Categoría desconocida: ' + categorySlug);
  if (!topicLabelFor(categorySlug, topicSlug)) throw new Error('No se encontró ese tema en esta categoría');

  var slug = topicSlugify(label);
  if (!slug) throw new Error('El nombre del subtema no generó un slug válido');

  var key = subtopicKey(categorySlug, topicSlug);
  var all = loadSubtopics();
  var items = all[key] || [];
  if (items.some(function (it) { return it[0] === slug; })) {
    throw new Error('Ya existe un subtema con ese nombre en este tema');
  }

  items.push([slug, label]);
  all[key] = items;
  saveSubtopics(all);
  return { slug: slug, label: label };
}

function renameSubtopic(categorySlug, topicSlug, slug, newLabel) {
  if (!newLabel || !newLabel.trim()) throw new Error('El nuevo nombre no puede estar vacío');
  var key = subtopicKey(categorySlug, topicSlug);
  var all = loadSubtopics();
  var items = all[key] || [];
  var found = items.find(function (it) { return it[0] === slug; });
  if (!found) throw new Error('No se encontró ese subtema');
  found[1] = newLabel.trim();
  all[key] = items;
  saveSubtopics(all);
  return { slug: slug, label: newLabel.trim() };
}

/* Saca un subtema de data/subtopics.json y borra su página HTML si existe.
   No toca los artículos que lo tengan asignado — eso se valida antes,
   desde server.js. */
function deleteSubtopic(categorySlug, topicSlug, slug) {
  var cat = CATEGORY_BY_SLUG[categorySlug];
  if (!cat) throw new Error('Categoría desconocida: ' + categorySlug);

  var key = subtopicKey(categorySlug, topicSlug);
  var all = loadSubtopics();
  var items = all[key] || [];
  var idx = items.findIndex(function (it) { return it[0] === slug; });
  if (idx === -1) throw new Error('No se encontró ese subtema');
  items.splice(idx, 1);
  if (items.length === 0) delete all[key];
  else all[key] = items;
  saveSubtopics(all);

  var subtopicPage = path.join(CATEGORIA_DIR, cat.slug, topicSlug + '-' + slug + '.html');
  if (fs.existsSync(subtopicPage)) fs.unlinkSync(subtopicPage);

  return { slug: slug };
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
  html = html.split('src="img/').join('src="../../img/');
  html = html.split("url('img/").join("url('../../img/");
  CATEGORIES.forEach(function (cat) {
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

var AD_SLOT_HTML = '      <div class="ad-slot" style="margin: 30px 0;">Advertisement · in-article</div>\n';

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
    } else if (b.type === 'ad') {
      html += AD_SLOT_HTML;
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
  var cat = CATEGORY_BY_SLUG[article.category];
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
  var cat = CATEGORY_BY_SLUG[article.category];
  if (!cat) throw new Error('Categoría desconocida: ' + article.category);
  var blocks = loadSidebarFooter();

  var topicSlug = article.topic || '';
  var topicLabel = topicSlug ? topicLabelFor(cat.slug, topicSlug) : null;
  var topicCrumb = '';
  var topicHref = 'index.html';
  if (topicSlug && topicLabel) {
    topicCrumb = '<span class="sep">/</span><a href="' + topicSlug + '.html">' + topicLabel + '</a>';
    topicHref = topicSlug + '.html';
  } else if (!topicLabel) {
    topicLabel = cat.label;
  }

  // Subtema (un nivel más adentro de un tema, ej. "Trailers" dentro de
  // "GTA VI") — si está asignado, se agrega como cuarto nivel del
  // breadcrumb y pasa a ser el destino de "Want more news about...".
  var subtopicSlug = article.subtopic || '';
  var subtopicLabel = (topicSlug && subtopicSlug) ? subtopicLabelFor(cat.slug, topicSlug, subtopicSlug) : null;
  if (topicSlug && subtopicSlug && subtopicLabel) {
    topicCrumb += '<span class="sep">/</span><a href="' + topicSlug + '-' + subtopicSlug + '.html">' + subtopicLabel + '</a>';
    topicLabel = subtopicLabel;
    topicHref = topicSlug + '-' + subtopicSlug + '.html';
  }

  var title = article.title;
  var titleShort = title.length <= 40 ? title : title.slice(0, 37) + '...';

  var html = fill(ARTICLE_PAGE_TEMPLATE, {
    title: title,
    titleShort: titleShort,
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
  CATEGORIES: CATEGORIES,
  CATEGORY_BY_SLUG: CATEGORY_BY_SLUG,
  loadTopicGroups: loadTopicGroups,
  topicLabelFor: topicLabelFor,
  addTopic: addTopic,
  listGroupNames: listGroupNames,
  renameTopic: renameTopic,
  deleteTopic: deleteTopic,
  loadSubtopics: loadSubtopics,
  subtopicLabelFor: subtopicLabelFor,
  addSubtopic: addSubtopic,
  renameSubtopic: renameSubtopic,
  deleteSubtopic: deleteSubtopic,
  slugify: slugify,
  generateArticleFile: generateArticleFile,
  deleteArticleFile: deleteArticleFile
};
