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
const deploy = require('./deploy');
const gravityEditor = require('./gravity-editor');
const social = require('./social');
const sprint = require('./sprint');
const carouselGen = require('./carousel-gen');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const IMG_DIR = path.join(ROOT, 'img');
const ADMIN_DIR = __dirname;
const CONFIG_FILE = path.join(ADMIN_DIR, 'config.json');
const PORT = 4321;

// Recargadas del disco en cada uso (pagegen.loadCategories), no una
// constante fija -- así un alta/baja de categoría hecha desde el panel
// se ve al toque, sin reiniciar el servidor.
function reservedSlugs() {
  return new Set(pagegen.loadCategories().map(function (c) { return c.slug; }).concat(['index']));
}

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
  var cat = pagegen.categoryBySlug(category);
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

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);

  // ---- API ----
  if (urlPath === '/api/categories' && req.method === 'GET') {
    return sendJSON(res, 200, pagegen.loadCategories());
  }
  if (urlPath === '/api/categories' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.label) {
        return sendJSON(res, 400, { error: 'Falta el nombre de la categoría' });
      }
      try {
        var created = pagegen.addCategory(data.label, data.icon, data.description);
        return sendJSON(res, 200, { ok: true, category: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/categories' && req.method === 'PATCH') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) {
        return sendJSON(res, 400, { error: 'Falta la categoría a editar' });
      }
      try {
        var renamed = pagegen.renameCategory(data.slug, data.label, data.icon, data.description);
        return sendJSON(res, 200, { ok: true, category: renamed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/categories' && req.method === 'DELETE') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug) {
        return sendJSON(res, 400, { error: 'Falta la categoría a eliminar' });
      }
      var articles = [];
      try { articles = readJSON(path.join(DATA_DIR, 'articulos.json')); } catch (e) { articles = []; }
      var usedBy = articles.filter(function (a) { return a.category === data.slug; });
      var draftUsedBy = [];
      try { draftUsedBy = readJSON(path.join(DATA_DIR, 'drafts.json')).filter(function (a) { return a.category === data.slug; }); } catch (e) { draftUsedBy = []; }
      if (usedBy.length || draftUsedBy.length) {
        return sendJSON(res, 409, {
          error: 'Esta categoría todavía tiene ' + (usedBy.length + draftUsedBy.length) + ' artículo(s)/borrador(es). Movelos o eliminalos antes de borrar la categoría.',
          articles: usedBy.concat(draftUsedBy).map(function (a) { return a.title; })
        });
      }
      try {
        var removed = pagegen.deleteCategory(data.slug);
        return sendJSON(res, 200, { ok: true, category: removed });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
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
    deploy.deploy('Actualización desde el panel de administración — ' + new Date().toISOString())
      .then(function (result) { sendJSON(res, result.ok ? 200 : 500, result); })
      .catch(function (e) { sendJSON(res, 500, { ok: false, error: e.message }); });
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

  // ---- Redes sociales (Instagram) ----
  if (urlPath === '/api/social/status' && req.method === 'GET') {
    return sendJSON(res, 200, { instagram: social.getStatus() });
  }
  if (urlPath === '/api/social/config' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.instagram) {
        return sendJSON(res, 400, { error: 'Faltan los datos de conexión' });
      }
      try {
        social.saveConfigPatch(data.instagram);
        return sendJSON(res, 200, { ok: true, instagram: social.getStatus() });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/social/log' && req.method === 'GET') {
    return sendJSON(res, 200, social.loadLog());
  }
  if (urlPath === '/api/social/instagram/publish' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.slug || !data.caption) {
        return sendJSON(res, 400, { error: 'Falta el artículo o el texto de la publicación' });
      }
      var articles = [];
      try { articles = readJSON(path.join(DATA_DIR, 'articulos.json')); } catch (e) { articles = []; }
      var article = articles.find(function (a) { return a.slug === data.slug; });
      if (!article) return sendJSON(res, 404, { error: 'No se encontró ese artículo' });
      if (!article.image) return sendJSON(res, 400, { error: 'Este artículo no tiene imagen de portada' });

      social.publishToInstagram({
        imageUrl: social.publicImageUrl(article.image),
        caption: data.caption
      }).then(function (result) {
        social.logPublish(data.slug, result.mediaId);
        return sendJSON(res, 200, { ok: true, mediaId: result.mediaId });
      }).catch(function (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      });
    });
  }

  // ---- Sprint de 14 días (crecimiento en Instagram) ----
  if (urlPath === '/api/sprint/status' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, sprint.getStatus());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/sprint/start' && req.method === 'POST') {
    return sendJSON(res, 200, { ok: true, log: sprint.startSprint() });
  }
  if (urlPath === '/api/sprint/reset' && req.method === 'POST') {
    return sendJSON(res, 200, { ok: true, log: sprint.resetSprint() });
  }
  if (urlPath === '/api/sprint/mark-reel' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day) return sendJSON(res, 400, { error: 'Falta el día' });
      var entry = sprint.markDayDone(data.day, { type: 'reel', postUrl: data.postUrl || null });
      return sendJSON(res, 200, { ok: true, entry: entry });
    });
  }
  if (urlPath === '/api/sprint/toggle-story' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day || data.index == null) return sendJSON(res, 400, { error: 'Faltan datos' });
      var entry = sprint.toggleStory(data.day, data.index);
      return sendJSON(res, 200, { ok: true, entry: entry });
    });
  }
  if (urlPath === '/api/sprint/kpi' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day || data.pct == null) return sendJSON(res, 400, { error: 'Faltan datos' });
      var result = sprint.saveKpi(data.day, Number(data.pct));
      return sendJSON(res, 200, { ok: true, entry: result.entry, verdict: result.verdict });
    });
  }
  if (urlPath === '/api/sprint/carousel/generate' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day) return sendJSON(res, 400, { error: 'Falta el día' });
      var plan = sprint.loadPlan();
      var dayPlan = plan.days.find(function (d) { return d.day === data.day; });
      if (!dayPlan || dayPlan.format !== 'carousel') return sendJSON(res, 400, { error: 'Ese día no es un carrusel' });
      var cfg = readJSON(CONFIG_FILE);
      carouselGen.generateCarouselImages(dayPlan, cfg).then(function (images) {
        return sendJSON(res, 200, { ok: true, images: images, postTitle: dayPlan.postTitle, caption: dayPlan.caption });
      }).catch(function (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      });
    });
  }
  if (urlPath === '/api/sprint/carousel/publish' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.day || !data.caption) return sendJSON(res, 400, { error: 'Faltan datos' });
      var dayDir = path.join(IMG_DIR, 'carousels', 'day-' + data.day);
      var files;
      try {
        files = fs.readdirSync(dayDir).filter(function (f) { return /^slide-\d+\.jpg$/.test(f); })
          .sort(function (a, b) { return parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10); });
      } catch (e) {
        return sendJSON(res, 400, { error: 'No hay imágenes generadas para este día. Generá el carrusel primero.' });
      }
      if (!files.length) return sendJSON(res, 400, { error: 'No hay imágenes generadas para este día. Generá el carrusel primero.' });

      var relPaths = files.map(function (f) { return 'img/carousels/day-' + data.day + '/' + f; });
      var cacheBust = Date.now();
      var publicUrls = relPaths.map(function (p) { return social.publicImageUrl(p, cacheBust); });

      deploy.deploy('Sprint día ' + data.day + ' — carrusel generado desde el panel')
        .then(function (deployResult) {
          if (!deployResult.ok) throw new Error('No se pudo publicar los cambios al sitio: ' + deployResult.output.slice(-300));
          return Promise.all(publicUrls.map(function (u) { return social.waitUntilPublic(u, 30, 4000); }));
        })
        .then(function () {
          return social.publishCarouselToInstagram({ imageUrls: publicUrls, caption: data.caption });
        })
        .then(function (result) {
          sprint.markDayDone(data.day, { type: 'carousel', mediaId: result.mediaId });
          return sendJSON(res, 200, { ok: true, mediaId: result.mediaId });
        })
        .catch(function (e) {
          return sendJSON(res, 500, { ok: false, error: e.message });
        });
    });
  }

  // ---- Editor visual de niveles de Gravity Flip ----
  if (urlPath === '/api/gravity-levels' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.listLevels());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-level' && req.method === 'GET') {
    var levelId = new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!levelId) return sendJSON(res, 400, { error: 'Falta el id del nivel' });
    try {
      return sendJSON(res, 200, gravityEditor.loadLevel(levelId));
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-level/verify' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.id || !Array.isArray(data.objects)) {
        return sendJSON(res, 400, { error: 'Faltan datos del nivel a verificar' });
      }
      try {
        var result = gravityEditor.verifyLevel(data.id, data, 90 * 1000);
        return sendJSON(res, 200, { ok: true, result: result });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-level/save' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.id || !Array.isArray(data.objects)) {
        return sendJSON(res, 400, { error: 'Faltan datos del nivel a guardar' });
      }
      try {
        gravityEditor.saveLevel(data.id, data);
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-level/create' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.name) return sendJSON(res, 400, { error: 'Falta el nombre del nivel' });
      try {
        var created = gravityEditor.createLevel(data.name);
        return sendJSON(res, 200, { ok: true, level: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-assets' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.listAssets());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-asset' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.key || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos del sprite a subir' });
      }
      try {
        var savedUrl = gravityEditor.saveAsset(data.key, data.dataBase64);
        return sendJSON(res, 200, { ok: true, url: savedUrl });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-variant-counts' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.getVariantCounts());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-asset/add-variant' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.base || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Faltan datos de la variante nueva' });
      }
      try {
        var created = gravityEditor.addVariant(data.base, data.dataBase64);
        return sendJSON(res, 200, { ok: true, variant: created });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
  }
  if (urlPath === '/api/gravity-backgrounds' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, gravityEditor.listBackgrounds());
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }
  if (urlPath === '/api/gravity-background' && req.method === 'POST') {
    return readBody(req, function (err, data) {
      if (err || !data || !data.dataBase64) {
        return sendJSON(res, 400, { error: 'Falta la imagen del fondo' });
      }
      try {
        var file = gravityEditor.addBackground(data.dataBase64, data.ext);
        return sendJSON(res, 200, { ok: true, file: file });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    });
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
