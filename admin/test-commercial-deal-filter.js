#!/usr/bin/env node
/*
  admin/test-commercial-deal-filter.js
  =====================================
  Hallazgo real reportado por Leonardo (2026-09-20): un borrador de IGN
  ("The SteelSeries Arctis Nova Pro Omni Gaming Headset Drops to the
  Lowest Price Ever at Amazon Resale") llegó a la ficha de revisión como
  usable, siendo una oferta comercial temporal de una sola fuente -- sin
  ningún valor editorial duradero (el precio puede cambiar en horas).

  Pedido (12 puntos, ver el informe entregado a Leonardo para el detalle
  completo): detectar ofertas/descuentos/CTAs de compra ANTES de crear o
  usar un borrador, revisando título+resumen+cuerpo+URL+metadatos del
  feed, combinando categorías de señales (nunca una palabra suelta como
  "deal"/"sale", que son normalísimas en el periodismo real -- ver
  "Anthropic's $45 Billion Deal with Nscale"), mostrando el texto exacto
  "Recomendación: descartar — oferta comercial o precio temporal",
  deshabilitando "Usar este borrador" en la UI Y bloqueando con HTTP 422
  un intento directo al servidor, sin bloquear nunca una noticia
  empresarial legítima que solo MENCIONE Amazon/precios/ingresos.

  Diseño verificado acá (ver admin/pipeline.js, detectCommercialDeal +
  classifyDraft): se exige que el texto combine señales de AL MENOS 3 de
  4 categorías independientes (compra/descuento/temporalidad/producto).

  Corre sobre una COPIA AISLADA del sitio completo (nunca el sandbox real
  ni la carpeta del usuario) y, para las partes de DOM/servidor, contra el
  propio admin/server.js real como subproceso -- mismo patrón que
  test-draft-button-disabled-dom.js.

  Pruebas:
    1. detectCommercialDeal/classifyDraft sobre el título REAL de IGN ->
       isCommercialDeal:true, bloqueado, con el texto exacto pedido.
    2. El titular real de Nscale ("$45 Billion Deal") NO se marca (1 sola
       categoría: "deal"/"sale" no alcanzan solos).
    3. Contraejemplos del requisito 8 (ninguno debe bloquearse): reporte
       de resultados de Amazon, lanzamiento informativo de un producto,
       análisis de tendencia de precios sin CTA de compra.
    4. buildCandidates(): un ítem de RSS con oferta comercial NUNCA llega
       a ser candidato (no se gasta una redacción con IA) y se cuenta en
       filteredCounts.commercialDeal.
    5. DOM real: la tarjeta del borrador de IGN tiene "Usar este
       borrador" deshabilitado, con el texto de recomendación exacto: la
       tarjeta de un borrador de control (estilo Nscale) sigue habilitada.
    6. El servidor rechaza (422) un intento directo de publicar el mismo
       contenido comercial sin pasar por el botón.
    7. Requisito 9 (procedencia): para el borrador real de IGN,
       sourceTitle es el NOMBRE DEL MEDIO ("IGN"), no el titular --
       sourceHeadline conserva el titular original completo.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

const REAL_ROOT = path.join(__dirname, '..');
const integrity = require('./articulos-integrity-check');
const REAL_ARTICULOS_PATH = path.join(REAL_ROOT, 'data', 'articulos.json');
const realArticulosBeforeSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-commercial-deal-test-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

// ---- El borrador REAL reportado por Leonardo (texto real del feed) ----
const IGN_REAL_HEADLINE = 'The SteelSeries Arctis Nova Pro Omni Gaming Headset Drops to the Lowest Price Ever at Amazon Resale';
const IGN_DRAFT = {
  title: 'SteelSeries Arctis Nova Pro Omni Gaming Headset Hits Its Lowest Price Ever',
  category: 'gaming', categoryLabel: 'Gaming', icon: '🎮', date: '2026-09-20',
  slug: 'steelseries-arctis-nova-pro-omni-lowest-price-ever-amazon',
  dek: 'The premium wireless gaming headset just hit its lowest price ever at Amazon Resale.',
  image: 'img/temas/tsmc-expands-investment-us-chip-plants.jpg', imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
  body: 'The SteelSeries Arctis Nova Pro Omni is now available at its lowest price ever through Amazon Resale, a limited-time deal on this popular gaming headset.\n\nShoppers looking to buy now can grab this deal before it is gone.',
  sourceUrl: 'https://www.ign.com/articles/steelseries-arctis-nova-pro-omni-lowest-price-amazon-resale',
  sourceTitle: 'IGN',
  sourceHeadline: IGN_REAL_HEADLINE,
  sourceDomain: 'ign.com',
  similarityWarning: false, similarityScore: 0, genericHeadingWarning: false, sourceCount: 1,
  createdAt: new Date().toISOString()
};
// ---- Control: mismo ESTILO que el titular real de Nscale ("$X Deal con
// Y") -- una noticia empresarial legítima que menciona "deal"/precios
// pero NUNCA debe bloquearse (requisito 6). A propósito NO se usa el
// titular real de Nscale acá (eso ya se prueba arriba, unitariamente, sin
// pasar por el servidor) -- el sandbox de pruebas YA tiene un artículo
// real y publicado sobre Nscale con un título casi idéntico, así que
// usar ese mismo titular en un borrador de control haría que
// classifyDraft lo marque como DUPLICADO real (correcto, pero mide otra
// cosa distinta de lo que esta sección quiere aislar: que "deal" solo
// nunca alcanza el umbral de oferta comercial).
const CONTROL_DEAL_DRAFT = {
  title: 'Meridian Robotics Signs $12 Million Deal With City Transit Authority',
  category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-20',
  slug: 'meridian-robotics-signs-12-million-deal-transit-authority',
  dek: 'The multi-year agreement will supply autonomous maintenance robots to the transit system.',
  image: 'img/temas/tsmc-expands-investment-us-chip-plants.jpg', imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
  body: 'Meridian Robotics announced a $12 million deal with the city transit authority Thursday to supply autonomous maintenance robots for its rail fleet, the companies said. The agreement reflects growing demand for automation across public transit systems.',
  sourceUrl: 'https://techcrunch.com/2026/09/meridian-robotics-transit-deal-control',
  sourceTitle: 'TechCrunch',
  sourceHeadline: 'Meridian Robotics Signs $12 Million Deal With City Transit Authority',
  sourceDomain: 'techcrunch.com',
  similarityWarning: false, similarityScore: 0, genericHeadingWarning: false, sourceCount: 1,
  createdAt: new Date().toISOString()
};
fs.writeFileSync(path.join(dataDir, 'drafts.json'), JSON.stringify([IGN_DRAFT, CONTROL_DEAL_DRAFT], null, 2));

const PORT = 4330; // puerto propio, distinto del resto de las suites (4321-4329)
{
  const serverPath = path.join(adminDir, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');
  src = src.replace('const PORT = 4321;', 'const PORT = ' + PORT + ';');
  fs.writeFileSync(serverPath, src);
}

const child = spawn(process.execPath, [path.join(adminDir, 'server.js')], { cwd: tmpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
child.stdout.on('data', function (d) { serverOutput += d.toString(); });
child.stderr.on('data', function (d) { serverOutput += d.toString(); });

function waitForServer(url, tries) {
  tries = tries || 60;
  return fetch(url).then(function () { return true; }).catch(function (e) {
    if (tries <= 0) throw e;
    return new Promise(function (r) { setTimeout(r, 150); }).then(function () { return waitForServer(url, tries - 1); });
  });
}

async function main() {
  // ==========================================================================
  // PARTE 1 -- pipeline.detectCommercialDeal / classifyDraft (sin red, sin DOM)
  // ==========================================================================
  const pipeline = require(path.join(adminDir, 'pipeline.js'));

  var ignCheck = pipeline.detectCommercialDeal(
    [IGN_DRAFT.title, IGN_DRAFT.sourceHeadline, IGN_DRAFT.dek, IGN_DRAFT.body].join(' . '),
    IGN_DRAFT.sourceUrl
  );
  check('1. IGN real: detectCommercialDeal combina >= 3 categorías (compra+descuento+producto)',
    ignCheck.isCommercialDeal === true && ignCheck.categoriesMatched.length >= 3, JSON.stringify(ignCheck));

  var ignClassified = pipeline.classifyDraft(IGN_DRAFT);
  check('1. IGN real: classifyDraft marca commercialDeal:true', ignClassified.commercialDeal === true);
  check('1. IGN real: recommendation es "descartar"', ignClassified.recommendation === 'descartar', ignClassified.recommendation);
  check('1. IGN real: eligibleToUse es false (bloqueo mecánico real)', ignClassified.eligibleToUse === false);
  check('1. IGN real: readinessTier es "descartar"', ignClassified.readinessTier === 'descartar', ignClassified.readinessTier);
  var ignUiText = '⛔ Recomendación: descartar — ' + ignClassified.reasons.join(' ');
  check('1. IGN real: el texto armado por admin.js contiene EXACTAMENTE "Recomendación: descartar — oferta comercial o precio temporal"',
    ignUiText.indexOf('Recomendación: descartar — oferta comercial o precio temporal') !== -1, ignUiText);

  // Titular REAL de Nscale (texto literal, sin pasar por classifyDraft con
  // allArticles -- eso mediría duplicado, no detección de oferta comercial).
  var NSCALE_REAL_HEADLINE = "Anthropic's $45 Billion Deal with Nscale Signals Growing Demand for AI Infrastructure";
  var nscaleCheck = pipeline.detectCommercialDeal(
    NSCALE_REAL_HEADLINE + ' . The recent agreement between Anthropic and Nscale highlights the rapidly increasing requirements for computational power in the AI industry.',
    'https://techcrunch.com/2026/09/anthropic-nscale-deal'
  );
  check('2. Nscale real ("$45 Billion Deal"): NO se marca como oferta comercial (solo 1 categoría: descuento)',
    nscaleCheck.isCommercialDeal === false, JSON.stringify(nscaleCheck));

  // Control (estilo Nscale, ver nota arriba): tampoco debe bloquearse.
  var controlCheck = pipeline.detectCommercialDeal(
    [CONTROL_DEAL_DRAFT.title, CONTROL_DEAL_DRAFT.sourceHeadline, CONTROL_DEAL_DRAFT.dek, CONTROL_DEAL_DRAFT.body].join(' . '),
    CONTROL_DEAL_DRAFT.sourceUrl
  );
  check('2. Control (estilo Nscale, "Deal" solo): NO se marca como oferta comercial', controlCheck.isCommercialDeal === false, JSON.stringify(controlCheck));
  var controlClassified = pipeline.classifyDraft(Object.assign({}, CONTROL_DEAL_DRAFT, { additionalSources: [{ url: 'https://www.reuters.com/tech/meridian-transit', label: 'Reuters' }] }));
  check('2. Control: classifyDraft NO lo bloquea (commercialDeal:false, eligibleToUse:true, recommendation:"crear")',
    controlClassified.commercialDeal === false && controlClassified.eligibleToUse === true && controlClassified.recommendation === 'crear',
    JSON.stringify(controlClassified));

  // Requisito 8: contraejemplos que NUNCA deben bloquearse.
  var counterexamples = [
    {
      label: 'Reporte de resultados de Amazon (ingresos/nube, sin CTA de compra)',
      text: 'Amazon reports third-quarter revenue of $180 billion, beating Wall Street estimates on strong cloud sales growth.',
      url: 'https://www.reuters.com/business/amazon-q3-earnings-2026'
    },
    {
      label: 'Lanzamiento informativo de un producto (sin descuento/urgencia)',
      text: 'Apple unveils the new MacBook Pro with the M5 chip, promising faster performance for creative professionals.',
      url: 'https://www.theverge.com/2026/apple-macbook-pro-m5-launch'
    },
    {
      label: 'Análisis de tendencia de precios de mercado, sin CTA de compra',
      text: 'Graphics card prices have fallen steadily this year as manufacturers ramp up production, analysts say.',
      url: 'https://arstechnica.com/gadgets/2026/gpu-price-trend-analysis'
    }
  ];
  counterexamples.forEach(function (ex) {
    var r = pipeline.detectCommercialDeal(ex.text, ex.url);
    check('3. Contraejemplo (' + ex.label + '): NO se marca como oferta comercial', r.isCommercialDeal === false, JSON.stringify(r));
  });

  // ==========================================================================
  // PARTE 2 -- buildCandidates(): el ítem comercial nunca llega a candidato
  // ==========================================================================
  const feeds = require(path.join(adminDir, 'feeds.js'));
  const originalFetchAllFeedItems = feeds.fetchAllFeedItems;
  const originalCheckUrlReachable = pipeline.checkUrlReachable;
  pipeline.checkUrlReachable = function () { return Promise.resolve({ reachable: true }); };
  // Corroboración previa a la redacción (2026-09-20): buildCandidates()
  // ahora intenta Google News RSS para cualquier candidato sin corroboración
  // de los demás feeds -- se simula "sin red" para que este test no dependa
  // de la red pública real (este sandbox no tiene salida a internet) ni se
  // vuelva lento/flaky por un timeout real.
  const originalFetchGoogleNewsRss = pipeline.fetchGoogleNewsRss;
  pipeline.fetchGoogleNewsRss = function () { return Promise.reject(new Error('sin red en el test')); };
  const NOW = new Date();
  function isoDaysAgo(days) { return new Date(NOW.getTime() - days * 86400000).toISOString(); }
  feeds.fetchAllFeedItems = function () {
    return Promise.resolve({
      items: [
        {
          category: 'gaming', title: IGN_REAL_HEADLINE,
          summary: 'The premium wireless gaming headset just hit its lowest price ever at Amazon Resale, a limited-time deal.',
          link: 'https://www.ign.com/articles/steelseries-nova-pro-omni-lowest-price-bc', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
          image: '', author: '', domain: 'ign.com', outlet: 'IGN'
        },
        // Historia distinta de CONTROL_DEAL_DRAFT a propósito: ese borrador
        // ya está en drafts.json (para la sección de DOM más abajo) y
        // buildCandidates() descarta cualquier ítem que se parezca demasiado
        // a un borrador/artículo ya conocido (isSameStoryAsKnown) -- usar el
        // mismo texto acá mediría esa deduplicación, no la de oferta
        // comercial, que es lo que esta parte quiere aislar.
        {
          category: 'business', title: 'Regional Airline Signs Fleet Maintenance Deal With Parts Supplier',
          summary: 'The regional airline announced a multi-year deal with a parts supplier to service its aircraft fleet.',
          link: 'https://techcrunch.com/2026/09/regional-airline-fleet-maintenance-deal-bc', pubDate: isoDaysAgo(0), pubDateISO: isoDaysAgo(0),
          image: '', author: '', domain: 'techcrunch.com', outlet: 'TechCrunch'
        }
      ],
      errors: []
    });
  };
  const built = await pipeline.buildCandidates();
  check('4. buildCandidates: el ítem de IGN (oferta comercial real) NUNCA llega a ser candidato',
    !built.candidates.some(function (c) { return c.domain === 'ign.com'; }));
  check('4. buildCandidates: se cuenta en filteredCounts.commercialDeal', built.filteredCounts.commercialDeal === 1, JSON.stringify(built.filteredCounts));
  check('4. buildCandidates: el ítem legítimo ("deal" solo, sin combinar categorías) SÍ llega a ser candidato',
    built.candidates.some(function (c) { return c.domain === 'techcrunch.com'; }));
  feeds.fetchAllFeedItems = originalFetchAllFeedItems;
  pipeline.checkUrlReachable = originalCheckUrlReachable;
  pipeline.fetchGoogleNewsRss = originalFetchGoogleNewsRss;

  // ==========================================================================
  // PARTE 3 -- DOM real: tarjeta deshabilitada + ficha de procedencia (IGN)
  // ==========================================================================
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');

  const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (win) {
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = function (url, opts) {
        var abs = new URL(url, win.location.href).toString();
        // Cualquier fetch a un origin externo real (ej. loadReactions() a
        // vexlowhq.com) se rechaza YA (ya está atrapado en un .catch() en
        // admin.js) en vez de dejar que golpee la red real -- evita que esa
        // promesa resuelva/rechace en un momento impredecible (a veces
        // DESPUÉS de window.close() más abajo, lo que revienta el proceso
        // con un TypeError al tocar un `document` ya destruido).
        if (abs.indexOf('http://127.0.0.1:' + PORT) !== 0) {
          return Promise.reject(new Error('red externa bloqueada en esta prueba'));
        }
        return fetch(abs, opts);
      };
    }
  });
  const { window } = dom;
  window.addEventListener('error', function () {});
  const doc = window.document;

  // Ojo: ".admin-item" también lo usa la lista de artículos reales (141),
  // así que un simple "hay >= 2 admin-item" puede quedar satisfecho apenas
  // esa lista renderiza, ANTES de que terminen de cargar los borradores --
  // se espera explícitamente a que las DOS tarjetas de borrador esperadas
  // (por título) estén presentes.
  function rowForTitle(titleFrag) {
    var items = Array.from(doc.querySelectorAll('.admin-item'));
    return items.find(function (row) {
      var ttl = row.querySelector('.ttl');
      return ttl && ttl.textContent.indexOf(titleFrag) !== -1;
    });
  }
  var loaded = false;
  for (var i = 0; i < 60; i++) {
    await sleep(200);
    if (rowForTitle('SteelSeries Arctis Nova Pro Omni Gaming Headset Hits Its Lowest Price Ever') &&
        rowForTitle('Meridian Robotics Signs $12 Million Deal With City Transit Authority')) { loaded = true; break; }
  }
  check('5. Setup: el panel real terminó de cargar (renderDraftsList corrió, ambas tarjetas presentes)', loaded, 'admin-item=' + doc.querySelectorAll('.admin-item').length);
  if (!loaded) throw new Error('El panel no inicializó a tiempo: ' + serverOutput.slice(-2000));

  var ignRow = rowForTitle('SteelSeries Arctis Nova Pro Omni Gaming Headset Hits Its Lowest Price Ever');
  check('5. Se encontró la tarjeta del borrador real de IGN', !!ignRow);
  var controlRow = rowForTitle('Meridian Robotics Signs $12 Million Deal With City Transit Authority');
  check('5. Se encontró la tarjeta del borrador de control (legítimo, "deal" solo)', !!controlRow);

  if (ignRow) {
    var ignButtons = Array.from(ignRow.querySelectorAll('button'));
    var ignUseBtn = ignButtons.find(function (b) { return b.textContent.trim() === 'Usar este borrador'; });
    check('5. IGN: "Usar este borrador" tiene el atributo disabled real', ignUseBtn && ignUseBtn.hasAttribute('disabled'), ignUseBtn && ignUseBtn.outerHTML);
    check('5. IGN: aria-disabled="true" presente', ignUseBtn && ignUseBtn.getAttribute('aria-disabled') === 'true');
    var ignRiskText = ignRow.textContent;
    check('5. IGN: la tarjeta muestra el texto de recomendación exacto pedido',
      ignRiskText.indexOf('Recomendación: descartar — oferta comercial o precio temporal') !== -1, ignRiskText);
    // Actualizado (pedido de Leonardo, 2026-09-27, punto 4 -- "claridad de
    // interfaz"): la línea combinada "Descartar — puntaje N/100" se separó
    // en "Puntaje técnico: N/100" + "Estado final: <etiqueta>", para que un
    // puntaje técnico alto nunca lea como si el borrador ya estuviera listo.
    // Misma información, ahora en dos líneas explícitas -- ver admin.js.
    check('5. IGN: la tarjeta muestra el puntaje técnico', /Puntaje técnico:\s*\d+\/100/.test(ignRiskText), ignRiskText);
    check('5. IGN: la tarjeta muestra el estado final "Descartar"', /Estado final:\s*⛔ Descartar/.test(ignRiskText), ignRiskText);
  }
  if (controlRow) {
    var controlButtons = Array.from(controlRow.querySelectorAll('button'));
    var controlUseBtn = controlButtons.find(function (b) { return b.textContent.trim() === 'Usar este borrador'; });
    check('5. Control (legítimo, "deal" solo): "Usar este borrador" SIGUE habilitado (sin atributo disabled)',
      controlUseBtn && !controlUseBtn.hasAttribute('disabled'), controlUseBtn && controlUseBtn.outerHTML);
  }

  // ---- 7. Requisito 9: procedencia -- sourceTitle es el MEDIO, no el
  // titular; sourceHeadline conserva el titular real completo ----
  check('7. sourceTitle del borrador de IGN es el nombre del medio ("IGN"), no el titular', IGN_DRAFT.sourceTitle === 'IGN', IGN_DRAFT.sourceTitle);
  check('7. sourceHeadline conserva el titular ORIGINAL completo', IGN_DRAFT.sourceHeadline === IGN_REAL_HEADLINE, IGN_DRAFT.sourceHeadline);
  check('7. feeds.outletNameFromDomain("ign.com") da "IGN" (mapeo real de medio)', feeds.outletNameFromDomain('ign.com') === 'IGN');
  // La ficha de procedencia (formulario de edición, tras "Usar este
  // borrador") ya muestra sourceTitle + "Título original: " + sourceHeadline
  // en líneas separadas -- mecanismo verificado de punta a punta con otros
  // medios en test-source-provenance.js (PARTE 7); acá se confirma que el
  // borrador real de IGN queda con los datos correctos para que esa ficha
  // los muestre tal cual.

  // Antes de cerrar el DOM: dar tiempo a que terminen otros fetches de
  // init del panel que no son parte de esta prueba (ej. estado de redes
  // sociales) -- sin esto, una de esas promesas puede resolver DESPUÉS de
  // window.close() y tirar abajo el proceso al tocar un `document` ya
  // destruido (renderSocialList). El GET /api/drafts de este panel ahora
  // recalcula clasificación/puntaje para cada borrador contra los 141
  // artículos reales (ver pipeline.classifyDraft con allArticles), así que
  // el init completo puede tardar algo más que antes de esta mejora.
  await sleep(1000);
  window.close();

  // ==========================================================================
  // PARTE 4 -- 422 directo al servidor, sin pasar por el botón
  // ==========================================================================
  {
    var all = JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8'));
    var tmpl = JSON.parse(JSON.stringify(all.find(function (a) { return a.category === 'gaming'; }) || all[0]));
    tmpl.noindex = false; tmpl.noindexReason = ''; delete tmpl.correctionNote;
    tmpl.category = 'gaming';
    tmpl.slug = 'prueba-sintetica-oferta-comercial-rechazo-servidor-20sep';
    tmpl.title = IGN_DRAFT.title + ' (prueba servidor)';
    tmpl.dek = IGN_DRAFT.dek;
    tmpl.date = '2026-09-20';
    tmpl.body = IGN_DRAFT.body + '\n\n## Relleno\n\nTexto adicional solo para superar el mínimo de palabras exigido, sin agregar ningún dato real, para aislar el efecto del filtro de oferta comercial.';
    tmpl.sourceUrl = IGN_DRAFT.sourceUrl;
    tmpl.sourceTitle = IGN_DRAFT.sourceTitle;
    tmpl.sourceHeadline = IGN_DRAFT.sourceHeadline;
    tmpl.status = 'published';
    tmpl.editorialApproval = true; // a propósito, forzado en true
    tmpl.href = 'categoria/' + tmpl.category + '/' + tmpl.slug + '.html';

    var pres = await fetch('http://127.0.0.1:' + PORT + '/api/articles/' + tmpl.category + '/' + tmpl.slug, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tmpl)
    });
    check('6. El servidor rechaza (422) el mismo contenido comercial aunque no pase por el botón', pres.status === 422, 'status=' + pres.status);
    var body422 = await pres.json().catch(function () { return null; });
    check('6. El motivo del 422 menciona la oferta/descuento comercial',
      !!body422 && JSON.stringify(body422).toLowerCase().indexOf('oferta') !== -1, JSON.stringify(body422));
  }

  child.kill();
}

main().catch(function (e) {
  console.error('ERROR durante las pruebas:', e);
  console.error('Salida del servidor de prueba:\n' + serverOutput.slice(-3000));
  fail++;
  try { child.kill(); } catch (e2) {}
}).finally(function () {
  const realArticulosAfterSnapshot = integrity.snapshot(REAL_ARTICULOS_PATH);
  check('8. data/articulos.json del sitio REAL no cambió durante estas pruebas (SHA-256 idéntico)', realArticulosAfterSnapshot.hash === realArticulosBeforeSnapshot.hash);
  const realIntegrityResult = integrity.unchanged(realArticulosBeforeSnapshot, realArticulosAfterSnapshot);
  check('8. El sitio real sigue teniendo exactamente la misma cantidad y el mismo conjunto de artículos (antes: ' + realArticulosBeforeSnapshot.count + ')', realIntegrityResult.ok, realIntegrityResult.detail);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('8. Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
});
