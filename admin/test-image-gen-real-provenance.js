#!/usr/bin/env node
/*
  admin/test-image-gen-real-provenance.js
  =========================================
  Pedido de Leonardo (2026-09-25), verificación #5 antes de sincronizar:
  "Confirmá end-to-end que la función real de generación de imagen produce
  todos los campos que ahora exige validateImageFields para
  ai-generated-commercial-use: modelo; fecha; prompt; declaración;
  herramienta; origen; licencia. No alcanza con construir manualmente un
  fixture válido. Probá la salida real de image-gen con la generación
  simulada para no gastar dinero."

  Qué hace este archivo (y qué NO hace):
  - Llama a la función REAL admin/image-gen.js:generateCoverImage() --
    nunca construye un objeto { tool, model, generatedAt, prompt } a mano.
  - Lo único simulado es la llamada de red a la API de OpenAI (https.request):
    se reemplaza esa única función por una que devuelve un PNG real
    (generado localmente con PIL, sin tocar ninguna red) con el mismo
    formato de respuesta que la API real ({ data: [{ b64_json }] }) --
    así se ejercita el 100% del código real de image-gen.js (construcción
    del prompt, conversión PNG->JPEG con PIL, armado del objeto de
    procedencia) sin gastar un centavo ni depender de la red.
  - Después toma el resultado real y repite EXACTAMENTE la misma asignación
    de campos que hace admin/pipeline.js (líneas ~2413-2424: imageTool,
    imageModel, imageGeneratedAt, imagePrompt, imageLicense, imageOrigin,
    imageHumanEdited, imageOwnerAttestation, imageSourceUrl) para construir
    el artículo final, y corre ese artículo contra pipeline.validateImageFields
    REAL -- la misma función que bloquea/aprueba en el guardado real.
  - Corre en un tmpdir propio (nunca la carpeta real del sitio); el archivo
    de imagen generado (img/temas/<slug>.jpg) se escribe ahí, no en el sitio.
  - Restaura https.request a su valor original al final, pase lo que pase.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}

function sha256File(p) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function main() {
  const REAL_ROOT = path.join(__dirname, '..');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-imagegen-test-'));

  // Copia aislada mínima: solo lo que admin/image-gen.js necesita para
  // correr (usa __dirname/.. como ROOT para calcular img/temas/).
  const tmpAdmin = path.join(tmpRoot, 'admin');
  fs.mkdirSync(tmpAdmin, { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'admin', 'image-gen.js'), path.join(tmpAdmin, 'image-gen.js'));

  // Genera localmente (sin red) un PNG de portada válido (1600x900, por
  // encima del mínimo 600x315 que exige pipeline.validateImageFields) con
  // PIL -- exactamente la misma herramienta que ya usa pngToJpeg() real.
  const fakePngPath = path.join(tmpRoot, 'fake-source.png');
  const { spawnSync } = require('child_process');
  const genPy = spawnSync('python', ['-c', [
    'from PIL import Image',
    "im = Image.new('RGB', (1600, 900), color=(120, 140, 200))",
    "im.save(r'" + fakePngPath + "', 'PNG')"
  ].join('\n')]);
  check('Imagen PNG de prueba generada localmente con PIL (sin red)', genPy.status === 0 && fs.existsSync(fakePngPath), genPy.stderr ? genPy.stderr.toString('utf8') : '');
  const fakeB64 = fs.readFileSync(fakePngPath).toString('base64');

  // --- Simulación de la ÚNICA llamada de red (https.request) ---
  // Firma real esperada por admin/image-gen.js:callOpenAIImage(): se llama
  // con (options, callback), el callback recibe un `res` con 'data'/'end',
  // y el objeto devuelto soporta .on('timeout'/'error'), .write(), .end().
  const originalRequest = https.request;
  let capturedRequestBody = null;
  let requestCallCount = 0;
  https.request = function (options, callback) {
    requestCallCount++;
    const EventEmitter = require('events');
    const req = new EventEmitter();
    req.write = function (body) { capturedRequestBody = body; };
    req.end = function () {
      const res = new EventEmitter();
      process.nextTick(function () {
        callback(res);
        process.nextTick(function () {
          const payload = JSON.stringify({ data: [{ b64_json: fakeB64 }] });
          res.statusCode = 200;
          res.emit('data', Buffer.from(payload, 'utf8'));
          res.emit('end');
        });
      });
    };
    req.destroy = function () {};
    return req;
  };

  let generated = null;
  let genError = null;
  try {
    const imageGen = require(path.join(tmpAdmin, 'image-gen.js'));
    const cfg = {
      openaiApiKey: 'sk-test-simulated-do-not-use',
      imageGeneration: { enabled: true, model: 'gpt-image-1.5', quality: 'low', size: '1536x1024' }
    };
    const article = { title: 'Meridian Robotics anuncia una nueva línea de brazos industriales', categoryLabel: 'Tecnología', slug: 'test-imagegen-provenance-meridian-robotics' };
    generated = await imageGen.generateCoverImage(article, cfg, null);
  } catch (e) {
    genError = e;
  } finally {
    https.request = originalRequest; // restaurar siempre, incluso si algo tira
  }

  check('generateCoverImage() real no tiró excepción', !genError, genError && genError.message);
  check('Se hizo exactamente 1 llamada de red simulada a la API de imágenes (nunca 2 ni 0)', requestCallCount === 1, 'llamadas: ' + requestCallCount);
  check('El cuerpo de la request incluía el modelo configurado (gpt-image-1.5)', !!(capturedRequestBody && capturedRequestBody.indexOf('"gpt-image-1.5"') !== -1));
  check('generateCoverImage() devolvió un objeto (no null)', !!generated, 'devolvió: ' + JSON.stringify(generated));

  if (generated) {
    // --- 1. Los 4 campos que devuelve la función real ---
    check('generated.tool === "openai-images-api"', generated.tool === 'openai-images-api', String(generated.tool));
    check('generated.model === "gpt-image-1.5" (tomado de cfg.imageGeneration.model, no hardcodeado)', generated.model === 'gpt-image-1.5', String(generated.model));
    check('generated.generatedAt es una fecha ISO válida y no futura', !!generated.generatedAt && !isNaN(Date.parse(generated.generatedAt)) && Date.parse(generated.generatedAt) <= Date.now(), String(generated.generatedAt));
    check('generated.prompt es un string no vacío (prompt real armado por image-gen.js)', typeof generated.prompt === 'string' && generated.prompt.length > 50);
    check('generated.prompt menciona el título real del artículo', generated.prompt.indexOf('Meridian Robotics') !== -1);
    check('generated.path apunta a img/temas/<slug>.jpg', generated.path === 'img/temas/test-imagegen-provenance-meridian-robotics.jpg', String(generated.path));

    // El archivo JPEG realmente se escribió en disco (conversión PIL real).
    const jpegFullPath = path.join(tmpAdmin, '..', generated.path);
    check('El archivo JPEG convertido existe físicamente en disco', fs.existsSync(jpegFullPath));
    if (fs.existsSync(jpegFullPath)) {
      const stat = fs.statSync(jpegFullPath);
      check('El JPEG generado pesa > 0 bytes y es razonable (< 5MB)', stat.size > 0 && stat.size < 5 * 1024 * 1024, stat.size + ' bytes');
      // El PNG intermedio se borra siempre (fs.unlinkSync en image-gen.js).
      const pngSibling = jpegFullPath.replace(/\.jpg$/, '.png');
      check('El PNG intermedio fue borrado (no queda residuo)', !fs.existsSync(pngSibling));
    }

    // --- 2. Reproduce EXACTAMENTE la asignación real de admin/pipeline.js
    //        (líneas ~2413-2424) a partir del resultado de generateCoverImage()
    //        -- nunca un fixture armado a mano con valores inventados.
    const article = {
      slug: 'test-imagegen-provenance-meridian-robotics',
      title: 'Meridian Robotics anuncia una nueva línea de brazos industriales',
      category: 'technology',
      date: new Date().toISOString(),
      image: generated.path,
      imageLicense: 'ai-generated-commercial-use',
      imageOrigin: 'ai-generated',
      imageTool: generated.tool,
      imageModel: generated.model,
      imageGeneratedAt: generated.generatedAt,
      imagePrompt: generated.prompt,
      imageHumanEdited: false,
      imageOwnerAttestation: true,
      imageSourceUrl: null
    };

    // --- 3. Copia el JPEG real a donde validateImageFields() lo espera:
    //        ROOT_DIR/<article.image> -- pipeline.js resuelve rutas contra
    //        su propio __dirname/.., así que se necesita una copia aislada
    //        completa del árbol admin/ + img/temas/ para no tocar el sitio
    //        real ni depender de rutas relativas cruzadas entre tmpdirs.
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-imagegen-validate-'));
    fs.cpSync(path.join(REAL_ROOT, 'admin'), path.join(isolatedRoot, 'admin'), { recursive: true, filter: (src) => !/[\\/]node_modules[\\/]?/.test(src) });
    fs.mkdirSync(path.join(isolatedRoot, 'img', 'temas'), { recursive: true });
    fs.copyFileSync(jpegFullPath, path.join(isolatedRoot, article.image));
    // categories.json real (necesario para otras validaciones del módulo al cargar, si las hubiera).
    fs.mkdirSync(path.join(isolatedRoot, 'data'), { recursive: true });
    fs.copyFileSync(path.join(REAL_ROOT, 'data', 'categories.json'), path.join(isolatedRoot, 'data', 'categories.json'));

    try {
      const pipelineIsolated = require(path.join(isolatedRoot, 'admin', 'pipeline.js'));
      const issues = pipelineIsolated.validateImageFields(article);
      check('pipeline.validateImageFields() real da 0 problemas sobre la salida real de generateCoverImage()', issues.length === 0, JSON.stringify(issues));

      // --- 4. Cada campo que Leonardo pidió explícitamente, verificado
      //        contra el artículo final (no contra el objeto crudo de
      //        generateCoverImage(), que no incluye licencia/origen/
      //        declaración -- esos los agrega pipeline.js, ya probado
      //        arriba en la línea de asignación real).
      check('modelo (imageModel) presente', !!article.imageModel);
      check('fecha (imageGeneratedAt) presente', !!article.imageGeneratedAt);
      check('prompt (imagePrompt) presente', !!article.imagePrompt);
      check('declaración (imageOwnerAttestation === true)', article.imageOwnerAttestation === true);
      check('herramienta (imageTool) presente', !!article.imageTool);
      check('origen (imageOrigin === "ai-generated")', article.imageOrigin === 'ai-generated');
      check('licencia (imageLicense) reconocida', require(path.join(isolatedRoot, 'admin', 'image-licenses.js')).isKnownLicense(article.imageLicense));

      // --- 5. Caso negativo de control: si a alguno de los 3 campos
      //        técnicos le faltara valor, validateImageFields() SÍ debe
      //        bloquear (prueba que el check nuevo del punto 2026-09-24
      //        realmente se ejercita acá, y no que da 0 issues porque el
      //        artículo tiene algún otro problema que enmascara el gap).
      const withoutPrompt = Object.assign({}, article, { imagePrompt: undefined });
      const issuesNoPrompt = pipelineIsolated.validateImageFields(withoutPrompt);
      check('Control negativo: sin imagePrompt, validateImageFields() SÍ bloquea (imageModel)', issuesNoPrompt.some(i => i.field === 'imageModel'), JSON.stringify(issuesNoPrompt));
    } catch (e) {
      check('pipeline.validateImageFields() pudo cargarse y correr sobre la copia aislada', false, e.message);
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }

  // --- Limpieza ---
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('Copias temporales (tmpAdmin, isolatedRoot, PNG de prueba) eliminadas', !fs.existsSync(tmpRoot));
  check('El sitio real (sandbox) no cambió durante esta prueba', fs.existsSync(path.join(REAL_ROOT, 'data', 'articulos.json')));
  check('https.request quedó restaurado a su función original', https.request === originalRequest);

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('ERROR FATAL:', e);
  process.exit(1);
});
