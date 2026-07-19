/*
  Panel de administración de VexlowHQ — servidor local
  =====================================================
  No requiere instalar nada (usa solo módulos incluidos con Node).
  Se arranca con doble clic en start-admin.bat, o a mano con:
    node admin/server.js

  Qué hace:
  - Sirve el panel en http://localhost:4321
  - Guarda los cambios de Hero y Artículos en data/hero.json y
    data/articulos.json, y regenera data/hero.js / data/articulos.js
    (los archivos que el sitio realmente carga) automáticamente.
  - Sirve el sitio real en http://localhost:4321/site/ para poder
    previsualizar los cambios sin salir del panel.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pagegen = require('./pagegen');
const pipeline = require('./pipeline');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const IMG_DIR = path.join(ROOT, 'img');
const ADMIN_DIR = __dirname;
const PORT = 4321;

const CATEGORIES = pagegen.CATEGORIES;
const RESERVED_SLUGS = new Set(CATEGORIES.map(function (c) { return c.slug; }).concat(['index']));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.avif']);

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function generateHeroJs(data) {
  var header = '/*\n' +
    '  HERO — diapositivas del carrusel principal de la Home\n' +
    '  =======================================================\n' +
    '  GENERADO AUTOMÁTICAMENTE por el panel de administración\n' +
    '  (admin/index.html). No lo edites a mano: los cambios se van a\n' +
    '  perder la próxima vez que guardes algo desde el panel.\n' +
    '  La fuente real es data/hero.json.\n' +
    '*/\n';
  return header + 'const VEXLOW_HERO = ' + JSON.stringify(data, null, 2) + ';\n';
}

function generateArticulosJs(data) {
  var header = '/*\n' +
    '  ARTÍCULOS — fuente de "Últimas publicadas" y de las páginas de categoría\n' +
    '  ==========================================================================\n' +
    '  GENERADO AUTOMÁTICAMENTE por el panel de administración\n' +
    '  (admin/index.html). No lo edites a mano: los cambios se van a\n' +
    '  perder la próxima vez que guardes algo desde el panel.\n' +
    '  La fuente real es data/articulos.json.\n' +
    '*/\n';
  return header + 'const VEXLOW_ARTICLES = ' + JSON.stringify(data, null, 2) + ';\n';
}

function camelToLabel(name) {
  var spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.replace(/[_-]/g, ' ').trim();
}

// Si el tema tiene una carpeta img/{folder}/{slug}/ con al menos una
// imagen adentro, devuelve la ruta relativa de esa imagen (para mostrar
// una vista previa en el panel); si no, null.
function topicThumbPath(cat, slug) {
  var folder = cat.imgFolder || cat.slug;
  var dir = path.join(IMG_DIR, folder, slug);
  var files;
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  var found = files.find(function (f) { return IMAGE_EXT.has(path.extname(f).toLowerCase()); });
  return found ? 'img/' + folder + '/' + slug + '/' + found : null;
}

function listTopics() {
  var topicGroups = pagegen.loadTopicGroups();
  var result = {};
  CATEGORIES.forEach(function (cat) {
    var seen = new Set();
    var topics = [];

    // 1) Temas curados en data/topics.json (la fuente principal, la misma
    //    que usa generate_pages.py para las páginas de categoría/tema).
    (topicGroups[cat.slug] || []).forEach(function (group) {
      group[1].forEach(function (pair) {
        var slug = pair[0], label = pair[1];
        if (seen.has(slug)) return;
        seen.add(slug);
        topics.push({ slug: slug, label: label, thumb: topicThumbPath(cat, slug) });
      });
    });

    // 2) Por si hay una carpeta de imagen para un tema que todavía no
    //    está en topics.json (modo automático viejo).
    var folder = cat.imgFolder || cat.slug;
    var base = path.join(IMG_DIR, folder);
    var entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { entries = []; }
    entries.forEach(function (entry) {
      if (!entry.isDirectory()) return;
      var slug = entry.name.toLowerCase();
      if (RESERVED_SLUGS.has(slug) || seen.has(slug)) return;
      seen.add(slug);
      topics.push({ slug: slug, label: camelToLabel(entry.name), thumb: topicThumbPath(cat, slug) });
    });

    result[cat.slug] = topics;
  });
  return result;
}

