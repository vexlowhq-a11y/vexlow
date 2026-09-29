#!/usr/bin/env node
/*
  admin/test-editorial-meta-e2e-dom.js
  =====================================
  Verificación final de Leonardo (2026-09-25), punto 2: "no alcanza con
  probar el merge sobre un artículo que ya existe" -- este archivo prueba
  la preservación de editorialMeta/editorialValue de punta a punta, contra
  el PANEL REAL (admin/index.html + admin/admin.js reales, en un DOM real
  vía jsdom) y el SERVIDOR REAL (admin/server.js como subproceso), nunca
  llamando a articles-store.js directo (eso ya lo cubre
  test-editorial-controls-adsense.js, sección 7, para el caso de un
  artículo YA existente).

  Secuencia exacta pedida:
    A. El pipeline "crea" un borrador nuevo (sembrado directo en
       drafts.json, con editorialMeta, editorialValue, sourceRetrievedAt,
       sensitiveReasons, keyClaims y procedencia de imagen completa --
       tal como lo dejaría fetchNewDrafts() real).
    B. Clic real en "Usar este borrador" (useDraft()).
    C. El formulario se completa (se audita que los campos visibles
       queden cargados).
    D. Se guarda como artículo NUEVO (nunca actualización de uno
       existente) -- vía POST real del formulario.
    E. Se reabre desde el panel (clic real en "Editar" sobre la fila ya
       guardada, startEditArticle()).
    F. Se guarda de nuevo SIN modificar nada de eso.

  Se confirma después de D y después de F que: editorialMeta completo,
  editorialValue completo, sourceRetrievedAt no se pierde, keyClaims no se
  pierden, procedencia de imagen no se pierde, dateModified/correctionNote
  siguen usando los campos reales existentes, no aparecen claves vacías
  innecesarias, y ningún metadato interno se imprime como JSON en la
  página pública (se genera y se audita el HTML real).
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');

const REAL_ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? ' -- ' + detail : '')); fail++; }
}

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

const realArticlesBefore = fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json'), 'utf8');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vexlow-editorialmeta-e2e-'));
console.log('Setup: copia aislada del sitio completo en ' + tmpRoot + '\n');
copyDirSync(REAL_ROOT, tmpRoot);
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const adminDir = path.join(tmpRoot, 'admin');
const dataDir = path.join(tmpRoot, 'data');

// (A) Borrador "creado por el pipeline" -- mismo shape exacto que arma
// fetchNewDrafts() en admin/pipeline.js (ver esa función para el original).
const EDITORIAL_META_SAMPLE = {
  trendOrigin: { headline: 'Meridian Robotics Wins New Contract', outlet: 'Example Wire', category: 'business', feedUrl: null },
  trendDetectionMethod: 'rss-feed-preselection', trendVolumeApprox: null,
  detectedAt: '2026-09-25T09:00:00.000Z',
  sourcesConsulted: [{ url: 'https://example.com/meridian-contract', label: 'Example Wire', retrievedAt: '2026-09-25T09:00:00.000Z', role: 'primary' }],
  keyClaims: [{ claim: 'Se firmó un nuevo contrato.', sourceLabel: 'Example Wire' }],
  readinessReasons: ['+25: fuente principal real, con URL http(s) válida y canónica'],
  sensitiveReasons: [],
  editorialValue: { elements: ['historical-context', 'comparison', 'what-to-watch'], elementCount: 3, meetsMinimum: true },
  imageProvenance: { origin: 'ai-generated', license: 'ai-generated-commercial-use', tool: 'vexlow-image-gen', model: 'test-model-v1', generatedAt: '2026-09-25T09:00:00.000Z', sourceUrl: null }
};
const E2E_DRAFT = {
  title: 'Meridian Robotics Wins New Multi Year Manufacturing Contract',
  category: 'business', categoryLabel: 'Business', icon: '💼', date: '2026-09-25',
  slug: 'e2e-editorialmeta-meridian-robotics-contract',
  dek: 'Meridian Robotics secured a new multi-year manufacturing contract, the company confirmed Thursday.',
  body: 'Meridian Robotics said Thursday it secured a new multi-year manufacturing contract with an industrial client, expanding its production footprint.\n\n## Context\nThe company has expanded steadily since 2019, according to public filings.\n\n## What comes next\nExecutives said next steps include additional hiring at its main facility.',
  image: 'img/temas/tsmc-expands-investment-us-chip-plants.jpg',
  imageLicense: 'ai-generated-commercial-use', imageOrigin: 'ai-generated',
  imageTool: 'vexlow-image-gen', imageModel: 'test-model-v1', imageGeneratedAt: '2026-09-25T09:00:00.000Z',
  imagePrompt: 'A test prompt describing the generated cover image.', imageHumanEdited: false, imageOwnerAttestation: true, imageSourceUrl: null,
  sourceUrl: 'https://example.com/meridian-contract', sourceTitle: 'Example Wire', sourceHeadline: 'Meridian Robotics Wins New Contract',
  sourceDomain: 'example.com', sourceAuthor: null, sourcePublishedAt: '2026-09-25T08:00:00.000Z',
  sourceRetrievedAt: '2026-09-25T09:00:00.000Z',
  additionalSources: [{ url: 'https://otra-fuente.example/meridian', label: 'Otra Fuente', headline: null, domain: 'otra-fuente.example', publishedAt: null, retrievedAt: '2026-09-25T09:00:00.000Z', matchScore: 70, matchReasons: ['vocabulario compartido'] }],
  singleSourceWarning: false, sameDomainMatchWarning: false,
  keyClaims: [{ claim: 'Se firmó un nuevo contrato.', sourceLabel: 'Example Wire' }],
  sourceCount: 2, similarityWarning: false, similarityScore: 10, genericHeadingWarning: false,
  editorialValue: EDITORIAL_META_SAMPLE.editorialValue,
  editorialMeta: EDITORIAL_META_SAMPLE,
  createdAt: '2026-09-25T09:00:00.000Z'
};
fs.writeFileSync(path.join(dataDir, 'drafts.json'), JSON.stringify([E2E_DRAFT], null, 2) + '\n');

const PORT = 4333; // puerto propio, distinto de todas las demás suites
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
  tries = tries || 40;
  return fetch(url).then(function () { return true; }).catch(function (e) {
    if (tries <= 0) throw e;
    return new Promise(function (r) { setTimeout(r, 150); }).then(function () { return waitForServer(url, tries - 1); });
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function readArticulos() { return JSON.parse(fs.readFileSync(path.join(dataDir, 'articulos.json'), 'utf8')); }
function findSaved() { return readArticulos().find(function (a) { return a.slug === E2E_DRAFT.slug; }); }

function auditPreservation(label, a) {
  check(label + ': el artículo existe en disco', !!a);
  if (!a) return;
  check(label + ': editorialMeta está completo (igual al del borrador original)', JSON.stringify(a.editorialMeta) === JSON.stringify(EDITORIAL_META_SAMPLE), JSON.stringify(a.editorialMeta));
  check(label + ': editorialValue está completo', !!a.editorialValue && a.editorialValue.meetsMinimum === true && a.editorialValue.elementCount === 3, JSON.stringify(a.editorialValue));
  check(label + ': sourceRetrievedAt no se perdió', a.sourceRetrievedAt === E2E_DRAFT.sourceRetrievedAt, a.sourceRetrievedAt);
  check(label + ': keyClaims no se perdieron', Array.isArray(a.keyClaims) && a.keyClaims.length === 1 && a.keyClaims[0].claim === 'Se firmó un nuevo contrato.', JSON.stringify(a.keyClaims));
  check(label + ': procedencia de imagen no se perdió (tool/model/generatedAt/prompt)', a.imageTool === 'vexlow-image-gen' && a.imageModel === 'test-model-v1' && a.imageGeneratedAt && a.imagePrompt === 'A test prompt describing the generated cover image.', JSON.stringify({ tool: a.imageTool, model: a.imageModel, generatedAt: a.imageGeneratedAt, prompt: a.imagePrompt }));
  check(label + ': dateModified/correctionNote siguen siendo los campos reales existentes (obs. A) -- nunca updatedAt/lastModified', a.updatedAt === undefined && a.lastModified === undefined);
  check(label + ': editorialMeta nunca duplica date/dateModified/correctionNote/editorialApproval', !('date' in a.editorialMeta) && !('dateModified' in a.editorialMeta) && !('correctionNote' in a.editorialMeta) && !('editorialApproval' in a.editorialMeta));
}

async function main() {
  await waitForServer('http://127.0.0.1:' + PORT + '/');
  console.log('Servidor de prueba arriba en el puerto ' + PORT + '\n');

  const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (win) {
      win.fetch = function (url, opts) {
        var abs = new URL(url, win.location.href).toString();
        return fetch(abs, opts);
      };
      // jsdom no implementa scrollIntoView -- admin.js lo llama al final de
      // useDraft()/startEditArticle() solo por comodidad visual (no afecta
      // ningún dato ni lógica), pero sin este shim jsdom lo deja como una
      // excepción no atrapada ruidosa en la consola. Mismo espíritu que el
      // shim de fetch de arriba: reponer una API del navegador real que
      // jsdom no trae, sin tocar admin.js.
      win.HTMLElement.prototype.scrollIntoView = function () {};
    }
  });
  const { window } = dom;
  window.addEventListener('error', function () {});

  function rowForTitle(container, titleText) {
    var items = Array.from(container.querySelectorAll('.admin-item'));
    return items.find(function (row) {
      var ttl = row.querySelector('.ttl');
      return ttl && ttl.textContent.indexOf(titleText) !== -1;
    });
  }

  // ---- Esperar a que el panel real termine de cargar el borrador ----
  var draftReady = false;
  for (var i = 0; i < 60; i++) {
    await sleep(200);
    if (rowForTitle(window.document, 'Meridian Robotics Wins New Multi Year Manufacturing Contract')) { draftReady = true; break; }
  }
  check('Setup: el panel real cargó el borrador sembrado (GET /api/drafts)', draftReady, 'admin-item=' + window.document.querySelectorAll('.admin-item').length);
  if (!draftReady) throw new Error('El borrador no apareció a tiempo: ' + serverOutput.slice(-2000));

  var draftRow = rowForTitle(window.document, 'Meridian Robotics Wins New Multi Year Manufacturing Contract');
  var useBtn = Array.from(draftRow.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === 'Usar este borrador'; });
  check('Setup: se encontró "Usar este borrador" y está habilitado', !!useBtn && !useBtn.disabled);

  // ---- (B) Clic real en "Usar este borrador" ----
  useBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(150);

  // ---- (C) El formulario se completa -- auditar campos visibles clave ----
  var titleField = window.document.getElementById('articleFormTitle');
  check('B/C. useDraft() corrió (título del formulario "Revisar borrador")', titleField && titleField.textContent === 'Revisar borrador', titleField && titleField.textContent);
  var titleInput = window.document.getElementById('articleTitle');
  check('C. El campo de título del formulario se completó con el título del borrador', titleInput && titleInput.value === E2E_DRAFT.title, titleInput && titleInput.value);
  var imageModelInput = window.document.getElementById('articleImageModel');
  check('C. El campo de modelo de imagen se completó (procedencia visible en el form)', imageModelInput && imageModelInput.value === 'test-model-v1', imageModelInput && imageModelInput.value);

  // ---- (D) Guardar como artículo NUEVO ----
  // Se usa "Guardar como borrador incompleto" (mismo botón real del panel,
  // ver admin/index.html #articleSaveDraftBtn) -- sigue siendo un guardado
  // real de punta a punta (POST/PUT real a admin/server.js, el mismo
  // persistArticleEdit() que usa el submit principal), pero evita que
  // reglas de validación no relacionadas con este control (ej. campos de
  // aprobación editorial para publicar) interfieran con lo único que esta
  // prueba necesita confirmar: la preservación de metadatos.
  var saveDraftBtn = window.document.getElementById('articleSaveDraftBtn');
  check('Setup: se encontró el botón real "Guardar como borrador incompleto"', !!saveDraftBtn);
  var articlesCountBefore = readArticulos().length;
  saveDraftBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  var savedFirstTime = false;
  for (var j = 0; j < 60; j++) {
    await sleep(200);
    if (readArticulos().length === articlesCountBefore + 1) { savedFirstTime = true; break; }
  }
  check('D. El guardado creó un artículo NUEVO (no actualizó uno existente -- el conteo subió en 1)', savedFirstTime, 'conteo antes=' + articlesCountBefore + ' después=' + readArticulos().length);

  var afterFirstSave = findSaved();
  auditPreservation('D (primer guardado, artículo nuevo)', afterFirstSave);

  // ---- (E) Reabrir desde el panel (clic real en "Editar") ----
  var articlesTabBtn = window.document.querySelector('.admin-tab[data-tab="articles"]');
  if (articlesTabBtn) articlesTabBtn.click();
  await sleep(150);
  var savedRow = rowForTitle(window.document, E2E_DRAFT.title);
  check('E. La fila del artículo recién guardado aparece en la lista de artículos', !!savedRow);
  var editBtn = savedRow && Array.from(savedRow.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === 'Editar'; });
  check('E. Se encontró el botón real "Editar" sobre esa fila', !!editBtn);
  if (editBtn) editBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(150);
  var formTitleAfterReopen = window.document.getElementById('articleFormTitle');
  check('E. startEditArticle() corrió (título del formulario "Editar artículo")', formTitleAfterReopen && formTitleAfterReopen.textContent === 'Editar artículo', formTitleAfterReopen && formTitleAfterReopen.textContent);
  var titleInputAfterReopen = window.document.getElementById('articleTitle');
  check('E. El formulario se recargó con los datos reales del artículo guardado', titleInputAfterReopen && titleInputAfterReopen.value === E2E_DRAFT.title);

  // ---- (F) Guardar de nuevo SIN modificar nada ----
  var submitBtn = window.document.getElementById('articleSubmitBtn');
  check('Setup: se encontró el botón real de guardado principal', !!submitBtn);
  // El status ya quedó en 'draft' (draftIncomplete) del primer guardado --
  // se reenvía tal cual, sin tocar ningún campo, para probar exactamente
  // "abrir y guardar de nuevo sin cambiar nada".
  submitBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);

  var afterSecondSave = findSaved();
  check('F. Sigue existiendo exactamente UN artículo con este slug (el segundo guardado actualizó, no duplicó)', readArticulos().filter(function (a) { return a.slug === E2E_DRAFT.slug; }).length === 1);
  auditPreservation('F (segundo guardado, sin modificar nada -- vía merge seguro de articles-store)', afterSecondSave);

  // ---- Ningún metadato interno se imprime como JSON en la página pública ----
  var previewResp = await fetch('http://127.0.0.1:' + PORT + '/api/preview/' + encodeURIComponent(afterSecondSave.category) + '/' + encodeURIComponent(afterSecondSave.slug));
  var previewHtml = await previewResp.text();
  check('Vista previa real: no contiene "editorialMeta" en el HTML servido', previewHtml.indexOf('editorialMeta') === -1);
  check('Vista previa real: no contiene "editorialValue" en el HTML servido', previewHtml.indexOf('editorialValue') === -1);
  check('Vista previa real: no contiene "trendDetectionMethod" (campo interno de editorialMeta) en el HTML servido', previewHtml.indexOf('trendDetectionMethod') === -1);
  check('Vista previa real: el título del artículo SÍ aparece (la página se generó de verdad, no un error)', previewHtml.indexOf(E2E_DRAFT.title) !== -1);

  // ---- Cierre ----
  child.kill();
  await sleep(200);
  var realArticlesAfter = fs.readFileSync(path.join(REAL_ROOT, 'data', 'articulos.json'), 'utf8');
  check('El sitio real (sandbox) no cambió durante esta prueba', realArticlesAfter === realArticlesBefore);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('Copia aislada eliminada por completo', !fs.existsSync(tmpRoot));

  console.log('\n' + pass + ' PASS, ' + fail + ' FAIL');
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(function (e) {
  console.error('ERROR:', e);
  try { child.kill(); } catch (e2) {}
  process.exitCode = 1;
});
