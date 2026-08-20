/*
  Carrusel automático para Instagram — usado por admin/server.js
  =================================================================
  Genera las imágenes de un carrusel (para los días "carousel" del
  sprint de vexlowhq/data/sprint-plan.json): UNA sola imagen de fondo
  generada por IA (mismo estilo abstracto/sin texto que las portadas
  de artículos, vía admin/image-gen.js) reutilizada en todas las
  diapositivas, con el texto de cada una superpuesto encima con
  Python + PIL — así el carrusel se ve como un set coherente en vez
  de 5 imágenes sueltas, y no dependemos de que la IA "escriba" bien
  el texto dentro de la imagen (los modelos de imágenes no son
  confiables para eso).

  Reutiliza Python (ya es un requisito de este repo — generate_pages.py
  y la conversión a JPEG de image-gen.js ya lo usan) en vez de sumar
  una librería nueva de Node solo para dibujar texto sobre imágenes.
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const imageGen = require('./image-gen');

const ROOT = path.join(__dirname, '..');
const CAROUSEL_DIR = path.join(ROOT, 'img', 'carousels');
const CANVAS_SIZE = 1024; // OpenAI images admite 1024x1024 (cuadrado, ideal para carrusel de IG)

function backgroundPrompt(dayTitle) {
  return 'Wide abstract editorial background about: ' + dayTitle + '. ' +
    'Clean modern flat illustration, bold geometric shapes, gradient, tech/gaming aesthetic, ' +
    'dark navy and electric blue and orange color palette. Leaves calm open space in the center ' +
    'for text to be legible on top. ' +
    'No readable text, no words, no letters, no logos, no watermarks, no real people, no brand logos.';
}

function runPython(scriptPath, argPath) {
  return new Promise(function (resolve, reject) {
    var py = spawn('python', [scriptPath, argPath]);
    var err = '';
    py.stderr.on('data', function (d) { err += d.toString('utf8'); });
    py.on('error', reject);
    py.on('close', function (code) {
      if (code !== 0) return reject(new Error('Python falló generando las diapositivas: ' + err.slice(0, 500)));
      resolve();
    });
  });
}

var OVERLAY_SCRIPT = [
  'import json, sys, os',
  'from PIL import Image, ImageDraw, ImageFont',
  '',
  'with open(sys.argv[1], "r", encoding="utf-8") as f:',
  '    params = json.load(f)',
  '',
  'bg = Image.open(params["background"]).convert("RGBA")',
  'size = bg.size',
  '',
  'font_paths = [',
  '    r"C:\\Windows\\Fonts\\arialbd.ttf",',
  '    r"C:\\Windows\\Fonts\\seguisb.ttf",',
  '    r"C:\\Windows\\Fonts\\arial.ttf"',
  ']',
  'def load_font(sz):',
  '    for p in font_paths:',
  '        if os.path.exists(p):',
  '            try:',
  '                return ImageFont.truetype(p, sz)',
  '            except Exception:',
  '                pass',
  '    return ImageFont.load_default()',
  '',
  'small_font_paths = [r"C:\\Windows\\Fonts\\arial.ttf", r"C:\\Windows\\Fonts\\segoeui.ttf"]',
  'def load_small_font(sz):',
  '    for p in small_font_paths:',
  '        if os.path.exists(p):',
  '            try:',
  '                return ImageFont.truetype(p, sz)',
  '            except Exception:',
  '                pass',
  '    return ImageFont.load_default()',
  '',
  'label_font = load_small_font(28)',
  '',
  'MAX_FONT_SIZE = 64',
  'MIN_FONT_SIZE = 30',
  'MARGIN = 80',
  'max_line_w = size[0] - 2 * MARGIN',
  '',
  'font_cache = {}',
  'def font_for(sz):',
  '    if sz not in font_cache:',
  '        font_cache[sz] = load_font(sz)',
  '    return font_cache[sz]',
  '',
  '# Encuentra el tamaño de fuente mas grande (entre MIN y MAX) con el',
  '# que TODAS las lineas de esta diapositiva entran dentro del ancho',
  '# util del canvas -- evita que una linea larga se corte contra los',
  '# bordes de la imagen (bug real: antes el tamano era fijo en 64px y',
  '# nunca se achicaba, asi que lineas largas quedaban centradas',
  '# alrededor de un ancho mayor al canvas y se salian por los dos lados).',
  'def fit_font_size(draw, lines):',
  '    for sz in range(MAX_FONT_SIZE, MIN_FONT_SIZE - 1, -2):',
  '        f = font_for(sz)',
  '        widths = [draw.textbbox((0, 0), line, font=f)[2] for line in lines]',
  '        if max(widths) <= max_line_w:',
  '            return sz',
  '    return MIN_FONT_SIZE',
  '',
  'for i, slide in enumerate(params["slides"]):',
  '    img = bg.copy()',
  '    overlay = Image.new("RGBA", size, (8, 12, 20, 150))',
  '    img = Image.alpha_composite(img, overlay)',
  '    draw = ImageDraw.Draw(img)',
  '',
  '    lines = slide["text"].split("\\n")',
  '    title_font = font_for(fit_font_size(draw, lines))',
  '    line_heights = []',
  '    for line in lines:',
  '        bbox = draw.textbbox((0, 0), line, font=title_font)',
  '        line_heights.append(bbox[3] - bbox[1])',
  '',
  '    line_gap = 18',
  '    total_h = sum(line_heights) + line_gap * (len(lines) - 1)',
  '    y = (size[1] - total_h) / 2',
  '    for idx, line in enumerate(lines):',
  '        bbox = draw.textbbox((0, 0), line, font=title_font)',
  '        w = bbox[2] - bbox[0]',
  '        x = (size[0] - w) / 2',
  '        draw.text((x + 3, y + 3), line, font=title_font, fill=(0, 0, 0, 140))',
  '        draw.text((x, y), line, font=title_font, fill=(255, 255, 255, 255))',
  '        y += line_heights[idx] + line_gap',
  '',
  '    label = str(i + 1) + "/" + str(len(params["slides"]))',
  '    draw.text((36, size[1] - 60), label, font=label_font, fill=(255, 176, 32, 255))',
  '    draw.text((size[0] - 150, size[1] - 60), "vexlow", font=label_font, fill=(255, 255, 255, 200))',
  '',
  '    out = img.convert("RGB")',
  '    out.save(slide["outPath"], "JPEG", quality=88, optimize=True)',
  '',
  'print("ok")'
].join('\n');

// dayPlan: entrada de data/sprint-plan.json con format "carousel"
// (day, title, slides: [{ text, slideText }]).
// Devuelve un array de rutas relativas ("img/carousels/day-3/slide-1.jpg", ...).
async function generateCarouselImages(dayPlan, cfg) {
  var apiKey = cfg && cfg.openaiApiKey;
  if (!apiKey) throw new Error('Falta la clave de OpenAI (admin/config.json) para generar imágenes.');
  var imgCfg = (cfg && cfg.imageGeneration) || {};

  var dayDir = path.join(CAROUSEL_DIR, 'day-' + dayPlan.day);
  fs.mkdirSync(dayDir, { recursive: true });

  var bgPngPath = path.join(dayDir, 'background.png');
  var b64 = await imageGen.callOpenAIImageWithRetry(
    apiKey,
    imgCfg.model || 'gpt-image-1.5',
    imgCfg.quality || 'low',
    (CANVAS_SIZE + 'x' + CANVAS_SIZE),
    backgroundPrompt(dayPlan.title)
  );
  fs.writeFileSync(bgPngPath, Buffer.from(b64, 'base64'));

  var slides = dayPlan.slides.map(function (slide, i) {
    return {
      text: slide.slideText || slide.text,
      outPath: path.join(dayDir, 'slide-' + (i + 1) + '.jpg')
    };
  });

  var scriptPath = path.join(os.tmpdir(), 'vexlow-carousel-overlay-' + Date.now() + '.py');
  var paramsPath = path.join(os.tmpdir(), 'vexlow-carousel-params-' + Date.now() + '.json');
  fs.writeFileSync(scriptPath, OVERLAY_SCRIPT, 'utf8');
  fs.writeFileSync(paramsPath, JSON.stringify({ background: bgPngPath, slides: slides }), 'utf8');

  try {
    await runPython(scriptPath, paramsPath);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
    try { fs.unlinkSync(paramsPath); } catch (e) {}
  }

  return slides.map(function (slide, i) {
    return 'img/carousels/day-' + dayPlan.day + '/slide-' + (i + 1) + '.jpg';
  });
}

module.exports = { generateCarouselImages: generateCarouselImages };