// Subtemas — un nivel más adentro de un tema (ej. "Trailers" dentro de
// "GTA VI"). Mismo patrón que listTopics/topicThumbPath, una carpeta de
// imagen más adentro.
function subtopicThumbPath(cat, topicSlug, subSlug) {
  var folder = cat.imgFolder || cat.slug;
  var dir = path.join(IMG_DIR, folder, topicSlug, subSlug);
  var files;
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  var found = files.find(function (f) { return IMAGE_EXT.has(path.extname(f).toLowerCase()); });
  return found ? 'img/' + folder + '/' + topicSlug + '/' + subSlug + '/' + found : null;
}

function listSubtopics() {
  var all = pagegen.loadSubtopics();
  var result = {};
  Object.keys(all).forEach(function (key) {
    var parts = key.split('/');
    var cat = CATEGORIES.find(function (c) { return c.slug === parts[0]; });
    var topicSlug = parts[1];
    result[key] = all[key].map(function (pair) {
      var slug = pair[0], label = pair[1];
      return { slug: slug, label: label, thumb: cat ? subtopicThumbPath(cat, topicSlug, slug) : null };
    });
  });
  return result;
}

function listImages() {
  var results = [];
  function walk(dir, relBase) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function (entry) {
      var rel = relBase ? relBase + '/' + entry.name : entry.name;
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        results.push('img/' + rel.split(path.sep).join('/'));
      }
    });
  }
  walk(IMG_DIR, '');
  return results.sort();
}

function sendJSON(res, status, data) {
  var body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, function (err, content) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado: ' + filePath);
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function readBody(req, cb) {
  var chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    try {
      var body = Buffer.concat(chunks).toString('utf8');
      cb(null, body ? JSON.parse(body) : null);
    } catch (e) {
      cb(e);
    }
  });
}

function safeJoin(base, rel) {
  var full = path.normalize(path.join(base, rel));
  if (!full.startsWith(path.normalize(base))) return null; // evita salir de la carpeta
  return full;
}

var MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB decodificados

function sanitizeFilename(name) {
  var ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(ext)) ext = '.jpg';
  var base = path.basename(name, path.extname(name))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'imagen';
  return { base: base, ext: ext };
}

function uploadImage(category, filename, dataBase64) {
  var cat = CATEGORIES.find(function (c) { return c.slug === category; });
  if (!cat) throw new Error('Categoría desconocida: ' + category);

  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('La imagen pesa más de 8 MB');

  var parts = sanitizeFilename(filename);
  var folder = cat.imgFolder || cat.slug;
  var dir = path.join(IMG_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });

  var finalName = parts.base + parts.ext;
  var counter = 1;
  while (fs.existsSync(path.join(dir, finalName))) {
    finalName = parts.base + '-' + counter + parts.ext;
    counter++;
  }

  fs.writeFileSync(path.join(dir, finalName), buffer);
  return 'img/' + folder + '/' + finalName;
}

var TOPIC_SLUG_RE = /^[a-z0-9-]+$/;

function topicImageDir(category, topicSlug) {
  var cat = CATEGORIES.find(function (c) { return c.slug === category; });
  if (!cat) throw new Error('Categoría desconocida: ' + category);
  if (!TOPIC_SLUG_RE.test(topicSlug)) throw new Error('Tema inválido: ' + topicSlug);
  var folder = cat.imgFolder || cat.slug;
  return path.join(IMG_DIR, folder, topicSlug);
}

// Cada tema tiene como mucho una imagen: al subir una nueva se borran las
// anteriores, para que no haya ambigüedad sobre cuál se usa como miniatura.
function uploadTopicImage(category, topicSlug, filename, dataBase64) {
  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('La imagen pesa más de 8 MB');

  var dir = topicImageDir(category, topicSlug);
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  var parts = sanitizeFilename(filename);
  var finalName = parts.base + parts.ext;
  fs.writeFileSync(path.join(dir, finalName), buffer);
  return path.relative(ROOT, path.join(dir, finalName)).split(path.sep).join('/');
}

function removeTopicImage(category, topicSlug) {
  var dir = topicImageDir(category, topicSlug);
  if (!fs.existsSync(dir)) return false;
  fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  fs.rmdirSync(dir);
  return true;
}

