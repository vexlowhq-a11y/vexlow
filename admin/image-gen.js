/*
  Imagen destacada generada por IA — usado por admin/auto-publish.js
  =====================================================================
  Le pide a la API de imágenes de OpenAI (gpt-image-1.5, calidad "low"
  por defecto — ver admin/config.json "imageGeneration") una portada
  para el artículo, a partir del título. Se guarda en img/temas/<slug>.jpg.
  Si falla por cualquier motivo (sin crédito, error de red, etc.) devuelve
  null — el artículo se publica igual, sin imagen (usa el ícono de la
  categoría, como cualquier artículo sin imagen puesta a mano).

  Solo aplica a artículos NUEVOS publicados por el bot de acá en
  más — no reprocesa artículos viejos.
*/

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IMG_TEMAS_DIR = path.join(ROOT, 'img', 'temas');

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// Esta cuenta de OpenAI tiene un límite bajo de imágenes por minuto
// (visto en la práctica: 5/min) — generar varias seguidas (backfill,
// o una corrida con varios artículos nuevos) choca con eso enseguida.
// Reintenta con espera cuando la API devuelve 429, en vez de
// simplemente fallar.
async function callOpenAIImageWithRetry(apiKey, model, quality, size, prompt) {
  var MAX_ATTEMPTS = 5;
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOpenAIImage(apiKey, model, quality, size, prompt);
    } catch (e) {
      if (e.statusCode !== 429 || attempt === MAX_ATTEMPTS) throw e;
      var match = /try again in ([\d.]+)s/i.exec(e.message);
      var waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 2000 : 15000;
      await sleep(waitMs);
    }
  }
}

function callOpenAIImage(apiKey, model, quality, size, prompt) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify({ model: model, prompt: prompt, size: size, quality: quality, n: 1 });
    var req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + apiKey,
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 120000
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          var err = new Error('OpenAI images API respondió ' + res.statusCode + ': ' + body.slice(0, 300));
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          var parsed = JSON.parse(body);
          var b64 = parsed.data && parsed.data[0] && parsed.data[0].b64_json;
          if (!b64) return reject(new Error('Respuesta sin imagen'));
          resolve(b64);
        } catch (e) {
          reject(new Error('No se pudo leer la respuesta de OpenAI: ' + e.message));
        }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout generando la imagen')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Convierte el PNG que devuelve la API a JPEG comprimido (reusa Python
// + PIL, que ya está probado en este repo para las portadas de los
// juegos — evita sumar una dependencia nueva de Node solo para esto).
function pngToJpeg(pngPath, jpegPath) {
  return new Promise(function (resolve, reject) {
    var code = [
      'from PIL import Image',
      "im = Image.open(r'" + pngPath + "').convert('RGB')",
      "im.save(r'" + jpegPath + "', 'JPEG', quality=82, optimize=True)"
    ].join('\n');
    var py = spawn('python', ['-c', code]);
    var err = '';
    py.stderr.on('data', function (d) { err += d.toString('utf8'); });
    py.on('error', reject);
    py.on('close', function (exitCode) {
      if (exitCode !== 0) return reject(new Error('PIL falló convirtiendo a JPEG: ' + err.slice(0, 300)));
      resolve();
    });
  });
}

// article: { title, categoryLabel, topic-related label si hay, slug }
// Devuelve la ruta relativa (ej. "img/temas/mi-articulo.jpg") o null.
async function generateCoverImage(article, cfg, topicLabel) {
  var imgCfg = (cfg && cfg.imageGeneration) || {};
  if (!imgCfg.enabled) return null;
  var apiKey = cfg.openaiApiKey;
  if (!apiKey) return null;

  var subject = topicLabel ? (article.title + ' (' + topicLabel + ')') : article.title;
  var prompt = 'Wide editorial news-article cover image about: ' + subject +
    '. Category: ' + (article.categoryLabel || '') + '. ' +
    'Clean modern illustration / abstract-conceptual style matching a professional tech/news website — think abstract shapes, symbolic icons, generic scenes, or stylized objects representing the concept. ' +
    'CRITICAL: never depict the face or likeness of any real, named, identifiable person (public figures, executives, celebrities, politicians, athletes, etc.) — do not draw a realistic or recognizable portrait of anyone real. If the story centers on a specific named person or organization, represent it symbolically instead (e.g. a generic silhouette from behind/far away, an abstract icon, a relevant object, a stylized building shape) rather than their actual face. ' +
    'CRITICAL — no brand logos of any kind: do not draw, approximate, or hint at the trademarked logo, wordmark, icon, or brand color-and-shape combination of ANY real company (this applies especially to Apple, Google, Microsoft, Meta, Amazon, OpenAI, Nvidia, X/Twitter, and any other named tech/business brand in the subject) — even a stylized, simplified, or "inspired by" version of a real logo is not allowed. Represent companies only through fully generic, unbranded imagery: plain geometric shapes, generic unmarked devices/buildings/products, or neutral icons that could not be mistaken for any specific real company\'s mark. ' +
    'No fake UI elements: do not draw play buttons, download icons, arrows, or any element styled to look like a clickable button or interface control — this includes any circle or rounded-square containing a triangular "play" symbol, anywhere in the image, even as a small background decoration. ' +
    'No spiral, pinwheel, or swirl-shaped icons (a ring or bubble containing a curved spiral pattern) — this specific shape reads as an AI-assistant company logo even when abstract; represent "AI" or "chat" concepts instead with a plain speech bubble, a generic chip/circuit icon, or the letters "AI" only. ' +
    'CRITICAL — no copyrighted fictional characters: if the subject mentions a movie, comic, game, or franchise character (e.g. any Marvel, DC, Disney, or other studio-owned superhero or character), do not draw that character\'s specific likeness, costume, or design — represent the story generically instead (e.g. a generic film reel, a generic silhouette in a generic costume shape, a movie-ticket icon, a comic-panel-style layout with no specific character drawn). Specifically: never draw a muscular humanoid figure with green skin (this reads unmistakably as the Hulk) and never draw a figure in a red-and-blue full-body suit swinging on a strand/web (this reads unmistakably as Spider-Man) — for these subjects use entirely non-humanoid imagery instead (comic panels, a themed color palette, a generic mask or emblem shape with no figure attached). ' +
    'No readable text, no words, no letters, no logos, no watermarks, no captions anywhere in the image.';

  fs.mkdirSync(IMG_TEMAS_DIR, { recursive: true });
  var pngPath = path.join(IMG_TEMAS_DIR, article.slug + '.png');
  var jpegPath = path.join(IMG_TEMAS_DIR, article.slug + '.jpg');

  try {
    var b64 = await callOpenAIImageWithRetry(apiKey, imgCfg.model || 'gpt-image-1.5', imgCfg.quality || 'low', imgCfg.size || '1536x1024', prompt);
    fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
    await pngToJpeg(pngPath, jpegPath);
    fs.unlinkSync(pngPath);
    return 'img/temas/' + article.slug + '.jpg';
  } catch (e) {
    try { if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath); } catch (e2) {}
    throw e;
  }
}

module.exports = {
  generateCoverImage: generateCoverImage,
  callOpenAIImageWithRetry: callOpenAIImageWithRetry,
  pngToJpeg: pngToJpeg
};