function subtopicImageDir(category, topicSlug, subtopicSlug) {
  var cat = CATEGORIES.find(function (c) { return c.slug === category; });
  if (!cat) throw new Error('Categoría desconocida: ' + category);
  if (!TOPIC_SLUG_RE.test(topicSlug)) throw new Error('Tema inválido: ' + topicSlug);
  if (!TOPIC_SLUG_RE.test(subtopicSlug)) throw new Error('Subtema inválido: ' + subtopicSlug);
  var folder = cat.imgFolder || cat.slug;
  return path.join(IMG_DIR, folder, topicSlug, subtopicSlug);
}

function uploadSubtopicImage(category, topicSlug, subtopicSlug, filename, dataBase64) {
  var buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) throw new Error('El archivo llegó vacío');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('La imagen pesa más de 8 MB');

  var dir = subtopicImageDir(category, topicSlug, subtopicSlug);
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  var parts = sanitizeFilename(filename);
  var finalName = parts.base + parts.ext;
  fs.writeFileSync(path.join(dir, finalName), buffer);
  return path.relative(ROOT, path.join(dir, finalName)).split(path.sep).join('/');
}

function removeSubtopicImage(category, topicSlug, subtopicSlug) {
  var dir = subtopicImageDir(category, topicSlug, subtopicSlug);
  if (!fs.existsSync(dir)) return false;
  fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  fs.rmdirSync(dir);
  return true;
}

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);

  // ---- API ----
  if (urlPath === '/api/categories' && req.method === 'GET') {
    return sendJSON(res, 200, CATEGORIES);
  }
  if (urlPath === '/api/images' && req.method === 'GET') {
    return sendJSON(res, 200, listImages());
  }
  if (urlPath === '/api/upload-image' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.filename || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, nombre de archivo o imagen)' });
      }
      try {
        var savedPath = uploadImage(data.category, data.filename, data.dataBase64);
        return sendJSON(res, 200, { ok: true, path: savedPath });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/upload-topic-image' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topicSlug || !data.filename || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema, nombre de archivo o imagen)' });
      }
      try {
        var savedPath = uploadTopicImage(data.category, data.topicSlug, data.filename, data.dataBase64);
        return sendJSON(res, 200, { ok: true, path: savedPath });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/upload-topic-image' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topicSlug) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría o tema)' });
      }
      try {
        var removed = removeTopicImage(data.category, data.topicSlug);
        return sendJSON(res, 200, { ok: true, removed: removed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/topics' && req.method === 'GET') {
    return sendJSON(res, 200, listTopics());
  }
  if (urlPath === '/api/topics' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.label) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría o nombre del tema)' });
      }
      try {
        var created = pagegen.addTopic(data.category, data.label, data.group);
        return sendJSON(res, 200, { ok: true, topic: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/topics' && req.method === 'PATCH') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.slug || !data.label) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema o nuevo nombre)' });
      }
      try {
        var renamed = pagegen.renameTopic(data.category, data.slug, data.label);
        return sendJSON(res, 200, { ok: true, topic: renamed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/topics' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.slug) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría o tema)' });
      }
      var articles = [];
      try { articles = readJSON(path.join(DATA_DIR, 'articulos.json')); } catch (e) { articles = []; }
      var usedBy = articles.filter(function (a) { return a.category === data.category && a.topic === data.slug; });
      var subtopicCount = (pagegen.loadSubtopics()[data.category + '/' + data.slug] || []).length;
      if (usedBy.length || subtopicCount) {
        var msgParts = [];
        if (usedBy.length) msgParts.push(usedBy.length + ' artículo(s)');
        if (subtopicCount) msgParts.push(subtopicCount + ' subtema(s)');
        return sendJSON(res, 409, {
          error: 'Este tema todavía tiene ' + msgParts.join(' y ') + '. Movelos o eliminalos antes de borrar el tema.',
          articles: usedBy.map(function (a) { return a.title; })
        });
      }
      try {
        var removed = pagegen.deleteTopic(data.category, data.slug);
        return sendJSON(res, 200, { ok: true, topic: removed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/upload-subtopic-image' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topicSlug || !data.subtopicSlug || !data.filename || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema, subtema, nombre de archivo o imagen)' });
      }
      try {
        var savedPath = uploadSubtopicImage(data.category, data.topicSlug, data.subtopicSlug, data.filename, data.dataBase64);
        return sendJSON(res, 200, { ok: true, path: savedPath });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/upload-subtopic-image' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topicSlug || !data.subtopicSlug) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema o subtema)' });
      }
      try {
        var removed = removeSubtopicImage(data.category, data.topicSlug, data.subtopicSlug);
        return sendJSON(res, 200, { ok: true, removed: removed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/subtopics' && req.method === 'GET') {
    return sendJSON(res, 200, listSubtopics());
  }
  if (urlPath === '/api/subtopics' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topic || !data.label) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema o nombre del subtema)' });
      }
      try {
        var created = pagegen.addSubtopic(data.category, data.topic, data.label);
        return sendJSON(res, 200, { ok: true, subtopic: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/subtopics' && req.method === 'PATCH') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topic || !data.slug || !data.label) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema, subtema o nuevo nombre)' });
      }
      try {
        var renamed = pagegen.renameSubtopic(data.category, data.topic, data.slug, data.label);
        return sendJSON(res, 200, { ok: true, subtopic: renamed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/subtopics' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.category || !data.topic || !data.slug) {
        return sendJSON(res, 400, { error: 'Faltan datos (categoría, tema o subtema)' });
      }
      var articles = [];
      try { articles = readJSON(path.join(DATA_DIR, 'articulos.json')); } catch (e) { articles = []; }
      var usedBy = articles.filter(function (a) { return a.category === data.category && a.topic === data.topic && a.subtopic === data.slug; });
      if (usedBy.length) {
        return sendJSON(res, 409, {
          error: usedBy.length + ' artículo(s) todavía usan este subtema. Cambialos de subtema o borralos antes de eliminarlo.',
          articles: usedBy.map(function (a) { return a.title; })
        });
      }
      try {
        var removed = pagegen.deleteSubtopic(data.category, data.topic, data.slug);
        return sendJSON(res, 200, { ok: true, subtopic: removed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/topic-groups' && req.method === 'GET') {
    return sendJSON(res, 200, pagegen.loadTopicGroups());
  }
  if (urlPath === '/api/hero' && req.method === 'GET') {
    return sendJSON(res, 200, readJSON(path.join(DATA_DIR, 'hero.json')));
  }
  if (urlPath === '/api/hero' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !Array.isArray(data)) return sendJSON(res, 400, { error: 'JSON inválido' });
      writeJSON(path.join(DATA_DIR, 'hero.json'), data);
      fs.writeFileSync(path.join(DATA_DIR, 'hero.js'), generateHeroJs(data), 'utf8');
      return sendJSON(res, 200, { ok: true });
    });
  }
  if (urlPath === '/api/articles' && req.method === 'GET') {
    return sendJSON(res, 200, readJSON(path.join(DATA_DIR, 'articulos.json')));
  }
  if (urlPath === '/api/articles' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !Array.isArray(data)) return sendJSON(res, 400, { error: 'JSON inválido' });

      var articlesFile = path.join(DATA_DIR, 'articulos.json');
      var previous = [];
      try { previous = readJSON(articlesFile); } catch (e) { previous = []; }

      writeJSON(articlesFile, data);
      fs.writeFileSync(path.join(DATA_DIR, 'articulos.js'), generateArticulosJs(data), 'utf8');

      // Genera (o regenera) la página real de cada artículo que tenga
      // slug + categoría + cuerpo — así "Guardar" ya deja la nota publicada.
      var generated = [];
      var errors = [];
      var currentKeys = new Set();
      data.forEach(function (a) {
        if (!a.slug || !a.category) return;
        currentKeys.add(a.category + '/' + a.slug);
        if (typeof a.body !== 'string' || !a.body.trim()) return; // sin cuerpo: solo queda en el listado, sin página propia
        try {
          generated.push(pagegen.generateArticleFile(a));
        } catch (e) {
          errors.push({ slug: a.slug, error: e.message });
        }
      });

      // Borra el HTML de artículos que ya no están en la lista (o que
      // cambiaron de categoría/slug).
      var removed = [];
      previous.forEach(function (a) {
        if (!a.slug || !a.category) return;
        var key = a.category + '/' + a.slug;
        if (currentKeys.has(key)) return;
        if (pagegen.deleteArticleFile(a)) removed.push(key);
      });

      return sendJSON(res, 200, { ok: true, generated: generated, removed: removed, errors: errors });
    });
  }
  if (urlPath === '/api/drafts' && req.method === 'GET') {
    var drafts = [];
    try { drafts = readJSON(path.join(DATA_DIR, 'drafts.json')); } catch (e) { drafts = []; }
    return sendJSON(res, 200, drafts);
  }
  if (urlPath === '/api/fetch-drafts' && req.method === 'POST') {
    pipeline.fetchNewDrafts().then(function (result) {
      sendJSON(res, 200, result);
    }).catch(function (e) {
      sendJSON(res, 500, { ok: false, error: e.message });
    });
    return;
  }
  if (urlPath === '/api/drafts' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) return sendJSON(res, 400, { error: 'Falta el slug del borrador' });
      // used=true: se publicó el borrador (solo se saca de la lista).
      // used=false (default): se descartó (se saca Y se recuerda la fuente
      // para no volver a sugerirla en la próxima búsqueda).
      var removed = data.used ? pipeline.removeDraft(data.slug) : pipeline.discardDraft(data.slug);
      return sendJSON(res, 200, { ok: true, removed: removed });
    });
  }
  if (urlPath === '/api/deploy' && req.method === 'POST') {
    (async function () {
      function runGit(args) {
        return new Promise(function (resolve, reject) {
          var proc = spawn('git', args, { cwd: ROOT });
          var out = '';
          proc.stdout.on('data', function (d) { out += d.toString('utf8'); });
          proc.stderr.on('data', function (d) { out += d.toString('utf8'); });
          proc.on('error', reject);
          proc.on('close', function (code) { resolve({ code: code, output: out }); });
        });
      }
      try {
        var add = await runGit(['add', '-A']);
        var commit = await runGit(['commit', '-m', 'Actualización desde el panel de administración — ' + new Date().toISOString()]);
        var nothingToCommit = commit.output.toLowerCase().indexOf('nothing to commit') !== -1;
        if (nothingToCommit) {
          return sendJSON(res, 200, { ok: true, nothingToCommit: true, output: 'No había cambios nuevos para publicar.' });
        }
        var push = await runGit(['push', 'origin', 'main']);
        var full = '--- git add ---\n' + add.output + '\n--- git commit ---\n' + commit.output + '\n--- git push ---\n' + push.output;
        return sendJSON(res, push.code === 0 ? 200 : 500, { ok: push.code === 0, output: full });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    })();
    return;
  }
  if (urlPath === '/api/regenerate' && req.method === 'POST') {
    var py = spawn('python', [path.join(ADMIN_DIR, 'generate_pages.py')], { cwd: ROOT });
    var out = '';
    py.stdout.on('data', function (d) { out += d.toString('utf8'); });
    py.stderr.on('data', function (d) { out += d.toString('utf8'); });
    py.on('error', function (e) {
      sendJSON(res, 500, { ok: false, error: 'No se pudo ejecutar Python: ' + e.message });
    });
    py.on('close', function (code) {
      sendJSON(res, code === 0 ? 200 : 500, { ok: code === 0, output: out });
    });
    return;
  }

  // ---- Preview del sitio real ----
  if (urlPath === '/site' || urlPath === '/site/') {
    return serveStaticFile(res, path.join(ROOT, 'index.html'));
  }
  if (urlPath.indexOf('/site/') === 0) {
    var sitePath = safeJoin(ROOT, urlPath.slice('/site/'.length));
    if (sitePath) return serveStaticFile(res, sitePath);
  }

  // ---- Panel de administración ----
  if (urlPath === '/' || urlPath === '') {
    return serveStaticFile(res, path.join(ADMIN_DIR, 'index.html'));
  }
  var adminPath = safeJoin(ADMIN_DIR, urlPath.slice(1));
  if (adminPath && fs.existsSync(adminPath)) {
    return serveStaticFile(res, adminPath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

server.listen(PORT, function () {
  console.log('');
  console.log('  VexlowHQ — Panel de administración');
  console.log('  Abrí esto en tu navegador: http://localhost:' + PORT);
  console.log('  Vista previa del sitio:    http://localhost:' + PORT + '/site/');
  console.log('  (Para cerrar el panel, cerrá esta ventana o presioná Ctrl+C)');
  console.log('');
});
